import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "./db.ts";
import type { ChatEvent, MessageMedia, MessagePayload } from "./events.ts";
import { chatEvents } from "./schema.ts";
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
