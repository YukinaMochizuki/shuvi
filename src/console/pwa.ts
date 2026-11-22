import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The console as an installable app, a PWA (docs/console.md, "Installing it"): the owner adds it to a phone's or a
 * computer's home screen and it opens in a window of its own, without the browser's bars.
 *
 * WHAT IT IS: a manifest (`/manifest.webmanifest`), the icons (`pwa/`, rendered from `pwa/icon.svg` by
 * scripts/pwa-icons.ts), and a service worker (`/sw.js`) whose ONLY job is one page, `/offline`, answered to a
 * top-level page load (a GET navigation) that cannot reach the console: the device is offline, or the tailnet or the
 * machine is down. Nothing else is cached and nothing else is answered by it: a write (a POST navigation), htmx's
 * requests, the live stream, images and the assets go to the network exactly as without it (a request the worker
 * does not answer is the browser's own). Opening an image by its link (`/media`, pages.ts `img`) is a page load
 * like any other: the network, or the offline page. The pages hold chats and are live; nothing of a chat is kept on
 * the device, and no page is ever shown from a cache.
 *
 * PUBLIC, like the stylesheet and scripts (server.ts): a browser fetches the manifest without credentials (no cookie
 * in token mode), and the worker and the icons before anyone has signed in. None of them holds anything but what is
 * in this file and pwa/.
 *
 * THE WORKER'S UPDATES: `/sw.js` is served `no-cache`, so the browser checks it on every navigation; its cache's name
 * carries a hash of the offline page, so a deploy that changes that page changes the worker's text, and the new one
 * caches the page again and deletes the old cache when it takes over. Unchanged, nothing happens.
 *
 * The CSP opens `manifest-src` and `worker-src` to this origin for these (server.ts `SECURITY_HEADERS`).
 */

const PWA_DIR = join(dirname(fileURLToPath(import.meta.url)), "pwa");

/** The console's colour behind the app while it opens, and its title bar's (style.css `--surface`). */
export const THEME_COLOR = "#1e1e24";
export const MANIFEST_PATH = "/manifest.webmanifest";
export const WORKER_PATH = "/sw.js";
export const OFFLINE_PATH = "/offline";
export const APPLE_ICON_PATH = "/pwa/apple-touch-icon.png";

const ICONS = ["icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"] as const;

const MANIFEST = JSON.stringify({
  id: "/",
  name: "shuvi console",
  short_name: "shuvi",
  description: "shuvi's turns, chats, files and settings.",
  start_url: "/turns",
  scope: "/",
  display: "standalone",
  background_color: THEME_COLOR,
  theme_color: THEME_COLOR,
  icons: [
    { src: "/pwa/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/pwa/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/pwa/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
});

/**
 * What a page load that cannot reach the console shows. Its own page, its style and icon inline under a CSP of its
 * own (`OFFLINE_CSP`: no script, images only as data), so it needs nothing else from the console, which it cannot
 * reach; "Try again" loads the address it was asked for.
 */
const OFFLINE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="${THEME_COLOR}">
<title>Not reachable · shuvi</title>
<style>
  html, body { margin: 0; height: 100%; background: ${THEME_COLOR}; color: #eceae7; font: 15px ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Noto Sans TC", sans-serif; }
  main { box-sizing: border-box; min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; text-align: center; }
  img { width: 72px; height: 72px; border-radius: 18px; }
  h1 { margin: 8px 0 0; font-size: 17px; }
  p { margin: 0; max-width: 32ch; color: #b3aea7; line-height: 1.5; }
  a { margin-top: 8px; padding: 8px 18px; border-radius: 6px; background: #7aa2f7; color: #1e1e24; text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
<main>
<img src="data:image/png;base64,${readFileSync(join(PWA_DIR, "icon-192.png")).toString("base64")}" alt="">
<h1>The console cannot be reached</h1>
<p>This device is offline, or the tailnet or shuvi's machine is down. Nothing is shown from a copy kept here.</p>
<a href="">Try again</a>
</main>
</body>
</html>
`;

const WORKER = `// The console's service worker (src/console/pwa.ts): a GET page load that cannot reach the console gets the
// offline page. Nothing else is answered here, and nothing else is kept. No navigation preload: a request the
// worker leaves alone (a write's POST) must go out once, as it would without a worker.
"use strict";
const PREFIX = "shuvi-offline-";
const CACHE = PREFIX + "${createHash("sha256").update(OFFLINE_PAGE).digest("hex").slice(0, 12)}";
const OFFLINE = "${OFFLINE_PATH}";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add(new Request(OFFLINE, { cache: "reload" }))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    // Only this worker's older copies.
    for (const k of await caches.keys()) if (k.startsWith(PREFIX) && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.mode !== "navigate" || r.method !== "GET") return;
  e.respondWith((async () => {
    try {
      return await fetch(r);
    } catch {
      return (await caches.match(OFFLINE, { cacheName: CACHE })) || Response.error();
    }
  })());
});
`;

export interface PwaFile {
  body: string | Uint8Array;
  type: string;
  cacheControl: string;
  /** Its own CSP instead of the console's (the offline page: no script at all, its icon inline). */
  csp?: string;
}

const OFFLINE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

const FILES = new Map<string, PwaFile>([
  [MANIFEST_PATH, { body: MANIFEST, type: "application/manifest+json; charset=utf-8", cacheControl: "no-cache" }],
  [WORKER_PATH, { body: WORKER, type: "text/javascript; charset=utf-8", cacheControl: "no-cache" }],
  [OFFLINE_PATH, { body: OFFLINE_PAGE, type: "text/html; charset=utf-8", cacheControl: "no-cache", csp: OFFLINE_CSP }],
  ...ICONS.map((name): [string, PwaFile] => [`/pwa/${name}`, { body: new Uint8Array(readFileSync(join(PWA_DIR, name))), type: "image/png", cacheControl: "public, max-age=86400" }]),
]);

/** The PWA's file at `path` (public: see the header), or `undefined` when `path` is not one. */
export function pwaFile(path: string): PwaFile | undefined {
  return FILES.get(path);
}
