import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "agent-runtime/openai-compat";
import { appendToClaudeSession, claudeSessionMessages, findClaudeSession } from "agent-runtime/convert";
import { conversationPosition, enterChatModel, getSwitchRequest, requestSwitch, switchModel, type SwitchMode } from "../src/agent/switch.ts";
import { switchRequestPass } from "../src/server/commands.ts";
import { wakerPass } from "../src/server/waker.ts";
import { appendMessages, conversationSince, conversationStore, pruneConversations } from "../src/store/conversations.ts";
import type { Db } from "../src/store/db.ts";
import { forgetConversations, getChat, resetConversation } from "../src/store/events.ts";
import { addModel, addProvider, setDefaultModel } from "../src/store/models.ts";
import { chatConversations, modelSwitches } from "../src/store/schema.ts";
import { claimTurn, finishTurn, getTurn, runningTurnFor, saveSession, setTurnConversation, setTurnPid } from "../src/store/turns.ts";
import { memDb, ownerChatId, ownerSays } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "shuvi-switch-"));
  dirs.push(dir);
  return dir;
}

/**
 * A catalog with a Claude login (two models, in a temporary config dir), a second Claude login (`work`), and
 * an OpenAI-compatible endpoint (two models).
 */
function setup() {
  const configDir = tmp();
  const workDir = tmp();
  const db = memDb();
  addProvider(db, { name: "claude", kind: "claude", configDir });
  addModel(db, { provider: "claude", model: "opus", isDefault: true });
  addModel(db, { provider: "claude", model: "sonnet" });
  addProvider(db, { name: "vllm", kind: "openai-compat", baseUrl: "http://127.0.0.1:8000/v1" });
  addModel(db, { provider: "vllm", model: "qwen", contextWindow: 32_000 });
  addModel(db, { provider: "vllm", model: "llama", contextWindow: 32_000 });
  addProvider(db, { name: "work", kind: "claude", configDir: workDir });
  addModel(db, { provider: "work", model: "opus" });
  ownerSays(db, "hi");
  const chatId = ownerChatId(db);
  const logins: Record<string, string> = { claude: configDir, work: workDir };
  return { db, chatId, configDir, workDir, logins };
}
type World = ReturnType<typeof setup>;

const turnOf = (n: string): ModelMessage[] => [
  { role: "user", content: `${n}-PROMPT` },
  { role: "assistant", content: [{ type: "text", text: `${n}-ANSWER` }] },
];
const texts = (messages: unknown) => JSON.stringify(messages).match(/T\d-(PROMPT|ANSWER)/g) ?? [];
const providerOf = (model: string) => model.slice(0, model.indexOf("/"));

/** What a conversation of `model` holds, wherever its model keeps it. */
function holds(w: World, model: string, session: string): string[] {
  const p = providerOf(model);
  return p === "vllm" ? texts(conversationSince(w.db, session, null).messages) : texts(claudeSessionMessages(session, { configDir: w.logins[p]! }).messages);
}

/** The chat's active conversation: whose it is, and what it holds. */
function active(w: World): { model: string | null; texts: string[] } {
  const chat = getChat(w.db, w.chatId)!;
  if (!chat.backendSessionId) return { model: chat.conversationModel, texts: [] };
  return { model: chat.conversationModel, texts: holds(w, chat.conversationModel!, chat.backendSessionId) };
}

/** What each parked conversation holds, by model. */
function parked(w: World): Record<string, string[]> {
  return Object.fromEntries(w.db.select().from(chatConversations).all().map((p) => [p.model, holds(w, p.model, p.backendSessionId)]));
}

/** A turn of the active conversation, as its driver would have written it. */
function speak(w: World, n: string): void {
  const chat = getChat(w.db, w.chatId)!;
  const p = providerOf(chat.conversationModel!);
  if (p === "vllm") {
    const id = chat.backendSessionId ?? `oa-${n}`;
    appendMessages(w.db, w.chatId, id, turnOf(n));
    if (!chat.backendSessionId) saveSession(w.db, w.chatId, id);
  } else {
    const s = appendToClaudeSession(chat.backendSessionId, turnOf(n), { configDir: w.logins[p]!, cwd: "/srv" });
    if (!chat.backendSessionId) saveSession(w.db, w.chatId, s.sessionId);
  }
}

