#!/usr/bin/env bun
/**
 * Each chat's computer, end to end (M7), with nothing real but the code under test and the Claude Code CLI:
 *
 *   fake Telegram (+ a fake control bot) ⇄ shuvi server ⇄ runner child ⇄ real Claude Code CLI ⇄ fake
 *   Anthropic;  the computer capability ⇄ a fake Hangar (Connect endpoints and an exec WebSocket that runs
 *   commands on this machine)
 *
 *   1. a turn runs a synchronous exec: the disk and the container are created, the output comes back
 *   2. a background exec: the turn ends at once, and the job's end comes back as a job_done turn
 *   3. a secret-gated exec: without a grant the variable is empty; request_secret puts a card in the
 *      control bot; the owner's press wakes the chat, whose exec gets the value in its environment and sees
 *      it only as [REDACTED:modal]; the value never reaches the store or anything the model was sent
 *   4. ~/.computer.yaml: an exec writes it, apply_computer_config applies it as root (apt through the cache
 *      in home, then setup) and records its hash on the root disk
 *   5. the idle computer is stopped (an apply of STOPPED, never a delete)
 *   6. the next command starts it again, and the file, its hash matching, is not applied again
 *
 *   bun scripts/e2e-computer.ts
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Update } from "grammy/types";
import { openDb } from "../src/store/db.ts";
import { FakeHangar } from "../test/fake-hangar.ts";
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

const SECRET = "fake-e2e-secret-value-0123456789";

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
const use = (name: string, input: unknown) => stream([{ type: "tool_use", name: `mcp__shuvi__${name}`, input }]);
const seen: string[] = [];
/** Every request body the model was sent, whole: the transcript as the model sees it. */
const bodies: string[] = [];
let toolsOffered: string[] = [];

