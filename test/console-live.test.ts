import { describe, expect, test } from "bun:test";
import { allowedHosts, allowedOrigins } from "../src/console/index.ts";
import { assetsVersion, warmAssets } from "../src/console/assets.ts";
import { HEARTBEAT_MS, LiveHub, LiveStream, MAX_STREAMS_PER_SESSION, parseHave, Watch, type Op } from "../src/console/live.ts";
import { chatPage, liveView, segmentPage, turnGonePage, turnsPage, type PageContext } from "../src/console/pages.ts";
import { handleConsole, LOGIN_HEADER, type ConsoleDeps } from "../src/console/server.ts";
import type { Db } from "../src/store/db.ts";
import { deleteMessages, deleteTurns, undoDeletion } from "../src/store/deletions.ts";
import { enqueueOutbound, ensureChat, markSent, recordInbound } from "../src/store/events.ts";
import { updateMedia } from "../src/store/media.ts";
import { addStep, completeStep, saveTranscript, setTranscriptModel } from "../src/store/transcripts.ts";
import { claimTurn, finishTurn } from "../src/store/turns.ts";
import { memDb, ownerChatId, ownerSays } from "./helpers.ts";

/**
 * Live pages (console/live.ts): the store watch's cursors, the stream's fragments (drawn by the page's own
 * functions, so equal to the reloaded page's parts), a reconnect resuming from what the page has, a chat log's window
 * sliding, deletes, pictures arriving in place, one drawing per page, the per-session cap and tabs, backpressure, and
 * /live behind the console's Host check and sign-in.
 */

const T0 = Date.parse("2026-11-14T10:00:00Z");
let clock = T0;
const ctxOf = (db: Db): PageContext => ({ db, timeZone: "UTC", now: clock });

/** A DM with one running turn: the owner's message, a transcript, a thinking step. */
function setup() {
  const db = memDb();
  const chat = ownerChatId(db);
  const hello = ownerSays(db, "can you look up the trains");
  const turn = claimTurn(db, chat)!;
  saveTranscript(db, turn.id, { promptHash: null, input: [{ type: "text", text: "can you look up the trains" }], resumed: true });
  addStep(db, turn.id, 0, { kind: "thinking", text: "The owner wants train times." });
  return { db, chat, hello, turn };
}

/**
 * What a page says it has when it connects (console.js `pageState`): its live parts outside the trace, the trace from
 * its first live part on, and the trace's last part.
 */
function pageState(html: string): { have: Map<string, string>; last: string | null } {
  const parts = [...html.matchAll(/class="lb" data-k="([^"]+)" data-h="([^"]+)"( data-live)?/g)].map((m) => ({ k: m[1]!, h: m[2]!, live: !!m[3] }));
  const isTrace = (k: string) => /^[tde]\d/.test(k);
  const trace = parts.filter((p) => isTrace(p.k));
  const from = trace.findIndex((p) => p.live);
  const listed = [...parts.filter((p) => !isTrace(p.k) && p.live), ...(from >= 0 ? trace.slice(from) : [])];
  return { have: parseHave(listed.map((p) => `${p.k}.${p.h}`).join(",")), last: trace.at(-1)?.k ?? null };
}

/** A part as a page draws it: its wrapper's hash and what it holds. */
function partIn(html: string, k: string): { h: string; inner: string } | null {
  const m = new RegExp(`class="lb" data-k="${k}" data-h="([^"]+)"(?: data-live)?>`).exec(html);
  return m ? { h: m[1]!, inner: html.slice(m.index + m[0].length) } : null;
}

/** A hub ticked by hand, and pages opened on it as console.js opens them. */
function harness(db: Db) {
  const hub = new LiveHub(db, () => clock, 0);
  const open = (path: string, page: string, session = "s", tab = "") => {
    const out: string[] = [];
    const u = new URL(path, "http://x");
    const key = `${u.pathname}${u.search}`;
    const ctx = () => ({ ...ctxOf(db), here: key });
    const feed = hub.feed(key, () => {
      const view = liveView(ctx(), u.pathname, u.searchParams);
      return view ? { view, ctx } : null;
    })!;
    const { have, last } = pageState(page);
    const s = new LiveStream(have, last, (c) => out.push(c), () => {}, session, tab);
    hub.add(s, feed);
    const ops = (): Op[] => out.splice(0).flatMap((c) => (c.startsWith("event: ops") ? (JSON.parse(c.split("data: ")[1]!) as Op[]) : []));
    return { s, out, ops, feed };
  };
  const tick = (ms = 1000) => {
    clock += ms;
    hub.tick();
  };
  return { hub, open, tick };
}