/** A chat that has talked T1 on the default (claude/opus). */
function started(): World {
  const w = setup();
  enterChatModel(w.db, getChat(w.db, w.chatId)!);
  speak(w, "T1");
  return w;
}

describe("switchModel: a conversation per model, across storages", () => {
  test("the owner's example: T1 Claude → lossless → T2 API → lossy → T3 Claude", () => {
    const w = started();
    expect(switchModel(w.db, w.chatId, "vllm/qwen", "lossless")).toEqual({ mode: "lossless", changed: true, from: "claude/opus", to: "vllm/qwen", carried: 2, compacted: false });
    expect(active(w)).toEqual({ model: "vllm/qwen", texts: ["T1-PROMPT", "T1-ANSWER"] });
    speak(w, "T2");
    expect(switchModel(w.db, w.chatId, "claude/opus", "lossy")).toEqual({ mode: "lossy", changed: true, from: "vllm/qwen", to: "claude/opus", carried: 0, compacted: false });
    speak(w, "T3");
    // Claude holds T1 (its own) and T3: T2 is the black hole.
    expect(active(w)).toEqual({ model: "claude/opus", texts: ["T1-PROMPT", "T1-ANSWER", "T3-PROMPT", "T3-ANSWER"] });
    // The API conversation is parked under its model, as it was left.
    expect(parked(w)).toEqual({ "vllm/qwen": ["T1-PROMPT", "T1-ANSWER", "T2-PROMPT", "T2-ANSWER"] });
  });

  test("lossless back and forth carries only what the target lacks, never twice", () => {
    const w = started();
    switchModel(w.db, w.chatId, "vllm/qwen", "lossless");
    speak(w, "T2");
    expect(switchModel(w.db, w.chatId, "claude/opus", "lossless").carried).toBe(2); // T2 only
    speak(w, "T3");
    expect(switchModel(w.db, w.chatId, "vllm/qwen", "lossless").carried).toBe(2); // T3 only
    expect(active(w).texts).toEqual(["T1-PROMPT", "T1-ANSWER", "T2-PROMPT", "T2-ANSWER", "T3-PROMPT", "T3-ANSWER"]);
    speak(w, "T4");
    switchModel(w.db, w.chatId, "claude/opus", "lossless");
    // Claude's own T1 and T3 stay native; T2 and T4 were appended, once each.
    expect(active(w).texts).toEqual(["T1-PROMPT", "T1-ANSWER", "T2-PROMPT", "T2-ANSWER", "T3-PROMPT", "T3-ANSWER", "T4-PROMPT", "T4-ANSWER"]);
  });

  test("lossless after a lossy return carries only what came since the return", () => {
    const w = started();
    switchModel(w.db, w.chatId, "vllm/qwen", "lossless");
    speak(w, "T2");
    switchModel(w.db, w.chatId, "claude/opus", "lossy");
    speak(w, "T3");
    expect(switchModel(w.db, w.chatId, "vllm/qwen", "lossless").carried).toBe(2);
    expect(active(w).texts).toEqual(["T1-PROMPT", "T1-ANSWER", "T2-PROMPT", "T2-ANSWER", "T3-PROMPT", "T3-ANSWER"]);
  });

  test("Claude across logins: a new session in the other login, written from the whole conversation", () => {
    const w = started();
    expect(switchModel(w.db, w.chatId, "work/opus", "lossless").carried).toBe(2);
    const chat = getChat(w.db, w.chatId)!;
    expect(chat.conversationModel).toBe("work/opus");
    expect(findClaudeSession(chat.backendSessionId!, w.workDir)).not.toBeNull();
    expect(active(w).texts).toEqual(["T1-PROMPT", "T1-ANSWER"]);
    speak(w, "T2");
    // Back lossless: only T2 is appended to the first login's own session.
    expect(switchModel(w.db, w.chatId, "claude/opus", "lossless").carried).toBe(2);
    expect(active(w).texts).toEqual(["T1-PROMPT", "T1-ANSWER", "T2-PROMPT", "T2-ANSWER"]);
  });
});

