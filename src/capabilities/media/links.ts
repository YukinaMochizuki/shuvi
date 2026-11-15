import { createHash } from "node:crypto";

/**
 * Which links are videos worth looking up ahead of time, and the key a link is known by.
 *
 * THE HOSTS a prewarm probes (media/index.ts), in one place: the video and social sites, and the short-link
 * services porchkit resolves (its media/canon.py `SHORTENERS`). A site matches with any subdomain
 * (`m.youtube.com`, `vm.tiktok.com`); a short-link service only as itself (or `www.`), as porchkit has it.
 */
export const VIDEO_HOSTS = [
  "youtube.com",
  "youtu.be",
  "x.com",
  "twitter.com",
  "threads.net",
  "threads.com",
  "instagram.com",
  "tiktok.com",
  "vimeo.com",
  "bilibili.com",
  "b23.tv",
] as const;

export const SHORTENER_HOSTS = [
  "t.co",
  "bit.ly",
  "tinyurl.com",
  "goo.gl",
  "ow.ly",
  "buff.ly",
  "is.gd",
  "lnkd.in",
  "rebrand.ly",
  "cutt.ly",
  "shorturl.at",
  "t.ly",
  "dlvr.it",
  "fb.me",
  "tiny.cc",
  "rb.gy",
  "s.id",
  "v.gd",
] as const;

/**
 * The hosts whose links are POSTS (a social post: text, images, videos), prewarmed through porchkit's
 * `POST /read` rather than `/media/probe`: a post is not a video, and most of them have none. Matched with
 * any subdomain, like `VIDEO_HOSTS`; checked first, so x.com and the others here leave the video list's
 * probe. A short link (`SHORTENER_HOSTS`) is read too: `/read` resolves it and answers whatever is behind
 * it (a post, a video site's post, a page), where a probe would fail on anything but a video.
 */
export const POST_HOSTS = ["x.com", "twitter.com", "threads.net", "threads.com", "instagram.com", "facebook.com", "reddit.com", "bsky.app"] as const;

/** Is `host` (lower case) one whose links a prewarm reads as a post? */
export function isPostHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return POST_HOSTS.some((v) => h === v || h.endsWith(`.${v}`));
}

/** The most links of one message prewarmed: a message full of links is not a reason to spend the budget. */
export const MAX_PREWARM_LINKS = 3;

/** Is `host` (lower case) one a prewarm probes? */
export function isVideoHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if ((SHORTENER_HOSTS as readonly string[]).includes(h.replace(/^www\./, ""))) return true;
  return VIDEO_HOSTS.some((v) => h === v || h.endsWith(`.${v}`));
}

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

/** The links of `text` a prewarm probes (known hosts), at most `MAX_PREWARM_LINKS`. */
export function videoLinks(text: string): { url: string; host: string }[] {
  return linksIn(text)
    .map((url) => ({ url, host: new URL(url).hostname.toLowerCase() }))
    .filter((l) => isVideoHost(l.host))
    .slice(0, MAX_PREWARM_LINKS);
}

/** Is `host` (lower case) a short-link service (itself or `www.`, as porchkit has it)? */
export function isShortener(host: string): boolean {
  return (SHORTENER_HOSTS as readonly string[]).includes(host.toLowerCase().replace(/\.$/, "").replace(/^www\./, ""));
}

/** Which porchkit call prewarms a link: `read` for a post host or a short link, `probe` for a video host. */
export type PrewarmEndpoint = "read" | "probe";

/**
 * The links of `text` a prewarm looks up, with the call each goes to: a post host's or a short link's to
 * `/read`, a video host's to `/media/probe`; at most `MAX_PREWARM_LINKS` in all, in the order sent.
 */
export function prewarmLinks(text: string): { url: string; host: string; endpoint: PrewarmEndpoint }[] {
  return linksIn(text)
    .map((url) => ({ url, host: new URL(url).hostname.toLowerCase() }))
    .flatMap((l): { url: string; host: string; endpoint: PrewarmEndpoint }[] => (isPostHost(l.host) || isShortener(l.host) ? [{ ...l, endpoint: "read" }] : isVideoHost(l.host) ? [{ ...l, endpoint: "probe" }] : []))
    .slice(0, MAX_PREWARM_LINKS);
}

/**
 * The key a link is known by (a prewarm and a later `video_probe` of it meet on this): the URL with its
 * scheme taken as https, its host in lower case without `www.`, and no fragment; a link written without a
 * scheme counts as https. Then hashed: a prewarm's row keeps this hash, not the URL (what else it keeps for
 * an hour, the probe's answer, is said in prewarm.ts).
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
