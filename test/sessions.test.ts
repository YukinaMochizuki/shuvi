import { describe, expect, test } from "bun:test";
import { chatGrouping, conversationOf, SEGMENT_GAP_MS, segmentList, segmentOf } from "../src/console/sessions.ts";
import { raiseAlert } from "../src/store/control.ts";
import type { Db } from "../src/store/db.ts";
import { ensureChat, recordInbound } from "../src/store/events.ts";
import type { Opening } from "../src/store/turns.ts";
import { memDb, OWNER } from "./helpers.ts";

/**
 * How turns are grouped, on hand-made rows: turns at chosen times, each with a message as its trigger, with
 * or without a recorded opening and backend session id, and `/new` commands or lost-session alerts where a
 * test puts them.
 */

const T0 = Date.parse("2026-01-10T09:00:00.000Z");
const MIN = 60_000;
let update = 1;

function message(db: Db, chatId: number, text: string, at: number): number {
  recordInbound(db, { chatId, kind: "message", payload: { from: { id: OWNER, name: "Owner" }, text }, tgUpdateId: update++, tgMessageId: update });
  const seq = (db.$client.query("select max(seq) as s from chat_events").get() as { s: number }).s;
  db.$client.query("update chat_events set at = ? where seq = ?").run(new Date(at).toISOString(), seq);
  return seq;
}

function command(db: Db, chatId: number, name: "new" | "stop"): void {
  recordInbound(db, { chatId, kind: "command", payload: { from: { id: OWNER, name: "Owner" }, command: name }, tgUpdateId: update++, tgMessageId: update });
}

/**
 * A turn answering one new message, from `start` to `end` (minutes from T0). With `conv`, as recorded since
 * openings exist (its backend session id and how it opened); without, as an older turn.
 */