describe("switchModel: two models of the same storage", () => {
  test("openai-compat ↔ openai-compat lossless: rows copied under a new conversation id, then appended", () => {
    const w = setup();
    switchModel(w.db, w.chatId, "vllm/qwen", "lossy");
    speak(w, "T1");
    const qwen = getChat(w.db, w.chatId)!.backendSessionId!;
    expect(switchModel(w.db, w.chatId, "vllm/llama", "lossless")).toMatchObject({ changed: true, from: "vllm/qwen", carried: 2 });
    const llama = getChat(w.db, w.chatId)!.backendSessionId!;
    expect(llama).not.toBe(qwen);
    expect(active(w)).toEqual({ model: "vllm/llama", texts: ["T1-PROMPT", "T1-ANSWER"] });
    speak(w, "T2");
    // A→B→A lossless: A gets exactly what B gained.
    expect(switchModel(w.db, w.chatId, "vllm/qwen", "lossless").carried).toBe(2);
    expect(getChat(w.db, w.chatId)!.backendSessionId).toBe(qwen);
    expect(active(w).texts).toEqual(["T1-PROMPT", "T1-ANSWER", "T2-PROMPT", "T2-ANSWER"]);
    expect(parked(w)).toEqual({ "vllm/llama": ["T1-PROMPT", "T1-ANSWER", "T2-PROMPT", "T2-ANSWER"] });
  });

  test("openai-compat ↔ openai-compat lossy: A→B→A resumes A's own conversation without B's part", () => {
    const w = setup();
    switchModel(w.db, w.chatId, "vllm/qwen", "lossy");
    speak(w, "T1");
    const qwen = getChat(w.db, w.chatId)!.backendSessionId!;
    switchModel(w.db, w.chatId, "vllm/llama", "lossy");
    expect(getChat(w.db, w.chatId)!.backendSessionId).toBeNull(); // llama has none: fresh at the next turn
    speak(w, "T2");
    switchModel(w.db, w.chatId, "vllm/qwen", "lossy");
    expect(getChat(w.db, w.chatId)!.backendSessionId).toBe(qwen);
    expect(active(w).texts).toEqual(["T1-PROMPT", "T1-ANSWER"]);
    expect(parked(w)).toEqual({ "vllm/llama": ["T2-PROMPT", "T2-ANSWER"] });
  });

  test("Claude ↔ Claude on the same login, lossless: the session is copied (forked), then appended", () => {
    const w = started();
    const opus = getChat(w.db, w.chatId)!.backendSessionId!;
    w.db.$client.query("update chats set context_tokens = 1234").run();
    const original = readFileSync(findClaudeSession(opus, w.configDir)!, "utf8");
    expect(switchModel(w.db, w.chatId, "claude/sonnet", "lossless")).toMatchObject({ changed: true, from: "claude/opus", carried: 2, compacted: false });
    const chat = getChat(w.db, w.chatId)!;
    expect(chat.backendSessionId).not.toBe(opus);
    // A copy in the same login, as it is; the original untouched; the same size of context.
    expect(findClaudeSession(chat.backendSessionId!, w.configDir)).not.toBeNull();
    expect(readFileSync(findClaudeSession(opus, w.configDir)!, "utf8")).toBe(original);
    expect(chat.contextTokens).toBe(1234);
    expect(active(w)).toEqual({ model: "claude/sonnet", texts: ["T1-PROMPT", "T1-ANSWER"] });
    speak(w, "T2");
    // A→B→A lossless: A gets exactly what B gained since the copy.
    expect(switchModel(w.db, w.chatId, "claude/opus", "lossless").carried).toBe(2);
    expect(getChat(w.db, w.chatId)!.backendSessionId).toBe(opus);
    expect(active(w).texts).toEqual(["T1-PROMPT", "T1-ANSWER", "T2-PROMPT", "T2-ANSWER"]);
  });

  test("Claude ↔ Claude on the same login, lossy: A→B→A resumes A's own session without B's part", () => {
    const w = started();
    const opus = getChat(w.db, w.chatId)!.backendSessionId!;
    switchModel(w.db, w.chatId, "claude/sonnet", "lossy");
    expect(getChat(w.db, w.chatId)!.backendSessionId).toBeNull();
    speak(w, "T2");
    switchModel(w.db, w.chatId, "claude/opus", "lossy");
    expect(getChat(w.db, w.chatId)!.backendSessionId).toBe(opus);
    expect(active(w).texts).toEqual(["T1-PROMPT", "T1-ANSWER"]);
    switchModel(w.db, w.chatId, "claude/sonnet", "lossy");
    expect(active(w)).toEqual({ model: "claude/sonnet", texts: ["T2-PROMPT", "T2-ANSWER"] });
  });

  test("A→B→A lossy across storages resumes A's own conversation without B's part", () => {
    const w = started();
    const opus = getChat(w.db, w.chatId)!.backendSessionId!;
    switchModel(w.db, w.chatId, "vllm/qwen", "lossy");
    speak(w, "T2");
    switchModel(w.db, w.chatId, "claude/opus", "lossy");
    expect(getChat(w.db, w.chatId)!.backendSessionId).toBe(opus);
    expect(active(w).texts).toEqual(["T1-PROMPT", "T1-ANSWER"]);
  });
});

