#!/usr/bin/env bun
/**
 * Jobs, schedules and inbound sources, end to end (M6), with nothing real but the code under test and the
 * Claude Code CLI:
 *
 *   fake Telegram ⇄ shuvi server (+ its hooks on SHUVI_HOOK_LISTEN) ⇄ runner child ⇄ real Claude Code CLI
 *   ⇄ fake Anthropic;  fake workstream desk (MCP) ⇄ the server's job watcher
 *
 * Each scenario writes a framework event into the owner's DM and checks that it starts a turn there, that
 * the model is shown it as a framework event (not as someone speaking), and that the reply reaches
 * Telegram exactly once:
 *
 *   1. an inbound POST (and that a wrong token is 401 and an unknown source 404, writing nothing); the turn
 *      it starts tries an owner-only tool and is refused at call time
 *   2. a schedule set with the `schedule` tool firing a turn
 *   3. a job reported by callback (and a repeat report writing nothing)
 *   4. a job that expires (and the owner alert)
 *   5. `ask_workstream`: the desk's answer polled back as a job_done
 *
 *   bun scripts/e2e-jobs.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/store/db.ts";
import { createJob } from "../src/store/jobs.ts";
import { FakeDesk } from "../test/fake-desk.ts";
import { dmUpdate, FakeTelegram, OWNER } from "../test/helpers.ts";

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

// ---- fake Anthropic: answers by what the newest user message holds -----------------------------------
const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
let nextId = 0;
function stream(blocks: Array<{ type: "text"; text: string } | { type: "tool_use"; name: string; input: unknown }>): Response {
  const id = ++nextId;
  let out = ev("message_start", { message: { id: `msg_${id}`, type: "message", role: "assistant", model: "claude-fake", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 1 } } });
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      out += ev("content_block_start", { index, content_block: { type: "text", text: "" } });
      out += ev("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
    } else {
      out += ev("content_block_start", { index, content_block: { type: "tool_use", id: `toolu_${id}`, name: b.name, input: {} } });
      out += ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    out += ev("content_block_stop", { index });
  });
  const tool = blocks.some((b) => b.type === "tool_use");
  out += ev("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } });
  out += ev("message_stop", {});
  return new Response(out, { headers: { "content-type": "text/event-stream" } });
}
const say = (text: string) => stream([{ type: "text", text }]);
const seen: string[] = [];
let toolsOffered: string[] = [];

/**
 * [what the newest user message contains, what the model does]: the first match wins. The message is
 * matched as JSON, so a newline reads `\n` and a quote `\"`.
 */
const SCRIPT: Array<[RegExp, () => Response]> = [
  [/Refused: `schedule` acts for the owner/, () => say("I can't set that up: only the owner can.")],
  [/Scheduled #\d+/, () => say("Reminder set.")],
  [/Asked the widgetry desk/, () => say("I asked the widgetry desk.")],
  [/⚙ inbound: grafana\]\\n  disk 91% on vm-3/, () => stream([{ type: "text", text: "Grafana: the disk on vm-3 is at 91%." }, { type: "tool_use", name: "mcp__shuvi__schedule", input: { at: "+1h", note: "reboot vm-3" } }])],
  [/remind me to stretch/, () => stream([{ type: "tool_use", name: "mcp__shuvi__schedule", input: { at: "+3s", note: "stretch reminder" } }])],
  [/· ⚙ schedule \d+\] stretch reminder/, () => say("Time to stretch!")],
  [/· ⚙ job \d+ · convert · done\] asked: \\"convert report\\"\\n  hello from the converter/, () => say("Converted: hello from the converter")],
  [/· ⚙ job \d+ · convert · expired\]/, () => say("The slow conversion never came back.")],
  [/ask the desk about the PR/, () => stream([{ type: "tool_use", name: "mcp__shuvi__ask_workstream", input: { product: "widgetry", message: "is the login PR merged?" } }])],
  [/· ⚙ job \d+ · workstream · done\] asked: \\"widgetry: is the login PR merged\?\\"\\n  Yes, merged as #212\./, () => say("The desk says: merged as #212.")],
];

