import { hasPendingSwitch } from "../agent/switch.ts";
import { resolveChat, type Policy } from "../policy/policy.ts";
import { raiseAlert } from "../store/control.ts";
import type { Db } from "../store/db.ts";
import { getChat, pendingCommands, type CommandPayload } from "../store/events.ts";
import { chatModel } from "../store/models.ts";
import { chatLabel, runningTurnFor } from "../store/turns.ts";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { turns } from "../store/schema.ts";
import { enforceCap, matchesServer, pinnedChats, removeWarm, retireAllWarm, retireWarm, retireWarmWhere, setDraining, warmRunnerFor, type RunnerIdentity, type WarmRunner } from "../store/warm.ts";
import { isAlive, processStart, signalTurn, signalWarm, spawnWarm, type SignalTurn, type SignalWarm, type SpawnWarm } from "./spawn.ts";

/**
 * The server's hand on WARM RUNNERS (runner/warm.ts; the rows: store/warm.ts). Retiring one is deleting its row
 * (it exits once it sees it gone) and then SIGUSR2, which only makes that quick. The store's own resets delete the
 * chat's row too, in their transaction (store/events.ts `forgetConversations`, agent/switch.ts `startClean` and
 * `applySwitchRequest`, store/profiles.ts `setChatProfile`), so a reset made from the console retires it as well;
 * the server's paths call `retireChatRunner` first so the signal goes out.
 *
 *   - `/new`, `/newclean` (server/commands.ts), a switch of the chat's model or provider (`switchRequestPass`), a
 *     switch of its profile (control/model-cards.ts): the chat's runner.
 *   - a drain (`drainWarmRunners`, main.ts `shutdown`): the drain flag first, so a runner in a turn does not stay
 *     after it, then every idle runner.
 *   - a server's start (`startWarmRunners`): the drain flag cleared; rows whose process is gone deleted; runners on
 *     other code or another configuration than this server's (`RunnerIdentity`: version.ts `codeVersion`,
 *     `runnerConfigHash`), or every runner when `SHUVI_WARM_RUNNERS` is off, retired. A runner on the same code and
 *     configuration is ADOPTED: nothing happens to it, and the waker hands it the chat's next turn as before.
 *   - a hand-off (store/turns.ts `claimTurn`, from server/waker.ts): a runner that does not match the server (one
 *     that registered later, from a child started by an earlier server) is retired instead of being handed the
 *     turn, and a child is spawned.
 *
 * PINNED CHATS (`chats.warm_pinned`, set from the console): `PinKeeper` runs as the server's `warm` loop. With
 * `SHUVI_WARM_RUNNERS` on and the server not draining, each pinned chat that is on a `claude` provider, listed in
 * the policy, with no live warm runner, no running turn, and no switch or `/new` waiting, gets a TURNLESS runner
 * child (spawn.ts `spawnWarm`, `child.ts --warm`): it opens the chat's CLI and waits, as after a turn. So a pinned
 * chat is warm again after a server start, after its runner exited for any reason (`/stop`, `/new`, a switch, a dead
 * CLI, a retire), and right after it is pinned.
 *
 *   - A live row that does not match this server (`RunnerIdentity`: a runner that registered after this server's
 *     start, on other code or configuration) is not warm for it: it is retired (SIGUSR2) and replaced.
 *   - Right after a turn closes, its runner may register again within moments: while that turn's process is alive
 *     and the turn closed less than `PIN_AFTER_TURN_GRACE_MS` ago, the chat is left alone (no second runner, which
 *     would double a process and a CLI and often retire the one that just served).
 *   - A START is followed until its process is gone. It SUCCEEDS once its runner served a turn, or stayed registered
 *     and alive for `PIN_WARM_MIN_MS`; only then are the failures forgotten. One that has not registered within
 *     `PIN_START_GRACE_MS` (then killed), or leaves before it succeeded (it registered, then its CLI died, or it
 *     found it could not stay), is a FAILURE: the next start waits `pinBackoffMs` (doubling, at most
 *     `PIN_BACKOFF_MAX_MS`), and after `PIN_ALERT_AFTER` failures in a row the owner is told once, until a start
 *     succeeds again. So a runner that keeps dying is never restarted in a tight loop, and never silently.
 *
 * The same pass applies the cap to the unpinned runners as they are (store/warm.ts `enforceCap`), so a chat unpinned
 * counts toward it at once (its `idle_since` set to the unpin: the most recently idle, not the cap's first victim).
 */

