import { diffLines, type DiffLine } from "./diff.ts";
import { html, raw, type Raw } from "./html.ts";

/**
 * A file diff drawn the way GitHub draws one (the owner asked for it): server-rendered, so it needs no script.
 *
 *   unified   one column: the old and the new line number, a +/− sign, the line on a green or red ground, the
 *             changed words within a line on a deeper one; `@@ -a,b +c,d @@` over each hunk;
 *   split     the old file on the left, the new on the right, a removed line facing the line that replaced it.
 *
 * With `full` (what Home's history shows: the owner reads a change in its context) the whole file is drawn and
 * nothing is folded; otherwise unchanged runs longer than the context are folded behind their hunk header and open
 * in place (`<details>`). The first changed line carries `id="first-change"`, which the page scrolls to.
 * Words are compared within a changed line only when it is paired with one on the other side (a run of removed
 * lines followed by a run of added ones, matched in order, as GitHub pairs them). Text is split into words,
 * runs of space and single characters, so a CJK sentence is compared character by character.
 */

type Row =
  | { k: "same"; o: number; n: number; text: string }
  | { k: "del"; o: number; text: string; pair?: string }
  | { k: "add"; n: number; text: string; pair?: string };

/** Lines in order with their numbers, and each removed line paired with the added line that replaced it. */
function rows(before: string, after: string): Row[] {
  const lines: DiffLine[] = diffLines(before, after);
  const out: Row[] = [];
  let o = 0;
  let n = 0;
  for (let i = 0; i < lines.length; ) {
    const l = lines[i]!;
    if (l.op === "same") {
      out.push({ k: "same", o: ++o, n: ++n, text: l.text });
      i++;
      continue;
    }
    const dels: string[] = [];
    const adds: string[] = [];
    while (i < lines.length && lines[i]!.op === "del") dels.push(lines[i++]!.text);
    while (i < lines.length && lines[i]!.op === "add") adds.push(lines[i++]!.text);
    dels.forEach((t, j) => out.push({ k: "del", o: ++o, text: t, ...(adds[j] !== undefined ? { pair: adds[j] } : {}) }));
    adds.forEach((t, j) => out.push({ k: "add", n: ++n, text: t, ...(dels[j] !== undefined ? { pair: dels[j] } : {}) }));
  }
  return out;
}

/** Latin words and numbers whole, runs of space, and every other character alone (so CJK goes by character). */
function tokens(s: string): string[] {
  return [...s.matchAll(/[A-Za-z0-9_]+|\s+|./gsu)].map((m) => m[0]);
}

/** `text` with the parts not shared with `other` wrapped as changed words. */
function words(text: string, other: string | undefined): Raw {
  if (other === undefined || text === other) return html`${text}`;
  const a = tokens(text);
  const b = tokens(other);
  // Too long to compare cheaply: the whole line is the change, which is still true.
  if (a.length * b.length > 250_000) return html`${text}`;
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
  const keep = new Uint8Array(a.length);
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) keep[i++] = 1, j++;
    else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) i++;
    else j++;
  }
  // A line that shares almost nothing is one change, not a confetti of single words.
  const shared = a.reduce((s, t, i) => s + (keep[i] && t.trim() ? t.length : 0), 0);
  if (shared < Math.min(text.length, other.length) * 0.3) return html`${text}`;
  const parts: Raw[] = [];
  let run = "";
  let changed = false;
  const flush = () => {
    if (run) parts.push(changed ? html`<span class="gw">${run}</span>` : html`${run}`);
    run = "";
  };
  a.forEach((t, i) => {
    const c = !keep[i];
    if (c !== changed) flush(), (changed = c);
    run += t;
  });
  flush();
  return html`${parts}`;
}

type Piece = { kind: "rows"; rows: Row[] } | { kind: "fold"; rows: Row[]; header: string };

/** Hunks with `context` lines around each change; the unchanged runs between them folded. */
function pieces(all: Row[], context: number): Piece[] {
  const changed = all.map((r) => r.k !== "same");
  const keep = all.map((_, i) => {
    for (let k = Math.max(0, i - context); k <= Math.min(all.length - 1, i + context); k++) if (changed[k]) return true;
    return false;
  });
  const out: Piece[] = [];
  let i = 0;
  while (i < all.length) {
    const start = i;
    const kept = keep[i];
    while (i < all.length && keep[i] === kept) i++;
    const slice = all.slice(start, i);
    if (kept) out.push({ kind: "rows", rows: slice });
    else out.push({ kind: "fold", rows: slice, header: "" });
  }
  // Every hunk has its header, as on GitHub: on the fold before it when there is one (opening it shows the
  // lines the hunk skips), else a header row of its own. A fold after the last hunk just counts its lines.
  const result: Piece[] = [];
  for (const p of out) {
    if (p.kind === "fold") {
      result.push({ ...p, header: `${p.rows.length} unchanged line${p.rows.length === 1 ? "" : "s"}` });
      continue;
    }
    const first = p.rows[0]!;
    const olds = p.rows.filter((r) => r.k !== "add").length;
    const news = p.rows.filter((r) => r.k !== "del").length;
    const o = first.k === "add" ? (lastOld(all, first) ?? 0) + 1 : first.o;
    const n = first.k === "del" ? (lastNew(all, first) ?? 0) + 1 : first.n;
    const header = `@@ -${o},${olds} +${n},${news} @@`;
    const prev = result.at(-1);
    if (prev?.kind === "fold") prev.header = header;
    else result.push({ kind: "fold", rows: [], header });
    result.push(p);
  }
  return result;
}

