import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationStore, pruneConversations } from "../src/store/conversations.ts";
import { openDb } from "../src/store/db.ts";
import { resetConversation } from "../src/store/events.ts";
import { chats, conversationMessages, conversations, turns } from "../src/store/schema.ts";
import { finishTurn, saveSession, setTurnConversation } from "../src/store/turns.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function database(): ReturnType<typeof openDb> {
  const dir = mkdtempSync(join(tmpdir(), "shuvi-conversation-retention-"));
  dirs.push(dir);
  return openDb(join(dir, "shuvi.db"), { migrate: true });
}

describe("conversation retention", () => {
  test("prunes strictly older histories and preserves active and running chats with opaque ids", async () => {
    const db = database();
    const cutoff = "2024-01-01T00:00:00.000Z";
    const active = db.insert(chats).values({ tgChatId: 1, kind: "private", backendSessionId: "opaque-active-A" }).returning().get();
    const running = db.insert(chats).values({ tgChatId: 2, kind: "private" }).returning().get();
    const abandoned = db.insert(chats).values({ tgChatId: 3, kind: "private" }).returning().get();
    const boundary = db.insert(chats).values({ tgChatId: 4, kind: "private" }).returning().get();
    db.insert(turns).values({ chatId: running.id, status: "running", fromSeq: 0, toSeq: 0 }).run();
    const histories = [
      [active.id, "opaque-active-A"],
      [active.id, "previous-active-session"],
      [running.id, "runner-session-without-chat-id"],
      [abandoned.id, "opaque-abandoned-Z"],
      [abandoned.id, "recent-session"],
      [boundary.id, "exact-cutoff"],
    ] as const;
    for (const [chatId, id] of histories) await conversationStore(db, chatId).append(id, [{ role: "user", content: id }]);
    db.$client.query("update conversations set written_at = ?").run("2020-01-01T00:00:00.000Z");
    db.$client.query("update conversations set written_at = ? where id = ?").run(cutoff, "exact-cutoff");

    db.$client.query("update conversations set written_at = ? where id = ?").run("2025-01-01T00:00:00.000Z", "recent-session");
    expect(pruneConversations(db, cutoff, 1)).toBe(2);
    for (const id of ["opaque-active-A", "runner-session-without-chat-id", "exact-cutoff", "recent-session"]) {
      const chatId = histories.find((entry) => entry[1] === id)![0];
      expect(await conversationStore(db, chatId).load(id)).toHaveLength(1);
    }
    expect(db.select().from(conversations).all()).toHaveLength(4);
    db.$client.close();
  });

  test("pruning an image-bearing history cascades to its message rows", async () => {
    const db = database();
    const chat = db.insert(chats).values({ tgChatId: 5, kind: "private" }).returning().get();
    const id = "session-with-image";
    await conversationStore(db, chat.id).append(id, [{
      role: "user",
      content: [{ type: "file", data: "data:image/jpeg;base64,ZmFrZQ==", mediaType: "image/jpeg" }],
    }]);
    db.$client.query("update conversations set written_at = ? where id = ?").run("2020-01-01T00:00:00.000Z", id);

    expect(db.select().from(conversationMessages).all()).toHaveLength(1);
    expect(pruneConversations(db, "2024-01-01T00:00:00.000Z")).toBe(1);
    expect(db.select().from(conversationMessages).all()).toHaveLength(0);
    await conversationStore(db, chat.id).append(id, [{ role: "user", content: "new activity" }]);
    expect(pruneConversations(db, "2024-01-01T00:00:00.000Z")).toBe(0);
    expect(await conversationStore(db, chat.id).load(id)).toEqual([{ role: "user", content: "new activity" }]);
    db.$client.close();
  });

  test("/new keeps history during the running turn before its first session callback", async () => {
    const db = database();
    const chat = db.insert(chats).values({ tgChatId: 6, kind: "private" }).returning().get();
    const turn = db.insert(turns).values({ chatId: chat.id, status: "running", fromSeq: 0, toSeq: 0 }).returning().get();
    const id = "opaque-session-before-callback";
    await conversationStore(db, chat.id).append(id, [{ role: "user", content: "in flight" }]);
    db.$client.query("update conversations set written_at = ? where id = ?").run("2020-01-01T00:00:00.000Z", id);

    resetConversation(db, chat.id);
    expect(pruneConversations(db, "2024-01-01T00:00:00.000Z")).toBe(0);
    expect(await conversationStore(db, chat.id).load(id)).toHaveLength(1);

    saveSession(db, chat.id, id);
    setTurnConversation(db, turn.id, { backendSessionId: id });
    resetConversation(db, chat.id);
    expect(pruneConversations(db, "2024-01-01T00:00:00.000Z")).toBe(0);
    finishTurn(db, turn.id, { status: "done" });
    expect(pruneConversations(db, "2024-01-01T00:00:00.000Z")).toBe(1);
    db.$client.close();
  });

  test("append and compaction refresh written_at and compaction replaces the visible generation", async () => {
    const db = database();
    const chat = db.insert(chats).values({ tgChatId: 7, kind: "private" }).returning().get();
    const store = conversationStore(db, chat.id);
    const timestamp = (id: string) => (db.$client.query("select written_at from conversations where id = ?").get(id) as { written_at: string }).written_at;

    await store.append("append-session", [{ role: "user", content: "first" }]);
    db.$client.query("update conversations set written_at = ? where id = ?").run("2020-01-01T00:00:00.000Z", "append-session");
    await store.append("append-session", [{ role: "assistant", content: "second" }]);
    expect(Date.parse(timestamp("append-session"))).toBeGreaterThan(Date.parse("2020-01-01T00:00:00.000Z"));

    await store.append("compact-session", [{ role: "user", content: "old history" }]);
    db.$client.query("update conversations set written_at = ? where id = ?").run("2020-01-01T00:00:00.000Z", "compact-session");
    await store.compact!("compact-session", [{ role: "user", content: "summary" }]);
    expect(Date.parse(timestamp("compact-session"))).toBeGreaterThan(Date.parse("2020-01-01T00:00:00.000Z"));
    expect((await store.load("append-session"))!.map((message) => message.content)).toEqual(["first", "second"]);
    expect((await store.load("compact-session"))!.map((message) => message.content)).toEqual(["summary"]);
    expect((db.$client.query("select generation from conversations where id = ?").get("compact-session") as { generation: number }).generation).toBe(1);
    expect((db.$client.query("select count(*) as count from conversation_messages").get() as { count: number }).count).toBe(3);
    expect(pruneConversations(db, "2024-01-01T00:00:00.000Z")).toBe(0);
    db.$client.close();
  });
});
