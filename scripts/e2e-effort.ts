#!/usr/bin/env bun
/**
 * Effort on the wire (store/models.ts EFFORT), end to end:
 *
 *   fake Telegram Bot API ⇄ shuvi server ⇄ runner child (cold, then warm) ⇄ real Claude Code CLI ⇄ fake Anthropic API
 *
 * What the CLI puts on the wire for a turn's effort is `output_config: { effort: <level> }` beside
 * `thinking: { type: "adaptive" }` (claude/opus, which stands for claude-opus-5-5 in the CLI used here); with no
 * effort given, the CLI sends its own default level there. This script asserts the field.
 *
 *   1. The server lists the login in the background and records claude/opus's effort levels (no listing asked).
 *   2. COLD (SHUVI_WARM_RUNNERS off): unset everywhere, the turn records none and its request carries the CLI's own
 *      default. The chat's effort set to `low` through the console's write boundary: the next request carries
 *      `low` (source chat). The override cleared and the model's default set to `max` in Settings: `max` (source
 *      model).
 *   3. WARM (on): a first turn spawns a runner (`max`); the runner stays. The chat's effort changed to `high`
 *      between two warm turns: the next turn is handed to the same runner, starts NO new CLI (no `cli` mark, the
 *      same CLI process) and its request carries `high`. Both cleared: the next warm turn's request carries the
 *      CLI's own default again, on the same CLI.
 *
 *   bun scripts/e2e-effort.ts
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/store/db.ts";
import { consolePortIn, dmUpdate, FakeTelegram, OWNER, tapLines } from "../test/helpers.ts";

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

// ---- fake Anthropic: a short reply; every turn's request kept with what it says of effort ------------------
const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
function reply(text: string): Response {
  let out = ev("message_start", { message: { id: "msg_x", type: "message", role: "assistant", model: "claude-fake", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 1 } } });
  out += ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  out += ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
  out += ev("content_block_stop", { index: 0 });
  out += ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } });
  out += ev("message_stop", {});
  return new Response(out, { headers: { "content-type": "text/event-stream" } });
}
type Wire = { latest: string; model: string; effort: string | null; thinking: unknown };
const requests: Wire[] = [];
const anthropic = Bun.serve({
  port: 0,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as { model?: string; messages?: unknown[]; tools?: Array<{ name: string }>; output_config?: { effort?: string }; thinking?: unknown }) : {};
    if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 10 });
    if (!url.pathname.endsWith("/v1/messages")) return Response.json({});
    if (!body.tools?.some((t) => t.name === "mcp__shuvi__say")) return reply("ok");
    // The newest "please say <word>" in the conversation is what this turn answers.
    const word = [...JSON.stringify(body.messages ?? []).matchAll(/please say (\w+)/g)].at(-1)?.[1];
    requests.push({ latest: word ? `please say ${word}` : "", model: String(body.model), effort: body.output_config?.effort ?? null, thinking: body.thinking ?? null });
    return reply(word ? `Reply ${word}.` : "Hm.");
  },
});

// ---- the world ---------------------------------------------------------------------------------------
const tg = new FakeTelegram();
const dataDir = mkdtempSync(join(tmpdir(), "shuvi-e2e-effort-"));
const baseEnv = {
  ...process.env,
  SHUVI_DATA_DIR: dataDir,
  SHUVI_BOT_TOKEN: "TOKEN",
  SHUVI_OWNER_ID: String(OWNER),
  SHUVI_TELEGRAM_API_ROOT: tg.apiRoot,
  SHUVI_MODEL: "opus",
  SHUVI_TZ: "Asia/Taipei",
  SHUVI_METRICS_LISTEN: "127.0.0.1:0",
  SHUVI_CONSOLE_LISTEN: "127.0.0.1:0",
  SHUVI_CONSOLE_USERS: "owner@example.com",
  // A warm runner left behind idles out soon, so it never holds this script's pipes for long.
  SHUVI_WARM_IDLE_SEC: process.env.SHUVI_WARM_IDLE_SEC ?? "60",
  ANTHROPIC_BASE_URL: `http://localhost:${anthropic.port}`,
  ANTHROPIC_API_KEY: "sk-ant-fake",
};
let server: ReturnType<typeof Bun.spawn> | null = null;
let consolePort = 0;
const startServer = (warm: boolean) => {
  consolePort = 0;
  server = Bun.spawn([process.execPath, "src/server/main.ts"], { env: { ...baseEnv, SHUVI_WARM_RUNNERS: warm ? "on" : "off" }, stdout: "pipe", stderr: "inherit", detached: true });
  tapLines(server.stdout, (line) => (consolePort = consolePortIn(line) ?? consolePort));
};
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
const texts = () => tg.sent().map((b) => String(b.text));
const db = openDb(join(dataDir, "shuvi.db"), { migrate: true });
const q = <T>(sql: string, ...args: (string | number)[]) => db.$client.query(sql).get(...args) as T;
type TurnRow = { id: number; status: string; pid: number | null; effort: string | null; source: string | null; timings: string | null };
const lastTurn = () => q<TurnRow>("select id, status, pid, effort, effort_source as source, timings from turns order by id desc limit 1");
const marks = (t: TurnRow) => (t.timings ? (JSON.parse(t.timings) as Record<string, number>) : {});
const warmRow = () => q<{ pid: number } | null>("select pid from warm_runners where chat_id = 1");

let update = 0;
/** Send `say <word>`, wait for its reply and the turn's end; the turn, and its requests' efforts. */
async function say(word: string): Promise<{ turn: TurnRow; wire: Wire[] }> {
  const before = texts().length;
  tg.updates.push(dmUpdate(++update, `please say ${word}`));
  await until(`the reply to "${word}"`, () => texts().slice(before).includes(`Reply ${word}.`));
  await until("the turn to close", () => lastTurn().status !== "running");
  const turn = lastTurn();
  if (turn.pid) runners.add(turn.pid);
  return { turn, wire: requests.filter((r) => r.latest === `please say ${word}`) };
}
const efforts = (w: Wire[]) => [...new Set(w.map((r) => r.effort))];