const parts = (ops: Op[]) => ops.filter((o): o is Extract<Op, { html: string }> => "html" in o);

describe("the store watch", () => {
  test("reports nothing when nothing changed, and each kind of change by its cursor", () => {
    const { db, chat, turn } = setup();
    const w = new Watch(db);
    const idle = w.poll();
    expect([idle.chats.size, idle.turns.size, idle.redraw.size]).toEqual([0, 0, 0]);

    // A tool call: written running, then completed in place.
    addStep(db, turn.id, 1, { kind: "tool", name: "search_notes", args: "{}", callId: "c1", status: "running" });
    let ch = w.poll();
    expect([...ch.turns]).toEqual([turn.id]);
    expect([...ch.chats]).toEqual([chat]);
    expect(w.poll().turns.size).toBe(0);
    completeStep(db, turn.id, "c1", { status: "ok", result: "none", endedAt: new Date(T0 + 4000).toISOString() });
    expect([...w.poll().turns]).toEqual([turn.id]);

    // Her message: queued pending, then sent.
    const m = enqueueOutbound(db, { chatId: chat, kind: "bot_message", payload: { text: "Found two trains." }, idemKey: "t:1", turnId: turn.id })!;
    expect([...w.poll().turns]).toEqual([turn.id]);
    expect(w.poll().chats.size).toBe(0);
    markSent(db, m, 900);
    expect([...w.poll().turns]).toEqual([turn.id]);

    // The turn ends; then a new message, a new turn.
    finishTurn(db, turn.id, { status: "done" });
    expect([...w.poll().turns]).toEqual([turn.id]);
    expect(w.poll().turns.size).toBe(0);
    ownerSays(db, "thanks");
    ch = w.poll();
    expect([...ch.chats]).toEqual([chat]);
    expect(ch.turns.size).toBe(0);
    const next = claimTurn(db, chat)!;
    expect([...w.poll().turns]).toEqual([next.id]);

    // A delete and its undo: the chat is drawn again whole.
    finishTurn(db, next.id, { status: "done" });
    w.poll();
    const d = deleteMessages(db, [m], T0);
    expect(d.ok).toBe(true);
    ch = w.poll();
    expect([...ch.redraw]).toEqual([chat]);
    expect(w.poll().redraw.size).toBe(0);
    undoDeletion(db, (d as { id: number }).id, T0 + 1000);
    expect([...w.poll().redraw]).toEqual([chat]);
  });

  test("a picture downloaded after its message was recorded (its payload rewritten in place) is a change", () => {
    const { db, chat } = setup();
    const photo = ownerSays(db, "look at this", { media: { kind: "photo", fileUniqueId: "u-1", file: { fileId: "f-1", fileUniqueId: "u-1" }, state: "pending" } as never });
    // Followed whether it arrived before the watch started or after.
    const w = new Watch(db);
    const late = ownerSays(db, "and this", { media: { kind: "photo", fileUniqueId: "u-2", file: { fileId: "f-2", fileUniqueId: "u-2" }, state: "pending" } as never });
    w.poll();
    expect(w.poll().chats.size).toBe(0);
    updateMedia(db, photo, { state: "ready", path: "media/u-1", mimeType: "image/png" });
    let ch = w.poll();
    expect([...ch.redraw]).toEqual([chat]);
    expect(w.poll().chats.size).toBe(0);
    updateMedia(db, late, { state: "ready", path: "media/u-2", mimeType: "image/png" });
    ch = w.poll();
    expect([...ch.redraw]).toEqual([chat]);
  });
});

