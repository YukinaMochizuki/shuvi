import type { Db } from "../store/db.ts";
import { CHAT_COLUMNS, turnWhere, type ConsoleChat, type TurnFilter } from "./queries.ts";

/**
 * How the console groups a chat's turns, by what the model actually saw. Three levels:
 *
 *   chat
 *   └ CONVERSATION   her conversation: the turns that share one backend session (agent-runtime's session id).
 *     │              Every turn of a chat resumes the same one until `/new`, changed settings or a lost session opens
 *     │              another; inside it she sees one continuous exchange, except across a compaction, after
 *     │              which she sees only a summary of what came before (a `compaction` step, shown as such).
 *     └ SEGMENT      a run of its turns with no gap longer than SEGMENT_GAP_MS between one turn's end (or
 *                    start, if it never ended) and the next one's start: what the owner remembers as "that
 *                    exchange". The list's items are segments.
 *
 * A turn opens a new conversation when it is the chat's first, when its recorded `opening` (schema.ts
 * `turns.opening`) is `first`, `new`, `changed` or `lost`, or when its backend session id differs from the previous
 * turn's. Turns recorded before `opening` existed have none: theirs is INFERRED from what was recorded anyway,
 * a `/new` command between the previous turn's trigger and this one's, or a lost-session alert raised for this
 * turn (`lost-session:<turn id>`, store/control.ts), and labelled as inferred. A conversation that began
 * before the change and went on after it is one conversation: the first recorded turn's `resumed` joins it.
 *
 * Conversations and segments are named by their first turn's id: new turns only extend the latest or start
 * another, and turns are never deleted. Computed in SQL with window functions (one pass over the turns per
 * query), not stored, so the rule can change without touching data. The list, which needs the grouping
 * several times, works it out once per request into a TEMP table: private to the connection, dropped after,
 * never written to the database file.
 */

export const SEGMENT_GAP_MS = 30 * 60_000;

/** How a conversation began: recorded on its first turn, or inferred for turns from before that was recorded. */
export type ConversationStart = "first" | "new" | "lost" | "changed" | "resumed";

/** A `turn_session` CTE definition (to follow `with`) and its parameters. */
type Grouping = { sql: string; params: number[] };

/** `turn_session(turn_id, chat_id, session_id, conversation_id, why)` as CTEs, over every chat or one. */
function groupingCte(chat?: number): Grouping {
  return {
    sql: `g_t as (
      select t.id, t.chat_id, t.started_at, t.opening, t.backend_session_id as sid, coalesce(t.trigger_seq, t.to_seq) as trig,
        lag(t.id) over w as prev_id,
        lag(coalesce(t.ended_at, t.started_at)) over w as prev_end,
        lag(coalesce(t.trigger_seq, t.to_seq)) over w as prev_trig,
        lag(t.backend_session_id) over w as prev_sid
      from turns t ${chat !== undefined ? "where t.chat_id = ?" : ""}
      window w as (partition by t.chat_id order by t.id)
    ),
    g_b as (
      select id, chat_id, opening,
        -- why a conversation starts here (null: it does not); recorded, else inferred
        case
          when prev_id is null then coalesce(opening, 'first')
          when opening in ('first', 'new', 'lost', 'changed') then opening
          when opening is null and exists (select 1 from control_messages m where m.idem_key = 'lost-session:' || g_t.id) then 'lost'
          when opening is null and exists (select 1 from chat_events e where e.chat_id = g_t.chat_id and e.seq > g_t.prev_trig and e.seq < g_t.trig
            and e.kind = 'command' and json_extract(e.payload, '$.command') = 'new') then 'new'
          when sid is not null and prev_sid is not null and sid <> prev_sid then 'resumed'
          else null end as why,
        -- whole milliseconds: julianday's floating point would put an exact gap a hair over the limit
        cast(round((julianday(started_at) - julianday(prev_end)) * 86400000.0) as integer) > ${SEGMENT_GAP_MS} as gap
      from g_t
    ),
    g_n as (
      select id, chat_id, opening, why,
        sum(why is not null) over w as cn,
        sum(why is not null or coalesce(gap, 0)) over w as sn
      from g_b window w as (partition by chat_id order by id)
    ),
    -- materialized: several subqueries read it, and recomputing the windows for each would cost the most
    turn_session as materialized (
      select id as turn_id, chat_id, why, opening,
        min(id) over (partition by chat_id, sn) as session_id,
        min(id) over (partition by chat_id, cn) as conversation_id
      from g_n
    )`,
    params: chat !== undefined ? [chat] : [],
  };
}

