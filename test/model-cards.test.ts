import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Api } from "grammy";
import type { Update } from "grammy/types";
import { enterChatModel, getSwitchRequest } from "../src/agent/switch.ts";
import { controlSendPass, recordControlBatch } from "../src/control/bot.ts";
import { catalogChanged, CLOSED, finishListing, getCard, modeLines, probeText, refreshCards, relativeTime, switchCardPass } from "../src/control/model-cards.ts";
import { commandPass, switchRequestPass } from "../src/server/commands.ts";
import { backgroundPass, backgroundSettled, probeRecord } from "../src/server/probes.ts";
import { appendMessages } from "../src/store/conversations.ts";
import { controlMessagesOf } from "../src/store/control.ts";
import type { Db } from "../src/store/db.ts";
import { getChat, recordInbound } from "../src/store/events.ts";
import { addModel, addProvider, findModel, getProvider, markProbing, recordProbe, setModelVision } from "../src/store/models.ts";
import { chatEvents, controlCards, models } from "../src/store/schema.ts";
import { claimTurn, finishTurn, saveSession, setTurnPid } from "../src/store/turns.ts";
import { FakeTelegram, memDb, OWNER, ownerChatId, ownerSays } from "./helpers.ts";

const dirs: string[] = [];
let tg: FakeTelegram | null = null;
let endpoint: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  tg?.stop();
  tg = null;
  endpoint?.stop(true);
  endpoint = null;
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "shuvi-cards-"));
  dirs.push(d);
  return d;
};

const deps = { ownerId: OWNER, commit: "abc1234", timeZone: "UTC" };
let nextUpdate = 1;
const say = (db: Db, text: string) => recordControlBatch(db, [{ update_id: nextUpdate++, message: { message_id: nextUpdate, date: 0, chat: { id: OWNER, type: "private", first_name: "Owner" }, from: { id: OWNER, is_bot: false, first_name: "Owner" }, text } } as unknown as Update], deps);
/** Press a button; returns what the press was answered with. */
const press = (db: Db, data: string) => recordControlBatch(db, [{ update_id: nextUpdate++, callback_query: { id: `cq${nextUpdate}`, from: { id: OWNER, is_bot: false, first_name: "Owner" }, chat_instance: "x", data } } as unknown as Update], deps).callbacks[0]!.text;

const lastCard = (db: Db) => db.select().from(controlCards).all().at(-1)!;
const buttons = (db: Db, id = lastCard(db).id) => getCard(db, id)!.keyboard.flat();
const button = (db: Db, text: string | RegExp, id = lastCard(db).id) => {
  const b = buttons(db, id).find((x) => (typeof text === "string" ? x.text === text : text.test(x.text)));
  if (!b) throw new Error(`no button ${text} on card ${id}: ${buttons(db, id).map((x) => x.text).join(" | ")}`);
  return b.callback_data;
};
const replies = (db: Db) => controlMessagesOf(db, "reply").map((r) => r.text);

/** A catalog: a Claude login (opus), and an endpoint with two models, the default `vllm/qwen`. A chat on it that has talked. */
function setup() {
  const db = memDb();
  addProvider(db, { name: "claude", kind: "claude", configDir: tmp() });
  addModel(db, { provider: "claude", model: "opus" });
  addProvider(db, { name: "vllm", kind: "openai-compat", baseUrl: "http://127.0.0.1:9/v1" });
  addModel(db, { provider: "vllm", model: "qwen", contextWindow: 32_000, isDefault: true });
  addModel(db, { provider: "vllm", model: "llama", contextWindow: 8_000 });
  ownerSays(db, "hi");
  const chatId = ownerChatId(db);
  enterChatModel(db, getChat(db, chatId)!);
  appendMessages(db, chatId, "oa-1", [
    { role: "user", content: "T1-PROMPT" },
    { role: "assistant", content: [{ type: "text", text: "T1-ANSWER" }] },
  ]);
  saveSession(db, chatId, "oa-1");
  return { db, chatId };
}

