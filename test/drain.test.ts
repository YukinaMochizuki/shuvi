import { describe, expect, test } from "bun:test";
import { drain, type DrainDeps } from "../src/server/drain.ts";
import { wakerPass } from "../src/server/waker.ts";
import type { Db } from "../src/store/db.ts";
import { enqueueOutbound, getChat, markSent } from "../src/store/events.ts";
import { claimTurn, DRAIN_STOP, finishTurn, getTurn, runningTurns, setTurnPid } from "../src/store/turns.ts";
import { memDb, ownerChatId, ownerSays } from "./helpers.ts";

/**
 * The drain (server/drain.ts) on a fake clock: `sleep` advances it and runs what the test scheduled for that
 * time (a turn ending, a message delivered), so the store changes the way the runner child and the sender
 * would change it from their own processes.
 */
function clock() {
  let t = 1_000_000;
  const at: Array<{ when: number; run: () => void }> = [];
  return {
    now: () => t,
    after: (ms: number, run: () => void) => at.push({ when: t + ms, run }),
    sleep: async (ms: number) => {
      t += ms;
      for (const a of at.splice(0).sort((x, y) => x.when - y.when)) {
        if (a.when <= t) a.run();
        else at.push(a);
      }
    },
  };
}

/** A chat with an owner message and a turn running for it, as the waker leaves it. */
function running(db: Db) {
  const seq = ownerSays(db, "hello");
  const turn = claimTurn(db, ownerChatId(db))!;
  setTurnPid(db, turn.id, 4242, "1");
  return { turn, seq };
}

const reply = (db: Db, turnId: number, n = 1) =>
  enqueueOutbound(db, { chatId: ownerChatId(db), kind: "bot_message", payload: { text: `reply ${n}` }, idemKey: `turn:${turnId}:${n}`, turnId })!;

const cursor = (db: Db) => getChat(db, ownerChatId(db))!.cursorSeq;
const alerts = (db: Db) => db.$client.query("select idem_key as k, text from control_messages").all() as { k: string; text: string }[];

describe("drain", () => {
  test("waits for the running turn and its message, then returns without signalling anything", async () => {
    const db = memDb();
    const c = clock();
    const { turn, seq } = running(db);
    const signals: string[] = [];
    // The turn writes its answer and ends at 5 s; the sender delivers it at 6 s.
    let row = 0;
    c.after(5000, () => {
      row = reply(db, turn.id);
      finishTurn(db, turn.id, { status: "done" });
    });
    c.after(6000, () => markSent(db, row, 777));
    const deps: DrainDeps = { db, drainMs: 600_000, now: c.now, sleep: c.sleep, log: () => {}, signal: (_p, _s, sig) => void signals.push(sig), alive: () => true };
    const r = await drain(deps);
    expect(r).toEqual({ outcome: "idle", stopped: [], killed: [], pendingLeft: 0 });
    expect(c.now()).toBeGreaterThanOrEqual(1_006_000);
    expect(c.now()).toBeLessThan(1_010_000);
    expect(signals).toEqual([]);
    expect(getTurn(db, turn.id)!.status).toBe("done");
    expect(cursor(db)).toBe(seq);
  });

  test("returns at once when nothing runs and nothing waits", async () => {
    const db = memDb();
    const c = clock();
    const r = await drain({ db, drainMs: 600_000, now: c.now, sleep: c.sleep, log: () => {} });
    expect(r.outcome).toBe("idle");
    expect(c.now()).toBe(1_000_000);
  });

  test("a message Telegram keeps refusing is left for the next server after the flush window, not waited on to the deadline", async () => {
    const db = memDb();
    const c = clock();
    const { turn } = running(db);
    reply(db, turn.id);
    finishTurn(db, turn.id, { status: "done" });
    const r = await drain({ db, drainMs: 600_000, flushMs: 30_000, now: c.now, sleep: c.sleep, log: () => {} });
    expect(r).toEqual({ outcome: "idle", stopped: [], killed: [], pendingLeft: 1 });
    expect(c.now() - 1_000_000).toBeGreaterThanOrEqual(30_000);
    expect(c.now() - 1_000_000).toBeLessThan(31_000);
  });

  test("at the deadline a running turn is stopped like a switch stops it: it closes as stopped, the cursor stays, and the next server answers again", async () => {
    const db = memDb();
    const c = clock();
    const { turn } = running(db);
    const before = cursor(db);
    reply(db, turn.id); // it already said something
    const signals: Array<[number, string]> = [];
    // The child treats SIGTERM as a stop and closes its own turn, as runner/child.ts does.
    const signal: DrainDeps["signal"] = (pid, _s, sig) => {
      signals.push([pid, sig]);
      if (sig === "SIGTERM") c.after(500, () => finishTurn(db, turn.id, { status: "stopped" }));
    };
    const r = await drain({ db, drainMs: 10_000, graceMs: 15_000, flushMs: 0, now: c.now, sleep: c.sleep, log: () => {}, signal, alive: () => true });
    expect(r.outcome).toBe("deadline");
    expect(r.stopped).toEqual([turn.id]);
    expect(r.killed).toEqual([]);
    expect(signals).toEqual([[4242, "SIGTERM"]]);
    const t = getTurn(db, turn.id)!;
    expect(t.status).toBe("stopped");
    expect(t.stopSeq).toBe(t.fromSeq);
    expect(cursor(db)).toBe(before);
    expect(alerts(db).map((a) => a.k)).toEqual([`drain-stop:${turn.id}`]);
    // A new server's waker starts a turn for the same message.
    const spawned: number[] = [];
    expect(runningTurns(db)).toEqual([]);
    wakerPass({ db, spawn: (id) => (spawned.push(id), 5151), alive: () => true, startOf: () => "2" });
    expect(spawned.length).toBe(1);
    expect(getTurn(db, spawned[0]!)!.fromSeq).toBe(before);
  });

  test("a turn that ignores the stop is killed after the grace and closed here, still as stopped with the cursor in place", async () => {
    const db = memDb();
    const c = clock();
    const { turn } = running(db);
    const before = cursor(db);
    let dead = false;
    const signals: string[] = [];
    const signal: DrainDeps["signal"] = (_p, _s, sig) => {
      signals.push(sig);
      if (sig === "SIGKILL") dead = true;
    };
    const r = await drain({ db, drainMs: 10_000, graceMs: 15_000, now: c.now, sleep: c.sleep, log: () => {}, signal, alive: () => !dead });
    expect(r).toMatchObject({ outcome: "deadline", stopped: [turn.id], killed: [turn.id] });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(c.now() - 1_000_000).toBeGreaterThanOrEqual(25_000);
    const t = getTurn(db, turn.id)!;
    expect(t.status).toBe("stopped");
    expect(t.error).toBe(DRAIN_STOP);
    expect(cursor(db)).toBe(before);
  });

  test("an owner's /stop placed before the deadline keeps its place: the cursor moves to it", async () => {
    const db = memDb();
    const c = clock();
    const { turn, seq } = running(db);
    db.$client.query("update turns set stop_seq = ? where id = ?").run(seq, turn.id);
    const signal: DrainDeps["signal"] = (_p, _s, sig) => {
      if (sig === "SIGTERM") c.after(100, () => finishTurn(db, turn.id, { status: "stopped" }));
    };
    await drain({ db, drainMs: 1000, now: c.now, sleep: c.sleep, log: () => {}, signal, alive: () => true });
    expect(getTurn(db, turn.id)!.stopSeq).toBe(seq);
    expect(cursor(db)).toBe(seq);
  });
});

