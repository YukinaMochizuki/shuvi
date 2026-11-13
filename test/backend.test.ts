import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, type ToolBundle, type ToolBoundary } from "agent-runtime";
import { z } from "zod";
import { driverModel, makeDriver } from "../src/agent/backend.ts";
import { conversationStore } from "../src/store/conversations.ts";
import { openDb, type Db } from "../src/store/db.ts";
import { addModel, addProvider, findModel, seedModels } from "../src/store/models.ts";
import { chats } from "../src/store/schema.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A secrets file (mode 600, as the store requires) holding `values`. */
function secretsFile(values: Record<string, Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "shuvi-backend-secrets-"));
  dirs.push(dir);
  const file = join(dir, "secrets.yaml");
  writeFileSync(file, Object.entries(values).map(([p, vars]) => `${p}:\n${Object.entries(vars).map(([k, v]) => `  ${k}: ${v}`).join("\n")}`).join("\n") + "\n");
  chmodSync(file, 0o600);
  return file;
}

/** A catalog with one OpenAI-compatible model, keyed through the secrets file. */
function endpoint(db: Db, apiKey: string | null = "endpoint.API_KEY") {
  addProvider(db, { name: "endpoint", kind: "openai-compat", baseUrl: "https://endpoint.example/api/", apiKey });
  return addModel(db, { provider: "endpoint", model: "test-model", contextWindow: 100_000 });
}

describe("the driver a model runs on", () => {
  test("a Claude model passes its id to the driver; the CLI's default passes none", () => {
    const db = openDb(":memory:", { migrate: true });
    seedModels(db, {});
    expect(driverModel(findModel(db, "claude/default")!)).toBeUndefined();
    addModel(db, { provider: "claude", model: "opus" });
    expect(driverModel(findModel(db, "claude/opus")!)).toBe("opus");
    expect(makeDriver({ db, chatId: 1, model: findModel(db, "claude/opus")!, boundary: {}, note: () => {}, secretsFile: "/nonexistent" }).id).toBe("claude-agent-sdk");
  });

  test("an OpenAI-compatible key is read from the secrets file; one missing fails naming only its reference", () => {
    const db = openDb(":memory:", { migrate: true });
    const m = endpoint(db);
    expect(makeDriver({ db, chatId: 1, model: m, boundary: {}, note: () => {}, secretsFile: secretsFile({ endpoint: { API_KEY: "test-key" } }) }).id).toBe("openai-compat");
    expect(() => makeDriver({ db, chatId: 1, model: m, boundary: {}, note: () => {}, secretsFile: secretsFile({ other: { API_KEY: "x" } }) })).toThrow(/the key endpoint\.API_KEY is not in the secrets file/);
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
  const driver = (db: Db, boundary: ToolBoundary) =>
    makeDriver({ db, chatId: 7, model: findModel(db, "endpoint/test-model") ?? endpoint(db), boundary, note: () => {}, secretsFile: secretsFile({ endpoint: { API_KEY: "test-key" } }) });

  test("persists a successful and refused boundary call, then resumes through the same factory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shuvi-backend-wire-"));
    dirs.push(dir);
    const db = openDb(join(dir, "shuvi.db"), { migrate: true });
    const requests: Array<{ model: string; messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[] }> }> = [];
    const responses = [toolCall("success", "run"), toolCall("refusal", "deny"), answer("finished"), answer("resumed")];
    db.insert(chats).values({ id: 7, tgChatId: 7, kind: "private" }).run();
    const savedFetch = globalThis.fetch;
    const auth: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      auth.push(new Headers(init?.headers).get("authorization") ?? "");
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
      const backend = driver(db, boundary);
      let sessionId = "";
      const first = await backend.run({ prompt: "try both", systemPrompt: "system one", tools: [tools] }, { onSessionId: (id) => (sessionId = id) });
      expect(first.text).toBe("finished");
      expect(sessionId).toBe(first.backendSessionId);
      // A conversation id names the conversation, not the model it runs on.
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(handlerCalls).toBe(1);
      expect(refusals).toEqual(["not allowed"]);
      expect(requests).toHaveLength(3);
      expect(auth[0]).toBe("Bearer test-key"); // the key the secrets file holds for `endpoint.API_KEY`
      expect(requests[1]!.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("echo:run"))).toBe(true);
      expect(requests[2]!.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("not allowed"))).toBe(true);
      expect(requests[0]!.messages[0]).toMatchObject({ role: "system", content: "system one" });

      const next = await driver(db, boundary).continueRun({ backendSessionId: sessionId, prompt: "continue", systemPrompt: "system two", tools: [tools] }, {});
      expect(next.text).toBe("resumed");
      expect(requests[3]!.messages.map((m) => m.role).slice(-2)).toEqual(["assistant", "user"]);
      expect(requests[3]!.messages[0]).toMatchObject({ role: "system", content: "system two" });
      expect((await conversationStore(db, 7).load(sessionId)).some((m) => m.role === "system")).toBe(false);
    } finally {
      globalThis.fetch = savedFetch;
      db.$client.close();
    }
  });

  test("passes AbortSignal into the provider request and resumes the persisted conversation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shuvi-backend-abort-"));
    dirs.push(dir);
    const db = openDb(join(dir, "shuvi.db"), { migrate: true });
    db.insert(chats).values({ id: 7, tgChatId: 7, kind: "private" }).run();
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
      const backend = driver(db, { append: () => null });
      const controller = new AbortController();
      let sessionId = "";
      const running = backend.run({ prompt: "persist before abort", tools: [] }, { signal: controller.signal, onSessionId: (id) => (sessionId = id) }).catch((error: unknown) => error);
      await started;
      controller.abort(new Error("stopped"));
      expect(await running).toBeInstanceOf(Error);
      expect((await conversationStore(db, 7).load(sessionId)).map((message) => message.role)).toEqual(["user"]);

      globalThis.fetch = (async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: unknown }> };
        expect(body.messages.some((message) => message.role === "user" && message.content === "persist before abort")).toBe(true);
        return sse(answer("continued after stop"));
      }) as typeof fetch;
      const resumed = await driver(db, { append: () => null }).continueRun({ backendSessionId: sessionId, prompt: "resume", tools: [] }, {});
      expect(resumed.text).toBe("continued after stop");
    } finally {
      globalThis.fetch = savedFetch;
      db.$client.close();
    }
  });
});
