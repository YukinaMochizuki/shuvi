import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "agent-runtime/openai-compat";
import { conversationMatchesBackend, openAICompatBackend, openAIConversationPrefix } from "../src/agent/backend.ts";
import { runTurn } from "../src/agent/turn.ts";
import { conversationLabel } from "../src/console/pages.ts";
import { chatGrouping, conversationOf } from "../src/console/sessions.ts";
import type { Config } from "../src/env.ts";
import { conversationStore } from "../src/store/conversations.ts";
import { controlMessagesOf } from "../src/store/control.ts";
import { getChat } from "../src/store/events.ts";
import { getTranscript, stepsOf } from "../src/store/transcripts.ts";
import { claimTurn, finishTurn, getTurn, saveSession, setTurnConversation } from "../src/store/turns.ts";
import { memDb, ownerChatId, ownerSays, ScriptedAdapter } from "./helpers.ts";

const dirs: string[] = [];
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function config(): Config {
  const dataDir = mkdtempSync(join(tmpdir(), "shuvi-backend-turn-"));
  dirs.push(dataDir);
  return {
    botToken: "", ownerId: 1001, dataDir, dbPath: join(dataDir, "shuvi.db"), home: join(dataDir, "home"),
    backend: "openai-compat", model: "test-model", timeZone: "UTC", turnMaxMs: 1, outboundAlertMs: 1,
    transcriptDays: 1, secretsFile: join(dataDir, "secrets"), console: { listen: "127.0.0.1:8787" },
    openAICompat: { baseURL: "http://127.0.0.1:8000/v1", contextWindow: 100_000, vision: false },
  };
}

