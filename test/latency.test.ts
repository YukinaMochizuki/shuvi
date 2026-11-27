import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Api } from "grammy";
import { runTurn } from "../src/agent/turn.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import { Kick, loop } from "../src/server/loop.ts";
import { sendPass } from "../src/server/sender.ts";
import { onWake, recordServerProcess, serverProcess, wakeServer } from "../src/server/wake.ts";
import { wakerPass } from "../src/server/waker.ts";
import { enqueueOutbound, getEvent, onTurnRowQueued } from "../src/store/events.ts";
import { claimTurn, getTurn, markTurn } from "../src/store/turns.ts";
import { FakeTelegram, memDb, ownerChatId, ownerSays, ScriptedAdapter } from "./helpers.ts";

/** Resolves once `cond` holds, polling every 5 ms; rejects after `ms`. */
async function until(cond: () => boolean, ms = 2000): Promise<number> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await Bun.sleep(5);
  }
  return Date.now() - t0;
}

describe("loop: kick", () => {
  test("a kick ends the wait at once; without one the interval holds", async () => {
    const stop = new AbortController();
    const kick = new Kick();
    let runs = 0;
    const done = loop("test", async () => void runs++, 60_000, stop.signal, kick);
    await until(() => runs === 1);
    await Bun.sleep(50);
    expect(runs).toBe(1);
    kick.kick();
    expect(await until(() => runs === 2)).toBeLessThan(500);
    kick.kick();
    await until(() => runs === 3);
    stop.abort();
    await done;
  });

  test("a kick during a run ends the wait after it; one before the run is that run's", async () => {
    const stop = new AbortController();
    const kick = new Kick();
    let runs = 0;
    const done = loop(
      "test",
      async () => {
        runs++;
        if (runs === 1) {
          // Written while the pass runs: the next pass must not wait out the interval for it.
          await Bun.sleep(20);
          kick.kick();
        }
      },
      60_000,
      stop.signal,
      kick,
    );
    await until(() => runs === 2);
    await Bun.sleep(100);
    expect(runs).toBe(2);
    stop.abort();
    await done;
  });

  test("a wait the body asked for (a 429) and an error's backoff are not cut short", async () => {
    const stop = new AbortController();
    const kick = new Kick();
    let runs = 0;
    const asked = loop(
      "asked",
      async () => {
        runs++;
        return 60_000;
      },
      10,
      stop.signal,
      kick,
    );
    await until(() => runs === 1);
    kick.kick();
    await Bun.sleep(100);
    expect(runs).toBe(1);

    const errKick = new Kick();
    let failures = 0;
    const origError = console.error;
    console.error = () => {};
    const failing = loop(
      "failing",
      async () => {
        failures++;
        throw new Error("boom");
      },
      1000,
      stop.signal,
      errKick,
    );
    try {
      await until(() => failures === 1);
      errKick.kick();
      await Bun.sleep(100);
      expect(failures).toBe(1);
    } finally {
      console.error = origError;
    }
    stop.abort();
    await Promise.all([asked, failing]);
  });
});

describe("waking the sender from a runner child (server/wake.ts)", () => {
  const removers: (() => void)[] = [];
  afterEach(() => removers.splice(0).forEach((r) => r()));

  test("a row queued for a turn signals SIGUSR2 to the recorded server, which kicks its sender", async () => {
    const db = memDb();
    const kick = new Kick();
    removers.push(onWake(() => kick.kick()));
    // As a runner child installs it (runner/run.ts): the store calls the hook, the hook wakes the server.
    removers.push(onTurnRowQueued(wakeServer));
    recordServerProcess(db);
    expect(serverProcess(db)?.pid).toBe(process.pid);

    const stop = new AbortController();
    let passes = 0;
    const sender = loop("sender", async () => void passes++, 60_000, stop.signal, kick);
    await until(() => passes === 1);

    ownerSays(db, "hi");
    const turn = claimTurn(db, ownerChatId(db))!;
    enqueueOutbound(db, { chatId: turn.chatId, kind: "bot_message", payload: { text: "hello" }, idemKey: `turn:${turn.id}:0`, turnId: turn.id });
    expect(await until(() => passes === 2)).toBeLessThan(1000);

    // The same key again wrote nothing: no wake.
    await Bun.sleep(50);
    enqueueOutbound(db, { chatId: turn.chatId, kind: "bot_message", payload: { text: "hello" }, idemKey: `turn:${turn.id}:0`, turnId: turn.id });
    await Bun.sleep(100);
    expect(passes).toBe(2);
    stop.abort();
    await sender;
  });

  test("no server recorded, a start time that does not match, or none known: nothing is signalled", () => {
    const db = memDb();
    let kicks = 0;
    removers.push(onWake(() => kicks++));
    expect(wakeServer(db)).toBe(false);
    // This pid, but another process's start time (the pid reused): never signalled.
    db.$client.query("insert into kv (key, value) values ('server_process', ?)").run(JSON.stringify({ pid: process.pid, start: "1" }));
    expect(wakeServer(db)).toBe(false);
    // No start time (no /proc when it was recorded): the pid cannot be checked, so no signal.
    db.$client.query("update kv set value = ? where key = 'server_process'").run(JSON.stringify({ pid: process.pid, start: null }));
    expect(wakeServer(db)).toBe(false);
    expect(kicks).toBe(0);
  });

  test("a queued row for a turn never fails because the wake could not be sent", () => {
    const db = memDb();
    db.$client.query("insert into kv (key, value) values ('server_process', 'not json')").run();
    ownerSays(db, "hi");
    const turn = claimTurn(db, ownerChatId(db))!;
    expect(enqueueOutbound(db, { chatId: turn.chatId, kind: "bot_message", payload: { text: "x" }, idemKey: `turn:${turn.id}:0`, turnId: turn.id })).toBeNumber();
  });
});

