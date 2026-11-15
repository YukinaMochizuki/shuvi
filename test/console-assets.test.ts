import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IMMUTABLE, replaceAssetForTest, warmAssets } from "../src/console/assets.ts";
import { allowedHosts } from "../src/console/index.ts";
import { handleConsole, LOGIN_HEADER, type ConsoleDeps } from "../src/console/server.ts";
import { memDb } from "./helpers.ts";

const HOST = "127.0.0.1:8787";
const deps = (): ConsoleDeps => ({ db: memDb(), timeZone: "Asia/Taipei", dataDir: "/nonexistent", allowedHosts: allowedHosts({ listen: HOST, url: "https://example-host.example-tailnet.ts.net" }, 8787), users: new Set(["owner@example.com"]) });
const get = (path: string) => handleConsole(deps(), new Request(`http://${HOST}${path}`, { headers: { [LOGIN_HEADER]: "owner@example.com" } }));
const ORIGINAL_CSS = readFileSync(join(import.meta.dir, "../src/console/style.css"), "utf8");
afterAll(() => replaceAssetForTest("style", ORIGINAL_CSS));

/** The page's stylesheet address, and its `<meta name="assets">`. */
async function head(): Promise<{ css: string; version: string }> {
  const text = await (await get("/turns")).text();
  return { css: /<link rel="stylesheet" href="([^"]+)">/.exec(text)![1]!, version: /<meta name="assets" content="([0-9a-f]+)">/.exec(text)![1]! };
}

describe("asset versions", () => {
  test("a new style.css is a new address; only the current one is cached for good", async () => {
    replaceAssetForTest("style", "body { color: red; }\n");
    const before = await head();
    expect(before.css).toMatch(/^\/style\.css\?v=[0-9a-f]{12}$/);
    const old = await get(before.css);
    expect(old.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(await old.text()).toBe("body { color: red; }\n");

    replaceAssetForTest("style", "body { color: blue; }\n"); // a deploy
    const after = await head();
    expect(after.css).toMatch(/^\/style\.css\?v=[0-9a-f]{12}$/);
    expect(after.css).not.toBe(before.css);
    expect(after.version).not.toBe(before.version);
    // The old address now gets the current content, and is not kept.
    const stale = await get(before.css);
    expect(stale.headers.get("cache-control")).toBe("no-cache");
    expect(await stale.text()).toBe("body { color: blue; }\n");
    const fresh = await get(after.css);
    expect(fresh.headers.get("cache-control")).toBe(IMMUTABLE);
    // No `v` at all: the current content, not kept.
    expect((await get("/style.css")).headers.get("cache-control")).toBe("no-cache");
  });

  test("every script is versioned the same way; the editor once its bundle is built", async () => {
    await warmAssets();
    const text = await (await get("/turns")).text();
    for (const name of ["htmx.min.js", "console.js"]) {
      const src = new RegExp(`<script src="(/${name.replace(".", "\\.")}\\?v=[0-9a-f]{12})" defer>`).exec(text)?.[1];
      expect(src).toBeDefined();
      expect((await get(src!)).headers.get("cache-control")).toBe(IMMUTABLE);
      expect((await get(`/${name}?v=000000000000`)).headers.get("cache-control")).toBe("no-cache");
    }
    // No page names an asset by its bare path.
    expect(text).not.toMatch(/(href|src)="\/(style\.css|console\.js|htmx\.min\.js|editor\.js)"/);
    const home = await (await get("/home")).text();
    const editor = /<script src="(\/editor\.js\?v=[0-9a-f]{12})" defer>/.exec(home)?.[1];
    expect(editor).toBeDefined();
    expect((await get(editor!)).headers.get("cache-control")).toBe(IMMUTABLE);
  }, 30_000);
});
