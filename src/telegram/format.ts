/**
 * The assistant writes markdown, the way a model writes by habit; Telegram renders a small HTML subset.
 * This is the one place that bridges the two, so the model never has to know Telegram's rules (it used to
 * write `<ul><li>` by hand to suit the old framework, which is exactly the kind of platform detail a prompt
 * should not carry).
 *
 * Two steps, in this order:
 *   1. `splitMarkdown` cuts the SOURCE into parts that fit one message, on paragraph boundaries, never
 *      inside a code fence. Cutting the source rather than the HTML means no part ever ends inside a tag.
 *   2. `markdownToTelegramHtml` converts each part.
 *
 * Telegram's limit is 4096 characters of text after entities are parsed; parts are cut well under it so
 * the HTML of a part stays under it too. If Telegram still rejects a part's HTML, the sender falls back to
 * sending that part's markdown as plain text: an ugly message beats a lost one.
 */

export const PART_LIMIT = 3500;
const TG_LIMIT = 4096;

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string): string => escapeHtml(s).replace(/"/g, "&quot;");

/** Inline markdown → HTML for one line of prose (no code fences reach here). */
function inline(src: string): string {
  // Pull inline code out first, so nothing inside it is treated as markup.
  const codes: string[] = [];
  let s = src.replace(/`([^`\n]+)`/g, (_, c: string) => {
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  const links: string[] = [];
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, text: string, url: string) => {
    links.push(`<a href="${escapeAttr(url)}">${escapeHtml(text)}</a>`);
    return `\u0001${links.length - 1}\u0001`;
  });
  s = escapeHtml(s);
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^_\n]+?)__/g, "<b>$1</b>");
  s = s.replace(/~~([^~\n]+?)~~/g, "<s>$1</s>");
  // Single-marker italics only at word edges, so `snake_case` and `2*3*4` stay as they are. The edges
  // include full-width brackets and punctuation, because the assistant mostly writes CJK text.
  s = s.replace(/(^|[\s(（])\*([^*\s][^*\n]*?)\*(?=$|[\s.,!?;:)）。，！？])/g, "$1<i>$2</i>");
  s = s.replace(/(^|[\s(（])_([^_\s][^_\n]*?)_(?=$|[\s.,!?;:)）。，！？])/g, "$1<i>$2</i>");
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i: string) => links[Number(i)]!);
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]!);
  return s;
}

/** Convert one part of markdown to Telegram HTML. */
export function markdownToTelegramHtml(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let quote: string[] = [];
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
    quote = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      flushQuote();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      const lang = fence[1] ? ` class="language-${escapeAttr(fence[1])}"` : "";
      out.push(`<pre><code${lang}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) {
      quote.push(inline(q[1]!));
      continue;
    }
    flushQuote();
    const h = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (h) {
      out.push(`<b>${inline(h[1]!)}</b>`);
      continue;
    }
    const li = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (li) {
      out.push(`${li[1]}• ${inline(li[2]!)}`);
      continue;
    }
    out.push(inline(line));
  }
  flushQuote();
  return out.join("\n");
}

/** A block of the source: a whole code fence, or a paragraph. */
function blocks(md: string): string[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const res: string[] = [];
  let cur: string[] = [];
  const push = () => {
    if (cur.length) res.push(cur.join("\n"));
    cur = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      push();
      const fence = [line];
      i++;
      while (i < lines.length) {
        fence.push(lines[i]!);
        if (/^\s*```\s*$/.test(lines[i]!)) break;
        i++;
      }
      res.push(fence.join("\n"));
      continue;
    }
    if (line.trim() === "") {
      push();
      continue;
    }
    cur.push(line);
  }
  push();
  return res;
}

/** Hard-cut a block that alone is too long: at line ends where possible, else at the limit. */
function cut(block: string, limit: number): string[] {
  const res: string[] = [];
  let rest = block;
  while (rest.length > limit) {
    let at = rest.lastIndexOf("\n", limit);
    if (at < limit / 2) at = limit;
    res.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  if (rest) res.push(rest);
  return res;
}

/**
 * Cut markdown into parts of at most `limit` characters, joining paragraphs while they fit. A code fence
 * longer than the limit is cut into several fences, each closed and reopened, so every part renders.
 */
export function splitMarkdown(md: string, limit = PART_LIMIT): string[] {
  const parts: string[] = [];
  let cur = "";
  for (const b of blocks(md)) {
    const pieces: string[] = [];
    if (b.length <= limit) pieces.push(b);
    else if (/^\s*```/.test(b)) {
      const open = b.split("\n")[0]!;
      const inner = b.split("\n").slice(1, -1).join("\n");
      for (const c of cut(inner, limit - open.length - 8)) pieces.push(`${open}\n${c}\n\`\`\``);
    } else pieces.push(...cut(b, limit));
    for (const p of pieces) {
      if (!cur) cur = p;
      else if (cur.length + 2 + p.length <= limit) cur += `\n\n${p}`;
      else {
        parts.push(cur);
        cur = p;
      }
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

/** Each part as Telegram will receive it: HTML, and the markdown to fall back to if the HTML is refused. */
export function renderParts(md: string): { html: string; plain: string }[] {
  return splitMarkdown(md).map((plain) => {
    const html = markdownToTelegramHtml(plain);
    // Conversion only ever adds tags, so a part can grow past the limit; then send it plain.
    return html.length <= TG_LIMIT ? { html, plain } : { html: escapeHtml(plain), plain };
  });
}
