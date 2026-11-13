import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/env.ts";

const variables = [
  "SHUVI_BOT_TOKEN",
  "SHUVI_OWNER_ID",
  "SHUVI_MODEL",
  "SHUVI_DATA_DIR",
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
  test("trims SHUVI_MODEL", () => {
    resetEnvironment();
    process.env.SHUVI_BOT_TOKEN = "test-token";
    process.env.SHUVI_OWNER_ID = "1";
    process.env.SHUVI_MODEL = "  claude-model  ";

    expect(loadConfig().model).toBe("claude-model");
  });

  test("omits a whitespace-only model", () => {
    resetEnvironment();
    process.env.SHUVI_BOT_TOKEN = "test-token";
    process.env.SHUVI_OWNER_ID = "1";
    process.env.SHUVI_MODEL = "   ";

    expect(loadConfig()).not.toHaveProperty("model");
  });
});