describe("the stream", () => {
  test("a page that is up to date gets nothing; a running turn unfolds step by step, each part as the reloaded page draws it", () => {
    const { db, chat, turn } = setup();
    const here = `/segments/${turn.id}`;
    const page = segmentPage({ ...ctxOf(db), here }, new URLSearchParams(), turn.id)!;
    expect(page).toContain(`data-live-page="${here}"`);
    expect(page).toContain(`data-k="t${turn.id}"`);
    const { open, tick } = harness(db);
    const { ops } = open(here, page);
    // Only the list's order, which a first frame always says.
    expect(ops().filter((o) => !("order" in o))).toEqual([]);

    addStep(db, turn.id, 1, { kind: "tool", name: "search_notes", args: JSON.stringify({ query: "trains" }), callId: "c1", status: "running" });
    tick();
    let got = parts(ops());
    const t = got.find((o) => o.k === `t${turn.id}`)!;
    expect(t.html).toContain("search_notes");
    expect(t.html).toContain("no result");
    expect(t.live).toBe(true);
    expect(got.some((o) => o.k === "head")).toBe(true);

    completeStep(db, turn.id, "c1", { status: "ok", result: "two trains", endedAt: new Date(T0 + 4000).toISOString() });
    const m = enqueueOutbound(db, { chatId: chat, kind: "bot_message", payload: { text: "The 9:15 or the 10:15." }, idemKey: "t:1", turnId: turn.id })!;
    tick();
    got = parts(ops());
    const t2 = got.find((o) => o.k === `t${turn.id}`)!;
    expect(t2.html).not.toContain("no result");
    expect(t2.html).toContain("… pending");

    markSent(db, m, 900);
    finishTurn(db, turn.id, { status: "done", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.0123 } as never });
    tick();
    got = parts(ops());
    const t3 = got.find((o) => o.k === `t${turn.id}`)!;
    expect(t3.html).toContain("✓ delivered");
    expect(t3.live).toBe(false);

    // What the stream sent is what a reload draws, to the byte, under the same hash.
    const reloaded = segmentPage({ ...ctxOf(db), here }, new URLSearchParams(), turn.id)!;
    const p = partIn(reloaded, `t${turn.id}`)!;
    expect(p.h).toBe(t3.h);
    expect(p.inner.startsWith(t3.html)).toBe(true);
    // The list, drawn at most every LIST_EVERY_MS, catches up on its next turn (the segment's row: its cost)...
    tick();
    tick();
    expect(parts(ops()).map((o) => o.k)).toEqual([`g${chat}`]);
    // ...and then nothing more while nothing changes.
    tick();
    tick();
    tick();
    expect(ops()).toEqual([]);
  });

  test("a new turn is a new part after the last; a reconnect resumes from what the page has, with no gap and nothing twice", () => {
    const { db, chat, turn } = setup();
    const here = `/segments/${turn.id}`;
    const old = segmentPage({ ...ctxOf(db), here }, new URLSearchParams(), turn.id)!;
    // While the page is not connected: the turn goes on and ends, and the next one starts.
    addStep(db, turn.id, 1, { kind: "tool", name: "search_notes", args: "{}", callId: "c1", status: "ok", result: "none" });
    finishTurn(db, turn.id, { status: "done" });
    ownerSays(db, "and tomorrow?");
    const next = claimTurn(db, chat)!;
    addStep(db, next.id, 0, { kind: "thinking", text: "Tomorrow's trains." });

    const { open } = harness(db);
    const { ops } = open(here, old);
    const got = parts(ops());
    expect(got.filter((o) => o.k === `t${turn.id}`).length).toBe(1);
    const added = got.find((o) => o.k === `t${next.id}`)!;
    expect(added.after).toBe(`t${turn.id}`);
    expect(added.in).toBe("trace");
    expect(added.html).toContain("Tomorrow&#39;s trains.");

    // Connecting again from the page as it is now: nothing to send.
    const now = segmentPage({ ...ctxOf(db), here }, new URLSearchParams(), turn.id)!;
    expect(parts(harness(db).open(here, now).ops())).toEqual([]);
  });

  test("a turn's divider says its model, and \"→\" where it changed, as the reloaded page does, the turn before taken from the cache", () => {
    const { db, chat, turn } = setup();
    setTranscriptModel(db, turn.id, "claude-example-a");
    finishTurn(db, turn.id, { status: "done" });
    ownerSays(db, "and now?");
    const next = claimTurn(db, chat)!;
    saveTranscript(db, next.id, { promptHash: null, input: [{ type: "text", text: "and now?" }], resumed: true });
    const here = `/segments/${turn.id}`;
    const page = segmentPage({ ...ctxOf(db), here }, new URLSearchParams(), turn.id)!;
    const { open, tick } = harness(db);
    const { ops } = open(here, page);
    ops();
    // Only the second turn changes: the first is drawn from the cache, and the label still knows its model.
    setTranscriptModel(db, next.id, "claude-example-b");
    addStep(db, next.id, 0, { kind: "thinking", text: "Another model now." });
    tick();
    const t2 = parts(ops()).find((o) => o.k === `t${next.id}`)!;
    expect(t2.html).toContain('class="tmodel switched"');
    expect(t2.html).toContain("→ claude-example-b");
    const reloaded = segmentPage({ ...ctxOf(db), here }, new URLSearchParams(), turn.id)!;
    const p = partIn(reloaded, `t${next.id}`)!;
    expect(p.h).toBe(t2.h);
    expect(p.inner.startsWith(t2.html)).toBe(true);
  });

  test("a deleted message does not come back; its undo does", () => {
    const { db, chat, turn } = setup();
    const m = enqueueOutbound(db, { chatId: chat, kind: "bot_message", payload: { text: "Trains at 9:15." }, idemKey: "t:1", turnId: turn.id })!;
    markSent(db, m, 900);
    finishTurn(db, turn.id, { status: "done" });
    const here = `/chats/${chat}`;
    const page = chatPage({ ...ctxOf(db), here }, chat)!;
    const { open, tick } = harness(db);
    const { ops } = open(here, page);
    expect(parts(ops())).toEqual([]);
    const d = deleteMessages(db, [m], clock);
    expect(d.ok).toBe(true);
    tick(3000);
    const after = ops();
    for (const o of parts(after)) expect(o.html).not.toContain("Trains at 9:15.");
    expect(after.some((o) => "rm" in o && o.k === `e${m}`)).toBe(true);
    undoDeletion(db, (d as { id: number }).id, clock);
    tick(3000);
    expect(parts(ops()).some((o) => o.k === `e${m}` && o.html.includes("Trains at 9:15."))).toBe(true);
  });

  test("a chat's log: a message no turn took is one new part; a turn taking it puts its divider before it, in place", () => {
    const { db, chat, turn } = setup();
    finishTurn(db, turn.id, { status: "done" });
    const here = `/chats/${chat}`;
    const page = chatPage({ ...ctxOf(db), here }, chat)!;
    expect(page).toContain('data-region="trace"');
    const { open, tick } = harness(db);
    const { ops } = open(here, page);
    ops();
    const seq = ownerSays(db, "one more thing");
    tick(3000);
    let got = parts(ops());
    const ev = got.find((o) => o.k === `e${seq}`)!;
    expect(ev.html).toContain("unseen");
    expect(ev.after).toBe(`e${seq - 1}`);
    expect(ev.live).toBe(true);
    const next = claimTurn(db, chat)!;
    tick(3000);
    got = parts(ops());
    const div = got.find((o) => o.k === `d${next.id}`)!;
    expect(div.html).toContain("divider");
    expect(div.after).toBe(`e${seq - 1}`);
    expect(got.find((o) => o.k === `e${seq}`)!.html).not.toContain("unseen");
    const reloaded = chatPage({ ...ctxOf(db), here }, chat)!;
    expect(partIn(reloaded, `d${next.id}`)!.h).toBe(div.h);
  });

  test("a chat's log whose window slides (more events than a page holds): one message is one small part, nothing again", () => {
    const db = memDb();
    const chat = ownerChatId(db);
    for (let i = 0; i < 205; i++) ownerSays(db, `message number ${i} with some words in it`);
    const here = `/chats/${chat}`;
    const page = chatPage({ ...ctxOf(db), here }, chat)!;
    const { open, tick } = harness(db);
    const { ops, out } = open(here, page);
    expect(parts(ops())).toEqual([]);
    const seq = ownerSays(db, "one more");
    tick(3000);
    const bytes = out.join("").length;
    const got = ops();
    expect(parts(got).map((o) => o.k)).toEqual([`e${seq}`]);
    expect(got.filter((o) => "rm" in o)).toEqual([]);
    expect(bytes).toBeLessThan(4000);
    // And again, from a page reconnecting after both: still only what it lacks.
    const second = ownerSays(db, "and another");
    const again = harness(db).open(here, page);
    expect(parts(again.ops()).map((o) => o.k)).toEqual([`e${seq}`, `e${second}`]);
  });

  test("one drawing per page and change, shared by every stream of it; a chat's log draws again only the parts that changed", () => {
    const { db, chat, turn } = setup();
    finishTurn(db, turn.id, { status: "done" });
    const here = `/chats/${chat}`;
    const page = chatPage({ ...ctxOf(db), here }, chat)!;
    const { open, tick } = harness(db);
    const a = open(here, page, "s", "tab-a");
    const b = open(here, page, "s", "tab-b");
    expect(a.feed).toBe(b.feed);
    const before = a.feed.frames;
    ownerSays(db, "hello to both");
    tick(3000);
    expect(a.feed.frames).toBe(before + 1);
    expect(parts(a.ops()).map((o) => o.k)).toEqual(parts(b.ops()).map((o) => o.k));

    const view = liveView({ ...ctxOf(db), here }, here, new URLSearchParams())!;
    const f1 = view.frame({ ...ctxOf(db), here }, { detail: "all" })!;
    ownerSays(db, "one more");
    const f2 = view.frame({ ...ctxOf(db), here }, { detail: new Set() })!;
    expect(f2.trace!.length).toBe(f1.trace!.length + 1);
    // The parts that did not change are the very same objects: not drawn again.
    f1.trace!.slice(0, -1).forEach((p, i) => p.k.startsWith("d") || p.html.includes("unseen") || expect(f2.trace![i]).toBe(p));
  });

  test("on /turns with nothing selected, a newer segment is offered, never loaded; the page keeps following its own", () => {
    const { db, turn } = setup();
    const page = turnsPage({ ...ctxOf(db), here: "/turns" }, new URLSearchParams())!;
    const { open, tick } = harness(db);
    const { ops } = open("/turns", page);
    ops();
    const g = ensureChat(db, { id: -100999, kind: "group", title: "Example Book Club" });
    recordInbound(db, { chatId: g.id, kind: "message", payload: { from: { id: 77, name: "Alice Example" }, text: "hello all" }, tgUpdateId: 9001, tgMessageId: 9001 });
    claimTurn(db, g.id);
    addStep(db, turn.id, 1, { kind: "thinking", text: "still mine" });
    tick(3000);
    const got = ops();
    expect(got.filter((o) => "newer" in o).length).toBe(1);
    expect(parts(got).find((o) => o.k === `t${turn.id}`)!.html).toContain("still mine");
    tick(3000);
    expect(ops().some((o) => "newer" in o)).toBe(false);
  });

  test("the list: a new chat's group appears, in its order; a heartbeat when nothing happens", () => {
    const { db, turn } = setup();
    const here = `/turns/${turn.id}`;
    const page = turnsPage({ ...ctxOf(db), here }, new URLSearchParams(), turn.id)!;
    const { open, tick } = harness(db);
    const { ops, out } = open(here, page);
    ops();
    const g = ensureChat(db, { id: -100999, kind: "group", title: "Example Book Club" });
    recordInbound(db, { chatId: g.id, kind: "message", payload: { from: { id: 77, name: "Alice Example" }, text: "hello all" }, tgUpdateId: 9001, tgMessageId: 9001 });
    claimTurn(db, g.id);
    tick(3000);
    const got = ops();
    expect(parts(got).some((o) => o.k === `g${g.id}` && o.in === "list" && o.html.includes("Example Book Club"))).toBe(true);
    expect(got.some((o) => "order" in o && o.order[0] === `g${g.id}`)).toBe(true);
    tick(HEARTBEAT_MS);
    expect(out.some((c) => c === ": \n\n")).toBe(true);
  });
});

