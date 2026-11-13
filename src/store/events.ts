import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, max, ne, notInArray, or } from "drizzle-orm";
import type { Db } from "./db.ts";
import { asksForTurn, chatEvents, chatLanes, chats, kv, OUTBOUND_KINDS, TRIGGER_KINDS } from "./schema.ts";

/**
 * Reads and writes on `chat_events`, `chats` and `kv`. Every write that must happen once is an
 * INSERT ... ON CONFLICT DO NOTHING on a unique key (schema.ts says which), so a caller that repeats itself
 * after a crash cannot double anything.
 */

// ---- payload shapes, by kind ------------------------------------------------------------------------

export interface Speaker {
  id: number;
  /** Their display name (first and last name), as people see it. */
  name: string;
  /** Their @username, if they have one (without the @). */
  username?: string;
  /** Another bot. */
  isBot?: boolean;
}

export interface MessagePayload {
  from: Speaker;
  text: string;
  /** The message replied to, as Telegram gave it (it may predate anything recorded here). `fromId`: its sender's user id. */
  replyTo?: { tgMessageId: number; fromName?: string; fromId?: number; text?: string };
  /** Who the message names: @usernames (lower case, without the @) and text mentions (user ids). */
  mentions?: { usernames: string[]; userIds: number[] };
  /** True when `text` stands in for content this slice cannot read yet (a sticker, a photo). */
  placeholder?: boolean;
  /** Where a forwarded message came from. */
  forwardedFrom?: string;
  /** A picture the message carries that the model can be shown (a photo, a sticker). See MessageMedia. */
  media?: MessageMedia;
  /** A file the message carries, to be copied into the chat's computer (`~/inbox/`). See MessageAttachment. */
  attachment?: MessageAttachment;
}

/**
 * A file the owner sent (a document, a photo, a video, audio), recorded with the message as a plain fact
 * (no `state`). Only the computer capability handles it (src/capabilities/computer/files.ts), and only
 * while it is on: it copies a new one into the chat's computer when that computer next runs, a photo only
 * when asked to (`requested`), and completes the record in place.
 */
