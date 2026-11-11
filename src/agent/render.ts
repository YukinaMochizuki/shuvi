import type { Prompt, PromptPart, ToolContent } from "agent-runtime";
import type { ApprovalPayload, ChatEvent, MessagePayload } from "../store/events.ts";

/**
 * How chat events read to the model. One line per message, led by its `#seq` (the handle `react` takes),
 * the time, and who said it, so the model reads the chat roughly the way a person scrolls it:
 *
 *   [#12 · 11/11 21:03 · Alice] long day today
 *     ↳ replying to Alice: "that bug from yesterday..."
 *
 * The time matters more than it looks: a reply hours later is a different conversation from one a few
 * seconds later, and without it the model cannot tell.
 *
 * What a message SHOWS (a photo, a sticker: `perceive`, from the capabilities) follows its line as image
 * parts, so a picture is always read right after the line that says who sent it and when. With no image
 * anywhere the result is the plain string it always was.
 */

/** The images to show after an event's line (capabilities/types.ts `capabilityPerception`). */
export type Perceive = (e: ChatEvent) => ToolContent[];
const blind: Perceive = () => [];

export function formatTime(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
}

export function renderMessage(e: ChatEvent, timeZone: string): string {
  if (e.kind === "bot_message") {
    // Something the assistant itself said earlier (only shown when a fresh conversation is opened).
    return `[#${e.seq} · ${formatTime(e.at, timeZone)} · you] ${(e.payload as { text: string }).text}`;
  }
  if (e.kind === "approval") {
    // Not something said in the chat: the owner's answer to a card in the control bot, asked for from here.
    const a = e.payload as unknown as ApprovalPayload;
    const outcome = a.answer ? `the owner answered "${a.label ?? a.answer}" (${a.answer})` : "it expired without an answer";
    return `[#${e.seq} · ${formatTime(e.at, timeZone)} · system] Approval #${a.approvalId} (${a.kind}) "${a.title}": ${outcome}.`;
  }
  const p = e.payload as unknown as MessagePayload;
  const head = `[#${e.seq} · ${formatTime(e.at, timeZone)} · ${p.from.name}]`;
  const lines = [`${head} ${p.forwardedFrom ? `(forwarded from ${p.forwardedFrom}) ` : ""}${p.text}`];
  if (p.replyTo) {
    const who = p.replyTo.fromName ? `${p.replyTo.fromName}: ` : "";
    const quoted = p.replyTo.text ? `"${p.replyTo.text}"` : "a message";
    lines.push(`  ↳ replying to ${who}${quoted}`);
  }
  return lines.join("\n");
}

/** Each event's line, then what it shows. */
function eventParts(events: ChatEvent[], timeZone: string, perceive: Perceive): PromptPart[] {
  return events.flatMap((e) => [{ type: "text" as const, text: renderMessage(e, timeZone) }, ...perceive(e)]);
}

/** Adjacent text parts joined by newlines; a prompt with no image is a plain string. */
export function joinParts(parts: PromptPart[]): Prompt {
  const out: PromptPart[] = [];
  for (const p of parts) {
    const prev = out.at(-1);
    if (p.type === "text" && prev?.type === "text") out[out.length - 1] = { type: "text", text: `${prev.text}\n${p.text}` };
    else out.push(p);
  }
  if (out.every((p) => p.type === "text")) return out.map((p) => (p as { text: string }).text).join("\n");
  return out;
}

const text = (t: string): PromptPart => ({ type: "text", text: t });

/** The prompt a turn opens with: the messages it is answering. */
export function renderTurnInput(events: ChatEvent[], timeZone: string, perceive: Perceive = blind): Prompt {
  return joinParts(eventParts(events, timeZone, perceive));
}

/** The opening of a fresh conversation: the recent exchange for context, then what to answer now. */
export function renderWithHistory(history: ChatEvent[], input: ChatEvent[], timeZone: string, perceive: Perceive = blind): Prompt {
  return joinParts([
    text(`(A new conversation. The last ${history.length} messages of this chat, for context:)`),
    ...eventParts(history, timeZone, perceive),
    text("\n(New messages:)"),
    ...eventParts(input, timeZone, perceive),
  ]);
}

/** What a running turn is told at its next tool call, when messages arrived while it worked. */
export function renderMidTurn(events: ChatEvent[], timeZone: string, perceive: Perceive = blind): Prompt {
  return joinParts([text("(New messages arrived while you were working:)"), ...eventParts(events, timeZone, perceive)]);
}
