import type { Db } from "../store/db.ts";
import type { Chat, ChatEvent } from "../store/events.ts";
import type { Turn } from "../store/turns.ts";

/**
 * What the console reads, and nothing else: every query here is a SELECT. Plain SQL over `$client`, since
 * the lists filter and aggregate in ways the query builder only makes longer.
 */

export const TURN_COLUMNS = `t.id, t.chat_id as chatId, t.status, t.pid, t.pid_start as pidStart, t.term_at as termAt, t.from_seq as fromSeq,
  t.to_seq as toSeq, t.trigger_seq as triggerSeq, t.stop_seq as stopSeq, t.error, t.cost_micro_usd as costMicroUsd,
  t.input_tokens as inputTokens, t.output_tokens as outputTokens, t.cache_read_tokens as cacheReadTokens,
  t.cache_creation_tokens as cacheCreationTokens, t.backend_session_id as backendSessionId, t.opening,
  t.started_at as startedAt, t.ended_at as endedAt`;

export const CHAT_COLUMNS = `c.id, c.tg_chat_id as tgChatId, c.kind, c.title, c.cursor_seq as cursorSeq, c.backend_session_id as backendSessionId,
  c.context_tokens as contextTokens, c.created_at as createdAt,
  (select json_extract(e.payload, '$.from.name') from chat_events e where e.chat_id = c.id and e.kind = 'message' order by e.seq desc limit 1) as person`;

const EVENT_COLUMNS = `seq, chat_id as chatId, kind, payload, tg_update_id as tgUpdateId, tg_message_id as tgMessageId, idem_key as idemKey,
  status, note, turn_id as turnId, at`;

/** A chat as the console names it: a private chat's person is whoever writes in it (the owner). */
export interface ConsoleChat extends Chat {
  person: string | null;
}

type EventRow = { payload: string } & Omit<ChatEvent, "payload">;
const eventRow = (r: EventRow): ChatEvent => ({ ...r, payload: JSON.parse(r.payload) as Record<string, unknown> });

export function chatById(db: Db, id: number): ConsoleChat | undefined {
  return (db.$client.query(`select ${CHAT_COLUMNS} from chats c where c.id = ?`).get(id) as ConsoleChat | null) ?? undefined;
}

/** A page of a chat's events, oldest first: the `limit` newest before `before` (or the newest overall). */
export function chatEventsPage(db: Db, chatId: number, limit: number, before?: number): { events: ChatEvent[]; more: boolean } {
  const rows = db.$client
    .query(`select ${EVENT_COLUMNS} from chat_events where chat_id = ? and seq < ? order by seq desc limit ?`)
    .all(chatId, before ?? Number.MAX_SAFE_INTEGER, limit + 1) as EventRow[];
  return { events: rows.slice(0, limit).reverse().map(eventRow), more: rows.length > limit };
}

/** A chat's events in (from, to], in order. */
export function eventsBetween(db: Db, chatId: number, from: number, to: number): ChatEvent[] {
  return (db.$client.query(`select ${EVENT_COLUMNS} from chat_events where chat_id = ? and seq > ? and seq <= ? order by seq`).all(chatId, from, to) as EventRow[]).map(eventRow);
}

export type TurnSpan = Pick<Turn, "id" | "fromSeq" | "toSeq" | "status" | "startedAt" | "endedAt" | "costMicroUsd">;

/** A chat's turns, with the range of events each answered (to link an event to its turn). */
export function chatTurnSpans(db: Db, chatId: number): TurnSpan[] {
  return db.$client
    .query(`select id, from_seq as fromSeq, to_seq as toSeq, status, started_at as startedAt, ended_at as endedAt, cost_micro_usd as costMicroUsd from turns where chat_id = ? order by id`)
    .all(chatId) as TurnSpan[];
}

export interface TurnFilter {
  chat?: number;
  outcome?: string;
  tool?: string;
  /** Dates, `YYYY-MM-DD`, inclusive, read in `timeZone` (the owner's). */
  from?: string;
  to?: string;
  timeZone?: string;
  q?: string;
  /** Turns older than this id (paging). */
  before?: number;
  /** Only this turn. */
  id?: number;
}