const anthropic = Bun.serve({
  port: 0,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as { messages?: Array<{ role: string; content: unknown }>; tools?: Array<{ name: string }> }) : {};
    if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 10 });
    if (!url.pathname.endsWith("/v1/messages")) return Response.json({});
    if (!body.tools?.some((t) => t.name === "mcp__shuvi__say")) return say("ok"); // the CLI's side requests
    toolsOffered = body.tools.map((t) => t.name);
    const last = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
    const text = JSON.stringify(last?.content ?? "");
    seen.push(text);
    for (const [re, act] of SCRIPT) if (re.test(text)) return act();
    return say(`(no script for: ${text.slice(0, 120)})`);
  },
});

// ---- the world ---------------------------------------------------------------------------------------
const tg = new FakeTelegram();
const desk = new FakeDesk();
const dataDir = mkdtempSync(join(tmpdir(), "shuvi-e2e-jobs-"));
mkdirSync(join(dataDir, "home"), { recursive: true });
writeFileSync(join(dataDir, "home", "inbound.yaml"), "sources:\n  grafana:\n    chat: dm\n");
const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const hookPort = probe.port;
probe.stop(true);
const hooks = `http://127.0.0.1:${hookPort}`;
const env = {
  ...process.env,
  SHUVI_DATA_DIR: dataDir,
  SHUVI_BOT_TOKEN: "TOKEN",
  SHUVI_OWNER_ID: String(OWNER),
  SHUVI_TELEGRAM_API_ROOT: tg.apiRoot,
  SHUVI_BACKEND: "claude",
  SHUVI_MODEL: "claude-sonnet-4-5",
  SHUVI_TZ: "Asia/Taipei",
  SHUVI_WEB: "off",
  SHUVI_HOOK_LISTEN: `127.0.0.1:${hookPort}`,
  SHUVI_INBOUND_GRAFANA_TOKEN: "grafana-secret",
  SHUVI_WORKSTREAM_MCP_URL: desk.url,
  SHUVI_WORKSTREAM_MCP_TOKEN: desk.token,
  SHUVI_WORKSTREAM_POLL_SEC: "1",
  ANTHROPIC_BASE_URL: `http://localhost:${anthropic.port}`,
  ANTHROPIC_API_KEY: "sk-ant-fake",
};
let serverOut = "";
const server = Bun.spawn([process.execPath, "src/server/main.ts"], { env, stdout: "pipe", stderr: "pipe", detached: true });
for (const [from, to] of [
  [server.stdout, process.stdout],
  [server.stderr, process.stderr],
] as const) {
  void (async () => {
    const dec = new TextDecoder();
    for await (const chunk of from) {
      const s = dec.decode(chunk);
      serverOut += s;
      to.write(s);
    }
  })();
}
function cleanup() {
  try {
    process.kill(-server.pid, "SIGKILL");
  } catch {}
  tg.stop();
  desk.stop();
  anthropic.stop(true);
}
const texts = () => tg.sent().map((b) => String(b.text));
const count = (t: string) => texts().filter((x) => x === t).length;
async function replied(text: string, what: string) {
  await until(what, () => count(text) >= 1);
  await Bun.sleep(800); // room for a duplicate to show up
  check(count(text) === 1, `${what}: "${text}" reached Telegram exactly once`);
}
const db = openDb(join(dataDir, "shuvi.db"));
const events = (kind: string) => (db.$client.query("select count(*) as n from chat_events where kind = ?").get(kind) as { n: number }).n;
const postHook = (path: string, body: string, headers: Record<string, string>) => fetch(`${hooks}${path}`, { method: "POST", body, headers });
const turnsIdle = () => (db.$client.query("select count(*) as n from turns where status = 'running'").get() as { n: number }).n === 0;

await until("the hooks to listen", () => serverOut.includes("hooks: listening"), 20_000);

// ---- 1. an inbound POST ------------------------------------------------------------------------------
check((await postHook("/inbound/grafana", "x", { authorization: "Bearer wrong" })).status === 401, "inbound: a wrong token is 401");
check((await postHook("/inbound/nagios", "x", { authorization: "Bearer grafana-secret" })).status === 404, "inbound: an unknown source is 404");
check(events("external") === 0, "inbound: and neither wrote anything");
const ib = await postHook("/inbound/grafana", JSON.stringify({ text: "disk 91% on vm-3" }), { authorization: "Bearer grafana-secret", "content-type": "application/json" });
check(ib.status === 200, "inbound: the right token is accepted");
await replied("Grafana: the disk on vm-3 is at 91%.", "an inbound POST starts a turn in the configured chat");
await replied("I can't set that up: only the owner can.", "inbound: the turn it started was refused the owner-only schedule tool");
check(toolsOffered.includes("mcp__shuvi__schedule"), "inbound: the owner-only tools were offered all the same (a stable tool list)");
check((db.$client.query("select count(*) as n from schedules").get() as { n: number }).n === 0, "inbound: and no schedule was set");
await until("the turn to close", turnsIdle);

