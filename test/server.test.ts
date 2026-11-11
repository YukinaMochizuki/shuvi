import { afterEach, describe, expect, test } from "bun:test";
import { Api } from "grammy";
import { CONTROL_COMMANDS } from "../src/control/bot.ts";
import { DM_DEFAULT, GROUP_DEFAULTS, type Policy } from "../src/policy/policy.ts";
import { commandPass, GroupMenus, MAIN_COMMANDS, registerCommands } from "../src/server/commands.ts";
import { classify } from "../src/telegram/inbound.ts";
import { currentOffset, pollOnce, recordBatch } from "../src/server/poller.ts";
import { sendPass } from "../src/server/sender.ts";
import { SPAWN_GRACE_MS, wakerPass } from "../src/server/waker.ts";
import { enqueueOutbound, getChat, getEvent, pendingOutbound, type BotMessagePayload } from "../src/store/events.ts";
import { claimTurn, finishTurn, getTurn, MAX_ATTEMPTS, RETRY_BASE_MS, runningTurns, saveSession, setTurnPid } from "../src/store/turns.ts";
import { dmUpdate, FakeTelegram, memDb, OWNER, ownerChatId, ownerSays } from "./helpers.ts";

let tg: FakeTelegram | null = null;
afterEach(() => {
  tg?.stop();
  tg = null;
});
const fakeApi = () => {
  tg = new FakeTelegram();
  return new Api("TOKEN", { apiRoot: tg.apiRoot });
};

describe("poller", () => {
  test("records a batch and moves the offset past it; a re-delivered batch is recorded once", () => {
    const db = memDb();
    const batch = [dmUpdate(10, "a"), dmUpdate(11, "b"), dmUpdate(12, "not the owner", 777)];
    expect(recordBatch(db, batch, OWNER)).toEqual({ recorded: 2, ignored: 1 });
    expect(currentOffset(db)).toBe(13);
    expect(recordBatch(db, batch, OWNER).recorded).toBe(0);
  });

  test("if recording fails, the offset does not move, so Telegram delivers the batch again", () => {
    const db = memDb();
    recordBatch(db, [dmUpdate(1, "first")], OWNER);
    db.$client.exec("DROP TABLE chat_events");
    expect(() => recordBatch(db, [dmUpdate(2, "lost?")], OWNER)).toThrow();
    expect(currentOffset(db)).toBe(2);
  });

  test("passes the stored offset to getUpdates", async () => {
    const db = memDb();
    const api = fakeApi();
    tg!.updates.push(dmUpdate(5, "hi"));
    await pollOnce(db, api, OWNER, undefined, 0);
    await pollOnce(db, api, OWNER, undefined, 0);
    const offsets = tg!.calls.filter((c) => c.method === "getUpdates").map((c) => c.body.offset);
    expect(offsets).toEqual([undefined, 6]);
    expect(db.$client.query("select count(*) as n from chat_events").get()).toEqual({ n: 1 });
  });
});

describe("waker", () => {
  test("starts one turn per chat with something to answer, and no second while it runs", () => {
    const db = memDb();
    ownerSays(db, "hi");
    const spawned: number[] = [];
    const spawn = (id: number) => (spawned.push(id), 4242);
    wakerPass({ db, spawn, alive: () => true });
    ownerSays(db, "again");
    wakerPass({ db, spawn, alive: () => true });
    expect(spawned.length).toBe(1);
    expect(getTurn(db, spawned[0]!)!.pid).toBe(4242);
  });

  test("reaps a turn whose process died, and retries its messages after a backoff that doubles", () => {
    const db = memDb();
    ownerSays(db, "hi");
    const spawned: number[] = [];
    const spawn = (id: number) => (spawned.push(id), 1);
    wakerPass({ db, spawn, alive: () => true });
    const r = wakerPass({ db, spawn, alive: () => false });
    expect(r.reaped).toEqual([spawned[0]!]);
    expect(getTurn(db, spawned[0]!)!.status).toBe("failed");
    expect(r.started).toEqual([]); // not straight away
    expect(getChat(db, ownerChatId(db))!.cursorSeq).toBe(0);
    const failedAt = Date.parse(getTurn(db, spawned[0]!)!.endedAt!);
    expect(wakerPass({ db, spawn, alive: () => false, now: () => failedAt + RETRY_BASE_MS - 1 }).started).toEqual([]);
    expect(wakerPass({ db, spawn, alive: () => false, now: () => failedAt + RETRY_BASE_MS + 1 }).started.length).toBe(1);
  });

  test("a spawn that always fails is retried with backoff, then the message is given up after MAX_ATTEMPTS", () => {
    const db = memDb();
    const seq = ownerSays(db, "hi");
    let clock = Date.now();
    const failing = () => {
      throw new Error("ENOENT");
    };
    for (let i = 0; i < 20; i++) {
      wakerPass({ db, spawn: failing, now: () => clock });
      clock += 60 * 60 * 1000; // far past any backoff
    }
    expect(db.$client.query("select count(*) as n from turns").get()).toEqual({ n: MAX_ATTEMPTS });
    expect(getChat(db, ownerChatId(db))!.cursorSeq).toBe(seq);
  });

  test("a turn whose spawn never recorded a pid is reaped after the grace period", () => {
    const db = memDb();
    ownerSays(db, "hi");
    const t = claimTurn(db, ownerChatId(db))!;
    const startedAt = Date.parse(t.startedAt);
    expect(wakerPass({ db, spawn: () => 1, now: () => startedAt + 1000 }).reaped).toEqual([]);
    expect(wakerPass({ db, spawn: () => 1, alive: () => true, now: () => startedAt + SPAWN_GRACE_MS + 1 }).reaped).toEqual([t.id]);
  });
});