// ---- a deleted turn, on pages open in other tabs (store/deletions.ts deleteTurns) -----------------------------

/** Two finished turns of a DM in one segment, each with a message of hers. */
function twoTurns() {
  const { db, chat, hello, turn } = setup();
  const m1 = enqueueOutbound(db, { chatId: chat, kind: "bot_message", payload: { text: "Trains at 9:15." }, idemKey: "t:1", turnId: turn.id })!;
  markSent(db, m1, 901);
  finishTurn(db, turn.id, { status: "done" });
  const ask = ownerSays(db, "and the way back?");
  const next = claimTurn(db, chat)!;
  saveTranscript(db, next.id, { promptHash: null, input: [{ type: "text", text: "and the way back?" }], resumed: true });
  const m2 = enqueueOutbound(db, { chatId: chat, kind: "bot_message", payload: { text: "Back at 18:40." }, idemKey: "t:2", turnId: next.id })!;
  markSent(db, m2, 902);
  finishTurn(db, next.id, { status: "done" });
  return { db, chat, hello, turn, m1, ask, next, m2 };
}

describe("a deleted turn on pages already open (another tab)", () => {
  test("a chat's log: its divider and its rows are taken out; the undo puts them back in place", () => {
    const { db, chat, hello, turn, m1, next } = twoTurns();
    const here = `/chats/${chat}`;
    const { open, tick } = harness(db);
    const { ops } = open(here, chatPage({ ...ctxOf(db), here }, chat)!);
    ops();
    const r = deleteTurns(db, [turn.id], clock);
    if (!r.ok) throw new Error(r.refused);
    tick(3000);
    const gone = ops().filter((o): o is { k: string; rm: true } => "rm" in o).map((o) => o.k);
    expect(gone).toContain(`d${turn.id}`);
    expect(gone).toEqual(expect.arrayContaining([`e${hello}`, `e${m1}`]));
    expect(gone).not.toContain(`d${next.id}`);
    undoDeletion(db, r.id, clock);
    tick(3000);
    const back = parts(ops());
    const div = back.find((o) => o.k === `d${turn.id}`)!;
    expect(div.html).toContain(`turn ${turn.id}`);
    expect(back.find((o) => o.k === `e${m1}`)!.html).toContain("Trains at 9:15.");
    // As a reload draws it.
    expect(div.h).toBe(partIn(chatPage({ ...ctxOf(db), here }, chat)!, `d${turn.id}`)!.h);
  });

  test("the turn's own page is told to swap for the plain page; that page, live, is told to swap back on the undo", () => {
    const { db, next } = twoTurns();
    const here = `/turns/${next.id}`;
    const { open, tick } = harness(db);
    const page = open(here, turnsPage({ ...ctxOf(db), here }, new URLSearchParams(), next.id)!);
    page.ops();
    const r = deleteTurns(db, [next.id], clock);
    if (!r.ok) throw new Error(r.refused);
    tick(3000);
    expect(page.ops()).toEqual([{ swap: true }]);
    tick(3000);
    expect(page.ops()).toEqual([]); // said once
    // What it swaps to: the plain page, live while the undo can bring the turn back.
    const goneHtml = turnGonePage({ ...ctxOf(db), here }, "turn", next.id);
    expect(goneHtml).toContain(`data-live-page="${here}"`);
    expect(goneHtml).not.toContain("Back at 18:40.");
    const h2 = harness(db);
    const again = h2.open(here, goneHtml);
    expect(again.ops()).toEqual([]);
    undoDeletion(db, r.id, clock);
    h2.tick(3000);
    expect(again.ops()).toEqual([{ swap: true }]);
  });

  test("a segment: a deleted turn's part is taken out (the first one too); the segment named by it swaps", () => {
    const { db, turn, next } = twoTurns();
    // The segment named by its first turn, open in one tab, and the same segment named by its second in another.
    const byFirst = `/segments/${turn.id}`;
    const bySecond = `/segments/${next.id}`;
    const { open, tick } = harness(db);
    const a = open(byFirst, segmentPage({ ...ctxOf(db), here: byFirst }, new URLSearchParams(), turn.id)!);
    const b = open(bySecond, segmentPage({ ...ctxOf(db), here: bySecond }, new URLSearchParams(), next.id)!);
    a.ops();
    b.ops();
    const r = deleteTurns(db, [turn.id], clock);
    if (!r.ok) throw new Error(r.refused);
    tick(3000);
    expect(a.ops()).toEqual([{ swap: true }]);
    const bo = b.ops();
    expect(bo).toContainEqual({ k: `t${turn.id}`, rm: true });
    expect(bo.some((o) => "k" in o && o.k === `t${next.id}` && "rm" in o)).toBe(false);
    undoDeletion(db, r.id, clock);
    tick(3000);
    expect(parts(b.ops()).some((o) => o.k === `t${turn.id}`)).toBe(true);
  });
});

