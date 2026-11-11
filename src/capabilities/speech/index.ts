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

You're on Telegram, and the other person sees only the messages you send. Your thinking never reaches them.

Whatever text you write is the message: each stretch of it goes out as one message when you call your next tool or when your turn ends. To tell them something partway through some work, like where things stand so far, use \`say\`. Your final answer you just write.

When nothing needs saying, call \`pass\`, with a reaction if you like; anything you write after it is not sent. A reaction alone is a reply too. To react to a particular message, use \`react\` with the #number shown before it.

Write the way a person chats on Telegram, not like a document. No headings or tables, a list only when the thing really is a list, and no blank lines for spacing. A line break is a real line break, never a literal \`\\n\`. Light markdown (bold, inline code, links) is fine and gets converted for Telegram; don't write HTML.

If they send more while you're working, it shows up after a tool result; take it in as it comes.`;

const emojiList = REACTION_EMOJI.join(" ");

export const speech = defineCapability<true>({
  id: "speech",
  label: "talking",
  gives: "say, react and pass: how anything she writes reaches the chat. Always on.",
  enable: () => true,
  always: true,
  tools({ db, state: s }) {
    const say: ToolDef<{ text: string }> = {
      name: "say",
      description: "Send a message partway through your work (progress, an early conclusion). Not for your final answer: write that as text.",
      inputSchema: { text: z.string().min(1).describe("The message to send, written the way you'd chat") },
      async handler({ text }) {
        queueMessage(db, s, text);
        return ok("Sent.");
      },
    };
    const react: ToolDef<{ seq: number; emoji: string }> = {
      name: "react",
      description: `React to someone's message (not one of yours). seq is the #number shown before it. Allowed emoji: ${emojiList}`,
      inputSchema: { seq: z.number().int().describe("The message's #number"), emoji: z.string().describe("One emoji") },
      async handler({ seq, emoji }) {
        const e = normalizeReaction(emoji);
        if (!e) return err(`Telegram does not accept "${emoji}" as a reaction. Allowed: ${emojiList}`);
        const target = getEvent(db, seq);
        if (!target || target.chatId !== s.chat.id || (target.kind !== "message" && target.kind !== "bot_message")) {
          return err(`#${seq} is not a message in this chat.`);
        }
        if (target.kind === "bot_message") return err(`#${seq} is your own message; you can react only to other people's.`);
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
