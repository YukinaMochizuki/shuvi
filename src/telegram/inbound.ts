import type { Message, Update } from "grammy/types";
import type { CommandPayload, MessagePayload, Speaker } from "../store/events.ts";

/**
 * What an inbound Telegram update IS to shuvi, decided before anything is written. Pure, so the rules
 * are testable without a bot:
 *
 *   - `ignore`: not for us. In this slice that is everything except the owner's private chat. Ignored
 *     updates are still confirmed (the offset moves past them), they are just never recorded.
 *   - `command`: an owner command. Recorded, then handled by the server; it never reaches the model.
 *   - `message`: something said in the chat. Text as written; anything this slice cannot read yet (a
 *     sticker, a photo, a voice note) becomes a short placeholder, so the assistant at least knows that
 *     something was sent and what it was, rather than seeing nothing.
 */

export type Classified =
  | { kind: "ignore"; reason: string }
  | { kind: "command"; chat: { id: number; type: "private" }; tgMessageId: number; payload: CommandPayload }
  | { kind: "message"; chat: { id: number; type: "private" }; tgMessageId: number; payload: MessagePayload };

const COMMANDS = new Set(["new", "stop"]);

function speaker(m: Message): Speaker {
  const u = m.from;
  if (!u) return { id: 0, name: "?" };
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || String(u.id);
  return { id: u.id, name };
}

/** A one-line stand-in for content without text. */
function placeholder(m: Message): string | null {
  if (m.sticker) return `[sticker${m.sticker.emoji ? `: ${m.sticker.emoji}` : ""}${m.sticker.set_name ? `, ${m.sticker.set_name}` : ""}]`;
  if (m.photo) return "[photo]";
  if (m.animation) return "[GIF]";
  if (m.video) return `[video, ${m.video.duration}s]`;
  if (m.video_note) return "[round video]";
  if (m.voice) return `[voice, ${m.voice.duration}s]`;
  if (m.audio) return `[audio: ${m.audio.title ?? m.audio.file_name ?? "untitled"}]`;
  if (m.document) return `[file: ${m.document.file_name ?? "untitled"}]`;
  if (m.location) return "[location]";
  if (m.contact) return "[contact]";
  if (m.poll) return `[poll: ${m.poll.question}]`;
  return null;
}

function forwardedFrom(m: Message): string | undefined {
  const o = m.forward_origin;
  if (!o) return undefined;
  switch (o.type) {
    case "user":
      return [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(" ");
    case "hidden_user":
      return o.sender_user_name;
    case "chat":
      return o.sender_chat.title ?? "a group";
    case "channel":
      return o.chat.title ?? "a channel";
  }
}

export function classify(update: Update, ownerId: number, botUsername?: string): Classified {
  const m = update.message;
  if (!m) return { kind: "ignore", reason: "not a new message" };
  if (m.chat.type !== "private") return { kind: "ignore", reason: `chat type ${m.chat.type} (this slice handles the owner's DM only)` };
  if (m.from?.id !== ownerId) return { kind: "ignore", reason: `private chat with a non-owner (${m.from?.id})` };
  const chat = { id: m.chat.id, type: "private" as const };
  const from = speaker(m);

  const text = m.text ?? m.caption ?? "";
  const cmd = m.text?.match(/^\/(\w+)(?:@(\w+))?\s*$/);
  if (cmd && COMMANDS.has(cmd[1]!) && (!cmd[2] || !botUsername || cmd[2] === botUsername)) {
    return { kind: "command", chat, tgMessageId: m.message_id, payload: { from, command: cmd[1] as CommandPayload["command"] } };
  }

  const stand = placeholder(m);
  const body = stand ? (text ? `${stand} ${text}` : stand) : text;
  if (!body) return { kind: "ignore", reason: "message with nothing to show" };
  const payload: MessagePayload = { from, text: body };
  if (stand) payload.placeholder = true;
  const fwd = forwardedFrom(m);
  if (fwd) payload.forwardedFrom = fwd;
  const r = m.reply_to_message;
  if (r) {
    payload.replyTo = {
      tgMessageId: r.message_id,
      ...(r.from ? { fromName: speaker(r).name } : {}),
      ...(r.text || r.caption ? { text: (r.text ?? r.caption ?? "").slice(0, 200) } : {}),
    };
  }
  return { kind: "message", chat, tgMessageId: m.message_id, payload };
}