describe("switchModel: edges", () => {
  test("choosing the current model is a no-op that says so", () => {
    const w = started();
    const before = getChat(w.db, w.chatId)!;
    expect(switchModel(w.db, w.chatId, "claude/opus", "lossless")).toEqual({ mode: "lossless", changed: false, from: "claude/opus", to: "claude/opus", carried: 0, compacted: false });
    expect(getChat(w.db, w.chatId)).toEqual(before);
    expect(w.db.select().from(modelSwitches).all()).toEqual([]);
  });

  test("lossy to a model with no conversation yet starts fresh at the next turn", () => {
    const w = started();
    switchModel(w.db, w.chatId, "vllm/qwen", "lossy");
    const chat = getChat(w.db, w.chatId)!;
    expect([chat.conversationModel, chat.backendSessionId, chat.model]).toEqual(["vllm/qwen", null, "vllm/qwen"]);
  });

  test("a target conversation that is gone lacks everything: the whole active conversation is carried onto a new one", () => {
    const w = started();
    const claudeSession = getChat(w.db, w.chatId)!.backendSessionId!;
    switchModel(w.db, w.chatId, "vllm/qwen", "lossless");
    speak(w, "T2");
    unlinkSync(findClaudeSession(claudeSession, w.configDir)!); // the CLI swept it away
    expect(switchModel(w.db, w.chatId, "claude/opus", "lossless").carried).toBe(4);
    expect(active(w).texts).toEqual(["T1-PROMPT", "T1-ANSWER", "T2-PROMPT", "T2-ANSWER"]);
    expect(getChat(w.db, w.chatId)!.backendSessionId).not.toBe(claudeSession);
  });

  test("a source whose login left the catalog carries nothing", () => {
    const w = setup();
    switchModel(w.db, w.chatId, "work/opus", "lossy");
    speak(w, "T1");
    w.db.$client.query("delete from model_providers where name = 'work'").run();
    expect(switchModel(w.db, w.chatId, "vllm/qwen", "lossless").carried).toBe(0);
  });

  test("a compaction since the conversation was entered: all the source holds is carried, and the switch says so", () => {
    const w = started();
    switchModel(w.db, w.chatId, "vllm/qwen", "lossless");
    speak(w, "T2");
    const id = getChat(w.db, w.chatId)!.backendSessionId!;
    void conversationStore(w.db, w.chatId).compact!(id, [{ role: "user", content: "SUMMARY of T1 and T2" }]);
    speak(w, "T3");
    const r = switchModel(w.db, w.chatId, "claude/opus", "lossless");
    expect([r.carried, r.compacted]).toEqual([3, true]);
    expect(JSON.stringify(claudeSessionMessages(getChat(w.db, w.chatId)!.backendSessionId!, { configDir: w.configDir }).messages)).toContain("SUMMARY of T1 and T2");
    expect(w.db.select().from(modelSwitches).all().at(-1)!.compacted).toBe(true);
  });

  test("refuses while a turn runs, and names a model the catalog does not have", () => {
    const w = setup();
    expect(() => switchModel(w.db, w.chatId, "vllm/nope", "lossy")).toThrow(/no model "vllm\/nope"/);
    const turn = claimTurn(w.db, w.chatId)!;
    expect(() => switchModel(w.db, w.chatId, "vllm/qwen", "lossy")).toThrow(/a turn is running/);
    finishTurn(w.db, turn.id, { status: "done" });
    // A chat with no conversation yet has nothing to park: it just takes the model, fresh.
    expect(switchModel(w.db, w.chatId, "vllm/qwen", "lossy")).toMatchObject({ changed: true, from: null, to: "vllm/qwen", carried: 0 });
    expect(getChat(w.db, w.chatId)!.conversationModel).toBe("vllm/qwen");
  });

  test("every switch is a row the next turn records, lossless or lossy, within a lane too", () => {
    const w = started();
    switchModel(w.db, w.chatId, "claude/sonnet", "lossy");
    switchModel(w.db, w.chatId, "vllm/qwen", "lossless");
    switchModel(w.db, w.chatId, "vllm/qwen", "lossless"); // no-op: no row
    expect(w.db.select().from(modelSwitches).all().map((s) => [s.fromModel, s.toModel, s.mode, s.carried, s.turnId])).toEqual([
      ["claude/opus", "claude/sonnet", "lossy", 0, null],
      ["claude/sonnet", "vllm/qwen", "lossless", 0, null], // sonnet had nothing yet: nothing to carry
    ]);
  });
});

