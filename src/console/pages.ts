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
import { getPromptText, getTranscript, previousPrompt, stepsOf, type PromptText, type Step, type Transcript } from "../store/transcripts.ts";
import type { Turn } from "../store/turns.ts";
import { diffLines, hunks } from "./diff.ts";
import { ago, badge, block, clock, dot, empty, excerpt, href, html, markdown, page, raw, resetBlocks, secs, short, size, tokens, usd, wall, when, type Raw } from "./html.ts";
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
  turnList,
  turnTree,
  type ConsoleChat,
  type TurnFilter,
  type TurnRow,
} from "./queries.ts";

/**
 * The console's pages (DESIGN.md): one navigation, chat → turn. The left pane lists the chats, each with its
 * latest turns; the right shows the selected turn, or a chat as a conversation. Read-only: nothing here writes.
 */

export interface PageContext {
  db: Db;
  timeZone: string;
  /** Who is looking (the tailnet login), shown in the top bar. */
  who?: string;
  /** The owner's id: their lines in a group are marked. */
  ownerId?: number;
  now?: number;
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

/** What is selected in the list: a turn (shown on the right), or a chat (its conversation on the right). */
interface Selection {
  turn?: Turn;
  chat?: number;
}

/**
 * What started a turn, as its row says it under the chat's header: in a direct chat the header already names
 * the person, so just the words; in a group, who said them. A leading mention of the bot is dropped (every
 * group turn starts with one).
 */
function rowPreview(t: TurnRow): string {
  const p = parsePayload(t.triggerPayload);
  if (t.triggerKind !== "message" || !p) return eventPreview(t.triggerKind, p);
  const m = p as unknown as MessagePayload;
  const text = excerpt(m.text.replace(/^\s*@\w+[\s,:]*/, ""), 160) || m.text;
  return t.chatKind === "private" ? text : `${m.from.name}: ${text}`;
}

/** One turn under its chat's header: the chat is the header's, so a row is what started the turn. */
function turnRow(t: TurnRow, f: Filters, on: { id?: number; auto: boolean }, now: number): Raw {
  const w = wall(t.startedAt, t.endedAt);
  const meta = [
    `#${t.id}`,
    t.toolCalls ? `${t.toolCalls} tool${t.toolCalls === 1 ? "" : "s"}` : "no tools",
    ...(t.refused ? [`${t.refused} refused`] : []),
    ...(t.failedCalls ? [`${t.failedCalls} failed`] : []),
    ...(w !== null ? [secs(w)] : []),
    ...(t.costMicroUsd ? [usd(t.costMicroUsd / 1e6)] : []),
  ];
  const bad = t.status === "failed";
  return html`<a class="row${t.id === on.id ? ` on${on.auto ? " auto" : ""}` : ""}${bad ? " bad" : ""}" href="${href(`/turns/${t.id}`, f)}">
<div class="l1">${dot(t.status)}<span class="what">${rowPreview(t) || "—"}</span><span class="when" title="${t.startedAt}">${ago(t.startedAt, now)}</span></div>
<div class="l3 num">${meta.join(" · ")}</div>${bad && t.error ? html`<div class="err">${excerpt(t.error, 120)}</div>` : ""}
</a>`;
}

/**
 * The left pane: the filters, then the turns grouped under their chats, most recently active chat first, each
 * with its latest PER_CHAT matching turns ("n more" opens the chat's own list, paged). With a chat filter, that
 * one chat, paged. The chat holding the selection is open; with nothing selected, the first OPEN_GROUPS are.
 */
function listPane(ctx: PageContext, q: URLSearchParams, sel: Selection): { pane: Raw; first?: number } {
  const f = currentFilters(q);
  const filter = toFilter(f, q, ctx.timeZone);
  const now = ctx.now ?? Date.now();
  const single = filter.chat !== undefined;
  const tree = turnTree(ctx.db, filter, single ? 0 : PER_CHAT);
  let paged: { more: boolean } = { more: false };
  if (single) {
    const l = turnList(ctx.db, filter, TURNS_PER_PAGE);
    paged = l;
    for (const g of tree.groups) g.rows = l.rows;
  }
  const selChat = sel.chat ?? sel.turn?.chatId;
  // A selected turn older than its chat's latest few is shown in its place, so the list says where you are.
  if (sel.turn) {
    const g = tree.groups.find((x) => x.chat.id === sel.turn!.chatId);
    if (g && !g.rows.some((r) => r.id === sel.turn!.id)) {
      const row = turnList(ctx.db, { id: sel.turn.id }, 1).rows[0];
      if (row) g.rows = [...g.rows, row].sort((a, b) => b.id - a.id);
    }
  }
  const first = tree.groups.find((g) => g.rows.length)?.rows[0]?.id;
  const on = { ...(sel.turn ? { id: sel.turn.id } : sel.chat === undefined && first !== undefined ? { id: first } : {}), auto: !sel.turn };

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
    const hidden = c.matching - g.rows.length;
    const head = html`<summary class="ghead${sel.chat === c.id ? " on" : ""}"><span class="gl1"><a class="gname" href="${href(`/chats/${c.id}`, f)}" title="the chat as a conversation">${chatName(c)}</a><span class="gwhen">${ago(c.lastEventAt, now)}</span></span>
<span class="gmeta">${c.kind === "group" ? "group" : "direct"} · ${c.matching} turn${c.matching === 1 ? "" : "s"}${c.failed ? html` · <span class="c-failed">${c.failed} failed</span>` : ""}</span></summary>`;
    const rows = g.rows.length ? html`<div class="rows">${g.rows.map((t) => turnRow(t, f, on, now))}</div>` : html`<p class="none">No turns yet.</p>`;
    const more = single
      ? paged.more
        ? html`<a class="more-link" href="${href("/turns", { ...f, before: g.rows.at(-1)!.id })}">Older turns</a>`
        : ""
      : hidden > 0
        ? html`<a class="more-link" href="${href("/turns", { ...f, chat: c.id })}">${hidden} more in this chat</a>`
        : "";
    return html`<details class="group${c.failed ? " has-failed" : ""}" ${open ? "open" : ""}>${head}${rows}${more}</details>`;
  });
  const count = html`<div class="count">${single ? html`<a href="${href("/turns", { ...f, chat: undefined })}">← all chats</a> · ` : ""}${tree.total} turn${tree.total === 1 ? "" : "s"}${single ? "" : ` in ${tree.groups.length} chat${tree.groups.length === 1 ? "" : "s"}, by last activity`}</div>`;
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