function lastOld(all: Row[], r: Row): number | undefined {
  for (let i = all.indexOf(r) - 1; i >= 0; i--) {
    const x = all[i]!;
    if (x.k !== "add") return x.o;
  }
  return undefined;
}
function lastNew(all: Row[], r: Row): number | undefined {
  for (let i = all.indexOf(r) - 1; i >= 0; i--) {
    const x = all[i]!;
    if (x.k !== "del") return x.n;
  }
  return undefined;
}

/** The id of the first changed row (`first`), so the page can bring it into view. */
const firstId = (first: boolean) => (first ? raw(' id="first-change"') : "");

function unifiedRow(r: Row, first: boolean): Raw {
  if (r.k === "same") return html`<div class="gr"><span class="gn">${r.o}</span><span class="gn">${r.n}</span><span class="gs"> </span><span class="gt">${r.text}</span></div>`;
  if (r.k === "del") return html`<div class="gr gdel"${firstId(first)}><span class="gn">${r.o}</span><span class="gn"></span><span class="gs">-</span><span class="gt">${words(r.text, r.pair)}</span></div>`;
  return html`<div class="gr gadd"${firstId(first)}><span class="gn"></span><span class="gn">${r.n}</span><span class="gs">+</span><span class="gt">${words(r.text, r.pair)}</span></div>`;
}

/** Split view: a removed run faces the added run that follows it, line by line; blank cells fill the shorter side. */
function splitRows(rs: Row[], firstChange: Row | undefined): Raw[] {
  const out: Raw[] = [];
  const cell = (side: "l" | "r", r: Row | undefined) => {
    if (!r) return html`<span class="gn gnone"></span><span class="gt gnone"></span>`;
    if (r.k === "same") return html`<span class="gn">${side === "l" ? r.o : r.n}</span><span class="gt">${r.text}</span>`;
    const cls = r.k === "del" ? "gdel" : "gadd";
    return html`<span class="gn ${cls}">${r.k === "del" ? r.o : r.n}</span><span class="gt ${cls}">${words(r.text, r.pair)}</span>`;
  };
  for (let i = 0; i < rs.length; ) {
    const r = rs[i]!;
    if (r.k === "same") {
      out.push(html`<div class="gr gsplit">${cell("l", r)}${cell("r", r)}</div>`);
      i++;
      continue;
    }
    const dels: Row[] = [];
    const adds: Row[] = [];
    while (i < rs.length && rs[i]!.k === "del") dels.push(rs[i++]!);
    while (i < rs.length && rs[i]!.k === "add") adds.push(rs[i++]!);
    for (let j = 0; j < Math.max(dels.length, adds.length); j++) {
      const first = j === 0 && (dels[0] ?? adds[0]) === firstChange;
      out.push(html`<div class="gr gsplit"${firstId(first)}>${cell("l", dels[j])}${cell("r", adds[j])}</div>`);
    }
  }
  return out;
}

export interface GhDiff {
  html: Raw;
  add: number;
  del: number;
}

/**
 * `before` → `after` as a GitHub-style diff. `name` heads it (the file's path), with its +/− and GitHub's five
 * squares. Identical texts draw a one-line "no changes".
 */
export function ghDiff(before: string, after: string, opts: { view?: "unified" | "split"; context?: number; full?: boolean; name?: string } = {}): GhDiff {
  const view = opts.view ?? "unified";
  const all = rows(before, after);
  const add = all.filter((r) => r.k === "add").length;
  const del = all.filter((r) => r.k === "del").length;
  const head = opts.name ? html`<div class="ghead2"><span class="mono">${opts.name}</span>${counts(add, del)}</div>` : "";
  if (!add && !del) return { html: html`<div class="gdiff">${head}<p class="gempty">No changes.</p></div>`, add, del };
  const firstChange = all.find((r) => r.k !== "same");
  const draw = (rs: Row[]) => (view === "split" ? splitRows(rs, firstChange) : rs.map((r) => unifiedRow(r, r === firstChange)));
  if (opts.full) return { html: html`<div class="gdiff g-${view}">${head}<div class="gbody">${draw(all)}</div></div>`, add, del };
  const body = pieces(all, opts.context ?? 3).map((p) => {
    const drawn = draw(p.rows);
    if (p.kind === "rows") return html`${drawn}`;
    const hunk = html`<span class="gn ghn" aria-hidden="true">${p.rows.length ? "⋯" : ""}</span><span class="gt">${p.header}</span>`;
    if (!p.rows.length) return html`<div class="gr ghunk g-${view}">${hunk}</div>`;
    return html`<details class="gfold"><summary class="gr ghunk g-${view}" title="Show ${p.rows.length} unchanged lines">${hunk}</summary>${drawn}</details>`;
  });
  return { html: html`<div class="gdiff g-${view}">${head}<div class="gbody">${body}</div></div>`, add, del };
}

/** `+3 −1` and GitHub's five squares (green for added, red for removed, grey for the rest). */
export function counts(add: number, del: number): Raw {
  const total = add + del;
  const g = total ? Math.round((add / total) * 5) : 0;
  const r = total ? Math.min(5 - g, Math.round((del / total) * 5)) : 0;
  const sq = [...Array(g).fill("a"), ...Array(r).fill("d"), ...Array(5 - g - r).fill("n")] as string[];
  return html`<span class="gcount"><span class="c-done">+${add}</span> <span class="c-failed">−${del}</span><span class="gsq" aria-hidden="true">${raw(sq.map((s) => `<i class="${s}"></i>`).join(""))}</span></span>`;
}
