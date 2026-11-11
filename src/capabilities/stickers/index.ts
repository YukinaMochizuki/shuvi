import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { err, ok, type ToolContent, type ToolDef } from "agent-runtime";
import { dataDirFrom } from "../../env.ts";
import { enqueueOutbound } from "../../store/events.ts";
import { isOwnerDm, ownerIdFrom } from "../access.ts";
import { commitHomeEdit, lastRemoval } from "../memory/home.ts";
import { defineCapability } from "../types.ts";
import { fetchPass, getSet, requestMissingSets, requestSet, setStickers, waitForSet } from "./fetch.ts";
import { findStickers, getSticker, LIST_PAGE, listStickers, RECENT_DAYS, vocabulary, type Candidate, type LibrarySticker } from "./find.ts";
import { fileOfPack, libraryPacks, PACK_NAME, packFileName, packSkeleton, parsePack, ROLES, stickersDir, syncLibrary, type PackFile, type Role, type SyncResult, type Tier } from "./library.ts";
import { refusal } from "./rules.ts";
import { renderContactSheet } from "./sheet.ts";

/**
 * Stickers: the sticker library (docs/design.md §12) and the tools that use it.
 *
 *   SHUVI_STICKERS   "off" disables it (default on)
 *   SHUVI_OWNER_ID   see ../access.ts (which chat is the owner's DM, where dm_only stickers may be used)
 *   (and SHUVI_DATA_DIR, the framework's, for the downloaded pictures)
 *
 * What it brings:
 *   - tools: `find_sticker`, `list_stickers`, `view_stickers`, `sticker` (open to every turn),
 *     `add_sticker_pack` and `remove_sticker_pack` (OWNER-ONLY, `ownerOnly`: they change the library);
 *   - its prompt section: home/stickers/preferences.md (principles across stickers), then the library's
 *     use vocabulary (find.ts `vocabulary`), so she searches with words the library uses; nothing when
 *     both are empty. How each tool is used is in the tool's own description. The section reads the index
 *     as the last sync left it (a section never writes), so it changes only when the library does;
 *   - search help beyond that: a find_sticker result with fewer than SMALL_RESULT candidates adds the
 *     vocabulary and points at `list_stickers`, which browses the library under find_sticker's rules;
 *   - a server loop that keeps the index in step with home/stickers/*.yaml (library.ts) and fetches what
 *     Telegram knows about each pack (fetch.ts), since only the server has the bot token.
 *
 * The library and preferences.md are written with memory's `write_home` (a new file) and `edit_home` (a
 * change to an existing one; owner-only; both are on its allow-list, memory/home.ts). A file that already
 * exists is read with `read_home` first: write_home refuses to overwrite a file not read in this turn, and
 * `add_sticker_pack` says so rather than share that turn state. The one file this capability writes itself
 * is a NEW pack's skeleton: `add_sticker_pack` commits it in home/ (through memory/home.ts `commitHomeEdit`,
 * the same helper as `write_home`) with the role it was given, so adding a pack is one step; an existing
 * file is never touched, only shown again as a skeleton. The index notices any change to the files by
 * itself, whoever made it.
 *
 * `remove_sticker_pack` takes a whole pack out (one sticker is retired with `tier: never` instead): it
 * deletes the pack's file as one commit in home/ (`commitHomeEdit` again, `why` as the message) and
 * re-indexes at once, so no sticker tool offers or accepts its stickers from that call on. What the file
 * said stays in home/'s git history; adding the pack again starts from a fresh skeleton, and says where the
 * old descriptions are. Only the file goes: what Telegram told us about the set (`sticker_sets`,
 * `sticker_meta`) and its downloaded pictures in data/ stay, being a cache that adding the pack again
 * reuses, and her past uses in `chat_events` are history, never rewritten.
 *
 * Which packs are in the library is runtime data in home/, never in this repository.
 *
 * `sticker` queues a `bot_sticker` row; the sender delivers it with `sendSticker`. The mechanical rules it
 * enforces are in rules.ts, the ranking in find.ts, the contact sheet in sheet.ts.
 *
 * Group-safe: in any chat but the owner's DM, `dm_only` stickers and packs are neither offered nor sent.
 */

