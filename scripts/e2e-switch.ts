#!/usr/bin/env bun
/**
 * Switching a chat's model, end to end, with nothing real but the code under test and the Claude Code CLI:
 *
 *   fake Telegram ⇄ shuvi server ⇄ runner child ⇄ real Claude Code CLI ⇄ fake Anthropic API
 *                                              └ OpenAI-compatible driver ⇄ fake Chat Completions endpoint
 *
 * A first start seeds the catalog with the Claude login; the script adds a second model of that login, an
 * OpenAI-compatible endpoint with two models, and a second login, and switches the owner's DM between them
 * between turns (agent/switch.ts), as the owner's surface will. A chat has a conversation per model:
 *
 *   T1 on Claude sonnet (a tool call, then an answer)
 *   → lossless → T2 on the endpoint: sent T1, its call paired with its result
 *   → lossy    → T3 on sonnet: its own session resumed, T2 not in it (the owner's "black hole")
 *   → lossless → T4 on the endpoint: T1, T2 as it had them, then T3 carried, each once
 *   → lossless → T5 on sonnet: T1 and T3 as Claude wrote them, T4 carried, still no T2
 *   → lossless → T6 on Claude opus, the same login, no conversation yet: sonnet's session copied (forked)
 *                as it is, resumed by the CLI on opus; sonnet's own file untouched
 *   → lossy    → T7 on sonnet: its own session, without T6
 *   → lossless → T8 on a second Claude login: a new session the switch wrote, of all of sonnet's, resumed
 *   → lossy    → T9 on the endpoint's first model: its own conversation (T1 to T4), nothing of T5 to T8
 *   → lossy    → T10 on the endpoint's second model, no conversation yet: fresh, with the last messages
 *   → lossy    → T11 on the first model again: its own conversation resumed (T9), without T10
 *   → lossy    → T12 on sonnet; T13 there is held at the API, and a lossless switch to the endpoint's first
 *                model is REQUESTED meanwhile: the server stops T13, applies the switch (T12 carried, not
 *                T13's prompt, which the CLI already wrote), and the endpoint answers T13, sent its prompt once
 *   → lossy    → T14 on sonnet, switched FROM THE CONSOLE: the chat's settings page (console/chat-settings*.ts),
 *                signed in as a tailnet user, its Origin and CSRF token, posts the switch; the page follows the
 *                request to its result, the bot's own words; T14 then runs on sonnet, its own session resumed
 *   → clean    → T15 on the endpoint's first model, which has a conversation (T1 to T13): a CLEAN START drops
 *                it, and T15's request is a new conversation holding T15's prompt and nothing earlier, not even
 *                the chat's last messages
 *
 * What each model was sent is checked on the wire, and that nothing in it says a switch happened.
 *
 *   bun scripts/e2e-switch.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findClaudeSession } from "agent-runtime/convert";
import { requestSwitch, switchModel } from "../src/agent/switch.ts";
import { openDb } from "../src/store/db.ts";
import { addModel, addProvider } from "../src/store/models.ts";
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
    await Bun.sleep(100);
  }
}
/** Each marker, in order, each after the one before it. */
function inOrder(wire: string, markers: string[]): string[] {
  let at = 0;
  return markers.filter((m) => {
    const i = wire.indexOf(m, at);
    if (i < 0) return true;
    at = i + m.length;
    return false;
  });
}
const count = (wire: string, s: string) => wire.split(s).length - 1;