describe("the hub", () => {
  test("one poll per tick for every stream; past the cap the oldest other tab is told bye; a tab's next page replaces its stream; the poll stops with the last", () => {
    const { db, turn } = setup();
    const { hub, open, tick } = harness(db);
    const here = `/segments/${turn.id}`;
    const page = segmentPage({ ...ctxOf(db), here }, new URLSearchParams(), turn.id)!;
    // One tab navigating quickly (j / k): each page replaces the last, nothing else is closed.
    const tabs = Array.from({ length: MAX_STREAMS_PER_SESSION - 1 }, (_, i) => open(here, page, "one", `tab-${i}`));
    const hop1 = open(here, page, "one", "hopper");
    const hop2 = open(`/turns/${turn.id}`, turnsPage({ ...ctxOf(db), here: `/turns/${turn.id}` }, new URLSearchParams(), turn.id)!, "one", "hopper");
    expect(hop1.s.closed).toBe(true);
    expect(hop1.out.some((c) => c.startsWith("event: bye"))).toBe(false);
    expect(tabs.every((t) => !t.s.closed)).toBe(true);
    // One tab more than the cap: the oldest other is told bye; another session is not counted against it.
    const extra = open(here, page, "one", "tab-new");
    const other = open(here, page, "another", "x");
    expect(tabs[0]!.s.closed).toBe(true);
    expect(tabs[0]!.out.some((c) => c.startsWith("event: bye"))).toBe(true);
    expect(hop2.s.closed).toBe(false);
    expect(hub.size).toBe(MAX_STREAMS_PER_SESSION + 1);
    tick();
    tick();
    expect(hub.polls).toBe(2);
    for (const x of [...tabs, hop2, extra, other]) x.s.close();
    expect(hub.size).toBe(0);
    expect(hub.feeds.size).toBe(0);
    tick();
    expect(hub.polls).toBe(2);
  });
});