export interface StickersConfig {
  dataDir: string;
  ownerId: number | null;
  /** How long `add_sticker_pack` waits for the server to fetch a set before saying "call again". */
  fetchWaitMs: number;
}

export const FETCH_WAIT_MS = 60_000;

/** A line per library file that could not be indexed. */
const errorLines = (r: SyncResult) => r.errors.map((e) => `stickers/${e.file} has an error and was not re-read (its previous version is still in use): ${e.error}`);

/** Fewer find_sticker candidates than this, and its result also shows the vocabulary. */
export const SMALL_RESULT = 3;

const vocabularyLine = (v: { label: string }[]) => v.map((x) => x.label).join(", ");

/** What a thin find_sticker result adds. */
function hint(v: { label: string }[]): string {
  return v.length
    ? `The library describes when to send a sticker with these words: ${vocabularyLine(v)}. Try another of them, or browse with list_stickers.`
    : "Try other words (what it shows, or when you would send it), or browse with list_stickers.";
}

function listed(s: LibrarySticker): string {
  const emoji = s.meta?.emoji ? ` ${s.meta.emoji}` : "";
  return `- ${s.id}${emoji} · ${s.tier}\n  shows: ${s.desc || "(not described)"}\n  use: ${s.use || "(not described)"}`;
}

function describe(c: Candidate): string {
  const tier = c.tier === "normal" ? "" : ` · ${c.tier}`;
  const used = c.recentUses ? ` · used ${c.recentUses}× in ${RECENT_DAYS} days` : "";
  const emoji = c.meta?.emoji ? ` ${c.meta.emoji}` : "";
  return `- ${c.id}${emoji}${tier}${used}\n  shows: ${c.desc || "(not described)"}\n  use: ${c.use || "(not described)"}`;
}

