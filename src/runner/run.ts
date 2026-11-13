import { driverModel, makeDriver } from "../agent/backend.ts";
import { enterModelLane } from "../agent/switch.ts";
import { botIdentity } from "../agent/triggers.ts";
import { runTurn } from "../agent/turn.ts";
import { enabledCapabilities } from "../capabilities/index.ts";
import { withCapabilitySecrets } from "../capabilities/types.ts";
import { loadConfig } from "../env.ts";
import { loadPolicy } from "../policy/load.ts";
import { LiveRedaction } from "../secrets/redaction.ts";
import { raiseAlert } from "../store/control.ts";
import { openDb } from "../store/db.ts";
import { getChat } from "../store/events.ts";
import { finishTurn, getTurn } from "../store/turns.ts";

/**
 * The body of a runner child (runner/child.ts, which loads this module only once its SIGTERM handler is in
 * place): run turn `turnId` to its end. `signal` is that handler's stop. Returns the line the child logs.
 *
 * The turn runs on the chat's model in the catalog (store/models.ts), on the driver its provider names
 * (agent/backend.ts), in the lane that model keeps its conversation in (agent/switch.ts `enterModelLane`).
 * A model no longer in the catalog fails the turn, saying so.
 */
export async function runChild(turnId: number, signal: AbortSignal): Promise<string> {
  const cfg = loadConfig({ needToken: false });
  const db = openDb(cfg.dbPath);
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
    const error = e instanceof Error ? e.message : String(e);
    finishTurn(db, turnId, { status: "failed", error });
    return `turn ${turnId}: failed (${error})`;
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
    signal,
    record: { dataDir: cfg.dataDir, redact, notes },
  });
  return `turn ${turnId}: ${outcome}`;
}
