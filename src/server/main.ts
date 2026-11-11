#!/usr/bin/env bun
/**
 * The shuvi server: the always-on process (docs/design.md §2). It owns the conversation with Telegram
 * and decides when to think; it never thinks itself. Its loops:
 *
 *   poller    long-poll Telegram, record updates, advance the offset (poller.ts)
 *   waker     reap dead turns, start a turn where one is due (waker.ts)
 *   commands  /stop, /new (commands.ts)
 *   sender    deliver what turns queued (sender.ts)
 *   typing    show "typing…" in chats with a running turn
 *   policy    reload home/policy.yaml when it changes; write the policy changes the owner approved
 *             (src/policy/)
 *   scan      alert on outbound rows that are not getting through; expire approvals (control/)
 *   backup    a daily copy of shuvi.db and home/ (control/backup.ts)
 *   control   when `SHUVI_CONTROL_BOT_TOKEN` is set, the control bot's poller and sender (control/bot.ts)
 *
 * and, alongside them, the loops of every enabled capability (src/capabilities/), through the same
 * loop helper (loop.ts).
 *
 * Everything it knows is in the store, so stopping it at any moment and starting it again loses nothing:
 * running turns carry on in their own processes, and the loops resume from the rows.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Api } from "grammy";
import { saveBotIdentity, TriggerScan } from "../agent/triggers.ts";
import { expireApprovals } from "../control/approvals.ts";
import { backupPass } from "../control/backup.ts";
import { CONTROL_COMMANDS, controlPollOnce, controlSendPass, deployedCommit, outboundAlertPass } from "../control/bot.ts";
import { enabledCapabilities } from "../capabilities/index.ts";
import { capabilityLoops } from "../capabilities/types.ts";
import { loadConfig } from "../env.ts";
import { PolicyWatch } from "../policy/load.ts";
import { applyPolicyApprovals } from "../policy/write.ts";
import { openDb } from "../store/db.ts";
import { getChat } from "../store/events.ts";
import { runningTurns } from "../store/turns.ts";
import { telegramFiles } from "../telegram/files.ts";
import { commandPass, MAIN_COMMANDS, registerCommands } from "./commands.ts";
import { loop as runLoop, startLoops } from "./loop.ts";
import { pollOnce } from "./poller.ts";
import { sendPass } from "./sender.ts";
import { signalTurn, spawnTurn } from "./spawn.ts";
import { wakerPass } from "./waker.ts";

const cfg = loadConfig();
const db = openDb(cfg.dbPath, { migrate: true });
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

const stop = new AbortController();
const loop = (name: string, body: () => Promise<number | void>, everyMs: number) => runLoop(name, body, everyMs, stop.signal);

// The poller's own long poll is its wait; it loops straight back.
void loop("poller", async () => void (await pollOnce(db, api, cfg.ownerId, () => ({ botUsername: me.username, policy: policies.current(), home: cfg.home }), 25, stop.signal)), 0);
void loop(
  "waker",
  async () => {
    commandPass(db);
    wakerPass({ db, spawn: spawnTurn, capabilities, maxTurnMs: cfg.turnMaxMs, policy: policies.current(), ownerId: cfg.ownerId, bot, triggers });
  },
  300,
);
void loop(
  "policy",
  async () => {
    if (applyPolicyApprovals(db, cfg.home, cfg.ownerId)) console.log("policy: wrote an approved change");
    if (policies.refresh()) console.log(`policy: loaded home/policy.yaml (${Object.keys(policies.current().chats).join(", ") || "no chats listed"})`);
  },
  1000,
);
void loop("sender", async () => (await sendPass(db, api)).backoffMs, 300);
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

if (cfg.controlBotToken) {
  const control = new Api(cfg.controlBotToken, cfg.controlApiRoot ? { apiRoot: cfg.controlApiRoot } : undefined);
  const deps = { ownerId: cfg.ownerId, commit: deployedCommit(join(dirname(fileURLToPath(import.meta.url)), "../..")), timeZone: cfg.timeZone, signal: signalTurn };
  void registerCommands(control, cfg.ownerId, CONTROL_COMMANDS, "control bot");
  void loop("control-poller", async () => void (await controlPollOnce(db, control, deps, 25, stop.signal)), 0);
  void loop("control-sender", async () => (await controlSendPass(db, control, cfg.ownerId)).backoffMs, 500);
  console.log(`control bot on, ${deps.commit}`);
} else console.log("control bot off (SHUVI_CONTROL_BOT_TOKEN unset): alerts are queued and logged only");

const files = telegramFiles(api, cfg.botToken, cfg.telegramApiRoot);
startLoops(capabilityLoops(capabilities, { db, home: cfg.home, timeZone: cfg.timeZone, ownerId: cfg.ownerId, files, signal: stop.signal }), stop.signal);

function shutdown(signal: string): void {
  // Running turns are NOT stopped: they are detached, and outliving this process is why they are.
  console.log(`${signal}: shuvi server exiting; ${runningTurns(db).length} turn(s) left running`);
  stop.abort();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
