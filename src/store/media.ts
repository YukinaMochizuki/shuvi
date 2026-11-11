import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolContent } from "agent-runtime";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "./db.ts";
import type { ChatEvent, MessageAttachment, MessageMedia, MessagePayload } from "./events.ts";
import { ATTACHMENT_PENDING, chatEvents } from "./schema.ts";
import { IMMEDIATE } from "./turns.ts";

/**
 * The `media` of message events (events.ts `MessageMedia`): which ones still wait for a download, and
 * completing one in place once it is fetched. The media lives in the message's own payload, so it is
 * recorded in the same write as the message (invariant 1) and kept with it for good.
 */

/** Message events whose media is waiting to be downloaded, oldest first. */
export function pendingMedia(db: Db, limit = 20): ChatEvent[] {
  return db
    .select()
    .from(chatEvents)
    .where(and(eq(chatEvents.kind, "message"), sql`json_extract(${chatEvents.payload}, '$.media.state') = 'pending'`))
    .orderBy(asc(chatEvents.seq))
    .limit(limit)
    .all();
}

export function mediaOfEvent(e: ChatEvent): MessageMedia | undefined {
  return e.kind === "message" ? (e.payload as unknown as MessagePayload).media : undefined;
}

/**
 * Message events whose attachment is still to be handled (new, or asked for), oldest first: in one chat, or
 * in all. Uses the partial index `chat_events_attachment_pending` (same predicate).
 */
export function pendingAttachments(db: Db, chatId?: number, limit = 50): ChatEvent[] {
  return db
    .select()
    .from(chatEvents)
    .where(and(ATTACHMENT_PENDING, ...(chatId !== undefined ? [eq(chatEvents.chatId, chatId)] : []), eq(chatEvents.kind, "message")))
    .orderBy(asc(chatEvents.seq))
    .limit(limit)
    .all();
}

export function attachmentOfEvent(e: ChatEvent): MessageAttachment | undefined {
  return e.kind === "message" ? (e.payload as unknown as MessagePayload).attachment : undefined;
}

/** Merge `patch` into event `seq`'s attachment. */
export function updateAttachment(db: Db, seq: number, patch: Partial<MessageAttachment>): void {
  db.transaction((tx) => {
    const e = tx.select().from(chatEvents).where(eq(chatEvents.seq, seq)).get();
    const p = e?.payload as unknown as MessagePayload | undefined;
    if (!p?.attachment) return;
    const payload: MessagePayload = { ...p, attachment: { ...p.attachment, ...patch } };
    tx.update(chatEvents)
      .set({ payload: payload as unknown as Record<string, unknown> })
      .where(eq(chatEvents.seq, seq))
      .run();
  }, IMMEDIATE);
}

/**
 * Which file under the data dir an image part was read from, so a turn transcript (agent/transcript.ts)
 * stores the path instead of a copy of the bytes. Keyed on the part object itself: the part is handed on
 * unchanged (into a prompt, a tool's result), and the tag goes when the part does.
 */
const IMAGE_FILES = new WeakMap<object, string>();

/** An image part read from `rel` (a path under `dataDir`), tagged with where it came from. Throws if unreadable. */
export function imageFromFile(dataDir: string, rel: string, mimeType: string): ToolContent {
  const part: ToolContent = { type: "image", data: readFileSync(join(dataDir, rel)).toString("base64"), mimeType };
  IMAGE_FILES.set(part, rel);
  return part;
}

/** The data-dir path an image part was read from (`imageFromFile`), if it was. */
export function imageFileOf(part: object): string | undefined {
  return IMAGE_FILES.get(part);
}

/** The image type of `bytes`, from their signature (Telegram's file paths do not say reliably), or null. */
export function sniffImage(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

/** Merge `patch` into event `seq`'s media. */
export function updateMedia(db: Db, seq: number, patch: Partial<MessageMedia>): void {
  db.transaction((tx) => {
    const e = tx.select().from(chatEvents).where(eq(chatEvents.seq, seq)).get();
    const p = e?.payload as unknown as MessagePayload | undefined;
    if (!p?.media) return;
    const payload: MessagePayload = { ...p, media: { ...p.media, ...patch } };
    tx.update(chatEvents)
      .set({ payload: payload as unknown as Record<string, unknown> })
      .where(eq(chatEvents.seq, seq))
      .run();
  }, IMMEDIATE);
}
