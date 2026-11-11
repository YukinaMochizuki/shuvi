import type { ChatEvent, MessagePayload } from "../store/events.ts";

/**
 * How chat events read to the model. One line per message, led by its `#seq` (the handle `react` takes),
 * the time, and who said it, so the model reads the chat roughly the way a person scrolls it:
 *
 *   [#12 · 11/11 21:03 · Alice] long day today
 *     ↳ replying to Alice: "that bug from yesterday..."
 *
 * The time matters more than it looks: a reply hours later is a different conversation from one a few
 * seconds later, and without it the model cannot tell.
 */

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

/** The prompt a turn opens with: the messages it is answering. */
export function renderTurnInput(events: ChatEvent[], timeZone: string): string {
  return events.map((e) => renderMessage(e, timeZone)).join("\n");
}

/** The opening of a fresh conversation: the recent exchange for context, then what to answer now. */
export function renderWithHistory(history: ChatEvent[], input: ChatEvent[], timeZone: string): string {
  return `(A new conversation. The last ${history.length} messages of this chat, for context:)\n${renderTurnInput(history, timeZone)}\n\n(New messages:)\n${renderTurnInput(input, timeZone)}`;
}

/** What a running turn is told at its next tool call, when messages arrived while it worked. */
export function renderMidTurn(events: ChatEvent[], timeZone: string): string {
  return `(New messages arrived while you were working:)\n${renderTurnInput(events, timeZone)}`;
}
