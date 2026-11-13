import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sameSecret } from "../secrets/compare.ts";
import type { Db } from "../store/db.ts";
import { sniffImage } from "../store/media.ts";
import { cardPage, html } from "./html.ts";
import { chatPage, conversationPage, segmentPage, turnsPage, type PageContext } from "./pages.ts";
import { listingPart, loadSettings, modelPart, settingsPage } from "./settings.ts";
import { isSettingsWrite, settingsWrite, takeFlash } from "./settings-write.ts";

/**
 * The console's HTTP side: who may look, and which page answers which URL.
 *
 * WHERE IT LISTENS: loopback only (`isLoopback`; the server refuses to start on anything else). It is
 * published to the owner's tailnet by `tailscale serve`, which terminates HTTPS on the machine's MagicDNS
 * name and proxies to this port.
 *
 * WHO MAY LOOK, decided per request:
 *   - HOST first: a request must name the host of SHUVI_CONSOLE_URL, or this port on 127.0.0.1, localhost
 *     or [::1]; anything else gets 421. That keeps a web page the owner visits from reaching the console
 *     through DNS rebinding.
 *   - with `users` (SHUVI_CONSOLE_USERS): the tailnet identity. `tailscale serve` sets `Tailscale-User-Login`
 *     on every request it proxies; a request is let in only
 *     when that header names one of `users`, and gets 403 otherwise (no header included). The header is not
 *     a secret: ANY process on this machine can connect to the loopback port and set it. The trust boundary
 *     is the machine: whoever can run code on it can read shuvi.db directly anyway. A token is not accepted
 *     in this mode.
 *   - else with `token` (SHUVI_CONSOLE_TOKEN), for local use over an ssh tunnel: `POST /login` with the token
 *     sets an HttpOnly, SameSite=Strict session cookie (an HMAC of its expiry under the token, so changing the
 *     token ends every session, and a restart ends none); `Authorization: Bearer <token>` works too, for a
 *     script. Anything else gets 401 and the sign-in form.
 *
 * READ ONLY, but for the Settings page: GET and HEAD everywhere, plus POST /login, plus POST to the Settings
 * page's write routes (`/settings/<area>/<verb>`, settings-write.ts `SETTINGS_WRITES`) and to nothing else. A
 * POST anywhere else, or any other method, gets 405; a GET to a write route gets 405 too. A write must pass,
 * after the Host check and the sign-in above, BOTH:
 *   - ORIGIN: an `Origin` header naming one of `allowedOrigins` (index.ts: SHUVI_CONSOLE_URL's origin, and
 *     `http://` the loopback names of the bound port). Missing, `null` or any other: 403.
 *   - CSRF TOKEN: a form field `csrf` equal to this session's token, `csrfToken`: an HMAC, under a secret the
 *     server draws at random when it starts (`csrfSecret`), of the session. The session is, by sign-in mode:
 *       tailnet login   the login (`Tailscale-User-Login`): there is no cookie in this mode, so the token is
 *                       derived from the login and the server secret, the same on every page for that login
 *                       until the server restarts;
 *       token cookie    the session cookie's value (so a new sign-in gets a new token);
 *       bearer token    the bearer (a script, which reads the token from the page as a browser would).
 *     A restart draws a new secret: a page loaded before it posts a stale token and is told to reload. Wrong or
 *     missing: 403.
 *   Two checks, so that one failing alone (a browser that sends no Origin, a token copied off a page) still
 *   refuses; and the session cookie is SameSite=Strict besides.
 * A write answers 303 to `/settings?r=<id>#<row>`: its result is a FLASH, kept in memory (at most
 * settings-write.ts FLASH_MAX, for FLASH_MS), read once by its random id and not bound to a session; it holds
 * only the note and the form's non-secret fields. The fragment is ASCII-encoded (settings.ts `anchor`), so
 * a `Location` header can carry any model id.
 * Every page is server-rendered with escaped text (html.ts); the CSP allows only this origin's stylesheet,
 * images and two scripts, and forms and background requests to this origin only. The scripts: htmx (the npm
 * package `htmx.org`, pinned, served from node_modules at `/htmx.min.js`; html.ts `page` sets its config: no
 * eval, no script from a response, no history kept in the browser's storage) and console.js (copy buttons,
 * j / k). Every page works without them; with them, links and forms swap the page in place (html.ts), and
 * Settings swaps only what changed and fetches a pending probe's row or listing (`/settings/model?id=`,
 * `/settings/listing`, read routes answering a part of the page) until it is done (settings.ts).
 */

