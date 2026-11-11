#!/usr/bin/env bun
/**
 * Create YAML skeletons in home/stickers/ for a list of sticker packs, so the owner's existing packs can be
 * described again in the library's format (docs/design.md §12). Each skeleton numbers every sticker of the
 * set and fills in its `file_unique_id`; `desc` and `use` are left empty, to be written later by her with
 * `add_sticker_pack`, which shows the contact sheet and carries over whatever a file already says.
 *
 *   bun scripts/import-stickers.ts                      the owner's packs (PACKS below)
 *   bun scripts/import-stickers.ts Name:role [...]      these packs instead (role: avatar / common / meme)
 *
 * Needs SHUVI_BOT_TOKEN (to call getStickerSet) and reads SHUVI_DATA_DIR / SHUVI_TELEGRAM_API_ROOT like the
 * server. A pack that already has a file is left alone. Each new file is its own commit in home/, through
 * the same helper as memory's `write_home` (memory/home.ts `commitHomeEdit`). Nothing is written to the
 * database: the running server indexes the files and fetches each pack's Telegram-side facts on its own.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Api } from "grammy";
import { packFileName, packSkeleton, PACK_NAME, ROLES, stickersDir, type Role } from "../src/capabilities/stickers/library.ts";
import { commitHomeEdit } from "../src/capabilities/memory/home.ts";
import { dataDirFrom } from "../src/env.ts";

/** The owner's packs, with the role each plays. */
export const PACKS: [string, Role][] = [
  ["LINE_Girl_with_black_hair_TL", "avatar"],
  ["line30630475a275_by_moe_sticker_bot", "common"],
  ["EveOneCat", "common"],
  ["nKOCat", "common"],
  ["Animated_Red_Fox", "common"],
  ["CAT_CAT_CAT111", "meme"],
  ["igotallday_fans", "meme"],
  ["line364379518_by_RekcitsEnilbot", "meme"],
  ["FallacyCN", "meme"],
  ["Coin_Master_Meme_By_Ethan", "meme"],
];

function parseArgs(args: string[]): [string, Role][] {
  if (!args.length) return PACKS;
  return args.map((a) => {
    const [name, role = "common"] = a.split(":");
    if (!name || !PACK_NAME.test(name)) throw new Error(`not a sticker set name: ${a}`);
    if (!(ROLES as readonly string[]).includes(role)) throw new Error(`role must be one of ${ROLES.join(" / ")}: ${a}`);
    return [name, role as Role];
  });
}

if (import.meta.main) {
  const token = process.env.SHUVI_BOT_TOKEN;
  if (!token) {
    console.error("SHUVI_BOT_TOKEN is not set");
    process.exit(2);
  }
  const packs = parseArgs(process.argv.slice(2));
  const api = new Api(token, process.env.SHUVI_TELEGRAM_API_ROOT ? { apiRoot: process.env.SHUVI_TELEGRAM_API_ROOT } : undefined);
  const home = join(dataDirFrom(process.env), "home");
  const dir = stickersDir(home);

  let failed = 0;
  for (const [name, role] of packs) {
    const file = join(dir, packFileName(name));
    if (existsSync(file)) {
      console.log(`skip   ${name}: stickers/${packFileName(name)} already exists`);
      continue;
    }
    try {
      const set = await api.getStickerSet(name);
      const stickers = set.stickers.map((s, i) => ({ n: i + 1, fileUniqueId: s.file_unique_id, emoji: s.emoji ?? null }));
      const commit = commitHomeEdit(home, join("stickers", packFileName(name)), packSkeleton(name, role, stickers, undefined, set.title), `stickers: skeleton for ${name}`);
      console.log(`wrote  ${name} (${role}): ${stickers.length} stickers (commit ${commit})`);
    } catch (e) {
      failed++;
      console.error(`FAILED ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
