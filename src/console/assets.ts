import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { editorBundle } from "./editor/bundle.ts";

/**
 * The console's stylesheet and scripts, under URLs that change when their content does.
 *
 * WHY: they are cached by the browser, and a deploy must not leave a page running against an old copy (a new
 * page's classes with the old stylesheet). So each one is addressed as `<path>?v=<hash>`, the first 12 hex of the
 * sha256 of what is served (for the editor, of its built bundle), and only that address is cached for good
 * (`public, max-age=31536000, immutable`). Its path without `v`, or with any other `v` (a page from before a
 * deploy), is answered with the current content under `no-cache`. html.ts `page` writes the addresses
 * (`assetUrl`); no page names an asset's path itself.
 *
 * A BOOSTED navigation (htmx) swaps the body and keeps the head, so a page loaded before a deploy would keep its
 * old stylesheet and scripts against new markup. Every page carries `<meta name="assets" content="<version>">`
 * (`assetsVersion`, a hash of the four hashes); console.js compares a boosted GET's answer's with its own on
 * `htmx:beforeSwap` and, when they differ, loads that page in full instead of swapping it in.
 *
 * The editor is bundled in the process (editor/bundle.ts), so its hash is known only once that build is done
 * (the console starts it when it starts). Until then its address has no `v` (served `no-cache`), and the version
 * says "editor pending": a page drawn in that first moment differs from the next ones, which costs one full load.
 */

export type Asset = "style" | "console" | "htmx" | "editor";

const HERE = dirname(fileURLToPath(import.meta.url));

const PATHS: Record<Asset, string> = { style: "/style.css", console: "/console.js", htmx: "/htmx.min.js", editor: "/editor.js" };
const TYPES: Record<Asset, string> = {
  style: "text/css; charset=utf-8",
  console: "text/javascript; charset=utf-8",
  htmx: "text/javascript; charset=utf-8",
  editor: "text/javascript; charset=utf-8",
};

export const IMMUTABLE = "public, max-age=31536000, immutable";

const hash12 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

interface Loaded {
  body: string;
  hash: string;
}

function load(text: string): Loaded {
  return { body: text, hash: hash12(text) };
}

const files: Partial<Record<Asset, Loaded>> = {
  style: load(readFileSync(join(HERE, "style.css"), "utf8")),
  console: load(readFileSync(join(HERE, "console.js"), "utf8")),
  htmx: load(readFileSync(fileURLToPath(import.meta.resolve("htmx.org/dist/htmx.min.js")), "utf8")),
};

/** The editor's bundle, built (or waited for); its hash is known from then on. */
async function editor(): Promise<Loaded> {
  const text = await editorBundle();
  if (files.editor?.body !== text) files.editor = load(text);
  return files.editor!;
}

/** Serve `text` as `asset` from now on, as a deploy would (tests only). */
export function replaceAssetForTest(asset: Exclude<Asset, "editor">, text: string): void {
  files[asset] = load(text);
}

/** Start the editor's build now, so its hash is known for the first Home page (server.ts `serveConsole`). */
export function warmAssets(): Promise<void> {
  return editor().then(() => undefined);
}

/** The address of `asset` a page writes: with its hash once known, else its bare path. */
export function assetUrl(asset: Asset): string {
  const h = files[asset]?.hash;
  return h ? `${PATHS[asset]}?v=${h}` : PATHS[asset];
}

/** What a page's `<meta name="assets">` says: one hash of the four (see the header). */
export function assetsVersion(): string {
  return hash12((["style", "console", "htmx", "editor"] as const).map((a) => `${a}:${files[a]?.hash ?? "pending"}`).join(","));
}

const BY_PATH = new Map<string, Asset>(Object.entries(PATHS).map(([a, p]) => [p, a as Asset]));

/** The asset at `path`, or `undefined` when `path` is not one. */
export function assetAt(path: string): Asset | undefined {
  return BY_PATH.get(path);
}

/**
 * Serve `asset` for a request asking for version `v`: the current content, cached for good only when `v` is its
 * hash. Returns its body, type and cache-control.
 */
export async function serveAsset(asset: Asset, v: string | null): Promise<{ body: string; type: string; cacheControl: string }> {
  const f = asset === "editor" ? await editor() : files[asset]!;
  return { body: f.body, type: TYPES[asset], cacheControl: v === f.hash ? IMMUTABLE : "no-cache" };
}