export interface ConsoleDeps {
  db: Db;
  timeZone: string;
  dataDir: string;
  /** The Host values a request may carry (`index.ts` `allowedHosts`). */
  allowedHosts: ReadonlySet<string>;
  /** The Origin values a write may carry (`index.ts` `allowedOrigins`). Unset: every write is refused. */
  allowedOrigins?: ReadonlySet<string>;
  /** The secret CSRF tokens are derived under. Default: drawn at random once per process. */
  csrfSecret?: string;
  /** Tailnet logins allowed in. Set: the only auth. */
  users?: ReadonlySet<string>;
  /** The fallback token, used only when `users` is not set. */
  token?: string;
  /** The owner's id, whose lines are marked in a group. */
  ownerId?: number;
  /** How long transcripts are kept (SHUVI_TRANSCRIPT_DAYS), to say why one is gone. Default 30. */
  transcriptDays?: number;
  now?: () => number;
}

export const LOGIN_HEADER = "tailscale-user-login";
export const SESSION_COOKIE = "shuvi_console";
export const SESSION_MS = 7 * 24 * 3600_000;

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, "style.css"), "utf8");
const JS = readFileSync(join(HERE, "console.js"), "utf8");
const HTMX = readFileSync(fileURLToPath(import.meta.resolve("htmx.org/dist/htmx.min.js")), "utf8");

const SECURITY_HEADERS: Record<string, string> = {
  // Inline style attributes only (a size bar's width, a speaker's colour); no inline script at all.
  // connect-src: htmx's requests, to this origin only.
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  // Not `no-referrer`: under it a browser serializes a form POST's Origin as `null` (Fetch, "append a
  // request Origin header"), and every write from the Settings page would be refused. `same-origin` sends
  // the Origin (and a Referer) to this origin only, and nothing to any other site.
  "referrer-policy": "same-origin",
  "cache-control": "no-store",
};

function respond(body: string | Uint8Array | null, status: number, type: string, extra: Record<string, string> = {}): Response {
  return new Response(body as ConstructorParameters<typeof Response>[0], { status, headers: { ...SECURITY_HEADERS, "content-type": type, ...extra } });
}
const htmlResponse = (body: string, status = 200, extra: Record<string, string> = {}) => respond(body, status, "text/html; charset=utf-8", extra);

