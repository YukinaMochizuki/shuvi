#!/usr/bin/env bun
/**
 * The draining shutdown (src/server/drain.ts), end to end, the way a container stops the server: SIGTERM to
 * the server process alone (what `tini` forwards), nothing to the runner child.
 *
 *   fake Telegram Bot API ⇄ shuvi server ⇄ runner child ⇄ real Claude Code CLI ⇄ fake Anthropic API
 *
 *   1. A turn is mid-flight (its model step is slow) when SIGTERM arrives. The server stops polling, so a
 *      message sent during the drain stays with Telegram; /healthz still answers and says it is draining;
 *      the turn finishes, its last message is delivered, and the server exits 0. The next server fetches
 *      the message that waited, and answers it.
 *   2. The deadline (SHUVI_DRAIN_SEC=3): a turn that would run for a minute is stopped at the deadline. It
 *      closes as `stopped` with the cursor where it was, its late answer is never sent, the server exits 0,
 *      and the next server answers the same message again, told that it is a retry (render.ts RETRY_NOTE).
 *   3. A second SIGTERM during a drain exits at once, 0; the turn is left to whatever outlives the server.
 *   4. No grace (SHUVI_DRAIN_GRACE_SEC=0): the child is killed right after its SIGTERM, with the waker running
 *      beside the drain; the turn closes as stopped (never failed, no retry alert) and is answered again.
 *
 *   bun scripts/e2e-drain.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETRY_NOTE } from "../src/agent/render.ts";
import { openDb } from "../src/store/db.ts";
import { isAlive } from "../src/server/spawn.ts";
import { DRAIN_STOP } from "../src/store/turns.ts";
import { dmUpdate, FakeTelegram, OWNER, tapLines } from "../test/helpers.ts";

const t0 = Date.now();
const log = (m: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  cleanup();
  process.exit(1);
};
const check = (cond: unknown, m: string) => (cond ? log(`ok  ${m}`) : fail(m));
async function until(what: string, cond: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) fail(`timed out waiting for: ${what}`);
    await Bun.sleep(100);
  }
}

// ---- fake Anthropic --------------------------------------------------------------------------------------
type Block = { type: string; text?: string; tool_use_id?: string };
type Msg = { role: string; content: string | Block[] };
const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
function stream(id: string, blocks: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown }>, stop: string): Response {
  let out = ev("message_start", { message: { id, type: "message", role: "assistant", model: "claude-fake", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 1 } } });
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      out += ev("content_block_start", { index, content_block: { type: "text", text: "" } });
      out += ev("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
    } else {
      out += ev("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      out += ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    out += ev("content_block_stop", { index });
  });
  out += ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 9 } });
  out += ev("message_stop", {});
  return new Response(out, { headers: { "content-type": "text/event-stream" } });
}

let n = 0;
let slowStepStarted = false;
let hangStarted = false;
/** Section 2: false until the next server is up, so its retry of the same message answers at once. */
let hangAnswersFast = false;
/** What the retry of section 2 was given: its last message, and how often the stopped input is in the request. */
let retrySeen: { latest: string; repeats: number } | null = null;
let keepGoingStarted = false;
let stubbornStarted = false;
let stubbornAnswersFast = false;
let stubbornRetry = "";
const anthropic = Bun.serve({
  port: 0,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as { messages?: Msg[]; tools?: Array<{ name: string }> }) : {};
    if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 10 });
    if (!url.pathname.endsWith("/v1/messages")) return Response.json({});
    if (!body.tools?.some((t) => t.name === "mcp__shuvi__say")) return stream("msg_side", [{ type: "text", text: "ok" }], "end_turn");
    n++;
    const last = body.messages?.at(-1);
    const latest = JSON.stringify(last ?? "");
    const toolResult = Array.isArray(last?.content) && last.content.some((b) => b.type === "tool_result");
    // Section 2: a model step that takes a minute, unless the next server is asking.
    if (latest.includes("think about it for a minute")) {
      if (hangAnswersFast) {
        retrySeen = { latest, repeats: JSON.stringify(body.messages ?? []).split("think about it for a minute").length - 1 };
        return stream(`msg_${n}`, [{ type: "text", text: "Answered after the restart." }], "end_turn");
      }
      hangStarted = true;
      await Bun.sleep(60_000); // cut short by the stop at the drain deadline
      return stream(`msg_${n}`, [{ type: "text", text: "must not be sent" }], "end_turn");
    }
    if (latest.includes("did you get this one")) return stream(`msg_${n}`, [{ type: "text", text: "Got the one that waited." }], "end_turn");
    // Section 3: a step that outlasts its server's (cut short) drain.
    if (latest.includes("keep going please")) {
      keepGoingStarted = true;
      await Bun.sleep(6000);
      return stream(`msg_${n}`, [{ type: "text", text: "Finished without a server." }], "end_turn");
    }
    // Section 4: a step the drain's SIGTERM does not get to end in time, so the child is killed.
    if (latest.includes("a stubborn one")) {
      if (stubbornAnswersFast) {
        stubbornRetry = latest;
        return stream(`msg_${n}`, [{ type: "text", text: "Stubborn one answered." }], "end_turn");
      }
      stubbornStarted = true;
      await Bun.sleep(60_000);
      return stream(`msg_${n}`, [{ type: "text", text: "must not be sent either" }], "end_turn");
    }
    // Section 1: say something, then a slow step that the SIGTERM lands in.
    if (toolResult) {
      slowStepStarted = true;
      await Bun.sleep(4000);
      return stream(`msg_${n}`, [{ type: "text", text: "All done." }], "end_turn");
    }
    return stream(`msg_${n}`, [{ type: "tool_use", id: `toolu_${n}`, name: "mcp__shuvi__say", input: { text: "Working on it" } }], "tool_use");
  },
});

