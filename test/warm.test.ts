import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LostSessionError, type AdapterRunOptions, type AdapterRunResult, type BackendAdapter, type ToolBundle } from "agent-runtime";
import { requestSwitch } from "../src/agent/switch.ts";
import { runTurn } from "../src/agent/turn.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import { consoleFromEnv, warmFromEnv, type Config } from "../src/env.ts";
import type { RunnerContext, RunnerSignals, TurnRun } from "../src/runner/run.ts";
import { stayWarm, whyNotStay } from "../src/runner/warm.ts";
import { WarmClaude, warmFingerprint, type FingerprintParts, type WarmSpec } from "../src/runner/warm-session.ts";
import { commandPass, switchRequestPass } from "../src/server/commands.ts";
import { processStart } from "../src/server/spawn.ts";
import { HANDOFF_ACK_MS, HANDOFF_LOST, wakerPass } from "../src/server/waker.ts";
import { drainWarmRunners, retireChatRunner, startWarmRunners } from "../src/server/warm.ts";
import type { Db } from "../src/store/db.ts";
import { ensureChat, getChat, lastOwnerName, recordFrameworkEvent, recordInbound, triggersAfter, turnOwnerName, type CommandPayload } from "../src/store/events.ts";
import { addModel, defaultModel, seedModels } from "../src/store/models.ts";
import { setChatProfile } from "../src/store/profiles.ts";
import { claimTurn, closeNeverStarted, finishTurn, getTurn, lastClosedTurn, MAX_ATTEMPTS, retryDelayMs, runningTurns } from "../src/store/turns.ts";
import { fileSource } from "../src/secrets/source.ts";
import { ackHandoff, allWarmRunners, isDraining, pendingHandoff, registerWarm, setDraining, warmRunnerFor, type WarmRunner } from "../src/store/warm.ts";
import { codeVersion, runnerConfigHash } from "../src/version.ts";
import { memDb, OWNER, ownerChatId, ownerSays, ScriptedAdapter } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "shuvi-warm-"));
  dirs.push(d);
  return d;
};

const row = (chatId: number, pid: number, idleSince: string, extra: Partial<WarmRunner> = {}): WarmRunner => ({
  chatId,
  pid,
  pidStart: "100",
  fingerprint: "fp",
  codeVersion: "v1",
  configHash: "c1",
  idleSince,
  cliStartedAt: null,
  ...extra,
});
const alerts = (db: Db) => db.$client.query("select idem_key as k from control_messages").all() as { k: string }[];

