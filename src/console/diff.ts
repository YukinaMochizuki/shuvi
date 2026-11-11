/**
 * A line diff, for a turn's system prompt against the previous turn's in the same chat. Common lines at
 * both ends are taken off first (two prompts of one chat usually differ in one section), then the middle is
 * diffed by longest common subsequence. A middle too large to diff in reasonable memory is shown as one
 * block removed and one added, which is still true.
 */

export type DiffLine = { op: "same" | "add" | "del"; text: string };

/** Above this many cells (lines × lines) the middle is not diffed line by line. */
const MAX_CELLS = 4_000_000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--;

  const head = a.slice(0, start).map((text) => ({ op: "same" as const, text }));
  const tail = a.slice(endA).map((text) => ({ op: "same" as const, text }));
  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);
  let middle: DiffLine[];
  if (ma.length * mb.length > MAX_CELLS) {
    middle = [...ma.map((text) => ({ op: "del" as const, text })), ...mb.map((text) => ({ op: "add" as const, text }))];
  } else {
    // lcs[i][j]: the longest common subsequence of ma[i..] and mb[j..].
    const w = mb.length + 1;
    const lcs = new Uint32Array((ma.length + 1) * w);
    for (let i = ma.length - 1; i >= 0; i--) {
      for (let j = mb.length - 1; j >= 0; j--) {
        lcs[i * w + j] = ma[i] === mb[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
      }
    }
    middle = [];
    let i = 0;
    let j = 0;
    while (i < ma.length && j < mb.length) {
      if (ma[i] === mb[j]) middle.push({ op: "same", text: ma[i++]! }), j++;
      else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) middle.push({ op: "del", text: ma[i++]! });
      else middle.push({ op: "add", text: mb[j++]! });
    }
    while (i < ma.length) middle.push({ op: "del", text: ma[i++]! });
    while (j < mb.length) middle.push({ op: "add", text: mb[j++]! });
  }
  return [...head, ...middle, ...tail];
}

/** A hunk view: changed lines with `context` lines around them; `null` marks lines left out. */
export function hunks(lines: DiffLine[], context = 3): (DiffLine | null)[] {
  const keep = new Uint8Array(lines.length);
  lines.forEach((l, i) => {
    if (l.op === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = 1;
  });
  const out: (DiffLine | null)[] = [];
  lines.forEach((l, i) => {
    if (keep[i]) out.push(l);
    else if (out.at(-1) !== null) out.push(null);
  });
  return out;
}
