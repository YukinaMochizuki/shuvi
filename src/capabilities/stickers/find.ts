import { and, eq, gte, inArray, ne, or, sql } from "drizzle-orm";
import type { Db } from "../../store/db.ts";
import { chatEvents, stickerLibrary, stickerMeta, stickerPacks } from "../../store/schema.ts";
import type { Role, Tier } from "./library.ts";

/**
 * Finding stickers, and the weights that rank them (docs/design.md §12). The weights are fixed numbers on
 * purpose: the owner tunes the library through `role` and `tier`, and should be able to predict the result.
 *
 *   score = match + ROLE_WEIGHT[role] + TIER_WEIGHT[tier] - USE_PENALTY × uses in the last RECENT_DAYS
 *
 *   - match: per term, MATCH_USE when it is in `use` (a preference: when to send it) plus MATCH_DESC when
 *     it is in `desc` (a fact: what it shows), summed over the terms;
 *   - recent uses are HER sends of that sticker in any chat, counted from `chat_events` (`bot_sticker`);
 *     what the owner sends is not counted, so the weights stay predictable.
 *
 * Never offered: a `never` sticker and a narrow one, unless named by id (`<pack>/<n>` as a term); in a
 * chat other than the owner's DM, a `dm_only` sticker or one from a `dm_only` pack, even by id; and a
 * sticker whose pack the server has not fetched from Telegram yet (it cannot be sent until then).
 *
 * Search is lexical, so a synonym misses. Two helpers point her at the words the library actually uses:
 *   - `vocabulary`: the `use` labels (a `use` split at 、，,;；／/| and line breaks), each counted once per
 *     sticker that carries it, most stickers first, ties in code-point order, at most VOCABULARY_CAP. Only
 *     stickers find_sticker could offer count (not never, not narrow, not unfetched, not dm_only outside
 *     the DM), so the list is a pure function of the library: it is in the system prompt's cached prefix.
 *   - `listStickers`: the library browsed in pack and number order, a page at a time, under the same rules.
 */

export const ROLE_WEIGHT: Record<Role, number> = { avatar: 1, common: 0.5, meme: 0 };
export const TIER_WEIGHT: Record<Tier, number> = { "go-to": 0.75, normal: 0, rare: -0.75, never: -10 };
export const MATCH_USE = 1;
export const MATCH_DESC = 0.6;
export const USE_PENALTY = 0.5;
export const RECENT_DAYS = 7;
export const DEFAULT_LIMIT = 8;
export const VOCABULARY_CAP = 80;
export const LIST_PAGE = 30;

/** A library sticker with everything the tools need to know about it. */
export interface LibrarySticker {
  /** `<pack>/<n>`: what the tools take. */
  id: string;
  pack: string;
  n: number;
  fileUniqueId: string;
  desc: string;
  use: string;
  tier: Tier;
  role: Role;
  /** dm_only on the sticker or on its pack. */
  dmOnly: boolean;
  /** Telegram's side; null until the server has fetched the pack. */
  meta: typeof stickerMeta.$inferSelect | null;
}

export interface Candidate extends LibrarySticker {
  score: number;
  recentUses: number;
}

export const stickerId = (pack: string, n: number) => `${pack}/${n}`;
const ID = /^([A-Za-z0-9_]+)\/(\d+)$/;

/** Parse `<pack>/<n>`. */
export function parseId(id: string): { pack: string; n: number } | null {
  const m = id.trim().match(ID);
  return m ? { pack: m[1]!, n: Number(m[2]) } : null;
}

function load(db: Db, where: ReturnType<typeof and>): LibrarySticker[] {
  return db
    .select({ s: stickerLibrary, role: stickerPacks.role, packDmOnly: stickerPacks.dmOnly, meta: stickerMeta })
    .from(stickerLibrary)
    .innerJoin(stickerPacks, eq(stickerPacks.file, stickerLibrary.file))
    .leftJoin(stickerMeta, eq(stickerMeta.fileUniqueId, stickerLibrary.fileUniqueId))
    .where(where)
    .all()
    .map(({ s, role, packDmOnly, meta }) => ({
      id: stickerId(s.pack, s.n),
      pack: s.pack,
      n: s.n,
      fileUniqueId: s.fileUniqueId,
      desc: s.desc,
      use: s.use,
      tier: s.tier,
      role: role ?? "meme",
      dmOnly: s.dmOnly || packDmOnly,
      meta,
    }));
}

/** Whether find_sticker could offer `s` without it being named by id. */
const offerable = (s: LibrarySticker, inDm: boolean) => !(s.dmOnly && !inDm) && s.tier !== "never" && !!s.meta && !s.meta.narrow;

/** Plain code-point order: the same everywhere, unlike a locale's. */
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The labels in one `use`, lower-cased, each once. */
export function useLabels(use: string): string[] {
  return [...new Set(use.split(/[、，,;；／/|\n]+/).map((l) => l.trim().toLowerCase()).filter(Boolean))];
}

/** The library's `use` labels, most stickers first (see the header). */
export function vocabulary(db: Db, inDm: boolean, cap = VOCABULARY_CAP): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const s of load(db, undefined)) {
    if (!offerable(s, inDm)) continue;
    for (const l of useLabels(s.use)) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  return [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || byCodePoint(a.label, b.label))
    .slice(0, cap);
}

export interface ListOptions {
  pack?: string;
  /** Only stickers whose `use` contains this (case-insensitive). */
  use?: string;
  tier?: Tier;
  inDm: boolean;
  /** 1-based. */
  page?: number;
  pageSize?: number;
}

export interface ListResult {
  stickers: LibrarySticker[];
  /** How many match in all, over every page. */
  total: number;
  page: number;
  pages: number;
  /** Matches left out because their pack is not fetched from Telegram yet. */
  unfetched: number;
}