// The console, signed in by the tailnet header, through its write boundary (Origin + CSRF).
const login = { "Tailscale-User-Login": "owner@example.com" };
async function consolePost(path: string, fields: Record<string, string>): Promise<void> {
  const origin = `http://127.0.0.1:${consolePort}`;
  const html = await (await fetch(`${origin}/chats/1/settings`, { headers: login })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? fail("no CSRF token on the page");
  const res = await fetch(`${origin}${path}`, { method: "POST", redirect: "manual", headers: { ...login, origin }, body: new URLSearchParams({ csrf, ...fields }) });
  check(res.status === 303, `POST ${path} ${JSON.stringify(fields)} → 303`);
}
const chatEffort = () => q<{ e: string | null }>("select effort as e from chats where id = 1").e;
const modelEffort = () => q<{ e: string | null }>("select effort as e from models where model = 'opus'").e;

// ---- 1. the levels, recorded in the background ----------------------------------------------------------------
startServer(false);
const levels = () => q<{ l: string | null } | null>("select effort_levels as l from models where model = 'opus'")?.l ?? null;
await until("claude/opus's effort levels, listed in the background", () => !!levels(), 60_000);
check(JSON.stringify(JSON.parse(levels()!)) === JSON.stringify(["low", "medium", "high", "xhigh", "max"]), `the server recorded claude/opus's levels with no listing asked (${levels()})`);
await until("the console", () => consolePort > 0);

// ---- 2. cold turns -------------------------------------------------------------------------------------------
const none = await say("one");
check(none.turn.effort === null && none.turn.source === "none", `unset everywhere: the turn records none (${none.turn.effort}, ${none.turn.source})`);
const cliDefault = none.wire[0]?.effort ?? null;
check(none.wire.length > 0 && efforts(none.wire).length === 1, `its request carries the CLI's own default: output_config.effort = ${cliDefault}, thinking ${JSON.stringify(none.wire[0]?.thinking)}`);

await consolePost("/chats/1/settings/effort", { effort: "low" });
check(chatEffort() === "low", "the chat's effort is low");
const low = await say("two");
check(!!marks(low.turn).spawned && JSON.stringify(efforts(low.wire)) === JSON.stringify(["low"]), `a cold turn's request carries output_config.effort = low (${JSON.stringify(efforts(low.wire))})`);
check(low.turn.effort === "low" && low.turn.source === "chat", `and the turn records low, from the chat (${low.turn.source})`);

await consolePost("/chats/1/settings/effort", { effort: "" });
await consolePost("/settings/models/effort", { model: "claude/opus", effort: "max" });
check(chatEffort() === null && modelEffort() === "max", "the override cleared, the model's default max");
const max = await say("three");
check(JSON.stringify(efforts(max.wire)) === JSON.stringify(["max"]) && max.turn.source === "model", `the model's default: output_config.effort = max, from the model (${JSON.stringify(efforts(max.wire))}, ${max.turn.source})`);

server!.kill("SIGTERM");
await server!.exited;
server = null;

// ---- 3. warm turns ---------------------------------------------------------------------------------------------
startServer(true);
await until("the console", () => consolePort > 0);
const first = await say("four");
check(!!marks(first.turn).spawned && JSON.stringify(efforts(first.wire)) === JSON.stringify(["max"]), `the first turn spawned a runner, at max (${JSON.stringify(efforts(first.wire))})`);
const runner = first.turn.pid!;
await until("the runner to wait, warm", () => warmRow()?.pid === runner);
const cli = cliPids(runner);
check(cli.length === 1, `it holds one Claude Code CLI (${cli.join(",")})`);

await consolePost("/chats/1/settings/effort", { effort: "high" });
const high = await say("five");
const hm = marks(high.turn);
check(high.turn.pid === runner && !!hm.handed && !hm.spawned, "the next turn was handed to the warm runner");
check(!hm.cli && JSON.stringify(cliPids(runner)) === JSON.stringify(cli), "it started no CLI: the same CLI process");
check(JSON.stringify(efforts(high.wire)) === JSON.stringify(["high"]) && high.turn.source === "chat", `and its request carries output_config.effort = high (${JSON.stringify(efforts(high.wire))})`);
await until("the runner to wait again", () => warmRow()?.pid === runner);

await consolePost("/chats/1/settings/effort", { effort: "" });
await consolePost("/settings/models/effort", { model: "claude/opus", effort: "" });
const back = await say("six");
const bm = marks(back.turn);
check(back.turn.pid === runner && !!bm.handed && !bm.cli && JSON.stringify(cliPids(runner)) === JSON.stringify(cli), "cleared: handed to the same runner, on the same CLI");
check(back.turn.effort === null && back.turn.source === "none" && JSON.stringify(efforts(back.wire)) === JSON.stringify([cliDefault]), `and its request is back to the CLI's own default (${JSON.stringify(efforts(back.wire))})`);

server!.kill("SIGTERM");
await server!.exited;
server = null;
log("PASS");
cleanup();
process.exit(0);
