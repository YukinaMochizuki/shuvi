import { CALLED_PREFIX, CONTEXT_HEADING } from "../agent/render.ts";
import type { Db } from "../store/db.ts";
import type {
  ApprovalPayload,
  BotFilePayload,
  BotMessagePayload,
  BotReactionPayload,
  BotStickerPayload,
  ChatEvent,
  CommandPayload,
  ExternalPayload,
  JobDonePayload,
  MessagePayload,
  ScheduledPayload,
} from "../store/events.ts";
import { OUTBOUND_KINDS, TRIGGER_KINDS, type TranscriptPart } from "../store/schema.ts";
import { getPromptText, getTranscript, previousPrompt, stepsOf, transcriptAbsence, type PromptText, type Step, type Transcript } from "../store/transcripts.ts";
import type { Turn } from "../store/turns.ts";
import { diffLines, hunks } from "./diff.ts";
import { ago, badge, block, clock, dot, empty, excerpt, href, html, markdown, page, raw, resetBlocks, secs, short, size, tokens, usd, wall, when, type Raw } from "./html.ts";
import { conversationOf, matchingTurns, segmentList, segmentOf, type Conversation, type SegmentRow, type Span } from "./sessions.ts";
import {
  chatById,
  chatEventsPage,
  chatTurnSpans,
  eventBySeq,
  eventsBetween,
  neighbours,
  outboundOf,
  toolNames,
  turnById,
  type ConsoleChat,
  type TurnFilter,
} from "./queries.ts";

/**
 * The console's pages (DESIGN.md): one navigation, chat → conversation → segment → turn (sessions.ts). The left
 * pane lists the chats, each with its latest segments under the conversation they belong to; the right shows
 * the selected segment or conversation as one exchange, a single turn, or a chat's whole log. Read-only:
 * nothing here writes.
 */

export interface PageContext {
  db: Db;
  timeZone: string;
  /** Who is looking (the tailnet login), shown in the top bar. */
  who?: string;
  /** The owner's id: their lines in a group are marked. */
  ownerId?: number;
  now?: number;
  /** How long transcripts are kept (SHUVI_TRANSCRIPT_DAYS), to say why one is gone. */
  transcriptDays?: number;
}

export const TURNS_PER_PAGE = 50;
/** Turns shown under each chat in the grouped list; the rest are a "more" link away. */
export const PER_CHAT = 5;
/** With nothing selected, how many chat groups start open. */
export const OPEN_GROUPS = 3;
export const EVENTS_PER_PAGE = 200;
const OUTCOMES = ["done", "failed", "stopped", "running"] as const;
const FILTER_KEYS = ["chat", "outcome", "tool", "from", "to", "q"] as const;
/** `?expand=1`: every step, thinking line and section open (for printing, or reading a turn top to bottom). */
let expandAll = false;
const openAttr = () => (expandAll ? "open" : "");
type Filters = Partial<Record<(typeof FILTER_KEYS)[number], string>>;

// ---- naming things ---------------------------------------------------------------------------------------

export function chatName(c: Pick<ConsoleChat, "kind" | "title" | "tgChatId" | "person">): string {
  if (c.title) return c.title;
  return c.kind === "private" ? `DM · ${c.person ?? "owner"}` : `group ${c.tgChatId}`;
}

const PEOPLE_TONES = ["#a89bc4", "#8fb0a4", "#93a3c0", "#ead084", "#c797ff", "#d6a37b"];
function personTone(id: number): string {
  return PEOPLE_TONES[Math.abs(id) % PEOPLE_TONES.length]!;
}

/** What an event says, on one line: for a list row, a header, a divider. */
export function eventPreview(kind: string | null, payload: Record<string, unknown> | null): string {
  if (!kind || !payload) return "";
  switch (kind) {
    case "message": {
      const p = payload as unknown as MessagePayload;
      return `${p.from.name}: ${excerpt(p.text, 160)}`;
    }
    case "scheduled":
      return `schedule ${(payload as unknown as ScheduledPayload).scheduleId}: ${excerpt((payload as unknown as ScheduledPayload).note, 140)}`;
    case "job_done": {
      const p = payload as unknown as JobDonePayload;
      return `job ${p.jobId} ${p.state}: ${excerpt(p.title, 140)}`;
    }
    case "external": {
      const p = payload as unknown as ExternalPayload;
      return `inbound ${p.source}: ${excerpt(p.text, 140)}`;
    }
    case "approval":
      return `approval: ${excerpt((payload as unknown as ApprovalPayload).title, 140)}`;
    case "bot_message":
      return `shuvi: ${excerpt((payload as unknown as BotMessagePayload).text.replace(/\*\*|`/g, ""), 160)}`;
    case "bot_reaction":
      return `shuvi reacted ${(payload as unknown as BotReactionPayload).emoji}`;
    case "bot_sticker":
      return `shuvi sent a sticker`;
    case "bot_file":
      return `shuvi sent ${(payload as unknown as BotFilePayload).name}`;
    case "command":
      return `/${(payload as unknown as CommandPayload).command}`;
    default:
      return kind;
  }
}

function parsePayload(s: string | null): Record<string, unknown> | null {
  try {
    return s ? (JSON.parse(s) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A short offset from the turn's start: +0.4s, +12s, +1m05. */
function offset(ms: number): string {
  const s = Math.max(0, ms / 1000);
  if (s < 10) return `+${s.toFixed(1)}s`;
  if (s < 60) return `+${Math.round(s)}s`;
  return `+${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}`;
}

function img(ref: string): Raw {
  const u = href("/media", { ref });
  return html`<a href="${u}"><img src="${u}" alt="" loading="lazy"></a>`;
}

function pretty(json: string | null): string {
  if (!json) return "";
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

/** A tool call's arguments in a few words: `terms: hello, cat · pack: Cats`. */
function argsSummary(json: string | null): string {
  if (!json) return "";
  try {
    const v = JSON.parse(json) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return excerpt(
        Object.entries(v)
          .map(([k, x]) => `${k}: ${typeof x === "string" ? x : Array.isArray(x) && x.every((y) => typeof y !== "object") ? x.join(", ") : JSON.stringify(x)}`)
          .join(" · "),
        140,
      );
    }
    return excerpt(JSON.stringify(v), 140);
  } catch {
    return excerpt(json, 140);
  }
}

// ---- events as bubbles -----------------------------------------------------------------------------------

function deliveryStatus(e: ChatEvent): Raw {
  if (e.status === "sent") return html`<span class="status c-done">✓ delivered</span>`;
  if (e.status === "failed") return html`<span class="status c-failed">✕ failed${e.note ? `: ${excerpt(e.note, 80)}` : ""}</span>`;
  if (e.status === "pending") return html`<span class="status c-running">… pending</span>`;
  return raw("");
}

interface BubbleOpts {
  tags?: Raw[];
  context?: boolean;
  trig?: boolean;
  ownerId?: number;
}

/** An event someone (or something) sent into the chat: a left bubble. */
function incoming(e: ChatEvent, tz: string, o: BubbleOpts = {}): Raw {
  let who: Raw;
  let body: Raw;
  const cls = `bubble in${o.context ? " context" : ""}${o.trig ? " trig" : ""}`;
  const meta = html`<span>${clock(e.at, tz)}</span><span class="mono">#${e.seq}</span>${o.tags ?? []}`;
  switch (e.kind) {
    case "message": {
      const p = e.payload as unknown as MessagePayload;
      const owner = o.ownerId !== undefined && p.from.id === o.ownerId;
      who = html`<span class="name" style="color:${personTone(p.from.id)}">${p.from.name}</span>${owner ? html`<span class="tag owner">owner</span>` : ""}${p.from.isBot ? html`<span class="tag">bot</span>` : ""}`;
      const media = p.media?.state === "ready" && p.media.path ? img(p.media.path) : "";
      body = html`${p.replyTo ? html`<div class="reply">↳ ${p.replyTo.fromName ? `${p.replyTo.fromName}: ` : ""}${p.replyTo.text ?? "a message"}</div>` : ""}${
        p.forwardedFrom ? html`<div class="reply">forwarded from ${p.forwardedFrom}</div>` : ""
      }<div class="text">${p.text}</div>${media}`;
      break;
    }
    case "scheduled": {
      const p = e.payload as unknown as ScheduledPayload;
      who = html`<span class="name faint">⚙ schedule ${p.scheduleId}${p.cron ? ` · ${p.cron}` : ""}</span>`;
      body = html`<div class="text">${p.note}</div>`;
      break;
    }
    case "job_done": {
      const p = e.payload as unknown as JobDonePayload;
      who = html`<span class="name faint">⚙ job ${p.jobId} · ${p.kind} · ${p.state}</span>`;
      body = html`<div class="text">${p.title}</div>${p.result ? block("result", p.result) : ""}`;
      break;
    }
    case "external": {
      const p = e.payload as unknown as ExternalPayload;
      who = html`<span class="name faint">⚙ inbound: ${p.source}</span>`;
      body = html`<div class="text">${p.text}</div>`;
      break;
    }
    case "approval": {
      const p = e.payload as unknown as ApprovalPayload;
      who = html`<span class="name faint">⚙ approval #${p.approvalId}</span>`;
      body = html`<div class="text">${p.title}: ${p.answer ? `answered “${p.label ?? p.answer}”` : "expired unanswered"}</div>`;
      break;
    }
    case "command": {
      const p = e.payload as unknown as CommandPayload;
      return html`<p class="note">${p.from.name} sent /${p.command} <span class="mono">#${e.seq}</span></p>`;
    }
    default:
      return html`<p class="note">${e.kind} #${e.seq}</p>`;
  }
  return html`<div class="${cls}" id="e${e.seq}"><div class="who">${who}${meta}</div>${body}</div>`;
}