/** The library in pack and number order, a page at a time, under find_sticker's rules. */
export function listStickers(db: Db, opts: ListOptions): ListResult {
  const use = opts.use?.trim().toLowerCase();
  let unfetched = 0;
  const all = load(db, and(opts.pack ? eq(stickerLibrary.pack, opts.pack) : undefined, opts.tier ? eq(stickerLibrary.tier, opts.tier) : undefined))
    .filter((s) => !use || s.use.toLowerCase().includes(use))
    .filter((s) => {
      if (!s.meta && !(s.dmOnly && !opts.inDm) && s.tier !== "never") unfetched++;
      return offerable(s, opts.inDm);
    })
    .sort((a, b) => byCodePoint(a.pack, b.pack) || a.n - b.n);
  const size = opts.pageSize ?? LIST_PAGE;
  const pages = Math.max(1, Math.ceil(all.length / size));
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1)), pages);
  return { stickers: all.slice((page - 1) * size, page * size), total: all.length, page, pages, unfetched };
}

/** The library sticker `id` (`<pack>/<n>`), or undefined. */
export function getSticker(db: Db, id: string): LibrarySticker | undefined {
  const p = parseId(id);
  if (!p) return undefined;
  return load(db, and(eq(stickerLibrary.pack, p.pack), eq(stickerLibrary.n, p.n)))[0];
}

/** How many times she sent each sticker (by file_unique_id) since `since`, in any chat. */
export function recentUses(db: Db, since: Date): Map<string, number> {
  const key = sql<string>`json_extract(${chatEvents.payload}, '$.fileUniqueId')`;
  const rows = db
    .select({ key, n: sql<number>`count(*)` })
    .from(chatEvents)
    .where(and(eq(chatEvents.kind, "bot_sticker"), ne(chatEvents.status, "failed"), gte(chatEvents.at, since.toISOString())))
    .groupBy(key)
    .all();
  return new Map(rows.map((r) => [r.key, r.n]));
}

/** An FTS5 phrase: the term in double quotes, inner quotes doubled. */
const phrase = (t: string) => `"${t.replaceAll('"', '""')}"`;
const likeArg = (t: string) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Library row ids whose desc or use contains any of `terms`. */
function matching(db: Db, terms: string[]): number[] {
  const ids = new Set<number>();
  // The trigram index answers terms of 3+ characters; shorter ones (a CJK word is often 2) are a LIKE scan.
  const long = terms.filter((t) => [...t].length >= 3);
  const short = terms.filter((t) => [...t].length < 3);
  if (long.length) {
    const q = long.map(phrase).join(" OR ");
    for (const r of db.$client.query("select rowid from sticker_fts where sticker_fts match ?").all(q) as { rowid: number }[]) ids.add(r.rowid);
  }
  for (const t of short) {
    const rows = db.$client.query("select id from sticker_library where desc like ?1 escape '\\' or use like ?1 escape '\\'").all(likeArg(t)) as { id: number }[];
    for (const r of rows) ids.add(r.id);
  }
  return [...ids];
}

/** How well `s` matches `terms`. */
export function matchScore(s: Pick<LibrarySticker, "desc" | "use">, terms: string[]): number {
  const desc = s.desc.toLowerCase();
  const use = s.use.toLowerCase();
  let score = 0;
  for (const t of terms) {
    const term = t.toLowerCase();
    if (use.includes(term)) score += MATCH_USE;
    if (desc.includes(term)) score += MATCH_DESC;
  }
  return score;
}

export interface FindOptions {
  terms: string[];
  pack?: string;
  /** The owner's DM: dm_only stickers may be offered. */
  inDm: boolean;
  now?: Date;
  limit?: number;
}

export interface FindResult {
  candidates: Candidate[];
  /** Matches left out because their pack is not fetched from Telegram yet. */
  unfetched: number;
}

export function findStickers(db: Db, opts: FindOptions): FindResult {
  const terms = [...new Set(opts.terms.map((t) => t.trim()).filter(Boolean))];
  const named = new Set(terms.filter((t) => ID.test(t)));
  const words = terms.filter((t) => !named.has(t));

  const ids = matching(db, words);
  const byId = ids.length ? load(db, and(inArray(stickerLibrary.id, ids), opts.pack ? eq(stickerLibrary.pack, opts.pack) : undefined)) : [];
  const explicit = named.size
    ? load(db, or(...[...named].map((id) => { const p = parseId(id)!; return and(eq(stickerLibrary.pack, p.pack), eq(stickerLibrary.n, p.n)); })))
    : [];

  const now = opts.now ?? new Date();
  const uses = recentUses(db, new Date(now.getTime() - RECENT_DAYS * 86_400_000));
  const seen = new Set<string>();
  const out: Candidate[] = [];
  let unfetched = 0;
  for (const s of [...explicit, ...byId]) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    const isNamed = named.has(s.id);
    if (s.dmOnly && !opts.inDm) continue;
    if (!isNamed && (s.tier === "never" || s.meta?.narrow)) continue;
    if (!s.meta) {
      unfetched++;
      continue;
    }
    const recent = uses.get(s.fileUniqueId) ?? 0;
    const score = matchScore(s, words) + ROLE_WEIGHT[s.role] + TIER_WEIGHT[s.tier] - USE_PENALTY * recent;
    out.push({ ...s, score: isNamed ? Number.POSITIVE_INFINITY : score, recentUses: recent });
  }
  out.sort((a, b) => b.score - a.score || ROLE_WEIGHT[b.role] - ROLE_WEIGHT[a.role] || a.pack.localeCompare(b.pack) || a.n - b.n);
  return { candidates: out.slice(0, opts.limit ?? DEFAULT_LIMIT), unfetched };
}
