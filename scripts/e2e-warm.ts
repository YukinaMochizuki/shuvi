#!/usr/bin/env bun
/**
 * Warm runners (`SHUVI_WARM_RUNNERS=on`, src/runner/warm.ts), end to end:
 *
 *   fake Telegram Bot API ⇄ shuvi server ⇄ runner child, staying warm ⇄ resident Claude Code CLI ⇄ fake Anthropic API
 *
 *   1. Two consecutive turns in one chat run in the same runner process, on one CLI: the second is HANDED to the
 *      warm runner (`timings.handed`, no `spawned`), and starts no CLI (no `cli` mark; the CLI's pid is the same).
 *   2. An edit to home/ between turns re-warms the runner within a few seconds, before the next message: a new CLI
 *      in the same runner, a new fingerprint on its row. The next turn is handed to it, starts no CLI, and its
 *      request carries the new system prompt. Each turn is charged its own cost, not its CLI's running total, also
 *      the first on a CLI that resumed the conversation.
 *   2b. A warm turn whose model call fails (the fake API answers 400 once) closes as `failed`, says nothing, raises
 *      the owner's alert, and is retried on the same input after the backoff, as a cold turn is.
 *   3. `/stop` mid-turn: the turn closes as stopped, and its runner exits instead of staying warm.
 *   4. SIGKILL of the server while a runner is idle: the next server (same code) adopts it, and the next turn is
 *      handed to it.
 *   5. SIGTERM to the server: an idle runner exits at once. Then a running turn finishes and is delivered during
 *      the drain, and its runner exits instead of staying.
 *   6. The `turns.timings` of the cold, the warm and the re-warmed turn, side by side, and the RSS of an idle warm
 *      runner with its CLI.
 *
 *   bun scripts/e2e-warm.ts
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/store/db.ts";
import { isAlive } from "../src/server/spawn.ts";
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
    await Bun.sleep(50);
  }
}

// ---- fake Anthropic: a short reply per message; two slow ones ----------------------------------------------
type Msg = { role: string; content: unknown };
const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
function reply(id: string, text: string): Response {
  let out = ev("message_start", { message: { id, type: "message", role: "assistant", model: "claude-fake", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 1 } } });
  out += ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  out += ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
  out += ev("content_block_stop", { index: 0 });
  out += ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } });
  out += ev("message_stop", {});
  return new Response(out, { headers: { "content-type": "text/event-stream" } });
}
/** Every model request of a turn (it offers `say`): its system prompt and its last message. */
const requests: { system: string; latest: string }[] = [];
let slowStarted = false;
/** Section 2b: requests for "fail once" get a 400 until a turn has failed on it (the CLI may ask again within a turn). */
const aTurnFailed = () => !!db.$client.query("select 1 from turns where status = 'failed'").get();
let failedRequests = 0;
const anthropic = Bun.serve({
  port: 0,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as { system?: unknown; messages?: Msg[]; tools?: Array<{ name: string }> }) : {};
    if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 10 });
    if (!url.pathname.endsWith("/v1/messages")) return Response.json({});
    if (!body.tools?.some((t) => t.name === "mcp__shuvi__say")) return reply("msg_side", "ok");
    const latest = JSON.stringify(body.messages?.at(-1) ?? "");
    requests.push({ system: JSON.stringify(body.system ?? ""), latest });
    const n = requests.length;
    if (latest.includes("a slow one, stop me")) {
      slowStarted = true;
      await Bun.sleep(30_000); // only ever cut short by /stop
      return reply(`msg_${n}`, "must not be sent");
    }
    if (latest.includes("slow but it finishes")) {
      slowStarted = true;
      await Bun.sleep(3000);
      return reply(`msg_${n}`, "Finished during the drain.");
    }
    if (latest.includes("fail once")) {
      if (!aTurnFailed()) {
        failedRequests++;
        return Response.json({ type: "error", error: { type: "invalid_request_error", message: "forced failure for the e2e" } }, { status: 400 });
      }
      return reply(`msg_${n}`, "Recovered.");
    }
    const m = /say (\w+)/.exec(latest);
    return reply(`msg_${n}`, m ? `Reply ${m[1]}.` : "Hm.");
  },
});

