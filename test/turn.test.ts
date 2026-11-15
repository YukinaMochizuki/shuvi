import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt } from "../src/agent/prompt.ts";
import { LostSessionError, type AdapterRunOptions, type AdapterRunResult, type ToolBoundary } from "agent-runtime";
import { RETRY_NOTE } from "../src/agent/render.ts";
import { GAP_NOTE_MINUTES, isLostSession, isRetryAfterDrain, runTurn } from "../src/agent/turn.ts";
import { controlMessagesOf } from "../src/store/control.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import type { Db } from "../src/store/db.ts";
import { enqueueOutbound, forgetConversations, getChat, pendingOutbound, type BotMessagePayload, type BotReactionPayload } from "../src/store/events.ts";
import { claimTurn, DRAIN_STOP, finishTurn, getTurn, markDrainStop, markStop, saveSession } from "../src/store/turns.ts";
import { modelSwitches } from "../src/store/schema.ts";
import { startClean } from "../src/agent/switch.ts";
import { addModel, addProvider } from "../src/store/models.ts";
import { lastSeq, memDb, ownerChatId, ownerSays, ScriptedAdapter, type Step } from "./helpers.ts";

const emptyHome = mkdtempSync(join(tmpdir(), "shuvi-home-"));

async function turnWith(db: Db, script: Step[], opts: { home?: string; signal?: AbortSignal; web?: { tavilyApiKey?: string }; startedAt?: string; retrieval?: boolean } = {}) {
  const turn = claimTurn(db, ownerChatId(db))!;
  if (opts.startedAt) db.$client.run("update turns set started_at = ? where id = ?", [opts.startedAt, turn.id]);
  let adapter!: ScriptedAdapter;
  const outcome = await runTurn({
    db,
    turnId: turn.id,
    home: opts.home ?? emptyHome,
    timeZone: "UTC",
    makeAdapter: (b) => (adapter = new ScriptedAdapter(b, script)),
    ...(opts.signal ? { signal: opts.signal } : {}),
    // The web capability is on when the test asks for it, off otherwise, through its own variables.
    // Schedules, memory, retrieval and playbooks are off here: these tests are about speech and web (retrieval: on
    // when asked for, for a clean conversation's).
    capabilities: enabledCapabilities(
      opts.web
        ? { SHUVI_STICKERS: "off", SHUVI_SCHEDULES: "off", SHUVI_MEMORY: "off", SHUVI_RETRIEVAL: "off", SHUVI_PLAYBOOKS: "off", SHUVI_GROUPS: "off", ...(opts.web.tavilyApiKey ? { SHUVI_TAVILY_API_KEY: opts.web.tavilyApiKey } : {}) }
        : { SHUVI_WEB: "off", SHUVI_STICKERS: "off", SHUVI_SCHEDULES: "off", SHUVI_MEMORY: "off", SHUVI_RETRIEVAL: opts.retrieval ? "on" : "off", SHUVI_PLAYBOOKS: "off", SHUVI_GROUPS: "off" },
    ),
  });
  return { outcome, adapter, turn: getTurn(db, turn.id)! };
}

const messages = (db: Db) => pendingOutbound(db).filter((e) => e.kind === "bot_message").map((e) => (e.payload as unknown as BotMessagePayload).text);

