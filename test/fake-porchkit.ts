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
 *
 * Errors by URL (any endpoint): one containing `private` is 422 unavailable, `busy` 429 (Retry-After 180),
 * `internal.example` 403 egress_refused, `broken` 502, `slow` 504. `failNext(path, …)` queues one answer for
 * the next call of a path. Every request is recorded (`calls`), with whether it carried the token.
 */

/** A 1x1 JPEG: what every sheet is here. */
export const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

export const FAKE_TOKEN = "pk-fake-token-0123456789abcdef";

export interface FakeVideo {
  title: string;
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
  private readonly fetches = new Map<string, { url: string; reads: number; state: string }>();
  private readonly queued = new Map<string, { status: number; body: Record<string, unknown>; headers?: Record<string, string> }[]>();
  private server: ReturnType<typeof Bun.serve>;

  constructor(readonly token = FAKE_TOKEN) {
    this.videos.set("https://www.youtube.com/watch?v=abc123def45", {
      title: "Example talk",
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

    const url = typeof body.url === "string" ? body.url : "";
    if (url) {
      if (url.includes("private")) return Response.json({ error: "unavailable", detail: "Private video. Sign in if you've been granted access" }, { status: 422 });
      if (url.includes("busy")) return Response.json({ error: "rate_limited", reason: "budget", site: "youtube", retry_after: 180, detail: "youtube: budget, retry in 180s" }, { status: 429, headers: { "retry-after": "180" } });
      if (url.includes("internal.example")) return Response.json({ error: "egress_refused", detail: "the address is not public" }, { status: 403 });
      if (url.includes("broken")) return Response.json({ error: "upstream_failed", detail: "the site answered 500." }, { status: 502 });
      if (url.includes("slow")) return Response.json({ error: "upstream_timeout", detail: "no answer within 90s." }, { status: 504 });
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
