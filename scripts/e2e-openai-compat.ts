#!/usr/bin/env bun
/**
 * The OpenAI-compatible backend end to end, with a local fake Chat Completions endpoint:
 *
 *   fake Telegram ⇄ shuvi server ⇄ detached runner ⇄ OpenAICompatBackend ⇄ local fake SSE endpoint
 *
 * Covers the production adapter and tool boundary, the model catalog (an endpoint whose key is read from
 * the secrets file), conversation persistence across runner processes, prompt refresh and chat visibility,
 * a switch to another model of the same lane (the conversation goes on), a lost history, /new, /stop, and
 * a runner surviving a server process-group restart. No model service or external API is used.
 *
 *   bun scripts/e2e-openai-compat.ts
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Update } from "grammy/types";
import { switchModel } from "../src/agent/switch.ts";
import { openDb } from "../src/store/db.ts";
import { addModel, addProvider } from "../src/store/models.ts";
import { signalTurn } from "../src/server/spawn.ts";
import { consolePortIn, dmUpdate, FakeTelegram, groupUpdate, OWNER, tapLines, type Person } from "../test/helpers.ts";

const t0 = Date.now();
const log = (m: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
let server: ReturnType<typeof Bun.spawn> | null = null;
let fake: ReturnType<typeof Bun.serve> | null = null;
let cleanupDb: ReturnType<typeof openDb> | null = null;
const tg = new FakeTelegram();
const dataDir = mkdtempSync(join(tmpdir(), "shuvi-e2e-openai-"));
const secretsFile = join(dataDir, "secrets.yaml");
// The endpoint's key, which the catalog names as `fake.API_KEY` and the fake endpoint requires.
writeFileSync(secretsFile, "fake:\n  API_KEY: sk-fake-local\n", { mode: 0o600 });
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

type ChatMessage = { role: string; content?: unknown; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
type ChatRequest = { model: string; messages: ChatMessage[]; tools?: Array<{ function: { name: string } }>; stream?: boolean };
type Reply = { text: string } | { tool: string; args: unknown; before?: string };
const requests: ChatRequest[] = [];
const seenSystems: Record<string, string> = {};
const seenBodies: Record<string, string> = {};
let nextCall = 0;
let restartStarted = false;
const restartGate: { release?: () => void } = {};
let stopStarted = false;
const stopGate: { release?: () => void } = {};

const sse = (chunks: unknown[]): Response => new Response(
  chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n",
  { headers: { "content-type": "text/event-stream" } },
);
const chunk = (delta: unknown, finish: string | null = null, usage?: unknown) => ({
  id: `chatcmpl-${requests.length}`,
  object: "chat.completion.chunk",
  created: 1,
  model: "fake-openai-model",
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...(usage ? { usage } : {}),
});
const textReply = (text: string) => sse([
  chunk({ role: "assistant", content: text.slice(0, Math.max(1, Math.floor(text.length / 2))) }),
  chunk({ content: text.slice(Math.max(1, Math.floor(text.length / 2))) }),
  chunk({}, "stop", { prompt_tokens: 41, completion_tokens: 7, total_tokens: 48 }),
]);
const toolReply = (name: string, args: unknown, before = "") => {
  const id = `call_${++nextCall}`;
  const json = JSON.stringify(args);
  const split = Math.max(1, Math.floor(json.length / 2));
  return sse([
    ...(before ? [chunk({ role: "assistant", content: before })] : []),
    chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: json.slice(0, split) } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: json.slice(split) } }] }),
    chunk({}, "tool_calls", { prompt_tokens: 29, completion_tokens: 10, total_tokens: 39 }),
  ]);
};

function latestUser(body: ChatRequest): string {
  const m = [...body.messages].reverse().find((message) => message.role === "user");
  return JSON.stringify(m?.content ?? "");
}
const SCENARIOS = [
  ["restart", "survive server restart"],
  ["stop", "do something that takes a long time"],
  ["ordered", "please do an ordered tool exchange"],
  ["group-write", "make a non-owner write"],
  ["memory-write", "save the green tea memory"],
  ["memory-read", "what drink did I save"],
  ["group-read", "run the private group check"],
  ["history-follow-up", "history marker follow-up"],
  ["history-first", "history marker first"],
  ["switch", "backend switch check"],
  ["lost", "lost history check"],
] as const;
function currentScenario(input: string): (typeof SCENARIOS)[number][0] | "other" {
  let selected: (typeof SCENARIOS)[number][0] | "other" = "other";
  let latest = -1;
  for (const [name, marker] of SCENARIOS) {
    const position = input.lastIndexOf(marker);
    if (position > latest) {
      latest = position;
      selected = name;
    }
  }
  return selected;
}
function hasCurrentToolResult(body: ChatRequest): boolean {
  return body.messages.at(-1)?.role === "tool";
}
function answer(body: ChatRequest): Reply {
  const input = latestUser(body);
  const scenario = currentScenario(input);
  const all = JSON.stringify(body.messages);
  const system = JSON.stringify(body.messages.find((m) => m.role === "system")?.content ?? "");
  if (scenario === "restart") return { text: "The detached turn finished." };
  if (scenario === "stop") return { text: "must not be sent after stop" };
  if (scenario === "ordered" && !hasCurrentToolResult(body)) {
    return { tool: "shuvi__say", args: { text: "Mid-turn update." }, before: "First message." };
  }
  if (scenario === "ordered" && hasCurrentToolResult(body)) return { text: "Final message." };
  if (scenario === "group-write" && !hasCurrentToolResult(body)) {
    return { tool: "shuvi__write_home", args: { path: "memory/private.md", content: "- Unauthorized write", why: "A group member requested it" } };
  }
  if (scenario === "memory-write" && !hasCurrentToolResult(body)) {
    return { tool: "shuvi__write_home", args: { path: "memory/private.md", content: "- Likes green tea", why: "The owner said they like green tea" } };
  }
  if (scenario === "memory-read") return { text: system.includes("Likes green tea") ? "Green tea." : "No saved drink." };
  if (scenario === "group-read") {
    return { text: system.includes("PRIVATE PERSONA MARKER") ? "Private context leaked." : "Group has public context only." };
  }
  if (scenario === "history-follow-up") {
    return { text: all.includes("history marker first") ? "History resumed." : "History missing." };
  }
  if (scenario === "switch") {
    return { text: all.includes("history marker first") ? "Same conversation on the other model." : "The conversation was lost in the switch." };
  }
  if (scenario === "lost") return { text: "Missing history recovered." };
  if (hasCurrentToolResult(body)) {
    const toolResultText = JSON.stringify(body.messages.at(-1)?.content);
    return { text: toolResultText.includes("write_home") && toolResultText.includes("acts for the owner") ? "Only the owner can change private memory." : "The owner’s memory was saved." };
  }
  return { text: "OpenAI-compatible reply." };
}

fake = Bun.serve({
  port: 0,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    if (req.headers.get("authorization") !== "Bearer sk-fake-local") return new Response("missing fake API key", { status: 401 });
    const body = await req.json() as ChatRequest;
    requests.push(body);
    const input = latestUser(body);
    const scenario = currentScenario(input);
    const key = scenario === "history-first" ? "history" : scenario;
    seenSystems[key] = JSON.stringify(body.messages.find((m) => m.role === "system")?.content ?? "");
    seenBodies[key] = JSON.stringify(body.messages);

    if (scenario === "restart") {
      restartStarted = true;
      await new Promise<void>((resolve) => { restartGate.release = resolve; });
    }
    if (scenario === "stop") {
      stopStarted = true;
      await new Promise<void>((resolve) => { stopGate.release = resolve; });
    }
    const reply = answer(body);
    return "tool" in reply ? toolReply(reply.tool, reply.args, reply.before) : textReply(reply.text);
  },
});

const GROUP = { id: -100778, title: "Compat test" };
const stranger: Person = { id: 2007, first: "Casey", username: "casey_test" };
const home = join(dataDir, "home");
mkdirSync(join(home, "persona"), { recursive: true });
mkdirSync(join(home, "memory"), { recursive: true });
writeFileSync(join(home, "persona/public.md"), "PUBLIC PERSONA MARKER: friendly.");
writeFileSync(join(home, "persona/private.md"), "PRIVATE PERSONA MARKER: never show in a group.");
writeFileSync(join(home, "policy.yaml"), `owner: ${OWNER}
chats:
  dm:
    tools: all
  "${GROUP.id}":
    title: ${GROUP.title}
    trigger: [mention, reply, followup]
    persona: [public]
    memory: [chat]
    tools:
      chat: {}
unknown_chat: ignore
`);
Bun.spawnSync(["git", "-C", home, "init", "-q"]);

const env = {
  PATH: process.env.PATH ?? "",
  HOME: dataDir,
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  LANG: "C.UTF-8",
  XDG_CONFIG_HOME: join(dataDir, "config"),
  XDG_DATA_HOME: join(dataDir, "xdg-data"),
  XDG_CACHE_HOME: join(dataDir, "cache"),
  SHUVI_DATA_DIR: dataDir,
  SHUVI_BOT_TOKEN: "TOKEN",
  SHUVI_OWNER_ID: String(OWNER),
  SHUVI_TELEGRAM_API_ROOT: tg.apiRoot,
  SHUVI_SECRETS_FILE: secretsFile,
  SHUVI_CONSOLE_LISTEN: "127.0.0.1:0",
  SHUVI_CONSOLE_USERS: "owner@example.com",
  SHUVI_TZ: "Asia/Taipei",
  SHUVI_WEB: "off",
};
let consolePort = 0;
let serverOut = "";
const startServer = () => {
  server = Bun.spawn([process.execPath, "src/server/main.ts"], { env, stdout: "pipe", stderr: "pipe", detached: true });
  const proc = server;
  consolePort = 0;
  tapLines(proc.stdout, (line) => {
    serverOut += `${line}\n`;
    consolePort = consolePortIn(line) ?? consolePort;
  });
  const stderr = proc.stderr;
  if (stderr && typeof stderr !== "number") void (async () => {
    const dec = new TextDecoder();
    for await (const chunk of stderr) {
      const line = dec.decode(chunk);
      serverOut += line;
      process.stderr.write(line);
    }
  })();
};
function cleanup() {
  try { if (server) process.kill(-server.pid, "SIGKILL"); } catch {}
  try {
    const pids = cleanupDb?.$client.query("select pid, pid_start from turns where status = 'running' and pid is not null").all() as { pid: number; pid_start: string | null }[] | undefined;
    for (const row of pids ?? []) signalTurn(row.pid, row.pid_start, "SIGKILL");
  } catch {}
  try { restartGate.release?.(); } catch {}
  try { stopGate.release?.(); } catch {}
  tg.stop();
  fake?.stop(true);
}
const texts = (chat = OWNER) => tg.sent().filter((b) => b.chat_id === chat).map((b) => String(b.text));
const db = openDb(join(dataDir, "shuvi.db"), { migrate: true });
cleanupDb = db;
// The catalog the turns run on: the fake endpoint and two of its models, the first the default.
addProvider(db, { name: "fake", kind: "openai-compat", baseUrl: `http://127.0.0.1:${fake.port}/v1`, apiKey: "fake.API_KEY" });
addModel(db, { provider: "fake", model: "fake-openai-model", contextWindow: 32_000 });
addModel(db, { provider: "fake", model: "fake-openai-other-model", contextWindow: 32_000 });
const idle = () => (db.$client.query("select count(*) as n from turns where status = 'running'").get() as { n: number }).n === 0;
let update = 1;
const push = (...updates: Update[]) => tg.updates.push(...updates);

startServer();
await until("server startup", () => serverOut.includes("server listening") || serverOut.includes("control bot on") || consolePort > 0, 30_000);

// 1. Text, say(), and a later tool result cross the production adapter and boundary in order.
push(dmUpdate(update++, "please do an ordered tool exchange"));
await until("ordered text and say output", () => texts().length >= 2);
check(texts().slice(0, 2).join("|") === "First message.|Mid-turn update.", `text block and say() arrive in order (${texts().slice(0, 2).join("|")})`);
await until("ordered turn completion", idle);
await until("final ordered reply", () => texts().includes("Final message."));
check(texts().slice(0, 3).join("|") === "First message.|Mid-turn update.|Final message.", "text, say(), and the post-tool text stay ordered");
check(requests.some((r) => r.stream === true && r.tools?.some((t) => t.function.name === "shuvi__say")), "production OpenAI request streams with shuvi tools declared");

// 2. A group member's owner-only write is refused at the real framework boundary.
push(groupUpdate(update++, GROUP, stranger, "@shuvi_test_bot make a non-owner write"));
await until("group refusal reply", () => texts(GROUP.id).includes("Only the owner can change private memory."));
check(seenSystems["group-write"]?.includes("PUBLIC PERSONA MARKER") && !seenSystems["group-write"]?.includes("PRIVATE PERSONA MARKER"), "group turn receives public persona without private persona");
check(!existsSync(join(home, "memory/private.md")), "the refused write did not mutate private memory");
await until("group write turn completion", idle);

// 3. Separate runner processes resume persistent history; write_home refreshes the next prompt.
push(dmUpdate(update++, "history marker first"));
await until("first history response", () => texts().includes("OpenAI-compatible reply."));
await until("first history turn completion", idle);
const firstHistoryTurn = db.$client.query("select t.pid, t.backend_session_id from turns t join chats c on c.id = t.chat_id where c.tg_chat_id = ? order by t.id desc limit 1").get(OWNER) as { pid: number; backend_session_id: string };
const firstHistorySession = (db.$client.query("select backend_session_id from chats where tg_chat_id = ?").get(OWNER) as { backend_session_id: string }).backend_session_id;
let before = texts().length;
push(dmUpdate(update++, "history marker follow-up"));
await until("resumed history response", () => texts().length > before);
check(texts().at(-1) === "History resumed.", "a later runner process resumes the same OpenAI conversation history");
await until("history turn completion", idle);
const secondHistoryTurn = db.$client.query("select t.pid, t.backend_session_id, t.opening from turns t join chats c on c.id = t.chat_id where c.tg_chat_id = ? order by t.id desc limit 1").get(OWNER) as { pid: number; backend_session_id: string; opening: string };
const secondHistorySession = (db.$client.query("select backend_session_id from chats where tg_chat_id = ?").get(OWNER) as { backend_session_id: string }).backend_session_id;
check(firstHistoryTurn.pid !== secondHistoryTurn.pid, "the turns ran in separate runner processes");
check(firstHistorySession === secondHistorySession && secondHistoryTurn.opening === "resumed", "the later runner resumed the persisted backend session");

before = texts().length;
push(dmUpdate(update++, "save the green tea memory"));
await until("memory write confirmation", () => texts().length > before);
check(texts().at(-1) === "The owner’s memory was saved.", "owner-only write_home commits through the tool boundary");
await until("memory write turn completion", idle);
before = texts().length;
push(dmUpdate(update++, "what drink did I save"));
await until("prompt-refreshed answer", () => texts().length > before);
check(texts().at(-1) === "Green tea.", "fresh system prompt includes the committed memory without /new");
check(seenSystems["memory-read"]?.includes("Likes green tea"), "the new system prompt contains the edited memory");
await until("memory read turn completion", idle);

// Group context remains separate from the owner's DM and its private persona.
before = texts(GROUP.id).length;
push(groupUpdate(update++, GROUP, stranger, "@shuvi_test_bot run the private group check"));
await until("group visibility response", () => texts(GROUP.id).length > before);
check(texts(GROUP.id).at(-1) === "Group has public context only.", "group conversation cannot see owner DM or private persona context");
check(!seenBodies["group-read"]?.includes("history marker first") && !seenBodies["group-read"]?.includes("PRIVATE PERSONA MARKER"), "group request contains neither DM history nor private persona");
await until("group visibility turn completion", idle);

// 4. A switch to another model of the same lane: the conversation goes on, on the other model.
const ownerChat = (db.$client.query("select id, backend_session_id from chats where tg_chat_id = ?").get(OWNER) as { id: number; backend_session_id: string });
check(switchModel(db, ownerChat.id, "fake/fake-openai-other-model", "lossy").mode === "native", "a switch within the OpenAI-compatible lane is native");
before = texts().length;
push(dmUpdate(update++, "backend switch check"));
await until("switched model response", () => texts().length > before);
await until("switched model turn completion", idle);
check(texts().at(-1) === "Same conversation on the other model.", "the other model is sent the conversation so far");
check(requests.at(-1)?.model === "fake-openai-other-model", "the request names the model switched to");
const changedModelTurn = db.$client.query("select opening, backend_session_id from turns order by id desc limit 1").get() as { opening: string; backend_session_id: string };
check(changedModelTurn.opening === "resumed" && changedModelTurn.backend_session_id === ownerChat.backend_session_id, "the turn resumed the same conversation");
check(!seenBodies.switch?.includes("switched"), "nothing tells the model a switch happened");

db.$client.query("delete from conversations where id = ?").run(changedModelTurn.backend_session_id);
before = texts().length;
push(dmUpdate(update++, "lost history check"));
await until("missing history response", () => texts().length > before);
await until("missing history turn completion", idle);
const recoveredTurn = db.$client.query("select opening, backend_session_id from turns order by id desc limit 1").get() as { opening: string; backend_session_id: string };
check(recoveredTurn.opening === "lost" && recoveredTurn.backend_session_id !== changedModelTurn.backend_session_id, "missing durable history restarts the same turn with a new conversation");
check(texts().at(-1) === "Missing history recovered.", "the recovered turn answers once");

// 5. /new clears the backend conversation, and /stop closes a blocked turn without a late reply.
push(dmUpdate(update++, "/new"));
await until("/new reaction", () => tg.sent("setMessageReaction").length >= 1);
check((db.$client.query("select backend_session_id from chats where tg_chat_id = ?").get(OWNER) as { backend_session_id: string | null }).backend_session_id === null, "/new clears the OpenAI conversation id");
before = texts().length;
push(dmUpdate(update++, "do something that takes a long time"));
await until("long request to reach fake endpoint", () => stopStarted);
push(dmUpdate(update++, "/stop"));
await until("/stop reaction", () => tg.sent("setMessageReaction").length >= 2);
await until("stopped turn", () => (db.$client.query("select status from turns order by id desc limit 1").get() as { status: string }).status !== "running", 20_000);
stopGate.release?.();
await Bun.sleep(500);
check((db.$client.query("select status from turns order by id desc limit 1").get() as { status: string }).status === "stopped", "/stop closes the running turn");
check(texts().length === before, "a stopped turn does not deliver a late model response");

// 6. A detached runner finishes its turn while the server's entire process group restarts.
push(dmUpdate(update++, "survive server restart"));
await until("restart request at local fake endpoint", () => restartStarted);
const running = db.$client.query("select id from turns where status = 'running'").get() as { id: number } | null;
check(!!running, "the turn is running before server restart");
const runningId = running!.id;
const oldServer = server!;
process.kill(-oldServer.pid, "SIGTERM");
await oldServer.exited;
server = null;
log("server process group stopped while the detached runner is waiting");
restartGate.release?.();
await until("detached turn completion", () => (db.$client.query("select status from turns where id = ?").get(runningId) as { status: string }).status !== "running", 30_000);
const restartPending = db.$client.query("select count(*) as n from chat_events where turn_id = ? and kind = 'bot_message' and status = 'pending'").get(runningId) as { n: number };
check(restartPending.n === 1, "the detached turn completed with its reply pending while the server was down");
startServer();
await until("restarted server startup", () => consolePort > 0, 30_000);
await until("restarted server delivers queued answer", () => texts().includes("The detached turn finished."), 30_000);
await Bun.sleep(1000);
check(texts().filter((t) => t === "The detached turn finished.").length === 1, "the detached turn finishes and is delivered exactly once after restart");

log("PASS");
cleanup();
process.exit(0);
