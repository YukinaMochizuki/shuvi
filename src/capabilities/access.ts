import { listsGroup, type Policy } from "../policy/policy.ts";
import type { Db } from "../store/db.ts";
import { allChats, ensureChat, type Chat } from "../store/events.ts";
import type { Env } from "./types.ts";

/**
 * Who may SEE what, for the capabilities that reach past the current turn (memory, retrieval).
 * docs/design.md §6: data scope follows the CHAT. The owner's DM may read every chat; any other chat only
 * itself. What a chat may not see is never handed to it, so no prompt instruction has to hold it back.
 *
 * Who may CHANGE what (authority follows the sender, §8) is not here: an owner-only tool is named in its
 * capability's `ownerOnly`, and the turn's boundary decides per call (agent/turn.ts `ownerAuthority`).
 *
 * Which chats exist at all is policy.yaml's (src/policy/): only the owner's DM and the groups it lists are
 * ever recorded (telegram/inbound.ts), so "every chat" is every chat recorded. SENDING follows the same
 * one-way rule (`sendTarget`): from the owner's DM to a group policy lists; from anywhere else, nowhere
 * but the chat itself (which is just speaking).
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

/**
 * The chat `from` may send to by Telegram id, or why not. From the owner's DM: any group policy lists
 * (recorded on first use, so a group nobody has spoken in yet can be written to). From any other chat:
 * nothing.
 */
export function sendTarget(db: Db, from: Chat, toTgChatId: number, ownerId: number | null, policy: Policy): Chat | string {
  if (!isOwnerDm(from, ownerId)) return "From this chat you can speak only here, in this chat; sending to another chat is for the owner's DM.";
  if (toTgChatId === from.tgChatId) return "That is this chat: just write your message.";
  if (!listsGroup(policy, toTgChatId)) return `There is no chat ${toTgChatId} you can send to: only the groups listed in policy.yaml.`;
  const title = policy.chats[String(toTgChatId)]?.title ?? null;
  return ensureChat(db, { id: toTgChatId, kind: "group", title });
}

/** How a chat is named to the model. The id is the Telegram chat id, the handle every tool takes. */
export function chatLabel(chat: Chat, ownerId: number | null): string {
  if (isOwnerDm(chat, ownerId)) return `${chat.tgChatId} (your DM with the owner)`;
  return chat.kind === "private" ? `${chat.tgChatId} (a private chat)` : `${chat.tgChatId} (group "${chat.title ?? "untitled"}")`;
}
