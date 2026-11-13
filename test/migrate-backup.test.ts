import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { openDb } from "../src/store/db.ts";
import { backupBeforeMigrate, KEEP_PRE_MIGRATE, pendingMigrations, prunePreMigrate } from "../src/store/migrate-backup.ts";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number }> };
const last = journal.entries.at(-1)!.idx;
const pad = (n: number) => String(n).padStart(4, "0");

/** A copy of drizzle/ whose journal stops after `upTo`: the migrations an older version shipped. */
function olderMigrations(upTo: number): string {
  const dir = mkdtempSync(join(tmpdir(), "shuvi-migrations-"));
  cpSync(MIGRATIONS, dir, { recursive: true });
  const j = JSON.parse(readFileSync(join(dir, "meta/_journal.json"), "utf8"));
  j.entries = j.entries.filter((e: { idx: number }) => e.idx <= upTo);
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify(j));
  return dir;
}

const copies = (dataDir: string) => (existsSync(join(dataDir, "backups")) ? readdirSync(join(dataDir, "backups")).filter((n) => n.startsWith("pre-migrate-")).sort() : []);

describe("backup before migrating", () => {
  test("a store an older version left gets a copy named for the migrations, then is migrated; a second start copies nothing", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "shuvi-data-"));
    const path = join(dataDir, "shuvi.db");
    const old = openDb(path, { migrate: true, migrationsFolder: olderMigrations(last - 2) });
    old.$client.exec("insert into kv (key, value) values ('marker', 'from the old version')");
    old.$client.close();
    expect(copies(dataDir)).toEqual([]); // a new file had nothing to keep

    const db = openDb(path, { migrate: true });
    const made = copies(dataDir);
    expect(made.length).toBe(1);
    expect(made[0]).toMatch(new RegExp(`^pre-migrate-${pad(last - 2)}-${pad(last)}-\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z\\.db$`));
    // The copy is the store as the old version left it: its data, and its migrations only.
    const copy = new Database(join(dataDir, "backups", made[0]!), { readonly: true });
    expect(copy.query("select value from kv where key = 'marker'").get()).toEqual({ value: "from the old version" });
    expect((copy.query(`select count(*) as n from "__drizzle_migrations"`).get() as { n: number }).n).toBe(last - 1);
    copy.close();
    expect(pendingMigrations(db.$client, MIGRATIONS)).toBeNull();
    db.$client.close();

    openDb(path, { migrate: true }).$client.close();
    expect(copies(dataDir).length).toBe(1);
  });

  test("pending is what drizzle's migrator would apply", () => {
    const client = new Database(":memory:");
    expect(pendingMigrations(client, MIGRATIONS)).toEqual({ from: null, to: pad(last), count: last + 1 });
    const older = olderMigrations(3);
    openDbOn(client, older);
    expect(pendingMigrations(client, older)).toBeNull();
    expect(pendingMigrations(client, MIGRATIONS)).toEqual({ from: pad(3), to: pad(last), count: last - 3 });
  });

  test("keeps the newest five, by time, and drops partial ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "shuvi-backups-"));
    const names = [
      "pre-migrate-0009-0010-2026-01-01T00-00-00-000Z.db",
      "pre-migrate-0010-0011-2026-02-01T00-00-00-000Z.db",
      // a restored older store migrated again: smaller numbers, later time
      "pre-migrate-0004-0011-2026-03-01T00-00-00-000Z.db",
      "pre-migrate-0011-0012-2026-04-01T00-00-00-000Z.db",
      "pre-migrate-0012-0013-2026-05-01T00-00-00-000Z.db",
      "pre-migrate-0013-0014-2026-06-01T00-00-00-000Z.db",
      "pre-migrate-0014-0015-2026-07-01T00-00-00-000Z.db.partial",
    ];
    for (const n of names) writeFileSync(join(dir, n), "");
    mkdirSync(join(dir, "2026-07-01T00-00-00-000Z")); // a daily backup is not touched
    prunePreMigrate(dir);
    expect(readdirSync(dir).sort()).toEqual(
      [
        "2026-07-01T00-00-00-000Z",
        "pre-migrate-0004-0011-2026-03-01T00-00-00-000Z.db",
        "pre-migrate-0010-0011-2026-02-01T00-00-00-000Z.db",
        "pre-migrate-0011-0012-2026-04-01T00-00-00-000Z.db",
        "pre-migrate-0012-0013-2026-05-01T00-00-00-000Z.db",
        "pre-migrate-0013-0014-2026-06-01T00-00-00-000Z.db",
      ].sort(),
    );
    expect(KEEP_PRE_MIGRATE).toBe(5);
  });

  test("old copies are pruned BEFORE the new one is taken, so a disk full of them frees room first", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "shuvi-data-"));
    const path = join(dataDir, "shuvi.db");
    openDb(path, { migrate: true, migrationsFolder: olderMigrations(last - 1) }).$client.close();
    mkdirSync(join(dataDir, "backups"));
    for (let i = 1; i <= KEEP_PRE_MIGRATE; i++) writeFileSync(join(dataDir, "backups", `pre-migrate-0001-0002-2026-0${i}-01T00-00-00-000Z.db`), "");
    const client = new Database(path);
    // Count what is on disk at the moment VACUUM INTO runs: the old copies are already down to KEEP - 1.
    const exec = client.exec.bind(client);
    let onDisk = -1;
    client.exec = ((sql: string) => {
      if (sql.startsWith("VACUUM INTO")) onDisk = copies(dataDir).length;
      return exec(sql);
    }) as typeof client.exec;
    backupBeforeMigrate(client, path, MIGRATIONS);
    client.close();
    expect(onDisk).toBe(KEEP_PRE_MIGRATE - 1);
    const left = copies(dataDir);
    expect(left.length).toBe(KEEP_PRE_MIGRATE);
    expect(left).not.toContain("pre-migrate-0001-0002-2026-01-01T00-00-00-000Z.db"); // the oldest went
    expect(left.some((n) => n.startsWith(`pre-migrate-${pad(last - 1)}-${pad(last)}-`))).toBe(true);
  });

  test("a copy that cannot be written stops the migration", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "shuvi-data-"));
    const path = join(dataDir, "shuvi.db");
    openDb(path, { migrate: true, migrationsFolder: olderMigrations(last - 1) }).$client.close();
    writeFileSync(join(dataDir, "backups"), "a file where the directory should be");
    expect(() => openDb(path, { migrate: true })).toThrow(/could not back up the store|EEXIST|ENOTDIR/);
    const client = new Database(path);
    expect(pendingMigrations(client, MIGRATIONS)?.count).toBe(1);
    client.close();
  });

  test("an in-memory store is migrated without a copy", () => {
    expect(() => openDb(":memory:", { migrate: true })).not.toThrow();
  });

  test("backupBeforeMigrate returns null when nothing is pending", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "shuvi-data-"));
    const db = openDb(join(dataDir, "shuvi.db"), { migrate: true });
    expect(backupBeforeMigrate(db.$client, join(dataDir, "shuvi.db"), MIGRATIONS)).toBeNull();
  });
});

/** The migrator on an existing client: what openDb does after opening the file. */
function openDbOn(client: Database, folder: string): void {
  migrate(drizzle(client), { migrationsFolder: folder });
}
