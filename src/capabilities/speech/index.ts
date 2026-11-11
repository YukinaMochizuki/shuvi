import { z } from "zod";
import { err, ok, type ToolDef } from "agent-runtime";
import { queueMessage, queueReaction } from "../../agent/turn.ts";
import { normalizeReaction, REACTION_EMOJI } from "../../agent/reactions.ts";
import { getEvent, lastMessage } from "../../store/events.ts";
import { defineCapability } from "../types.ts";

/**
 * Speech: `say`, `react` and `pass`, and the section that tells the model how its output becomes Telegram
 * messages. Always enabled, in every chat whatever its policy (`always`), and first in the registry, so
 * its tools come first and its section directly follows "this chat" (docs/design.md §6).
 *
 * Only the tools live here. The speech model itself (docs/design.md §4, "C'"), that reply text becomes
 * messages at each boundary, that nothing is queued after `pass`, that later tool calls are refused and
 * the idempotency keys, stays in agent/turn.ts, which owns the turn state these tools act on.
 */

/** How the assistant's output becomes Telegram messages. Framework knowledge, not persona. */
export const SPEAKING = `## How you speak here

You are on Telegram. The other person sees only the messages you send:

- **Your ordinary text is the message.** Each stretch of text is sent as one message when you call your next tool or when your turn ends. Your thinking is never sent; they cannot see it.
- **To tell them something partway through work** ("halfway there, here is the gist so far"), use \`say\`. Do not use \`say\` for your final answer; just write it.
- **When no reply is needed**, call \`pass\`, optionally with a reaction. Nothing you write after it is sent. A reaction alone is a reply too.
- **To react** to a message, use \`react\` with the #number shown before it.
- Format with markdown (bold, lists, code blocks, links); the framework converts it for Telegram. Do not write HTML.
- Messages they send while you work are appended after a tool result; take them in as they come.`;

const emojiList = REACTION_EMOJI.join(" ");

export const speech = defineCapability<true>({
  id: "speech",
  enable: () => true,
  always: true,
  tools({ db, state: s }) {
    const say: ToolDef<{ text: string }> = {
      name: "say",
      description: "Send a message partway through your work (progress, an early conclusion). Not for your final answer: write that as text.",
      inputSchema: { text: z.string().min(1).describe("The message to send, in markdown") },
      async handler({ text }) {
        queueMessage(db, s, text);
        return ok("Sent.");
      },
    };
    const react: ToolDef<{ seq: number; emoji: string }> = {
      name: "react",
      description: `React to a message. seq is the #number shown before it. Allowed emoji: ${emojiList}`,
      inputSchema: { seq: z.number().int().describe("The message's #number"), emoji: z.string().describe("One emoji") },
      async handler({ seq, emoji }) {
        const e = normalizeReaction(emoji);
        if (!e) return err(`Telegram does not accept "${emoji}" as a reaction. Allowed: ${emojiList}`);
        const target = getEvent(db, seq);
        if (!target || target.chatId !== s.chat.id || (target.kind !== "message" && target.kind !== "bot_message")) {
          return err(`#${seq} is not a message in this chat.`);
        }
        queueReaction(db, s, seq, e);
        return ok("Reacted.");
      },
    };
    const pass: ToolDef<{ reaction?: string }> = {
      name: "pass",
      description: "Do not reply; end this turn. Optionally react to the latest message. Nothing you write after this is sent.",
      inputSchema: { reaction: z.string().optional().describe("An emoji to react with (optional)") },
      async handler({ reaction }) {
        if (reaction) {
          const e = normalizeReaction(reaction);
          if (!e) return err(`Telegram does not accept "${reaction}" as a reaction. Allowed: ${emojiList}`);
          const last = lastMessage(db, s.chat.id, s.toSeq);
          if (last) queueReaction(db, s, last.seq, e);
        }
        s.passed = true;
        return ok("OK. This turn ends here; write nothing more.");
      },
    };
    return [{ serverName: "shuvi", tools: [say, react, pass] as ToolDef[] }];
  },
  section: () => SPEAKING,
});