describe("drain and the waker's reap, racing", () => {
  test("a turn killed after the grace that the waker reaps first closes as stopped, not failed: no retry alert, no attempt counted", async () => {
    const db = memDb();
    const c = clock();
    const { turn } = running(db);
    const before = cursor(db);
    // The child ignores SIGTERM; SIGKILL takes a moment (50 ms) to take it down.
    let killedAt: number | null = null;
    const alive = () => killedAt === null || c.now() < killedAt + 50;
    const signal: DrainDeps["signal"] = (_p, _s, sig) => {
      if (sig === "SIGKILL") killedAt = c.now();
    };
    // The server's waker loop runs beside the drain (reap only), as main.ts runs it: on every tick of the clock.
    const reaped: number[] = [];
    const sleep = async (ms: number) => {
      await c.sleep(ms);
      reaped.push(...wakerPass({ db, spawn: () => 1, alive, wake: false, now: c.now }).reaped);
    };
    const r = await drain({ db, drainMs: 10_000, graceMs: 15_000, now: c.now, sleep, log: () => {}, signal, alive });
    // The waker's pass right after the SIGKILL (while the drain waits for the process to go) closed it first.
    expect(reaped).toEqual([turn.id]);
    expect(r.killed).toEqual([turn.id]);
    const t = getTurn(db, turn.id)!;
    expect(t.status).toBe("stopped");
    expect(t.error).toBe(DRAIN_STOP);
    expect(cursor(db)).toBe(before);
    expect(alerts(db).map((a) => a.k)).toEqual([`drain-stop:${turn.id}`]); // no turn-failed alert
  });

  test("the waker's reap closes any dead turn that was being stopped as stopped, wherever its stop put the cursor", () => {
    const db = memDb();
    const { turn, seq } = running(db);
    db.$client.run("update turns set stop_seq = ? where id = ?", [seq, turn.id]); // an owner's /stop
    wakerPass({ db, spawn: () => 1, alive: () => false, wake: false });
    expect(getTurn(db, turn.id)!.status).toBe("stopped");
    expect(cursor(db)).toBe(seq);
  });
});

describe("waker while draining", () => {
  test("wake: false reaps a dead turn and starts nothing", () => {
    const db = memDb();
    const { turn } = running(db);
    const spawned: number[] = [];
    const r = wakerPass({ db, spawn: (id) => (spawned.push(id), 1), alive: () => false, wake: false });
    expect(r.reaped).toEqual([turn.id]);
    expect(r.started).toEqual([]);
    expect(spawned).toEqual([]);
    // The same pass with wake on would retry it (after the backoff); the drain leaves that to the next server.
    ownerSays(db, "another");
    expect(wakerPass({ db, spawn: (id) => (spawned.push(id), 1), alive: () => true, wake: false }).started).toEqual([]);
  });
});
