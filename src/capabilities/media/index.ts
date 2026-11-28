import { z } from "zod";
import { err, ok, type ToolContent, type ToolDef, type ToolResult } from "agent-runtime";
import { describe, Porchkit, PorchkitError, porchkitConfig, type FetchStatus, type PorchkitConfig, type SheetAnswer, type SheetRequest } from "../../porchkit/client.ts";
import { computerConfig, type ComputerConfig } from "../computer/config.ts";
import { computersFor, localSheet, SHEET_DESCRIPTION, SHEET_FILE_NOTE, sheetSchema } from "../computer/index.ts";
import { sheetActsForOwner, sheetOptions, type SheetArgs } from "../computer/media.ts";
import { actingFor, authorisation } from "../../agent/acting.ts";
import { defineCapability, policyDelegates, policyEnables } from "../types.ts";
import { AUTOREAD_HOLD_MS, AUTOREAD_MAX_CHARS, AUTOREAD_READ_MS, autoread, autoreadHolds, autoreadParts, type Autoread, type AutoreadConfig } from "./autoread.ts";
import { FETCH_JOB_KIND, fetchJobKind, startFetch } from "./fetch.ts";
import { JOIN_WAIT_MS, joinedProbe, preparedLines, pruneResults, startPrewarms } from "./prewarm.ts";
import { readTools, SAVE_NOTE } from "./read.ts";
import { probeText, subsText } from "./text.ts";

