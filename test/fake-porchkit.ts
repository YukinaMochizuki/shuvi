import { createHash } from "node:crypto";

/**
 * A fake porchkit for tests and the e2e script, over real HTTP (Bun), so the client under test is what
 * talks to it. Made-up videos only:
 *
 *   POST /media/probe   a probe of any URL it knows (`videos`), after `probeDelayMs`; others: 404
 *   POST /media/subs    `[mm:ss] line` text (`subtitleLines` lines per video)
 *   POST /media/sheet   sheets served as JPEGs at /media/sheets/<id>/<n>.jpg; for a URL in `needsFile` whose
 *                       file is not fetched yet, 409 needs_file, starting its fetch
 *   POST /media/fetch   a download that advances one state per status read (queued → downloading → done)
 *   GET  /media/fetch/<key>, GET /files/<key> (with Range)
 *   POST /read          as porchkit's docs/decisions/read.md: an X post (`X_POST`: text, 2 images, a short
 *                       video with poster, probe, transcript and sheet, a quoted post), a Reddit post with
 *                       replies (`REDDIT_POST`), a long page cut at `pageMaxChars` with `full` and
 *                       `original` (`LONG_PAGE`), a short page read whole (`SHORT_PAGE`), raw JSON
 *                       (`RAW_JSON`), a known video's link (`videos`) as a `youtube` post whose video carries
 *                       its probe and poster; a `.pdf` is 415 unsupported_type; anything else 404. A speculative read
 *                       leaves a video's transcript and sheet out, as porchkit does. Its files (images,
 *                       posters, the page's whole text and original) are served by GET /files/<key>.
 *
 *   /browse             as porchkit's docs/decisions/desktop.md ("API"): `GET /browse/status` from `browse`;
 *                       `POST /browse/sessions/<s>/act` opens the session's window on its first act (at most
 *                       `browse.maxSessions`, then 503 busy); a made-up shop (`SHOP`): its home page links to an
 *                       item and has buttons that raise an alert (accepted, a note), a confirm and a prompt; the
 *                       item's page has "Add to cart" and "立即購買" (never guarded) leading to a checkout page
 *                       (`checkout: true`). The guard, as porchkit's: without `approved: true`, 403
 *                       approval_required for a click on a final-step button (`FINAL_STEP`) anywhere, and on the
 *                       checkout page for any button click, Enter, type with submit, or accepting a dialog; and for
 *                       accepting a dialog whose message reads like `FINAL_STEP` anywhere. The checkout's "Pay"
 *                       opens a confirm "Confirm and pay NT$1,280?". While a confirm / prompt is open
 *                       (`browse.dialogs`, settable by a test) every act but `dialog` is 409 dialog_open; the act
 *                       that opened it answers with `dialog` and no snapshot. A ref not on the page is 422 bad_ref;
 *                       `browse.takeover` is 409; Google sign-in and account-security pages (`ownerOnlyUrl`) 403
 *                       owner_only, the rest of the account (`PROFILE`, its "Change photo" button and file input) not;
 *                       `POST /browse/sessions/<s>/uploads` holds a file (`browse.uploads`; > 20 MB 413 too_large,
 *                       an 11th 409 too_many) and the act `upload` sets it on a file input (`ref`, recorded in
 *                       `browse.inputs`) or arms the next file chooser, which a click on "Change photo" opens
 *                       (`browse.chosen`); `internal.example` 403
 *                       egress_refused; a screenshot is a PNG served by GET /files/<key>. `DELETE
 *                       /browse/sessions/<s>` 204. Every act is recorded in `calls` (`of("/browse/sessions/")`).
 *                       `GET /browse/sessions/<s>/downloads` lists `browse.downloads` (`addDownload` puts one there,
 *                       its file served by GET /files/<key> once completed); the act `pdf` answers `pdf: {key,
 *                       bytes}` (a small made-up PDF). `browse.reportBytes` makes a screenshot's or a PDF's answer
 *                       claim that size (a large file without the bytes).
 *
 * Errors by URL (any endpoint but /browse): one containing `private` is 422 unavailable, `busy` 429 (Retry-After 180),
 * `internal.example` 403 egress_refused, `broken` 502, `slow` 504. `failNext(path, …)` queues one answer for
 * the next call of a path. Every request is recorded (`calls`), with whether it carried the token.
 */

/** A 1x1 JPEG: what every sheet is here. */
export const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

/** A 1x1 PNG: every screenshot of the fake desktop. */
export const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

export const FAKE_TOKEN = "pk-fake-token-0123456789abcdef";

/** The fake desktop's made-up shop. */
export const SHOP = "https://shop.example.com/";
export const SHOP_ITEM = "https://shop.example.com/item/42";
export const SHOP_CHECKOUT = "https://shop.example.com/checkout";
export const SHOP_DONE = "https://shop.example.com/order/done";
/** shuvi's own Google profile page: no longer the owner's (owner decision); a file chooser and a file input. */
export const PROFILE = "https://myaccount.google.com/personal-info";
/** A page drawn on a canvas: its "Start" button is at x 100–200, y 100–150 (1280-wide pixels), not in the page text. */
export const CANVAS = "https://game.example.com/";
/** A page that a captcha blocks, and one with a native popup open. */
export const CAPTCHA = "https://blocked.example.com/";
export const POPUP_PAGE = "https://cookies.example.com/";
/** A form with a dropdown. */
export const FORM = "https://forms.example.com/apply";
/** porchkit's hints per page (the fake's own). */
const PAGE_HINTS: Record<string, string[]> = { [CANVAS]: ["page: canvas-heavy"], [CAPTCHA]: ["blocked-by: captcha"], [POPUP_PAGE]: ["native-popup: press Escape"] };
/** A dropdown's options, by `<page> <ref>`. */
const SELECT_OPTIONS: Record<string, string[]> = { [`${FORM} e2`]: ["Japan", "Taiwan", "United States"] };

type FakeDialog = { type: "alert" | "confirm" | "prompt"; message: string; default_prompt?: string | null; /** Where accepting it leads. */ then?: string };

