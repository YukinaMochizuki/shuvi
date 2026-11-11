import type { Api } from "grammy";
import type { Update } from "grammy/types";
import type { Db } from "../store/db.ts";
import { ensureChat, kvGet, kvSet, recordInbound } from "../store/events.ts";
import { classify } from "../telegram/inbound.ts";
import { IMMEDIATE } from "../store/turns.ts";

/**
 * Long polling, with the offset kept in OUR store rather than left to Telegram's session.
 *
 * Telegram re-delivers every update until a `getUpdates` call passes an offset past it. So the offset this
 * process sends is the one stored in `kv`, and it is advanced in the SAME transaction that records the
 * batch: either the events and the new offset are both written, or neither is and the next call fetches
 * the same updates again. `tg_update_id` is unique, so a batch recorded twice is recorded once.
 *
 * This is why grammY's `bot.start()` is not used: it confirms updates on its own schedule, which would
 * let an update be confirmed before it is safely written down (invariant 1 of docs/design.md).
 */

export const OFFSET_KEY = "telegram_offset";

/** Record one batch of updates and advance the offset past it, atomically. */
export function recordBatch(db: Db, updates: Update[], ownerId: number, botUsername?: string): { recorded: number; ignored: number } {
  let recorded = 0;
  let ignored = 0;
  if (!updates.length) return { recorded, ignored };
  db.transaction((tx) => {
    const tdb = tx as unknown as Db;
    for (const u of updates) {
      const c = classify(u, ownerId, botUsername);
      if (c.kind === "ignore") {
        ignored++;
        continue;
      }
      const chat = ensureChat(tdb, { id: c.chat.id, kind: "private" });
      const base = { chatId: chat.id, tgUpdateId: u.update_id, tgMessageId: c.tgMessageId };
      const fresh = c.kind === "command" ? recordInbound(tdb, { ...base, kind: "command", payload: c.payload }) : recordInbound(tdb, { ...base, kind: "message", payload: c.payload });
      if (fresh) recorded++;
    }
    kvSet(tdb, OFFSET_KEY, String(updates.at(-1)!.update_id + 1));
  }, IMMEDIATE);
  return { recorded, ignored };
}

export function currentOffset(db: Db): number | undefined {
  const v = kvGet(db, OFFSET_KEY);
  return v ? Number(v) : undefined;
}

/** One long-poll round: fetch, record, advance. */
export async function pollOnce(db: Db, api: Api, ownerId: number, botUsername: string | undefined, timeoutSec = 25, signal?: AbortSignal): Promise<number> {
  const offset = currentOffset(db);
  const updates = await api.getUpdates({ ...(offset !== undefined ? { offset } : {}), timeout: timeoutSec, allowed_updates: ["message"] }, signal as never); // grammY types its own AbortSignal shim
  recordBatch(db, updates, ownerId, botUsername);
  return updates.length;
}
