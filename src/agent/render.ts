import type { Prompt, PromptPart, ToolContent } from "agent-runtime";
import type { ApprovalPayload, ChatEvent, ExternalPayload, JobDonePayload, MessagePayload, ScheduledPayload } from "../store/events.ts";

/**
 * How chat events read to the model. One line per message, led by its `#seq` (the handle `react` takes),
 * the time, and who said it, so the model reads the chat roughly the way a person scrolls it:
 *
 *   [#12 · Wed 11/11 21:03 · Alice] long day today
 *     ↳ replying to Alice: "that bug from yesterday..."
 *
 * The time matters more than it looks: a reply hours later is a different conversation from one a few
 * seconds later, and without it the model cannot tell. The stamp carries the weekday (`Thu 11/12 00:36`),
 * and since models rarely compare stamps on their own, a turn that opens after a gap, or a fresh
 * conversation, starts with a line saying what time it is now and how long it has been (`timeNote`).
 *
 * What a message SHOWS (a photo, a sticker: `perceive`, from the capabilities) follows its line as image
 * parts, so a picture is always read right after the line that says who sent it and when. With no image
 * anywhere the result is the plain string it always was.
 *
 * Events the FRAMEWORK perceived are shown the same way, but never as someone speaking: where a message
 * has the sender's name they have what they are (docs/design.md §6, "system events never pose as the user"):
 *
 *   [#41 · Wed 11/11 18:30 · ⚙ schedule 3] check whether the deploy finished
 *   [#42 · Wed 11/11 18:31 · ⚙ job 7 · workstream · done] asked: "is the widgetry PR merged?"
 *     Yes, merged an hour ago as #212.
 *   [#43 · Wed 11/11 18:32 · ⚙ inbound: grafana]
 *     disk 91% on vm-3
 *   [#44 · Wed 11/11 18:33 · ⚙ approval] Approval #5 (deploy) "Deploy to prod?": the owner answered "Yes" (yes).
 *
 * The assistant's own earlier messages read `[#13 · Wed 11/11 21:04 · ⚙ you] …`.
 *
 * In a GROUP, where many people speak, the owner's lines say so (`RenderOptions.owner`), with the same
 * unforgeable mark: `[#14 · Wed 11/11 21:05 · Ownerly · ⚙ owner] …`. Someone who names themselves
 * "Ownerly · owner" reads as exactly that, a name. In the owner's DM nothing is marked: everyone there is.
 * Another bot's lines are marked the same way: `[#15 · Wed 11/11 21:06 · Helper · ⚙ bot] …`.
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

export interface RenderOptions {
  /** Mark this user's lines as the owner's (in a group). */
  owner?: number;
}
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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The wall-clock fields of `iso` in `timeZone`. Weekday and month names come from fixed English tables,
 * not from Intl, so they read the same whatever the runtime's locale data (`Sept` vs `Sep`).
 */
function zoned(iso: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const [year, month, day] = [Number(get("year")), Number(get("month")), Number(get("day"))];
  return {
    year,
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    weekday: WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]!,
    monthName: MONTHS[month - 1]!,
  };
}

/** An event's stamp, in the owner's zone: `Thu 11/12 00:36` (weekday, then month/day as before). */
export function formatTime(iso: string, timeZone: string): string {
  const z = zoned(iso, timeZone);
  return `${z.weekday} ${z.month}/${z.day} ${z.hour}:${z.minute}`;
}

/** The current time in full, for the line a turn opens with: `Thu 13 Nov 2026 09:12 (Asia/Taipei)`. */
export function formatNow(iso: string, timeZone: string): string {
  const z = zoned(iso, timeZone);
  return `${z.weekday} ${Number(z.day)} ${z.monthName} ${z.year} ${z.hour}:${z.minute} (${timeZone})`;
}

/** How long `ms` is, the way a person says it: `less than a minute`, `5 minutes`, `3 hours`, `2 days` (rounded down). */
export function humanDuration(ms: number): string {
  const unit = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return unit(hours, "hour");
  return unit(Math.floor(hours / 24), "day");
}

/**
 * The line a turn's input opens with after a gap, or in a fresh conversation (agent/turn.ts
 * `GAP_NOTE_MINUTES`): the time now (the turn's start), and how long since the chat's previous event,
 * `lastAt` (none: this is the chat's first). It goes in the INPUT, never the system prompt, which must stay
 * the same from turn to turn for the prompt cache.
 */
