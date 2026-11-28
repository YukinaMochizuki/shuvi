import { hasPendingSwitch } from "../agent/switch.ts";
import { TriggerScan, type BotIdentity } from "../agent/triggers.ts";
import { capabilityHolds, type EnabledCapability } from "../capabilities/types.ts";
import { defaultPolicy, resolveChat, type Policy } from "../policy/policy.ts";
import type { Db } from "../store/db.ts";
import { raiseAlert } from "../store/control.ts";
import { allChats, getChat, lastTriggerSeq, triggersAfter } from "../store/events.ts";
import { chatLabel, claimTurn, closeNeverStarted, finishTurn, IMMEDIATE, markTerm, markTurn, retryDelayMs, runningTurns, setTurnPid, type WarmClaim } from "../store/turns.ts";
import type { RunnerIdentity } from "../store/warm.ts";
import { isAlive, processStart, signalTurn, signalWarm, type SignalTurn, type SignalWarm, type SpawnTurn } from "./spawn.ts";

/**
 * The waker decides WHEN to think, and nothing about how. One pass:
 *
 *   1. Reap: a `running` turn whose process is gone died without closing itself (a crash, an OOM kill).
 *      Close it as failed; the cursor rule (store/turns.ts) then has the next pass retry its input. One that
 *      was being stopped (`term_at` or `stop_seq` set) closes as stopped instead, where its stop put it.
 *      A turn that never got a pid (the spawn itself failed) is reaped after `SPAWN_GRACE_MS`. "Gone"
 *      means the pid no longer runs the process started for the turn (spawn.ts: pid + start time).
 *      A turn HANDED to a warm runner that the runner never took (`handoff = 'pending'`, store/warm.ts) and whose
 *      runner is gone never started: it closes as `stopped` with its stop at its start (cursor unchanged, an
 *      earlier `/stop` keeping its own place), which is not a failed attempt (no backoff, no `MAX_ATTEMPTS`, no
 *      alert), so the next pass answers the same input again, with a child. One still pending `HANDOFF_ACK_MS`
 *      after the hand-off, its runner alive but not taking it, is first marked `abandoned` (store/warm.ts
 *      `abandonHandoff`: only while still pending, so a runner that takes it at that moment runs it, and one that
 *      tries later cannot), then its runner killed and the turn closed the same way.
 *   2. Limit: a turn running longer than its wall-clock limit (`SHUVI_TURN_MAX_MINUTES`, default 15) is
 *      sent SIGTERM, which the child treats as a stop, and SIGKILL `KILL_GRACE_MS` later if it is still
 *      there. Either way it closes as `stopped`, not `failed`: its input counts as handled, so a message
 *      that makes every turn hang is not retried into another hang. `term_at` and the owner's alert are
 *      committed together before the SIGTERM, which is repeated on each pass during the grace, so the
 *      limit survives a server restart at any point. The closed turn's error names the limit
 *      (store/turns.ts `WALL_CLOCK_STOP`), which tells it apart from an owner /stop.
 *   3. Wake: for each chat with inbound events past its cursor that START a turn there and no running
 *      turn, claim a turn (the unique index makes the claim the lock) and start a child for it. What
 *      starts a turn is the chat's policy (src/policy/): in the owner's DM every message; in a group a
 *      mention, a reply to her or a follow-up (agent/triggers.ts), the other messages waiting past the
 *      cursor to be shown with the next turn; a chat policy does not list gets none. A chat whose last turns failed
 *      waits out its backoff first (store/turns.ts `retryDelayMs`). A chat with a message a capability
 *      still holds (a picture still downloading: PERCEPTION GATING, `Capability.holds`) waits too; a hold
 *      lasts a few seconds at most, then the turn opens anyway. A chat with a switch of its model pending
 *      (agent/switch.ts `requestSwitch`) waits until it is applied (server/commands.ts `switchRequestPass`),
 *      so no turn starts on the model being left.
 *      A chat with a live WARM RUNNER (store/warm.ts; `SHUVI_WARM_RUNNERS`, runner/warm.ts) is HANDED the turn
 *      instead of a child being spawned: the claim's transaction gives the turn the runner's pid and start
 *      time, deletes its row and marks the hand-off pending (store/turns.ts `claimTurn`), then SIGUSR1 wakes it
 *      (it also polls). A row whose runner is dead is not handed anything: a child is spawned as before. Nor is a
 *      runner on other code or another configuration than this server's (`runnerIdentity`, server/warm.ts): it
 *      is retired, and a child spawned.
 *
 * It holds no state between passes: every answer is in the store, so a restarted server picks up exactly
 * where the last one was, including turns that are still running in children it did not start. (The one
 * exception is `triggers`, a memo of how far each group's backlog has been judged; a new one judges it
 * again, to the same answers.)
 */

