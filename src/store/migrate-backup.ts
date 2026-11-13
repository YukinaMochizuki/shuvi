import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * A copy of the store before its schema changes: when the server starts with migrations pending, it first
 * writes `$SHUVI_DATA_DIR/backups/pre-migrate-<from>-<to>-<UTC time>.db`, where `<from>` is the number of
 * the last migration applied (`none` when the file has tables but no migration record) and `<to>` the last
 * one there is, and keeps the newest `KEEP_PRE_MIGRATE`. A deploy whose migration goes wrong can then be
 * rolled back to the exact store the previous version ran on.
 *
 * The copy is taken with `VACUUM INTO`, one read transaction, so it is consistent even while runner children
 * of the previous server write (WAL content included), like the daily backup (control/backup.ts). It is
 * written as `<name>.partial` and renamed when complete. Older copies are pruned to `KEEP_PRE_MIGRATE - 1`
 * BEFORE the copy is taken, so a disk filled by old copies frees their room first. If it still cannot be
 * written the server does not start: migrating with no way back is what this is here to prevent.
 *
 * "Pending" is decided as drizzle's migrator decides it (drizzle-orm/sqlite-core: a journal entry whose
 * `when` is later than the newest `created_at` in `__drizzle_migrations`), so the two cannot disagree. A new,
 * empty file has nothing to keep and gets no copy.
 */

export const KEEP_PRE_MIGRATE = 5;
const PREFIX = "pre-migrate-";

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const num = (idx: number) => String(idx).padStart(4, "0");

/** What `migrate` would apply to this database: `from` (the last applied, or null) and `to`; null when nothing. */
export function pendingMigrations(client: Database, migrationsFolder: string): { from: string | null; to: string; count: number } | null {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")) as { entries: JournalEntry[] };
  const entries = journal.entries;
  if (!entries.length) return null;
  const hasTable = !!client.query("select 1 from sqlite_master where type = 'table' and name = '__drizzle_migrations'").get();
  let last: number | null = null;
  if (hasTable) {
    const row = client.query(`select created_at as at from "__drizzle_migrations" order by created_at desc limit 1`).get() as { at: number | string } | null;
    if (row) last = Number(row.at);
  }
  const pending = entries.filter((e) => last === null || last < e.when);
  if (!pending.length) return null;
  const applied = last === null ? undefined : [...entries].reverse().find((e) => e.when <= last);
  return { from: applied ? num(applied.idx) : null, to: num(entries.at(-1)!.idx), count: pending.length };
}

/**
 * Before migrating `client` (the store at `dbPath`): when migrations are pending and the file holds anything,
 * copy it to `<dirname(dbPath)>/backups/` and prune older copies. Returns the copy's path, or null when none was
 * needed. Throws when the copy fails.
 */
export function backupBeforeMigrate(client: Database, dbPath: string, migrationsFolder: string, now = Date.now()): string | null {
  const p = pendingMigrations(client, migrationsFolder);
  if (!p) return null;
  const tables = client.query("select count(*) as n from sqlite_master where type = 'table'").get() as { n: number };
  if (!tables.n) return null; // a new file: nothing to keep
  const dir = join(dbPath, "..", "backups");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const final = join(dir, `${PREFIX}${p.from ?? "none"}-${p.to}-${stamp}.db`);
  const partial = `${final}.partial`;
  // Room for this one first, then this one (with the newest older ones it keeps the count at KEEP).
  prunePreMigrate(dir, KEEP_PRE_MIGRATE - 1);
  try {
    client.exec(`VACUUM INTO '${partial.replaceAll("'", "''")}'`);
    renameSync(partial, final);
  } catch (e) {
    rmSync(partial, { force: true });
    throw new Error(`could not back up the store before migrating it (${p.from ?? "none"} → ${p.to}), so it was not migrated: ${e instanceof Error ? e.message : String(e)}`);
  }
  prunePreMigrate(dir);
  return final;
}

/** The time part of a copy's name, which is what orders them (the numbers need not grow: a restored copy). */
const stampOf = (name: string) => /-(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.db$/.exec(name)?.[1] ?? "";

/** Keep the newest `KEEP_PRE_MIGRATE` copies; drop the rest and any partial one. */
export function prunePreMigrate(dir: string, keep = KEEP_PRE_MIGRATE): void {
  if (!existsSync(dir)) return;
  const names = readdirSync(dir).filter((n) => n.startsWith(PREFIX));
  for (const n of names) if (n.endsWith(".partial")) rmSync(join(dir, n), { force: true });
  const done = names.filter((n) => n.endsWith(".db")).sort((a, b) => stampOf(a).localeCompare(stampOf(b)));
  for (const n of done.slice(0, Math.max(0, done.length - keep))) rmSync(join(dir, n), { force: true });
}
