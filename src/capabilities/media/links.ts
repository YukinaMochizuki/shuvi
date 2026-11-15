import { createHash } from "node:crypto";

/**
 * Which links of a message a prewarm reads ahead of time, and the key a link is known by.
 *
 * EVERY http(s) link, through porchkit's `/read` (prewarm.ts): there is no list of hosts. `/read` reads any
 * link (a post, a page, raw text, a short link resolved), and for a video site it probes the video itself,
 * sharing `/media/probe`'s cache, so one call covers them all. At most `MAX_PREWARM_LINKS` per message.
 */

/** The most links of one message prewarmed: a message full of links is not a reason to spend the budget. */
export const MAX_PREWARM_LINKS = 3;

/** Punctuation that ends a sentence around a link rather than belonging to it. */
const TRAILING = /[.,;:!?)\]}>'"*_~]+$/;

/**
 * The http(s) links in `text`, in order, each once: ASCII only (a link pasted against CJK text ends where
 * the text starts), with sentence punctuation after it left off (a `)` is kept when the link opened one).
 */
export function linksIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[!-~]+/gi)) {
    let u = m[0].replace(/[<>"'`]+.*$/, "");
    for (;;) {
      const t = u.replace(TRAILING, (p) => {
        // Keep a `)` that closes one opened inside the link (a Wikipedia-style path).
        const open = (u.match(/\(/g) ?? []).length;
        const close = (u.match(/\)/g) ?? []).length;
        return p === ")" && open >= close ? p : "";
      });
      if (t === u) break;
      u = t;
    }
    try {
      new URL(u);
    } catch {
      continue;
    }
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

/**
 * Which porchkit call a prewarm went to. A new one is always `read`; `probe` is what older rows say (a video
 * host's link was probed then), and `video_probe` still joins those (prewarm.ts `joinedProbe`).
 */
export type PrewarmEndpoint = "read" | "probe";

/**
 * The links a prewarm reads, from `texts` in order (the message's own text, then the text it replies to): every
 * http(s) link, the first occurrence of each (by `urlKey`) kept, at most `MAX_PREWARM_LINKS` in all.
 */
export function prewarmLinks(texts: readonly (string | null | undefined)[]): { url: string; host: string; endpoint: "read" }[] {
  const out: { url: string; host: string; endpoint: "read" }[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const url of text ? linksIn(text) : []) {
      if (out.length >= MAX_PREWARM_LINKS) return out;
      const key = urlKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ url, host: new URL(url).hostname.toLowerCase(), endpoint: "read" });
    }
  }
  return out;
}

/**
 * The key a link is known by (a prewarm and a later `read_link` of it meet on this): the URL with its
 * scheme taken as https, its host in lower case without `www.`, and no fragment; a link written without a
 * scheme counts as https. Then hashed: a prewarm's row keeps this hash, not the URL (what else it keeps for
 * an hour is said in prewarm.ts).
 */
export function urlKey(raw: string): string {
  let s = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let norm: string;
  try {
    const u = new URL(s);
    norm = `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.port ? `:${u.port}` : ""}${u.pathname}${u.search}`;
  } catch {
    norm = s;
  }
  return createHash("sha256").update(norm).digest("hex").slice(0, 32);
}
