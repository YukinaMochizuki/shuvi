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
 *                       `browse.takeover` is 409; Google account pages 403 owner_only; `internal.example` 403
 *                       egress_refused; a screenshot is a PNG served by GET /files/<key>. `DELETE
 *                       /browse/sessions/<s>` 204. Every act is recorded in `calls` (`of("/browse/sessions/")`).
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
};
const OWNER_ONLY_HOSTS = ["accounts.google.com", "myaccount.google.com", "pay.google.com", "payments.google.com"];
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
}

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
  readonly browse: FakeBrowse = { available: true, takeover: false, google: true, liveUrl: "https://porchkit.example.ts.net:8444/", maxSessions: 3, sessions: new Map(), dialogs: new Map() };

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
    const needs = (cond: boolean) => (cond && body.approved !== true ? fail(403, "approval_required", "that could place an order; it needs approved: true") : null);
    const action = String(body.action ?? "");
    const open = b.dialogs.get(id);
    if (open && action !== "dialog") return fail(409, "dialog_open", `a ${open.type} is open; answer it with the dialog action`);
    const notes: string[] = [];
    switch (action) {
      case "open": {
        const url = String(body.url ?? "");
        if (OWNER_ONLY_HOSTS.includes(host(url))) return fail(403, "owner_only", "the owner does this through the live view");
        if (url.includes("internal.example")) return fail(403, "egress_refused", "the address is not public");
        h.push(url);
        break;
      }
      case "snapshot":
      case "wait":
      case "scroll":
        break;
      case "click": {
        const r = page?.refs[String(body.ref)];
        if (!r) return fail(422, "bad_ref", "no such ref in the latest snapshot");
        const g = needs(FINAL_STEP.test(r[1]) || (isCheckout && r[0] === "button"));
        if (g) return g;
        if (r[3]?.type === "alert") notes.push(`dialog: alert "${r[3].message}" (accepted)`);
        else if (r[3]) {
          b.dialogs.set(id, r[3]);
          const p = SHOP_PAGES[here];
          return Response.json({ session: id, url: here, title: p?.title ?? "", tabs: [{ index: 0, url: here, title: p?.title ?? "", active: true }], checkout: isCheckout, notes: [], dialog: { type: r[3].type, message: r[3].message, default_prompt: r[3].default_prompt ?? null } });
        }
        if (r[2]) h.push(r[2]);
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
        const key = this.keep(`screenshot-${here}`, TINY_PNG, "image/png");
        return Response.json({ session: id, url: here, title: page?.title ?? "", checkout: isCheckout, notes: [], screenshot: { key, width: 1, height: 1, bytes: TINY_PNG.length } });
      }
      default:
        return fail(400, "bad_request", `unknown action ${action}`);
    }
    const now = h.at(-1)!;
    const p = SHOP_PAGES[now];
    const lines = [`URL: ${now}`, `Title: ${p?.title ?? ""}`, ...Object.entries(p?.refs ?? {}).map(([ref, [role, name]]) => `[${ref}] ${role} "${name}"`)];
    return Response.json({
      session: id,
      url: now,
      title: p?.title ?? "",
      snapshot: lines.join("\n"),
      tabs: [{ index: 0, url: now, title: p?.title ?? "", active: true }],
      checkout: now === SHOP_CHECKOUT,
      notes,
    });
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