function conversation(ctx: PageContext, turn: Turn, transcript: Transcript | undefined, steps: Step[], group: boolean): Raw {
  const t0 = Date.parse(turn.startedAt);
  const owner = group && ctx.ownerId !== undefined ? { ownerId: ctx.ownerId } : {};
  const lookup = (seq: number) => eventBySeq(ctx.db, seq);
  const at = (iso: string) => offset(Date.parse(iso) - t0);
  const shape = inputShape(transcript);
  const appended = steps.filter((s) => s.kind === "append" && s.fromSeq !== null && s.toSeq !== null);
  const inAppend = (seq: number) => appended.some((a) => seq > a.fromSeq! && seq <= a.toSeq!);
  const events = eventsBetween(ctx.db, turn.chatId, turn.fromSeq, turn.toSeq);
  const shown = events.filter((e) => (TRIGGER_KINDS as string[]).includes(e.kind) && !inAppend(e.seq)).slice(shape.unread ?? 0);
  const firstCalled = shape.called?.[0];
  const trigger = turn.triggerSeq ?? turn.toSeq;
  const rows: Raw[] = [];

  if (shape.history) rows.push(tr("", html`<p class="marker">A fresh conversation, opened with the chat's last ${shape.history} messages (see Raw input)</p>`));
  else if (transcript?.resumed) rows.push(tr("", html`<p class="marker">Resumed conversation</p>`));
  if (shape.unread) rows.push(tr("", html`<p class="marker">${shape.unread} earlier unread message${shape.unread === 1 ? "" : "s"} not shown to her</p>`));
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
      default:
        rows.push(tr(at(s.at), html`<p class="marker">${s.text ?? ""}</p>`));
    }
  }
  for (const e of outbound) if (!claimed.has(e.seq)) rows.push(tr(at(e.at), outgoing(e, ctx.timeZone, { lookup })));

  const w = wall(turn.startedAt, turn.endedAt);
  const end = turn.endedAt ? at(turn.endedAt) : "";
  if (turn.status === "running") rows.push(tr("", html`<p class="marker c-running">still running</p>`));
  else rows.push(tr(end, html`<p class="marker"><span class="c-${turn.status}">ended ${turn.status}</span>${w !== null ? html`<span class="sep"></span>${secs(w)}` : ""}</p>`));
  if (!steps.length && !shown.length) rows.unshift(tr("", empty("Nothing recorded for this turn: the transcript was pruned, or the turn never reached the model.")));
  return html`<div class="trace">${rows}</div>`;
}

// ---- one turn: the system prompt and the raw input --------------------------------------------------------

function promptTab(ctx: PageContext, turn: Turn, prompt: PromptText | undefined, showDiff: boolean, link: (q: Record<string, string>) => string): Raw {
  if (!prompt) return empty("No system prompt recorded: the transcript was pruned, or the turn never reached the model.");
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

function rawTab(turn: Turn, transcript: Transcript | undefined, steps: Step[]): Raw {
  if (!transcript) return empty("No input recorded: the transcript was pruned, or the turn never reached the model.");
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
<p class="facts">${facts.map((x, i) => html`${i ? html`<span class="sep"></span>` : ""}${x}`)}</p>
${turn.error ? html`<div class="banner">${turn.status === "stopped" ? "Stopped" : "Why it ended that way"}<span class="mono">${turn.error}</span></div>` : ""}
</div>`;
  const tabs = html`<nav class="tabs">${TABS.map((t) => html`<a class="${t.id === tab ? "on" : ""}" href="${link(t.id === "conversation" ? {} : { tab: t.id })}">${t.label}${t.id === "prompt" && prompt ? html` <span class="meta">${size(prompt.text)}</span>` : ""}</a>`)}<span class="aside"><a href="${link(expandAll ? (tab === "conversation" ? {} : { tab }) : { ...(tab === "conversation" ? {} : { tab }), expand: "1" })}">${expandAll ? "collapse all" : "expand all"}</a> · j / k: next / previous turn</span></nav>`;
  const body =
    tab === "prompt" ? promptTab(ctx, turn, prompt, q.get("diff") === "1", link) : tab === "raw" ? rawTab(turn, transcript, steps) : conversation(ctx, turn, transcript, steps, chat.kind === "group");
  return html`<div class="detail">${head}${tabs}<div class="panel">${body}</div></div>`;
}

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
  const shown = turn ?? (first !== undefined ? turnById(ctx.db, first) : undefined);
  const detail = shown ? turnDetail(ctx, shown, q, f) : empty("No turn to show.");
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
  const { pane } = listPane(ctx, q, { chat: chat.id });
  return page(chatName(chat), split(pane, detail, true), ctx.who);
}