describe("the switch card", () => {
  test("/model in the chat: 👌, no turn stopped, and a card in the control bot; delivered with its buttons", async () => {
    const { db, chatId } = setup();
    const turn = claimTurn(db, chatId)!;
    setTurnPid(db, turn.id, 4242, "1");
    recordInbound(db, { chatId, kind: "command", payload: { from: { id: OWNER, name: "Owner" }, command: "model" }, tgUpdateId: 900, tgMessageId: 900 });
    const signals: number[] = [];
    expect(commandPass(db, (pid) => signals.push(pid))).toBe(1);
    expect(commandPass(db, (pid) => signals.push(pid))).toBe(0);
    expect(signals).toEqual([]); // the card stops it, if the owner switches
    const reaction = db.select().from(chatEvents).all().filter((e) => e.kind === "bot_reaction");
    expect(reaction.map((e) => (e.payload as { emoji: string }).emoji)).toEqual(["👌"]);
    expect(db.select().from(chatEvents).all().filter((e) => e.kind === "bot_message")).toEqual([]);
    expect(db.select().from(controlCards).all()).toHaveLength(1);

    tg = new FakeTelegram();
    await controlSendPass(db, new Api("CONTROL", { apiRoot: tg.apiRoot }), OWNER);
    const sent = tg.sent()[0]!;
    expect(sent.text).toBe("Model for chat 1 (tg 1001): now vllm/qwen.");
    const kb = (sent.reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard.map((r) => r.map((b) => b.text));
    expect(kb).toEqual([["claude/opus"], ["✓ vllm/qwen"], ["vllm/llama"], ["Cancel"]]);
  });

  test("a model, then lossless: the mode step says what each mode would do; the switch is applied and the card edited to the result", async () => {
    const { db, chatId } = setup();
    say(db, "/model 1");
    const id = lastCard(db).id;
    expect(press(db, button(db, "vllm/llama"))).toBe("");
    expect(getCard(db, id)!.text).toBe("Switch chat 1 (tg 1001) to vllm/llama:\nLossless: copies the whole conversation (2 messages) to vllm/llama\nLossy: vllm/llama starts fresh with the last 10 messages");
    expect(buttons(db).map((b) => b.text)).toEqual(["Lossless", "Lossy", "‹ Back"]);
    // Back, and forth: nothing is lost on the way.
    press(db, button(db, "‹ Back"));
    press(db, button(db, "vllm/llama"));
    press(db, button(db, "Lossless"));
    const card = getCard(db, id)!;
    expect(card.status).toBe("waiting");
    expect(card.text).toBe("chat 1 (tg 1001) → vllm/llama (lossless): switching…");
    expect(card.keyboard).toEqual([]);
    expect(getSwitchRequest(db, card.switchRequestId!)!.status).toBe("pending");
    expect(switchCardPass(db)).toBe(0); // still pending
    switchRequestPass(db, () => {});
    expect(switchCardPass(db)).toBe(1);
    expect(getCard(db, id)).toMatchObject({ status: "closed", text: "chat 1 (tg 1001) → vllm/llama (lossless, 2 messages carried)", keyboard: [] });
    expect(getChat(db, chatId)!.model).toBe("vllm/llama");

    // Delivered: the card once, then edits, each showing the card as it is then.
    tg = new FakeTelegram();
    await controlSendPass(db, new Api("CONTROL", { apiRoot: tg.apiRoot }), OWNER);
    expect(tg.sent().map((b) => b.text)).toEqual(["chat 1 (tg 1001) → vllm/llama (lossless, 2 messages carried)"]);
    const edits = tg.sent("editMessageText");
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.every((e) => e.message_id === 9000 && e.text === "chat 1 (tg 1001) → vllm/llama (lossless, 2 messages carried)")).toBe(true);
  });

  test("lossy back resumes the model's own conversation, from when it was left; the current model is 'already on'", () => {
    const { db } = setup();
    say(db, "/model 1 vllm/llama lossless");
    switchRequestPass(db, () => {});
    switchCardPass(db);
    expect(replies(db).at(-1)).toBe("chat 1 (tg 1001) → vllm/llama (lossless, 2 messages carried)");
    say(db, "/model 1");
    press(db, button(db, "✓ vllm/llama"));
    expect(lastCard(db)).toMatchObject({ status: "closed", text: "chat 1 (tg 1001): already on vllm/llama" });
    say(db, "/model 1");
    press(db, button(db, "vllm/qwen"));
    expect(lastCard(db).text).toContain("\nLossy: resumes vllm/qwen's conversation from just now");
    expect(lastCard(db).text).toContain("\nLossless: carries 0 new messages into vllm/qwen's conversation");
    press(db, button(db, "Lossy"));
    switchRequestPass(db, () => {});
    switchCardPass(db);
    expect(lastCard(db).text).toBe("chat 1 (tg 1001) → vllm/qwen (lossy, its own conversation resumed)");
  });

  test("a running turn: the card says it will be stopped; the switch stops it, then applies, and the result names it", () => {
    const { db, chatId } = setup();
    const turn = claimTurn(db, chatId)!;
    setTurnPid(db, turn.id, 4242, "1");
    say(db, "/model 1");
    press(db, button(db, "vllm/llama"));
    expect(lastCard(db).text.split("\n").at(-1)).toBe(`turn ${turn.id} is running and will be stopped`);
    press(db, button(db, "Lossy"));
    const signals: number[] = [];
    switchRequestPass(db, (pid) => signals.push(pid));
    expect(signals).toEqual([4242]);
    expect(switchCardPass(db)).toBe(0);
    finishTurn(db, turn.id, { status: "stopped" });
    switchRequestPass(db, () => {});
    switchCardPass(db);
    expect(lastCard(db).text).toBe(`chat 1 (tg 1001) → vllm/llama (lossy, starting fresh with the last 10 messages); stopped turn ${turn.id}`);
  });

  test("a stale or closed card changes nothing; a restart between steps loses nothing; button data fits in 64 bytes", () => {
    const { db } = setup();
    for (let i = 0; i < 8; i++) addModel(db, { provider: "vllm", model: `extra-model-with-a-long-name-${i}`, contextWindow: 4096 });
    say(db, "/model 1");
    const id = lastCard(db).id;
    expect(getCard(db, id)!.text).toBe("Model for chat 1 (tg 1001): now vllm/qwen (page 1/2).");
    const old = button(db, "vllm/llama");
    press(db, button(db, "›"));
    expect(buttons(db).map((b) => b.text)).toEqual(["extra-model-with-a-long-name-3", "extra-model-with-a-long-name-4", "extra-model-with-a-long-name-5", "extra-model-with-a-long-name-6", "extra-model-with-a-long-name-7", "‹", "Cancel"].map((t) => (t.startsWith("extra") ? `vllm/${t}` : t)));
    // A button from before the page turned: stale.
    const before = JSON.stringify(getCard(db, id));
    expect(press(db, old)).toBe(CLOSED);
    expect(JSON.stringify(getCard(db, id))).toBe(before);
    // "A restart": nothing of the card lives anywhere but its row, so a new batch carries on from it.
    press(db, button(db, "vllm/extra-model-with-a-long-name-7"));
    expect(getCard(db, id)!.text).toStartWith("Switch chat 1 (tg 1001) to vllm/extra-model-with-a-long-name-7:");
    for (const b of buttons(db)) expect(new TextEncoder().encode(b.callback_data).length).toBeLessThan(64);
    const cancel = button(db, "‹ Back");
    press(db, cancel);
    press(db, button(db, "Cancel"));
    expect(getCard(db, id)).toMatchObject({ status: "closed", text: "Cancelled.", keyboard: [] });
    expect(press(db, cancel)).toBe(CLOSED);
    expect(press(db, "cd:999:0:x")).toBe(CLOSED);
  });

  test("/model <chat> <model> <mode> switches with no card and replies with the result; bad arguments get the usage", () => {
    const { db } = setup();
    say(db, "/model 1 vllm/llama lossy");
    expect(controlMessagesOf(db, "card")).toEqual([]);
    expect(replies(db)).toEqual([]);
    switchRequestPass(db, () => {});
    switchCardPass(db);
    switchCardPass(db);
    expect(replies(db)).toEqual(["chat 1 (tg 1001) → vllm/llama (lossy, starting fresh with the last 10 messages)"]);
    say(db, "/model 1 vllm/llama lossy");
    say(db, "/model 1 vllm/llama sideways");
    say(db, "/model 7");
    say(db, "/model 1 vllm/nope lossy");
    expect(replies(db).slice(1)).toEqual([
      "chat 1 (tg 1001): already on vllm/llama",
      "Usage: /model <chat> [<provider>/<model> lossless|lossy]",
      "No chat 7. Use its number from /status, or its Telegram id.",
      "There is no model vllm/nope in the catalog. /models lists them.",
    ]);
  });

  test("the mode lines, and relative times", () => {
    const now = Date.parse("2026-11-13T12:00:00Z");
    expect(modeLines({ to: "x/y", noop: false, lossless: { kind: "carry", messages: 1 }, lossy: { kind: "resume", since: "2026-11-10T11:00:00Z" }, running: 812 }, now)).toEqual({
      lossless: "carries 1 new message into x/y's conversation",
      lossy: "resumes x/y's conversation from 3 days ago",
      running: "turn 812 is running and will be stopped",
    });
    expect(relativeTime("2026-11-13T11:55:00Z", now)).toBe("5 minutes ago");
    expect(relativeTime("2026-11-13T09:00:00Z", now)).toBe("3 hours ago");
  });
});