describe("per-turn timings (turns.timings)", () => {
  const capabilities = enabledCapabilities({ SHUVI_WEB: "off", SHUVI_STICKERS: "off", SHUVI_SCHEDULES: "off", SHUVI_MEMORY: "off", SHUVI_RETRIEVAL: "off", SHUVI_PLAYBOOKS: "off", SHUVI_RELEASES: "off", SHUVI_GROUPS: "off" });

  test("the waker marks the claim and the spawn; the turn marks the driver's call, first output, first row and return", async () => {
    const db = memDb();
    ownerSays(db, "hello");
    const t0 = Date.now();
    const { started } = wakerPass({ db, spawn: () => process.pid, startOf: () => "1", alive: () => true });
    expect(started.length).toBe(1);
    const id = started[0]!;
    const waker = getTurn(db, id)!.timings!;
    expect(Object.keys(waker).sort()).toEqual(["claimed", "spawned"]);
    expect(waker.claimed).toBeGreaterThanOrEqual(t0);
    expect(waker.spawned).toBeGreaterThanOrEqual(waker.claimed!);

    const outcome = await runTurn({
      db,
      turnId: id,
      home: mkdtempSync(join(tmpdir(), "shuvi-home-")),
      timeZone: "UTC",
      capabilities,
      makeAdapter: (b) =>
        new ScriptedAdapter(b, [
          { token: "thinking", thinking: true },
          { run: () => Bun.sleepSync(5) },
          { token: "Hi" },
          { tool: "say", args: { text: "a progress note" } },
          { token: "done" },
        ]),
    });
    expect(outcome).toBe("done");
    const t = getTurn(db, id)!.timings!;
    expect(Object.keys(t).sort()).toEqual(["claimed", "firstOutput", "query", "queuedFirst", "returned", "spawned"]);
    expect(t.query!).toBeGreaterThanOrEqual(t.spawned!);
    expect(t.firstOutput!).toBeGreaterThanOrEqual(t.query!);
    // The first row is the text before `say`, queued when the tool was announced, after the first output.
    expect(t.queuedFirst!).toBeGreaterThanOrEqual(t.firstOutput!);
    expect(t.returned!).toBeGreaterThanOrEqual(t.queuedFirst!);
  });

  test("a mark once written is kept; marks from two writers merge; a failure to write never throws", () => {
    const db = memDb();
    ownerSays(db, "hi");
    const turn = claimTurn(db, ownerChatId(db))!;
    markTurn(db, turn.id, { child: 1000.4, ready: 2000 });
    markTurn(db, turn.id, { ready: 3000, query: 4000 });
    expect(getTurn(db, turn.id)!.timings).toEqual({ child: 1000, ready: 2000, query: 4000 });
    const origError = console.error;
    console.error = () => {};
    try {
      db.$client.close();
      expect(() => markTurn(db, turn.id, { returned: 5000 })).not.toThrow();
    } finally {
      console.error = origError;
    }
  });

  test("a turn that never reached the driver has no driver marks", async () => {
    const db = memDb();
    ownerSays(db, "hi");
    const turn = claimTurn(db, ownerChatId(db))!;
    await runTurn({
      db,
      turnId: turn.id,
      home: mkdtempSync(join(tmpdir(), "shuvi-home-")),
      timeZone: "UTC",
      capabilities,
      makeAdapter: () => {
        throw new Error("no driver");
      },
    });
    expect(getTurn(db, turn.id)!.timings).toBeNull();
  });
});

describe("chat_events.sent_at", () => {
  let tg: FakeTelegram | null = null;
  afterEach(() => {
    tg?.stop();
    tg = null;
  });

  test("set by the sender when a row is marked sent; null while pending", async () => {
    const db = memDb();
    tg = new FakeTelegram();
    const api = new Api("TOKEN", { apiRoot: tg.apiRoot });
    const chatId = ownerChatId(db);
    const seq = enqueueOutbound(db, { chatId, kind: "bot_message", payload: { text: "one" }, idemKey: "t:0" })!;
    expect(getEvent(db, seq)!.sentAt).toBeNull();
    const before = new Date().toISOString();
    expect((await sendPass(db, api)).sent).toBe(1);
    const row = getEvent(db, seq)!;
    expect(row.status).toBe("sent");
    expect(row.sentAt).not.toBeNull();
    expect(row.sentAt! >= before).toBe(true);
    expect(new Date(row.sentAt!).toISOString()).toBe(row.sentAt!);
  });
});
