import { asc, eq } from "drizzle-orm";
import type { Db } from "./db.ts";
import type { Chat } from "./events.ts";
import { chats, warmRunners } from "./schema.ts";

/**
 * Which profile each chat uses (`chats.profile`; the profiles themselves are folders in home/:
 * capabilities/memory/layers.ts). Null: none, the base. A switch applies from the chat's next turn (agent/turn.ts
 * reads it when a turn starts and records it on the turn); a running turn is left as it is.
 */

export function setChatProfile(db: Db, chatId: number, profile: string | null): void {
  db.transaction((tx) => {
    tx.update(chats).set({ profile }).where(eq(chats.id, chatId)).run();
    // The chat's warm runner, if one waits, is retired (store/warm.ts): its CLI's prompt was the old profile's.
    tx.delete(warmRunners).where(eq(warmRunners.chatId, chatId)).run();
  });
}

/** The chats set to `profile`, oldest first. */
export function chatsOnProfile(db: Db, profile: string): Chat[] {
  return db.select().from(chats).where(eq(chats.profile, profile)).orderBy(asc(chats.id)).all();
}

/** A profile renamed: its chats follow it. */
export function renameChatsProfile(db: Db, from: string, to: string): void {
  db.update(chats).set({ profile: to }).where(eq(chats.profile, from)).run();
}

/** A profile deleted: its chats go back to the base. */
export function clearChatsProfile(db: Db, profile: string): void {
  db.update(chats).set({ profile: null }).where(eq(chats.profile, profile)).run();
}