export interface TurnPlace {
  turnId: number;
  sessionId: number;
  conversationId: number;
}

/** Every turn of a chat with its segment and conversation, in order. */
export function chatGrouping(db: Db, chatId: number): TurnPlace[] {
  const c = groupingCte(chatId);
  return db.$client
    .query(`with ${c.sql} select turn_id as turnId, session_id as sessionId, conversation_id as conversationId from turn_session order by turn_id`)
    .all(...c.params) as TurnPlace[];
}

/** A conversation: how it began, and what it holds. */
export interface Conversation {
  id: number;
  chatId: number;
  /** Why it began (null only if nothing says: shown as an earlier, unlabelled conversation). */
  start: ConversationStart | null;
  /** True when `start` was inferred (its first turn is from before openings were recorded). */
  inferred: boolean;
  backendSessionId: string | null;
  startedAt: string;
  endedAt: string;
  turns: number;
  segments: number;
  compactions: number;
}

/** Conversations by id, for `ids` (of one chat or several). */
export function conversations(db: Db, ids: number[], grouping?: Grouping): Map<number, Conversation> {
  if (!ids.length) return new Map();
  const c = grouping ?? groupingCte();
  const marks = ids.map(() => "?").join(",");
  const rows = db.$client
    .query(
      // One pass of aggregates (a correlated subquery per conversation would rescan the grouping each time).
      `with ${c.sql},
      compacted as (select turn_id, count(*) as n from turn_steps where kind = 'compaction' group by turn_id)
      select ts.conversation_id as id, ts.chat_id as chatId,
        max(case when ts.turn_id = ts.conversation_id then ts.why end) as start,
        max(case when ts.turn_id = ts.conversation_id then t.opening is null end) as inferred,
        max(t.backend_session_id) as backendSessionId,
        min(t.started_at) as startedAt, max(coalesce(t.ended_at, t.started_at)) as endedAt, count(*) as turns,
        count(distinct ts.session_id) as segments, coalesce(sum(k.n), 0) as compactions
      from turn_session ts join turns t on t.id = ts.turn_id left join compacted k on k.turn_id = ts.turn_id
      where ts.conversation_id in (${marks}) group by ts.conversation_id`,
    )
    .all(...c.params, ...ids) as (Omit<Conversation, "inferred"> & { inferred: number })[];
  return new Map(rows.map((r) => [r.id, { ...r, inferred: !!r.inferred }]));
}

/** A segment or a conversation, located: its turns, its conversation, and its neighbours of the same kind. */
export interface Span {
  id: number;
  chatId: number;
  turnIds: number[];
  conversation: Conversation;
  /** The conversation's segments (their ids), in order. */
  segmentIds: number[];
  /** Each turn's segment, for drawing the gaps inside a conversation. */
  segmentOf: Map<number, number>;
  prev: number | null;
  next: number | null;
}

