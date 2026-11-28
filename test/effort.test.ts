import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelChoice } from "agent-runtime";
import type { Update } from "grammy/types";
import { enterChatModel, switchModel } from "../src/agent/switch.ts";
import { runTurn } from "../src/agent/turn.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import { allowedHosts, allowedOrigins } from "../src/console/index.ts";
import { csrfToken, handleConsole, LOGIN_HEADER, type ConsoleDeps } from "../src/console/server.ts";
import { recordControlBatch } from "../src/control/bot.ts";
import { getCard, switchResultText } from "../src/control/model-cards.ts";
import { backgroundPass, backgroundSettled, fillEffortLevels, forgetFills } from "../src/server/probes.ts";
import { fileSource } from "../src/secrets/source.ts";
import type { Db } from "../src/store/db.ts";
import { ensureChat, getChat } from "../src/store/events.ts";
import { addModel, addProvider, chatModel, findModel, recordEffortLevels, resolveEffort, setChatEffort, setModelEffort } from "../src/store/models.ts";
import { controlCards } from "../src/store/schema.ts";
import { stepsOf } from "../src/store/transcripts.ts";
import { claimTurn, getTurn } from "../src/store/turns.ts";
import { memDb, OWNER, ownerChatId, ownerSays, ScriptedAdapter } from "./helpers.ts";

/** Effort per model with a per-chat override (store/models.ts EFFORT): resolution, levels, the console, the control bot. */

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "shuvi-effort-"));
  dirs.push(d);
  return d;
};

const ALL = ["low", "medium", "high", "xhigh", "max"];
/** What Claude Code's listing reports (agent-runtime `listClaudeModels`): `opus` with all five levels, `old` with three. */
const CHOICES: ModelChoice[] = [
  { id: "opus", canonicalId: "claude-opus-5-5", label: "Opus", description: "Opus 5.5 · Example", effortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "old", canonicalId: "claude-old-4-5", label: "Old", description: "Old 4.5 · Example", effortLevels: ["low", "medium", "high"] },
];

/** A Claude login with opus (levels known), old (three levels) and fixed (levels unknown); an endpoint with qwen; the DM on opus. */
function setup() {
  const db = memDb();
  addProvider(db, { name: "claude", kind: "claude", configDir: tmp() });
  addModel(db, { provider: "claude", model: "opus", isDefault: true });
  addModel(db, { provider: "claude", model: "old" });
  addModel(db, { provider: "claude", model: "fixed-version" });
  recordEffortLevels(db, "claude", CHOICES);
  addProvider(db, { name: "vllm", kind: "openai-compat", baseUrl: "http://127.0.0.1:9/v1" });
  addModel(db, { provider: "vllm", model: "qwen", contextWindow: 32_000 });
  ownerSays(db, "hi");
  const chatId = ownerChatId(db);
  enterChatModel(db, getChat(db, chatId)!);
  return { db, chatId };
}
const resolved = (db: Db, chatId: number) => {
  const chat = getChat(db, chatId)!;
  return resolveEffort(chat, chatModel(db, chat));
};

