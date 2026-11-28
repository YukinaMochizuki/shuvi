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
import { DELETABLE_KINDS, DELETE_UNDO_MS, turnDeletionPlan, turnMessageCount, type TurnDeletionEvent, type TurnDeletionPlan } from "../store/deletions.ts";
import { listModels } from "../store/models.ts";
import { diffLines, hunks } from "./diff.ts";
import { ago, badge, block, clock, dot, empty, excerpt, href, html, lb, livePart, markdown, page, raw, resetBlocks, scopedBlocks, secs, short, size, tokens, usd, wall, when, type LivePart, type Raw } from "./html.ts";
import { conversationOf, matchingTurns, segmentList, segmentOf, type Conversation, type SegmentRow, type Span } from "./sessions.ts";
import { spanTimeline, turnTimes, turnWaterfall, type TurnTimes } from "./timeline.ts";
import {
  chatById,
  chatEventsPage,
  chatTurnSpans,
  eventBySeq,
  eventsBetween,
  neighbours,
  outboundOf,
  outboundOfTurns,
  toolNames,
  turnById,
  turnPrewarms,
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
  /** This session's CSRF token (server.ts), for the page's writes: the delete form. Unset: no form (a test rendering a page). */
  csrf?: string;
  /** The page's own path and query, where a delete without script comes back to. */
  here?: string;
  /** A delete's result, shown once at the top of the page it came back to (delete-write.ts). */
  notice?: Raw;
}

/** "⚙ Settings" beside a chat's name on every page about it: its settings page (chat-settings.ts). */
function settingsLink(chatId: number): Raw {
  return html`<a class="tgear" href="/chats/${chatId}/settings" title="This chat's settings: model, profile, conversation, permissions">⚙ Settings</a>`;
}

/** The chats list with chat `chatId`'s group open and marked, for a page about that chat (its settings). */
export function chatListPane(ctx: PageContext, chatId: number, q: URLSearchParams = new URLSearchParams()): Raw {
  return listPane(ctx, q, { chat: chatId, inChat: chatId }).pane;
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
  // Not boosted: the link opens the image itself, which htmx would otherwise swap into the page as text.
  return html`<a href="${u}" hx-boost="false"><img src="${u}" alt="" loading="lazy"></a>`;
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
  /** The owner's id, to count a selection's lines as theirs ("you"), hers, or someone else's. */
  me?: number;
}

/**
 * A bubble the owner may delete. Idle, nothing about deleting shows: with script (console.js) a faint "⋯" fades in
 * at its top right on hover or focus (on a touch screen a long press opens the same menu instead), offering Select
 * and Delete; while selecting, a round check on its left (`dsel`). Without script there is only what `<noscript>`
 * holds: a checkbox for the page's delete form (`deleteBar`), which is inside `<noscript>` too. `side` counts it:
 * you (the owner), her, or someone else.
 *
 * No `<style>` may go in a `<noscript>` here: htmx swaps pages in parsed with scripting off, so a `<noscript>`'s
 * content becomes real elements; they stay hidden (`noscript` is display:none with script on), but a style in it
 * would apply.
 */
function pickable(e: ChatEvent, side: "you" | "her" | "other", inner: Raw): Raw {
  if (!DELETABLE_KINDS.includes(e.kind)) return inner;
  return html`<div class="pickable ${side}" data-seq="${e.seq}" data-side="${side}"><span class="dslot"><button type="button" class="dsel" aria-pressed="false" aria-label="Select #${e.seq}" tabindex="-1"></button><noscript><label class="nspick" title="Tick to delete"><input type="checkbox" name="seq" value="${e.seq}" form="del" aria-label="Tick #${e.seq} to delete"></label></noscript></span><div class="pbody">${inner}<details class="bmenu"><summary title="More" aria-label="More for #${e.seq}">⋯</summary><div class="menu"><button type="button" class="dm-sel">Select</button><button type="button" class="dm-del">Delete</button></div></details></div></div>`;
}

/**
 * What deleting needs on a page, at the end of its detail pane. With script (console.js): the pill that floats at
 * the bottom centre only while something is selected ("3 selected · Delete · ✕", a refusal's reason under it), and
 * the snackbar at the bottom left after a delete ("Deleted 3 · Undo", a thin line counting down its 10 s); the
 * delete is posted in the background with the CSRF token of `data-csrf`. Without script: a plain form posting the
 * ticked boxes (`delete-write.ts`), all inside `<noscript>`, so nothing of it shows with script on.
 */
function deleteBar(ctx: PageContext): Raw {
  if (!ctx.csrf) return raw("");
  return html`<noscript><form id="del" class="nsdel" method="post" action="/messages/delete"><input type="hidden" name="csrf" value="${ctx.csrf}"><input type="hidden" name="back" value="${ctx.here ?? "/turns"}"><button type="submit" class="btn danger">Delete the ticked messages</button></form></noscript>
<div class="delui" data-csrf="${ctx.csrf}"><div class="selpill" role="toolbar" hidden aria-label="Selected messages"><span class="pn" aria-live="polite"></span><span class="psep" aria-hidden="true"></span><button type="button" class="pdel" title="Delete (Del)">Delete</button><button type="button" class="px" aria-label="Clear the selection" title="Clear (Esc)">✕</button><span class="pwhy" role="alert"></span></div>
<div class="snack" role="status" hidden><span class="swhat"></span><button type="button" class="sundo">Undo</button><span class="sline" aria-hidden="true"></span></div></div>`;
}

// ---- deleting a whole turn -------------------------------------------------------------------------------

/**
 * Where deleting a turn starts: its confirmation (`/turns/<id>/delete`, a page of its own, which works without
 * script; console.js opens the same panel in place). `back`: the page to come back to.
 */
export function turnDeleteHref(turnId: number, back: string | undefined): string {
  return href(`/turns/${turnId}/delete`, back ? { back } : {});
}

/**
 * A turn divider's "⋯" in a chat's log: its menu, "Delete turn…" (a link to the confirmation). With script it fades
 * in on hover, as a bubble's does; without script it shows faintly, as a link works without script; on a touch
 * screen it shows too (a divider has no long press). Not tied to the session (no CSRF token in it): the live stream
 * draws it for every session alike, and the confirmation page carries its own token.
 */
function turnMenu(ctx: PageContext, turnId: number): Raw {
  return html`<details class="bmenu tmenu"><summary title="More" aria-label="More for turn ${turnId}">⋯</summary><div class="menu"><a class="dm-tdel" hx-boost="false" href="${turnDeleteHref(turnId, ctx.here)}" data-turn="${turnId}">Delete turn…</a></div></details>`;
}