function locate(db: Db, chatId: number, id: number, level: "session" | "conversation"): Span | null {
  const map = chatGrouping(db, chatId);
  const key = level === "session" ? "sessionId" : "conversationId";
  const mine = map.find((m) => m[key] === id) ?? map.find((m) => m.turnId === id);
  if (!mine) return null;
  const myId = mine[key];
  const ids = [...new Set(map.map((m) => m[key]))];
  const i = ids.indexOf(myId);
  const conv = conversations(db, [mine.conversationId]).get(mine.conversationId)!;
  const inConv = map.filter((m) => m.conversationId === mine.conversationId);
  return {
    id: myId,
    chatId,
    turnIds: map.filter((m) => m[key] === myId).map((m) => m.turnId),
    conversation: conv,
    segmentIds: [...new Set(inConv.map((m) => m.sessionId))],
    segmentOf: new Map(map.map((m) => [m.turnId, m.sessionId])),
    prev: ids[i - 1] ?? null,
    next: ids[i + 1] ?? null,
  };
}

/** The segment named `id`, or holding turn `id`. */
export function segmentOf(db: Db, chatId: number, id: number): Span | null {
  return locate(db, chatId, id, "session");
}

/** The conversation named `id`, or holding turn `id`. */
export function conversationOf(db: Db, chatId: number, id: number): Span | null {
  return locate(db, chatId, id, "conversation");
}

/** A segment as the list shows it. */
export interface SegmentRow {
  id: number;
  chatId: number;
  conversationId: number;
  turns: number;
  /** Turns in it that match the filter (all of them, without one). */
  matching: number;
  startedAt: string;
  endedAt: string;
  failed: number;
  running: number;
  stopped: number;
  costMicroUsd: number;
  triggerKind: string | null;
  triggerPayload: string | null;
  chatKind: ConsoleChat["kind"];
  /** Filled for the segments shown. */
  toolCalls: number;
  refused: number;
  failedCalls: number;
  compactions: number;
}

export interface ChatHead extends ConsoleChat {
  lastEventAt: string | null;
  segments: number;
  turns: number;
  failed: number;
}

export interface SegmentTree {
  groups: { chat: ChatHead; segments: SegmentRow[] }[];
  /** The conversations of the segments shown. */
  conversations: Map<number, Conversation>;
  segments: number;
  turns: number;
}

const isFiltered = (f: TurnFilter) => !!(f.chat !== undefined || f.outcome || f.tool || f.from || f.to || f.q);

/**
 * The list: chats with a segment holding a matching turn (with no filter, every chat), most recently active
 * first, each with its latest `perChat` such segments, newest first. With `f.chat`, that one chat's segments,
 * `perChat` a page, older than `f.before` (a segment id).
 */
export function segmentList(db: Db, f: TurnFilter, perChat: number): SegmentTree {
  // The list asks the grouping four times (heads, rows, step counts, conversations): work it out once.
  db.$client.run("drop table if exists temp.console_turn_session");
  const g = groupingCte(f.chat);
  db.$client.run(`create temp table console_turn_session as with ${g.sql} select * from turn_session`, g.params);
  try {
    return segmentListOf(db, f, perChat, { sql: "turn_session as (select * from temp.console_turn_session)", params: [] });
  } finally {
    db.$client.run("drop table if exists temp.console_turn_session");
  }
}

