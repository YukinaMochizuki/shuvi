#!/usr/bin/env bun
/**
 * Reading links, end to end, with nothing real but the code under test and the Claude Code CLI:
 *
 *   fake Telegram ⇄ shuvi server ⇄ runner child ⇄ real Claude Code CLI ⇄ fake Anthropic;  the media
 *   capability ⇄ a fake porchkit (test/fake-porchkit.ts, its `/read`);  the computer ⇄ a fake Hangar
 *
 *   1. the owner sends an X post's link: the server reads it at once (`/read`, speculative) while the turn
 *      starts; the turn's input says it is prepared; the turn calls read_link, which joins the prewarm and
 *      reads it again normally; what the model receives is text and FOUR images (2 pictures, the video's
 *      poster and its contact sheet), never a file key, a porchkit path or the token; web_fetch is not
 *      offered (porchkit is configured), read_link and save_link are
 *   2. the owner asks about a long article: the server prewarms it too (every link is read, not only posts);
 *      read_link gives the first part and how to read on; the model
 *      reads on with offset, then saves the whole text and the page as received with save_link: both land
 *      in ~/inbox on the computer, byte for byte
 *   3. the owner asks her to open a shop: her own browser (porchkit's `/browse`, the fake's made-up shop):
 *      browser_open, then browser_click on a ref from the page text it answered with, both in the session
 *      `chat-<id>`; the browser's prompt section and tools are offered; then the owner asks for a screenshot:
 *      browser_send queues it and the sender sends it to the DM as a photo, exactly once
 *
 *   bun scripts/e2e-read.ts
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/store/db.ts";
import { FakeHangar } from "../test/fake-hangar.ts";
import { FakePorchkit, LONG_HTML, LONG_MARKDOWN, LONG_PAGE, SHOP, SHOP_ITEM, X_POST } from "../test/fake-porchkit.ts";
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
const use = (name: string, input: unknown) => stream([{ type: "tool_use", name: `mcp__shuvi__${name}`, input }]);
const seen: string[] = [];
const bodies: string[] = [];
let toolsOffered: string[] = [];
let postResult = "";
let readsWhenFirstTool = -1;

/** [what the newest user message contains, what the model does]: the first match wins (matched as JSON). */
const SCRIPT: Array<[RegExp, (text: string) => Response]> = [
  [/Sent a screenshot of A teapot - Example Shop/, () => say("There it is.")],
  [/send me a screenshot of it/, () => use("browser_send", { what: "screenshot", caption: "the teapot" })],
  [/Title: A teapot - Example Shop/, () => say("The teapot page is open.")],
  [/Title: Example Shop/, () => use("browser_click", { ref: "e1" })],
  [/open the example shop/, () => use("browser_open", { url: SHOP })],
  [/Saved on your computer: ~\/inbox\//, () => say("Saved it on your computer.")],
  [/\(from character 20,000 of/, () => use("save_link", { url: LONG_PAGE, what: "both" })],
  [/To read on, call read_link again with offset: 20000/, () => use("read_link", { url: LONG_PAGE, offset: 20000 })],
  [/Post on X by Example Person/, (t) => ((postResult = t), say(`A post by Example Person; I looked at ${t.split('"type":"image"').length - 1} image(s).`))],
  [/what does this post say/, () => ((readsWhenFirstTool = porch.of("/read").length), use("read_link", { url: X_POST }))],
  [/read me this article/, () => use("read_link", { url: LONG_PAGE })],
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
porch.readDelayMs = 300; // long enough that the turn's read_link may find the prewarm still in flight
const hangar = new FakeHangar();
const dataDir = mkdtempSync(join(tmpdir(), "shuvi-e2e-read-"));
mkdirSync(join(dataDir, "home"), { recursive: true });
const env: Record<string, string | undefined> = {
  ...process.env,
  SHUVI_DATA_DIR: dataDir,
  SHUVI_BOT_TOKEN: "TOKEN",
  SHUVI_OWNER_ID: String(OWNER),
  SHUVI_TELEGRAM_API_ROOT: tg.apiRoot,
  SHUVI_MODEL: "claude-sonnet-4-5",
  SHUVI_TZ: "Asia/Taipei",
  ...hangar.env(),
  ...porch.env(),
  SHUVI_SECRETS_FILE: join(dataDir, "no-secrets.yaml"),
  SHUVI_COMPUTER_POLL_SEC: "1",
  ANTHROPIC_BASE_URL: `http://localhost:${anthropic.port}`,
  ANTHROPIC_API_KEY: "sk-ant-fake",
};
delete env.SHUVI_WEB; // the web capability on: web_fetch must still not be offered
delete env.SHUVI_TAVILY_API_KEY;
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

// ---- 1. a post's link from the owner: prewarm, read_link, its images -----------------------------------
tg.updates.push(dmUpdate(1, `what does this post say? ${X_POST}`));
await replied("A post by Example Person; I looked at 4 image(s).", "the turn read the post and saw its images");
const reads = porch.of("/read");
check(reads.length === 2, `porchkit saw two reads (${reads.length})`);
check(reads[0]!.body.speculative === true && reads[0]!.body.url === X_POST, "the first was the server's prewarm, speculative");
check(reads[1]!.body.speculative === undefined && reads[1]!.body.url === X_POST, "the second was read_link's own, normal (it adds the transcript and the sheet)");
check(readsWhenFirstTool === 1, "the prewarm had gone out before the turn's first tool call");
const first = seen.find((s) => s.includes("what does this post say"))!;
const line = first.match(/\((?:Prepared|Preparing): #\d+'s link — read_link (?:returns at once|joins it)\.\)/)?.[0];
check(line, `the turn's input says the link is prepared: ${line}`);
check(toolsOffered.includes("mcp__shuvi__read_link") && toolsOffered.includes("mcp__shuvi__save_link"), "read_link and save_link are offered");
check(!toolsOffered.some((t) => t.endsWith("web_fetch")), `web_fetch is not offered (${toolsOffered.filter((t) => t.includes("web")).join(", ") || "no web tools"})`);
check(postResult.includes("Example Person (@example)") && postResult.includes("The full text of the post") && postResult.includes("Transcript (subtitles, en)") && postResult.includes("with url: https://x.com/example/status/1234567890/video/1"), "the model got the post's text, its video's transcript and where to go on");
check(postResult.split('"type":"image"').length - 1 === 4, "the model got 4 images in the tool result");
check(porch.of("/files/").length === 3 && porch.of("/media/sheets/").length === 1 && [...porch.of("/files/"), ...porch.of("/media/sheets/")].every((c) => c.authed), "3 files and 1 sheet were fetched, with the token");
check(!bodies.some((b) => /\/files\/[0-9a-f]{32}|\/media\/sheets\//.test(b)), "no file or sheet path reached the model");
check(!bodies.some((b) => b.includes('\\"kind\\":\\"post\\"') || b.includes('"kind":"post"')), "porchkit's JSON did not reach the model");
const pre = db.$client.query("select endpoint, outcome, result, used_turn_id as used from media_prewarms").all() as { endpoint: string; outcome: string; result: string; used: number | null }[];
check(pre.length === 1 && pre[0]!.endpoint === "read" && pre[0]!.outcome === "ok" && pre[0]!.used !== null, `the prewarm is recorded as a read, used (${JSON.stringify(pre)})`);
check(!/https?:|x\.com|1234567890/.test(pre[0]!.result), `what the prewarm keeps holds no URL: ${pre[0]!.result}`);
await until("the turn to close", turnsIdle);

// ---- 2. a long article: read on, then save it -----------------------------------------------------------
tg.updates.push(dmUpdate(2, `read me this article ${LONG_PAGE}`));
await replied("Saved it on your computer.", "the turn read the article, read on, and saved it");
const pageReads = porch.of("/read").slice(2).map((c) => c.body);
check(JSON.stringify(pageReads) === JSON.stringify([{ url: LONG_PAGE, speculative: true }, { url: LONG_PAGE }, { url: LONG_PAGE, offset: 20000 }, { url: LONG_PAGE }]), `the prewarm (a page is read too), then read, read on, and save_link's read (${JSON.stringify(pageReads)})`);
const inbox = join(hangar.home("shuvi-1001"), "inbox");
const saved = readdirSync(inbox);
const md = saved.find((f) => f.endsWith(".md"));
const html = saved.find((f) => f.endsWith(".html"));
check(md && html && saved.length === 2, `two files in ~/inbox: ${saved.join(", ")}`);
check(readFileSync(join(inbox, md!), "utf8") === LONG_MARKDOWN, "the whole text, byte for byte");
check(readFileSync(join(inbox, html!), "utf8") === LONG_HTML, "the page as received, byte for byte");
await until("the turn to close", turnsIdle);

// ---- 3. her own browser: open a page, click a ref from its text ----------------------------------------

tg.updates.push(dmUpdate(3, "open the example shop and look at the teapot"));
await replied("The teapot page is open.", "the turn opened the shop and clicked through");
const acts = porch.of("/browse/sessions/").map((c) => ({ path: c.path, ...c.body }));
const dmChat = (db.$client.query("select id from chats where tg_chat_id = ?").get(OWNER) as { id: number }).id;
const actPath = `/browse/sessions/chat-${dmChat}/act`;
check(
  JSON.stringify(acts) === JSON.stringify([{ path: actPath, action: "open", url: SHOP }, { path: actPath, action: "click", ref: "e1" }]),
  `porchkit got browser_open, then browser_click on e1, in the chat's session (${JSON.stringify(acts)})`,
);
check(porch.browse.sessions.get(`chat-${dmChat}`)?.at(-1) === SHOP_ITEM, "the window is on the item's page");
check(toolsOffered.includes("mcp__shuvi__browser_open") && toolsOffered.includes("mcp__shuvi__browser_request_purchase"), "the browser's tools are offered");
check(bodies.some((b) => b.includes("## Your browser")), "the browser's section is in the system prompt");
await until("the turn to close", turnsIdle);

tg.updates.push(dmUpdate(4, "send me a screenshot of it"));
await replied("There it is.", "the turn sent a screenshot");
const photos = tg.sent("sendPhoto");
check(photos.length === 1 && Number(photos[0]!.chat_id) === OWNER && photos[0]!.caption === "the teapot", `the screenshot reached the DM as a photo, once (${JSON.stringify(photos.map((p) => ({ chat: p.chat_id, caption: p.caption })))})`);
await until("the turn to close", turnsIdle);

// ---- 4. the token: nowhere on disk under the data dir, nor in the server's log ---------------------------
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const all = files(dataDir);
const leaked = all.filter((f) => readFileSync(f).includes(Buffer.from(porch.token)));
check(all.length > 3 && !leaked.length, `the token is in none of the ${all.length} files under the data dir${leaked.length ? ` (found in ${leaked.join(", ")})` : ""}`);
check(!serverOut.includes(porch.token) && !bodies.some((b) => b.includes(porch.token)), "the token is not in the server's output nor in what the model was sent");

log("all good");
cleanup();
process.exit(0);