/** Something she sent: a right bubble (a message) or a pill (a reaction, a sticker, a file). */
function outgoing(e: ChatEvent, tz: string, opts: { via?: string; lookup?: (seq: number) => ChatEvent | undefined } = {}): Raw {
  const meta = html`${opts.via ? html`<span>via ${opts.via}</span>` : ""}<span>${clock(e.at, tz)}</span><span class="mono">#${e.seq}</span>${deliveryStatus(e)}`;
  switch (e.kind) {
    case "bot_message": {
      const p = e.payload as unknown as BotMessagePayload;
      const to = p.replyToSeq ? opts.lookup?.(p.replyToSeq) : undefined;
      const quoted = to ? eventPreview(to.kind, to.payload) : "";
      return html`<div class="bubble out" id="e${e.seq}"><div class="who">${meta}</div>${
        p.replyToSeq ? html`<div class="reply">↳ <a href="#e${p.replyToSeq}">#${p.replyToSeq}</a> ${quoted}</div>` : ""
      }<div class="text">${markdown(p.text)}</div></div>`;
    }
    case "bot_reaction": {
      const p = e.payload as unknown as BotReactionPayload;
      return html`<div class="pill" id="e${e.seq}">reacted ${p.emoji} to <a href="#e${p.targetSeq}">#${p.targetSeq}</a> <span class="meta">${deliveryStatus(e)}</span></div>`;
    }
    case "bot_sticker": {
      const p = e.payload as unknown as BotStickerPayload;
      return html`<div class="pill" id="e${e.seq}">sticker ${p.emoji ?? ""} <span class="mono">${p.stickerId}</span> <span class="meta">${deliveryStatus(e)}</span></div>`;
    }
    case "bot_file": {
      const p = e.payload as unknown as BotFilePayload;
      return html`<div class="pill" id="e${e.seq}">${p.as === "photo" ? "photo" : "file"} <span class="mono">${p.name}</span>${p.caption ? ` · ${excerpt(p.caption, 60)}` : ""} <span class="meta">${deliveryStatus(e)}</span></div>`;
    }
    default:
      return html`<p class="note">${e.kind} #${e.seq}</p>`;
  }
}

// ---- the turn list ---------------------------------------------------------------------------------------

function currentFilters(q: URLSearchParams): Filters {
  const out: Filters = {};
  for (const k of FILTER_KEYS) {
    const v = q.get(k)?.trim();
    if (v) out[k] = v;
  }
  return out;
}

function toFilter(f: Filters, q: URLSearchParams, timeZone: string): TurnFilter {
  const date = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined);
  const before = q.get("before");
  return {
    timeZone,
    ...(f.chat && /^\d+$/.test(f.chat) ? { chat: Number(f.chat) } : {}),
    ...(f.outcome && (OUTCOMES as readonly string[]).includes(f.outcome) ? { outcome: f.outcome } : {}),
    ...(f.tool ? { tool: f.tool } : {}),
    ...(date(f.from) ? { from: date(f.from)! } : {}),
    ...(date(f.to) ? { to: date(f.to)! } : {}),
    ...(f.q ? { q: f.q } : {}),
    ...(before && /^\d+$/.test(before) ? { before: Number(before) } : {}),
  };
}

/** What is selected: a turn, a segment, a conversation, or a chat (its full log), shown on the right. */
interface Selection {
  turn?: Turn;
  segment?: number;
  conversation?: number;
  /** The chat's whole log is shown (its header is marked). */
  chat?: number;
  /** The chat the selection is in (its group is open). */
  inChat?: number;
}

/** A conversation's label: how it began (recorded, or inferred for turns from before that was recorded). */
export function conversationLabel(c: Conversation, form: "short" | "long" = "long"): string {
  const base =
    c.start === "first"
      ? form === "short" ? "first conversation" : "The chat's first conversation"
      : c.start === "new"
        ? form === "short" ? "after /new" : "A fresh conversation, after /new"
        : c.start === "changed"
          ? form === "short" ? "backend settings changed" : "A fresh conversation after backend settings changed"
          : c.start === "lost"
            ? form === "short" ? "restarted (lost)" : "Restarted: the previous conversation was lost"
            : form === "short" ? "conversation" : "A new conversation";
  if (!c.inferred) return base;
  return form === "short" ? `${base} · inferred` : `${base} (inferred: these turns ran before conversations were recorded)`;
}

/** A label that opens a sentence, put inside one. */
const inSentence = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);

/** What started a segment, as its row says it under the chat: the words, and in a group who said them. */
function rowPreview(kind: string | null, payload: string | null, chatKind: string): string {
  const p = parsePayload(payload);
  if (kind !== "message" || !p) return eventPreview(kind, p);
  const m = p as unknown as MessagePayload;
  const text = excerpt(m.text.replace(/^\s*@\w+[\s,:]*/, ""), 160) || m.text;
  return chatKind === "private" ? text : `${m.from.name}: ${text}`;
}

/** The worst outcome among a segment's turns: what its dot shows. */
function worst(s: { failed: number; running: number; stopped: number }): string {
  return s.failed ? "failed" : s.running ? "running" : s.stopped ? "stopped" : "done";
}