describe("runTurn: how output becomes messages", () => {
  test("each stretch of reply text between tool calls is one message, in order; thinking is never sent", async () => {
    const db = memDb();
    ownerSays(db, "Can you look this up");
    await turnWith(db, [
      { token: "internal reasoning...", thinking: true },
      { token: "OK, " },
      { token: "let me look" },
      { tool: "say", args: { text: "Halfway there, here is the gist so far" } },
      { token: "thinking how to put it", thinking: true },
      { token: "All done." },
    ]);
    expect(messages(db)).toEqual(["OK, let me look", "Halfway there, here is the gist so far", "All done."]);
  });

  test("idempotency keys number the turn's messages in order", async () => {
    const db = memDb();
    ownerSays(db, "hi");
    const { turn } = await turnWith(db, [{ token: "a" }, { tool: "say", args: { text: "b" } }, { token: "c" }]);
    expect(pendingOutbound(db).map((e) => e.idemKey)).toEqual([`turn:${turn.id}:0`, `turn:${turn.id}:1`, `turn:${turn.id}:2`]);
  });

  test("pass: nothing written after it is sent, and later tool calls are refused", async () => {
    const db = memDb();
    ownerSays(db, "(hug)");
    const { adapter } = await turnWith(db, [{ tool: "pass", args: { reaction: "❤️" } }, { tool: "say", args: { text: "must not be sent" } }, { token: "must not be sent either" }]);
    expect(messages(db)).toEqual([]);
    const reactions = pendingOutbound(db).filter((e) => e.kind === "bot_reaction");
    expect(reactions.map((e) => (e.payload as unknown as BotReactionPayload).emoji)).toEqual(["❤"]);
    expect(adapter.toolResults[1]!.result.isError).toBe(true);
  });

  test("a message that arrives during `pass` is not taken by the passing turn; the next turn answers it", async () => {
    const db = memDb();
    const first = ownerSays(db, "mhm");
    const { adapter } = await turnWith(db, [{ run: () => ownerSays(db, "Oh, and what time tomorrow?") }, { tool: "pass" }, { token: "Nine tomorrow" }]);
    const passResult = adapter.toolResults[0]!.result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(passResult).not.toContain("what time tomorrow");
    expect(getChat(db, ownerChatId(db))!.cursorSeq).toBe(first);
    expect(claimTurn(db, ownerChatId(db))).not.toBeNull();
  });

  test("two text blocks separated by thinking, with no tool call between, are two messages", async () => {
    const db = memDb();
    ownerSays(db, "a question");
    await turnWith(db, [{ token: "First, the conclusion." }, { token: "let me think", thinking: true }, { token: "Then, a detail." }]);
    expect(messages(db)).toEqual(["First, the conclusion.", "Then, a detail."]);
  });

  test("a turn of only a reaction is a complete answer", async () => {
    const db = memDb();
    const seq = ownerSays(db, "sounds good");
    const { outcome } = await turnWith(db, [{ tool: "react", args: { seq, emoji: "👍" } }]);
    expect(outcome).toBe("done");
    expect(messages(db)).toEqual([]);
    expect(pendingOutbound(db).map((e) => e.kind)).toEqual(["bot_reaction"]);
  });

  test("react refuses an emoji Telegram does not accept, and a seq outside the chat", async () => {
    const db = memDb();
    const seq = ownerSays(db, "x");
    const { adapter } = await turnWith(db, [{ tool: "react", args: { seq, emoji: "🦖" } }, { tool: "react", args: { seq: 9999, emoji: "👍" } }]);
    expect(adapter.toolResults.map((r) => r.result.isError)).toEqual([true, true]);
    expect(pendingOutbound(db)).toEqual([]);
  });

  test("react refuses her own message, and still reacts to theirs", async () => {
    const db = memDb();
    ownerSays(db, "before");
    enqueueOutbound(db, { chatId: ownerChatId(db), kind: "bot_message", payload: { text: "an earlier answer" }, idemKey: "earlier" });
    const mine = lastSeq(db);
    db.$client.exec("update chat_events set status = 'sent' where kind = 'bot_message'");
    const theirs = ownerSays(db, "nice");
    const { adapter } = await turnWith(db, [{ tool: "react", args: { seq: mine, emoji: "👍" } }, { tool: "react", args: { seq: theirs, emoji: "👍" } }]);
    expect(adapter.toolResults.map((r) => !!r.result.isError)).toEqual([true, false]);
    expect(JSON.stringify(adapter.toolResults[0]!.result)).toContain("your own message");
    expect(pendingOutbound(db).map((e) => [e.kind, (e.payload as unknown as BotReactionPayload).targetSeq])).toEqual([["bot_reaction", theirs]]);
  });
});

describe("capabilities", () => {
  test("with the web capability the turn gets the shared web tools and is told when to use them", async () => {
    const db = memDb();
    ownerSays(db, "what happened today?");
    const { adapter } = await turnWith(db, [{ token: "ok" }], { web: { tavilyApiKey: "tvly-test" } });
    expect(adapter.calls[0]!.tools).toEqual(["say", "react", "pass", "web_search", "web_fetch"]);
    expect(adapter.calls[0]!.systemPrompt).toContain("## Looking things up");
  });

  test("without it there is no web tool, and the prompt does not mention one", async () => {
    const db = memDb();
    ownerSays(db, "hi");
    const { adapter } = await turnWith(db, [{ token: "ok" }]);
    expect(adapter.calls[0]!.tools).toEqual(["say", "react", "pass"]);
    expect(adapter.calls[0]!.systemPrompt ?? "").not.toContain("Looking things up");
  });
});

describe("system prompt", () => {
  test("the owner's language, when configured, is named in the owner's DM", () => {
    const db = memDb();
    const chat = getChat(db, ownerChatId(db))!;
    expect(buildSystemPrompt(emptyHome, chat, { name: "Owner", language: "Traditional Chinese (Taiwan)" })).toContain(
      "They speak Traditional Chinese (Taiwan): reply in it, unless they write to you in another language.",
    );
  });
});