/**
 * Media: links and videos, through porchkit (src/porchkit/client.ts), the platform's relay on the owner's
 * home connection and its main way out for reading. Always anonymous; porchkit keeps each site's request
 * budget, and refuses past it.
 *
 * WHY READING IS HERE (and not a capability of its own): reading a link and looking at a video are one
 * service, one token and one prewarm. The prewarm reads every link through `/read` (which probes a video
 * site's video itself) under one cap and one accounting table; a post's video goes on with the video tools;
 * save_link reuses video_fetch's copy onto the computer. And a chat whose policy enables media gets both, so
 * no chat loses a way to read a link when web_fetch goes (web/index.ts).
 *
 *   tools     read_link(url, comments?, offset?, video?): any link read through porchkit's `/read` (a post,
 *             a page, raw text), as text with the post's images as images (read.ts); save_link(url, what?):
 *             a page's whole text or the page as received into ~/inbox/ on the computer (read.ts; owner-only,
 *             as video_fetch, and offered only where the chat has the computer).
 *             video_probe(url): what a video is, as a few lines; video_subs(url, lang?, from?, to?): its
 *             subtitles as `[mm:ss] line` text, in pages; video_sheet(url | path, …): contact sheets, from
 *             porchkit for a link (images fetched here with the token, never shown as URLs), or on the
 *             chat's computer for a file (computer's `localSheet`, as before); video_fetch(url, quality?):
 *             the file into ~/inbox/ on the computer, as a background job (fetch.ts).
 *             Anyone may LOOK (probe, subs, sheet of a link) in a chat whose policy enables this capability;
 *             `video_fetch` is owner-only (it fills the computer and spends the home connection's budget),
 *             and so is a sheet of a file (`ownerOnlyWhen`). Their refusals say why and what to offer instead
 *             (`ownerOnlyNote`). video_fetch and a file's sheet are offered only where the chat has the
 *             computer capability too; a chat without media keeps the computer's own video_sheet (files).
 *   prewarm   `inbound`: a message that STARTS A TURN, from anyone (the waker's `isTrigger` with the chat's
 *             policy: every message in the owner's DM, a mention, a reply to her or a follow-up in a group), has
 *             every http(s) link in it, then in the message it replies to, read at once through `/read`,
 *             speculatively, at most 3, while its turn is being spawned; no host list, never a download, best
 *             effort (prewarm.ts, links.ts). A turn's input shows "(Prepared: #N's link — read_link returns at
 *             once.)" after the message once that has started (`perceive`), and read_link joins it rather than
 *             asking twice (single-flight, across the server and the runner child, through the store).
 *             video_probe asks porchkit itself, whose probe cache the read filled. Each is recorded with
 *             whether a turn then used it: the console's turn view shows "prewarmed: used / unused".
 *   auto-read a message that opens a turn with one or two links and at most SHUVI_AUTOREAD_MAX_CHARS of its own
 *             text, from a sender the boundary lets call read_link, opens with its links already read
 *             (autoread.ts): `holds` keeps its turn from opening while its prewarm is in flight (at most
 *             SHUVI_AUTOREAD_WAIT_SEC; never a message a running turn would append); then, in the runner child
 *             before the driver (`prepare`), each link whose prewarm answered is read by read_link's own handler,
 *             through the turn's boundary (authority, redaction, the prewarm's join and accounting), recorded as
 *             the framework's call, for at most SHUVI_AUTOREAD_READ_SEC and given up on at a stop; `perceive`
 *             shows what it gave as an unforgeable framework part after the message, instead of the
 *             "(Prepared: …)" line. A prewarm past the cap, failed or refused: as without it. A read that fails,
 *             runs past its cap or is stopped: not retried, a note says so. The framework still never speaks.
 *   section   reading links, then videos; with auto-read on, one sentence says a link may arrive already read.
 *   jobs      `video_fetch`: porchkit's download, then a resumable copy onto the computer (fetch.ts).
 *   loops     `media-prune`: drop prewarm answers older than an hour (the accounting stays).
 *   secrets   the porchkit token is redacted from turn transcripts (`[REDACTED:porchkit]`), and never logged.
 *
 * Fetched content goes into a turn's input only through auto-read, as read_link's own answer, marked as the
 * framework's and as untrusted; otherwise the framework only says what is ready.
 *
 *   SHUVI_PORCHKIT_URL / SHUVI_PORCHKIT_TOKEN   porchkit and shuvi's token there (both set: on; src/porchkit/)
 *   SHUVI_MEDIA_SHEET_WAIT_SEC  how long video_sheet(url) waits for a download porchkit started for it (409
 *                               `needs_file`) before saying to ask again (default 60)
 *   SHUVI_MEDIA_JOIN_WAIT_SEC   how long video_probe waits on a prewarm of its link still in flight before
 *                               asking porchkit itself (default 15: a prewarm lost to a restart never ends)
 *   SHUVI_AUTOREAD              "off" turns auto-read off (default on)
 *   SHUVI_AUTOREAD_MAX_CHARS    the most characters of a message's own text, links removed and trimmed, for it to
 *                               be auto-read (default 40)
 *   SHUVI_AUTOREAD_WAIT_SEC     the longest a qualifying message's turn is held for its prewarm (default 8)
 *   SHUVI_AUTOREAD_READ_SEC     the longest the framework's read of one link may take before the turn goes on
 *                               without it (default 10)
 */

export interface MediaConfig {
  porchkit: PorchkitConfig;
  /** The computer's configuration, when it is on: for a file's sheet and video_fetch. */
  computer: ComputerConfig | null;
  sheetWaitMs: number;
  /** How long video_probe waits on a prewarm of its link still in flight (prewarm.ts `JOIN_WAIT_MS`). */
  joinWaitMs: number;
  /** Auto-read (autoread.ts); null: off. */
  autoread: AutoreadConfig | null;
}

/** What a refusal of video_fetch adds (the boundary's, agent/turn.ts): why only the owner, and what instead. */
export const FETCH_NOTE =
  "Tell them plainly that you can't download a video for them without the owner's say-so: it puts the whole file on the owner's computer and uses the home connection's download budget. Offer what you can do instead: look at it (video_probe, video_subs, video_sheet with the link) and tell them what is in it.";

/** The sentence the reading section adds where auto-read is on. */
export const AUTOREAD_SENTENCE =
  'A link in a short message may arrive already read: its content follows the message between "[⚙ #N\'s link, read by the framework …]" and "[⚙ end of #N\'s link]", and you then need not call read_link for it.';

