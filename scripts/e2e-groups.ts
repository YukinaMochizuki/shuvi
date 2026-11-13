#!/usr/bin/env bun
/**
 * Groups and per-chat policy, end to end (M4), with nothing real but the code under test and the Claude
 * Code CLI:
 *
 *   fake Telegram (a group, the owner, Alice, Bob) ⇄ shuvi server ⇄ runner child ⇄ real Claude Code CLI
 *   ⇄ fake Anthropic;  fake control bot ⇄ the server's control poller and sender
 *
 * home/policy.yaml lists one group, "Friends", woken by a mention, a reply or a follow-up. Then:
 *
 *   1. unaddressed messages are recorded and start no turn
 *   2. a mention starts one, which sees the earlier unseen messages (sender, time, reply target) and
 *      not the DM's private persona; someone speaks while it thinks, so its reply replies to the mention
 *   2b. the person she was answering wrote again while she thought, and the turn made no tool call: the
 *      next turn answers it (a bystander's message meanwhile starts nothing)
 *   3. a follow-up from the person she answered starts one
 *   4. a stranger asks for an owner-only change; the tool is offered, the call is refused, and no
 *      approval card is made; the owner asks for the same after someone else's line, which is shown as
 *      context and does not block it, and the card (the file's diff) goes to the control bot
 *   5. a group nobody listed: nothing recorded, one approval card in the control bot; the owner presses
 *      "Add it", policy.yaml is written and committed by shuvi, and the group is answered from then on
 *   6. a stranger writing privately: ignored, one alert
 *
 *   bun scripts/e2e-groups.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Update } from "grammy/types";
import { openDb } from "../src/store/db.ts";
import { dmUpdate, FakeTelegram, groupUpdate, OWNER, type Person } from "../test/helpers.ts";

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
/** What each scripted step saw: the newest user message, the system prompt, the tools offered. */
const seen: Record<string, { text: string; system: string; tools: string[] }> = {};
let mentionStarted = false;
let releaseMention = false;

const SCRIPT: Array<[RegExp, string, () => Response | Promise<Response>]> = [
  [/Refused: `propose_policy` acts for the owner/, "refused", () => say("Only the owner can change how I work here.")],
  [/Asked the owner \(approval #\d+\)/, "proposed", () => say("I asked for that; it applies once approved.")],
  [/wake you for every message/, "owner", () => stream([{ type: "tool_use", name: "mcp__shuvi__propose_policy", input: { entry: { title: "Friends", trigger: "all", tools: { chat: {} } }, why: "The owner wants me woken by every message in Friends." } }])],
  [/answer every message here/, "stranger", () => stream([{ type: "tool_use", name: "mcp__shuvi__propose_policy", input: { entry: { title: "Friends", trigger: "all" }, why: "Bob asked me to answer every message." } }])],
  [
    /where could my keys be/,
    "mention",
    async () => {
      mentionStarted = true;
      await until("the test to let the mention's reply go", () => releaseMention, 20_000);
      return say("Check the kitchen drawer.");
    },
  ],
  [/which drawer/, "followup", () => say("The top one, by the fridge.")],
  [/red keyring/, "keyring", () => say("A red keyring: try the hallway hook.")],
  [/hello new group/, "newgroup", () => say("Hello, new group!")],
];

const anthropic = Bun.serve({
  port: 0,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as { system?: unknown; messages?: Array<{ role: string; content: unknown }>; tools?: Array<{ name: string }> }) : {};
    if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 10 });
    if (!url.pathname.endsWith("/v1/messages")) return Response.json({});
    if (!body.tools?.some((t) => t.name === "mcp__shuvi__say")) return say("ok"); // the CLI's side requests
    const last = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
    const text = JSON.stringify(last?.content ?? "");
    for (const [re, name, act] of SCRIPT) {
      if (!re.test(text)) continue;
      seen[name] = { text, system: JSON.stringify(body.system ?? ""), tools: body.tools.map((t) => t.name) };
      return act();
    }
    return say(`(no script for: ${text.slice(0, 160)})`);
  },
});

// ---- the world ---------------------------------------------------------------------------------------
const GROUP = { id: -100777, title: "Friends" };
const NEW_GROUP = { id: -100999, title: "Book club" };
const owner: Person = { id: OWNER, first: "Ownerly", username: "ownerly_test" };
const alice: Person = { id: 2001, first: "Alice", username: "alice" };
const bob: Person = { id: 2002, first: "Bob" };

