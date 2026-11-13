#!/usr/bin/env bun
/**
 * The shuvi server: the always-on process (docs/design.md §2). It owns the conversation with Telegram
 * and decides when to think; it never thinks itself. Its loops:
 *
 *   poller    long-poll Telegram, record updates, advance the offset (poller.ts); then hand the new events
 *             to the capabilities' inbound hooks (a media prewarm), before any turn for them can start
 *   waker     reap dead turns, start a turn where one is due (waker.ts)
 *   commands  /stop, /new, /model (commands.ts); switch requests, and the control cards waiting on them
 *             (control/model-cards.ts `switchCardPass`)
 *   catalog   probes of OpenAI-compatible models, and the `/models` listings `/provider add` waits on (probes.ts)
 *   sender    deliver what turns queued (sender.ts)
 *   typing    show "typing…" in chats with a running turn
 *   policy    reload home/policy.yaml when it changes; write the policy changes the owner approved
 *             (src/policy/); give the owner the command menu in each group it lists (commands.ts)
 *   scan      alert on outbound rows that are not getting through; expire approvals (control/)
 *   backup    a daily copy of shuvi.db and home/ (control/backup.ts)
 *   control   when `SHUVI_CONTROL_BOT_TOKEN` is set, the control bot's poller and sender (control/bot.ts)
 *   prune     drop turn transcripts and abandoned conversations older than SHUVI_TRANSCRIPT_DAYS
 *   console   when SHUVI_CONSOLE_USERS or SHUVI_CONSOLE_TOKEN is set, the read-only web console (src/console/)
 *   health    /healthz and /metrics on SHUVI_METRICS_LISTEN, loopback (health.ts)
 *
 * and, alongside them, the loops of every enabled capability (src/capabilities/), through the same
 * loop helper (loop.ts).
 *
 * Everything it knows is in the store, so stopping it at any moment and starting it again loses nothing:
 * the loops resume from the rows. SIGTERM (or SIGINT) DRAINS (drain.ts): the poller stops, the waker starts
 * no new turn, and the server waits for the running turns and their messages, up to SHUVI_DRAIN_SEC, before
 * it exits 0. A second signal exits at once. A server that dies without draining (SIGKILL, a crash) leaves
 * its turns running in their own detached processes where the host lets them outlive it (systemd with
 * `KillMode=process`), and the next server picks them up; in a container they die with it, and the next
 * server reaps and retries them (waker.ts).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Api } from "grammy";
import { saveBotIdentity, TriggerScan } from "../agent/triggers.ts";
import { expireApprovals } from "../control/approvals.ts";
import { pruneTranscriptMedia } from "../agent/transcript.ts";
import { backupPass } from "../control/backup.ts";
import { checkConsole, consoleOn, startConsole } from "../console/index.ts";
import { CONTROL_COMMANDS, controlPollOnce, controlSendPass, deployedCommit, outboundAlertPass } from "../control/bot.ts";
import { switchCardPass } from "../control/model-cards.ts";
import { enabledCapabilities } from "../capabilities/index.ts";
import { capabilityInbound, capabilityLoops } from "../capabilities/types.ts";
import { loadConfig } from "../env.ts";
import { PolicyWatch } from "../policy/load.ts";
import { applyPolicyApprovals } from "../policy/write.ts";
import { openDb } from "../store/db.ts";
import { pruneConversations } from "../store/conversations.ts";
import { reconcileClaudeLogin, seedModels } from "../store/models.ts";
import { getChat, type ChatEvent } from "../store/events.ts";
import { pruneTranscripts } from "../store/transcripts.ts";
import { pendingControl } from "../store/control.ts";
import { runningTurns } from "../store/turns.ts";
import { telegramFiles } from "../telegram/files.ts";
import { commandPass, GroupMenus, MAIN_COMMANDS, registerCommands, switchRequestPass } from "./commands.ts";
import { drain } from "./drain.ts";
import { newVitals, startHealth } from "./health.ts";
import { loop as runLoop, startLoops } from "./loop.ts";
import { pollOnce } from "./poller.ts";
import { backgroundPass } from "./probes.ts";
import { sendPass } from "./sender.ts";
import { signalTurn, spawnTurn } from "./spawn.ts";
import { wakerPass } from "./waker.ts";

const cfg = loadConfig();
// Refused here, before anything starts: a console on a non-loopback address (src/console/server.ts).
checkConsole(cfg.console);
const db = openDb(cfg.dbPath, { migrate: true });
// A first start's model catalog: what turns ran on before there was one (store/models.ts).
seedModels(db, { ...(cfg.claudeConfigDir ? { claudeConfigDir: cfg.claudeConfigDir } : {}), ...(cfg.model ? { model: cfg.model } : {}) });
// And on every start: SHUVI_CLAUDE_CONFIG_DIR, when set, is where that login is (a volume, in a container).
const moved = reconcileClaudeLogin(db, cfg.claudeConfigDir);
if (moved) console.log(`models: the claude login moved from ${moved.from ?? "the server user's default"} to ${moved.to} (SHUVI_CLAUDE_CONFIG_DIR); sessions filed under the old one start over`);
const api = new Api(cfg.botToken, cfg.telegramApiRoot ? { apiRoot: cfg.telegramApiRoot } : undefined);
const capabilities = enabledCapabilities();
const me = await api.getMe();
console.log(`shuvi server: @${me.username}, data in ${cfg.dataDir}`);
// Who she is, for mentions and replies in groups; the runner children read it from the store.
const bot = { id: me.id, ...(me.username ? { username: me.username } : {}) };
saveBotIdentity(db, bot);
const policies = new PolicyWatch(db, cfg.home, cfg.ownerId);
const triggers = new TriggerScan();
// The owner's `/` menu. Best effort and not awaited: a failure is logged and the server carries on.
void registerCommands(api, cfg.ownerId, MAIN_COMMANDS, "main bot");
// The same menu, for the owner only, in each group policy lists; synced by the policy loop below.
const groupMenus = new GroupMenus(api, cfg.ownerId);

// `stop` ends every loop; `intake` only the Telegram poller, which a drain stops first (drain.ts).
const stop = new AbortController();
const intake = new AbortController();
const loop = (name: string, body: () => Promise<number | void>, everyMs: number) => runLoop(name, body, everyMs, stop.signal);
// What /healthz and /metrics report of this process (health.ts).
const vitals = newVitals();

// The poller's own long poll is its wait; it loops straight back.
const onRecorded = (events: ChatEvent[]) => capabilityInbound(capabilities, events, policies.current(), { db, ownerId: cfg.ownerId });
void runLoop(
  "poller",
  async () => {
    try {
      await pollOnce(db, api, cfg.ownerId, () => ({ botUsername: me.username, policy: policies.current(), home: cfg.home, onRecorded }), 25, intake.signal);
      vitals.lastPollAt = Date.now();
    } catch (e) {
      if (!intake.signal.aborted) vitals.pollErrors++;
      throw e;
    }
  },
  0,
  intake.signal,
);
void loop(
  "waker",
  async () => {
    commandPass(db);
    switchRequestPass(db);
    switchCardPass(db);
    // Draining: still reap and enforce the limit, start nothing.
    wakerPass({ db, spawn: spawnTurn, capabilities, maxTurnMs: cfg.turnMaxMs, policy: policies.current(), ownerId: cfg.ownerId, bot, triggers, wake: !vitals.draining });
  },
  300,
);
void loop(
  "policy",
  async () => {
    if (applyPolicyApprovals(db, cfg.home, cfg.ownerId)) console.log("policy: wrote an approved change");
    if (policies.refresh()) console.log(`policy: loaded home/policy.yaml (${Object.keys(policies.current().chats).join(", ") || "no chats listed"})`);
    // Startup (the first pass) and every change of the listed groups; otherwise no call. Never throws.
    await groupMenus.sync(policies.current());
  },
  1000,
);
// Started in the background; the rows say what is asked, so a restart's interrupted ones start again here.
void loop("catalog", async () => void backgroundPass(db, { secretsFile: cfg.secretsFile }), 1000);
// Awaited at exit (`shutdown`), so the server never exits in the middle of a send.
const senders: Promise<void>[] = [loop("sender", async () => (await sendPass(db, api)).backoffMs, 300)];
void loop(
  "typing",
  async () => {
    for (const t of runningTurns(db)) {
      const chat = getChat(db, t.chatId);
      if (chat) await api.sendChatAction(chat.tgChatId, "typing").catch(() => {});
    }
  },
  4000,
);
void loop(
  "scan",
  async () => {
    outboundAlertPass(db, cfg.outboundAlertMs);
    expireApprovals(db, cfg.ownerId);
  },
  5000,
);
void loop("backup", async () => void backupPass({ db, dataDir: cfg.dataDir, home: cfg.home }), 10 * 60_000);
void loop(
  "prune",
  async () => {
    const cutoff = Date.now() - cfg.transcriptDays * 24 * 3600_000;
    const before = new Date(cutoff).toISOString();
    const r = pruneTranscripts(db, before);
    const conversations = pruneConversations(db, before);
    const images = pruneTranscriptMedia(cfg.dataDir, cutoff);
    if (r.transcripts || r.prompts || images || conversations) console.log(`prune: ${r.transcripts} transcript(s), ${r.steps} step(s), ${r.prompts} prompt text(s), ${conversations} conversation(s), ${images} image(s) older than ${cfg.transcriptDays} days`);
  },
  3600_000,
);
if (consoleOn(cfg.console)) {
  let served = false;
  // From a loop, so a failure to bind is logged and retried like any loop error.
  void loop(
    "console",
    async () => {
      if (served) return;
      startConsole(cfg.console, { db, timeZone: cfg.timeZone, dataDir: cfg.dataDir, ownerId: cfg.ownerId, transcriptDays: cfg.transcriptDays }, stop.signal);
      served = true;
    },
    5000,
  );
} else console.log("console off (neither SHUVI_CONSOLE_USERS nor SHUVI_CONSOLE_TOKEN is set)");
{
  let served = false;
  // From a loop, like the console: a failure to bind (the port taken by something else) is logged and retried.
  // The address itself was checked at startup (env.ts).
  void loop(
    "health",
    async () => {
      if (served) return;
      const port = startHealth(cfg.metricsListen, db, vitals, stop.signal);
      served = true;
      console.log(`health: /healthz and /metrics on port ${port}`);
    },
    5000,
  );
}

if (cfg.controlBotToken) {
  const control = new Api(cfg.controlBotToken, cfg.controlApiRoot ? { apiRoot: cfg.controlApiRoot } : undefined);
  const deps = { ownerId: cfg.ownerId, commit: deployedCommit(join(dirname(fileURLToPath(import.meta.url)), "../..")), timeZone: cfg.timeZone, signal: signalTurn, policy: () => policies.current(), enabled: new Set(capabilities.map((c) => c.capability.id)) };
  void registerCommands(control, cfg.ownerId, CONTROL_COMMANDS, "control bot");
  void loop("control-poller", async () => void (await controlPollOnce(db, control, deps, 25, stop.signal)), 0);
  senders.push(loop("control-sender", async () => (await controlSendPass(db, control, cfg.ownerId)).backoffMs, 500));
  console.log(`control bot on, ${deps.commit}`);
} else console.log("control bot off (SHUVI_CONTROL_BOT_TOKEN unset): alerts are queued and logged only");

const files = telegramFiles(api, cfg.botToken, cfg.telegramApiRoot);
startLoops(capabilityLoops(capabilities, { db, home: cfg.home, timeZone: cfg.timeZone, ownerId: cfg.ownerId, files, signal: stop.signal }), stop.signal);

/** At exit, how long the drain's alerts may take to reach the owner, and how long a send in flight may take. */
const CONTROL_FLUSH_MS = 5_000;
const SEND_SETTLE_MS = 10_000;