/** The reading part of the section; `computer`: save_link is there; `autoread`: links may arrive already read. */
export function readSection(computer: boolean, delegated = false, autoread = false): string {
  const who = delegated ? "the owner or this group's operators" : "the owner";
  return `## Reading links

To read any link, use \`read_link\`: a social post comes whole (its full text, who posted it and when, the post it quotes, and its pictures shown to you), an article or other page as markdown, JSON and plain text as they are. A post's video comes with what it is, what is said in it and a few frames when it is short; the video tools below go further with its link. \`comments\` adds a post's replies. A long page is cut: call read_link again with the \`offset\` it gives to read on${
    computer ? `, or have the whole text put on your computer with \`save_link\` (only ${who} can ask for that)` : ""
  }. When a message is followed by "(Prepared: … read_link …)", its link was read already and read_link answers at once.${autoread ? ` ${AUTOREAD_SENTENCE}` : ""}

Links are read through the owner's home connection, anonymously: nothing behind a login is ever read. Say so when that is what stops a link, rather than guessing at what it says.`;
}

/** The capability's prompt section; `computer`: the chat has a computer (video_fetch, save_link, sheets of files). */
export function mediaSection(computer: boolean, delegated = false, autoread = false): string {
  return `${readSection(computer, computer && delegated, autoread)}\n\n${videoSection(computer, delegated)}`;
}

function videoSection(computer: boolean, delegated = false): string {
  if (computer && delegated) return videoSectionDelegated();
  return `## Videos

Anyone here may ask you to look at a video, and you can, from its link. \`video_probe\` says what it is (title, length, chapters, which subtitles exist); \`video_subs\` gives what is said, with times; \`video_sheet\` with the \`url\` shows you frames from it, tiled in order with each one's time under it. Start with video_probe.

Looking never needs a download: what a sheet needs is fetched by itself. ${
    computer
      ? "`video_fetch` is something else: it puts the whole file in ~/inbox/ on your computer, and only the owner can ask for it. "
      : "Downloading a whole video is only ever for the owner, and there is no computer here to put one on anyway. "
  }When someone else asks you to download a video, tell them plainly you can't do that for them without the owner's say-so, and offer to look at it and tell them what's in it instead.

Videos come through the owner's home connection, which has a request budget for each site. When you're told to wait, tell them it's busy and roughly for how long, rather than trying again and again. Nothing behind a login (members-only, age-restricted, private) is ever fetched: say so, rather than guessing at what it shows.`;
}

/** The section in a group whose operators may ask for video_fetch too (policy `delegate: [media]`). */
function videoSectionDelegated(): string {
  return videoSection(true)
    .replace("and only the owner can ask for it. ", "and here the owner or this group's operators can ask for it. ")
    .replace(
      "When someone else asks you to download a video, tell them plainly you can't do that for them without the owner's say-so, and offer to look at it and tell them what's in it instead.",
      "Download only what is needed for work on the file itself: it uses the home connection's download budget. When someone who is not an operator asks for a download, tell them plainly you can't do that for them, and offer to look at it instead.",
    );
}

/** One client per configuration. */
const clients = new WeakMap<PorchkitConfig, Porchkit>();
export function porchkitOf(cfg: MediaConfig): Porchkit {
  let p = clients.get(cfg.porchkit);
  if (!p) clients.set(cfg.porchkit, (p = new Porchkit(cfg.porchkit)));
  return p;
}

/** A video's link: http(s) only (anything else is refused here, before porchkit sees it). */
const link = (what: string) =>
  z
    .string()
    .min(1)
    .regex(/^https?:\/\/\S+$/i, "an http(s) link")
    .describe(what);

const positive = (v: string | undefined, fallback: number) => (v && Number(v) > 0 ? Number(v) : fallback);

