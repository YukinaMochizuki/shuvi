import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./db.ts";
import { recordFrameworkEvent, type JobDonePayload } from "./events.ts";
import { jobs } from "./schema.ts";
import { IMMEDIATE } from "./turns.ts";

/**
 * Jobs (docs/design.md §10): work whose result comes later. The rules this module keeps:
 *
 *   - A job remembers where it came from: the chat and the event (`origin_seq`) it was started for. Its
 *     result goes back to THAT chat and nowhere else; nothing outside the row decides where (the previous
 *     assistant's hand-kept table of request origins is what this replaces).
 *   - A job ends ONCE. `finishJob` moves a `running` row to done / failed / expired and writes the
 *     `job_done` event in the same transaction, the event keyed `job:<id>`. A second report (a callback
 *     retried, a poll racing a callback, the deadline racing either) finds the row no longer running and
 *     writes nothing; were the row ever reopened, the key would still drop a second event.
 *   - A callback job's token is returned once, at creation, and only its sha256 is stored. Checking one
 *     compares the hashes in constant time.
 *   - Deadlines are the watcher's (capabilities/jobs/watch.ts): past it, the job is polled once if its
 *     kind can be polled; still nothing, it is `expired`, and that is written back to the origin too, so
 *     nothing vanishes silently.
 *
 * The `job_done` event is an ordinary trigger past the chat's cursor, so the turn that reads it is claimed
 * by the same exactly-once rule as a message (store/turns.ts).
 */

export type Job = typeof jobs.$inferSelect;
export type JobState = Job["state"];
export type JobReport = Job["report"];

/** A result longer than this is cut (the full text is for the job's own logs, not the chat). */
export const MAX_RESULT_CHARS = 20_000;

/** What polling a job found. */
export type JobPoll = { state: "running"; note?: string } | { state: "done" | "failed"; result: string };

/**
 * A kind of job a capability owns (capabilities/types.ts `jobKinds`). `poll` asks the outside world how
 * the job stands; a kind without one is reported to (callback) or exits.
 */
export interface JobKind {
  kind: string;
  /** How often a `poll` job of this kind is polled. */
  pollEveryMs?: number;
  /** How long one poll may take before it counts as failed (default: the watcher's). */
  pollTimeoutMs?: number;
  poll?(job: Job, signal: AbortSignal): Promise<JobPoll>;
}

export interface NewJob {
  chatId: number;
  originSeq: number;
  kind: string;
  title: string;
  report: JobReport;
  spec?: Record<string, unknown>;
  deadline: Date;
  /** poll: when to poll first (default: now). */
  firstPollAt?: Date;
  /** Started by a call the owner authorised (an owner-only tool): see schema.ts `jobs.ownerAuthorised`. */
  ownerAuthorised?: boolean;
}

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Create a running job. A `callback` job gets a fresh token, returned here once and never again. */
export function createJob(db: Db, j: NewJob): { job: Job; token?: string } {
  const token = j.report === "callback" ? randomBytes(24).toString("base64url") : undefined;
  const job = db
    .insert(jobs)
    .values({
      chatId: j.chatId,
      originSeq: j.originSeq,
      kind: j.kind,
      title: j.title,
      report: j.report,
      spec: j.spec ?? {},
      tokenHash: token ? hashToken(token) : null,
      deadline: j.deadline.toISOString(),
      nextPollAt: j.report === "poll" ? (j.firstPollAt ?? new Date()).toISOString() : null,
      ownerAuthorised: j.ownerAuthorised ?? false,
    })
    .returning()
    .get();
  return { job, ...(token ? { token } : {}) };
}

export function getJob(db: Db, id: number): Job | undefined {
  return db.select().from(jobs).where(eq(jobs.id, id)).get();
}

export function runningJobs(db: Db): Job[] {
  return db.select().from(jobs).where(eq(jobs.state, "running")).orderBy(asc(jobs.id)).all();
}

/** Does `token` belong to this callback job? Constant time in the token. */
export function checkJobToken(job: Job, token: string): boolean {
  if (!job.tokenHash) return false;
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(job.tokenHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Record when to poll next, and why the last poll failed if it did. */
export function setNextPoll(db: Db, id: number, at: Date, note: string | null = null): void {
  db.update(jobs).set({ nextPollAt: at.toISOString(), note }).where(eq(jobs.id, id)).run();
}

/**
 * End a job and write its `job_done` event into the origin chat, in one transaction. Returns the event's
 * seq, or null when the job was not running (already ended: nothing is written).
 */
export function finishJob(db: Db, id: number, outcome: { state: "done" | "failed" | "expired"; result: string }): number | null {
  const result = outcome.result.length > MAX_RESULT_CHARS ? `${outcome.result.slice(0, MAX_RESULT_CHARS)}\n…(cut at ${MAX_RESULT_CHARS} characters)` : outcome.result;
  return db.transaction((tx) => {
    const tdb = tx as unknown as Db;
    const closed = tx
      .update(jobs)
      .set({ state: outcome.state, result, endedAt: new Date().toISOString(), nextPollAt: null })
      .where(and(eq(jobs.id, id), eq(jobs.state, "running")))
      .returning()
      .get();
    if (!closed) return null;
    const payload: JobDonePayload = { jobId: closed.id, kind: closed.kind, title: closed.title, state: outcome.state, result };
    return recordFrameworkEvent(tdb, { chatId: closed.chatId, kind: "job_done", payload, idemKey: `job:${closed.id}` });
  }, IMMEDIATE);
}
