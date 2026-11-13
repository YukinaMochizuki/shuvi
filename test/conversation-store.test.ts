import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "agent-runtime/openai-compat";
import { conversationStore } from "../src/store/conversations.ts";
import { openDb, type Db } from "../src/store/db.ts";
import { chats } from "../src/store/schema.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function database() {
  const dir = mkdtempSync(join(tmpdir(), "shuvi-conversation-"));
  dirs.push(dir);
  const path = join(dir, "shuvi.db");
  const db = openDb(path, { migrate: true });
  db.insert(chats).values({ id: 7, tgChatId: 7, kind: "private" }).run();
  return { db, path, store: conversationStore(db, 7) };
}

const metadata = (db: Db) => db.$client.query("select * from conversations where id = 'session'").get();
const messages = (db: Db) => db.$client.query("select generation, seq, message from conversation_messages where conversation_id = 'session' order by generation, seq").all();
const old = "2020-01-01T00:00:00.000Z";

const workerImports = `
  import { openDb } from ${JSON.stringify(new URL("../src/store/db.ts", import.meta.url).href)};
  import { conversationStore } from ${JSON.stringify(new URL("../src/store/conversations.ts", import.meta.url).href)};
  const db = openDb(process.argv[1]);
  const store = conversationStore(db, 7);
  console.log("ready");
  await Bun.stdin.text();
`;

async function startWorkers(path: string, scripts: string[]) {
  const workers = scripts.map((script) => Bun.spawn([process.execPath, "-e", workerImports + script + "\ndb.$client.close();", path], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }));
  try {
    await Promise.all(workers.map(async (worker) => {
      const reader = worker.stdout.getReader();
      const { value } = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(value)).toBe("ready\n");
    }));
    for (const worker of workers) worker.stdin.end();
    const finished = Promise.all(workers.map(async (worker, index) => {
      const [code, stderr] = await Promise.all([worker.exited, new Response(worker.stderr).text()]);
      if (code !== 0) throw new Error(`conversation worker ${index} exited ${code}: ${stderr}`);
    }));
    return { workers, finished };
  } catch (error) {
    for (const worker of workers) worker.kill();
    await Promise.all(workers.map((worker) => worker.exited));
    throw error;
  }
}

