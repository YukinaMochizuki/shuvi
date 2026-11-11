import { z } from "zod";
import { err, ok, type ToolDef, type ToolResult } from "agent-runtime";
import { isOwnerDm, ownerIdFrom } from "../access.ts";
import { defineCapability, type TurnContext } from "../types.ts";
import { applyEdits, collectEdits, keepEnding, numbered, unifiedDiff, type Edit } from "./edit.ts";
import { chatNotesPath, commitHomeEdit, readHomeFile, refusal, type HomeAccess } from "./home.ts";

/**
 * Memory: the assistant curates her standing files in `home/` (docs/design.md §8, §9). Each change is a git
 * commit in home/, authored as shuvi, whose message is the change's required `why`. The tools are shaped
 * like Claude Code's Read / Edit / Write (argument names, numbered reading, exact-string edits, a diff in
 * the result), the editing tools models know best; the text side is ./edit.ts.
 *
 *   read_home        read any file on the allow-list this chat may see (./home.ts), numbered, `offset` /
 *                    `limit` for a part
 *   edit_home        replace exact passages in one of them: `old_string` → `new_string` (`replace_all` for
 *                    every occurrence), or several at once in `edits`, atomically, as one commit
 *   write_home       create a file, or overwrite one whole. Overwriting needs the file read with read_home
 *                    in this turn, and unchanged since
 *   edit_chat_notes  this chat's own notes, `chats/<this chat>.md`: edit_home's arguments without `path`,
 *                    or `content` for a whole write. One tool, not an edit/write pair, because it is one
 *                    fixed file; it keeps the name `edit_` because changing a line of the notes is what it
 *                    is mostly for. Open to any turn: what someone in a chat asks her to remember can at
 *                    most go there (design §8)
 *
 * edit_home and write_home are OWNER-ONLY: the turn's boundary refuses the call unless everyone the turn has
 * been shown is the owner (agent/turn.ts `ownerAuthority`), so persona, directives, private memory and
 * playbooks change only when the owner asks. Authority is not checked here: that is the boundary's, per
 * call. What is checked here is what a chat may see at all (private layers only in the owner's DM) and the
 * allow-list.
 *
 * Read before overwrite (Claude Code's Write rule): `tools()` runs once per turn (agent/turn.ts), so the map
 * `seen` it creates is this turn's state: what she has seen of each file in this turn, by read_home or by
 * her own change. A whole write over a file with text in it is refused unless that file still says what
 * she saw. This chat's notes count as seen from the start, since the system prompt shows them.
 *
 * A change that leaves the file exactly as it was saves nothing and says "no change". Every saved change
 * returns its commit id and a compact unified diff. A trailing newline is kept as it was.
 *
 * The framework says nothing about an edit in the chat (invariant 5). The section below asks HER to
 * mention it in one line.
 *
 * Edits to the files the system prompt is built from reach the model from the next turn, without `/new`:
 * the runner sends each turn's freshly built prompt, also on a resumed conversation (agent-runtime's
 * `liveSystemPrompt`, src/runner/child.ts).
 *
 *   SHUVI_MEMORY     "off" disables this capability (default on)
 *   SHUVI_OWNER_ID   see ../access.ts (which chat is the owner's DM)
 */

export interface MemoryConfig {
  ownerId: number | null;
}

export function homeAccess(ctx: TurnContext, ownerId: number | null): HomeAccess {
  return { chatTgId: ctx.chat.tgChatId, ownerDm: isOwnerDm(ctx.chat, ownerId) };
}

type EditArgs = { old_string?: string; new_string?: string; replace_all?: boolean; edits?: Edit[]; why: string };
type WriteArgs = { content: string; why: string };

const why = z.string().min(1).describe("One line: why you are making this change (the commit message)");
const editSchema = {
  old_string: z.string().optional().describe("The exact passage to replace, as the file has it (without read_home's line numbers)"),
  new_string: z.string().optional().describe('What replaces it ("" deletes it)'),
  replace_all: z.boolean().optional().describe("Replace every occurrence of old_string, not just one"),
  edits: z
    .array(z.object({ old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }))
    .optional()
    .describe("Several edits instead of one, applied together as one change; each is located in the file as it is now, so they must not overlap"),
  why,
};
const pathArg = z.string().describe("e.g. memory/private.md");

