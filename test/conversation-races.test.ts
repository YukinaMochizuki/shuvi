import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "agent-runtime/openai-compat";
import { conversationStore, LostConversationError } from "../src/store/conversations.ts";
import { openDb, type Db } from "../src/store/db.ts";
import { resetConversation } from "../src/store/events.ts";
import { claimTurn, saveSession } from "../src/store/turns.ts";
import { ownerChatId, ownerSays } from "./helpers.ts";

const dirs: string[] = [];
const processes: ReturnType<typeof Bun.spawn>[] = [];
const databases: Db[] = [];
afterEach(async () => {
  for (const child of processes) child.kill();
  await Promise.all(processes.splice(0).map((child) => child.exited));
  for (const db of databases.splice(0)) db.$client.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const future = "9999-01-01T00:00:00.000Z";
const original: ModelMessage[] = [{ role: "user", content: "old history" }];
const appended: ModelMessage[] = [{ role: "user", content: "append one" }, { role: "assistant", content: "append two" }];
const summary: ModelMessage[] = [{ role: "user", content: "summary one" }, { role: "assistant", content: "summary two" }];
const append = `await store.append("session", ${JSON.stringify(appended)}); return "appended";`;
const compact = `await store.compact("session", ${JSON.stringify(summary)}); return "compacted";`;
const prune = `return pruneConversations(db, ${JSON.stringify(future)});`;
// Pause on the second new row so an earlier batch row must still be invisible to readers.
const appendPause = "after insert on conversation_messages when new.seq = 2";
const compactPause = "after insert on conversation_messages when new.seq = 1";

async function database() {
  const dir = mkdtempSync(join(tmpdir(), "shuvi-conversation-race-"));
  dirs.push(dir);
  const path = join(dir, "shuvi.db");
  const db = openDb(path, { migrate: true });
  databases.push(db);
  ownerSays(db, "start a turn");
  const chatId = ownerChatId(db);
  const store = conversationStore(db, chatId);
  await store.append("session", original);
  db.$client.query("update conversations set written_at = '2020-01-01T00:00:00.000Z'").run();
  return { dir, path, db, chatId, store };
}

type World = Awaited<ReturnType<typeof database>>;

async function* lines(stream: ReadableStream<Uint8Array>) {
  let pending = "";
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      yield pending.slice(0, newline);
      pending = pending.slice(newline + 1);
    }
  }
}

