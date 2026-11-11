import { z } from "zod";
import { err, ok, type ToolDef, type ToolResult } from "agent-runtime";
import { isOwnerDm, ownerIdFrom } from "../access.ts";
import { defineCapability, type TurnContext } from "../types.ts";
import { chatNotesPath, commitHomeEdit, readHomeFile, refusal, type HomeAccess } from "./home.ts";

/**
 * Memory: the assistant curates her standing files in `home/` (docs/design.md §8, §9). Each edit is a git
 * commit in home/, authored as shuvi, whose message is the edit's required `why`.
 *
 *   read_home        any file on the allow-list this chat may see (./home.ts)
 *   edit_home        any of them. OWNER-ONLY: the turn's boundary refuses the call unless everyone the turn
 *                    has been shown is the owner (agent/turn.ts `ownerAuthority`), so persona, directives,
 *                    private memory and playbooks change only when the owner asks
 *   edit_chat_notes  this chat's own notes, `chats/<this chat>.md`, open to any turn: what someone in a
 *                    chat asks her to remember can at most go there (design §8)
 *
 * Authority is not checked here: that is the boundary's, per call. What is checked here is what a chat may
 * see at all (private layers only in the owner's DM) and the allow-list.
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

type EditArgs = { content?: string; old?: string; new?: string; why: string };

const editSchema = {
  content: z.string().optional().describe("The file's whole new text"),
  old: z.string().optional().describe("An exact passage of the file to replace"),
  new: z.string().optional().describe("What replaces `old` (empty to delete it)"),
  why: z.string().min(1).describe("One line: why you are making this change"),
};

/** Apply one edit (a whole write, or one exact replacement) to `path` and commit it. */
function applyEdit(home: string, path: string, args: EditArgs): ToolResult {
  const whole = args.content !== undefined;
  const replace = args.old !== undefined || args.new !== undefined;
  if (whole === replace) return err("Give either `content` (the whole file) or `old` and `new` (one replacement), not both or neither.");
  let next: string;
  if (whole) next = args.content!.endsWith("\n") || !args.content ? args.content! : `${args.content}\n`;
  else {
    if (!args.old) return err("`old` must be a non-empty passage of the file.");
    const current = readHomeFile(home, path);
    if (current === null) return err(`${path} does not exist yet; write it whole with \`content\`.`);
    const count = current.split(args.old).length - 1;
    if (count !== 1) return err(count === 0 ? `\`old\` does not occur in ${path}. Read it again with read_home.` : `\`old\` occurs ${count} times in ${path}; include more around it so it is unique.`);
    next = current.replace(args.old, () => args.new ?? "");
  }
  try {
    const commit = commitHomeEdit(home, path, next, args.why.trim());
    return ok(`Saved ${path} (commit ${commit}). Mention the change in one line in the chat.`);
  } catch (e) {
    return err(`${e instanceof Error ? e.message : String(e)}. ${path} is unchanged.`);
  }
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

Your persona, the rules and the memory in this prompt come from files you keep yourself. Read one with \`read_home\`. Change one with \`edit_home\` when the owner asks (only the owner can have them changed), and keep this chat's notes with \`edit_chat_notes\`, which anyone here may ask for:

${files}

Write down what will matter later, when you judge it will, or when ${ownerDm ? "the owner" : "someone"} asks you to remember something. Keep each file short and current: replace what has gone stale rather than piling on. Anything else that was said needs no note; you can find it again in the chat logs.

Every edit is saved with a \`why\`, one line on why you changed it. After an edit, mention it in one line in the chat (for example "Noted: you take your coffee black."). A change to a file in this prompt applies from your next turn.`;
}

export const memory = defineCapability<MemoryConfig>({
  id: "memory",
  enable: (env) => (env.SHUVI_MEMORY === "off" ? null : { ownerId: ownerIdFrom(env) }),
  ownerOnly: ["edit_home"],
  tools(ctx, config) {
    const home = ctx.home;
    const access = () => homeAccess(ctx, config.ownerId);

    const readHome: ToolDef<{ path: string }> = {
      name: "read_home",
      description: "Read one of your files in home/ (persona, directives, memory, this chat's notes, a playbook).",
      inputSchema: { path: z.string().describe("e.g. memory/private.md") },
      async handler({ path }) {
        const no = refusal(path, access());
        if (no) return err(no);
        const text = readHomeFile(home, path);
        return ok(text === null || !text.trim() ? `(${path} is empty)` : text);
      },
    };

    const editHome: ToolDef<EditArgs & { path: string }> = {
      name: "edit_home",
      description:
        "Change one of your files in home/ (persona, directives, memory, a playbook, this chat's notes), when the owner asks: either write it whole (`content`), or replace one exact passage (`old` → `new`; `old` must occur exactly once). Saved as a commit with `why` as its message. Only the owner can have this done.",
      inputSchema: { path: z.string().describe("e.g. memory/private.md"), ...editSchema },
      async handler({ path, ...args }) {
        const no = refusal(path, access());
        if (no) return err(no);
        return applyEdit(home, path, args);
      },
    };

    const editChatNotes: ToolDef<EditArgs> = {
      name: "edit_chat_notes",
      description: `Change your notes on this chat (${chatNotesPath(ctx.chat.tgChatId)}), which anyone here may ask you to keep: either write them whole (\`content\`), or replace one exact passage (\`old\` → \`new\`). Saved as a commit with \`why\` as its message.`,
      inputSchema: editSchema,
      async handler(args) {
        return applyEdit(home, chatNotesPath(ctx.chat.tgChatId), args);
      },
    };

    return [{ serverName: "shuvi", tools: [readHome, editHome, editChatNotes] as ToolDef[] }];
  },
  section: (ctx, config) => memorySection(ctx.chat.tgChatId, isOwnerDm(ctx.chat, config.ownerId)),
});