// ---- the world ---------------------------------------------------------------------------------------
const tg = new FakeTelegram();
const dataDir = mkdtempSync(join(tmpdir(), "shuvi-e2e-warm-"));
const env = {
  ...process.env,
  SHUVI_DATA_DIR: dataDir,
  SHUVI_BOT_TOKEN: "TOKEN",
  SHUVI_OWNER_ID: String(OWNER),
  SHUVI_TELEGRAM_API_ROOT: tg.apiRoot,
  SHUVI_MODEL: "claude-sonnet-4-5",
  SHUVI_TZ: "Asia/Taipei",
  SHUVI_METRICS_LISTEN: "127.0.0.1:0",
  SHUVI_WARM_RUNNERS: "on",
  ANTHROPIC_BASE_URL: `http://localhost:${anthropic.port}`,
  ANTHROPIC_API_KEY: "sk-ant-fake",
};
let server: ReturnType<typeof Bun.spawn> | null = null;
const serverLines: string[] = [];
const startServer = () => {
  server = Bun.spawn([process.execPath, "src/server/main.ts"], { env, stdout: "pipe", stderr: "inherit", detached: true });
  tapLines(server.stdout, (line) => {
    serverLines.push(line);
    if (/warm|turn \d+:/.test(line)) console.log(`    | ${line}`);
  });
};
/** Every runner pid this script has seen, killed at the end (a warm runner outlives the server by design). */
const runners = new Set<number>();
function cleanup() {
  try {
    if (server) process.kill(-server.pid, "SIGKILL");
  } catch {}
  for (const pid of runners) {
    for (const c of cliPids(pid)) {
      try {
        process.kill(c, "SIGKILL");
      } catch {}
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  tg.stop();
  anthropic.stop(true);
}
const texts = () => tg.sent().map((b) => String(b.text));
const db = openDb(join(dataDir, "shuvi.db"), { migrate: true });
const q = <T>(sql: string, ...args: (string | number)[]) => db.$client.query(sql).get(...args) as T;
type TurnRow = { id: number; status: string; pid: number | null; pid_start: string | null; handoff: string | null; timings: string | null };
const turn = (id: number) => q<TurnRow>("select id, status, pid, pid_start, handoff, timings from turns where id = ?", id);
const lastTurn = () => q<TurnRow>("select id, status, pid, pid_start, handoff, timings from turns order by id desc limit 1");
const marks = (t: TurnRow) => (t.timings ? (JSON.parse(t.timings) as Record<string, number>) : {});
type WarmRow = { pid: number; pid_start: string | null; fingerprint: string; cli_started_at: string | null; code_version: string };
const warmRow = () => q<WarmRow | null>("select pid, pid_start, fingerprint, cli_started_at, code_version from warm_runners where chat_id = 1");

/** The Claude Code CLIs a runner runs (its children whose command line names claude). */
function cliPids(parent: number): number[] {
  const out: number[] = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(rest[1]) !== parent || rest[0] === "Z") continue;
      if (readFileSync(`/proc/${d}/cmdline`, "utf8").includes("claude")) out.push(Number(d));
    } catch {}
  }
  return out;
}
const rssKb = (pid: number) => Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0);

let update = 0;
async function say(text: string, expect: string): Promise<TurnRow> {
  const before = texts().length;
  tg.updates.push(dmUpdate(++update, text));
  await until(`the reply "${expect}"`, () => texts().slice(before).includes(expect));
  await until("the turn to close", () => lastTurn().status !== "running");
  const t = lastTurn();
  if (t.pid) runners.add(t.pid);
  return t;
}

// ---- 1. two turns, one runner, one CLI -------------------------------------------------------------------
startServer();
const cold = await say("please say one", "Reply one.");
check(cold.status === "done" && !!marks(cold).spawned && !marks(cold).handed, "the first turn was spawned (cold)");
await until("the runner to wait, warm", () => warmRow()?.pid === cold.pid);
const runner = cold.pid!;
const cli1 = cliPids(runner);
check(cli1.length === 1, `the warm runner holds one Claude Code CLI (${cli1.join(",")})`);
check(warmRow()!.code_version.length > 0 && !!warmRow()!.cli_started_at, "its row has its code version and its CLI's start");

const warm = await say("please say two", "Reply two.");
const wm = marks(warm);
check(warm.pid === runner && warm.handoff === "acked", `the second turn ran in the same runner (pid ${warm.pid}), handed over and taken`);
check(!!wm.handed && !wm.spawned && !wm.child && !!wm.acked, "its timings say handed (not spawned), and acked");
check(!wm.cli, "it started no CLI");
check(JSON.stringify(cliPids(runner)) === JSON.stringify(cli1), "the CLI is the same process");
await until("the runner to wait again", () => warmRow()?.pid === runner);