describe("the hand-off (server/waker.ts, store/turns.ts claimTurn)", () => {
  test("a turn for a chat with a live warm runner is handed to it: its pid, the row gone, pending, SIGUSR1, timings `handed`", () => {
    const db = memDb();
    ownerSays(db, "hello");
    const chatId = ownerChatId(db);
    registerWarm(db, row(chatId, 4242, new Date().toISOString()), 2);
    const signals: string[] = [];
    const r = wakerPass({
      db,
      spawn: () => {
        throw new Error("must not spawn");
      },
      alive: () => true,
      signalWarm: (pid, _s, sig) => void signals.push(`${pid}:${sig}`),
    });
    expect(r.started.length).toBe(1);
    const t = getTurn(db, r.started[0]!)!;
    expect([t.pid, t.pidStart, t.handoff]).toEqual([4242, "100", "pending"]);
    expect(warmRunnerFor(db, chatId)).toBeUndefined();
    expect(signals).toEqual(["4242:SIGUSR1"]);
    expect(Object.keys(t.timings!).sort()).toEqual(["claimed", "handed"]);
    // The runner finds it, takes it once.
    expect(pendingHandoff(db, 4242, "100")?.id).toBe(t.id);
    expect(ackHandoff(db, t.id, 4242)).toBe(true);
    expect(ackHandoff(db, t.id, 4242)).toBe(false);
    expect(pendingHandoff(db, 4242, "100")).toBeUndefined();
    // Taken: the waker leaves it to the ordinary rules (alive: nothing happens).
    expect(wakerPass({ db, spawn: () => 1, alive: () => true }).reaped).toEqual([]);
  });

  test("a warm runner that is dead is not handed anything: a child is spawned as before", () => {
    const db = memDb();
    ownerSays(db, "hello");
    const chatId = ownerChatId(db);
    registerWarm(db, row(chatId, 4242, new Date().toISOString()), 2);
    let spawned = 0;
    const r = wakerPass({ db, spawn: () => (spawned++, 5151), startOf: () => "9", alive: (pid) => pid !== 4242, signalWarm: () => {} });
    expect(spawned).toBe(1);
    const t = getTurn(db, r.started[0]!)!;
    expect([t.pid, t.handoff]).toEqual([5151, null]);
    expect(Object.keys(t.timings!).sort()).toEqual(["claimed", "spawned"]);
  });

  test("the claim decides on the row as it is in its own transaction: a dead runner's row is dropped, a spawn follows", () => {
    const db = memDb();
    ownerSays(db, "hello");
    const chatId = ownerChatId(db);
    registerWarm(db, row(chatId, 4242, new Date().toISOString()), 2);
    const t = claimTurn(db, chatId, undefined, { alive: () => false, retired: [] })!;
    expect([t.pid, t.handoff]).toEqual([null, null]);
    expect(warmRunnerFor(db, chatId)).toBeUndefined();
  });

  test("guard 1, the race: the waker found no row, the runner registers, the claim (deciding in its transaction) still hands it the turn", () => {
    // Before, the waker read the row outside the claim; a runner registering in between stayed idle while a child
    // ran the chat's turn. Now the claim reads the row in its own transaction: whichever commits first wins.
    const db = memDb();
    ownerSays(db, "one");
    const chatId = ownerChatId(db);
    const t1 = claimTurn(db, chatId)!; // runner A's turn
    finishTurn(db, t1.id, { status: "done" });
    ownerSays(db, "two");
    expect(warmRunnerFor(db, chatId)).toBeUndefined(); // what a look before the claim would have seen
    expect(registerWarm(db, row(chatId, 4242, new Date().toISOString()), 2).registered).toBe(true); // A, in between
    const t2 = wakerPass({ db, spawn: () => 5151, startOf: () => "9", alive: () => true, signalWarm: () => {} }).started[0]!;
    expect([getTurn(db, t2)!.pid, getTurn(db, t2)!.handoff]).toEqual([4242, "pending"]);
    expect(warmRunnerFor(db, chatId)).toBeUndefined();
    // And the other order: the claim first (a child), then A: refused.
    finishTurn(db, t2, { status: "done" });
    ownerSays(db, "three");
    const t3 = wakerPass({ db, spawn: () => 6161, startOf: () => "9", alive: () => true, signalWarm: () => {} }).started[0]!;
    expect(getTurn(db, t3)!.pid).toBe(6161);
    expect(registerWarm(db, row(chatId, 4242, new Date().toISOString()), 2).refused).toBe("busy");
    // Never both: a registered runner while a child runs the chat's turn.
    expect(warmRunnerFor(db, chatId)).toBeUndefined();
  });

  test("a hand-off its runner never took, the runner dead: closed without a failure, and the same input runs again at once", () => {
    const db = memDb();
    const seq = ownerSays(db, "hello");
    const chatId = ownerChatId(db);
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
      registerWarm(db, row(chatId, 4242, new Date().toISOString()), 2);
      let alive = true;
      const handed = wakerPass({ db, spawn: () => 1, alive: () => alive, signalWarm: () => {} }).started[0]!;
      expect(getTurn(db, handed)!.handoff).toBe("pending");
      alive = false;
      const pass = wakerPass({ db, spawn: () => 1, alive: () => alive, signalWarm: () => {}, wake: false });
      expect(pass.reaped).toEqual([handed]);
      const t = getTurn(db, handed)!;
      expect([t.status, t.error, t.stopSeq]).toEqual(["stopped", HANDOFF_LOST, t.fromSeq]);
      expect(getChat(db, chatId)!.cursorSeq).toBe(0);
      expect(retryDelayMs(db, chatId, Date.now())).toBe(0);
    }
    // Never counted: no alert, no skip past the message.
    expect(alerts(db)).toEqual([]);
    // And the next pass answers it, with a child.
    const next = wakerPass({ db, spawn: () => 777, startOf: () => "1", alive: () => true }).started[0]!;
    expect(getTurn(db, next)!.toSeq).toBe(seq);
    expect(getTurn(db, next)!.pid).toBe(777);
  });

  test("a /stop that reaches a hand-off before the runner took it keeps its place", () => {
    const db = memDb();
    ownerSays(db, "hello");
    const chatId = ownerChatId(db);
    registerWarm(db, row(chatId, 4242, new Date().toISOString()), 2);
    const handed = wakerPass({ db, spawn: () => 1, alive: () => true, signalWarm: () => {} }).started[0]!;
    const stopSeq = ownerSays(db, "more");
    db.$client.query("update turns set stop_seq = ? where id = ?").run(stopSeq, handed);
    wakerPass({ db, spawn: () => 1, alive: () => false, wake: false });
    const t = getTurn(db, handed)!;
    expect([t.status, t.stopSeq]).toEqual(["stopped", stopSeq]);
  });

  test("a runner alive but not taking its hand-off: after HANDOFF_ACK_MS it is abandoned, then killed, and the turn closed unfailed; a late take fails", () => {
    const db = memDb();
    ownerSays(db, "hello");
    const chatId = ownerChatId(db);
    registerWarm(db, row(chatId, 4242, new Date().toISOString()), 2);
    const handed = wakerPass({ db, spawn: () => 1, alive: () => true, signalWarm: () => {} }).started[0]!;
    const at = Date.parse(getTurn(db, handed)!.startedAt);
    const signals: string[] = [];
    const sig = (pid: number, _s: string | null, s: string) => void signals.push(`${pid}:${s}`);
    const origError = console.error;
    console.error = () => {};
    try {
      wakerPass({ db, spawn: () => 1, alive: () => true, signal: sig, now: () => at + 1000, wake: false });
      expect(signals).toEqual([]);
      const r = wakerPass({ db, spawn: () => 1, alive: () => true, signal: sig, now: () => at + HANDOFF_ACK_MS + 1, wake: false });
      expect(signals).toEqual(["4242:SIGKILL"]);
      expect(r.reaped).toEqual([handed]);
    } finally {
      console.error = origError;
    }
    const t = getTurn(db, handed)!;
    expect([t.status, t.handoff, t.error, t.stopSeq]).toEqual(["stopped", "abandoned", HANDOFF_LOST, t.fromSeq]);
    // The runner, had it survived, tries to take it now: refused, so it never runs.
    expect(ackHandoff(db, handed, 4242)).toBe(false);
    expect(pendingHandoff(db, 4242, "100")).toBeUndefined();
    expect(alerts(db)).toEqual([]);
  });

  test("a take that wins the race with the abandon runs: nothing is abandoned or killed", () => {
    const db = memDb();
    ownerSays(db, "hello");
    const chatId = ownerChatId(db);
    registerWarm(db, row(chatId, 4242, new Date().toISOString()), 2);
    const handed = wakerPass({ db, spawn: () => 1, alive: () => true, signalWarm: () => {} }).started[0]!;
    expect(ackHandoff(db, handed, 4242)).toBe(true);
    const signals: string[] = [];
    const at = Date.parse(getTurn(db, handed)!.startedAt);
    wakerPass({ db, spawn: () => 1, alive: () => true, signal: (p, _s, s) => void signals.push(`${p}:${s}`), now: () => at + HANDOFF_ACK_MS + 1, wake: false });
    expect(signals).toEqual([]);
    expect([getTurn(db, handed)!.status, getTurn(db, handed)!.handoff]).toEqual(["running", "acked"]);
  });

  test("a runner on other code or another configuration than the server's is retired at the hand-off, and a child spawned", () => {
    for (const other of [{ codeVersion: "v0" }, { configHash: "c0" }]) {
      const db = memDb();
      ownerSays(db, "hello");
      const chatId = ownerChatId(db);
      registerWarm(db, row(chatId, 4242, new Date().toISOString(), other), 2);
      const signals: string[] = [];
      const origLog = console.log;
      console.log = () => {};
      let r;
      try {
        r = wakerPass({
          db,
          spawn: () => 5151,
          startOf: () => "9",
          alive: () => true,
          signalWarm: (p, _s, s) => void signals.push(`${p}:${s}`),
          runnerIdentity: { codeVersion: "v1", configHash: "c1" },
        });
      } finally {
        console.log = origLog;
      }
      const t = getTurn(db, r.started[0]!)!;
      expect([t.pid, t.handoff]).toEqual([5151, null]);
      expect(signals).toEqual(["4242:SIGUSR2"]);
      expect(warmRunnerFor(db, chatId)).toBeUndefined();
    }
    // The same code and configuration: handed.
    const db = memDb();
    ownerSays(db, "hello");
    registerWarm(db, row(ownerChatId(db), 4242, new Date().toISOString()), 2);
    const r = wakerPass({ db, spawn: () => 5151, alive: () => true, signalWarm: () => {}, runnerIdentity: { codeVersion: "v1", configHash: "c1" } });
    expect(getTurn(db, r.started[0]!)!.handoff).toBe("pending");
  });

  test("guard 1: a runner does not register while another process runs its chat's turn, so the next turn is not handed to its stale CLI", () => {
    const db = memDb();
    ownerSays(db, "one");
    const chatId = ownerChatId(db);
    // Runner A (4242) ran turn 1; it is closed, and A is about to register.
    const t1 = claimTurn(db, chatId)!;
    finishTurn(db, t1.id, { status: "done" });
    // Meanwhile the waker started a cold child B (5151) for a message that was waiting.
    ownerSays(db, "two");
    const t2 = wakerPass({ db, spawn: () => 5151, startOf: () => "9", alive: () => true }).started[0]!;
    expect(getTurn(db, t2)!.pid).toBe(5151);
    // A registers now: refused.
    expect(registerWarm(db, row(chatId, 4242, new Date().toISOString()), 2)).toEqual({ registered: false, retired: [], refused: "busy" });
    expect(warmRunnerFor(db, chatId)).toBeUndefined();
    // B finishes; a new message: not handed to A (spawned).
    finishTurn(db, t2, { status: "done" });
    ownerSays(db, "three");
    const t3 = wakerPass({ db, spawn: () => 6161, startOf: () => "9", alive: () => true, signalWarm: () => {} }).started[0]!;
    expect([getTurn(db, t3)!.pid, getTurn(db, t3)!.handoff]).toEqual([6161, null]);
  });
});

