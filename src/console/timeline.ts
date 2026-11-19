import type { ChatEvent } from "../store/events.ts";
import type { Step } from "../store/transcripts.ts";
import type { Turn } from "../store/turns.ts";
import { html, type Raw } from "./html.ts";

/**
 * Where a turn's time went, drawn as a timeline at the top of a page (DESIGN.md "Timeline"): on a segment or a
 * conversation, four lanes (In / Model / Tools / Out) across all its turns, the silences between turns folded; on
 * a turn, a waterfall (the model's row, then a row per tool call). Server-rendered, positions in percent, no
 * script: each tool's bar is a link to its call's chip below (`#call-<id>`, which console.js opens), and its
 * details are in the bar's `title`.
 *
 * THE MODEL'S TIME IS DERIVED. The transcript records each tool call from its start to its end, and each thinking
 * stretch and text block, but not the rest of what the model does (waiting for its first token, writing a tool
 * call's arguments). So: the model's time is the turn's wall time minus the time at least one tool was running
 * (parallel calls counted once), and Model + Tools is the turn's wall time exactly. Inside the model's time, the
 * recorded thinking and text are drawn solid and the rest faint ("waiting").
 *
 * A turn still running is drawn up to `now`; a call with no result is drawn to the turn's end (or `now`). A turn
 * without a transcript has no steps and is not drawn; a span with none of its turns recorded has no timeline.
 */

/** An interval in epoch milliseconds. */
type Iv = readonly [number, number];

export type ModelKind = "think" | "text" | "wait";
export type ToolState = "ok" | "error" | "threw" | "refused" | "running";

export interface ToolBar {
  a: number;
  b: number;
  name: string;
  args: string;
  state: ToolState;
  callId: string | null;
  /** True when the call has no result: drawn to the turn's end, or to now while the turn runs. */
  open: boolean;
}

export interface TurnTimes {
  turnId: number;
  start: number;
  end: number;
  running: boolean;
  model: { a: number; b: number; kind: ModelKind }[];
  tools: ToolBar[];
  /** Messages in: the turn's start (what opened it), then each mid-turn append. */
  in: number[];
  /** Her messages, stickers and files, when each was written (not those whose send failed). */
  out: number[];
  /** Wall time, the model's share of it, of which recorded (thinking + text), and the tools' (union). */
  wallMs: number;
  modelMs: number;
  genMs: number;
  toolMs: number;
}

/** The union of intervals, sorted and merged. */
export function union(ivs: readonly Iv[]): [number, number][] {
  const s = ivs.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of s) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

const total = (ivs: readonly Iv[]) => ivs.reduce((n, [a, b]) => n + (b - a), 0);

/** [start, end] minus the intervals (which must be a union: sorted, disjoint). */
function complement(start: number, end: number, ivs: readonly Iv[]): [number, number][] {
  const out: [number, number][] = [];
  let at = start;
  for (const [a, b] of ivs) {
    if (a > at) out.push([at, Math.min(a, end)]);
    at = Math.max(at, b);
    if (at >= end) break;
  }
  if (at < end) out.push([at, end]);
  return out.filter(([a, b]) => b > a);
}

const OUT_KINDS = new Set(["bot_message", "bot_sticker", "bot_file"]);

