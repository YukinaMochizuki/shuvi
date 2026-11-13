import { describe, expect, test } from "bun:test";
import type { ToolBoundary } from "agent-runtime";
import { driverModel, makeDriver } from "../src/agent/backend.ts";
import {
  addModel,
  addProvider,
  chatModel,
  defaultModel,
  findModel,
  laneOf,
  listModels,
  parseLane,
  seedModels,
  setDefaultModel,
  type CatalogModel,
  type ProviderKind,
} from "../src/store/models.ts";
import { memDb } from "./helpers.ts";

describe("the model catalog", () => {
  test("a first start seeds what turns ran on before; a later start changes nothing", () => {
    const db = memDb();
    seedModels(db, { claudeConfigDir: "/home/shuvi/.claude-a", model: "opus" });
    seedModels(db, { model: "sonnet" });
    expect(listModels(db).map((m) => [m.id, m.provider.configDir, m.model.isDefault])).toEqual([["claude/opus", "/home/shuvi/.claude-a", true]]);
    const blank = memDb();
    seedModels(blank, {});
    expect(defaultModel(blank)!.id).toBe("claude/default");
  });

  test("ids are <provider>/<model>; a model's own id may hold slashes", () => {
    const db = memDb();
    addProvider(db, { name: "openrouter", kind: "openai-compat", baseUrl: "https://openrouter.ai/api/v1/", apiKey: "openrouter.API_KEY" });
    const m = addModel(db, { provider: "openrouter", model: "qwen/qwen3-235b", contextWindow: 131_072, vision: true });
    expect(m.id).toBe("openrouter/qwen/qwen3-235b");
    expect(findModel(db, "openrouter/qwen/qwen3-235b")!.model.vision).toBe(true);
    expect(findModel(db, "openrouter/qwen")).toBeUndefined();
    expect(findModel(db, "no-slash")).toBeUndefined();
    expect(m.provider.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  test("lanes: each Claude login its own, every OpenAI-compatible provider the same one", () => {
    expect(laneOf({ kind: "claude", name: "claude" })).toBe("claude:claude");
    expect(laneOf({ kind: "claude", name: "work" })).toBe("claude:work");
    expect(laneOf({ kind: "openai-compat", name: "vllm" })).toBe("openai-compat");
    expect(laneOf({ kind: "openai-compat", name: "openrouter" })).toBe("openai-compat");
  });

  test("a lane reads back as what laneOf wrote; one this code does not know is refused, never taken for a Claude login", () => {
    expect(parseLane(laneOf({ kind: "claude", name: "work" }))).toEqual({ kind: "claude", provider: "work" });
    expect(parseLane(laneOf({ kind: "openai-compat", name: "vllm" }))).toEqual({ kind: "openai-compat" });
    for (const lane of ["vllm", "claude:", "openai-compat:x", ""]) expect(() => parseLane(lane)).toThrow(`unknown lane "${lane}"`);
  });

  test("a kind this code does not know is refused everywhere, never run as another kind", () => {
    const vllm = "vllm" as unknown as ProviderKind;
    expect(() => laneOf({ kind: vllm, name: "x" })).toThrow('unknown provider kind "vllm"');
    expect(() => addProvider(memDb(), { name: "x", kind: vllm, baseUrl: "http://127.0.0.1:8000/v1" })).toThrow('unknown provider kind "vllm"');
    const model = { id: "x/m", provider: { kind: vllm, name: "x" }, model: { model: "m" } } as unknown as CatalogModel;
    expect(() => driverModel(model)).toThrow('unknown provider kind "vllm"');
    expect(() => makeDriver({ db: memDb(), chatId: 1, model, boundary: {} as ToolBoundary, note: () => {}, secretsFile: "/nonexistent" })).toThrow(
      'unknown provider kind "vllm"',
    );
  });

  test("one default: the first model, or whichever is made so", () => {
    const db = memDb();
    addProvider(db, { name: "claude", kind: "claude" });
    addModel(db, { provider: "claude", model: "opus" });
    addModel(db, { provider: "claude", model: "sonnet" });
    expect(defaultModel(db)!.id).toBe("claude/opus");
    setDefaultModel(db, "claude/sonnet");
    expect(listModels(db).filter((m) => m.model.isDefault).map((m) => m.id)).toEqual(["claude/sonnet"]);
    addModel(db, { provider: "claude", model: "haiku", isDefault: true });
    expect(listModels(db).filter((m) => m.model.isDefault).map((m) => m.id)).toEqual(["claude/haiku"]);
  });

  test("a chat runs on its own model, else the default; one no longer in the catalog says what to do", () => {
    const db = memDb();
    addProvider(db, { name: "claude", kind: "claude" });
    addModel(db, { provider: "claude", model: "opus" });
    expect(chatModel(db, { model: null }).id).toBe("claude/opus");
    expect(() => chatModel(db, { model: "gone/model" })).toThrow(/no longer in the model catalog: pick another model/);
    expect(() => chatModel(memDb(), { model: null })).toThrow(/no default model/);
  });

  test("refused: a bad name, a duplicate, an endpoint without its URL or with credentials in it, a key not named as profile.VAR, a model without its context window", () => {
    const db = memDb();
    expect(() => addProvider(db, { name: "Has Space", kind: "claude" })).toThrow(/not a provider name/);
    expect(() => addProvider(db, { name: "a/b", kind: "claude" })).toThrow(/not a provider name/);
    addProvider(db, { name: "claude", kind: "claude" });
    expect(() => addProvider(db, { name: "claude", kind: "claude" })).toThrow(/already a provider/);
    expect(() => addProvider(db, { name: "x", kind: "openai-compat" })).toThrow(/needs its base URL/);
    expect(() => addProvider(db, { name: "x", kind: "openai-compat", baseUrl: "https://u:p@example/v1" })).toThrow(/no credentials/);
    expect(() => addProvider(db, { name: "x", kind: "openai-compat", baseUrl: "https://example/v1?key=1" })).toThrow(/no credentials, query/);
    expect(() => addProvider(db, { name: "x", kind: "openai-compat", baseUrl: "https://example/v1", apiKey: "sk-123" })).toThrow(/<secrets profile>\.<VARIABLE>/);
    addProvider(db, { name: "x", kind: "openai-compat", baseUrl: "https://example/v1" });
    expect(() => addModel(db, { provider: "x", model: "m" })).toThrow(/context window/);
    expect(() => addModel(db, { provider: "nope", model: "m" })).toThrow(/no provider named "nope"/);
  });
});
