import { z } from "zod";
import { err, ok, type ToolContent, type ToolDef, type ToolResult } from "agent-runtime";
import { describeRead, FILE_KEY, type FileRef, type Page, type Porchkit, type Post, type PostImage, type PostVideo, type Raw, type ReadAnswer } from "../../porchkit/client.ts";
import type { Db } from "../../store/db.ts";
import type { Chat } from "../../store/events.ts";
import type { ComputerConfig } from "../computer/config.ts";
import { ComputerError } from "../computer/computer.ts";
import { computersFor } from "../computer/index.ts";
import { timeLabel } from "../computer/media.ts";
import { shq } from "../computer/exec.ts";
import { getComputer } from "../computer/state.ts";
import { COPY_SLICE_MS, copyInto, homeRun } from "./fetch.ts";
import { urlKey } from "./links.ts";
import { joinedRead } from "./prewarm.ts";
import { probeText } from "./text.ts";

/**
 * READING A LINK (docs: media/index.ts): `read_link` asks porchkit's `POST /read` (its decision
 * docs/decisions/read.md is the contract) and hands the model compact text, never porchkit's JSON:
 *
 *   post   who, when, the whole text, metrics, the post it quotes, replies when asked, links, `via` when it
 *          came through a mirror, porchkit's notes. Each image comes as an IMAGE BLOCK, fetched here from
 *          `GET /files/<key>` with the token (never shown as a URL or a key); each video as its probe lines
 *          (`probeText`), its transcript, its poster and contact sheet as images, and a line saying that
 *          video_subs / video_sheet with its `media_url` give more. At most `MAX_READ_IMAGES` images per call,
 *          the rest counted and said so; a reply's images are counted, not fetched.
 *   page   title, byline, date, the markdown; when cut, how to read on (`offset`, free: from porchkit's
 *          cache) and, where the chat has a computer, that save_link puts the whole text there.
 *   raw    the text, with the same read-on line when cut.
 *
 * `save_link` puts a page's (or raw answer's) whole text and/or the page as received into ~/inbox/ on the
 * chat's computer: porchkit's file keys (`full`, `original`) copied by video_fetch's resumable copy
 * (fetch.ts `copyInto`), or, for a page read whole, the text itself. It acts for the owner, as every way of
 * putting a file on the computer does (`ownerOnly`, delegable to a group's operators with media).
 */

/** The most images one read_link call returns (a post's, its videos' posters and sheets, the quoted post's). */
export const MAX_READ_IMAGES = 8;
/** The most of a page's links / images listed. */
export const MAX_LISTED_LINKS = 30;
export const MAX_LISTED_IMAGES = 10;

/** What a refusal of save_link adds (the boundary's): why only the owner, and what instead. */
export const SAVE_NOTE =
  "Tell them plainly that you can't put files on the owner's computer for them without the owner's say-so. Offer what you can do instead: read the page with read_link (offset reads on past a cut) and tell them what it says.";

/** An image handed over after the text: a file of porchkit's cache, or a contact sheet. */
export type ImageSource = { file: string } | { sheet: string };

export interface Rendered {
  text: string;
  images: { label: string; source: ImageSource }[];
  /** Images past `MAX_READ_IMAGES`, not returned. */
  leftOut: number;
}

/** Numbers the images of one answer, up to the cap. */
class Images {
  readonly list: { label: string; source: ImageSource }[] = [];
  leftOut = 0;
  constructor(readonly max: number) {}
  /** "image N", or null past the cap (counted). */
  add(label: string, source: ImageSource): string | null {
    if (this.list.length >= this.max) {
      this.leftOut++;
      return null;
    }
    this.list.push({ label, source });
    return `image ${this.list.length}`;
  }
}

const SOURCES: Record<string, string> = { x: "X", reddit: "Reddit", bluesky: "Bluesky", threads: "Threads", instagram: "Instagram", facebook: "Facebook", meta: "Meta", youtube: "YouTube", tiktok: "TikTok" };
const sourceName = (s?: string) => (s ? (SOURCES[s] ?? s) : undefined);

