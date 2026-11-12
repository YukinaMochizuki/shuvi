import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, type ToolBundle, type ToolBoundary } from "agent-runtime";
import { z } from "zod";
import { backendFromEnv, type Config } from "../src/env.ts";
import { conversationMatchesBackend, openAICompatBackend, openAIConversationPrefix } from "../src/agent/backend.ts";
import { conversationStore, LostConversationError } from "../src/store/conversations.ts";
import { openDb } from "../src/store/db.ts";
import type { ModelMessage } from "agent-runtime/openai-compat";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("backend configuration", () => {
  test("Claude remains the default and OpenAI-compatible settings are explicit", () => {
    expect(backendFromEnv({})).toEqual({ backend: "claude" });
    expect(backendFromEnv({ SHUVI_BACKEND: "openai-compat", SHUVI_MODEL: " local-model ", SHUVI_OPENAI_BASE_URL: "http://localhost:8000/v1/", SHUVI_OPENAI_CONTEXT_WINDOW: "32768" })).toEqual({
      backend: "openai-compat",
      openAICompat: { baseURL: "http://localhost:8000/v1", contextWindow: 32768, vision: false },
    });
    expect(backendFromEnv({ SHUVI_BACKEND: "openai-compat", SHUVI_MODEL: "x", SHUVI_OPENAI_BASE_URL: "https://api.example/v1", SHUVI_OPENAI_CONTEXT_WINDOW: "1", SHUVI_OPENAI_VISION: "true", SHUVI_OPENAI_API_KEY: "secret" }).openAICompat).toMatchObject({ vision: true, apiKey: "secret" });
  });

  test("rejects unknown, incomplete, or unsafe endpoint settings without echoing values", () => {
    expect(() => backendFromEnv({ SHUVI_BACKEND: "other" })).toThrow("SHUVI_BACKEND");
    expect(() => backendFromEnv({ SHUVI_BACKEND: "openai-compat" })).toThrow("SHUVI_MODEL");
    expect(() => backendFromEnv({ SHUVI_BACKEND: "openai-compat", SHUVI_MODEL: "m", SHUVI_OPENAI_BASE_URL: "not-a-url-secret", SHUVI_OPENAI_CONTEXT_WINDOW: "2" })).toThrow("SHUVI_OPENAI_BASE_URL");
    expect(() => backendFromEnv({ SHUVI_BACKEND: "openai-compat", SHUVI_MODEL: "m", SHUVI_OPENAI_BASE_URL: "https://u:p@example/v1", SHUVI_OPENAI_CONTEXT_WINDOW: "2" })).toThrow("SHUVI_OPENAI_BASE_URL");
    expect(() => backendFromEnv({ SHUVI_BACKEND: "openai-compat", SHUVI_MODEL: "m", SHUVI_OPENAI_BASE_URL: "https://example/v1?token=secret", SHUVI_OPENAI_CONTEXT_WINDOW: "2" })).toThrow("SHUVI_OPENAI_BASE_URL");
    expect(() => backendFromEnv({ SHUVI_BACKEND: "openai-compat", SHUVI_MODEL: "   ", SHUVI_OPENAI_BASE_URL: "https://example/api", SHUVI_OPENAI_CONTEXT_WINDOW: "2" })).toThrow("SHUVI_MODEL");
    expect(() => backendFromEnv({ SHUVI_BACKEND: "openai-compat", SHUVI_MODEL: "m", SHUVI_OPENAI_BASE_URL: "https://example/v1", SHUVI_OPENAI_CONTEXT_WINDOW: "1.5" })).toThrow("SHUVI_OPENAI_CONTEXT_WINDOW");
    expect(() => backendFromEnv({ SHUVI_BACKEND: "openai-compat", SHUVI_MODEL: "m", SHUVI_OPENAI_BASE_URL: "https://example/v1", SHUVI_OPENAI_CONTEXT_WINDOW: "2", SHUVI_OPENAI_VISION: "yes" })).toThrow("SHUVI_OPENAI_VISION");
  });
});