export function timeNote(nowIso: string, lastAt: string | undefined, timeZone: string): string {
  const since = lastAt === undefined ? "This is the first message here." : `The last message here was ${humanDuration(Date.parse(nowIso) - Date.parse(lastAt))} ago.`;
  return `(It is now ${formatNow(nowIso, timeZone)}. ${since})`;
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

export function renderMessage(e: ChatEvent, timeZone: string, opts: RenderOptions = {}): string {
  const framework = renderFrameworkEvent(e, timeZone);
  if (framework !== null) return framework;
  if (e.kind === "bot_message") {
    // Something the assistant itself said earlier (only shown when a fresh conversation is opened).
    return `[#${e.seq} · ${formatTime(e.at, timeZone)} · ${FRAMEWORK_MARK} you] ${inline(plain((e.payload as { text: string }).text))}`;
  }
  const p = e.payload as unknown as MessagePayload;
  const owner = opts.owner !== undefined && p.from.id === opts.owner ? ` · ${FRAMEWORK_MARK} owner` : "";
  const bot = p.from.isBot ? ` · ${FRAMEWORK_MARK} bot` : "";
  const head = `[#${e.seq} · ${formatTime(e.at, timeZone)} · ${plainName(p.from.name)}${owner}${bot}]`;
  const lines = [`${head} ${p.forwardedFrom ? `(forwarded from ${plainName(p.forwardedFrom)}) ` : ""}${inline(plain(p.text))}`];
  if (p.replyTo) {
    const who = p.replyTo.fromName ? `${plainName(p.replyTo.fromName)}: ` : "";
    const quoted = p.replyTo.text ? `"${plain(p.replyTo.text).replace(/[\r\n]+/g, " ")}"` : "a message";
    lines.push(`  ↳ replying to ${who}${quoted}`);
  }
  return lines.join("\n");
}

/** Each event's line, then what it shows. */
function eventParts(events: ChatEvent[], timeZone: string, perceive: Perceive, opts: RenderOptions = {}): PromptPart[] {
  return events.flatMap((e) => [{ type: "text" as const, text: renderMessage(e, timeZone, opts) }, ...perceive(e)]);
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

/**
 * A group turn's note on what it does not show: the unread messages older than the ones it opens with
 * (agent/turn.ts `GROUP_CONTEXT`).
 */
export function unreadNote(n: number): string {
  return `(${n} earlier message${n === 1 ? "" : "s"} since your last turn ${n === 1 ? "is" : "are"} not shown here; read_chat reaches ${n === 1 ? "it" : "them"}.)`;
}

const note = (unread: number | undefined): PromptPart[] => (unread ? [text(unreadNote(unread))] : []);

/** What a turn's input opens with: the time line, and in a group `unread` and `context` (see `InputOptions`). */
export interface InputOptions extends RenderOptions {
  /** The "It is now…" line (`timeNote`), first of all, when the turn opens after a gap or a fresh start. */
  timeNote?: string;
  /** The input repeats a turn a restart cut off, in the same conversation: `RETRY_NOTE` before it. */
  retry?: boolean;
  /** How many older unread messages are not shown. */
  unread?: number;
  /** How many of the first events are context from before she was called (they carry no authority). */
  context?: number;
  /** In a group: the events that called her (by seq), named in a heading before the first of them. */
  called?: number[];
}

export const CONTEXT_HEADING = "(Earlier, before you were called; context only:)";
/**
 * Before the input of a turn that answers again what a turn cut off by a restart was answering (a draining
 * server's deadline, server/drain.ts), in the same conversation: the model has already seen these messages,
 * and may have said part of its answer. A framework line, like the time line: no message can produce it.
 */
export const RETRY_NOTE =
  "(Your previous turn on the messages below was cut off by a restart before it finished. They are shown again so you can finish answering them: what you already sent was delivered, or will be, so do not repeat it.)";
export const CALLED_PREFIX = "(You were called by";
/** The heading before the messages that called her: which ones did (the owner's carry `⚙ owner`). */
export function calledHeading(seqs: number[]): string {
  return `${CALLED_PREFIX} ${seqs.map((s) => `#${s}`).join(", ")}. From here on is what you answer:)`;
}

function inputParts(events: ChatEvent[], timeZone: string, perceive: Perceive, opts: InputOptions): PromptPart[] {
  const n = opts.context ?? 0;
  if (!opts.called?.length) return [...note(opts.unread), ...eventParts(events, timeZone, perceive, opts)];
  return [
    ...note(opts.unread),
    ...(n ? [text(CONTEXT_HEADING), ...eventParts(events.slice(0, n), timeZone, perceive, opts)] : []),
    text(calledHeading(opts.called)),
    ...eventParts(events.slice(n), timeZone, perceive, opts),
  ];
}

/**
 * The prompt a turn opens with: the messages it is answering. In a group, after a note on unread ones and
 * under its own heading, the earlier messages shown as context (agent/turn.ts `GROUP_CONTEXT`).
 */
export function renderTurnInput(events: ChatEvent[], timeZone: string, perceive: Perceive = blind, opts: InputOptions = {}): Prompt {
  return joinParts([...timeLine(opts), ...inputParts(events, timeZone, perceive, opts)]);
}

const timeLine = (opts: InputOptions): PromptPart[] => [...(opts.timeNote ? [text(opts.timeNote)] : []), ...(opts.retry ? [text(RETRY_NOTE)] : [])];

/** The opening of a fresh conversation: the recent exchange for context, then what to answer now. */
export function renderWithHistory(history: ChatEvent[], input: ChatEvent[], timeZone: string, perceive: Perceive = blind, opts: InputOptions = {}): Prompt {
  return joinParts([
    ...timeLine(opts),
    text(`(A new conversation. The last ${history.length} messages of this chat, for context:)`),
    ...eventParts(history, timeZone, perceive, opts),
    text("\n(New messages:)"),
    ...inputParts(input, timeZone, perceive, opts),
  ]);
}

/** What a running turn is told at its next tool call, when messages arrived while it worked. */
export function renderMidTurn(events: ChatEvent[], timeZone: string, perceive: Perceive = blind, opts: RenderOptions = {}): Prompt {
  return joinParts([text("(New messages arrived while you were working:)"), ...eventParts(events, timeZone, perceive, opts)]);
}