function worker(world: World, action: string, pause?: string) {
  const gate = join(world.dir, `worker-${processes.length}`);
  const script = `
    import { existsSync, writeSync } from "node:fs";
    import { openDb } from ${JSON.stringify(new URL("../src/store/db.ts", import.meta.url).href)};
    import { conversationStore, pruneConversations } from ${JSON.stringify(new URL("../src/store/conversations.ts", import.meta.url).href)};
    import { resetConversation } from ${JSON.stringify(new URL("../src/store/events.ts", import.meta.url).href)};
    import { claimTurn, finishTurn, saveSession, setTurnConversation } from ${JSON.stringify(new URL("../src/store/turns.ts", import.meta.url).href)};
    const db = openDb(${JSON.stringify(world.path)});
    const chatId = ${world.chatId};
    const store = conversationStore(db, chatId);
    const announce = (name) => writeSync(1, name + "\\n");
    function checkpoint(name) {
      announce(name);
      const deadline = Date.now() + 10_000;
      // The release file is the barrier; polling only waits for its explicit signal.
      while (!existsSync(${JSON.stringify(gate)} + "-" + name)) {
        if (Date.now() > deadline) throw new Error("timed out at " + name);
        Bun.sleepSync(1);
      }
      return 0;
    }
    db.$client.exec("PRAGMA busy_timeout = 0");
    ${pause ? `db.$client.function("pause_write", () => checkpoint("locked"));
    db.$client.exec(${JSON.stringify(`create temp trigger pause_write ${pause} begin select pause_write(); end;`)});` : ""}
    checkpoint("ready");
    const operation = async () => { ${action} };
    let result;
    try {
      result = await operation();
    } catch (error) {
      let cause = error;
      while (cause.cause) cause = cause.cause;
      if (cause.code !== "SQLITE_BUSY") throw error;
      checkpoint("busy");
      result = await operation();
    }
    announce("result:" + JSON.stringify(result));
    db.$client.close();
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  processes.push(child);
  const output = lines(child.stdout);
  const errors = new Response(child.stderr).text();
  return {
    async wait(expected: string) {
      const line = await output.next();
      if (line.done) throw new Error(`worker exited ${await child.exited}: ${await errors}`);
      expect(line.value).toBe(expected);
    },
    release(name: string) { writeFileSync(`${gate}-${name}`, "release"); },
    async result(expected: unknown) {
      await this.wait(`result:${JSON.stringify(expected)}`);
      expect(await child.exited).toBe(0);
      expect(await errors).toBe("");
    },
  };
}

async function contend(world: World, firstAction: string, pause: string, secondAction: string) {
  const first = worker(world, firstAction, pause);
  const second = worker(world, secondAction);
  await Promise.all([first.wait("ready"), second.wait("ready")]);
  first.release("ready");
  await first.wait("locked");
  second.release("ready");
  await second.wait("busy");
  return { first, second };
}

function checkRows(world: World, expected: ModelMessage[], generation: number) {
  const rows = world.db.$client.query("select generation, seq, message from conversation_messages order by seq").all() as { generation: number; seq: number; message: string }[];
  expect(rows.map((row) => row.generation)).toEqual(expected.map(() => generation));
  expect(rows.map((row) => row.seq)).toEqual(expected.map((_, seq) => seq));
  expect(rows.map((row) => JSON.parse(row.message))).toEqual(expected);
  expect(world.db.$client.query("pragma foreign_key_check").all()).toEqual([]);
  expect(world.db.$client.query("select m.* from conversation_messages m left join conversations c on c.id = m.conversation_id where c.id is null").all()).toEqual([]);
}

for (const appendFirst of [true, false]) {
  test(`unprotected append/prune serializes with ${appendFirst ? "append" : "prune"} holding the lock first`, async () => {
    const world = await database();
    const before = world.db.$client.query("select * from conversations").all();
    const { first, second } = await contend(world, appendFirst ? append : prune, appendFirst ? appendPause : "after delete on conversations", appendFirst ? prune : append);
    expect(await world.store.load("session")).toEqual(original);
    expect(world.db.$client.query("select * from conversations").all()).toEqual(before);
    first.release("locked");
    await first.result(appendFirst ? "appended" : 1);
    if (appendFirst) expect(await world.store.load("session")).toEqual([...original, ...appended]);
    else await expect(world.store.load("session")).rejects.toBeInstanceOf(LostConversationError);
    second.release("busy");
    await second.result(appendFirst ? 1 : "appended");
    if (appendFirst) {
      await expect(world.store.load("session")).rejects.toBeInstanceOf(LostConversationError);
      expect(world.db.$client.query("select * from conversations").all()).toEqual([]);
      checkRows(world, [], 0);
    } else {
      expect(await world.store.load("session")).toEqual(appended);
      checkRows(world, appended, 0);
    }
  });

  test(`compact/append serializes with ${appendFirst ? "append" : "compact"} holding the lock first`, async () => {
    const world = await database();
    const { first, second } = await contend(world, appendFirst ? append : compact, appendFirst ? appendPause : compactPause, appendFirst ? compact : append);
    expect(await world.store.load("session")).toEqual(original);
    expect(world.db.$client.query("select generation from conversations").get()).toEqual({ generation: 0 });
    first.release("locked");
    await first.result(appendFirst ? "appended" : "compacted");
    expect(await world.store.load("session")).toEqual(appendFirst ? [...original, ...appended] : summary);
    second.release("busy");
    await second.result(appendFirst ? "compacted" : "appended");
    const expected = appendFirst ? summary : [...summary, ...appended];
    expect(await world.store.load("session")).toEqual(expected);
    expect(world.db.$client.query("select generation from conversations").get()).toEqual({ generation: 1 });
    checkRows(world, expected, 1);
  });
}

for (const finishing of [false, true]) {
  test(`prune observes a competing turn ${finishing ? "finishing" : "being claimed"}`, async () => {
    const world = await database();
    const turn = finishing ? claimTurn(world.db, world.chatId)! : null;
    const action = finishing ? `finishTurn(db, ${turn!.id}, { status: "done" }); return "done";` : 'return claimTurn(db, chatId).status;';
    const pause = finishing ? "after update of status on turns" : "after insert on turns";
    const { first, second } = await contend(world, action, pause, prune);
    expect(world.db.$client.query("select status from turns").all()).toEqual(finishing ? [{ status: "running" }] : []);
    expect(await world.store.load("session")).toEqual(original);
    first.release("locked");
    await first.result(finishing ? "done" : "running");
    second.release("busy");
    await second.result(finishing ? 1 : 0);
    if (finishing) {
      await expect(world.store.load("session")).rejects.toBeInstanceOf(LostConversationError);
      checkRows(world, [], 0);
    } else {
      expect(await world.store.load("session")).toEqual(original);
      checkRows(world, original, 0);
    }
  });
}

test("/new and pruning before a runner's first session callback preserve its history", async () => {
  const world = await database();
  saveSession(world.db, world.chatId, "session");
  const turn = claimTurn(world.db, world.chatId)!;
  const runner = worker(world, `
    checkpoint("before-session");
    const onSessionId = (id) => {
      saveSession(db, chatId, id);
      setTurnConversation(db, ${turn.id}, { backendSessionId: id });
    };
    onSessionId("session");
    await store.append("session", ${JSON.stringify(appended)});
    finishTurn(db, ${turn.id}, { status: "done" });
    return "done";
  `);
  await runner.wait("ready");
  runner.release("ready");
  await runner.wait("before-session");
  const controller = worker(world, 'resetConversation(db, chatId); return "reset";');
  await controller.wait("ready");
  controller.release("ready");
  await controller.result("reset");
  expect(world.db.$client.query("select backend_session_id from chats").get()).toEqual({ backend_session_id: null });
  expect(world.db.$client.query("select status, backend_session_id from turns").get()).toEqual({ status: "running", backend_session_id: null });
  const pruner = worker(world, prune);
  await pruner.wait("ready");
  pruner.release("ready");
  await pruner.result(0);
  expect(await world.store.load("session")).toEqual(original);
  runner.release("before-session");
  await runner.result("done");
  expect(await world.store.load("session")).toEqual([...original, ...appended]);
  checkRows(world, [...original, ...appended], 0);
  resetConversation(world.db, world.chatId);
  const expired = worker(world, prune);
  await expired.wait("ready");
  expired.release("ready");
  await expired.result(1);
  await expect(world.store.load("session")).rejects.toBeInstanceOf(LostConversationError);
  checkRows(world, [], 0);
});
