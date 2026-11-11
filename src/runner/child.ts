#!/usr/bin/env bun
/**
 * A runner child: one process per turn, started DETACHED by the server (server/spawn.ts) so that the
 * server can restart (a deploy, a crash) while the turn carries on. That is invariant 3 of
 * docs/design.md: thinking is not interrupted by the body restarting.
 *
 * It talks to nothing but the store: it reads its turn and the events past the cursor, and writes what it
 * says back as pending outbound rows for the server's sender. It never calls Telegram, so a child never
 * needs the bot token and two processes never race to send the same message.
 *
 * SIGTERM is a stop (`/stop`, or `/new` while a turn runs): it aborts the driver, and the turn closes as
 * `stopped`. Usage: `bun src/runner/child.ts <turnId>`.
 *
 * The SIGTERM handler is installed BEFORE anything else is loaded (the modules below are imported
 * dynamically for that reason): a stop that lands while the child is still starting up would otherwise
 * kill it with the default action, and the waker would reap the turn as failed and run it again.
 */
export {};

const ac = new AbortController();
process.on("SIGTERM", () => ac.abort());

const turnId = Number(process.argv[2]);
if (!Number.isSafeInteger(turnId)) {
  console.error("usage: child.ts <turnId>");
  process.exit(2);
}

const { ClaudeBackend } = await import("agent-runtime/claude");
const { loadConfig } = await import("../env.ts");
const { openDb } = await import("../store/db.ts");
const { runTurn } = await import("../agent/turn.ts");
const { enabledCapabilities } = await import("../capabilities/index.ts");

const cfg = loadConfig({ needToken: false });
const db = openDb(cfg.dbPath);

const outcome = await runTurn({
  db,
  turnId,
  home: cfg.home,
  timeZone: cfg.timeZone,
  ownerId: cfg.ownerId,
  ...(cfg.model ? { model: cfg.model } : {}),
  ...(cfg.ownerLanguage ? { ownerLanguage: cfg.ownerLanguage } : {}),
  capabilities: enabledCapabilities(),
  makeAdapter: (boundary) => new ClaudeBackend({ boundary, ...(cfg.claudeConfigDir ? { configDir: cfg.claudeConfigDir } : {}) }),
  signal: ac.signal,
});
console.log(`turn ${turnId}: ${outcome}`);
process.exit(0);