/** Each page of the shop: its title, and its elements by ref ([role, name, where a click leads, the dialog it raises]). */
const SHOP_PAGES: Record<string, { title: string; refs: Record<string, [string, string, string | null, FakeDialog?]> }> = {
  [SHOP]: {
    title: "Example Shop",
    refs: {
      e1: ["link", "A teapot", SHOP_ITEM],
      e2: ["searchbox", "Search", null],
      e3: ["button", "Show tip", null, { type: "alert", message: "Free shipping today" }],
      e4: ["button", "Clear history", null, { type: "confirm", message: "Clear your browsing history?" }],
      e5: ["button", "Gift message", null, { type: "prompt", message: "Your gift message?", default_prompt: "Enjoy!" }],
    },
  },
  [SHOP_ITEM]: { title: "A teapot - Example Shop", refs: { e1: ["button", "Add to cart", SHOP_CHECKOUT], e2: ["link", "Home", SHOP], e3: ["button", "立即購買", SHOP_CHECKOUT] } },
  [SHOP_CHECKOUT]: {
    title: "Checkout - Example Shop",
    refs: {
      e1: ["textbox", "Note to seller", null],
      e2: ["button", "Place order", SHOP_DONE],
      e3: ["button", "Pay", null, { type: "confirm", message: "Confirm and pay NT$1,280?", then: SHOP_DONE }],
    },
  },
  [SHOP_DONE]: { title: "Thank you - Example Shop", refs: { e1: ["link", "Home", SHOP] } },
  [PROFILE]: { title: "Personal info - Google Account", refs: { e1: ["button", "Change photo", null], e2: ["button", "Choose file", null], e3: ["textbox", "Name", null] } },
  [CANVAS]: { title: "Canvas game", refs: { e1: ["canvas", "", null] } },
  [CAPTCHA]: { title: "Just a moment...", refs: { e1: ["checkbox", "I am human", null] } },
  [POPUP_PAGE]: { title: "Cookies", refs: { e1: ["link", "Home", SHOP] } },
  [FORM]: { title: "A long form", refs: { e1: ["textbox", "Name", null], e2: ["combobox", "Country", null], e3: ["button", "Next", null], e4: ["link", "Terms", null] } },
};
/** Google sign-in and account security (password, 2-Step, passkeys, recovery, deleting the account): the owner's. */
export function ownerOnlyUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname === "accounts.google.com") return true;
    return u.hostname === "myaccount.google.com" && /^\/(security|signinoptions|two-step-verification|recovery|delete-services-or-account)/.test(u.pathname);
  } catch {
    return false;
  }
}
/** Final-step words, as porchkit's table (a sample): a click on such a button, or accepting such a dialog, places an order. */
export const FINAL_STEP = /place (this |the )?order|pay now|confirm and pay|確認付款|送出訂單|下單/i;

export interface FakeBrowse {
  /** Whether a desktop is configured at all (false: every /browse call 503 unavailable). */
  available: boolean;
  takeover: boolean;
  google: boolean | null;
  liveUrl: string | null;
  maxSessions: number;
  /** Open sessions: their history (the last is the current page). */
  sessions: Map<string, string[]>;
  /** The confirm / prompt open in a session. */
  dialogs: Map<string, FakeDialog>;
  /** Each session's downloads, as GET /browse/sessions/<s>/downloads lists them. */
  downloads: Map<string, { key: string | null; name: string; bytes: number; mime: string; state: string }[]>;
  /** Files held for each session's page (uploads), with their bytes. */
  uploads: Map<string, { id: string; name: string; bytes: Uint8Array }[]>;
  /** A session's next file chooser, armed with these files' names. */
  armed: Map<string, string[]>;
  /** What a session's file chooser got when the page opened it. */
  chosen: Map<string, string[]>;
  /** What each file input (`<session> <ref>`) was set to. */
  inputs: Map<string, string[]>;
  /** Every pointer act's body, in order; how many hit the canvas's Start button. */
  pointers: Record<string, unknown>[];
  canvasHits: number;
  /** Every screenshot asked for, with marks or grid. */
  screenshots: { marks: boolean; grid: boolean }[];
  /** What each select (`<session> <ref>`) was set to. */
  selected: Map<string, string>;
  popupClosed: boolean;
  /** Cut every page text after this many elements, with `next_offset` (porchkit cuts at max_chars). */
  cutAt?: number;
  /** The next pointer act answers 409 target_changed (the point holds something else now). */
  targetChangedNext?: boolean;
  /** What a watch's `urls` says (default: the page's URL at every frame). */
  watchUrls?: string[];
  /** A size a screenshot's or a PDF's answer claims instead of its own. */
  reportBytes?: number;
}

/** The fake page's PDF. */
export const FAKE_PDF = new TextEncoder().encode("%PDF-1.4\n% a made-up PDF for tests\n%%EOF\n");

export const X_POST = "https://x.com/example/status/1234567890";
export const REDDIT_POST = "https://www.reddit.com/r/example/comments/abc123/an_example_thread/";
export const LONG_PAGE = "https://news.example.com/long-article";
export const SHORT_PAGE = "https://news.example.com/short-note";
export const RAW_JSON = "https://api.example.com/data.json";

/** The long page's whole markdown: numbered paragraphs, well over `pageMaxChars`. */
export const LONG_MARKDOWN = `# An example article\n\n${Array.from({ length: 400 }, (_, i) => `Paragraph ${i + 1} of the example article, made up for tests and saying nothing at all.`).join("\n\n")}\n`;
export const LONG_HTML = `<!doctype html><html><head><title>An example article</title></head><body><nav>menu</nav><article>${LONG_MARKDOWN.replace(/\n/g, "<br>")}</article></body></html>`;

export interface FakeVideo {
  title: string;
  /** The site's own text (a tweet's full text, a caption, a description); porchkit answers null without. */
  description?: string;
  duration: number;
  chapters?: { start: number; end: number; title: string }[];
}

