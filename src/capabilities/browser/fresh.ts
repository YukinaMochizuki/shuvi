import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import type { Db } from "../../store/db.ts";
import { kvGet, kvSet } from "../../store/events.ts";
import { turnSteps, turns } from "../../store/schema.ts";

/**
 * Whether the model has read the last page text of this chat's window. porchkit answers an action on the same page
 * with only what changed since the page text it last gave (its `snapshot_kind: "delta"`), but its session
 * (`chat-<id>`) outlives the model's conversation: after `/new`, `/newclean`, a switch to another model's conversation,
 * a lost conversation restarted, or a compaction, the model no longer holds that text, and a delta against it would
 * be read as the whole truth. So the first page text after any of those is asked for whole (`whole: true`, porchkit's
 * flag).
 *
 *   mark   the conversation the model is in: the latest turn of the chat that opened one (`turns.opening` other than
 *          `resumed`) and the chat's latest compaction (`turn_steps` of kind `compaction`), as one string.
 *   kv     `browser_seen:<chat>`: the mark under which the model was last given a whole page text. Another mark, or
 *          none, sends `whole: true`. It is set when an answer carries a whole page text (not a delta, not a part of
 *          one, not find's matches), and cleared after a failure that may have come after the act (porchkit's answer
 *          lost on the way: the model never read it), so the next page text is whole again.
 */

const seenKey = (chatId: number) => `browser_seen:${chatId}`;

/** The conversation the model is in now (the header's `mark`). */
export function conversationMark(db: Db, chatId: number): string {
  const opened = db
    .select({ id: turns.id })
    .from(turns)
    .where(and(eq(turns.chatId, chatId), isNotNull(turns.opening), ne(turns.opening, "resumed")))
    .orderBy(desc(turns.id))
    .limit(1)
    .get();
  const compacted = db
    .select({ id: turnSteps.id })
    .from(turnSteps)
    .innerJoin(turns, eq(turns.id, turnSteps.turnId))
    .where(and(eq(turns.chatId, chatId), eq(turnSteps.kind, "compaction")))
    .orderBy(desc(turnSteps.id))
    .limit(1)
    .get();
  return `${opened?.id ?? 0}:${compacted?.id ?? 0}`;
}

/** `{ whole: true }` when this conversation has not been given the window's page text yet. */
export function wholeFlag(db: Db, chatId: number): { whole?: true } {
  return kvGet(db, seenKey(chatId)) === conversationMark(db, chatId) ? {} : { whole: true };
}

/** The model was given a whole page text in this conversation. */
export function seenWhole(db: Db, chatId: number): void {
  kvSet(db, seenKey(chatId), conversationMark(db, chatId));
}

/** The model may not have read the last page text (an answer lost on the way): the next one is whole. */
export function unseen(db: Db, chatId: number): void {
  kvSet(db, seenKey(chatId), "");
}