describe("the cap and the rows (store/warm.ts)", () => {
  test("one more than SHUVI_WARM_MAX retires the least recently idle other runner", () => {
    const db = memDb();
    const a = ensureChat(db, { id: 1, kind: "private" }).id;
    const b = ensureChat(db, { id: 2, kind: "private" }).id;
    const c = ensureChat(db, { id: 3, kind: "private" }).id;
    expect(registerWarm(db, row(a, 1, "2026-01-01T00:00:01Z"), 2)).toEqual({ registered: true, retired: [] });
    expect(registerWarm(db, row(b, 2, "2026-01-01T00:00:02Z"), 2)).toEqual({ registered: true, retired: [] });
    const r = registerWarm(db, row(c, 3, "2026-01-01T00:00:03Z"), 2);
    expect(r.registered).toBe(true);
    expect(r.retired.map((x) => x.pid)).toEqual([1]);
    expect(allWarmRunners(db).map((x) => x.pid)).toEqual([2, 3]);
  });

  test("this one leaves when it is the oldest (or the cap is 0), and nothing is retired", () => {
    const db = memDb();
    const a = ensureChat(db, { id: 1, kind: "private" }).id;
    const b = ensureChat(db, { id: 2, kind: "private" }).id;
    registerWarm(db, row(a, 1, "2026-01-01T00:00:05Z"), 1);
    expect(registerWarm(db, row(b, 2, "2026-01-01T00:00:01Z"), 1)).toEqual({ registered: false, retired: [], refused: "cap" });
    expect(registerWarm(db, row(b, 2, "2026-01-01T00:00:09Z"), 0)).toEqual({ registered: false, retired: [], refused: "cap" });
    expect(allWarmRunners(db).map((x) => x.pid)).toEqual([1]);
  });

  test("another runner's row for the same chat is replaced, and that runner retired", () => {
    const db = memDb();
    const a = ensureChat(db, { id: 1, kind: "private" }).id;
    registerWarm(db, row(a, 1, "2026-01-01T00:00:01Z"), 2);
    const r = registerWarm(db, row(a, 2, "2026-01-01T00:00:02Z"), 2);
    expect(r.retired.map((x) => x.pid)).toEqual([1]);
    expect(warmRunnerFor(db, a)?.pid).toBe(2);
  });
});

describe("retiring (server/warm.ts, server/commands.ts, the store's resets)", () => {
  function chatWithRunner() {
    const db = memDb();
    seedModels(db, {});
    ownerSays(db, "hi");
    const chatId = ownerChatId(db);
    registerWarm(db, row(chatId, 4242, new Date().toISOString()), 2);
    const signals: string[] = [];
    const warm = (pid: number, _s: string | null, sig: string) => void signals.push(`${pid}:${sig}`);
    return { db, chatId, signals, warm };
  }
  const command = (db: Db, chatId: number, c: CommandPayload["command"]) =>
    recordInbound(db, { chatId, kind: "command", payload: { from: { id: OWNER, name: "Owner" }, command: c }, tgUpdateId: Math.floor(Math.random() * 1e9), tgMessageId: Math.floor(Math.random() * 1e9) });

  test("/new and /newclean retire the chat's runner (SIGUSR2); /stop does not", () => {
    for (const c of ["new", "newclean"] as const) {
      const { db, chatId, signals, warm } = chatWithRunner();
      command(db, chatId, c);
      commandPass(db, () => {}, undefined, warm);
      expect(warmRunnerFor(db, chatId)).toBeUndefined();
      expect(signals).toEqual(["4242:SIGUSR2"]);
    }
    const { db, chatId, signals, warm } = chatWithRunner();
    command(db, chatId, "stop");
    commandPass(db, () => {}, undefined, warm);
    expect(warmRunnerFor(db, chatId)?.pid).toBe(4242);
    expect(signals).toEqual([]);
  });

  test("a switch of the chat's model retires its runner; one that changes nothing does not", () => {
    const { db, chatId, signals, warm } = chatWithRunner();
    addModel(db, { provider: "claude", model: "sonnet" });
    const current = defaultModel(db)!.id;
    requestSwitch(db, chatId, current, "lossy");
    switchRequestPass(db, () => {}, {}, warm);
    expect(warmRunnerFor(db, chatId)?.pid).toBe(4242);
    requestSwitch(db, chatId, "claude/sonnet", "lossy");
    const [done] = switchRequestPass(db, () => {}, {}, warm);
    expect(done!.status).toBe("done");
    expect(warmRunnerFor(db, chatId)).toBeUndefined();
    expect(signals).toEqual(["4242:SIGUSR2"]);
  });

  test("a profile switch (and a reset from anywhere: the console's) deletes the row; retireChatRunner signals", () => {
    const { db, chatId, signals, warm } = chatWithRunner();
    setChatProfile(db, chatId, "work");
    expect(warmRunnerFor(db, chatId)).toBeUndefined();
    registerWarm(db, row(chatId, 4242, new Date().toISOString()), 2);
    expect(retireChatRunner(db, chatId, warm)?.pid).toBe(4242);
    expect(signals).toEqual(["4242:SIGUSR2"]);
    expect(retireChatRunner(db, chatId, warm)).toBeUndefined();
  });

  test("a drain sets the flag and retires every idle runner; the next server clears it, forgets the dead, retires other code", () => {
    const db = memDb();
    const ids = [1, 2, 3, 4].map((n) => ensureChat(db, { id: n, kind: "private" }).id);
    const signals: string[] = [];
    const warm = (pid: number, _s: string | null, sig: string) => void signals.push(`${pid}:${sig}`);
    registerWarm(db, row(ids[0]!, 1, "2026-01-01T00:00:01Z"), 9);
    registerWarm(db, row(ids[1]!, 2, "2026-01-01T00:00:02Z"), 9);
    expect(drainWarmRunners(db, warm).map((r) => r.pid)).toEqual([1, 2]);
    expect(isDraining(db)).toBe(true);
    expect(signals).toEqual(["1:SIGUSR2", "2:SIGUSR2"]);
    expect(allWarmRunners(db)).toEqual([]);

    signals.length = 0;
    registerWarm(db, row(ids[0]!, 1, "2026-01-01T00:00:01Z"), 9); // dead
    registerWarm(db, row(ids[1]!, 2, "2026-01-01T00:00:02Z", { codeVersion: "v0" }), 9); // other code
    registerWarm(db, row(ids[2]!, 3, "2026-01-01T00:00:03Z"), 9); // adopted
    registerWarm(db, row(ids[3]!, 4, "2026-01-01T00:00:04Z", { configHash: "c0" }), 9); // another configuration
    const r = startWarmRunners(db, { enabled: true, identity: { codeVersion: "v1", configHash: "c1" }, alive: (pid) => pid !== 1, signal: warm });
    expect(isDraining(db)).toBe(false);
    expect(r.dead.map((x) => x.pid)).toEqual([1]);
    expect(r.retired.map((x) => x.pid)).toEqual([2, 4]);
    expect(signals).toEqual(["2:SIGUSR2", "4:SIGUSR2"]);
    expect(allWarmRunners(db).map((x) => x.pid)).toEqual([3]);
    // The switch off: every runner leaves.
    expect(startWarmRunners(db, { enabled: false, identity: { codeVersion: "v1", configHash: "c1" }, alive: () => true, signal: warm }).retired.map((x) => x.pid)).toEqual([3]);
  });
});