/** A hostname a socket bound to it can only be reached from this machine. */
export function isLoopback(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/** `host:port` (or `[v6]:port`) → Bun.serve's options; refuses anything that is not loopback. */
export function parseConsoleListen(listen: string): { hostname: string; port: number } {
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(listen.trim());
  if (!m) throw new Error(`SHUVI_CONSOLE_LISTEN must be host:port on a loopback address (e.g. 127.0.0.1:8787), not "${listen}"`);
  const hostname = m[1] ?? m[2]!;
  if (!isLoopback(hostname)) {
    throw new Error(`SHUVI_CONSOLE_LISTEN must be a loopback address (127.0.0.1, ::1 or localhost), not "${hostname}": publish it to the tailnet with \`tailscale serve\` instead`);
  }
  return { hostname, port: Number(m[3]) };
}

function sessionValue(token: string, exp: number): string {
  return `${exp}.${createHmac("sha256", token).update(`shuvi-console:${exp}`).digest("base64url")}`;
}

function validSession(token: string, value: string | undefined, now: number): boolean {
  const m = value ? /^(\d+)\.([A-Za-z0-9_-]+)$/.exec(value) : null;
  if (!m) return false;
  const exp = Number(m[1]);
  return exp > now && sameSecret(value!, sessionValue(token, exp));
}

function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

function loginPage(status: number, error?: string): Response {
  const body = html`<p>Sign in with the console's token (SHUVI_CONSOLE_TOKEN).</p>
<form method="post" action="/login"><input type="password" name="token" autocomplete="current-password" autofocus aria-label="token"><button type="submit">Sign in</button></form>
${error ? html`<p class="err">${error}</p>` : ""}`;
  return htmlResponse(cardPage("Sign in", body), status);
}

const PROCESS_CSRF_SECRET = randomBytes(32).toString("base64url");

/** The CSRF token of session `session` (see the header). */
export function csrfToken(secret: string, session: string): string {
  return createHmac("sha256", secret).update(`shuvi-console-csrf:${session}`).digest("base64url");
}

const refusedWrite = (why: string) => htmlResponse(cardPage("Refused", html`<p>${why}</p><p><a href="/settings">Back to Settings</a>, reloaded.</p>`), 403);

const forbidden = () => htmlResponse(cardPage("Not for you", html`<p>This console is open to the tailnet users it lists, and this request did not come from one of them.</p>`), 403);
const notFound = (who?: string) => htmlResponse(cardPage("Not found", html`<p>There is nothing here. <a href="/turns">Back to the turns</a>.</p>`, who), 404);
const misdirected = () => respond("This console does not answer for that host.\n", 421, "text/plain; charset=utf-8");

/** `session`: what this request's CSRF token is derived from (see the header). */
type Auth = { ok: true; who?: string; session: string } | { ok: false; response: Response };

async function authenticate(deps: ConsoleDeps, req: Request, path: string): Promise<Auth> {
  const now = (deps.now ?? Date.now)();
  if (deps.users) {
    const login = req.headers.get(LOGIN_HEADER)?.trim();
    return login && deps.users.has(login) ? { ok: true, who: login, session: `login:${login}` } : { ok: false, response: forbidden() };
  }
  const token = deps.token;
  if (!token) return { ok: false, response: forbidden() }; // never served this way (the console is off)
  if (path === "/login" && req.method === "POST") {
    const form = await req.formData().catch(() => null);
    const given = form?.get("token");
    if (typeof given !== "string" || !given || !sameSecret(given, token)) return { ok: false, response: loginPage(401, "That is not the token.") };
    const exp = now + SESSION_MS;
    return {
      ok: false,
      response: respond(null, 303, "text/plain", {
        location: "/",
        "set-cookie": `${SESSION_COOKIE}=${sessionValue(token, exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_MS / 1000)}`,
      }),
    };
  }
  if (path === "/logout") {
    return { ok: false, response: respond(null, 303, "text/plain", { location: "/login", "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` }) };
  }
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (bearer && sameSecret(bearer, token)) return { ok: true, session: "bearer" };
  const session = cookie(req, SESSION_COOKIE);
  if (validSession(token, session, now)) return { ok: true, session: `cookie:${session}` };
  if (path === "/login") return { ok: false, response: loginPage(200) };
  return { ok: false, response: loginPage(401) };
}

/** An image the transcript or a chat refers to: only files under `<data dir>/media/`, only images. */
function media(deps: ConsoleDeps, ref: string | null): Response {
  if (!ref || !/^media\/[A-Za-z0-9._/-]+$/.test(ref)) return notFound();
  const rel = normalize(ref);
  if (rel.startsWith("..") || !rel.startsWith(`media${sep}`)) return notFound();
  const root = join(deps.dataDir, "media");
  const abs = join(deps.dataDir, rel);
  if (!existsSync(abs)) return notFound();
  let real: string;
  try {
    real = realpathSync(abs);
    if (!real.startsWith(`${realpathSync(root)}${sep}`)) return notFound();
  } catch {
    return notFound();
  }
  const bytes = readFileSync(real);
  const type = sniffImage(bytes);
  if (!type) return notFound();
  return respond(bytes, 200, type, { "cache-control": "private, max-age=86400" });
}

/** The Host a request names (Bun.serve builds `req.url` from it; a test's Request carries it in the URL). */
function hostOf(req: Request, url: URL): string {
  return (req.headers.get("host") ?? url.host).toLowerCase();
}

/** Route one request. Exported so tests run it without a socket. */
export async function handleConsole(deps: ConsoleDeps, req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (!deps.allowedHosts.has(hostOf(req, url))) return misdirected();
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const write = isSettingsWrite(path);
  if (write ? req.method !== "POST" : !["GET", "HEAD"].includes(req.method) && !(req.method === "POST" && path === "/login")) {
    return write ? respond("a write: POST only", 405, "text/plain", { allow: "POST" }) : respond("read only", 405, "text/plain", { allow: "GET, HEAD" });
  }
  // The stylesheet and the script are public: the sign-in, 403 and 404 pages need them before anyone is let in,
  // and they hold nothing but this file's own code.
  if (path === "/style.css") return respond(CSS, 200, "text/css; charset=utf-8", { "cache-control": "public, max-age=3600" });
  if (path === "/console.js") return respond(JS, 200, "text/javascript; charset=utf-8", { "cache-control": "public, max-age=3600" });
  if (path === "/htmx.min.js") return respond(HTMX, 200, "text/javascript; charset=utf-8", { "cache-control": "public, max-age=3600" });
  try {
    const auth = await authenticate(deps, req, path);
    if (!auth.ok) return auth.response;
    const ctx: PageContext = { db: deps.db, timeZone: deps.timeZone, ...(auth.who ? { who: auth.who } : {}), ...(deps.ownerId !== undefined ? { ownerId: deps.ownerId } : {}), ...(deps.transcriptDays ? { transcriptDays: deps.transcriptDays } : {}), now: (deps.now ?? Date.now)() };
    const csrf = csrfToken(deps.csrfSecret ?? PROCESS_CSRF_SECRET, auth.session);
    if (write) {
      const origin = req.headers.get("origin");
      if (!origin || !deps.allowedOrigins?.has(origin.toLowerCase())) return refusedWrite("This change did not come from the console's own page (its Origin is missing or another site's).");
      const form = await req.formData().catch(() => null);
      const given = form?.get("csrf");
      if (!form || typeof given !== "string" || !sameSecret(given, csrf)) return refusedWrite("This change carried no valid token for your session: the page may be from before a restart.");
      return respond(null, 303, "text/plain", { location: settingsWrite(deps.db, path, form, ctx.now) });
    }
    if (path === "/" || path === "/login") return respond(null, 302, "text/plain", { location: "/turns" });
    if (path === "/media") return media(deps, url.searchParams.get("ref"));
    // Chats and turns are one navigation now (the list groups turns by chat); the old address leads there.
    if (path === "/chats") return respond(null, 302, "text/plain", { location: "/turns" });
    if (path === "/turns") return htmlResponse(turnsPage(ctx, url.searchParams)!);
    if (path === "/settings" || path === "/settings/model" || path === "/settings/listing") {
      const sctx = { timeZone: ctx.timeZone, now: ctx.now ?? Date.now(), csrf, ...(ctx.who ? { who: ctx.who } : {}) };
      // A part of the page, fetched by itself while something in it is pending (settings.ts `polls`).
      if (path === "/settings/model") return htmlResponse(modelPart(sctx, loadSettings(deps.db, new URLSearchParams()), url.searchParams.get("id") ?? "").s);
      if (path === "/settings/listing") return htmlResponse(listingPart(sctx, loadSettings(deps.db, new URLSearchParams())).s);
      const flash = takeFlash(url.searchParams.get("r"), ctx.now);
      const view = loadSettings(deps.db, url.searchParams, flash);
      return htmlResponse(settingsPage(sctx, view));
    }
    const chat = /^\/chats\/(\d+)$/.exec(path);
    if (chat) {
      const out = chatPage(ctx, Number(chat[1]), url.searchParams);
      return out ? htmlResponse(out) : notFound(ctx.who);
    }
    // Segments were first served at /sessions/<id>; an old link still finds its segment.
    const oldSegment = /^\/sessions\/(\d+)$/.exec(path);
    if (oldSegment) return respond(null, 301, "text/plain", { location: `/segments/${oldSegment[1]}${url.search}` });
    // A segment or a whole conversation, named by its first turn (or any turn in it).
    const span = /^\/(segments|conversations)\/(\d+)$/.exec(path);
    if (span) {
      const out = (span[1] === "segments" ? segmentPage : conversationPage)(ctx, url.searchParams, Number(span[2]));
      return out ? htmlResponse(out) : notFound(ctx.who);
    }
    const turn = /^\/turns\/(\d+)$/.exec(path);
    if (turn) {
      const out = turnsPage(ctx, url.searchParams, Number(turn[1]));
      return out ? htmlResponse(out) : notFound(ctx.who);
    }
    return notFound(ctx.who);
  } catch (e) {
    console.error(`console: ${req.method} ${path} failed:`, e);
    return htmlResponse(cardPage("This page failed", html`<p class="err">${e instanceof Error ? e.message : String(e)}</p>`), 500);
  }
}

/**
 * Serve the console on `listen` (loopback only) until `signal` aborts. `where(port)` gives the Host values it
 * answers and the Origins a write may come from, once the port is known (a listen port of 0 binds any free
 * one, as the e2e scripts do).
 */
export function serveConsole(
  deps: Omit<ConsoleDeps, "allowedHosts" | "allowedOrigins">,
  listen: string,
  where: (port: number) => { hosts: ReadonlySet<string>; origins: ReadonlySet<string> },
  signal: AbortSignal,
): ReturnType<typeof Bun.serve> {
  let allowed: { hosts: ReadonlySet<string>; origins: ReadonlySet<string> } = { hosts: new Set(), origins: new Set() };
  const server = Bun.serve({ ...parseConsoleListen(listen), maxRequestBodySize: 16 * 1024, fetch: (req) => handleConsole({ ...deps, allowedHosts: allowed.hosts, allowedOrigins: allowed.origins }, req) });
  allowed = where(server.port!);
  signal.addEventListener("abort", () => void server.stop(true), { once: true });
  console.log(`console: listening on ${server.hostname}:${server.port} (${deps.users ? `tailnet users: ${[...deps.users].join(", ")}` : "token sign-in"})`);
  return server;
}
