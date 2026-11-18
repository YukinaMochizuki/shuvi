import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq, like } from "drizzle-orm";
import type { Db } from "../../store/db.ts";
import { getEvent, kvGet, kvSet, type Chat, type MessageAttachment, type MessagePayload } from "../../store/events.ts";
import { attachmentOfEvent, mediaOfEvent } from "../../store/media.ts";
import { kv } from "../../store/schema.ts";
import type { TelegramFiles } from "../../telegram/files.ts";
import { safeName } from "../computer/files.ts";
import { UPLOAD_LIMIT } from "./upload.ts";

/**
 * A file someone sent in the chat (a message's `attachment`: a photo, a document, …), fetched for browser_upload.
 *
 * A turn runs in a runner child, which never holds the bot token, so it cannot download from Telegram itself. It
 * asks the server instead: `requestAttachment` records `browser_attach:<seq>` in kv; the server's loop
 * (`attachmentPass`, the browser capability's `browser-attachments`, with the read-only file downloader every loop
 * gets) downloads it into `<data dir>/browser-uploads/` under a temporary name and renames it, and marks it ready;
 * the tool waits for that (`awaitAttachment`), reads it, and removes the file and the row once porchkit has it.
 * What nobody collects is removed after an hour. At most 20 MB, a bot's download limit and porchkit's upload limit.
 */

export const ATTACH_PREFIX = "browser_attach:";
const keyOf = (seq: number) => `${ATTACH_PREFIX}${seq}`;
export const ATTACH_KEEP_MS = 3600_000;

interface Req {
  state: "requested" | "ready" | "failed";
  at: number;
  path?: string;
  error?: string;
}

/**
 * The file message #seq of `chat` carries, or why there is none:
 *   - its `attachment` (a file the owner, or a group's operator, sent: telegram/inbound.ts `filesCopiedFrom`),
 *     fetched by the server for the tool;
 *   - else, for a photo anyone sent, the picture vision already downloaded (`media`, under the data dir): read
 *     in place, nothing to fetch;
 *   - a document from anyone else was never kept (no file id is recorded for it), so it cannot be uploaded.
 */
export function attachmentIn(
  db: Db,
  chat: Chat,
  seq: number,
): { attachment: MessageAttachment } | { photo: { path: string; name: string } } | { error: string } {
  const e = getEvent(db, seq);
  if (!e || e.chatId !== chat.id || e.kind !== "message") return { error: `There is no message #${seq} in this chat.` };
  const a = attachmentOfEvent(e);
  if (a) return { attachment: a };
  const m = mediaOfEvent(e);
  if (m?.kind === "photo") {
    if (m.state === "ready" && m.path) return { photo: { path: m.path, name: `photo-${seq}.${m.mimeType === "image/png" ? "png" : m.mimeType === "image/webp" ? "webp" : "jpg"}` } };
    if (m.state === "pending") return { error: `#${seq}'s photo is still downloading; call browser_upload again in a moment.` };
    return { error: `#${seq}'s photo could not be downloaded, so it cannot be uploaded.` };
  }
  const p = e.payload as unknown as MessagePayload;
  if (p.placeholder && /\[(?:file|video|audio|GIF|round video|voice)\b/.test(p.text ?? ""))
    return { error: `#${seq}'s file was not kept: only the owner's files (and in a group its operators') are, so it cannot be uploaded.` };
  return { error: `#${seq} carries no photo or file to upload.` };
}

/** Ask the server for message #seq's file (again, if an earlier try failed). */
export function requestAttachment(db: Db, seq: number, now = Date.now()): void {
  const r = read(db, seq);
  if (r?.state === "requested" || r?.state === "ready") return;
  kvSet(db, keyOf(seq), JSON.stringify({ state: "requested", at: now } satisfies Req));
}

const read = (db: Db, seq: number): Req | undefined => {
  const v = kvGet(db, keyOf(seq));
  return v ? (JSON.parse(v) as Req) : undefined;
};

/** Wait (up to `ms`) for the server: the file's bytes, or why not (`pending`: not there yet). */
export async function awaitAttachment(db: Db, dataDir: string, seq: number, ms: number): Promise<{ bytes: Uint8Array } | { error: string; pending?: true }> {
  const end = Date.now() + ms;
  for (;;) {
    const r = read(db, seq);
    if (r?.state === "ready" && r.path) {
      try {
        return { bytes: new Uint8Array(readFileSync(join(dataDir, r.path))) };
      } catch {
        kvSet(db, keyOf(seq), JSON.stringify({ state: "requested", at: Date.now() } satisfies Req)); // gone: fetch again
      }
    }
    if (r?.state === "failed") return { error: `#${seq}'s file could not be fetched: ${r.error ?? "unknown error"}.` };
    if (Date.now() >= end) return { error: `#${seq}'s file is still being fetched; call browser_upload again in a moment.`, pending: true };
    await Bun.sleep(200);
  }
}

/** The file is with porchkit: drop the copy and the request. */
export function doneWithAttachment(db: Db, dataDir: string, seq: number): void {
  const r = read(db, seq);
  if (r?.path) rmSync(join(dataDir, r.path), { force: true });
  db.delete(kv).where(eq(kv.key, keyOf(seq))).run();
}

/** The server's pass: download every requested file; drop what nobody collected within an hour. */
export async function attachmentPass(db: Db, files: TelegramFiles, dataDir: string, now = Date.now()): Promise<number> {
  let done = 0;
  for (const row of db.select().from(kv).where(like(kv.key, `${ATTACH_PREFIX}%`)).all()) {
    const seq = Number(row.key.slice(ATTACH_PREFIX.length));
    const r = JSON.parse(row.value) as Req;
    if (now - r.at > ATTACH_KEEP_MS) {
      if (r.path) rmSync(join(dataDir, r.path), { force: true });
      db.delete(kv).where(eq(kv.key, row.key)).run();
      continue;
    }
    if (r.state !== "requested") continue;
    const e = getEvent(db, seq);
    const a = e ? attachmentOfEvent(e) : undefined;
    if (!a) {
      kvSet(db, row.key, JSON.stringify({ ...r, state: "failed", error: "the message is gone" } satisfies Req));
      continue;
    }
    try {
      if (a.size && a.size > UPLOAD_LIMIT) throw new Error("it is over 20 MB");
      const bytes = await files.download(a.fileId, UPLOAD_LIMIT);
      const rel = join("browser-uploads", `${seq}-${safeName(a.name)}`);
      mkdirSync(join(dataDir, "browser-uploads"), { recursive: true });
      const tmp = `${join(dataDir, rel)}.${process.pid}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, join(dataDir, rel));
      kvSet(db, row.key, JSON.stringify({ state: "ready", at: r.at, path: rel } satisfies Req));
      done++;
    } catch (err) {
      kvSet(db, row.key, JSON.stringify({ ...r, state: "failed", error: err instanceof Error ? err.message : String(err) } satisfies Req));
    }
  }
  return done;
}
