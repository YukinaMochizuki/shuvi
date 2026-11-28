import type { Db } from "../store/db.ts";
import { isAlive, processStart } from "./spawn.ts";

/**
 * Waking the server's sender from a runner child, so a queued message goes out at once rather than at the
 * sender's next poll.
 *
 * At startup the server records its own pid and that process's start time in `kv` (`recordServerProcess`),
 * after installing its SIGUSR2 handler (`onWake`): SIGUSR2's default action ends a process, so a child must
 * never find a pid whose handler is not in place yet. After a child queues an outbound row
 * (store/events.ts `enqueueOutbound`, a row carrying its turn), it sends SIGUSR2 to that pid (`wakeServer`),
 * but only while the pid's start time still matches (spawn.ts `isAlive`): a server gone and its pid reused by
 * another process is never signalled (nor any pid, where there is no /proc to tell). A child that outlives a restart reads the new server's record, as the
 * record is read at every wake.
 *
 * A wake is only a hint. It carries nothing, and a failure to send one is ignored: the sender still polls
 * (loop.ts), so a lost signal costs a poll interval, never a message (docs/design.md §1, invariant 2). Only the
 * server sends; a child still never talks to Telegram.
 */

const KEY = "server_process";

/** Record this process as the server to wake. Call once its SIGUSR2 handler is installed (`onWake`). */
export function recordServerProcess(db: Db, pid: number = process.pid): void {
  const value = JSON.stringify({ pid, start: processStart(pid) });
  db.$client.query("insert into kv (key, value) values (?, ?) on conflict (key) do update set value = excluded.value").run(KEY, value);
}

/** The server to wake, as recorded; undefined when none was. */
export function serverProcess(db: Db): { pid: number; start: string | null } | undefined {
  const row = db.$client.query("select value from kv where key = ?").get(KEY) as { value: string } | null;
  if (!row) return undefined;
  const v = JSON.parse(row.value) as { pid?: unknown; start?: unknown };
  return typeof v.pid === "number" ? { pid: v.pid, start: typeof v.start === "string" ? v.start : null } : undefined;
}

/**
 * Tell the server something was queued for its sender. Best effort: false when no server is recorded, it is
 * gone, or the signal could not be sent; never throws.
 */
export function wakeServer(db: Db): boolean {
  try {
    const s = serverProcess(db);
    // Without a start time (no /proc) the pid cannot be told from a reused one: no signal, the poll covers it.
    if (!s || s.start === null || !isAlive(s.pid, s.start)) return false;
    // This process itself (a test, or a server path): only with a handler in place, or SIGUSR2 would end it.
    if (s.pid === process.pid && process.listenerCount("SIGUSR2") === 0) return false;
    process.kill(s.pid, "SIGUSR2");
    return true;
  } catch {
    return false;
  }
}

/** In the server: call `kick` on every SIGUSR2. Returns a function that removes the handler. */
export function onWake(kick: () => void): () => void {
  const handler = () => kick();
  process.on("SIGUSR2", handler);
  return () => void process.off("SIGUSR2", handler);
}