describe("GET /live", () => {
  const PORT = 8787;
  const BASE = `http://127.0.0.1:${PORT}`;
  const LOGIN = "owner@example.com";
  const deps = (db: Db, hub = new LiveHub(db, Date.now, 0)): ConsoleDeps => {
    const c = { listen: `127.0.0.1:${PORT}` };
    return { db, timeZone: "UTC", dataDir: "/nonexistent", allowedHosts: allowedHosts(c, PORT), allowedOrigins: allowedOrigins(c, PORT), csrfSecret: "x", users: new Set([LOGIN]), liveHub: hub };
  };
  const live = (db: Db, q: string, headers: Record<string, string> = { [LOGIN_HEADER]: LOGIN }, base = BASE, hub?: LiveHub) =>
    handleConsole(deps(db, hub), new Request(`${base}/live?${q}`, { headers }));

  test("behind the Host check and the sign-in; a page that is not live gets 204; a probe answers without a stream; a page from before a deploy is told to reload", async () => {
    const { db, turn } = setup();
    // The version a page names once the editor is built (/live waits for that build before it compares).
    await warmAssets();
    const page = `page=${encodeURIComponent(`/segments/${turn.id}`)}&v=${assetsVersion()}`;
    expect((await live(db, page, {})).status).toBe(403);
    expect((await live(db, page, { [LOGIN_HEADER]: "someone@example.com" })).status).toBe(403);
    expect((await live(db, page, { [LOGIN_HEADER]: LOGIN }, "http://evil.example:8787")).status).toBe(421);
    expect((await live(db, `page=${encodeURIComponent("/settings")}`)).status).toBe(204);
    expect((await live(db, `page=${encodeURIComponent("https://evil.example/turns")}`)).status).toBe(204);
    expect((await live(db, `page=${encodeURIComponent("/settings")}&probe=1`)).status).toBe(204);
    expect((await live(db, `${page}&probe=1`, {})).status).toBe(403);
    const probe = await live(db, `${page}&probe=1`);
    expect(probe.status).toBe(200);
    expect(probe.headers.get("content-type")).not.toContain("event-stream");

    const stale = await live(db, `page=${encodeURIComponent(`/segments/${turn.id}`)}&v=0000`);
    expect(await stale.text()).toContain("event: reload");

    const r = await live(db, page);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    expect(r.headers.get("content-security-policy")).toContain("connect-src 'self'");
    const reader = r.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("event: hello");
    await reader.cancel();
  });

  test("a stream that falls behind (its socket takes nothing) is dropped, not queued without end", async () => {
    const db = memDb();
    const chat = ownerChatId(db);
    const words = "a long message to fill the page ".repeat(200);
    for (let i = 0; i < 200; i++) ownerSays(db, `${i} ${words}`);
    await warmAssets();
    const hub = new LiveHub(db, Date.now, 0);
    // A page that has nothing yet: its first frame is the whole log (over a megabyte). One large frame goes out...
    const r = await live(db, `page=${encodeURIComponent(`/chats/${chat}`)}&v=${assetsVersion()}`, undefined, BASE, hub);
    expect(r.status).toBe(200);
    expect(hub.size).toBe(1);
    // ...but nobody reads it, and the next one finds it still waiting: the stream is dropped.
    ownerSays(db, "one more");
    hub.tick();
    expect(hub.size).toBe(0);
  });
});