/** How far `timeZone` is ahead of UTC at instant `t`, in ms. */
function zoneOffset(t: number, timeZone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(t))
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(t / 1000) * 1000;
}

/** The instant a calendar day (`YYYY-MM-DD`) begins in `timeZone`, as ISO. */
export function dayStart(date: string, timeZone = "UTC"): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d);
  let t = naive - zoneOffset(naive, timeZone);
  t = naive - zoneOffset(t, timeZone); // again, at the instant itself: a DST change that day
  return new Date(t).toISOString();
}

function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

export function turnWhere(f: TurnFilter): { sql: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.chat !== undefined) where.push("t.chat_id = ?"), params.push(f.chat);
  if (f.outcome) where.push("t.status = ?"), params.push(f.outcome);
  if (f.tool) where.push("exists (select 1 from turn_steps s where s.turn_id = t.id and s.kind = 'tool' and s.name = ?)"), params.push(f.tool);
  if (f.from) where.push("t.started_at >= ?"), params.push(dayStart(f.from, f.timeZone));
  if (f.to) where.push("t.started_at < ?"), params.push(dayStart(nextDay(f.to), f.timeZone));
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(
      `(t.error like ? escape '\\' or exists (select 1 from turn_steps s where s.turn_id = t.id and (s.text like ? escape '\\' or s.args like ? escape '\\' or s.result like ? escape '\\' or s.error like ? escape '\\'))
        or exists (select 1 from turn_transcripts x where x.turn_id = t.id and x.input like ? escape '\\'))`,
    );
    params.push(like, like, like, like, like, like);
  }
  if (f.before !== undefined) where.push("t.id < ?"), params.push(f.before);
  if (f.id !== undefined) where.push("t.id = ?"), params.push(f.id);
  return { sql: where.length ? `where ${where.join(" and ")}` : "", params };
}

/** Every tool name recorded, most used first (the turns list's filter). */
export function toolNames(db: Db): string[] {
  return (db.$client.query(`select name from turn_steps where kind = 'tool' and name is not null group by name order by count(*) desc, name`).all() as { name: string }[]).map((r) => r.name);
}

export function turnById(db: Db, id: number): Turn | undefined {
  return (db.$client.query(`select ${TURN_COLUMNS} from turns t where t.id = ?`).get(id) as Turn | null) ?? undefined;
}

/** The turns before and after `turn` in its chat. */
export function neighbours(db: Db, turn: Turn): { prev: number | null; next: number | null } {
  const prev = db.$client.query(`select max(id) as id from turns where chat_id = ? and id < ?`).get(turn.chatId, turn.id) as { id: number | null };
  const next = db.$client.query(`select min(id) as id from turns where chat_id = ? and id > ?`).get(turn.chatId, turn.id) as { id: number | null };
  return { prev: prev.id, next: next.id };
}

/** The events a turn wrote (outbound), in order, with their delivery state. */
export function outboundOf(db: Db, turnId: number): ChatEvent[] {
  return (db.$client.query(`select ${EVENT_COLUMNS} from chat_events where turn_id = ? order by seq`).all(turnId) as EventRow[]).map(eventRow);
}

/**
 * The media prewarms of the messages a turn answered (its chat's, in (from, to]): how many, and how many a
 * turn then used (`video_probe` of the same link). The console's "prewarmed: used / unused".
 */
export function turnPrewarms(db: Db, chatId: number, fromSeq: number, toSeq: number): { used: number; unused: number } {
  const r = db.$client
    .query(`select count(*) as n, count(used_turn_id) as used from media_prewarms where chat_id = ? and seq > ? and seq <= ?`)
    .get(chatId, fromSeq, toSeq) as { n: number; used: number } | null;
  return { used: r?.used ?? 0, unused: (r?.n ?? 0) - (r?.used ?? 0) };
}

/** One event by seq. */
export function eventBySeq(db: Db, seq: number): ChatEvent | undefined {
  const r = db.$client.query(`select ${EVENT_COLUMNS} from chat_events where seq = ?`).get(seq) as EventRow | null;
  return r ? eventRow(r) : undefined;
}
