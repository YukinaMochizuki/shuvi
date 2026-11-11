import type { Prompt, PromptPart, ToolContent } from "agent-runtime";
import type { ApprovalPayload, ChatEvent, ExternalPayload, JobDonePayload, MessagePayload, ScheduledPayload } from "../store/events.ts";

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
 *
 * Events the FRAMEWORK perceived are shown the same way, but never as someone speaking: where a message
 * has the sender's name they have what they are (docs/design.md §6, "system events never pose as the user"):
 *
 *   [#41 · 11/11 18:30 · ⚙ schedule 3] check whether the deploy finished
 *   [#42 · 11/11 18:31 · ⚙ job 7 · workstream · done] asked: "is the hangar PR merged?"
 *     Yes, merged an hour ago as #212.
 *   [#43 · 11/11 18:32 · ⚙ inbound: grafana]
 *     disk 91% on vm-3
 *   [#44 · 11/11 18:33 · ⚙ approval] Approval #5 (deploy) "Deploy to prod?": the owner answered "Yes" (yes).
 *
 * The assistant's own earlier messages read `[#13 · 11/11 21:04 · ⚙ you] …`.
 *
 * No label may be FORGEABLE by what people write, since authority and trust hang on telling them apart:
 *   - the framework's labels and the assistant's (`⚙ you`) carry `FRAMEWORK_MARK` (⚙), which this module
 *     strips from everything people wrote (a display name, a message, a quoted reply, a forward's origin):
 *     someone named `inbound: grafana` or `you` reads as a person, never as `⚙ inbound: grafana` / `⚙ you`;
 *   - only the first line of an event starts at the margin: every later line of anyone's message, and
 *     every line of a framework event's body (a job's result, an inbound text, a note's later lines), is
 *     indented, so no text can start a line that looks like a new event.
 */

/** The images to show after an event's line (capabilities/types.ts `capabilityPerception`). */
export type Perceive = (e: ChatEvent) => ToolContent[];
const blind: Perceive = () => [];
/** Marks a framework event's label. Never appears in anything people wrote, as rendered here. */
export const FRAMEWORK_MARK = "⚙";

const BODY_INDENT = "  ";

/** Text people wrote, as shown: without the framework mark (and, for a name, on one line). */
function plain(s: string): string {
  return s.replaceAll(FRAMEWORK_MARK, "");
}
function plainName(s: string): string {
  return plain(s).replace(/[\r\n]+/g, " ").trim() || "?";
}

/** A body under a framework label: every line indented. */
function body(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => `${BODY_INDENT}${l}`)
    .join("\n");
}

/** Text continuing a label's line: its first line stays there, later lines are indented like a body. */
function inline(text: string): string {
  const [first, ...rest] = text.split(/\r?\n/);
  return rest.length ? `${first}\n${body(rest.join("\n"))}` : (first ?? "");
}

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

/** A framework event, or null for a kind that is someone speaking. */
function renderFrameworkEvent(e: ChatEvent, timeZone: string): string | null {
  const label = (what: string) => `[#${e.seq} · ${formatTime(e.at, timeZone)} · ${FRAMEWORK_MARK} ${what}]`;
  if (e.kind === "scheduled") {
    const p = e.payload as unknown as ScheduledPayload;
    const lateMs = Date.parse(e.at) - Date.parse(p.dueAt);
    const late = lateMs > 5 * 60_000 ? ` (was due ${formatTime(p.dueAt, timeZone)}; fired late, after downtime)` : "";
    return `${label(`schedule ${p.scheduleId}${p.cron ? `, ${p.cron}` : ""}`)} ${inline(`${p.note}${late}`)}`;
  }
  if (e.kind === "job_done") {
    const p = e.payload as unknown as JobDonePayload;
    const head = `${label(`job ${p.jobId} · ${p.kind} · ${p.state}`)} asked: "${p.title.replace(/[\r\n]+/g, " ")}"`;
    return p.result ? `${head}\n${body(p.result)}` : head;
  }
  if (e.kind === "external") {
    const p = e.payload as unknown as ExternalPayload;
    return `${label(`inbound: ${p.source}`)}\n${body(p.text)}`;
  }
  if (e.kind === "approval") {
    // The owner's answer to a card in the control bot that this chat asked for; not something said here.
    const a = e.payload as unknown as ApprovalPayload;
    const line = (s: string) => s.replace(/[\r\n]+/g, " ");
    const outcome = a.answer ? `the owner answered "${line(a.label ?? a.answer)}" (${a.answer})` : "it expired without an answer";
    return `${label("approval")} Approval #${a.approvalId} (${a.kind}) "${line(a.title)}": ${outcome}.`;
  }
  return null;
}

export function renderMessage(e: ChatEvent, timeZone: string): string {
  const framework = renderFrameworkEvent(e, timeZone);
  if (framework !== null) return framework;
  if (e.kind === "bot_message") {
    // Something the assistant itself said earlier (only shown when a fresh conversation is opened).
    return `[#${e.seq} · ${formatTime(e.at, timeZone)} · ${FRAMEWORK_MARK} you] ${inline(plain((e.payload as { text: string }).text))}`;
  }
  const p = e.payload as unknown as MessagePayload;
  const head = `[#${e.seq} · ${formatTime(e.at, timeZone)} · ${plainName(p.from.name)}]`;
  const lines = [`${head} ${p.forwardedFrom ? `(forwarded from ${plainName(p.forwardedFrom)}) ` : ""}${inline(plain(p.text))}`];
  if (p.replyTo) {
    const who = p.replyTo.fromName ? `${plainName(p.replyTo.fromName)}: ` : "";
    const quoted = p.replyTo.text ? `"${plain(p.replyTo.text).replace(/[\r\n]+/g, " ")}"` : "a message";
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
