import type { Db } from "../store/db.ts";
import type { Chat, ChatEvent } from "../store/events.ts";
import type { Turn } from "../store/turns.ts";

/**
 * What the console reads, and nothing else: every query here is a SELECT. Plain SQL over `$client`, since
 * the lists filter and aggregate in ways the query builder only makes longer.
 */

const TURN_COLUMNS = `t.id, t.chat_id as chatId, t.status, t.pid, t.pid_start as pidStart, t.term_at as termAt, t.from_seq as fromSeq,
  t.to_seq as toSeq, t.trigger_seq as triggerSeq, t.stop_seq as stopSeq, t.error, t.cost_micro_usd as costMicroUsd,
  t.input_tokens as inputTokens, t.output_tokens as outputTokens, t.cache_read_tokens as cacheReadTokens,
  t.cache_creation_tokens as cacheCreationTokens, t.started_at as startedAt, t.ended_at as endedAt`;

const CHAT_COLUMNS = `c.id, c.tg_chat_id as tgChatId, c.kind, c.title, c.cursor_seq as cursorSeq, c.backend_session_id as backendSessionId,
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

export interface TurnRow extends Turn {
  chatTitle: string | null;
  chatKind: Chat["kind"];
  tgChatId: number;
  person: string | null;
  toolCalls: number;
  refused: number;
  failedCalls: number;
  triggerKind: string | null;
  triggerPayload: string | null;
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

function turnWhere(f: TurnFilter): { sql: string; params: (string | number)[] } {
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

/** What a list row shows of a turn beyond its own columns. */
const ROW_EXTRAS = `c.title as chatTitle, c.kind as chatKind, c.tg_chat_id as tgChatId,
        (select json_extract(e.payload, '$.from.name') from chat_events e where e.chat_id = c.id and e.kind = 'message' order by e.seq desc limit 1) as person,
        (select count(*) from turn_steps s where s.turn_id = t.id and s.kind = 'tool') as toolCalls,
        (select count(*) from turn_steps s where s.turn_id = t.id and s.kind = 'tool' and s.status = 'refused') as refused,
        (select count(*) from turn_steps s where s.turn_id = t.id and s.kind = 'tool' and s.status in ('error', 'threw')) as failedCalls,
        (select e.kind from chat_events e where e.seq = coalesce(t.trigger_seq, t.to_seq)) as triggerKind,
        (select e.payload from chat_events e where e.seq = coalesce(t.trigger_seq, t.to_seq)) as triggerPayload`;

/** A chat at the head of its group in the turn list: what its matching turns add up to. */
export interface ChatGroupHead extends ConsoleChat {
  lastEventAt: string | null;
  /** Its turns that match the filter, and how many of those failed. */
  matching: number;
  failed: number;
}

export interface TurnTree {
  groups: { chat: ChatGroupHead; rows: TurnRow[] }[];
  /** Matching turns in all. */
  total: number;
}

const isFiltered = (f: TurnFilter) => !!(f.chat !== undefined || f.outcome || f.tool || f.from || f.to || f.q);

/**
 * The turn list grouped by chat: every chat with a matching turn (with no filter, every chat), most recently
 * active first, each with its latest `perChat` matching turns, newest first. One query for the heads and
 * one, windowed, for the rows, however many chats there are.
 */
export function turnTree(db: Db, f: TurnFilter, perChat: number): TurnTree {
  const { sql, params } = turnWhere({ ...f, before: undefined });
  const heads = db.$client
    .query(
      `select ${CHAT_COLUMNS},
        (select e.at from chat_events e where e.chat_id = c.id order by e.seq desc limit 1) as lastEventAt,
        coalesce(m.n, 0) as matching, coalesce(m.failed, 0) as failed
      from chats c
      ${isFiltered(f) ? "join" : "left join"} (select t.chat_id, count(*) as n, sum(t.status = 'failed') as failed, max(t.started_at) as lastTurnAt from turns t ${sql} group by t.chat_id) m on m.chat_id = c.id
      order by coalesce(lastEventAt, m.lastTurnAt, c.created_at) desc, c.id desc`,
    )
    .all(...params) as ChatGroupHead[];
  const rows = db.$client
    .query(
      `with ranked as (select t.*, row_number() over (partition by t.chat_id order by t.id desc) as rn from turns t ${sql})
      select ${TURN_COLUMNS}, ${ROW_EXTRAS}
      from ranked t join chats c on c.id = t.chat_id
      where t.rn <= ? order by t.id desc`,
    )
    .all(...params, perChat) as TurnRow[];
  const byChat = new Map<number, TurnRow[]>();
  for (const r of rows) byChat.set(r.chatId, [...(byChat.get(r.chatId) ?? []), r]);
  return { groups: heads.map((chat) => ({ chat, rows: byChat.get(chat.id) ?? [] })), total: heads.reduce((n, h) => n + h.matching, 0) };
}

export function turnList(db: Db, f: TurnFilter, limit: number): { rows: TurnRow[]; more: boolean; total: number } {
  const { sql, params } = turnWhere(f);
  const rows = db.$client
    .query(
      `select ${TURN_COLUMNS}, ${ROW_EXTRAS}
      from turns t join chats c on c.id = t.chat_id
      ${sql} order by t.id desc limit ?`,
    )
    .all(...params, limit + 1) as TurnRow[];
  const { sql: countSql, params: countParams } = turnWhere({ ...f, before: undefined });
  const total = (db.$client.query(`select count(*) as n from turns t ${countSql}`).get(...countParams) as { n: number }).n;
  return { rows: rows.slice(0, limit), more: rows.length > limit, total };
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

/** One event by seq. */
export function eventBySeq(db: Db, seq: number): ChatEvent | undefined {
  const r = db.$client.query(`select ${EVENT_COLUMNS} from chat_events where seq = ?`).get(seq) as EventRow | null;
  return r ? eventRow(r) : undefined;
}
