import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt } from "../src/agent/prompt.ts";
import type { AdapterRunOptions, AdapterRunResult, ToolBoundary } from "agent-runtime";
import { isLostSession, runTurn } from "../src/agent/turn.ts";
import { controlMessagesOf } from "../src/store/control.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import type { Db } from "../src/store/db.ts";
import { getChat, pendingOutbound, type BotMessagePayload, type BotReactionPayload } from "../src/store/events.ts";
import { claimTurn, getTurn } from "../src/store/turns.ts";
import { memDb, ownerChatId, ownerSays, ScriptedAdapter, type Step } from "./helpers.ts";

const emptyHome = mkdtempSync(join(tmpdir(), "shuvi-home-"));

async function turnWith(db: Db, script: Step[], opts: { home?: string; signal?: AbortSignal; web?: { tavilyApiKey?: string } } = {}) {
  const turn = claimTurn(db, ownerChatId(db))!;
  let adapter!: ScriptedAdapter;
  const outcome = await runTurn({
    db,
    turnId: turn.id,
    home: opts.home ?? emptyHome,
    timeZone: "UTC",
    makeAdapter: (b) => (adapter = new ScriptedAdapter(b, script)),
    ...(opts.signal ? { signal: opts.signal } : {}),
    // The web capability is on when the test asks for it, off otherwise, through its own variables.
    // Schedules, memory, retrieval and playbooks are off here: these tests are about speech and web.
    capabilities: enabledCapabilities(opts.web ? { SHUVI_SCHEDULES: "off", SHUVI_MEMORY: "off", SHUVI_RETRIEVAL: "off", SHUVI_PLAYBOOKS: "off", ...(opts.web.tavilyApiKey ? { SHUVI_TAVILY_API_KEY: opts.web.tavilyApiKey } : {}) } : { SHUVI_WEB: "off", SHUVI_SCHEDULES: "off", SHUVI_MEMORY: "off", SHUVI_RETRIEVAL: "off", SHUVI_PLAYBOOKS: "off" }),
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
    expect(adapter.calls[0]!.prompt).toMatch(/\[#\d+ · \d\d\/\d\d \d\d:\d\d · Owner\] first message/);
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

/** A scripted driver whose `continueRun` fails the way a lost Claude session does (or with `error`). */
class LostSessionAdapter extends ScriptedAdapter {
  constructor(
    boundary: ToolBoundary,
    script: Step[],
    private readonly error: string,
  ) {
    super(boundary, script);
  }
  override continueRun(input: Parameters<ScriptedAdapter["continueRun"]>[0], opts: AdapterRunOptions): Promise<AdapterRunResult> {
    this.calls.push({ method: "continueRun", prompt: input.prompt, backendSessionId: input.backendSessionId, tools: [] });
    opts.onSessionId?.(input.backendSessionId); // the CLI echoes the id it was asked for
    return Promise.reject(new Error(this.error));
  }
}

describe("runTurn: a lost conversation", () => {
  // The exact text agent-runtime's Claude driver produces when the session no longer exists: its own
  // prefix, then the SDK result's `errors` (the Claude Code CLI's message) after a colon.
  const LOST = 'Claude Agent SDK run ended with "error_during_execution": No conversation found with session ID: 6b0b8a3e-1111-4222-8333-444455556666';

  async function lostTurn(db: Db, error: string) {
    const turn = claimTurn(db, ownerChatId(db))!;
    let adapter!: LostSessionAdapter;
    const outcome = await runTurn({ db, turnId: turn.id, home: emptyHome, timeZone: "UTC", makeAdapter: (b) => (adapter = new LostSessionAdapter(b, [{ token: "Fresh start." }], error)), capabilities: enabledCapabilities({ SHUVI_WEB: "off" }) });
    return { outcome, adapter, turn: getTurn(db, turn.id)! };
  }

  test("the pinned driver text is recognised, and nothing else is", () => {
    expect(isLostSession(new Error(LOST))).toBe(true);
    expect(isLostSession(new Error('Claude Agent SDK run ended with "error_during_execution"'))).toBe(false);
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