describe("resolution (resolveEffort)", () => {
  test("unset everywhere: none, nothing to note (today's behaviour)", () => {
    const { db, chatId } = setup();
    expect(resolved(db, chatId)).toEqual({ level: null, source: "none", notes: [] });
  });

  test("the chat's override over the model's default over none", () => {
    const { db, chatId } = setup();
    setModelEffort(db, "claude/opus", "medium");
    expect(resolved(db, chatId)).toEqual({ level: "medium", source: "model", notes: [] });
    setChatEffort(db, chatId, "low");
    expect(resolved(db, chatId)).toEqual({ level: "low", source: "chat", notes: [] });
    setChatEffort(db, chatId, null);
    setModelEffort(db, "claude/opus", null);
    expect(resolved(db, chatId).source).toBe("none");
  });

  test("a level the model is known not to support is skipped with a note, and the next layer used", () => {
    const { db, chatId } = setup();
    const old = findModel(db, "claude/old")!;
    // As if set while the levels said otherwise (the setters refuse it now).
    const r = resolveEffort({ effort: "max" }, { ...old, model: { ...old.model, effort: "medium" } });
    expect(r.level).toBe("medium");
    expect(r.source).toBe("model");
    expect(r.notes).toEqual(["Effort: this chat's effort (max) was not sent: claude/old does not support it (it supports low, medium, high)."]);
    const none = resolveEffort({ effort: "max" }, old);
    expect(none).toMatchObject({ level: null, source: "none" });
    expect(none.notes).toHaveLength(1);
    void chatId;
  });

  test("levels not recorded: nothing is sent, with a note; an OpenAI-compatible model takes none", () => {
    const { db } = setup();
    const fixed = findModel(db, "claude/fixed-version")!;
    expect(fixed.model.effortLevels).toBeNull();
    const r = resolveEffort({ effort: "high" }, fixed);
    expect(r).toMatchObject({ level: null, source: "none" });
    expect(r.notes[0]).toContain("the levels claude/fixed-version supports are not known yet");
    const qwen = findModel(db, "vllm/qwen")!;
    const q = resolveEffort({ effort: "high" }, qwen);
    expect(q).toMatchObject({ level: null, source: "none" });
    expect(q.notes[0]).toContain("not on a Claude login");
  });

  test("the setters refuse what is not known to be supported", () => {
    const { db, chatId } = setup();
    expect(() => setModelEffort(db, "claude/old", "max")).toThrow("does not support effort max");
    expect(() => setModelEffort(db, "claude/fixed-version", "low")).toThrow("not known yet");
    expect(() => setModelEffort(db, "vllm/qwen", "low")).toThrow("not on a Claude login");
    setModelEffort(db, "claude/fixed-version", null); // clearing always works
    switchModel(db, chatId, "claude/old", "lossy");
    expect(() => setChatEffort(db, chatId, "xhigh")).toThrow("does not support effort xhigh");
    setChatEffort(db, chatId, "high");
    expect(getChat(db, chatId)!.effort).toBe("high");
  });
});

describe("a turn: its effort reaches the driver and is recorded", () => {
  test("the input's effort, the turn row's effort and source, and the note for one skipped", async () => {
    const { db, chatId } = setup();
    setChatEffort(db, chatId, "low");
    const home = join(tmp(), "home");
    const t1 = claimTurn(db, chatId)!;
    let adapter: ScriptedAdapter | undefined;
    const chat = getChat(db, chatId)!;
    expect(await runTurn({ db, turnId: t1.id, home, timeZone: "UTC", capabilities: [], effort: resolveEffort(chat, chatModel(db, chat)), makeAdapter: (b) => (adapter = new ScriptedAdapter(b, [{ token: "one" }])) })).toBe("done");
    expect(adapter!.calls[0]!.effort).toBe("low");
    expect(getTurn(db, t1.id)).toMatchObject({ effort: "low", effortSource: "chat" });

    // On a model whose levels are not known: nothing sent, recorded as none, and the transcript says why.
    ownerSays(db, "again");
    const fixed = findModel(db, "claude/fixed-version")!;
    const t2 = claimTurn(db, chatId)!;
    expect(await runTurn({ db, turnId: t2.id, home, timeZone: "UTC", capabilities: [], effort: resolveEffort({ effort: "low" }, fixed), makeAdapter: (b) => (adapter = new ScriptedAdapter(b, [{ token: "two" }])) })).toBe("done");
    expect(adapter!.calls[0]!.effort).toBeUndefined();
    expect(getTurn(db, t2.id)).toMatchObject({ effort: null, effortSource: "none" });
    expect(stepsOf(db, t2.id).filter((s) => s.kind === "note").map((s) => s.text)).toEqual([expect.stringContaining("was not sent: the levels claude/fixed-version supports are not known yet")]);
  });
});

