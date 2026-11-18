import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.ts";
import { enqueueOutbound } from "./events.ts";

/**
 * Queue a file for the sender to send to a chat (a `bot_file` row), from any capability that has its bytes: the
 * computer's send_file / send_photo, the browser's browser_send. The bytes wait in `<data dir>/outbox/` until
 * delivered (server/sender.ts deletes them once the row is sent); the file is written under a temporary name and
 * renamed, so the sender never reads half of one. The row is keyed on the turn and its message number, like every
 * message a turn sends (exactly once). Limits and checks (size, secrets) are the caller's.
 */

/** The Bot API's limits for a file a bot sends, as a document or as a photo. */
export const DOCUMENT_LIMIT = 50 * 1024 * 1024;
export const PHOTO_LIMIT = 10 * 1024 * 1024;

export interface OutboxFile {
  dataDir: string;
  chatId: number;
  turnId: number;
  /** The turn's message number (`TurnState.n`, taken by the caller). */
  n: number;
  as: "document" | "photo";
  /** The name Telegram shows; already safe (no path). */
  name: string;
  bytes: Uint8Array;
  caption?: string;
  /** Where it came from, for the record (a path on the computer, `browser: <what>`). */
  source: string;
}

export function queueBotFile(db: Db, f: OutboxFile): void {
  const dir = join(f.dataDir, "outbox");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${f.turnId}-${f.n}-${f.name}`);
  writeFileSync(`${file}.tmp`, f.bytes);
  renameSync(`${file}.tmp`, file);
  enqueueOutbound(db, {
    chatId: f.chatId,
    kind: "bot_file",
    payload: { as: f.as, file, name: f.name, source: f.source, bytes: f.bytes.length, ...(f.caption ? { caption: f.caption.slice(0, 1024) } : {}) },
    idemKey: `turn:${f.turnId}:${f.n}`,
    turnId: f.turnId,
  });
}