// ---- the world ---------------------------------------------------------------------------------------
const tg = new FakeTelegram();
const dataDir = mkdtempSync(join(tmpdir(), "shuvi-e2e-drain-"));
const env = {
  ...process.env,
  SHUVI_DATA_DIR: dataDir,
  SHUVI_BOT_TOKEN: "TOKEN",
  SHUVI_OWNER_ID: String(OWNER),
  SHUVI_TELEGRAM_API_ROOT: tg.apiRoot,
  SHUVI_MODEL: "claude-sonnet-4-5",
  SHUVI_TZ: "Asia/Taipei",
  SHUVI_METRICS_LISTEN: "127.0.0.1:0",
  ANTHROPIC_BASE_URL: `http://localhost:${anthropic.port}`,
  ANTHROPIC_API_KEY: "sk-ant-fake",
};
let server: ReturnType<typeof Bun.spawn> | null = null;
let healthPort = 0;
const startServer = (extra: Record<string, string> = {}) => {
  healthPort = 0;
  // Its own process group, only so that cleanup can kill whatever is left; the SIGTERM below goes to the pid.
  server = Bun.spawn([process.execPath, "src/server/main.ts"], { env: { ...env, ...extra }, stdout: "pipe", stderr: "inherit", detached: true });
  tapLines(server.stdout, (line) => {
    const m = /health: \/healthz and \/metrics on port (\d+)/.exec(line);
    if (m) healthPort = Number(m[1]);
  });
};
function cleanup() {
  try {
    if (server) process.kill(-server.pid, "SIGKILL");
  } catch {}
  tg.stop();
  anthropic.stop(true);
}
const texts = () => tg.sent().map((b) => String(b.text));
const db = openDb(join(dataDir, "shuvi.db"), { migrate: true });
const q = <T>(sql: string, ...args: (string | number)[]) => db.$client.query(sql).get(...args) as T;
const pollsSince = (i: number) => tg.calls.slice(i).filter((c) => c.method === "getUpdates").length;

// ---- 1. SIGTERM mid-turn: the turn finishes, its message goes out, the server exits 0 -------------------
startServer();
await until("the health endpoint", () => healthPort > 0);
const healthy = await fetch(`http://127.0.0.1:${healthPort}/healthz`);
check(healthy.status === 200, "/healthz answers 200 while serving");
tg.updates.push(dmUpdate(1, "Can you sort this out"));
await until("the say() message", () => texts().includes("Working on it"));
await until("the slow model step", () => slowStepStarted);