function turn(db: Db, chatId: number, start: number, end: number | null, o: { status?: string; conv?: { sid: string; opening: Opening } } = {}): number {
  const seq = message(db, chatId, `message at ${start}`, T0 + start * MIN);
  return Number(
    db.$client
      .query("insert into turns (chat_id, status, from_seq, to_seq, trigger_seq, started_at, ended_at, backend_session_id, opening) values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(chatId, o.status ?? "done", seq - 1, seq, seq, new Date(T0 + start * MIN).toISOString(), end === null ? null : new Date(T0 + end * MIN).toISOString(), o.conv?.sid ?? null, o.conv?.opening ?? null)
      .lastInsertRowid,
  );
}

/** The chat's turns as [conversation[segment[turn ids]]]. */
function shape(db: Db, chatId: number): number[][][] {
  const out: number[][][] = [];
  let conv = -1;
  let seg = -1;
  for (const p of chatGrouping(db, chatId)) {
    if (p.conversationId !== conv) out.push([]), (conv = p.conversationId), (seg = -1);
    const c = out.at(-1)!;
    if (p.sessionId !== seg) c.push([]), (seg = p.sessionId);
    c.at(-1)!.push(p.turnId);
  }
  return out;
}

const dm = (db: Db) => ensureChat(db, { id: OWNER, kind: "private" }).id;

describe("segments: time gaps inside a conversation", () => {
  test("turns closer than the gap are one segment; a longer gap starts another, in the same conversation", () => {
    expect(SEGMENT_GAP_MS).toBe(30 * MIN);
    const db = memDb();
    const chat = dm(db);
    const a = turn(db, chat, 0, 1);
    const b = turn(db, chat, 20, 21); // 19 min after a ended
    const c = turn(db, chat, 51, 52); // exactly 30 min after b ended: still the same segment
    const d = turn(db, chat, 83, 84); // 31 min after c ended
    expect(shape(db, chat)).toEqual([[[a, b, c], [d]]]);
  });

  test("the gap is measured from the previous turn's end, or its start when it never ended", () => {
    const db = memDb();
    const chat = dm(db);
    const a = turn(db, chat, 0, 50); // a long turn
    const b = turn(db, chat, 60, 61); // 10 min after a ended
    const c = turn(db, chat, 80, null, { status: "running" }); // 19 min after b ended; no end
    const d = turn(db, chat, 100, 101); // 20 min after c's start
    expect(shape(db, chat)).toEqual([[[a, b, c, d]]]);
  });
});

describe("conversations: what the model saw as one", () => {
  test("recorded: turns sharing a backend session are one conversation; `new` and `lost` open another", () => {
    const db = memDb();
    const chat = dm(db);
    const a = turn(db, chat, 0, 1, { conv: { sid: "s1", opening: "first" } });
    const b = turn(db, chat, 2, 3, { conv: { sid: "s1", opening: "resumed" } });
    const c = turn(db, chat, 300, 301, { conv: { sid: "s1", opening: "resumed" } }); // hours later: same conversation, new segment
    command(db, chat, "new");
    const d = turn(db, chat, 302, 303, { conv: { sid: "s2", opening: "new" } });
    const e = turn(db, chat, 304, 305, { conv: { sid: "s3", opening: "lost" } });
    expect(shape(db, chat)).toEqual([[[a, b], [c]], [[d]], [[e]]]);
    const conv = conversationOf(db, chat, c)!;
    expect(conv.conversation).toMatchObject({ id: a, start: "first", inferred: false, backendSessionId: "s1", turns: 3, segments: 2 });
    expect(conversationOf(db, chat, e)!.conversation).toMatchObject({ start: "lost", inferred: false });
  });

  test("a backend session that changes without a recorded opening still starts a new conversation", () => {
    const db = memDb();
    const chat = dm(db);
    const a = turn(db, chat, 0, 1, { conv: { sid: "s1", opening: "first" } });
    const b = turn(db, chat, 2, 3, { conv: { sid: "s9", opening: "resumed" } });
    expect(shape(db, chat)).toEqual([[[a]], [[b]]]);
  });

  test("older turns: /new and lost-session alerts are read back as conversation starts, marked inferred", () => {
    const db = memDb();
    const chat = dm(db);
    const a = turn(db, chat, 0, 1);
    command(db, chat, "stop"); // not a reset
    const b = turn(db, chat, 2, 3);
    command(db, chat, "new");
    const c = turn(db, chat, 4, 5);
    const d = turn(db, chat, 6, 7);
    raiseAlert(db, { key: `lost-session:${d}`, text: "The conversation was lost." });
    expect(shape(db, chat)).toEqual([[[a, b]], [[c]], [[d]]]);
    expect(conversationOf(db, chat, a)!.conversation).toMatchObject({ start: "first", inferred: true });
    expect(conversationOf(db, chat, c)!.conversation).toMatchObject({ start: "new", inferred: true });
    expect(conversationOf(db, chat, d)!.conversation).toMatchObject({ start: "lost", inferred: true });
  });

  test("a conversation that began before openings were recorded and went on after is one", () => {
    const db = memDb();
    const chat = dm(db);
    const a = turn(db, chat, 0, 1);
    const b = turn(db, chat, 2, 3, { conv: { sid: "s1", opening: "resumed" } });
    expect(shape(db, chat)).toEqual([[[a, b]]]);
    expect(conversationOf(db, chat, b)!.conversation).toMatchObject({ id: a, inferred: true, backendSessionId: "s1" });
  });

  test("chats are never mixed, even when their turns interleave", () => {
    const db = memDb();
    const one = dm(db);
    const group = ensureChat(db, { id: -100777, kind: "group", title: "Example Group" }).id;
    const a = turn(db, one, 0, 1);
    const x = turn(db, group, 2, 3);
    const b = turn(db, one, 4, 5);
    const y = turn(db, group, 6, 7);
    expect(shape(db, one)).toEqual([[[a, b]]]);
    expect(shape(db, group)).toEqual([[[x, y]]]);
  });

  test("a segment is found by any of its turns, with its neighbours and its conversation's segments", () => {
    const db = memDb();
    const chat = dm(db);
    const a = turn(db, chat, 0, 1);
    const b = turn(db, chat, 100, 101);
    const c = turn(db, chat, 102, 103);
    command(db, chat, "new");
    const d = turn(db, chat, 104, 105);
    const s = segmentOf(db, chat, c)!;
    expect([s.id, s.turnIds, s.prev, s.next, s.segmentIds]).toEqual([b, [b, c], a, d, [a, b]]);
    expect(conversationOf(db, chat, a)!.next).toBe(d);
    expect(segmentOf(db, chat, 9999)).toBeNull();
  });
});

describe("the list", () => {
  test("segments newest first per chat, with their counts; filters keep segments holding a matching turn", () => {
    const db = memDb();
    const chat = dm(db);
    const a = turn(db, chat, 0, 1);
    const b = turn(db, chat, 2, 3, { status: "failed" });
    const c = turn(db, chat, 100, 101);
    db.$client.query("update turns set cost_micro_usd = 1000 where id in (?, ?, ?)").run(a, b, c);
    const all = segmentList(db, {}, 5);
    expect([all.segments, all.turns]).toEqual([2, 3]);
    expect(all.groups[0]!.segments.map((s) => [s.id, s.conversationId, s.turns, s.failed, s.costMicroUsd])).toEqual([
      [c, a, 1, 0, 1000],
      [a, a, 2, 1, 2000],
    ]);
    expect(all.conversations.get(a)).toMatchObject({ turns: 3, segments: 2 });
    const failed = segmentList(db, { outcome: "failed" }, 5);
    expect(failed.groups[0]!.segments.map((s) => [s.id, s.turns, s.matching])).toEqual([[a, 2, 1]]);
    expect(segmentList(db, { q: "no such text" }, 5).groups).toEqual([]);
    expect(segmentList(db, { chat, before: c }, 5).groups[0]!.segments.map((s) => s.id)).toEqual([a]);
  });
});
