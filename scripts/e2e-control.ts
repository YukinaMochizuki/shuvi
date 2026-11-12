#!/usr/bin/env bun
/**
 * The control bot end to end: a real server and real runner children with the real Claude Code CLI,
 * against TWO fake Bot APIs (the assistant's bot and the control bot) and a fake Anthropic API.
 *
 *   1. /status in the control bot answers the owner (and nobody else) with the deployed commit. /policy
 *      lists home/policy.yaml's chats in words, as HTML (a fake group); /policy 2 shows that one in detail.
 *      The main bot's menu is registered for the owner's chat and, for him only, in the listed group; when
 *      policy swaps the group for another, the new one gets the menu and the old one's is cleared.
 *   2. A message whose every turn fails: an alert for the failure, then one saying which message went
 *      unanswered once the retry cap gives up. Nothing of it appears in the assistant's chat.
 *   3. A turn that hangs past the wall-clock limit is stopped, closes as `stopped`, and is alerted.
 *   4. An approval round trip: a card with buttons, the owner presses one, the answer is recorded, the
 *      card is edited, and the chat that asked is woken by it with a turn.
 *   5. A lost Claude session: the chat's conversation id is one Claude Code has never seen. The real CLI
 *      refuses to resume it, and the turn recovers at once as a fresh conversation opening with the last
 *      messages, with no failure attempt used and one alert. This pins the driver's real error text.
 *   6. The console's links: a failed turn's alert links to its page, `/turn <id>` answers a paragraph and
 *      the link, and the page itself opens with the token fallback (a session cookie from /login).
 *
 *   bun scripts/e2e-control.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Update } from "grammy/types";
import { getApproval, requestApproval } from "../src/control/approvals.ts";
import { openDb } from "../src/store/db.ts";
import { WALL_CLOCK_STOP } from "../src/store/turns.ts";
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

// ---- fake Anthropic: "please fail" is refused, "hang" never answers, anything else gets "Noted." ------
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
let approvalPrompt = "";
let freshPrompt = "";
const anthropic = Bun.serve({
  port: 0,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as { messages?: unknown[]; tools?: Array<{ name: string }> }) : {};
    if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 10 });
    if (!url.pathname.endsWith("/v1/messages")) return Response.json({});
    if (!body.tools?.some((t) => t.name === "mcp__shuvi__say")) return reply("ok");
    const all = JSON.stringify(body.messages);
    // Only what is new in the last message: a fresh conversation opens with the chat's earlier messages
    // ("please fail", "hang" among them) before "(New messages:)".
    const last = JSON.stringify(body.messages?.at(-1)).split("(New messages:)").at(-1)!;
    if (last.includes("still there")) freshPrompt = all;
    // "hang" first: a continued conversation may fold the earlier, failed "please fail" into the same
    // user message.
    if (last.includes("hang")) {
      await Bun.sleep(60_000); // only ever cut short by the wall-clock limit
      return reply("must not be sent");
    }
    if (last.includes("please fail")) return Response.json({ type: "error", error: { type: "invalid_request_error", message: "forced failure for the e2e" } }, { status: 400 });
    if (all.includes("Approval #")) approvalPrompt = all;
    return reply("Noted.");
  },
});

// ---- the world ---------------------------------------------------------------------------------------
const tg = new FakeTelegram();
const control = new FakeTelegram();
const dataDir = mkdtempSync(join(tmpdir(), "shuvi-e2e-control-"));
// One fake group, for /policy.
mkdirSync(join(dataDir, "home"), { recursive: true });
writeFileSync(join(dataDir, "home", "policy.yaml"), `chats:\n  "-1009999999999":\n    title: Fake Hiking Club\n    tools: { web: {}, stickers: {} }\n`);
// The console binds any free port (0); the server's log says which (`tapLines`).
let consolePort = 0;
const CONSOLE_URL = "https://example-host.example-tailnet.ts.net";
const env = {
  ...process.env,
  SHUVI_DATA_DIR: dataDir,
  SHUVI_BOT_TOKEN: "TOKEN",
  SHUVI_CONTROL_BOT_TOKEN: "CONTROL",
  SHUVI_OWNER_ID: String(OWNER),
  SHUVI_TELEGRAM_API_ROOT: tg.apiRoot,
  SHUVI_CONTROL_API_ROOT: control.apiRoot,
  SHUVI_COMMIT: "e2e1234",
  SHUVI_TURN_MAX_MINUTES: "0.15", // 9 s
  SHUVI_BACKEND: "claude",
  SHUVI_MODEL: "claude-sonnet-4-5",
  SHUVI_TZ: "Asia/Taipei",
  SHUVI_CONSOLE_LISTEN: "127.0.0.1:0",
  SHUVI_CONSOLE_TOKEN: "example-console-token",
  SHUVI_CONSOLE_URL: CONSOLE_URL,
  ANTHROPIC_BASE_URL: `http://localhost:${anthropic.port}`,
  ANTHROPIC_API_KEY: "sk-ant-fake",
};
const server = Bun.spawn([process.execPath, "src/server/main.ts"], { env, stdout: "pipe", stderr: "inherit", detached: true });
tapLines(server.stdout, (line) => (consolePort = consolePortIn(line) ?? consolePort));
function cleanup() {
  try {
    process.kill(-server.pid, "SIGKILL");
  } catch {}
  tg.stop();
  control.stop();
  anthropic.stop(true);
}
const controlTexts = () => control.sent().map((b) => String(b.text));
const chatTexts = () => tg.sent().map((b) => String(b.text));
const db = openDb(join(dataDir, "shuvi.db"));
await until("the server to migrate the store", () => {
  try {
    return !!db.$client.query("select 1 from control_messages limit 1").all();
  } catch {
    return false;
  }
});

// ---- 1. /status, owner only -------------------------------------------------------------------------
control.updates.push(dmUpdate(1, "/status", 777), dmUpdate(2, "/status"));
await until("the /status reply", () => controlTexts().length >= 1);
await Bun.sleep(500);
check(controlTexts().length === 1, "only the owner gets an answer");
check(controlTexts()[0]!.startsWith("shuvi, commit e2e1234") && controlTexts()[0]!.includes("Running turns: 0") && controlTexts()[0]!.includes("Outbound pending: 0"), `/status lists turns, outbound and the commit (${JSON.stringify(controlTexts()[0])})`);
const menu = (bot: FakeTelegram) => bot.sent("setMyCommands").map((b) => `${JSON.stringify(b.scope)} ${(b.commands as { command: string }[]).map((c) => c.command).join(",")}`);
const ownerScope = JSON.stringify({ type: "chat", chat_id: OWNER });
const groupScope = (g: number) => JSON.stringify({ type: "chat_member", chat_id: g, user_id: OWNER });
await until("the group menu", () => menu(tg).length >= 2);
check(
  [...menu(tg)].sort().join("|") === [`${ownerScope} new,stop`, `${groupScope(-1009999999999)} new,stop`].sort().join("|") && menu(control).join("|") === `${ownerScope} status,stop,policy,turn`,
  `each bot registered its commands for the owner's chat, and the main bot for the owner in the listed group (${menu(tg)} / ${menu(control)})`,
);

// ---- 1b. /policy -------------------------------------------------------------------------------------
control.updates.push(dmUpdate(3, "/policy"), dmUpdate(4, "/policy 2"));
await until("the /policy replies", () => control.sent().filter((b) => b.parse_mode === "HTML").length >= 2);
const [overview, detail] = control.sent().filter((b) => b.parse_mode === "HTML").map((b) => String(b.text));
check(
  overview!.includes("<b>1. Your DM</b>") && overview!.includes("<b>2. Fake Hiking Club</b>  <i>-1009999999999</i>") && overview!.includes("• web lookups\n• stickers") && overview!.includes("<b>Unknown groups:</b>") && !overview!.includes("tools:"),
  `/policy lists the DM and the group in words, as HTML (${JSON.stringify(overview)})`,
);
check(detail!.includes("<b>2. Fake Hiking Club</b>") && detail!.includes("<b>Off:</b>") && detail!.includes("• schedules (owner only)"), `/policy 2 shows the group with what is off (${JSON.stringify(detail)})`);

// ---- 1c. the group menu follows policy ----------------------------------------------------------------
writeFileSync(join(dataDir, "home", "policy.yaml"), `chats:\n  "-1008888888888":\n    title: Fake Chess Club\n`);
await until("the group menus to follow the policy change", () => menu(tg).length >= 3 && tg.sent("deleteMyCommands").length >= 1);
await Bun.sleep(1500); // a few more policy passes: nothing changed, so no more calls
check(menu(tg).length === 3 && menu(tg)[2] === `${groupScope(-1008888888888)} new,stop`, `a group added to policy gets the owner's menu (${menu(tg)})`);
check(tg.sent("deleteMyCommands").map((b) => JSON.stringify(b.scope)).join("|") === groupScope(-1009999999999), `a group removed from policy has its menu cleared (${JSON.stringify(tg.sent("deleteMyCommands"))})`);

// ---- 2. a forced failure, retried to the cap ---------------------------------------------------------
tg.updates.push(dmUpdate(1, "please fail"));
await until("the failure alert", () => controlTexts().some((t) => t.includes("failed in chat")));
check(controlTexts().some((t) => /^Turn \d+ failed in chat 1 \(tg 1001\): .*It will be retried\.\nhttps:\/\/example-host\.example-tailnet\.ts\.net\/turns\/\d+$/s.test(t)), "a failed turn is alerted, with its console link");
await until("the retry cap to give up", () => controlTexts().some((t) => t.startsWith("Unanswered")), 60_000);
const gaveUp = controlTexts().find((t) => t.startsWith("Unanswered"))!;
check(gaveUp.includes('"please fail" (#1)') && gaveUp.includes("3 turns failed on it"), `the alert says which message went unanswered (${JSON.stringify(gaveUp)})`);
check(controlTexts().filter((t) => t.includes("It will be retried")).length === 1, "repeats of the failure alert are rate-limited");
check(chatTexts().length === 0, "and nothing was said in the assistant's chat");

// ---- 3. the wall-clock limit -------------------------------------------------------------------------
tg.updates.push(dmUpdate(2, "hang"));
await until("the hanging turn to start", () => (db.$client.query("select count(*) as n from turns where status = 'running' and pid is not null").get() as { n: number }).n === 1, 40_000);
control.updates.push(dmUpdate(5, "/status"));
await until("the second /status reply", () => controlTexts().filter((t) => t.startsWith("shuvi, commit")).length >= 2);
const status = controlTexts().filter((t) => t.startsWith("shuvi, commit")).at(-1)!;
check(/Running turns: 1\n- chat 1 \(tg 1001\): turn 4, running \d+s, pid \d+/.test(status) && status.includes("Failed turns, last 24h: 3") && status.includes("API Error: 400"), `/status shows the running turn and the recent failures (${JSON.stringify(status)})`);
await until("the wall-clock alert", () => controlTexts().some((t) => t.includes("wall-clock limit") && t.includes("is being stopped")), 40_000);
await until("the hung turn to close", () => (db.$client.query("select status from turns order by id desc limit 1").get() as { status: string }).status !== "running", 30_000);
const hung = db.$client.query("select status, term_at, error from turns order by id desc limit 1").get() as { status: string; term_at: string | null; error: string | null };
check(hung.status === "stopped" && !!hung.term_at && hung.error === WALL_CLOCK_STOP, `the hung turn closed as stopped, with the limit as its reason (${hung.error})`);
const cursor = db.$client.query("select cursor_seq from chats").get() as { cursor_seq: number };
const hangSeq = db.$client.query("select seq from chat_events where tg_update_id = 2").get() as { seq: number };
check(cursor.cursor_seq === hangSeq.seq, "and its message is not retried");

// ---- 4. an approval round trip -----------------------------------------------------------------------
const chatId = (db.$client.query("select id from chats").get() as { id: number }).id;
const id = requestApproval(db, { kind: "throwaway", title: "Allow the e2e?", body: "A throwaway approval.", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }], originChatId: chatId });
await until("the approval card", () => controlTexts().some((t) => t.includes("Allow the e2e?")));
const card = control.calls.find((c) => c.method === "sendMessage" && String(c.body.text).includes("Allow the e2e?"))!.body;
const keyboard = (card.reply_markup as { inline_keyboard: { callback_data: string; text: string }[][] }).inline_keyboard;
check(keyboard.map((r) => r[0]!.text).join("|") === "Yes|No", "the card carries one button per option");
control.updates.push({ update_id: 6, callback_query: { id: "cq1", from: { id: OWNER, is_bot: false, first_name: "Owner" }, chat_instance: "x", data: keyboard[0]![0]!.callback_data } } as unknown as Update);
await until("the answer to be recorded", () => getApproval(db, id)!.status !== "pending");
check(getApproval(db, id)!.answer === "yes", "the owner's press is recorded");
await until("the card to be edited", () => control.sent("editMessageText").length >= 1);
check(String(control.sent("editMessageText")[0]!.text).includes("→ Answered: Yes"), "the card shows the answer");
check(control.sent("answerCallbackQuery").length === 1, "the button press is acknowledged");
await until("the woken chat's turn to answer", () => chatTexts().includes("Noted."), 30_000);
check(approvalPrompt.includes(`Approval #${id} (throwaway)`) && approvalPrompt.includes('the owner answered \\"Yes\\"'), "the chat that asked was woken by the answer");

// ---- 5. a lost Claude session --------------------------------------------------------------------------
const failedBefore = (db.$client.query("select count(*) as n from turns where status = 'failed'").get() as { n: number }).n;
const turnsBefore = (db.$client.query("select count(*) as n from turns").get() as { n: number }).n;
const unknown = crypto.randomUUID();
db.$client.query("update chats set backend_session_id = ? where id = ?").run(unknown, chatId);
tg.updates.push(dmUpdate(3, "are you still there"));
await until("the recovered turn's answer", () => chatTexts().filter((t) => t === "Noted.").length >= 2, 30_000);
await until("the recovered turn to close", () => (db.$client.query("select status from turns order by id desc limit 1").get() as { status: string }).status !== "running", 15_000);
const recovered = db.$client.query("select status from turns where id > ?").all(turnsBefore) as { status: string }[];
check(recovered.length === 1 && recovered[0]!.status === "done", "one turn, done: the same turn recovered");
const opened = db.$client.query("select opening, backend_session_id as sid from turns order by id desc limit 1").get() as { opening: string; sid: string | null };
check(opened.opening === "lost" && !!opened.sid && opened.sid !== unknown, `and it records that its conversation was restarted, with the new session id (${opened.opening})`);
check((db.$client.query("select count(*) as n from turns where status = 'failed'").get() as { n: number }).n === failedBefore, "no failure attempt was used");
const session = (db.$client.query("select backend_session_id from chats where id = ?").get(chatId) as { backend_session_id: string }).backend_session_id;
check(!!session && session !== unknown, "the chat has a fresh conversation");
check(freshPrompt.includes("(A new conversation.") && freshPrompt.includes("hang"), "which opened with the chat's last messages");
await until("the lost-session alert", () => controlTexts().some((t) => t.includes("was lost")));
check(controlTexts().filter((t) => t.includes(`was lost (${unknown})`)).length === 1, "and one alert says the conversation was lost");

// ---- 6. the console's links, and the token fallback ------------------------------------------------------
const failedTurn = db.$client.query("select id, error from turns where status = 'failed' order by id limit 1").get() as { id: number; error: string };
const lastFailed = (db.$client.query("select max(id) as id from turns where status = 'failed'").get() as { id: number }).id;
check(controlTexts().some((t) => t.startsWith("Unanswered") && t.endsWith(`/turns/${lastFailed}`)), "the given-up alert links to the turn that gave up");
control.updates.push(dmUpdate(7, `/turn ${failedTurn.id}`));
await until("the /turn reply", () => controlTexts().some((t) => t.startsWith(`Turn ${failedTurn.id} in`)));
const summary = controlTexts().find((t) => t.startsWith(`Turn ${failedTurn.id} in`))!;
check(summary.includes(": failed after") && summary.endsWith(`\n${CONSOLE_URL}/turns/${failedTurn.id}`), `/turn answers a paragraph and the link (${JSON.stringify(summary)})`);
await until("the console to be listening", () => consolePort > 0);
const consoleBase = `http://127.0.0.1:${consolePort}`;
check((await fetch(`${consoleBase}/turns/${failedTurn.id}`)).status === 401, "the console wants the token");
const login = await fetch(`${consoleBase}/login`, { method: "POST", body: new URLSearchParams({ token: "example-console-token" }), redirect: "manual" });
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
check(login.status === 303 && cookie.startsWith("shuvi_console="), "the token buys a session cookie");
const failedPage = await fetch(`${consoleBase}/turns/${failedTurn.id}`, { headers: { cookie } });
const failedHtml = await failedPage.text();
check(failedPage.status === 200 && failedHtml.includes("Why it ended that way") && failedHtml.includes("System prompt"), "and with it the failed turn's page opens, saying why it failed");

log("PASS");
cleanup();
process.exit(0);