// ---- the runner's side, with a fake CLI ----------------------------------------------------------------------

/** A stand-in for agent-runtime's ClaudeSession: what WarmClaude reads of it, and whether it was closed. */
class FakeSession {
  static opened: FakeSession[] = [];
  /** Run when one is opened (a test's way into the middle of a re-warm). */
  static onOpen: (() => void) | null = null;
  sessionId: string | null = null;
  alive = true;
  busy = false;
  readonly systemPrompt: string | undefined;
  readonly toolsFingerprint: string;
  readonly resumeSessionId: string | undefined;
  constructor(readonly opts: { systemPrompt?: string; tools?: ToolBundle[]; resumeSessionId?: string; configDir?: string }) {
    this.systemPrompt = opts.systemPrompt;
    this.toolsFingerprint = fakeToolsFp(opts.tools ?? []);
    this.resumeSessionId = opts.resumeSessionId;
    FakeSession.opened.push(this);
    FakeSession.onOpen?.();
  }
  close() {
    this.alive = false;
    return Promise.resolve({ code: 0, signal: null });
  }
}
const fakeToolsFp = (tools: ToolBundle[]) => JSON.stringify(tools.map((b) => [b.serverName, b.tools.map((t) => [t.name, t.description])]));
/** A stand-in for agent-runtime's ClaudeBackend on a session: one reply, through the turn's callbacks. */
class FakeBackend {
  static turns: { conversation: string | null; session: FakeSession }[] = [];
  constructor(private readonly o: { session: FakeSession }) {}
  run(input: { prompt: unknown }, opts: AdapterRunOptions) {
    return this.turn(null, opts);
  }
  continueRun(input: { backendSessionId: string }, opts: AdapterRunOptions) {
    return this.turn(input.backendSessionId, opts);
  }
  private async turn(conversation: string | null, opts: AdapterRunOptions): Promise<AdapterRunResult> {
    FakeBackend.turns.push({ conversation, session: this.o.session });
    const id = conversation ?? "s-warm";
    this.o.session.sessionId = id;
    const usage = { model: "fake", costUsd: 0.001, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 };
    opts.onSessionId?.(id);
    opts.onToken?.("Handed reply.");
    opts.onResult?.({ text: "Handed reply.", backendSessionId: id, usage });
    return { text: "Handed reply.", backendSessionId: id, usage };
  }
}
const fakeClaude = { ClaudeSession: FakeSession, ClaudeBackend: FakeBackend, toolsFingerprint: fakeToolsFp } as unknown as typeof import("agent-runtime/claude");

const bundle = (name: string, description = "d"): ToolBundle => ({ serverName: "shuvi", tools: [{ name, description, inputSchema: {}, handler: async () => ({ content: [] }) }] });
const spec = (o: Partial<WarmSpec> = {}): WarmSpec => ({ systemPrompt: "P", tools: [bundle("say")], configDir: null, conversation: null, lastTurn: null, ...o });

describe("the resident CLI (runner/warm-session.ts)", () => {
  test("the fingerprint is the prompt, the tool list, the provider, its login and settings; nothing else (not the code: that is the row's code_version)", () => {
    const base: FingerprintParts = { systemPrompt: "P", toolsFingerprint: "T", kind: "claude", configDir: null, settings: null };
    const fp = warmFingerprint(base);
    expect(warmFingerprint({ ...base })).toBe(fp);
    for (const change of [{ systemPrompt: "P2" }, { toolsFingerprint: "T2" }, { kind: "x" }, { configDir: "/c" }, { settings: "/s" }]) {
      expect(warmFingerprint({ ...base, ...change })).not.toBe(fp);
    }
  });

  test("a CLI that fits is kept; another prompt, tool list, login or conversation opens a new one and closes the old", async () => {
    FakeSession.opened = [];
    const w = new WarmClaude(fakeClaude, () => {});
    const first = await w.ensure(spec());
    expect(first.started).toBe(true);
    expect(w.starts).toBe(1);
    expect((await w.ensure(spec())).started).toBe(false);
    // Handlers do not count: same names and descriptions.
    expect((await w.ensure(spec({ tools: [bundle("say")] }))).started).toBe(false);
    // Each change on top of the last: every one opens a new CLI and closes the one before.
    let s = spec();
    const changes: Partial<WarmSpec>[] = [{ systemPrompt: "P2" }, { tools: [bundle("say", "other words")] }, { configDir: "/login" }, { conversation: "s-1" }];
    for (const [i, change] of changes.entries()) {
      const before = w.session as unknown as FakeSession;
      s = { ...s, ...change };
      expect(w.misfit(s)).not.toBeNull();
      expect((await w.ensure(s)).started).toBe(true);
      expect(before.alive).toBe(false);
      expect(w.starts).toBe(i + 2);
    }
    // A resume carries the new prompt.
    const last = w.session as unknown as FakeSession;
    expect([last.resumeSessionId, last.systemPrompt]).toEqual(["s-1", "P2"]);
    // A CLI whose conversation has its id now still fits that conversation.
    last.sessionId = "s-1";
    expect(w.misfit(spec({ systemPrompt: "P2", tools: [bundle("say", "other words")], configDir: "/login", conversation: "s-1" }))).toBeNull();
    expect(w.misfit(spec({ systemPrompt: "P2", tools: [bundle("say", "other words")], configDir: "/login", conversation: null }))).toBe("the conversation changed");
    await w.close();
    expect(last.alive).toBe(false);
    expect(w.alive).toBe(false);
  });
});

