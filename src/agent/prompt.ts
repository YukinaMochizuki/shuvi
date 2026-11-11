import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { capabilitySections, type EnabledCapability, type OwnerInfo } from "../capabilities/types.ts";
import { defaultPolicy, GROUP_DEFAULTS, resolveChat, type ChatPolicy } from "../policy/policy.ts";
import type { Db } from "../store/db.ts";
import type { Chat } from "../store/events.ts";
import { playbookIndex } from "./playbooks.ts";

/**
 * The system prompt, assembled from `home/` in the order docs/design.md §6 fixes: the most stable layers
 * first, so the provider's prompt cache keeps as long a prefix as possible.
 *
 *   1. persona      persona/public.md (every chat), persona/private.md (the owner's DM only)
 *   2. directives   directives.md
 *   3. this chat    who is here, and this chat's notes (chats/<telegram chat id>.md)
 *   4. capabilities each enabled capability's section, in registry order (src/capabilities/index.ts):
 *                   speech (how speaking works in this framework) first, then the others (web, …)
 *   5. playbooks    the playbook index (agent/playbooks.ts), a fixed slot after every capability section,
 *                   whatever the registry order; only when the playbooks capability (read_playbook) is on
 *   6. memory       memory/private.md (the owner's DM only)
 *
 * Which persona and memory layers a chat gets is its policy's (`persona`, `memory`, src/policy/): the
 * owner's DM by default gets them all, a group `persona/public.md` and its own notes. Privacy is
 * structural: a layer a chat may not see is never read into that chat's prompt, so there is nothing for a
 * prompt instruction to have to hold back. The private layers are read only in the owner's DM, whatever
 * a policy says (the policy parser refuses them elsewhere too).
 *
 * The prompt is built fresh for every turn and sent on a resumed conversation too (agent/turn.ts), so an
 * edit to home/ reaches the model from the next turn, without `/new`. An unchanged home/ builds the same
 * bytes, so the prompt cache holds; an edit costs it once.
 */

function read(home: string, rel: string): string | null {
  const p = join(home, rel);
  if (!existsSync(p)) return null;
  const s = readFileSync(p, "utf8").trim();
  return s || null;
}

/**
 * `capabilities` are the ones enabled in this process, in registry order; each contributes its section.
 * Without any (a bare call), the prompt has no capability sections at all, not even speech. `db` is
 * handed to the sections to read from (a section never writes; capabilities/types.ts `PromptContext`).
 */
export function buildSystemPrompt(home: string, chat: Chat, owner: OwnerInfo, capabilities: readonly EnabledCapability[] = [], chatPolicy?: ChatPolicy, db?: Db): string {
  const cp = chatPolicy ?? resolveChat(defaultPolicy(), chat) ?? { ...GROUP_DEFAULTS, key: String(chat.tgChatId), ownerDm: false };
  const isOwnerDm = cp.ownerDm && chat.kind === "private";
  const sections: string[] = [];

  const pub = cp.persona.includes("public") ? read(home, "persona/public.md") : null;
  if (pub) sections.push(pub);
  if (isOwnerDm && cp.persona.includes("private")) {
    const priv = read(home, "persona/private.md");
    if (priv) sections.push(priv);
  }

  const directives = read(home, "directives.md");
  if (directives) sections.push(`## Rules\n\n${directives}`);

  const notes = cp.memory.includes("chat") ? read(home, `chats/${chat.tgChatId}.md`) : null;
  sections.push(
    (isOwnerDm
      ? `## This chat\n\nA private chat between you and ${owner.name ?? "the owner"}.${
          owner.language ? ` They speak ${owner.language}: reply in it, unless they write to you in another language.` : ""
        }`
      : `## This chat\n\nThe group "${chat.title ?? "untitled"}". Everyone in it reads what you write here, so nothing private to the owner belongs here.${
          owner.language ? ` The owner speaks ${owner.language}; reply to each person in the language they write in.` : ""
        }`) + (notes ? `\n\n### Your notes on this chat\n\n${notes}` : ""),
  );

  sections.push(...capabilitySections(capabilities, { home, chat, owner, chatPolicy: cp, ...(db ? { db } : {}) }));

  if (capabilities.some((c) => c.capability.id === "playbooks")) {
    const index = playbookIndex(home);
    if (index) sections.push(index);
  }

  if (isOwnerDm && cp.memory.includes("private")) {
    const mem = read(home, "memory/private.md");
    if (mem) sections.push(`## Memory\n\n${mem}`);
  }

  return sections.join("\n\n");
}