// ---- 2. a schedule firing a turn ---------------------------------------------------------------------
tg.updates.push(dmUpdate(1, "remind me to stretch in a moment"));
await replied("Reminder set.", "the schedule tool ran in an owner turn");
check(toolsOffered.includes("mcp__shuvi__schedule") && toolsOffered.includes("mcp__shuvi__ask_workstream"), "an owner turn is offered schedule and ask_workstream");
await replied("Time to stretch!", "the schedule fired a turn in the chat it was set in");
check(events("scheduled") === 1, "the schedule fired once");
check(seen.some((s) => /· ⚙ schedule \d+\] stretch reminder/.test(s)), "the model saw it as a schedule event, not as someone speaking");
await until("the turn to close", turnsIdle);

// ---- 3. a job reported by callback -------------------------------------------------------------------
const chatId = (db.$client.query("select id from chats where tg_chat_id = ?").get(OWNER) as { id: number }).id;
const lastSeq = () => (db.$client.query("select max(seq) as s from chat_events").get() as { s: number }).s;
const cb = createJob(db, { chatId, originSeq: lastSeq(), kind: "convert", title: "convert report", report: "callback", deadline: new Date(Date.now() + 60_000) });
check((await postHook(`/jobs/${cb.job.id}/report`, "x", { authorization: "Bearer wrong" })).status === 401, "callback: a wrong token is 401");
check((await postHook(`/jobs/99999/report`, "x", { authorization: `Bearer ${cb.token}` })).status === 404, "callback: an unknown job is 404");
check(events("job_done") === 0, "callback: and neither wrote anything");
const rep = { authorization: `Bearer ${cb.token}`, "content-type": "application/json" };
check((await postHook(`/jobs/${cb.job.id}/report`, JSON.stringify({ status: "done", result: "hello from the converter" }), rep)).status === 200, "callback: the report is accepted");
check((await postHook(`/jobs/${cb.job.id}/report`, JSON.stringify({ status: "done", result: "again" }), rep)).status === 200, "callback: a repeat report is accepted");
await replied("Converted: hello from the converter", "a job reported by callback starts a turn in its origin chat");
check(events("job_done") === 1, "callback: one job_done, the repeat wrote nothing");
await until("the turn to close", turnsIdle);

// ---- 4. an expired job -------------------------------------------------------------------------------
const slow = createJob(db, { chatId, originSeq: lastSeq(), kind: "convert", title: "slow convert", report: "callback", deadline: new Date(Date.now() + 1_500) });
await replied("The slow conversion never came back.", "an expired job is written back to its origin chat and starts a turn");
check((db.$client.query("select state from jobs where id = ?").get(slow.job.id) as { state: string }).state === "expired", "the job is expired");
check(
  (db.$client.query("select text from control_messages where kind = 'alert'").all() as { text: string }[]).some((a) => a.text.startsWith(`Job ${slow.job.id} (convert) expired`)),
  "the owner was alerted (an alert queued for the control bot)",
);
await until("the turn to close", turnsIdle);

// ---- 5. the workstream desk, polled ------------------------------------------------------------------
tg.updates.push(dmUpdate(2, "ask the desk about the PR"));
await replied("I asked the widgetry desk.", "ask_workstream asked the desk and the turn ended");
const reqId = [...desk.requests.keys()][0]!;
check(desk.calls.some((c) => c.tool === "tell_desk" && c.args.wait === 0), "tell_desk was called with wait: 0");
await until("the watcher to poll the desk", () => desk.calls.some((c) => c.tool === "request_status"), 15_000);
desk.requests.get(reqId)!.status = "answered";
desk.requests.get(reqId)!.text = "Yes, merged as #212.";
await replied("The desk says: merged as #212.", "the desk's answer came back to the asking chat as a job_done");

log("PASS");
cleanup();
process.exit(0);
