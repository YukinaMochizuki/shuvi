#!/usr/bin/env bun
/**
 * The whole path, end to end, with nothing real but the code under test and the Claude Code CLI:
 *
 *   fake Telegram Bot API ⇄ shuvi server ⇄ runner child ⇄ real Claude Code CLI ⇄ fake Anthropic API
 *
 * It checks the property the design rests on (docs/design.md invariants 2 and 3): the server is killed
 * while a turn is mid-flight, the turn finishes anyway in its own process, and when a new server starts,
 * every message the turn wrote reaches Telegram exactly once and in order. The server is killed the way
 * a terminal or systemd does it, by its whole process group, so the check also proves the child is
 * detached from it. Then `/new` and `/stop` are acknowledged with a reaction and nothing else, and a
 * stopped turn says nothing more. Last, a photo: the server downloads it from the fake Bot API, and the
 * model receives it as an image block (on a resumed conversation). Then an edit to home/ (a git commit
 * by shuvi) is in the system prompt of the very next turn of the same conversation, without `/new`.
 * Then stickers: a pack file in home/ is indexed and its set fetched by the server, a turn calls
 * `find_sticker` then `sticker`, and the fake Bot API receives `sendSticker`.
 *
 *   bun scripts/e2e-fake.ts
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/store/db.ts";
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

// ---- fake Anthropic: step 1 says something and calls `say`; step 2 (after the tool result) is SLOW ----
type Block = { type: string; text?: string; source?: { type?: string; data?: string }; tool_use_id?: string; content?: unknown };
type Msg = { role: string; content: string | Block[] };
// A valid 1x1 PNG: the photo the owner sends in step 4.
const PHOTO = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
type ImageSeen = { data: string; withText: string; messages: number };
let imageSeen = null as ImageSeen | null;
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
let stickerFound = "";
let stickerResult = "";
let slowStepStarted = false;
let longStepStarted = false;
let modelRequests = 0;
/** The system prompt of each request of the memory section (4), by step. */
const memorySystems: Record<string, string> = {};
const anthropic = Bun.serve({
  port: 0,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as { system?: unknown; messages?: Msg[]; tools?: Array<{ name: string }> }) : {};
    if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 10 });
    if (!url.pathname.endsWith("/v1/messages")) return Response.json({});
    if (!body.tools?.some((t) => t.name === "mcp__shuvi__say")) return stream("msg_side", [{ type: "text", text: "ok" }], "end_turn");
    modelRequests++;
    // Section 4 (memory). Matched on the LAST message, since the conversation's history holds section 3's.
    const latest = JSON.stringify(body.messages?.at(-1) ?? "");
    const system = JSON.stringify(body.system ?? "");
    if (latest.includes("what do I drink")) {
      memorySystems.ask = system;
      return stream(`msg_${modelRequests}`, [{ type: "text", text: system.includes("Likes green tea") ? "Green tea." : "No idea." }], "end_turn");
    }
    if (latest.includes("toolu_mem")) return stream(`msg_${modelRequests}`, [{ type: "text", text: "Noted: green tea." }], "end_turn");
    if (latest.includes("remember I like green tea")) {
      memorySystems.edit = system;
      return stream(`msg_${modelRequests}`, [{ type: "tool_use", id: "toolu_mem", name: "mcp__shuvi__edit_home", input: { path: "memory/private.md", content: "- Likes green tea", why: "The owner told me what they drink" } }], "tool_use");
    }
    const lastMsg = body.messages?.at(-1);
    const lastBlocks = Array.isArray(lastMsg?.content) ? lastMsg!.content : [];
    const image = lastBlocks.find((b) => b.type === "image" && b.source?.type === "base64");
    // Step 5: find a sticker, send it, then a word.
    const toolResult = (id: string) => lastBlocks.find((b) => b.type === "tool_result" && b.tool_use_id === id);
    if (toolResult("toolu_find")) {
      stickerFound = JSON.stringify(toolResult("toolu_find")!.content);
      return stream(`msg_${modelRequests}`, [{ type: "tool_use", id: "toolu_send", name: "mcp__shuvi__sticker", input: { id: "Cats/1" } }], "tool_use");
    }
    if (toolResult("toolu_send")) {
      stickerResult = JSON.stringify(toolResult("toolu_send")!.content);
      return stream(`msg_${modelRequests}`, [{ type: "text", text: "There you go." }], "end_turn");
    }
    if (lastMsg?.role === "user" && !lastBlocks.some((b) => b.type === "tool_result") && JSON.stringify(lastMsg.content).includes("send me a sticker")) {
      return stream(`msg_${modelRequests}`, [{ type: "tool_use", id: "toolu_find", name: "mcp__shuvi__find_sticker", input: { terms: ["hello"] } }], "tool_use");
    }
    if (lastMsg?.role === "user" && image) {
      imageSeen = { data: image.source!.data!, withText: JSON.stringify(lastBlocks.filter((b) => b.type === "text")), messages: body.messages!.length };
      return stream(`msg_${modelRequests}`, [{ type: "text", text: "A red square." }], "end_turn");
    }
    if (JSON.stringify(body.messages).includes("a long time")) {
      longStepStarted = true;
      await Bun.sleep(20_000); // only ever cut short by /stop
      return stream(`msg_${modelRequests}`, [{ type: "text", text: "must not be sent" }], "end_turn");
    }
    const last = body.messages?.at(-1);
    const blocks = Array.isArray(last?.content) ? last!.content : [];
    if (blocks.some((b) => b.type === "tool_result")) {
      slowStepStarted = true;
      await Bun.sleep(4000); // the window in which the server is killed
      return stream(`msg_${modelRequests}`, [{ type: "text", text: "All done." }], "end_turn");
    }
    return stream(`msg_${modelRequests}`, [{ type: "text", text: "On it, let me look" }, { type: "tool_use", id: `toolu_${modelRequests}`, name: "mcp__shuvi__say", input: { text: "Halfway there, here is the gist" } }], "tool_use");
  },
});

