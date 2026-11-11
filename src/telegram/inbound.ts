import type { Message, MessageEntity, Sticker, Update } from "grammy/types";
import { defaultPolicy, listsGroup, type Policy } from "../policy/policy.ts";
import { MAIN_COMMANDS } from "../server/commands.ts";
import type { CommandPayload, MessageAttachment, MessageMedia, MessagePayload, Speaker } from "../store/events.ts";

/**
 * What an inbound Telegram update IS to shuvi, decided before anything is written. Pure, so the rules
 * are testable without a bot:
 *
 *   - `ignore`: not for us. Ignored updates are still confirmed (the offset moves past them), they are
 *     just never recorded. A private message from anyone but the owner is ignored and names its sender
 *     (`stranger`), so the server can tell the owner (server/poller.ts).
 *   - `unknown_chat`: a message in a group that policy.yaml does not list (src/policy/). Not recorded;
 *     the server asks the owner whether to add the group (server/poller.ts).
 *   - `command`: an owner command, in the DM or in a listed group (only the owner's sender id counts).
 *     Recorded, then handled by the server; it never reaches the model.
 *   - `message`: something said in the chat. Text as written; anything this slice cannot read yet (a
 *     sticker, a photo, a voice note) becomes a short placeholder, so the assistant at least knows that
 *     something was sent and what it was, rather than seeing nothing. A photo or a sticker also records
 *     its `media` (which file to show the model); the server downloads it (src/capabilities/vision/).
 */

/**
 * Groups and supergroups alike are `group` to shuvi; a message in a group listed in policy is recorded
 * whoever sent it, another bot included. Who it is FROM never decides whether it is recorded there, only
 * whether it starts a turn (agent/triggers.ts) and whether it carries the owner's authority
 * (agent/turn.ts `ownerAuthority`).
 */
export type InboundChat = { id: number; type: "private" } | { id: number; type: "group"; title: string | null };

export type Classified =
  | { kind: "ignore"; reason: string; stranger?: Speaker }
  | { kind: "unknown_chat"; chat: { id: number; type: "group"; title: string | null }; from: Speaker }
  | { kind: "command"; chat: InboundChat; tgMessageId: number; payload: CommandPayload }
  | { kind: "message"; chat: InboundChat; tgMessageId: number; payload: MessagePayload };

const COMMANDS = new Set<string>(MAIN_COMMANDS.map((c) => c.command));

function speaker(m: Message): Speaker {
  const u = m.from;
  if (!u) return { id: 0, name: "?" };
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || String(u.id);
  return { id: u.id, name, ...(u.username ? { username: u.username } : {}), ...(u.is_bot ? { isBot: true } : {}) };
}

