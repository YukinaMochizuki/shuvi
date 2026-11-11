import type { Db } from "../store/db.ts";
import { allChats, type Chat } from "../store/events.ts";
import type { Env } from "./types.ts";

/**
 * Who may SEE what, for the capabilities that reach past the current turn (memory, retrieval).
 * docs/design.md §6: data scope follows the CHAT. The owner's DM may read every chat; any other chat only
 * itself. What a chat may not see is never handed to it, so no prompt instruction has to hold it back.
 *
 * Who may CHANGE what (authority follows the sender, §8) is not here: an owner-only tool is named in its
 * capability's `ownerOnly`, and the turn's boundary decides per call (agent/turn.ts `ownerAuthority`).
 *
 * Today the owner's DM is the only chat. When groups arrive (M4), `visibleChats` is where policy.yaml says
 * which chats exist; the rules above stay as they are.
 *
 *   SHUVI_OWNER_ID   the owner's Telegram user id (the framework's own variable, read here too). Unset: no
 *                    chat is the owner's DM, so every chat sees only itself.
 */

export function ownerIdFrom(env: Env): number | null {
  const id = Number(env.SHUVI_OWNER_ID);
  return env.SHUVI_OWNER_ID && Number.isSafeInteger(id) ? id : null;
}

/** The owner's private chat: a private chat's Telegram id is the other person's user id. */
export function isOwnerDm(chat: Chat, ownerId: number | null): boolean {
  return ownerId !== null && chat.kind === "private" && chat.tgChatId === ownerId;
}

/** The chats `chat` may search and read: every chat from the owner's DM, otherwise only itself. */
export function visibleChats(db: Db, chat: Chat, ownerId: number | null): Chat[] {
  return isOwnerDm(chat, ownerId) ? allChats(db) : [chat];
}

/** How a chat is named to the model. The id is the Telegram chat id, the handle every tool takes. */
export function chatLabel(chat: Chat, ownerId: number | null): string {
  if (isOwnerDm(chat, ownerId)) return `${chat.tgChatId} (your DM with the owner)`;
  return chat.kind === "private" ? `${chat.tgChatId} (a private chat)` : `${chat.tgChatId} (group "${chat.title ?? "untitled"}")`;
}
