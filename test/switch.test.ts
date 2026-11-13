import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "agent-runtime/openai-compat";
import { appendToClaudeSession, claudeSessionMessages, findClaudeSession } from "agent-runtime/convert";
import { enterModelLane, switchModel } from "../src/agent/switch.ts";
import { appendMessages, conversationSince, conversationStore, pruneConversations } from "../src/store/conversations.ts";
import type { Db } from "../src/store/db.ts";
import { forgetConversations, getChat, resetConversation } from "../src/store/events.ts";
import { addModel, addProvider, setDefaultModel } from "../src/store/models.ts";
import { chatLanes, modelSwitches } from "../src/store/schema.ts";
import { claimTurn, finishTurn, saveSession } from "../src/store/turns.ts";
import { memDb, ownerChatId, ownerSays } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A catalog with a Claude login (in a temporary config dir) and an OpenAI-compatible endpoint. */
function setup() {
  const configDir = mkdtempSync(join(tmpdir(), "shuvi-switch-"));
  dirs.push(configDir);
  const db = memDb();
  addProvider(db, { name: "claude", kind: "claude", configDir });
  addModel(db, { provider: "claude", model: "opus", isDefault: true });
  addModel(db, { provider: "claude", model: "sonnet" });
  addProvider(db, { name: "vllm", kind: "openai-compat", baseUrl: "http://127.0.0.1:8000/v1" });
  addModel(db, { provider: "vllm", model: "qwen", contextWindow: 32_000 });
  addModel(db, { provider: "vllm", model: "llama", contextWindow: 32_000 });
  ownerSays(db, "hi");
  const chatId = ownerChatId(db);
  return { db, chatId, configDir };
}

const turnOf = (n: string): ModelMessage[] => [
  { role: "user", content: `${n}-PROMPT` },
  { role: "assistant", content: [{ type: "text", text: `${n}-ANSWER` }] },
];
const texts = (messages: ModelMessage[]) => JSON.stringify(messages).match(/T\d-(PROMPT|ANSWER)/g) ?? [];

/** Where the chat's active conversation is, and what it holds, whichever lane it is in. */
function active(db: Db, chatId: number, configDir: string): { lane: string | null; texts: string[] } {
  const chat = getChat(db, chatId)!;
  if (!chat.backendSessionId) return { lane: chat.lane, texts: [] };
  const messages = chat.lane === "openai-compat" ? conversationSince(db, chat.backendSessionId, null).messages : claudeSessionMessages(chat.backendSessionId, { configDir }).messages;
  return { lane: chat.lane, texts: texts(messages) };
}

/** A turn of the active conversation, as its driver would have written it. */
function speak(db: Db, chatId: number, configDir: string, n: string): void {
  const chat = getChat(db, chatId)!;
  if (chat.lane === "openai-compat") {
    const id = chat.backendSessionId ?? `oa-${n}`;
    appendMessages(db, chatId, id, turnOf(n));
    if (!chat.backendSessionId) saveSession(db, chatId, id);
  } else {
    const s = appendToClaudeSession(chat.backendSessionId, turnOf(n), { configDir, cwd: "/srv" });
    if (!chat.backendSessionId) saveSession(db, chatId, s.sessionId);
  }
}

