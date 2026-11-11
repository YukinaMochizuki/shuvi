import { z } from "zod";
import { err, ok, type ToolDef } from "agent-runtime";
import { formatTime } from "../../agent/render.ts";
import type { Chat } from "../../store/events.ts";
import { chatLabel, isOwnerDm, ownerIdFrom, visibleChats } from "../access.ts";
import { defineCapability, type TurnContext } from "../types.ts";
import { parseBound, readChat, renderHit, renderPage, searchChats, type Anchor } from "./logs.ts";

/**
 * Retrieval: `search_chats` and `read_chat` over `chat_events`, the complete record of what was said
 * (docs/design.md §9). There are no summaries to search instead: what only needs to be findable is found
 * here. The search and paging are in ./logs.ts.
 *
 * Visibility is enforced in the tools, not asked of the model (../access.ts): from the owner's DM every
 * chat; from any other chat only itself. Asking for a chat out of reach gets the same answer whether or not
 * that chat exists.
 *
 *   SHUVI_RETRIEVAL   "off" disables this capability (default on)
 *   SHUVI_OWNER_ID    see ../access.ts
 */

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export interface RetrievalConfig {
  ownerId: number | null;
}

function section(ownerDm: boolean): string {
  return `## Looking back

What was said is all kept, and you can look it up rather than rely on what you happen to remember. \`search_chats\` finds messages by words (give several terms: synonyms, both languages, a name); each hit has its #number. \`read_chat\` then reads the conversation around a #number, or pages back through a chat. ${
    ownerDm ? "From here you can search and read every chat you are in." : "From here you can search and read only this chat."
  } When the owner refers to something from before ("that place I mentioned last month"), look it up before you answer.`;
}

export const retrieval = defineCapability<RetrievalConfig>({
  id: "retrieval",
  label: "searching chat history",
  gives: "search_chats and read_chat over what was said: every chat from the owner's DM, only itself elsewhere.",
  enable: (env) => (env.SHUVI_RETRIEVAL === "off" ? null : { ownerId: ownerIdFrom(env) }),
  tools(ctx: TurnContext, { ownerId }) {
    const { db, timeZone } = ctx;
    const visible = () => visibleChats(db, ctx.chat, ownerId);
    /** The chat a tool was pointed at, if this chat may see it. Absent: this chat. */
    const resolve = (tgChatId: number | undefined): Chat | string => {
      if (tgChatId === undefined) return ctx.chat;
      return visible().find((c) => c.tgChatId === tgChatId) ?? (isOwnerDm(ctx.chat, ownerId) ? `There is no chat ${tgChatId}.` : "From this chat you can only search and read this chat.");
    };
    const label = (chatId: number) => {
      const c = visible().find((v) => v.id === chatId);
      return c ? chatLabel(c, ownerId) : String(chatId);
    };

    const search: ToolDef<{ terms: string[]; chat?: number; sender?: string; since?: string; until?: string; limit?: number }> = {
      name: "search_chats",
      description: `Full-text search over what was said in your chats (people's messages and your own). Terms are OR-combined; each matches anywhere in a message, any case. Each hit: chat, #seq, time, sender and a snippet. When there are more hits than \`limit\` across several chats, you get the number of hits per chat instead: narrow by chat, time or terms.`,
      inputSchema: {
        terms: z.array(z.string().min(1)).min(1).describe("Words or phrases, OR-combined"),
        chat: z.number().int().optional().describe("Only this chat (its id, as hits show it). Default: every chat you may see"),
        sender: z.string().optional().describe('Only messages from this person (a name, or a Telegram user id), or "you" for your own'),
        since: z.string().optional().describe("From this date or time on, e.g. 2026-11-01 (in the owner's time zone)"),
        until: z.string().optional().describe("Up to and including this date, or before this time"),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Most hits to show (default ${DEFAULT_LIMIT})`),
      },
      async handler(a) {
        let chats: Chat[];
        if (a.chat !== undefined) {
          const c = resolve(a.chat);
          if (typeof c === "string") return err(c);
          chats = [c];
        } else chats = visible();
        const since = a.since ? parseBound(a.since, timeZone, "start") : undefined;
        const until = a.until ? parseBound(a.until, timeZone, "end") : undefined;
        if (since === null || until === null) return err("since / until must be a date (2026-11-01) or a date and time (2026-11-01T18:00).");
        const limit = a.limit ?? DEFAULT_LIMIT;
        const r = searchChats(db, { terms: a.terms, chats, limit, ...(a.sender !== undefined ? { sender: a.sender } : {}), ...(since ? { since } : {}), ...(until ? { until } : {}) });
        if (r.mode === "counts") {
          const lines = r.perChat.map((c) => `- chat ${label(c.chatId)}: ${c.hits} hits, ${formatTime(c.first, timeZone)} – ${formatTime(c.last, timeZone)}`);
          return ok(`${r.total} hits, more than ${limit}. Hits per chat:\n${lines.join("\n")}\nNarrow with chat, since / until, sender or more specific terms.`);
        }
        if (!r.hits.length) return ok("No hits.");
        const groups = new Map<number, string[]>();
        for (const e of r.hits) groups.set(e.chatId, [...(groups.get(e.chatId) ?? []), renderHit(e, a.terms, timeZone)]);
        const body = [...groups].map(([chatId, lines]) => `chat ${label(chatId)}:\n${lines.join("\n")}`).join("\n\n");
        const more = r.total > r.hits.length ? `\n\n(${r.hits.length} newest of ${r.total} hits. Narrow with since / until, or page with read_chat.)` : "";
        return ok(body + more);
      },
    };

    const read: ToolDef<{ chat?: number; around?: number; before?: number; after?: number; limit?: number }> = {
      name: "read_chat",
      description: "Read a chat's log, in order, as you see messages in a turn. Give one of around / before / after a #seq, or none for the latest messages.",
      inputSchema: {
        chat: z.number().int().optional().describe("The chat's id (as search hits show it). Default: this chat"),
        around: z.number().int().optional().describe("Messages around this #seq"),
        before: z.number().int().optional().describe("Messages before this #seq"),
        after: z.number().int().optional().describe("Messages after this #seq"),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`How many messages (default ${DEFAULT_LIMIT})`),
      },
      async handler(a) {
        const c = resolve(a.chat);
        if (typeof c === "string") return err(c);
        const given = (["around", "before", "after"] as const).filter((k) => a[k] !== undefined);
        if (given.length > 1) return err("Give at most one of around, before and after.");
        const anchor: Anchor = given.length ? ({ [given[0]!]: a[given[0]!]! } as Anchor) : null;
        const page = readChat(db, c.id, anchor, a.limit ?? DEFAULT_LIMIT);
        if (!page.events.length) return ok(`(Nothing there in chat ${chatLabel(c, ownerId)}.)`);
        const hints = [page.more.before && `earlier: before=${page.events[0]!.seq}`, page.more.after && `later: after=${page.events.at(-1)!.seq}`].filter(Boolean);
        return ok(`(chat ${chatLabel(c, ownerId)})\n${renderPage(page, timeZone)}${hints.length ? `\n(${hints.join("; ")})` : "\n(That is all of it.)"}`);
      },
    };

    return [{ serverName: "shuvi", tools: [search, read] as ToolDef[] }];
  },
  section: (ctx, { ownerId }) => section(isOwnerDm(ctx.chat, ownerId)),
});