export const SPAWN_GRACE_MS = 30_000;
/** How long a warm runner has to take a turn handed to it (store/warm.ts `ackHandoff`) before it is killed. */
export const HANDOFF_ACK_MS = 10_000;
/** The error a handed turn its runner never took closes with (not a failure: see the header). */
export const HANDOFF_LOST = "never started: the warm runner it was handed to did not take it";
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
  /** SIGUSR1 to a warm runner handed a turn, SIGUSR2 to one retired (spawn.ts `signalWarm`). */
  signalWarm?: SignalWarm;
  /** The server's own code and configuration: a warm runner that does not match it is not handed a turn. */
  runnerIdentity?: RunnerIdentity;
  now?: () => number;
  /** The enabled capabilities, for perception gating. */
  capabilities?: readonly EnabledCapability[];
  /** A turn's wall-clock limit (default `DEFAULT_TURN_MAX_MS`). */
  maxTurnMs?: number;
  /** The policy in effect (default: the owner's DM only). */
  policy?: Policy;
  /** The owner's id: a private chat with anyone else gets no turn. */
  ownerId?: number;
  /** Who the bot is, for mentions and replies to her. */
  bot?: BotIdentity;
  /** Kept by the caller from pass to pass (see the header). */
  triggers?: TriggerScan;
  /**
   * false: reap and enforce the limit (1 and 2), but start nothing (3). A draining server (server/drain.ts)
   * still closes the turns that die and stops the ones that hang, and starts no new one.
   */
  wake?: boolean;
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
    if ((t.handoff === "pending" || t.handoff === "abandoned") && t.pid != null) {
      // Never started: not a failure (store/turns.ts `closeNeverStarted`, one transaction).
      if (t.handoff === "abandoned") {
        // Abandoned but left open (it cannot be: the abandon closes it in its transaction; defence only).
        if (closeNeverStarted(db, t.id, HANDOFF_LOST)) reaped.push(t.id);
        signal(t.pid, t.pidStart, "SIGKILL");
      } else if (!alive(t.pid, t.pidStart)) {
        if (closeNeverStarted(db, t.id, HANDOFF_LOST)) reaped.push(t.id);
      } else if (now() - Date.parse(t.startedAt) > HANDOFF_ACK_MS && closeNeverStarted(db, t.id, HANDOFF_LOST, { abandon: true })) {
        // Abandoned and closed together, so a take from here on fails; then the runner goes.
        console.error(`waker: warm runner ${t.pid} did not take turn ${t.id} in ${Math.round(HANDOFF_ACK_MS / 1000)} s; abandoned it, killing the runner`);
        reaped.push(t.id);
        signal(t.pid, t.pidStart, "SIGKILL");
      }
      continue;
    }
    if (t.pid == null) {
      if (now() - Date.parse(t.startedAt) > SPAWN_GRACE_MS) {
        finishTurn(db, t.id, { status: "failed", error: "never started" });
        reaped.push(t.id);
      }
      continue;
    }
    if (!alive(t.pid, t.pidStart)) {
      // A turn something stopped (the limit's `term_at`, or a `stop_seq`: /stop, a switch, a draining server's
      // deadline) and that died before closing itself closes as `stopped`, as it would have: not `failed`, which
      // would count toward MAX_ATTEMPTS and alert. finishTurn records why from the row.
      if (t.termAt || t.stopSeq != null) finishTurn(db, t.id, { status: "stopped" });
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
            turnId: t.id,
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

  if (deps.wake === false) return { reaped, started, limited };
  const policy = deps.policy ?? defaultPolicy();
  const scan = deps.triggers ?? new TriggerScan();
  for (const chat of allChats(db)) {
    // A cheap pre-check; the claim re-checks against the cursor inside its own transaction.
    if (lastTriggerSeq(db, chat.id) <= chat.cursorSeq) continue;
    const cp = resolveChat(policy, chat, deps.ownerId);
    if (!cp) continue;
    // In a group, the newest event that starts a turn; recording alone does not.
    let trigger: number | undefined;
    if (cp.trigger !== "all") {
      const t = scan.newestTrigger(db, chat, cp, deps.bot, policy);
      if (t === null) continue;
      trigger = t;
    }
    if (retryDelayMs(db, chat.id, now()) > 0) continue;
    if (hasPendingSwitch(db, chat.id)) continue;
    const caps = deps.capabilities ?? [];
    if (caps.length && triggersAfter(db, chat.id, chat.cursorSeq).some((e) => capabilityHolds(caps, e, now()))) continue;
    // Whether the chat's warm runner takes the turn is decided inside the claim's transaction (store/turns.ts
    // `claimTurn`), against its row as it is then: alive and on this server's code and configuration.
    const warm: WarmClaim = { alive, ...(deps.runnerIdentity ? { identity: deps.runnerIdentity } : {}), retired: [] };
    const turn = claimTurn(db, chat.id, trigger, warm);
    for (const r of warm.retired) {
      console.log(`waker: warm runner ${r.pid} of chat ${chat.id} runs other code or configuration; retired it`);
      (deps.signalWarm ?? signalWarm)(r.pid, r.pidStart, "SIGUSR2");
    }
    if (!turn) continue;
    // Wall-clock marks (store/turns.ts `markTurn`), written once the child is on its way.
    const claimed = Date.now();
    if (turn.handoff === "pending" && turn.pid != null) {
      (deps.signalWarm ?? signalWarm)(turn.pid, turn.pidStart, "SIGUSR1");
      markTurn(db, turn.id, { claimed, handed: Date.now() });
      started.push(turn.id);
      continue;
    }
    let spawned: number;
    let pid: number;
    try {
      pid = spawn(turn.id);
      spawned = Date.now();
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
    markTurn(db, turn.id, { claimed, spawned });
    started.push(turn.id);
  }
  return { reaped, started, limited };
}