describe("switchModel", () => {
  test("the owner's example: T1 Claude → lossless → T2 API → lossy → T3 Claude", () => {
    const { db, chatId, configDir } = setup();
    enterModelLane(db, getChat(db, chatId)!);
    speak(db, chatId, configDir, "T1");

    expect(switchModel(db, chatId, "vllm/qwen", "lossless")).toEqual({ mode: "lossless", from: "claude/opus", to: "vllm/qwen", carried: 2, compacted: false });
    expect(active(db, chatId, configDir)).toEqual({ lane: "openai-compat", texts: ["T1-PROMPT", "T1-ANSWER"] });
    speak(db, chatId, configDir, "T2");

    expect(switchModel(db, chatId, "claude/opus", "lossy")).toEqual({ mode: "lossy", from: "vllm/qwen", to: "claude/opus", carried: 0, compacted: false });
    speak(db, chatId, configDir, "T3");
    // Claude holds T1 (its own) and T3: T2 is the black hole.
    expect(active(db, chatId, configDir)).toEqual({ lane: "claude:claude", texts: ["T1-PROMPT", "T1-ANSWER", "T3-PROMPT", "T3-ANSWER"] });
    // The API conversation is parked as it was left.
    const parked = db.select().from(chatLanes).all();
    expect(parked.map((p) => p.lane)).toEqual(["openai-compat"]);
    expect(texts(conversationSince(db, parked[0]!.backendSessionId, null).messages)).toEqual(["T1-PROMPT", "T1-ANSWER", "T2-PROMPT", "T2-ANSWER"]);
  });

  test("lossless back and forth carries only what the target lacks, never twice", () => {
    const { db, chatId, configDir } = setup();
    enterModelLane(db, getChat(db, chatId)!);
    speak(db, chatId, configDir, "T1");
    switchModel(db, chatId, "vllm/qwen", "lossless");
    speak(db, chatId, configDir, "T2");
    expect(switchModel(db, chatId, "claude/opus", "lossless").carried).toBe(2); // T2 only
    speak(db, chatId, configDir, "T3");
    expect(switchModel(db, chatId, "vllm/qwen", "lossless").carried).toBe(2); // T3 only
    expect(active(db, chatId, configDir).texts).toEqual(["T1-PROMPT", "T1-ANSWER", "T2-PROMPT", "T2-ANSWER", "T3-PROMPT", "T3-ANSWER"]);
    speak(db, chatId, configDir, "T4");
    switchModel(db, chatId, "claude/opus", "lossless");
    // Claude's own T1 and T3 stay native; T2 and T4 were appended, once each.
    expect(active(db, chatId, configDir).texts).toEqual(["T1-PROMPT", "T1-ANSWER", "T2-PROMPT", "T2-ANSWER", "T3-PROMPT", "T3-ANSWER", "T4-PROMPT", "T4-ANSWER"]);
  });

  test("lossless after a lossy return carries only what came since the return", () => {
    const { db, chatId, configDir } = setup();
    enterModelLane(db, getChat(db, chatId)!);
    speak(db, chatId, configDir, "T1");
    switchModel(db, chatId, "vllm/qwen", "lossless");
    speak(db, chatId, configDir, "T2");
    switchModel(db, chatId, "claude/opus", "lossy");
    speak(db, chatId, configDir, "T3");
    expect(switchModel(db, chatId, "vllm/qwen", "lossless").carried).toBe(2);
    expect(active(db, chatId, configDir).texts).toEqual(["T1-PROMPT", "T1-ANSWER", "T2-PROMPT", "T2-ANSWER", "T3-PROMPT", "T3-ANSWER"]);
  });

  test("within a lane only the model changes: the conversation and its position stay", () => {
    const { db, chatId, configDir } = setup();
    enterModelLane(db, getChat(db, chatId)!);
    speak(db, chatId, configDir, "T1");
    const before = getChat(db, chatId)!;
    expect(switchModel(db, chatId, "claude/sonnet", "lossy").mode).toBe("native");
    const after = getChat(db, chatId)!;
    expect(after.model).toBe("claude/sonnet");
    expect([after.lane, after.backendSessionId, after.laneEnteredAt]).toEqual([before.lane, before.backendSessionId, before.laneEnteredAt]);
    switchModel(db, chatId, "vllm/qwen", "lossless");
    speak(db, chatId, configDir, "T2");
    const id = getChat(db, chatId)!.backendSessionId;
    expect(switchModel(db, chatId, "vllm/llama", "lossless").mode).toBe("native");
    expect(getChat(db, chatId)!.backendSessionId).toBe(id);
  });

  test("lossy to a lane with no conversation yet starts fresh at the next turn", () => {
    const { db, chatId, configDir } = setup();
    enterModelLane(db, getChat(db, chatId)!);
    speak(db, chatId, configDir, "T1");
    switchModel(db, chatId, "vllm/qwen", "lossy");
    const chat = getChat(db, chatId)!;
    expect([chat.lane, chat.backendSessionId, chat.model]).toEqual(["openai-compat", null, "vllm/qwen"]);
  });

  test("a target conversation that is gone lacks everything: the whole active conversation is carried onto a new one", () => {
    const { db, chatId, configDir } = setup();
    enterModelLane(db, getChat(db, chatId)!);
    speak(db, chatId, configDir, "T1");
    const claudeSession = getChat(db, chatId)!.backendSessionId!;
    switchModel(db, chatId, "vllm/qwen", "lossless");
    speak(db, chatId, configDir, "T2");
    unlinkSync(findClaudeSession(claudeSession, configDir)!); // the CLI swept it away
    expect(switchModel(db, chatId, "claude/opus", "lossless").carried).toBe(4);
    expect(active(db, chatId, configDir).texts).toEqual(["T1-PROMPT", "T1-ANSWER", "T2-PROMPT", "T2-ANSWER"]);
    expect(getChat(db, chatId)!.backendSessionId).not.toBe(claudeSession);
  });

  test("a source whose login left the catalog carries nothing", () => {
    const { db, chatId, configDir } = setup();
    addProvider(db, { name: "work", kind: "claude", configDir });
    addModel(db, { provider: "work", model: "opus" });
    switchModel(db, chatId, "work/opus", "lossy");
    speak(db, chatId, configDir, "T1");
    db.$client.query("delete from model_providers where name = 'work'").run();
    expect(switchModel(db, chatId, "vllm/qwen", "lossless").carried).toBe(0);
  });

  test("between two Claude logins: lanes of their own, carried like any other", () => {
    const { db, chatId, configDir } = setup();
    const other = mkdtempSync(join(tmpdir(), "shuvi-switch-"));
    dirs.push(other);
    addProvider(db, { name: "work", kind: "claude", configDir: other });
    addModel(db, { provider: "work", model: "opus" });
    enterModelLane(db, getChat(db, chatId)!);
    speak(db, chatId, configDir, "T1");
    expect(switchModel(db, chatId, "work/opus", "lossless").carried).toBe(2);
    const chat = getChat(db, chatId)!;
    expect(chat.lane).toBe("claude:work");
    expect(findClaudeSession(chat.backendSessionId!, other)).not.toBeNull();
    expect(texts(claudeSessionMessages(chat.backendSessionId!, { configDir: other }).messages)).toEqual(["T1-PROMPT", "T1-ANSWER"]);
  });

  test("a compaction since the lane was entered: all the source holds is carried, and the switch says so", () => {
    const { db, chatId, configDir } = setup();
    enterModelLane(db, getChat(db, chatId)!);
    speak(db, chatId, configDir, "T1");
    switchModel(db, chatId, "vllm/qwen", "lossless");
    speak(db, chatId, configDir, "T2");
    const id = getChat(db, chatId)!.backendSessionId!;
    void conversationStore(db, chatId).compact!(id, [{ role: "user", content: "SUMMARY of T1 and T2" }]);
    speak(db, chatId, configDir, "T3");
    const r = switchModel(db, chatId, "claude/opus", "lossless");
    expect([r.carried, r.compacted]).toEqual([3, true]);
    expect(JSON.stringify(claudeSessionMessages(getChat(db, chatId)!.backendSessionId!, { configDir }).messages)).toContain("SUMMARY of T1 and T2");
    expect(db.select().from(modelSwitches).all().at(-1)!.compacted).toBe(true);
  });

  test("refuses while a turn runs, and names a model the catalog does not have", () => {
    const { db, chatId } = setup();
    expect(() => switchModel(db, chatId, "vllm/nope", "lossy")).toThrow(/no model "vllm\/nope"/);
    const turn = claimTurn(db, chatId)!;
    expect(() => switchModel(db, chatId, "vllm/qwen", "lossy")).toThrow(/a turn is running/);
    finishTurn(db, turn.id, { status: "done" });
    // A chat with no conversation yet has nothing to move: only its model changes.
    expect(switchModel(db, chatId, "vllm/qwen", "lossy")).toMatchObject({ mode: "native", to: "vllm/qwen" });
  });

  test("every switch is a row the next turn records", () => {
    const { db, chatId, configDir } = setup();
    enterModelLane(db, getChat(db, chatId)!);
    speak(db, chatId, configDir, "T1");
    switchModel(db, chatId, "claude/sonnet", "lossless");
    switchModel(db, chatId, "vllm/qwen", "lossless");
    expect(db.select().from(modelSwitches).all().map((s) => [s.fromModel, s.toModel, s.mode, s.carried, s.turnId])).toEqual([
      ["claude/opus", "claude/sonnet", "native", 0, null],
      ["claude/sonnet", "vllm/qwen", "lossless", 2, null],
    ]);
  });
});