const reply = () => new Response([
  { choices: [{ index: 0, delta: { role: "assistant", content: "continued" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
].map((chunk) => `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test-model", ...chunk })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });

function seed(cfg: Config) {
  const db = memDb();
  ownerSays(db, "earlier chat message");
  const chatId = ownerChatId(db);
  const id = `${openAIConversationPrefix(cfg, chatId)}saved`;
  saveSession(db, chatId, id);
  const previous = claimTurn(db, chatId)!;
  setTurnConversation(db, previous.id, { backendSessionId: id, opening: "first" });
  finishTurn(db, previous.id, { status: "done" });
  ownerSays(db, "continue please");
  return { db, chatId, id };
}

async function realTurn(db: ReturnType<typeof memDb>, cfg: Config) {
  const chatId = ownerChatId(db);
  const turn = claimTurn(db, chatId)!;
  const outcome = await runTurn({
    db, turnId: turn.id, home: cfg.home, timeZone: "UTC", model: cfg.model, capabilities: [],
    conversationMatches: (id, chat) => conversationMatchesBackend(id, cfg, chat),
    makeAdapter: (boundary, note) => openAICompatBackend(db, cfg, chatId, boundary, note),
  });
  return { outcome, turn: getTurn(db, turn.id)!, steps: stepsOf(db, turn.id) };
}

describe("runTurn: backend scope changes", () => {
  for (const change of ["backend", "model", "endpoint", "to Claude"] as const) {
    test(`${change} starts fresh with a recorded reason and recent history`, async () => {
      const cfg = config();
      const { db, chatId, id } = seed(cfg);
      await conversationStore(db, chatId).append(id, [{ role: "user", content: "old model history" }]);
      if (change === "backend") saveSession(db, chatId, "legacy-claude-session");
      if (change === "model") cfg.model = "another-model";
      if (change === "endpoint") cfg.openAICompat!.baseURL = "http://127.0.0.1:9000/v1";
      if (change === "to Claude") cfg.backend = "claude";
      const turn = claimTurn(db, chatId)!;
      let adapter!: ScriptedAdapter;
      try {
        expect(await runTurn({
          db, turnId: turn.id, home: cfg.home, timeZone: "UTC", capabilities: [],
          conversationMatches: (session, chat) => conversationMatchesBackend(session, cfg, chat),
          makeAdapter: (boundary) => (adapter = new ScriptedAdapter(boundary, [{ token: "fresh" }])),
        })).toBe("done");
        expect(adapter.calls.map((call) => call.method)).toEqual(["run"]);
        expect(adapter.calls[0]!.prompt).toContain("earlier chat message");
        expect(getTurn(db, turn.id)!.opening).toBe("changed");
        expect(getTranscript(db, turn.id)!.resumed).toBe(false);
        expect(stepsOf(db, turn.id).some((step) => step.kind === "note" && step.text?.includes("Backend settings changed"))).toBe(true);
        const alert = controlMessagesOf(db, "alert")[0]!;
        expect(alert.idemKey).toBe(`backend-changed:${turn.id}`);
        expect(alert.text).not.toContain("/new");
        const conversation = conversationOf(db, chatId, turn.id)!.conversation;
        expect(conversation.start).toBe("changed");
        expect(new Set(chatGrouping(db, chatId).map((item) => item.conversationId)).size).toBe(2);
        expect(conversationLabel(conversation)).toBe("A fresh conversation after backend settings changed");
        expect(await conversationStore(db, chatId).load(id)).toEqual([{ role: "user", content: "old model history" }]);
      } finally {
        db.$client.close();
      }
    });
  }

  test("key rotation and legacy Claude ids resume without a change alert", async () => {
    for (const backend of ["claude", "openai-compat"] as const) {
      const cfg = config();
      const { db, chatId } = seed(cfg);
      cfg.backend = backend;
      if (backend === "claude") saveSession(db, chatId, "legacy-claude-session");
      else cfg.openAICompat!.apiKey = "rotated-test-key";
      const turn = claimTurn(db, chatId)!;
      let adapter!: ScriptedAdapter;
      try {
        expect(await runTurn({
          db, turnId: turn.id, home: cfg.home, timeZone: "UTC", capabilities: [],
          conversationMatches: (session, chat) => conversationMatchesBackend(session, cfg, chat),
          makeAdapter: (boundary) => (adapter = new ScriptedAdapter(boundary, [{ token: "resumed" }])),
        })).toBe("done");
        expect(adapter.calls.map((call) => call.method)).toEqual(["continueRun"]);
        expect(getTurn(db, turn.id)!.opening).toBe("resumed");
        expect(controlMessagesOf(db, "alert")).toHaveLength(0);
      } finally {
        db.$client.close();
      }
    }
  });
});

describe("runTurn: real OpenAI-compatible driver failures", () => {
  for (const failure of ["5xx", "network"] as const) {
    test(`${failure} preserves the session and resumes it on retry`, async () => {
      const cfg = config();
      const { db, chatId, id } = seed(cfg);
      await conversationStore(db, chatId).append(id, [{ role: "user", content: "durable history" }]);
      // Even an API error containing the Claude CLI marker is not a missing local conversation.
      const message = "No conversation found with session ID: upstream-error";
      let requests = 0;
      globalThis.fetch = (async (_input, _init) => {
        requests++;
        if (failure === "network") throw new TypeError(message);
        return Response.json({ error: { message, type: "server_error" } }, { status: 503 });
      }) as typeof fetch;
      try {
        const failed = await realTurn(db, cfg);
        expect(requests).toBeGreaterThan(0);
        expect(failed.outcome).toBe("failed");
        expect(failed.turn.opening).toBe("resumed");
        expect(failed.turn.backendSessionId).toBe(id);
        expect(getChat(db, chatId)!.backendSessionId).toBe(id);
        expect(controlMessagesOf(db, "alert").some((alert) => alert.idemKey?.startsWith("lost-session:"))).toBe(false);
        expect((await conversationStore(db, chatId).load(id))[0]!.content).toBe("durable history");
        globalThis.fetch = (async (_url, init) => {
          expect(String(init?.body)).toContain("durable history");
          return reply();
        }) as typeof fetch;
        const retried = await realTurn(db, cfg);
        expect(retried.outcome).toBe("done");
        expect(retried.turn.backendSessionId).toBe(id);
        expect(retried.turn.opening).toBe("resumed");
      } finally {
        db.$client.close();
      }
    }, 20_000);
  }
});

describe("runTurn: constructor compaction reports", () => {
  const secret = "sensitive-provider-response";
  const history = (): ModelMessage[] => Array.from({ length: 10 }, (_, i): ModelMessage[] => [
    { role: "user", content: `old question ${i} ${"x".repeat(400)}` },
    { role: "assistant", content: `old answer ${i}` },
  ]).flat();

  for (const pruned of [false, true]) {
    test(`summary failure is a safe note ${pruned ? "with a successful prune" : "even when history is unchanged"}`, async () => {
      const cfg = config();
      cfg.openAICompat!.contextWindow = 100;
      const { db, chatId, id } = seed(cfg);
      const before = history();
      if (pruned) before[0] = { role: "user", content: [{ type: "file", mediaType: "image/png", data: "aGVsbG8=" }] };
      await conversationStore(db, chatId).append(id, before);
      let summaries = 0;
      globalThis.fetch = (async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { stream?: boolean };
        if (body.stream) return reply();
        summaries++;
        return Response.json({ error: { message: secret, type: "invalid_request_error" } }, { status: 400 });
      }) as typeof fetch;
      try {
        const result = await realTurn(db, cfg);
        expect(result.outcome).toBe("done");
        expect(summaries).toBe(1);
        const notes = result.steps.filter((step) => step.kind === "note");
        expect(notes).toHaveLength(1);
        expect(notes[0]!.text).toContain("could not summarize");
        expect(JSON.stringify(result.steps)).not.toContain(secret);
        expect(result.steps.filter((step) => step.kind === "compaction")).toHaveLength(pruned ? 1 : 0);
        expect(getChat(db, ownerChatId(db))!.backendSessionId).toBe(id);
      } finally {
        db.$client.close();
      }
    });
  }

  test("rejected compaction is noted without exposing the rejected tool call id", async () => {
    const cfg = config();
    cfg.openAICompat!.contextWindow = 100;
    const { db, chatId, id } = seed(cfg);
    const before = history();
    before.push({ role: "tool", content: [{ type: "tool-result", toolCallId: secret, toolName: "example", output: { type: "text", value: "orphaned result" } }] });
    await conversationStore(db, chatId).append(id, before);
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { stream?: boolean };
      if (body.stream) return reply();
      return Response.json({ id: "summary", object: "chat.completion", created: 1, model: "test-model", choices: [{ index: 0, message: { role: "assistant", content: "short summary" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
    }) as typeof fetch;
    try {
      const result = await realTurn(db, cfg);
      expect(result.outcome).toBe("done");
      const notes = result.steps.filter((step) => step.kind === "note");
      expect(notes).toHaveLength(1);
      expect(notes[0]!.text).toContain("rejected the replacement history");
      expect(JSON.stringify(notes)).not.toContain(secret);
      expect(result.steps.filter((step) => step.kind === "compaction")).toHaveLength(0);
      expect((await conversationStore(db, chatId).load(id)).slice(0, before.length)).toEqual(before);
    } finally {
      db.$client.close();
    }
  });
});
