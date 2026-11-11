/**
 * The text side of the home/ editing tools, shaped like Claude Code's Read / Edit / Write (and workstream's
 * read_box / write_box, src/agent/tools/text-edit.ts and file-view.ts, which this follows): numbered
 * reading, exact-string edits, a compact unified diff. No file system and no git here; ./index.ts does
 * those through ./home.ts.
 *
 * Rules this module owns:
 *   - Every edit of a batch is located against the ORIGINAL text, never against what an earlier edit of
 *     the same batch produced. Two edits that touch the same text are refused (merge them into one).
 *   - A batch is atomic: any refused edit refuses the whole batch, and the caller writes nothing.
 *   - A refusal says which edit, why, and how to fix the call; a passage that was not found points at the
 *     closest text, so she need not read the whole file again.
 *   - A trailing newline is kept as it was (`keepEnding`); a new file ends with one.
 */

export interface Edit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/** Lines returned when the caller gives no limit, and a ceiling on one read whatever the limit. */
const DEFAULT_LIMIT = 2000;
const BYTE_BUDGET = 50 * 1024;
/** Unified-diff context lines, and a cap on the diff's length. */
const DIFF_CONTEXT = 3;
const DIFF_BUDGET = 3000;

/** Split into lines without a phantom trailing "" from a final newline. */
function toLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * `text` as Claude Code's Read shows a file (`cat -n`: the line number right-aligned in six columns, a
 * tab, the line), from line `offset` (1-based, default 1), at most `limit` lines. A view cut short ends
 * with a note saying how to read on.
 */
export function numbered(text: string, offset?: number, limit?: number): string {
  const lines = toLines(text);
  const total = lines.length;
  const start = Math.max(1, Math.floor(offset ?? 1));
  if (start > total) return `(it has ${total} line(s); offset ${start} is past the end)`;
  const max = Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT));
  const out: string[] = [];
  let bytes = 0;
  let last = start - 1;
  for (let i = start; i <= total && out.length < max; i++) {
    const row = `${String(i).padStart(6)}\t${lines[i - 1]}`;
    if (out.length > 0 && bytes + row.length + 1 > BYTE_BUDGET) break;
    out.push(row);
    bytes += row.length + 1;
    last = i;
  }
  const shown = out.join("\n");
  if (last < total) return `${shown}\n(showing lines ${start}-${last} of ${total}; call again with offset=${last + 1} to read on)`;
  return shown;
}

/** `next` with the trailing newline `before` had (a new or empty file gets one). */
export function keepEnding(before: string | null, next: string): string {
  if (next === "") return next;
  const want = before === null || before === "" || before.endsWith("\n");
  if (want && !next.endsWith("\n")) return `${next}\n`;
  if (!want && next.endsWith("\n")) return next.slice(0, -1);
  return next;
}

// ---- edits --------------------------------------------------------------------------------------------

/** The single-edit arguments plus `edits`, as one list, or why the call is malformed. */
export function collectEdits(a: { old_string?: string; new_string?: string; replace_all?: boolean; edits?: Edit[] }): Edit[] | string {
  const single = a.old_string !== undefined || a.new_string !== undefined || a.replace_all !== undefined;
  if (single && a.edits !== undefined) return "Give either `old_string` + `new_string` (one edit) or `edits` (several), not both.";
  if (a.edits !== undefined) return a.edits.length ? a.edits : "`edits` is empty; give at least one { old_string, new_string }.";
  if (!single) return "Give `old_string` + `new_string` (one edit), or `edits` (several).";
  if (a.old_string === undefined || a.new_string === undefined) return 'An edit needs both `old_string` and `new_string` (use "" as `new_string` to delete the passage).';
  return [{ old_string: a.old_string, new_string: a.new_string, replace_all: a.replace_all }];
}

interface Span {
  start: number;
  end: number;
  text: string;
  edit: number;
}

/** Offset of the start of each line (index 0 = line 1). */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n" && i + 1 < text.length) starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Bigram Dice similarity of two strings, 0..1. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) grams.set(a.slice(i, i + 2), (grams.get(a.slice(i, i + 2)) ?? 0) + 1);
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const c = grams.get(b.slice(i, i + 2)) ?? 0;
    if (c > 0) grams.set(b.slice(i, i + 2), c - 1), hits++;
  }
  return (2 * hits) / (a.length + b.length - 2);
}

const HINT_LINES = 8;

/** Where `text` looks most like `needle`, numbered, for a "not found" refusal; "" when nothing is close. */
export function nearestHint(text: string, needle: string): string {
  const lines = toLines(text);
  const want = toLines(needle).map((l) => l.trim());
  const firstIdx = want.findIndex((l) => l !== "");
  if (lines.length === 0 || firstIdx === -1) return "";
  const cands = lines
    .map((l, i) => ({ i: i - firstIdx, s: similarity(l.trim(), want[firstIdx]!) }))
    .filter((c) => c.i >= 0 && c.s >= 0.5)
    .sort((x, y) => y.s - x.s)
    .slice(0, 5);
  let best: { i: number; s: number } | null = null;
  for (const c of cands) {
    let sum = 0;
    for (let k = 0; k < want.length; k++) sum += similarity((lines[c.i + k] ?? "").trim(), want[k]!);
    if (!best || sum / want.length > best.s) best = { i: c.i, s: sum / want.length };
  }
  if (!best || best.s < 0.6) return "";
  const shown = lines.slice(best.i, best.i + Math.min(want.length, HINT_LINES));
  const body = shown.map((l, k) => `${String(best!.i + k + 1).padStart(6)}\t${l}`).join("\n");
  return `\nThe closest text is at line ${best.i + 1}:\n${body}${want.length > HINT_LINES ? "\n…" : ""}`;
}