function segmentListOf(db: Db, f: TurnFilter, perChat: number, c: Grouping): SegmentTree {
  const w = turnWhere({ ...f, before: undefined });
  const before = f.chat !== undefined && f.before !== undefined ? f.before : null;
  const base = `with ${c.sql},
    matching as (select ts.session_id, count(*) as n from turn_session ts join turns t on t.id = ts.turn_id ${w.sql} group by ts.session_id),
    s as (
      select ts.session_id as id, ts.chat_id as chatId, min(ts.conversation_id) as conversationId, count(*) as turns, m.n as matching,
        min(t.started_at) as startedAt, max(coalesce(t.ended_at, t.started_at)) as endedAt,
        sum(t.status = 'failed') as failed, sum(t.status = 'running') as running, sum(t.status = 'stopped') as stopped,
        sum(coalesce(t.cost_micro_usd, 0)) as costMicroUsd
      from turn_session ts join turns t on t.id = ts.turn_id join matching m on m.session_id = ts.session_id
      group by ts.session_id
    )`;
  const params = [...c.params, ...w.params];
  const heads = db.$client
    .query(
      `${base}
      select ${CHAT_COLUMNS},
        (select e.at from chat_events e where e.chat_id = c.id order by e.seq desc limit 1) as lastEventAt,
        coalesce(h.segments, 0) as segments, coalesce(h.turns, 0) as turns, coalesce(h.failed, 0) as failed
      from chats c ${isFiltered(f) ? "join" : "left join"} (select chatId, count(*) as segments, sum(matching) as turns, sum(failed) as failed, max(endedAt) as lastAt from s group by chatId) h on h.chatId = c.id
      ${f.chat !== undefined ? "where c.id = ?" : ""}
      order by coalesce(lastEventAt, h.lastAt, c.created_at) desc, c.id desc`,
    )
    .all(...params, ...(f.chat !== undefined ? [f.chat] : [])) as ChatHead[];
  const rows = db.$client
    .query(
      `${base},
      ranked as (select s.*, row_number() over (partition by chatId order by id desc) as rn from s ${before !== null ? "where id < ?" : ""})
      select ranked.*, c.kind as chatKind,
        (select e.kind from turns ft join chat_events e on e.seq = coalesce(ft.trigger_seq, ft.to_seq) where ft.id = ranked.id) as triggerKind,
        (select e.payload from turns ft join chat_events e on e.seq = coalesce(ft.trigger_seq, ft.to_seq) where ft.id = ranked.id) as triggerPayload
      from ranked join chats c on c.id = ranked.chatId
      where rn <= ? ${f.chat !== undefined ? "and ranked.chatId = ?" : ""}
      order by id desc`,
    )
    .all(...params, ...(before !== null ? [before] : []), perChat, ...(f.chat !== undefined ? [f.chat] : [])) as SegmentRow[];
  if (rows.length) {
    // Step counts for the segments shown only.
    const ids = rows.map((r) => r.id);
    const counts = db.$client
      .query(
        `with ${c.sql}
        select ts.session_id as id, sum(s.kind = 'tool') as toolCalls, sum(s.kind = 'tool' and s.status = 'refused') as refused,
          sum(s.kind = 'tool' and s.status in ('error', 'threw')) as failedCalls, sum(s.kind = 'compaction') as compactions
        from turn_session ts join turn_steps s on s.turn_id = ts.turn_id
        where ts.session_id in (${ids.map(() => "?").join(",")}) group by ts.session_id`,
      )
      .all(...c.params, ...ids) as { id: number; toolCalls: number; refused: number; failedCalls: number; compactions: number }[];
    const byId = new Map(counts.map((x) => [x.id, x]));
    for (const r of rows) {
      const k = byId.get(r.id);
      Object.assign(r, { toolCalls: k?.toolCalls ?? 0, refused: k?.refused ?? 0, failedCalls: k?.failedCalls ?? 0, compactions: k?.compactions ?? 0 });
    }
  }
  const byChat = new Map<number, SegmentRow[]>();
  for (const r of rows) byChat.set(r.chatId, [...(byChat.get(r.chatId) ?? []), r]);
  return {
    groups: heads.map((chat) => ({ chat, segments: byChat.get(chat.id) ?? [] })),
    conversations: conversations(db, [...new Set(rows.map((r) => r.conversationId))], c),
    segments: heads.reduce((n, h) => n + h.segments, 0),
    turns: heads.reduce((n, h) => n + h.turns, 0),
  };
}

/** Which of `turnIds` match the filter (to highlight them in a segment or conversation). */
export function matchingTurns(db: Db, f: TurnFilter, turnIds: number[]): Set<number> {
  if (!turnIds.length) return new Set();
  const w = turnWhere({ ...f, before: undefined, chat: undefined });
  const sql = `select t.id from turns t ${w.sql ? `${w.sql} and` : "where"} t.id in (${turnIds.map(() => "?").join(",")})`;
  return new Set((db.$client.query(sql).all(...w.params, ...turnIds) as { id: number }[]).map((r) => r.id));
}