/** An ISO time as "2026-11-14 09:30 UTC"; anything else as it came. */
export function when(iso?: string | null): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const indent = (s: string, pad = "  ") =>
  s
    .split("\n")
    .map((l) => (l ? pad + l : l))
    .join("\n");

const n = (x: number) => x.toLocaleString("en-US");

function authorOf(p: Post): string {
  const a = p.author;
  const name = a?.name?.trim();
  const handle = a?.handle?.trim();
  if (name && handle && name !== handle) return `${name} (${handle})`;
  return name || handle || "an unknown author";
}

function metricsLine(m: Post["metrics"]): string | undefined {
  const parts = Object.entries(m ?? {})
    .filter((e): e is [string, number] => typeof e[1] === "number")
    .map(([k, v]) => `${n(v)} ${k}`);
  return parts.length ? parts.join(" · ") : undefined;
}

const viaMirror = (via?: string) => (via?.startsWith("mirror:") ? `Read through a mirror (${via.slice(7)}), not the site itself: it may lag behind it.` : undefined);

const size = (w?: number | null, h?: number | null) => (w && h ? `${w}x${h}` : undefined);

function imageLine(img: PostImage, i: number, imgs: Images): string {
  const what = [size(img.width, img.height), img.alt?.trim() ? `alt: ${JSON.stringify(img.alt.trim())}` : undefined].filter(Boolean).join(", ");
  const tail = what ? ` (${what})` : "";
  if (!img.key) return `Image ${i}: not fetched by the media service${tail}`;
  const shown = imgs.add(`picture ${i} of the post${img.alt?.trim() ? `, alt: ${img.alt.trim()}` : ""}`, { file: img.key });
  return shown ? `Image ${i}: ${shown}${tail}` : `Image ${i}: not shown (one read_link returns at most ${imgs.max} images)${tail}`;
}

