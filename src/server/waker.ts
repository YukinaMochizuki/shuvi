import { capabilityHolds, type EnabledCapability } from "../capabilities/types.ts";
import type { Db } from "../store/db.ts";
import { raiseAlert } from "../store/control.ts";
import { allChats, getChat, lastTriggerSeq, triggersAfter } from "../store/events.ts";
import { chatLabel, claimTurn, finishTurn, IMMEDIATE, markTerm, retryDelayMs, runningTurns, setTurnPid } from "../store/turns.ts";
import { isAlive, processStart, signalTurn, type SignalTurn, type SpawnTurn } from "./spawn.ts";

/**
 * The waker decides WHEN to think, and nothing about how. One pass:
 *
 *   1. Reap: a `running` turn whose process is gone died without closing itself (a crash, an OOM kill).
 *      Close it as failed; the cursor rule (store/turns.ts) then has the next pass retry its input.
 *      A turn that never got a pid (the spawn itself failed) is reaped after `SPAWN_GRACE_MS`. "Gone"
 *      means the pid no longer runs the process started for the turn (spawn.ts: pid + start time).
 *   2. Limit: a turn running longer than its wall-clock limit (`SHUVI_TURN_MAX_MINUTES`, default 15) is
 *      sent SIGTERM, which the child treats as a stop, and SIGKILL `KILL_GRACE_MS` later if it is still
 *      there. Either way it closes as `stopped`, not `failed`: its input counts as handled, so a message
 *      that makes every turn hang is not retried into another hang. `term_at` and the owner's alert are
 *      committed together before the SIGTERM, which is repeated on each pass during the grace, so the
 *      limit survives a server restart at any point. The closed turn's error names the limit
 *      (store/turns.ts `WALL_CLOCK_STOP`), which tells it apart from an owner /stop.
 *   3. Wake: for each chat with inbound events past its cursor and no running turn, claim a turn (the
 *      unique index makes the claim the lock) and start a child for it. A chat whose last turns failed
 *      waits out its backoff first (store/turns.ts `retryDelayMs`). A chat with a message a capability
 *      still holds (a picture still downloading: PERCEPTION GATING, `Capability.holds`) waits too; a hold
 *      lasts a few seconds at most, then the turn opens anyway.
 *
 * It holds no state between passes: every answer is in the store, so a restarted server picks up exactly
 * where the last one was, including turns that are still running in children it did not start.
 */

export const SPAWN_GRACE_MS = 30_000;
export const DEFAULT_TURN_MAX_MS = 15 * 60_000;
/** How long a turn sent SIGTERM for the wall-clock limit has to close itself before SIGKILL. */
export const KILL_GRACE_MS = 15_000;

const limitText = (ms: number) => (ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`);

export interface WakerDeps {
  db: Db;
  spawn: SpawnTurn;
  alive?: (pid: number, start: string | null) => boolean;
  /** The start time of a freshly spawned pid (spawn.ts `processStart`). */
  startOf?: (pid: number) => string | null;
  signal?: SignalTurn;
  now?: () => number;
  /** The enabled capabilities, for perception gating. */
  capabilities?: readonly EnabledCapability[];
  /** A turn's wall-clock limit (default `DEFAULT_TURN_MAX_MS`). */
  maxTurnMs?: number;
}

export function wakerPass(deps: WakerDeps): { reaped: number[]; started: number[]; limited: number[] } {
  const { db, spawn } = deps;
  const alive = deps.alive ?? isAlive;
  const startOf = deps.startOf ?? processStart;
  const signal = deps.signal ?? signalTurn;
  const now = deps.now ?? Date.now;
  const maxTurnMs = deps.maxTurnMs ?? DEFAULT_TURN_MAX_MS;
  const reaped: number[] = [];
  const started: number[] = [];
  const limited: number[] = [];

  for (const t of runningTurns(db)) {
    if (t.pid == null) {
      if (now() - Date.parse(t.startedAt) > SPAWN_GRACE_MS) {
        finishTurn(db, t.id, { status: "failed", error: "never started" });
        reaped.push(t.id);
      }
      continue;
    }
    if (!alive(t.pid, t.pidStart)) {
      // A turn the limit stopped closes as `stopped`; finishTurn records why from its `term_at`.
      if (t.termAt) finishTurn(db, t.id, { status: "stopped" });
      else finishTurn(db, t.id, { status: "failed", error: `process ${t.pid} died` });
      reaped.push(t.id);
      continue;
    }
    const ranMs = now() - Date.parse(t.startedAt);
    if (ranMs <= maxTurnMs) continue;
    if (!t.termAt) {
      // `term_at` and the alert commit together, so a crash cannot leave one without the other. The signal
      // follows the commit; if the server dies before sending it, the next pass sends it (below).
      const at = new Date(now()).toISOString();
      db.transaction((tx) => {
        const tdb = tx as unknown as Db;
        markTerm(tdb, t.id, at);
        const chat = getChat(tdb, t.chatId);
        raiseAlert(
          tdb,
          {
            key: `turn-limit:${t.id}`,
            topic: `turn-limit:${t.chatId}`,
            text: `Turn ${t.id} in ${chat ? chatLabel(chat) : `chat ${t.chatId}`} ran past the wall-clock limit (${limitText(maxTurnMs)}) and is being stopped. Its messages will not be retried.`,
          },
          now(),
        );
      }, IMMEDIATE);
      signal(t.pid, t.pidStart, "SIGTERM");
      limited.push(t.id);
    } else if (now() - Date.parse(t.termAt) > KILL_GRACE_MS) {
      signal(t.pid, t.pidStart, "SIGKILL");
    } else {
      // Within the grace: SIGTERM again. A stop is idempotent in the child, and this covers a server that
      // died between recording `term_at` and sending the first one.
      signal(t.pid, t.pidStart, "SIGTERM");
    }
  }

  for (const chat of allChats(db)) {
    // A cheap pre-check; the claim re-checks against the cursor inside its own transaction.
    if (lastTriggerSeq(db, chat.id) <= chat.cursorSeq) continue;
    if (retryDelayMs(db, chat.id, now()) > 0) continue;
    const caps = deps.capabilities ?? [];
    if (caps.length && triggersAfter(db, chat.id, chat.cursorSeq).some((e) => capabilityHolds(caps, e, now()))) continue;
    const turn = claimTurn(db, chat.id);
    if (!turn) continue;
    let pid: number;
    try {
      pid = spawn(turn.id);
    } catch (e) {
      finishTurn(db, turn.id, { status: "failed", error: `spawn failed: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    // The child is running now. If recording its pid fails, the turn stays `running` with no pid and is
    // reaped after the grace period; marking it failed here would let a second turn start beside it.
    try {
      setTurnPid(db, turn.id, pid, startOf(pid));
    } catch (e) {
      console.error(`waker: could not record pid ${pid} for turn ${turn.id}:`, e);
    }
    started.push(turn.id);
  }
  return { reaped, started, limited };
}