// ---- fake Anthropic: a T1 calls `say`, then answers; every other turn answers with its marker ----------
type Msg = { role: string; content: unknown };
/** The turn a prompt is for: its last marker (a fresh conversation's prompt opens with the last messages). */
const lastMarker = (s: string) => [...s.matchAll(/T(\d+)-PROMPT/g)].at(-1)?.[1] ?? "?";
const claudeSeen: Msg[][] = [];
const claudeModels: string[] = [];
let t13Held = false;
let releaseT13 = () => {};
const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
function anthropicReply(id: string, model: string, blocks: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown }>, stop: string): Response {
  let out = ev("message_start", { message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 1 } } });
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
const anthropic = Bun.serve({
  port: 0,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as { model: string; messages?: Msg[]; tools?: Array<{ name: string }> }) : { model: "", messages: [] };
    if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 10 });
    if (!url.pathname.endsWith("/v1/messages")) return Response.json({});
    if (!body.tools?.some((t) => t.name === "mcp__shuvi__say")) return anthropicReply("msg_side", body.model, [{ type: "text", text: "ok" }], "end_turn");
    claudeSeen.push(body.messages ?? []);
    // The last user message: resumed on another model, the CLI appends a `system` message of its own after it.
    const last = JSON.stringify(body.messages?.findLast((m) => m.role === "user") ?? "");
    const n = claudeSeen.length;
    if (last.includes("T1-PROMPT")) return anthropicReply(`msg_${n}`, body.model, [{ type: "tool_use", id: "toolu_T1", name: "mcp__shuvi__say", input: { text: "T1-SAY" } }], "tool_use");
    if (last.includes("toolu_T1")) return anthropicReply(`msg_${n}`, body.model, [{ type: "text", text: "T1-ANSWER" }], "end_turn");
    claudeModels.push(body.model);
    const marker = lastMarker(last);
    if (marker === "13") {
      // Held until the switch request stops the turn (its CLI is killed, and this request with it).
      t13Held = true;
      await new Promise<void>((resolve) => (releaseT13 = resolve));
    }
    return anthropicReply(`msg_${n}`, body.model, [{ type: "text", text: `T${marker}-ANSWER` }], "end_turn");
  },
});

// ---- fake Chat Completions endpoint: every turn answers with its marker -------------------------------
const openaiSeen: Msg[][] = [];
/** The names of the tools each of those requests offered, in the same order, without their server's prefix (`shuvi__`). */
const openaiTools: string[][] = [];
const sse = (chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const chunk = (delta: unknown, finish: string | null = null) => ({ id: "c", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 3, total_tokens: 53 } } : {}) });
const openai = Bun.serve({
  port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    const body = (await req.json()) as { messages: Msg[]; tools?: Array<{ function?: { name?: string } }> };
    openaiSeen.push(body.messages);
    openaiTools.push((body.tools ?? []).map((t) => (t.function?.name ?? "").replace(/^[A-Za-z0-9-]+__/, "")));
    const marker = lastMarker(JSON.stringify(body.messages.at(-1)));
    return sse([chunk({ role: "assistant", content: `T${marker}-ANSWER` }), chunk({}, "stop")]);
  },
});

// ---- the world ---------------------------------------------------------------------------------------
const tg = new FakeTelegram();
const dataDir = mkdtempSync(join(tmpdir(), "shuvi-e2e-switch-"));
const secretsFile = join(dataDir, "secrets.yaml");
writeFileSync(secretsFile, "fake:\n  API_KEY: sk-fake-local\n", { mode: 0o600 });
const env = {
  ...process.env,
  SHUVI_DATA_DIR: dataDir,
  SHUVI_BOT_TOKEN: "TOKEN",
  SHUVI_OWNER_ID: String(OWNER),
  SHUVI_TELEGRAM_API_ROOT: tg.apiRoot,
  // A first start seeds the catalog with this login and model (store/models.ts `seedModels`).
  SHUVI_MODEL: "claude-sonnet-4-5",
  SHUVI_CLAUDE_CONFIG_DIR: join(dataDir, "claude"),
  SHUVI_SECRETS_FILE: secretsFile,
  SHUVI_TZ: "Asia/Taipei",
  SHUVI_WEB: "off",
  SHUVI_CONSOLE_LISTEN: "127.0.0.1:0",
  SHUVI_CONSOLE_USERS: "owner@example.com",
  ANTHROPIC_BASE_URL: `http://localhost:${anthropic.port}`,
  ANTHROPIC_API_KEY: "sk-ant-fake",
};
const server = Bun.spawn([process.execPath, "src/server/main.ts"], { env, stdout: "pipe", stderr: "inherit", detached: true });
// The console binds any free port (0); the server's log says which.
let consolePort = 0;
tapLines(server.stdout, (line) => (consolePort = consolePortIn(line) ?? consolePort));
function cleanup() {
  try {
    process.kill(-server.pid, "SIGKILL");
  } catch {}
  releaseT13();
  tg.stop();
  anthropic.stop(true);
  openai.stop(true);
}
const texts = () => tg.sent().map((b) => String(b.text));
// The database is opened once the server has answered T1: by then it has made and migrated it.
let db: ReturnType<typeof openDb> | null = null;
const idle = () => !db || (db.$client.query("select count(*) as n from turns where status = 'running'").get() as { n: number }).n === 0;
let update = 1;
async function turn(n: number): Promise<void> {
  const before = texts().length;
  tg.updates.push(dmUpdate(update++, `T${n}-PROMPT please`));
  await until(`T${n}'s answer`, () => texts().slice(before).includes(`T${n}-ANSWER`));
  db ??= openDb(join(dataDir, "shuvi.db"));
  await until(`T${n} to end`, idle);
}
const chat = () => db!.$client.query("select id, model, conversation_model as owner, backend_session_id as session from chats").get() as { id: number; model: string | null; owner: string | null; session: string | null };
const sessionFile = (dir: string, id: string) => findClaudeSession(id, dir);
const lastOpening = () => (db!.$client.query("select opening from turns order by id desc limit 1").get() as { opening: string }).opening;