describe("guard 2: a CLI that missed a closed turn (runner/warm-session.ts)", () => {
  test("a CLI fits only while the chat's last closed turn is the one it last served; else it is reopened on a resume", async () => {
    FakeSession.opened = [];
    const w = new WarmClaude(fakeClaude, () => {});
    // Opened for turn 5 (the chat's last closed turn was 4), then served it.
    await w.ensure(spec({ conversation: "s-1", lastTurn: 4 }));
    (w.session as unknown as FakeSession).sessionId = "s-1";
    w.served(5);
    expect(w.misfit(spec({ conversation: "s-1", lastTurn: 5 }))).toBeNull();
    // Turn 6 ran in another process (a cold child) on the same conversation, same id: the CLI did not see it.
    expect(w.misfit(spec({ conversation: "s-1", lastTurn: 6 }))).toBe("a turn ran elsewhere since its last one");
    const before = w.session as unknown as FakeSession;
    expect((await w.ensure(spec({ conversation: "s-1", lastTurn: 6 }))).started).toBe(true);
    expect(before.alive).toBe(false);
    // The new CLI resumes the conversation, which has turn 6 on file, and fits from now on.
    expect((w.session as unknown as FakeSession).resumeSessionId).toBe("s-1");
    expect(w.misfit(spec({ conversation: "s-1", lastTurn: 6 }))).toBeNull();
    await w.close();
  });

  test("a turn adapter reopens a CLI that missed a turn before running on it", async () => {
    FakeSession.opened = [];
    FakeBackend.turns = [];
    const w = new WarmClaude(fakeClaude, () => {});
    await w.ensure(spec({ conversation: "s-1", lastTurn: 1 }));
    const stale = w.session as unknown as FakeSession;
    w.served(2);
    const noBoundary = {} as Parameters<WarmClaude["adapter"]>[0];
    let cli = 0;
    // The chat's last closed turn is 3 (another process's): the turn runs on a new CLI, not the stale one.
    await w.adapter(noBoundary, null, 3, () => cli++).continueRun({ backendSessionId: "s-1", prompt: "hi", tools: [bundle("say")], systemPrompt: "P" }, {});
    expect(cli).toBe(1);
    expect(FakeBackend.turns.at(-1)!.session).not.toBe(stale);
    expect(stale.alive).toBe(false);
    await w.close();
  });
});

