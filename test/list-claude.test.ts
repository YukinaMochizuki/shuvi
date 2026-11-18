import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listClaudeInChild } from "../src/server/list-claude.ts";
import { childEnv } from "../src/server/spawn.ts";

// The real Claude Code CLI the Agent SDK bundles: listing what it offers a login sends nothing to a model and
// needs no login (an empty config dir lists the CLI's own menu).
const emptyLogin = () => mkdtempSync(join(tmpdir(), "shuvi-list-claude-"));

/** Listing children still running. Their CLI is in the child's process group, which is killed with it. */
const listingChildren = () =>
  Bun.spawnSync(["sh", "-c", "ps -eo args | grep -E '[s]rc/server/list-claude.ts' || true"]).stdout.toString().trim();

describe("listing a Claude login in a child", () => {
  test("lists what Claude Code offers, and leaves nothing running", async () => {
    const choices = await listClaudeInChild(emptyLogin(), new AbortController().signal);
    expect(choices.length).toBeGreaterThan(0);
    expect(choices.every((c) => typeof c.id === "string" && typeof c.label === "string")).toBe(true);
    await Bun.sleep(200);
    expect(listingChildren()).toBe("");
  });

  test("a cancel rejects at once and kills the child", async () => {
    const ac = new AbortController();
    const listing = listClaudeInChild(emptyLogin(), ac.signal);
    ac.abort(new Error("cancelled"));
    await expect(listing).rejects.toThrow("cancelled");
    await Bun.sleep(200);
    expect(listingChildren()).toBe("");
  });

  test("its environment is the runner child's: no bot token", () => {
    const saved = { bot: process.env.SHUVI_BOT_TOKEN, control: process.env.SHUVI_CONTROL_BOT_TOKEN };
    process.env.SHUVI_BOT_TOKEN = "example-bot-token";
    process.env.SHUVI_CONTROL_BOT_TOKEN = "example-control-token";
    try {
      const env = childEnv();
      expect(env.SHUVI_BOT_TOKEN).toBeUndefined();
      expect(env.SHUVI_CONTROL_BOT_TOKEN).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      if (saved.bot === undefined) delete process.env.SHUVI_BOT_TOKEN;
      else process.env.SHUVI_BOT_TOKEN = saved.bot;
      if (saved.control === undefined) delete process.env.SHUVI_CONTROL_BOT_TOKEN;
      else process.env.SHUVI_CONTROL_BOT_TOKEN = saved.control;
    }
  });
});
