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
 * The turn runs on the chat's model in the catalog (store/models.ts), on the driver its provider names
 * (agent/backend.ts), in the lane that model keeps its conversation in (agent/switch.ts `enterModelLane`).
 * A model no longer in the catalog fails the turn, saying so.
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

const { driverModel, makeDriver } = await import("../agent/backend.ts");
const { enterModelLane } = await import("../agent/switch.ts");
const { loadConfig } = await import("../env.ts");
const { openDb } = await import("../store/db.ts");
const { getChat } = await import("../store/events.ts");
const { runTurn } = await import("../agent/turn.ts");
const { enabledCapabilities } = await import("../capabilities/index.ts");
const { withCapabilitySecrets } = await import("../capabilities/types.ts");
const { loadPolicy } = await import("../policy/load.ts");
const { botIdentity } = await import("../agent/triggers.ts");
const { LiveRedaction } = await import("../secrets/redaction.ts");
const { raiseAlert } = await import("../store/control.ts");

const cfg = loadConfig({ needToken: false });
const db = openDb(cfg.dbPath);
const { finishTurn, getTurn } = await import("../store/turns.ts");
const turn = getTurn(db, turnId);
const chat = turn ? getChat(db, turn.chatId) : undefined;
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

// The chat's model, and its conversation in that model's lane, before anything is rendered.
let model: ReturnType<typeof enterModelLane> | undefined;
try {
  model = chat && turn?.status === "running" ? enterModelLane(db, chat) : undefined;
} catch (e) {
  finishTurn(db, turnId, { status: "failed", error: e instanceof Error ? e.message : String(e) });
  console.log(`turn ${turnId}: failed (${e instanceof Error ? e.message : String(e)})`);
  process.exit(0);
}
const turnModel = model ? driverModel(model) : undefined;

const outcome = await runTurn({
  db,
  turnId,
  home: cfg.home,
  timeZone: cfg.timeZone,
  ownerId: cfg.ownerId,
  ...(turnModel ? { model: turnModel } : {}),
  ...(cfg.ownerLanguage ? { ownerLanguage: cfg.ownerLanguage } : {}),
  capabilities,
  policy,
  ...(bot ? { bot } : {}),
  // Claude: its system prompt is live on every turn, so an edit to home/ is heard from the next turn
  // (Claude Code otherwise replays the prompt it recorded). agent/backend.ts.
  makeAdapter: (boundary, note) => makeDriver({ db, chatId: chat!.id, model: model!, boundary, note, secretsFile: cfg.secretsFile }),
  signal: ac.signal,
  record: { dataDir: cfg.dataDir, redact, notes },
});
console.log(`turn ${turnId}: ${outcome}`);
process.exit(0);