describe("conversation message storage", () => {
  test("loads ordered rows across connections and appends without rewriting prior messages", async () => {
    const { db, path, store } = database();
    const second = openDb(path);
    try {
      const image: ModelMessage = { role: "user", content: [{ type: "image", image: "data:image/png;base64,aGVsbG8=" }] };
      await store.append("session", [image, { role: "assistant", content: "seen" }]);
      const originalRows = messages(db);
      db.$client.exec(`
        create trigger prevent_message_update before update on conversation_messages begin select raise(abort, 'old message updated'); end;
        create trigger prevent_message_delete before delete on conversation_messages begin select raise(abort, 'old message deleted'); end;
      `);
      await conversationStore(second, 7).append("session", [{ role: "user", content: "next" }, { role: "assistant", content: "reply" }]);
      expect(messages(db).slice(0, 2)).toEqual(originalRows);
      expect(await store.load("session")).toEqual([image, { role: "assistant", content: "seen" }, { role: "user", content: "next" }, { role: "assistant", content: "reply" }]);
      expect(messages(db).map((row) => (row as { seq: number }).seq)).toEqual([0, 1, 2, 3]);
      expect(metadata(db)).toMatchObject({ chat_id: 7, generation: 0 });
    } finally {
      second.$client.close();
      db.$client.close();
    }
  });

  test("the stored form is plain JSON text: rows written as text load as they were, and what the store writes is JSON.stringify of each message", async () => {
    const { db, store } = database();
    try {
      const history: ModelMessage[] = [
        { role: "user", content: [{ type: "text", text: "日本語 and emoji 🍣, a \"quote\", a \\ backslash\nand a newline" }] },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_1", toolName: "ws__echo", input: { n: 1.5, list: [null, true], nested: { a: "b" } } }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "call_1", toolName: "ws__echo", output: { type: "text", value: "ok" } }] },
      ];
      // Written the way the store wrote before it went through drizzle: raw SQL, JSON.stringify per row.
      db.$client.query("insert into conversations (id, chat_id, written_at) values ('legacy', 7, ?)").run(old);
      history.forEach((message, seq) =>
        db.$client.query("insert into conversation_messages (conversation_id, generation, seq, message) values ('legacy', 0, ?, ?)").run(seq, JSON.stringify(message)),
      );
      expect(await store.load("legacy")).toEqual(history);
      await store.append("legacy", [{ role: "assistant", content: "next" }]);
      expect(await store.load("legacy")).toEqual([...history, { role: "assistant", content: "next" }]);

      await store.append("session", history);
      expect(messages(db)).toEqual(history.map((message, seq) => ({ generation: 0, seq, message: JSON.stringify(message) })));
    } finally {
      db.$client.close();
    }
  });

  test("only a missing parent is lost; empty history loads and corrupt JSON remains an error", async () => {
    const { db, store } = database();
    try {
      await expect(store.load("missing")).resolves.toBeNull();
      await store.compact!("created-by-compaction", [{ role: "user", content: "summary" }]);
      expect(await store.load("created-by-compaction")).toEqual([{ role: "user", content: "summary" }]);
      await store.append("session", []);
      expect(await store.load("session")).toEqual([]);
      await store.append("session", [{ role: "user", content: "first" }]);
      db.$client.query("update conversation_messages set message = '{' where conversation_id = 'session'").run();
      await expect(store.load("session")).rejects.toBeInstanceOf(SyntaxError);
      // Append neither parses nor serializes the previous history.
      await store.append("session", [{ role: "assistant", content: "next" }]);
      expect(messages(db)).toHaveLength(2);
      await expect(store.load("session")).rejects.toBeInstanceOf(SyntaxError);
    } finally {
      db.$client.close();
    }
  });

  test("compacting a missing conversation inserts its timestamps without updating the parent", async () => {
    const { db, store } = database();
    try {
      db.$client.exec("create trigger reject_conversation_update before update on conversations begin select raise(abort, 'parent updated'); end;");
      await store.compact!("fresh-compaction", [{ role: "user", content: "summary" }]);
      const row = db.$client.query("select generation, created_at, written_at from conversations where id = 'fresh-compaction'").get() as {
        generation: number;
        created_at: string;
        written_at: string;
      };
      expect(row.generation).toBe(0);
      expect(Number.isNaN(Date.parse(row.created_at))).toBe(false);
      expect(Number.isNaN(Date.parse(row.written_at))).toBe(false);
      expect(row.written_at > old).toBe(true);
      expect(await store.load("fresh-compaction")).toEqual([{ role: "user", content: "summary" }]);
    } finally {
      db.$client.close();
    }
  });

  test("a failed append rolls back its rows and timestamp", async () => {
    const { db, store } = database();
    try {
      await store.append("session", [{ role: "user", content: "first" }]);
      db.$client.query("update conversations set written_at = ? where id = 'session'").run(old);
      const before = metadata(db);
      db.$client.exec("create trigger reject_append before insert on conversation_messages when new.seq = 2 begin select raise(abort, 'append failed'); end;");
      await expect(store.append("session", [{ role: "assistant", content: "second" }, { role: "user", content: "third" }])).rejects.toThrow("append failed");
      expect(metadata(db)).toEqual(before);
      expect(await store.load("session")).toEqual([{ role: "user", content: "first" }]);
    } finally {
      db.$client.close();
    }
  });

  test("compaction rolls back on failure, then replaces its generation and accepts ordered appends", async () => {
    const { db, store } = database();
    try {
      await store.append("session", [{ role: "user", content: "first" }, { role: "assistant", content: "second" }]);
      db.$client.query("update conversations set written_at = ? where id = 'session'").run(old);
      const before = metadata(db);
      const beforeMessages = messages(db);
      const compacted: ModelMessage[] = [{ role: "user", content: "summary" }, { role: "assistant", content: "recent answer" }];
      db.$client.exec("create trigger reject_compaction before insert on conversation_messages when new.generation = 1 and new.seq = 1 begin select raise(abort, 'compaction failed'); end;");
      await expect(store.compact!("session", compacted)).rejects.toThrow("compaction failed");
      expect(metadata(db)).toEqual(before);
      expect(messages(db)).toEqual(beforeMessages);
      db.$client.exec("drop trigger reject_compaction;");
      await store.compact!("session", compacted);
      expect(metadata(db)).toMatchObject({ generation: 1, created_at: (before as { created_at: string }).created_at });
      expect((metadata(db) as { written_at: string }).written_at > old).toBe(true);
      expect(messages(db).every((row) => (row as { generation: number }).generation === 1)).toBe(true);
      await store.append("session", [{ role: "user", content: "follow-up" }]);
      expect(await store.load("session")).toEqual([...compacted, { role: "user", content: "follow-up" }]);
      expect(messages(db).map((row) => (row as { seq: number }).seq)).toEqual([0, 1, 2]);
      await store.compact!("session", []);
      expect(await store.load("session")).toEqual([]);
      expect(messages(db)).toEqual([]);
      expect(metadata(db)).toMatchObject({ generation: 2 });
      await store.append("session", [{ role: "user", content: "after empty compaction" }]);
      expect(messages(db)[0]).toMatchObject({ generation: 2, seq: 0 });
    } finally {
      db.$client.close();
    }
  });

  test("separate processes preserve every append batch and each writer's order", async () => {
    const { db, path, store } = database();
    const { workers, finished } = await startWorkers(path, [0, 1, 2].map((worker) => `
      for (let n = 0; n < 30; n++) {
        await store.append("session", [
          { role: "user", content: "${worker}:" + n + ":user" },
          { role: "assistant", content: "${worker}:" + n + ":assistant" },
        ]);
      }
    `));
    try {
      await finished;
      const history = (await store.load("session"))!.map((message) => String(message.content));
      expect(history).toHaveLength(180);
      expect(new Set(history).size).toBe(180);
      for (let worker = 0; worker < 3; worker++) {
        expect(history.filter((content) => content.startsWith(`${worker}:`))).toEqual(Array.from({ length: 30 }, (_, n) => [`${worker}:${n}:user`, `${worker}:${n}:assistant`]).flat());
      }
      for (let index = 0; index < history.length; index += 2) expect(history[index + 1]).toBe(history[index]!.replace(/user$/, "assistant"));
      expect(messages(db).map((row) => (row as { seq: number }).seq)).toEqual(Array.from({ length: 180 }, (_, i) => i));
    } finally {
      for (const worker of workers) worker.kill();
      await Promise.all(workers.map((worker) => worker.exited));
      db.$client.close();
    }
  }, 15_000);

  test("loads one coherent generation while another process compacts", async () => {
    const { db, path, store } = database();
    const version = (n: number): ModelMessage[] => Array.from({ length: 16 }, (_, seq) => ({ role: "user", content: `${n}:${seq}` }));
    await store.append("session", version(0));
    const { workers, finished } = await startWorkers(path, [`
      for (let n = 1; n <= 80; n++) {
        await store.compact("session", Array.from({ length: 16 }, (_, seq) => ({ role: "user", content: n + ":" + seq })));
        await Bun.sleep(1);
      }
    `]);
    let done = false;
    const completion = finished.finally(() => { done = true; });
    try {
      let reads = 0;
      while (!done) {
        const history = (await store.load("session"))!;
        const generation = Number(String(history[0]?.content).split(":")[0]);
        expect(history).toEqual(version(generation));
        reads++;
        await Bun.sleep(1);
      }
      await completion;
      expect(reads).toBeGreaterThan(1);
      expect(await store.load("session")).toEqual(version(80));
      expect(messages(db)).toHaveLength(16);
    } finally {
      for (const worker of workers) worker.kill();
      await Promise.all(workers.map((worker) => worker.exited));
      db.$client.close();
    }
  }, 15_000);
});