try {
  // T1 on the seeded Claude model.
  await turn(1);
  check(texts().slice(0, 2).join("|") === "T1-SAY|T1-ANSWER", "T1 ran on Claude: a say() call, then its answer");
  const claudeSession = chat().session!;
  check(chat().owner === "claude/claude-sonnet-4-5" && !!claudeSession, "the conversation is the seeded model's");
  const store = db!;
  addProvider(store, { name: "fake", kind: "openai-compat", baseUrl: `http://127.0.0.1:${openai.port}/v1`, apiKey: "fake.API_KEY" });
  addModel(store, { provider: "fake", model: "fake-model", contextWindow: 32_000 });

  // → lossless → T2 on the endpoint.
  check(switchModel(store, chat().id, "fake/fake-model", "lossless").carried > 0, "a lossless switch to the endpoint carries T1");
  await turn(2);
  const r2 = JSON.stringify(openaiSeen.at(-1));
  check(inOrder(r2, ["T1-PROMPT", '"name":"shuvi__say"', "T1-SAY", "T1-ANSWER", "T2-PROMPT"]).length === 0, "T2's request holds T1, its call paired with its result, then T2's prompt");
  check(lastOpening() === "switched" && chat().owner === "fake/fake-model", "T2 opened the endpoint model's conversation (`switched`)");
  const fakeSession = chat().session!;

  // → lossy → T3 on Claude.
  check(switchModel(store, chat().id, "claude/claude-sonnet-4-5", "lossy").carried === 0, "a lossy switch carries nothing");
  check(chat().session === claudeSession, "Claude's own session is resumed");
  await turn(3);
  const r3 = JSON.stringify(claudeSeen.at(-1));
  check(inOrder(r3, ["T1-PROMPT", "T1-ANSWER", "T3-PROMPT"]).length === 0 && !r3.includes("T2-"), "T3's request holds T1 and T3, and nothing of T2");

  // → lossless → T4 on the endpoint.
  switchModel(store, chat().id, "fake/fake-model", "lossless");
  await turn(4);
  const r4 = JSON.stringify(openaiSeen.at(-1));
  check(inOrder(r4, ["T1-ANSWER", "T2-PROMPT", "T2-ANSWER", "T3-PROMPT", "T3-ANSWER", "T4-PROMPT"]).length === 0, "T4's request holds T1, T2, then T3 carried, then T4's prompt");
  check(["T1-PROMPT", "T2-PROMPT", "T3-PROMPT"].every((m) => count(r4, m) === 1), "each earlier turn once");

  // → lossless → T5 on Claude.
  switchModel(store, chat().id, "claude/claude-sonnet-4-5", "lossless");
  await turn(5);
  const r5 = JSON.stringify(claudeSeen.at(-1));
  check(inOrder(r5, ["T1-PROMPT", "T1-ANSWER", "T3-PROMPT", "T3-ANSWER", "T4-PROMPT", "T4-ANSWER", "T5-PROMPT"]).length === 0 && !r5.includes("T2-"), "T5's request holds T1 and T3 (Claude's own), T4 carried, still no T2");
  check(chat().session === claudeSession, "all on the one Claude session");

  // → lossless → T6 on another model of the same Claude login, with no conversation yet: a fork.
  addModel(store, { provider: "claude", model: "claude-opus-4-1" });
  const claudeDir = join(dataDir, "claude");
  // The conversation: its entries (each has a `uuid`), without Claude Code's per-process metadata lines
  // (`last-prompt`, `cost-state`, …). A CLI appends those when it exits, which for a warm runner's resident CLI
  // (SHUVI_WARM_RUNNERS) is when it is closed, possibly after the copy below.
  const conversationOf = (text: string) =>
    text
      .split("\n")
      .filter((l) => {
        try {
          return "uuid" in (JSON.parse(l) as object);
        } catch {
          return false;
        }
      })
      .join("\n");
  const sonnetBytes = conversationOf(readFileSync(sessionFile(claudeDir, claudeSession)!, "utf8"));
  check(switchModel(store, chat().id, "claude/claude-opus-4-1", "lossless").carried > 0, "a lossless switch to a model of the same login with no conversation copies it");
  const opusSession = chat().session!;
  check(chat().owner === "claude/claude-opus-4-1" && opusSession !== claudeSession && !!sessionFile(claudeDir, opusSession), "a new session id, in the same login");
  await turn(6);
  const r6 = JSON.stringify(claudeSeen.at(-1));
  check(claudeModels.at(-1) !== claudeModels.at(-2), `T6 ran on another model than T5 (${claudeModels.at(-2)} → ${claudeModels.at(-1)})`);
  check(inOrder(r6, ["T1-PROMPT", '"name":"mcp__shuvi__say"', "T1-SAY", "T1-ANSWER", "T3-PROMPT", "T3-ANSWER", "T4-PROMPT", "T4-ANSWER", "T5-PROMPT", "T5-ANSWER", "T6-PROMPT"]).length === 0 && !r6.includes("T2-"), "the CLI resumed the copy: sonnet's conversation as it was, then T6's prompt");
  check(["T1-PROMPT", "T5-PROMPT"].every((m) => count(r6, m) === 1), "each earlier turn once");
  check(conversationOf(readFileSync(sessionFile(claudeDir, claudeSession)!, "utf8")) === sonnetBytes, "sonnet's own session file is untouched");

  // → lossy → T7 on sonnet: its own session, without T6.
  switchModel(store, chat().id, "claude/claude-sonnet-4-5", "lossy");
  check(chat().session === claudeSession, "sonnet's own session is resumed");
  await turn(7);
  const r7 = JSON.stringify(claudeSeen.at(-1));
  check(inOrder(r7, ["T5-PROMPT", "T5-ANSWER", "T7-PROMPT"]).length === 0 && !r7.includes("T6-"), "T7's request holds sonnet's conversation and nothing of T6");

  // → lossless → T8 on a second Claude login, with no conversation yet.
  addProvider(store, { name: "work", kind: "claude", configDir: join(dataDir, "claude-work") });
  addModel(store, { provider: "work", model: "claude-sonnet-4-5" });
  check(switchModel(store, chat().id, "work/claude-sonnet-4-5", "lossless").carried > 0, "a lossless switch to another login's model with no conversation carries the whole conversation");
  check(chat().owner === "work/claude-sonnet-4-5" && chat().session !== claudeSession && !!sessionFile(join(dataDir, "claude-work"), chat().session!), "a new session, in the second login");
  await turn(8);
  const r8 = JSON.stringify(claudeSeen.at(-1));
  check(inOrder(r8, ["T1-PROMPT", "T1-ANSWER", "T3-PROMPT", "T4-PROMPT", "T5-PROMPT", "T7-PROMPT", "T7-ANSWER", "T8-PROMPT"]).length === 0 && !r8.includes("T2-") && !r8.includes("T6-"), "the CLI resumed the new session: T1, T3, T4, T5, T7, then T8's prompt");

  // → lossy → T9 on the endpoint's first model: its own conversation, as it was left after T4.
  addModel(store, { provider: "fake", model: "other-model", contextWindow: 32_000 });
  switchModel(store, chat().id, "fake/fake-model", "lossy");
  check(chat().session === fakeSession, "the endpoint model's own conversation is resumed");
  await turn(9);
  const r9 = JSON.stringify(openaiSeen.at(-1));
  check(inOrder(r9, ["T1-PROMPT", "T2-PROMPT", "T3-PROMPT", "T4-PROMPT", "T4-ANSWER", "T9-PROMPT"]).length === 0 && !["T5-", "T6-", "T7-", "T8-"].some((m) => r9.includes(m)), "T9's request holds T1 to T4 and nothing said on Claude since");

  // → lossy → T10 on the endpoint's second model, with no conversation yet: a fresh one.
  switchModel(store, chat().id, "fake/other-model", "lossy");
  check(chat().owner === "fake/other-model" && chat().session === null, "the other model has no conversation: the next turn starts fresh");
  await turn(10);
  const r10 = openaiSeen.at(-1)!;
  check(r10.filter((m) => m.role !== "system").length === 1 && JSON.stringify(r10).includes("T10-PROMPT"), "T10's request is a fresh conversation: one user message (the last messages, then T10's prompt)");
  check(lastOpening() === "switched" && !!chat().session && chat().session !== fakeSession, "T10 opened the other model's own conversation");

  // → lossy → T11 back on the first model: its own conversation resumed, without T10.
  switchModel(store, chat().id, "fake/fake-model", "lossy");
  check(chat().session === fakeSession, "the first model's conversation is active again");
  await turn(11);
  const r11 = JSON.stringify(openaiSeen.at(-1));
  check(inOrder(r11, ["T4-ANSWER", "T9-PROMPT", "T9-ANSWER", "T11-PROMPT"]).length === 0 && !r11.includes("T10-"), "T11's request holds the first model's conversation (T9) and nothing of T10");

  // → lossy → T12 on sonnet; then T13 is held, and a lossless switch back to the endpoint is requested.
  switchModel(store, chat().id, "claude/claude-sonnet-4-5", "lossy");
  await turn(12);
  const before13 = texts().length;
  tg.updates.push(dmUpdate(update++, "T13-PROMPT please"));
  await until("T13 to reach the API", () => t13Held);
  // The CLI writes the prompt into the session around the time it calls the API: wait for it, so the switch
  // below has a stopped turn's part to leave out.
  await until("the CLI to write T13's prompt into sonnet's session", () => readFileSync(sessionFile(claudeDir, claudeSession)!, "utf8").includes("T13-PROMPT"), 15_000);
  log("ok  the CLI has written T13's prompt into sonnet's session");
  const req = requestSwitch(store, chat().id, "fake/fake-model", "lossless");
  const request = () => store.$client.query("select status, stopped_turn_id as stopped, result from model_switch_requests where id = ?").get(req.id) as { status: string; stopped: number | null; result: string | null };
  await until("the request to be applied", () => request().status !== "pending");
  check(request().status === "done" && request().stopped !== null, "the server stopped T13's turn, then applied the switch");
  check((store.$client.query("select status from turns where id = ?").get(request().stopped) as { status: string }).status === "stopped", "the stopped turn closed as stopped");
  check((JSON.parse(request().result!) as { carried: number }).carried === 2, "the switch carried T12, not what the stopped turn added");
  await until("T13's answer from the endpoint", () => texts().slice(before13).includes("T13-ANSWER"));
  await until("T13 to end", idle);
  const r13 = JSON.stringify(openaiSeen.at(-1));
  check(inOrder(r13, ["T11-ANSWER", "T12-PROMPT", "T12-ANSWER", "T13-PROMPT"]).length === 0 && count(r13, "T13-PROMPT") === 1, "the endpoint was sent T12 carried, then T13's prompt once, as its input");

  // → lossy → T14 on sonnet, switched from the console's settings page for the chat.
  await until("the console to be listening", () => consolePort > 0);
  const base = `http://127.0.0.1:${consolePort}`;
  const as = { "tailscale-user-login": "owner@example.com" };
  const settings = `${base}/chats/${chat().id}/settings`;
  const pageNow = async (path: string) => (await fetch(`${base}${path}`, { headers: as })).text();
  const picked = await pageNow(`/chats/${chat().id}/settings?to=claude/claude-sonnet-4-5`);
  check(picked.includes("Switch from <span class=\"mono\">fake/fake-model</span> to <span class=\"mono\">claude/claude-sonnet-4-5</span>. How?"), "the page offers Lossless / Lossy for the model picked");
  const csrf = /name="csrf" value="([^"]+)"/.exec(picked)![1]!;
  const refused = await fetch(`${settings}/switch`, { method: "POST", headers: as, body: new URLSearchParams({ csrf, to: "claude/claude-sonnet-4-5", mode: "lossy" }), redirect: "manual" });
  check(refused.status === 403, "a switch without the console's Origin is refused");
  const posted = await fetch(`${settings}/switch`, { method: "POST", headers: { ...as, origin: base }, body: new URLSearchParams({ csrf, to: "claude/claude-sonnet-4-5", mode: "lossy" }), redirect: "manual" });
  const back = posted.headers.get("location") ?? "";
  check(posted.status === 303 && back.startsWith(`/chats/${chat().id}/settings?r=`), "the switch is a POST answered 303 back to the page");
  const consoleReq = store.$client.query("select id from model_switch_requests order by id desc limit 1").get() as { id: number };
  check((store.$client.query("select count(*) as n from control_cards where idem_key like 'console-switch:%' and switch_request_id = ?").get(consoleReq.id) as { n: number }).n === 1, "asked through a switch card of the console's, as the bot asks");
  const followed = await pageNow(back);
  check(followed.includes("Switching to") || followed.includes("→ claude/claude-sonnet-4-5"), "the page follows the request");
  await until("the console's request to be applied", () => (store.$client.query("select status from model_switch_requests where id = ?").get(consoleReq.id) as { status: string }).status !== "pending");
  const done = await fetch(`${settings}/switching?req=${consoleReq.id}`, { headers: as });
  const result = await pageNow(done.headers.get("hx-redirect") ?? "/none");
  check(result.includes("→ claude/claude-sonnet-4-5 (lossy, its own conversation resumed)"), "once applied, the page shows the result in the bot's words");
  check(chat().model === "claude/claude-sonnet-4-5" && chat().session === claudeSession, "the chat is on sonnet, its own session active again");
  const claudeBefore = claudeSeen.length;
  await turn(14);
  const r14 = JSON.stringify(claudeSeen.at(-1));
  check(claudeSeen.length > claudeBefore && r14.includes("T14-PROMPT") && !JSON.stringify(openaiSeen.at(-1)).includes("T14-PROMPT"), "T14 ran on sonnet, not on the endpoint");
  check(inOrder(r14, ["T12-PROMPT", "T12-ANSWER", "T14-PROMPT"]).length === 0 && !r14.includes("T13-ANSWER"), "T14's request is sonnet's own conversation (T12), without what the endpoint said in T13");

  // → clean → T15 on the endpoint's first model: its conversation (T1 to T13) dropped, nothing carried.
  check(store.$client.query("select 1 from chat_conversations where model = 'fake/fake-model'").get() !== null, "the endpoint model has a parked conversation");
  const cleanReq = requestSwitch(store, chat().id, "fake/fake-model", "clean");
  await until("the clean start to be applied", () => (store.$client.query("select status from model_switch_requests where id = ?").get(cleanReq.id) as { status: string }).status !== "pending");
  check(chat().owner === "fake/fake-model" && chat().session === null, "a clean start: the endpoint model has no conversation now");
  check(store.$client.query("select 1 from chat_conversations where model = 'fake/fake-model'").get() === null, "its parked conversation is dropped");
  check(store.$client.query("select 1 from chat_conversations where model = 'claude/claude-sonnet-4-5'").get() !== null, "sonnet's conversation, the one left, is parked");
  const openaiBefore = openaiSeen.length;
  await turn(15);
  const r15 = openaiSeen.at(-1)!;
  const w15 = JSON.stringify(r15);
  check(openaiSeen.length > openaiBefore && w15.includes("T15-PROMPT"), "T15 ran on the endpoint");
  check(r15.filter((m) => m.role !== "system").length === 1, "T15's request is a new conversation: one user message");
  check(!/T([1-9]|1[0-4])-(PROMPT|ANSWER|SAY)/.test(w15), "and it carries none of the earlier messages, not even the chat's last ones");
  check(lastOpening() === "switched" && !!chat().session, "T15 opened the endpoint model's new conversation");
  const t15Tools = openaiTools.at(-1)!;
  const before15 = openaiTools.slice(0, -1).find((names) => names.includes("read_chat"));
  check(!!before15 && before15.includes("search_chats"), "before the clean start, the endpoint was offered search_chats and read_chat");
  check(t15Tools.includes("say") && !t15Tools.includes("read_chat") && !t15Tools.includes("search_chats"), "a clean conversation is offered no search_chats / read_chat");
  check(!JSON.stringify(r15).includes("Looking back"), "nor their section of the system prompt");

  const said = [...claudeSeen, ...openaiSeen].map((m) => JSON.stringify(m)).join("");
  check(!/switch(ed)? (from|to)|lossless|lossy|clean start/i.test(said), "nothing any model was sent says a switch happened");
  check((store.$client.query("select count(*) as n from model_switches where turn_id is not null").get() as { n: number }).n === 14, "every switch was recorded by the turn after it");
  log("PASS");
} finally {
  cleanup();
}
process.exit(0);
