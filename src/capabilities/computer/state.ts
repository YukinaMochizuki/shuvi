import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../store/db.ts";
import type { Chat } from "../../store/events.ts";
import { computers, jobs } from "../../store/schema.ts";
import { IMMEDIATE } from "../../store/turns.ts";
import { computerNames } from "./config.ts";

/**
 * What the store knows of each chat's computer (schema.ts `computers`), and the two claims every process
 * makes on it, each decided in one IMMEDIATE transaction so the server's loops and a runner child never
 * both win:
 *
 *   LEASE   an exec in flight (a model's exec, a job poll, a file copied into ~/inbox). Taken only while no
 *           op is held; while any lease is live, no op that needs the computer quiet is granted.
 *   OP      a change of run state: `stop` (idle), `boost` (resize up), `restore` (resize back). Taken only
 *           while no lease is live (and, for stop and boost, while no background job runs there). While one
 *           is held, no lease is granted: an exec waits for it, or is refused.
 *
 * Both lapse on their own (a lease at its time, an op at `op_until`), so a process that died holding one
 * blocks nothing for long. The row is the whole state: a restarted server carries on from it.
 */

export type ComputerRow = typeof computers.$inferSelect;
export const COMPUTER_JOB_KIND = "computer";

export function getComputer(db: Db, chatId: number): ComputerRow | undefined {
  return db.select().from(computers).where(eq(computers.chatId, chatId)).get();
}

export function allComputers(db: Db): ComputerRow[] {
  return db.select().from(computers).all();
}

/** The chat's row, made on first use (its Hangar objects are made by the lifecycle, computer.ts). */
export function ensureComputerRow(db: Db, chat: Chat): ComputerRow {
  const names = computerNames(chat.tgChatId);
  db.insert(computers).values({ chatId: chat.id, disk: names.disk, container: names.container }).onConflictDoNothing().run();
  return getComputer(db, chat.id)!;
}

export function updateComputer(db: Db, chatId: number, patch: Partial<Omit<ComputerRow, "chatId">>): void {
  db.update(computers).set(patch).where(eq(computers.chatId, chatId)).run();
}

const live = (leases: Record<string, string>, now: number) => Object.entries(leases).filter(([, until]) => Date.parse(until) > now);
const opHeld = (row: ComputerRow, now: number) => !!row.op && !!row.opUntil && Date.parse(row.opUntil) > now;

/** The computer jobs still running in a chat (background execs and media tools). */
export function runningComputerJobs(db: Db, chatId: number) {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.chatId, chatId), eq(jobs.kind, COMPUTER_JOB_KIND), eq(jobs.state, "running")))
    .all();
}

/** Take a lease until `untilMs`. Returns its id, or the op that holds the computer now. */
export function acquireLease(db: Db, chatId: number, untilMs: number, now = Date.now()): { lease: string } | { busy: string } {
  return db.transaction((tx) => {
    const row = tx.select().from(computers).where(eq(computers.chatId, chatId)).get();
    if (!row) throw new Error(`no computer row for chat ${chatId}`);
    if (opHeld(row, now)) return { busy: row.op! };
    const lease = randomBytes(6).toString("hex");
    const leases = Object.fromEntries([...live(row.leases, now), [lease, new Date(untilMs).toISOString()]]);
    tx.update(computers).set({ leases, lastExecAt: new Date(now).toISOString() }).where(eq(computers.chatId, chatId)).run();
    return { lease };
  }, IMMEDIATE);
}

/** End a lease; the idle clock starts again from now. */
export function releaseLease(db: Db, chatId: number, lease: string, now = Date.now()): void {
  db.transaction((tx) => {
    const row = tx.select().from(computers).where(eq(computers.chatId, chatId)).get();
    if (!row) return;
    const leases = Object.fromEntries(live(row.leases, now).filter(([id]) => id !== lease));
    tx.update(computers).set({ leases, lastExecAt: new Date(now).toISOString() }).where(eq(computers.chatId, chatId)).run();
  }, IMMEDIATE);
}

/**
 * Take the op `op` until `untilMs`. Refused, with why in words, while another op is held, while an exec holds
 * a lease, or (`quietJobs`) while a background job runs in the chat.
 */
export function acquireOp(db: Db, chatId: number, op: "stop" | "boost" | "restore", untilMs: number, opts: { quietJobs?: boolean; exceptJob?: number | null; now?: number } = {}): { ok: true } | { ok: false; why: string } {
  const now = opts.now ?? Date.now();
  return db.transaction((tx) => {
    const tdb = tx as unknown as Db;
    const row = tx.select().from(computers).where(eq(computers.chatId, chatId)).get();
    if (!row) return { ok: false as const, why: "the computer does not exist yet" };
    if (opHeld(row, now)) return { ok: false as const, why: `the computer is busy (${row.op})` };
    const leases = live(row.leases, now);
    if (leases.length) return { ok: false as const, why: `${leases.length} command(s) are running on it` };
    if (opts.quietJobs) {
      const running = runningComputerJobs(tdb, chatId).filter((j) => j.id !== opts.exceptJob);
      if (running.length) return { ok: false as const, why: `background job(s) ${running.map((j) => j.id).join(", ")} still run on it` };
    }
    tx.update(computers).set({ op, opUntil: new Date(untilMs).toISOString() }).where(eq(computers.chatId, chatId)).run();
    return { ok: true as const };
  }, IMMEDIATE);
}

/** Release the op, recording what it changed. */
export function releaseOp(db: Db, chatId: number, patch: Partial<Pick<ComputerRow, "runState" | "boost">> = {}): void {
  db.update(computers)
    .set({ ...patch, op: null, opUntil: null })
    .where(eq(computers.chatId, chatId))
    .run();
}

/** Whether a lease is live on the computer now. */
export function hasLiveLease(row: ComputerRow, now = Date.now()): boolean {
  return live(row.leases, now).length > 0;
}

export { opHeld };
