import { and, asc, desc, eq, gt, inArray, lte, max } from "drizzle-orm";
import type { Db } from "./db.ts";
import { chatEvents, chats, kv, OUTBOUND_KINDS, TRIGGER_KINDS } from "./schema.ts";

/**
 * Reads and writes on `chat_events`, `chats` and `kv`. Every write that must happen once is an
 * INSERT ... ON CONFLICT DO NOTHING on a unique key (schema.ts says which), so a caller that repeats itself
 * after a crash cannot double anything.
 */

// ---- payload shapes, by kind ------------------------------------------------------------------------

export interface Speaker {
  id: number;
  name: string;
}

export interface MessagePayload {
  from: Speaker;
  text: string;
  /** The message replied to, as Telegram gave it (it may predate anything recorded here). */
  replyTo?: { tgMessageId: number; fromName?: string; text?: string };
  /** True when `text` stands in for content this slice cannot read yet (a sticker, a photo). */
  placeholder?: boolean;
  /** Where a forwarded message came from. */
  forwardedFrom?: string;
  /** A picture the message carries that the model can be shown (a photo, a sticker). See MessageMedia. */
  media?: MessageMedia;
}

/**
 * The picture a message carries, as recorded with the message and completed in place by the server once
 * downloaded (src/capabilities/vision/). `text` keeps its placeholder ("[sticker: 😳, Pack]") either way, so
 * the emoji and pack stay known whether or not the image can be shown. Never pruned from `chat_events`.
 */
export interface MessageMedia {
  kind: "photo" | "sticker";
  /** The photo's or sticker's own `file_unique_id`: its stable identity (a sticker's, for the library). */
  fileUniqueId: string;
  /**
   * The file shown to the model: the photo size chosen, a static sticker itself, or an animated or video
   * sticker's thumbnail (`thumbnail`). Null when there is nothing to show (an animated sticker with no
   * thumbnail).
   */
  file: { fileId: string; fileUniqueId: string; thumbnail?: boolean } | null;
  /** pending: not downloaded yet; ready: at `path`; failed: given up (`error`); none: nothing to fetch. */
  state: "pending" | "ready" | "failed" | "none";
  /** Relative to the data dir: `media/<file.fileUniqueId>`. Set once downloaded. */
  path?: string;
  /** The downloaded file's media type, read from its bytes. */
  mimeType?: string;
  attempts?: number;
  error?: string;
}

export interface CommandPayload {
  from: Speaker;
  command: "new" | "stop";
}

export interface BotMessagePayload {
  text: string;
  /** The event (by seq) this message replies to. */
  replyToSeq?: number;
  /** Delivery progress: the Telegram ids of the parts already sent (a long message is several). */
  sentParts?: number[];
}

/** The owner answered an approval card (src/control/approvals.ts) that was asked to wake this chat. */
export interface ApprovalPayload {
  from: Speaker;
  approvalId: number;
  /** The approval's kind (who asked) and title, as put to the owner. */
  kind: string;
  title: string;
  /** The chosen option's id and label, or null when the card expired unanswered. */
  answer: string | null;
  label: string | null;
}

export interface BotReactionPayload {
  targetSeq: number;
  emoji: string;
}

export type ChatEvent = typeof chatEvents.$inferSelect;
export type Chat = typeof chats.$inferSelect;

// ---- chats ------------------------------------------------------------------------------------------

export function ensureChat(db: Db, tg: { id: number; kind: "private" | "group"; title?: string | null }): Chat {
  db.insert(chats)
    .values({ tgChatId: tg.id, kind: tg.kind, title: tg.title ?? null })
    .onConflictDoNothing()
    .run();
  return db.select().from(chats).where(eq(chats.tgChatId, tg.id)).get()!;
}

export function getChat(db: Db, chatId: number): Chat | undefined {
  return db.select().from(chats).where(eq(chats.id, chatId)).get();
}

export function allChats(db: Db): Chat[] {
  return db.select().from(chats).all();
}

/** Forget the model's conversation: the next turn starts a fresh one. `chat_events` and the cursor stay. */
export function resetConversation(db: Db, chatId: number): void {
  db.update(chats).set({ backendSessionId: null, contextTokens: null }).where(eq(chats.id, chatId)).run();
}

// ---- inbound ----------------------------------------------------------------------------------------

/**
 * Record an inbound event. Returns false when this update was already recorded (Telegram re-delivers an
 * update until its offset is confirmed, and we confirm only after recording).
 */
export function recordInbound(
  db: Db,
  e: { chatId: number; kind: "message"; payload: MessagePayload; tgUpdateId: number; tgMessageId: number } | { chatId: number; kind: "command"; payload: CommandPayload; tgUpdateId: number; tgMessageId: number },
): boolean {
  const inserted = db
    .insert(chatEvents)
    .values({
      chatId: e.chatId,
      kind: e.kind,
      payload: e.payload as unknown as Record<string, unknown>,
      tgUpdateId: e.tgUpdateId,
      tgMessageId: e.tgMessageId,
      status: e.kind === "command" ? "pending" : null,
    })
    .onConflictDoNothing()
    .returning({ seq: chatEvents.seq })
    .all();
  return inserted.length > 0;
}

/** Inbound events past `afterSeq` that ask for a turn, oldest first. */
export function triggersAfter(db: Db, chatId: number, afterSeq: number): ChatEvent[] {
  return db
    .select()
    .from(chatEvents)
    .where(and(eq(chatEvents.chatId, chatId), gt(chatEvents.seq, afterSeq), inArray(chatEvents.kind, TRIGGER_KINDS)))
    .orderBy(asc(chatEvents.seq))
    .all();
}

