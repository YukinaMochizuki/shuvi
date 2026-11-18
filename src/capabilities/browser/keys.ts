import { FILE_KEY, type BrowseDownload, type Porchkit } from "../../porchkit/client.ts";
import type { Db } from "../../store/db.ts";
import { kvGet, type Chat } from "../../store/events.ts";

/**
 * Which of porchkit's file keys are a chat's own, for its browser's files: a completed download of the chat's
 * window (porchkit `GET /browse/sessions/<s>/downloads`), or a PDF that browser_send made in the chat (recorded
 * in kv `browser_pdf:<chat>:<key>` with its name). Any other key is refused, so one chat never reaches another's
 * files through porchkit's file cache. The browser's browser_send and the computer's browser_save both ask here;
 * this module imports no capability, so either may import it.
 */

/** The chat's session at porchkit: `chat-<chat id>`, only `[A-Za-z0-9_-]`. */
export const sessionOf = (chat: Pick<Chat, "id">): string => `chat-${String(chat.id).replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64);

export const pdfKv = (chatId: number, key: string) => `browser_pdf:${chatId}:${key}`;

/** The downloads of the chat's window, or the error text (`describe`: the caller's words for a porchkit failure). */
export async function downloadsOf(porch: Porchkit, session: string, describe: (e: unknown) => string): Promise<BrowseDownload[] | string> {
  try {
    return await porch.browseDownloads(session);
  } catch (e) {
    return describe(e);
  }
}

/** A key of this chat's browser: its file's name (and size, for a download), or why it is not usable. */
export async function ownKey(db: Db, porch: Porchkit, chat: Chat, key: string, describe: (e: unknown) => string): Promise<{ name: string; bytes?: number } | { error: string }> {
  if (!FILE_KEY.test(key)) return { error: "That is not a file key of the browser's. browser_downloads lists this chat's downloads with theirs." };
  const pdf = kvGet(db, pdfKv(chat.id, key));
  if (pdf) return { name: pdf };
  const list = await downloadsOf(porch, sessionOf(chat), describe);
  if (typeof list === "string") return { error: list };
  const d = list.find((x) => x.key === key);
  if (!d) return { error: "No download or PDF of this chat's browser has that key. browser_downloads lists this chat's downloads with their keys." };
  if (d.state !== "completed") return { error: `${d.name} is ${d.state === "in_progress" ? "still downloading" : "not downloaded (canceled)"}.` };
  return { name: d.name, bytes: d.bytes };
}
