import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CALLED_PREFIX, renderMessage, renderTurnInput } from "../src/agent/render.ts";
import { TriggerScan } from "../src/agent/triggers.ts";
import { searchChats, readChat, renderHit } from "../src/capabilities/retrieval/logs.ts";
import { downloadPass } from "../src/capabilities/vision/download.ts";
import { backPath } from "../src/console/delete-write.ts";
import { parsePolicy, resolveChat } from "../src/policy/policy.ts";
import type { TelegramFiles } from "../src/telegram/files.ts";
import { FIXTURE_PNG } from "./console-fixture.ts";
import { allowedHosts, allowedOrigins } from "../src/console/index.ts";
import { csrfToken, handleConsole, LOGIN_HEADER, type ConsoleDeps } from "../src/console/server.ts";
import type { Db } from "../src/store/db.ts";
import { DELETE_UNDO_MS, deleteMessages, dropEventLines, purgeDeletions, undoDeletion } from "../src/store/deletions.ts";
import { ensureChat, enqueueOutbound, getChat, getEvent, lastMessage, markSent, previousEvent, recentHistory, recordInbound, triggersAfter, type ChatEvent } from "../src/store/events.ts";
import { addStep, saveTranscript } from "../src/store/transcripts.ts";
import { claimTurn, extendTurn, finishTurn } from "../src/store/turns.ts";
import { lastSeq, memDb, OWNER, ownerChatId, ownerSays } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "shuvi-deletions-"));
  dirs.push(d);
  return d;
};

const TZ = "UTC";
const T0 = Date.parse("2026-11-14T10:00:00Z");

/** Every row of the tables a deletion touches, as stored: what an undo must give back byte for byte. */
function dump(db: Db) {
  const q = (s: string) => db.$client.query(s).all();
  return {
    events: q("select * from chat_events order by seq"),
    fts: q("select rowid, text from chat_events_fts order by rowid"),
    transcripts: q("select * from turn_transcripts order by turn_id"),
    steps: q("select * from turn_steps order by id"),
  };
}

/**
 * A DM with: #a the owner's photo message, #b her reply to it (delivered, two parts), her reaction to #a, #c the
 * owner replying to #b's second part (quoting it), #d. Then a turn whose input opened a fresh conversation with
 * #a (and its picture) and #b as history and #c as new, and an append step showing #c and #d.
 */
