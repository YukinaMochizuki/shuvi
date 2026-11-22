import { describe, expect, test } from "bun:test";
import { allowedHosts } from "../src/console/index.ts";
import { handleConsole, LOGIN_HEADER, type ConsoleDeps } from "../src/console/server.ts";
import { memDb } from "./helpers.ts";

const HOST = "127.0.0.1:8787";
const tailnet = (): ConsoleDeps => ({ db: memDb(), timeZone: "Asia/Taipei", dataDir: "/nonexistent", allowedHosts: allowedHosts({ listen: HOST, url: "https://example-host.example-tailnet.ts.net" }, 8787), users: new Set(["owner@example.com"]) });
const tokenMode = (): ConsoleDeps => ({ db: memDb(), timeZone: "Asia/Taipei", dataDir: "/nonexistent", allowedHosts: allowedHosts({ listen: HOST }, 8787), token: "example-token" });
/** A request with no sign-in at all: no login header, no cookie, no bearer. */
const anon = (deps: ConsoleDeps, path: string, method = "GET") => handleConsole(deps, new Request(`http://${HOST}${path}`, { method }));
const owner = (path: string) => handleConsole(tailnet(), new Request(`http://${HOST}${path}`, { headers: { [LOGIN_HEADER]: "owner@example.com" } }));