describe("/models", () => {
  test("lists each model's id, label, ★, context window, vision and probe; make default, re-probe, remove", () => {
    const { db, chatId } = setup();
    const llama = findModel(db, "vllm/llama")!;
    recordProbe(db, llama.model.id, { status: "text-instead", error: "it wrote: pong", latencyMs: 310, vision: true });
    db.update(models).set({ label: "Qwen 3" }).where(eqId(findModel(db, "vllm/qwen")!.model.id)).run();
    say(db, "/models");
    const id = lastCard(db).id;
    expect(getCard(db, id)!.text).toBe(
      [
        "Models, ★ = default:",
        "1. claude/opus",
        "   Claude login",
        "2. vllm/qwen (Qwen 3) ★",
        "   32000 tokens · no vision · not probed",
        "3. vllm/llama",
        "   8000 tokens · vision · probe ⚠ text-instead, 310 ms",
      ].join("\n"),
    );
    expect(buttons(db).map((b) => b.text)).toEqual(["1 · Make default", "1 · Remove", "2 · Re-probe", "2 · Remove", "3 · Make default", "3 · Re-probe", "3 · Remove", "Done"]);

    // The default cannot be removed.
    press(db, button(db, "2 · Remove"));
    expect(getCard(db, id)!.text).toStartWith("Models, ★ = default:\nvllm/qwen is the default: make another model the default first.\n\n1. claude/opus");
    // Re-probe: checking.
    press(db, button(db, "2 · Re-probe"));
    expect(getCard(db, id)!.text).toContain("2. vllm/qwen (Qwen 3) ★\n   32000 tokens · no vision · probe checking…");
    // Remove names the chats whose own model it is, and asks.
    db.$client.query("update chats set model = 'vllm/llama' where id = ?").run(chatId);
    press(db, button(db, "3 · Remove"));
    expect(getCard(db, id)!.text).toBe("Remove vllm/llama?\nChats on it: chat 1 (tg 1001). Their next turn fails until they get another model.");
    press(db, button(db, "Remove vllm/llama"));
    expect(findModel(db, "vllm/llama")).toBeUndefined();
    expect(getCard(db, id)!.text).toStartWith("Models, ★ = default:\nRemoved vllm/llama.\n");
    press(db, button(db, "1 · Make default"));
    expect(findModel(db, "claude/opus")!.model.isDefault).toBe(true);
    expect(getCard(db, id)!.text).toContain("1. claude/opus ★");
    press(db, button(db, "Done"));
    expect(getCard(db, id)!.status).toBe("closed");
  });

  test("/models add adds a model directly, and asks for its probe; errors are replied", () => {
    const { db } = setup();
    say(db, "/models add vllm/mistral 16384");
    say(db, "/models add claude/sonnet");
    say(db, "/models add vllm/nolen");
    say(db, "/models add nope");
    expect(replies(db)).toEqual([
      "Added vllm/mistral (16384 tokens). Probing it.",
      "Added claude/sonnet.",
      "Could not add vllm/nolen: an OpenAI-compatible model needs its context window, in tokens: compaction is measured against it",
      "Usage: /models, or /models add <provider>/<model> [<context_window>]",
    ]);
    expect(findModel(db, "vllm/mistral")!.model.probeStatus).toBe("checking");
    expect(findModel(db, "claude/sonnet")!.model.probeStatus).toBeNull();
  });
});