async function shutdown(signal: string): Promise<void> {
  if (vitals.draining) {
    // A second signal: the operator wants out now. Turns left running are reaped by the next server.
    console.log(`${signal} again: shuvi server exiting without draining; ${runningTurns(db).length} turn(s) left running`);
    process.exit(0);
  }
  vitals.draining = true;
  vitals.drainDeadline = Date.now() + cfg.drainMs;
  intake.abort();
  console.log(`${signal}: shuvi server draining: no new updates or turns; ${runningTurns(db).length} turn(s) running, up to ${Math.round(cfg.drainMs / 1000)} s`);
  try {
    const r = await drain({ db, drainMs: cfg.drainMs, graceMs: cfg.drainGraceMs });
    console.log(`drain: ${r.outcome === "idle" ? "done" : `deadline; stopped ${r.stopped.length} turn(s), killed ${r.killed.length}`}; ${r.pendingLeft} outbound row(s) left for the next server`);
  } catch (e) {
    console.error("drain failed:", e);
  }
  // The control bot gets a few seconds to deliver what the drain told the owner.
  if (cfg.controlBotToken) {
    const until = Date.now() + CONTROL_FLUSH_MS;
    while (pendingControl(db).length && Date.now() < until) await Bun.sleep(200);
  }
  // Stop every loop, and let the senders finish the pass in flight (capped): a send cut off between Telegram
  // accepting it and its id being recorded would be sent again by the next server.
  stop.abort();
  const settled = await Promise.race([Promise.all(senders).then(() => true), Bun.sleep(SEND_SETTLE_MS).then(() => false)]);
  console.log(`shuvi server exiting${settled ? "" : " (a send was still in flight after the cap)"}`);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
