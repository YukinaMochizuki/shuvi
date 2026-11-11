import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../../store/db.ts";
import { mediaOfEvent, pendingMedia, updateMedia } from "../../store/media.ts";
import type { TelegramFiles } from "../../telegram/files.ts";

/**
 * The server loop that fetches what a message shows (a photo, a sticker or its thumbnail) into
 * `<data dir>/media/<file_unique_id>`, and completes the message's `media` in place.
 *
 * DEDUPLICATED by `file_unique_id`, which Telegram keeps the same for the same file across messages and
 * bots: a sticker sent a hundred times is downloaded once, and a file already there is never fetched again
 * (a crash between writing it and recording it costs nothing). A file is written under a temporary name and
 * renamed, so a half-written one is never taken for a whole one.
 *
 * A failing download is retried on the next passes, then given up after MAX_ATTEMPTS: the message is then
 * shown with its placeholder alone, as it would be if it had never had a picture.
 */

export const MAX_ATTEMPTS = 3;
/** The Messages API takes images up to 5 MB; a chosen photo size or a sticker is far below it. */
export const MAX_BYTES = 5 * 1024 * 1024;

/** The relative path a file is kept at, from the data dir. */
export const mediaPath = (fileUniqueId: string): string => join("media", fileUniqueId.replace(/[^A-Za-z0-9_-]/g, "_"));

/** The image type of `bytes`, from their signature (Telegram's file paths do not say reliably), or null. */
export function sniffImage(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

/** One pass: try every pending download once. Returns how many completed. */
export async function downloadPass(db: Db, files: TelegramFiles, dataDir: string): Promise<number> {
  let done = 0;
  for (const e of pendingMedia(db)) {
    const media = mediaOfEvent(e);
    if (!media?.file) {
      updateMedia(db, e.seq, { state: "none" });
      continue;
    }
    const rel = mediaPath(media.file.fileUniqueId);
    const abs = join(dataDir, rel);
    try {
      if (!existsSync(abs)) {
        const bytes = await files.download(media.file.fileId, MAX_BYTES);
        if (!sniffImage(bytes)) throw new Error("not an image the model can read (jpeg, png, gif, webp)");
        mkdirSync(join(dataDir, "media"), { recursive: true });
        const tmp = `${abs}.${process.pid}.tmp`;
        writeFileSync(tmp, bytes);
        renameSync(tmp, abs);
      }
      const mimeType = sniffImage(readFileSync(abs)) ?? "image/jpeg";
      updateMedia(db, e.seq, { state: "ready", path: rel, mimeType });
      done++;
    } catch (err) {
      const attempts = (media.attempts ?? 0) + 1;
      const error = err instanceof Error ? err.message : String(err);
      updateMedia(db, e.seq, attempts >= MAX_ATTEMPTS ? { state: "failed", attempts, error } : { attempts, error });
    }
  }
  return done;
}
