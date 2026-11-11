import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJimp } from "@jimp/core";
import webp from "@jimp/wasm-webp";
import type { ToolResult } from "agent-runtime";
import { Api } from "grammy";
import type { Sticker, StickerSet } from "grammy/types";
import { defaultFormats, defaultPlugins } from "jimp";
import { buildSystemPrompt } from "../src/agent/prompt.ts";
import { runTurn } from "../src/agent/turn.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import { fetchPass, setStickers } from "../src/capabilities/stickers/fetch.ts";
import { findStickers, getSticker, MATCH_USE, ROLE_WEIGHT, TIER_WEIGHT, USE_PENALTY } from "../src/capabilities/stickers/find.ts";
import { parsePack, syncLibrary } from "../src/capabilities/stickers/library.ts";
import { refusal } from "../src/capabilities/stickers/rules.ts";
import { cellBox, decode, PER_PAGE, renderContactSheet } from "../src/capabilities/stickers/sheet.ts";
import { sendPass } from "../src/server/sender.ts";
import type { Db } from "../src/store/db.ts";
import { enqueueOutbound, ensureChat, getChat, recordInbound } from "../src/store/events.ts";
import { claimTurn } from "../src/store/turns.ts";
import { telegramFiles } from "../src/telegram/files.ts";
import { FakeTelegram, memDb, OWNER, ownerChatId, ownerSays, ScriptedAdapter, type Step } from "./helpers.ts";

const Jimp = createJimp({ formats: [...defaultFormats, webp], plugins: defaultPlugins });

let tg: FakeTelegram | null = null;
afterEach(() => {
  tg?.stop();
  tg = null;
});

// ---- the world: a data dir, home/stickers/, a fake Bot API serving sets and their pictures ------------

/** Distinct colours: a 4-level RGB grid without the near-white corner, so no two are alike and none is the background. */
const COLOURS: [number, number, number][] = [];
for (const r of [0, 85, 170, 255]) for (const g of [0, 85, 170, 255]) for (const b of [0, 85, 170, 255]) if (r + g + b < 600) COLOURS.push([r, g, b]);