export interface PorchCall {
  method: string;
  path: string;
  body: Record<string, unknown>;
  authed: boolean;
  range?: string | null;
}

const hex = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

export class FakePorchkit {
  readonly calls: PorchCall[] = [];
  readonly videos = new Map<string, FakeVideo>();
  /** URLs whose sheet needs the file first (409 until fetched). */
  readonly needsFile = new Set<string>();
  probeDelayMs = 0;
  subtitleLines = 20;
  /** Status reads before a fetch is done (each read advances it). */
  fetchSteps = 2;
  /** The fetched file's bytes. */
  fileBytes: Uint8Array = new Uint8Array(3 * 1024 * 1024 + 123).map((_, i) => (i * 31) & 0xff);
  /** Range requests to refuse (with 502) before serving again: a dropped copy. */
  failRanges = 0;
  /** `/read`: the most characters of a page (or raw text) answered from `offset`. */
  pageMaxChars = 20_000;
  /** `/read`: how long each read takes. */
  readDelayMs = 0;
  /** `/read`'s files, by key: images, posters, a page's whole text and original. */
  readonly readFiles = new Map<string, { bytes: Uint8Array; type: string }>();
  private readonly fetches = new Map<string, { url: string; reads: number; state: string }>();
  private readonly queued = new Map<string, { status: number; body: Record<string, unknown>; headers?: Record<string, string> }[]>();
  private server: ReturnType<typeof Bun.serve>;
  readonly browse: FakeBrowse = { available: true, takeover: false, google: true, liveUrl: "https://porchkit.example.ts.net:8444/", maxSessions: 3, sessions: new Map(), dialogs: new Map(), downloads: new Map(), uploads: new Map(), armed: new Map(), chosen: new Map(), inputs: new Map(), pointers: [], canvasHits: 0, screenshots: [], selected: new Map(), popupClosed: false };