/** Where one turn's time went, from its steps and the messages it wrote. Null for a turn without steps. */
export function turnTimes(turn: Turn, steps: readonly Step[], outbound: readonly ChatEvent[], now: number): TurnTimes | null {
  if (!steps.length) return null;
  const start = Date.parse(turn.startedAt);
  const running = turn.status === "running" && !turn.endedAt;
  const lastStep = Math.max(...steps.map((s) => Date.parse(s.endedAt ?? s.at)));
  const end = Math.max(start, turn.endedAt ? Date.parse(turn.endedAt) : running ? now : lastStep);
  const clamp = (t: number) => Math.min(end, Math.max(start, t));

  const tools: ToolBar[] = steps
    .filter((s) => s.kind === "tool")
    .map((s) => {
      const open = !s.endedAt;
      return {
        a: clamp(Date.parse(s.at)),
        b: open ? end : clamp(Date.parse(s.endedAt!)),
        name: s.name ?? "?",
        args: s.args ?? "",
        state: (s.status ?? "running") as ToolState,
        callId: s.callId,
        open,
      };
    });
  const busy = union(tools.map((t) => [t.a, t.b] as const));
  const toolMs = total(busy);
  const free = complement(start, end, busy);
  const gen = steps
    .filter((s) => (s.kind === "thinking" || s.kind === "text") && s.endedAt)
    .map((s) => ({ a: clamp(Date.parse(s.at)), b: clamp(Date.parse(s.endedAt!)), kind: (s.kind === "thinking" ? "think" : "text") as ModelKind }))
    .sort((u, v) => u.a - v.a);
  // The recorded stretches, cut to where no tool runs (the model's time is never counted twice, and never inside
  // a tool's), and the rest of the free time as waiting.
  const model: TurnTimes["model"] = [];
  for (const [a, b] of free) {
    let at = a;
    for (const g of gen) {
      const x = Math.max(at, g.a);
      const y = Math.min(b, g.b);
      if (y <= x) continue;
      if (x > at) model.push({ a: at, b: x, kind: "wait" });
      model.push({ a: x, b: y, kind: g.kind });
      at = y;
    }
    if (b > at) model.push({ a: at, b, kind: "wait" });
  }
  const genMs = total(model.filter((m) => m.kind !== "wait").map((m) => [m.a, m.b] as const));
  return {
    turnId: turn.id,
    start,
    end,
    running,
    model,
    tools,
    in: [start, ...steps.filter((s) => s.kind === "append").map((s) => clamp(Date.parse(s.at)))],
    // Written, whether delivered yet or not (`pending` while the sender works); a send that failed was never hers to see.
    out: outbound.filter((e) => OUT_KINDS.has(e.kind) && e.status !== "failed").map((e) => clamp(Date.parse(e.at))),
    wallMs: end - start,
    modelMs: end - start - toolMs,
    genMs,
    toolMs,
  };
}

// ---- formatting ----------------------------------------------------------------------------------------------

/**
 * A duration: 420 ms, 3.4s, 42s, 1m 02s, 1h 05m. Rounded once, at the precision shown, before it is split into
 * units, so 119.6s is "2m 00s" (never "1m 60s" or "1m 00s") and 59.6s is "1m 00s".
 */
