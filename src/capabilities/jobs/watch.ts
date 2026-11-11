import type { Db } from "../../store/db.ts";
import { getChat } from "../../store/events.ts";
import { finishJob, runningJobs, setNextPoll, type Job, type JobKind, type JobPoll } from "../../store/jobs.ts";
import { raiseAlert } from "../../store/control.ts";

/**
 * The job watcher (docs/design.md §2, §10): one pass over the running jobs.
 *
 *   - A `poll` job whose next poll is due is polled through its kind (a capability's `jobKinds`). A result
 *     ends it (store/jobs.ts `finishJob`, which writes the one `job_done`); "still running" sets the next
 *     poll; a poll that throws is noted on the row and retried at the next interval.
 *   - A job past its deadline, of any report kind, is polled ONCE if its kind can be polled. Still no
 *     result, it ends as `expired`: that is written back to the origin chat like a result, so nothing
 *     vanishes silently, and the owner is told (an expired job is an alert, design §13).
 *   - A job whose kind no enabled capability owns (its capability was turned off) is left until its
 *     deadline and then expires the same way.
 *
 * Polls run CONCURRENTLY, each under its own timeout (`JobKind.pollTimeoutMs`, default
 * `DEFAULT_POLL_TIMEOUT_MS`): one hung remote holds up neither the other jobs' polls nor their deadlines,
 * and a poll that times out counts as a failed poll.
 *
 * It holds no state: everything is on the rows, so a restarted server carries on where it was.
 */

export const DEFAULT_POLL_EVERY_MS = 15_000;
export const DEFAULT_POLL_TIMEOUT_MS = 30_000;

export interface WatchDeps {
  db: Db;
  kinds: readonly JobKind[];
  now?: () => number;
  signal?: AbortSignal;
}

/** Poll one job, bounded by its kind's timeout whether or not `poll` honours the signal. Never throws. */
async function pollJob(kind: JobKind, job: Job, signal: AbortSignal, db: Db): Promise<JobPoll | { error: string }> {
  const ms = kind.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const timeout = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<{ error: string }>((resolve) => {
    timer = setTimeout(() => {
      timeout.abort();
      resolve({ error: `no answer within ${ms / 1000}s` });
    }, ms);
  });
  try {
    return await Promise.race([kind.poll!(job, AbortSignal.any([signal, timeout.signal]), db), timedOut]);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export async function jobWatchPass(deps: WatchDeps): Promise<{ finished: number[]; expired: number[] }> {
  const now = deps.now ?? Date.now;
  const signal = deps.signal ?? new AbortController().signal;
  const finished: number[] = [];
  const expired: number[] = [];
  const t = now();
  const due = runningJobs(deps.db).flatMap((job) => {
    const kind = deps.kinds.find((k) => k.kind === job.kind);
    const past = t >= Date.parse(job.deadline);
    const pollDue = job.report === "poll" && !!kind?.poll && job.nextPollAt != null && Date.parse(job.nextPollAt) <= t;
    return past || pollDue ? [{ job, kind, past }] : [];
  });
  // Every due job at once, each settled as soon as ITS poll returns (the store writes are synchronous, so
  // they do not interleave): a slow poll delays nobody else's result or deadline.
  await Promise.all(
    due.map(async ({ job, kind, past }) => {
      let note: string | null = null;
      if (kind?.poll) {
        if (signal.aborted) return; // shutting down: not polled, nothing decided
        const r = await pollJob(kind, job, signal, deps.db);
        if ("error" in r) note = `poll failed: ${r.error}`;
        else if (r.state !== "running") {
          if (finishJob(deps.db, job.id, { state: r.state, result: r.result }) != null) finished.push(job.id);
          return;
        } else note = r.note ?? null;
      }
      if (past) {
        const why = `No result by the deadline (${job.deadline}).${note ? ` Last check: ${note}` : job.note ? ` Last check: ${job.note}` : ""}`;
        if (finishJob(deps.db, job.id, { state: "expired", result: why }) != null) {
          expired.push(job.id);
          const chat = getChat(deps.db, job.chatId);
          raiseAlert(deps.db, { key: `job-expired:${job.id}`, text: `Job ${job.id} (${job.kind}) expired with no result: "${job.title}" (chat ${chat?.title ?? chat?.tgChatId ?? job.chatId}). ${why}` });
        }
        return;
      }
      setNextPoll(deps.db, job.id, new Date(now() + (kind?.pollEveryMs ?? DEFAULT_POLL_EVERY_MS)), note);
    }),
  );
  return { finished, expired };
}