  constructor(readonly token = FAKE_TOKEN) {
    this.videos.set("https://www.youtube.com/watch?v=abc123def45", {
      title: "Example talk",
      description: "A talk about examples.\nSlides: https://example.com/slides",
      duration: 635,
      chapters: [
        { start: 0, end: 120, title: "Intro" },
        { start: 120, end: 635, title: "The main part" },
      ],
    });
    this.server = Bun.serve({ port: 0, idleTimeout: 60, fetch: (req) => this.handle(req) });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  env(extra: Record<string, string> = {}): Record<string, string> {
    return { SHUVI_PORCHKIT_URL: this.url, SHUVI_PORCHKIT_TOKEN: this.token, ...extra };
  }

  /** The calls of `path` (a prefix), e.g. "/media/probe". */
  of(path: string): PorchCall[] {
    return this.calls.filter((c) => c.path.startsWith(path));
  }

  /** Paths whose next answer starts (200) and then breaks off mid-body: a connection dropped while it was read. */
  readonly dropNext = new Set<string>();

  failNext(path: string, status: number, body: Record<string, unknown>, headers?: Record<string, string>): void {
    this.queued.set(path, [...(this.queued.get(path) ?? []), { status, body, ...(headers ? { headers } : {}) }]);
  }

  stop(): void {
    this.server.stop(true);
  }

  /** The known video a URL names (any youtu.be / youtube.com shape of the one id; else exactly). */
  private video(url: string): { canon: string; v: FakeVideo } | undefined {
    const id = url.match(/(?:v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{11})/)?.[1];
    for (const [canon, v] of this.videos) if (canon === url || (id && canon.includes(id))) return { canon, v };
    return undefined;
  }

  private async handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const authed = req.headers.get("authorization") === `Bearer ${this.token}`;
    let body: Record<string, unknown> = {};
    const up = req.method === "POST" ? u.pathname.match(/^\/browse\/sessions\/([A-Za-z0-9_-]{1,64})\/uploads$/) : null;
    if (up) {
      const bytes = new Uint8Array(await req.arrayBuffer());
      const name = req.headers.get("x-filename") ?? "";
      this.calls.push({ method: req.method, path: u.pathname, body: { name, bytes: bytes.length }, authed, range: null });
      if (!authed) return Response.json({ error: "unauthorized", detail: "no valid bearer token" }, { status: 401 });
      if (!name) return Response.json({ error: "bad_request", detail: "X-Filename is required" }, { status: 400 });
      if (bytes.length > 20 * 1024 * 1024) return Response.json({ error: "too_large", detail: "uploads are at most 20 MB" }, { status: 413 });
      const list = this.browse.uploads.get(up[1]!) ?? [];
      if (list.length >= 10) return Response.json({ error: "too_many", detail: "at most 10 uploads per session" }, { status: 409 });
      const held = { id: `u${list.length + 1}`, name: decodeURIComponent(name), bytes };
      list.push(held);
      this.browse.uploads.set(up[1]!, list);
      return Response.json({ id: held.id, name: held.name, bytes: bytes.length });
    }
    if (req.method === "POST") {
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    this.calls.push({ method: req.method, path: u.pathname, body, authed, range: req.headers.get("range") });
    if (!authed) return Response.json({ error: "unauthorized", detail: "no valid bearer token" }, { status: 401 });
    const q = this.queued.get(u.pathname)?.shift();
    if (q) return Response.json(q.body, { status: q.status, ...(q.headers ? { headers: q.headers } : {}) });
    if (u.pathname.startsWith("/browse/")) {
      const answer = this.browseRoute(req.method, u.pathname, body);
      if (!this.dropNext.delete(u.pathname)) return answer;
      const half = (await answer.text()).slice(0, 10);
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(half));
            c.error(new Error("dropped"));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }

    const url = typeof body.url === "string" ? body.url : "";
    if (url) {
      if (url.includes("private")) return Response.json({ error: "unavailable", detail: "Private video. Sign in if you've been granted access" }, { status: 422 });
      if (url.includes("busy")) return Response.json({ error: "rate_limited", reason: "budget", site: "youtube", retry_after: 180, detail: "youtube: budget, retry in 180s" }, { status: 429, headers: { "retry-after": "180" } });
      if (url.includes("internal.example")) return Response.json({ error: "egress_refused", detail: "the address is not public" }, { status: 403 });
      if (url.includes("broken")) return Response.json({ error: "upstream_failed", detail: "the site answered 500." }, { status: 502 });
      if (url.includes("slow")) return Response.json({ error: "upstream_timeout", detail: "no answer within 90s." }, { status: 504 });
    }

    if (req.method === "POST" && u.pathname === "/read") {
      if (this.readDelayMs) await Bun.sleep(this.readDelayMs);
      return this.read(body);
    }
    if (req.method === "POST" && u.pathname === "/media/probe") {
      if (this.probeDelayMs) await Bun.sleep(this.probeDelayMs);
      const found = this.video(url);
      if (!found) return Response.json({ error: "not_found", detail: "no video at that URL" }, { status: 404 });
      const { canon, v } = found;
      return Response.json({
        id: `youtube:${canon.slice(-11)}`,
        canonical_url: canon,
        extractor: "youtube",
        title: v.title,
        description: v.description ?? null,
        uploader: "Example Channel",
        uploader_id: "@examplechannel",
        upload_date: "20260101",
        duration: v.duration,
        live_status: "not_live",
        language: "en",
        width: 1920,
        height: 1080,
        chapters: v.chapters ?? [],
        subtitles: ["en"],
        auto_captions: ["en"],
        auto_caption_translations: 157,
        storyboard: { available: true, levels: [] },
        formats: { count: 57, video_heights: [144, 360, 480, 1080], h264_heights: [144, 360, 480, 1080], audio: true },
        cached: false,
      });
    }
    if (req.method === "POST" && u.pathname === "/media/subs") {
      const found = this.video(url);
      if (!found) return Response.json({ error: "not_found", detail: "no video at that URL" }, { status: 404 });
      const lines = Array.from({ length: this.subtitleLines }, (_, i) => {
        const t = i * 5;
        return `[${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}] This is spoken line number ${i + 1} of the example talk.`;
      });
      return Response.json({ id: `youtube:${found.canon.slice(-11)}`, lang: (body.lang as string) ?? "en", kind: "manual", lines: lines.length, text: `${lines.join("\n")}\n`, cached: false });
    }
    if (req.method === "POST" && u.pathname === "/media/sheet") {
      const found = this.video(url);
      if (!found) return Response.json({ error: "not_found", detail: "no video at that URL" }, { status: 404 });
      const key = hex(`${found.canon}|low`);
      if (this.needsFile.has(found.canon) && this.fetches.get(key)?.state !== "done") {
        const f = this.startFetch(key, found.canon);
        return Response.json({ error: "needs_file", detail: "the video is not fetched yet; its fetch has started, so ask again when it is done", fetch: this.status(key, f, false) }, { status: 409 });
      }
      const id = hex(`${found.canon}|${JSON.stringify(body)}`);
      const sheets = [1, 2].map((n) => ({ url: `/media/sheets/${id}/${n}.jpg`, labels: ["00:00", "00:40"] }));
      return Response.json({
        id,
        source: "storyboard",
        index: `video: ${found.v.title} · 10:35 (635.0s) · 1920x1080\nsource: storyboard (160x90 thumbnails, one every 4.96s)\n32 frame(s), spread evenly, on 2 sheet(s) of 4x4:\nsheet-01.jpg: 00:00 00:20 …\nsheet-02.jpg: 05:20 05:40 …\n`,
        sheets,
        cached: false,
      });
    }
    const sheet = u.pathname.match(/^\/media\/sheets\/([0-9a-f]{32})\/(\d+)\.jpg$/);
    if (req.method === "GET" && sheet) return new Response(TINY_JPEG, { headers: { "content-type": "image/jpeg" } });
    if (req.method === "POST" && u.pathname === "/media/fetch") {
      const found = this.video(url);
      if (!found) return Response.json({ error: "not_found", detail: "no video at that URL" }, { status: 404 });
      const key = hex(`${found.canon}|${(body.quality as string) ?? "low"}`);
      const f = this.startFetch(key, found.canon);
      return Response.json(this.status(key, f, false));
    }
    const st = u.pathname.match(/^\/media\/fetch\/([0-9a-f]{32})$/);
    if (req.method === "GET" && st) {
      const f = this.fetches.get(st[1]!);
      if (!f) return Response.json({ error: "not_found", detail: "no such fetch (or its file has expired); fetch it again" }, { status: 404 });
      return Response.json(this.status(st[1]!, f, true));
    }
    const file = u.pathname.match(/^\/files\/([0-9a-f]{32})$/);
    const readFile = file ? this.readFiles.get(file[1]!) : undefined;
    if (req.method === "GET" && readFile) {
      const all = readFile.bytes;
      const r = req.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
      if (!r) return new Response(all, { headers: { "content-type": readFile.type } });
      const start = Number(r[1]);
      const end = Math.min(r[2] ? Number(r[2]) : all.length - 1, all.length - 1);
      return new Response(all.subarray(start, end + 1), { status: 206, headers: { "content-type": readFile.type, "content-range": `bytes ${start}-${end}/${all.length}` } });
    }
    if (req.method === "GET" && file) {
      if (this.fetches.get(file[1]!)?.state !== "done") return Response.json({ error: "not_found", detail: "no such file (or it has expired); fetch it again" }, { status: 404 });
      if (this.failRanges > 0) {
        this.failRanges--;
        return Response.json({ error: "upstream_failed", detail: "dropped" }, { status: 502 });
      }
      const all = this.fileBytes;
      const r = req.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
      if (!r) return new Response(all, { headers: { "content-type": "video/mp4" } });
      const start = Number(r[1]);
      const end = Math.min(r[2] ? Number(r[2]) : all.length - 1, all.length - 1);
      return new Response(all.subarray(start, end + 1), { status: 206, headers: { "content-type": "video/mp4", "content-range": `bytes ${start}-${end}/${all.length}` } });
    }
    return Response.json({ error: "not_found", detail: `no route ${req.method} ${u.pathname}` }, { status: 404 });
  }