describe("OpenAI-compatible conversation persistence", () => {
  test("appends across DB connections and compaction replaces the durable history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shuvi-conversation-"));
    dirs.push(dir);
    const db1 = openDb(join(dir, "shuvi.db"), { migrate: true });
    const first = conversationStore(db1);
    const id = "openai-compat:identity:42:session";
    const old: ModelMessage = { role: "user", content: "hello" };
    const compacted: ModelMessage = { role: "user", content: "summary" };
    await first.append(id, [old]);
    const db2 = openDb(join(dir, "shuvi.db"));
    const second = conversationStore(db2);
    await second.append(id, [{ role: "assistant", content: "hi" }]);
    expect((await second.load(id)).map((m) => m.content)).toEqual(["hello", "hi"]);
    await second.compact!(id, [compacted]);
    expect(await first.load(id)).toEqual([compacted]);
    db1.$client.close();
    db2.$client.close();
  });

  test("missing history has a dedicated lost-conversation error; malformed history remains a parse error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shuvi-conversation-"));
    dirs.push(dir);
    const db = openDb(join(dir, "shuvi.db"), { migrate: true });
    const store = conversationStore(db);
    await expect(store.load("missing")).rejects.toBeInstanceOf(LostConversationError);
    db.$client.query("insert into kv (key, value) values (?, ?)").run("conversation:broken", "{");
    await expect(store.load("broken")).rejects.toBeInstanceOf(SyntaxError);
    db.$client.query("insert into kv (key, value) values (?, ?)").run("conversation:wrong-shape", "{}");
    await expect(store.load("wrong-shape")).rejects.toThrow("must be an array");
    db.$client.close();
  });

  test("separate processes append without losing concurrent writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shuvi-conversation-processes-"));
    dirs.push(dir);
    const path = join(dir, "shuvi.db");
    const db = openDb(path, { migrate: true });
    const script = `
      import { openDb } from ${JSON.stringify(new URL("../src/store/db.ts", import.meta.url).href)};
      import { conversationStore } from ${JSON.stringify(new URL("../src/store/conversations.ts", import.meta.url).href)};
      const db = openDb(process.argv[1]);
      const store = conversationStore(db);
      for (let n = 0; n < 20; n++) await store.append("shared", [{ role: "user", content: process.argv[2] + ":" + n }]);
      db.$client.close();
    `;
    try {
      await Promise.all([0, 1, 2].map(async (worker) => {
        const child = Bun.spawn([process.execPath, "-e", script, path, String(worker)], { stdout: "ignore", stderr: "pipe" });
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        if (code !== 0) throw new Error(`conversation writer ${worker} exited ${code}: ${stderr}`);
      }));
      const history = await conversationStore(db).load("shared");
      expect(history).toHaveLength(60);
      expect(new Set(history.map((message) => message.content)).size).toBe(60);
    } finally {
      db.$client.close();
    }
  });
});

describe("conversation backend identity", () => {
  const config = (baseURL: string, model: string): Config => ({
    botToken: "", ownerId: 1, dataDir: "/tmp", dbPath: "/tmp/shuvi.db", home: "/tmp/home", model, backend: "openai-compat",
    openAICompat: { baseURL, contextWindow: 1000, vision: false }, timeZone: "UTC", turnMaxMs: 1, outboundAlertMs: 1, transcriptDays: 1, secretsFile: "/tmp/secrets", console: { listen: "127.0.0.1:8787" },
  });

  test("scopes session ids to backend, endpoint, model, and chat", () => {
    const a = config("http://localhost:8000/v1", "model-a");
    const id = `${openAIConversationPrefix(a, 7)}session`;
    expect(conversationMatchesBackend(id, a, 7)).toBe(true);
    expect(conversationMatchesBackend(id, config("http://localhost:9000/v1", "model-a"), 7)).toBe(false);
    expect(conversationMatchesBackend(id, config("http://localhost:8000/v1", "model-b"), 7)).toBe(false);
    expect(conversationMatchesBackend(id, a, 8)).toBe(false);
    expect(conversationMatchesBackend(id, { ...a, openAICompat: { ...a.openAICompat!, apiKey: "rotated-key" } }, 7)).toBe(true);
    expect(backendFromEnv({ SHUVI_BACKEND: "openai-compat", SHUVI_MODEL: "m", SHUVI_OPENAI_BASE_URL: "https://example/api/", SHUVI_OPENAI_CONTEXT_WINDOW: "2" }).openAICompat?.baseURL).toBe("https://example/api");
    expect(conversationMatchesBackend("legacy-claude-session", { ...a, backend: "claude" }, 7)).toBe(true);
    expect(conversationMatchesBackend(id, { ...a, backend: "claude" }, 7)).toBe(false);
  });
});