function videoLines(v: PostVideo, i: number, imgs: Images): string[] {
  const head = [typeof v.duration === "number" ? timeLabel(v.duration) : undefined, size(v.width, v.height)].filter(Boolean).join(" · ");
  let poster = "";
  if (v.poster?.key) {
    const shown = imgs.add(`video ${i}'s poster (its still image)`, { file: v.poster.key });
    poster = shown ? ` — poster: ${shown}` : " — poster not shown (image limit)";
  }
  const out = [`Video ${i}${head ? ` (${head})` : ""}${poster}`];
  if (v.probe) out.push(indent(probeText(v.probe)));
  const t = v.transcript;
  if (t?.text?.trim()) {
    const kind = t.kind === "manual" ? "subtitles" : t.kind === "auto" || t.kind === "automatic" ? "automatic captions" : t.kind;
    out.push(`  Transcript (${kind}, ${t.lang}):`, indent(t.text.trim(), "    "));
    if (t.truncated) out.push("    …(cut here; video_subs reads the rest)");
  }
  const sheets = v.sheet?.sheets ?? [];
  if (sheets.length) {
    const shown = sheets.map((s, k) => imgs.add(`video ${i}'s contact sheet${sheets.length > 1 ? ` ${k + 1} of ${sheets.length}` : ""}${s.labels?.length ? `, frames at ${s.labels.join(" ")}` : ""}`, { sheet: s.url })).filter((x): x is string => !!x);
    out.push(`  Contact sheet: ${shown.length ? `${shown.join(", ")}, frames tiled in order with each one's time under it` : "not shown (image limit)"}${shown.length && shown.length < sheets.length ? ` (${sheets.length - shown.length} more not shown)` : ""}`);
    if (v.sheet?.index?.trim()) out.push(indent(v.sheet.index.trim(), "    "));
  }
  if (v.media_url) out.push(`  More from this video: video_subs (all it says, with times) and video_sheet (more frames) with url: ${v.media_url}`);
  return out;
}

/** A post's lines; `depth` "quoted" and "comment" leave out what only the top post carries. */
function postLines(p: Post, imgs: Images, depth: "top" | "quoted" | "comment", authors: ReadonlyMap<string, string> = new Map()): string[] {
  const out: string[] = [];
  const at = when(p.created_at);
  const site = sourceName(p.source);
  const media = p.media ?? [];
  if (depth === "comment") {
    const m = metricsLine(p.metrics);
    // Replies are flat: one that answers another reply (not the post) says whose.
    const to = p.reply_to?.id ? authors.get(p.reply_to.id) : undefined;
    out.push(`- ${authorOf(p)}${at ? `, ${at}` : ""}${m ? ` (${m})` : ""}${to ? `, replying to ${to}` : ""}:`);
    out.push(indent(p.text?.trim() || "(no text)", "    "));
    const pics = media.filter((x) => x.type === "image").length;
    const vids = media.filter((x) => x.type === "video").length;
    const has = [pics ? `${pics} image(s)` : "", vids ? `${vids} video(s)` : ""].filter(Boolean).join(" and ");
    if (has) out.push(`    [${has}, not shown${p.canonical_url ? `; read_link on ${p.canonical_url} shows them` : ""}]`);
    return out;
  }
  out.push(`${depth === "quoted" ? "Quoted post" : "Post"}${site && depth === "top" ? ` on ${site}` : ""} by ${authorOf(p)}${at ? `, ${at}` : ""}`);
  if (p.canonical_url) out.push(`Link: ${p.canonical_url}`);
  if (depth === "top") {
    const mirror = viaMirror(p.via);
    if (mirror) out.push(mirror);
  }
  if (p.reply_to?.url || p.reply_to?.id) out.push(`Replying to: ${p.reply_to.url ?? p.reply_to.id}`);
  const m = metricsLine(p.metrics);
  if (m) out.push(m);
  out.push("", p.text?.trim() || "(no text)");
  if (media.length) out.push("");
  let pi = 0;
  let vi = 0;
  for (const x of media) {
    if (x.type === "image") out.push(imageLine(x, ++pi, imgs));
    else if (x.type === "video") out.push(...videoLines(x, ++vi, imgs));
  }
  if (depth === "top" && p.quoted) out.push("", ...postLines(p.quoted, imgs, "quoted").map((l) => (l ? `  ${l}` : l)));
  if (depth === "top" && p.comments?.length) {
    out.push("", `Replies (${p.comments.length}):`);
    const authors = new Map(p.comments.flatMap((c) => (c.id ? [[c.id, authorOf(c)] as const] : [])));
    for (const c of p.comments) out.push(...postLines(c, imgs, "comment", authors));
  }
  if (p.links?.length) out.push("", `Links: ${p.links.join(" ")}`);
  return out;
}

const notesLines = (notes?: string[]) => (notes?.length ? ["", "Notes:", ...notes.map((x) => `- ${x}`)] : []);

/** The read-on line of a cut page or raw answer. */
function cutLine(a: Page | Raw, saveable: boolean): string | undefined {
  if (!a.truncated) return undefined;
  const next = a.next_offset;
  const total = a.total_chars;
  const where = typeof next === "number" ? `at character ${n(next)}${typeof total === "number" ? ` of ${n(total)}` : ""}` : "here";
  const on = typeof next === "number" ? ` To read on, call read_link again with offset: ${next} (free: it comes from the cache).` : "";
  const save = saveable ? " save_link puts the whole text onto your computer (for the owner)." : "";
  return `…(cut ${where}.${on}${save})`;
}

/** An answer as the model reads it: the text, and the images to hand over after it. */
export function renderRead(a: ReadAnswer, opts: { saveable: boolean; maxImages?: number }): Rendered {
  const imgs = new Images(opts.maxImages ?? MAX_READ_IMAGES);
  const out: string[] = [];
  if (a.kind === "post") {
    out.push(...postLines(a, imgs, "top"));
  } else if (a.kind === "page") {
    out.push(`Page: ${a.title?.trim() || "(untitled)"}${a.site_name ? ` — ${a.site_name}` : ""}`);
    const by = [a.byline ? `By ${a.byline}` : undefined, a.published ? `published ${a.published}` : undefined, a.lang ? `language ${a.lang}` : undefined].filter(Boolean);
    if (by.length) out.push(by.join(" · "));
    if (a.canonical_url) out.push(`Link: ${a.canonical_url}`);
    const mirror = viaMirror(a.via);
    if (mirror) out.push(mirror);
    if (a.offset) out.push(`(from character ${n(a.offset)}${a.total_chars ? ` of ${n(a.total_chars)}` : ""})`);
    out.push("", a.markdown.trim() || "(no text could be read from it)");
    const cut = cutLine(a, opts.saveable);
    if (cut) out.push("", cut);
    if (a.videos?.length) out.push("", `Videos on the page: ${a.videos.map((v) => v.media_url).join(" ")} — video_probe, video_subs and video_sheet look at them.`);
    if (a.images?.length) {
      const shown = a.images.slice(0, MAX_LISTED_IMAGES).map((i) => `${i.url}${i.alt?.trim() ? ` (${JSON.stringify(i.alt.trim())})` : ""}`);
      out.push("", `Images on the page (${a.images.length}, listed, not fetched): ${shown.join(" ")}${a.images.length > MAX_LISTED_IMAGES ? ` …and ${a.images.length - MAX_LISTED_IMAGES} more` : ""}`);
    }
    if (a.links?.length) out.push("", `Links (${a.links.length}): ${a.links.slice(0, MAX_LISTED_LINKS).join(" ")}${a.links.length > MAX_LISTED_LINKS ? ` …and ${a.links.length - MAX_LISTED_LINKS} more` : ""}`);
  } else {
    out.push(`Raw text${a.content_type ? ` (${a.content_type})` : ""}${a.canonical_url ? ` from ${a.canonical_url}` : ""}${a.offset ? `, from character ${n(a.offset)}` : ""}:`, "", a.text);
    const cut = cutLine(a, opts.saveable);
    if (cut) out.push("", cut);
  }
  out.push(...notesLines(a.notes));
  if (imgs.leftOut) out.push("", `(${imgs.leftOut} more image(s) not shown: one read_link returns at most ${imgs.max}.)`);
  else if (imgs.list.length) out.push("", `(${imgs.list.length} image(s) follow, in order.)`);
  return { text: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(), images: imgs.list, leftOut: imgs.leftOut };
}

const imageType = (t: string | null) => {
  const m = (t ?? "").split(";")[0]!.trim().toLowerCase();
  return /^image\/(jpeg|png|gif|webp)$/.test(m) ? m : "image/jpeg";
};

/** The tool's content: the text, then each image (fetched with the token) after a line naming it. */
export async function readContent(porch: Porchkit, r: Rendered): Promise<ToolContent[]> {
  const got = await Promise.all(
    r.images.map(async (img) => {
      try {
        if ("sheet" in img.source) return { bytes: await porch.sheetImage(img.source.sheet), type: "image/jpeg" };
        const f = await porch.file(img.source.file);
        return { bytes: f.bytes, type: imageType(f.type) };
      } catch (e) {
        return { error: describeRead(e) };
      }
    }),
  );
  const content: ToolContent[] = [{ type: "text", text: r.text }];
  got.forEach((g, i) => {
    const label = `[image ${i + 1}: ${r.images[i]!.label}]`;
    if ("error" in g) content.push({ type: "text", text: `${label} could not be read back: ${g.error}` });
    else content.push({ type: "text", text: label }, { type: "image", data: Buffer.from(g.bytes).toString("base64"), mimeType: g.type });
  });
  return content;
}

// ---- save_link ----------------------------------------------------------------------------------------

const EXT: Record<string, string> = { "text/html": "html", "application/xhtml+xml": "html", "application/json": "json", "text/plain": "txt", "text/markdown": "md", "text/csv": "csv", "application/xml": "xml", "text/xml": "xml" };
const extOf = (type: string | null | undefined, fallback: string) => EXT[(type ?? "").split(";")[0]!.trim().toLowerCase()] ?? fallback;

/** `inbox/<slug>-<hash>`: a slug from the title (or the link), and the link's key so two pages never collide. */
export function saveBase(a: Page | Raw, url: string): string {
  let words = a.kind === "page" ? (a.title ?? "") : "";
  if (!words.trim()) {
    try {
      const u = new URL(a.canonical_url ?? url);
      words = `${u.hostname.replace(/^www\./, "")} ${u.pathname}`;
    } catch {
      words = "";
    }
  }
  const slug = words
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `inbox/${slug || a.kind}-${urlKey(a.canonical_url ?? url).slice(0, 8)}`;
}

type SavePlan = { path: string; what: string; from: { key: string } | { bytes: Uint8Array } };

const kb = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

/** What save_link writes for `what`, or why it can't. */
export function savePlan(a: Page | Raw, url: string, what: "text" | "original" | "both"): { plans: SavePlan[]; notes: string[] } | { error: string } {
  const base = saveBase(a, url);
  const plans: SavePlan[] = [];
  const notes: string[] = [];
  const file = (f: FileRef | null | undefined) => (f?.key ? { key: f.key } : undefined);
  if (a.kind === "raw") {
    // The raw text is the body as received: one file, whichever is asked for.
    const ext = extOf(a.content_type ?? a.original?.type, "txt");
    const orig = file(a.original);
    if (orig) plans.push({ path: `${base}.${ext}`, what: "the whole body as received", from: orig });
    else if (!a.truncated) plans.push({ path: `${base}.${ext}`, what: "the whole body as received", from: { bytes: new TextEncoder().encode(a.text) } });
    else return { error: "The media service kept no whole copy of that answer, so only what read_link shows can be had; read on with its offset." };
    return { plans, notes };
  }
  if (what !== "original") {
    const full = file(a.full);
    if (full) plans.push({ path: `${base}.md`, what: "the whole text as markdown", from: full });
    else if (!a.truncated) plans.push({ path: `${base}.md`, what: "the whole text as markdown", from: { bytes: new TextEncoder().encode(a.markdown) } });
    else return { error: "The media service kept no whole copy of that page's text, so only what read_link shows can be had; read on with its offset." };
  }
  if (what !== "text") {
    const orig = file(a.original);
    if (orig) plans.push({ path: `${base}.${extOf(a.original?.type, "html")}`, what: "the page as received", from: orig });
    else if (what === "original") return { error: "The media service did not keep that page as received (it keeps it when the text was cut, or read poorly). save_link with what: \"text\" saves the text." };
    else notes.push("The page as received was not kept by the media service (it keeps it when the text was cut, or read poorly); only the text is saved.");
  }
  return { plans, notes };
}

// ---- the tools ----------------------------------------------------------------------------------------

const link = z
  .string()
  .min(1)
  .regex(/^https?:\/\/\S+$/i, "an http(s) link")
  .describe("The link, as it was sent");

export interface ReadToolsContext {
  db: Db;
  chat: Chat;
  turnId: number;
  porch: Porchkit;
  /** The chat's computer, when it has one (save_link, and the read-on line's mention of it). */
  computer: ComputerConfig | null;
  joinWaitMs: number;
}

export function readTools(x: ReadToolsContext): ToolDef[] {
  const { db, chat, turnId, porch, computer } = x;

  const readLink: ToolDef<{ url: string; comments?: number; offset?: number; video?: "auto" | "summary" }> = {
    name: "read_link",
    description:
      "Read any http(s) link through the home relay: a social post (X, Threads, Instagram, Facebook, Reddit, Bluesky…) comes whole, with its images shown to you, each video's details, transcript, poster and contact sheet, and the post it quotes; an article or any other page comes as markdown; JSON and plain text as they are. " +
      "A long page is cut: the answer says the `offset` to read on from (free). `comments`: for a post, how many replies to include (default 0, at most 50). `video`: for a post, \"auto\" (default: details, transcript and frames of short videos), or \"summary\" (only what the post's own data says).",
    inputSchema: {
      url: link,
      comments: z.number().int().min(0).max(50).optional().describe("Posts: how many replies to include (0 to 50; default 0)"),
      offset: z.number().int().min(0).optional().describe("Pages and raw text: the character to start from, as a cut answer says"),
      video: z.enum(["auto", "summary"]).optional().describe('Posts: "auto" (default) or "summary"'),
    },
    async handler(a): Promise<ToolResult> {
      let answer: ReadAnswer;
      try {
        ({ answer } = await joinedRead(db, porch, chat.id, turnId, { url: a.url, ...(a.comments ? { comments: a.comments } : {}), ...(a.offset ? { offset: a.offset } : {}), ...(a.video ? { video: a.video } : {}) }, { waitMs: x.joinWaitMs }));
      } catch (e) {
        return err(describeRead(e));
      }
      if (!answer || !["post", "page", "raw"].includes(answer.kind)) return err("The media service answered with something it should not have (no kind of answer read_link knows); nothing to show.");
      return { content: await readContent(porch, renderRead(answer, { saveable: !!computer })) };
    },
  };

  if (!computer) return [readLink];

  const saveLink: ToolDef<{ url: string; what?: "text" | "original" | "both" }> = {
    name: "save_link",
    description:
      "Save a page's whole text (markdown) and/or the page as it was received into ~/inbox/ on your computer, to work on it there (a long page read_link cuts, a document to parse). Only the owner may ask for it. " +
      '`what`: "text" (the default), "original" or "both". For JSON or plain text, the body as received. Not for posts (read_link shows them whole) or videos (video_fetch).',
    inputSchema: {
      url: link,
      what: z.enum(["text", "original", "both"]).optional().describe('"text" (default), "original" or "both"'),
    },
    async handler(a): Promise<ToolResult> {
      let answer: ReadAnswer;
      try {
        answer = await porch.read({ url: a.url });
      } catch (e) {
        return err(describeRead(e));
      }
      if (answer.kind === "post") return err("That link is a post: read_link shows it whole, images included, and save_link only saves pages and raw text. A video in it goes onto the computer with video_fetch and its url.");
      const plan = savePlan(answer, a.url, a.what ?? "text");
      if ("error" in plan) return err(plan.error);
      for (const p of plan.plans) if ("key" in p.from && !FILE_KEY.test(p.from.key)) return err("The media service answered with a file key that is not its own; nothing was saved.");
      const computers = computersFor(db, computer);
      try {
        const { value } = await computers.withLease(chat, COPY_SLICE_MS + 60_000, async () => {
          const run = homeRun(computers.hangar, getComputer(db, chat.id)!.container);
          const done: string[] = [];
          for (const p of plan.plans) {
            if ("bytes" in p.from) {
              await run(`set -e; cd ~; mkdir -p inbox; cat > ${shq(`${p.path}.part`)}; mv -f -- ${shq(`${p.path}.part`)} ${shq(p.path)}`, p.from.bytes);
              done.push(`~/${p.path} (${p.what}, ${kb(p.from.bytes.length)})`);
              continue;
            }
            const first = await porch.fileRange(p.from.key, 0, 0);
            if (first.total === null) throw new Error("the media service did not say how large the file is");
            const r = await copyInto(porch, run, { key: p.from.key, path: p.path, part: `${p.path}.part-save`, total: first.total });
            if (!r.done) return { partial: `${p.what}: ${kb(r.offset)} of ${kb(first.total)} copied so far`, done };
            done.push(`~/${p.path} (${p.what}, ${kb(first.total)})`);
          }
          return { done };
        });
        const notes = plan.notes.length ? ` ${plan.notes.join(" ")}` : "";
        if ("partial" in value) return ok(`Not all there yet (${value.partial}${value.done.length ? `; saved: ${value.done.join(", ")}` : ""}). Call save_link again with the same link to carry on: it resumes where it stopped.${notes}`);
        return ok(`Saved on your computer: ${value.done.join(", ")}.${notes}`);
      } catch (e) {
        if (e instanceof ComputerError) return err(e.message);
        return err(`Saving failed: ${describeRead(e).replace(/^The media service failed unexpectedly: /, "")}`);
      }
    },
  };

  return [readLink, saveLink];
}