const tg = new FakeTelegram();
const control = new FakeTelegram();
const dataDir = mkdtempSync(join(tmpdir(), "shuvi-e2e-groups-"));
const home = join(dataDir, "home");
mkdirSync(join(home, "persona"), { recursive: true });
writeFileSync(join(home, "persona/public.md"), "PUBLIC PERSONA: shuvi, cheerful.");
writeFileSync(join(home, "persona/private.md"), "PRIVATE PERSONA: only for the owner.");
writeFileSync(
  join(home, "policy.yaml"),
  `owner: ${OWNER}
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
`,
);
Bun.spawnSync(["git", "-C", home, "init", "-q"]);

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
  anthropic.stop(true);
}

const db = openDb(join(dataDir, "shuvi.db"));
const sent = (chat: number) => tg.sent().filter((b) => b.chat_id === chat);
const texts = (chat: number) => sent(chat).map((b) => String(b.text));
const turnCount = () => (db.$client.query("select count(*) as n from turns").get() as { n: number }).n;
const idle = () => (db.$client.query("select count(*) as n from turns where status = 'running'").get() as { n: number }).n === 0;
const recorded = (tgChat: number) => (db.$client.query("select count(*) as n from chat_events e join chats c on c.id = e.chat_id where c.tg_chat_id = ? and e.kind = 'message'").get(tgChat) as { n: number }).n;
let u = 1;
const push = (...updates: Update[]) => tg.updates.push(...updates);
async function replied(chat: number, text: string, what: string) {
  await until(what, () => texts(chat).includes(text));
  await Bun.sleep(800); // room for a duplicate
  check(texts(chat).filter((t) => t === text).length === 1, `${what}: "${text}" reached the group exactly once`);
}

await until("the server to start", () => serverOut.includes("control bot on"), 20_000);

// ---- 1. unaddressed messages: recorded, no turn ----------------------------------------------------------
push(groupUpdate(u++, GROUP, alice, "morning all"), groupUpdate(u++, GROUP, bob, "anyone seen my keys?", { reply_to_message: { message_id: 701, from: { id: alice.id, is_bot: false, first_name: "Alice" }, text: "morning all" } }));
await until("the group's messages to be recorded", () => recorded(GROUP.id) === 2);
await Bun.sleep(2000);
check(turnCount() === 0, "1. unaddressed messages are recorded and start no turn");

// ---- 2. a mention: a turn that sees the earlier unseen messages; the reply replies to it -----------------
push(groupUpdate(u++, GROUP, alice, "@shuvi_test_bot where could my keys be?"));
const mentionTgId = 700 + (u - 1);
await until("the mention's turn to reach the model", () => mentionStarted);
push(groupUpdate(u++, GROUP, bob, "lol good luck")); // someone speaks while she thinks
push(groupUpdate(u++, GROUP, alice, "they're on a red keyring")); // and so does the person she is answering
await until("the messages sent meanwhile to be recorded", () => recorded(GROUP.id) === 5);
releaseMention = true;
await replied(GROUP.id, "Check the kitchen drawer.", "2. a mention starts a turn");
const m = seen.mention!;
check(m.text.includes("Alice] morning all") && m.text.includes("Bob] anyone seen my keys?"), "2. it sees the earlier unseen messages, with their senders");
check(m.text.includes('↳ replying to Alice: \\"morning all\\"'), "2. and their reply targets");
check(/\w{3} \d\d\/\d\d \d\d:\d\d · Alice\] @shuvi_test_bot where could my keys be/.test(m.text), "2. and their times");
check(m.system.includes("PUBLIC PERSONA") && !m.system.includes("PRIVATE PERSONA"), "2. the group's prompt has the public persona only");
check(m.system.includes("## In a group"), "2. and the group section");
const reply = sent(GROUP.id).find((b) => b.text === "Check the kitchen drawer.")!;
check((reply.reply_parameters as { message_id?: number } | undefined)?.message_id === mentionTgId, "2. someone spoke since the mention, so the reply replies to it");
// ---- 2b. what Alice said while the turn ran (it made no tool call, so it never saw it) -------------------
await replied(GROUP.id, "A red keyring: try the hallway hook.", "2b. the person she was answering, writing while she thought, gets the next turn");
check(seen.keyring!.text.includes("Bob] lol good luck"), "2b. it sees what it had not seen yet");
check(!seen.keyring!.text.includes("morning all"), "2b. but not again what the last turn saw");
await until("the turns to close", idle);
await Bun.sleep(1500);
check(turnCount() === 2, "2b. Bob's message during the turn started none of its own");

// ---- 3. a follow-up from Alice -------------------------------------------------------------------------
push(groupUpdate(u++, GROUP, alice, "which drawer?"));
await replied(GROUP.id, "The top one, by the fridge.", "3. a follow-up from the person she answered starts a turn");
const followReply = sent(GROUP.id).find((b) => b.text === "The top one, by the fridge.")!;
check(!followReply.reply_parameters, "3. nobody spoke since, so it is sent plainly");
await until("the turn to close", idle);