async function webpOf([r, g, b]: [number, number, number], w = 128, h = 128): Promise<Buffer> {
  const img = new Jimp({ width: w, height: h, color: ((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0 });
  return img.getBuffer("image/webp");
}

interface World {
  db: Db;
  dataDir: string;
  home: string;
  tg: FakeTelegram;
  files: ReturnType<typeof telegramFiles>;
}

function world(): World {
  const db = memDb();
  const dataDir = mkdtempSync(join(tmpdir(), "shuvi-stickers-"));
  const home = join(dataDir, "home");
  mkdirSync(join(home, "stickers"), { recursive: true });
  tg = new FakeTelegram();
  const files = telegramFiles(new Api("TOKEN", { apiRoot: tg.apiRoot }), "TOKEN", tg.apiRoot);
  return { db, dataDir, home, tg, files };
}

/** Put a set of `count` static stickers on the fake Bot API, sticker i coloured COLOURS[i]. Ids are `<name>-<i+1>`. */
async function serveSet(w: World, name: string, count: number, opts: { narrow?: number[]; noPicture?: number[] } = {}): Promise<void> {
  const stickers: Sticker[] = [];
  for (let i = 0; i < count; i++) {
    const n = i + 1;
    const fileId = `${name}-f${n}`;
    const narrow = opts.narrow?.includes(n);
    stickers.push({ file_id: fileId, file_unique_id: `${name}-${n}`, type: "regular", width: 512, height: narrow ? 128 : 512, is_animated: false, is_video: false, emoji: "🙂", set_name: name } as Sticker);
    if (!opts.noPicture?.includes(n)) w.tg.files.set(fileId, await webpOf(COLOURS[i % COLOURS.length]!));
  }
  w.tg.stickerSets.set(name, { name, title: `${name} title`, sticker_type: "regular", stickers } as StickerSet);
}

interface Entry {
  n: number;
  desc?: string;
  use?: string;
  tier?: string;
  dm_only?: boolean;
}

function packYaml(pack: string, role: string, entries: Entry[], extra = ""): string {
  const lines = [`pack: ${pack}`, `role: ${role}`, ...(extra ? [extra] : []), "stickers:"];
  for (const e of entries) {
    lines.push(`  - n: ${e.n}`, `    file_unique_id: ${pack}-${e.n}`);
    if (e.desc) lines.push(`    desc: ${JSON.stringify(e.desc)}`);
    if (e.use) lines.push(`    use: ${JSON.stringify(e.use)}`);
    if (e.tier) lines.push(`    tier: ${e.tier}`);
    if (e.dm_only) lines.push(`    dm_only: true`);
  }
  return `${lines.join("\n")}\n`;
}

const writePack = (w: World, pack: string, role: string, entries: Entry[], extra = "") => writeFileSync(join(w.home, "stickers", `${pack}.yaml`), packYaml(pack, role, entries, extra));

/** Index, ask for and fetch every pack written so far. */
async function ready(w: World): Promise<void> {
  syncLibrary(w.db, w.home);
  const { requestMissingSets } = await import("../src/capabilities/stickers/fetch.ts");
  requestMissingSets(w.db);
  await fetchPass(w.db, w.files, w.dataDir);
}

const ids = (w: World, terms: string[], opts: { inDm?: boolean; pack?: string } = {}) =>
  findStickers(w.db, { terms, inDm: opts.inDm ?? true, ...(opts.pack ? { pack: opts.pack } : {}) }).candidates.map((c) => c.id);

const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

const capsFor = (w: World) => enabledCapabilities({ SHUVI_DATA_DIR: w.dataDir, SHUVI_OWNER_ID: String(OWNER), SHUVI_WEB: "off", SHUVI_VISION: "off" });

/** Run one owner-DM turn with the stickers capability on this world's data dir. */
async function turn(w: World, script: Step[], text = "hi"): Promise<ScriptedAdapter> {
  ownerSays(w.db, text);
  const t = claimTurn(w.db, ownerChatId(w.db))!;
  let adapter!: ScriptedAdapter;
  await runTurn({
    db: w.db,
    turnId: t.id,
    home: w.home,
    timeZone: "UTC",
    ownerId: OWNER,
    capabilities: capsFor(w),
    makeAdapter: (b) => (adapter = new ScriptedAdapter(b, script)),
  });
  return adapter;
}

let groupUpdate = 90_000;
/** Run one turn in a group, answering someone who is not the owner. */
async function groupTurn(w: World, script: Step[]): Promise<ScriptedAdapter> {
  const chat = ensureChat(w.db, { id: -100777, kind: "group", title: "G" });
  recordInbound(w.db, { chatId: chat.id, kind: "message", payload: { from: { id: 2002, name: "Someone" }, text: "hey" }, tgUpdateId: groupUpdate++, tgMessageId: groupUpdate });
  const t = claimTurn(w.db, chat.id)!;
  let adapter!: ScriptedAdapter;
  await runTurn({ db: w.db, turnId: t.id, home: w.home, timeZone: "UTC", ownerId: OWNER, capabilities: capsFor(w), makeAdapter: (b) => (adapter = new ScriptedAdapter(b, script)) });
  return adapter;
}

const outbound = (db: Db) => db.$client.query("select kind, payload, status from chat_events where kind in ('bot_message','bot_sticker') order by seq").all() as { kind: string; payload: string; status: string }[];

// ---- the format -------------------------------------------------------------------------------------

describe("the pack file", () => {
  test("parses design §12's shape; an omitted tier is normal; empty desc and use are allowed", () => {
    const p = parsePack(packYaml("Cats", "avatar", [{ n: 1, desc: "an OK sign", use: "OK, got it", tier: "go-to" }, { n: 2 }], "dm_only: true"));
    expect(p).toMatchObject({ pack: "Cats", role: "avatar", dm_only: true, stickers: [{ n: 1, desc: "an OK sign", use: "OK, got it", tier: "go-to" }, { n: 2, desc: "", use: "" }] });
    expect(p.stickers[1]!.tier ?? "normal").toBe("normal");
  });

  test("says what is wrong", () => {
    expect(() => parsePack("pack: Cats\nrole: hero\nstickers: []\n")).toThrow(/role/);
    expect(() => parsePack(packYaml("Cats", "meme", [{ n: 1 }, { n: 1 }]))).toThrow(/n 1 appears twice/);
    expect(() => parsePack("pack: [\n")).toThrow(/YAML/);
  });
});

// ---- the index --------------------------------------------------------------------------------------

describe("the index follows the files", () => {
  test("a changed file is re-indexed, a removed one dropped, a broken one keeps its last good version", async () => {
    const w = world();
    await serveSet(w, "Cats", 3);
    writePack(w, "Cats", "common", [{ n: 1, desc: "a cat waving", use: "hello" }]);
    await ready(w);
    expect(ids(w, ["waving"])).toEqual(["Cats/1"]);

    // An edit by hand (or by memory's edit_home): no one tells the index; the next read notices.
    writePack(w, "Cats", "common", [{ n: 1, desc: "a cat sleeping", use: "good night" }, { n: 2, desc: "a cat waving", use: "hello" }]);
    expect(syncLibrary(w.db, w.home).changed).toEqual(["Cats.yaml"]);
    expect(ids(w, ["waving"])).toEqual(["Cats/2"]);
    expect(ids(w, ["sleeping"])).toEqual(["Cats/1"]);
    expect(syncLibrary(w.db, w.home).changed).toEqual([]); // unchanged bytes: nothing to do

    writeFileSync(join(w.home, "stickers", "Cats.yaml"), "pack: Cats\nrole: [oops\n");
    const broken = syncLibrary(w.db, w.home);
    expect(broken.errors[0]!.file).toBe("Cats.yaml");
    expect(ids(w, ["waving"])).toEqual(["Cats/2"]);

    rmSync(join(w.home, "stickers", "Cats.yaml"));
    syncLibrary(w.db, w.home);
    expect(ids(w, ["waving"])).toEqual([]);
  });

  test("full text over desc and use, any script, short terms included", async () => {
    const w = world();
    await serveSet(w, "Cats", 2);
    writePack(w, "Cats", "common", [{ n: 1, desc: "貓咪比讚", use: "好的、收到" }, { n: 2, desc: "a Thumbs-Up cat", use: "agreeing" }]);
    await ready(w);
    expect(ids(w, ["收到"])).toEqual(["Cats/1"]);
    expect(ids(w, ["比讚的"])).toEqual([]);
    expect(ids(w, ["thumbs"])).toEqual(["Cats/2"]);
    expect(ids(w, ["收到", "agree"]).sort()).toEqual(["Cats/1", "Cats/2"]);
  });
});

// ---- ranking ----------------------------------------------------------------------------------------

describe("find_sticker's ranking", () => {
  async function three(w: World, tiers: [string?, string?, string?] = []) {
    for (const [i, [pack, role]] of [["Ava", "avatar"], ["Com", "common"], ["Mem", "meme"]].entries()) {
      await serveSet(w, pack!, 2);
      writePack(w, pack!, role!, [{ n: 1, desc: "thumbs up", use: "ok", ...(tiers[i] ? { tier: tiers[i] } : {}) }]);
    }
    await ready(w);
  }

  test("an equal match ranks by the pack's role: avatar > common > meme", async () => {
    const w = world();
    await three(w);
    expect(ids(w, ["ok"])).toEqual(["Ava/1", "Com/1", "Mem/1"]);
  });

  test("then by tier: go-to lifts, rare sinks", async () => {
    const w = world();
    await three(w, ["rare", undefined, "go-to"]);
    // avatar+rare = 0.25, common = 0.5, meme+go-to = 0.75
    expect(ROLE_WEIGHT.avatar + TIER_WEIGHT.rare).toBeLessThan(ROLE_WEIGHT.common);
    expect(ids(w, ["ok"])).toEqual(["Mem/1", "Com/1", "Ava/1"]);
  });

  test("how well it matches comes first: more terms, and a match in use over one in desc", async () => {
    const w = world();
    await serveSet(w, "Mem", 3);
    await serveSet(w, "Ava", 2);
    writePack(w, "Mem", "meme", [{ n: 1, desc: "a cat", use: "ok, agreed, sure" }, { n: 2, desc: "ok sign", use: "" }]);
    writePack(w, "Ava", "avatar", [{ n: 1, desc: "", use: "ok" }]);
    await ready(w);
    // Mem/1 matches three terms in use (3) over Ava/1's one (1 + avatar 1); Mem/2's desc-only match (0.6) is last.
    expect(ids(w, ["ok", "agreed", "sure"])).toEqual(["Mem/1", "Ava/1", "Mem/2"]);
    // A match in use outranks the same match in desc.
    expect(ids(w, ["ok"], { pack: "Mem" })).toEqual(["Mem/1", "Mem/2"]);
  });

  test("minus her recent uses, counted from chat_events, and each candidate shows them", async () => {
    const w = world();
    await three(w);
    const chat = ownerChatId(w.db);
    for (let k = 0; k < 2; k++) {
      enqueueOutbound(w.db, { chatId: chat, kind: "bot_sticker", payload: { fileId: "Ava-f1", fileUniqueId: "Ava-1", stickerId: "Ava/1" }, idemKey: `x:${k}`, turnId: 1 });
    }
    // 1 (avatar) - 2 × 0.5 = 0 < common 0.5; = meme 0, tie broken by role.
    expect(USE_PENALTY * 2).toBe(ROLE_WEIGHT.avatar);
    const got = findStickers(w.db, { terms: ["ok"], inDm: true }).candidates;
    expect(got.map((c) => [c.id, c.recentUses])).toEqual([["Com/1", 0], ["Ava/1", 2], ["Mem/1", 0]]);
    expect(got[0]!.score).toBe(MATCH_USE + ROLE_WEIGHT.common);
  });

  test("never and narrow stickers are not offered, unless named by id", async () => {
    const w = world();
    await serveSet(w, "Cats", 3, { narrow: [2] });
    writePack(w, "Cats", "common", [{ n: 1, desc: "wave", tier: "never" }, { n: 2, desc: "wave" }, { n: 3, desc: "wave" }]);
    await ready(w);
    expect(ids(w, ["wave"])).toEqual(["Cats/3"]);
    expect(ids(w, ["Cats/1", "Cats/2"]).sort()).toEqual(["Cats/1", "Cats/2"]);
  });

  test("outside the owner's DM, dm_only stickers and packs are not offered, even by id", async () => {
    const w = world();
    await serveSet(w, "Cats", 2);
    await serveSet(w, "Mine", 1);
    writePack(w, "Cats", "common", [{ n: 1, desc: "wave", dm_only: true }, { n: 2, desc: "wave" }]);
    writePack(w, "Mine", "avatar", [{ n: 1, desc: "wave" }], "dm_only: true");
    await ready(w);
    expect(ids(w, ["wave"], { inDm: true })).toEqual(["Mine/1", "Cats/1", "Cats/2"]);
    expect(ids(w, ["wave", "Cats/1", "Mine/1"], { inDm: false })).toEqual(["Cats/2"]);
  });

  test("pack limits the search; a pack not fetched yet is left out and counted", async () => {
    const w = world();
    await serveSet(w, "Cats", 1);
    await serveSet(w, "Dogs", 1);
    writePack(w, "Cats", "common", [{ n: 1, desc: "wave" }]);
    writePack(w, "Dogs", "common", [{ n: 1, desc: "wave" }]);
    await ready(w);
    expect(ids(w, ["wave"], { pack: "Dogs" })).toEqual(["Dogs/1"]);
    writePack(w, "Fox", "avatar", [{ n: 1, desc: "wave" }]);
    syncLibrary(w.db, w.home);
    expect(findStickers(w.db, { terms: ["wave"], inDm: true })).toMatchObject({ unfetched: 1 });
  });
});

// ---- the mechanical rules ---------------------------------------------------------------------------

describe("sticker(): the rules the tool enforces", () => {
  async function library(w: World) {
    await serveSet(w, "Cats", 4);
    writePack(w, "Cats", "common", [{ n: 1, desc: "wave" }, { n: 2, desc: "nod" }, { n: 3, desc: "bad", tier: "never" }, { n: 4, desc: "secret", dm_only: true }]);
    await ready(w);
  }

  test("two stickers in a row: the second is refused, with why; text between them is fine", async () => {
    const w = world();
    await library(w);
    const a = await turn(w, [{ tool: "sticker", args: { id: "Cats/1" } }, { tool: "sticker", args: { id: "Cats/2" } }, { token: "ha" }, { tool: "sticker", args: { id: "Cats/2" } }]);
    expect(a.toolResults.map((r) => !!r.result.isError)).toEqual([false, true, false]);
    expect(textOf(a.toolResults[1]!.result)).toContain("One sticker at a time");
    expect(outbound(w.db).map((o) => o.kind)).toEqual(["bot_sticker", "bot_message", "bot_sticker"]);
  });

  test("a sticker in the next turn after hers, with nothing from them between, is still two in a row", async () => {
    const w = world();
    await library(w);
    await turn(w, [{ tool: "sticker", args: { id: "Cats/1" } }]);
    const chat = ownerChatId(w.db);
    const s = getSticker(w.db, "Cats/2")!;
    expect(refusal(w.db, chat, 1e9, s, true)).toContain("One sticker at a time");
    ownerSays(w.db, "lol");
    expect(refusal(w.db, chat, 1e9, s, true)).toBeNull();
  });

  test("never echo the sticker they just sent", async () => {
    const w = world();
    await library(w);
    // They send Cats/1, then a line of text; both are "since she last spoke".
    ownerSays(w.db, "[sticker: 🙂, Cats]", { placeholder: true, media: { kind: "sticker", fileUniqueId: "Cats-1", file: null, state: "none" } });
    const a = await turn(w, [{ tool: "sticker", args: { id: "Cats/1" } }, { tool: "sticker", args: { id: "Cats/2" } }], "look");
    expect(textOf(a.toolResults[0]!.result)).toBe("Cats/1 is the sticker they just sent you. Do not echo it back; pick another, or answer in words.");
    expect(textOf(a.toolResults[1]!.result)).toBe("Sent Cats/2.");
    // Once she has spoken, it is no longer "just sent".
    ownerSays(w.db, "again");
    expect(refusal(w.db, ownerChatId(w.db), 1e9, getSticker(w.db, "Cats/1")!, true)).toBeNull();
  });

  test("never is refused; dm_only is refused outside the DM; an unknown id is refused", async () => {
    const w = world();
    await library(w);
    const a = await turn(w, [{ tool: "sticker", args: { id: "Cats/3" } }, { tool: "sticker", args: { id: "Cats/9" } }, { tool: "sticker", args: { id: "Cats/4" } }]);
    expect(a.toolResults.map((r) => textOf(r.result))).toEqual([
      "Cats/3 is marked never: it is not to be sent.",
      "Cats/9 is not in the sticker library. Use an id that find_sticker gave you.",
      "Sent Cats/4.",
    ]);
    const group = ensureChat(w.db, { id: -100, kind: "group", title: "G" });
    expect(refusal(w.db, group.id, 1e9, getSticker(w.db, "Cats/4")!, false)).toContain("owner's DM only");
  });
});

// ---- delivery -----------------------------------------------------------------------------------------

describe("delivery", () => {
  test("find_sticker then sticker: the sender delivers it with sendSticker and records its message id", async () => {
    const w = world();
    await serveSet(w, "Cats", 2);
    writePack(w, "Cats", "common", [{ n: 1, desc: "a cat waving", use: "hello" }, { n: 2, desc: "a cat nodding", use: "ok" }]);
    await ready(w);
    const a = await turn(w, [{ tool: "find_sticker", args: { terms: ["hello"] } }, { token: "Hi!" }, { tool: "sticker", args: { id: "Cats/1" } }]);
    expect(textOf(a.toolResults[0]!.result)).toContain("- Cats/1 🙂\n  shows: a cat waving\n  use: hello");
    const api = new Api("TOKEN", { apiRoot: w.tg.apiRoot });
    expect(await sendPass(w.db, api)).toMatchObject({ sent: 2, failed: 0 });
    expect(w.tg.calls.filter((c) => c.method === "sendMessage" || c.method === "sendSticker").map((c) => c.method)).toEqual(["sendMessage", "sendSticker"]);
    expect(w.tg.sent("sendSticker")[0]).toMatchObject({ chat_id: getChat(w.db, ownerChatId(w.db))!.tgChatId, sticker: "Cats-f1" });
    const row = w.db.$client.query("select status, tg_message_id from chat_events where kind = 'bot_sticker'").get() as { status: string; tg_message_id: number };
    expect(row.status).toBe("sent");
    expect(row.tg_message_id).toBeGreaterThan(0);
  });
});

// ---- the contact sheet and add_sticker_pack ------------------------------------------------------------

describe("the contact sheet", () => {
  const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) < 40);

  test(`every sticker, in order, ${PER_PAGE} to a page, none missing (a missing picture still has its numbered cell)`, async () => {
    const w = world();
    const count = PER_PAGE + 7;
    await serveSet(w, "Big", count, { noPicture: [5] });
    const { requestSet } = await import("../src/capabilities/stickers/fetch.ts");
    requestSet(w.db, "Big");
    await fetchPass(w.db, w.files, w.dataDir);
    const metas = setStickers(w.db, "Big");
    expect(metas.map((m) => m.position)).toEqual(Array.from({ length: count }, (_, i) => i + 1));

    const pages = await renderContactSheet(metas.map((m) => ({ n: m.position, path: m.path })), w.dataDir);
    expect(pages.map((p) => p.numbers)).toEqual([Array.from({ length: PER_PAGE }, (_, i) => i + 1), Array.from({ length: 7 }, (_, i) => PER_PAGE + i + 1)]);
    for (const [k, p] of pages.entries()) {
      const img = await decode(p.image);
      p.numbers.forEach((n, i) => {
        const box = cellBox(i);
        const at = img.bitmap.data.subarray(((box.y + box.size / 2) * img.bitmap.width + box.x + box.size / 2) * 4);
        const px = [at[0]!, at[1]!, at[2]!];
        if (n === 5) expect(near(px, [255, 255, 255])).toBe(true);
        else expect({ page: k, n, ok: near(px, COLOURS[n - 1]!) }).toEqual({ page: k, n, ok: true });
      });
    }
  });

  test("add_sticker_pack: the server fetches the set, she gets the sheet, and a new pack's skeleton is committed with its role; she reads it and fills it in with write_home; the index picks it up; a pack she already has is read first, then edited", async () => {
    const w = world();
    await serveSet(w, "Fox", 3);
    // The server's loop, running beside the turn as it would in production.
    let running = true;
    const loop = (async () => {
      while (running) {
        await fetchPass(w.db, w.files, w.dataDir);
        await Bun.sleep(20);
      }
    })();
    const filled = packYaml("Fox", "meme", [{ n: 1, desc: "a fox waving", use: "hello" }, { n: 2, desc: "a fox sleeping", use: "good night", tier: "go-to" }, { n: 3 }]);
    const a = await turn(w, [
      { tool: "add_sticker_pack", args: { name: "Fox", role: "meme" } },
      { tool: "write_home", args: { path: "stickers/Fox.yaml", content: filled, why: "unread" } },
      { tool: "read_home", args: { path: "stickers/Fox.yaml" } },
      { tool: "write_home", args: { path: "stickers/Fox.yaml", content: filled, why: "Describe the Fox pack" } },
      { tool: "write_home", args: { path: "stickers/preferences.md", content: "Prefer the fox.\n", why: "The owner likes the fox" } },
      { tool: "find_sticker", args: { terms: ["night"] } },
    ]);
    running = false;
    await loop;

    const first = a.toolResults[0]!.result;
    expect(first.isError).toBeFalsy();
    expect(first.content.filter((c) => c.type === "image")).toHaveLength(1);
    const skeleton = textOf(first);
    expect(skeleton).toContain("Fox title: 3 stickers");
    expect(skeleton).toContain("created it as this skeleton (commit ");
    for (const n of [1, 2, 3]) expect(skeleton).toContain(`  - n: ${n}  # 🙂\n    file_unique_id: "Fox-${n}"\n    desc:\n    use:`);
    const yaml = skeleton.split("```yaml\n")[1]!.split("```")[0]!;
    expect(parsePack(yaml)).toMatchObject({ pack: "Fox", role: "meme" });
    expect(parsePack(yaml).stickers).toHaveLength(3);

    // The skeleton was committed as-is; a whole write without reading it first is refused.
    expect(a.toolResults[1]!.result.isError).toBe(true);
    expect(textOf(a.toolResults[1]!.result)).toContain("not read in this turn");
    expect(a.toolResults.slice(2, 5).map((r) => !!r.result.isError)).toEqual([false, false, false]);
    expect(readFileSync(join(w.home, "stickers", "Fox.yaml"), "utf8")).toBe(filled);
    const log = Bun.spawnSync(["git", "-C", w.home, "log", "--format=%an|%s"]).stdout.toString().trim().split("\n");
    expect(log).toEqual(["shuvi|The owner likes the fox", "shuvi|Describe the Fox pack", "shuvi|stickers: skeleton for Fox"]);
    const committed = Bun.spawnSync(["git", "-C", w.home, "show", "HEAD~2:stickers/Fox.yaml"]).stdout.toString();
    expect(committed).toBe(yaml);
    expect(textOf(a.toolResults[5]!.result)).toContain("Fox/2");

    // Again, now that the file exists: the skeleton says to read it first; a whole write unread is refused.
    const b = await turn(w, [
      { tool: "add_sticker_pack", args: { name: "Fox" } },
      { tool: "write_home", args: { path: "stickers/Fox.yaml", content: filled.replace("a fox waving", "a fox saying hi"), why: "w" } },
      { tool: "read_home", args: { path: "stickers/Fox.yaml" } },
      { tool: "edit_home", args: { path: "stickers/Fox.yaml", old_string: "a fox waving", new_string: "a fox saying hi", why: "Better words for Fox/1" } },
    ]);
    const [again, unread, read, edit] = b.toolResults.map((r) => r.result);
    expect(textOf(again!)).toContain("that file already exists, so read it first with read_home, then save your changes with edit_home");
    // No role given: the file's own role is kept, and nothing new is committed for an existing pack.
    expect(textOf(again!)).toContain("role: meme");
    expect(unread!.isError).toBe(true);
    expect(textOf(unread!)).toContain("not read in this turn");
    expect(textOf(read!)).toContain("     1\tpack: Fox");
    expect(edit!.isError).toBeFalsy();
    expect(textOf(edit!)).toContain('-    desc: "a fox waving"\n+    desc: "a fox saying hi"');
    expect(readFileSync(join(w.home, "stickers", "Fox.yaml"), "utf8")).toBe(filled.replace("a fox waving", "a fox saying hi"));
    const after = Bun.spawnSync(["git", "-C", w.home, "log", "--format=%s"]).stdout.toString().trim().split("\n");
    expect(after).toEqual(["Better words for Fox/1", "The owner likes the fox", "Describe the Fox pack", "stickers: skeleton for Fox"]);
  });

  test("add_sticker_pack: a new pack's role defaults to common; a bad role is refused", async () => {
    const w = world();
    await serveSet(w, "Owl", 2);
    let running = true;
    const loop = (async () => {
      while (running) {
        await fetchPass(w.db, w.files, w.dataDir);
        await Bun.sleep(20);
      }
    })();
    const a = await turn(w, [{ tool: "add_sticker_pack", args: { name: "Owl", role: "boss" } }, { tool: "add_sticker_pack", args: { name: "Owl" } }]);
    running = false;
    await loop;
    expect(a.toolResults[0]!.result.isError).toBe(true);
    expect(textOf(a.toolResults[0]!.result)).toContain("role must be one of avatar / common / meme");
    expect(a.toolResults[1]!.result.isError).toBeFalsy();
    expect(parsePack(readFileSync(join(w.home, "stickers", "Owl.yaml"), "utf8"))).toMatchObject({ pack: "Owl", role: "common" });
  });

  test("add_sticker_pack is owner-only; finding and sending stay open; a group cannot read pack files", async () => {
    const w = world();
    await serveSet(w, "Cats", 2);
    writePack(w, "Cats", "common", [{ n: 1, desc: "wave", use: "hello" }, { n: 2, desc: "secret wave", use: "hello", dm_only: true }]);
    writeFileSync(join(w.home, "stickers", "preferences.md"), "Prefer cats.\n");
    await ready(w);
    const g = await groupTurn(w, [
      { tool: "add_sticker_pack", args: { name: "Cats" } },
      { tool: "find_sticker", args: { terms: ["hello"] } },
      { tool: "sticker", args: { id: "Cats/1" } },
      { tool: "read_home", args: { path: "stickers/Cats.yaml" } },
      { tool: "read_home", args: { path: "stickers/preferences.md" } },
    ]);
    const [add, find, send, readPack, readPrefs] = g.toolResults.map((r) => r.result);
    expect(add!.isError).toBe(true);
    expect(textOf(add!)).not.toContain("contact sheet");
    expect(textOf(find!)).toContain("Cats/1");
    expect(textOf(find!)).not.toContain("Cats/2");
    expect(textOf(send!)).toBe("Sent Cats/1.");
    expect(textOf(readPack!)).toContain("not available in this chat");
    expect(textOf(readPrefs!)).toBe("     1\tPrefer cats.");
  });

  test("add_sticker_pack refuses a bad name; a set Telegram does not have fails with why", async () => {
    const w = world();
    const a = await turn(w, [{ tool: "add_sticker_pack", args: { name: "no such/pack" } }]);
    expect(textOf(a.toolResults[0]!.result)).toContain("is not a sticker set name");

    const { requestSet, getSet, MAX_ATTEMPTS } = await import("../src/capabilities/stickers/fetch.ts");
    requestSet(w.db, "Nope");
    for (let i = 0; i < MAX_ATTEMPTS; i++) await fetchPass(w.db, w.files, w.dataDir);
    expect(getSet(w.db, "Nope")).toMatchObject({ state: "failed", error: expect.stringContaining("STICKERSET_INVALID") });
  });
});

// ---- the prompt section -------------------------------------------------------------------------------

describe("the prompt section", () => {
  test("is home/stickers/preferences.md, only when stickers are on", () => {
    const w = world();
    ownerSays(w.db, "hi");
    const chat = getChat(w.db, ownerChatId(w.db))!;
    const env = { SHUVI_DATA_DIR: w.dataDir, SHUVI_WEB: "off" };
    expect(buildSystemPrompt(w.home, chat, {}, enabledCapabilities(env))).not.toContain("## Stickers");
    writeFileSync(join(w.home, "stickers", "preferences.md"), "Prefer the avatar pack. One sticker is often the whole reply.\n");
    expect(buildSystemPrompt(w.home, chat, {}, enabledCapabilities(env))).toContain("## Stickers\n\nPrefer the avatar pack. One sticker is often the whole reply.");
    expect(buildSystemPrompt(w.home, chat, {}, enabledCapabilities({ ...env, SHUVI_STICKERS: "off" }))).not.toContain("## Stickers");
  });
});