describe("the app's files", () => {
  test("are public in both sign-in modes, with their types", async () => {
    const want: [string, string][] = [
      ["/manifest.webmanifest", "application/manifest+json"],
      ["/sw.js", "text/javascript"],
      ["/offline", "text/html"],
      ["/pwa/icon-192.png", "image/png"],
      ["/pwa/icon-512.png", "image/png"],
      ["/pwa/icon-maskable-512.png", "image/png"],
      ["/pwa/apple-touch-icon.png", "image/png"],
    ];
    for (const deps of [tailnet(), tokenMode()]) {
      for (const [path, type] of want) {
        const r = await anon(deps, path);
        expect(r.status, path).toBe(200);
        expect(r.headers.get("content-type"), path).toStartWith(type);
      }
    }
    // A PNG is a PNG.
    const png = new Uint8Array(await (await anon(tailnet(), "/pwa/icon-512.png")).arrayBuffer());
    expect([...png.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    // Nothing else under /pwa/ is served (they are looked up by exact path), and a page still needs a sign-in.
    expect((await anon(tailnet(), "/pwa/icon.svg")).status).toBe(403);
    expect((await anon(tokenMode(), "/turns")).status).toBe(401);
    // Public, but only under the console's own names: another Host is refused first (DNS rebinding).
    const foreign = await handleConsole(tailnet(), new Request("http://attacker.example/sw.js", { headers: { host: "attacker.example" } }));
    expect(foreign.status).toBe(421);
    // Read only, like any page.
    expect((await anon(tailnet(), "/manifest.webmanifest", "POST")).status).toBe(405);
  });

  test("the manifest: a standalone app over the whole console, icons that exist", async () => {
    const m = (await (await anon(tailnet(), "/manifest.webmanifest")).json()) as { id: string; start_url: string; scope: string; display: string; short_name: string; icons: { src: string; sizes: string; purpose: string }[] };
    expect(m).toMatchObject({ id: "/", start_url: "/turns", scope: "/", display: "standalone", short_name: "shuvi" });
    expect(m.icons.map((i) => i.purpose).sort()).toEqual(["any", "any", "maskable"]);
    for (const i of m.icons) expect((await anon(tailnet(), i.src)).status, i.src).toBe(200);
  });

  test("every page names the manifest and the home screen icon; the CSP allows the manifest and the worker", async () => {
    const r = await owner("/turns");
    const text = await r.text();
    expect(text).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(text).toContain('<link rel="apple-touch-icon" href="/pwa/apple-touch-icon.png">');
    expect(text).toContain('<meta name="theme-color" content="#1e1e24">');
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toContain("manifest-src 'self'");
    expect(csp).toContain("worker-src 'self'");
    // The sign-in page too, so the app can be added before signing in.
    expect(await (await anon(tokenMode(), "/login")).text()).toContain('<link rel="manifest"');
  });

  test("the offline page needs nothing from the console, and runs no script", async () => {
    const r = await anon(tailnet(), "/offline");
    const text = await r.text();
    expect(text).not.toMatch(/<script|<link |src="\//);
    expect(text).toContain('src="data:image/png;base64,');
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
    expect(csp).toContain("img-src data:");
  });
});

/** sw.js run against a fake worker scope: what it does with each kind of request. */
async function worker(network: (r: { url: string }) => Promise<Response>, stored = new Map<string, Map<string, Response>>()) {
  const code = await (await anon(tailnet(), "/sw.js")).text();
  const handlers: Record<string, (e: unknown) => void> = {};
  const caches = {
    open: async (name: string) => {
      const c = stored.get(name) ?? new Map<string, Response>();
      stored.set(name, c);
      return { add: async (r: Request) => void c.set(new URL(r.url, "http://h").pathname, await network(r)) };
    },
    keys: async () => [...stored.keys()],
    delete: async (k: string) => stored.delete(k),
    match: async (path: string, o: { cacheName: string }) => stored.get(o.cacheName)?.get(path)?.clone(),
  };
  const self = {
    addEventListener: (k: string, f: (e: unknown) => void) => (handlers[k] = f),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    registration: {},
  };
  // In a worker a relative URL is the worker's origin's.
  const WorkerRequest = class extends Request {
    constructor(u: string, init?: RequestInit) {
      super(new URL(u, "http://h").href, init);
    }
  };
  new Function("self", "caches", "fetch", "Request", "Response", code)(self, caches, network, WorkerRequest, Response);
  for (const k of ["install", "activate"]) {
    let wait: Promise<unknown> = Promise.resolve();
    handlers[k]!({ waitUntil: (p: Promise<unknown>) => (wait = p) });
    await wait;
  }
  /** What the worker answers `r` with, or `null` when it leaves it to the browser. */
  return async (r: Request, mode: string): Promise<Response | null> => {
    let answer: Promise<Response> | null = null;
    // A fetch event's request, as far as the worker reads it.
    const req = { mode, method: r.method, url: r.url };
    handlers.fetch!({ request: req, respondWith: (p: Promise<Response>) => (answer = p) });
    return answer;
  };
}

describe("the worker", () => {
  test("a GET page load goes to the network; when that fails, the offline page", async () => {
    let up = true;
    const fetchOf = await worker(async (r) => {
      if (new URL(r.url, "http://h").pathname === "/offline") return new Response("OFFLINE PAGE");
      if (!up) throw new TypeError("Failed to fetch");
      return new Response(`live ${new URL(r.url).pathname}`);
    });
    expect(await (await fetchOf(new Request("http://h/turns/5"), "navigate"))!.text()).toBe("live /turns/5");
    up = false;
    expect(await (await fetchOf(new Request("http://h/turns/5"), "navigate"))!.text()).toBe("OFFLINE PAGE");
  });

  test("on taking over, drops only its own older copies", async () => {
    const stored = new Map<string, Map<string, Response>>([
      ["shuvi-offline-000000000000", new Map()],
      ["someone-else", new Map()],
    ]);
    await worker(async () => new Response("OFFLINE PAGE"), stored);
    const names = [...stored.keys()];
    expect(names).toContain("someone-else");
    expect(names).not.toContain("shuvi-offline-000000000000");
    expect(names.filter((n) => n.startsWith("shuvi-offline-"))).toHaveLength(1);
  });

  test("leaves everything else alone: writes, htmx, the live stream, media", async () => {
    const fetchOf = await worker(async () => new Response("x"));
    expect(await fetchOf(new Request("http://h/settings/models/add", { method: "POST" }), "navigate")).toBeNull();
    expect(await fetchOf(new Request("http://h/turns"), "cors")).toBeNull();
    expect(await fetchOf(new Request("http://h/live?page=/turns"), "cors")).toBeNull();
    expect(await fetchOf(new Request("http://h/media?ref=media/a.png"), "no-cors")).toBeNull();
  });
});