describe("a chat's conversations", () => {
  test("/new forgets every model's conversation; a lost conversation only its own", () => {
    const w = started();
    switchModel(w.db, w.chatId, "claude/sonnet", "lossless");
    switchModel(w.db, w.chatId, "vllm/qwen", "lossless");
    expect(Object.keys(parked(w)).sort()).toEqual(["claude/opus", "claude/sonnet"]);
    resetConversation(w.db, w.chatId);
    expect(getChat(w.db, w.chatId)!.backendSessionId).toBeNull();
    expect(w.db.select().from(chatConversations).all()).toHaveLength(2);
    forgetConversations(w.db, w.chatId);
    expect(w.db.select().from(chatConversations).all()).toHaveLength(0);
    expect(getChat(w.db, w.chatId)!.backendSessionId).toBeNull();
    // After /new, the lossy way back to opus has nothing to resume: fresh.
    switchModel(w.db, w.chatId, "claude/opus", "lossy");
    expect(getChat(w.db, w.chatId)!.backendSessionId).toBeNull();
  });

  test("pruning keeps a conversation parked for a model in the catalog, and not one whose model was removed", () => {
    const w = setup();
    const later = () => new Date(Date.now() + 86_400_000).toISOString();
    switchModel(w.db, w.chatId, "vllm/qwen", "lossy");
    speak(w, "T1");
    const qwen = getChat(w.db, w.chatId)!.backendSessionId!;
    switchModel(w.db, w.chatId, "vllm/llama", "lossy");
    speak(w, "T2");
    const llama = getChat(w.db, w.chatId)!.backendSessionId!;
    switchModel(w.db, w.chatId, "claude/opus", "lossy");
    expect(pruneConversations(w.db, later())).toBe(0);
    expect(texts(conversationSince(w.db, qwen, null).messages)).toEqual(["T1-PROMPT", "T1-ANSWER"]);
    w.db.$client.query("delete from models where model = 'qwen'").run();
    expect(pruneConversations(w.db, later())).toBe(1);
    expect(conversationSince(w.db, qwen, null).messages).toEqual([]);
    expect(texts(conversationSince(w.db, llama, null).messages)).toEqual(["T2-PROMPT", "T2-ANSWER"]);
  });

  test("the default changed without a switch: the next turn moves lossy to the new default's own conversation", () => {
    const w = setup();
    switchModel(w.db, w.chatId, "vllm/qwen", "lossy");
    speak(w, "T1");
    const qwen = getChat(w.db, w.chatId)!.backendSessionId!;
    // The chat follows the default again; the default moves within the lane, then back.
    w.db.$client.query("update chats set model = null").run();
    setDefaultModel(w.db, "vllm/llama");
    expect(enterChatModel(w.db, getChat(w.db, w.chatId)!).id).toBe("vllm/llama");
    expect(active(w)).toEqual({ model: "vllm/llama", texts: [] });
    expect(getChat(w.db, w.chatId)!.model).toBeNull();
    speak(w, "T2");
    setDefaultModel(w.db, "vllm/qwen");
    enterChatModel(w.db, getChat(w.db, w.chatId)!);
    expect(getChat(w.db, w.chatId)!.backendSessionId).toBe(qwen);
    expect(w.db.select().from(modelSwitches).all().map((s) => [s.fromModel, s.toModel, s.mode]).slice(1)).toEqual([
      [null, "vllm/llama", "lossy"],
      [null, "vllm/qwen", "lossy"],
    ]);
  });

  test("a conversation from before models were recorded is the seeded Claude login's, even once the default is an endpoint", () => {
    const w = setup();
    const legacy = appendToClaudeSession(null, turnOf("T1"), { configDir: w.configDir, cwd: "/srv" }).sessionId;
    saveSession(w.db, w.chatId, legacy);
    setDefaultModel(w.db, "vllm/qwen");
    // The next turn moves it lossy to the endpoint: the Claude session is parked under that login's model.
    expect(enterChatModel(w.db, getChat(w.db, w.chatId)!).id).toBe("vllm/qwen");
    expect(w.db.select().from(chatConversations).all().map((l) => [l.model, l.backendSessionId])).toEqual([["claude/opus", legacy]]);
    expect(w.db.select().from(modelSwitches).all().map((s) => [s.fromModel, s.toModel, s.mode])).toEqual([[null, "vllm/qwen", "lossy"]]);
    // And an explicit lossless switch from such a chat carries the Claude conversation.
    const w2 = setup();
    const legacy2 = appendToClaudeSession(null, turnOf("T1"), { configDir: w2.configDir, cwd: "/srv" }).sessionId;
    saveSession(w2.db, w2.chatId, legacy2);
    setDefaultModel(w2.db, "vllm/qwen");
    expect(switchModel(w2.db, w2.chatId, "vllm/qwen", "lossless").carried).toBe(2);
    expect(w2.db.select().from(chatConversations).all().map((l) => [l.model, l.backendSessionId])).toEqual([["claude/opus", legacy2]]);
  });

  test("a conversation from before models were recorded, on its model: it just takes the model", () => {
    const w = setup();
    saveSession(w.db, w.chatId, "legacy-claude-session");
    expect(enterChatModel(w.db, getChat(w.db, w.chatId)!).id).toBe("claude/opus");
    expect([getChat(w.db, w.chatId)!.conversationModel, getChat(w.db, w.chatId)!.backendSessionId]).toEqual(["claude/opus", "legacy-claude-session"]);
  });
});