function setup(dataDir = "/nonexistent") {
  const db = memDb();
  const chat = ownerChatId(db);
  const a = ownerSays(db, "the secret plan is pineapple", { media: { kind: "photo", fileUniqueId: "photo-a", file: { fileId: "f-a", fileUniqueId: "photo-a" }, state: "ready", path: "media/photo-a", mimeType: "image/png" } });
  const turn = claimTurn(db, chat)!;
  const b = enqueueOutbound(db, { chatId: chat, kind: "bot_message", payload: { text: "pineapple noted, long reply", replyToSeq: a, sentParts: [501, 502] }, idemKey: "turn:1:0", turnId: turn.id })!;
  markSent(db, b, 501);
  const r = enqueueOutbound(db, { chatId: chat, kind: "bot_reaction", payload: { targetSeq: a, emoji: "👍" }, idemKey: "turn:1:1", turnId: turn.id })!;
  markSent(db, r, null);
  saveTranscript(db, turn.id, { promptHash: null, input: [{ type: "text", text: renderMessage(getEvent(db, a)!, TZ) }], resumed: false });
  addStep(db, turn.id, 0, { kind: "text", text: "pineapple noted, long reply", sent: true, outboundSeq: b });
  // A message of hers sent by `say` (its words, untrimmed, in the call's arguments), and another tool's call
  // whose arguments quote the same words: only the `say` is hers.
  addStep(db, turn.id, 1, { kind: "tool", name: "say", args: JSON.stringify({ text: "  mango too, by say " }), callId: "call-say", status: "ok", result: "Sent." });
  const s = enqueueOutbound(db, { chatId: chat, kind: "bot_message", payload: { text: "mango too, by say" }, idemKey: "turn:1:2", turnId: turn.id })!;
  markSent(db, s, 503);
  addStep(db, turn.id, 2, { kind: "tool", name: "search_notes", args: JSON.stringify({ text: "mango too, by say" }), callId: "call-search", status: "ok", result: "none" });
  finishTurn(db, turn.id, { status: "done" });
  recordInbound(db, { chatId: chat, kind: "message", payload: { from: { id: OWNER, name: "Owner" }, text: "why pineapple?", replyTo: { tgMessageId: 502, fromName: "shuvi", fromId: 9, text: "pineapple noted, long reply" } }, tgUpdateId: 900, tgMessageId: 900 });
  const c = lastSeq(db);
  const d = ownerSays(db, "unrelated words");
  const turn2 = claimTurn(db, chat)!;
  const [ea, eb, ec, ed] = [a, b, c, d].map((s) => getEvent(db, s)!) as [ChatEvent, ChatEvent, ChatEvent, ChatEvent];
  const line = (e: ChatEvent) => renderMessage(e, TZ);
  saveTranscript(db, turn2.id, {
    promptHash: null,
    input: [
      { type: "text", text: `(A new conversation. The last 2 messages of this chat, for context:)\n${line(ea)}` },
      { type: "image", ref: "media/photo-a", mimeType: "image/png" },
      { type: "text", text: `${line(eb)}\n\n(New messages:)\n${line(ec)}` },
    ],
    resumed: false,
  });
  addStep(db, turn2.id, 0, { kind: "append", text: `(New messages arrived while you were working:)\n${line(ec)}\n${line(ed)}`, fromSeq: c - 1, toSeq: d, images: [] });
  // What read_chat and search_chats gave the turn, and another tool's result quoting the same line.
  const hit = (e: ChatEvent) => renderHit(e, ["pineapple"], TZ);
  addStep(db, turn2.id, 1, { kind: "tool", name: "search_chats", args: '{"terms":["pineapple"]}', result: `chat DM:\n${hit(ea)}\n${hit(ec)}`, callId: "call-s1", status: "ok" });
  addStep(db, turn2.id, 2, { kind: "tool", name: "search_chats", args: '{"terms":["secret"]}', result: `chat DM:\n${hit(ea)}`, callId: "call-s2", status: "ok" });
  addStep(db, turn2.id, 3, { kind: "tool", name: "read_chat", args: "{}", result: `(chat DM)\n${line(ea)}\n${line(eb)}\n${line(ec)}\n(That is all of it.)`, callId: "call-r", status: "ok" });
  addStep(db, turn2.id, 4, { kind: "tool", name: "web_fetch", args: "{}", result: line(ea), callId: "call-w", status: "ok" });
  finishTurn(db, turn2.id, { status: "done" });
  if (dataDir !== "/nonexistent") {
    mkdirSync(join(dataDir, "media"), { recursive: true });
    writeFileSync(join(dataDir, "media/photo-a"), "png");
  }
  return { db, chat, a, b, r, s, c, d, turn1: turn.id, turn2: turn2.id };
}

