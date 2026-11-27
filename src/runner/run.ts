import { driverModel, loadDriver, makeDriver } from "../agent/backend.ts";
import { conversationPosition, enterChatModel } from "../agent/switch.ts";
import { botIdentity } from "../agent/triggers.ts";
import { runTurn, type TurnOutcome } from "../agent/turn.ts";
import { enabledCapabilities } from "../capabilities/index.ts";
import { withCapabilitySecrets, type EnabledCapability } from "../capabilities/types.ts";
import { loadConfig, type Config } from "../env.ts";
import { loadPolicy } from "../policy/load.ts";
import { LiveRedaction } from "../secrets/source.ts";
import { raiseAlert } from "../store/control.ts";
import { openDb, type Db } from "../store/db.ts";
import { getChat, onTurnRowQueued } from "../store/events.ts";
import { wakeServer } from "../server/wake.ts";
import { childEnv } from "../server/spawn.ts";
import { runnerConfigHash } from "../version.ts";
import { finishTurn, getTurn, lastClosedTurn, markTurn, setTurnConversation } from "../store/turns.ts";
import type { WarmClaude } from "./warm-session.ts";

/**
 * What a runner child's signal handlers give its code (runner/child.ts installs them before anything loads):
 * `stop` is SIGTERM (stop the turn; a warm runner then exits), `retired` whether SIGUSR2 came (retire), and
 * `wait` a sleep that SIGUSR1 (a turn was handed over), SIGUSR2 or SIGTERM end early.
 */
export interface RunnerSignals {
  stop: AbortSignal;
  retired: () => boolean;
  wait: (ms: number) => Promise<void>;
}

/** What a runner child holds for its whole life, across the turns of a warm runner (runner/warm.ts). */
export interface RunnerContext {
  cfg: Config;
  db: Db;
  capabilities: EnabledCapability[];
  /** The resident Claude CLI, with `SHUVI_WARM_RUNNERS` on and once a Claude turn ran. */
  warm?: WarmClaude;
  /** Its configuration's hash (version.ts `runnerConfigHash`), taken at its start, before anything ran. */
  configHash?: string;
}

/** How one turn of a runner ended, and what the warm runner needs to know to decide whether to stay. */
export interface TurnRun {
  turnId: number;
  line: string;
  outcome: TurnOutcome | "failed";
  chatId?: number;
  /** The kind of the provider the turn ran on (store/models.ts), when it got that far. */
  kind?: string;
}

/**
 * The body of a runner child (runner/child.ts, which loads this module only once its SIGTERM handler is in
 * place): run turn `turnId` to its end. `signals` are those handlers' (`RunnerSignals`). Returns the line the
 * child logs.
 *
 * The turn runs on the chat's model in the catalog (store/models.ts), on the driver its provider names
 * (agent/backend.ts), in that model's own conversation (agent/switch.ts `enterChatModel`).
 * A model no longer in the catalog fails the turn, saying so. Only that provider's driver is loaded
 * (backend.ts `loadDriver`).
 *
 * WHAT A CHILD LOADS before its turn starts is on every turn's path, so this module's imports are what a turn
 * needs to start; a tool's heavy library (an image codec, an SDK client) is imported where the tool runs.
 *
 * With `SHUVI_WARM_RUNNERS` on, a Claude turn runs on a resident CLI (runner/warm-session.ts) and, the turn over,
 * the child may stay as its chat's WARM RUNNER and run its next turns (runner/warm.ts, loaded only then). Off,
 * the child runs its one turn and exits, as it always did.
 */
export async function runChild(turnId: number, signals: RunnerSignals): Promise<string> {
  const cfg = loadConfig({ needToken: false });
  const db = openDb(cfg.dbPath);
  // Each row a turn queues wakes the server's sender (server/wake.ts); the store only calls the hook.
  onTurnRowQueued(wakeServer);
  const capabilities = enabledCapabilities();
  const runner: RunnerContext = { cfg, db, capabilities, configHash: runnerConfigHash(childEnv(), capabilities.map((c) => c.capability.id)) };
  const first = await runOne(runner, turnId, signals.stop, { spawned: true });
  if (!cfg.warm.enabled) return first.line;
  const { stayWarm } = await import("./warm.ts");
  return stayWarm(runner, first, signals);
}

