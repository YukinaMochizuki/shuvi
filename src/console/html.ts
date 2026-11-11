/**
 * Server-rendered HTML for the console (DESIGN.md). `html` is a tagged template that ESCAPES every value
 * interpolated into it unless the value is itself `html` output (`Raw`), so text from a chat, a tool or the
 * model can never become markup. The small components every page shares are here; numbers are formatted
 * in one place.
 */

export class Raw {
  constructor(readonly s: string) {}
  toString(): string {
    return this.s;
  }
}

export type Value = Raw | string | number | boolean | null | undefined | readonly Value[];

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function render(v: Value): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join("");
  return esc(String(v));
}

export function html(strings: TemplateStringsArray, ...values: Value[]): Raw {
  let out = strings[0]!;
  values.forEach((v, i) => (out += render(v) + strings[i + 1]!));
  return new Raw(out);
}

export const raw = (s: string) => new Raw(s);

/** A URL with query parameters, empty ones dropped. */
export function href(path: string, query: Record<string, string | number | undefined | null> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/** The shell every page is drawn in: the top bar, then `body`. */
export function page(title: string, body: Raw, who?: string): string {
  return `<!doctype html>${html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · shuvi</title>
<link rel="stylesheet" href="/style.css">
<script src="/console.js" defer></script>
</head>
<body>
<header class="topbar"><a class="brand" href="/turns">shuvi</a><span class="crumb">console</span>
${who ? html`<span class="who">${who}</span>` : ""}</header>
${body}
</body>
</html>`}`;
}

/** A small centred card in the shell: sign-in, 403, 404. */
export function cardPage(title: string, body: Raw, who?: string): string {
  return page(title, html`<main class="card"><h1>${title}</h1>${body}</main>`, who);
}

export function dot(state: string): Raw {
  return html`<span class="dot ${state}" aria-hidden="true"></span>`;
}

/** An outcome: its dot and its word, in its colour. */
export function badge(state: string, label = state): Raw {
  return html`<span class="badge c-${state}">${dot(state)}${label}</span>`;
}

export function empty(text: string): Raw {
  return html`<p class="empty">${text}</p>`;
}

/** Content longer than this many lines or characters is folded behind "Show all". */
export const FOLD_LINES = 10;
export const FOLD_CHARS = 1200;

let blockId = 0;
/**
 * A labelled block of text. Long text is folded (a faded preview that opens on click, with its size); every
 * block has a copy button (console.js, hidden without it). `prose`: sans-serif at a readable measure.
 */
export function block(label: Value, text: string, opts: { prose?: boolean; open?: boolean; extra?: Raw; unfold?: boolean } = {}): Raw {
  const id = `b${++blockId}`;
  const cls = opts.prose ? "prose" : "";
  const lines = text.split("\n").length;
  const long = lines > FOLD_LINES || text.length > FOLD_CHARS;
  const pre = html`<pre id="${id}" class="${cls}">${text}</pre>`;
  const copy = html`<button class="copy" type="button" data-copy="${id}" hidden>copy</button>`;
  const head = html`<div class="label">${label}${long ? html`<span>${size(text)} · ${lines} lines</span>` : ""}${copy}</div>`;
  if (!long || opts.open || opts.unfold) return html`<div class="block">${head}${pre}${opts.extra ?? ""}</div>`;
  return html`<div class="block">${head}<details class="fold"><summary><pre class="${cls}">${text.slice(0, 600)}</pre><span class="show more">Show all</span><span class="show less">Show less</span></summary>${pre}</details>${opts.extra ?? ""}</div>`;
}

/** Reset the block ids (one page at a time, so ids are stable for tests). */
export function resetBlocks(): void {
  blockId = 0;
}

// ---- numbers ---------------------------------------------------------------------------------------------

/** Seconds, at a precision that suits the magnitude. */
export function secs(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  if (value >= 600) return `${Math.round(value / 60)}m`;
  if (value >= 100) return `${value.toFixed(0)}s`;
  if (value >= 10) return `${value.toFixed(1)}s`;
  if (value >= 1) return `${value.toFixed(1)}s`;
  return `${Math.round(value * 1000)} ms`;
}

/**
 * Her message as Telegram shows it: the markdown the sender converts (bold, italic, inline code), on
 * escaped text, so nothing else can become markup.
 */
export function markdown(text: string): Raw {
  // Inline code is pulled out first (as telegram/format.ts does), so nothing inside it becomes bold or italic.
  const codes: string[] = [];
  const s = esc(text.replace(/\u0000/g, ""))
    .replace(/`([^`\n]+)`/g, (_, c: string) => {
      codes.push(`<code>${c}</code>`);
      return `\u0000${codes.length - 1}\u0000`;
    })
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])[_*]([^_*\n]+)[_*](?=[\s).,!?]|$)/g, "$1<em>$2</em>")
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]!);
  return raw(s);
}

/** Dollars, never rounded away: a four-cent turn and a free one are different facts. */
export function usd(value: number | null | undefined): string {
  if (!value) return "-";
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

export function tokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  return n.toLocaleString("en-US");
}

/** A count in short form: 950, 1.2k, 34k. */
export function short(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

/** A text's size: 840 B, 4.2 kB. */
export function size(s: string): string {
  const b = Buffer.byteLength(s);
  return b < 1000 ? `${b} B` : `${(b / 1000).toFixed(1)} kB`;
}

/** A time in the owner's zone, e.g. `11 Nov 21:03`. */
export function when(iso: string | null | undefined, timeZone: string, seconds = false): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("en-GB", { timeZone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: false });
}

/** A clock time in the owner's zone, e.g. `21:03`. */
export function clock(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false });
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "-";
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/** Wall time of something that started and ended, in seconds (null when it has not ended). */
export function wall(startedAt: string | null | undefined, endedAt: string | null | undefined): number | null {
  if (!startedAt || !endedAt) return null;
  return Math.max(0, (Date.parse(endedAt) - Date.parse(startedAt)) / 1000);
}

export function excerpt(s: string, n = 140): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
