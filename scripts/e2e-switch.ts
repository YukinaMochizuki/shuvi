#!/usr/bin/env bun
/**
 * Switching a chat's model, end to end, with nothing real but the code under test and the Claude Code CLI:
 *
 *   fake Telegram ⇄ shuvi server ⇄ runner child ⇄ real Claude Code CLI ⇄ fake Anthropic API
 *                                              └ OpenAI-compatible driver ⇄ fake Chat Completions endpoint
 *
 * A first start seeds the catalog with the Claude login; the script adds an OpenAI-compatible endpoint, and
 * switches the owner's DM between them between turns (agent/switch.ts), as the owner's surface will:
 *
 *   T1 on Claude (a tool call, then an answer)
 *   → lossless → T2 on the endpoint: sent T1, its call paired with its result
 *   → lossy    → T3 on Claude: its own session resumed, T2 not in it (the owner's "black hole")
 *   → lossless → T4 on the endpoint: T1, T2 as it had them, then T3 carried, each once
 *   → lossless → T5 on Claude: T1 and T3 as Claude wrote them, T4 carried, still no T2
 *   → lossless → T6 on a second Claude login: a new session the switch wrote, of all of T1 to T5 (as the
 *                first login holds them), resumed by the CLI
 *
 * What each model was sent is checked on the wire, and that nothing in it says a switch happened.
 *
 *   bun scripts/e2e-switch.ts
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { switchModel } from "../src/agent/switch.ts";
import { openDb } from "../src/store/db.ts";
import { addModel, addProvider } from "../src/store/models.ts";
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
const claudeSeen: Msg[][] = [];
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
    const last = JSON.stringify(body.messages?.at(-1) ?? "");
    const n = claudeSeen.length;
    if (last.includes("T1-PROMPT")) return anthropicReply(`msg_${n}`, body.model, [{ type: "tool_use", id: "toolu_T1", name: "mcp__shuvi__say", input: { text: "T1-SAY" } }], "tool_use");
    if (last.includes("toolu_T1")) return anthropicReply(`msg_${n}`, body.model, [{ type: "text", text: "T1-ANSWER" }], "end_turn");
    const marker = /T(\d)-PROMPT/.exec(last)?.[1] ?? "?";
    return anthropicReply(`msg_${n}`, body.model, [{ type: "text", text: `T${marker}-ANSWER` }], "end_turn");
  },
});

// ---- fake Chat Completions endpoint: every turn answers with its marker -------------------------------
const openaiSeen: Msg[][] = [];
const sse = (chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const chunk = (delta: unknown, finish: string | null = null) => ({ id: "c", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 3, total_tokens: 53 } } : {}) });
const openai = Bun.serve({
  port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    const body = (await req.json()) as { messages: Msg[] };
    openaiSeen.push(body.messages);
    const marker = /T(\d)-PROMPT/.exec(JSON.stringify(body.messages.at(-1)))?.[1] ?? "?";
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
  ANTHROPIC_BASE_URL: `http://localhost:${anthropic.port}`,
  ANTHROPIC_API_KEY: "sk-ant-fake",
};
const server = Bun.spawn([process.execPath, "src/server/main.ts"], { env, stdout: "ignore", stderr: "inherit", detached: true });
function cleanup() {
  try {
    process.kill(-server.pid, "SIGKILL");
  } catch {}
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
const chat = () => db!.$client.query("select id, model, lane, backend_session_id as session from chats").get() as { id: number; model: string | null; lane: string | null; session: string | null };
const lastOpening = () => (db!.$client.query("select opening from turns order by id desc limit 1").get() as { opening: string }).opening;

try {
  // T1 on the seeded Claude model.
  await turn(1);
  check(texts().slice(0, 2).join("|") === "T1-SAY|T1-ANSWER", "T1 ran on Claude: a say() call, then its answer");
  const claudeSession = chat().session!;
  check(chat().lane === "claude:claude" && !!claudeSession, "the conversation is in the Claude login's lane");
  const store = db!;
  addProvider(store, { name: "fake", kind: "openai-compat", baseUrl: `http://127.0.0.1:${openai.port}/v1`, apiKey: "fake.API_KEY" });
  addModel(store, { provider: "fake", model: "fake-model", contextWindow: 32_000 });

  // → lossless → T2 on the endpoint.
  check(switchModel(store, chat().id, "fake/fake-model", "lossless").carried > 0, "a lossless switch to the endpoint carries T1");
  await turn(2);
  const r2 = JSON.stringify(openaiSeen.at(-1));
  check(inOrder(r2, ["T1-PROMPT", '"name":"shuvi__say"', "T1-SAY", "T1-ANSWER", "T2-PROMPT"]).length === 0, "T2's request holds T1, its call paired with its result, then T2's prompt");
  check(lastOpening() === "switched" && chat().lane === "openai-compat", "T2 opened the endpoint's conversation (`switched`)");

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

  // → lossless → T6 on a second Claude login, whose lane has no conversation yet.
  addProvider(store, { name: "work", kind: "claude", configDir: join(dataDir, "claude-work") });
  addModel(store, { provider: "work", model: "claude-sonnet-4-5" });
  check(switchModel(store, chat().id, "work/claude-sonnet-4-5", "lossless").carried > 0, "a lossless switch to an empty lane carries the whole conversation");
  check(chat().lane === "claude:work" && chat().session !== claudeSession, "a new session, in the second login's lane");
  await turn(6);
  const r6 = JSON.stringify(claudeSeen.at(-1));
  check(inOrder(r6, ["T1-PROMPT", "T1-ANSWER", "T3-PROMPT", "T4-PROMPT", "T5-PROMPT", "T5-ANSWER", "T6-PROMPT"]).length === 0 && !r6.includes("T2-"), "the CLI resumed the new session: T1, T3, T4, T5, then T6's prompt");

  const said = [...claudeSeen, ...openaiSeen].map((m) => JSON.stringify(m)).join("");
  check(!/switch(ed)? (from|to)|lossless|lossy/i.test(said), "nothing any model was sent says a switch happened");
  check((store.$client.query("select count(*) as n from model_switches where turn_id is not null").get() as { n: number }).n === 5, "every switch was recorded by the turn after it");
  log("PASS");
} finally {
  cleanup();
}
process.exit(0);