describe("a warm runner waiting (runner/warm.ts)", () => {
  const capabilities = enabledCapabilities({ SHUVI_WEB: "off", SHUVI_STICKERS: "off", SHUVI_SCHEDULES: "off", SHUVI_MEMORY: "off", SHUVI_RETRIEVAL: "off", SHUVI_PLAYBOOKS: "off", SHUVI_RELEASES: "off", SHUVI_GROUPS: "off" });

  async function setup(warm: Partial<Config["warm"]> = {}) {
    const db = memDb();
    seedModels(db, {});
    ownerSays(db, "hi");
    const chatId = ownerChatId(db);
    const dataDir = tmp();
    const home = join(dataDir, "home");
    mkdirSync(home);
    writeFileSync(join(home, "directives.md"), "Be brief.");
    const cfg = { home, dataDir, ownerId: OWNER, timeZone: "UTC", secrets: fileSource(join(dataDir, "no-secrets.yaml")), console: consoleFromEnv({}), warm: { enabled: true, idleMs: 600_000, max: 2, ...warm } } as unknown as Config;
    const runner: RunnerContext = { cfg, db, capabilities, warm: new WarmClaude(fakeClaude, () => {}) };
    // Its first turn, closed, on the CLI it ran on.
    const t1 = claimTurn(db, chatId)!;
    finishTurn(db, t1.id, { status: "done" });
    await runner.warm!.ensure(spec({ lastTurn: null }));
    const first: TurnRun = { turnId: t1.id, line: `turn ${t1.id}: done`, outcome: "done", chatId, kind: "claude" };
    let retired = false;
    const stop = new AbortController();
    const signals: RunnerSignals = { stop: stop.signal, retired: () => retired, wait: (ms) => Bun.sleep(Math.min(ms, 50)) };
    return { db, chatId, home, runner, first, signals, stop, retire: () => (retired = true) };
  }
  const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
    const orig = console.log;
    console.log = () => {};
    try {
      return await f();
    } finally {
      console.log = orig;
    }
  };

  test("it registers, re-warmed for the next turn's prompt, and leaves once idle past SHUVI_WARM_IDLE_SEC, closing its CLI", async () => {
    const w = await setup({ idleMs: 400 });
    let seen: WarmRunner | undefined;
    const watch = setInterval(() => (seen ??= warmRunnerFor(w.db, w.chatId)), 10);
    const line = await quiet(() => stayWarm(w.runner, w.first, w.signals));
    clearInterval(watch);
    expect(line).toContain("idle past");
    expect([seen?.pid, seen?.pidStart, seen?.codeVersion]).toEqual([process.pid, processStart(process.pid), codeVersion()]);
    // The CLI it registered with was opened for the chat's real prompt (Rules: Be brief.), not its first turn's.
    expect((FakeSession.opened.at(-1)!.systemPrompt ?? "").includes("Be brief.")).toBe(true);
    expect(warmRunnerFor(w.db, w.chatId)).toBeUndefined();
    expect(w.runner.warm!.alive).toBe(false);
  });

  test("its row deleted by anyone (a retire) makes it leave; so do SIGUSR2 and SIGTERM", async () => {
    for (const how of ["row", "usr2", "term"] as const) {
      const w = await setup();
      const p = quiet(() => stayWarm(w.runner, w.first, w.signals));
      for (let i = 0; i < 100 && !warmRunnerFor(w.db, w.chatId); i++) await Bun.sleep(10);
      expect(warmRunnerFor(w.db, w.chatId)?.pid).toBe(process.pid);
      if (how === "row") w.db.$client.query("delete from warm_runners").run();
      else if (how === "usr2") w.retire();
      else w.stop.abort();
      const line = await p;
      expect(line).toContain(how === "row" ? "its row is gone" : how === "usr2" ? "retired (SIGUSR2)" : "SIGTERM while idle");
      expect(warmRunnerFor(w.db, w.chatId)).toBeUndefined();
    }
  });

  test("over SHUVI_WARM_MAX as the oldest, it does not stay", async () => {
    const w = await setup({ max: 0 });
    expect(await quiet(() => stayWarm(w.runner, w.first, w.signals))).toContain("over SHUVI_WARM_MAX");
  });

  test("an edit to home/ while it waits re-warms it within CHECK_MS: a new CLI, the new fingerprint on its row", async () => {
    const w = await setup();
    const p = quiet(() => stayWarm(w.runner, w.first, w.signals));
    for (let i = 0; i < 100 && !warmRunnerFor(w.db, w.chatId); i++) await Bun.sleep(10);
    const before = warmRunnerFor(w.db, w.chatId)!;
    const opened = FakeSession.opened.length;
    writeFileSync(join(w.home, "directives.md"), "Be very brief.");
    for (let i = 0; i < 80 && warmRunnerFor(w.db, w.chatId)?.fingerprint === before.fingerprint; i++) await Bun.sleep(50);
    const after = warmRunnerFor(w.db, w.chatId)!;
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.pid).toBe(before.pid);
    expect(FakeSession.opened.length).toBe(opened + 1);
    expect(FakeSession.opened.at(-1)!.systemPrompt).toContain("Be very brief.");
    w.retire();
    await p;
  });

  /** The waker's claim, its runner check passing (this process is the runner here). */
  const handToMe = () => ({ alive: () => true, retired: [] });
  const registered = async (db: Db, chatId: number) => {
    for (let i = 0; i < 200 && warmRunnerFor(db, chatId)?.pid !== process.pid; i++) await Bun.sleep(10);
    expect(warmRunnerFor(db, chatId)?.pid).toBe(process.pid);
  };
  const closed = async (db: Db, id: number) => {
    for (let i = 0; i < 400 && getTurn(db, id)!.status === "running"; i++) await Bun.sleep(10);
    return getTurn(db, id)!;
  };
  const replies = (db: Db, turnId: number) =>
    (db.$client.query("select payload from chat_events where kind = 'bot_message' and turn_id = ?").all(turnId) as { payload: string }[]).map((r) => JSON.parse(r.payload).text as string);

  test("it takes a turn handed to it (ack, then runTurn on its CLI, no new CLI) and waits again", async () => {
    const w = await setup();
    FakeBackend.turns = [];
    const p = quiet(() => stayWarm(w.runner, w.first, w.signals));
    await registered(w.db, w.chatId);
    ownerSays(w.db, "and again");
    const started = wakerPass({
      db: w.db,
      spawn: () => {
        throw new Error("must not spawn");
      },
      alive: () => true,
      signalWarm: () => {},
    }).started;
    const t = await closed(w.db, started[0]!);
    expect([t.status, t.handoff, t.pid]).toEqual(["done", "acked", process.pid]);
    const m = t.timings!;
    expect(!!m.handed && !!m.acked && !!m.ready && !m.child && !m.spawned).toBe(true);
    // Its prompt and tools were the ones the runner had warmed up for: no CLI was opened for it.
    expect(m.cli).toBeUndefined();
    expect(FakeBackend.turns.length).toBe(1);
    expect(replies(w.db, t.id)).toEqual(["Handed reply."]);
    await registered(w.db, w.chatId);
    w.retire();
    expect(await p).toContain(`turn ${t.id}: done`);
  });

  test("leaving, it finds its row already gone because a turn was just handed to it: it takes that turn first", async () => {
    const w = await setup();
    const p = quiet(() => stayWarm(w.runner, w.first, w.signals));
    await registered(w.db, w.chatId);
    ownerSays(w.db, "just in time");
    // The hand-off (row deleted, turn pending) and the retire land together: it decides to leave first.
    const t = claimTurn(w.db, w.chatId, undefined, handToMe())!;
    w.retire();
    const line = await p;
    const done = getTurn(w.db, t.id)!;
    expect([done.status, done.handoff]).toEqual(["done", "acked"]);
    expect(line).toContain(`turn ${t.id}: done`);
    expect(line).toContain("retired (SIGUSR2)");
  });

  test("a re-warm whose row update fails (handed a turn meanwhile) goes on to take that turn", async () => {
    const w = await setup();
    const p = quiet(() => stayWarm(w.runner, w.first, w.signals));
    await registered(w.db, w.chatId);
    let t: { id: number } | null = null;
    // While the new CLI is opened, the waker hands the runner a turn: the row it would update is gone.
    FakeSession.onOpen = () => {
      FakeSession.onOpen = null;
      ownerSays(w.db, "meanwhile");
      t = claimTurn(w.db, w.chatId, undefined, handToMe());
    };
    writeFileSync(join(w.home, "directives.md"), "Be briefer.");
    for (let i = 0; i < 100 && !t; i++) await Bun.sleep(50);
    expect(t).not.toBeNull();
    const done = await closed(w.db, t!.id);
    expect([done.status, done.handoff]).toEqual(["done", "acked"]);
    w.retire();
    await p;
  });

  test("a turn run elsewhere while it waits (its CLI missed it) re-warms it on a resume", async () => {
    const w = await setup();
    const p = quiet(() => stayWarm(w.runner, w.first, w.signals));
    await registered(w.db, w.chatId);
    const opened = FakeSession.opened.length;
    // A turn of the chat closes that this runner did not run (it could only have run while the runner was away).
    ownerSays(w.db, "elsewhere");
    const other = claimTurn(w.db, w.chatId)!;
    finishTurn(w.db, other.id, { status: "done" });
    for (let i = 0; i < 80 && FakeSession.opened.length === opened; i++) await Bun.sleep(50);
    expect(FakeSession.opened.length).toBe(opened + 1);
    expect(lastClosedTurn(w.db, w.chatId)).toBe(other.id);
    w.retire();
    await p;
  });

  test("it does not stay after a stopped turn, a lost conversation, a drain, a /new or a switch waiting, or another provider", async () => {
    const w = await setup();
    const sig = { stop: new AbortController().signal, retired: () => false };
    expect(whyNotStay(w.runner, w.first, sig)).toBeUndefined();
    expect(whyNotStay(w.runner, { ...w.first, outcome: "stopped" }, sig)).toContain("stopped");
    expect(whyNotStay(w.runner, { ...w.first, kind: "openai-compat" }, sig)).toContain("openai-compat");
    setDraining(w.db, true);
    expect(whyNotStay(w.runner, w.first, sig)).toContain("draining");
    setDraining(w.db, false);
    recordInbound(w.db, { chatId: w.chatId, kind: "command", payload: { from: { id: OWNER, name: "Owner" }, command: "new" }, tgUpdateId: 99_001, tgMessageId: 99_001 });
    expect(whyNotStay(w.runner, w.first, sig)).toContain("/new");
    w.db.$client.query("update chat_events set status = 'done' where kind = 'command'").run();
    addModel(w.db, { provider: "claude", model: "sonnet" });
    requestSwitch(w.db, w.chatId, "claude/sonnet", "lossy");
    expect(whyNotStay(w.runner, w.first, sig)).toContain("switch");
    w.db.$client.query("delete from model_switch_requests").run();
    w.runner.warm!.lost = true;
    expect(whyNotStay(w.runner, w.first, sig)).toContain("lost");
  });
});