export function dur(ms: number): string {
  if (ms <= 0) return "0s";
  if (ms < 999.5) return `${Math.round(ms)} ms`;
  if (ms < 9950) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  const m = Math.round(ms / 60_000);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
/** A position as a CSS percentage, rounded so the page's hash does not move with float noise. */
const p = (x: number) => `${Math.round(x * 100) / 100}%`;

function clockOf(ms: number, timeZone: string): string {
  return new Date(ms).toLocaleTimeString("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/** The tools that took longest, summed per name: "bash 1m 02s · read_link 8.0s". */
function topTools(tools: readonly ToolBar[], n: number): { name: string; ms: number }[] {
  const by = new Map<string, number>();
  for (const t of tools) by.set(t.name, (by.get(t.name) ?? 0) + (t.b - t.a));
  return [...by.entries()]
    .map(([name, ms]) => ({ name, ms }))
    .filter((x) => x.ms > 0)
    .sort((x, y) => y.ms - x.ms)
    .slice(0, n);
}

const key = (k: string) => html`<span class="tl-key k-${k}" aria-hidden="true"></span>`;

function toolTitle(t: ToolBar, t0: number, describe: (args: string) => string): string {
  const what = describe(t.args);
  const when = `+${dur(t.a - t0)} → ${t.open ? "no result" : `+${dur(t.b - t0)}`}`;
  return `${t.name}${what ? ` · ${what}` : ""}\n${when} · ${dur(t.b - t.a)}${t.state === "ok" ? "" : ` · ${t.state}`}`;
}

const toolClass = (t: ToolBar) => (t.state === "error" || t.state === "threw" ? "k-error" : t.state === "refused" ? "k-refused" : t.open ? "k-open" : "k-tool");

function bar(cls: string, x0: number, x1: number, title: string, link?: string): Raw {
  const style = `left:${p(x0)};width:${p(Math.max(0, x1 - x0))}`;
  return link ? html`<a class="tl-bar ${cls}" style="${style}" href="${link}" title="${title}"></a>` : html`<span class="tl-bar ${cls}" style="${style}" title="${title}"></span>`;
}

const tick = (cls: string, x: number, title: string) => html`<span class="tl-tick ${cls}" style="left:${p(x)}" title="${title}"></span>`;

// ---- a turn: the waterfall --------------------------------------------------------------------------------------

/** Above this many calls, a turn's waterfall has one row per tool name instead of one per call. */
export const ROWS_PER_CALL_MAX = 20;

/**
 * A turn's waterfall: a summary line, the model's row (thinking and text solid, waiting faint), the messages'
 * row (in: what opened it and what arrived mid-turn; out: hers), then one row per tool call in the order they
 * started (one per tool name past ROWS_PER_CALL_MAX calls), on the turn's own time axis.
 */
export function turnWaterfall(tt: TurnTimes, describe: (args: string) => string): Raw {
  const t0 = tt.start;
  const w = Math.max(1, tt.wallMs);
  const x = (t: number) => ((t - t0) / w) * 100;
  const modelBars = tt.model.map((m) => bar(`k-${m.kind}`, x(m.a), x(m.b), `${m.kind === "think" ? "thinking" : m.kind === "text" ? "writing" : "model, not recorded (waiting, or writing a call)"} · ${dur(m.b - m.a)}`));
  const msgs = [
    ...tt.in.slice(1).map((t) => tick("k-in", x(t), `a message arrived mid-turn · +${dur(t - t0)}`)),
    ...tt.out.map((t) => tick("k-out", x(t), `her message · +${dur(t - t0)}`)),
  ];
  const calls = [...tt.tools].sort((a, b) => a.a - b.a);
  const perName = calls.length > ROWS_PER_CALL_MAX;
  const rows: { label: Raw; bars: Raw[]; ms: number }[] = [];
  if (perName) {
    const names = [...new Set(calls.map((c) => c.name))];
    for (const name of names) {
      const mine = calls.filter((c) => c.name === name);
      rows.push({
        label: html`<span class="tl-name">${name}</span> <span class="tl-arg">× ${mine.length}</span>`,
        bars: mine.map((c) => bar(toolClass(c), x(c.a), x(c.b), toolTitle(c, t0, describe), c.callId ? `#call-${c.callId}` : undefined)),
        ms: total(union(mine.map((c) => [c.a, c.b] as const))),
      });
    }
  } else {
    for (const c of calls)
      rows.push({
        label: html`<span class="tl-name">${c.name}</span> <span class="tl-arg">${describe(c.args)}</span>`,
        bars: [bar(toolClass(c), x(c.a), x(c.b), toolTitle(c, t0, describe), c.callId ? `#call-${c.callId}` : undefined)],
        ms: c.b - c.a,
      });
  }
  const overlap = calls.reduce((n, c) => n + c.b - c.a, 0) - tt.toolMs;
  const top = topTools(calls, 3);
  const sum = html`<p class="tl-sum">
<span>${key("think")}Model <b>${dur(tt.modelMs)}</b> ${pct(tt.modelMs, tt.wallMs)}%</span>
<span class="faint">${key("wait")}of which not recorded ${dur(tt.modelMs - tt.genMs)}</span>
<span>${key("tool")}Tools <b>${dur(tt.toolMs)}</b> ${pct(tt.toolMs, tt.wallMs)}%${calls.length ? html` <span class="faint">(${calls.length} call${calls.length === 1 ? "" : "s"}${overlap > 0 ? ", some in parallel" : ""})</span>` : ""}</span>
${top.length ? html`<span class="faint">${top.map((t, i) => html`${i ? " · " : ""}${t.name} ${dur(t.ms)}`)}</span>` : ""}${tt.running ? html`<span class="c-running">running</span>` : ""}
</p>`;
  const axis = [0, 0.25, 0.5, 0.75, 1].map((f) => html`<span class="${f === 0 ? "first" : f === 1 ? "last" : "mid"}" style="left:${p(f * 100)}">+${dur(f * tt.wallMs)}</span>`);
  return html`<div class="timeline waterfall" aria-label="Where the turn's time went">${sum}<div class="tl-grid">
<div class="tl-label faint">Model</div><div class="tl-track">${modelBars}</div><div class="tl-dur">${dur(tt.modelMs)}</div>
${msgs.length ? html`<div class="tl-label faint">Messages</div><div class="tl-track thin">${msgs}</div><div class="tl-dur"></div>` : ""}
${rows.map((r) => html`<div class="tl-label">${r.label}</div><div class="tl-track">${r.bars}</div><div class="tl-dur">${dur(r.ms)}</div>`)}
<div></div><div class="tl-axis">${axis}</div><div></div>
</div></div>`;
}

// ---- a segment or a conversation: the lanes ---------------------------------------------------------------------

/**
 * A silence between two turns is folded into a break of fixed width when it is longer than FOLD_MS, or than
 * FOLD_SHARE of the turns' own time together (so a few seconds between turns of a few milliseconds do not take the
 * whole axis either).
 */
export const FOLD_MS = 10_000;
export const FOLD_SHARE = 0.2;
/** A break's width, in percent of the timeline; all breaks together take at most MAX_BREAKS_PCT. */
const BREAK_PCT = 1.6;
const MAX_BREAKS_PCT = 25;
/** Bars of one kind closer than this (percent) are drawn as one, so a conversation of hundreds of turns stays small. */
export const MERGE_PCT = 0.15;
/** A bar narrower than this (percent) is a sliver, which may be merged into the bar before it. */
export const SLIVER_PCT = 0.5;
/** Ticks, turn marks and breaks closer than this (percent) to the last one drawn of their kind are not drawn. */
export const THIN_PCT = 0.5;
/** A break narrower than this (percent: hundreds of folds share the axis) is not drawn; the summary says it folded. */
const MIN_BREAK_PCT = 0.2;
/** A turn narrower than this (percent) on a span's axis is too narrow to see into: it is binned with its neighbours. */
export const DETAIL_PCT = 1;
/** Neighbouring narrow turns starting within this (percent) of a bin's start share it. */
export const BIN_PCT = 0.6;

export interface Fold {
  a: number;
  b: number;
}

/**
 * The span's time axis: epoch ms → percent, with every silence between turns longer than FOLD_MS folded into a
 * break of fixed width, so a nine-minute pause does not squash the work around it.
 */
export function spanAxis(times: readonly TurnTimes[]): { x: (t: number) => number; folds: Fold[]; breakPct: number } {
  const folds: Fold[] = [];
  const busy = times.reduce((n, t) => n + t.wallMs, 0);
  const foldOver = busy > 0 ? Math.min(FOLD_MS, busy * FOLD_SHARE) : FOLD_MS;
  // A silence starts where every turn before it has ended (turns of a chat run one at a time, but never assume it).
  let ended = times[0]!.end;
  for (let i = 1; i < times.length; i++) {
    const b = times[i]!.start;
    if (b - ended > foldOver) folds.push({ a: ended, b });
    ended = Math.max(ended, times[i]!.end);
  }
  const start = times[0]!.start;
  const end = Math.max(start, ended);
  const shown = end - start - folds.reduce((n, f) => n + (f.b - f.a), 0);
  // With nothing at scale (turns of no length), the breaks share the whole axis.
  const breakPct = !folds.length ? 0 : shown > 0 ? Math.min(BREAK_PCT, MAX_BREAKS_PCT / folds.length) : 100 / folds.length;
  const per = shown > 0 ? (100 - breakPct * folds.length) / shown : 0;
  // Time shown at its scale up to t, plus the breaks passed; inside a fold, across the break linearly.
  const x = (t: number): number => {
    let ms = Math.max(0, Math.min(end, t) - start);
    let brk = 0;
    for (const f of folds) {
      if (t >= f.b) {
        ms -= f.b - f.a;
        brk += breakPct;
      } else if (t > f.a) {
        ms -= t - f.a;
        brk += ((t - f.a) / (f.b - f.a)) * breakPct;
        break;
      } else break;
    }
    return Math.min(100, Math.max(0, ms * per + brk));
  };
  return { x, folds, breakPct };
}

export interface Drawn {
  x0: number;
  x1: number;
  cls: string;
  title: string;
  link?: string;
  n: number;
  /** The turn it belongs to: bars are merged within a turn only. */
  turn?: number;
}

/**
 * Merges bars of the same class and turn that touch or nearly touch (MERGE_PCT), each class on its own (a lane's
 * classes are layered: waiting under thinking). A merged tool bar keeps its first call's link and says how many it
 * holds. Never across turns: a chain of slivers would otherwise grow into one bar across many turns and silences,
 * drawn as if the tools ran all along (dense turns are binned instead, `spanTimeline`).
 */
export function merged(bars: readonly Drawn[]): Drawn[] {
  const out: Drawn[] = [];
  const last = new Map<string, Drawn>();
  // What a merged bar is called: its first bar's "turn 7 · bash" (or "turn 7 · model").
  const heads = new Map<Drawn, string>();
  for (const b of [...bars].sort((u, v) => u.x0 - v.x0)) {
    const k = `${b.turn ?? ""}|${b.cls}`;
    const l = last.get(k);
    // Only a sliver joins the bar before it: a call wide enough to point at keeps its own bar and link.
    if (l && b.x0 - l.x1 <= MERGE_PCT && b.x1 - b.x0 < SLIVER_PCT) {
      l.x1 = Math.max(l.x1, b.x1);
      l.n += b.n;
      l.title = `${heads.get(l)} · ${l.n} ${l.cls === "k-wait" || l.cls === "k-think" ? "stretches" : "calls"}, merged at this scale`;
    } else {
      const c = { ...b };
      out.push(c);
      last.set(k, c);
      heads.set(c, b.title.split("\n")[0]!.split(" · ").slice(0, 2).join(" · "));
    }
  }
  return out;
}

/**
 * Of points in order, those at least THIN_PCT past the last one kept, each with how many it stands for (itself and
 * the ones dropped after it), so a conversation of hundreds of turns draws a few hundred marks, not thousands.
 */
export function thinned<T>(items: readonly T[], at: (t: T) => number): { item: T; n: number }[] {
  const out: { item: T; n: number }[] = [];
  for (const item of [...items].sort((u, v) => at(u) - at(v))) {
    const last = out.at(-1);
    if (last && at(item) - at(last.item) < THIN_PCT) last.n++;
    else out.push({ item, n: 1 });
  }
  return out;
}

/**
 * A segment's or a conversation's lanes: In, Model, Tools, Out across its recorded turns, with each turn's start
 * marked (its number, a link to the turn: `turnHref`, which keeps the page's filters) and the silences folded.
 * Null when none of its turns is recorded. The breaks are drawn in the Model and Tools lanes only, and ticks,
 * marks and breaks are thinned (THIN_PCT), so the head stays small: it is a live part, sent whole while a turn runs.
 */
export function spanTimeline(all: readonly TurnTimes[], timeZone: string, describe: (args: string) => string, turnHref: (id: number) => string = (id) => `/turns/${id}`): Raw | null {
  const times = all.filter(Boolean);
  if (!times.length) return null;
  const { x, folds, breakPct } = spanAxis(times);
  const wallMs = times.reduce((n, t) => n + t.wallMs, 0);
  const modelMs = times.reduce((n, t) => n + t.modelMs, 0);
  const toolMs = times.reduce((n, t) => n + t.toolMs, 0);
  const span = times.at(-1)!.end - times[0]!.start;
  const idle = span - wallMs;

  // A turn wide enough to see into is drawn step by step; narrower ones, side by side, are binned (BIN_PCT): each
  // bin one model bar and one tools bar from its start, as wide as their share of its turns' time.
  const detailed = times.filter((t) => x(t.end) - x(t.start) >= DETAIL_PCT);
  const bins: { first: TurnTimes; last: TurnTimes; x0: number; x1: number; wall: number; model: number; tool: number; calls: number; link?: string }[] = [];
  let prevCompact = false;
  for (const t of times) {
    const compact = x(t.end) - x(t.start) < DETAIL_PCT;
    if (compact) {
      const bin = bins.at(-1);
      const link = t.tools.find((c) => c.callId)?.callId;
      if (bin && prevCompact && x(t.start) - bin.x0 < BIN_PCT) {
        bin.last = t;
        bin.x1 = Math.max(bin.x1, x(t.end));
        bin.wall += t.wallMs;
        bin.model += t.modelMs;
        bin.tool += t.toolMs;
        bin.calls += t.tools.length;
        if (!bin.link && link) bin.link = `#call-${link}`;
      } else bins.push({ first: t, last: t, x0: x(t.start), x1: x(t.end), wall: t.wallMs, model: t.modelMs, tool: t.toolMs, calls: t.tools.length, ...(link ? { link: `#call-${link}` } : {}) });
    }
    prevCompact = compact;
  }
  const binName = (b: (typeof bins)[number]) => (b.first === b.last ? `turn ${b.first.turnId}` : `turns ${b.first.turnId}–${b.last.turnId}`);
  const binBar = (b: (typeof bins)[number], ms: number) => b.x0 + (b.wall > 0 ? ((b.x1 - b.x0) * ms) / b.wall : 0);
  const model = [
    ...merged(detailed.flatMap((t) => t.model.map((m) => ({ x0: x(m.a), x1: x(m.b), cls: m.kind === "wait" ? "k-wait" : "k-think", title: `turn ${t.turnId} · model · ${dur(m.b - m.a)}`, n: 1, turn: t.turnId })))),
    ...bins.filter((b) => b.model > 0).map((b) => ({ x0: b.x0, x1: binBar(b, b.model), cls: "k-think", title: `${binName(b)} · model ${dur(b.model)} of ${dur(b.wall)} (${pct(b.model, b.wall)}%)`, n: 1 })),
  ];
  const tools = [
    ...merged(
      detailed.flatMap((t) =>
        t.tools.map((c) => ({ x0: x(c.a), x1: x(c.b), cls: toolClass(c), title: `turn ${t.turnId} · ${toolTitle(c, t.start, describe)}`, ...(c.callId ? { link: `#call-${c.callId}` } : {}), n: 1, turn: t.turnId })),
      ),
    ),
    ...bins
      .filter((b) => b.tool > 0)
      .map((b) => ({ x0: b.x0, x1: binBar(b, b.tool), cls: "k-tool", title: `${binName(b)} · tools ${dur(b.tool)} of ${dur(b.wall)} (${pct(b.tool, b.wall)}%), ${b.calls} call${b.calls === 1 ? "" : "s"}`, ...(b.link ? { link: b.link } : {}), n: 1 })),
  ];
  const brks = thinned(breakPct >= MIN_BREAK_PCT ? folds : [], (f) => x(f.b)).map(({ item: f, n }) =>
    html`<span class="tl-break" style="left:${p(x(f.b) - breakPct)};width:${p(breakPct)}" title="${n > 1 ? `${n} silences between turns` : `${dur(f.b - f.a)} without a turn`}"></span>`,
  );
  const marks = thinned(times, (t) => x(t.start)).map(({ item: t }) => html`<span class="tl-turn" style="left:${p(x(t.start))}"></span>`);
  const ins = thinned(
    times.flatMap((t) => t.in.map((at, i) => ({ at, title: i ? `turn ${t.turnId} · a message arrived mid-turn` : `turn ${t.turnId} began` }))),
    (e) => x(e.at),
  ).map(({ item, n }) => tick("k-in", x(item.at), n > 1 ? `${item.title}, and ${n - 1} more` : item.title));
  const outs = thinned(
    times.flatMap((t) => t.out.map((at) => ({ at, title: `turn ${t.turnId} · her message` }))),
    (e) => x(e.at),
  ).map(({ item, n }) => tick("k-out", x(item.at), n > 1 ? `${item.title}, and ${n - 1} more` : item.title));
  // Turn numbers where there is room for them (3% apart); every turn keeps its mark.
  let lastLabel = -Infinity;
  const labels: Raw[] = [];
  for (const t of times) {
    const at = x(t.start);
    if (at - lastLabel < 3) continue;
    lastLabel = at;
    labels.push(html`<a style="left:${p(at)}" href="${turnHref(t.turnId)}" title="turn ${t.turnId} · ${dur(t.wallMs)}">${t.turnId}</a>`);
  }
  let lastGap = -Infinity;
  const gapLabels: Raw[] = [];
  for (const f of folds) {
    const at = x(f.b) - breakPct / 2;
    // Clear of the clock at each end (about 9% wide) and of the label before it.
    if (at < 9 || at > 88 || at - lastGap < 9) continue;
    lastGap = at;
    gapLabels.push(html`<span class="gap" style="left:${p(at)}">+${dur(f.b - f.a)}</span>`);
  }
  const draw = (bs: Drawn[]) => bs.map((b) => bar(b.cls, b.x0, b.x1, b.title, b.link));
  const top = topTools(
    times.flatMap((t) => t.tools),
    3,
  );
  const sum = html`<p class="tl-sum">
<span>${key("think")}Model <b>${dur(modelMs)}</b> ${pct(modelMs, wallMs)}%</span>
<span>${key("tool")}Tools <b>${dur(toolMs)}</b> ${pct(toolMs, wallMs)}%</span>
${top.length ? html`<span class="faint">${top.map((t, i) => html`${i ? " · " : ""}${t.name} ${dur(t.ms)}`)}</span>` : ""}
${idle > 0 ? html`<span class="faint">${key("idle")}between turns ${dur(idle)}${folds.length ? " (folded)" : ""}</span>` : ""}
</p>`;
  return html`<div class="timeline lanes" aria-label="Where the time went">${sum}<div class="tl-grid">
<div></div><div class="tl-turns">${labels}</div><div></div>
<div class="tl-label faint">In</div><div class="tl-track thin">${ins}</div><div></div>
<div class="tl-label faint">Model</div><div class="tl-track">${brks}${marks}${draw(model)}</div><div></div>
<div class="tl-label faint">Tools</div><div class="tl-track">${brks}${marks}${draw(tools)}</div><div></div>
<div class="tl-label faint">Out</div><div class="tl-track thin">${outs}</div><div></div>
<div></div><div class="tl-axis"><span class="first" style="left:0%">${clockOf(times[0]!.start, timeZone)}</span>${gapLabels}<span class="last" style="left:100%">${clockOf(times.at(-1)!.end, timeZone)}</span></div><div></div>
</div></div>`;
}
