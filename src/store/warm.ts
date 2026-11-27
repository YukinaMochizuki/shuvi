import { and, asc, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "./db.ts";
import { IMMEDIATE, type Turn } from "./turns.ts";
import { turns, warmRunners } from "./schema.ts";

/**
 * The store's side of WARM RUNNERS (runner/warm.ts has the runner's side, server/waker.ts the hand-off):
 *
 *   - a row of `warm_runners` exists only while its runner is IDLE, one per chat. The runner writes it when its
 *     turn is over (`registerWarm`), and it goes when the runner is handed a turn (`claimTurn` with `handTo`, in
 *     the claim's own transaction), when the runner leaves (`removeWarm`), or when anyone RETIRES it
 *     (`retireWarm`, `retireAllWarm`): a runner that finds its row gone or changed by someone else exits, so
 *     deleting the row is the retire, and the SIGUSR2 that usually follows only makes it quick. Since a hand-off
 *     needs the row, a runner whose row was deleted by anyone else is never handed a turn after that.
 *   - TWO GUARDS keep a runner's CLI from serving a conversation that moved on without it:
 *     1. never registered while another process runs its chat's turn. `registerWarm` refuses while the chat has a
 *        running turn, and the waker decides a hand-off on the row as it is inside the claim's own transaction
 *        (store/turns.ts `claimTurn`); both take the write lock up front, so either the runner registered first
 *        and is handed the turn, or the turn was claimed first and the runner is refused.
 *     2. never serves on a CLI that missed a CLOSED turn. A turn can still run and close elsewhere while the
 *        runner is not registered (between its turn and its registration, or while a turnless start opens its
 *        CLI), and then the runner registers with nothing running. Each CLI remembers the last closed turn it has
 *        seen, and is reopened on a resume when the chat's last closed turn is another (runner/warm-session.ts).
 *   - the cap (`SHUVI_WARM_MAX`): registering one more than the cap retires the least recently idle runner, or
 *     refuses this one if it is the oldest.
 *   - a turn handed to a runner is `handoff = 'pending'` until the runner takes it (`ackHandoff`, which needs
 *     `pending`); one whose runner died first never started, and the waker closes it without counting a failed
 *     attempt. One not taken in time is `abandoned` and closed in one transaction (store/turns.ts
 *     `closeNeverStarted`), so a late take fails.
 *   - a runner on other code or another configuration than the server's is retired, at the server's start and at
 *     a hand-off (server/warm.ts, store/turns.ts `claimTurn`). Compared: `code_version` (version.ts `codeVersion`:
 *     SHUVI_COMMIT, else `git describe`, else the package's version) and `config_hash` (version.ts
 *     `runnerConfigHash`: every variable of the environment a child gets, `childEnv()`, names sorted and each value
 *     hashed, plus the ids of the enabled capabilities). Both sides compute them the same way.
 *   - the DRAIN flag (`kv` `draining`): set by a draining server (server/main.ts `shutdown`), cleared by the next
 *     server at its start. A runner that sees it does not stay warm.
 */

export type WarmRunner = typeof warmRunners.$inferSelect;

/** What a runner must match to be adopted or handed a turn: the server's own (version.ts). */
export interface RunnerIdentity {
  codeVersion: string;
  configHash: string;
}

export const matchesServer = (r: Pick<WarmRunner, "codeVersion" | "configHash">, me: RunnerIdentity): boolean =>
  r.codeVersion === me.codeVersion && r.configHash === me.configHash;

const DRAIN_KEY = "draining";

export function setDraining(db: Db, on: boolean): void {
  if (on) db.$client.query("insert into kv (key, value) values (?, '1') on conflict (key) do update set value = excluded.value").run(DRAIN_KEY);
  else db.$client.query("delete from kv where key = ?").run(DRAIN_KEY);
}

export function isDraining(db: Db): boolean {
  return !!db.$client.query("select 1 from kv where key = ?").get(DRAIN_KEY);
}

export function warmRunnerFor(db: Db, chatId: number): WarmRunner | undefined {
  return db.select().from(warmRunners).where(eq(warmRunners.chatId, chatId)).get();
}

export function allWarmRunners(db: Db): WarmRunner[] {
  return db.select().from(warmRunners).orderBy(asc(warmRunners.idleSince)).all();
}

/**
 * Register runner `row` as idle for its chat, within the cap `max`. A row of another runner for the same chat
 * (one left behind, or a runner that is still leaving) is replaced, and returned among `retired` for the caller
 * to signal. Beyond the cap, the least recently idle runner is retired; if that would be this one (it is the
 * oldest, or the cap is 0) nothing is written and `registered` is false (`refused: "cap"`). While a turn of the
 * chat runs (another process's: the runner's own is closed by now) nothing is written either (`refused: "busy"`).
 */
export function registerWarm(db: Db, row: WarmRunner, max: number): { registered: boolean; retired: WarmRunner[]; refused?: "busy" | "cap" } {
  return db.transaction((tx) => {
    const retired: WarmRunner[] = [];
    // Another process runs the chat's turn now: this runner's CLI would miss it.
    // (The runner's own turn is closed by now, so any running turn of the chat is another process's.)
    const busy = tx
      .select({ id: turns.id })
      .from(turns)
      .where(and(eq(turns.chatId, row.chatId), eq(turns.status, "running")))
      .get();
    if (busy) return { registered: false, retired: [], refused: "busy" as const };
    const same = tx.select().from(warmRunners).where(eq(warmRunners.chatId, row.chatId)).get();
    const others = tx.select().from(warmRunners).where(ne(warmRunners.chatId, row.chatId)).orderBy(asc(warmRunners.idleSince)).all();
    // Oldest first; this one among them by its own idle_since.
    const all = [...others, row].sort((a, b) => a.idleSince.localeCompare(b.idleSince));
    const over = all.length - max;
    const out = all.slice(0, Math.max(0, over));
    if (out.includes(row)) return { registered: false, retired: [], refused: "cap" as const };
    for (const r of out) {
      tx.delete(warmRunners).where(and(eq(warmRunners.chatId, r.chatId), eq(warmRunners.pid, r.pid))).run();
      retired.push(r);
    }
    if (same) {
      tx.delete(warmRunners).where(eq(warmRunners.chatId, row.chatId)).run();
      if (same.pid !== row.pid || same.pidStart !== row.pidStart) retired.push(same);
    }
    tx.insert(warmRunners).values(row).run();
    return { registered: true, retired };
  }, IMMEDIATE);
}

/** Whose row is it: the same pid AND start time. */
const ownedBy = (pid: number, pidStart: string | null) => and(eq(warmRunners.pid, pid), pidStart === null ? isNull(warmRunners.pidStart) : eq(warmRunners.pidStart, pidStart));

/** Update runner `pid`'s own row (its fingerprint after a re-warm). False when the row is no longer its own. */
export function updateWarm(db: Db, chatId: number, pid: number, pidStart: string | null, patch: Partial<Pick<WarmRunner, "fingerprint" | "cliStartedAt">>): boolean {
  const r = db
    .update(warmRunners)
    .set(patch)
    .where(and(eq(warmRunners.chatId, chatId), ownedBy(pid, pidStart)))
    .returning({ pid: warmRunners.pid })
    .all();
  return r.length > 0;
}

/** A runner leaving: delete its own row. False when it was gone already (retired, or handed a turn). */
export function removeWarm(db: Db, chatId: number, pid: number, pidStart: string | null): boolean {
  return db.delete(warmRunners).where(and(eq(warmRunners.chatId, chatId), ownedBy(pid, pidStart))).returning({ pid: warmRunners.pid }).all().length > 0;
}

/**
 * RETIRE the chat's warm runner (`/new`, a switch, a profile switch): delete its row and return it, for the
 * caller to send SIGUSR2 (server/spawn.ts `signalWarm`); without the signal it still exits at its next look
 * (runner/warm.ts). Undefined when the chat has none idle. A runner in a turn has no row: it is not touched,
 * and it decides after its turn whether to stay (the switch or `/new` that stops its turn stops it too).
 */
export function retireWarm(db: Db, chatId: number): WarmRunner | undefined {
  return db.delete(warmRunners).where(eq(warmRunners.chatId, chatId)).returning().get();
}

/** Retire every idle runner (a drain; a server that finds the switch off). */
export function retireAllWarm(db: Db): WarmRunner[] {
  return db.delete(warmRunners).returning().all();
}

/** Retire the runners `pred` picks (a server's start: the dead ones, those on other code). */
export function retireWarmWhere(db: Db, pred: (r: WarmRunner) => boolean): WarmRunner[] {
  const out: WarmRunner[] = [];
  for (const r of allWarmRunners(db)) {
    if (!pred(r)) continue;
    if (db.delete(warmRunners).where(and(eq(warmRunners.chatId, r.chatId), ownedBy(r.pid, r.pidStart))).returning({ pid: warmRunners.pid }).all().length) out.push(r);
  }
  return out;
}

/** The running turn handed to runner `pid` that it has not taken yet. */
export function pendingHandoff(db: Db, pid: number, pidStart: string | null): Turn | undefined {
  return db
    .select()
    .from(turns)
    .where(and(eq(turns.status, "running"), eq(turns.pid, pid), pidStart === null ? isNull(turns.pidStart) : eq(turns.pidStart, pidStart), eq(turns.handoff, "pending")))
    .get();
}

/** The runner takes turn `id` (pending → acked). False when it is no longer a pending hand-off to it (reaped, abandoned). */
export function ackHandoff(db: Db, id: number, pid: number): boolean {
  return (
    db
      .update(turns)
      .set({ handoff: "acked" })
      .where(and(eq(turns.id, id), eq(turns.status, "running"), eq(turns.pid, pid), eq(turns.handoff, "pending")))
      .returning({ id: turns.id })
      .all().length > 0
  );
}