export interface MessageAttachment {
  kind: "document" | "photo" | "video" | "audio" | "voice" | "video_note" | "animation";
  fileId: string;
  fileUniqueId: string;
  /** The file's name as sent, or one made up from its kind (`photo.jpg`). */
  name: string;
  /** Its size in bytes, as Telegram gave it. */
  size?: number;
  mimeType?: string;
  /**
   * Unset: new, not handled yet. requested: a photo asked for (`save_photo`); ready: at `path`; failed: given
   * up (`error`); skipped: left out (a photo nobody asked for, or a file sent before the computer was on).
   */
  state?: "requested" | "ready" | "failed" | "skipped";
  /** Where it is in the computer, from its home: `inbox/<message id>-<name>`. */
  path?: string;
  attempts?: number;
  error?: string;
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

/**
 * A file the assistant sends (computer/files.ts `send_file`, `send_photo`). The bytes wait in the data dir
 * at `file` (`<data dir>/outbox/…`, absolute) until the sender has delivered them, and are deleted then.
 */
export interface BotFilePayload {
  as: "document" | "photo";
  /** The bytes to send, an absolute path under `<data dir>/outbox/`. */
  file: string;
  /** The file name Telegram shows. */
  name: string;
  caption?: string;
  /** Where it came from in the computer, for the record. */
  source: string;
  bytes: number;
}

/** A schedule came due. */
export interface ScheduledPayload {
  scheduleId: number;
  note: string;
  /** When it was due (ISO). Later than this by much means it fired late, after downtime. */
  dueAt: string;
  /** Recurring: its cron expression. */
  cron?: string;
}

/** A job's outcome, written back to the chat it was started from. */
export interface JobDonePayload {
  jobId: number;
  kind: string;
  /** What was asked. */
  title: string;
  state: "done" | "failed" | "expired";
  result: string;
}

/** Something an external system POSTed to `/inbound/<source>`. */
export interface ExternalPayload {
  source: string;
  text: string;
  /** false: recorded for the next turn, but does not start one (inbound.yaml `trigger: false`). */
  trigger: boolean;
}

/** A sticker the assistant sends (src/capabilities/stickers/). */
export interface BotStickerPayload {
  /** What `sendSticker` takes. */
  fileId: string;
  /** The sticker's stable identity: what its recent uses are counted by. */
  fileUniqueId: string;
  /** Its library id (`<pack>/<n>`), for people reading the log. */
  stickerId: string;
  emoji?: string;
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

/**
 * Forget the active conversation (a lost one): the next turn starts a fresh one in the same lane. The
 * conversations parked in other lanes (agent/switch.ts), `chat_events` and the cursor stay.
 */
export function resetConversation(db: Db, chatId: number): void {
  db.update(chats).set({ backendSessionId: null, laneEnteredAt: null, contextTokens: null }).where(eq(chats.id, chatId)).run();
}

/**
 * `/new`: forget every conversation of the chat, the active one and those parked in other lanes. Their
 * histories stay until retention prunes them (store/conversations.ts).
 */
export function forgetConversations(db: Db, chatId: number): void {
  db.transaction((tx) => {
    tx.update(chats).set({ backendSessionId: null, laneEnteredAt: null, contextTokens: null }).where(eq(chats.id, chatId)).run();
    tx.delete(chatLanes).where(eq(chatLanes.chatId, chatId)).run();
  }, { behavior: "immediate" });
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

/**
 * Inbound events past `afterSeq` that are a turn's input (TRIGGER_KINDS, quiet `external` ones included:
 * they do not start a turn, but the next turn is shown them), oldest first.
 */
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
    .where(and(eq(chatEvents.chatId, chatId), asksForTurn()))
    .get();
  return row?.m ?? 0;
}

export function getEvent(db: Db, seq: number): ChatEvent | undefined {
  return db.select().from(chatEvents).where(eq(chatEvents.seq, seq)).get();
}

/** The inbound event recorded for Telegram update `updateId`. */
export function eventOfUpdate(db: Db, updateId: number): ChatEvent | undefined {
  return db.select().from(chatEvents).where(eq(chatEvents.tgUpdateId, updateId)).get();
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

/**
 * The chat's newest event before `beforeSeq`, of any kind (hers included): when the chat was last active,
 * for the "It is now…" line a turn opens with after a gap (agent/turn.ts `GAP_NOTE_MINUTES`). Skipped:
 * an outbound row that failed (nobody saw it), and what is said to the FRAMEWORK rather than in the chat,
 * a command (`/new`, `/stop`) and the server's reaction acknowledging it (an outbound row with no turn),
 * so `/new` after two days still reads as two days.
 */
export function previousEvent(db: Db, chatId: number, beforeSeq: number): ChatEvent | undefined {
  return db
    .select()
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatId, chatId),
        lt(chatEvents.seq, beforeSeq),
        ne(chatEvents.kind, "command"),
        or(notInArray(chatEvents.kind, OUTBOUND_KINDS), isNotNull(chatEvents.turnId)),
        or(isNull(chatEvents.status), ne(chatEvents.status, "failed")),
      ),
    )
    .orderBy(desc(chatEvents.seq))
    .limit(1)
    .get();
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

/**
 * Record an event the FRAMEWORK perceived (a schedule come due, a job's result, an inbound POST). `idemKey`
 * makes it exactly-once: a second write with the same key is dropped (an inbound POST without an
 * Idempotency-Key has none). Returns its seq, or null when the key was already recorded.
 */
export function recordFrameworkEvent(
  db: Db,
  e:
    | { chatId: number; kind: "scheduled"; payload: ScheduledPayload; idemKey: string }
    | { chatId: number; kind: "job_done"; payload: JobDonePayload; idemKey: string }
    | { chatId: number; kind: "external"; payload: ExternalPayload; idemKey: string | null },
): number | null {
  const rows = db
    .insert(chatEvents)
    .values({ chatId: e.chatId, kind: e.kind, payload: e.payload as unknown as Record<string, unknown>, idemKey: e.idemKey })
    .onConflictDoNothing()
    .returning({ seq: chatEvents.seq })
    .all();
  return rows[0]?.seq ?? null;
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
    | { chatId: number; kind: "bot_reaction"; payload: BotReactionPayload; idemKey: string; turnId?: number }
    | { chatId: number; kind: "bot_sticker"; payload: BotStickerPayload; idemKey: string; turnId?: number }
    | { chatId: number; kind: "bot_file"; payload: BotFilePayload; idemKey: string; turnId?: number },
): number | null {
  const row = db
    .insert(chatEvents)
    .values({
      chatId: e.chatId,
      kind: e.kind,
      payload: e.payload as unknown as Record<string, unknown>,
      idemKey: e.idemKey,
      status: "pending",
      turnId: e.turnId ?? null,
    })
    .onConflictDoNothing()
    .returning({ seq: chatEvents.seq })
    .get();
  // A second write of the same key wrote nothing: the row that holds the key is the message.
  return row?.seq ?? db.select({ seq: chatEvents.seq }).from(chatEvents).where(eq(chatEvents.idemKey, e.idemKey)).get()?.seq ?? null;
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
