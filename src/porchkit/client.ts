/**
 * The client for porchkit, the platform's media relay on a home IP (a separate, private service). shuvi
 * reaches it with a bearer token; porchkit fetches anonymously, keeps each site's rate budget and caches
 * what it fetched.
 *
 * WHO USES IT: the media capability (src/capabilities/media/) makes every call here: probe, subtitles,
 * sheets of a link, fetches, the prewarm. The computer capability reads only `porchkitConfig`, to know
 * whether media is on (`ComputerConfig.mediaOn`: then media's video_sheet stands in for its own). The
 * dependency between the two capabilities runs the other way: media imports from computer what a file's
 * sheet and a fetch's copy need (`computersFor`, `localSheet`, the sheet schema, `exec.ts`, `state.ts`).
 *
 *   SHUVI_PORCHKIT_URL     porchkit's base URL, e.g. https://porchkit.example.ts.net   (both set: on)
 *   SHUVI_PORCHKIT_TOKEN   shuvi's bearer token there. Never logged; redacted from turn transcripts
 *                          (the media capability's `secrets`).
 *
 * THE API, as this client uses it (porchkit's README is the reference):
 *   POST /media/probe {url, speculative?}            what the video is; cached there 6 h
 *   POST /media/subs  {url, lang?}                   `[mm:ss] line` text
 *   POST /media/sheet {url, every|count|scene, from?, to?, grid?, source?}
 *                                                    contact sheets: `/media/sheets/<id>/<n>.jpg` (bearer)
 *                                                    and a text index
 *   POST /media/fetch {url, quality?}                start a download: {key, state, bytes, total}
 *   GET  /media/fetch/<key>                          its progress
 *   GET  /files/<key>                                the file, with Range
 *
 * Errors are `{error, detail, ...}`; `PorchkitError` carries them, and `describe` turns one into a plain
 * sentence for the model (what happened, what to do). A URL porchkit answered with (a sheet's) is fetched
 * here with the token and never shown to the model.
 */

export interface PorchkitConfig {
  /** The base URL, without a trailing slash. */
  url: string;
  token: string;
  /** How long one API call may take (a probe can take up to porchkit's own 90 s extract limit). */
  timeoutMs: number;
}

/** porchkit's config from the environment, or null when it is not set up (both variables are needed). */
export function porchkitConfig(env: Record<string, string | undefined>): PorchkitConfig | null {
  const url = env.SHUVI_PORCHKIT_URL?.trim();
  const token = env.SHUVI_PORCHKIT_TOKEN?.trim();
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token, timeoutMs: 120_000 };
}

export interface Chapter {
  start: number;
  end?: number;
  title: string;
}

/** What `POST /media/probe` answers (the fields shuvi reads; porchkit may add more). */
export interface Probe {
  id: string;
  canonical_url?: string;
  extractor?: string;
  title?: string | null;
  uploader?: string | null;
  uploader_id?: string | null;
  upload_date?: string | null;
  duration?: number | null;
  live_status?: string | null;
  language?: string | null;
  width?: number | null;
  height?: number | null;
  chapters?: Chapter[];
  subtitles?: string[];
  auto_captions?: string[];
  auto_caption_translations?: number;
  storyboard?: { available: boolean };
  formats?: { count?: number; video_heights?: number[]; audio?: boolean };
  cached?: boolean;
}

export interface Subs {
  id: string;
  lang: string;
  kind: string;
  lines: number;
  text: string;
  cached?: boolean;
}

export interface SheetRequest {
  url?: string;
  key?: string;
  every?: number;
  count?: number;
  scene?: boolean;
  from?: number | string;
  to?: number | string;
  grid?: string;
  source?: "auto" | "file" | "storyboard";
}

export interface SheetAnswer {
  id: string;
  source: string;
  index: string;
  sheets: { url: string; labels: string[] }[];
  /** A longer video's storyboard sheet now, and its download started for sharper sheets later. */
  fetch?: FetchStatus;
  cached?: boolean;
}

export interface FetchStatus {
  key: string;
  state: "queued" | "downloading" | "done" | "failed";
  quality?: string;
  bytes?: number;
  total?: number | null;
  url?: string;
  error?: { error: string; detail?: string; retry_after?: number; reason?: string };
}

/** An error porchkit answered with (or the network's, as status 0). */
export class PorchkitError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    /** The whole body (409 `needs_file` carries `fetch`, 429 `reason` and `retry_after`). */
    readonly body: Record<string, unknown> = {},
    /** Seconds, from Retry-After (or the body's `retry_after`). */
    readonly retryAfter?: number,
  ) {
    super(`porchkit ${status} ${code}: ${detail}`);
  }
}

/** What the model is told about a video behind a login (422 `unavailable`), before the site's own words. */
export const UNAVAILABLE =
  "This video can't be had: it is behind a login (members-only, age-restricted or private), or removed or region-locked, and videos are only ever fetched anonymously, without anyone's account. Say so plainly rather than guessing at what it shows.";

/** A wait, said the way a person would: "about 40 seconds", "about 3 minutes". */
export function waitLabel(sec: number): string {
  const s = Math.max(1, Math.round(sec));
  if (s < 90) return `about ${s} second${s === 1 ? "" : "s"}`;
  const m = Math.round(s / 60);
  if (m < 90) return `about ${m} minute${m === 1 ? "" : "s"}`;
  return `about ${Math.round(m / 60)} hours`;
}

/**
 * What the model is told when a porchkit call failed: plain sentences, never a status code alone, never the
 * token or porchkit's address.
 */