describe("a chat with no active conversation takes up its model's parked one", () => {
  /** T1 on opus, then lossy to qwen (opus parked); then the active conversation is gone, as the migration drops one. */
  function dropped(): World {
    const w = started();
    switchModel(w.db, w.chatId, "vllm/qwen", "lossy");
    w.db.$client.query("update chats set model = null, conversation_model = null, backend_session_id = null, entered_at = null").run();
    return w;
  }

  test("before a turn: the model's parked conversation becomes active", () => {
    const w = dropped();
    const opus = w.db.select().from(chatConversations).get()!.backendSessionId;
    expect(enterChatModel(w.db, getChat(w.db, w.chatId)!).id).toBe("claude/opus");
    expect(getChat(w.db, w.chatId)!.backendSessionId).toBe(opus);
    expect(active(w)).toEqual({ model: "claude/opus", texts: ["T1-PROMPT", "T1-ANSWER"] });
    expect(parked(w)).toEqual({});
    expect(w.db.select().from(modelSwitches).all().at(-1)).toMatchObject({ fromModel: null, toModel: "claude/opus", mode: "lossy", toSessionId: opus });
  });

  test("switchModel to the model it runs on is then no no-op: it resumes the parked one", () => {
    const w = dropped();
    expect(switchModel(w.db, w.chatId, "claude/opus", "lossy")).toMatchObject({ changed: true, from: null, to: "claude/opus", carried: 0 });
    expect(active(w)).toEqual({ model: "claude/opus", texts: ["T1-PROMPT", "T1-ANSWER"] });
    expect(parked(w)).toEqual({});
    // And now it is one.
    expect(switchModel(w.db, w.chatId, "claude/opus", "lossy").changed).toBe(false);
  });
});