describe("commands", () => {
  test("/stop signals the running turn's process and acknowledges with 👌, saying nothing", () => {
    const db = memDb();
    ownerSays(db, "long task");
    const t = claimTurn(db, ownerChatId(db))!;
    setTurnPid(db, t.id, 31337);
    recordBatch(db, [dmUpdate(900, "/stop")], OWNER);
    const killed: number[] = [];
    commandPass(db, (pid) => killed.push(pid));
    expect(killed).toEqual([31337]);
    const out = pendingOutbound(db);
    expect(out.map((e) => e.kind)).toEqual(["bot_reaction"]);
    expect(out[0]!.payload).toMatchObject({ emoji: "👌" });
    expect(commandPass(db, () => {})).toBe(0); // handled once
  });

  test("what the owner sends after /stop is not swallowed by the stopped turn", () => {
    const db = memDb();
    const first = ownerSays(db, "long task");
    const chatId = ownerChatId(db);
    const t = claimTurn(db, chatId)!;
    setTurnPid(db, t.id, 31337);
    recordBatch(db, [dmUpdate(902, "/stop")], OWNER);
    commandPass(db, () => {});
    // The child reached a tool boundary before the SIGTERM landed and was shown a message sent after /stop.
    const after = ownerSays(db, "never mind, do B instead");
    db.$client.exec(`update turns set to_seq = ${after} where id = ${t.id}`);
    finishTurn(db, t.id, { status: "stopped" });
    expect(getChat(db, chatId)!.cursorSeq).toBe(first);
    expect(claimTurn(db, chatId)).not.toBeNull(); // "B" gets its own turn
  });

  test("/new forgets the model's conversation but keeps the chat's events and cursor", () => {
    const db = memDb();
    ownerSays(db, "hi");
    const chatId = ownerChatId(db);
    saveSession(db, chatId, "sess-1");
    recordBatch(db, [dmUpdate(901, "/new")], OWNER);
    commandPass(db, () => {});
    expect(getChat(db, chatId)!.backendSessionId).toBeNull();
    expect(runningTurns(db)).toEqual([]);
    expect(db.$client.query("select count(*) as n from chat_events where kind = 'message'").get()).toEqual({ n: 1 });
  });

  test("each bot's command menu is registered for the owner's chat only, idempotently", async () => {
    const api = fakeApi();
    expect(await registerCommands(api, OWNER, MAIN_COMMANDS, "main bot")).toBe(true);
    expect(await registerCommands(api, OWNER, MAIN_COMMANDS, "main bot")).toBe(true);
    expect(await registerCommands(api, OWNER, CONTROL_COMMANDS, "control bot")).toBe(true);
    const scope = { type: "chat", chat_id: OWNER };
    const main = { scope, commands: [{ command: "new", description: expect.any(String) }, { command: "stop", description: expect.any(String) }] };
    const control = { scope, commands: [{ command: "status", description: expect.any(String) }, { command: "stop", description: expect.stringContaining("<chat>") }, { command: "policy", description: expect.stringContaining("<chat>") }, { command: "turn", description: expect.stringContaining("<id>") }] };
    expect(tg!.sent("setMyCommands")).toEqual([main, main, control]);
  });

  test("a Telegram error while registering commands is logged, not thrown", async () => {
    const api = fakeApi();
    tg!.fail("setMyCommands", { code: 400, description: "Bad Request: chat not found" });
    expect(await registerCommands(api, OWNER, MAIN_COMMANDS, "main bot")).toBe(false);
  });

  describe("the owner's menu in groups", () => {
    // Made-up group ids.
    const A = -1000000000001;
    const B = -1000000000002;
    const C = -1000000000003;
    const policyOf = (...groups: number[]): Policy => ({ chats: { dm: DM_DEFAULT, ...Object.fromEntries(groups.map((g) => [String(g), GROUP_DEFAULTS])) }, unknownChat: "ignore" });
    const memberScope = (g: number) => ({ type: "chat_member", chat_id: g, user_id: OWNER });
    const commands = [{ command: "new", description: expect.any(String) }, { command: "stop", description: expect.any(String) }];

    test("each listed group gets the commands for the owner only; the DM is not a group", async () => {
      const api = fakeApi();
      const menus = new GroupMenus(api, OWNER);
      expect(await menus.sync(policyOf(A, B))).toBe(2);
      expect(tg!.sent("setMyCommands")).toEqual([
        { scope: memberScope(B), commands },
        { scope: memberScope(A), commands },
      ]);
      expect(tg!.sent("deleteMyCommands")).toEqual([]);
    });

    test("no call while the listed groups stay the same, whatever else in policy changes", async () => {
      const api = fakeApi();
      const menus = new GroupMenus(api, OWNER);
      await menus.sync(policyOf(A, B));
      expect(await menus.sync(policyOf(A, B))).toBe(0);
      const retitled = policyOf(B, A);
      retitled.chats[String(A)] = { ...GROUP_DEFAULTS, title: "Fake Book Club" };
      expect(await menus.sync(retitled)).toBe(0);
      expect(tg!.sent("setMyCommands").length).toBe(2);
    });

    test("after a policy change, a group added gets the menu and a group removed has its scope cleared", async () => {
      const api = fakeApi();
      const menus = new GroupMenus(api, OWNER);
      await menus.sync(policyOf(A, B));
      expect(await menus.sync(policyOf(A, C))).toBe(2);
      expect(tg!.sent("setMyCommands").map((b) => b.scope)).toEqual([memberScope(B), memberScope(A), memberScope(C)]);
      expect(tg!.sent("deleteMyCommands")).toEqual([{ scope: memberScope(B) }]);
      expect(await menus.sync(policyOf())).toBe(2);
      expect(tg!.sent("deleteMyCommands").map((b) => b.scope)).toEqual([memberScope(B), memberScope(A), memberScope(C)]);
    });

    test("one group failing is logged; the others still register, and it is tried again at the next change", async () => {
      const api = fakeApi();
      const menus = new GroupMenus(api, OWNER);
      // Sorted by id, C is registered first: it fails.
      tg!.fail("setMyCommands", { code: 400, description: "Bad Request: chat not found" });
      expect(await menus.sync(policyOf(A, B, C))).toBe(3);
      expect(tg!.sent("setMyCommands").map((b) => b.scope)).toEqual([memberScope(C), memberScope(B), memberScope(A)]);
      // The next change retries C alongside the removal of B; A is left alone.
      expect(await menus.sync(policyOf(A, C))).toBe(2);
      expect(tg!.sent("setMyCommands").map((b) => b.scope).slice(3)).toEqual([memberScope(C)]);
      expect(tg!.sent("deleteMyCommands").map((b) => b.scope)).toEqual([memberScope(B)]);
    });

    test("a failed clear is tried again at the next change", async () => {
      const api = fakeApi();
      const menus = new GroupMenus(api, OWNER);
      await menus.sync(policyOf(A));
      tg!.fail("deleteMyCommands", { code: 403, description: "Forbidden: bot was kicked from the supergroup chat" });
      expect(await menus.sync(policyOf())).toBe(1);
      expect(await menus.sync(policyOf(B))).toBe(2);
      expect(tg!.sent("deleteMyCommands").map((b) => b.scope)).toEqual([memberScope(A), memberScope(A)]);
    });
  });

  test("the menu and inbound recognise the same commands", () => {
    for (const [i, c] of MAIN_COMMANDS.entries()) {
      expect(classify(dmUpdate(950 + i, `/${c.command}`), OWNER)).toMatchObject({ kind: "command", payload: { command: c.command } });
    }
  });
});