// ---- 2. an edit to home/ re-warms the runner before the next message ----------------------------------------
const fpBefore = warmRow()!.fingerprint;
mkdirSync(join(dataDir, "home", "memory"), { recursive: true });
writeFileSync(join(dataDir, "home", "memory", "private.md"), "- Favourite colour: WARM-EDIT-MARKER\n");
const editedAt = Date.now();
await until("the re-warm", () => !!warmRow() && warmRow()!.fingerprint !== fpBefore, 10_000);
const rewarmMs = Date.now() - editedAt;
check(rewarmMs < 6000, `the runner re-warmed ${(rewarmMs / 1000).toFixed(1)} s after the edit, with no message`);
check(warmRow()!.pid === runner, "the same runner");
await until("its new CLI", () => cliPids(runner).some((p) => !cli1.includes(p)), 10_000);
await until("the old CLI to be gone", () => cliPids(runner).every((p) => !cli1.includes(p)), 15_000);
const cli2 = cliPids(runner);
check(cli2.length === 1 && cli2[0] !== cli1[0], `a new CLI (${cli1[0]} → ${cli2[0]})`);
const nReq = requests.length;
const rewarmed = await say("please say three", "Reply three.");
const rm = marks(rewarmed);
check(rewarmed.pid === runner && !!rm.handed && !rm.cli, "the next turn was handed to the runner and started no CLI");
check(requests.slice(nReq).every((r) => r.system.includes("WARM-EDIT-MARKER")) && requests.length > nReq, "its request carries the new system prompt");
check(!requests[nReq - 1]!.system.includes("WARM-EDIT-MARKER"), "(the request before the edit did not)");
await until("the runner to wait again", () => warmRow()?.pid === runner);

// The cost recorded on each turn is that turn's, not the resident CLI's running total.
const costOf = (id: number) => q<{ c: number | null }>("select cost_micro_usd as c from turns where id = ?", id).c ?? 0;
check(costOf(warm.id) > 0 && costOf(warm.id) <= costOf(cold.id), `a warm turn on the running CLI is charged its own cost, not the CLI's total (cold ${costOf(cold.id)}, warm ${costOf(warm.id)} µ$)`);
// So is the first turn of a CLI that resumed the conversation (the re-warmed one), not the conversation's total.
check(costOf(rewarmed.id) > 0 && costOf(rewarmed.id) <= costOf(cold.id), `the first turn of a resumed CLI is charged its own cost too (re-warmed ${costOf(rewarmed.id)} µ$)`);

// ---- 2b. a failed warm turn: failed, alerted, nothing said, retried --------------------------------------------
const beforeFail = texts().length;
tg.updates.push(dmUpdate(++update, "please fail once"));
await until("the failing turn to close", () => lastTurn().id > rewarmed.id && lastTurn().status !== "running", 30_000);
const failed = lastTurn();
check(failed.pid === runner && !!marks(failed).handed, "the failing turn ran in the warm runner");
check(failed.status === "failed", `it closed as failed (${failed.status})`);
check(!!q<{ k: string } | null>("select idem_key as k from control_messages where idem_key = ?", `turn-failed:${failed.id}`), "the owner is alerted");
await until("the retry's answer", () => texts().slice(beforeFail).includes("Recovered."), 30_000);
const retried = lastTurn();
if (retried.pid) runners.add(retried.pid);
const fromOf = (id: number) => q<{ f: number }>("select from_seq as f from turns where id = ?", id).f;
check(retried.id > failed.id && fromOf(retried.id) === fromOf(failed.id), "the same input was answered again");
check(JSON.stringify(texts().slice(beforeFail)) === JSON.stringify(["Recovered."]), `the failed turn said nothing (${texts().slice(beforeFail).join("|")})`);
log(`    (${failedRequests} request(s) refused; the retry ran ${retried.pid === runner ? "in the same warm runner" : `in a new runner (${retried.pid})`})`);
await until("a runner to wait again", () => !!warmRow(), 10_000);
const current = warmRow()!.pid;
const currentClis = cliPids(current);

// ---- 6 (measured here). the RSS of an idle warm runner and its CLI --------------------------------------------
await Bun.sleep(1000);
const rss = { bun: rssKb(current), cli: cliPids(current).reduce((a, p) => a + rssKb(p), 0) };
log(`RSS of the idle warm runner: bun ${(rss.bun / 1024).toFixed(0)} MiB + CLI ${(rss.cli / 1024).toFixed(0)} MiB = ${((rss.bun + rss.cli) / 1024).toFixed(0)} MiB`);