describe("deleting messages (store/deletions.ts)", () => {
  test("the rows move out at once: no reader of the log sees them, FTS no longer matches, her reactions go with them", () => {
    const { db, chat, a, b, r, s, c, d } = setup();
    const res = deleteMessages(db, [a, b, s], T0);
    expect(res).toMatchObject({ ok: true, count: 3 });
    for (const seq of [a, b, r, s]) expect(getEvent(db, seq)).toBeUndefined();
    const held = db.$client.query("select seq from deleted_events order by seq").all() as { seq: number }[];
    expect(held.map((x) => x.seq)).toEqual([a, b, r, s]);
    expect(recentHistory(db, chat, d, 10).map((e) => e.seq)).toEqual([c, d]);
    expect(triggersAfter(db, chat, 0).map((e) => e.seq)).toEqual([c, d]);
    expect(lastMessage(db, chat, b)).toBeUndefined();
    expect(previousEvent(db, chat, c)).toBeUndefined();
    const all = [getChat(db, chat)!];
    expect(searchChats(db, { terms: ["pineapple"], chats: all, limit: 10 })).toMatchObject({ total: 1 }); // #c's own words
    expect(searchChats(db, { terms: ["secret plan"], chats: all, limit: 10 }).total).toBe(0);
    expect(searchChats(db, { terms: ["long reply"], chats: all, limit: 10 }).total).toBe(0);
    expect(searchChats(db, { terms: ["by say"], chats: all, limit: 10 }).total).toBe(0);
    expect(readChat(db, chat, null, 50).events.map((e) => e.seq)).toEqual([c, d]);
    // The cursor and the turns are as they were.
    expect(db.$client.query("select count(*) as n from turns").get()).toEqual({ n: 2 });
  });

  test("verbatim copies are scrubbed: a reply's quote, the line in a turn's input (with its picture) and in an append", () => {
    const { db, a, b, c, turn2 } = setup();
    deleteMessages(db, [a, b], T0);
    const reply = getEvent(db, c)!.payload as { replyTo: Record<string, unknown> };
    expect(reply.replyTo).toEqual({ tgMessageId: 502, fromName: "shuvi", fromId: 9 });
    const input = JSON.stringify(db.$client.query("select input from turn_transcripts where turn_id = ?").get(turn2));
    expect(input).not.toContain("pineapple noted");
    expect(input).not.toContain("secret plan");
    expect(input).not.toContain("media/photo-a");
    expect(input).not.toContain(`[#${a} `);
    expect(input).toContain("↳ replying to shuvi: a message");
    const step = db.$client.query("select text from turn_steps where turn_id = ? and kind = 'append'").get(turn2) as { text: string };
    expect(step.text).toContain("↳ replying to shuvi: a message");
    expect(step.text).not.toContain("long reply");
    // The fresh conversation's count is what is left under it: #a and #b were its two.
    expect(input).toContain("(A new conversation. The last 0 messages of this chat, for context:)");
  });

  test("the lines in read_chat and search_chats results go (a chat left with no hit, and a search left with none); other tools' results stay", () => {
    const { db, a, c, turn2 } = setup();
    deleteMessages(db, [a], T0);
    const result = (n: number) => (db.$client.query("select result from turn_steps where turn_id = ? and n = ?").get(turn2, n) as { result: string }).result;
    expect(result(1)).toBe(`chat DM:\n${renderHit(getEvent(db, c)!, ["pineapple"], TZ)}`);
    expect(result(2)).toBe("No hits.");
    expect(result(3)).not.toContain("secret plan");
    expect(result(3)).toContain("why pineapple?");
    expect(result(3).split("\n")[0]).toBe("(chat DM)");
    expect(result(4)).toContain("secret plan");
  });

  test("her own deleted messages leave the turn that wrote them: the text step emptied, the say call's text taken out", () => {
    const { db, b, s, turn1 } = setup();
    deleteMessages(db, [b, s], T0);
    const steps = db.$client.query("select name, kind, text, args from turn_steps where turn_id = ? order by n").all(turn1) as { name: string | null; kind: string; text: string | null; args: string | null }[];
    expect(steps[0]).toMatchObject({ kind: "text", text: "" });
    expect(steps[1]).toMatchObject({ name: "say", args: "{}" });
    // Another tool's arguments stay as they are.
    expect(steps[2]).toMatchObject({ name: "search_notes", args: JSON.stringify({ text: "mango too, by say" }) });
    expect(JSON.stringify(steps.slice(0, 2))).not.toContain("pineapple");
    expect(JSON.stringify(steps.slice(0, 2))).not.toContain("mango");
  });

  test("undo within the window puts everything back byte for byte", () => {
    const { db, a, b, s } = setup();
    const before = dump(db);
    const res = deleteMessages(db, [a, b, s], T0);
    expect(dump(db)).not.toEqual(before);
    expect(JSON.stringify(dump(db).steps)).not.toContain("pineapple noted");
    expect(JSON.stringify(dump(db).steps)).not.toContain("  mango too, by say ");
    if (!res.ok) throw new Error(res.refused);
    expect(undoDeletion(db, res.id, T0 + DELETE_UNDO_MS - 1)).toEqual({ ok: true, count: 3 });
    expect(dump(db)).toEqual(before);
    expect(db.$client.query("select (select count(*) from deletions) + (select count(*) from deleted_events) + (select count(*) from deletion_scrubs) as n").get()).toEqual({ n: 0 });
  });

  test("after the window: undo is refused, the purge drops the stash and the media file no other row names", () => {
    const dir = tmp();
    const { db, a } = setup(dir);
    const res = deleteMessages(db, [a], T0);
    if (!res.ok) throw new Error(res.refused);
    expect(purgeDeletions(db, dir, T0 + 1000)).toEqual({ deletions: 0, files: 0 });
    expect(undoDeletion(db, res.id, T0 + DELETE_UNDO_MS)).toMatchObject({ ok: false });
    // The server was down when it came due: the next pass (at start) runs it.
    expect(purgeDeletions(db, dir, T0 + 3600_000)).toEqual({ deletions: 1, files: 1 });
    expect(existsSync(join(dir, "media/photo-a"))).toBe(false);
    expect(db.$client.query("select (select count(*) from deletions) + (select count(*) from deleted_events) + (select count(*) from deletion_scrubs) as n").get()).toEqual({ n: 0 });
    expect(undoDeletion(db, res.id, T0)).toMatchObject({ ok: false });
  });

  test("a media file another message still shows is kept", () => {
    const dir = tmp();
    const { db, a } = setup(dir);
    ownerSays(db, "the same photo again", { media: { kind: "photo", fileUniqueId: "photo-a", file: null, state: "ready", path: "media/photo-a" } });
    deleteMessages(db, [a], T0);
    expect(purgeDeletions(db, dir, T0 + DELETE_UNDO_MS)).toEqual({ deletions: 1, files: 0 });
    expect(existsSync(join(dir, "media/photo-a"))).toBe(true);
  });

  test("refused, with nothing changed: a running turn's messages, a pending outbound row, a kind that is not a message", () => {
    const db = memDb();
    const chat = ownerChatId(db);
    const m = ownerSays(db, "hello");
    const turn = claimTurn(db, chat)!;
    const before = dump(db);
    expect(deleteMessages(db, [m], T0)).toEqual({ ok: false, refused: `#${m} is part of turn ${turn.id}, which is still running. Delete it once the turn has ended.` });
    const out = enqueueOutbound(db, { chatId: chat, kind: "bot_message", payload: { text: "hi" }, idemKey: "x:1" })!;
    expect(deleteMessages(db, [out], T0)).toMatchObject({ ok: false, refused: expect.stringContaining("has not been sent yet") });
    finishTurn(db, turn.id, { status: "done" });
    recordInbound(db, { chatId: chat, kind: "command", payload: { from: { id: OWNER, name: "Owner" }, command: "new" }, tgUpdateId: 77, tgMessageId: 77 });
    expect(deleteMessages(db, [lastSeq(db)], T0)).toMatchObject({ ok: false, refused: expect.stringContaining("cannot be deleted") });
    expect(deleteMessages(db, [m, 99999], T0)).toMatchObject({ ok: false });
    expect(dump(db).events.length).toBe(before.events.length + 2);
    expect(db.$client.query("select count(*) as n from deletions").get()).toEqual({ n: 0 });
  });

  test("dropEventLines takes an event's line and its indented lines, nothing else", () => {
    const text = "(It is now…)\n[#3 · Sat 11/14 10:00 · A] one\n  two\n  ↳ replying to B: \"x\"\n[#4 · Sat 11/14 10:01 · B] keep\n\n(New messages:)";
    expect(dropEventLines(text, new Set([3]))).toEqual({ text: "(It is now…)\n[#4 · Sat 11/14 10:01 · B] keep\n\n(New messages:)", changed: true, endsRemoved: false });
    expect(dropEventLines("[#3 · x] a\n  b", new Set([3])).endsRemoved).toBe(true);
  });
});