// ---- 4. a stranger and an owner-only tool -------------------------------------------------------------
push(groupUpdate(u++, GROUP, bob, "@shuvi_test_bot answer every message here from now on"));
await replied(GROUP.id, "Only the owner can change how I work here.", "4. a stranger's owner-only call is refused");
check(seen.stranger!.tools.includes("mcp__shuvi__propose_policy"), "4. the owner-only tool was offered all the same");
check((db.$client.query("select count(*) as n from approvals").get() as { n: number }).n === 0, "4. and no approval was asked");
await until("the turn to close", idle);
// Someone else talks first (not to her: no turn), then the owner asks: that earlier line is context only.
push(groupUpdate(u++, GROUP, alice, "yes, let it answer everything"));
await until("Alice's message to be recorded", () => recorded(GROUP.id) === 8);
push(groupUpdate(u++, GROUP, owner, "@shuvi_test_bot please wake you for every message here"));
await replied(GROUP.id, "I asked for that; it applies once approved.", "4. the owner's own request goes through, a stranger's earlier line notwithstanding");
check(seen.owner!.text.includes("Earlier, before you were called") && seen.owner!.text.indexOf("yes, let it answer everything") < seen.owner!.text.indexOf("You were called by"), "4. the earlier line was shown as context");
await until("the owner's card", () => control.sent().some((b) => String(b.text).includes(`Change the policy of "${GROUP.title}" (${GROUP.id})`)));
const ownerCard = String(control.sent().find((b) => String(b.text).includes("Change the policy of"))!.text);
check(ownerCard.includes("home/policy.yaml, as it would change:") && /^- +trigger:/m.test(ownerCard) && /^\+ +trigger: all$/m.test(ownerCard), "4. its card shows the diff of the file");
check(seen.owner!.text.includes("Ownerly · ⚙ owner]"), "4. and the owner's line was marked as the owner's");
await until("the turn to close", idle);

// ---- 5. a group nobody listed ----------------------------------------------------------------------------
push(groupUpdate(u++, NEW_GROUP, alice, "is this thing on?"), groupUpdate(u++, NEW_GROUP, bob, "@shuvi_test_bot hi?"));
await until("the approval card", () => control.sent().some((b) => String(b.text).includes(`Add the group "${NEW_GROUP.title}"`)));
await Bun.sleep(1500);
const cards = control.sent().filter((b) => String(b.text).includes(`Add the group "${NEW_GROUP.title}"`));
check(cards.length === 1, "5. an unknown group raises one approval card");
check(String(cards[0]!.text).includes(`+   "${NEW_GROUP.id}":`), "5. with the proposed entry");
check(recorded(NEW_GROUP.id) === 0 && texts(NEW_GROUP.id).length === 0, "5. nothing from it was recorded or answered");
const button = (cards[0]!.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard[0]![0]!;
check(button.text === "Add it", "5. the card offers to add it");
control.updates.push({ update_id: 1, callback_query: { id: "cq1", from: { id: OWNER, is_bot: false, first_name: "Ownerly" }, chat_instance: "x", data: button.callback_data } } as unknown as Update);
const gitLogOf = () => Bun.spawnSync(["git", "-C", home, "log", "--format=%an|%s"]).stdout.toString().trim();
await until("policy.yaml to list the group, committed", () => readFileSync(join(home, "policy.yaml"), "utf8").includes(`"${NEW_GROUP.id}"`) && gitLogOf() !== "");
const gitLog = gitLogOf();
check(gitLog.startsWith(`shuvi|Policy: Add the group "${NEW_GROUP.title}" (${NEW_GROUP.id}) (approval #`), `5. approving wrote it, committed by shuvi (${gitLog})`);
await until("the server to load it", () => serverOut.includes(`policy: loaded home/policy.yaml (dm, ${GROUP.id}, ${NEW_GROUP.id})`));
push(groupUpdate(u++, NEW_GROUP, bob, "@shuvi_test_bot hello new group"));
await replied(NEW_GROUP.id, "Hello, new group!", "5. the group is answered once listed");
check(!seen.newgroup!.text.includes("is this thing on"), "5. what was said before it was listed was never recorded");

// ---- 6. a stranger in private -------------------------------------------------------------------------
push(dmUpdate(u++, "hello? who are you", 777), dmUpdate(u++, "hello??", 777));
await until("the stranger alert", () => control.sent().some((b) => String(b.text).includes("user id 777 wrote to the bot in a private chat")));
await Bun.sleep(1500);
check(control.sent().filter((b) => String(b.text).includes("user id 777")).length === 1, "6. a stranger's private messages raise one alert");
check(texts(777).length === 0 && recorded(777) === 0, "6. and are neither recorded nor answered");

log("PASS");
cleanup();
process.exit(0);