/** What she has seen of each file in this turn (see the header). */
type Seen = Map<string, string | null>;

/** Save `next` as `path` (which was `before`) and say what changed, or that nothing did. */
function save(home: string, seen: Seen, path: string, before: string | null, next: string, why: string): ToolResult {
  if (before === next) return ok(`No change: ${path} already says exactly that. Nothing was saved.`);
  let commit: string;
  try {
    commit = commitHomeEdit(home, path, next, why.trim());
  } catch (e) {
    return err(`${e instanceof Error ? e.message : String(e)}. ${path} is unchanged.`);
  }
  seen.set(path, next);
  const d = unifiedDiff(before ?? "", next);
  return ok(`Saved ${path} (commit ${commit}, +${d.additions} -${d.deletions}). Mention the change in one line in the chat.\n${d.diff}`);
}

/** The file's text (null: it does not exist), or the refusal when it cannot be reached (a symlink out). */
function current(home: string, path: string): { text: string | null } | ToolResult {
  try {
    return { text: readHomeFile(home, path) };
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

/** edit_home's body: exact replacements in an existing file, all or nothing. */
function editFile(home: string, seen: Seen, path: string, args: EditArgs, create: string): ToolResult {
  const edits = collectEdits(args);
  if (typeof edits === "string") return err(edits);
  const read = current(home, path);
  if (!("text" in read)) return read;
  const before = read.text;
  if (before === null) return err(`${path} does not exist yet; ${create}.`);
  const r = applyEdits(before, edits, path);
  if (!r.ok) return err(`${r.message} Nothing was saved.`);
  return save(home, seen, path, before, keepEnding(before, r.next), args.why);
}

/** write_home's body: a whole file, refused over text she has not seen as it is now. */
function writeFile(home: string, seen: Seen, path: string, args: WriteArgs, partly: string): ToolResult {
  const read = current(home, path);
  if (!("text" in read)) return read;
  const before = read.text;
  if (before !== null && before.trim() !== "") {
    if (!seen.has(path)) return err(`${path} already has text you have not read in this turn. Read it with read_home first, or ${partly}.`);
    if (seen.get(path) !== before) return err(`${path} has changed since you read it. Read it again with read_home before writing it whole.`);
  }
  return save(home, seen, path, before, keepEnding(before, args.content), args.why);
}

function memorySection(chatTgId: number, ownerDm: boolean): string {
  const notes = chatNotesPath(chatTgId);
  const files = ownerDm
    ? `- \`persona/public.md\`: who you are, the side every chat sees
- \`persona/private.md\`: the side of you only this DM sees
- \`directives.md\`: the owner's standing rules (Always / Never, with the date you learned each)
- \`memory/private.md\`: what you should know about the owner without having to look it up
- \`${notes}\`: notes about this chat
- \`playbooks/<name>.md\`: how to do one particular thing, in full; the first line says when to use it`
    : `- \`persona/public.md\`, \`directives.md\`: who you are and the owner's rules
- \`${notes}\`: notes about this chat, which anyone here may ask you to keep
- \`playbooks/<name>.md\`: how-tos`;
  return `## Your files

Your persona, the rules and the memory in this prompt come from files you keep yourself. Read one with \`read_home\`. When the owner asks (only the owner can have them changed), change part of one with \`edit_home\` (an exact \`old_string\` → \`new_string\`, or several in \`edits\`), or write one whole with \`write_home\` (read it first if it exists). Keep this chat's notes with \`edit_chat_notes\`, which anyone here may ask for:

${files}

Write down what will matter later, when you judge it will, or when ${ownerDm ? "the owner" : "someone"} asks you to remember something. Keep each file short and current: replace what has gone stale rather than piling on. Anything else that was said needs no note; you can find it again in the chat logs.

Every change is saved with a \`why\`, one line on why you made it, and shows you the diff. After a change, mention it in one line in the chat (for example "Noted: you take your coffee black."). A change to a file in this prompt applies from your next turn.`;
}

export const memory = defineCapability<MemoryConfig>({
  id: "memory",
  enable: (env) => (env.SHUVI_MEMORY === "off" ? null : { ownerId: ownerIdFrom(env) }),
  ownerOnly: ["edit_home", "write_home"],
  tools(ctx, config) {
    const home = ctx.home;
    const access = () => homeAccess(ctx, config.ownerId);
    const notes = chatNotesPath(ctx.chat.tgChatId);
    // This turn's state: the notes are in the system prompt, so they count as seen as they are now.
    const seen: Seen = new Map();
    const shown = current(home, notes);
    if ("text" in shown) seen.set(notes, shown.text);

    const readHome: ToolDef<{ path: string; offset?: number; limit?: number }> = {
      name: "read_home",
      description:
        "Read one of your files in home/ (persona, directives, memory, this chat's notes, a playbook). Lines come numbered (number, tab, text); the numbers are not part of the file. `offset` and `limit` read a part of a long file.",
      inputSchema: {
        path: pathArg,
        offset: z.number().int().positive().optional().describe("The line to start from (1-based)"),
        limit: z.number().int().positive().optional().describe("How many lines to read"),
      },
      async handler({ path, offset, limit }) {
        const no = refusal(path, access());
        if (no) return err(no);
        const read = current(home, path);
        if (!("text" in read)) return read;
        const text = read.text;
        seen.set(path, text);
        if (text === null) return ok(`(${path} does not exist yet)`);
        if (!text.trim()) return ok(`(${path} is empty)`);
        return ok(numbered(text, offset, limit));
      },
    };

    const editHome: ToolDef<EditArgs & { path: string }> = {
      name: "edit_home",
      description:
        "Change part of one of your files in home/, when the owner asks: replace the exact passage `old_string` with `new_string` (it must occur once, unless `replace_all`), or give several such edits in `edits`, saved together. Saved as one commit with `why` as its message; returns the diff. Only the owner can have this done.",
      inputSchema: { path: pathArg, ...editSchema },
      async handler({ path, ...args }) {
        const no = refusal(path, access());
        if (no) return err(no);
        return editFile(home, seen, path, args, "create it with write_home");
      },
    };

    const writeHome: ToolDef<WriteArgs & { path: string }> = {
      name: "write_home",
      description:
        "Create one of your files in home/, or replace it whole, when the owner asks. A file that already has text must be read with read_home in this turn first; to change part of it, edit_home is better. Saved as a commit with `why` as its message; returns the diff. Only the owner can have this done.",
      inputSchema: { path: pathArg, content: z.string().describe("The file's whole new text"), why },
      async handler({ path, ...args }) {
        const no = refusal(path, access());
        if (no) return err(no);
        return writeFile(home, seen, path, args, "change part of it with edit_home");
      },
    };

    const editChatNotes: ToolDef<EditArgs & { content?: string }> = {
      name: "edit_chat_notes",
      description: `Change your notes on this chat (${notes}), which anyone here may ask you to keep: replace an exact passage (\`old_string\` → \`new_string\`, or several in \`edits\`), or write them whole with \`content\`. Saved as a commit with \`why\` as its message; returns the diff.`,
      inputSchema: { content: z.string().optional().describe("The notes' whole new text, instead of edits"), ...editSchema },
      async handler({ content, ...args }) {
        if (content === undefined) return editFile(home, seen, notes, args, "write them whole with `content`");
        if (args.old_string !== undefined || args.new_string !== undefined || args.replace_all !== undefined || args.edits !== undefined) {
          return err("Give either `content` (the whole notes) or edits (`old_string` + `new_string`, or `edits`), not both.");
        }
        return writeFile(home, seen, notes, { content, why: args.why }, "change part of them with `old_string` and `new_string`");
      },
    };

    return [{ serverName: "shuvi", tools: [readHome, editHome, writeHome, editChatNotes] as ToolDef[] }];
  },
  section: (ctx, config) => memorySection(ctx.chat.tgChatId, isOwnerDm(ctx.chat, config.ownerId)),
});