// ---- the console's write path ----------------------------------------------------------------------------

const PORT = 8787;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "example-csrf-secret";
const LOGIN = "owner@example.com";
const CSRF = csrfToken(SECRET, `login:${LOGIN}`);
function deps(db: Db, now = T0): ConsoleDeps {
  const c = { listen: `127.0.0.1:${PORT}` };
  return { db, timeZone: TZ, dataDir: "/nonexistent", allowedHosts: allowedHosts(c, PORT), allowedOrigins: allowedOrigins(c, PORT), csrfSecret: SECRET, users: new Set([LOGIN]), ownerId: OWNER, now: () => now };
}
function post(db: Db, path: string, fields: [string, string][], o: { json?: boolean; origin?: string | null; csrf?: string | null; now?: number; headers?: Record<string, string> } = {}) {
  const body = new URLSearchParams(fields);
  if (o.csrf !== null) body.set("csrf", o.csrf ?? CSRF);
  const headers: Record<string, string> = { [LOGIN_HEADER]: LOGIN, "content-type": "application/x-www-form-urlencoded", ...(o.origin !== null ? { origin: o.origin ?? BASE } : {}), ...(o.json ? { accept: "application/json" } : {}), ...o.headers };
  return handleConsole(deps(db, o.now), new Request(`${BASE}${path}`, { method: "POST", headers, body }));
}
const get = async (db: Db, path: string, now = T0) => (await handleConsole(deps(db, now), new Request(`${BASE}${path}`, { headers: { [LOGIN_HEADER]: LOGIN } }))).text();

