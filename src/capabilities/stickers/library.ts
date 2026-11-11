import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../store/db.ts";
import { stickerLibrary, stickerPacks } from "../../store/schema.ts";
import { IMMEDIATE } from "../../store/turns.ts";

/**
 * The sticker library's FORMAT (docs/design.md §12) and its INDEX in SQLite.
 *
 *   # home/stickers/<pack>.yaml
 *   pack: <set name>
 *   role: avatar          # avatar / common / meme: the pack's base weight
 *   dm_only: true         # optional: never offered outside the owner's DM
 *   stickers:
 *     - n: 10
 *       file_unique_id: <...>
 *       desc: an OK hand sign      # what it shows (fact)
 *       use: OK, got it            # when to use it (preference)
 *       tier: go-to                # go-to / (omitted) / rare / never
 *       dm_only: true              # optional, as for the pack
 *
 * Only what a person writes is in the YAML. What Telegram knows (file_id, size, static or animated,
 * narrow) is fetched by the server into `sticker_meta` (fetch.ts) and never written here.
 *
 * The YAML files are the truth; `sticker_packs` / `sticker_library` / `sticker_fts` are an index of them,
 * refreshed by `syncLibrary` whenever a file's bytes change, however it changed (memory's `edit_home`,
 * scripts/import-stickers.ts, or a hand edit). It runs before every sticker tool reads the library and in a server
 * loop, so no writer has to remember to re-index. A file that stops parsing keeps its last good stickers
 * indexed and records the error, so one typo does not take a pack away.
 *
 * `sticker_fts` is an FTS5 table (trigram tokenizer, so substrings of any script match, CJK included) over
 * `desc` and `use`. It is a derived cache, so it is created here at runtime rather than by a migration
 * (drizzle-kit does not model virtual tables), and rebuilt from `sticker_library` after every change.
 */

export const ROLES = ["avatar", "common", "meme"] as const;
export type Role = (typeof ROLES)[number];
export const TIERS = ["go-to", "normal", "rare", "never"] as const;
export type Tier = (typeof TIERS)[number];

/** A Telegram sticker set name: what `getStickerSet` takes, and the YAML file's name. */
export const PACK_NAME = /^[A-Za-z0-9_]{1,64}$/;

const text = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => (v === null || v === undefined ? "" : String(v).trim()));

const stickerEntry = z.object({
  n: z.number().int().positive(),
  file_unique_id: z.string().min(1),
  desc: text,
  use: text,
  tier: z.enum(["go-to", "normal", "rare", "never"]).nullish(),
  dm_only: z.boolean().nullish(),
});

export const packFile = z.object({
  pack: z.string().regex(PACK_NAME, "a sticker set name (letters, digits and _)"),
  role: z.enum(ROLES),
  dm_only: z.boolean().nullish(),
  stickers: z.array(stickerEntry).nullish().transform((v) => v ?? []),
});
export type PackFile = z.infer<typeof packFile>;