/**
 * Run turn `turnId` in this runner to its end. `spawned`: the turn this child was started for (its start is
 * marked as `child`); a turn handed to a warm runner is not.
 */
export async function runOne(runner: RunnerContext, turnId: number, signal: AbortSignal, opts: { spawned?: boolean } = {}): Promise<TurnRun> {
  const { cfg, db } = runner;
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
  const redaction = new LiveRedaction(db, cfg.secrets);
  const secretsProblem = redaction.problem();
  const notes: string[] = [];
  if (secretsProblem) {
    console.error(`turn ${turnId}: secrets file unusable for redaction: ${secretsProblem}`);
    notes.push(`The secrets file could not be read (${secretsProblem}); this transcript is redacted with the values known before, or withheld.`);
    try {
      raiseAlert(db, {
        key: `secrets-unusable:${cfg.secrets.file}:${secretsProblem}`,
        topic: "secrets-unusable",
        text: `The secrets file cannot be used: ${secretsProblem}. Turn transcripts and computer output are redacted with the values known before, or withheld.`,
      });
    } catch (e) {
      console.error("could not raise the secrets alert:", e);
    }
  }

  const capabilities = runner.capabilities;
  // A capability's own credential (porchkit's token) is redacted too, as `[REDACTED:<label>]`.
  const redact = withCapabilitySecrets((s) => redaction.redact(s), capabilities);

  // The chat's model, and that model's conversation, before anything is rendered.
  let model: ReturnType<typeof enterChatModel> | undefined;
  try {
    model = chat && turn?.status === "running" ? enterChatModel(db, chat) : undefined;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    finishTurn(db, turnId, { status: "failed", error });
    return { turnId, line: `turn ${turnId}: failed (${error})`, outcome: "failed", ...(chat ? { chatId: chat.id } : {}) };
  }
  // Where its conversation stands before the driver writes anything: a switch that stops this turn carries
  // only up to here (agent/switch.ts).
  if (model && chat) setTurnConversation(db, turnId, { conversationStart: conversationPosition(db, chat) });
  const turnModel = model ? driverModel(model) : undefined;
  if (model) {
    try {
      await loadDriver(model.provider.kind);
    } catch (e) {
      const error = `the ${model.provider.kind} driver could not be loaded: ${e instanceof Error ? e.message : String(e)}`;
      finishTurn(db, turnId, { status: "failed", error });
      return { turnId, line: `turn ${turnId}: failed (${error})`, outcome: "failed", chatId: chat!.id, kind: model.provider.kind };
    }
  }
  // With warm runners on, a Claude turn runs on the runner's resident CLI (warm-session.ts), kept for the next.
  const resident = cfg.warm.enabled && model?.provider.kind === "claude";
  if (resident && !runner.warm) {
    const { WarmClaude } = await import("./warm-session.ts");
    runner.warm = new WarmClaude(await import("agent-runtime/claude"));
  }

  // When this process began, and when the turn is about to run: what starting it cost (store/turns.ts `markTurn`).
  markTurn(db, turnId, { ...(opts.spawned ? { child: performance.timeOrigin } : {}), ready: Date.now() });
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
    makeAdapter: (boundary, note) =>
      resident
        ? runner.warm!.adapter(boundary, model!.provider.configDir ?? null, lastClosedTurn(db, chat!.id), () => markTurn(db, turnId, { cli: Date.now() }))
        : makeDriver({ db, chatId: chat!.id, model: model!, boundary, note, secrets: cfg.secrets }),
    signal,
    record: { dataDir: cfg.dataDir, redact, notes },
  });
  return { turnId, line: `turn ${turnId}: ${outcome}`, outcome, ...(chat ? { chatId: chat.id } : {}), ...(model ? { kind: model.provider.kind } : {}) };
}