describe("the console's delete (console/delete-write.ts)", () => {
  test("the write boundary: POST only, its Origin, its CSRF token", async () => {
    const { db, a } = setup();
    expect((await handleConsole(deps(db), new Request(`${BASE}/messages/delete`, { headers: { [LOGIN_HEADER]: LOGIN } }))).status).toBe(405);
    expect((await post(db, "/messages/delete", [["seq", String(a)]], { origin: null })).status).toBe(403);
    expect((await post(db, "/messages/delete", [["seq", String(a)]], { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(db, "/messages/delete", [["seq", String(a)]], { csrf: "wrong" })).status).toBe(403);
    expect((await post(db, "/messages/delete", [["seq", String(a)]], { csrf: null })).status).toBe(403);
    expect(getEvent(db, a)).toBeDefined();
    // The refusal leads back to the page the write came from, when that page is this console's; else the turns.
    const back = (referer?: string) => post(db, "/messages/delete", [["seq", String(a)]], { csrf: "wrong", headers: referer ? { referer } : {} }).then((r) => r.text());
    expect(await back(`${BASE}/chats/1?q=x&n=old`)).toContain('<a href="/chats/1?q=x">Back to the page</a>');
    expect(await back("https://evil.example/chats/1")).toContain('<a href="/turns">Back to the page</a>');
    expect(await back()).toContain('<a href="/turns">Back to the page</a>');
  });

  test("with script: JSON, a refusal as 409 with its reason, an undo", async () => {
    const { db, a, b } = setup();
    const res = await post(db, "/messages/delete", [["seq", String(a)], ["seq", String(b)]], { json: true });
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { id: number; count: number; seconds: number };
    expect(answer).toMatchObject({ count: 2, seconds: 10 });
    const page = await get(db, `/chats/${ownerChatId(db)}`);
    expect(page).not.toContain("secret plan");
    expect(page).not.toContain("long reply");
    const again = await post(db, "/messages/delete", [["seq", String(a)]], { json: true });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { refused: string }).refused).toContain("not in the chat's log");
    const undo = await post(db, "/messages/undo", [["id", String(answer.id)]], { json: true });
    expect(await undo.json()).toEqual({ count: 2 });
    expect(await get(db, `/chats/${ownerChatId(db)}`)).toContain("secret plan");
  });

  test("without script: a 303 back with a one-time notice carrying an Undo button", async () => {
    const { db, a } = setup();
    const back = `/chats/${ownerChatId(db)}`;
    const res = await post(db, "/messages/delete", [["only", String(a)], ["seq", "999"], ["back", back]]);
    expect(res.status).toBe(303);
    const loc = res.headers.get("location")!;
    expect(loc).toMatch(new RegExp(`^${back}\\?n=[\\w-]+$`));
    const page = await get(db, loc);
    expect(page).toContain("Deleted 1 message.");
    expect(page).toContain('action="/messages/undo"');
    expect(page).not.toContain("secret plan");
    expect(await get(db, loc)).not.toContain("Deleted 1 message."); // once
    const id = /name="id" value="(\d+)"/.exec(page)![1]!;
    const undo = await post(db, "/messages/undo", [["id", id], ["back", back]]);
    expect(await get(db, undo.headers.get("location")!)).toContain("Put back 1 message.");
    expect(getEvent(db, a)).toBeDefined();
    // A back that is not a path here goes to the turns.
    const off = await post(db, "/messages/delete", [["seq", String(a)], ["back", "https://evil.example/"]]);
    expect(off.headers.get("location")).toMatch(/^\/turns\?n=/);
  });

  test("a turn page with a deleted message of hers shows neither it nor its text step, and no reply pointer to it", async () => {
    const { db, a, b, turn1, turn2 } = setup();
    const shown = await get(db, `/turns/${turn1}`);
    expect(shown).toContain("long reply");
    expect(shown).toContain(`#${a}</a>`);
    deleteMessages(db, [a, b], T0);
    for (const t of [turn1, turn2]) {
      const page = await get(db, `/turns/${t}`);
      expect(page).not.toContain("long reply");
      // Turn 2's web_fetch result quotes it, and another tool's result stays as it was: that one only.
      expect(page.split("secret plan").length - 1).toBe(t === turn2 ? 1 : 0);
      expect(page).not.toContain("not sent");
      expect(page).not.toContain(`#${a}</a>`);
    }
    // Her message alone deleted: the owner's #a keeps its bubble, her reply's pointer to it is gone with her.
    const one = setup();
    deleteMessages(one.db, [one.b], T0);
    const page = await get(one.db, `/turns/${one.turn1}`);
    expect(page).toContain("secret plan");
    expect(page).not.toContain("long reply");
  });
});