describe("the model-change rule", () => {
  test("a switch keeps the override only if the new model supports it; the result says so", () => {
    const { db, chatId } = setup();
    setChatEffort(db, chatId, "high");
    expect(switchModel(db, chatId, "claude/old", "lossy").effortDropped).toBeUndefined();
    expect(getChat(db, chatId)!.effort).toBe("high");
    switchModel(db, chatId, "claude/opus", "lossy");
    setChatEffort(db, chatId, "max");
    const r = switchModel(db, chatId, "claude/old", "lossy");
    expect(r.effortDropped).toBe("max");
    expect(getChat(db, chatId)!.effort).toBeNull();
    const text = switchResultText(getChat(db, chatId)!, { status: "done", result: r, toModel: "claude/old", stoppedTurnId: null } as never);
    expect(text).toContain("Its effort max was dropped: claude/old does not support it");
    // To a model whose levels are not known, or an endpoint: dropped too.
    setChatEffort(db, chatId, "low");
    expect(switchModel(db, chatId, "vllm/qwen", "lossy").effortDropped).toBe("low");
  });
});

describe("levels: recorded by a listing, filled in the background", () => {
  test("recordEffortLevels names a model by alias or by the fixed version it stands for; others stay unknown", () => {
    const db = memDb();
    addProvider(db, { name: "claude", kind: "claude" });
    addModel(db, { provider: "claude", model: "claude-opus-5-5" });
    addModel(db, { provider: "claude", model: "mystery" });
    expect(recordEffortLevels(db, "claude", CHOICES)).toBe(1);
    expect(findModel(db, "claude/claude-opus-5-5")!.model.effortLevels).toEqual(ALL);
    expect(findModel(db, "claude/mystery")!.model.effortLevels).toBeNull();
    expect(recordEffortLevels(db, "claude", CHOICES)).toBe(0); // nothing new
  });

  test("the background fill lists each login with a model missing them, once per set of such models", async () => {
    forgetFills();
    const db = memDb();
    addProvider(db, { name: "claude", kind: "claude" });
    addModel(db, { provider: "claude", model: "opus" });
    addModel(db, { provider: "claude", model: "mystery" });
    let calls = 0;
    const listClaude = async () => (calls++, CHOICES);
    expect(fillEffortLevels(db, { listClaude })).toBe(1);
    expect(fillEffortLevels(db, { listClaude })).toBe(0); // running
    await backgroundSettled();
    expect(findModel(db, "claude/opus")!.model.effortLevels).toEqual(ALL);
    // `mystery` is not in the listing: not listed again for the same set of models...
    expect(fillEffortLevels(db, { listClaude })).toBe(0);
    // ...but a new model without levels is.
    addModel(db, { provider: "claude", model: "another" });
    expect(fillEffortLevels(db, { listClaude })).toBe(1);
    await backgroundSettled();
    expect(calls).toBe(2);
  });

  test("a listing card records the levels, and a model added from it keeps them", async () => {
    const db = memDb();
    addProvider(db, { name: "claude", kind: "claude" });
    addModel(db, { provider: "claude", model: "opus" });
    say(db, "/provider add work claude /tmp/example-login");
    backgroundPass(db, { secrets: fileSource("/nonexistent"), listClaude: async () => CHOICES });
    await backgroundSettled();
    const card = db.select().from(controlCards).all().at(-1)!;
    const add = card.keyboard.flat().find((b) => b.text.startsWith("old"))!;
    press(db, add.callback_data);
    expect(findModel(db, "work/old")!.model.effortLevels).toEqual(["low", "medium", "high"]);
  });
});

// ---- the control bot ------------------------------------------------------------------------------------

const deps = { ownerId: OWNER, commit: "abc1234", timeZone: "UTC" };
let nextUpdate = 1;
const say = (db: Db, text: string) =>
  recordControlBatch(db, [{ update_id: nextUpdate++, message: { message_id: nextUpdate, date: 0, chat: { id: OWNER, type: "private", first_name: "Owner" }, from: { id: OWNER, is_bot: false, first_name: "Owner" }, text } } as unknown as Update], deps);
const press = (db: Db, data: string) =>
  recordControlBatch(db, [{ update_id: nextUpdate++, callback_query: { id: `cq${nextUpdate}`, from: { id: OWNER, is_bot: false, first_name: "Owner" }, chat_instance: "x", data } } as unknown as Update], deps).callbacks[0]!.text;