describe("the reply at the result (agent/turn.ts)", () => {
  test("the reply is queued when the driver reports its result, before it returns; the turn closes after", async () => {
    const db = memDb();
    ownerSays(db, "hello");
    const turn = claimTurn(db, ownerChatId(db))!;
    let release!: () => void;
    const returned = new Promise<void>((r) => (release = r));
    let atResult: { rows: number; status: string } | null = null;
    const adapter: BackendAdapter = {
      id: "result-first",
      run: async (_input, opts: AdapterRunOptions): Promise<AdapterRunResult> => {
        const usage = { model: "fake", costUsd: 0, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 };
        opts.onSessionId?.("s-1");
        opts.onToken?.("Hello there.");
        opts.onResult?.({ text: "Hello there.", backendSessionId: "s-1", usage });
        atResult = {
          rows: (db.$client.query("select count(*) as n from chat_events where kind = 'bot_message' and turn_id = ?").get(turn.id) as { n: number }).n,
          status: getTurn(db, turn.id)!.status,
        };
        await returned;
        return { text: "Hello there.", backendSessionId: "s-1", usage };
      },
      continueRun: () => Promise.reject(new Error("not here")),
    };
    const done = runTurn({ db, turnId: turn.id, home: tmp(), timeZone: "UTC", capabilities: enabledCapabilities({ SHUVI_WEB: "off" }), makeAdapter: () => adapter });
    for (let i = 0; i < 100 && !atResult; i++) await Bun.sleep(5);
    expect(atResult!).toEqual({ rows: 1, status: "running" });
    expect(getTurn(db, turn.id)!.status).toBe("running");
    release();
    expect(await done).toBe("done");
    const rows = db.$client.query("select payload, idem_key as k from chat_events where kind = 'bot_message'").all() as { payload: string; k: string }[];
    expect(rows.map((r) => [JSON.parse(r.payload).text, r.k])).toEqual([["Hello there.", `turn:${turn.id}:0`]]);
    expect(Object.keys(getTurn(db, turn.id)!.timings!)).toContain("result");
    // The transcript records the text once, as sent.
    const steps = db.$client.query("select kind, sent from turn_steps where turn_id = ? and kind = 'text'").all(turn.id) as { kind: string; sent: number }[];
    expect(steps.length).toBe(1);
  });
});

describe("a driver that fails after its result (agent/turn.ts)", () => {
  const usage = { model: "fake", costUsd: 0.002, inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 };
  /** The reviewer's adapter: a token, the result, then a throw (a CLI exiting non-zero after its result). */
  const afterResult = (o: { abortWith?: AbortController } = {}): BackendAdapter => ({
    id: "fails-after-result",
    run: async (_input, opts) => {
      opts.onSessionId?.("s-1");
      opts.onToken?.("The answer.");
      opts.onResult?.({ text: "The answer.", backendSessionId: "s-1", usage });
      o.abortWith?.abort();
      throw new Error("Claude Code process exited with code 1");
    },
    continueRun: () => Promise.reject(new Error("not here")),
  });

  test("closes done with the result's usage, its reply queued once, the cursor advanced, no retry, a transcript note", async () => {
    const db = memDb();
    const seq = ownerSays(db, "hello");
    const turn = claimTurn(db, ownerChatId(db))!;
    const outcome = await runTurn({ db, turnId: turn.id, home: tmp(), timeZone: "UTC", capabilities: enabledCapabilities({ SHUVI_WEB: "off" }), makeAdapter: () => afterResult() });
    expect(outcome).toBe("done");
    const t = getTurn(db, turn.id)!;
    expect([t.status, t.costMicroUsd, t.inputTokens]).toEqual(["done", 2000, 3]);
    const rows = db.$client.query("select payload from chat_events where kind = 'bot_message'").all() as { payload: string }[];
    expect(rows.map((r) => JSON.parse(r.payload).text)).toEqual(["The answer."]);
    expect(getChat(db, ownerChatId(db))!.cursorSeq).toBe(seq);
    expect(alerts(db)).toEqual([]);
    // Nothing is left to answer: the waker starts no turn.
    expect(wakerPass({ db, spawn: () => 1, alive: () => true }).started).toEqual([]);
    const notes = db.$client.query("select text from turn_steps where turn_id = ? and kind = 'note'").all(turn.id) as { text: string }[];
    expect(notes.some((n) => n.text.includes("failed after reporting the turn's result"))).toBe(true);
  });

  test("a stop is still a stop, even after the result", async () => {
    const db = memDb();
    ownerSays(db, "hello");
    const turn = claimTurn(db, ownerChatId(db))!;
    const ac = new AbortController();
    const outcome = await runTurn({ db, turnId: turn.id, home: tmp(), timeZone: "UTC", capabilities: enabledCapabilities({ SHUVI_WEB: "off" }), signal: ac.signal, makeAdapter: () => afterResult({ abortWith: ac }) });
    expect(outcome).toBe("stopped");
    expect(getTurn(db, turn.id)!.status).toBe("stopped");
  });
});

describe("the owner's name in a turn with no message of his (agent/turn.ts)", () => {
  test("a DM turn on an inbound event names the owner as he last wrote, as a warm runner's prompt does", async () => {
    const db = memDb();
    ownerSays(db, "hi");
    const chatId = ownerChatId(db);
    const first = claimTurn(db, chatId)!;
    finishTurn(db, first.id, { status: "done" });
    recordFrameworkEvent(db, { chatId, kind: "external", payload: { source: "grafana", text: "disk at 90%", trigger: true }, idemKey: null });
    const turn = claimTurn(db, chatId)!;
    let adapter: ScriptedAdapter | null = null;
    await runTurn({
      db,
      turnId: turn.id,
      home: tmp(),
      timeZone: "UTC",
      ownerId: OWNER,
      capabilities: enabledCapabilities({ SHUVI_WEB: "off" }),
      makeAdapter: (b) => (adapter = new ScriptedAdapter(b, [{ token: "Noted." }])),
    });
    const system = (adapter as ScriptedAdapter | null)!.calls[0]!.systemPrompt!;
    expect(system).toContain("A private chat between you and Owner.");
    expect(lastOwnerName(db, chatId, OWNER)).toBe("Owner");
  });
});