/** One line of the confirmation's lists: who, what it says, when, its number. */
function goneLine(e: TurnDeletionEvent, tz: string, me: number | undefined): Raw {
  const p = parsePayload(e.payload) ?? {};
  let who = "";
  let what = "";
  let side = "other";
  switch (e.kind) {
    case "message": {
      const m = p as unknown as MessagePayload;
      side = me !== undefined && m.from.id === me ? "you" : "other";
      who = side === "you" ? "you" : m.from.name;
      what = m.text || (m.media ? "[a picture]" : "");
      break;
    }
    case "bot_message":
      side = "her";
      who = "shuvi";
      what = (p as unknown as BotMessagePayload).text.replace(/\*\*|`/g, "");
      break;
    case "bot_sticker":
      side = "her";
      who = "shuvi";
      what = `a sticker${(p as unknown as BotStickerPayload).emoji ? ` ${(p as unknown as BotStickerPayload).emoji}` : ""}`;
      break;
    case "bot_file":
      side = "her";
      who = "shuvi";
      what = `a file: ${(p as unknown as BotFilePayload).name}`;
      break;
    case "bot_reaction":
      side = "her";
      who = "shuvi";
      what = `reacted ${(p as unknown as BotReactionPayload).emoji} to #${(p as unknown as BotReactionPayload).targetSeq}`;
      break;
    default:
      who = e.kind.replace("_", " ");
      what = eventPreview(e.kind, p);
  }
  return html`<li class="${side}"><span class="gwho">${who}</span><span class="gwhat">${excerpt(what, 120)}</span><span class="gmeta">${clock(e.at, tz)} <span class="mono">#${e.seq}</span></span></li>`;
}

const GONE_SHOWN = 8;

/** A list of events going, the first few and how many more. */
function goneList(events: TurnDeletionEvent[], tz: string, me: number | undefined): Raw {
  const shown = events.slice(0, GONE_SHOWN);
  const more = events.length - shown.length;
  return html`<ul class="glist">${shown.map((e) => goneLine(e, tz, me))}${more > 0 ? html`<li class="gmore">and ${more} more</li>` : ""}</ul>`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "you 1, Alice Example 2, Bob 2": who sent the messages a turn answered, in the order they first spoke. */
function byWhom(events: TurnDeletionEvent[], me: number | undefined): string {
  const n = new Map<string, number>();
  for (const e of events) {
    const p = parsePayload(e.payload);
    const who = e.kind === "message" ? (me !== undefined && (p as unknown as MessagePayload).from.id === me ? "you" : (p as unknown as MessagePayload).from.name) : e.kind.replace("_", " ");
    n.set(who, (n.get(who) ?? 0) + 1);
  }
  return [...n].map(([w, c]) => `${w} ${c}`).join(", ");
}

/** "2 messages, 1 sticker, 1 reaction": what a turn wrote, by kind. */
function wroteSummary(events: TurnDeletionEvent[]): string {
  const count = (k: string) => events.filter((e) => e.kind === k).length;
  return [
    [count("bot_message"), "message"],
    [count("bot_sticker"), "sticker"],
    [count("bot_file"), "file"],
    [count("bot_reaction"), "reaction"],
  ]
    .filter(([c]) => (c as number) > 0)
    .map(([c, w]) => plural(c as number, w as string))
    .join(", ");
}

/**
 * The confirmation of deleting a turn: a red-tinted panel (DESIGN.md "Deleting a turn") listing what goes, first
 * the messages (those it answered, anyone's; what she wrote), then her record of it; what is NOT undone; the
 * button and Cancel. Refused (running, a message still to send): the reason instead of the button.
 */
export function turnDeleteConfirm(ctx: PageContext, plan: TurnDeletionPlan, back: string): Raw {
  const me = ctx.ownerId;
  const tz = ctx.timeZone;
  const s = plan.steps;
  const record = [
    ...(plan.transcript ? ["its input and system prompt"] : []),
    ...(s.thinking ? [plural(s.thinking, "stretch of thinking", "stretches of thinking")] : []),
    ...(s.text ? [plural(s.text, "text block")] : []),
    ...(s.append ? [plural(s.append, "append")] : []),
    ...(s.note ? [plural(s.note, "note")] : []),
    ...(s.compaction ? [plural(s.compaction, "compaction")] : []),
  ];
  const tools = plan.tools.map((t) => `${t.name}${t.n > 1 ? ` ×${t.n}` : ""}`).join(", ");
  // The one count of a turn's messages (store/deletions.ts): the snackbar and the notice say the same.
  const messages = turnMessageCount(plan);
  return html`<div class="confirm tconfirm" role="alertdialog" aria-label="Delete turn ${plan.turnId}" data-turn="${plan.turnId}">
<p class="q">Delete turn ${plan.turnId}${messages ? html`, with the ${plural(messages, "message")} in it` : ""}?</p>
<p class="effect">It goes from the chat's log, the console, her history and her searches, as deleted messages do: no trace.</p>
<div class="tgone">
<h3>It answered <span class="meta">${plan.answered.length ? html`${plural(plan.answered.length, "message")} · ${byWhom(plan.answered, me)}` : "nothing still in the log"}</span></h3>
${plan.answered.length ? goneList(plan.answered, tz, me) : ""}
<h3>She wrote <span class="meta">${plan.wrote.length ? wroteSummary(plan.wrote) : "nothing"}</span></h3>
${plan.wrote.length ? goneList(plan.wrote, tz, me) : ""}
<h3>Her record of it</h3>
<p class="grecord">${record.length ? record.join(" · ") : "no transcript"}${s.tool ? html`<br><b>${plural(s.tool, "tool call")}</b>: <span class="mono">${tools}</span>` : ""}</p>
</div>
${plan.shared.length ? html`<p class="effect">Some of these messages were also answered by ${plan.shared.length === 1 ? `turn ${plan.shared[0]}` : `turns ${plan.shared.join(", ")}`}: they go from ${plan.shared.length === 1 ? "its" : "their"} input too.</p>` : ""}
<p class="effect faint">Not undone: what the turn did (her edits in home/, schedules it set, jobs it started), nor what her conversation remembers of it.</p>
${
  plan.refused
    ? html`<p class="row-note refused" role="alert">${plan.refused}</p><div class="cbtns"><a class="btn tcancel" href="${back}">Back</a></div>`
    : html`<form class="cbtns" method="post" action="/turns/delete"><input type="hidden" name="csrf" value="${ctx.csrf ?? ""}"><input type="hidden" name="turn" value="${plan.turnId}"><input type="hidden" name="back" value="${back}"><button type="submit" class="btn danger solid">Delete turn ${plan.turnId}</button><a class="btn tcancel" href="${back}">Cancel</a><span class="faint">You can undo it for ${DELETE_UNDO_MS / 1000} seconds.</span></form>`
}
</div>`;
}

/** The confirmation as a page of its own (`/turns/<id>/delete?back=…`): for no script, and what console.js takes the panel from. */
export function turnDeletePage(ctx: PageContext, turnId: number, back: string): string | null {
  resetBlocks();
  const turn = turnById(ctx.db, turnId);
  const plan = turnDeletionPlan(ctx.db, turnId);
  if (!turn || !plan) return null;
  const chat = chatById(ctx.db, turn.chatId)!;
  const detail = html`<div class="detail"><a class="back" href="${back}">← Back</a><div class="head"><div class="title">${badge(turn.status)}<h1>Delete turn ${turn.id}</h1><a href="/chats/${chat.id}">${chatName(chat)}</a><span class="meta" title="${when(turn.startedAt, ctx.timeZone, true)}">${when(turn.startedAt, ctx.timeZone)} · ${ago(turn.startedAt, ctx.now)}</span></div></div>${turnDeleteConfirm(ctx, plan, back)}</div>`;
  const { pane } = listPane(ctx, new URLSearchParams(), { turn });
  // Not a live page: nothing on it changes by itself (no `data-live-page`).
  const { here: _here, ...still } = ctx;
  return page(`Delete turn ${turn.id}`, split(still, pane, detail, true), ctx.who, "turns");
}

/**
 * The page for a turn (or a segment, a conversation named by one) that is not there: deleted (store/deletions.ts
 * leaves every pointer to it as it was: an alert's link, a Home commit's `Turn:` trailer, a switch note) or never
 * was. Plain, as a not-found page: the list beside it (which no longer has it), the sentence, and a delete's notice
 * with its Undo when it came back here from the delete. Not live.
 */
export function turnGonePage(ctx: PageContext, what: string, turnId?: number): string {
  resetBlocks();
  // The list marks no row (no segment is shown); a turn deleted and still undoable opens its chat's group, and the
  // page is live (liveView: an undo, from here or another tab, swaps it back for the turn's page).
  const chat = turnId === undefined ? undefined : stashedTurnChat(ctx.db, turnId);
  const { pane } = listPane(ctx, new URLSearchParams(), chat !== undefined ? { chat: -1, inChat: chat } : { chat: -1 });
  const gone = livePart("gone", html`<div class="head"><div class="title"><h1>No such ${what}</h1></div></div><p class="tdeleted">This ${what} was deleted or does not exist. <a href="/turns">Back to the turns</a>.</p>`, true);
  const detail = html`<div class="detail"><a class="back" href="/turns">← All chats</a>${ctx.notice ?? ""}${lb(gone)}${snackbarOnly(ctx)}</div>`;
  const { here: _here, ...still } = ctx;
  return page(`No such ${what}`, split(chat !== undefined ? ctx : still, pane, detail, true), ctx.who, "turns");
}

/** The delete UI's snackbar alone (a page with no bubbles: nothing to tick, no form; console.js puts an Undo in it). */
function snackbarOnly(ctx: PageContext): Raw {
  if (!ctx.csrf) return raw("");
  return html`<div class="delui" data-csrf="${ctx.csrf}"><div class="snack" role="status" hidden><span class="swhat"></span><button type="button" class="sundo">Undo</button><span class="sline" aria-hidden="true"></span></div></div>`;
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
  const side = e.kind === "message" && o.me !== undefined && (e.payload as unknown as MessagePayload).from.id === o.me ? "you" : "other";
  return pickable(e, side, html`<div class="${cls}" id="e${e.seq}"><div class="who">${who}${meta}</div>${body}</div>`);
}

/** Something she sent: a right bubble (a message) or a pill (a reaction, a sticker, a file). */
function outgoing(e: ChatEvent, tz: string, opts: { via?: string; lookup?: (seq: number) => ChatEvent | undefined } = {}): Raw {
  return pickable(e, "her", outgoingBody(e, tz, opts));
}

function outgoingBody(e: ChatEvent, tz: string, opts: { via?: string; lookup?: (seq: number) => ChatEvent | undefined }): Raw {
  const meta = html`${opts.via ? html`<span>via ${opts.via}</span>` : ""}<span>${clock(e.at, tz)}</span><span class="mono">#${e.seq}</span>${deliveryStatus(e)}`;
  switch (e.kind) {
    case "bot_message": {
      const p = e.payload as unknown as BotMessagePayload;
      const to = p.replyToSeq ? opts.lookup?.(p.replyToSeq) : undefined;
      const quoted = to ? eventPreview(to.kind, to.payload) : "";
      // A reply to a message deleted since shows as no reply at all (store/deletions.ts: no trace).
      return html`<div class="bubble out" id="e${e.seq}"><div class="who">${meta}</div>${
        p.replyToSeq && to ? html`<div class="reply">↳ <a href="#e${p.replyToSeq}">#${p.replyToSeq}</a> ${quoted}</div>` : ""
      }<div class="text">${markdown(p.text)}</div></div>`;
    }
    case "bot_reaction": {
      const p = e.payload as unknown as BotReactionPayload;
      return html`<div class="pill" id="e${e.seq}" data-target="${p.targetSeq}">reacted ${p.emoji} to <a href="#e${p.targetSeq}">#${p.targetSeq}</a> <span class="meta">${deliveryStatus(e)}</span></div>`;
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
        : c.start === "switched"
          ? form === "short" ? "after a model switch" : "Another conversation, after the model was switched"
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
  const l = listParts(ctx, q, sel);
  return { pane: html`${l.filters}${lb(l.count)}<nav class="tree" data-region="list">${l.groups.map(lb)}</nav>`, ...(l.first !== undefined ? { first: l.first } : {}) };
}

/** The left pane's parts: its filters (drawn once), and the count line and each chat's group, which the live stream draws again. */
function listParts(ctx: PageContext, q: URLSearchParams, sel: Selection): { filters: Raw; count: LivePart; groups: LivePart[]; first?: number } {
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
    const head = html`<summary class="ghead${sel.chat === c.id ? " on" : ""}"><span class="gl1"><a class="gname" href="${href(`/chats/${c.id}`, f)}" title="the chat's whole log">${chatName(c)}</a><a class="ggear" href="/chats/${c.id}/settings" title="Chat settings" aria-label="${chatName(c)}: settings">⚙</a><span class="gwhen">${ago(c.lastEventAt, now)}</span></span>
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
    return livePart(`g${c.id}`, html`<details class="group${c.failed ? " has-failed" : ""}" ${open ? "open" : ""}>${head}${body}${more}</details>`, true);
  });
  const n = tree.segments;
  const count = html`<div class="count">${single ? html`<a href="${href("/turns", { ...f, chat: undefined })}">← all chats</a> · ` : ""}${n} segment${n === 1 ? "" : "s"}, ${tree.turns} turn${tree.turns === 1 ? "" : "s"}${single ? "" : ` in ${tree.groups.length} chat${tree.groups.length === 1 ? "" : "s"}, by last activity`}</div>`;
  const list = tree.groups.length ? groups : [livePart("none", empty("No turn matches that."), true)];
  return { filters, count: livePart("count", count, true), groups: list, ...(first !== undefined ? { first } : {}) };
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
  // `#call-<id>`: where Home's history links a change of hers to the call that made it (console.js opens it).
  const anchor = s.callId ? html`<span class="call-anchor" id="call-${s.callId}"></span>` : "";
  // A call the framework made itself, before the model ran (media's auto-read), says so beside its name.
  const by = s.madeBy === "framework" ? html`<span class="word" title="made by the framework before the model ran (auto-read), not by the model">⚙ framework</span>` : "";
  return html`${anchor}<details class="step tool" id="s${s.n}" ${openAttr()}><summary>${dot(status)}<span class="name">${s.name ?? "?"}</span>${by}<span class="args grow">${shownBelow ? "" : argsSummary(s.args)}</span>${
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
  const owner = { ...(group && ctx.ownerId !== undefined ? { ownerId: ctx.ownerId } : {}), ...(ctx.ownerId !== undefined ? { me: ctx.ownerId } : {}) };
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
        // A message she sent that was deleted since (store/deletions.ts): gone from the trace, without a trace.
        if (s.sent && s.outboundSeq !== null && !e) break;
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

/** A turn's rows on its own page, as one live part, its block ids its own (`scopedBlocks`). */
function turnPart(ctx: PageContext, turn: Turn, transcript: Transcript | undefined, steps: Step[], group: boolean): LivePart {
  return scopedBlocks(`t${turn.id}`, () => livePart(`t${turn.id}`, turnTrace(ctx, turn, transcript, steps, group), liveTurn(ctx.db, turn)));
}

/** May a turn's rows still change: it is running, or a message of hers in it is not sent yet. */
function liveTurn(db: Db, turn: Turn): boolean {
  return turn.status === "running" || outboundOf(db, turn.id).some((e) => e.status === "pending");
}

// ---- one turn: the system prompt and the raw input --------------------------------------------------------

function promptTab(ctx: PageContext, turn: Turn, prompt: PromptText | undefined, showDiff: boolean, link: (q: Record<string, string>) => string): Raw {
  if (!prompt) return empty(absenceText(ctx, turn));
  const prev = previousPrompt(ctx.db, turn.chatId, turn.id);
  const changed = prev && prev.prompt.hash !== prompt.hash;
  const sizes = prompt.sections.map((s) => s.end - s.start);
  const max = Math.max(1, ...sizes);
  const allId = "prompt-all";
  // The profile the turn ran under (capabilities/memory/layers.ts), recorded at its start; each section's layer below.
  const profile = turn.profile;
  const summary = html`<div class="psum"><span><b class="num">${tokens(prompt.text.length)}</b> chars · ~${short(Math.round(prompt.text.length / 4))} tokens · ${prompt.sections.length} sections · <span class="mono">${prompt.hash.slice(0, 10)}</span></span>
<span class="pprof">on ${profile ? html`profile <b>${profile}</b>` : "Base"}</span>
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
    const layer = s.layer;
    return html`<details ${openAttr()}><summary><span class="lbl">${s.label}${layer ? html`<span class="psrc src-${layer === "base" ? "base" : layer === "code" ? "code" : "profile"}">· ${layer}</span>` : ""}</span><span class="bar"><i style="width:${Math.max(2, Math.round((sizes[i]! / max) * 100))}%"></i></span><span class="size">${size(text)}</span></summary><div class="inner">${block("", text, { prose: true, open: true })}</div></details>`;
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

/** A turn's page: its detail (`raw`), and its header and rows as the live stream draws them again. */
function turnDetail(ctx: PageContext, turn: Turn, q: URLSearchParams, f: Filters): { raw: () => Raw; head: LivePart; trace: LivePart | null } {
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
  // The media capability's prewarms of this turn's messages, and whether a video_probe then used them.
  const pre = turnPrewarms(ctx.db, turn.chatId, turn.fromSeq, turn.toSeq);

  const facts = [
    ...(w !== null ? [html`<b>${secs(w)}</b>`] : turn.status === "running" ? [html`running for <b>${secs((Date.now() - Date.parse(turn.startedAt)) / 1000)}</b>`] : []),
    ...(turn.inputTokens !== null ? [html`<b>${tokens(turn.inputTokens)}</b> in / <b>${tokens(turn.outputTokens)}</b> out`] : [html`<span class="faint">no usage recorded</span>`]),
    ...(turn.cacheReadTokens !== null ? [html`cache <b>${short(turn.cacheReadTokens)}</b> read / <b>${short(turn.cacheCreationTokens)}</b> write`] : []),
    ...(turn.costMicroUsd ? [html`<b>${usd(turn.costMicroUsd / 1e6)}</b>`] : []),
    html`${tools.length} tool call${tools.length === 1 ? "" : "s"}${refused ? html`, <span class="c-refused">${refused} refused</span>` : ""}${failedCalls ? html`, <span class="c-failed">${failedCalls} failed</span>` : ""}`,
    ...(transcript?.model ? [html`<span class="mono">${transcript.model}</span>`] : []),
    // The effort it ran at (store/models.ts `resolveEffort`), recorded at its start; none for a turn from before.
    ...(turn.effortSource
      ? [
          html`<span title="the effort the turn ran at, and where it came from">effort <b>${turn.effort ?? "model default"}</b>${
            turn.effortSource === "chat" ? " (this chat)" : turn.effortSource === "model" ? " (the model's setting)" : ""
          }</span>`,
        ]
      : []),
    ...(pre.used + pre.unused
      ? [html`<span class="prewarm" title="links in this turn's messages looked up ahead (media prewarm), and whether video_probe then used them">prewarmed: ${pre.used ? html`<b class="c-done">${pre.used} used</b>` : ""}${pre.used && pre.unused ? " / " : ""}${pre.unused ? html`<b class="c-stopped">${pre.unused} unused</b>` : ""}</span>`]
      : []),
  ];
  // Where the turn's time went (timeline.ts), on the Conversation tab only: its bars link to the chips there.
  const times = tab === "conversation" ? turnTimes(turn, steps, outboundOf(ctx.db, turn.id), ctx.now ?? Date.now()) : null;
  const waterfall = times ? turnWaterfall(times, argsSummary) : null;
  const headRaw = html`<div class="head">
<a class="back" href="${href("/turns", f)}">← All chats</a>
<div class="title">${badge(turn.status)}<h1>Turn ${turn.id}</h1><a href="/chats/${chat.id}#e${turn.toSeq}">${chatName(chat)}</a>${settingsLink(chat.id)}<span class="meta" title="${when(turn.startedAt, ctx.timeZone, true)}">${when(turn.startedAt, ctx.timeZone)} · ${ago(turn.startedAt, ctx.now)}</span>
<span class="nav">${prev ? html`<a href="${href(`/turns/${prev}`, f)}" title="the chat's previous turn">‹ turn ${prev}</a>` : ""}${next ? html`<a href="${href(`/turns/${next}`, f)}" title="the chat's next turn">turn ${next} ›</a>` : ""}</span>${
    html`<a class="btn danger tdelbtn" hx-boost="false" href="${turnDeleteHref(turn.id, ctx.here)}" data-turn="${turn.id}" title="Delete this turn, the messages it answered and what it wrote">Delete this turn</a>`
  }</div>
${trigger ? html`<p class="trigger">Triggered by ${eventPreview(trigger.kind, trigger.payload)} <span class="mono">#${trigger.seq}</span></p>` : ""}
${place ? html`<p class="trigger context">In <a href="${href(`/segments/${place.id}`, f)}">the segment of ${when(turnById(ctx.db, place.id)?.startedAt, ctx.timeZone)}</a> (turn ${place.turnIds.indexOf(turn.id) + 1} of ${place.turnIds.length}), of <a href="${href(`/conversations/${place.conversation.id}`, f)}">${inSentence(conversationLabel(place.conversation))}</a></p>` : ""}
<p class="facts">${facts.map((x, i) => html`${i ? html`<span class="sep"></span><wbr>` : ""}<span class="fact">${x}</span>`)}</p>
${waterfall ?? ""}
${turn.error ? html`<div class="banner">${turn.status === "stopped" ? "Stopped" : "Why it ended that way"}<span class="mono">${turn.error}</span></div>` : ""}
</div>`;
  const head = livePart("head", headRaw, true);
  const trace = tab === "conversation" ? turnPart(ctx, turn, transcript, steps, chat.kind === "group") : null;
  const detail = () => {
    const tabs = html`<nav class="tabs">${TABS.map((t) => html`<a class="${t.id === tab ? "on" : ""}" href="${link(t.id === "conversation" ? {} : { tab: t.id })}">${t.label}${t.id === "prompt" && prompt ? html` <span class="meta">${size(prompt.text)}</span>` : ""}</a>`)}<span class="aside"><a href="${link(expandAll ? (tab === "conversation" ? {} : { tab }) : { ...(tab === "conversation" ? {} : { tab }), expand: "1" })}">${expandAll ? "collapse all" : "expand all"}</a> · j / k: next / previous turn</span></nav>`;
    const body = tab === "prompt" ? promptTab(ctx, turn, prompt, q.get("diff") === "1", link) : tab === "raw" ? rawTab(ctx, turn, transcript, steps) : html`<div class="trace" data-region="trace">${lb(trace!)}</div>`;
    const del = tab === "conversation";
    return html`<div class="detail">${lb(head)}${tabs}${del ? (ctx.notice ?? "") : ""}<div class="panel turnpanel">${body}</div>${del ? deleteBar(ctx) : ""}</div>`;
  };
  return { raw: detail, head, trace };
}

// ---- the model a turn ran on, on its divider ---------------------------------------------------------------------

/**
 * Names the model of each turn on a page's dividers, and marks a switch: a turn's model (its transcript's
 * `model`, as the driver reported it) by its catalog label when the catalog still has THAT model: matched by the
 * catalog id, the provider's own model name, or that name with only a version suffix an API adds to it (a date,
 * `-20250929`, or `-latest`: `claude-sonnet-4-5` for `claude-sonnet-4-5-20250929`). Any other suffix is another
 * model (`gpt-4o-mini` is not `gpt-4o`), shown as recorded; so is a model the catalog no longer has. Nothing for a
 * turn without a transcript. When it differs from the model of the turn before it on the same page (the last one
 * that had one), it is shown as "→ name" in the accent, so a switch is seen at a glance. One per page: it reads the
 * catalog once and remembers the last model.
 *
 * Not handled, on purpose: a switch is marked within a page only (the first turn of a page is never marked, even
 * when the turn before it, on the previous page, ran on another model); and the transcript records only the
 * provider's model name, so the same name on two providers (two Claude logins, say) reads as the first provider's
 * entry, and a switch between them is not seen.
 */
export function turnModels(db: Db): (model: string | null | undefined) => Raw {
  const catalog = listModels(db);
  let last: string | null = null;
  return (model) => {
    if (!model) return html``;
    const versionOf = (c: (typeof catalog)[number]) => model.startsWith(`${c.model.model}-`) && /^-(\d{8}|latest)$/.test(model.slice(c.model.model.length));
    const m = catalog.find((c) => c.id === model) ?? catalog.find((c) => c.model.model === model) ?? catalog.find(versionOf);
    const name = m ? (m.model.label ?? m.id) : model;
    const switched = last !== null && last !== model;
    const from = last;
    last = model;
    return switched
      ? html`<span class="tmodel switched" title="${model}; the turn before ran on ${from}">→ ${name}</span>`
      : html`<span class="tmodel" title="${model}">${name}</span>`;
  };
}

// ---- a segment, or a whole conversation ------------------------------------------------------------------------

/**
 * What the live stream keeps of a segment or conversation between two of its frames (live.ts): each turn's part,
 * what it was drawn under, and the messages shown up to it (`seen`), so a frame draws again only the turns that
 * changed and those after one whose `seen` did.
 */
export type SpanCache = Map<number, { key: string; part: LivePart; seenAfter: number[]; model: string | null }>;

/**
 * A segment, or a conversation, as one continuous exchange: each turn opens with a thin divider (its number,
 * outcome, duration, cost, and a link to the turn's own view), then its rows; in a conversation, a time gap
 * between segments is a divider too, and a compaction is marked where it happened. Returns the detail (`raw`), and
 * its header and each turn's part as the live stream draws them again; with `cache`, a turn not in `changed` is
 * taken from it when nothing before it changed.
 */
function spanDetail(
  ctx: PageContext,
  sp: Span,
  level: "segment" | "conversation",
  q: URLSearchParams,
  f: Filters,
  cache?: SpanCache,
  changed: ReadonlySet<number> | "all" = "all",
): { raw: () => Raw; head: LivePart; turns: LivePart[] } {
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
  // Where the span's time went (timeline.ts): its recorded turns on one axis, the silences between them folded.
  const now = ctx.now ?? Date.now();
  const written = outboundOfTurns(ctx.db, sp.turnIds);
  const lanes = spanTimeline(
    turns.map((t) => turnTimes(t, allSteps.get(t.id) ?? [], written.get(t.id) ?? [], now)).filter((x): x is TurnTimes => x !== null),
    ctx.timeZone,
    argsSummary,
    (id) => href(`/turns/${id}`, f),
  );
  const headRaw = html`<div class="head">
<a class="back" href="${href("/turns", f)}">← All chats</a>
<div class="title">${badge(outcome)}<h1>${title}</h1><a href="${href(`/chats/${chat.id}`, f)}#e${first.toSeq}">${chatName(chat)}</a>${settingsLink(chat.id)}
<span class="nav">${sp.prev ? html`<a href="${href(`${base}/${sp.prev}`, f)}" title="the chat's previous ${level}">‹ earlier</a>` : ""}${sp.next ? html`<a href="${href(`${base}/${sp.next}`, f)}" title="the chat's next ${level}">later ›</a>` : ""}</span></div>
${context}
<p class="facts">${facts.map((x, i) => html`${i ? html`<span class="sep"></span><wbr>` : ""}<span class="fact">${x}</span>`)}</p>
${filtered ? html`<p class="trigger context"><span class="c-accent">${matches.size} of ${turns.length} turns</span> match the filter; they are marked below.</p>` : ""}
${missing.length ? html`<p class="note left">${absenceOf(ctx, missing, turns.length)}</p>` : ""}
${lanes ?? ""}
</div>`;
  const head = livePart("head", headRaw, true);
  const aside = html`<nav class="tabs"><span class="on">${level === "segment" ? "Segment" : "Conversation"}</span><span class="aside"><a href="${href(`${base}/${sp.id}`, expandAll ? f : { ...f, expand: "1" })}">${expandAll ? "collapse all" : "expand all"}</a> · j / k: next / previous segment</span></nav>`;

  const group = chat.kind === "group";
  const seen = new Set<number>();
  const parts: LivePart[] = [];
  // The model on each divider, and "→ <model>" where it differs from the turn before's (`turnModels` keeps the last).
  const modelOf = turnModels(ctx.db);
  let lastModel = "";
  let prevTurn: Turn | null = null;
  // Whether `seen` is what it was when the cached parts were drawn (it is, until a turn drawn again adds others).
  let same = true;
  for (const t of turns) {
    const gap =
      prevTurn && sp.segmentOf.get(t.id) !== sp.segmentOf.get(prevTurn.id)
        ? html`<div class="gapdiv"><span>${span(Date.parse(t.startedAt) - Date.parse(endOf(prevTurn)))} later · ${when(t.startedAt, ctx.timeZone)}</span></div>`
        : null;
    // What a turn's part depends on besides itself: a match, the gap before it, the model of the turn before.
    const key = `${matches.has(t.id) ? "m" : ""}|${lastModel}|${gap?.s ?? ""}`;
    const kept = cache?.get(t.id);
    if (kept && same && kept.key === key && changed !== "all" && !changed.has(t.id)) {
      modelOf(kept.model);
      if (kept.model) lastModel = kept.model;
      parts.push(kept.part);
      for (const s of kept.seenAfter) seen.add(s);
      prevTurn = t;
      continue;
    }
    let model: string | null = null;
    const part = scopedBlocks(`t${t.id}`, () => {
      const steps = allSteps.get(t.id) ?? [];
      const transcript = getTranscript(ctx.db, t.id);
      model = transcript?.model ?? null;
      const w = wall(t.startedAt, t.endedAt);
      const retry = eventsBetween(ctx.db, t.chatId, t.fromSeq, t.toSeq).some((e) => seen.has(e.seq));
      const divider = html`<div class="tdiv${matches.has(t.id) ? " match" : ""}"><a href="${href(`/turns/${t.id}`, f)}">${dot(t.status)}turn ${t.id}</a><span class="c-${t.status}">${t.status}</span>${w !== null ? html`<span>${secs(w)}</span>` : ""}${
        t.costMicroUsd ? html`<span>${usd(t.costMicroUsd / 1e6)}</span>` : ""
      }${modelOf(transcript?.model)}${retry ? html`<span class="tag">retry</span>` : ""}${transcript ? "" : html`<span class="tag" title="${absenceText(ctx, t)}">messages only</span>`}${matches.has(t.id) ? html`<span class="tag trig">match</span>` : ""}<span class="tlinks"><a class="tabs-link" href="${href(`/turns/${t.id}`, { ...f, tab: "prompt" })}">prompt</a><a class="tabs-link" href="${href(`/turns/${t.id}`, { ...f, tab: "raw" })}">raw</a></span></div>`;
      return livePart(`t${t.id}`, [...(gap ? [gap] : []), divider, ...turnTrace(ctx, t, transcript, steps, group, { seen })], liveTurn(ctx.db, t));
    });
    if (model) lastModel = model;
    const seenAfter = [...seen];
    if (kept && kept.seenAfter.join(",") !== seenAfter.join(",")) same = false;
    if (!kept) same = false;
    cache?.set(t.id, { key, part, seenAfter, model });
    parts.push(part);
    prevTurn = t;
  }
  const raw = () => html`<div class="detail">${lb(head)}${aside}${ctx.notice ?? ""}<div class="panel"><div class="trace" data-region="trace">${parts.map(lb)}</div></div>${deleteBar(ctx)}</div>`;
  return { raw, head, turns: parts };
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
  return page(level === "segment" ? "Segment" : "Conversation", split(ctx, pane, spanDetail(ctx, sp, level, q, f).raw(), true), ctx.who, "turns");
}

export const segmentPage = (ctx: PageContext, q: URLSearchParams, id: number) => spanPage(ctx, q, id, "segment");
export const conversationPage = (ctx: PageContext, q: URLSearchParams, id: number) => spanPage(ctx, q, id, "conversation");

/**
 * The left pane beside `detail`, one pane at a time on a narrow screen (`selected`: the detail's). `data-live-page`:
 * the page's own address, which console.js opens the live stream for (live.ts).
 */
function split(ctx: PageContext, pane: Raw, detail: Raw, selected: boolean): Raw {
  return html`<div class="split${selected ? " selected" : ""}"${ctx.here ? html` data-live-page="${ctx.here}"` : ""}><aside class="list-pane">${pane}</aside><main class="detail-pane">${detail}</main></div>`;
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
  if (turn) detail = turnDetail(ctx, turn, q, f).raw();
  else if (first !== undefined) {
    // Nothing selected: the newest segment in the list, beside it.
    const t = turnById(ctx.db, first);
    const sp = t ? segmentOf(ctx.db, t.chatId, first) : null;
    if (sp) detail = spanDetail(ctx, sp, "segment", q, f).raw();
  }
  return page(turn ? `Turn ${turn.id}` : "Turns", split(ctx, pane, detail, !!turn), ctx.who, "turns");
}

// ---- a chat ---------------------------------------------------------------------------------------------------

/**
 * What the live stream keeps of a chat's log between two frames (live.ts): each part as drawn, and what it was drawn
 * from, so a frame draws again only what changed.
 */
export type ChatCache = Map<string, { sig: string; part: LivePart }>;

/**
 * A chat's log as live parts, one per row: each event (`e<seq>`) and each turn's divider (`d<turn>`; a turn whose
 * divider shows again further down, `d<turn>x2`, …). So a part's name never depends on where the page's window of
 * events begins, and a new message is a new part, not a change to a run. An event may still change while it is not sent yet, while its turn
 * runs, or while no turn has taken it in (it may get a divider and lose its "unseen"); a divider while its turn runs.
 * With `cache`, a part whose inputs are the same as when it was drawn is taken from it.
 */
function chatParts(ctx: PageContext, chat: ConsoleChat, q: URLSearchParams, events: ChatEvent[], cache?: ChatCache): LivePart[] {
  const spans = chatTurnSpans(ctx.db, chat.id);
  const byId = new Map(spans.map((s) => [s.id, s]));
  // An inbound event is placed with the first turn that took it in, so the dividers stay in order; a retry
  // after a failure answers it again, and its own divider follows the failed turn's.
  const turnOf = (e: ChatEvent) => ((OUTBOUND_KINDS as string[]).includes(e.kind) ? e.turnId : spans.find((t) => t.fromSeq < e.seq && e.seq <= t.toSeq)?.id) ?? null;
  // The model on each divider, in order ("→ <model>" where it changed).
  const modelOf = turnModels(ctx.db);
  const models = turnModelsOf(ctx.db, spans.map((s) => s.id));
  const filters = currentFilters(q);
  const parts: LivePart[] = [];
  const take = (k: string, sig: string, live: boolean, draw: () => Raw) => {
    const kept = cache?.get(k);
    if (kept && kept.sig === sig) {
      if (kept.part.live !== live) kept.part = { ...kept.part, live };
      parts.push(kept.part);
      return;
    }
    const part = scopedBlocks(k, () => livePart(k, draw(), live));
    cache?.set(k, { sig, part });
    parts.push(part);
  };
  let current: number | null = null;
  const dividers = new Map<number, number>();
  for (const e of events) {
    const t = turnOf(e);
    if (t !== null && t !== current) {
      const nth = (dividers.get(t) ?? 0) + 1;
      dividers.set(t, nth);
      const s = byId.get(t);
      const w = s ? wall(s.startedAt, s.endedAt) : null;
      const model = modelOf(models.get(t));
      const sig = JSON.stringify([t, s?.status, w, s?.costMicroUsd, model.s, filters]);
      take(`d${t}${nth > 1 ? `x${nth}` : ""}`, sig, s?.status === "running", () =>
        html`<div class="divider" data-turn="${t}"><a href="${href(`/turns/${t}`, filters)}">${dot(s?.status ?? "")}turn ${t}${s ? ` · ${s.status}` : ""}${w !== null ? ` · ${secs(w)}` : ""}${s?.costMicroUsd ? ` · ${usd(s.costMicroUsd / 1e6)}` : ""}</a>${model}${s ? turnMenu(ctx, t) : ""}</div>`,
      );
    }
    if (t !== null) current = t;
    const out = (OUTBOUND_KINDS as string[]).includes(e.kind);
    const unseen = t === null && e.seq > chat.cursorSeq;
    const lookup = (seq: number) => events.find((x) => x.seq === seq) ?? eventBySeq(ctx.db, seq);
    const quoted = out && e.kind === "bot_message" ? (e.payload as unknown as BotMessagePayload).replyToSeq : undefined;
    const to = quoted ? lookup(quoted) : undefined;
    const sig = JSON.stringify([e.kind, e.status, e.note, e.payload, unseen, to ? [to.kind, to.payload] : null]);
    const live = e.status === "pending" || (t !== null && byId.get(t)?.status === "running") || unseen;
    take(`e${e.seq}`, sig, live, () =>
      out
        ? outgoing(e, ctx.timeZone, { lookup })
        : incoming(e, ctx.timeZone, {
            ...(chat.kind === "group" && ctx.ownerId !== undefined ? { ownerId: ctx.ownerId } : {}),
            ...(ctx.ownerId !== undefined ? { me: ctx.ownerId } : {}),
            ...(unseen ? { tags: [html`<span class="tag">unseen</span>`] } : {}),
          }),
    );
  }
  // Parts that fell off the window are not kept.
  if (cache && cache.size > parts.length * 2 + 64) for (const k of [...cache.keys()]) if (!parts.some((p) => p.k === k)) cache.delete(k);
  return parts;
}

/** The model each turn's transcript names, in one query (`turnModels` draws it). */
function turnModelsOf(db: Db, ids: number[]): Map<number, string | null> {
  const out = new Map<number, string | null>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db.$client.query(`select turn_id as id, model from turn_transcripts where turn_id in (${chunk.map(() => "?").join(",")})`).all(...chunk) as { id: number; model: string | null }[];
    for (const r of rows) out.set(r.id, r.model);
  }
  return out;
}

/** A chat's page: its detail (`raw`), and its header and parts as the live stream draws them again (none on an earlier page of it). */
function chatDetail(ctx: PageContext, chat: ConsoleChat, q: URLSearchParams, cache?: ChatCache): { raw: () => Raw; head: LivePart; runs: LivePart[] | null; since: number } {
  const b = q.get("before");
  const before = b && /^\d+$/.test(b) ? Number(b) : undefined;
  const { events, more } = chatEventsPage(ctx.db, chat.id, EVENTS_PER_PAGE, before);
  const spans = chatTurnSpans(ctx.db, chat.id);
  const runs = chatParts(ctx, chat, q, events, cache);
  const first = events[0]?.seq;
  const failed = spans.filter((t) => t.status === "failed").length;
  const head = livePart(
    "head",
    html`<div class="head"><div class="title"><h1>${chatName(chat)}</h1><span class="meta">${chat.kind === "group" ? "group" : "direct chat"}</span>${settingsLink(chat.id)}</div>
<p class="facts">telegram <span class="mono">${chat.tgChatId}</span><span class="sep"></span>cursor <span class="mono">#${chat.cursorSeq}</span><span class="sep"></span>${
      chat.backendSessionId ? html`conversation with <b>${short(chat.contextTokens)}</b> tokens of context` : "a fresh conversation next"
    }<span class="sep"></span><a href="${href("/turns", { chat: chat.id })}">${spans.length} turn${spans.length === 1 ? "" : "s"}</a>${failed ? html`, <span class="c-failed">${failed} failed</span>` : ""}</p></div>`,
    true,
  );
  // An earlier page of the log does not grow: only the newest is live.
  const live = before === undefined;
  const raw = () => html`<div class="detail">
<a class="back" href="${href("/turns", currentFilters(q))}">← All chats</a>
${lb(head)}
${ctx.notice ?? ""}
<div class="panel">
${more && first ? html`<p class="note"><a href="${href(`/chats/${chat.id}`, { ...currentFilters(q), before: first })}">Earlier events</a></p>` : ""}
${events.length ? html`<div class="convo"${live ? html` data-region="trace"` : ""}>${runs.map(lb)}</div>` : html`${empty("Nothing recorded in this chat.")}${live ? html`<div class="convo" data-region="trace"></div>` : ""}`}
</div>${deleteBar(ctx)}</div>`;
  return { raw, head, runs: live ? runs : null, since: more && first ? first - 1 : 0 };
}

/**
 * A chat as a conversation, on the right of the same list (its group open and marked): the chat's header in the
 * list leads here, each turn's divider leads back to that turn.
 */
export function chatPage(ctx: PageContext, chatId: number, q: URLSearchParams = new URLSearchParams()): string | null {
  resetBlocks();
  const chat = chatById(ctx.db, chatId);
  if (!chat) return null;
  const detail = chatDetail(ctx, chat, q).raw();
  const { pane } = listPane(ctx, q, { chat: chat.id, inChat: chat.id });
  return page(chatName(chat), split(ctx, pane, detail, true), ctx.who, "turns");
}

// ---- the live stream's frames -----------------------------------------------------------------------------------

/**
 * What one frame of a live page holds (live.ts), of what it was asked to draw: its fixed parts (the detail's header,
 * the list's count line), its trace's parts in order (a segment's or conversation's turns, a turn's rows, a chat's
 * rows; absent: not drawn, or none is live here), and the list's groups in order (absent: not drawn). `newer`: on
 * `/turns` with nothing selected, a newer segment is now the one a load would show (the page offers to load it; it
 * never loads by itself). `turnIds`: the turns of the page's chat that exist now; a turn's part or divider the page
 * has for any other (deleted) is taken out, and put back with an undo. `swap`: what a load of a turn's, a segment's or
 * a conversation's page now shows: the page itself, or the plain page of one that is not there (deleted); a page
 * showing the other is told to swap (live.ts).
 */
export interface LiveFrame {
  fixed: LivePart[];
  trace?: LivePart[];
  list?: LivePart[];
  newer?: boolean;
  turnIds?: ReadonlySet<number>;
  swap?: "page" | "gone";
  /** A chat's log: its trace holds every event after this seq (0: the whole log); one the page has from there on and the trace lacks is gone. */
  since?: number;
}

/** The turns of chat `chatId` that exist now (a frame's `turnIds`). */
function turnIdsOf(db: Db, chatId: number): Set<number> {
  return new Set((db.$client.query("select id from turns where chat_id = ?").all(chatId) as { id: number }[]).map((r) => r.id));
}

/** The chat of a deleted turn still waiting out its undo (its page can come back), else undefined. */
export function stashedTurnChat(db: Db, turnId: number): number | undefined {
  return (db.$client.query("select chat_id as c from deleted_turns where id = ?").get(turnId) as { c: number } | null)?.c;
}

/** What a frame is to draw: the detail (with the turns that changed since the last one; "all": every one), the list. */
export interface LiveWant {
  detail?: ReadonlySet<number> | "all";
  list?: boolean;
}

/** A page the live stream follows: the chat it is about (none: only the list changes), and how to draw a frame of it. */
export interface LiveView {
  chatId?: number;
  frame(ctx: PageContext, want: LiveWant): LiveFrame | null;
}

/**
 * The live view of the page at `path` (`?q`), drawn by the same functions as the page itself, so a live page and a
 * reloaded one are the same. Null: a page that is not live (Home, Settings, a chat's settings, an unknown one).
 */
export function liveView(ctx: PageContext, path: string, q: URLSearchParams): LiveView | null {
  const f = currentFilters(q);
  const begin = (c: PageContext) => {
    resetBlocks();
    expandAll = q.get("expand") === "1";
    return c;
  };
  /** The frame's list part, when asked for. */
  const withList = (c: PageContext, want: LiveWant, sel: Selection, out: LiveFrame): LiveFrame => {
    if (!want.list) return out;
    const l = listParts(c, q, sel);
    return { ...out, fixed: [...out.fixed, l.count], list: l.groups };
  };
  const span = /^\/(segments|conversations)\/(\d+)$/.exec(path);
  const turn = /^\/turns\/(\d+)$/.exec(path);
  const chat = /^\/chats\/(\d+)$/.exec(path);
  if (span || path === "/turns") {
    const level = span?.[1] === "conversations" ? "conversation" : "segment";
    const cache: SpanCache = new Map();
    // On /turns, the newest segment in the list, which the page shows. When another is the newest, the page keeps
    // showing (and following) this one, marked in the list as chosen, and is told there is newer activity.
    const shown = span ? undefined : listParts(begin(ctx), q, {}).first;
    const id = span ? Number(span[2]) : shown;
    const t0 = id !== undefined ? turnById(ctx.db, id) : undefined;
    // A segment or conversation named by a deleted turn: its page is the plain one, live while the undo can bring it back.
    const chatId = t0?.chatId ?? (span ? stashedTurnChat(ctx.db, id!) : undefined);
    if (span && chatId === undefined) return null;
    let newerSeen = false;
    return {
      ...(chatId !== undefined ? { chatId } : {}),
      frame(c, want) {
        begin(c);
        const now = id !== undefined ? turnById(c.db, id) : undefined;
        if (span && !now) return { fixed: [], swap: "gone" };
        // On /turns, the segment shown was deleted: a load would show another, offered as newer activity.
        const newer = !span && ((want.list && listParts(c, q, {}).first !== shown) || (t0 !== undefined && !now));
        if (newer) newerSeen = true;
        const sp = !now ? null : level === "segment" ? segmentOf(c.db, now.chatId, now.id) : conversationOf(c.db, now.chatId, now.id);
        const sel: Selection = !sp ? {} : !span ? (newerSeen ? { segment: sp.id, inChat: sp.chatId } : {}) : level === "segment" ? { segment: sp.id, inChat: sp.chatId } : { conversation: sp.id, inChat: sp.chatId };
        const out: LiveFrame = { fixed: [], ...(newer ? { newer: true } : {}), ...(span ? { swap: "page" as const } : {}), ...(chatId !== undefined ? { turnIds: turnIdsOf(c.db, chatId) } : {}) };
        if (!sp || !want.detail) return withList(c, want, sel, out);
        const d = spanDetail(c, sp, level, q, f, cache, want.detail);
        return withList(c, want, sel, { ...out, fixed: [d.head], trace: d.turns });
      },
    };
  }
  if (turn) {
    const id = Number(turn[1]);
    const chatId = turnById(ctx.db, id)?.chatId ?? stashedTurnChat(ctx.db, id);
    if (chatId === undefined) return null;
    return {
      chatId,
      frame(c, want) {
        begin(c);
        const t = turnById(c.db, id);
        // Deleted: a load shows the plain page now; undone: the turn's page again.
        if (!t) return { fixed: [], swap: "gone" };
        if (!want.detail) return withList(c, want, { turn: t }, { fixed: [], swap: "page" });
        const d = turnDetail(c, t, q, f);
        return withList(c, want, { turn: t }, { fixed: [d.head], ...(d.trace ? { trace: [d.trace] } : {}), swap: "page" });
      },
    };
  }
  if (chat) {
    const id = Number(chat[1]);
    if (!chatById(ctx.db, id)) return null;
    const cache: ChatCache = new Map();
    return {
      chatId: id,
      frame(c, want) {
        begin(c);
        const ch = chatById(c.db, id);
        if (!ch) return null;
        const sel: Selection = { chat: id, inChat: id };
        if (!want.detail) return withList(c, want, sel, { fixed: [] });
        const d = chatDetail(c, ch, q, cache);
        return withList(c, want, sel, { fixed: [d.head], ...(d.runs ? { trace: d.runs, since: d.since } : {}), turnIds: turnIdsOf(c.db, id) });
      },
    };
  }
  return null;
}