// ---- a fake OpenAI-compatible endpoint: its /models, and Chat Completions answering the probe ---------------

const sse = (chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const chunk = (delta: unknown, finish: string | null = null) => ({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] });

function fakeEndpoint(): { url: string; auth: string[] } {
  const auth: string[] = [];
  endpoint = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      auth.push(req.headers.get("authorization") ?? "");
      if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "qwen3", max_model_len: 32768 }, { id: "chatty", max_model_len: 8192 }, { id: "nolen" }] });
      const body = (await req.json()) as { model: string; tools?: unknown[]; messages: { content: unknown }[] };
      if (!body.tools) return JSON.stringify(body.messages).includes("image") ? Response.json({ error: { message: "this model does not support image input" } }, { status: 400 }) : sse([chunk({ content: "red" }), chunk({}, "stop")]);
      if (body.model === "chatty") return sse([chunk({ role: "assistant", content: "pong!" }), chunk({}, "stop")]);
      return sse([chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "ping", arguments: "{}" } }] }), chunk({}, "tool_calls")]);
    },
  });
  return { url: `http://127.0.0.1:${endpoint.port}/v1`, auth };
}

describe("/provider", () => {
  test("add lists the endpoint's /models on the card; pressing one adds it with its context window and probes it", async () => {
    const { db } = setup();
    const fake = fakeEndpoint();
    const dir = tmp();
    const secretsFile = join(dir, "secrets.yaml");
    writeFileSync(secretsFile, "lab:\n  LAB_KEY: sk-example-not-real\n", { mode: 0o600 });
    say(db, `/provider add lab ${fake.url} lab.LAB_KEY`);
    const id = lastCard(db).id;
    expect(getProvider(db, "lab")).toMatchObject({ kind: "openai-compat", apiKey: "lab.LAB_KEY" });
    expect(getCard(db, id)!.text).toBe(`Added provider lab (${fake.url}, key lab.LAB_KEY). Listing its models…`);
    expect(backgroundPass(db, { secretsFile })).toBe(1);
    expect(backgroundPass(db, { secretsFile })).toBe(0); // one at a time
    await backgroundSettled();
    expect(fake.auth).toEqual(["Bearer sk-example-not-real"]);
    expect(getCard(db, id)!.text).toBe(`lab (${fake.url}, key lab.LAB_KEY) lists 3 models. Press one to add it. ✓ = in the catalog.`);
    expect(buttons(db).map((b) => b.text)).toEqual(["qwen3 · 32768 tokens", "chatty · 8192 tokens", "nolen · no context length", "Done"]);

    press(db, button(db, "qwen3 · 32768 tokens"));
    press(db, button(db, "chatty · 8192 tokens"));
    press(db, button(db, "nolen · no context length"));
    expect(getCard(db, id)!.text.split("\n")[1]).toBe("The listing gives no context length for nolen. Add it with /models add lab/nolen <context_window>.");
    expect(findModel(db, "lab/qwen3")!.model).toMatchObject({ contextWindow: 32768, probeStatus: "checking" });
    expect(getCard(db, id)!.text).toContain("lab/qwen3: probe checking…");

    expect(backgroundPass(db, { secretsFile })).toBe(2);
    await backgroundSettled();
    const qwen = findModel(db, "lab/qwen3")!.model;
    expect(qwen).toMatchObject({ probeStatus: "ok", probeError: null, probeVision: false, vision: false });
    expect(qwen.probedAt).toBeString();
    expect(findModel(db, "lab/chatty")!.model).toMatchObject({ probeStatus: "text-instead", probeError: "it wrote: pong!" });
    // The card was edited to show it, marked ✓ and ⚠.
    const text = getCard(db, id)!.text;
    expect(text).toMatch(/lab\/qwen3: probe ok, \d+ ms/);
    expect(text).toMatch(/lab\/chatty: probe ⚠ text-instead, \d+ ms/);
    expect(buttons(db).map((b) => b.text)).toEqual(["✓ qwen3 · 32768 tokens", "✓ ⚠ chatty · 8192 tokens", "nolen · no context length", "Done"]);
    // The key never appears on a card.
    expect(JSON.stringify(db.select().from(controlCards).all())).not.toContain("sk-example");
    // And the switch card marks the model whose tools did not work.
    say(db, "/model 1");
    expect(buttons(db).map((b) => b.text)).toContain("⚠ lab/chatty");
    expect(lastCard(db).text).toContain("⚠: its last probe got no tool call.");
  });

  test("a listing that fails is shown on the card, and the provider stays", async () => {
    const { db } = setup();
    say(db, "/provider add down http://127.0.0.1:9/v1");
    backgroundPass(db, { secretsFile: "/nonexistent" });
    await backgroundSettled();
    const card = lastCard(db);
    expect(card.status).toBe("closed");
    expect(card.text).toStartWith("Added provider down (http://127.0.0.1:9/v1). Listing its models failed: ");
    expect(card.text).toEndWith("\nThe provider stays. Add a model with /models add down/<model> <context_window>.");
    expect(getProvider(db, "down")).toBeDefined();
  });

  test("add a Claude login; refuse a bad one", () => {
    const { db } = setup();
    say(db, "/provider add work claude /srv/example-claude");
    say(db, "/provider add Bad! http://x");
    say(db, "/provider add x ftp://x");
    say(db, "/provider frob");
    expect(replies(db)).toEqual([
      "Added Claude login work (/srv/example-claude). Add its models with /models add work/<model>.",
      'Could not add provider Bad!: "Bad!" is not a provider name: lower-case letters, digits, \'.\', \'_\' and \'-\', at most 40',
      "Could not add provider x: the base URL must be http(s)",
      "Usage: /provider add <name> <base_url> [<profile>.<VAR>], /provider add <name> claude [<config_dir>], or /provider remove <name>",
    ]);
    expect(getProvider(db, "work")).toMatchObject({ kind: "claude", configDir: "/srv/example-claude" });
  });

  test("remove names its models and the chats on them, then removes them all; one holding the default is refused", () => {
    const { db, chatId } = setup();
    say(db, "/provider remove vllm");
    expect(replies(db)).toEqual(["vllm/qwen is the default model: make a model of another provider the default first."]);
    say(db, "/models");
    press(db, button(db, "1 · Make default"));
    db.$client.query("update chats set model = 'vllm/llama' where id = ?").run(chatId);
    say(db, "/provider remove vllm");
    const id = lastCard(db).id;
    expect(getCard(db, id)!.text).toBe("Remove provider vllm and its 2 models (vllm/qwen, vllm/llama)?\nChats on them: chat 1 (tg 1001). Their next turn fails until they get another model.");
    press(db, button(db, "Remove vllm"));
    expect(getCard(db, id)).toMatchObject({ status: "closed", text: "Removed provider vllm and its 2 models (vllm/qwen, vllm/llama)." });
    expect(getProvider(db, "vllm")).toBeUndefined();
    expect(findModel(db, "vllm/llama")).toBeUndefined();
  });
});

