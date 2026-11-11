import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { capabilitySections, type EnabledCapability, type OwnerInfo } from "../capabilities/types.ts";
import type { Chat } from "../store/events.ts";

/**
 * The system prompt, assembled from `home/` in the order docs/design.md §6 fixes: the most stable layers
 * first, so the provider's prompt cache keeps as long a prefix as possible.
 *
 *   1. persona      persona/public.md (every chat), persona/private.md (the owner's DM only)
 *   2. directives   directives.md
 *   3. this chat    who is here
 *   4. capabilities each enabled capability's section, in registry order (src/capabilities/index.ts):
 *                   speech (how speaking works in this framework) first, then the others (web, …)
 *   5. playbooks    (not in this slice)
 *   6. memory       memory/private.md (the owner's DM only)
 *
 * Privacy is structural: a layer a chat may not see is never read into that chat's prompt, so there is
 * nothing for a prompt instruction to have to hold back. This slice serves only the owner's DM, so every
 * layer applies; the `private` checks are here so the group slice cannot forget them.
 *
 * On Claude the system prompt is fixed when a conversation starts (a resumed conversation keeps the one it
 * began with, agent-runtime's ClaudeBackend), so an edit to home/ reaches the model at the next `/new`.
 */

function read(home: string, rel: string): string | null {
  const p = join(home, rel);
  if (!existsSync(p)) return null;
  const s = readFileSync(p, "utf8").trim();
  return s || null;
}

/**
 * `capabilities` are the ones enabled in this process, in registry order; each contributes its section.
 * Without any (a bare call), the prompt has no capability sections at all, not even speech.
 */
export function buildSystemPrompt(home: string, chat: Chat, owner: OwnerInfo, capabilities: readonly EnabledCapability[] = []): string {
  const isOwnerDm = chat.kind === "private";
  const sections: string[] = [];

  const pub = read(home, "persona/public.md");
  if (pub) sections.push(pub);
  if (isOwnerDm) {
    const priv = read(home, "persona/private.md");
    if (priv) sections.push(priv);
  }

  const directives = read(home, "directives.md");
  if (directives) sections.push(`## Rules\n\n${directives}`);

  sections.push(
    isOwnerDm
      ? `## This chat\n\nA private chat between you and ${owner.name ?? "the owner"}.${
          owner.language ? ` They speak ${owner.language}: reply in it, unless they write to you in another language.` : ""
        }`
      : `## This chat\n\nThe group "${chat.title ?? "untitled"}".`,
  );

  sections.push(...capabilitySections(capabilities, { home, chat, owner }));

  if (isOwnerDm) {
    const mem = read(home, "memory/private.md");
    if (mem) sections.push(`## Memory\n\n${mem}`);
  }

  return sections.join("\n\n");
}
