import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { raiseAlert } from "../store/control.ts";
import type { Db } from "../store/db.ts";
import { kvGet, kvSet } from "../store/events.ts";

/**
 * Daily backups of the data dir: `$SHUVI_DATA_DIR/backups/<UTC timestamp>/` holding
 *
 *   shuvi.db      a consistent copy of the store, taken online with `VACUUM INTO` (one read transaction,
 *                 so the copy is a single point in time even while turns write; WAL content included)
 *   home.bundle   `git bundle create --all` of `home/`, when home/ is a git repo with at least one commit
 *
 * The newest `KEEP` are kept. A backup is assembled in `<name>.partial` and renamed when complete, so a
 * crash never leaves a half backup that pruning would count as one. The time of the last good backup is
 * in `kv` (`backup_last_at`), so a restart does not take an extra one; a failure raises an alert and is
 * retried after `RETRY_MS`.
 *
 * This is a copy on the same disk: it protects against a bad write or a mistaken delete, not against the
 * disk. Copying `backups/` off the machine is the deployment's business.
 */

export const KEEP = 7;
export const BACKUP_EVERY_MS = 24 * 3600_000;
export const RETRY_MS = 3600_000;
const LAST_KEY = "backup_last_at";
const RETRY_KEY = "backup_retry_at";

export interface BackupDeps {
  db: Db;
  dataDir: string;
  home: string;
  now?: () => number;
}

/** Take a backup now. Returns its directory. Throws on failure. */
export function takeBackup(deps: BackupDeps): string {
  const now = (deps.now ?? Date.now)();
  const root = join(deps.dataDir, "backups");
  mkdirSync(root, { recursive: true });
  const name = new Date(now).toISOString().replace(/[:.]/g, "-");
  const final = join(root, name);
  const partial = `${final}.partial`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial);

  const dbCopy = join(partial, "shuvi.db");
  deps.db.$client.exec(`VACUUM INTO '${dbCopy.replaceAll("'", "''")}'`);

  if (existsSync(join(deps.home, ".git"))) {
    const head = Bun.spawnSync(["git", "-C", deps.home, "rev-parse", "--verify", "-q", "HEAD"]);
    if (head.exitCode === 0) {
      const r = Bun.spawnSync(["git", "-C", deps.home, "bundle", "create", join(partial, "home.bundle"), "--all"], { stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(`git bundle failed: ${r.stderr.toString().trim()}`);
    }
  }
  renameSync(partial, final);
  prune(root);
  return final;
}

/** Keep the newest `KEEP` complete backups; drop older ones and any leftover partial ones. */
function prune(root: string): void {
  const entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const e of entries) if (e.name.endsWith(".partial")) rmSync(join(root, e.name), { recursive: true, force: true });
  const done = entries.map((e) => e.name).filter((n) => !n.endsWith(".partial")).sort();
  for (const n of done.slice(0, Math.max(0, done.length - KEEP))) rmSync(join(root, n), { recursive: true, force: true });
}

/** One pass of the backup loop: take a backup when one is due. */
export function backupPass(deps: BackupDeps): "taken" | "not-due" | "failed" {
  const now = (deps.now ?? Date.now)();
  const last = Number(kvGet(deps.db, LAST_KEY) ?? 0);
  const retryAt = Number(kvGet(deps.db, RETRY_KEY) ?? 0);
  if (now - last < BACKUP_EVERY_MS || now < retryAt) return "not-due";
  try {
    const dir = takeBackup(deps);
    kvSet(deps.db, LAST_KEY, String(now));
    console.log(`backup: ${dir}`);
    return "taken";
  } catch (e) {
    kvSet(deps.db, RETRY_KEY, String(now + RETRY_MS));
    const msg = e instanceof Error ? e.message : String(e);
    raiseAlert(deps.db, { key: `backup-failed:${now}`, topic: "backup", text: `Backup failed: ${msg.slice(0, 300)}. Retrying in an hour.` }, now);
    return "failed";
  }
}