describe("OpenAI-compatible backend factory over mocked fetch", () => {
  const chunk = (delta: unknown, finish: string | null = null, usage?: unknown) => ({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  });
  const sse = (chunks: unknown[]) => new Response(chunks.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  const toolCall = (id: string, text: string) => [
    chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id, type: "function", function: { name: "tests__echo", arguments: JSON.stringify({ text }) } }] }),
    chunk({}, "tool_calls"),
  ];
  const answer = (text: string) => [chunk({ role: "assistant", content: text }), chunk({}, "stop", { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 })];
  const config = (): Config => ({
    botToken: "", ownerId: 1, dataDir: "/tmp", dbPath: "/tmp/shuvi.db", home: "/tmp/home", model: "test-model", backend: "openai-compat",
    openAICompat: { baseURL: "https://endpoint.example/api", apiKey: "test-key", contextWindow: 100_000, vision: false },
    timeZone: "UTC", turnMaxMs: 1, outboundAlertMs: 1, transcriptDays: 1, secretsFile: "/tmp/secrets", console: { listen: "127.0.0.1:8787" },
  });

  test("persists a successful and refused boundary call, then resumes through the same factory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shuvi-backend-wire-"));
    dirs.push(dir);
    const db = openDb(join(dir, "shuvi.db"), { migrate: true });
    const requests: Array<{ model: string; messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[] }> }> = [];
    const responses = [toolCall("success", "run"), toolCall("refusal", "deny"), answer("finished"), answer("resumed")];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as (typeof requests)[number]);
      return sse(responses[requests.length - 1]!);
    }) as typeof fetch;
    try {
      let handlerCalls = 0;
      const tools: ToolBundle = {
        serverName: "tests",
        tools: [{ name: "echo", description: "echo", inputSchema: { text: z.string() }, handler: async ({ text }) => (handlerCalls++, ok(`echo:${text}`)) }],
      };
      const refusals: string[] = [];
      const boundary: ToolBoundary = {
        refuse: ({ args }) => (JSON.stringify(args).includes("deny") ? "not allowed" : null),
        recordRefusal: (_call, reason) => { refusals.push(reason); },
      };
      const backend = openAICompatBackend(db, config(), 7, boundary);
      let sessionId = "";
      const first = await backend.run({ prompt: "try both", systemPrompt: "system one", tools: [tools] }, { onSessionId: (id) => (sessionId = id) });
      expect(first.text).toBe("finished");
      expect(sessionId).toBe(first.backendSessionId);
      expect(sessionId).toMatch(/^openai-compat:[a-f0-9]{16}:7:/);
      expect(handlerCalls).toBe(1);
      expect(refusals).toEqual(["not allowed"]);
      expect(requests).toHaveLength(3);
      expect(requests[1]!.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("echo:run"))).toBe(true);
      expect(requests[2]!.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("not allowed"))).toBe(true);
      expect(requests[0]!.messages[0]).toMatchObject({ role: "system", content: "system one" });

      const next = await openAICompatBackend(db, config(), 7, boundary).continueRun({ backendSessionId: sessionId, prompt: "continue", systemPrompt: "system two", tools: [tools] }, {});
      expect(next.text).toBe("resumed");
      expect(requests[3]!.messages.map((m) => m.role).slice(-2)).toEqual(["assistant", "user"]);
      expect(requests[3]!.messages[0]).toMatchObject({ role: "system", content: "system two" });
      expect((await conversationStore(db).load(sessionId)).some((m) => m.role === "system")).toBe(false);
    } finally {
      globalThis.fetch = savedFetch;
      db.$client.close();
    }
  });

  test("passes AbortSignal into the provider request and resumes the persisted conversation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shuvi-backend-abort-"));
    dirs.push(dir);
    const db = openDb(join(dir, "shuvi.db"), { migrate: true });
    const savedFetch = globalThis.fetch;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    globalThis.fetch = (async (_input, init) => {
      entered();
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error("provider request did not receive an abort signal"));
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;
    try {
      const backend = openAICompatBackend(db, config(), 7, { append: () => null });
      const controller = new AbortController();
      let sessionId = "";
      const running = backend.run({ prompt: "persist before abort", tools: [] }, { signal: controller.signal, onSessionId: (id) => (sessionId = id) }).catch((error: unknown) => error);
      await started;
      controller.abort(new Error("stopped"));
      expect(await running).toBeInstanceOf(Error);
      expect((await conversationStore(db).load(sessionId)).map((message) => message.role)).toEqual(["user"]);

      globalThis.fetch = (async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: unknown }> };
        expect(body.messages.some((message) => message.role === "user" && message.content === "persist before abort")).toBe(true);
        return sse(answer("continued after stop"));
      }) as typeof fetch;
      const resumed = await openAICompatBackend(db, config(), 7, { append: () => null }).continueRun({ backendSessionId: sessionId, prompt: "resume", tools: [] }, {});
      expect(resumed.text).toBe("continued after stop");
    } finally {
      globalThis.fetch = savedFetch;
      db.$client.close();
    }
  });
});