  // ---- /browse --------------------------------------------------------------------------------------------

  private browseRoute(method: string, path: string, body: Record<string, unknown>): Response {
    const fail = (status: number, error: string, detail: string) => Response.json({ error, detail }, { status });
    const b = this.browse;
    if (!b.available) return fail(503, "unavailable", "no desktop is configured");
    if (method === "GET" && path === "/browse/status") {
      return Response.json({
        available: true,
        takeover: b.takeover,
        signed_in: { google: b.google },
        live_url: b.liveUrl,
        sessions: [...b.sessions].map(([session, h]) => ({ session, url: h.at(-1) ?? "about:blank", title: SHOP_PAGES[h.at(-1) ?? ""]?.title ?? "", idle_seconds: 5 })),
      });
    }
    const dl = path.match(/^\/browse\/sessions\/([A-Za-z0-9_-]{1,64})\/downloads$/);
    if (method === "GET" && dl) return Response.json({ downloads: b.downloads.get(dl[1]!) ?? [] });
    const m = path.match(/^\/browse\/sessions\/([A-Za-z0-9_-]{1,64})(\/act)?$/);
    if (!m) return fail(404, "not_found", `no route ${method} ${path}`);
    const id = m[1]!;
    if (method === "DELETE" && !m[2]) {
      b.sessions.delete(id);
      return new Response(null, { status: 204 });
    }
    if (method !== "POST" || !m[2]) return fail(404, "not_found", `no route ${method} ${path}`);
    if (b.takeover) return fail(409, "takeover", "the owner holds the live view; wait or ask him");
    let h = b.sessions.get(id);
    if (!h) {
      if (b.sessions.size >= b.maxSessions) return fail(503, "busy", `${b.maxSessions} sessions are open`);
      b.sessions.set(id, (h = ["about:blank"]));
    }
    const here = h.at(-1)!;
    const page = SHOP_PAGES[here];
    const host = (url: string) => {
      try {
        return new URL(url).hostname;
      } catch {
        return "";
      }
    };
    const isCheckout = here === SHOP_CHECKOUT;
    const needs = (cond: boolean, target?: Record<string, unknown>) =>
      cond && body.approved !== true ? Response.json({ error: "approval_required", detail: "that could place an order; it needs approved: true", ...(target ? { target } : {}) }, { status: 403 }) : null;
    const action = String(body.action ?? "");
    const open = b.dialogs.get(id);
    if (open && action !== "dialog") return fail(409, "dialog_open", `a ${open.type} is open; answer it with the dialog action`);
    const notes: string[] = [];
    /** porchkit's situation, on every act answer. */
    const situation: Record<string, unknown> = { url_changed: false, dialog_opened: false, popup_opened: false, hints: [] };
    let only: string | undefined;
    let from = 0;
    const img = (name: string, width: number, height: number, bytes = TINY_PNG.length) => ({ key: this.keep(name, TINY_PNG, "image/png"), width, height, bytes });
    const tabsOf = (url: string) => [{ index: 0, url, title: SHOP_PAGES[url]?.title ?? "", active: true }];
    /** Every act answer: session, url, title, checkout, notes, situation, and what the act adds. */
    const reply = (fields: Record<string, unknown>, withSituation = true) => {
      const now = h.at(-1)!;
      situation.url_changed = now !== here;
      situation.hints = PAGE_HINTS[now] ?? [];
      return Response.json({ session: id, url: now, title: SHOP_PAGES[now]?.title ?? "", checkout: now === SHOP_CHECKOUT, notes, ...(withSituation ? { situation } : {}), ...fields });
    };
    /** A snapshot answer's own fields: the page text (cut at `browse.cutAt` refs, with `next_offset`), tabs. */
    const snapshot = () => {
      const now = h.at(-1)!;
      const p = SHOP_PAGES[now];
      const all = Object.entries(p?.refs ?? {}).filter(([ref]) => only === undefined || ref === only).map(([ref, [role, name]]) => `[${ref}] ${role} "${name}"`);
      const rest = all.slice(from);
      const cut = b.cutAt !== undefined && rest.length > b.cutAt;
      const shown = cut ? rest.slice(0, b.cutAt) : rest;
      return { snapshot: [`URL: ${now}`, `Title: ${p?.title ?? ""}`, ...shown].join("\n"), tabs: tabsOf(now), ...(cut ? { next_offset: from + b.cutAt! } : {}) };
    };
    switch (action) {
      case "open": {
        const url = String(body.url ?? "");
        if (ownerOnlyUrl(url)) return fail(403, "owner_only", "the owner does this through the live view");
        if (url.includes("internal.example")) return fail(403, "egress_refused", "the address is not public");
        h.push(url);
        break;
      }
      case "snapshot":
        if (body.ref !== undefined && !page?.refs[String(body.ref)]) return fail(422, "bad_ref", "no such ref in the latest snapshot");
        if (body.ref !== undefined) only = String(body.ref);
        if (body.offset !== undefined) from = Number(body.offset);
        break;
      case "wait":
      case "scroll":
        break;
      case "hover": {
        if (!page?.refs[String(body.ref)]) return fail(422, "bad_ref", "no such ref in the latest snapshot");
        notes.push(`hovering ${String(body.ref)}`);
        break;
      }
      case "select": {
        const r = page?.refs[String(body.ref)];
        if (!r) return fail(422, "bad_ref", "no such ref in the latest snapshot");
        const options = SELECT_OPTIONS[`${here} ${String(body.ref)}`] ?? [];
        const option = String(body.option);
        if (!options.includes(option)) return Response.json({ error: "bad_request", detail: `no option "${option}"`, options }, { status: 400 });
        b.selected.set(`${id} ${String(body.ref)}`, option);
        return reply({ ...snapshot(), select: { selected: option, value: option.toLowerCase().replace(/\s+/g, "-"), via: "select" } });
      }
      case "find": {
        const q = String(body.query ?? "").toLowerCase();
        const found = Object.entries(page?.refs ?? {})
          .filter(([, [, name]]) => name.toLowerCase().includes(q))
          .map(([ref, [role, name]]) => ({ ref, line: `[${ref}] ${role} "${name}"`, context: page?.title ?? "" }));
        return reply({ tabs: tabsOf(here), query: String(body.query ?? ""), matches: found.slice(0, 40), total: found.length });
      }
      case "wait_for": {
        const names = Object.values(page?.refs ?? {}).map(([, name]) => name);
        const met =
          body.text !== undefined ? names.some((n) => n.includes(String(body.text))) : body.ref !== undefined ? !!page?.refs[String(body.ref)] : !names.some((n) => n.includes(String(body.gone))) && !page?.refs[String(body.gone)];
        if (!met) return fail(504, "timeout", `not within ${String(body.timeout)}s`);
        return reply({ ...snapshot(), wait_for: { met: true, seconds: 0.4 } });
      }
      case "zoom": {
        const region = { x: Number(body.x), y: Number(body.y), w: Number(body.w), h: Number(body.h) };
        return reply({ width: 400, height: 300, region, factor: 2, zoom: img(`zoom-${here}`, 400, 300) });
      }
      case "watch": {
        const frames = Number(body.frames ?? 6);
        const seconds = Number(body.seconds ?? 3);
        const tiles = Array.from({ length: frames }, (_, i) => ({ t: Math.round((i * seconds * 10) / (frames - 1)) / 10, x: (i % 3) * 320, y: Math.floor(i / 3) * 270, w: 320, h: 270 }));
        const urls = b.watchUrls ?? Array.from({ length: frames }, () => here);
        return reply({ width: 960, height: 540, tiles, tile_scale: 0.25, changed_pct: 3.5, urls, sheet: img(`watch-${here}`, 960, 540) });
      }
      case "pointer": {
        b.pointers.push(body);
        // Coordinates come in the screenshot's pixels (`image_width`); the page is 1280 wide.
        const scale = 1280 / (Number(body.image_width) || 1280);
        const x = Number(body.x) * scale;
        const y = Number(body.y) * scale;
        const kind = String(body.kind);
        const hit = here === CANVAS && x >= 100 && x <= 200 && y >= 100 && y <= 150;
        // `names`: the hit node's text, then its ancestors' names (always there); a drag's end point in `to`.
        const target: Record<string, unknown> = isCheckout
          ? { role: "button", name: "Pay", ref: "e3", in_canvas: false, names: ["Pay", "Order summary"] }
          : { role: here === CANVAS ? "canvas" : "generic", name: "", ref: null, in_canvas: here === CANVAS, names: hit ? ["Start", "Game area"] : [] };
        if (kind === "drag") target.to = { role: "canvas", name: "", ref: null, in_canvas: here === CANVAS, names: ["Goal"] };
        // A dry run has no situation: nothing was done.
        if (body.dry_run === true) return reply({ tabs: tabsOf(here), target, dry_run: true }, false);
        if (b.targetChangedNext) {
          b.targetChangedNext = false;
          return Response.json({ error: "target_changed", detail: "the point holds something else now", target: { role: "link", name: "Ad", ref: null, in_canvas: false } }, { status: 409 });
        }
        const pressing = ["click", "double", "right", "press_hold", "drag"].includes(kind);
        const shot = img(`pointer-${here}`, 1280, 666);
        const common = { tabs: tabsOf(here), kind, target, settled: true, settle_ms: 120, width: 1280, height: 666, scale: 1, screenshot: shot };
        if (isCheckout && pressing) {
          // A button on a checkout page: the order, as far as porchkit can tell.
          const g = needs(true, target);
          if (g) return g;
          h.push(SHOP_DONE);
          situation.visible_change_pct = 80;
          return reply({ ...common, tabs: tabsOf(SHOP_DONE), changed_pct: 80, changed_bbox: { x: 0, y: 0, w: 1280, h: 666 } });
        }
        if (hit && pressing) b.canvasHits++;
        if (hit) {
          situation.changes = [{ subtree: 'canvas ""', added: 1, removed: 0 }];
          situation.visible_change_pct = 12.5;
        } else situation.nothing_visible_changed = true;
        return reply({
          ...common,
          changed_pct: hit ? 12.5 : 0,
          ...(hit ? { changed_bbox: { x: 100, y: 100, w: 100, h: 50 } } : {}),
          closeup: { ...img(`closeup-${here}`, 200, 200), x: Math.max(0, Number(body.x) - 50), y: Math.max(0, Number(body.y) - 50), w: 100, h: 100, factor: 2 },
        });
      }
      case "click": {
        const r = page?.refs[String(body.ref)];
        if (!r) return fail(422, "bad_ref", "no such ref in the latest snapshot");
        const g = needs(FINAL_STEP.test(r[1]) || (isCheckout && r[0] === "button"));
        if (g) return g;
        if (r[3]?.type === "alert") notes.push(`dialog: alert "${r[3].message}" (accepted)`);
        else if (r[3]) {
          b.dialogs.set(id, r[3]);
          situation.dialog_opened = true;
          return reply({ tabs: tabsOf(here), dialog: { type: r[3].type, message: r[3].message, default_prompt: r[3].default_prompt ?? null } });
        }
        if (r[2]) h.push(r[2]);
        // The profile's "Change photo" opens a file chooser: an armed one takes its files.
        const armed = b.armed.get(id);
        if (here === PROFILE && r[1] === "Change photo" && armed) {
          b.chosen.set(id, armed);
          b.armed.delete(id);
          notes.push(`file chooser: ${armed.join(", ")} (set)`);
        }
        return reply(snapshot());
      }
      case "upload": {
        const held = b.uploads.get(id) ?? [];
        const ids = Array.isArray(body.files) ? (body.files as string[]) : [];
        const names = ids.map((f) => held.find((x) => x.id === f)?.name);
        if (!ids.length || names.some((n) => n === undefined)) return fail(422, "bad_upload", "no such upload in this session");
        if (body.ref !== undefined) {
          if (!page?.refs[String(body.ref)]) return fail(422, "bad_ref", "no such ref in the latest snapshot");
          b.inputs.set(`${id} ${String(body.ref)}`, names as string[]);
          notes.push(`files set on ${String(body.ref)}: ${names.join(", ")}`);
        } else {
          b.armed.set(id, names as string[]);
          notes.push(`the next file chooser gets: ${names.join(", ")}`);
        }
        break;
      }
      case "type": {
        if (body.ref !== undefined && !page?.refs[String(body.ref)]) return fail(422, "bad_ref", "no such ref in the latest snapshot");
        const g = needs(isCheckout && body.submit === true);
        if (g) return g;
        break;
      }
      case "press": {
        const g = needs(isCheckout && body.key === "Enter");
        if (g) return g;
        if (body.hold_ms !== undefined) notes.push(`held ${String(body.key)} for ${String(body.hold_ms)} ms`);
        if (body.key === "Escape" && here === POPUP_PAGE) b.popupClosed = true;
        break;
      }
      case "dialog": {
        if (!open) return fail(409, "no_dialog", "no dialog is open");
        const g = needs(body.accept === true && (isCheckout || FINAL_STEP.test(open.message)));
        if (g) return g;
        b.dialogs.delete(id);
        notes.push(`dialog: ${open.type} "${open.message}" (${body.accept === true ? "accepted" : "dismissed"})`);
        if (body.accept === true && open.then) h.push(open.then);
        break;
      }
      case "back":
        if (h.length > 1) h.pop();
        break;
      case "tab":
        if (body.index !== 0) return fail(422, "bad_ref", "no such tab");
        break;
      case "screenshot": {
        const grid = body.grid === true ? 100 : typeof body.grid === "number" ? body.grid : undefined;
        b.screenshots.push({ marks: body.marks === true, grid: grid !== undefined });
        const marks =
          body.marks === true ? Object.entries(page?.refs ?? {}).map(([ref, [role, name]], i) => ({ ref, role, name, x: 20, y: 40 + i * 40, w: 120, h: 30 })) : undefined;
        return reply({
          width: 1280,
          height: 666,
          scale: 1,
          viewport: { width: 1280, height: 666 },
          ...(marks ? { marks } : {}),
          ...(grid !== undefined ? { grid } : {}),
          screenshot: img(`screenshot-${here}`, 1280, 666, b.reportBytes ?? TINY_PNG.length),
        });
      }
      case "pdf": {
        const key = this.keep(`pdf-${here}`, FAKE_PDF, "application/pdf");
        return reply({ pdf: { key, bytes: b.reportBytes ?? FAKE_PDF.length } });
      }
      default:
        return fail(400, "bad_request", `unknown action ${action}`);
    }
    return reply(snapshot());
  }