/** Parse and check one pack file. Throws an Error saying what is wrong. */
export function parsePack(source: string): PackFile {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(source);
  } catch (e) {
    throw new Error(`not valid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  const r = packFile.safeParse(raw);
  if (!r.success) {
    throw new Error(r.error.issues.map((i) => `${i.path.join(".") || "(file)"}: ${i.message}`).join("; "));
  }
  const seen = new Set<number>();
  for (const s of r.data.stickers) {
    if (seen.has(s.n)) throw new Error(`stickers: n ${s.n} appears twice`);
    seen.add(s.n);
  }
  return r.data;
}

export const stickersDir = (home: string) => join(home, "stickers");
export const packFileName = (pack: string) => `${pack}.yaml`;

// ---- the skeleton -------------------------------------------------------------------------------------

export interface SkeletonSticker {
  n: number;
  fileUniqueId: string;
  emoji?: string | null;
}

/** A YAML string: plain when it is safe, quoted otherwise. */
function yamlString(s: string): string {
  return /^[\p{L}\p{N}][\p{L}\p{N} ,.'!?()\-]*$/u.test(s) && !/^(true|false|null|yes|no|on|off|~)$/i.test(s) && !/^[\d.]+$/.test(s) ? s : JSON.stringify(s);
}

/**
 * A pack file with every sticker of the set numbered, its `file_unique_id` filled in and `desc` / `use`
 * left for her to write. What an existing file already says about a sticker (matched by
 * `file_unique_id`) is carried over, so re-describing a pack starts from what was there.
 */
export function packSkeleton(pack: string, role: Role, stickers: SkeletonSticker[], existing?: PackFile, title?: string | null): string {
  const before = new Map(existing?.stickers.map((s) => [s.file_unique_id, s]));
  const lines = [
    `# ${title ? `${title}: ` : ""}${stickers.length} stickers. For each, write desc (what it shows) and use (when to use it).`,
    `# tier: go-to / rare / never, or leave it out. dm_only: true keeps a sticker (or the whole pack) out of groups.`,
    `pack: ${pack}`,
    `role: ${existing?.role ?? role}  # avatar / common / meme`,
    ...(existing?.dm_only ? ["dm_only: true"] : []),
    "stickers:",
  ];
  for (const s of stickers) {
    const old = before.get(s.fileUniqueId);
    lines.push(`  - n: ${s.n}${s.emoji ? `  # ${s.emoji}` : ""}`);
    lines.push(`    file_unique_id: ${JSON.stringify(s.fileUniqueId)}`);
    lines.push(`    desc: ${old?.desc ? yamlString(old.desc) : ""}`.trimEnd());
    lines.push(`    use: ${old?.use ? yamlString(old.use) : ""}`.trimEnd());
    if (old?.tier && old.tier !== "normal") lines.push(`    tier: ${old.tier}`);
    if (old?.dm_only) lines.push(`    dm_only: true`);
  }
  return `${lines.join("\n")}\n`;
}

// ---- the index ----------------------------------------------------------------------------------------

export interface SyncResult {
  /** Files (re)indexed or dropped in this pass. */
  changed: string[];
  /** Files whose latest version could not be indexed, and why. */
  errors: { file: string; error: string }[];
}

function ensureFts(db: Db): boolean {
  const had = db.$client.query("select 1 from sqlite_master where name = 'sticker_fts'").get();
  if (had) return false;
  db.$client.run(
    "create virtual table if not exists sticker_fts using fts5(desc, use, content='sticker_library', content_rowid='id', tokenize='trigram case_sensitive 0')",
  );
  return true;
}

const hashOf = (bytes: Uint8Array) => Bun.hash(bytes).toString(16);

/** Bring the index up to date with home/stickers/. Cheap when nothing changed: a read and a hash per file. */
export function syncLibrary(db: Db, home: string): SyncResult {
  const dir = stickersDir(home);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  const sources = new Map(files.map((f) => [f, readFileSync(join(dir, f))]));
  const result: SyncResult = { changed: [], errors: [] };

  db.transaction((tx) => {
    let dirty = ensureFts(db);
    const indexed = new Map(tx.select().from(stickerPacks).all().map((p) => [p.file, p]));

    for (const file of indexed.keys()) {
      if (sources.has(file)) continue;
      tx.delete(stickerLibrary).where(eq(stickerLibrary.file, file)).run();
      tx.delete(stickerPacks).where(eq(stickerPacks.file, file)).run();
      result.changed.push(file);
      dirty = true;
    }

    for (const [file, bytes] of sources) {
      const hash = hashOf(bytes);
      const prev = indexed.get(file);
      if (prev?.hash === hash) {
        if (prev.error) result.errors.push({ file, error: prev.error });
        continue;
      }
      let parsed: PackFile;
      try {
        parsed = parsePack(bytes.toString("utf8"));
        const other = tx
          .select({ file: stickerPacks.file })
          .from(stickerPacks)
          .where(eq(stickerPacks.pack, parsed.pack))
          .all()
          .find((p) => p.file !== file);
        if (other) throw new Error(`pack ${parsed.pack} is already described in ${other.file}`);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        // Keep the last good stickers; remember this version's hash so it is not re-parsed every pass.
        tx.insert(stickerPacks)
          .values({ file, hash, error })
          .onConflictDoUpdate({ target: stickerPacks.file, set: { hash, error } })
          .run();
        result.errors.push({ file, error });
        continue;
      }
      tx.delete(stickerLibrary).where(eq(stickerLibrary.file, file)).run();
      for (const s of parsed.stickers) {
        tx.insert(stickerLibrary)
          .values({ file, pack: parsed.pack, n: s.n, fileUniqueId: s.file_unique_id, desc: s.desc, use: s.use, tier: s.tier ?? "normal", dmOnly: s.dm_only ?? false })
          .run();
      }
      const row = { hash, pack: parsed.pack, role: parsed.role, dmOnly: parsed.dm_only ?? false, error: null };
      tx.insert(stickerPacks)
        .values({ file, ...row })
        .onConflictDoUpdate({ target: stickerPacks.file, set: row })
        .run();
      result.changed.push(file);
      dirty = true;
    }

    if (dirty) db.$client.run("insert into sticker_fts(sticker_fts) values('rebuild')");
  }, IMMEDIATE);
  return result;
}

/** The packs the library describes (successfully indexed at least once). */
export function libraryPacks(db: Db): string[] {
  return db
    .select({ pack: stickerPacks.pack })
    .from(stickerPacks)
    .where(isNotNull(stickerPacks.pack))
    .all()
    .map((p) => p.pack!);
}
