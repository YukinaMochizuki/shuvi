import type { Api } from "grammy";
import type { Update } from "grammy/types";
import { entryToDoc, proposedGroupEntry, type Policy } from "../policy/policy.ts";
import { requestPolicyChange } from "../policy/write.ts";
import { raiseAlert } from "../store/control.ts";
import type { Db } from "../store/db.ts";
import { ensureChat, eventOfUpdate, kvGet, kvSet, recordInbound, type ChatEvent, type Speaker } from "../store/events.ts";
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
/** `unknown_chat:<tg chat id>`: the owner was already asked about this group. */
export const UNKNOWN_CHAT_PREFIX = "unknown_chat:";

/** What the poller needs besides the updates: who the bot is, the policy in effect, where home/ is. */
export interface InboundContext {
  botUsername?: string;
  policy?: Policy;
  /** For the diff on the unknown-group card. */
  home?: string;
  /**
   * Called with the events a batch newly recorded, once its transaction has committed (and before the poller
   * yields, so before the waker can start a turn for them): the capabilities' inbound hooks (main.ts).
   */
  onRecorded?: (events: ChatEvent[]) => void;
}

const who = (s: Speaker) => `${s.name}${s.username ? ` (@${s.username})` : ""}, user id ${s.id}`;

/**
 * What is not recorded is still not lost on the owner (docs/design.md §7, §13):
 *   - a private message from someone else: an alert, at most one per sender per (UTC) day;
 *   - the first message from a group policy does not list: one approval card offering to add the group,
 *     with the entry it would get (policy/write.ts). Asked once per group, ever (`unknown_chat:<id>` in
 *     kv): if the owner says no, the group stays unlisted and silent. Approving writes the entry; the
 *     messages before that were never recorded.
 * Both are written in the batch's transaction, so they are raised once, like the batch is recorded once.
 */
function tellOwner(db: Db, c: ReturnType<typeof classify>, ownerId: number, ctx: InboundContext, now: number): void {
  if (c.kind === "ignore" && c.stranger) {
    const day = new Date(now).toISOString().slice(0, 10);
    raiseAlert(db, { key: `stranger:${c.stranger.id}:${day}`, text: `${who(c.stranger)} wrote to the bot in a private chat. Only the owner is answered there, so it was ignored and not recorded.` }, now);
  }
  if (c.kind === "unknown_chat") {
    const key = `${UNKNOWN_CHAT_PREFIX}${c.chat.id}`;
    if (kvGet(db, key)) return;
    kvSet(db, key, new Date(now).toISOString());
    const name = c.chat.title ? `"${c.chat.title}"` : "an untitled group";
    const r = requestPolicyChange(
      db,
      ctx.home,
      ownerId,
      { chat: String(c.chat.id), entry: entryToDoc(proposedGroupEntry(c.chat.title ?? undefined)) },
      {
        title: `Add the group ${name} (${c.chat.id})?`,
        why: `${who(c.from)} wrote in ${name}, which home/policy.yaml does not list. Nothing said there is recorded or answered until it is. Add it with this entry? (You can edit it in the file later.)`,
        approveLabel: "Add it",
        rejectLabel: "Ignore it",
      },
    );
    // policy.yaml is broken (and alerted as such): say so rather than ask for something that cannot be written.
    if ("error" in r) raiseAlert(db, { key: key, text: `${who(c.from)} wrote in ${name} (${c.chat.id}), which home/policy.yaml does not list; it cannot be added for now: ${r.error}.` }, now);
  }
}

/** Record one batch of updates and advance the offset past it, atomically. */
export function recordBatch(db: Db, updates: Update[], ownerId: number, ctx: InboundContext = {}, now = Date.now()): { recorded: number; ignored: number } {
  let recorded = 0;
  let ignored = 0;
  if (!updates.length) return { recorded, ignored };
  const fresh: ChatEvent[] = [];
  db.transaction((tx) => {
    const tdb = tx as unknown as Db;
    for (const u of updates) {
      const c = classify(u, ownerId, ctx.botUsername, ctx.policy);
      if (c.kind === "ignore" || c.kind === "unknown_chat") {
        tellOwner(tdb, c, ownerId, ctx, now);
        ignored++;
        continue;
      }
      const chat = ensureChat(tdb, c.chat.type === "private" ? { id: c.chat.id, kind: "private" } : { id: c.chat.id, kind: "group", title: c.chat.title });
      const base = { chatId: chat.id, tgUpdateId: u.update_id, tgMessageId: c.tgMessageId };
      const isNew = c.kind === "command" ? recordInbound(tdb, { ...base, kind: "command", payload: c.payload }) : recordInbound(tdb, { ...base, kind: "message", payload: c.payload });
      if (isNew) {
        recorded++;
        const e = ctx.onRecorded && eventOfUpdate(tdb, u.update_id);
        if (e) fresh.push(e);
      }
    }
    kvSet(tdb, OFFSET_KEY, String(updates.at(-1)!.update_id + 1));
  }, IMMEDIATE);
  if (fresh.length) {
    try {
      ctx.onRecorded?.(fresh);
    } catch (e) {
      console.error(`poller: inbound hooks failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { recorded, ignored };
}

export function currentOffset(db: Db): number | undefined {
  const v = kvGet(db, OFFSET_KEY);
  return v ? Number(v) : undefined;
}

/** One long-poll round: fetch, record, advance. */
export async function pollOnce(db: Db, api: Api, ownerId: number, ctx: InboundContext | (() => InboundContext) = {}, timeoutSec = 25, signal?: AbortSignal): Promise<number> {
  const offset = currentOffset(db);
  const updates = await api.getUpdates({ ...(offset !== undefined ? { offset } : {}), timeout: timeoutSec, allowed_updates: ["message"] }, signal as never); // grammY types its own AbortSignal shim
  // The policy is read after the long poll returns, so an edit made while it waited applies to this batch.
  recordBatch(db, updates, ownerId, typeof ctx === "function" ? ctx() : ctx);
  return updates.length;
}