export const stickers = defineCapability<StickersConfig>({
  id: "stickers",
  label: "stickers",
  gives: "find_sticker, list_stickers, view_stickers and sticker from her library; add_sticker_pack and remove_sticker_pack when the owner asks.",
  enable: (env) => {
    if (env.SHUVI_STICKERS === "off") return null;
    return { dataDir: dataDirFrom(env), ownerId: ownerIdFrom(env), fetchWaitMs: FETCH_WAIT_MS };
  },
  ownerOnly: ["add_sticker_pack", "remove_sticker_pack"],

  tools({ db, home, chat, state: s }, { dataDir, ownerId, fetchWaitMs }) {
    const inDm = isOwnerDm(chat, ownerId);

    const find: ToolDef<{ terms: string[]; pack?: string }> = {
      name: "find_sticker",
      description:
        "Find stickers to send. `terms`: a few words for what you want to convey or what it should show (OR-combined; matched as text against each sticker's description and when-to-use, so a synonym the library does not use misses). Search in the language the descriptions are written in, and prefer the words in the stickers vocabulary of your instructions. Optionally limit to one `pack`. Candidates come best first, with their id, what they show, when to use them, their tier and how often you used them lately. Name a sticker by id as a term to look it up directly.",
      inputSchema: {
        terms: z.array(z.string().min(1)).min(1).describe("Words to match, e.g. [\"ok\", \"got it\"] or [\"好的\", \"收到\"]"),
        pack: z.string().optional().describe("Only this pack"),
      },
      async handler({ terms, pack }) {
        const sync = syncLibrary(db, home);
        const { candidates, unfetched } = findStickers(db, { terms, ...(pack ? { pack } : {}), inDm });
        const notes = [
          ...(unfetched ? [`${unfetched} more matched but their pack is not fetched from Telegram yet.`] : []),
          ...(candidates.length < SMALL_RESULT ? [hint(vocabulary(db, inDm))] : []),
          ...errorLines(sync),
        ];
        if (!candidates.length) return ok(["No sticker matches.", ...notes].join("\n"));
        return ok([`${candidates.length} candidate(s), best first. Send one with \`sticker\`.`, ...candidates.map(describe), ...notes].join("\n"));
      },
    };

    const list: ToolDef<{ pack?: string; use?: string; tier?: Exclude<Tier, "never">; page?: number }> = {
      name: "list_stickers",
      description: `Browse the sticker library when find_sticker's words miss: every sticker you could send, in pack and number order, with its id, what it shows, when to use it and its tier, ${LIST_PAGE} to a page. Narrow it with \`pack\`, \`use\` (text in its when-to-use) or \`tier\`; ask for the next \`page\` when it says there is one.`,
      inputSchema: {
        pack: z.string().optional().describe("Only this pack"),
        use: z.string().min(1).optional().describe("Only stickers whose when-to-use contains this, e.g. \"hello\" or \"開心\""),
        tier: z.enum(["go-to", "normal", "rare"]).optional().describe("Only this tier"),
        page: z.number().int().positive().optional().describe("Which page, from 1 (default 1)"),
      },
      async handler({ pack, use, tier, page }) {
        const sync = syncLibrary(db, home);
        const r = listStickers(db, { inDm, ...(pack ? { pack } : {}), ...(use ? { use } : {}), ...(tier ? { tier } : {}), ...(page ? { page } : {}) });
        const notes = [...(r.unfetched ? [`${r.unfetched} more are in packs not fetched from Telegram yet.`] : []), ...errorLines(sync)];
        if (!r.total) return ok(["No sticker in the library fits that.", ...notes].join("\n"));
        const first = (r.page - 1) * LIST_PAGE + 1;
        const head = `Stickers ${first}–${first + r.stickers.length - 1} of ${r.total} (page ${r.page}/${r.pages}).${r.page < r.pages ? ` For more, call list_stickers again with page ${r.page + 1}.` : ""} Send one with \`sticker\`.`;
        return ok([head, ...r.stickers.map(listed), ...notes].join("\n"));
      },
    };

    const view: ToolDef<{ ids: string[] }> = {
      name: "view_stickers",
      description: "Look at stickers by id (from find_sticker), when their description is not enough to choose. Up to 10.",
      inputSchema: { ids: z.array(z.string()).min(1).max(10).describe("Sticker ids, e.g. [\"ExamplePack/3\"]") },
      async handler({ ids }) {
        syncLibrary(db, home);
        const content: ToolContent[] = [];
        for (const id of ids) {
          const st = getSticker(db, id);
          if (!st) {
            content.push({ type: "text", text: `${id}: no such sticker in the library.` });
            continue;
          }
          const head = `${st.id}${st.meta?.emoji ? ` ${st.meta.emoji}` : ""}: ${st.desc || "(not described)"}`;
          const path = st.meta?.path;
          let image: ToolContent | null = null;
          if (path && st.meta?.mimeType) {
            try {
              image = { type: "image", data: readFileSync(join(dataDir, path)).toString("base64"), mimeType: st.meta.mimeType };
            } catch {}
          }
          content.push({ type: "text", text: image ? head : `${head} (no picture available)` });
          if (image) content.push(image);
        }
        return { content };
      },
    };

    const send: ToolDef<{ id: string }> = {
      name: "sticker",
      description:
        "Send a sticker by id (from find_sticker). It goes out as its own message, after any text you wrote before calling this, and can be your whole reply. One at a time: put words or another action between two stickers.",
      inputSchema: { id: z.string().describe("The sticker's id, e.g. \"ExamplePack/3\"") },
      async handler({ id }) {
        syncLibrary(db, home);
        const st = getSticker(db, id);
        if (!st) return err(`${id} is not in the sticker library. Use an id that find_sticker gave you.`);
        const why = refusal(db, chat.id, s.toSeq, st, inDm);
        if (why) return err(why);
        enqueueOutbound(db, {
          chatId: chat.id,
          kind: "bot_sticker",
          payload: { fileId: st.meta!.fileId, fileUniqueId: st.fileUniqueId, stickerId: st.id, ...(st.meta!.emoji ? { emoji: st.meta!.emoji } : {}) },
          idemKey: `turn:${s.turnId}:${s.n++}`,
          turnId: s.turnId,
        });
        return ok(`Sent ${st.id}.`);
      },
    };

    const add: ToolDef<{ name: string; role?: Role }> = {
      name: "add_sticker_pack",
      description:
        "Add a sticker pack to the library, or learn it again, when the owner asks. Give the pack's Telegram set `name` (e.g. from a sticker someone sent) and its `role` (avatar / common / meme; default common). A pack not in the library yet gets its file stickers/<name>.yaml created and committed as a skeleton: every sticker numbered, desc and use empty. Returns a numbered contact sheet of every sticker and the skeleton (for a pack you already have, what its file says is carried over). Look at the sheet; fill in each sticker's desc (what it shows: a fact) and use (when to send it: several ways of saying it, separated by commas or 、, e.g. \"happy, smile, grin\" or \"開心、笑臉、微笑\", since search matches words, not meanings), and any tier (go-to / rare / never); leave stickers you cannot place without desc. To save, read the file with `read_home` first, then change it with `edit_home` (or rewrite it whole with `write_home`). Only the owner can have this done.",
      inputSchema: {
        name: z.string().describe("The sticker set's name, e.g. \"ExamplePack\""),
        role: z.enum(ROLES).optional().describe("The pack's role: avatar / common / meme (default common; for a pack you already have, default its current role)"),
      },
      async handler({ name, role }) {
        if (!PACK_NAME.test(name)) return err(`"${name}" is not a sticker set name (letters, digits and _ only).`);
        if (role !== undefined && !(ROLES as readonly string[]).includes(role)) return err(`role must be one of ${ROLES.join(" / ")}.`);

        const set = getSet(db, name);
        if (!set || set.state !== "ready" || !set.fetchedAt || Date.now() - Date.parse(set.fetchedAt) > 60_000) requestSet(db, name);
        const got = await waitForSet(db, name, fetchWaitMs);
        if (!got || got.state === "pending") return ok(`Still fetching ${name} from Telegram. Call add_sticker_pack("${name}") again in a moment.`);
        if (got.state === "failed") return err(`Telegram could not give the pack ${name}: ${got.error ?? "unknown error"}. Check the name.`);

        const metas = setStickers(db, name);
        const pages = await renderContactSheet(metas.map((m) => ({ n: m.position, path: m.path })), dataDir);
        const file = join(stickersDir(home), packFileName(name));
        const exists = existsSync(file);
        let existing: PackFile | undefined;
        try {
          existing = exists ? parsePack(readFileSync(file, "utf8")) : undefined;
        } catch {}
        const skeleton = packSkeleton(
          name,
          role ?? existing?.role ?? "common",
          metas.map((m) => ({ n: m.position, fileUniqueId: m.fileUniqueId, emoji: m.emoji })),
          existing && role ? { ...existing, role } : existing,
          got.title,
        );
        let created: string | null = null;
        let removed: string | null = null;
        if (!exists) {
          removed = lastRemoval(home, join("stickers", packFileName(name)));
          try {
            created = commitHomeEdit(home, join("stickers", packFileName(name)), skeleton, `stickers: skeleton for ${name}`);
          } catch (e) {
            return err(`Could not create stickers/${packFileName(name)}: ${e instanceof Error ? e.message : String(e)}`);
          }
          syncLibrary(db, home);
        }
        const missing = metas.filter((m) => !m.path).map((m) => m.position);
        const content: ToolContent[] = [
          {
            type: "text",
            text: `${got.title ?? name}: ${metas.length} stickers, numbered in set order on ${pages.length} sheet(s).${missing.length ? ` No picture for ${missing.join(", ")}.` : ""}${existing ? " What the current file says is carried into the skeleton." : ""}`,
          },
        ];
        pages.forEach((p, i) => {
          content.push({ type: "text", text: `Sheet ${i + 1}/${pages.length}: ${p.numbers[0]}–${p.numbers.at(-1)}` });
          content.push({ type: "image", data: p.image.toString("base64"), mimeType: "image/jpeg" });
        });
        const how = created
          ? `created it as this skeleton (commit ${created}); to fill it in, read it with read_home, then save your changes with edit_home (or the whole file with write_home)`
          : `that file already exists, so read it first with read_home, then save your changes with edit_home (or the whole file with write_home)`;
        content.push({ type: "text", text: `The skeleton for stickers/${packFileName(name)}; ${how}:\n\n\`\`\`yaml\n${skeleton}\`\`\`` });
        if (removed) {
          content.push({
            type: "text",
            text: `${name} was removed from the library before (commit ${removed}), so this is a fresh skeleton. What its old file said is still in home/'s git history (stickers/${packFileName(name)} as it was before commit ${removed}), if the owner wants it back.`,
          });
        }
        return { content };
      },
    };

    const remove: ToolDef<{ name: string; why: string }> = {
      name: "remove_sticker_pack",
      description:
        "Take a whole sticker pack out of the library, when the owner asks: its file stickers/<name>.yaml is deleted (as a commit, with `why` as the message) and none of its stickers is offered or sent any more. To retire a single sticker, set its tier to never instead. Adding the pack again later starts from a fresh skeleton. Only the owner can have this done.",
      inputSchema: {
        name: z.string().describe("The pack's name, as in its sticker ids, e.g. \"ExamplePack\""),
        why: z.string().min(1).describe("Why it goes, in a line: the commit message"),
      },
      async handler({ name, why }) {
        syncLibrary(db, home);
        const file = fileOfPack(db, name);
        if (!file) {
          const packs = libraryPacks(db).sort();
          return err(`${name} is not in the sticker library. ${packs.length ? `The packs in it: ${packs.join(", ")}.` : "The library has no packs."}`);
        }
        const rel = join("stickers", file);
        const count = db.$client.query("select count(*) as n from sticker_library where file = ?").get(file) as { n: number };
        let commit: string;
        try {
          commit = commitHomeEdit(home, rel, null, why);
        } catch (e) {
          return err(`Could not remove ${rel}: ${e instanceof Error ? e.message : String(e)}`);
        }
        syncLibrary(db, home);
        return ok(
          `Removed ${name} from the library (commit ${commit}): its ${count.n} sticker(s) are no longer offered or sent. What ${rel} said stays in home/'s git history (the file as it was before commit ${commit}); add_sticker_pack("${name}") would start again from a fresh skeleton.`,
        );
      },
    };

    return [{ serverName: "shuvi", tools: [find, list, view, send, add, remove] as ToolDef[] }];
  },

  // Reads only (PromptContext): the index as the last sync left it, never a sync of its own.
  section({ home, chat, db }, { ownerId }) {
    const p = join(stickersDir(home), "preferences.md");
    const body = existsSync(p) ? readFileSync(p, "utf8").trim() : "";
    const words = db ? vocabulary(db, isOwnerDm(chat, ownerId)) : [];
    const vocab = words.length
      ? `Words the sticker library uses for when to send a sticker, most common first; find_sticker matches text, so search with these: ${vocabularyLine(words)}`
      : "";
    const parts = [body, vocab].filter(Boolean);
    return parts.length ? `## Stickers\n\n${parts.join("\n\n")}` : null;
  },

  loops: ({ db, home, files }, { dataDir }) => [
    {
      name: "stickers",
      everyMs: 1000,
      run: async () => {
        syncLibrary(db, home);
        requestMissingSets(db);
        await fetchPass(db, files, dataDir);
      },
    },
  ],
});
