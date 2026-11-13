import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "agent-runtime/openai-compat";
import { appendToClaudeSession } from "agent-runtime/convert";
import { makeDriver } from "../src/agent/backend.ts";
import { enterChatModel, switchModel } from "../src/agent/switch.ts";
import { runTurn } from "../src/agent/turn.ts";
import { conversationLabel } from "../src/console/pages.ts";
import { conversationOf } from "../src/console/sessions.ts";
import { conversationStore } from "../src/store/conversations.ts";
import { controlMessagesOf } from "../src/store/control.ts";
import { getChat } from "../src/store/events.ts";
import { addModel, addProvider, setDefaultModel } from "../src/store/models.ts";
import { stepsOf } from "../src/store/transcripts.ts";
import { claimTurn, finishTurn, getTurn, saveSession, setTurnConversation } from "../src/store/turns.ts";
import { memDb, ownerChatId, ownerSays, ScriptedAdapter } from "./helpers.ts";

const dirs: string[] = [];
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const reply = () => new Response([
  { choices: [{ index: 0, delta: { role: "assistant", content: "continued" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
].map((chunk) => `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test-model", ...chunk })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });

/** A catalog whose default is an OpenAI-compatible model with no key. */
function catalog(db: ReturnType<typeof memDb>, contextWindow = 100_000) {
  addProvider(db, { name: "local", kind: "openai-compat", baseUrl: "http://127.0.0.1:8000/v1" });
  return addModel(db, { provider: "local", model: "test-model", contextWindow, isDefault: true });
}

/** A chat whose conversation `saved` is in the OpenAI-compatible lane, after one turn, with a new message. */
function seed(contextWindow?: number) {
  const db = memDb();
  catalog(db, contextWindow);
  ownerSays(db, "earlier chat message");
  const chatId = ownerChatId(db);
  const id = "saved";
  saveSession(db, chatId, id);
  enterChatModel(db, getChat(db, chatId)!);
  const previous = claimTurn(db, chatId)!;
  setTurnConversation(db, previous.id, { backendSessionId: id, opening: "first" });
  finishTurn(db, previous.id, { status: "done" });
  ownerSays(db, "continue please");
  return { db, chatId, id };
}

/** One turn as the runner child runs it: the chat's model from the catalog, its driver built from it. */
async function realTurn(db: ReturnType<typeof memDb>) {
  const chatId = ownerChatId(db);
  const turn = claimTurn(db, chatId)!;
  const model = enterChatModel(db, getChat(db, chatId)!);
  const outcome = await runTurn({
    db, turnId: turn.id, home: join(tmp("shuvi-home-"), "home"), timeZone: "UTC", model: model.model.model, capabilities: [],
    makeAdapter: (boundary, note) => makeDriver({ db, chatId, model, boundary, note, secretsFile: "/nonexistent" }),
  });
  return { outcome, turn: getTurn(db, turn.id)!, steps: stepsOf(db, turn.id) };
}

describe("runTurn after a switch", () => {
  test("lossless from a Claude conversation: the next turn on the OpenAI-compatible model is sent it, records `switched` and a note", async () => {
    const db = memDb();
    const configDir = tmp("shuvi-claude-");
    addProvider(db, { name: "claude", kind: "claude", configDir });
    addModel(db, { provider: "claude", model: "opus", isDefault: true });
    addProvider(db, { name: "local", kind: "openai-compat", baseUrl: "http://127.0.0.1:8000/v1" });
    addModel(db, { provider: "local", model: "test-model", contextWindow: 100_000 });
    ownerSays(db, "hello on claude");
    const chatId = ownerChatId(db);
    // The chat's Claude conversation, as a Claude Code session file.
    const claude = appendToClaudeSession(null, [{ role: "user", content: "CLAUDE-QUESTION" }, { role: "assistant", content: [{ type: "text", text: "CLAUDE-ANSWER" }] }], { configDir, cwd: "/srv" });
    saveSession(db, chatId, claude.sessionId);
    enterChatModel(db, getChat(db, chatId)!);
    const first = claimTurn(db, chatId)!;
    finishTurn(db, first.id, { status: "done" });
    expect(switchModel(db, chatId, "local/test-model", "lossless")).toEqual({ mode: "lossless", changed: true, from: "claude/opus", to: "local/test-model", carried: 2, compacted: false, resumed: false });
    ownerSays(db, "now on the endpoint");
    let body = "";
    globalThis.fetch = (async (_url, init) => ((body = String(init?.body)), reply())) as typeof fetch;
    try {
      const result = await realTurn(db);
      expect(result.outcome).toBe("done");
      expect(body).toContain("CLAUDE-QUESTION");
      expect(body).toContain("CLAUDE-ANSWER");
      expect(body).not.toContain("switched"); // the model is not told
      expect(result.turn.opening).toBe("switched");
      expect(result.steps.find((step) => step.kind === "note")?.text).toBe("Model switched from claude/opus to local/test-model, lossless: 2 messages carried into its conversation.");
      const conversation = conversationOf(db, chatId, result.turn.id)!.conversation;
      expect(conversation.start).toBe("switched");
      expect(conversationLabel(conversation)).toBe("Another conversation, after the model was switched");
    } finally {
      db.$client.close();
    }
  });

  test("a lossy switch to another model of the same lane opens that model's own conversation: fresh, `switched`, with a note", async () => {
    const { db, chatId, id } = seed();
    addModel(db, { provider: "local", model: "other-model", contextWindow: 100_000 });
    expect(switchModel(db, chatId, "local/other-model", "lossy")).toMatchObject({ changed: true, carried: 0 });
    const turn = claimTurn(db, chatId)!;
    let adapter!: ScriptedAdapter;
    try {
      expect(await runTurn({ db, turnId: turn.id, home: join(tmp("shuvi-home-"), "home"), timeZone: "UTC", capabilities: [], makeAdapter: (b) => (adapter = new ScriptedAdapter(b, [{ token: "fresh" }])) })).toBe("done");
      expect(adapter.calls.map((call) => call.method)).toEqual(["run"]);
      expect(adapter.calls[0]!.prompt).toContain("earlier chat message"); // fresh: it opens with the last messages
      expect(getTurn(db, turn.id)!.opening).toBe("switched");
      expect(getTurn(db, turn.id)!.backendSessionId).not.toBe(id);
      expect(stepsOf(db, turn.id).find((step) => step.kind === "note")?.text).toBe(
        "Model switched from local/test-model to local/other-model, lossy: it had no conversation, so a fresh one opens with the chat's last messages.",
      );
      expect(db.$client.query("select backend_session_id as s from chat_conversations where chat_id = ? and model = 'local/test-model'").get(chatId)).toEqual({ s: id });
    } finally {
      db.$client.close();
    }
  });

  test("a default moved to another model without a switch: the next turn moves lossy, and the earlier model's conversation is kept", async () => {
    const { db, chatId, id } = seed();
    addProvider(db, { name: "claude", kind: "claude", configDir: tmp("shuvi-claude-") });
    addModel(db, { provider: "claude", model: "opus" });
    setDefaultModel(db, "claude/opus");
    const turn = claimTurn(db, chatId)!;
    let adapter!: ScriptedAdapter;
    try {
      enterChatModel(db, getChat(db, chatId)!);
      expect(await runTurn({ db, turnId: turn.id, home: join(tmp("shuvi-home-"), "home"), timeZone: "UTC", capabilities: [], makeAdapter: (b) => (adapter = new ScriptedAdapter(b, [{ token: "fresh" }])) })).toBe("done");
      expect(adapter.calls.map((call) => call.method)).toEqual(["run"]);
      expect(adapter.calls[0]!.prompt).toContain("earlier chat message"); // a fresh lane opens with the last messages
      expect(getTurn(db, turn.id)!.opening).toBe("switched");
      expect(stepsOf(db, turn.id).find((step) => step.kind === "note")?.text).toBe(
        "The chat moved to claude/opus without a switch (its default changed, or it took up that model's parked conversation), lossy: it had no conversation, so a fresh one opens with the chat's last messages.",
      );
      expect(db.$client.query("select backend_session_id as s from chat_conversations where chat_id = ? and model = 'local/test-model'").get(chatId)).toEqual({ s: id });
    } finally {
      db.$client.close();
    }
  });
});

describe("runTurn: several switches, and a driver that cannot be built", () => {
  test("every switch since the last turn is noted, and makes the opening `switched`", async () => {
    const { db, chatId } = seed();
    addProvider(db, { name: "claude", kind: "claude", configDir: tmp("shuvi-claude-") });
    addModel(db, { provider: "claude", model: "opus" });
    addModel(db, { provider: "local", model: "other-model", contextWindow: 100_000 });
    switchModel(db, chatId, "claude/opus", "lossy");
    switchModel(db, chatId, "local/other-model", "lossy");
    const turn = claimTurn(db, chatId)!;
    try {
      expect(await runTurn({ db, turnId: turn.id, home: join(tmp("shuvi-home-"), "home"), timeZone: "UTC", capabilities: [], makeAdapter: (b) => new ScriptedAdapter(b, [{ token: "ok" }]) })).toBe("done");
      expect(getTurn(db, turn.id)!.opening).toBe("switched");
      expect(stepsOf(db, turn.id).filter((step) => step.kind === "note").map((step) => step.text)).toEqual([
        "Model switched from local/test-model to claude/opus, lossy: it had no conversation, so a fresh one opens with the chat's last messages.",
        "Model switched from claude/opus to local/other-model, lossy: it had no conversation, so a fresh one opens with the chat's last messages.",
      ]);
    } finally {
      db.$client.close();
    }
  });

  test("a driver that cannot be built fails the turn, saying why, redacted", async () => {
    const { db, chatId } = seed();
    const turn = claimTurn(db, chatId)!;
    try {
      const outcome = await runTurn({
        db, turnId: turn.id, home: join(tmp("shuvi-home-"), "home"), timeZone: "UTC", capabilities: [],
        record: { dataDir: tmp("shuvi-data-"), redact: (text) => text.replaceAll("sk-secret", "[REDACTED]") },
        makeAdapter: () => {
          throw new Error("the key endpoint.API_KEY is not in the secrets file (sk-secret)");
        },
      });
      expect(outcome).toBe("failed");
      expect(getTurn(db, turn.id)!.error).toBe("the key endpoint.API_KEY is not in the secrets file ([REDACTED])");
    } finally {
      db.$client.close();
    }
  });
});

describe("runTurn: real OpenAI-compatible driver failures", () => {
  for (const failure of ["5xx", "network"] as const) {
    test(`${failure} preserves the session and resumes it on retry`, async () => {
      const { db, chatId, id } = seed();
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
        const failed = await realTurn(db);
        expect(requests).toBeGreaterThan(0);
        expect(failed.outcome).toBe("failed");
        expect(failed.turn.opening).toBe("resumed");
        expect(failed.turn.backendSessionId).toBe(id);
        expect(getChat(db, chatId)!.backendSessionId).toBe(id);
        expect(controlMessagesOf(db, "alert").some((alert) => alert.idemKey?.startsWith("lost-session:"))).toBe(false);
        expect((await conversationStore(db, chatId).load(id))![0]!.content).toBe("durable history");
        globalThis.fetch = (async (_url, init) => {
          expect(String(init?.body)).toContain("durable history");
          return reply();
        }) as typeof fetch;
        const retried = await realTurn(db);
        expect(retried.outcome).toBe("done");
        expect(retried.turn.backendSessionId).toBe(id);
        expect(retried.turn.opening).toBe("resumed");
      } finally {
        db.$client.close();
      }
    }, 20_000);
  }

  test("a history that is gone (its row deleted) is lost: the real driver says so, and the turn starts over fresh", async () => {
    const { db, chatId, id } = seed();
    await conversationStore(db, chatId).append(id, [{ role: "user", content: "durable history" }]);
    db.$client.query("delete from conversations where id = ?").run(id);
    const bodies: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      bodies.push(String(init?.body));
      return reply();
    }) as typeof fetch;
    try {
      const r = await realTurn(db);
      expect(r.outcome).toBe("done");
      expect(r.turn.opening).toBe("lost");
      expect(r.turn.backendSessionId).not.toBe(id);
      expect(controlMessagesOf(db, "alert").some((alert) => alert.idemKey === `lost-session:${r.turn.id}`)).toBe(true);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).not.toContain("durable history");
      expect(bodies[0]).toContain("earlier chat message");
    } finally {
      db.$client.close();
    }
  }, 20_000);
});

describe("runTurn: constructor compaction reports", () => {
  const secret = "sensitive-provider-response";
  const history = (): ModelMessage[] => Array.from({ length: 10 }, (_, i): ModelMessage[] => [
    { role: "user", content: `old question ${i} ${"x".repeat(400)}` },
    { role: "assistant", content: `old answer ${i}` },
  ]).flat();

  for (const pruned of [false, true]) {
    test(`summary failure is a safe note ${pruned ? "with a successful prune" : "even when history is unchanged"}`, async () => {
      const { db, chatId, id } = seed(100);
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
        const result = await realTurn(db);
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
    const { db, chatId, id } = seed(100);
    const before = history();
    before.push({ role: "tool", content: [{ type: "tool-result", toolCallId: secret, toolName: "example", output: { type: "text", value: "orphaned result" } }] });
    await conversationStore(db, chatId).append(id, before);
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { stream?: boolean };
      if (body.stream) return reply();
      return Response.json({ id: "summary", object: "chat.completion", created: 1, model: "test-model", choices: [{ index: 0, message: { role: "assistant", content: "short summary" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
    }) as typeof fetch;
    try {
      const result = await realTurn(db);
      expect(result.outcome).toBe("done");
      const notes = result.steps.filter((step) => step.kind === "note");
      expect(notes).toHaveLength(1);
      expect(notes[0]!.text).toContain("rejected the replacement history");
      expect(JSON.stringify(notes)).not.toContain(secret);
      expect(result.steps.filter((step) => step.kind === "compaction")).toHaveLength(0);
      expect((await conversationStore(db, chatId).load(id))!.slice(0, before.length)).toEqual(before);
    } finally {
      db.$client.close();
    }
  });
});