/** The newest seq in the chat that asks for a turn (0 when none). */
export function lastTriggerSeq(db: Db, chatId: number): number {
  const row = db
    .select({ m: max(chatEvents.seq) })
    .from(chatEvents)
    .where(and(eq(chatEvents.chatId, chatId), inArray(chatEvents.kind, TRIGGER_KINDS)))
    .get();
  return row?.m ?? 0;
}

export function getEvent(db: Db, seq: number): ChatEvent | undefined {
  return db.select().from(chatEvents).where(eq(chatEvents.seq, seq)).get();
}

/**
 * The last `limit` things said in the chat at or before `atOrBefore`, by anyone, oldest first: what a
 * fresh conversation is shown so it knows what was just being talked about. Outbound messages count only
 * once delivered (a failed one was never seen by the person).
 */
export function recentHistory(db: Db, chatId: number, atOrBefore: number, limit: number): ChatEvent[] {
  return db
    .select()
    .from(chatEvents)
    .where(and(eq(chatEvents.chatId, chatId), lte(chatEvents.seq, atOrBefore), inArray(chatEvents.kind, ["message", "bot_message"])))
    .orderBy(desc(chatEvents.seq))
    .all()
    .filter((e) => e.kind === "message" || e.status === "sent")
    .slice(0, limit)
    .reverse();
}

/** The newest inbound message of a chat (what a bare `pass(reaction)` reacts to). */
export function lastMessage(db: Db, chatId: number, atOrBefore: number): ChatEvent | undefined {
  return db
    .select()
    .from(chatEvents)
    .where(and(eq(chatEvents.chatId, chatId), eq(chatEvents.kind, "message"), lte(chatEvents.seq, atOrBefore)))
    .orderBy(desc(chatEvents.seq))
    .limit(1)
    .get();
}

export function pendingCommands(db: Db): ChatEvent[] {
  return db
    .select()
    .from(chatEvents)
    .where(and(eq(chatEvents.kind, "command"), eq(chatEvents.status, "pending")))
    .orderBy(asc(chatEvents.seq))
    .all();
}

export function markCommandDone(db: Db, seq: number, note: string): void {
  db.update(chatEvents).set({ status: "done", note }).where(eq(chatEvents.seq, seq)).run();
}

/**
 * Record that an approval was answered (or expired) in the chat that asked, to wake it: an `approval`
 * event is a trigger. Keyed on the approval, so it is recorded once.
 */
export function recordApprovalEvent(db: Db, chatId: number, payload: ApprovalPayload): void {
  db.insert(chatEvents)
    .values({ chatId, kind: "approval", payload: payload as unknown as Record<string, unknown>, idemKey: `approval:${payload.approvalId}` })
    .onConflictDoNothing()
    .run();
}

// ---- outbound ---------------------------------------------------------------------------------------

/**
 * Queue something for the sender. `idemKey` makes a repeat a no-op: a turn that is re-run, or a tool
 * handler that is retried, writes the same key and the second write is dropped.
 */
export function enqueueOutbound(
  db: Db,
  e:
    | { chatId: number; kind: "bot_message"; payload: BotMessagePayload; idemKey: string; turnId?: number }
    | { chatId: number; kind: "bot_reaction"; payload: BotReactionPayload; idemKey: string; turnId?: number },
): void {
  db.insert(chatEvents)
    .values({
      chatId: e.chatId,
      kind: e.kind,
      payload: e.payload as unknown as Record<string, unknown>,
      idemKey: e.idemKey,
      status: "pending",
      turnId: e.turnId ?? null,
    })
    .onConflictDoNothing()
    .run();
}

/** Outbound rows not yet delivered, oldest first (the sender keeps each chat in order). */
export function pendingOutbound(db: Db): ChatEvent[] {
  return db
    .select()
    .from(chatEvents)
    .where(and(inArray(chatEvents.kind, OUTBOUND_KINDS), eq(chatEvents.status, "pending")))
    .orderBy(asc(chatEvents.seq))
    .all();
}

/** Record a delivered part of a long message, so a crash between parts does not resend the earlier ones. */
export function recordPartSent(db: Db, seq: number, payload: BotMessagePayload, tgMessageId: number): void {
  const sentParts = [...(payload.sentParts ?? []), tgMessageId];
  db.update(chatEvents)
    .set({ payload: { ...payload, sentParts } as unknown as Record<string, unknown> })
    .where(eq(chatEvents.seq, seq))
    .run();
}

export function markSent(db: Db, seq: number, tgMessageId: number | null): void {
  db.update(chatEvents).set({ status: "sent", tgMessageId }).where(eq(chatEvents.seq, seq)).run();
}

export function markFailed(db: Db, seq: number, note: string): void {
  db.update(chatEvents).set({ status: "failed", note }).where(eq(chatEvents.seq, seq)).run();
}

// ---- kv ---------------------------------------------------------------------------------------------

export function kvGet(db: Db, key: string): string | undefined {
  return db.select().from(kv).where(eq(kv.key, key)).get()?.value;
}

export function kvSet(db: Db, key: string, value: string): void {
  db.insert(kv).values({ key, value }).onConflictDoUpdate({ target: kv.key, set: { value } }).run();
}
