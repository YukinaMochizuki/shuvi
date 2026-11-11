import { formatTime, FRAMEWORK_MARK, renderMessage } from "../../agent/render.ts";
import type { Db } from "../../store/db.ts";
import type { Chat, ChatEvent, MessagePayload } from "../../store/events.ts";

/**
 * Searching and paging the chat logs (`chat_events`), the way workstream's code-search and transcript
 * tools work: several OR-combined terms, every hit with its seq, and a per-chat distribution instead of a
 * flood when there are too many. Full-text search runs on the `chat_events_fts` table (FTS5, trigram:
 * drizzle/0002_chat_events_fts.sql), which holds people's messages and the assistant's delivered ones.
 *
 * These functions take the chats the caller may see and never look outside them; deciding which those
 * are is ../access.ts's job.
 */

/** What reads as "said": a person's message, or the assistant's once it reached Telegram. */
const SAID = `(e.kind = 'message' OR (e.kind = 'bot_message' AND e.status = 'sent'))`;

type Row = { seq: number; chat_id: number; kind: string; payload: string; at: string; tg_message_id: number | null; status: string | null };

function toEvent(r: Row): ChatEvent {
  return { seq: r.seq, chatId: r.chat_id, kind: r.kind as ChatEvent["kind"], payload: JSON.parse(r.payload), at: r.at, tgMessageId: r.tg_message_id, status: r.status as ChatEvent["status"], tgUpdateId: null, idemKey: null, note: null, turnId: null };
}

// ---- time --------------------------------------------------------------------------------------------

/** Milliseconds `timeZone` is ahead of UTC at instant `t`. */
function zoneOffset(t: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t));
  const g = (k: string) => Number(parts.find((p) => p.type === k)!.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(t / 1000) * 1000;
}

/**
 * A `since` / `until` bound as an ISO instant, comparable with `chat_events.at`. A bare date is a day in
 * the owner's time zone: `since` its start, `until` its end (so `until: "2026-11-10"` includes that day).
 * A date-time without a zone is read in that time zone too.
 */