  /** A download in `session`'s window; its key (null unless completed). */
  addDownload(session: string, name: string, bytes: Uint8Array, mime: string, state = "completed"): string | null {
    const key = state === "completed" ? this.keep(`download-${session}-${name}`, bytes, mime) : null;
    const list = this.browse.downloads.get(session) ?? [];
    list.push({ key, name, bytes: bytes.length, mime, state });
    this.browse.downloads.set(session, list);
    return key;
  }

  /** A file of `/read`'s answers, kept for GET /files/<key>; returns its key. */
  private keep(name: string, bytes: Uint8Array | string, type: string): string {
    const key = hex(`read|${name}`);
    this.readFiles.set(key, { bytes: typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes, type });
    return key;
  }

  private read(body: Record<string, unknown>): Response {
    const url = String(body.url ?? "");
    const speculative = body.speculative === true;
    const comments = Number(body.comments ?? 0);
    const video = (body.video as string) ?? "auto";
    const offset = Number(body.offset ?? 0);
    const base = { cached: false };
    if (/\.pdf(\?|$)/i.test(url)) return Response.json({ error: "unsupported_type", content_type: "application/pdf", detail: "application/pdf is not read by /read" }, { status: 415 });

    const xId = url.match(/^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/)?.[1];
    if (xId === "1234567890") {
      const v: Record<string, unknown> = { type: "video", duration: 42.5, width: 1280, height: 720, media_url: `${X_POST}/video/1` };
      if (video === "auto") {
        v.poster = { key: this.keep("poster", TINY_JPEG, "image/jpeg"), width: 1280, height: 720 };
        v.probe = { id: "x:1234567890", extractor: "twitter", title: "Example Person - a short clip", uploader: "Example Person", uploader_id: "example", upload_date: "20261114", duration: 42.5, width: 1280, height: 720, chapters: [], subtitles: ["en"], auto_captions: [], formats: { video_heights: [360, 720], audio: true } };
        if (!speculative) {
          v.transcript = { lang: "en", kind: "manual", text: "[00:01] Hello from the example clip.\n[00:05] This is the second line.\n", truncated: false };
          const id = hex("x-sheet");
          v.sheet = { id, index: "video: a short clip · 00:42 (42.5s) · 1280x720\n9 frame(s), spread evenly, on 1 sheet(s) of 3x3", sheets: [{ url: `/media/sheets/${id}/1.jpg`, labels: ["00:03", "00:08", "00:13"] }] };
        }
      }
      const media = [
        { type: "image", key: this.keep("img1", TINY_JPEG, "image/jpeg"), width: 1200, height: 800, alt: "A chart" },
        { type: "image", key: this.keep("img2", TINY_JPEG, "image/jpeg"), width: 800, height: 800, alt: null },
        v,
      ];
      return Response.json({
        kind: "post",
        source: "x",
        via: "syndication",
        canonical_url: X_POST,
        id: "x:1234567890",
        author: { name: "Example Person", handle: "@example", url: "https://x.com/example" },
        created_at: "2026-11-14T09:30:00Z",
        text: "The full text of the post, links expanded: https://example.com/article",
        lang: "en",
        metrics: { likes: 120, reposts: 14, replies: 9, views: 5300 },
        media,
        quoted: { kind: "post", source: "x", canonical_url: "https://x.com/other/status/1234567000", id: "x:1234567000", author: { name: "Other Example", handle: "@other" }, created_at: "2026-11-13T08:00:00Z", text: "The quoted post's text.", metrics: { likes: 3 }, media: [], links: [] },
        reply_to: null,
        comments: [],
        links: ["https://example.com/article"],
        notes: comments ? ["replies need a login on X; none included"] : [],
        ...base,
      });
    }
    if (url.startsWith("https://www.reddit.com/r/example/comments/abc123/")) {
      const all = [
        { kind: "post", source: "reddit", id: "reddit:c1", author: { name: "u/first_example", handle: null }, created_at: "2026-11-14T10:00:00Z", text: "The first reply.", metrics: { score: 12 }, media: [], reply_to: { id: "reddit:abc123", url: REDDIT_POST }, links: [] },
        { kind: "post", source: "reddit", id: "reddit:c2", author: { name: "u/second_example", handle: null }, created_at: "2026-11-14T10:05:00Z", text: "A reply to the first reply,\nover two lines.", metrics: { score: 4 }, media: [{ type: "image", key: null }], reply_to: { id: "reddit:c1", url: null }, links: [] },
        { kind: "post", source: "reddit", id: "reddit:c3", author: { name: "u/third_example", handle: null }, created_at: "2026-11-14T11:00:00Z", text: "The third reply.", metrics: { score: 1 }, media: [], reply_to: { id: "reddit:abc123", url: REDDIT_POST }, links: [] },
      ];
      return Response.json({
        kind: "post",
        source: "reddit",
        via: "json",
        canonical_url: REDDIT_POST,
        id: "reddit:abc123",
        author: { name: "u/example_poster", handle: null, url: "https://www.reddit.com/user/example_poster" },
        created_at: "2026-11-14T09:00:00Z",
        text: "An example thread\n\nThe body of the example thread, made up.",
        lang: null,
        metrics: { score: 321, comments: 3 },
        media: [],
        quoted: null,
        reply_to: null,
        comments: all.slice(0, comments),
        links: [],
        notes: [],
        ...base,
      });
    }
    if (url === LONG_PAGE || url === SHORT_PAGE) {
      const long = url === LONG_PAGE;
      const md = long ? LONG_MARKDOWN : "# A short note\n\nA short note, read whole.\n";
      const part = md.slice(offset, offset + this.pageMaxChars);
      const truncated = offset + part.length < md.length;
      return Response.json({
        kind: "page",
        source: "generic",
        via: "http",
        canonical_url: url,
        title: long ? "An example article" : "A short note",
        byline: long ? "Example Writer" : null,
        published: long ? "2026-11-01" : null,
        site_name: "Example News",
        lang: "en",
        markdown: part,
        truncated,
        offset,
        next_offset: truncated ? offset + part.length : null,
        total_chars: md.length,
        ...(long
          ? {
              full: { key: this.keep("long-full", md, "text/markdown"), bytes: md.length, type: "text/markdown" },
              original: { key: this.keep("long-original", LONG_HTML, "text/html"), bytes: LONG_HTML.length, type: "text/html" },
              videos: [{ media_url: "https://www.youtube.com/watch?v=abc123def45" }],
              images: [{ url: "https://news.example.com/a.jpg", alt: "An example picture" }],
              links: ["https://news.example.com/next"],
            }
          : { full: null, original: null, videos: [], images: [], links: [] }),
        notes: [],
        ...base,
      });
    }
    if (url === RAW_JSON) {
      return Response.json({ kind: "raw", source: "generic", via: "http", canonical_url: url, content_type: "application/json", text: '{"example": true, "items": [1, 2, 3]}', truncated: false, offset: 0, notes: [], ...base });
    }
    const found = this.video(url);
    if (found) {
      // A video site's link: porchkit probes the video itself (sharing /media/probe's cache).
      const { canon, v } = found;
      const probe = { id: `youtube:${canon.slice(-11)}`, extractor: "youtube", title: v.title, description: v.description ?? null, uploader: "Example Channel", uploader_id: "@examplechannel", upload_date: "20260101", duration: v.duration, width: 1920, height: 1080, chapters: v.chapters ?? [], subtitles: ["en"], auto_captions: ["en"], formats: { video_heights: [144, 360, 480, 1080], audio: true } };
      return Response.json({
        kind: "post",
        source: "youtube",
        via: "yt-dlp",
        canonical_url: canon,
        id: `youtube:${canon.slice(-11)}`,
        author: { name: "Example Channel", handle: "@examplechannel", url: null },
        created_at: "2026-01-01T00:00:00Z",
        text: v.description ?? null,
        lang: "en",
        metrics: {},
        media: [{ type: "video", duration: v.duration, width: 1920, height: 1080, media_url: canon, poster: { key: this.keep("video-poster", TINY_JPEG, "image/jpeg"), width: 1280, height: 720 }, probe }],
        quoted: null,
        reply_to: null,
        comments: [],
        links: [],
        notes: [],
        ...base,
      });
    }
    return Response.json({ error: "not_found", detail: "nothing at that URL" }, { status: 404 });
  }

  private startFetch(key: string, url: string) {
    let f = this.fetches.get(key);
    if (!f) this.fetches.set(key, (f = { url, reads: 0, state: "queued" }));
    return f;
  }

  /** A fetch's status; a read (`advance`) moves it one step towards done. */
  private status(key: string, f: { reads: number; state: string }, advance: boolean) {
    if (advance && f.state !== "done") {
      f.reads++;
      f.state = f.reads >= this.fetchSteps ? "done" : "downloading";
    }
    const total = this.fileBytes.length;
    const bytes = f.state === "done" ? total : f.state === "downloading" ? Math.floor(total / 2) : 0;
    return { key, state: f.state, quality: "low", bytes, total, ...(f.state === "done" ? { url: `/files/${key}` } : {}) };
  }
}
