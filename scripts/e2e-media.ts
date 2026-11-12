#!/usr/bin/env bun
/**
 * Videos from links, end to end, with nothing real but the code under test and the Claude Code CLI:
 *
 *   fake Telegram ⇄ shuvi server ⇄ runner child ⇄ real Claude Code CLI ⇄ fake Anthropic;  the media
 *   capability ⇄ a fake porchkit (test/fake-porchkit.ts);  the computer ⇄ a fake Hangar
 *
 *   1. the owner sends a YouTube link: the server probes it at once (speculative), while the turn starts;
 *      the turn's input says it is prepared; the turn calls video_probe (which joins the prewarm: porchkit
 *      sees ONE probe) and video_sheet with the url (the sheets come back as images, never as URLs); the
 *      prewarm is recorded as used, and the porchkit token is nowhere in the store
 *   2. the owner asks for the file: video_fetch starts porchkit's download and a job; the job copies the file
 *      into ~/inbox on the computer, and its job_done turn answers with the path
 *
 *   bun scripts/e2e-media.ts
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/store/db.ts";
import { FakeHangar } from "../test/fake-hangar.ts";
import { FakePorchkit } from "../test/fake-porchkit.ts";
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

const LINK = "https://youtu.be/abc123def45";

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
const bodies: string[] = [];
let toolsOffered: string[] = [];
let probesWhenFirstTool = -1;

/** [what the newest user message contains, what the model does]: the first match wins (matched as JSON). */
const SCRIPT: Array<[RegExp, (text: string) => Response]> = [
  [/Title: Example talk/, () => use("video_sheet", { url: LINK, count: 8 })],
  [/2 sheet\(s\), in order:/, (t) => say(`It is a talk with two chapters; I looked at ${t.split('"type":"image"').length - 1} sheet(s).`)],
  [/what is in this video/, () => ((probesWhenFirstTool = porch.of("/media/probe").length), use("video_probe", { url: LINK }))],
  [/Started job \d+ in the background: the media service fetches the video/, () => say("Downloading it now.")],
  [/video_fetch · done\].*Saved on your computer as ~\/inbox\/video-[0-9a-f]{12}\.mp4/, () => say("It is in your inbox now.")],
  [/download that video for me/, () => use("video_fetch", { url: LINK })],
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
const porch = new FakePorchkit();
porch.probeDelayMs = 300; // long enough that the turn's video_probe may find it still in flight
const hangar = new FakeHangar();
const dataDir = mkdtempSync(join(tmpdir(), "shuvi-e2e-media-"));
mkdirSync(join(dataDir, "home"), { recursive: true });
const env = {
  ...process.env,
  SHUVI_DATA_DIR: dataDir,
  SHUVI_BOT_TOKEN: "TOKEN",
  SHUVI_OWNER_ID: String(OWNER),
  SHUVI_TELEGRAM_API_ROOT: tg.apiRoot,
  SHUVI_MODEL: "claude-sonnet-4-5",
  SHUVI_TZ: "Asia/Taipei",
  SHUVI_WEB: "off",
  ...hangar.env(),
  ...porch.env(),
  SHUVI_SECRETS_FILE: join(dataDir, "no-secrets.yaml"),
  SHUVI_COMPUTER_POLL_SEC: "1",
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
  porch.stop();
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

// ---- 1. a link from the owner: prewarm, probe, sheet --------------------------------------------------
tg.updates.push(dmUpdate(1, `what is in this video? ${LINK}`));
await replied("It is a talk with two chapters; I looked at 2 sheet(s).", "the turn probed the link and looked at its sheets");
const probes = porch.of("/media/probe");
check(probes.length === 1, `porchkit saw one probe (${probes.length})`);
check(probes[0]!.body.speculative === true && probes[0]!.body.url === LINK, "it was the server's prewarm, speculative");
check(probesWhenFirstTool === 1, "the prewarm had gone out before the turn's first tool call");
const first = seen.find((s) => s.includes("what is in this video"))!;
const line = first.match(/\((?:Prepared|Preparing): #\d+'s link — video_probe (?:returns at once|joins it)\.\)/)?.[0];
check(line, `the turn's input says the link is prepared: ${line}`);
check(toolsOffered.includes("mcp__shuvi__video_probe") && toolsOffered.includes("mcp__shuvi__video_sheet") && toolsOffered.includes("mcp__shuvi__video_fetch"), "the media tools are offered");
const sheetCall = porch.calls.find((c) => c.path === "/media/sheet");
check(sheetCall?.body.url === LINK && sheetCall.body.count === 8, "video_sheet asked porchkit for sheets of the link");
check(porch.of("/media/sheets/").length === 2 && porch.of("/media/sheets/").every((c) => c.authed), "both sheets were fetched with the token");
check(!bodies.some((b) => b.includes("/media/sheets/")), "no sheet URL reached the model");
const pre = db.$client.query("select outcome, used_turn_id as used from media_prewarms").all() as { outcome: string; used: number | null }[];
check(pre.length === 1 && pre[0]!.outcome === "ok" && pre[0]!.used !== null, `the prewarm is recorded as used (${JSON.stringify(pre)})`);
const dump = (db.$client.query("select group_concat(coalesce(payload, ''), '') as t from chat_events").get() as { t: string }).t + JSON.stringify(db.$client.query("select * from turn_steps").all());
check(!dump.includes(porch.token) && !bodies.some((b) => b.includes(porch.token)), "the porchkit token is nowhere in the store or what the model was sent");
await until("the turn to close", turnsIdle);

// ---- 2. the file onto the computer ---------------------------------------------------------------------
tg.updates.push(dmUpdate(2, "download that video for me"));
await replied("Downloading it now.", "video_fetch started a job and the turn ended");
await replied("It is in your inbox now.", "the job copied the file and its job_done came back to the chat");
const job = db.$client.query("select state, result from jobs where kind = 'video_fetch'").get() as { state: string; result: string };
const path = job.result.match(/~\/(inbox\/video-[0-9a-f]{12}\.mp4)/)?.[1];
check(job.state === "done" && path, `the job is done: ${job.result}`);
const copied = new Uint8Array(readFileSync(join(hangar.home("shuvi-1001"), path!)));
check(copied.length === porch.fileBytes.length && Buffer.from(copied).equals(Buffer.from(porch.fileBytes)), "the whole file is on the computer, byte for byte");
check(porch.of("/files/").every((c) => c.authed && c.range), "it came in ranges, with the token");
await until("the turn to close", turnsIdle);

// ---- 3. the token: nowhere on disk under the data dir (store, transcripts, media), nor in the server's log --
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const all = files(dataDir);
const leaked = all.filter((f) => readFileSync(f).includes(Buffer.from(porch.token)));
check(all.length > 3 && !leaked.length, `the token is in none of the ${all.length} files under the data dir${leaked.length ? ` (found in ${leaked.join(", ")})` : ""}`);
check(!serverOut.includes(porch.token), "the token is not in the server's output");

log("all good");
cleanup();
process.exit(0);