const lastCard = (db: Db) => db.select().from(controlCards).all().at(-1)!;
const button = (db: Db, text: string | RegExp, id = lastCard(db).id) => {
  const b = getCard(db, id)!.keyboard.flat().find((x) => (typeof text === "string" ? x.text === text : text.test(x.text)));
  if (!b) throw new Error(`no button ${text} on card ${id}: ${getCard(db, id)!.keyboard.flat().map((x) => x.text).join(" | ")}`);
  return b.callback_data;
};
const labels = (db: Db, id = lastCard(db).id) => getCard(db, id)!.keyboard.map((r) => r.map((b) => b.text));

describe("/effort in the control bot", () => {
  test("the card: the effort now and its source, the model's setting and each level; a press sets and clears", () => {
    const { db, chatId } = setup();
    setModelEffort(db, "claude/opus", "medium");
    say(db, "/effort 1");
    const id = lastCard(db).id;
    expect(getCard(db, id)!.kind).toBe("effort");
    expect(getCard(db, id)!.text).toBe("Effort for chat 1 (tg 1001), on claude/opus: now medium (the model's setting).\nA change applies from its next turn.");
    expect(labels(db)).toEqual([["✓ Model's setting (currently medium)"], ["low", "medium", "high"], ["xhigh", "max"], ["Cancel"]]);
    expect(press(db, button(db, "low"))).toBe("");
    expect(getChat(db, chatId)!.effort).toBe("low");
    expect(getCard(db, id)!.text).toBe("chat 1 (tg 1001): effort low (set for this chat), from its next turn.");
    // The same store the console reads: and back to the model's setting.
    say(db, "/effort 1");
    expect(labels(db)[0]).toEqual(["Model's setting (currently medium)"]);
    expect(labels(db)[1]).toEqual(["✓ low", "medium", "high"]);
    press(db, button(db, /^Model's setting/));
    expect(getChat(db, chatId)!.effort).toBeNull();
  });

  test("levels not known: no level offered, and List models again, after which the card offers them", async () => {
    const { db, chatId } = setup();
    switchModel(db, chatId, "claude/fixed-version", "lossy");
    say(db, "/effort 1");
    const id = lastCard(db).id;
    expect(getCard(db, id)!.text).toContain("The effort levels claude/fixed-version supports are not known yet, so none is offered.");
    expect(labels(db)).toEqual([["List claude's models again"], ["Cancel"]]);
    press(db, button(db, "List claude's models again"));
    const listing = lastCard(db);
    expect(listing.kind).toBe("provider_add");
    expect(listing.text).toContain("Listing the models of claude");
    backgroundPass(db, { secrets: fileSource("/nonexistent"), listClaude: async () => [...CHOICES, { id: "fixed-version", label: "Fixed", effortLevels: ["low", "high"] }] });
    await backgroundSettled();
    expect(labels(db, id)).toEqual([["✓ Model's setting (currently its own default)"], ["low", "high"], ["Cancel"]]);
  });

  test("an OpenAI-compatible model offers none; a chat that is not there is said", () => {
    const { db, chatId } = setup();
    switchModel(db, chatId, "vllm/qwen", "lossy");
    say(db, "/effort 1");
    expect(lastCard(db).text).toContain("vllm/qwen is not on a Claude login: it takes no effort.");
    expect(labels(db)).toEqual([["Cancel"]]);
    say(db, "/effort 99");
    say(db, "/effort");
  });

  test("/models: a Claude model's default effort, as a step of the card", () => {
    const { db } = setup();
    say(db, "/models");
    const id = lastCard(db).id;
    expect(getCard(db, id)!.text).toContain("1. claude/opus ★\n   Claude login · default effort the model's own (low/medium/high/xhigh/max)");
    expect(getCard(db, id)!.text).toContain("claude/fixed-version\n   Claude login · effort levels not known yet");
    // An Effort button for opus and old, none for fixed-version (unknown) or qwen (an endpoint).
    expect(getCard(db, id)!.keyboard.flat().filter((b) => b.text.endsWith("· Effort")).map((b) => b.text)).toEqual(["1 · Effort", "2 · Effort"]);
    press(db, button(db, "2 · Effort"));
    expect(getCard(db, id)!.text).toStartWith("Default effort for claude/old: now the model's own default.");
    expect(labels(db)).toEqual([["✓ The model's own default"], ["low", "medium", "high"], ["‹ Back"]]);
    press(db, button(db, "high"));
    expect(findModel(db, "claude/old")!.model.effort).toBe("high");
    expect(getCard(db, id)!.text).toContain("claude/old: default effort high, from its chats' next turn.");
    expect(getCard(db, id)!.text).toContain("Claude login · default effort high (low/medium/high)");
  });
});

// ---- the console ------------------------------------------------------------------------------------------

const PORT = 8787;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "example-csrf-secret";
const LOGIN = "owner@example.com";
const CSRF = csrfToken(SECRET, `login:${LOGIN}`);

function consoleDeps(db: Db, home: string): ConsoleDeps {
  const c = { listen: `127.0.0.1:${PORT}` };
  return {
    db,
    home,
    timeZone: "UTC",
    dataDir: "/nonexistent",
    ownerId: OWNER,
    allowedHosts: allowedHosts(c, PORT),
    allowedOrigins: allowedOrigins(c, PORT),
    csrfSecret: SECRET,
    users: new Set([LOGIN]),
    prompt: { capabilities: enabledCapabilities({ SHUVI_OWNER_ID: String(OWNER), SHUVI_WEB: "off" }), ownerId: OWNER },
  };
}
const get = async (db: Db, home: string, path: string) => (await handleConsole(consoleDeps(db, home), new Request(`${BASE}${path}`, { headers: { [LOGIN_HEADER]: LOGIN } }))).text();
function post(db: Db, home: string, path: string, fields: Record<string, string>, o: { origin?: string | null; csrf?: string } = {}): Promise<Response> {
  const body = new URLSearchParams(fields);
  body.set("csrf", o.csrf ?? CSRF);
  const headers: Record<string, string> = { [LOGIN_HEADER]: LOGIN, "content-type": "application/x-www-form-urlencoded" };
  if (o.origin !== null) headers.origin = o.origin ?? BASE;
  return handleConsole(consoleDeps(db, home), new Request(`${BASE}${path}`, { method: "POST", headers, body }));
}
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#39;/g, "'").replace(/\s+/g, " ");

describe("the console", () => {
  test("a chat's settings: the Effort picker under Model, the effort now and its source; the write and its checks", async () => {
    const { db, chatId } = setup();
    const home = tmp();
    setModelEffort(db, "claude/opus", "medium");
    const html = await get(db, home, `/chats/${chatId}/settings`);
    expect(html.indexOf('id="effort"')).toBeGreaterThan(html.indexOf('id="model"'));
    expect(html.indexOf('id="effort"')).toBeLessThan(html.indexOf('id="profile"'));
    expect(text(html)).toContain("Her turns here run at medium (the model's setting) on claude/opus.");
    expect(text(html)).toContain("Model's setting (currently medium)");
    for (const l of ALL) expect(html).toContain(`name="effort" value="${l}"`);

    // Origin and CSRF, as every write.
    expect((await post(db, home, `/chats/${chatId}/settings/effort`, { effort: "low" }, { csrf: "wrong" })).status).toBe(403);
    expect((await post(db, home, `/chats/${chatId}/settings/effort`, { effort: "low" }, { origin: null })).status).toBe(403);
    expect((await post(db, home, `/chats/${chatId}/settings/effort`, { effort: "low" }, { origin: "https://evil.example" })).status).toBe(403);
    expect(getChat(db, chatId)!.effort).toBeNull();

    const res = await post(db, home, `/chats/${chatId}/settings/effort`, { effort: "low" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toEndWith("#effort");
    expect(getChat(db, chatId)!.effort).toBe("low");
    const after = text(await get(db, home, res.headers.get("location")!.replace(/#.*$/, "")));
    expect(after).toContain("effort low (set for this chat), from her next turn here.");
    expect(after).toContain("Her turns here run at low (set for this chat)");

    // A level the model does not support, refused in the store's words; back to the model's setting.
    await post(db, home, `/chats/${chatId}/settings/effort`, { effort: "nope" });
    expect(getChat(db, chatId)!.effort).toBe("low");
    await post(db, home, `/chats/${chatId}/settings/effort`, { effort: "" });
    expect(getChat(db, chatId)!.effort).toBeNull();
  });

  test("a chat's model with unknown levels: no picker, the levels said unknown, List models again", async () => {
    const { db, chatId } = setup();
    const home = tmp();
    switchModel(db, chatId, "claude/fixed-version", "lossy");
    const html = await get(db, home, `/chats/${chatId}/settings`);
    expect(html).not.toContain('name="effort" value="low"');
    expect(text(html)).toContain("The effort levels claude/fixed-version supports are not known yet, so none is offered.");
    expect(html).toContain(`action="/chats/${chatId}/settings/effort-list"`);
    expect((await post(db, home, `/chats/${chatId}/settings/effort-list`, {}, { csrf: "wrong" })).status).toBe(403);
    expect((await post(db, home, `/chats/${chatId}/settings/effort-list`, {})).status).toBe(303);
    expect(lastCard(db)).toMatchObject({ kind: "provider_add", status: "open" });
    await handleListing(db);
    expect(await get(db, home, `/chats/${chatId}/settings`)).toContain('name="effort" value="high"');
  });

  test("Settings: a Claude model's default-effort picker; none while its levels are unknown or on an endpoint; the write and its checks", async () => {
    const { db } = setup();
    const home = tmp();
    const html = await get(db, home, "/settings");
    expect(html.match(/action="\/settings\/models\/effort"/g)).toHaveLength(2); // opus, old
    expect(text(html)).toContain("effort levels not known yet");
    expect((await post(db, home, "/settings/models/effort", { model: "claude/old", effort: "high" }, { csrf: "wrong" })).status).toBe(403);
    expect((await post(db, home, "/settings/models/effort", { model: "claude/old", effort: "high" }, { origin: "https://evil.example" })).status).toBe(403);
    expect(findModel(db, "claude/old")!.model.effort).toBeNull();
    const ok = await post(db, home, "/settings/models/effort", { model: "claude/old", effort: "high" });
    expect(ok.status).toBe(303);
    expect(findModel(db, "claude/old")!.model.effort).toBe("high");
    expect(text(await get(db, home, ok.headers.get("location")!.replace(/#.*$/, "")))).toContain("claude/old: default effort high, from its chats' next turn.");
    const no = await post(db, home, "/settings/models/effort", { model: "claude/old", effort: "max" });
    expect(text(await get(db, home, no.headers.get("location")!.replace(/#.*$/, "")))).toContain("does not support effort max");
    expect(findModel(db, "claude/old")!.model.effort).toBe("high");
    await post(db, home, "/settings/models/effort", { model: "claude/old", effort: "" });
    expect(findModel(db, "claude/old")!.model.effort).toBeNull();
  });

  test("a turn's page shows the effort it ran at, next to the model", async () => {
    const { db, chatId } = setup();
    const home = tmp();
    setChatEffort(db, chatId, "high");
    const t = claimTurn(db, chatId)!;
    const chat = getChat(db, chatId)!;
    await runTurn({ db, turnId: t.id, home: join(home, "home"), timeZone: "UTC", capabilities: [], effort: resolveEffort(chat, chatModel(db, chat)), makeAdapter: (b) => new ScriptedAdapter(b, [{ token: "ok" }]) });
    expect(text(await get(db, home, `/turns/${t.id}`))).toContain("effort high (this chat)");
  });
});

/** Run the console's listing that is waiting, as the server's pass would, with the listing reporting `fixed-version` too. */
async function handleListing(db: Db): Promise<void> {
  backgroundPass(db, { secrets: fileSource("/nonexistent"), listClaude: async () => [...CHOICES, { id: "fixed-version", label: "Fixed", effortLevels: ["low", "high"] }] });
  await backgroundSettled();
}

void ensureChat;