/** Who a message names: its @mentions and its text mentions (of users without a username). */
export function mentionsOf(m: Message): { usernames: string[]; userIds: number[] } | undefined {
  const text = m.text ?? m.caption ?? "";
  const entities: MessageEntity[] = m.entities ?? m.caption_entities ?? [];
  const usernames: string[] = [];
  const userIds: number[] = [];
  for (const e of entities) {
    if (e.type === "mention") usernames.push(text.slice(e.offset + 1, e.offset + e.length).toLowerCase());
    else if (e.type === "text_mention") userIds.push(e.user.id);
  }
  return usernames.length || userIds.length ? { usernames: [...new Set(usernames)], userIds: [...new Set(userIds)] } : undefined;
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

/** The longest side, in pixels, of a photo size the model is shown: larger ones are downscaled by the model's API anyway. */
export const PHOTO_MAX_SIDE = 1568;

/**
 * The picture a message carries, if any, and which file of it to fetch:
 *   - a photo: the largest size whose longer side is at most PHOTO_MAX_SIDE (the smallest when none is);
 *   - a static (WebP) sticker: the sticker itself;
 *   - an animated (tgs) or video (webm) sticker: its thumbnail, which the model can read.
 */
export function mediaOf(m: Message): MessageMedia | undefined {
  if (m.photo?.length) {
    const sizes = [...m.photo].sort((a, b) => a.width * a.height - b.width * b.height);
    const fits = sizes.filter((s) => Math.max(s.width, s.height) <= PHOTO_MAX_SIDE);
    const pick = fits.at(-1) ?? sizes[0]!;
    const own = sizes.at(-1)!;
    if (!pick.file_id || !own.file_unique_id) return undefined;
    return { kind: "photo", fileUniqueId: own.file_unique_id, file: { fileId: pick.file_id, fileUniqueId: pick.file_unique_id }, state: "pending" };
  }
  const s = m.sticker;
  if (s?.file_id) {
    const file = stickerShownFile(s);
    return { kind: "sticker", fileUniqueId: s.file_unique_id, file, state: file ? "pending" : "none" };
  }
  return undefined;
}

/** Which file shows a sticker to the model: a static one itself, an animated or video one its thumbnail (null: none). */
export function stickerShownFile(s: Sticker): MessageMedia["file"] {
  if (!s.is_animated && !s.is_video) return { fileId: s.file_id, fileUniqueId: s.file_unique_id };
  const thumb = s.thumbnail;
  return thumb ? { fileId: thumb.file_id, fileUniqueId: thumb.file_unique_id, thumbnail: true } : null;
}

/**
 * The file a message carries, if any, for the chat's computer to keep in `~/inbox/`
 * (src/capabilities/computer/): a document, the largest size of a photo, a video, audio, a voice note, a
 * round video or a GIF. Recorded as a fact with no state: only the computer capability handles it.
 */
export function attachmentOf(m: Message): MessageAttachment | undefined {
  const pick = (kind: MessageAttachment["kind"], f: { file_id: string; file_unique_id: string; file_size?: number; file_name?: string; mime_type?: string }, fallback: string): MessageAttachment => ({
    kind,
    fileId: f.file_id,
    fileUniqueId: f.file_unique_id,
    name: f.file_name || fallback,
    ...(f.file_size ? { size: f.file_size } : {}),
    ...(f.mime_type ? { mimeType: f.mime_type } : {}),
  });
  if (m.document) return pick("document", m.document, "file");
  if (m.photo?.length) {
    const largest = [...m.photo].sort((a, b) => a.width * a.height - b.width * b.height).at(-1)!;
    return pick("photo", { ...largest, mime_type: "image/jpeg" }, "photo.jpg");
  }
  if (m.video) return pick("video", m.video, "video.mp4");
  if (m.animation) return pick("animation", m.animation, "animation.mp4");
  if (m.audio) return pick("audio", m.audio, "audio");
  if (m.voice) return pick("voice", m.voice, "voice.ogg");
  if (m.video_note) return pick("video_note", m.video_note, "round-video.mp4");
  return undefined;
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

export function classify(update: Update, ownerId: number, botUsername?: string, policy: Policy = defaultPolicy()): Classified {
  const m = update.message;
  if (!m) return { kind: "ignore", reason: "not a new message" };
  const from = speaker(m);
  let chat: InboundChat;
  if (m.chat.type === "private") {
    if (m.from?.id !== ownerId) return { kind: "ignore", reason: `private chat with a non-owner (${m.from?.id})`, stranger: from };
    chat = { id: m.chat.id, type: "private" };
  } else if (m.chat.type === "group" || m.chat.type === "supergroup") {
    const group = { id: m.chat.id, type: "group" as const, title: m.chat.title ?? null };
    if (!listsGroup(policy, m.chat.id)) return { kind: "unknown_chat", chat: group, from };
    chat = group;
  } else return { kind: "ignore", reason: `chat type ${(m.chat as { type: string }).type}` };

  const text = m.text ?? m.caption ?? "";
  const cmd = m.text?.match(/^\/(\w+)(?:@(\w+))?\s*$/);
  // A command counts only from the owner; anyone else's `/stop` in a group is just something they said.
  if (cmd && COMMANDS.has(cmd[1]!) && from.id === ownerId && (!cmd[2] || !botUsername || cmd[2].toLowerCase() === botUsername.toLowerCase())) {
    return { kind: "command", chat, tgMessageId: m.message_id, payload: { from, command: cmd[1] as CommandPayload["command"] } };
  }

  const stand = placeholder(m);
  const body = stand ? (text ? `${stand} ${text}` : stand) : text;
  if (!body) return { kind: "ignore", reason: "message with nothing to show" };
  const payload: MessagePayload = { from, text: body };
  if (stand) payload.placeholder = true;
  const media = mediaOf(m);
  if (media) payload.media = media;
  // Only the owner's files are ever copied into a computer.
  const attachment = m.from?.id === ownerId ? attachmentOf(m) : undefined;
  if (attachment) payload.attachment = attachment;
  const fwd = forwardedFrom(m);
  if (fwd) payload.forwardedFrom = fwd;
  const mentions = mentionsOf(m);
  if (mentions) payload.mentions = mentions;
  const r = m.reply_to_message;
  // In a forum group, a message in a topic carries the topic's opening message as reply_to_message: that
  // is where it was posted, not whom it answers.
  if (r && !(m.is_topic_message && r.forum_topic_created)) {
    payload.replyTo = {
      tgMessageId: r.message_id,
      ...(r.from ? { fromName: speaker(r).name, fromId: r.from.id } : {}),
      ...(r.text || r.caption ? { text: (r.text ?? r.caption ?? "").slice(0, 200) } : {}),
    };
  }
  return { kind: "message", chat, tgMessageId: m.message_id, payload };
}