describe("sender", () => {
  test("delivers in order, as HTML, and records the Telegram id; a delivered row is never sent again", async () => {
    const db = memDb();
    const api = fakeApi();
    const chatId = ownerChatId(db);
    enqueueOutbound(db, { chatId, kind: "bot_message", payload: { text: "**one**" }, idemKey: "t:0" });
    enqueueOutbound(db, { chatId, kind: "bot_message", payload: { text: "two" }, idemKey: "t:1" });
    expect((await sendPass(db, api)).sent).toBe(2);
    expect(tg!.sent().map((b) => [b.text, b.parse_mode])).toEqual([["<b>one</b>", "HTML"], ["two", "HTML"]]);
    expect(pendingOutbound(db)).toEqual([]);
    await sendPass(db, api);
    expect(tg!.sent().length).toBe(2);
  });

  test("a long message goes out in parts; after a crash between parts only the rest is sent", async () => {
    const db = memDb();
    const api = fakeApi();
    const chatId = ownerChatId(db);
    const para = "x".repeat(3000);
    enqueueOutbound(db, { chatId, kind: "bot_message", payload: { text: `${para}\n\n${para}\n\n${para}`, sentParts: [111] }, idemKey: "t:0" });
    await sendPass(db, api);
    expect(tg!.sent().length).toBe(2); // part 1 was already delivered before the "crash"
    const row = db.$client.query("select payload from chat_events").get() as { payload: string };
    expect((JSON.parse(row.payload) as BotMessagePayload).sentParts!.length).toBe(3);
  });

  test("429 waits and keeps the row (and everything after it) pending", async () => {
    const db = memDb();
    const api = fakeApi();
    const chatId = ownerChatId(db);
    enqueueOutbound(db, { chatId, kind: "bot_message", payload: { text: "a" }, idemKey: "t:0" });
    enqueueOutbound(db, { chatId, kind: "bot_message", payload: { text: "b" }, idemKey: "t:1" });
    tg!.fail("sendMessage", { code: 429, description: "Too Many Requests: retry after 3", retry_after: 3 });
    const r = await sendPass(db, api);
    expect(r.backoffMs).toBe(3500);
    expect(pendingOutbound(db).length).toBe(2);
    await sendPass(db, api);
    expect(tg!.sent().slice(-2).map((b) => b.text)).toEqual(["a", "b"]);
  });

  test("HTML Telegram refuses is resent as plain text", async () => {
    const db = memDb();
    const api = fakeApi();
    enqueueOutbound(db, { chatId: ownerChatId(db), kind: "bot_message", payload: { text: "**x**" }, idemKey: "t:0" });
    tg!.fail("sendMessage", { code: 400, description: "Bad Request: can't parse entities" });
    await sendPass(db, api);
    const last = tg!.sent().at(-1)!;
    expect(last.text).toBe("**x**");
    expect(last.parse_mode).toBeUndefined();
  });

  test("another 4xx fails the row with Telegram's reason and moves on", async () => {
    const db = memDb();
    const api = fakeApi();
    const chatId = ownerChatId(db);
    enqueueOutbound(db, { chatId, kind: "bot_message", payload: { text: "a" }, idemKey: "t:0" });
    enqueueOutbound(db, { chatId, kind: "bot_message", payload: { text: "b" }, idemKey: "t:1" });
    tg!.fail("sendMessage", { code: 403, description: "Forbidden: bot was blocked by the user" });
    const r = await sendPass(db, api);
    expect(r).toMatchObject({ sent: 1, failed: 1 });
    expect(db.$client.query("select note from chat_events where status = 'failed'").get()).toEqual({ note: "403 Forbidden: bot was blocked by the user" });
  });

  test("a reaction targets the Telegram id of the event it names", async () => {
    const db = memDb();
    const api = fakeApi();
    const seq = ownerSays(db, "hi");
    enqueueOutbound(db, { chatId: ownerChatId(db), kind: "bot_reaction", payload: { targetSeq: seq, emoji: "❤" }, idemKey: "t:0" });
    await sendPass(db, api);
    const call = tg!.sent("setMessageReaction")[0]!;
    expect(call.message_id).toBe(getEvent(db, seq)!.tgMessageId);
    expect(call.reaction).toEqual([{ type: "emoji", emoji: "❤" }]);
  });
});
