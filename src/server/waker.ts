import { capabilityHolds, type EnabledCapability } from "../capabilities/types.ts";
import type { Db } from "../store/db.ts";
import { allChats, lastTriggerSeq, triggersAfter } from "../store/events.ts";
import { claimTurn, finishTurn, retryDelayMs, runningTurns, setTurnPid } from "../store/turns.ts";
import { isAlive, type SpawnTurn } from "./spawn.ts";

/**
 * The waker decides WHEN to think, and nothing about how. One pass:
 *
 *   1. Reap: a `running` turn whose process is gone died without closing itself (a crash, an OOM kill).
 *      Close it as failed; the cursor rule (store/turns.ts) then has the next pass retry its input.
 *      A turn that never got a pid (the spawn itself failed) is reaped after `SPAWN_GRACE_MS`.
 *   2. Wake: for each chat with inbound events past its cursor and no running turn, claim a turn (the
 *      unique index makes the claim the lock) and start a child for it. A chat whose last turns failed
 *      waits out its backoff first (store/turns.ts `retryDelayMs`). A chat with a message a capability
 *      still holds (a picture still downloading: PERCEPTION GATING, `Capability.holds`) waits too; a hold
 *      lasts a few seconds at most, then the turn opens anyway.
 *
 * It holds no state between passes: every answer is in the store, so a restarted server picks up exactly
 * where the last one was, including turns that are still running in children it did not start.
 */

export const SPAWN_GRACE_MS = 30_000;

export interface WakerDeps {
  db: Db;
  spawn: SpawnTurn;
  alive?: (pid: number) => boolean;
  now?: () => number;
  /** The enabled capabilities, for perception gating. */
  capabilities?: readonly EnabledCapability[];
}

export function wakerPass(deps: WakerDeps): { reaped: number[]; started: number[] } {
  const { db, spawn } = deps;
  const alive = deps.alive ?? isAlive;
  const now = deps.now ?? Date.now;
  const reaped: number[] = [];
  const started: number[] = [];

  for (const t of runningTurns(db)) {
    const dead = t.pid != null ? !alive(t.pid) : now() - Date.parse(t.startedAt) > SPAWN_GRACE_MS;
    if (dead) {
      finishTurn(db, t.id, { status: "failed", error: t.pid != null ? `process ${t.pid} died` : "never started" });
      reaped.push(t.id);
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
      setTurnPid(db, turn.id, pid);
    } catch (e) {
      console.error(`waker: could not record pid ${pid} for turn ${turn.id}:`, e);
    }
    started.push(turn.id);
  }
  return { reaped, started };
}