export function mediaConfig(env: Record<string, string | undefined>): MediaConfig | null {
  const porchkit = porchkitConfig(env);
  if (!porchkit) return null;
  const autoread: AutoreadConfig | null =
    env.SHUVI_AUTOREAD === "off"
      ? null
      : {
          maxChars: positive(env.SHUVI_AUTOREAD_MAX_CHARS, AUTOREAD_MAX_CHARS),
          holdMs: positive(env.SHUVI_AUTOREAD_WAIT_SEC, AUTOREAD_HOLD_MS / 1000) * 1000,
          readMs: positive(env.SHUVI_AUTOREAD_READ_SEC, AUTOREAD_READ_MS / 1000) * 1000,
        };
  return { porchkit, computer: computerConfig(env), sheetWaitMs: positive(env.SHUVI_MEDIA_SHEET_WAIT_SEC, 60) * 1000, joinWaitMs: positive(env.SHUVI_MEDIA_JOIN_WAIT_SEC, JOIN_WAIT_MS / 1000) * 1000, autoread };
}

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

/** Wait (up to `ms`) for porchkit's download `key` to end. */
async function awaitFetch(porch: Porchkit, key: string, ms: number, everyMs = 2_000): Promise<FetchStatus | undefined> {
  const end = Date.now() + ms;
  let st: FetchStatus | undefined;
  for (;;) {
    try {
      st = await porch.fetchStatus(key);
    } catch {
      return st;
    }
    if (st.state === "done" || st.state === "failed" || Date.now() + everyMs > end) return st;
    await Bun.sleep(everyMs);
  }
}

/**
 * video_sheet of a link: porchkit's sheets, fetched with the token and handed over as images with the index.
 * A 409 `needs_file` (the download it needs has started) is waited for up to `waitMs`, then tried once more;
 * still not there, the model is told to ask again shortly, and what it can do meanwhile.
 */
export async function urlSheet(porch: Porchkit, req: SheetRequest, waitMs: number): Promise<ToolResult> {
  let ans: SheetAnswer;
  try {
    ans = await porch.sheet(req);
  } catch (e) {
    if (!(e instanceof PorchkitError && e.code === "needs_file")) return err(describe(e));
    const started = e.body.fetch as FetchStatus | undefined;
    const st = started?.key ? await awaitFetch(porch, started.key, waitMs) : undefined;
    if (st?.state === "failed") return err(`The video had to be downloaded for that sheet, and the download failed. ${describe(new PorchkitError(0, st.error?.error ?? "failed", st.error?.detail ?? "", (st.error ?? {}) as Record<string, unknown>, st.error?.retry_after))}`);
    if (st?.state !== "done") {
      const progress = st?.bytes ? `${mb(st.bytes)}${st.total ? ` of ${mb(st.total)}` : ""} so far` : "just started";
      return ok(
        `No sheets yet: the video has to be downloaded for that sheet, and its download is under way on the media service (${progress}). Call video_sheet again with the same arguments in a minute or two. Meanwhile video_probe and video_subs work, and source: "storyboard" gives a quick low-resolution sheet where the site has previews.`,
      );
    }
    try {
      ans = await porch.sheet(req);
    } catch (e2) {
      return err(describe(e2));
    }
  }
  let images: Uint8Array[];
  try {
    images = await Promise.all(ans.sheets.map((s) => porch.sheetImage(s.url)));
  } catch (e) {
    return err(`The sheets were made but could not be read back: ${describe(e)}`);
  }
  const later = ans.source === "storyboard" && ans.fetch ? `\n(These are from the site's low-resolution previews; the video is downloading, so in a few minutes video_sheet with source: "file" gives sharp frames.)` : "";
  const content: ToolContent[] = [
    { type: "text", text: `${ans.index.trimEnd()}\n${images.length} sheet(s), in order:${later}` },
    ...images.map((b) => ({ type: "image" as const, data: Buffer.from(b).toString("base64"), mimeType: "image/jpeg" })),
  ];
  return { content };
}

