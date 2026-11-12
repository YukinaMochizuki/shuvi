import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/env.ts";

const variables = [
  "SHUVI_BOT_TOKEN",
  "SHUVI_OWNER_ID",
  "SHUVI_MODEL",
  "SHUVI_BACKEND",
  "SHUVI_DATA_DIR",
  "SHUVI_OPENAI_BASE_URL",
  "SHUVI_OPENAI_CONTEXT_WINDOW",
  "SHUVI_OPENAI_VISION",
  "SHUVI_OPENAI_API_KEY",
] as const;
const original = Object.fromEntries(variables.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of variables) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function resetEnvironment(): void {
  for (const name of variables) delete process.env[name];
}

describe("loadConfig", () => {
  test("trims SHUVI_MODEL for Claude", () => {
    resetEnvironment();
    process.env.SHUVI_BOT_TOKEN = "test-token";
    process.env.SHUVI_OWNER_ID = "1";
    process.env.SHUVI_BACKEND = "claude";
    process.env.SHUVI_MODEL = "  claude-model  ";

    expect(loadConfig().model).toBe("claude-model");
  });

  test("trims SHUVI_MODEL for OpenAI-compatible backends", () => {
    resetEnvironment();
    process.env.SHUVI_BOT_TOKEN = "test-token";
    process.env.SHUVI_OWNER_ID = "1";
    process.env.SHUVI_BACKEND = "openai-compat";
    process.env.SHUVI_MODEL = "  openai-model  ";
    process.env.SHUVI_OPENAI_BASE_URL = "https://api.example/v1";
    process.env.SHUVI_OPENAI_CONTEXT_WINDOW = "32768";

    expect(loadConfig().model).toBe("openai-model");
  });

  test("omits a whitespace-only Claude model", () => {
    resetEnvironment();
    process.env.SHUVI_BOT_TOKEN = "test-token";
    process.env.SHUVI_OWNER_ID = "1";
    process.env.SHUVI_BACKEND = "claude";
    process.env.SHUVI_MODEL = "   ";

    expect(loadConfig()).not.toHaveProperty("model");
  });
});
