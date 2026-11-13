import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/env.ts";

const variables = [
  "SHUVI_BOT_TOKEN",
  "SHUVI_OWNER_ID",
  "SHUVI_MODEL",
  "SHUVI_DATA_DIR",
  "SHUVI_METRICS_LISTEN",
  "SHUVI_DRAIN_SEC",
  "SHUVI_DRAIN_GRACE_SEC",
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

  test("a non-loopback SHUVI_METRICS_LISTEN is refused at startup, not retried later", () => {
    resetEnvironment();
    process.env.SHUVI_BOT_TOKEN = "test-token";
    process.env.SHUVI_OWNER_ID = "1";
    expect(loadConfig().metricsListen).toBe("127.0.0.1:8788");
    process.env.SHUVI_METRICS_LISTEN = "[::1]:9100";
    expect(loadConfig().metricsListen).toBe("[::1]:9100");
    process.env.SHUVI_METRICS_LISTEN = "0.0.0.0:8788";
    expect(() => loadConfig()).toThrow(/SHUVI_METRICS_LISTEN must be a loopback address/);
    process.env.SHUVI_METRICS_LISTEN = "8788";
    expect(() => loadConfig()).toThrow(/SHUVI_METRICS_LISTEN must be host:port/);
  });

  test("the drain's deadline and grace, in seconds", () => {
    resetEnvironment();
    process.env.SHUVI_BOT_TOKEN = "test-token";
    process.env.SHUVI_OWNER_ID = "1";
    expect(loadConfig()).toMatchObject({ drainMs: 600_000, drainGraceMs: 15_000 });
    process.env.SHUVI_DRAIN_SEC = "3";
    process.env.SHUVI_DRAIN_GRACE_SEC = "0";
    expect(loadConfig()).toMatchObject({ drainMs: 3000, drainGraceMs: 0 });
    process.env.SHUVI_DRAIN_SEC = "-1";
    expect(() => loadConfig()).toThrow(/SHUVI_DRAIN_SEC/);
  });
});