// ---- the world ---------------------------------------------------------------------------------------
const tg = new FakeTelegram();
const dataDir = mkdtempSync(join(tmpdir(), "shuvi-e2e-"));
const env = {
  ...process.env,
  SHUVI_DATA_DIR: dataDir,
  SHUVI_BOT_TOKEN: "TOKEN",
  SHUVI_OWNER_ID: String(OWNER),
  SHUVI_TELEGRAM_API_ROOT: tg.apiRoot,
  SHUVI_MODEL: "claude-sonnet-4-5",
  SHUVI_TZ: "Asia/Taipei",
  ANTHROPIC_BASE_URL: `http://localhost:${anthropic.port}`,
  ANTHROPIC_API_KEY: "sk-ant-fake",
};
let server: ReturnType<typeof Bun.spawn> | null = null;
const startServer = () => {
  // Its own process group, so it can be killed as a group, the way a terminal or systemd kills it.
  server = Bun.spawn([process.execPath, "src/server/main.ts"], { env, stdout: "inherit", stderr: "inherit", detached: true });
};
function cleanup() {
  try {
    if (server) process.kill(-server.pid, "SIGKILL");
  } catch {}
  tg.stop();
  anthropic.stop(true);
}
const texts = () => tg.sent().map((b) => String(b.text));

// ---- 1. a turn that outlives its server ----------------------------------------------------------------
startServer();
tg.updates.push(dmUpdate(1, "Can you check tomorrow's weather"));
await until("the first two messages to reach Telegram", () => texts().length >= 2);
check(texts().join("|") === "On it, let me look|Halfway there, here is the gist", `text before a tool call and a say() arrive in order (${texts().join("|")})`);
await until("the slow model step to start", () => slowStepStarted);

process.kill(-server!.pid, "SIGTERM"); // the whole group: only a detached child survives this
await server!.exited;
log("server's process group stopped mid-turn");
const db = openDb(join(dataDir, "shuvi.db"));
const running = db.$client.query("select id, pid from turns where status = 'running'").all() as { id: number; pid: number }[];
check(running.length === 1, "the turn is still running with no server");

