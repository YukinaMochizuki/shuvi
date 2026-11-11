import { and, desc, eq, gt, inArray, isNull, lte, ne, or } from "drizzle-orm";
import type { Db } from "../../store/db.ts";
import type { MessagePayload } from "../../store/events.ts";
import { chatEvents } from "../../store/schema.ts";
import type { LibrarySticker } from "./find.ts";

/**
 * The MECHANICAL rules of sending a sticker (docs/design.md §12): the framework guarantees these, so the
 * assistant's taste only ever chooses among stickers that may be sent. Whether one fits is hers.
 *
 *   - `never` is never sent.
 *   - Outside the owner's DM, nothing `dm_only` (on the sticker or its pack) is sent.
 *   - No two stickers in a row: the last thing in the chat (a message, a sticker or a reaction, hers or
 *     theirs) must not be a sticker she sent. Text she wrote before calling `sticker` is already queued
 *     by then (the turn flushes text at every tool call), so "text, sticker, text, sticker" is fine.
 *   - No echo: not the sticker the other person just sent (any sticker they sent since she last spoke).
 *   - The pack must have been fetched from Telegram, or there is no `file_id` to send.
 *
 * Each refusal says why, in a sentence she can act on.
 */

const SEQUENCE_KINDS = ["message", "bot_message", "bot_sticker", "bot_reaction"] as const;
const notFailed = or(isNull(chatEvents.status), ne(chatEvents.status, "failed"));

export function refusal(db: Db, chatId: number, toSeq: number, s: LibrarySticker, inDm: boolean): string | null {
  if (s.tier === "never") return `${s.id} is marked never: it is not to be sent.`;
  if (s.dmOnly && !inDm) return `${s.id} is for the owner's DM only, and this is not it.`;
  if (!s.meta) return `${s.id}'s pack has not been fetched from Telegram yet, so it cannot be sent; try again in a moment.`;

  const last = db
    .select({ kind: chatEvents.kind })
    .from(chatEvents)
    .where(and(eq(chatEvents.chatId, chatId), inArray(chatEvents.kind, [...SEQUENCE_KINDS]), notFailed))
    .orderBy(desc(chatEvents.seq))
    .limit(1)
    .get();
  if (last?.kind === "bot_sticker") return "The last thing in the chat is already a sticker you sent. One sticker at a time: say something, or do something else, before another.";

  const lastSpoke = db
    .select({ seq: chatEvents.seq })
    .from(chatEvents)
    .where(and(eq(chatEvents.chatId, chatId), inArray(chatEvents.kind, ["bot_message", "bot_sticker"]), notFailed))
    .orderBy(desc(chatEvents.seq))
    .limit(1)
    .get();
  const theirs = db
    .select({ payload: chatEvents.payload })
    .from(chatEvents)
    .where(and(eq(chatEvents.chatId, chatId), eq(chatEvents.kind, "message"), gt(chatEvents.seq, lastSpoke?.seq ?? 0), lte(chatEvents.seq, toSeq)))
    .all();
  const echoed = theirs.some((e) => {
    const m = (e.payload as unknown as MessagePayload).media;
    return m?.kind === "sticker" && m.fileUniqueId === s.fileUniqueId;
  });
  if (echoed) return `${s.id} is the sticker they just sent you. Do not echo it back; pick another, or answer in words.`;
  return null;
}
