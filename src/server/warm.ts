import type { Db } from "../store/db.ts";
import { matchesServer, retireAllWarm, retireWarm, retireWarmWhere, setDraining, type RunnerIdentity, type WarmRunner } from "../store/warm.ts";
import { isAlive, signalWarm, type SignalWarm } from "./spawn.ts";

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
 *   - a hand-off (server/waker.ts): a runner that does not match the server (one that registered later, from a
 *     child started by an earlier server) is retired instead of being handed the turn, and a child is spawned.
 */

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