/** A span of time, shortly: 40s, 3 min, 1h 05m, 2d 3h. */
function span(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

/** One segment in the list: the exchange it was, when, how long, and what it cost. */
function segmentRow(s: SegmentRow, f: Filters, on: { id?: number; auto: boolean }, filtered: boolean, ctx: PageContext, now: number): Raw {
  const meta = [
    clock(s.startedAt, ctx.timeZone),
    span(Date.parse(s.endedAt) - Date.parse(s.startedAt)),
    `${s.turns} turn${s.turns === 1 ? "" : "s"}`,
    ...(s.toolCalls ? [`${s.toolCalls} tool${s.toolCalls === 1 ? "" : "s"}`] : []),
    ...(s.refused ? [`${s.refused} refused`] : []),
    ...(s.failedCalls ? [`${s.failedCalls} tool error${s.failedCalls === 1 ? "" : "s"}`] : []),
    ...(s.costMicroUsd ? [usd(s.costMicroUsd / 1e6)] : []),
  ];
  const bad = s.failed > 0;
  return html`<a class="row${s.id === on.id ? ` on${on.auto ? " auto" : ""}` : ""}${bad ? " bad" : ""}" href="${href(`/segments/${s.id}`, f)}">
<div class="l1">${dot(worst(s))}<span class="what">${rowPreview(s.triggerKind, s.triggerPayload, s.chatKind) || "—"}</span><span class="when" title="${s.startedAt}">${ago(s.startedAt, now)}</span></div>
<div class="l3 num">${meta.join(" · ")}${s.compactions ? html` · <span class="c-lost">compacted</span>` : ""}${s.failed ? html` · <span class="c-failed">${s.failed} failed</span>` : ""}${
    filtered && s.matching < s.turns ? html` · <span class="c-accent">${s.matching} of ${s.turns} match</span>` : ""
  }</div>
</a>`;
}

/**
 * The left pane: the filters, then each chat (most recently active first), its latest PER_CHAT segments
 * newest first, under the header of the conversation each belongs to ("n more" opens the chat's own list,
 * paged). The chat holding the selection is open; with nothing selected, the first OPEN_GROUPS are.
 */
function listPane(ctx: PageContext, q: URLSearchParams, sel: Selection): { pane: Raw; first?: number } {
  const f = currentFilters(q);
  const filter = toFilter(f, q, ctx.timeZone);
  const filtered = Object.keys(f).some((k) => k !== "chat");
  const now = ctx.now ?? Date.now();
  const single = filter.chat !== undefined;
  const tree = segmentList(ctx.db, filter, single ? TURNS_PER_PAGE : PER_CHAT);
  const selChat = sel.inChat ?? sel.chat ?? sel.turn?.chatId;
  // The segment to mark: the one selected, or the one holding the selected turn or conversation's start.
  const selSegment = sel.segment ?? (sel.turn ? segmentOf(ctx.db, sel.turn.chatId, sel.turn.id)?.id : undefined);
  // A selected segment older than its chat's latest few is shown in its place, so the list says where you are.
  if (selSegment !== undefined && selChat !== undefined) {
    const g = tree.groups.find((x) => x.chat.id === selChat);
    if (g && !g.segments.some((s) => s.id === selSegment)) {
      const one = segmentList(ctx.db, { ...filter, chat: selChat, before: selSegment + 1 }, 1);
      const row = one.groups[0]?.segments[0];
      if (row && row.id === selSegment) {
        g.segments = [...g.segments, row].sort((a, b) => b.id - a.id);
        for (const [k, v] of one.conversations) tree.conversations.set(k, v);
      }
    }
  }
  const first = tree.groups.find((g) => g.segments.length)?.segments[0]?.id;
  const on = { ...(selSegment !== undefined ? { id: selSegment } : sel.chat === undefined && sel.conversation === undefined && first !== undefined ? { id: first } : {}), auto: selSegment === undefined };

  const tools = toolNames(ctx.db);
  const seg = (o: string | undefined, label: string) => html`<a class="${f.outcome === o ? "on" : ""}" href="${href("/turns", { ...f, outcome: o })}">${label}</a>`;
  const moreOpen = !!(f.tool || f.from || f.to);
  const filters = html`<form class="filters" method="get" action="/turns">
<input type="search" name="q" value="${f.q ?? ""}" placeholder="Search text, arguments, results, errors">
${f.outcome ? html`<input type="hidden" name="outcome" value="${f.outcome}">` : ""}${f.chat ? html`<input type="hidden" name="chat" value="${f.chat}">` : ""}
<div class="seg">${seg(undefined, "all")}${OUTCOMES.map((o) => seg(o, o))}</div>
<details ${moreOpen ? "open" : ""}><summary>more filters</summary><div class="more">
<label class="wide">uses tool<select name="tool"><option value="">any tool</option>${tools.map((t) => html`<option value="${t}" ${f.tool === t ? "selected" : ""}>${t}</option>`)}</select></label>
<label>from<input type="date" name="from" value="${f.from ?? ""}"></label>
<label>to<input type="date" name="to" value="${f.to ?? ""}"></label>
</div></details>
<div class="actions"><button type="submit">Apply</button>${Object.keys(f).length ? html`<a href="/turns" class="small">clear</a>` : ""}</div>
</form>`;

  const groups = tree.groups.map((g, i) => {
    const c = g.chat;
    const open = single || c.id === selChat || (selChat === undefined && i < OPEN_GROUPS);
    const hidden = c.segments - g.segments.length;
    const head = html`<summary class="ghead${sel.chat === c.id ? " on" : ""}"><span class="gl1"><a class="gname" href="${href(`/chats/${c.id}`, f)}" title="the chat's whole log">${chatName(c)}</a><span class="gwhen">${ago(c.lastEventAt, now)}</span></span>
<span class="gmeta">${c.kind === "group" ? "group" : "direct"} · ${c.turns} turn${c.turns === 1 ? "" : "s"}${c.failed ? html` · <span class="c-failed">${c.failed} failed</span>` : ""}</span></summary>`;
    // Segments newest first, each conversation's header above its first (newest) segment shown.
    const rows: Raw[] = [];
    let conv: number | null = null;
    for (const s of g.segments) {
      if (s.conversationId !== conv) {
        conv = s.conversationId;
        const cv = tree.conversations.get(conv);
        if (cv) {
          rows.push(html`<a class="conv${sel.conversation === cv.id ? " on" : ""}" href="${href(`/conversations/${cv.id}`, f)}" title="${conversationLabel(cv)}"><span class="cl">${conversationLabel(cv, "short")}</span><span class="cm">${when(cv.startedAt, ctx.timeZone)} · ${cv.turns} turn${cv.turns === 1 ? "" : "s"}${
            cv.compactions ? html` · <span class="c-lost">${cv.compactions} compaction${cv.compactions === 1 ? "" : "s"}</span>` : ""
          }</span></a>`);
        }
      }
      rows.push(segmentRow(s, f, on, filtered, ctx, now));
    }
    const body = g.segments.length ? html`<div class="rows">${rows}</div>` : html`<p class="none">No turns yet.</p>`;
    const more = single
      ? g.segments.length >= TURNS_PER_PAGE
        ? html`<a class="more-link" href="${href("/turns", { ...f, before: g.segments.at(-1)!.id })}">Older segments</a>`
        : ""
      : hidden > 0
        ? html`<a class="more-link" href="${href("/turns", { ...f, chat: c.id })}">${hidden} more in this chat</a>`
        : "";
    return html`<details class="group${c.failed ? " has-failed" : ""}" ${open ? "open" : ""}>${head}${body}${more}</details>`;
  });
  const n = tree.segments;
  const count = html`<div class="count">${single ? html`<a href="${href("/turns", { ...f, chat: undefined })}">← all chats</a> · ` : ""}${n} segment${n === 1 ? "" : "s"}, ${tree.turns} turn${tree.turns === 1 ? "" : "s"}${single ? "" : ` in ${tree.groups.length} chat${tree.groups.length === 1 ? "" : "s"}, by last activity`}</div>`;
  const list = tree.groups.length ? html`${groups}` : empty("No turn matches that.");
  return { pane: html`${filters}${count}<nav class="tree">${list}</nav>`, ...(first !== undefined ? { first } : {}) };
}

// ---- one turn: the conversation ---------------------------------------------------------------------------

/** What the opening prompt says about itself: a fresh conversation's history, unread lines, who called her. */
function inputShape(t: Transcript | undefined): { history?: number; unread?: number; called?: number[]; hasContext: boolean } {
  const text = (t?.input ?? [])
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n");
  const history = /^\(A new conversation\. The last (\d+) messages/m.exec(text);
  const unread = /^\((\d+) earlier messages? since your last turn/m.exec(text);
  const calledLine = text.split("\n").find((l) => l.startsWith(CALLED_PREFIX));
  const called = calledLine ? [...calledLine.matchAll(/#(\d+)/g)].map((m) => Number(m[1])) : undefined;
  return { ...(history ? { history: Number(history[1]) } : {}), ...(unread ? { unread: Number(unread[1]) } : {}), ...(called ? { called } : {}), hasContext: text.includes(CONTEXT_HEADING) };
}

function tr(at: string, body: Value2): Raw {
  return html`<div class="tr"><div class="at">${at}</div><div class="body">${body}</div></div>`;
}
type Value2 = Raw | string | readonly Raw[];

/** Durations below this are not worth a number in a chip. */
const QUIET_MS = 50;

function toolChip(s: Step, shownBelow = false): Raw {
  const status = s.status ?? "running";
  const ms = s.endedAt ? Date.parse(s.endedAt) - Date.parse(s.at) : 0;
  const d = ms >= QUIET_MS ? secs(ms / 1000) : "";
  const word = status === "ok" ? "" : status === "running" ? "no result" : status;
  const outcome =
    status === "refused"
      ? block(html`<span class="c-refused">refused</span>`, s.error ?? "", { prose: true, unfold: expandAll })
      : status === "threw"
        ? block(html`<span class="c-failed">threw</span>`, s.error ?? "", { unfold: expandAll })
        : status === "running"
          ? html`<p class="meta">No result recorded: still running, or the turn ended during the call.</p>`
          : block(html`<span class="${status === "error" ? "c-failed" : ""}">result${status === "error" ? " (error)" : ""}</span>`, s.result ?? "", {
              unfold: expandAll,
              extra: s.images?.length ? html`<div class="imgs">${s.images.map((i) => img(i.ref))}</div>` : raw(""),
            });
  const reason = status === "refused" || status === "threw" || status === "error" ? html`<p class="why c-${status === "refused" ? "refused" : "failed"}">${excerpt(status === "error" ? (s.result ?? "") : (s.error ?? ""), 200)}</p>` : "";
  return html`<details class="step tool" id="s${s.n}" ${openAttr()}><summary>${dot(status)}<span class="name">${s.name ?? "?"}</span><span class="args grow">${shownBelow ? "" : argsSummary(s.args)}</span>${
    word ? html`<span class="word c-${status === "refused" ? "refused" : status === "running" ? "running" : "failed"}">${word}</span>` : ""
  }<span class="dur">${d}</span></summary><div class="inner">${block("arguments", pretty(s.args) || "(none)")}${outcome}</div></details>${reason}`;
}

/**
 * Why a turn has no transcript, in one plain sentence (store/transcripts.ts `transcriptAbsence`): it ran before
 * recording began, its transcript was pruned, or it was never recorded.
 */
function absenceText(ctx: PageContext, turn: Turn): string {
  return absenceOf(ctx, [turn]);
}

/** Why `turns` have no transcript, in a sentence or two; `of`: how many turns are shown, when not only these. */
function absenceOf(ctx: PageContext, turns: Turn[], of = turns.length): string {
  const one = turns.length === 1;
  const reasons = turns.map((t) => transcriptAbsence(ctx.db, t, ctx.transcriptDays ?? 30, ctx.now));
  const a = reasons[0]!;
  const some = turns.length < of ? `${turns.length} of these ${of} turns have no transcript. ` : "";
  if (reasons.some((r) => r.why !== a.why)) return `${turns.length} of these turns have no transcript, not all for the same reason: each one's "messages only" tag says why.`;
  return some + absenceSentence(ctx, a, one);
}

function absenceSentence(ctx: PageContext, a: ReturnType<typeof transcriptAbsence>, one: boolean): string {
  const their = one ? "Its" : "Their";
  if (a.why === "before") {
    return a.first
      ? `${one ? "This turn" : "These turns"} ran before transcripts were recorded: recording started with the console's deployment, and the first recorded turn is turn ${a.first.id}, on ${when(a.first.startedAt, ctx.timeZone)}. ${their} messages are shown from the chat's log.`
      : `No turn has been recorded yet: recording starts with the console's deployment. ${their} messages are shown from the chat's log.`;
  }
  if (a.why === "pruned") return `${one ? "This turn's transcript was" : "These turns' transcripts were"} pruned: transcripts are kept for ${a.days} days after a turn ends. ${their} messages are still in the chat's log.`;
  return `No transcript was recorded for ${one ? "this turn: it" : "these turns: each"} ended before its prompt reached the model, or recording failed.`;
}

/** A compaction: the point after which she sees only a summary of what came before. */
function compactionDivider(s: Step): Raw {
  const tokensBefore = s.tokensBefore ? `${short(s.tokensBefore)} tokens before` : "";
  const tokensAfter = s.tokensAfter ? ` → ${short(s.tokensAfter)} after` : "";
  return html`<div class="compaction"><div class="ct"><b>Compacted</b><span class="tag">${s.name === "manual" ? "manual" : "auto"}</span><span class="num">${tokensBefore}${tokensAfter}</span>${
    s.text ? html`<span class="faint">${s.text}</span>` : ""
  }</div><div class="cs">From here on she sees only a summary of what came before.</div></div>`;
}

/** How a turn's rows are drawn inside a session (`turnTrace`). */
interface InSession {
  /** The incoming events already shown by an earlier turn of the session (a retry shows them again). */
  seen: Set<number>;
}

/**
 * A turn's rows in the trace: what opened it, then its steps, her messages, what arrived mid-turn, and how it
 * ended. Alone (the turn's own view) it says everything; inside a session (`inSession`) it leaves out what the
 * session's divider already says (a resumed conversation, a clean end) and what an earlier turn already showed.
 */
function turnTrace(ctx: PageContext, turn: Turn, transcript: Transcript | undefined, steps: Step[], group: boolean, inSession?: InSession): Raw[] {
  const t0 = Date.parse(turn.startedAt);
  const owner = group && ctx.ownerId !== undefined ? { ownerId: ctx.ownerId } : {};
  const lookup = (seq: number) => eventBySeq(ctx.db, seq);
  const at = (iso: string) => offset(Date.parse(iso) - t0);
  const shape = inputShape(transcript);
  const appended = steps.filter((s) => s.kind === "append" && s.fromSeq !== null && s.toSeq !== null);
  const inAppend = (seq: number) => appended.some((a) => seq > a.fromSeq! && seq <= a.toSeq!);
  const events = eventsBetween(ctx.db, turn.chatId, turn.fromSeq, turn.toSeq);
  const shown = events.filter((e) => (TRIGGER_KINDS as string[]).includes(e.kind) && !inAppend(e.seq) && !inSession?.seen.has(e.seq)).slice(shape.unread ?? 0);
  for (const e of shown) inSession?.seen.add(e.seq);
  const firstCalled = shape.called?.[0];
  const trigger = turn.triggerSeq ?? turn.toSeq;
  const rows: Raw[] = [];

  if (!transcript && !inSession) rows.push(tr("", html`<p class="note">${absenceText(ctx, turn)}</p>`));
  if (shape.history) rows.push(tr("", html`<p class="marker">A fresh conversation, opened with the chat's last ${shape.history} messages (see Raw input)</p>`));
  else if (transcript?.resumed && !inSession) rows.push(tr("", html`<p class="marker">Resumed conversation</p>`));
  if (shape.unread) rows.push
  for (const e of shown) {
    const context = shape.hasContext && firstCalled !== undefined && e.seq < firstCalled;
    const trig = e.seq === trigger;
    rows.push(
      tr(
        "",
        incoming(e, ctx.timeZone, {
          ...owner,
          context,
          trig,
          tags: [...(context ? [html`<span class="tag">context</span>`] : []), ...(trig ? [html`<span class="tag trig">trigger</span>`] : [])],
        }),
      ),
    );
  }

  // Her outbound rows: a text block's by its seq; the rest to the tool call they happened during.
  const outbound = outboundOf(ctx.db, turn.id);
  const bySeq = new Map(outbound.map((e) => [e.seq, e]));
  const claimed = new Set(steps.filter((s) => s.kind === "text" && s.outboundSeq !== null).map((s) => s.outboundSeq!));
  const effects = new Map<number, ChatEvent[]>();
  for (const e of outbound) {
    if (claimed.has(e.seq)) continue;
    const t = Date.parse(e.at);
    const s = steps.find((x) => x.kind === "tool" && t >= Date.parse(x.at) - 5 && t <= Date.parse(x.endedAt ?? x.at) + 5);
    if (!s) continue;
    claimed.add(e.seq);
    effects.set(s.n, [...(effects.get(s.n) ?? []), e]);
  }
  const toolName = new Map(steps.filter((s) => s.kind === "tool" && s.callId).map((s) => [s.callId!, s.name ?? "?"]));

  for (const s of steps) {
    switch (s.kind) {
      case "thinking":
        rows.push(tr(at(s.at), html`<details class="step thinking" ${openAttr()}><summary><span class="grow">Thinking<span class="ex"> · ${excerpt(s.text ?? "", 140)}</span></span></summary><div class="inner">${s.text ?? ""}</div></details>`));
        break;
      case "text": {
        const e = s.outboundSeq !== null ? bySeq.get(s.outboundSeq) : undefined;
        rows.push(
          tr(
            at(s.at),
            s.sent && e
              ? outgoing(e, ctx.timeZone, { lookup })
              : html`<div class="bubble out unsent"><div class="who"><span>not sent</span></div><div class="text">${s.text ?? ""}</div></div>`,
          ),
        );
        break;
      }
      case "tool":
        // A message the call sent is shown as her bubble right after it, so the chip need not repeat it.
        rows.push(tr(at(s.at), toolChip(s, (effects.get(s.n) ?? []).some((e) => e.kind === "bot_message"))));
        for (const e of effects.get(s.n) ?? []) rows.push(tr(at(e.at), outgoing(e, ctx.timeZone, { via: s.name ?? "a tool", lookup })));
        break;
      case "append": {
        const after = s.callId ? toolName.get(s.callId) : undefined;
        const added = eventsBetween(ctx.db, turn.chatId, s.fromSeq ?? 0, s.toSeq ?? 0).filter((e) => (TRIGGER_KINDS as string[]).includes(e.kind));
        for (const e of added) {
          rows.push(
            tr(at(s.at), incoming(e, ctx.timeZone, { ...owner, tags: [html`<span class="tag mid" title="appended to the result of ${after ?? "a call"}">mid-turn · after ${after ?? "a call"}</span>`] })),
          );
        }
        if (!added.length && s.text) rows.push(tr(at(s.at), html`<p class="note">appended after ${after ?? "a call"}: ${excerpt(s.text, 120)}</p>`));
        break;
      }
      case "compaction":
        rows.push(tr(at(s.at), compactionDivider(s)));
        break;
      default:
        rows.push(tr(at(s.at), html`<p class="marker">${s.text ?? ""}</p>`));
    }
  }
  for (const e of outbound) if (!claimed.has(e.seq)) rows.push(tr(at(e.at), outgoing(e, ctx.timeZone, { lookup })));
  for (const e of appended.flatMap((s) => eventsBetween(ctx.db, turn.chatId, s.fromSeq ?? 0, s.toSeq ?? 0))) inSession?.seen.add(e.seq);

  const w = wall(turn.startedAt, turn.endedAt);
  const end = turn.endedAt ? at(turn.endedAt) : "";
  if (turn.status === "running") rows.push(tr("", html`<p class="marker c-running">still running</p>`));
  else if (inSession) {
    // The divider already says how it ended; what went wrong is said here, where it happened.
    if (turn.error) rows.push(tr(end, html`<p class="why c-${turn.status === "failed" ? "failed" : "stopped"}">${turn.status === "failed" ? "Failed" : "Stopped"}: ${excerpt(turn.error, 240)}</p>`));
  } else rows.push(tr(end, html`<p class="marker"><span class="c-${turn.status}">ended ${turn.status}</span>${w !== null ? html`<span class="sep"></span>${secs(w)}` : ""}</p>`));
  return rows;
}

function conversation(ctx: PageContext, turn: Turn, transcript: Transcript | undefined, steps: Step[], group: boolean): Raw {
  return html`<div class="trace">${turnTrace(ctx, turn, transcript, steps, group)}</div>`;
}

// ---- one turn: the system prompt and the raw input --------------------------------------------------------

function promptTab(ctx: PageContext, turn: Turn, prompt: PromptText | undefined, showDiff: boolean, link: (q: Record<string, string>) => string): Raw {
  if (!prompt) return empty(absenceText(ctx, turn));
  const prev = previousPrompt(ctx.db, turn.chatId, turn.id);
  const changed = prev && prev.prompt.hash !== prompt.hash;
  const sizes = prompt.sections.map((s) => s.end - s.start);
  const max = Math.max(1, ...sizes);
  const allId = "prompt-all";
  const summary = html`<div class="psum"><span><b class="num">${tokens(prompt.text.length)}</b> chars · ~${short(Math.round(prompt.text.length / 4))} tokens · ${prompt.sections.length} sections · <span class="mono">${prompt.hash.slice(0, 10)}</span></span>
<span>${prev ? (changed ? html`changed since <a href="/turns/${prev.turnId}?tab=prompt">turn ${prev.turnId}</a>` : html`unchanged since <a href="/turns/${prev.turnId}?tab=prompt">turn ${prev.turnId}</a>`) : "the first recorded in this chat"}</span>
<span class="right">${changed ? html`<a href="${link(showDiff ? { tab: "prompt" } : { tab: "prompt", diff: "1" })}">${showDiff ? "Hide diff" : "Show diff"}</a>` : ""}<button class="copy" type="button" data-copy="${allId}" hidden>copy all</button></span></div><pre id="${allId}" hidden>${prompt.text}</pre>`;
  let diff: Raw = raw("");
  if (changed && showDiff) {
    const lines = hunks(diffLines(prev.prompt.text, prompt.text));
    const added = lines.filter((l) => l?.op === "add").length;
    const removed = lines.filter((l) => l?.op === "del").length;
    diff = html`<p class="meta" style="margin-bottom:var(--s2)">Diff against turn ${prev.turnId}: <span class="c-done">+${added}</span> <span class="c-failed">−${removed}</span> lines</p><div class="diff">${lines.map((l) =>
      l === null ? html`<span class="gap">⋯</span>` : html`<span class="${l.op === "add" ? "add" : l.op === "del" ? "del" : "ctx"}">${l.op === "add" ? "+ " : l.op === "del" ? "- " : "  "}${l.text || " "}</span>`,
    )}</div>`;
  }
  const sections = prompt.sections.map((s, i) => {
    const text = prompt.text.slice(s.start, s.end);
    return html`<details ${openAttr()}><summary><span class="lbl">${s.label}</span><span class="bar"><i style="width:${Math.max(2, Math.round((sizes[i]! / max) * 100))}%"></i></span><span class="size">${size(text)}</span></summary><div class="inner">${block("", text, { prose: true, open: true })}</div></details>`;
  });
  return html`${summary}${diff}<div class="sections">${sections}</div>`;
}

function rawTab(ctx: PageContext, turn: Turn, transcript: Transcript | undefined, steps: Step[]): Raw {
  if (!transcript) return empty(absenceText(ctx, turn));
  const t0 = Date.parse(turn.startedAt);
  const parts = (label: string, ps: readonly TranscriptPart[]) => {
    const text = ps.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
    const imgs = ps.filter((p) => p.type === "image").map((p) => img((p as { ref: string }).ref));
    return block(label, text, { open: true, extra: imgs.length ? html`<div class="imgs">${imgs}</div>` : raw("") });
  };
  const toolName = new Map(steps.filter((s) => s.kind === "tool" && s.callId).map((s) => [s.callId!, s.name ?? "?"]));
  const appends = steps
    .filter((s) => s.kind === "append")
    .map((s) => block(`appended to the result of ${s.callId ? (toolName.get(s.callId) ?? "a call") : "a call"} · ${offset(Date.parse(s.at) - t0)}`, s.text ?? "", { open: true, extra: s.images?.length ? html`<div class="imgs">${s.images.map((i) => img(i.ref))}</div>` : raw("") }));
  return html`<div class="raw">${parts(transcript.resumed ? "the new user message (a resumed conversation)" : "the opening prompt (a fresh conversation)", transcript.input)}${appends}</div>`;
}

// ---- one turn ----------------------------------------------------------------------------------------------

const TABS = [
  { id: "conversation", label: "Conversation" },
  { id: "prompt", label: "System prompt" },
  { id: "raw", label: "Raw input" },
] as const;

function turnDetail(ctx: PageContext, turn: Turn, q: URLSearchParams, f: Filters): Raw {
  const chat = chatById(ctx.db, turn.chatId)!;
  const transcript = getTranscript(ctx.db, turn.id);
  const prompt = transcript?.promptHash ? getPromptText(ctx.db, transcript.promptHash) : undefined;
  const steps = stepsOf(ctx.db, turn.id);
  const { prev, next } = neighbours(ctx.db, turn);
  const tab = (TABS.find((t) => t.id === q.get("tab")) ?? TABS[0]).id;
  const link = (extra: Record<string, string>) => href(`/turns/${turn.id}`, { ...f, ...extra });
  const w = wall(turn.startedAt, turn.endedAt);
  const trigger = eventBySeq(ctx.db, turn.triggerSeq ?? turn.toSeq);
  const tools = steps.filter((s) => s.kind === "tool");
  const refused = tools.filter((s) => s.status === "refused").length;
  const failedCalls = tools.filter((s) => s.status === "error" || s.status === "threw").length;
  const place = segmentOf(ctx.db, turn.chatId, turn.id);

  const facts = [
    ...(w !== null ? [html`<b>${secs(w)}</b>`] : turn.status === "running" ? [html`running for <b>${secs((Date.now() - Date.parse(turn.startedAt)) / 1000)}</b>`] : []),
    ...(turn.inputTokens !== null ? [html`<b>${tokens(turn.inputTokens)}</b> in / <b>${tokens(turn.outputTokens)}</b> out`] : [html`<span class="faint">no usage recorded</span>`]),
    ...(turn.cacheReadTokens !== null ? [html`cache <b>${short(turn.cacheReadTokens)}</b> read / <b>${short(turn.cacheCreationTokens)}</b> write`] : []),
    ...(turn.costMicroUsd ? [html`<b>${usd(turn.costMicroUsd / 1e6)}</b>`] : []),
    html`${tools.length} tool call${tools.length === 1 ? "" : "s"}${refused ? html`, <span class="c-refused">${refused} refused</span>` : ""}${failedCalls ? html`, <span class="c-failed">${failedCalls} failed</span>` : ""}`,
    ...(transcript?.model ? [html`<span class="mono">${transcript.model}</span>`] : []),
  ];
  const head = html`<div class="head">
<a class="back" href="${href("/turns", f)}">← All chats</a>
<div class="title">${badge(turn.status)}<h1>Turn ${turn.id}</h1><a href="/chats/${chat.id}#e${turn.toSeq}">${chatName(chat)}</a><span class="meta" title="${when(turn.startedAt, ctx.timeZone, true)}">${when(turn.startedAt, ctx.timeZone)} · ${ago(turn.startedAt, ctx.now)}</span>
<span class="nav">${prev ? html`<a href="${href(`/turns/${prev}`, f)}" title="the chat's previous turn">‹ turn ${prev}</a>` : ""}${next ? html`<a href="${href(`/turns/${next}`, f)}" title="the chat's next turn">turn ${next} ›</a>` : ""}</span></div>
${trigger ? html`<p class="trigger">Triggered by ${eventPreview(trigger.kind, trigger.payload)} <span class="mono">#${trigger.seq}</span></p>` : ""}
${place ? html`<p class="trigger context">In <a href="${href(`/segments/${place.id}`, f)}">the segment of ${when(turnById(ctx.db, place.id)?.startedAt, ctx.timeZone)}</a> (turn ${place.turnIds.indexOf(turn.id) + 1} of ${place.turnIds.length}), of <a href="${href(`/conversations/${place.conversation.id}`, f)}">${inSentence(conversationLabel(place.conversation))}</a></p>` : ""}
<p class="facts">${facts.map((x, i) => html`${i ? html`<span class="sep"></span><wbr>` : ""}<span class="fact">${x}</span>`)}</p>
${turn.error ? html`<div class="banner">${turn.status === "stopped" ? "Stopped" : "Why it ended that way"}<span class="mono">${turn.error}</span></div>` : ""}
</div>`;
  const tabs = html`<nav class="tabs">${TABS.map((t) => html`<a class="${t.id === tab ? "on" : ""}" href="${link(t.id === "conversation" ? {} : { tab: t.id })}">${t.label}${t.id === "prompt" && prompt ? html` <span class="meta">${size(prompt.text)}</span>` : ""}</a>`)}<span class="aside"><a href="${link(expandAll ? (tab === "conversation" ? {} : { tab }) : { ...(tab === "conversation" ? {} : { tab }), expand: "1" })}">${expandAll ? "collapse all" : "expand all"}</a> · j / k: next / previous turn</span></nav>`;
  const body =
    tab === "prompt" ? promptTab(ctx, turn, prompt, q.get("diff") === "1", link) : tab === "raw" ? rawTab(ctx, turn, transcript, steps) : conversation(ctx, turn, transcript, steps, chat.kind === "group");
  return html`<div class="detail">${head}${tabs}<div class="panel">${body}</div></div>`;
}

// ---- a segment, or a whole conversation ------------------------------------------------------------------------

/**
 * A segment, or a conversation, as one continuous exchange: each turn opens with a thin divider (its number,
 * outcome, duration, cost, and a link to the turn's own view), then its rows; in a conversation, a time gap
 * between segments is a divider too, and a compaction is marked where it happened.
 */
function spanDetail(ctx: PageContext, sp: Span, level: "segment" | "conversation", q: URLSearchParams, f: Filters): Raw {
  const chat = chatById(ctx.db, sp.chatId)!;
  const turns = sp.turnIds.map((id) => turnById(ctx.db, id)!).filter(Boolean);
  const first = turns[0]!;
  const last = turns.at(-1)!;
  const conv = sp.conversation;
  const filter = toFilter(f, q, ctx.timeZone);
  const filtered = Object.keys(f).some((k) => k !== "chat");
  const matches = filtered ? matchingTurns(ctx.db, filter, sp.turnIds) : new Set<number>();
  const endOf = (t: Turn) => t.endedAt ?? t.startedAt;
  const sum = (k: "inputTokens" | "outputTokens" | "costMicroUsd") => turns.reduce((n, t) => n + (t[k] ?? 0), 0);
  const failed = turns.filter((t) => t.status === "failed").length;
  // A segment shows its worst outcome, as its row's dot does; a conversation goes on past a failure, so it
  // shows where it stands now (its latest turn), and its failures are counted in the facts.
  const outcome =
    level === "conversation" ? last.status : worst({ failed, running: turns.filter((t) => t.status === "running").length, stopped: turns.filter((t) => t.status === "stopped").length });
  const allSteps = new Map(turns.map((t) => [t.id, stepsOf(ctx.db, t.id)]));
  const tools = [...allSteps.values()].flat().filter((s) => s.kind === "tool");
  const refused = tools.filter((s) => s.status === "refused").length;
  const toolErrors = tools.filter((s) => s.status === "error" || s.status === "threw").length;
  const compactions = [...allSteps.values()].flat().filter((s) => s.kind === "compaction").length;
  const base = level === "segment" ? "/sessions" : "/conversations";

  // A segment is named by when it happened: its start, and its end when that is another minute.
  const endClock = clock(endOf(last), ctx.timeZone);
  const title =
    level === "segment"
      ? `${when(first.startedAt, ctx.timeZone)}${endClock !== clock(first.startedAt, ctx.timeZone) ? ` – ${endClock}` : ""}`
      : conversationLabel(conv);
  const part = sp.segmentIds.indexOf(sp.id) + 1;
  const context =
    level === "segment"
      ? html`<p class="trigger context">${sp.segmentIds.length > 1 ? `Segment ${part} of ${sp.segmentIds.length} of ` : "The only segment of "}<a href="${href(`/conversations/${conv.id}`, f)}">${inSentence(conversationLabel(conv))}</a>, which began ${when(conv.startedAt, ctx.timeZone)}${
          conv.compactions ? ` · ${conv.compactions} compaction${conv.compactions === 1 ? "" : "s"} in it` : ""
        }</p>`
      : html`<p class="trigger context">Began ${when(conv.startedAt, ctx.timeZone)}${conv.backendSessionId ? html` · session <span class="mono">${conv.backendSessionId.slice(0, 8)}</span>` : ""} · ${conv.segments} segment${conv.segments === 1 ? "" : "s"}${
          conv.compactions ? html` · <span class="c-lost">${conv.compactions} compaction${conv.compactions === 1 ? "" : "s"}</span>` : ""
        }</p>`;
  const facts = [
    html`<b>${span(Date.parse(endOf(last)) - Date.parse(first.startedAt))}</b>`,
    html`<b>${turns.length}</b> turn${turns.length === 1 ? "" : "s"}${failed ? html`, <span class="c-failed">${failed} failed</span>` : ""}`,
    html`<b>${tokens(sum("inputTokens"))}</b> in / <b>${tokens(sum("outputTokens"))}</b> out`,
    ...(sum("costMicroUsd") ? [html`<b>${usd(sum("costMicroUsd") / 1e6)}</b>`] : []),
    html`${tools.length} tool call${tools.length === 1 ? "" : "s"}${refused ? html`, <span class="c-refused">${refused} refused</span>` : ""}${toolErrors ? html`, <span class="c-failed">${toolErrors} failed</span>` : ""}`,
    ...(level === "segment" && compactions ? [html`<span class="c-lost">compacted</span>`] : []),
  ];
  const missing = turns.filter((t) => !getTranscript(ctx.db, t.id));
  const head = html`<div class="head">
<a class="back" href="${href("/turns", f)}">← All chats</a>
<div class="title">${badge(outcome)}<h1>${title}</h1><a href="${href(`/chats/${chat.id}`, f)}#e${first.toSeq}">${chatName(chat)}</a>
<span class="nav">${sp.prev ? html`<a href="${href(`${base}/${sp.prev}`, f)}" title="the chat's previous ${level}">‹ earlier</a>` : ""}${sp.next ? html`<a href="${href(`${base}/${sp.next}`, f)}" title="the chat's next ${level}">later ›</a>` : ""}</span></div>
${context}
<p class="facts">${facts.map((x, i) => html`${i ? html`<span class="sep"></span><wbr>` : ""}<span class="fact">${x}</span>`)}</p>
${filtered ? html`<p class="trigger context"><span class="c-accent">${matches.size} of ${turns.length} turns</span> match the filter; they are marked below.</p>` : ""}
${missing.length ? html`<p class="note left">${absenceOf(ctx, missing, turns.length)}</p>` : ""}
</div>`;
  const aside = html`<nav class="tabs"><span class="on">${level === "segment" ? "Segment" : "Conversation"}</span><span class="aside"><a href="${href(`${base}/${sp.id}`, expandAll ? f : { ...f, expand: "1" })}">${expandAll ? "collapse all" : "expand all"}</a> · j / k: next / previous segment</span></nav>`;

  const group = chat.kind === "group";
  const seen = new Set<number>();
  const rows: Raw[] = [];
  let prevTurn: Turn | null = null;
  for (const t of turns) {
    if (prevTurn && sp.segmentOf.get(t.id) !== sp.segmentOf.get(prevTurn.id)) {
      rows.push(html`<div class="gapdiv"><span>${span(Date.parse(t.startedAt) - Date.parse(endOf(prevTurn)))} later · ${when(t.startedAt, ctx.timeZone)}</span></div>`);
    }
    const steps = allSteps.get(t.id) ?? [];
    const transcript = getTranscript(ctx.db, t.id);
    const w = wall(t.startedAt, t.endedAt);
    const retry = eventsBetween(ctx.db, t.chatId, t.fromSeq, t.toSeq).some((e) => seen.has(e.seq));
    rows.push(
      html`<div class="tdiv${matches.has(t.id) ? " match" : ""}"><a href="${href(`/turns/${t.id}`, f)}">${dot(t.status)}turn ${t.id}</a><span class="c-${t.status}">${t.status}</span>${w !== null ? html`<span>${secs(w)}</span>` : ""}${
        t.costMicroUsd ? html`<span>${usd(t.costMicroUsd / 1e6)}</span>` : ""
      }${retry ? html`<span class="tag">retry</span>` : ""}${transcript ? "" : html`<span class="tag" title="${absenceText(ctx, t)}">messages only</span>`}${matches.has(t.id) ? html`<span class="tag trig">match</span>` : ""}<span class="tlinks"><a class="tabs-link" href="${href(`/turns/${t.id}`, { ...f, tab: "prompt" })}">prompt</a><a class="tabs-link" href="${href(`/turns/${t.id}`, { ...f, tab: "raw" })}">raw</a></span></div>`,
    );
    rows.push(...turnTrace(ctx, t, transcript, steps, group, { seen }));
    prevTurn = t;
  }
  return html`<div class="detail">${head}${aside}<div class="panel"><div class="trace">${rows}</div></div></div>`;
}

/** A segment (`level` segment) or a conversation, by id or by any turn in it. Null: no such thing. */
function spanPage(ctx: PageContext, q: URLSearchParams, id: number, level: "segment" | "conversation"): string | null {
  resetBlocks();
  expandAll = q.get("expand") === "1";
  const t = turnById(ctx.db, id);
  if (!t) return null;
  const sp = level === "segment" ? segmentOf(ctx.db, t.chatId, id) : conversationOf(ctx.db, t.chatId, id);
  if (!sp) return null;
  const f = currentFilters(q);
  const { pane } = listPane(ctx, q, level === "segment" ? { segment: sp.id, inChat: sp.chatId } : { conversation: sp.id, inChat: sp.chatId });
  return page(level === "segment" ? "Segment" : "Conversation", split(pane, spanDetail(ctx, sp, level, q, f), true), ctx.who);
}

export const segmentPage = (ctx: PageContext, q: URLSearchParams, id: number) => spanPage(ctx, q, id, "segment");
export const conversationPage = (ctx: PageContext, q: URLSearchParams, id: number) => spanPage(ctx, q, id, "conversation");

/** The left pane beside `detail`, one pane at a time on a narrow screen (`selected`: the detail's). */
function split(pane: Raw, detail: Raw, selected: boolean): Raw {
  return html`<div class="split${selected ? " selected" : ""}"><aside class="list-pane">${pane}</aside><main class="detail-pane">${detail}</main></div>`;
}

/** The turns page: the list, and the selected turn (`id`, else the newest in the list). Null: no such turn. */
export function turnsPage(ctx: PageContext, q: URLSearchParams, id?: number): string | null {
  resetBlocks();
  expandAll = q.get("expand") === "1";
  const turn = id !== undefined ? turnById(ctx.db, id) : undefined;
  if (id !== undefined && !turn) return null;
  const f = currentFilters(q);
  const { pane, first } = listPane(ctx, q, turn ? { turn } : {});
  let detail: Raw = empty("No turn to show.");
  if (turn) detail = turnDetail(ctx, turn, q, f);
  else if (first !== undefined) {
    // Nothing selected: the newest segment in the list, beside it.
    const t = turnById(ctx.db, first);
    const sp = t ? segmentOf(ctx.db, t.chatId, first) : null;
    if (sp) detail = spanDetail(ctx, sp, "segment", q, f);
  }
  return page(turn ? `Turn ${turn.id}` : "Turns", split(pane, detail, !!turn), ctx.who);
}

// ---- a chat ---------------------------------------------------------------------------------------------------

/**
 * A chat as a conversation, on the right of the same list (its group open and marked): the chat's header in the
 * list leads here, each turn's divider leads back to that turn.
 */
export function chatPage(ctx: PageContext, chatId: number, q: URLSearchParams = new URLSearchParams()): string | null {
  const b = q.get("before");
  const before = b && /^\d+$/.test(b) ? Number(b) : undefined;
  resetBlocks();
  const chat = chatById(ctx.db, chatId);
  if (!chat) return null;
  const { events, more } = chatEventsPage(ctx.db, chatId, EVENTS_PER_PAGE, before);
  const spans = chatTurnSpans(ctx.db, chatId);
  const byId = new Map(spans.map((s) => [s.id, s]));
  // An inbound event is placed with the first turn that took it in, so the dividers stay in order; a retry
  // after a failure answers it again, and its own divider follows the failed turn's.
  const turnOf = (e: ChatEvent) => ((OUTBOUND_KINDS as string[]).includes(e.kind) ? e.turnId : spans.find((t) => t.fromSeq < e.seq && e.seq <= t.toSeq)?.id) ?? null;
  const items: Raw[] = [];
  let current: number | null = null;
  for (const e of events) {
    const t = turnOf(e);
    if (t !== null && t !== current) {
      const s = byId.get(t);
      const w = s ? wall(s.startedAt, s.endedAt) : null;
      items.push(html`<div class="divider"><a href="${href(`/turns/${t}`, currentFilters(q))}">${dot(s?.status ?? "")}turn ${t}${s ? ` · ${s.status}` : ""}${w !== null ? ` · ${secs(w)}` : ""}${s?.costMicroUsd ? ` · ${usd(s.costMicroUsd / 1e6)}` : ""}</a></div>`);
    }
    if (t !== null) current = t;
    const out = (OUTBOUND_KINDS as string[]).includes(e.kind);
    items.push(
      out
        ? outgoing(e, ctx.timeZone, { lookup: (seq) => events.find((x) => x.seq === seq) ?? eventBySeq(ctx.db, seq) })
        : incoming(e, ctx.timeZone, {
            ...(chat.kind === "group" && ctx.ownerId !== undefined ? { ownerId: ctx.ownerId } : {}),
            ...(t === null && e.seq > chat.cursorSeq ? { tags: [html`<span class="tag">unseen</span>`] } : {}),
          }),
    );
  }
  const first = events[0]?.seq;
  const failed = spans.filter((t) => t.status === "failed").length;
  const detail = html`<div class="detail">
<a class="back" href="${href("/turns", currentFilters(q))}">← All chats</a>
<div class="head"><div class="title"><h1>${chatName(chat)}</h1><span class="meta">${chat.kind === "group" ? "group" : "direct chat"}</span></div>
<p class="facts">telegram <span class="mono">${chat.tgChatId}</span><span class="sep"></span>cursor <span class="mono">#${chat.cursorSeq}</span><span class="sep"></span>${
    chat.backendSessionId ? html`conversation with <b>${short(chat.contextTokens)}</b> tokens of context` : "a fresh conversation next"
  }<span class="sep"></span><a href="${href("/turns", { chat: chat.id })}">${spans.length} turn${spans.length === 1 ? "" : "s"}</a>${failed ? html`, <span class="c-failed">${failed} failed</span>` : ""}</p></div>
<div class="panel">
${more && first ? html`<p class="note"><a href="${href(`/chats/${chat.id}`, { ...currentFilters(q), before: first })}">Earlier events</a></p>` : ""}
${events.length ? html`<div class="convo">${items}</div>` : empty("Nothing recorded in this chat.")}
</div></div>`;
  const { pane } = listPane(ctx, q, { chat: chat.id, inChat: chat.id });
  return page(chatName(chat), split(pane, detail, true), ctx.who);
}
