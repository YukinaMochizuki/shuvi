import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isLoopback, parseLoopbackListen } from "../listen.ts";
import { sameSecret } from "../secrets/compare.ts";
import type { Db } from "../store/db.ts";
import { sniffImage } from "../store/media.ts";
import { assetAt, serveAsset, warmAssets } from "./assets.ts";
import { activityPage, changedBanner, homePage } from "./home.ts";
import { allHistory, loadHome, watch, type PromptDeps } from "./home-data.ts";
import { HOME_WRITES, homeSave, PROFILE_WRITES, profileWrite, takeResult } from "./home-write.ts";
import { HomeLayers } from "../capabilities/memory/layers.ts";
import { cardPage, html } from "./html.ts";
import { chatListPane, chatPage, conversationPage, segmentPage, turnsPage, type PageContext } from "./pages.ts";
import { chatSettingsPage, switchingLine, type SettingsCategory } from "./chat-settings.ts";
import { loadChatSettings, switchResultFlash, type ChatSettingsDeps } from "./chat-settings-data.ts";
import { CHAT_SETTINGS_WRITE, chatSettingsWrite, keepResult, takeSettingsResult } from "./chat-settings-write.ts";
import { getSwitchRequest } from "../agent/switch.ts";
import type { ComputerConfig } from "../capabilities/computer/config.ts";
import { diskLine } from "./chat-extras.ts";
import { diskFacts } from "./chat-extras-data.ts";
import type { SignalTurn } from "../server/spawn.ts";
import { CAPABILITIES } from "../capabilities/index.ts";
import { listingPart, loadSettings, modelPart, settingsPage } from "./settings.ts";
import { isSettingsWrite, settingsWrite, takeFlash } from "./settings-write.ts";
import { backPath, deleteWrite, isDeleteWrite, NOTICE_PARAM, takeDeleteNotice } from "./delete-write.ts";
import { openLive, type LiveHub } from "./live.ts";

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
 * READ ONLY, but for a few writes: GET and HEAD everywhere, plus POST /login, plus POST to the Settings page's write
 * routes (`/settings/<area>/<verb>`, settings-write.ts `SETTINGS_WRITES`), to the Home page's (`/home/save`,
 * home-write.ts `HOME_WRITES`: saving one of her files in home/; `/home/profile/<verb>`, `PROFILE_WRITES`: her
 * profiles, capabilities/memory/layers.ts), to a chat's settings page's (`/chats/<id>/settings/<verb>`,
 * chat-settings-write.ts `CHAT_SETTINGS_WRITE`: its model, profile, conversation, its entry in policy.yaml, its
 * schedules (cancel, pause, resume) and revoking a secret granted to its computer), and
 * to the delete of chat messages (`/messages/delete`, `/messages/undo`: delete-write.ts, store/deletions.ts), and to
 * nothing else. A
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
 * A delete answers JSON to console.js (`Accept: application/json`), and otherwise 303 back to the page it came
 * from (a path on this console) with its result as a flash of its own (delete-write.ts, `?n=<id>`).
 * A Settings write answers 303 to `/settings?r=<id>#<row>`: its result is a FLASH, kept in memory (at most
 * settings-write.ts FLASH_MAX, for FLASH_MS), read once by its random id and not bound to a session; it holds
 * only the note and the form's non-secret fields. The fragment is ASCII-encoded (settings.ts `anchor`), so
 * a `Location` header can carry any model id. A Home save answers 303 to `/home?file=<path>&r=<id>` the same way
 * (home-write.ts: its result, or a conflict's two texts to resolve).
 * BODY SIZE: a request body may be up to `MAX_SMALL_BODY`, but for the routes in `LARGE_BODY_WRITES`, which may be
 * up to `MAX_BODY`: a Home save carries a whole file, and a delete a page's worth of selected messages.
 * Every page is server-rendered with escaped text (html.ts); the CSP allows only this origin's stylesheet,
 * images and its scripts, and forms and background requests to this origin only. The scripts: htmx (the npm
 * package `htmx.org`, pinned, served from node_modules at `/htmx.min.js`; html.ts `page` sets its config: no
 * eval, no script from a response, no history kept in the browser's storage), console.js (copy buttons,
 * j / k), and on the Home page only, `/editor.js` (CodeMirror, pinned, bundled in the process: editor/bundle.ts); each
 * under an address carrying its content's hash, cached for good only there (assets.ts). Every page works without them; with them, links and forms swap the page in place (html.ts), and
 * Settings swaps only what changed and fetches a pending probe's row or listing (`/settings/model?id=`,
 * `/settings/listing`, read routes answering a part of the page) until it is done (settings.ts).
 * LIVE PAGES: `GET /live?page=<a page's path>` is an event stream (Server-Sent Events) that keeps that page current
 * (a chat's log, a segment, a conversation, a turn, the chats list): HTML parts drawn by the page's own functions,
 * from one poll of the store shared by every open stream (live.ts). It is a read like any page: the same Host check
 * and sign-in, its own session's streams capped, nothing written. EventSource is a same-origin request, so the CSP
 * needs nothing beyond `connect-src 'self'`. Bun's idle timeout is lifted for it (`serveConsole`); its heartbeat
 * keeps a proxy from cutting it.
 */

export interface ConsoleDeps {
  db: Db;
  timeZone: string;
  dataDir: string;
  /** Her files (env.ts `home`). Default: `<dataDir>/home`, where env.ts puts it. */
  home?: string;
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
  /** What Home's Preview builds a chat's prompt with: the enabled capabilities, the policy, the owner. */
  prompt?: PromptDeps;
  /** How a chat's settings page stops a running turn (server/spawn.ts `signalTurn`; a test passes its own). */
  signalTurn?: SignalTurn;
  /**
   * The computer's configuration, for a chat's settings page (its Secrets and Computer sections). Default: the one
   * `prompt` has, when the computer capability is set up in this process.
   */
  computer?: ComputerConfig | null;
  now?: () => number;
  /** The live streams' hub (live.ts). Default: the one of `db`. */
  liveHub?: LiveHub;
}

export const LOGIN_HEADER = "tailscale-user-login";
/** The largest request body, for `LARGE_BODY_WRITES` only: a Home save carries a whole file (a sticker pack's yaml is the largest). */
export const MAX_BODY = 2 * 1024 * 1024;
/** Every other request's: what the console allowed before Home (the sign-in posts before anyone is let in). */
export const MAX_SMALL_BODY = 16 * 1024;
/**
 * The writes that may be larger than `MAX_SMALL_BODY`: a Home save, and a delete, whose script posts one
 * multipart field per selected message (about 95 bytes each: a chat page's 200 messages are about 19 KB).
 */
export const LARGE_BODY_WRITES: ReadonlySet<string> = new Set([...HOME_WRITES, "/messages/delete"]);
export const SESSION_COOKIE = "shuvi_console";
export const SESSION_MS = 7 * 24 * 3600_000;

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

export { isLoopback };

/** `host:port` (or `[v6]:port`) → Bun.serve's options; refuses anything that is not loopback. */
export function parseConsoleListen(listen: string): { hostname: string; port: number } {
  return parseLoopbackListen("SHUVI_CONSOLE_LISTEN", listen, "127.0.0.1:8787", ": publish it to the tailnet with `tailscale serve` instead");
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

/**
 * A write refused at the boundary: why, and a link back to the page it came from (its Referer, when that is a
 * page of this console; else the turns), to reload there.
 */
function refusedWrite(deps: ConsoleDeps, req: Request, why: string): Response {
  let back = "/turns";
  try {
    const ref = new URL(req.headers.get("referer") ?? "");
    if (deps.allowedOrigins?.has(ref.origin.toLowerCase()) && deps.allowedHosts.has(ref.host.toLowerCase())) back = backPath(`${ref.pathname}${ref.search}`);
  } catch {}
  return htmlResponse(cardPage("Refused", html`<p>${why}</p><p><a href="${back}">Back to the page</a>, reloaded.</p>`), 403);
}

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

const homeOf = (deps: ConsoleDeps) => deps.home ?? join(deps.dataDir, "home");

/** What a chat's settings page reads with: the store, home/, the registry and what this process set up. */
function settingsDeps(deps: ConsoleDeps): ChatSettingsDeps {
  return {
    db: deps.db,
    home: homeOf(deps),
    registry: CAPABILITIES,
    ...(deps.ownerId !== undefined ? { ownerId: deps.ownerId } : {}),
    ...(deps.prompt ? { enabled: new Set(deps.prompt.capabilities.map((c) => c.capability.id)) } : {}),
    computer: computerOf(deps),
  };
}

/** The computer's configuration, when it is set up in this process. */
function computerOf(deps: ConsoleDeps): ComputerConfig | null {
  if (deps.computer !== undefined) return deps.computer;
  return (deps.prompt?.capabilities.find((c) => c.capability.id === "computer")?.config as ComputerConfig | undefined) ?? null;
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
  // Only a Home save and a delete may be large (`MAX_BODY`, Bun's own limit); anything else keeps the small one.
  if (!LARGE_BODY_WRITES.has(path) && Number(req.headers.get("content-length") ?? 0) > MAX_SMALL_BODY) return respond("too large", 413, "text/plain");
  const write = isSettingsWrite(path) || HOME_WRITES.has(path) || isDeleteWrite(path) || PROFILE_WRITES.has(path) || CHAT_SETTINGS_WRITE.test(path);
  if (write ? req.method !== "POST" : !["GET", "HEAD"].includes(req.method) && !(req.method === "POST" && path === "/login")) {
    return write ? respond("a write: POST only", 405, "text/plain", { allow: "POST" }) : respond("read only", 405, "text/plain", { allow: "GET, HEAD" });
  }
  // The stylesheet and the script are public: the sign-in, 403 and 404 pages need them before anyone is let in,
  // and they hold nothing but this file's own code. Cached for good only at their current version (assets.ts).
  const asset = assetAt(path);
  if (asset) {
    const a = await serveAsset(asset, url.searchParams.get("v"));
    return respond(a.body, 200, a.type, { "cache-control": a.cacheControl });
  }
  try {
    const auth = await authenticate(deps, req, path);
    if (!auth.ok) return auth.response;
    const ctx: PageContext = { db: deps.db, timeZone: deps.timeZone, ...(auth.who ? { who: auth.who } : {}), ...(deps.ownerId !== undefined ? { ownerId: deps.ownerId } : {}), ...(deps.transcriptDays ? { transcriptDays: deps.transcriptDays } : {}), now: (deps.now ?? Date.now)() };
    const csrf = csrfToken(deps.csrfSecret ?? PROCESS_CSRF_SECRET, auth.session);
    ctx.csrf = csrf;
    ctx.here = backPath(`${path}${url.search}`);
    if (!write) {
      const notice = takeDeleteNotice(deps.db, url.searchParams.get(NOTICE_PARAM), csrf, ctx.here, ctx.now);
      if (notice) ctx.notice = notice;
    }
    if (write) {
      const origin = req.headers.get("origin");
      if (!origin || !deps.allowedOrigins?.has(origin.toLowerCase())) return refusedWrite(deps, req, "This change did not come from the console's own page (its Origin is missing or another site's).");
      const form = await req.formData().catch(() => null);
      const given = form?.get("csrf");
      if (!form || typeof given !== "string" || !sameSecret(given, csrf)) return refusedWrite(deps, req, "This change carried no valid token for your session: the page may be from before a restart.");
      if (isDeleteWrite(path)) {
        const r = deleteWrite(deps.db, path, form, (req.headers.get("accept") ?? "").includes("application/json"), ctx.now);
        return "json" in r ? respond(r.json.body, r.json.status, "application/json; charset=utf-8") : respond(null, 303, "text/plain", { location: r.location });
      }
      if (isSettingsWrite(path)) return respond(null, 303, "text/plain", { location: settingsWrite(deps.db, path, form, ctx.now) });
      if (PROFILE_WRITES.has(path)) return respond(null, 303, "text/plain", { location: profileWrite(deps.db, homeOf(deps), path, form, auth.who, ctx.now!) });
      const chatWrite = CHAT_SETTINGS_WRITE.exec(path);
      if (chatWrite) {
        const wdeps = { ...settingsDeps(deps), now: ctx.now!, timeZone: deps.timeZone, ...(auth.who ? { login: auth.who } : {}), ...(deps.signalTurn ? { signal: deps.signalTurn } : {}) };
        return respond(null, 303, "text/plain", { location: chatSettingsWrite(wdeps, Number(chatWrite[1]), chatWrite[2]!, form) });
      }
      return respond(null, 303, "text/plain", { location: homeSave(deps.db, homeOf(deps), form, auth.who, ctx.now!) });
    }
    if (path === "/home" || path === "/home/history" || path === "/home/watch") {
      const hctx = { csrf, timeZone: ctx.timeZone, now: ctx.now!, ...(ctx.who ? { who: ctx.who } : {}), ...(deps.prompt ? { prompt: deps.prompt } : {}) };
      if (path === "/home/history") return htmlResponse(activityPage({ ...allHistory(deps.db, homeOf(deps), url.searchParams.get("before") ?? undefined), ...hctx }));
      if (path === "/home/watch") {
        // The editor's poll (home.ts): a banner when the file changed since the version it opened, else nothing.
        // In a profile, its own copy (capabilities/memory/layers.ts); else the file itself.
        const file = url.searchParams.get("file") ?? "";
        const profile = url.searchParams.get("profile") ?? undefined;
        const layers = HomeLayers.of(homeOf(deps), profile);
        const phys = layers.profile && layers.hasOwn(file) ? layers.ownPath(file)! : file;
        const changed = watch(deps.db, homeOf(deps), phys, url.searchParams.get("base") ?? "");
        return htmlResponse(changed ? changedBanner(changed, file, layers.name ?? undefined).s : "");
      }
      return htmlResponse(homePage(loadHome(deps.db, homeOf(deps), url.searchParams, hctx, takeResult(url.searchParams.get("r"), ctx.now!))));
    }
    if (path === "/" || path === "/login") return respond(null, 302, "text/plain", { location: "/turns" });
    if (path === "/media") return media(deps, url.searchParams.get("ref"));
    if (path === "/live") {
      // The assets' version is known only once the editor is built (assets.ts): a page reconnecting just after a restart
      // must not be told its assets changed while the build is still under way.
      await warmAssets().catch(() => {});
      return openLive({ db: deps.db, ctx, now: deps.now ?? Date.now, session: auth.session, url, signal: req.signal, ...(deps.liveHub ? { hub: deps.liveHub } : {}) }, SECURITY_HEADERS);
    }
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
    // A switch asked for from a chat's settings page, followed until it is done (chat-settings.ts `switchingLine`):
    // while pending, the line again; once done, the page is loaded again with the result, shown once.
    const switching = /^\/chats\/(\d+)\/settings\/switching$/.exec(path);
    if (switching) {
      const chatId = Number(switching[1]);
      const req = getSwitchRequest(deps.db, Number(url.searchParams.get("req")));
      if (!req || req.chatId !== chatId) return notFound(ctx.who);
      if (req.status === "pending") return htmlResponse(switchingLine({ chat: { id: chatId } as never }, { to: req.toModel, mode: req.mode, requestId: req.id, stopping: req.stoppedTurnId }).s);
      const r = keepResult(ctx.now!, { chatId, section: "model", flash: switchResultFlash(deps.db, req) });
      return htmlResponse("", 200, { "hx-redirect": `/chats/${chatId}/settings?r=${r}#model` });
    }
    // The Computer section's disk, fetched by the page after it has loaded (chat-extras.ts `diskLine`): a read with
    // one Hangar call, which waits at most DISK_TIMEOUT_MS.
    const disk = /^\/chats\/(\d+)\/settings\/disk$/.exec(path);
    if (disk) {
      const cfg = computerOf(deps);
      const chatId = Number(disk[1]);
      return htmlResponse(diskLine(chatId, cfg ? await diskFacts(deps.db, cfg, chatId) : { error: "the computer is off in this process" }).s);
    }
    // A chat's settings, by category (chat-settings.ts `CATEGORIES`): Chat, Permissions, Automation & machine.
    const settings = /^\/chats\/(\d+)\/settings(?:\/(permissions|automation))?$/.exec(path);
    if (settings) {
      const category = (settings[2] ?? "chat") as SettingsCategory;
      const result = takeSettingsResult(url.searchParams.get("r"), Number(settings[1]), ctx.now!);
      const v = loadChatSettings(settingsDeps(deps), Number(settings[1]), url.searchParams, { timeZone: ctx.timeZone, now: ctx.now!, csrf, category, ...(ctx.who ? { who: ctx.who } : {}) }, result);
      return v ? htmlResponse(chatSettingsPage(v, chatListPane(ctx, v.chat.id))) : notFound(ctx.who);
    }
    const chat = /^\/chats\/(\d+)$/.exec(path);
    if (chat) {
      const out = chatPage({ ...ctx, csrf }, Number(chat[1]), url.searchParams);
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
  const server = Bun.serve({
    ...parseConsoleListen(listen),
    maxRequestBodySize: MAX_BODY,
    fetch: (req, srv) => {
      // A live page's stream stays open while the page does (live.ts): no idle timeout; its heartbeat keeps it busy.
      if (new URL(req.url).pathname === "/live") srv.timeout(req, 0);
      return handleConsole({ ...deps, allowedHosts: allowed.hosts, allowedOrigins: allowed.origins }, req);
    },
  });
  allowed = where(server.port!);
  // Build the editor now, so the first Home page does not wait for it and names its version (a failure is retried on request).
  void warmAssets().catch((e) => console.error("console: ", e instanceof Error ? e.message : e));
  signal.addEventListener("abort", () => void server.stop(true), { once: true });
  console.log(`console: listening on ${server.hostname}:${server.port} (${deps.users ? `tailnet users: ${[...deps.users].join(", ")}` : "token sign-in"})`);
  return server;
}
