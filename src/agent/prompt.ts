import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Chat } from "../store/events.ts";

/**
 * The system prompt, assembled from `home/` in the order docs/design.md §6 fixes: the most stable layers
 * first, so the provider's prompt cache keeps as long a prefix as possible.
 *
 *   1. persona      persona/public.md (every chat), persona/private.md (the owner's DM only)
 *   2. directives   directives.md
 *   3. this chat    who is here
 *   4. capabilities how speaking works in this framework, then each enabled capability group (web)
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

/** How the assistant's output becomes Telegram messages. Framework knowledge, not persona. */
export const SPEAKING = `## How you speak here

You are on Telegram. The other person sees only the messages you send:

- **Your ordinary text is the message.** Each stretch of text is sent as one message when you call your next tool or when your turn ends. Your thinking is never sent; they cannot see it.
- **To tell them something partway through work** ("halfway there, here is the gist so far"), use \`say\`. Do not use \`say\` for your final answer; just write it.
- **When no reply is needed**, call \`pass\`, optionally with a reaction. Nothing you write after it is sent. A reaction alone is a reply too.
- **To react** to a message, use \`react\` with the #number shown before it.
- Format with markdown (bold, lists, code blocks, links); the framework converts it for Telegram. Do not write HTML.
- Messages they send while you work are appended after a tool result; take them in as they come.`;

/** The web capability group: when to reach for the web tools. */
export const WEB = `## Looking things up

You can reach the web. Use \`web_search\` to find pages, and \`web_fetch\` to read one you have a URL for (it returns the raw response, so it works best on text, JSON and simple pages). Look things up rather than guess whenever a question depends on recent events, prices or facts you are unsure of, and say where an answer came from when it matters. A lookup that takes several steps is worth a short \`say\` first.`;

export interface Capabilities {
  web?: boolean;
}

export function buildSystemPrompt(home: string, chat: Chat, owner: { name?: string; language?: string }, caps: Capabilities = {}): string {
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

  sections.push(SPEAKING);
  if (caps.web) sections.push(WEB);

  if (isOwnerDm) {
    const mem = read(home, "memory/private.md");
    if (mem) sections.push(`## Memory\n\n${mem}`);
  }

  return sections.join("\n\n");
}