export function parseBound(s: string, timeZone: string, edge: "start" | "end"): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s.trim());
  if (m) {
    const [, y, mo, d, h, mi, se] = m;
    let wall = Date.UTC(+y!, +mo! - 1, +d!, +(h ?? 0), +(mi ?? 0), +(se ?? 0));
    if (h === undefined && edge === "end") wall += 86_400_000;
    // The offset at the wall time itself is a guess; the offset at that guess is right except within an
    // hour of a DST change, which is close enough for a search bound.
    return new Date(wall - zoneOffset(wall - zoneOffset(wall, timeZone), timeZone)).toISOString();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// ---- search ------------------------------------------------------------------------------------------

export interface SearchQuery {
  terms: string[];
  chats: Chat[];
  /** A name (substring, any case), a Telegram user id, or "you" for the assistant's own messages. */
  sender?: string;
  since?: string;
  until?: string;
  limit: number;
}

export type SearchResult =
  | { mode: "hits"; total: number; hits: ChatEvent[] }
  | { mode: "counts"; total: number; perChat: { chatId: number; hits: number; first: string; last: string }[] };

/** Trigram FTS needs three characters; a shorter term is a substring scan of the same table. */
function termCondition(term: string): { sql: string; param: string } {
  if ([...term].length >= 3) return { sql: `f.rowid IN (SELECT rowid FROM chat_events_fts WHERE chat_events_fts MATCH ?)`, param: `"${term.replaceAll('"', '""')}"` };
  return { sql: `f.text LIKE ? ESCAPE '\\'`, param: `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%` };
}

export function searchChats(db: Db, q: SearchQuery): SearchResult {
  const terms = q.terms.map((t) => t.trim()).filter(Boolean);
  if (!terms.length || !q.chats.length) return { mode: "hits", total: 0, hits: [] };
  const conds = terms.map(termCondition);
  const where = [`(${conds.map((c) => c.sql).join(" OR ")})`, `e.chat_id IN (${q.chats.map(() => "?").join(",")})`];
  const params: (string | number)[] = [...conds.map((c) => c.param), ...q.chats.map((c) => c.id)];
  if (q.since) (where.push("e.at >= ?"), params.push(q.since));
  if (q.until) (where.push("e.at < ?"), params.push(q.until));
  if (q.sender !== undefined) {
    const s = q.sender.trim();
    if (s.toLowerCase() === "you") where.push("e.kind = 'bot_message'");
    else if (/^-?\d+$/.test(s)) (where.push("e.kind = 'message' AND json_extract(e.payload, '$.from.id') = ?"), params.push(Number(s)));
    else (where.push("e.kind = 'message' AND lower(json_extract(e.payload, '$.from.name')) LIKE ?"), params.push(`%${s.toLowerCase()}%`));
  }
  const matched = db.$client
    .query(`SELECT e.seq, e.chat_id, e.at FROM chat_events_fts f JOIN chat_events e ON e.seq = f.rowid WHERE ${SAID} AND ${where.join(" AND ")} ORDER BY e.seq DESC`)
    .all(...params) as { seq: number; chat_id: number; at: string }[];

  const byChat = new Map<number, { chatId: number; hits: number; first: string; last: string }>();
  for (const r of matched) {
    const c = byChat.get(r.chat_id) ?? { chatId: r.chat_id, hits: 0, first: r.at, last: r.at };
    c.hits++;
    c.first = r.at; // rows come newest first
    byChat.set(r.chat_id, c);
  }
  if (matched.length > q.limit && byChat.size > 1) return { mode: "counts", total: matched.length, perChat: [...byChat.values()].sort((a, b) => b.hits - a.hits) };
  const seqs = matched.slice(0, q.limit).map((r) => r.seq);
  const hits = seqs.length ? (db.$client.query(`SELECT * FROM chat_events WHERE seq IN (${seqs.map(() => "?").join(",")}) ORDER BY seq ASC`).all(...seqs) as Row[]).map(toEvent) : [];
  return { mode: "hits", total: matched.length, hits };
}

/** The part of `text` around the first term it contains, on one line. */
export function snippet(text: string, terms: string[], width = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= width) return flat;
  const lower = flat.toLowerCase();
  const at = Math.min(...terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0), flat.length);
  const start = Math.max(0, Math.min(at - Math.floor(width / 3), flat.length - width));
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + width)}${start + width < flat.length ? "…" : ""}`;
}

/**
 * One hit, led like a message line: `[#seq · time · sender] snippet`. As in agent/render.ts, the
 * assistant's own lines are `⚙ you`, and the mark is stripped from what people wrote, so nobody can pass
 * for her (or for the framework) by name.
 */
export function renderHit(e: ChatEvent, terms: string[], timeZone: string): string {
  const plain = (s: string) => s.replaceAll(FRAMEWORK_MARK, "");
  const who = e.kind === "bot_message" ? `${FRAMEWORK_MARK} you` : plain((e.payload as unknown as MessagePayload).from.name).replace(/[\r\n]+/g, " ").trim() || "?";
  return `[#${e.seq} · ${formatTime(e.at, timeZone)} · ${who}] ${plain(snippet(String((e.payload as { text?: string }).text ?? ""), terms))}`;
}

// ---- paging ------------------------------------------------------------------------------------------

export type Anchor = { around: number } | { before: number } | { after: number } | null;

export interface Page {
  events: ChatEvent[];
  /** Whether the chat has more before the first / after the last event of the page. */
  more: { before: boolean; after: boolean };
}

function said(db: Db, chatId: number, cond: string, order: "ASC" | "DESC", limit: number, ...params: number[]): ChatEvent[] {
  return (db.$client.query(`SELECT * FROM chat_events e WHERE e.chat_id = ? AND ${SAID} AND ${cond} ORDER BY e.seq ${order} LIMIT ?`).all(chatId, ...params, limit) as Row[]).map(toEvent);
}

/** A page of a chat's log, oldest first, by seq. No anchor: the newest `limit`. */
export function readChat(db: Db, chatId: number, anchor: Anchor, limit: number): Page {
  let events: ChatEvent[];
  if (!anchor) events = said(db, chatId, "1", "DESC", limit).reverse();
  else if ("before" in anchor) events = said(db, chatId, "e.seq < ?", "DESC", limit, anchor.before).reverse();
  else if ("after" in anchor) events = said(db, chatId, "e.seq > ?", "ASC", limit, anchor.after);
  else {
    const older = said(db, chatId, "e.seq <= ?", "DESC", Math.ceil(limit / 2), anchor.around).reverse();
    const newer = said(db, chatId, "e.seq > ?", "ASC", limit - older.length, anchor.around);
    events = [...older, ...newer];
  }
  const first = events[0]?.seq;
  const last = events.at(-1)?.seq;
  return {
    events,
    more: {
      before: first !== undefined && said(db, chatId, "e.seq < ?", "DESC", 1, first).length > 0,
      after: last !== undefined && said(db, chatId, "e.seq > ?", "ASC", 1, last).length > 0,
    },
  };
}

export function renderPage(page: Page, timeZone: string): string {
  return page.events.map((e) => renderMessage(e, timeZone)).join("\n");
}