/** The spans one edit replaces, or why it does not apply. */
function locate(text: string, starts: number[], e: Edit, idx: number, label: string): Span[] | string {
  if (typeof e.old_string !== "string" || typeof e.new_string !== "string") return 'an edit needs both `old_string` and `new_string` (use "" as `new_string` to delete the passage).';
  if (e.old_string === "") return "`old_string` is empty. Give the exact passage to replace; to write a whole file, write it whole instead.";
  if (e.old_string === e.new_string) return "`old_string` and `new_string` are the same, so this changes nothing. Put the new text in `new_string`.";
  const spans: Span[] = [];
  for (let at = text.indexOf(e.old_string); at !== -1; at = text.indexOf(e.old_string, at + e.old_string.length)) {
    spans.push({ start: at, end: at + e.old_string.length, text: e.new_string, edit: idx });
  }
  if (spans.length === 0) {
    return `\`old_string\` was not found in ${label}. It must match the file exactly (spaces and line breaks included), without read_home's line-number prefix; read it again with read_home and copy the passage.${nearestHint(text, e.old_string)}`;
  }
  if (spans.length > 1 && !e.replace_all) {
    const where = spans.slice(0, 10).map((s) => lineOf(starts, s.start));
    return `\`old_string\` occurs ${spans.length} times in ${label} (lines ${where.join(", ")}${spans.length > 10 ? ", …" : ""}). Include more of the surrounding text so it occurs once, or pass replace_all: true to change every one.`;
  }
  return spans;
}

export type EditsResult = { ok: true; next: string; changes: number } | { ok: false; message: string };

/**
 * Apply a batch of edits to `text`, every one located against the original. `label` names the text in
 * refusals. A refusal applies nothing; with more than one edit it starts `edits[i]: `.
 */
export function applyEdits(text: string, edits: Edit[], label: string): EditsResult {
  const starts = lineStarts(text);
  const all: Span[] = [];
  const tag = (i: number) => (edits.length > 1 ? `edits[${i}]: ` : "");
  for (let i = 0; i < edits.length; i++) {
    const r = locate(text, starts, edits[i]!, i, label);
    if (typeof r === "string") return { ok: false, message: `${tag(i)}${r}` };
    all.push(...r);
  }
  all.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let k = 1; k < all.length; k++) {
    const p = all[k - 1]!;
    const c = all[k]!;
    if (c.start < p.end) {
      return {
        ok: false,
        message: `edits[${p.edit}] and edits[${c.edit}] touch the same text (line ${lineOf(starts, c.start)}). Every edit is located against the file as it was, so merge them into one edit.`,
      };
    }
  }
  let next = "";
  let at = 0;
  for (const s of all) {
    next += text.slice(at, s.start) + s.text;
    at = s.end;
  }
  return { ok: true, next: next + text.slice(at), changes: all.length };
}

// ---- the diff -----------------------------------------------------------------------------------------

interface Op {
  t: "=" | "-" | "+";
  line: string;
  oldNo: number;
  newNo: number;
}

function diffOps(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ma = a.slice(pre, a.length - suf);
  const mb = b.slice(pre, b.length - suf);
  const ops: Op[] = [];
  let on = 0;
  let nn = 0;
  const push = (t: Op["t"], line: string) => ops.push({ t, line, oldNo: t !== "+" ? ++on : on, newNo: t !== "-" ? ++nn : nn });
  for (let k = 0; k < pre; k++) push("=", a[k]!);
  if ((ma.length + 1) * (mb.length + 1) > 1_000_000) {
    for (const l of ma) push("-", l);
    for (const l of mb) push("+", l);
  } else {
    const n = ma.length;
    const m = mb.length;
    const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = ma[i] === mb[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (ma[i] === mb[j]) push("=", ma[i++]!), j++;
      else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) push("-", ma[i++]!);
      else push("+", mb[j++]!);
    }
    while (i < n) push("-", ma[i++]!);
    while (j < m) push("+", mb[j++]!);
  }
  for (let k = a.length - suf; k < a.length; k++) push("=", a[k]!);
  return ops;
}

/** A compact unified diff of `before` → `after` (hunks with three context lines, capped), and its counts. */
export function unifiedDiff(before: string, after: string): { additions: number; deletions: number; diff: string } {
  const ops = diffOps(toLines(before), toLines(after));
  const windows: [number, number][] = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k]!.t === "=") continue;
    let e = k;
    while (e + 1 < ops.length && ops[e + 1]!.t !== "=") e++;
    const lo = Math.max(0, k - DIFF_CONTEXT);
    const hi = Math.min(ops.length - 1, e + DIFF_CONTEXT);
    const last = windows[windows.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else windows.push([lo, hi]);
    k = e;
  }
  const hunks = windows.map(([lo, hi]) => {
    const slice = ops.slice(lo, hi + 1);
    const olds = slice.filter((o) => o.t !== "+");
    const news = slice.filter((o) => o.t !== "-");
    const header = `@@ -${olds[0]?.oldNo ?? 0},${olds.length} +${news[0]?.newNo ?? 0},${news.length} @@`;
    return [header, ...slice.map((o) => `${o.t === "=" ? " " : o.t}${o.line}`)].join("\n");
  });
  let diff = hunks.join("\n");
  if (diff.length > DIFF_BUDGET) diff = `${diff.slice(0, DIFF_BUDGET)}\n… (diff cut short)`;
  return { additions: ops.filter((o) => o.t === "+").length, deletions: ops.filter((o) => o.t === "-").length, diff };
}