// ---- the review's cases: overlapping deletes, undo once the chat moved on, what counts a deleted line ---------

describe("deletes in a row, and undo once the chat has moved on", () => {
  test("B1: the reply, then what it quotes: one deletion, one undo puts both back byte for byte", () => {
    const { db, b, c } = setup();
    const before = dump(db);
    const first = deleteMessages(db, [c], T0);
    const second = deleteMessages(db, [b], T0 + 4000);
    if (!first.ok || !second.ok) throw new Error("refused");
    expect(second.id).toBe(first.id);
    expect(second.count).toBe(2);
    // The window started again with the second.
    expect(second.purgeAt).toBe(new Date(T0 + 4000 + DELETE_UNDO_MS).toISOString());
    expect(db.$client.query("select count(*) as n from deletions").get()).toEqual({ n: 1 });
    expect(undoDeletion(db, first.id, T0 + 4000 + DELETE_UNDO_MS - 1)).toEqual({ ok: true, count: 2 });
    expect(dump(db)).toEqual(before);
  });

  test("B1: what is quoted, then the reply: undone, both back byte for byte; purged, the quote is nowhere", () => {
    for (const end of ["undo", "purge"] as const) {
      const { db, b, c } = setup();
      const before = dump(db);
      deleteMessages(db, [b], T0);
      const r = deleteMessages(db, [c], T0 + 1000);
      if (!r.ok) throw new Error(r.refused);
      if (end === "undo") {
        expect(undoDeletion(db, r.id, T0 + 2000)).toEqual({ ok: true, count: 2 });
        expect(dump(db)).toEqual(before);
      } else {
        // Reply first, then quote, purged: before, the reply came back with the quote for good (B1).
        expect(purgeDeletions(db, "/nonexistent", T0 + 1000 + DELETE_UNDO_MS)).toMatchObject({ deletions: 1 });
        expect(getEvent(db, c)).toBeUndefined();
        expect(JSON.stringify(dump(db))).not.toContain("long reply");
      }
    }
    // And in the other order, purged: no quote comes back either.
    const { db, b, c } = setup();
    deleteMessages(db, [c], T0);
    deleteMessages(db, [b], T0 + 1000);
    purgeDeletions(db, "/nonexistent", T0 + 1000 + DELETE_UNDO_MS);
    expect(JSON.stringify(dump(db))).not.toContain("long reply");
    expect(getEvent(db, c)).toBeUndefined();
  });

  test("B2: two lines of one turn's input deleted one after the other: one undo restores both", () => {
    const { db, a, c, turn2 } = setup();
    const before = dump(db);
    const r1 = deleteMessages(db, [a], T0);
    deleteMessages(db, [c], T0 + 1000);
    const input = JSON.stringify(db.$client.query("select input from turn_transcripts where turn_id = ?").get(turn2));
    expect(input).not.toContain("secret plan");
    expect(input).not.toContain("why pineapple?");
    if (!r1.ok) throw new Error(r1.refused);
    expect(undoDeletion(db, r1.id, T0 + 2000)).toEqual({ ok: true, count: 2 });
    expect(dump(db)).toEqual(before);
  });

  test("S1: undo is refused once a turn has started since, a running turn has taken in past it, or the cursor has", () => {
    // A turn started since the delete.
    let db = memDb();
    let chat = ownerChatId(db);
    let m = ownerSays(db, "hello there");
    let r = deleteMessages(db, [m], T0);
    ownerSays(db, "are you there?");
    claimTurn(db, chat);
    if (!r.ok) throw new Error(r.refused);
    expect(undoDeletion(db, r.id, T0 + 1000)).toEqual({ ok: false, refused: expect.stringContaining("started a turn in this chat since") });
    expect(getEvent(db, m)).toBeUndefined();

    // A turn running from before the delete, whose range then grew past it (a message appended mid-turn)...
    db = memDb();
    chat = ownerChatId(db);
    ownerSays(db, "first");
    const turn = claimTurn(db, chat)!;
    m = ownerSays(db, "arrived while she worked");
    r = deleteMessages(db, [m], T0);
    const later = ownerSays(db, "and one more");
    extendTurn(db, turn.id, later);
    if (!r.ok) throw new Error(r.refused);
    expect(undoDeletion(db, r.id, T0 + 1000)).toEqual({ ok: false, refused: expect.stringContaining("the turn running now has taken in") });
    // ...and once it ended, the cursor is past it: put back there, it would never be answered.
    finishTurn(db, turn.id, { status: "done" });
    expect(undoDeletion(db, r.id, T0 + 1000)).toEqual({ ok: false, refused: expect.stringContaining("moved past them") });

    // Neither: an old message, behind the cursor already, comes back fine.
    db = memDb();
    chat = ownerChatId(db);
    m = ownerSays(db, "old news");
    const t = claimTurn(db, chat)!;
    finishTurn(db, t.id, { status: "done" });
    r = deleteMessages(db, [m], T0);
    if (!r.ok) throw new Error(r.refused);
    expect(undoDeletion(db, r.id, T0 + 1000)).toEqual({ ok: true, count: 1 });
  });

  test("S2: a group turn's unread note and called heading follow its deleted messages; the console shows what it showed", async () => {
    const db = memDb();
    const g = ensureChat(db, { id: -100555, kind: "group", title: "Example Group" });
    let update = 7000;
    const say = (text: string) => {
      recordInbound(db, { chatId: g.id, kind: "message", payload: { from: { id: 2001, name: "Alice Example" }, text }, tgUpdateId: update++, tgMessageId: update });
      return lastSeq(db);
    };
    const m1 = say("first unread chatter");
    const m2 = say("second unread chatter");
    const m3 = say("@shuvi_test_bot what do you think?");
    const m4 = say("@shuvi_test_bot and this?");
    const turn = claimTurn(db, g.id)!;
    const input = renderTurnInput([m3, m4].map((s) => getEvent(db, s)!), TZ, undefined, { unread: 2, called: [m3, m4] }) as string;
    saveTranscript(db, turn.id, { promptHash: null, input: [{ type: "text", text: input }], resumed: false });
    finishTurn(db, turn.id, { status: "done" });
    const before = dump(db);
    const text = () => ((db.$client.query("select input from turn_transcripts where turn_id = ?").get(turn.id) as { input: string }).input);

    // A hidden unread one goes: the note counts one, and the console still shows #m3 and #m4 (not #m2).
    const r = deleteMessages(db, [m1], T0);
    if (!r.ok) throw new Error(r.refused);
    expect(text()).toContain("(1 earlier message since your last turn is not shown here; read_chat reaches it.)");
    const page = await get(db, `/turns/${turn.id}`);
    expect(page).toContain("what do you think?");
    expect(page).toContain("and this?");
    expect(page).not.toContain("second unread chatter");

    // A called one goes: the heading names the other alone. The last hidden one goes: no note at all.
    deleteMessages(db, [m4], T0 + 1000);
    deleteMessages(db, [m2], T0 + 2000);
    const now = JSON.parse(text()) as { text: string }[];
    expect(now[0]!.text.split("\n").find((l) => l.startsWith(CALLED_PREFIX))).toBe(`(You were called by #${m3}. From here on is what you answer:)`);
    expect(now[0]!.text).not.toContain("earlier message");
    expect(now[0]!.text).not.toContain(`#${m4}`);
    expect(await get(db, `/turns/${turn.id}`)).toContain("what do you think?");

    // The one called left goes too: no heading naming nothing.
    deleteMessages(db, [m3], T0 + 3000);
    expect(text()).not.toContain(CALLED_PREFIX);
    expect(undoDeletion(db, r.id, T0 + 4000)).toEqual({ ok: true, count: 4 });
    expect(dump(db)).toEqual(before);
  });

  test("S3: a deleted group trigger no longer starts a turn; put back, it does again", () => {
    const db = memDb();
    const parsed = parsePolicy(`owner: ${OWNER}\nchats:\n  "-100555":\n    title: Example Group\n    trigger: [mention]\n`, OWNER);
    if ("error" in parsed) throw new Error(parsed.error);
    const policy = parsed.policy;
    const g = ensureChat(db, { id: -100555, kind: "group", title: "Example Group" });
    const bot = { id: 1, username: "shuvi_test_bot" };
    recordInbound(db, { chatId: g.id, kind: "message", payload: { from: { id: 2001, name: "Alice Example" }, text: "just chatting" }, tgUpdateId: 1, tgMessageId: 1 });
    recordInbound(db, { chatId: g.id, kind: "message", payload: { from: { id: 2001, name: "Alice Example" }, text: "@shuvi_test_bot hi", mentions: { usernames: ["shuvi_test_bot"], userIds: [] } }, tgUpdateId: 2, tgMessageId: 2 });
    const trigger = lastSeq(db);
    const scan = new TriggerScan();
    const newest = () => scan.newestTrigger(db, getChat(db, g.id)!, resolveChat(policy, getChat(db, g.id)!)!, bot, policy);
    expect(newest()).toBe(trigger);
    const r = deleteMessages(db, [trigger], T0);
    expect(newest()).toBeNull();
    if (!r.ok) throw new Error(r.refused);
    undoDeletion(db, r.id, T0 + 1000);
    expect(newest()).toBe(trigger);
  });

  test("N1: a way back that would leave the console goes to the turns", () => {
    for (const bad of ["//evil.example/x", "/.//evil.example/x", "/\\evil.example", "/x/..//evil.example", "https://evil.example/", "turns"]) expect(backPath(bad)).toBe("/turns");
    expect(backPath("/chats/1?q=x&n=old")).toBe("/chats/1?q=x");
  });

  test("N3: a picture whose download ends after its message was deleted leaves no file; put back, it is fetched again", async () => {
    const dir = tmp();
    const db = memDb();
    const m = ownerSays(db, "[photo]", { media: { kind: "photo", fileUniqueId: "p-late", file: { fileId: "f-late", fileUniqueId: "p-late" }, state: "pending" } });
    let id = 0;
    const deleting = { download: async () => ((id = (deleteMessages(db, [m], T0) as { id: number }).id), new Uint8Array(FIXTURE_PNG)) } as unknown as TelegramFiles;
    await downloadPass(db, deleting, dir);
    expect(existsSync(join(dir, "media/p-late"))).toBe(false);
    expect(undoDeletion(db, id, T0 + 1000)).toEqual({ ok: true, count: 1 });
    await downloadPass(db, { download: async () => new Uint8Array(FIXTURE_PNG) } as unknown as TelegramFiles, dir);
    expect(existsSync(join(dir, "media/p-late"))).toBe(true);
    expect((getEvent(db, m)!.payload as { media: { state: string } }).media.state).toBe("ready");
  });

  test("the console answers a delete that joined with the deletion's whole count", async () => {
    const { db, a, d } = setup();
    const one = (await (await post(db, "/messages/delete", [["seq", String(a)]], { json: true })).json()) as { id: number; count: number };
    const two = (await (await post(db, "/messages/delete", [["seq", String(d)]], { json: true, now: T0 + 2000 })).json()) as { id: number; count: number };
    expect(two).toMatchObject({ id: one.id, count: 2 });
    expect(await (await post(db, "/messages/undo", [["id", String(one.id)]], { json: true, now: T0 + 3000 })).json()).toEqual({ count: 2 });
  });
});