const oneLine = (s: string, n = 120) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

type SheetInput = SheetArgs & { url?: string; path?: string; source?: "auto" | "file" | "storyboard"; background?: boolean };

export const media = defineCapability<MediaConfig>({
  id: "media",
  label: "reading links and videos",
  gives: "reading any link through the home relay (posts with their pictures and videos, pages, raw text) and looking at videos (what it is, its subtitles, contact sheets); saving a page or downloading a video onto the computer for the owner only.",
  enable: mediaConfig,
  ownerOnly: ["video_fetch", "save_link"],
  ownerOnlyWhen: { video_sheet: sheetActsForOwner },
  delegable: ["video_fetch", "video_sheet", "save_link"],
  ownerOnlyNote: { video_fetch: FETCH_NOTE, video_sheet: SHEET_FILE_NOTE, save_link: SAVE_NOTE },
  tools({ db, chat, turnId, state: s, chatPolicy }, cfg) {
    const porch = porchkitOf(cfg);
    const computer = cfg.computer && policyEnables(chatPolicy, "computer") ? cfg.computer : null;

    const probe: ToolDef<{ url: string }> = {
      name: "video_probe",
      description:
        "What a video link is, without downloading it: title, uploader, date, length, resolution, chapters, which subtitles and automatic captions exist. Fast, and cached: use it first on any video link (YouTube, X, Instagram, TikTok, Vimeo, Bilibili, short links…).",
      inputSchema: { url: link("The video's link, as it was sent") },
      async handler(a) {
        try {
          const { probe: p } = await joinedProbe(db, porch, chat.id, turnId, a.url, { waitMs: cfg.joinWaitMs });
          return ok(probeText(p));
        } catch (e) {
          return err(describe(e));
        }
      },
    };

    const subs: ToolDef<{ url: string; lang?: string; from?: number | string; to?: number | string }> = {
      name: "video_subs",
      description:
        "A video's subtitles as text, one `[mm:ss] line` per line: what is said, and when. Manual subtitles are preferred, then automatic captions in the video's own language; `lang` picks a language (e.g. en, ja; a machine translation only when named). " +
        "A long track comes in parts: the answer says where it was cut and the `from` to read on with; `from` / `to` also read just a window.",
      inputSchema: {
        url: link("The video's link"),
        lang: z.string().max(35).optional().describe("A language code, e.g. en, ja, zh-TW (default: the original language)"),
        from: z.union([z.number().nonnegative(), z.string()]).optional().describe('Start of the window: seconds, or "mm:ss" / "hh:mm:ss"'),
        to: z.union([z.number().nonnegative(), z.string()]).optional().describe("End of the window, as from"),
      },
      async handler(a) {
        try {
          const page = subsText(await porch.subs(a.url, a.lang), a);
          return page.ok ? ok(page.text) : err(page.error);
        } catch (e) {
          return err(describe(e));
        }
      },
    };

    const sheet: ToolDef<SheetInput> = {
      name: "video_sheet",
      description:
        `Look at a video as contact sheets: ${SHEET_DESCRIPTION} ` +
        "Give the video's `url` (anyone may ask; the media service gets the frames, from the site's previews or by downloading it, and you get the sheets at once)" +
        (computer
          ? ', or the `path` of a file on your computer (only for the owner; in the background by default, the sheets coming back with the job\'s result; background: false waits). '
          : ". ") +
        'For a link, `source` picks where frames come from: "storyboard" (the site\'s low-resolution previews: seconds, no download), "file" (the downloaded video: sharp), or "auto" (the default).',
      inputSchema: {
        url: link("The video's link").optional(),
        ...(computer ? { path: z.string().min(1).optional().describe("Or: a video file on the computer, e.g. ~/inbox/123-clip.mp4") } : {}),
        ...sheetSchema,
        source: z.enum(["auto", "file", "storyboard"]).optional().describe('With url: "storyboard", "file" or "auto" (default)'),
        ...(computer ? { background: z.boolean().optional().describe("With path: false waits for the sheets (default true)") } : {}),
      },
      async handler(a) {
        if ((a.url === undefined) === (a.path === undefined)) return err(computer ? "Give one of url (a link) or path (a file on your computer)." : "Give the video's url.");
        const plan = sheetOptions(a);
        if (!plan.ok) return err(plan.error);
        if (a.path !== undefined) {
          if (!computer) return err("There is no computer in this chat to read a file from; give the video's link (url) instead.");
          return localSheet({ db, chat, computers: computersFor(db, computer), cfg: computer }, s, { ...a, path: a.path });
        }
        const req: SheetRequest = { url: a.url! };
        for (const k of ["every", "count", "scene", "from", "to", "grid", "source"] as const) if (a[k] !== undefined) (req as Record<string, unknown>)[k] = a[k];
        return urlSheet(porch, req, cfg.sheetWaitMs);
      },
    };

    const fetchTool: ToolDef<{ url: string; quality?: "low" | "best" }> = {
      name: "video_fetch",
      description:
        "Download a video into ~/inbox/ on your computer, for work on the file itself (cutting, converting, sending it). Only the owner may ask for it, and it is not needed to look at a video: video_sheet with the link does that. " +
        'In the background: you get a job id at once, and the result, with the file\'s path, comes back to this chat as a job event; end your turn meanwhile. `quality`: "low" (the default, up to 480p, no sound) or "best" (up to 1080p, with sound).',
      inputSchema: {
        url: link("The video's link"),
        quality: z.enum(["low", "best"]).optional().describe('"low" (default) or "best"'),
      },
      async handler(a) {
        const r = await startFetch(db, porch, {
          chatId: chat.id,
          originSeq: s.toSeq,
          url: a.url,
          ...(a.quality ? { quality: a.quality } : {}),
          title: `video_fetch ${oneLine(a.url)}${a.quality ? ` (${a.quality})` : ""}`,
          authorised: authorisation(actingFor(s, "video_fetch")),
        });
        return r.ok ? ok(r.text) : err(r.text);
      },
    };

    const reading = readTools({ db, chat, turnId, porch, computer, joinWaitMs: cfg.joinWaitMs });
    return [{ serverName: "shuvi", tools: [...reading, probe, subs, sheet, ...(computer ? [fetchTool] : [])] as ToolDef[] }];
  },
  section: (ctx, cfg) => mediaSection(!!cfg.computer && policyEnables(ctx.chatPolicy, "computer"), policyDelegates(ctx.chatPolicy, "media"), !!cfg.autoread),
  jobKinds: (cfg) => [fetchJobKind(porchkitOf(cfg), cfg.computer)],
  inbound(event, { db, chatPolicy, wake }, cfg) {
    void startPrewarms(db, porchkitOf(cfg), event, chatPolicy, Date.now(), wake);
  },
  holds(event, now, cfg, ctx) {
    return !!cfg.autoread && autoreadHolds(ctx, event, now, cfg.autoread);
  },
  async prepare(events, ctx, cfg) {
    return cfg.autoread ? autoread(events, ctx, cfg.autoread) : undefined;
  },
  perceive(event, _cfg, { db, prepared }): ToolContent[] {
    if (!db || event.kind !== "message") return [];
    const read = (prepared as Autoread | undefined)?.get(event.seq);
    const lines = preparedLines(db, event, Date.now(), new Set(read?.keys() ?? []));
    return [...(lines.length ? [{ type: "text" as const, text: lines.join("\n") }] : []), ...(read?.size ? autoreadParts(event, read) : [])];
  },
  loops: ({ db }) => [{ name: "media-prune", everyMs: 10 * 60_000, run: async () => void pruneResults(db) }],
  secrets: (cfg) => ({ porchkit: cfg.porchkit.token }),
});

export { FETCH_JOB_KIND };