describe("a lossless switch after a stopped turn carries nothing the stopped turn added", () => {
  /**
   * A turn claimed and started as the runner child starts it (its conversation's position recorded), `during`
   * written by its driver, then stopped by a switch request to `to`, which is applied. Returns the request.
   */
  function stopAndSwitch(w: World, during: () => void, to: string, mode: SwitchMode = "lossless") {
    const turn = claimTurn(w.db, w.chatId)!;
    setTurnPid(w.db, turn.id, 4242, "1");
    setTurnConversation(w.db, turn.id, { conversationStart: conversationPosition(w.db, getChat(w.db, w.chatId)!) });
    during();
    const req = requestSwitch(w.db, w.chatId, to, mode);
    switchRequestPass(w.db, () => {});
    finishTurn(w.db, turn.id, { status: "stopped" });
    const [done] = switchRequestPass(w.db, () => {});
    expect(done).toMatchObject({ id: req.id, status: "done", stoppedTurnId: turn.id });
    return done!;
  }

  test("Claude → openai-compat with a conversation: only what came before the stopped turn", () => {
    const w = started();
    switchModel(w.db, w.chatId, "vllm/qwen", "lossless");
    speak(w, "T2");
    switchModel(w.db, w.chatId, "claude/opus", "lossless");
    speak(w, "T3"); // a turn that finished
    const done = stopAndSwitch(w, () => speak(w, "T4"), "vllm/qwen"); // T4: what the stopped turn wrote
    expect(done.result).toMatchObject({ carried: 2, compacted: false });
    expect(active(w).texts).toEqual(["T1-PROMPT", "T1-ANSWER", "T2-PROMPT", "T2-ANSWER", "T3-PROMPT", "T3-ANSWER"]);
  });

  test("openai-compat → openai-compat with none: the copy stops before the stopped turn", () => {
    const w = setup();
    switchModel(w.db, w.chatId, "vllm/qwen", "lossy");
    speak(w, "T1");
    stopAndSwitch(w, () => speak(w, "T2"), "vllm/llama");
    expect(active(w)).toEqual({ model: "vllm/llama", texts: ["T1-PROMPT", "T1-ANSWER"] });
  });

  test("Claude → Claude on one login with none: a session of what came before, not a fork of all of it", () => {
    const w = started();
    const opus = getChat(w.db, w.chatId)!.backendSessionId!;
    const done = stopAndSwitch(w, () => speak(w, "T2"), "claude/sonnet");
    expect(done.result).toMatchObject({ carried: 2 });
    expect(getChat(w.db, w.chatId)!.backendSessionId).not.toBe(opus);
    expect(active(w)).toEqual({ model: "claude/sonnet", texts: ["T1-PROMPT", "T1-ANSWER"] });
    // Opus keeps its own conversation as it is, the stopped turn's part included.
    expect(parked(w)).toEqual({ "claude/opus": ["T1-PROMPT", "T1-ANSWER", "T2-PROMPT", "T2-ANSWER"] });
  });

  test("a stopped turn that wrote nothing: the fork, as without a stop", () => {
    const w = started();
    w.db.$client.query("update chats set context_tokens = 777").run();
    stopAndSwitch(w, () => {}, "claude/sonnet");
    expect(active(w)).toEqual({ model: "claude/sonnet", texts: ["T1-PROMPT", "T1-ANSWER"] });
    expect(getChat(w.db, w.chatId)!.contextTokens).toBe(777); // a fork keeps the size
  });

  test("a conversation the stopped turn opened itself carries nothing", () => {
    const w = setup();
    switchModel(w.db, w.chatId, "vllm/qwen", "lossy");
    const done = stopAndSwitch(w, () => speak(w, "T1"), "claude/opus");
    expect(done.result).toMatchObject({ carried: 0 });
    expect(active(w)).toEqual({ model: "claude/opus", texts: [] });
  });
});