server!.kill("SIGTERM");
const sigtermAt = Date.now();
log("SIGTERM sent to the server while the turn is mid-flight");
await Bun.sleep(500);
const callsAtDrain = tg.calls.length;
tg.updates.push(dmUpdate(2, "did you get this one"));
const during = await fetch(`http://127.0.0.1:${healthPort}/healthz`);
const duringBody = (await during.json()) as { ok: boolean; draining: boolean };
check(during.status === 200 && duringBody.draining === true, `/healthz says draining while the turn finishes (${JSON.stringify(duringBody)})`);
const metrics = await (await fetch(`http://127.0.0.1:${healthPort}/metrics`)).text();
check(/^shuvi_draining 1$/m.test(metrics) && /^shuvi_turns_running 1$/m.test(metrics), "/metrics shows the drain and the running turn");

const code1 = await server!.exited;
server = null;
check(code1 === 0, `the server exited 0 (${code1}) after ${((Date.now() - sigtermAt) / 1000).toFixed(1)} s`);
check(texts().join("|") === "Working on it|All done.", `the turn's last message was sent before it exited (${texts().join("|")})`);
const turn1 = q<{ status: string }>("select status from turns where id = 1");
check(turn1.status === "done", "the turn finished as done");
check(q<{ n: number }>("select count(*) as n from chat_events where status = 'pending'").n === 0, "nothing was left pending");
check(pollsSince(callsAtDrain) === 0, "the server did not poll Telegram during the drain");
check(!q<{ seq: number } | null>("select seq from chat_events where tg_update_id = 2"), "the message sent during the drain was not fetched");

startServer();
await until("the message that waited to be answered", () => texts().includes("Got the one that waited."));
check(q<{ n: number }>("select count(*) as n from chat_events where tg_update_id = 2").n === 1, "the next server fetched it from Telegram");
await Bun.sleep(1000);
check(texts().filter((t) => t === "All done.").length === 1, "nothing was said twice");

// ---- 2. the deadline: the turn is stopped, closes cleanly, and is answered again after the restart -----
server!.kill("SIGTERM");
check((await server!.exited) === 0, "an idle server drains at once and exits 0");
server = null;
startServer({ SHUVI_DRAIN_SEC: "3" });
await until("the health endpoint", () => healthPort > 0);
const before = texts().length;
tg.updates.push(dmUpdate(3, "think about it for a minute"));
await until("the minute-long model step", () => hangStarted);
const hung = q<{ id: number; from_seq: number }>("select id, from_seq from turns where status = 'running'");
const cursorBefore = q<{ c: number }>("select cursor_seq as c from chats").c;
server!.kill("SIGTERM");
const deadlineAt = Date.now();
const code2 = await server!.exited;
server = null;
const took = (Date.now() - deadlineAt) / 1000;
check(code2 === 0, `the server exited 0 (${code2})`);
check(took >= 3 && took < 25, `at the deadline, not after the model step (${took.toFixed(1)} s)`);
const stopped = q<{ status: string; stop_seq: number | null; from_seq: number }>("select status, stop_seq, from_seq from turns where id = ?", hung.id);
check(stopped.status === "stopped" && stopped.stop_seq === stopped.from_seq, `the turn closed as stopped, its stop placed at its start (${JSON.stringify(stopped)})`);
check(q<{ c: number }>("select cursor_seq as c from chats").c === cursorBefore, "the cursor did not move past the message");
const alert = q<{ text: string } | null>("select text from control_messages where idem_key = ?", `drain-stop:${hung.id}`);
check(!!alert && alert.text.includes("drain deadline"), "the owner is told in the control bot");

hangAnswersFast = true;
startServer();
await until("the same message answered again", () => texts().includes("Answered after the restart."));
const retry = q<{ from_seq: number; status: string }>("select from_seq, status from turns order by id desc limit 1");
check(retry.from_seq === hung.from_seq, "the next server answered the same input");
await Bun.sleep(1000);
check(!texts().includes("must not be sent"), "the stopped turn's late answer was never sent");
check(texts().length === before + 1, `one answer (${texts().slice(before).join("|")})`);
const seen = retrySeen as { latest: string; repeats: number } | null;
check(!!seen && seen.latest.includes(RETRY_NOTE.slice(1, 60)), "the retry is told the previous turn on these messages was cut off by a restart");
log(`    (the stopped input is in the retried request ${seen?.repeats} time(s): the resumed conversation holds it, and the note says why)`);

