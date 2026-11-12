import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationStore, pruneConversations } from "../src/store/conversations.ts";
import { openDb } from "../src/store/db.ts";
import { resetConversation } from "../src/store/events.ts";
import { chats, turns } from "../src/store/schema.ts";
import { finishTurn, saveSession, setTurnConversation } from "../src/store/turns.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("conversation retention", () => {
  test("prunes abandoned history by last write, keeps active and running sessions, and ages metadata-less rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "shuvi-conversation-retention-"));
    dirs.push(dir);
    const db = openDb(join(dir, "shuvi.db"), { migrate: true });
    const old = "2020-01-01T00:00:00.000Z";
    const recent = "2025-01-01T00:00:00.000Z";
    const cutoff = "2024-01-01T00:00:00.000Z";
    const add = (key: string, value: string) => db.$client.query("insert into kv (key, value) values (?, ?)").run(key, value);
    db.insert(chats).values({ tgChatId: 1, kind: "private", backendSessionId: "active" }).run();
    const runningChat = db.insert(chats).values({ tgChatId: 2, kind: "private" }).returning().get();
    const legacyChat = db.insert(chats).values({ tgChatId: 3, kind: "private" }).returning().get();
    const oldLegacyChat = db.insert(chats).values({ tgChatId: 5, kind: "private" }).returning().get();
    const exactRunningChat = db.insert(chats).values({ tgChatId: 4, kind: "private" }).returning().get();
    db.insert(turns).values({ chatId: runningChat.id, status: "running", fromSeq: 0, toSeq: 0 }).run();
    db.insert(turns).values({ chatId: exactRunningChat.id, status: "running", fromSeq: 0, toSeq: 0, backendSessionId: "running" }).run();
    db.insert(turns).values({ chatId: legacyChat.id, status: "done", fromSeq: 0, toSeq: 0, backendSessionId: "legacy-recent", startedAt: recent, endedAt: recent }).run();
    db.insert(turns).values({ chatId: oldLegacyChat.id, status: "done", fromSeq: 0, toSeq: 0, backendSessionId: "legacy-old", startedAt: old, endedAt: old }).run();

    add("conversation:abandoned", "[]");
    add("conversation_retention:abandoned", old);
    add("conversation:active", "[]");
    add("conversation:running", "[]");
    add("conversation_retention:running", old);
    add("conversation:openai-compat:0123456789abcdef:2:before-callback", "[]");
    add("conversation_retention:openai-compat:0123456789abcdef:2:before-callback", old);
    add("conversation:orphaned-metadata", JSON.stringify([{ role: "user", content: [{ type: "image", image: "data:image/jpeg;base64,ZmFrZS1pbWFnZS1kYXRh" }] }]));
    add("conversation_retention:orphaned-metadata", old);
    add("conversation:legacy-recent", "[]");
    add("conversation:legacy-old", "[]");
    add("conversation:legacy-orphan", "[]");
    add("conversation_retention:orphan-only", old);
    add("unrelated-setting", "kept");

    expect(pruneConversations(db, cutoff, 1)).toBe(4);
    const keys = (db.$client.query("select key from kv order by key").all() as Array<{ key: string }>).map((row) => row.key);
    expect(keys).toContain("conversation:active");
    expect(keys).toContain("conversation:running");
    expect(keys).toContain("conversation:legacy-recent");
    expect(keys).not.toContain("conversation:abandoned");
    expect(keys).not.toContain("conversation:orphaned-metadata");
    expect(keys).not.toContain("conversation:legacy-old");
    expect(keys).not.toContain("conversation:legacy-orphan");
    expect(keys).not.toContain("conversation_retention:orphan-only");
    expect(keys).toContain("unrelated-setting");
    db.$client.close();
  });

  test("/new keeps the old history while its runner is live, then releases it", () => {
    const dir = mkdtempSync(join(tmpdir(), "shuvi-conversation-retention-race-"));
    dirs.push(dir);
    const db = openDb(join(dir, "shuvi.db"), { migrate: true });
    const chat = db.insert(chats).values({ tgChatId: 4, kind: "private" }).returning().get();
    const turn = db.insert(turns).values({ chatId: chat.id, status: "running", fromSeq: 0, toSeq: 0 }).returning().get();
    const scoped = `openai-compat:0123456789abcdef:${chat.id}:session`;
    db.$client.query("insert into kv (key, value) values (?, ?)").run(`conversation:${scoped}`, "[]");
    db.$client.query("insert into kv (key, value) values (?, ?)").run(`conversation_retention:${scoped}`, "2020-01-01T00:00:00.000Z");

    saveSession(db, chat.id, scoped);
    resetConversation(db, chat.id);
    expect(pruneConversations(db, "2024-01-01T00:00:00.000Z")).toBe(0);
    saveSession(db, chat.id, scoped);
    setTurnConversation(db, turn.id, { backendSessionId: scoped });
    expect(pruneConversations(db, "2024-01-01T00:00:00.000Z")).toBe(0);
    resetConversation(db, chat.id);
    finishTurn(db, turn.id, { status: "done" });
    expect(pruneConversations(db, "2024-01-01T00:00:00.000Z")).toBe(1);
    db.$client.close();
  });

  test("append and compaction refresh retention timestamps before pruning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shuvi-conversation-retention-order-"));
    dirs.push(dir);
    const db = openDb(join(dir, "shuvi.db"), { migrate: true });
    const store = conversationStore(db);
    const add = (id: string, value: string) => db.$client.query("insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(id, value);
    const timestamp = (id: string) => (db.$client.query("select value from kv where key = ?").get(`conversation_retention:${id}`) as { value: string }).value;

    await store.append("append", [{ role: "user", content: "first" }]);
    add("conversation_retention:append", "2020-01-01T00:00:00.000Z");
    await store.append("append", [{ role: "assistant", content: "second" }]);
    expect(Date.parse(timestamp("append"))).toBeGreaterThan(Date.parse("2020-01-01T00:00:00.000Z"));

    add("conversation:compact", JSON.stringify([{ role: "user", content: "old history" }]));
    add("conversation_retention:compact", "2020-01-01T00:00:00.000Z");
    await store.compact!("compact", [{ role: "user", content: "summary" }]);
    expect(Date.parse(timestamp("compact"))).toBeGreaterThan(Date.parse("2020-01-01T00:00:00.000Z"));
    expect(pruneConversations(db, "2024-01-01T00:00:00.000Z")).toBe(0);
    expect((await store.load("append")).map((message) => message.content)).toEqual(["first", "second"]);
    expect((await store.load("compact")).map((message) => message.content)).toEqual(["summary"]);
    db.$client.close();
  });

  test("an append after pruning recreates the conversation with current history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shuvi-conversation-retention-order-"));
    dirs.push(dir);
    const db = openDb(join(dir, "shuvi.db"), { migrate: true });
    db.$client.query("insert into kv (key, value) values (?, ?)").run("conversation:expired", "[]");
    db.$client.query("insert into kv (key, value) values (?, ?)").run("conversation_retention:expired", "2020-01-01T00:00:00.000Z");
    expect(pruneConversations(db, "2024-01-01T00:00:00.000Z")).toBe(1);

    const store = conversationStore(db);
    await store.append("expired", [{ role: "user", content: "new activity" }]);
    expect(pruneConversations(db, "2024-01-01T00:00:00.000Z")).toBe(0);
    expect((await store.load("expired")).map((message) => message.content)).toEqual(["new activity"]);
    db.$client.close();
  });

  test("a separate pruning process preserves history while another process appends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shuvi-conversation-retention-processes-"));
    dirs.push(dir);
    const path = join(dir, "shuvi.db");
    const db = openDb(path, { migrate: true });
    db.insert(chats).values({ tgChatId: 5, kind: "private", backendSessionId: "shared" }).run();
    await conversationStore(db).append("shared", [{ role: "user", content: "before workers" }]);
    db.$client.query("update kv set value = ? where key = ?").run("2020-01-01T00:00:00.000Z", "conversation_retention:shared");
    const script = `
      import { openDb } from ${JSON.stringify(new URL("../src/store/db.ts", import.meta.url).href)};
      import { conversationStore, pruneConversations } from ${JSON.stringify(new URL("../src/store/conversations.ts", import.meta.url).href)};
      const db = openDb(process.argv[1]);
      if (process.argv[2] === "append") {
        const store = conversationStore(db);
        for (let n = 0; n < 20; n++) await store.append("shared", [{ role: "user", content: "worker:" + n }]);
      } else pruneConversations(db, "2024-01-01T00:00:00.000Z");
      db.$client.close();
    `;
    try {
      const workers = ["append", "prune"].map((kind) => Bun.spawn([process.execPath, "-e", script, path, kind], { stdout: "ignore", stderr: "pipe" }));
      const results = await Promise.all(workers.map(async (worker, index) => {
        const [code, stderr] = await Promise.all([worker.exited, new Response(worker.stderr).text()]);
        if (code !== 0) throw new Error(`conversation ${index} worker exited ${code}: ${stderr}`);
      }));
      expect(results).toHaveLength(2);
      const history = await conversationStore(db).load("shared");
      expect(history).toHaveLength(21);
      expect(new Set(history.map((message) => message.content)).size).toBe(21);
    } finally {
      db.$client.close();
    }
  });
});