export function describe(e: unknown): string {
  if (!(e instanceof PorchkitError)) return `The media service failed unexpectedly: ${e instanceof Error ? e.message : String(e)}.`;
  const detail = e.detail.trim().replace(/\.?$/, ".");
  switch (e.code) {
    case "unreachable":
      return `The media service could not be reached (${e.detail}). Nothing was fetched; try again later.`;
    case "timeout":
      return "The media service did not answer in time. Nothing was fetched; try again later.";
    case "unauthorized":
      return "The media service refused shuvi's credentials; the owner needs to check its token. Nothing was fetched.";
    case "bad_request":
      return `The media service refused the request: ${detail}`;
    case "egress_refused":
      return "That link does not lead to the public internet (it, a redirect or its address is private), so it was not opened.";
    case "not_found":
      return `Not found: ${detail}`;
    case "too_large":
      return `The video is too large to fetch: ${detail}`;
    case "unavailable":
      return `${UNAVAILABLE} (The site said: ${detail})`;
    case "rate_limited": {
      const wait = e.retryAfter !== undefined ? waitLabel(e.retryAfter) : "a while";
      const why =
        e.body.reason === "backoff"
          ? "the site asked it to slow down, so it is leaving that site alone for a while"
          : e.body.reason === "speculative"
            ? "that budget is more than half used, so a look-ahead was turned down"
            : "that budget is used up for now";
      return `Not now: videos are fetched through the owner's home connection, which keeps a request budget for each site, and ${why}. It should free up in ${wait}. Tell whoever asked that it is busy right now and roughly how long, rather than trying again and again.`;
    }
    case "upstream_failed":
      return `The site (or the downloader) failed: ${detail} Trying again later may work.`;
    case "upstream_timeout":
      return `The site did not answer in time: ${detail} Trying again later may work.`;
    case "insufficient_storage":
      return `The media service has no room for downloads right now: ${detail} Try again later.`;
    case "needs_file":
      return `The video has to be downloaded first; its download has started. ${detail}`;
    default:
      return `The media service failed (${e.code}): ${detail}`;
  }
}

/** One porchkit, over `fetch` (a fake in tests). Every call carries the bearer token and a timeout. */
export class Porchkit {
  constructor(
    readonly cfg: PorchkitConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.cfg.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.cfg.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      if (timeout.aborted) throw new PorchkitError(0, "timeout", `no answer within ${Math.round(this.cfg.timeoutMs / 1000)}s`);
      // The error's text may carry the address; say only what kind of failure it was.
      const name = e instanceof Error ? e.name : "error";
      throw new PorchkitError(0, "unreachable", name === "AbortError" ? "the request was cancelled" : `a ${name} on the way there`);
    }
    if (res.ok) return res;
    let b: Record<string, unknown> = {};
    try {
      b = (await res.json()) as Record<string, unknown>;
    } catch {
      // not JSON: a proxy's error page
    }
    const ra = Number(res.headers.get("retry-after") ?? b.retry_after);
    const code = typeof b.error === "string" ? b.error : res.status === 401 ? "unauthorized" : res.status === 429 ? "rate_limited" : `http_${res.status}`;
    throw new PorchkitError(res.status, code, typeof b.detail === "string" ? b.detail : res.statusText || `HTTP ${res.status}`, b, Number.isFinite(ra) && ra > 0 ? ra : undefined);
  }

  private async json<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return (await (await this.call(method, path, body, {}, signal)).json()) as T;
  }

  probe(url: string, speculative = false, signal?: AbortSignal): Promise<Probe> {
    return this.json("POST", "/media/probe", { url, ...(speculative ? { speculative: true } : {}) }, signal);
  }

  subs(url: string, lang?: string): Promise<Subs> {
    return this.json("POST", "/media/subs", { url, ...(lang ? { lang } : {}) });
  }

  sheet(req: SheetRequest): Promise<SheetAnswer> {
    return this.json("POST", "/media/sheet", req);
  }

  /** A sheet's JPEG, by the path porchkit answered with (`/media/sheets/<id>/<n>.jpg`). */
  async sheetImage(path: string): Promise<Uint8Array> {
    if (!/^\/media\/sheets\/[0-9a-f]{32}\/\d+\.jpg$/.test(path)) throw new PorchkitError(0, "bad_answer", "a sheet path that is not porchkit's");
    return new Uint8Array(await (await this.call("GET", path)).arrayBuffer());
  }

  fetch(url: string, quality?: "low" | "best"): Promise<FetchStatus> {
    return this.json("POST", "/media/fetch", { url, ...(quality ? { quality } : {}) });
  }

  fetchStatus(key: string, signal?: AbortSignal): Promise<FetchStatus> {
    return this.json("GET", `/media/fetch/${encodeURIComponent(key)}`, undefined, signal);
  }

  /** Bytes [start, end] (inclusive) of a fetched file, its total size and its media type. */
  async fileRange(key: string, start: number, end: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array; total: number | null; type: string | null }> {
    const res = await this.call("GET", `/files/${encodeURIComponent(key)}`, undefined, { range: `bytes=${start}-${end}` }, signal);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const range = res.headers.get("content-range")?.match(/\/(\d+)\s*$/);
    // A server that ignored the Range answers 200 with the whole file: take only the part asked for.
    const part = res.status === 206 ? bytes : bytes.subarray(start, end + 1);
    const total = range ? Number(range[1]) : res.status === 200 ? bytes.length : null;
    return { bytes: part, total, type: res.headers.get("content-type") };
  }
}
