import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { openDb, type Db } from "../src/store/db.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function checkConversationTables(db: Db) {
  db.$client.query("insert into chats (id, tg_chat_id, kind) values (7, 1007, 'private')").run();
  db.$client.query("insert into conversations (id, chat_id) values ('session', 7)").run();
  const insert = db.$client.query("insert into conversation_messages (conversation_id, generation, seq, message) values (?, ?, ?, ?)");
  const message = JSON.stringify({ role: "user", content: "hello" });
  insert.run("session", 0, 0, message);
  expect(() => insert.run("session", 0, 0, message)).toThrow();
  insert.run("session", 1, 0, message);
  expect(() => insert.run("missing", 0, 0, message)).toThrow();
  expect(db.$client.query("select generation, created_at, written_at from conversations").get()).toMatchObject({ generation: 0, created_at: expect.any(String), written_at: expect.any(String) });
  const plan = db.$client.query("explain query plan select id from conversations where written_at < ?").all("2024-01-01T00:00:00.000Z") as { detail: string }[];
  expect(plan.some((row) => row.detail.includes("conversations_written_at"))).toBe(true);
  db.$client.query("delete from conversations where id = 'session'").run();
  expect(db.$client.query("select * from conversation_messages").all()).toEqual([]);
  expect(db.$client.query("pragma foreign_key_check").all()).toEqual([]);
}

test("fresh database migration creates conversation keys, defaults, retention index and cascade", () => {
  const db = openDb(":memory:", { migrate: true });
  try {
    checkConversationTables(db);
  } finally {
    db.$client.close();
  }
});

test("upgrading the existing schema preserves data and can be applied repeatedly", () => {
  const dir = mkdtempSync(join(tmpdir(), "shuvi-conversation-migration-"));
  dirs.push(dir);
  const migrations = join(dir, "migrations");
  mkdirSync(join(migrations, "meta"), { recursive: true });
  const source = new URL("../drizzle/", import.meta.url);
  const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", source), "utf8")) as { entries: { idx: number; tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 9);
  for (const entry of journal.entries) copyFileSync(new URL(`${entry.tag}.sql`, source), join(migrations, `${entry.tag}.sql`));
  writeFileSync(join(migrations, "meta/_journal.json"), JSON.stringify(journal));
  const path = join(dir, "shuvi.db");
  const previous = openDb(path);
  migrate(previous, { migrationsFolder: migrations });
  previous.$client.query("insert into chats (id, tg_chat_id, kind, backend_session_id) values (1, 1001, 'private', 'claude-session')").run();
  previous.$client.query("insert into kv (key, value) values ('telegram_offset', '123')").run();
  previous.$client.query("insert into chat_events (chat_id, kind, payload) values (1, 'message', ?)").run(JSON.stringify({ text: "existing event" }));
  expect(previous.$client.query("select name from sqlite_master where name = 'conversations'").get()).toBeNull();
  previous.$client.close();

  for (let attempt = 0; attempt < 2; attempt++) {
    const db = openDb(path, { migrate: true });
    try {
      expect(db.$client.query("select backend_session_id from chats where id = 1").get()).toEqual({ backend_session_id: "claude-session" });
      expect(db.$client.query("select value from kv where key = 'telegram_offset'").get()).toEqual({ value: "123" });
      expect(db.$client.query("select payload from chat_events where chat_id = 1").get()).toEqual({ payload: JSON.stringify({ text: "existing event" }) });
      expect(db.$client.query("select * from conversations").all()).toEqual([]);
      if (attempt === 1) checkConversationTables(db);
    } finally {
      db.$client.close();
    }
  }
});