describe("a chat's lanes", () => {
  test("/new forgets every lane; a lost conversation only its own", () => {
    const { db, chatId, configDir } = setup();
    enterModelLane(db, getChat(db, chatId)!);
    speak(db, chatId, configDir, "T1");
    switchModel(db, chatId, "vllm/qwen", "lossless");
    expect(db.select().from(chatLanes).all()).toHaveLength(1);
    resetConversation(db, chatId);
    expect(getChat(db, chatId)!.backendSessionId).toBeNull();
    expect(db.select().from(chatLanes).all()).toHaveLength(1);
    forgetConversations(db, chatId);
    expect(db.select().from(chatLanes).all()).toHaveLength(0);
    expect(getChat(db, chatId)!.backendSessionId).toBeNull();
  });

  test("pruning keeps a parked conversation however old it is", () => {
    const { db, chatId, configDir } = setup();
    switchModel(db, chatId, "vllm/qwen", "lossy");
    speak(db, chatId, configDir, "T1");
    const id = getChat(db, chatId)!.backendSessionId!;
    switchModel(db, chatId, "claude/opus", "lossy");
    expect(pruneConversations(db, new Date(Date.now() + 86_400_000).toISOString())).toBe(0);
    expect(texts(conversationSince(db, id, null).messages)).toEqual(["T1-PROMPT", "T1-ANSWER"]);
  });

  test("a conversation from before lanes is the seeded Claude login's, even once the default is an endpoint", () => {
    const { db, chatId, configDir } = setup();
    // A chat from before lanes: a Claude session, no lane.
    const legacy = appendToClaudeSession(null, turnOf("T1"), { configDir, cwd: "/srv" }).sessionId;
    saveSession(db, chatId, legacy);
    setDefaultModel(db, "vllm/qwen");
    // The next turn moves it lossy to the endpoint's lane: the Claude session is parked in Claude's lane.
    expect(enterModelLane(db, getChat(db, chatId)!).id).toBe("vllm/qwen");
    expect(db.select().from(chatLanes).all().map((l) => [l.lane, l.backendSessionId])).toEqual([["claude:claude", legacy]]);
    expect(db.select().from(modelSwitches).all().map((s) => [s.fromModel, s.toModel, s.mode])).toEqual([[null, "vllm/qwen", "lossy"]]);
    // And an explicit lossless switch from such a chat carries the Claude conversation.
    const db2 = setup();
    const legacy2 = appendToClaudeSession(null, turnOf("T1"), { configDir: db2.configDir, cwd: "/srv" }).sessionId;
    saveSession(db2.db, db2.chatId, legacy2);
    setDefaultModel(db2.db, "vllm/qwen");
    expect(switchModel(db2.db, db2.chatId, "vllm/qwen", "lossless").carried).toBe(2);
    expect(db2.db.select().from(chatLanes).all().map((l) => [l.lane, l.backendSessionId])).toEqual([["claude:claude", legacy2]]);
  });

  test("a conversation from before lanes is in its model's lane", () => {
    const { db, chatId } = setup();
    saveSession(db, chatId, "legacy-claude-session");
    expect(enterModelLane(db, getChat(db, chatId)!).id).toBe("claude/opus");
    expect([getChat(db, chatId)!.lane, getChat(db, chatId)!.backendSessionId]).toEqual(["claude:claude", "legacy-claude-session"]);
  });
});