describe("switch requests", () => {
  test("a switch asked for while a turn runs: the turn is stopped, no turn starts meanwhile, then the switch is applied", () => {
    const w = started();
    const turn = claimTurn(w.db, w.chatId)!;
    setTurnPid(w.db, turn.id, 4242, "1");
    const req = requestSwitch(w.db, w.chatId, "vllm/qwen", "lossless");
    expect(req.status).toBe("pending");
    const signals: string[] = [];
    const signal = (pid: number, _start: string | null, sig: string) => void signals.push(`${pid}:${sig}`);

    expect(switchRequestPass(w.db, signal)).toEqual([]);
    expect(signals).toEqual(["4242:SIGTERM"]);
    expect(getSwitchRequest(w.db, req.id)!.stoppedTurnId).toBe(turn.id);
    expect(getTurn(w.db, turn.id)!.stopSeq).toBe(turn.fromSeq);
    // Still running on the next pass: not signalled again, still pending.
    expect(switchRequestPass(w.db, signal)).toEqual([]);
    expect(signals).toHaveLength(1);

    // The child closes the turn; its input is not consumed: the new model's next turn answers it.
    const cursor = getChat(w.db, w.chatId)!.cursorSeq;
    finishTurn(w.db, turn.id, { status: "stopped" });
    expect(getChat(w.db, w.chatId)!.cursorSeq).toBe(cursor);
    // The waker does not start a turn while the request is pending.
    expect(wakerPass({ db: w.db, spawn: () => 1, alive: () => true }).started).toEqual([]);

    const [done] = switchRequestPass(w.db, signal);
    expect(done).toMatchObject({ id: req.id, status: "done", stoppedTurnId: turn.id, error: null, result: { mode: "lossless", changed: true, from: "claude/opus", to: "vllm/qwen", carried: 2, compacted: false } });
    expect(getChat(w.db, w.chatId)!.conversationModel).toBe("vllm/qwen");
    // Applied: the waker starts the next turn, on the new model, for the same messages.
    const { started: next } = wakerPass({ db: w.db, spawn: () => 1, alive: () => true, startOf: () => "1" });
    expect(next).toHaveLength(1);
    expect(getTurn(w.db, next[0]!)!.fromSeq).toBe(turn.fromSeq);
  });

  test("with nothing running it applies at once; a failure is stored on the request; switchModel stays callable directly", () => {
    const w = started();
    const ok = requestSwitch(w.db, w.chatId, "claude/sonnet", "lossy");
    const bad = requestSwitch(w.db, w.chatId, "vllm/llama", "lossy");
    w.db.$client.query("delete from models where model = 'llama'").run();
    expect(switchRequestPass(w.db, () => {}).map((r) => [r.id, r.status, r.error])).toEqual([
      [ok.id, "done", null],
      [bad.id, "failed", 'there is no model "vllm/llama" in the catalog'],
    ]);
    expect(runningTurnFor(w.db, w.chatId)).toBeUndefined();
    expect(() => requestSwitch(w.db, w.chatId, "vllm/nope", "lossy")).toThrow(/no model/);
    expect(switchModel(w.db, w.chatId, "claude/opus", "lossy")).toMatchObject({ changed: true, from: "claude/sonnet" });
  });
});
