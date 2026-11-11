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
 * Everything it knows is in the store, so stopping it at any moment and starting it again loses nothing:
 * running turns carry on in their own processes, and the loops resume from the rows.
 */
import { Api } from "grammy";
import { loadConfig } from "../env.ts";
import { openDb } from "../store/db.ts";
import { getChat } from "../store/events.ts";
import { runningTurns } from "../store/turns.ts";
import { commandPass } from "./commands.ts";
import { pollOnce } from "./poller.ts";
import { sendPass } from "./sender.ts";
import { spawnTurn } from "./spawn.ts";
import { wakerPass } from "./waker.ts";

const cfg = loadConfig();
const db = openDb(cfg.dbPath, { migrate: true });
const api = new Api(cfg.botToken, cfg.telegramApiRoot ? { apiRoot: cfg.telegramApiRoot } : undefined);
const me = await api.getMe();
console.log(`shuvi server: @${me.username}, data in ${cfg.dataDir}`);

const stop = new AbortController();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `body` forever, `everyMs` apart. The waker and the sender poll the store rather than being
 * signalled: a child writes from another process, and a 300 ms read of a local SQLite file is cheaper
 * than any cross-process wake-up would be to get right. `body` may return a longer wait (a 429).
 */
async function loop(name: string, body: () => Promise<number | void>, everyMs: number): Promise<void> {
  while (!stop.signal.aborted) {
    let wait = everyMs;
    try {
      const asked = await body();
      if (typeof asked === "number" && asked > wait) wait = asked;
    } catch (e) {
      if (stop.signal.aborted) return;
      console.error(`${name}:`, e);
      wait = Math.max(everyMs * 4, 2000);
    }
    await sleep(wait);
  }
}

// The poller's own long poll is its wait; it loops straight back.
void loop("poller", async () => void (await pollOnce(db, api, cfg.ownerId, me.username, 25, stop.signal)), 0);
void loop(
  "waker",
  async () => {
    commandPass(db);
    wakerPass({ db, spawn: spawnTurn });
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

function shutdown(signal: string): void {
  // Running turns are NOT stopped: they are detached, and outliving this process is why they are.
  console.log(`${signal}: shuvi server exiting; ${runningTurns(db).length} turn(s) left running`);
  stop.abort();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
