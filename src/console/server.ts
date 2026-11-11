import { createHmac } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sameSecret } from "../secrets/compare.ts";
import type { Db } from "../store/db.ts";
import { sniffImage } from "../store/media.ts";
import { cardPage, html } from "./html.ts";
import { chatPage, turnsPage, type PageContext } from "./pages.ts";

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
 * READ ONLY: GET and HEAD, plus POST /login. Every page is server-rendered with escaped text (html.ts); the
 * CSP allows only this origin's stylesheet, images and one script (console.js: copy buttons, j / k).
 */

export interface ConsoleDeps {
  db: Db;
  timeZone: string;
  dataDir: string;
  /** The Host values a request may carry (`index.ts` `allowedHosts`). */
  allowedHosts: ReadonlySet<string>;
  /** Tailnet logins allowed in. Set: the only auth. */
  users?: ReadonlySet<string>;
  /** The fallback token, used only when `users` is not set. */
  token?: string;
  /** The owner's id, whose lines are marked in a group. */
  ownerId?: number;
  now?: () => number;
}

export const LOGIN_HEADER = "tailscale-user-login";
export const SESSION_COOKIE = "shuvi_console";
export const SESSION_MS = 7 * 24 * 3600_000;

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, "style.css"), "utf8");
const JS = readFileSync(join(HERE, "console.js"), "utf8");

const SECURITY_HEADERS: Record<string, string> = {
  // Inline style attributes only (a size bar's width, a speaker's colour); no inline script at all.
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
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

const forbidden = () => htmlResponse(cardPage("Not for you", html`<p>This console is open to the tailnet users it lists, and this request did not come from one of them.</p>`), 403);
const notFound = (who?: string) => htmlResponse(cardPage("Not found", html`<p>There is nothing here. <a href="/turns">Back to the turns</a>.</p>`, who), 404);
const misdirected = () => respond("This console does not answer for that host.\n", 421, "text/plain; charset=utf-8");

type Auth = { ok: true; who?: string } | { ok: false; response: Response };

async function authenticate(deps: ConsoleDeps, req: Request, path: string): Promise<Auth> {
  const now = (deps.now ?? Date.now)();
  if (deps.users) {
    const login = req.headers.get(LOGIN_HEADER)?.trim();
    return login && deps.users.has(login) ? { ok: true, who: login } : { ok: false, response: forbidden() };
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
  if ((bearer && sameSecret(bearer, token)) || validSession(token, cookie(req, SESSION_COOKIE), now)) return { ok: true };
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
  if (!["GET", "HEAD"].includes(req.method) && !(req.method === "POST" && path === "/login")) {
    return respond("read only", 405, "text/plain", { allow: "GET, HEAD" });
  }
  // The stylesheet and the script are public: the sign-in, 403 and 404 pages need them before anyone is let in,
  // and they hold nothing but this file's own code.
  if (path === "/style.css") return respond(CSS, 200, "text/css; charset=utf-8", { "cache-control": "public, max-age=3600" });
  if (path === "/console.js") return respond(JS, 200, "text/javascript; charset=utf-8", { "cache-control": "public, max-age=3600" });
  try {
    const auth = await authenticate(deps, req, path);
    if (!auth.ok) return auth.response;
    const ctx: PageContext = { db: deps.db, timeZone: deps.timeZone, ...(auth.who ? { who: auth.who } : {}), ...(deps.ownerId !== undefined ? { ownerId: deps.ownerId } : {}), now: (deps.now ?? Date.now)() };
    if (path === "/" || path === "/login") return respond(null, 302, "text/plain", { location: "/turns" });
    if (path === "/media") return media(deps, url.searchParams.get("ref"));
    // Chats and turns are one navigation now (the list groups turns by chat); the old address leads there.
    if (path === "/chats") return respond(null, 302, "text/plain", { location: "/turns" });
    if (path === "/turns") return htmlResponse(turnsPage(ctx, url.searchParams)!);
    const chat = /^\/chats\/(\d+)$/.exec(path);
    if (chat) {
      const out = chatPage(ctx, Number(chat[1]), url.searchParams);
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
 * Serve the console on `listen` (loopback only) until `signal` aborts. `hosts(port)` gives the Host values it
 * answers, once the port is known (a listen port of 0 binds any free one, as the e2e scripts do).
 */
export function serveConsole(deps: Omit<ConsoleDeps, "allowedHosts">, listen: string, hosts: (port: number) => ReadonlySet<string>, signal: AbortSignal): ReturnType<typeof Bun.serve> {
  let allowed: ReadonlySet<string> = new Set();
  const server = Bun.serve({ ...parseConsoleListen(listen), maxRequestBodySize: 16 * 1024, fetch: (req) => handleConsole({ ...deps, allowedHosts: allowed }, req) });
  allowed = hosts(server.port!);
  signal.addEventListener("abort", () => void server.stop(true), { once: true });
  console.log(`console: listening on ${server.hostname}:${server.port} (${deps.users ? `tailnet users: ${[...deps.users].join(", ")}` : "token sign-in"})`);
  return server;
}