describe("runTurn: input and the cursor", () => {
  test("the turn answers every message past the cursor, and the cursor moves past them when it ends", async () => {
    const db = memDb();
    ownerSays(db, "first message");
    const second = ownerSays(db, "second message");
    const { adapter, turn } = await turnWith(db, [{ token: "ok" }]);
    expect(adapter.calls[0]!.prompt).toContain("first message");
    expect(adapter.calls[0]!.prompt).toContain("second message");
    expect(adapter.calls[0]!.prompt).toMatch(/\[#\d+ · \w{3} \d\d\/\d\d \d\d:\d\d · Owner\] first message/);
    expect(turn.status).toBe("done");
    expect(getChat(db, ownerChatId(db))!.cursorSeq).toBe(second);
  });

  test("a message that arrives mid-turn is appended to the next tool result and counted as answered", async () => {
    const db = memDb();
    ownerSays(db, "check A");
    let late = 0;
    const { adapter, turn } = await turnWith(db, [{ run: () => (late = ownerSays(db, "and check B too")) }, { tool: "say", args: { text: "on it" } }, { token: "A and B are both done" }]);
    const appended = adapter.toolResults[0]!.result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(appended).toContain("and check B too");
    expect(turn.toSeq).toBe(late);
    expect(getChat(db, ownerChatId(db))!.cursorSeq).toBe(late);
  });

  test("a message that arrives after the last tool call is left past the cursor for the next turn", async () => {
    const db = memDb();
    const first = ownerSays(db, "check A");
    await turnWith(db, [{ tool: "say", args: { text: "on it" } }, { run: () => ownerSays(db, "and B") }, { token: "A is done" }]);
    expect(getChat(db, ownerChatId(db))!.cursorSeq).toBe(first);
    expect(claimTurn(db, ownerChatId(db))).not.toBeNull();
  });

  test("a failed turn leaves the cursor, so the next turn retries the same messages", async () => {
    const db = memDb();
    ownerSays(db, "hi");
    const { outcome, turn } = await turnWith(db, [{ fail: "API error" }]);
    expect(outcome).toBe("failed");
    expect(turn.error).toBe("API error");
    expect(getChat(db, ownerChatId(db))!.cursorSeq).toBe(0);
  });

  test("a stopped turn moves the cursor (the owner chose to stop it) and drops half-written text", async () => {
    const db = memDb();
    const seq = ownerSays(db, "do something that takes a long time");
    const ac = new AbortController();
    const pending = turnWith(db, [{ token: "half-writ" }, { waitForAbort: true }], { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    const { outcome } = await pending;
    expect(outcome).toBe("stopped");
    expect(messages(db)).toEqual([]);
    expect(getChat(db, ownerChatId(db))!.cursorSeq).toBe(seq);
  });

  test("a message appended after a stop began is left for the next turn", async () => {
    const db = memDb();
    const seq = ownerSays(db, "do something that takes a long time");
    const ac = new AbortController();
    const { outcome, adapter } = await turnWith(db, [{ run: () => ac.abort() }, { run: () => ownerSays(db, "do B instead") }, { tool: "say", args: { text: "x" } }, { waitForAbort: true }], { signal: ac.signal });
    expect(outcome).toBe("stopped");
    expect(JSON.stringify(adapter.toolResults[0]!.result)).not.toContain("do B instead");
    expect(getChat(db, ownerChatId(db))!.cursorSeq).toBe(seq);
  });

  test("after /new, the fresh conversation opens with the chat's recent exchange", async () => {
    const db = memDb();
    ownerSays(db, "we were just talking about headphones");
    await turnWith(db, [{ token: "QC Ultra is good" }]);
    db.$client.exec("update chat_events set status = 'sent' where kind = 'bot_message'");
    db.$client.exec("update chats set backend_session_id = null"); // what /new does
    ownerSays(db, "which colour then");
    const { adapter } = await turnWith(db, [{ token: "black" }]);
    const prompt = adapter.calls[0]!.prompt as string; // no image: still a plain string
    expect(typeof prompt).toBe("string");
    expect(adapter.calls[0]!.method).toBe("run");
    expect(prompt).toContain("we were just talking about headphones");
    expect(prompt).toContain("· ⚙ you] QC Ultra is good");
    expect(prompt.indexOf("which colour then")).toBeGreaterThan(prompt.indexOf("(New messages:)"));
  });

  test("after a clean start (agent/switch.ts), the new conversation opens with its input only; after a later /new, with history again", async () => {
    const db = memDb();
    ownerSays(db, "we were just talking about headphones");
    await turnWith(db, [{ token: "QC Ultra is good" }]);
    db.$client.exec("update chat_events set status = 'sent' where kind = 'bot_message'");
    // What a clean switch leaves: no conversation, and its unclaimed switch row.
    db.$client.exec("update chats set backend_session_id = null");
    db.insert(modelSwitches).values({ chatId: ownerChatId(db), fromModel: "example/a", toModel: "example/b", mode: "clean" }).run();
    ownerSays(db, "which colour then");
    const { adapter, turn } = await turnWith(db, [{ token: "black" }]);
    const prompt = JSON.stringify(adapter.calls[0]!.prompt);
    expect(adapter.calls[0]!.method).toBe("run");
    expect(prompt).toContain("which colour then");
    expect(prompt).not.toContain("headphones");
    expect(prompt).not.toContain("QC Ultra");
    expect(prompt).not.toContain("(New messages:)");
    // The model is never told; the transcript notes it for the console.
    expect(prompt).not.toContain("clean");
    const notes = db.$client.query("select text from turn_steps where turn_id = ? and kind = 'note'").all(turn.id) as { text: string }[];
    expect(notes.some((n) => n.text.includes("clean start"))).toBe(true);
    // A later /new is a /new: its fresh conversation opens with the recent exchange.
    db.$client.exec("update chat_events set status = 'sent' where kind = 'bot_message'");
    db.$client.exec("update chats set backend_session_id = null");
    ownerSays(db, "and the case?");
    const again = await turnWith(db, [{ token: "grey" }]);
    expect(JSON.stringify(again.adapter.calls[0]!.prompt)).toContain("which colour then");
  });

  test("Start clean (agent/switch.ts startClean): the next turn is a NEW conversation (not a switch) that opens with its input only", async () => {
    const db = memDb();
    addProvider(db, { name: "vllm", kind: "openai-compat", baseUrl: "http://127.0.0.1:9/v1" });
    addModel(db, { provider: "vllm", model: "qwen", contextWindow: 32_000, isDefault: true });
    ownerSays(db, "we were just talking about headphones");
    await turnWith(db, [{ token: "QC Ultra is good" }]);
    db.$client.exec("update chat_events set status = 'sent' where kind = 'bot_message'");
    startClean(db, ownerChatId(db));
    ownerSays(db, "which colour then");
    const { adapter, turn } = await turnWith(db, [{ token: "black" }]);
    const prompt = JSON.stringify(adapter.calls[0]!.prompt);
    expect(adapter.calls[0]!.method).toBe("run");
    expect(prompt).toContain("which colour then");
    expect(prompt).not.toContain("headphones");
    expect(prompt).not.toContain("QC Ultra");
    expect(getTurn(db, turn.id)!.opening).toBe("new");
  });

  test("a clean conversation (/newclean): no search_chats / read_chat nor their section, on every turn of it; after /new they are back", async () => {
    const db = memDb();
    addProvider(db, { name: "vllm", kind: "openai-compat", baseUrl: "http://127.0.0.1:9/v1" });
    addModel(db, { provider: "vllm", model: "qwen", contextWindow: 32_000, isDefault: true });
    ownerSays(db, "we were just talking about headphones");
    const before = await turnWith(db, [{ token: "QC Ultra is good" }], { retrieval: true });
    expect(before.adapter.calls[0]!.tools).toEqual(expect.arrayContaining(["search_chats", "read_chat"]));
    expect(before.adapter.calls[0]!.systemPrompt).toContain("## Looking back");
    db.$client.exec("update chat_events set status = 'sent' where kind = 'bot_message'");
    startClean(db, ownerChatId(db));
    for (const [n, said] of ["which colour then", "and the case?"].entries()) {
      ownerSays(db, said);
      const { adapter } = await turnWith(db, [{ token: "ok" }], { retrieval: true });
      const call = adapter.calls[0]!;
      expect(call.method).toBe(n === 0 ? "run" : "continueRun");
      expect(call.tools).not.toContain("search_chats");
      expect(call.tools).not.toContain("read_chat");
      expect(call.tools).toContain("say");
      expect(call.systemPrompt).not.toContain("Looking back");
      if (n === 0) expect(JSON.stringify(call.prompt)).not.toContain("headphones");
    }
    forgetConversations(db, ownerChatId(db));
    ownerSays(db, "one more");
    const after = await turnWith(db, [{ token: "ok" }], { retrieval: true });
    expect(after.adapter.calls[0]!.tools).toEqual(expect.arrayContaining(["search_chats", "read_chat"]));
    expect(after.adapter.calls[0]!.systemPrompt).toContain("## Looking back");
  });

  test("a message nobody answered before /newclean is not the clean conversation's: it counts as seen, unanswered", async () => {
    const db = memDb();
    addProvider(db, { name: "vllm", kind: "openai-compat", baseUrl: "http://127.0.0.1:9/v1" });
    addModel(db, { provider: "vllm", model: "qwen", contextWindow: 32_000, isDefault: true });
    ownerSays(db, "OLD-TOPIC-BEFORE-NEWCLEAN");
    startClean(db, ownerChatId(db)); // the message above is still past the cursor
    ownerSays(db, "the new topic");
    const { adapter, turn } = await turnWith(db, [{ token: "ok" }]);
    const prompt = JSON.stringify(adapter.calls[0]!.prompt);
    expect(prompt).toContain("the new topic");
    expect(prompt).not.toContain("OLD-TOPIC-BEFORE-NEWCLEAN");
    expect(getChat(db, ownerChatId(db))!.cursorSeq).toBe(turn.toSeq);
    // Only it: the turn closes empty, and counts it as seen.
    const db2 = memDb();
    addProvider(db2, { name: "vllm", kind: "openai-compat", baseUrl: "http://127.0.0.1:9/v1" });
    addModel(db2, { provider: "vllm", model: "qwen", contextWindow: 32_000, isDefault: true });
    const old = ownerSays(db2, "OLD-TOPIC-BEFORE-NEWCLEAN");
    startClean(db2, ownerChatId(db2));
    const empty = await turnWith(db2, [{ token: "must not run" }]);
    expect(empty.outcome).toBe("empty");
    expect(empty.adapter).toBeUndefined();
    expect(getChat(db2, ownerChatId(db2))!.cursorSeq).toBe(old);
  });

  test("a clean conversation opened afresh between turns (its session gone, its clean start already opened) is shown only what was said since it began", async () => {
    const db = memDb();
    ownerSays(db, "FROM-BEFORE-THE-CLEAN-START");
    const since = (db.$client.query("select max(seq) as s from chat_events").get() as { s: number }).s;
    ownerSays(db, "SAID-IN-THE-CLEAN-CONVERSATION");
    // No session, no clean switch row to open: an ordinary fresh opening, but of a clean conversation.
    db.$client.exec(`update chats set cursor_seq = (select max(seq) from chat_events), backend_session_id = null, clean_since = ${since}`);
    ownerSays(db, "are you there");
    const { adapter } = await turnWith(db, [{ token: "ok" }]);
    const prompt = JSON.stringify(adapter.calls[0]!.prompt);
    expect(adapter.calls[0]!.method).toBe("run");
    expect(prompt).toContain("SAID-IN-THE-CLEAN-CONVERSATION");
    expect(prompt).not.toContain("FROM-BEFORE-THE-CLEAN-START");
  });

  test("the first turn starts a conversation with the system prompt; later turns continue it with the prompt built afresh", async () => {
    const db = memDb();
    const home = mkdtempSync(join(tmpdir(), "shuvi-home-"));
    mkdirSync(join(home, "persona"));
    mkdirSync(join(home, "memory"));
    writeFileSync(join(home, "persona/public.md"), "PUBLIC PERSONA");
    writeFileSync(join(home, "persona/private.md"), "PRIVATE PERSONA");
    writeFileSync(join(home, "directives.md"), "- Always be brief.");
    writeFileSync(join(home, "memory/private.md"), "PRIVATE MEMORY");
    ownerSays(db, "one");
    const first = await turnWith(db, [{ token: "ok" }], { home });
    expect(first.adapter.calls[0]!.method).toBe("run");
    const sp = first.adapter.calls[0]!.systemPrompt!;
    // Most stable first: persona, directives, the chat, how speaking works, memory.
    const order = ["PUBLIC PERSONA", "PRIVATE PERSONA", "Always be brief", "This chat", "How you speak here", "PRIVATE MEMORY"].map((s) => sp.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    ownerSays(db, "two");
    expect(sp).not.toContain("They speak"); // no language configured, none named
    writeFileSync(join(home, "memory/private.md"), "EDITED MEMORY");
    const second = await turnWith(db, [{ token: "ok" }], { home });
    expect(second.adapter.calls[0]).toMatchObject({ method: "continueRun", backendSessionId: "fake-session" });
    // A resumed conversation is handed this turn's prompt, so an edit to home/ is seen without `/new`.
    expect(second.adapter.calls[0]!.systemPrompt).toBe(sp.replace("PRIVATE MEMORY", "EDITED MEMORY"));
  });
});

describe("runTurn: a sense of time", () => {
  const at = (db: Db, seq: number, iso: string) => db.$client.run("update chat_events set at = ? where seq = ?", [iso, seq]);
  const NOW = "2026-11-13T01:12:00.000Z";
  const minutesBefore = (iso: string, m: number) => new Date(Date.parse(iso) - m * 60_000).toISOString();

  /** A chat with a conversation going: one exchange at `lastAt` (her reply last), then a new message at `newAt`. */
  async function resumedAfter(lastAt: string, newAt: string) {
    const db = memDb();
    const a = ownerSays(db, "see you later");
    await turnWith(db, [{ token: "bye" }]);
    db.$client.exec("update chat_events set status = 'sent' where kind = 'bot_message'");
    at(db, a, minutesBefore(lastAt, 1));
    at(db, lastSeq(db), lastAt);
    const b = ownerSays(db, "I'm back");
    at(db, b, newAt);
    const { adapter } = await turnWith(db, [{ token: "welcome back" }], { startedAt: NOW });
    expect(adapter.calls[0]!.method).toBe("continueRun");
    return adapter.calls[0]!.prompt as string;
  }

  test(`the gap threshold: exactly ${GAP_NOTE_MINUTES} minutes since her last message is no gap; a second more is`, async () => {
    const under = await resumedAfter(minutesBefore(NOW, GAP_NOTE_MINUTES), NOW);
    expect(under).not.toContain("(It is now");
    expect(under).toStartWith("[#");
    const over = await resumedAfter(minutesBefore(NOW, GAP_NOTE_MINUTES + 1 / 60), NOW);
    expect(over).toStartWith("(It is now Fri 13 Nov 2026 01:12 (UTC). The last message here was 1 hour ago.)\n[#");
  });

  test("the gap is measured to the turn's first input event; the elapsed time to the turn's start", async () => {
    // The new message came 30 minutes after her reply, and the turn only started two days later: no gap
    // between the chat's events, so no line.
    const late = await resumedAfter(minutesBefore(NOW, 2 * 24 * 60 + 30), minutesBefore(NOW, 2 * 24 * 60));
    expect(late).not.toContain("(It is now");
    const days = await resumedAfter(minutesBefore(NOW, 2 * 24 * 60 + 5), minutesBefore(NOW, 1));
    expect(days).toStartWith("(It is now Fri 13 Nov 2026 01:12 (UTC). The last message here was 2 days ago.)\n");
  });

  test("a command and its acknowledgement are not the chat's previous event: /new after three days still says three days", async () => {
    const db = memDb();
    const a = ownerSays(db, "see you later");
    await turnWith(db, [{ token: "bye" }]);
    db.$client.exec("update chat_events set status = 'sent' where kind = 'bot_message'");
    at(db, a, minutesBefore(NOW, 3 * 24 * 60 + 1));
    at(db, lastSeq(db), minutesBefore(NOW, 3 * 24 * 60));
    // What /new leaves behind: the command, the server's reaction acknowledging it, and no session.
    db.$client.run("insert into chat_events (chat_id, kind, payload, status, at) values (?, 'command', ?, 'done', ?)", [ownerChatId(db), JSON.stringify({ command: "new" }), minutesBefore(NOW, 2)]);
    enqueueOutbound(db, { chatId: ownerChatId(db), kind: "bot_reaction", payload: { targetSeq: lastSeq(db), emoji: "👌" }, idemKey: "command:x" });
    db.$client.exec("update chats set backend_session_id = null");
    const b = ownerSays(db, "new topic");
    at(db, b, minutesBefore(NOW, 1));
    const { adapter } = await turnWith(db, [{ token: "ok" }], { startedAt: NOW });
    expect(adapter.calls[0]!.prompt as string).toStartWith("(It is now Fri 13 Nov 2026 01:12 (UTC). The last message here was 3 days ago.)\n(A new conversation.");
  });

  test("an outbound that failed to send is not the chat's previous event: nobody saw it", async () => {
    const db = memDb();
    const a = ownerSays(db, "see you later");
    await turnWith(db, [{ token: "bye" }]);
    // Her reply, from that turn, failed to send ten minutes ago; the last thing anyone saw was three days ago.
    db.$client.exec("update chat_events set status = 'failed' where kind = 'bot_message'");
    at(db, a, minutesBefore(NOW, 3 * 24 * 60));
    at(db, lastSeq(db), minutesBefore(NOW, 10));
    const b = ownerSays(db, "hello again");
    at(db, b, minutesBefore(NOW, 1));
    const { adapter } = await turnWith(db, [{ token: "hi" }], { startedAt: NOW });
    expect(adapter.calls[0]!.method).toBe("continueRun");
    expect(adapter.calls[0]!.prompt as string).toStartWith("(It is now Fri 13 Nov 2026 01:12 (UTC). The last message here was 3 days ago.)\n[#");
  });

  test("the chat's first turn says it is the first message here", async () => {
    const db = memDb();
    const seq = ownerSays(db, "hello?");
    at(db, seq, minutesBefore(NOW, 1));
    const { adapter } = await turnWith(db, [{ token: "hi" }], { startedAt: NOW });
    expect(adapter.calls[0]!.prompt).toBe(`(It is now Fri 13 Nov 2026 01:12 (UTC). This is the first message here.)\n[#${seq} · Fri 11/13 01:11 · Owner] hello?`);
  });

  test("a fresh conversation (/new) always opens with the line, even with no gap", async () => {
    const db = memDb();
    ownerSays(db, "we were just talking about headphones");
    await turnWith(db, [{ token: "QC Ultra is good" }]);
    db.$client.exec("update chat_events set status = 'sent' where kind = 'bot_message'");
    db.$client.exec("update chats set backend_session_id = null"); // what /new does
    ownerSays(db, "which colour then");
    const { adapter } = await turnWith(db, [{ token: "black" }]);
    const prompt = adapter.calls[0]!.prompt as string;
    expect(prompt).toMatch(/^\(It is now \w{3} \d{1,2} \w{3} \d{4} \d\d:\d\d \(UTC\)\. The last message here was less than a minute ago\.\)\n\(A new conversation\./);
  });

  test("a lost conversation restarts with the line; the attempt to resume, with no gap, had none", async () => {
    const db = memDb();
    ownerSays(db, "earlier message");
    db.$client.exec(`update chats set cursor_seq = (select max(seq) from chat_events), backend_session_id = 'gone-session'`);
    ownerSays(db, "are you there");
    const turn = claimTurn(db, ownerChatId(db))!;
    let adapter!: LostSessionAdapter;
    await runTurn({ db, turnId: turn.id, home: emptyHome, timeZone: "UTC", makeAdapter: (b) => (adapter = new LostSessionAdapter(b, [{ token: "Fresh start." }], LOST_ERROR)), capabilities: enabledCapabilities({ SHUVI_WEB: "off" }) });
    expect(adapter.calls.map((c) => c.method)).toEqual(["continueRun", "run"]);
    expect(adapter.calls[0]!.prompt as string).not.toContain("(It is now");
    expect(adapter.calls[1]!.prompt as string).toMatch(/^\(It is now [^\n]*\. The last message here was less than a minute ago\.\)\n\(A new conversation\./);
  });

  test("mid-turn appends get no such line, whatever the gap", async () => {
    const db = memDb();
    const first = ownerSays(db, "one");
    at(db, first, minutesBefore(new Date().toISOString(), 3 * 24 * 60));
    const { adapter } = await turnWith(db, [{ run: () => ownerSays(db, "two") }, { tool: "say", args: { text: "x" } }, { token: "done" }]);
    const appended = JSON.stringify(adapter.toolResults[0]!.result);
    expect(appended).toContain("two");
    expect(appended).not.toContain("It is now");
  });
});

/** What agent-runtime's Claude driver throws when the session it resumes no longer exists. */
const LOST_ERROR = new LostSessionError(
  "6b0b8a3e-1111-4222-8333-444455556666",
  'Claude Agent SDK run ended with "error_during_execution": No conversation found with session ID: 6b0b8a3e-1111-4222-8333-444455556666',
);

/** A scripted driver whose `continueRun` fails the way a lost Claude session does (or with `error`). */
class LostSessionAdapter extends ScriptedAdapter {
  constructor(
    boundary: ToolBoundary,
    script: Step[],
    private readonly error: string | Error,
  ) {
    super(boundary, script);
  }
  override continueRun(input: Parameters<ScriptedAdapter["continueRun"]>[0], opts: AdapterRunOptions): Promise<AdapterRunResult> {
    this.calls.push({ method: "continueRun", prompt: input.prompt, backendSessionId: input.backendSessionId, tools: [] });
    opts.onSessionId?.(input.backendSessionId); // the CLI echoes the id it was asked for
    return Promise.reject(this.error instanceof Error ? this.error : new Error(this.error));
  }
}

describe("runTurn: a lost conversation", () => {
  const LOST = LOST_ERROR;

  async function lostTurn(db: Db, error: string | Error) {
    const turn = claimTurn(db, ownerChatId(db))!;
    let adapter!: LostSessionAdapter;
    const outcome = await runTurn({ db, turnId: turn.id, home: emptyHome, timeZone: "UTC", makeAdapter: (b) => (adapter = new LostSessionAdapter(b, [{ token: "Fresh start." }], error)), capabilities: enabledCapabilities({ SHUVI_WEB: "off" }) });
    return { outcome, adapter, turn: getTurn(db, turn.id)! };
  }

  test("only agent-runtime's LostSessionError is a lost conversation: not its text in a plain Error, not another failure", () => {
    expect(isLostSession(LOST)).toBe(true);
    expect(isLostSession(new LostSessionError("openai-compat:identity:1:gone"))).toBe(true);
    expect(isLostSession(new Error(LOST.message))).toBe(false);
    expect(isLostSession(new Error('Claude Agent SDK run ended with "error_during_execution"'))).toBe(false);
  });

  test("a missing persisted API conversation restarts once with recent chat history", async () => {
    const db = memDb();
    ownerSays(db, "earlier API context");
    db.$client.exec(`update chats set cursor_seq = (select max(seq) from chat_events), backend_session_id = 'openai-compat:identity:1:gone'`);
    ownerSays(db, "continue please");
    const { outcome, adapter, turn } = await lostTurn(db, new LostSessionError("openai-compat:identity:1:gone"));
    expect(outcome).toBe("done");
    expect(turn.opening).toBe("lost");
    expect(adapter.calls.map((call) => call.method)).toEqual(["continueRun", "run"]);
    expect(adapter.calls[1]!.prompt as string).toContain("earlier API context");
  });

  test("a lost CLEAN conversation restarts as one: with the last messages said since it began only, and still no looking back", async () => {
    const db = memDb();
    ownerSays(db, "from before the clean start");
    const chatId = ownerChatId(db);
    const since = (db.$client.query("select max(seq) as s from chat_events").get() as { s: number }).s;
    ownerSays(db, "said in the clean conversation");
    db.$client.exec(`update chats set cursor_seq = (select max(seq) from chat_events), backend_session_id = 'gone-session', clean_since = ${since}`);
    ownerSays(db, "are you there");
    const { outcome, adapter } = await lostTurn(db, LOST);
    expect(outcome).toBe("done");
    expect(adapter.calls.map((c) => c.method)).toEqual(["continueRun", "run"]);
    const prompt = adapter.calls[1]!.prompt as string;
    expect(prompt).toContain("said in the clean conversation");
    expect(prompt).not.toContain("from before the clean start");
    expect(adapter.calls[1]!.tools).not.toContain("read_chat");
    expect(adapter.calls[1]!.tools).not.toContain("search_chats");
    expect(adapter.calls[1]!.systemPrompt).not.toContain("Looking back");
    expect(getChat(db, chatId)!.cleanSince).toBe(since);
  });

  test("the conversation is reset and the same turn runs again at once as a fresh one, with the last messages, costing no attempt", async () => {
    const db = memDb();
    ownerSays(db, "earlier message");
    const chatId = ownerChatId(db);
    db.$client.exec(`update chats set cursor_seq = (select max(seq) from chat_events), backend_session_id = 'gone-session'`);
    ownerSays(db, "are you there");
    const { outcome, adapter, turn } = await lostTurn(db, LOST);
    expect(outcome).toBe("done");
    expect(turn.status).toBe("done");
    expect(adapter.calls.map((c) => c.method)).toEqual(["continueRun", "run"]);
    const prompt = adapter.calls[1]!.prompt as string; // no image: a plain string
    expect(prompt).toContain("earlier message");
    expect(prompt.indexOf("are you there")).toBeGreaterThan(prompt.indexOf("(New messages:)"));
    expect(adapter.calls[1]!.systemPrompt).toBeDefined();
    expect(getChat(db, chatId)!.backendSessionId).toBe("fake-session");
    expect(messages(db)).toEqual(["Fresh start."]);
    expect(db.$client.query("select count(*) as n from turns where status = 'failed'").get()).toEqual({ n: 0 });
    expect(controlMessagesOf(db, "alert")[0]!.text).toContain("was lost (gone-session)");
  });

  test("any other error is an ordinary failure: the conversation is kept", async () => {
    const db = memDb();
    ownerSays(db, "hi");
    db.$client.exec(`update chats set backend_session_id = 'kept-session'`);
    const { outcome, adapter } = await lostTurn(db, 'Claude Agent SDK run ended with "error_during_execution"');
    expect(outcome).toBe("failed");
    expect(adapter.calls.map((c) => c.method)).toEqual(["continueRun"]);
    expect(getChat(db, ownerChatId(db))!.backendSessionId).toBe("kept-session");
  });
});

describe("runTurn: the retry of a turn a restart cut off", () => {
  /** A chat whose turn on "hello" was stopped at a draining server's deadline (server/drain.ts), in `session`. */
  function cutOff(db: Db, session: string | null) {
    ownerSays(db, "hello");
    if (session) saveSession(db, ownerChatId(db), session);
    const t = claimTurn(db, ownerChatId(db))!;
    if (session) db.$client.run("update turns set backend_session_id = ? where id = ?", [session, t.id]);
    markDrainStop(db, t.id);
    markStop(db, t.id, t.fromSeq);
    finishTurn(db, t.id, { status: "stopped" });
    return getTurn(db, t.id)!;
  }

  test("in the same conversation, the same messages come again under the retry note, once", async () => {
    const db = memDb();
    const stopped = cutOff(db, "s-1");
    expect(stopped.error).toBe(DRAIN_STOP);
    expect(getChat(db, ownerChatId(db))!.cursorSeq).toBe(stopped.fromSeq);
    const { adapter, turn } = await turnWith(db, [{ token: "Hi again." }]);
    expect(turn.fromSeq).toBe(stopped.fromSeq);
    const prompt = String(adapter.calls[0]!.prompt);
    expect(prompt).toContain(RETRY_NOTE);
    expect(prompt.split(RETRY_NOTE).length).toBe(2);
    expect(prompt.indexOf(RETRY_NOTE)).toBeLessThan(prompt.indexOf("hello"));
    // And only that once: the turn after it is an ordinary one.
    ownerSays(db, "thanks");
    const next = await turnWith(db, [{ token: "Any time." }]);
    expect(String(next.adapter.calls[0]!.prompt)).not.toContain(RETRY_NOTE);
  });

  test("no note in a fresh conversation (after /new, a lost session), nor after a stop that was not the drain's", async () => {
    const db = memDb();
    cutOff(db, null);
    const fresh = await turnWith(db, [{ token: "Hello." }]);
    expect(String(fresh.adapter.calls[0]!.prompt)).not.toContain(RETRY_NOTE);

    const db2 = memDb();
    ownerSays(db2, "hello");
    saveSession(db2, ownerChatId(db2), "s-2");
    const t = claimTurn(db2, ownerChatId(db2))!;
    markStop(db2, t.id, t.fromSeq); // a switch's stop: no DRAIN_STOP
    finishTurn(db2, t.id, { status: "stopped" });
    const after = await turnWith(db2, [{ token: "Hello." }]);
    expect(String(after.adapter.calls[0]!.prompt)).not.toContain(RETRY_NOTE);
  });

  test("not when the conversation resumed is another than the one the stopped turn ran in", () => {
    const db = memDb();
    const stopped = cutOff(db, "s-1");
    ownerSays(db, "x");
    const next = claimTurn(db, ownerChatId(db))!;
    expect(next.fromSeq).toBe(stopped.fromSeq);
    expect(isRetryAfterDrain(db, next, "s-1")).toBe(true);
    expect(isRetryAfterDrain(db, next, "s-other")).toBe(false);
    expect(isRetryAfterDrain(db, next, null)).toBe(false);
  });
});
