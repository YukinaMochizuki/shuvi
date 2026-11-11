import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema.ts";

export type Db = BunSQLiteDatabase<typeof schema> & { $client: Database };

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Open the store. Several processes open the same file at once (the server and each runner child), so it
 * runs in WAL mode with a busy timeout: a writer waits for another instead of failing. `path` ":memory:"
 * gives a private database (tests).
 */
export function openDb(path: string, opts: { migrate?: boolean } = {}): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const client = new Database(path, { create: true });
  client.exec("PRAGMA journal_mode = WAL;");
  client.exec("PRAGMA busy_timeout = 5000;");
  client.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(client, { schema }) as Db;
  // Only the server migrates. A runner child opens the store as it is: a child applying migrations
  // underneath a server that has not would be the wrong process changing the schema.
  if (opts.migrate) migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}