await until("the turn to finish on its own", () => (db.$client.query("select status from turns where id = ?").get(running[0]!.id) as { status: string }).status !== "running", 30_000);
check(texts().length === 2, "nothing was sent while no server was up");
const pending = db.$client.query("select count(*) as n from chat_events where status = 'pending'").get() as { n: number };
check(pending.n === 1, "the turn's last message waits, queued");

startServer();
await until("the queued message to be delivered", () => texts().length >= 3);
await Bun.sleep(1500); // room for any duplicate to show up
check(texts().join("|") === "On it, let me look|Halfway there, here is the gist|All done.", `every message exactly once, in order (${texts().join("|")})`);
const turn = db.$client.query("select status, from_seq, to_seq from turns").all() as { status: string }[];
check(turn.length === 1 && turn[0]!.status === "done", "one turn, done (no retry)");
const chat = db.$client.query("select cursor_seq, backend_session_id from chats").get() as { cursor_seq: number; backend_session_id: string };
check(chat.cursor_seq === 1 && !!chat.backend_session_id, "the cursor moved past the message, and the conversation id was kept");

// ---- 2. /new is acknowledged by a reaction, and the framework says nothing ---------------------------
tg.updates.push(dmUpdate(2, "/new"));
await until("the /new acknowledgement", () => tg.sent("setMessageReaction").length >= 1);
check(JSON.stringify(tg.sent("setMessageReaction")[0]!.reaction) === JSON.stringify([{ type: "emoji", emoji: "👌" }]), "/new is acknowledged with 👌");
check(texts().length === 3, "and no message was sent for it");
const after = db.$client.query("select backend_session_id from chats").get() as { backend_session_id: string | null };
check(after.backend_session_id === null, "the conversation was reset");

// ---- 3. /stop ends a running turn, and the stopped turn says nothing ---------------------------------
tg.updates.push(dmUpdate(3, "do something that takes a long time"));
await until("the long model step to start", () => longStepStarted);
tg.updates.push(dmUpdate(4, "/stop"));
await until("the /stop acknowledgement", () => tg.sent("setMessageReaction").length >= 2);
await until("the turn to close", () => (db.$client.query("select status from turns order by id desc limit 1").get() as { status: string }).status !== "running", 15_000);
const stopped = db.$client.query("select status from turns order by id desc limit 1").get() as { status: string };
check(stopped.status === "stopped", "the turn closed as stopped");
await Bun.sleep(1000);
check(!texts().includes("must not be sent") && texts().length === 3, "and nothing more was said");

// ---- 4. a photo: downloaded by the server, shown to the model as an image ------------------------------
tg.files.set("photo-m", Buffer.from(PHOTO, "base64"));
tg.updates.push(
  dmUpdate(5, undefined as never, OWNER, {
    text: undefined,
    caption: "what colour is this",
    photo: [
      { file_id: "photo-s", file_unique_id: "ps", width: 90, height: 90 },
      { file_id: "photo-m", file_unique_id: "pm", width: 1280, height: 1280 },
      { file_id: "photo-l", file_unique_id: "pl", width: 2560, height: 2560 },
    ],
  }),
);
await until("the reply to the photo", () => texts().includes("A red square."));
check(tg.sent("getFile").some((b) => b.file_id === "photo-m"), "the server fetched the photo size that fits (getFile)");
check(existsSync(join(dataDir, "media", "pm")), "the photo was stored under media/<file_unique_id>");
const seenImage = imageSeen as ImageSeen | null; // set by the fake's handler, which TypeScript cannot follow
check(seenImage?.data === PHOTO, "the fake Anthropic API received the photo as an image block");
check(!!seenImage?.withText.includes("[photo] what colour is this"), `with its line and placeholder as text (${seenImage?.withText})`);
check((seenImage?.messages ?? 0) > 1, `in a resumed conversation: the new user message follows ${(seenImage?.messages ?? 1) - 1} earlier one(s)`);
const photoEvent = db.$client.query("select payload from chat_events where kind = 'message' order by seq desc limit 1").get() as { payload: string };
check(JSON.parse(photoEvent.payload).media?.state === "ready", "the message event records its media as downloaded");

