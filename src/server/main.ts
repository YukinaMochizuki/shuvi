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
 *
 * and, alongside them, the loops of every enabled capability (src/capabilities/), through the same
 * loop helper (loop.ts).
 *
 * Everything it knows is in the store, so stopping it at any moment and starting it again loses nothing:
 * running turns carry on in their own processes, and the loops resume from the rows.
 */
import { Api } from "grammy";
import { enabledCapabilities } from "../capabilities/index.ts";
import { capabilityLoops } from "../capabilities/types.ts";
import { loadConfig } from "../env.ts";
import { openDb } from "../store/db.ts";
import { getChat } from "../store/events.ts";
import { runningTurns } from "../store/turns.ts";
import { telegramFiles } from "../telegram/files.ts";
import { commandPass } from "./commands.ts";
import { loop as runLoop, startLoops } from "./loop.ts";
import { pollOnce } from "./poller.ts";
import { sendPass } from "./sender.ts";
import { spawnTurn } from "./spawn.ts";
import { wakerPass } from "./waker.ts";

const cfg = loadConfig();
const db = openDb(cfg.dbPath, { migrate: true });
const api = new Api(cfg.botToken, cfg.telegramApiRoot ? { apiRoot: cfg.telegramApiRoot } : undefined);
const capabilities = enabledCapabilities();
const me = await api.getMe();
console.log(`shuvi server: @${me.username}, data in ${cfg.dataDir}`);

const stop = new AbortController();
const loop = (name: string, body: () => Promise<number | void>, everyMs: number) => runLoop(name, body, everyMs, stop.signal);

// The poller's own long poll is its wait; it loops straight back.
void loop("poller", async () => void (await pollOnce(db, api, cfg.ownerId, me.username, 25, stop.signal)), 0);
void loop(
  "waker",
  async () => {
    commandPass(db);
    wakerPass({ db, spawn: spawnTurn, capabilities });
  },
  300,
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