/** [what the newest user message contains, what the model does]: the first match wins (matched as JSON). */
const SCRIPT: Array<[RegExp, (text: string) => Response]> = [
  [/run something on your computer/, () => use("exec", { command: "echo computer-says-$((6*7)); whoami >/dev/null" })],
  [/exit 0 · [^"]*computer-says-42/, () => say("The computer says 42.")],
  [/start the long job/, () => use("exec", { command: "sleep 2; echo bg-finished", background: true, expect_seconds: 10 })],
  [/Started job \d+ in the background/, () => say("Started it in the background.")],
  [/· ⚙ job \d+ · computer · done\] asked: [^\n]*\\n  exit 0 · ran [^"]*bg-finished/, () => say("The job finished: bg-finished.")],
  [/deploy with modal/, () => use("exec", { command: 'echo "token=[$MODAL_TOKEN]"' })],
  [/token=\[\[REDACTED:modal\]\]/, () => say("Deployed; the token stayed hidden.")],
  [/token=\[\]/, () => use("request_secret", { profile: "modal", ttl: "1d", reason: "to deploy the app" })],
  [/Asked the owner for \\"modal\\"/, () => say("I asked the owner for the modal secret.")],
  [/· ⚙ approval\] Approval #\d+ \(secret\)[^\n]*Grant for 1 day/, () => use("exec", { command: 'echo "token=[$MODAL_TOKEN]"' })],
  [/declare a package/, () => use("exec", { command: "printf 'apt: [example-tool]\\nsetup: echo configured > configured.txt\\n' > ~/.computer.yaml && echo declared-ok" })],
  [/exit 0 · [^"]*declared-ok/, () => use("apply_computer_config", {})],
  [/Applied ~\/\.computer\.yaml in \d+s: apt: example-tool; the setup script/, () => say("The computer config is applied.")],
  [/run something after the restart/, () => use("exec", { command: "echo after-restart" })],
  [/exit 0 · [^"]*after-restart/, (t) => say(t.includes(".computer.yaml") ? "It applied the config again." : "Back after the restart.")],
];

const anthropic = Bun.serve({
  port: 0,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const raw = req.method === "POST" ? await req.text() : "";
    const body = (raw ? JSON.parse(raw) : {}) as { messages?: Array<{ role: string; content: unknown }>; tools?: Array<{ name: string }> };
    if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 10 });
    if (!url.pathname.endsWith("/v1/messages")) return Response.json({});
    bodies.push(raw);
    if (!body.tools?.some((t) => t.name === "mcp__shuvi__say")) return say("ok"); // the CLI's side requests
    toolsOffered = body.tools.map((t) => t.name);
    const last = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
    const text = JSON.stringify(last?.content ?? "");
    seen.push(text);
    for (const [re, act] of SCRIPT) if (re.test(text)) return act(text);
    return say(`(no script for: ${text.slice(0, 160)})`);
  },
});

// ---- the world ---------------------------------------------------------------------------------------
const tg = new FakeTelegram();
const control = new FakeTelegram();
const hangar = new FakeHangar();
const dataDir = mkdtempSync(join(tmpdir(), "shuvi-e2e-computer-"));
mkdirSync(join(dataDir, "home"), { recursive: true });
const secretsFile = join(mkdtempSync(join(tmpdir(), "shuvi-e2e-secrets-")), "shuvi.secrets.yaml");
writeFileSync(secretsFile, `modal:\n  MODAL_TOKEN: ${SECRET}\n`);
chmodSync(secretsFile, 0o600);
const env = {
  ...process.env,
  SHUVI_DATA_DIR: dataDir,
  SHUVI_BOT_TOKEN: "TOKEN",
  SHUVI_OWNER_ID: String(OWNER),
  SHUVI_TELEGRAM_API_ROOT: tg.apiRoot,
  SHUVI_CONTROL_BOT_TOKEN: "CONTROL",
  SHUVI_CONTROL_API_ROOT: control.apiRoot,
  SHUVI_MODEL: "claude-sonnet-4-5",
  SHUVI_TZ: "Asia/Taipei",
  SHUVI_WEB: "off",
  ...hangar.env(),
  SHUVI_SECRETS_FILE: secretsFile,
  SHUVI_COMPUTER_POLL_SEC: "1",
  SHUVI_COMPUTER_IDLE_MINUTES: "0.1",
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
  control.stop();
  hangar.stop();
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
const turnsIdle = () => (db.$client.query("select count(*) as n from turns where status = 'running'").get() as { n: number }).n === 0;
await until("the server to start", () => serverOut.includes("shuvi server:"), 20_000);

// ---- 1. a synchronous exec ---------------------------------------------------------------------------
tg.updates.push(dmUpdate(1, "run something on your computer"));
await replied("The computer says 42.", "a turn ran a synchronous exec and answered from its output");
check(toolsOffered.includes("mcp__shuvi__exec") && toolsOffered.includes("mcp__shuvi__read_job") && toolsOffered.includes("mcp__shuvi__request_secret"), "the computer's tools are offered");
check(hangar.disks.has("home-1001") && hangar.containers.has("shuvi-1001"), "the chat's disk and container were created on the first exec");
check(hangar.applies()[0] === "shuvi-1001 RUNNING 2/2Gi", `the container was started (${hangar.applies().join(", ")})`);
await until("the turn to close", turnsIdle);

// ---- 2. a background exec ----------------------------------------------------------------------------
tg.updates.push(dmUpdate(2, "start the long job"));
await replied("Started it in the background.", "a background exec returned a job id and the turn ended");
await replied("The job finished: bg-finished.", "the job's end came back to the chat as a job_done and started a turn");
const job = db.$client.query("select state, report, result from jobs where kind = 'computer'").get() as { state: string; report: string; result: string };
check(job.state === "done" && job.report === "poll" && job.result.startsWith("exit 0 · ran"), `the job is done, with its usage line (${JSON.stringify(job.result.split("\n")[0])})`);
await until("the turn to close", turnsIdle);

// ---- 3. a secret-gated exec --------------------------------------------------------------------------
tg.updates.push(dmUpdate(3, "deploy with modal"));
await replied("I asked the owner for the modal secret.", "without a grant the variable was empty, and the assistant asked for the secret");
const controlTexts = () => control.sent().map((b) => String(b.text));
await until("the secret card", () => controlTexts().some((t) => t.includes('Secret "modal"')));
const card = control.calls.find((c) => c.method === "sendMessage" && String(c.body.text).includes('Secret "modal"'))!.body;
check(String(card.text).includes("Variables: MODAL_TOKEN") && !String(card.text).includes(SECRET), "the card names the variables, never the values");
const keyboard = (card.reply_markup as { inline_keyboard: { callback_data: string; text: string }[][] }).inline_keyboard;
check(keyboard.map((r) => r[0]!.text).join("|") === "Grant for 4 hours|Grant for 1 day|Grant for 3 days|Deny", "the card offers 4h / 1d / 3d and deny");
control.updates.push({ update_id: 1, callback_query: { id: "cq1", from: { id: OWNER, is_bot: false, first_name: "Owner" }, chat_instance: "x", data: keyboard[1]![0]!.callback_data } } as unknown as Update);
await replied("Deployed; the token stayed hidden.", "the owner's grant woke the chat, and its exec saw the value only as [REDACTED:modal]");
check(hangar.execs.some((e) => e.env.MODAL_TOKEN === SECRET), "the value went into that exec's environment");
await until("the revoke card", () => controlTexts().some((t) => t.includes("is granted to the computer")));
check(true, "a revoke card was put in the control bot");
const dump = ["chat_events", "jobs", "approvals", "secret_grants", "control_messages", "computers", "turns"].map((t) => JSON.stringify(db.$client.query(`select * from ${t}`).all())).join("\n");
check(!dump.includes(SECRET), "the value is nowhere in the store");
check(bodies.length > 0 && !bodies.some((b) => b.includes(SECRET)), "the value is in nothing the model was sent");
check(!JSON.stringify([...hangar.containers.values()]).includes(SECRET), "nor in the container's spec");
await until("the turn to close", turnsIdle);

// ---- 4. ~/.computer.yaml -----------------------------------------------------------------------------
const rootRuns = () => hangar.execs.filter((e) => e.user === "0" && e.command.join(" ").includes("flock")).length;
tg.updates.push(dmUpdate(4, "declare a package"));
await replied("The computer config is applied.", "an exec wrote ~/.computer.yaml and apply_computer_config applied it at once");
check(toolsOffered.includes("mcp__shuvi__apply_computer_config") && !toolsOffered.includes("mcp__shuvi__transcribe"), "apply_computer_config is offered, transcribe is not");
check(rootRuns() === 1, `it was applied once, as root (${rootRuns()})`);
check(existsSync(join(hangar.rootfs("shuvi-1001"), "installed", "example-tool")), "its apt package was installed on the root disk");
check(existsSync(join(hangar.home("shuvi-1001"), ".cache/computer/apt/example-tool.deb")), "through the apt cache in home");
check(readFileSync(join(hangar.home("shuvi-1001"), "configured.txt"), "utf8") === "configured\n", "its setup script ran");
check(existsSync(join(hangar.rootfs("shuvi-1001"), "var/lib/shuvi/computer.applied")), "its hash was recorded on the root disk");
await until("the turn to close", turnsIdle);

// ---- 5. idle stop ------------------------------------------------------------------------------------
await until("the idle computer to be stopped", () => hangar.applies().at(-1) === "shuvi-1001 STOPPED 2/2Gi", 30_000);
check(!hangar.calls.some((c) => c.method.startsWith("Delete")), "the idle computer was stopped, never deleted");

// ---- 6. the next start: the file's hash matches, nothing is applied -----------------------------------
tg.updates.push(dmUpdate(5, "run something after the restart"));
await replied("Back after the restart.", "the next command started the computer again");
check(hangar.applies().at(-1) === "shuvi-1001 RUNNING 2/2Gi", "it was started again");
check(rootRuns() === 1, "~/.computer.yaml, unchanged on the same root disk, was not applied again");
await until("the turn to close", turnsIdle);

log("PASS");
cleanup();
process.exit(0);
