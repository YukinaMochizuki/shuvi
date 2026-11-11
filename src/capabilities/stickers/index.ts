import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { err, ok, type ToolContent, type ToolDef } from "agent-runtime";
import { dataDirFrom } from "../../env.ts";
import { enqueueOutbound } from "../../store/events.ts";
import { isOwnerDm, ownerIdFrom } from "../access.ts";
import { defineCapability } from "../types.ts";
import { fetchPass, getSet, requestMissingSets, requestSet, setStickers, waitForSet } from "./fetch.ts";
import { findStickers, getSticker, RECENT_DAYS, type Candidate } from "./find.ts";
import { PACK_NAME, packFileName, packSkeleton, parsePack, stickersDir, syncLibrary, type PackFile, type SyncResult } from "./library.ts";
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
 *   - tools: `find_sticker`, `view_stickers`, `sticker` (open to every turn) and `add_sticker_pack`
 *     (OWNER-ONLY, `ownerOnly`: learning a pack is the first step of changing the library);
 *   - its prompt section: home/stickers/preferences.md (principles across stickers), and nothing when
 *     that file is absent: how each tool is used is in the tool's own description;
 *   - a server loop that keeps the index in step with home/stickers/*.yaml (library.ts) and fetches what
 *     Telegram knows about each pack (fetch.ts), since only the server has the bot token.
 *
 * The library and preferences.md are written with memory's `write_home` (a new file) and `edit_home` (a
 * change to an existing one; owner-only; both are on its allow-list, memory/home.ts). A file that already
 * exists is read with `read_home` first: write_home refuses to overwrite a file not read in this turn, and
 * `add_sticker_pack` says so rather than share that turn state. Never written by this capability:
 * `add_sticker_pack` only returns the contact sheet and a skeleton. The index notices any change to the
 * files by itself, whoever made it.
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

function describe(c: Candidate): string {
  const tier = c.tier === "normal" ? "" : ` · ${c.tier}`;
  const used = c.recentUses ? ` · used ${c.recentUses}× in ${RECENT_DAYS} days` : "";
  const emoji = c.meta?.emoji ? ` ${c.meta.emoji}` : "";
  return `- ${c.id}${emoji}${tier}${used}\n  shows: ${c.desc || "(not described)"}\n  use: ${c.use || "(not described)"}`;
}

export const stickers = defineCapability<StickersConfig>({
  id: "stickers",
  enable: (env) => {
    if (env.SHUVI_STICKERS === "off") return null;
    return { dataDir: dataDirFrom(env), ownerId: ownerIdFrom(env), fetchWaitMs: FETCH_WAIT_MS };
  },
  ownerOnly: ["add_sticker_pack"],

  tools({ db, home, chat, state: s }, { dataDir, ownerId, fetchWaitMs }) {
    const inDm = isOwnerDm(chat, ownerId);

    const find: ToolDef<{ terms: string[]; pack?: string }> = {
      name: "find_sticker",
      description:
        "Find stickers to send. `terms`: a few words for what you want to convey or what it should show (OR-combined; matched against each sticker's description and when-to-use). Optionally limit to one `pack`. Candidates come best first, with their id, what they show, when to use them, their tier and how often you used them lately. Name a sticker by id as a term to look it up directly.",
      inputSchema: {
        terms: z.array(z.string().min(1)).min(1).describe("Words to match, e.g. [\"ok\", \"got it\"]"),
        pack: z.string().optional().describe("Only this pack"),
      },
      async handler({ terms, pack }) {
        const sync = syncLibrary(db, home);
        const { candidates, unfetched } = findStickers(db, { terms, ...(pack ? { pack } : {}), inDm });
        const notes = [
          ...(unfetched ? [`${unfetched} more matched but their pack is not fetched from Telegram yet.`] : []),
          ...errorLines(sync),
        ];
        if (!candidates.length) return ok(["No sticker matches. Try other words: what it shows, or when you would send it.", ...notes].join("\n"));
        return ok([`${candidates.length} candidate(s), best first. Send one with \`sticker\`.`, ...candidates.map(describe), ...notes].join("\n"));
      },
    };

    const view: ToolDef<{ ids: string[] }> = {
      name: "view_stickers",
      description: "Look at stickers by id (from find_sticker), when their description is not enough to choose. Up to 10.",
      inputSchema: { ids: z.array(z.string()).min(1).max(10).describe("Sticker ids, e.g. [\"EveOneCat/12\"]") },
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
      inputSchema: { id: z.string().describe("The sticker's id, e.g. \"EveOneCat/12\"") },
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

    const add: ToolDef<{ name: string }> = {
      name: "add_sticker_pack",
      description:
        "Learn a sticker pack, when the owner asks. Give the pack's Telegram set `name` (e.g. from a sticker someone sent): returns a numbered contact sheet of every sticker and a YAML skeleton for stickers/<name>.yaml (what the current file says is carried over). Look at the sheet; fill in each sticker's desc (what it shows: a fact) and use (when to send it); set the pack's role (avatar / common / meme) and any tier (go-to / rare / never); leave stickers you cannot place without desc. Then save it: a new pack's file with `write_home` (path stickers/<name>.yaml); when the file already exists, read it with `read_home` first, then change it with `edit_home` (or rewrite it whole with `write_home`). Only the owner can have this done.",
      inputSchema: { name: z.string().describe("The sticker set's name") },
      async handler({ name }) {
        if (!PACK_NAME.test(name)) return err(`"${name}" is not a sticker set name (letters, digits and _ only).`);

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
        const skeleton = packSkeleton(name, existing?.role ?? "common", metas.map((m) => ({ n: m.position, fileUniqueId: m.fileUniqueId, emoji: m.emoji })), existing, got.title);
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
        content.push({ type: "text", text: `The skeleton for stickers/${packFileName(name)}; ${exists ? "that file already exists, so read it first with read_home, then save your changes with edit_home (or the whole file with write_home)" : "save it filled in with write_home"}:\n\n\`\`\`yaml\n${skeleton}\`\`\`` });
        return { content };
      },
    };

    return [{ serverName: "shuvi", tools: [find, view, send, add] as ToolDef[] }];
  },

  section({ home }) {
    const p = join(stickersDir(home), "preferences.md");
    if (!existsSync(p)) return null;
    const body = readFileSync(p, "utf8").trim();
    return body ? `## Stickers\n\n${body}` : null;
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
