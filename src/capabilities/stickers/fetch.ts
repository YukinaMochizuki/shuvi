import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, asc, eq, lt, notInArray, sql } from "drizzle-orm";
import type { Sticker } from "grammy/types";
import type { Db } from "../../store/db.ts";
import { stickerMeta, stickerSets } from "../../store/schema.ts";
import type { TelegramFiles } from "../../telegram/files.ts";
import { stickerShownFile } from "../../telegram/inbound.ts";
import { MAX_BYTES, mediaPath, sniffImage } from "../vision/download.ts";
import { libraryPacks } from "./library.ts";

/**
 * Telegram's side of the library, fetched by the SERVER (it alone has the bot token; a runner child
 * never does). A tool that needs a set asks for it by queueing a `sticker_sets` row (`requestSet`) and
 * waits for the server loop to fill it (`waitForSet`); the loop also asks, on its own, for every pack the
 * YAML describes that was never fetched, so a hand-written or imported pack becomes sendable.
 *
 * Per sticker it caches in `sticker_meta`: the `file_id` `sendSticker` takes, the size, the format and
 * whether it is narrow; and it downloads the picture that shows it, by vision's rule (a static sticker
 * itself, an animated or video one its thumbnail) into vision's `media/<file_unique_id>`, so a sticker the
 * owner sent and the same sticker in the library are one file.
 *
 * A failing set is retried on the next passes and given up after MAX_ATTEMPTS; `add_sticker_pack` asking
 * again starts it over. A sticker whose picture cannot be fetched is still recorded (it can be sent; it
 * just cannot be shown).
 */

export const MAX_ATTEMPTS = 3;
/** Shorter side / longer side below this, and a sticker is narrow: a thin strip that reads badly in a chat. */
export const NARROW_RATIO = 0.5;

export const isNarrow = (width: number, height: number): boolean => Math.min(width, height) / Math.max(width, height, 1) < NARROW_RATIO;

/** Ask the server to fetch set `name` (again). */
export function requestSet(db: Db, name: string): void {
  const row = { state: "pending" as const, attempts: 0, error: null, requestedAt: new Date().toISOString() };
  db.insert(stickerSets)
    .values({ name, ...row })
    .onConflictDoUpdate({ target: stickerSets.name, set: row })
    .run();
}

/** Ask for every pack the library describes that has never been asked for. */
export function requestMissingSets(db: Db): void {
  for (const pack of libraryPacks(db)) db.insert(stickerSets).values({ name: pack, state: "pending" }).onConflictDoNothing().run();
}

export type SetRow = typeof stickerSets.$inferSelect;
export type MetaRow = typeof stickerMeta.$inferSelect;

export function getSet(db: Db, name: string): SetRow | undefined {
  return db.select().from(stickerSets).where(eq(stickerSets.name, name)).get();
}

/** The set's stickers as last fetched, in set order. */
export function setStickers(db: Db, name: string): MetaRow[] {
  return db.select().from(stickerMeta).where(eq(stickerMeta.setName, name)).orderBy(asc(stickerMeta.position)).all();
}

/** Wait until the server has fetched (or given up on) set `name`, for at most `ms`. */
export async function waitForSet(db: Db, name: string, ms: number, signal?: AbortSignal): Promise<SetRow | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const row = getSet(db, name);
    if (!row || row.state !== "pending" || Date.now() >= end || signal?.aborted) return row;
    await Bun.sleep(200);
  }
}

const formatOf = (s: Sticker): MetaRow["format"] => (s.is_video ? "video" : s.is_animated ? "animated" : "static");

async function fetchPicture(files: TelegramFiles, dataDir: string, s: Sticker): Promise<{ path: string; mimeType: string } | null> {
  const shown = stickerShownFile(s);
  if (!shown) return null;
  const rel = mediaPath(shown.fileUniqueId);
  const abs = join(dataDir, rel);
  if (!existsSync(abs)) {
    const bytes = await files.download(shown.fileId, MAX_BYTES);
    if (!sniffImage(bytes)) throw new Error("not an image the model can read");
    mkdirSync(join(dataDir, "media"), { recursive: true });
    const tmp = `${abs}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, abs);
  }
  return { path: rel, mimeType: sniffImage(readFileSync(abs)) ?? "image/jpeg" };
}

/** One pass: fetch every set waiting to be fetched. Returns how many became ready. */
export async function fetchPass(db: Db, files: TelegramFiles, dataDir: string): Promise<number> {
  const pending = db
    .select()
    .from(stickerSets)
    .where(and(eq(stickerSets.state, "pending"), lt(stickerSets.attempts, MAX_ATTEMPTS)))
    .orderBy(asc(stickerSets.requestedAt))
    .all();
  let done = 0;
  for (const set of pending) {
    try {
      const got = await files.stickerSet(set.name);
      // Stickers since removed from the set are forgotten, so positions stay those of the set as it is.
      const ids = got.stickers.map((s) => s.file_unique_id);
      db.delete(stickerMeta)
        .where(and(eq(stickerMeta.setName, set.name), notInArray(stickerMeta.fileUniqueId, ids.length ? ids : [""])))
        .run();
      for (const [i, s] of got.stickers.entries()) {
        let picture: { path: string; mimeType: string } | null = null;
        try {
          picture = await fetchPicture(files, dataDir, s);
        } catch {
          // Still sendable; the contact sheet and view_stickers say it has no picture.
        }
        const row = {
          setName: set.name,
          position: i + 1,
          fileId: s.file_id,
          emoji: s.emoji ?? null,
          width: s.width,
          height: s.height,
          format: formatOf(s),
          narrow: isNarrow(s.width, s.height),
          path: picture?.path ?? null,
          mimeType: picture?.mimeType ?? null,
          updatedAt: new Date().toISOString(),
        };
        db.insert(stickerMeta)
          .values({ fileUniqueId: s.file_unique_id, ...row })
          .onConflictDoUpdate({ target: stickerMeta.fileUniqueId, set: row })
          .run();
      }
      db.update(stickerSets)
        .set({ state: "ready", title: got.title, count: got.stickers.length, error: null, fetchedAt: new Date().toISOString() })
        .where(eq(stickerSets.name, set.name))
        .run();
      done++;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      db.update(stickerSets)
        .set({ attempts: sql`${stickerSets.attempts} + 1`, error, state: set.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "pending" })
        .where(eq(stickerSets.name, set.name))
        .run();
    }
  }
  return done;
}