export const PIN_START_GRACE_MS = 30_000;
/** How long a started runner must stay registered and alive (unless it serves a turn first) for its start to count as a success. */
export const PIN_WARM_MIN_MS = 60_000;
/** After a turn closes, how long its runner (alive) is waited for to register again before the keeper steps in. */
export const PIN_AFTER_TURN_GRACE_MS = 15_000;
export const PIN_BACKOFF_BASE_MS = 5_000;
export const PIN_BACKOFF_MAX_MS = 10 * 60_000;
export const PIN_ALERT_AFTER = 3;
/** The least time between two starts for one chat. */
export const PIN_MIN_GAP_MS = 2_000;

export const pinBackoffMs = (failures: number): number => (failures <= 0 ? 0 : Math.min(PIN_BACKOFF_MAX_MS, PIN_BACKOFF_BASE_MS * 2 ** (failures - 1)));

export interface PinKeeperDeps {
  db: Db;
  enabled: boolean;
  /** `SHUVI_WARM_MAX`, for the unpinned runners. */
  max: number;
  draining: () => boolean;
  policy: () => Policy;
  ownerId?: number;
  /** This server's code and configuration: a runner that does not match is retired, not counted as warm. */
  identity?: RunnerIdentity;
  spawn?: SpawnWarm;
  alive?: (pid: number, start: string | null) => boolean;
  startOf?: (pid: number) => string | null;
  signal?: SignalWarm;
  kill?: SignalTurn;
  now?: () => number;
  log?: (line: string) => void;
}

/** A start the keeper made, followed until its process is gone. */
interface Started {
  pid: number;
  start: string | null;
  at: number;
  /** First seen registered (alive, matching). */
  warmAt: number | null;
  /** Last seen registered. */
  lastWarmAt: number | null;
  /** It served a turn, or stayed warm long enough: its start succeeded. */
  succeeded: boolean;
}

interface PinState {
  current: Started | null;
  failures: number;
  nextAt: number;
  lastStartAt: number;
  alerted: boolean;
}

export class PinKeeper {
  private readonly state = new Map<number, PinState>();
  constructor(private readonly deps: PinKeeperDeps) {}

