import { raiseAlert } from "../store/control.ts";
import type { Db } from "../store/db.ts";
import { getChat, pendingOutbound } from "../store/events.ts";
import { chatLabel, finishTurn, markDrainStop, runningTurns } from "../store/turns.ts";
import { stopTurn } from "./commands.ts";
import { isAlive, signalTurn, type SignalTurn } from "./spawn.ts";
import { KILL_GRACE_MS } from "./waker.ts";

/**
 * DRAINING SHUTDOWN: what the server does on SIGTERM (docs/design.md §16).
 *
 * In a container, stopping the server stops everything in it: a runner child cannot outlive the server the
 * way it does under systemd with `KillMode=process`. So invariant 3 (thinking is not interrupted by the body
 * restarting) is kept by waiting instead: the server stops taking work in, lets what runs finish, and only
 * then exits. main.ts does the first part; this module is the wait.
 *
 *   1. main.ts: the Telegram poller stops (an update it does not fetch stays with Telegram, which hands it to
 *      the next server: the offset is ours and only moves with what was recorded, poller.ts), and the waker
 *      starts no new turn (`wakerPass({ wake: false })`: it still reaps dead turns and enforces the
 *      wall-clock limit). The sender, the control bot and the other loops keep running.
 *   2. Wait until no turn runs and nothing is waiting to be sent, up to the deadline (`SHUVI_DRAIN_SEC`,
 *      default 600). Once the last turn has ended, its queued messages get at most `FLUSH_MS` more: a row
 *      Telegram keeps refusing for now (a 429, an outage) is left for the next server, not waited on.
 *   3. At the deadline, every turn still running is stopped the way a model switch stops one
 *      (server/commands.ts `stopTurn`): the stop is placed at the turn's START (`stop_seq` = `from_seq`),
 *      so when it closes as `stopped` the cursor does not move and the next server answers the same messages
 *      again. The row is marked first (store/turns.ts `DRAIN_STOP`), so whoever closes it records why, and the
 *      next turn on the same input tells the model it is a retry (agent/turn.ts `retryNote`). The child gets
 *      SIGTERM, which it treats as a stop and closes its turn itself; one still there after `graceMs`
 *      (`SHUVI_DRAIN_GRACE_SEC`, default 15) gets SIGKILL and is closed as `stopped` here, or by the waker's
 *      reap if that sees it dead first. The owner is told, in the control bot.
 *   4. Return; main.ts stops the remaining loops and exits 0.
 *
 * What it keeps:
 *   - nothing perceived is lost: what arrives during the drain is not fetched, so Telegram still holds it;
 *     schedules, jobs and inbound hooks keep writing to the store, which the next server reads;
 *   - nothing said is lost or said twice: delivery is the sender's, with its idempotency keys, and a row
 *     still pending at exit is sent by the next server. A turn stopped at the deadline may have said part of
 *     its answer already. Its retry resumes the SAME conversation, which holds the stopped turn's input and
 *     whatever it said, and is given the same messages again under a note saying the previous turn on them
 *     was cut off by a restart (render.ts `RETRY_NOTE`), so the model can answer once without repeating what
 *     it already sent. (A switch differs: the target conversation never held the stopped turn's part.)
 *   - a chat is still ordered: the stopped turn is closed before this returns, so the next server finds no
 *     turn running there.
 *
 * Holds no state of its own: every answer is in the store. But it assumes it is the ONLY server on this
 * store until it exits: liveness is a pid and its /proc start time (spawn.ts), which mean nothing across
 * containers, so a second server started on the same data dir while this one drains would take its running
 * turns for dead, reap them and start them again beside the originals (breaking invariants 2 and 4). The old
 * container must have stopped before the new one starts; never two servers on one SHUVI_DATA_DIR.
 */

/** After the last turn ended, how long its queued messages may still take to go out. */
export const FLUSH_MS = 30_000;

export interface DrainDeps {
  db: Db;
  /** The deadline, from the start of the drain (`SHUVI_DRAIN_SEC`). */
  drainMs: number;
  /** After the SIGTERM at the deadline, how long a turn has to close itself before SIGKILL. */
  graceMs?: number;
  flushMs?: number;
  /** How often the store is looked at. */
  pollMs?: number;
  signal?: SignalTurn;
  alive?: (pid: number, start: string | null) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface DrainResult {
  /** `idle`: everything ended before the deadline; `deadline`: turns were stopped. */
  outcome: "idle" | "deadline";
  /** Turns stopped at the deadline. */
  stopped: number[];
  /** Of those, the ones that had to be killed. */
  killed: number[];
  /** Outbound rows left for the next server. */
  pendingLeft: number;
}

export async function drain(deps: DrainDeps): Promise<DrainResult> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const signal = deps.signal ?? signalTurn;
  const alive = deps.alive ?? isAlive;
  const pollMs = deps.pollMs ?? 250;
  const flushMs = deps.flushMs ?? FLUSH_MS;
  const graceMs = deps.graceMs ?? KILL_GRACE_MS;
  const log = deps.log ?? ((l: string) => console.log(l));
  const deadline = now() + deps.drainMs;

  // When the last turn was seen ending, for the flush window. Null while one runs.
  let quietSince: number | null = null;
  const settled = (): boolean => {
    if (runningTurns(db).length) {
      quietSince = null;
      return false;
    }
    quietSince ??= now();
    return pendingOutbound(db).length === 0 || now() - quietSince >= flushMs;
  };

  let reported = -1;
  while (now() < deadline) {
    if (settled()) return { outcome: "idle", stopped: [], killed: [], pendingLeft: pendingOutbound(db).length };
    const n = runningTurns(db).length;
    if (n !== reported) {
      log(`drain: waiting for ${n} turn(s), ${Math.max(0, Math.round((deadline - now()) / 1000))} s left`);
      reported = n;
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }

  // The deadline: stop what still runs, so it closes cleanly and is answered again by the next server.
  const late = runningTurns(db);
  const stopped: number[] = [];
  for (const t of late) {
    markDrainStop(db, t.id);
    stopTurn(db, t.chatId, t.fromSeq, signal);
    stopped.push(t.id);
    const chat = getChat(db, t.chatId);
    raiseAlert(db, {
      key: `drain-stop:${t.id}`,
      turnId: t.id,
      text: `Shutting down: turn ${t.id} in ${chat ? chatLabel(chat) : `chat ${t.chatId}`} was still running at the drain deadline and was stopped. Its messages will be answered again after the restart.`,
    });
  }
  if (stopped.length) log(`drain: deadline reached; stopped turn(s) ${stopped.join(", ")}`);

  const graceEnd = now() + graceMs;
  quietSince = null;
  while (now() < graceEnd && !settled()) await sleep(Math.min(pollMs, Math.max(1, graceEnd - now())));

  // Whatever is still running did not close itself: kill it and close it here, as stopped.
  const killed: number[] = [];
  for (const t of runningTurns(db)) {
    if (t.pid != null && alive(t.pid, t.pidStart)) {
      signal(t.pid, t.pidStart, "SIGKILL");
      for (let i = 0; i < 20 && alive(t.pid, t.pidStart); i++) await sleep(50);
    }
    // `stop_seq` was placed at its start above (or by an earlier /stop, which then wins), so this keeps
    // the cursor where that stop put it.
    finishTurn(db, t.id, { status: "stopped" });
    killed.push(t.id);
  }
  if (killed.length) log(`drain: killed turn(s) ${killed.join(", ")} after the grace`);
  return { outcome: "deadline", stopped, killed, pendingLeft: pendingOutbound(db).length };
}
