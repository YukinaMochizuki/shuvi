import { Cron } from "croner";
import { and, asc, eq, lte } from "drizzle-orm";
import type { Db } from "./db.ts";
import { recordFrameworkEvent, type ScheduledPayload } from "./events.ts";
import { schedules } from "./schema.ts";
import { IMMEDIATE } from "./turns.ts";

/**
 * Schedules (docs/design.md §10): a wake-up with a stated purpose, set in a chat. When one comes due,
 * `fireDue` writes a `scheduled` event carrying its note into the chat it was set in, and the waker
 * starts a turn there like for a message (store/turns.ts).
 *
 * Exactly once, and once after downtime:
 *   - firing writes the event and moves the schedule on in ONE transaction, the event keyed
 *     `schedule:<id>:<due>`, so a pass that dies half-way writes nothing and a pass that repeats writes
 *     nothing twice;
 *   - a cron schedule moves on to its next run after NOW, not after the time it was due: a server that was
 *     down through five occurrences fires it once when it comes back, not five times. A one-shot past due
 *     fires once and is done.
 *
 * Cron expressions are croner's (the library workstream uses), read in the schedule's time zone, which is
 * `SHUVI_TZ` when it is set. Only the five-field form (minute hour day month weekday) or a nickname
 * (`@daily` …) is accepted: croner also takes a seconds field, and a schedule that wakes a turn every few
 * seconds is a runaway, not a reminder. Two runs are never less than `MIN_CRON_INTERVAL_MS` apart.
 */

export const MIN_CRON_INTERVAL_MS = 60_000;
const NICKNAMES = new Set(["@yearly", "@annually", "@monthly", "@weekly", "@daily", "@midnight", "@hourly"]);

