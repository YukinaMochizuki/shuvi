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
const { conversationMatchesBackend, openAICompatBackend } = await import("../agent/backend.ts");
const { loadConfig } = await import("../env.ts");
const { openDb } = await import("../store/db.ts");
const { getChat, resetConversation } = await import("../store/events.ts");
const { runTurn } = await import("../agent/turn.ts");
const { enabledCapabilities } = await import("../capabilities/index.ts");
const { withCapabilitySecrets } = await import("../capabilities/types.ts");
const { loadPolicy } = await import("../policy/load.ts");
const { botIdentity } = await import("../agent/triggers.ts");
const { LiveRedaction } = await import("../secrets/redaction.ts");
const { raiseAlert } = await import("../store/control.ts");

const cfg = loadConfig({ needToken: false });
const db = openDb(cfg.dbPath);
const turn = (await import("../store/turns.ts")).getTurn(db, turnId);
const chat = turn ? getChat(db, turn.chatId) : undefined;
if (turn?.status === "running" && chat?.backendSessionId && !conversationMatchesBackend(chat.backendSessionId, cfg, chat.id)) resetConversation(db, chat.id);
// The same home/policy.yaml the server reads, the same way (a broken one: the last good, from the store);
// and who the bot is, which the server recorded at startup (a child has no token to ask Telegram).
const policy = loadPolicy(db, cfg.home, cfg.ownerId);
const bot = botIdentity(db);
// The transcript is redacted with the computer's own redaction (every value the secrets file holds or ever
// held), whether or not the computer capability is on, and rebuilt if the file changes during the turn. An
// unusable file still redacts every value known before; with none known, the transcript's texts are
// withheld. Either way the owner is told once (per version of the file) and the transcript says so.
const redaction = new LiveRedaction(cfg.secretsFile);
const secretsProblem = redaction.problem();
const notes: string[] = [];
if (secretsProblem) {
  console.error(`turn ${turnId}: secrets file unusable for redaction: ${secretsProblem}`);
  notes.push(`The secrets file could not be read (${secretsProblem}); this transcript is redacted with the values known before, or withheld.`);
  try {
    raiseAlert(db, {
      key: `secrets-unusable:${cfg.secretsFile}:${secretsProblem}`,
      topic: "secrets-unusable",
      text: `The secrets file cannot be used: ${secretsProblem}. Turn transcripts and computer output are redacted with the values known before, or withheld.`,
    });
  } catch (e) {
    console.error("could not raise the secrets alert:", e);
  }
}

const capabilities = enabledCapabilities();
// A capability's own credential (porchkit's token) is redacted too, as `[REDACTED:<label>]`.
const redact = withCapabilitySecrets((s) => redaction.redact(s), capabilities);

const outcome = await runTurn({
  db,
  turnId,
  home: cfg.home,
  timeZone: cfg.timeZone,
  ownerId: cfg.ownerId,
  ...(cfg.model ? { model: cfg.model } : {}),
  ...(cfg.ownerLanguage ? { ownerLanguage: cfg.ownerLanguage } : {}),
  capabilities,
  policy,
  ...(bot ? { bot } : {}),
  // liveSystemPrompt: each turn's system prompt replaces the one the conversation began with, so an edit
  // to home/ is heard from the next turn (Claude Code otherwise replays the prompt it recorded).
  makeAdapter: (boundary) =>
    cfg.backend === "openai-compat"
      ? openAICompatBackend(db, cfg, chat!.id, boundary)
      : new ClaudeBackend({ boundary, liveSystemPrompt: true, ...(cfg.claudeConfigDir ? { configDir: cfg.claudeConfigDir } : {}) }),
  signal: ac.signal,
  record: { dataDir: cfg.dataDir, redact, notes },
});
console.log(`turn ${turnId}: ${outcome}`);
process.exit(0);