// ---- 3. /stop mid-turn: stopped, and the runner exits -------------------------------------------------------
slowStarted = false;
tg.updates.push(dmUpdate(++update, "a slow one, stop me"));
await until("the slow model step", () => slowStarted);
const slow = lastTurn();
check(slow.pid === current && slow.status === "running", "the slow turn runs in the warm runner");
tg.updates.push(dmUpdate(++update, "/stop"));
await until("the turn to stop", () => turn(slow.id).status !== "running", 20_000);
check(turn(slow.id).status === "stopped", "the turn closed as stopped");
await until("the runner to exit", () => !isAlive(current, slow.pid_start), 15_000);
check(!warmRow(), "and it did not stay warm");
await until("its CLI to be gone", () => currentClis.every((p) => !isAlive(p)), 15_000);
log("ok  its CLI is gone too");

// ---- 4. SIGKILL of the server while a runner is idle: the next server adopts it -------------------------------
const five = await say("please say five", "Reply five.");
check(!!marks(five).spawned, "a cold runner for the next turn");
const r2 = five.pid!;
await until("it to wait, warm", () => warmRow()?.pid === r2);
process.kill(-server!.pid, "SIGKILL");
await server!.exited;
server = null;
check(isAlive(r2, five.pid_start), "the server was killed with its process group; the warm runner, detached, is alive");
startServer();
await until("the next server", () => serverLines.filter((l) => l.startsWith("warm runners on")).length >= 2);
check(warmRow()?.pid === r2, "the next server adopted it (same code and configuration): its row stays");
const six = await say("please say six", "Reply six.");
check(six.pid === r2 && !!marks(six).handed && !marks(six).cli, "the next turn was handed to it, on its CLI");
await until("it to wait again", () => warmRow()?.pid === r2);

// ---- 5. SIGTERM to the server: an idle runner exits at once; a running turn finishes, and its runner exits ----
server!.kill("SIGTERM");
const termAt = Date.now();
await until("the idle runner to exit", () => !isAlive(r2, six.pid_start), 5000);
check(Date.now() - termAt < 3000, `the idle runner exited ${Date.now() - termAt} ms after the server's SIGTERM`);
check((await server!.exited) === 0, "the server exited 0");
server = null;
check(!warmRow(), "no warm runner is left");

startServer();
slowStarted = false;
const beforeDrain = texts().length;
tg.updates.push(dmUpdate(++update, "slow but it finishes"));
await until("the slow model step", () => slowStarted);
const draining = lastTurn();
runners.add(draining.pid!);
server!.kill("SIGTERM");
check((await server!.exited) === 0, "the server drained and exited 0");
server = null;
check(turn(draining.id).status === "done", "the running turn finished");
check(texts().slice(beforeDrain).includes("Finished during the drain."), "and was delivered");
await until("its runner to exit", () => !isAlive(draining.pid!, draining.pid_start), 10_000);
check(!warmRow(), "its runner exited instead of staying warm (the drain flag)");

// ---- 6. timings: cold, warm, re-warmed --------------------------------------------------------------------------
const sentAt = (id: number) =>
  q<{ s: string | null } | null>("select sent_at as s from chat_events where turn_id = ? and kind = 'bot_message' order by seq limit 1", id)?.s ?? null;
const rows: [string, TurnRow][] = [
  ["cold", turn(cold.id)],
  ["warm", turn(warm.id)],
  ["re-warmed", turn(rewarmed.id)],
];
const order = ["claimed", "spawned", "handed", "child", "acked", "ready", "cli", "query", "firstOutput", "result", "queuedFirst", "returned"];
console.log("\nturns.timings, ms after `claimed` (and sent: chat_events.sent_at of its reply)");
console.log(["mark".padEnd(12), ...rows.map(([n]) => n.padStart(10))].join(""));
for (const k of [...order, "sent"]) {
  const cells = rows.map(([, t]) => {
    const m = marks(t);
    const v = k === "sent" ? (sentAt(t.id) ? Date.parse(sentAt(t.id)!) : undefined) : m[k];
    return (v === undefined || m.claimed === undefined ? "-" : String(v - m.claimed)).padStart(10);
  });
  console.log([k.padEnd(12), ...cells].join(""));
}
console.log("");

log("PASS");
cleanup();
process.exit(0);