describe("probes", () => {
  test("a probe left checking (a restart) runs again at the next pass; vision follows it unless the owner set it", async () => {
    const { db } = setup();
    const fake = fakeEndpoint();
    addProvider(db, { name: "lab", kind: "openai-compat", baseUrl: fake.url });
    const m = addModel(db, { provider: "lab", model: "qwen3", contextWindow: 32768 });
    // As a restart leaves it: `checking`, with no probe running in this process.
    db.update(models).set({ probeStatus: "checking" }).where(eqId(m.model.id)).run();
    db.update(models).set({ vision: true }).where(eqId(m.model.id)).run();
    expect(backgroundPass(db, { secretsFile: "/nonexistent" })).toBe(1);
    await backgroundSettled();
    expect(findModel(db, "lab/qwen3")!.model).toMatchObject({ probeStatus: "ok", vision: false, probeVision: false });
    setModelVision(db, "lab/qwen3", true);
    markProbing(db, m.model.id);
    backgroundPass(db, { secretsFile: "/nonexistent" });
    await backgroundSettled();
    expect(findModel(db, "lab/qwen3")!.model).toMatchObject({ probeStatus: "ok", vision: true, visionSet: true });
    // Claude models are not probed.
    expect(markProbing(db, findModel(db, "claude/opus")!.model.id)).toBe(false);
  });

  test("a probe's result as the row keeps it", () => {
    expect(probeRecord({ toolCall: "ok", latencyMs: 12, vision: { result: "accepted", latencyMs: 3 } })).toEqual({ status: "ok", error: null, latencyMs: 12, vision: true });
    expect(probeRecord({ toolCall: "error", latencyMs: 5, error: { kind: "unreachable", message: "fetch failed with sk-secret" } }, (s) => s.replace("sk-secret", "[key]"))).toEqual({
      status: "failed",
      error: "unreachable: fetch failed with [key]",
      latencyMs: 5,
      vision: null,
    });
  });

  test("a model removed while its probe ran: the result is dropped", async () => {
    const { db } = setup();
    const fake = fakeEndpoint();
    addProvider(db, { name: "lab", kind: "openai-compat", baseUrl: fake.url });
    const m = addModel(db, { provider: "lab", model: "qwen3", contextWindow: 32768 });
    markProbing(db, m.model.id);
    backgroundPass(db, { secretsFile: "/nonexistent" });
    db.delete(models).where(eqId(m.model.id)).run();
    await backgroundSettled();
    expect(findModel(db, "lab/qwen3")).toBeUndefined();
  });
});