  /** One pass (the header). Returns the chats a runner was started for. */
  pass(): number[] {
    const d = this.deps;
    if (!d.enabled || d.draining()) return [];
    const now = (d.now ?? Date.now)();
    const alive = d.alive ?? isAlive;
    const signal = d.signal ?? signalWarm;
    const log = d.log ?? ((l: string) => console.log(l));
    for (const r of enforceCap(d.db, d.max)) {
      log(`warm: runner ${r.pid} of chat ${r.chatId} retired: over SHUVI_WARM_MAX`);
      signal(r.pid, r.pidStart, "SIGUSR2");
    }
    const started: number[] = [];
    const pinned = pinnedChats(d.db);
    for (const id of [...this.state.keys()]) if (!pinned.includes(id)) this.state.delete(id);
    for (const chatId of pinned) {
      const st = this.state.get(chatId) ?? { current: null, failures: 0, nextAt: 0, lastStartAt: 0, alerted: false };
      this.state.set(chatId, st);
      const cur = st.current;
      const row = warmRunnerFor(d.db, chatId);
      if (row && alive(row.pid, row.pidStart)) {
        if (d.identity && !matchesServer(row, d.identity)) {
          // Registered after this server's start, on other code or configuration: not warm for this server.
          if (removeWarm(d.db, chatId, row.pid, row.pidStart)) {
            log(`warm: runner ${row.pid} of pinned chat ${chatId} runs other code or configuration; retired it`);
            signal(row.pid, row.pidStart, "SIGUSR2");
          }
        } else {
          if (cur && row.pid === cur.pid) {
            cur.warmAt ??= now;
            cur.lastWarmAt = now;
            if (!cur.succeeded && (now - cur.warmAt >= PIN_WARM_MIN_MS || this.served(cur))) this.succeeded(st);
          }
          continue;
        }
      }
      if (cur) {
        const up = alive(cur.pid, cur.start);
        if (!cur.succeeded && this.served(cur)) this.succeeded(st);
        if (up) {
          if (cur.warmAt === null && now - cur.at >= PIN_START_GRACE_MS && runningTurnFor(d.db, chatId)?.pid !== cur.pid) {
            // Never warm in time: killed, a failure.
            (d.kill ?? signalTurn)(cur.pid, cur.start, "SIGKILL");
            st.current = null;
            this.failed(chatId, st, now, "it did not open its CLI in time");
          }
          // Otherwise opening its CLI, running a turn handed to it, or about to register again: wait for it.
          if (st.current) continue;
        } else {
          st.current = null;
          if (!cur.succeeded) this.failed(chatId, st, now, cur.warmAt === null ? "it exited before it was warm" : `it left ${Math.round(((cur.lastWarmAt ?? now) - cur.warmAt) / 1000)} s after it was warm`);
        }
      }
      if (!this.wanted(chatId, now, alive)) continue;
      if (now < st.nextAt || now - st.lastStartAt < PIN_MIN_GAP_MS) continue;
      let pid: number;
      try {
        pid = (d.spawn ?? spawnWarm)(chatId);
      } catch (e) {
        this.failed(chatId, st, now, `it could not be started: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      st.current = { pid, start: (d.startOf ?? processStart)(pid), at: now, warmAt: null, lastWarmAt: null, succeeded: false };
      st.lastStartAt = now;
      started.push(chatId);
      log(`warm: started runner ${pid} for pinned chat ${chatId}`);
    }
    return started;
  }

  /** Whether a start's runner has run a turn (so it registered and was handed one). */
  private served(s: Started): boolean {
    return !!this.deps.db
      .select({ id: turns.id })
      .from(turns)
      .where(and(eq(turns.pid, s.pid), s.start === null ? isNull(turns.pidStart) : eq(turns.pidStart, s.start)))
      .get();
  }

  private succeeded(st: PinState): void {
    if (st.current) st.current.succeeded = true;
    st.failures = 0;
    st.nextAt = 0;
    st.alerted = false;
  }

  /** Whether pinned chat `chatId` should get a runner now (the header's conditions). */
  private wanted(chatId: number, now: number, alive: (pid: number, start: string | null) => boolean): boolean {
    const d = this.deps;
    const chat = getChat(d.db, chatId);
    if (!chat || !resolveChat(d.policy(), chat, d.ownerId)) return false;
    try {
      if (chatModel(d.db, chat).provider.kind !== "claude") return false;
    } catch {
      return false;
    }
    if (runningTurnFor(d.db, chatId)) return false;
    if (hasPendingSwitch(d.db, chatId)) return false;
    if (pendingCommands(d.db).some((c) => c.chatId === chatId && ["new", "newclean"].includes((c.payload as unknown as CommandPayload).command))) return false;
    // The runner of the turn that just closed may register again: give it the grace.
    const last = d.db
      .select({ pid: turns.pid, pidStart: turns.pidStart, endedAt: turns.endedAt })
      .from(turns)
      .where(and(eq(turns.chatId, chatId), ne(turns.status, "running")))
      .orderBy(desc(turns.id))
      .get();
    if (last?.pid != null && last.endedAt && now - Date.parse(last.endedAt) < PIN_AFTER_TURN_GRACE_MS && alive(last.pid, last.pidStart)) return false;
    return true;
  }

  private failed(chatId: number, st: PinState, now: number, why: string): void {
    st.failures++;
    st.nextAt = now + pinBackoffMs(st.failures);
    (this.deps.log ?? ((l: string) => console.log(l)))(`warm: keeping pinned chat ${chatId} warm failed (${why}); next try in ${Math.round(pinBackoffMs(st.failures) / 1000)} s`);
    if (st.failures >= PIN_ALERT_AFTER && !st.alerted) {
      st.alerted = true;
      const chat = getChat(this.deps.db, chatId);
      raiseAlert(this.deps.db, {
        key: `warm-pin:${chatId}:${now}`,
        topic: `warm-pin:${chatId}`,
        text: `${chat ? chatLabel(chat) : `Chat ${chatId}`} is pinned warm, but its runner could not be kept warm (${st.failures} starts failed in a row; last: ${why}). Its turns run cold meanwhile; the server keeps trying, less often.`,
      });
    }
  }
}

export { matchesServer, type RunnerIdentity } from "../store/warm.ts";

/** Retire chat `chatId`'s idle warm runner, if it has one. */
export function retireChatRunner(db: Db, chatId: number, signal: SignalWarm = signalWarm): WarmRunner | undefined {
  const r = retireWarm(db, chatId);
  if (r) signal(r.pid, r.pidStart, "SIGUSR2");
  return r;
}

/** A drain starts: runners do not stay after their turn, and the idle ones leave now. */
export function drainWarmRunners(db: Db, signal: SignalWarm = signalWarm): WarmRunner[] {
  setDraining(db, true);
  const out = retireAllWarm(db);
  for (const r of out) signal(r.pid, r.pidStart, "SIGUSR2");
  return out;
}

/** At a server's start (the header). Returns what it did, for the log. */
export function startWarmRunners(
  db: Db,
  o: { enabled: boolean; identity: RunnerIdentity; alive?: (pid: number, start: string | null) => boolean; signal?: SignalWarm },
): { dead: WarmRunner[]; retired: WarmRunner[] } {
  const alive = o.alive ?? isAlive;
  const signal = o.signal ?? signalWarm;
  setDraining(db, false);
  const dead = retireWarmWhere(db, (r) => !alive(r.pid, r.pidStart));
  const retired = retireWarmWhere(db, (r) => !o.enabled || !matchesServer(r, o.identity));
  for (const r of retired) signal(r.pid, r.pidStart, "SIGUSR2");
  return { dead, retired };
}