/** Check a cron expression for a schedule; throws with the reason when it is not one shuvi takes. */
export function validateCron(cron: string, timeZone: string, now: Date): void {
  const c = cron.trim();
  if (c.startsWith("@")) {
    if (!NICKNAMES.has(c.toLowerCase())) throw new Error(`"${cron}" is not a cron nickname (${[...NICKNAMES].join(", ")})`);
  } else {
    const fields = c.split(/\s+/).length;
    if (fields !== 5) throw new Error(`"${cron}" is not a five-field cron expression (minute hour day month weekday)${fields > 5 ? "; a seconds field is not allowed" : ""}`);
  }
  let prev: Date | null;
  try {
    prev = nextCronRun(c, timeZone, now);
  } catch (e) {
    throw new Error(`"${cron}" is not a cron expression croner accepts: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!prev) throw new Error(`"${cron}" never runs after now`);
  for (let i = 0; i < 3; i++) {
    const next = nextCronRun(c, timeZone, prev);
    if (!next) break;
    if (next.getTime() - prev.getTime() < MIN_CRON_INTERVAL_MS) throw new Error(`"${cron}" runs more often than once a minute`);
    prev = next;
  }
}

export type Schedule = typeof schedules.$inferSelect;

/** The next run of `cron` in `timeZone` strictly after `after`, or null if there is none. Throws if invalid. */
export function nextCronRun(cron: string, timeZone: string, after: Date): Date | null {
  const c = new Cron(cron, { timezone: timeZone, paused: true });
  try {
    return c.nextRun(after);
  } finally {
    c.stop();
  }
}

/**
 * The instant a one-shot `at` names. Accepts a relative offset (`+90m`, `+2h`, `+1d`, `+1h30m`, `+30s`), or a date
 * and time (`2026-11-12T08:00`, `2026-11-12 08:00`, with or without seconds), read in `timeZone` unless it
 * carries its own offset (`Z`, `+08:00`). Throws on anything else.
 */
export function parseAt(at: string, timeZone: string, now: Date): Date {
  const s = at.trim();
  const rel = /^\+\s*(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+)\s*s)?$/i.exec(s);
  if (rel && (rel[1] || rel[2] || rel[3] || rel[4])) {
    const ms = ((Number(rel[1] ?? 0) * 24 * 60 + Number(rel[2] ?? 0) * 60 + Number(rel[3] ?? 0)) * 60 + Number(rel[4] ?? 0)) * 1000;
    return new Date(now.getTime() + ms);
  }
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (!m) throw new Error(`"${at}" is not a time: use "+30m" / "+2h" / "+1d", or "YYYY-MM-DD HH:MM" (${timeZone})`);
  if (m[5]) {
    const d = new Date(`${m[1]}T${m[2]}${m[3] ?? ":00"}${m[5].toUpperCase() === "Z" ? "Z" : m[5]}`);
    if (Number.isNaN(d.getTime())) throw new Error(`"${at}" is not a valid time`);
    return d;
  }
  // A wall-clock time in `timeZone`: croner's ISO one-shot reads it there.
  const c = new Cron(`${m[1]}T${m[2]}${m[3] ?? ":00"}`, { timezone: timeZone, paused: true });
  try {
    // nextRun() is null for a time already past; find the instant anyway by asking from far back.
    const d = c.nextRun(new Date(0));
    if (!d) throw new Error(`"${at}" is not a valid time`);
    return d;
  } finally {
    c.stop();
  }
}

export interface NewSchedule {
  chatId: number;
  note: string;
  at?: Date;
  cron?: string;
  timeZone: string;
  turnId?: number;
  /** Set by a call the owner authorised (the `schedule` tool is owner-only): schema.ts. */
  ownerAuthorised?: boolean;
}

/** Set a schedule. Exactly one of `at` (in the future) and `cron` (with a next run). Throws otherwise. */
export function createSchedule(db: Db, s: NewSchedule, now = new Date()): Schedule {
  if (!!s.at === !!s.cron) throw new Error("give exactly one of `at` and `cron`");
  let nextAt: Date | null;
  if (s.at) {
    if (s.at.getTime() <= now.getTime()) throw new Error(`${s.at.toISOString()} is in the past`);
    nextAt = s.at;
  } else {
    validateCron(s.cron!, s.timeZone, now);
    nextAt = nextCronRun(s.cron!.trim(), s.timeZone, now)!;
  }
  return db
    .insert(schedules)
    .values({
      chatId: s.chatId,
      note: s.note,
      at: s.at ? s.at.toISOString() : null,
      cron: s.cron?.trim() ?? null,
      timeZone: s.timeZone,
      nextAt: nextAt.toISOString(),
      createdTurnId: s.turnId ?? null,
      ownerAuthorised: s.ownerAuthorised ?? false,
    })
    .returning()
    .get();
}

export function getSchedule(db: Db, id: number): Schedule | undefined {
  return db.select().from(schedules).where(eq(schedules.id, id)).get();
}

/** The active schedules of a chat, soonest first. */
export function activeSchedules(db: Db, chatId: number): Schedule[] {
  return db
    .select()
    .from(schedules)
    .where(and(eq(schedules.chatId, chatId), eq(schedules.state, "active")))
    .orderBy(asc(schedules.nextAt))
    .all();
}

/** Cancel an active schedule of this chat. False when there is no such schedule here. */
export function cancelSchedule(db: Db, id: number, chatId: number): boolean {
  const rows = db
    .update(schedules)
    .set({ state: "cancelled", nextAt: null })
    .where(and(eq(schedules.id, id), eq(schedules.chatId, chatId), eq(schedules.state, "active")))
    .returning({ id: schedules.id })
    .all();
  return rows.length > 0;
}

/** A cron schedule that fired for the last time because its expression no longer parses. */
export interface StoppedSchedule {
  id: number;
  cron: string;
  error: string;
}

/**
 * Fire every schedule due at `now`: one `scheduled` event each, and move it on (see the header). Returns
 * the ids that fired, and the cron schedules that stopped because their expression no longer parses (a
 * croner upgrade, a time zone gone): they fire this once and are done, and the caller tells the owner.
 */
export function fireDue(db: Db, now = new Date()): { fired: number[]; stopped: StoppedSchedule[] } {
  const iso = now.toISOString();
  const due = db
    .select()
    .from(schedules)
    .where(and(eq(schedules.state, "active"), lte(schedules.nextAt, iso)))
    .orderBy(asc(schedules.nextAt))
    .all();
  const fired: number[] = [];
  const stopped: StoppedSchedule[] = [];
  for (const d of due) {
    let broken: string | null = null;
    const ok = db.transaction((tx) => {
      broken = null;
      const tdb = tx as unknown as Db;
      // Re-read inside the write lock: another pass (or a cancel) may have got here first.
      const s = tx.select().from(schedules).where(eq(schedules.id, d.id)).get();
      if (!s || s.state !== "active" || !s.nextAt || s.nextAt > iso) return false;
      let next: Date | null = null;
      if (s.cron) {
        try {
          next = nextCronRun(s.cron, s.timeZone, now);
        } catch (e) {
          next = null;
          broken = e instanceof Error ? e.message : String(e);
        }
      }
      const payload: ScheduledPayload = { scheduleId: s.id, note: s.note, dueAt: s.nextAt, ...(s.cron ? { cron: s.cron } : {}) };
      recordFrameworkEvent(tdb, { chatId: s.chatId, kind: "scheduled", payload, idemKey: `schedule:${s.id}:${s.nextAt}` });
      tx.update(schedules)
        .set(next ? { nextAt: next.toISOString(), lastFiredAt: iso } : { state: "done", nextAt: null, lastFiredAt: iso })
        .where(eq(schedules.id, s.id))
        .run();
      return true;
    }, IMMEDIATE);
    if (ok) fired.push(d.id);
    if (ok && broken !== null) stopped.push({ id: d.id, cron: d.cron ?? "", error: broken });
  }
  return { fired, stopped };
}