describe("review fixes: identity, the abandon's transaction, a concluded turn, the owner's name", () => {
  test("the config hash covers the child's whole environment: a capability's variable or SHUVI_SECRETS_KEY changed retires the runner", () => {
    const base = { SHUVI_DATA_DIR: "/d", SHUVI_HANGAR_API: "https://h.example", SHUVI_SECRETS_KEY: "a2V5LW9uZQ==" };
    const ids = ["speech", "computer"];
    const h = runnerConfigHash(base, ids);
    expect(runnerConfigHash({ ...base }, ids)).toBe(h);
    // Order of the variables does not matter; a value, a name or the capabilities do.
    expect(runnerConfigHash({ SHUVI_SECRETS_KEY: base.SHUVI_SECRETS_KEY, SHUVI_HANGAR_API: base.SHUVI_HANGAR_API, SHUVI_DATA_DIR: "/d" }, ids)).toBe(h);
    const capability = runnerConfigHash({ ...base, SHUVI_HANGAR_API: "https://other.example" }, ids);
    const key = runnerConfigHash({ ...base, SHUVI_SECRETS_KEY: "a2V5LXR3bw==" }, ids);
    expect(capability).not.toBe(h);
    expect(key).not.toBe(h);
    expect(runnerConfigHash({ ...base, SHUVI_VISION_WAIT_MS: "100" }, ids)).not.toBe(h);
    expect(runnerConfigHash(base, ["speech"])).not.toBe(h);
    // Nothing of a value is in it.
    expect(h.includes("a2V5")).toBe(false);
    // Both retire at the server's start, and at a hand-off.
    for (const other of [capability, key]) {
      const db = memDb();
      ownerSays(db, "hi");
      const chatId = ownerChatId(db);
      registerWarm(db, row(chatId, 4242, new Date().toISOString(), { configHash: other }), 2);
      const sig: string[] = [];
      expect(startWarmRunners(db, { enabled: true, identity: { codeVersion: "v1", configHash: h }, alive: () => true, signal: (p, _s, s) => void sig.push(`${p}:${s}`) }).retired.length).toBe(1);
      expect(sig).toEqual(["4242:SIGUSR2"]);
      registerWarm(db, row(chatId, 4242, new Date().toISOString(), { configHash: other }), 2);
      const origLog = console.log;
      console.log = () => {};
      try {
        const t = wakerPass({ db, spawn: () => 5151, startOf: () => "9", alive: () => true, signalWarm: () => {}, runnerIdentity: { codeVersion: "v1", configHash: h } }).started[0]!;
        expect(getTurn(db, t)!.pid).toBe(5151);
      } finally {
        console.log = origLog;
      }
    }
  });

  test("the abandon, its stop and its close are one transaction; a turn left abandoned and running is reaped as never started", () => {
    const db = memDb();
    ownerSays(db, "hello");
    const chatId = ownerChatId(db);
    registerWarm(db, row(chatId, 4242, new Date().toISOString()), 2);
    const handed = wakerPass({ db, spawn: () => 1, alive: () => true, signalWarm: () => {} }).started[0]!;
    // One call does it all, or nothing: a pending hand-off is abandoned AND closed, unfailed.
    expect(closeNeverStarted(db, handed, HANDOFF_LOST, { abandon: true })).toBe(true);
    const t = getTurn(db, handed)!;
    expect([t.status, t.handoff, t.error, t.stopSeq]).toEqual(["stopped", "abandoned", HANDOFF_LOST, t.fromSeq]);
    expect(closeNeverStarted(db, handed, HANDOFF_LOST, { abandon: true })).toBe(false);
    // Defence: a running turn somehow left `abandoned` (a crash under older code) is closed as never started.
    ownerSays(db, "again");
    registerWarm(db, row(chatId, 4242, new Date().toISOString()), 2);
    const second = wakerPass({ db, spawn: () => 1, alive: () => true, signalWarm: () => {} }).started[0]!;
    db.$client.query("update turns set handoff = 'abandoned' where id = ?").run(second);
    const sig: string[] = [];
    const r = wakerPass({ db, spawn: () => 1, alive: () => true, signal: (p, _s, s) => void sig.push(`${p}:${s}`), wake: false });
    expect(r.reaped).toEqual([second]);
    expect([getTurn(db, second)!.status, getTurn(db, second)!.error]).toEqual(["stopped", HANDOFF_LOST]);
    expect(sig).toEqual(["4242:SIGKILL"]);
    expect(alerts(db)).toEqual([]);
    expect(retryDelayMs(db, chatId, Date.now())).toBe(0);
  });

  test("a lost conversation reported after the turn's result does not start the turn over", async () => {
    const db = memDb();
    ownerSays(db, "hello");
    const chatId = ownerChatId(db);
    db.$client.query("update chats set backend_session_id = 's-old' where id = ?").run(chatId);
    const turn = claimTurn(db, chatId)!;
    const usage = { model: "fake", costUsd: 0.001, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 };
    let fresh = 0;
    const adapter: BackendAdapter = {
      id: "lost-after-result",
      run: async () => {
        fresh++;
        return { text: "again", backendSessionId: "s-new", usage };
      },
      continueRun: async (_input, opts) => {
        opts.onToken?.("Answered.");
        opts.onResult?.({ text: "Answered.", backendSessionId: "s-old", usage });
        throw new LostSessionError("s-old");
      },
    };
    const origErr = console.error;
    const outcome = await runTurn({ db, turnId: turn.id, home: tmp(), timeZone: "UTC", capabilities: enabledCapabilities({ SHUVI_WEB: "off" }), makeAdapter: () => adapter });
    console.error = origErr;
    expect(outcome).toBe("done");
    expect(fresh).toBe(0);
    expect(getChat(db, chatId)!.backendSessionId).toBe("s-old");
    const rows = db.$client.query("select payload from chat_events where kind = 'bot_message'").all() as { payload: string }[];
    expect(rows.map((r) => JSON.parse(r.payload).text)).toEqual(["Answered."]);
  });

  test("the owner's name: one rule for the turn and the warm runner (his latest message in the input, else the latest here)", () => {
    const db = memDb();
    ownerSays(db, "hi", { from: { id: OWNER, name: "Old Name" } });
    const chatId = ownerChatId(db);
    const done = claimTurn(db, chatId)!;
    finishTurn(db, done.id, { status: "done" });
    // No input: the name he last wrote under.
    expect(turnOwnerName(db, chatId, OWNER, [])).toBe("Old Name");
    ownerSays(db, "first", { from: { id: OWNER, name: "First" } });
    ownerSays(db, "someone", { from: { id: 77, name: "Someone" } });
    ownerSays(db, "second", { from: { id: OWNER, name: "Second" } });
    const input = triggersAfter(db, chatId, getChat(db, chatId)!.cursorSeq);
    // The latest of his in the input, not the first, and never someone else's.
    expect(turnOwnerName(db, chatId, OWNER, input)).toBe("Second");
    // A warm runner looks at the same events (what is past the cursor): the same name.
    expect(turnOwnerName(db, chatId, OWNER, triggersAfter(db, chatId, getChat(db, chatId)!.cursorSeq))).toBe("Second");
  });
});

describe("SHUVI_WARM_* (env.ts)", () => {
  test("off by default, 600 s, 2; on with on/1/true; bad values refused", () => {
    expect(warmFromEnv({})).toEqual({ enabled: false, idleMs: 600_000, max: 2 });
    for (const v of ["on", "1", "true", "ON"]) expect(warmFromEnv({ SHUVI_WARM_RUNNERS: v }).enabled).toBe(true);
    for (const v of ["off", "0", "", "yes"]) expect(warmFromEnv({ SHUVI_WARM_RUNNERS: v }).enabled).toBe(false);
    expect(warmFromEnv({ SHUVI_WARM_IDLE_SEC: "30", SHUVI_WARM_MAX: "5" })).toEqual({ enabled: false, idleMs: 30_000, max: 5 });
    expect(() => warmFromEnv({ SHUVI_WARM_IDLE_SEC: "0" })).toThrow();
    expect(() => warmFromEnv({ SHUVI_WARM_MAX: "1.5" })).toThrow();
  });
});