describe("cards stay bounded, current and safe", () => {
  test("/model in the chat is one transaction: a failure leaves no card, no 👌 and the command pending, and a retry sends it", () => {
    const { db, chatId } = setup();
    recordInbound(db, { chatId, kind: "command", payload: { from: { id: OWNER, name: "Owner" }, command: "model" }, tgUpdateId: 900, tgMessageId: 900 });
    db.$client.run("create trigger no_cards before insert on control_messages when new.kind = 'card' begin select raise(abort, 'simulated crash'); end");
    expect(() => commandPass(db, () => {})).toThrow("simulated crash");
    expect(db.select().from(controlCards).all()).toEqual([]);
    expect(db.select().from(chatEvents).all().filter((e) => e.kind === "bot_reaction")).toEqual([]);
    expect(db.select().from(chatEvents).all().find((e) => e.kind === "command")!.status).toBe("pending");
    db.$client.run("drop trigger no_cards");
    expect(commandPass(db, () => {})).toBe(1);
    expect(controlMessagesOf(db, "card")).toHaveLength(1);
    expect(db.select().from(chatEvents).all().filter((e) => e.kind === "bot_reaction")).toHaveLength(1);
  });

  test("a command or press that throws is answered with its error; the rest of the batch and the offset stand", () => {
    const { db } = setup();
    say(db, "/model 1");
    const data = button(db, "vllm/llama");
    db.$client.run("create trigger frozen before update on control_cards begin select raise(abort, 'simulated failure'); end");
    const out = recordControlBatch(
      db,
      [
        { update_id: 7001, callback_query: { id: "cqx", from: { id: OWNER, is_bot: false, first_name: "Owner" }, chat_instance: "x", data } } as unknown as Update,
        { update_id: 7002, message: { message_id: 1, date: 0, chat: { id: OWNER, type: "private", first_name: "Owner" }, from: { id: OWNER, is_bot: false, first_name: "Owner" }, text: "/turn" } } as unknown as Update,
      ],
      deps,
    );
    expect(out.callbacks[0]!.text).toBe("Failed: simulated failure");
    expect(replies(db).at(-1)).toBe("Usage: /turn <id>");
    db.$client.run("drop trigger frozen");
    expect(lastCard(db).text).toStartWith("Model for"); // unchanged: the press's writes were undone
    expect(db.$client.query("select value from kv where key = 'control_telegram_offset'").get()).toEqual({ value: "7003" });
  });

  test("the /provider add card stays under Telegram's limit with its note first, however many models; so does removing it", () => {
    const db = memDb();
    addProvider(db, { name: "claude", kind: "claude" });
    addModel(db, { provider: "claude", model: "opus", isDefault: true });
    say(db, "/provider add lab http://127.0.0.1:9/v1");
    const card = lastCard(db);
    const listed = Array.from({ length: 40 }, (_, i) => ({ model: `org/some-fairly-long-model-name-${i}`, contextWindow: 32768 }));
    for (const l of listed) {
      const m = addModel(db, { provider: "lab", model: l.model, contextWindow: 32768 });
      recordProbe(db, m.model.id, { status: "failed", error: "x".repeat(199), latencyMs: 300000, vision: null });
    }
    finishListing(db, card.id, { listed: [...listed, { model: "nolen" }] });
    for (let i = 0; i < 6; i++) press(db, button(db, "›")); // to the last page (41 entries, 6 a page)
    press(db, button(db, "nolen · no context length"));
    const text = getCard(db, card.id)!.text;
    expect(text.length).toBeLessThan(4096);
    expect(text.split("\n")[1]).toBe("The listing gives no context length for nolen. Add it with /models add lab/nolen <context_window>.");
    // Page 1: its six models' probe lines, no more.
    press(db, button(db, "‹"));
    expect(getCard(db, card.id)!.text.split("\n").filter((l) => l.includes(": probe ")).length).toBe(6);
    say(db, "/provider remove lab");
    const remove = lastCard(db).text;
    expect(remove.length).toBeLessThan(4096);
    expect(remove).toContain("lab/org/some-fairly-long-model-name-9 and 30 more)?");
  });

  test("a newer switch card for a chat, or a newer /models card, supersedes the older open ones", () => {
    const { db } = setup();
    say(db, "/model 1");
    const first = lastCard(db).id;
    say(db, "/models");
    const models1 = lastCard(db).id;
    say(db, "/model 1");
    say(db, "/models");
    expect(getCard(db, first)).toMatchObject({ status: "closed", text: "Superseded by a newer card.", keyboard: [] });
    expect(getCard(db, models1)).toMatchObject({ status: "closed", text: "Superseded by a newer card." });
    expect(db.select().from(controlCards).all().filter((c) => c.status === "open")).toHaveLength(2);
  });

  test("an open mode step is redrawn when a turn starts or ends in its chat; a probe finishing leaves switch cards alone", () => {
    const { db, chatId } = setup();
    say(db, "/model 1");
    const id = lastCard(db).id;
    press(db, button(db, "vllm/llama"));
    const rev = getCard(db, id)!.rev;
    expect(switchCardPass(db)).toBe(0);
    expect(getCard(db, id)!.rev).toBe(rev); // nothing changed: no edit
    const turn = claimTurn(db, chatId)!;
    switchCardPass(db);
    expect(getCard(db, id)!.text.split("\n").at(-1)).toBe(`turn ${turn.id} is running and will be stopped`);
    const version = getCard(db, id)!.version;
    finishTurn(db, turn.id, { status: "done" });
    switchCardPass(db);
    expect(getCard(db, id)!.text).not.toContain("is running");
    expect(getCard(db, id)!.version).toBe(version); // a redraw, not a step: the Lossless button still counts
    const after = getCard(db, id)!.rev;
    const m = findModel(db, "vllm/qwen")!;
    markProbing(db, m.model.id);
    recordProbe(db, m.model.id, { status: "failed", error: "x", latencyMs: 1, vision: null });
    catalogChanged(db);
    expect(getCard(db, id)!.rev).toBe(after);
  });

  test("the /models card follows the catalog: a model added by command, or made the default on another card", () => {
    const { db } = setup();
    say(db, "/models");
    const id = lastCard(db).id;
    say(db, "/models add vllm/mistral 16384");
    expect(getCard(db, id)!.text).toContain("4. vllm/mistral\n   16384 tokens · no vision · probe checking…");
    say(db, "/provider add lab http://127.0.0.1:9/v1");
    say(db, "/models add lab/q 8000");
    expect(getCard(db, id)!.text).toContain("5. lab/q");
    say(db, "/provider remove lab");
    press(db, button(db, "Remove lab"));
    expect(getCard(db, id)!.text).not.toContain("lab/q");
  });

  test("no edit for a relative time moving on alone", () => {
    const { db } = setup();
    say(db, "/model 1 vllm/llama lossy");
    switchRequestPass(db, () => {});
    switchCardPass(db);
    // Parked qwen two hours ago.
    db.$client.run("update chat_conversations set parked_at = ?", [new Date(Date.now() - 2 * 3600_000).toISOString()]);
    say(db, "/model 1");
    const id = lastCard(db).id;
    press(db, button(db, "vllm/qwen"));
    expect(getCard(db, id)!.text).toContain("resumes vllm/qwen's conversation from 2 hours ago");
    const rev = getCard(db, id)!.rev;
    db.$client.run("update chat_conversations set parked_at = ?", [new Date(Date.now() - 5 * 3600_000).toISOString()]);
    const turn = claimTurn(db, getCard(db, id)!.chatId!)!;
    finishTurn(db, turn.id, { status: "done" });
    // A redraw whose only change would be "5 hours ago": none queued.
    refreshCards(db, ["switch"]);
    expect(getCard(db, id)!.rev).toBe(rev);
    expect(getCard(db, id)!.text).toContain("from 2 hours ago");
  });

  test("a probe that could not even be sent records no latency; Cancel while listing closes the card and drops the listing", async () => {
    const { db } = setup();
    addProvider(db, { name: "keyed", kind: "openai-compat", baseUrl: "http://127.0.0.1:9/v1", apiKey: "lab.MISSING" });
    const m = addModel(db, { provider: "keyed", model: "q", contextWindow: 8000 });
    markProbing(db, m.model.id);
    backgroundPass(db, { secretsFile: "/nonexistent" });
    await backgroundSettled();
    const row = findModel(db, "keyed/q")!;
    expect(row.model).toMatchObject({ probeStatus: "failed", probeLatencyMs: null });
    expect(probeText(row)).toBe("⚠ failed: the key lab.MISSING is not in the secrets file /nonexistent");

    const fake = fakeEndpoint();
    say(db, `/provider add lab ${fake.url}`);
    const id = lastCard(db).id;
    expect(buttons(db).map((b) => b.text)).toEqual(["Cancel"]);
    press(db, button(db, "Cancel"));
    expect(getCard(db, id)).toMatchObject({ status: "closed", text: "Cancelled. The provider lab stays; /provider remove lab removes it." });
    backgroundPass(db, { secretsFile: "/nonexistent" });
    await backgroundSettled();
    expect(getCard(db, id)!.text).toStartWith("Cancelled.");
    expect(getProvider(db, "lab")).toBeDefined();
  });
});

function eqId(id: number) {
  return eq(models.id, id);
}