// ---- 5. an edit to home/ is seen by the next turn of the same conversation ---------------------------
tg.updates.push(dmUpdate(6, "remember I like green tea"));
await until("the edit to be acknowledged", () => texts().includes("Noted: green tea."));
const home = join(dataDir, "home");
const gitLog = Bun.spawnSync(["git", "-C", home, "log", "--format=%an|%s", "--", "memory/private.md"]).stdout.toString().trim();
check(gitLog === "shuvi|The owner told me what they drink", `the edit is a commit in home/ by shuvi, with its why (${gitLog})`);
check(!memorySystems.edit!.includes("Likes green tea"), "the turn that made the edit started without it");
await until("the edit turn to close", () => (db.$client.query("select status from turns order by id desc limit 1").get() as { status: string }).status !== "running", 15_000);
const session = (db.$client.query("select backend_session_id from chats").get() as { backend_session_id: string | null }).backend_session_id;
check(!!session, "the conversation goes on (no /new)");

const before = texts().length;
tg.updates.push(dmUpdate(7, "what do I drink?"));
await until("the answer", () => texts().length > before);
check(texts().at(-1) === "Green tea.", `the next turn's system prompt has the edit (${texts().at(-1)})`);
const resumed = (db.$client.query("select backend_session_id from chats").get() as { backend_session_id: string }).backend_session_id;
check(resumed === session, "and it was the same conversation, resumed");

// ---- 6. stickers: the library is indexed, the set fetched, and find_sticker + sticker reach sendSticker --
tg.files.set("cats-f1", Buffer.from(PHOTO, "base64"));
tg.files.set("cats-f2", Buffer.from(PHOTO, "base64"));
tg.stickerSets.set("Cats", {
  name: "Cats",
  title: "Cats",
  sticker_type: "regular",
  stickers: [1, 2].map((n) => ({ file_id: `cats-f${n}`, file_unique_id: `cats-u${n}`, type: "regular", width: 512, height: 512, is_animated: false, is_video: false, emoji: "👋", set_name: "Cats" })),
} as never);
mkdirSync(join(dataDir, "home", "stickers"), { recursive: true });
writeFileSync(
  join(dataDir, "home", "stickers", "Cats.yaml"),
  "pack: Cats\nrole: avatar\nstickers:\n  - n: 1\n    file_unique_id: cats-u1\n    desc: a cat waving\n    use: hello, hi\n  - n: 2\n    file_unique_id: cats-u2\n    desc: a cat asleep\n    use: good night\n",
);
await until("the server to index the pack and fetch its set", () => {
  const r = db.$client.query("select count(*) as n from sticker_meta where set_name = 'Cats'").get() as { n: number } | null;
  return (r?.n ?? 0) === 2;
});
log("ok  the server indexed home/stickers/Cats.yaml and fetched the set (getStickerSet)");
tg.updates.push(dmUpdate(8, "send me a sticker"));
await until("the sticker to be sent", () => tg.sent("sendSticker").length >= 1);
check(stickerFound.includes("Cats/1") && stickerFound.includes("a cat waving"), `find_sticker offered Cats/1 (${stickerFound.slice(0, 120)})`);
check(stickerResult.includes("Sent Cats/1."), `sticker() accepted it (${stickerResult})`);
check(tg.sent("sendSticker")[0]!.sticker === "cats-f1", "the fake Bot API received sendSticker with the sticker's file_id");
await until("the text after it", () => texts().includes("There you go."));
const stickerRow = db.$client.query("select status, tg_message_id from chat_events where kind = 'bot_sticker'").get() as { status: string; tg_message_id: number };
check(stickerRow.status === "sent" && stickerRow.tg_message_id > 0, "the bot_sticker row is recorded as delivered, with its message id");

log("PASS");
cleanup();
process.exit(0);