// ---- 3. a second signal ends the drain at once ------------------------------------------------------------
const before3 = texts().length;
tg.updates.push(dmUpdate(4, "keep going please"));
await until("the long model step", () => keepGoingStarted);
const long = q<{ id: number }>("select id from turns where status = 'running'");
server!.kill("SIGTERM");
await Bun.sleep(500);
server!.kill("SIGTERM");
const secondAt = Date.now();
const code3 = await server!.exited;
server = null;
check(code3 === 0 && Date.now() - secondAt < 3000, `a second SIGTERM exits at once, 0 (${code3}, ${Date.now() - secondAt} ms)`);
check(q<{ status: string }>("select status from turns where id = ?", long.id).status === "running", "its turn is left running (here its detached child carries on; in a container it would die and be retried)");
await until("the turn to finish on its own", () => q<{ status: string }>("select status from turns where id = ?", long.id).status !== "running", 30_000);
startServer();
await until("its answer, sent by the next server", () => texts().includes("Finished without a server."));
await Bun.sleep(1000);
check(texts().length === before3 + 1, "sent once");

// ---- 4. SIGKILL after the grace, with the waker running beside the drain -----------------------------------
server!.kill("SIGTERM");
check((await server!.exited) === 0, "the idle server exits 0");
server = null;
// No grace: the drain kills the child right after its SIGTERM, before it can close its own turn, while the
// waker keeps reaping. Whoever closes it, it must close as stopped, not failed.
startServer({ SHUVI_DRAIN_SEC: "2", SHUVI_DRAIN_GRACE_SEC: "0" });
await until("the health endpoint", () => healthPort > 0);
const before4 = texts().length;
tg.updates.push(dmUpdate(5, "a stubborn one"));
await until("the stubborn model step", () => stubbornStarted);
const stubborn = q<{ id: number; from_seq: number; pid: number; pid_start: string | null }>("select id, from_seq, pid, pid_start from turns where status = 'running'");
server!.kill("SIGTERM");
const code4 = await server!.exited;
server = null;
check(code4 === 0, `the server exited 0 (${code4})`);
// Gone as the server judges it (spawn.ts `isAlive`: the pid no longer runs the process started for the turn).
// Not `kill(pid, 0)`: that also succeeds on a zombie, and the killed child stays one until whoever inherited it
// from the exited server reaps it, which on a loaded machine can take a while. So wait for it, bounded.
await until("the runner child to be gone", () => !isAlive(stubborn.pid, stubborn.pid_start), 10_000);
log("ok  the runner child was killed");
const killedTurn = q<{ status: string; error: string | null; stop_seq: number | null; from_seq: number }>("select status, error, stop_seq, from_seq from turns where id = ?", stubborn.id);
check(killedTurn.status === "stopped" && killedTurn.error === DRAIN_STOP && killedTurn.stop_seq === killedTurn.from_seq, `closed as stopped by the drain, not failed (${JSON.stringify(killedTurn)})`);
check(!q<{ k: string } | null>("select idem_key as k from control_messages where idem_key = ?", `turn-failed:${stubborn.id}`), "no 'turn failed, will be retried' alert");
stubbornAnswersFast = true;
startServer();
await until("the stubborn one answered again", () => texts().includes("Stubborn one answered."));
check(q<{ from_seq: number }>("select from_seq from turns order by id desc limit 1").from_seq === stubborn.from_seq, "the next server answered the same input");
await Bun.sleep(1000);
check(!texts().includes("must not be sent either") && texts().length === before4 + 1, `one answer (${texts().slice(before4).join("|")})`);
log(`    (retry note on the killed turn's retry: ${stubbornRetry.includes(RETRY_NOTE.slice(1, 60)) ? "yes" : "no, its conversation was not saved before the kill"})`);

log("PASS");
cleanup();
process.exit(0);
