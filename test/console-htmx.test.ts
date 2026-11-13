import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allowedHosts, allowedOrigins } from "../src/console/index.ts";
import { csrfToken, handleConsole, LOGIN_HEADER, type ConsoleDeps } from "../src/console/server.ts";
import { anchor } from "../src/console/settings.ts";
import { closeConsoleListing, consoleListing, openConsoleListing, probeText } from "../src/control/model-cards.ts";
import { backgroundPass, backgroundSettled } from "../src/server/probes.ts";
import type { Db } from "../src/store/db.ts";
import { addModel, addProvider, cancelProbe, findModel, markProbing, recordProbe } from "../src/store/models.ts";
import { models } from "../src/store/schema.ts";
import { memDb } from "./helpers.ts";

/**
 * The console with htmx (PR A): the shell and its script, the parts of Settings fetched while something is
 * pending, cancelling a probe, and the background pass aborting what is no longer asked.
 */

const PORT = 8787;
const HOST = `127.0.0.1:${PORT}`;
const BASE = `http://${HOST}`;
const SECRET = "example-csrf-secret";
const LOGIN = "owner@example.com";
const CSRF = csrfToken(SECRET, `login:${LOGIN}`);

let endpoint: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  endpoint?.stop(true);
  endpoint = null;
});

function deps(db: Db): ConsoleDeps {
  const c = { listen: HOST };
  return { db, timeZone: "UTC", dataDir: "/nonexistent", allowedHosts: allowedHosts(c, PORT), allowedOrigins: allowedOrigins(c, PORT), csrfSecret: SECRET, users: new Set([LOGIN]) };
}

const get = (db: Db, path: string) => handleConsole(deps(db), new Request(`${BASE}${path}`, { headers: { [LOGIN_HEADER]: LOGIN } }));
const post = (db: Db, path: string, fields: Record<string, string>) =>
  handleConsole(deps(db), new Request(`${BASE}${path}`, { method: "POST", headers: { [LOGIN_HEADER]: LOGIN, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...fields, csrf: CSRF }) }));

function setup(baseUrl = "http://127.0.0.1:9/v1"): Db {
  const db = memDb();
  addProvider(db, { name: "claude", kind: "claude" });
  addModel(db, { provider: "claude", model: "opus" });
  addProvider(db, { name: "vllm", kind: "openai-compat", baseUrl });
  addModel(db, { provider: "vllm", model: "qwen", contextWindow: 32_000 });
  return db;
}

/** An endpoint that never answers, and records each request the client gave up on. */
function hangingEndpoint(): { url: string; asked: string[]; aborted: string[] } {
  const asked: string[] = [];
  const aborted: string[] = [];
  endpoint = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      asked.push(path);
      req.signal.addEventListener("abort", () => aborted.push(path));
      return new Promise<Response>(() => {});
    },
  });
  return { url: `http://127.0.0.1:${endpoint.port}/v1`, asked, aborted };
}

const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
};

describe("the shell", () => {
  test("htmx is served from this origin, configured without eval or a history copy, and the CSP lets it fetch this origin only", async () => {
    const db = setup();
    const js = await get(db, "/htmx.min.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toStartWith("text/javascript");
    expect((await js.text()).length).toBeGreaterThan(10_000);
    const res = await get(db, "/turns");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toBe("default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const html = await res.text();
    expect(html).toContain(`<script src="/htmx.min.js" defer></script>`);
    expect(html).toContain(`<body hx-boost="true" hx-indicator="#progress">`);
    const config = JSON.parse(/<meta name="htmx-config" content="([^"]+)">/.exec(html)![1]!.replace(/&quot;/g, '"'));
    expect(config).toMatchObject({ allowEval: false, allowScriptTags: false, historyCacheSize: 0, selfRequestsOnly: true, includeIndicatorStyles: false });
  });

  test("the htmx served is the pinned package's", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["htmx.org"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("Settings with htmx", () => {
  test("every write form posts in the background and swaps the page's main; in-page links swap it too", async () => {
    const html = await (await get(setup(), "/settings")).text();
    const forms = [...html.matchAll(/<form [^>]*method="post"[^>]*>/g)].map(([tag]) => tag);
    expect(forms.length).toBe(6); // vllm's List models; qwen's Make default, Re-probe, Vision; Add a model; Add a provider
    for (const tag of forms) {
      const action = /action="([^"]+)"/.exec(tag)![1];
      expect(tag).toContain(`hx-post="${action}" hx-target="main.settings" hx-select="main" hx-swap="outerHTML" hx-push-url="false"`);
    }
    expect(html).toMatch(/<a class="btn danger" href="\/settings\?remove=model%3Avllm%2Fqwen#model-vllm_2fqwen" hx-target="main.settings" hx-select="main" hx-swap="outerHTML">Remove<\/a>/);
  });

  test("the vision switch disables its three buttons together; a polled part is marked for console.js", async () => {
    const db = setup();
    markProbing(db, findModel(db, "vllm/qwen")!.model.id);
    const html = await (await get(db, "/settings")).text();
    expect(html).toContain(`action="/settings/models/vision" class="seg-btns" aria-label="vision" hx-post="/settings/models/vision" hx-target="main.settings" hx-select="main" hx-swap="outerHTML" hx-push-url="false" hx-indicator="#progress, closest form" hx-disabled-elt="find fieldset">`);
    expect(html).toMatch(/<fieldset class="seg-set">(<button [^>]*name="vision"[^>]*>\w+<\/button>){3}<\/fieldset><\/form>/);
    expect(html).toContain(`hx-disinherit="*" data-poll>`);
  });

  test("anchors are CSS identifiers and one-to-one", () => {
    expect(anchor("model", "vllm/qwen")).toBe("model-vllm_2fqwen");
    expect(anchor("model", "a_b")).toBe("model-a_5fb");
    expect(anchor("model", "a/b")).not.toBe(anchor("model", "a_2fb"));
    expect(anchor("model", "vllm/qwen-日本")).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("a pending probe's row fetches itself every second, with the time waited and a Cancel; a finished one does not", async () => {
    const db = setup();
    const qwen = findModel(db, "vllm/qwen")!;
    recordProbe(db, qwen.model.id, { status: "ok", error: null, latencyMs: 300, vision: false });
    let html = await (await get(db, "/settings")).text();
    expect(html).not.toContain("hx-trigger");
    markProbing(db, qwen.model.id, Date.now() - 102_000);
    html = await (await get(db, "/settings")).text();
    expect(html).toContain(`id="model-vllm_2fqwen" hx-get="/settings/model?id=vllm%2Fqwen" hx-trigger="every 1s" hx-target="this" hx-swap="outerHTML" hx-indicator="unset" hx-disinherit="*"`);
    expect(html).toMatch(/waited 1:4[23]/);
    expect(html).toContain("each request gives up after 5:00");
    expect(html).toContain(">Cancel probe</button>");
    expect(html).not.toContain(">Re-probe</button>");
    // The part alone: the row, and the count line out of band.
    const part = await (await get(db, "/settings/model?id=vllm%2Fqwen")).text();
    expect(part).toStartWith(`<div class="srow" id="model-vllm_2fqwen" hx-get=`);
    expect(part).toContain(`<span class="meta" id="models-summary" hx-swap-oob="true">2 models · 1 probing</span>`);
    expect(part).not.toContain("<main");
    // Being edited, it is left alone.
    expect(await (await get(db, "/settings?edit=vllm%2Fqwen")).text()).not.toContain("hx-trigger");
    // Done: the part no longer asks again.
    recordProbe(db, qwen.model.id, { status: "ok", error: null, latencyMs: 250, vision: false });
    const done = await (await get(db, "/settings/model?id=vllm%2Fqwen")).text();
    expect(done).not.toContain("hx-trigger");
    expect(done).toContain("probe ok, 250 ms");
    // A model removed meanwhile: its part is empty but for the count line.
    expect(await (await get(db, "/settings/model?id=vllm%2Fgone")).text()).toStartWith(`<span class="meta" id="models-summary"`);
  });

  test("Cancel probe: back to the last result; a second Cancel says there is none", async () => {
    const db = setup();
    const qwen = findModel(db, "vllm/qwen")!;
    recordProbe(db, qwen.model.id, { status: "failed", error: "http: HTTP 402", latencyMs: null, vision: null });
    markProbing(db, qwen.model.id);
    expect(probeText(findModel(db, "vllm/qwen")!)).toBe("checking…");
    let res = await post(db, "/settings/models/probe-cancel", { model: "vllm/qwen" });
    expect(res.status).toBe(303);
    let page = await (await get(db, res.headers.get("location")!.replace(/#.*$/, ""))).text();
    expect(page).toContain("Cancelled the probe of vllm/qwen.");
    expect(findModel(db, "vllm/qwen")!.model).toMatchObject({ probeStartedAt: null, probeStatus: "failed", probeError: "http: HTTP 402" });
    expect(probeText(findModel(db, "vllm/qwen")!)).toBe("⚠ failed: http: HTTP 402");
    res = await post(db, "/settings/models/probe-cancel", { model: "vllm/qwen" });
    page = await (await get(db, res.headers.get("location")!.replace(/#.*$/, ""))).text();
    expect(page).toContain("vllm/qwen has no probe to cancel: it had finished.");
  });

  test("the listing panel fetches itself while the endpoint is listed, and stops once it has answered", async () => {
    const db = setup();
    let html = await (await get(db, "/settings")).text();
    expect(html).toContain(`<div id="listing"></div>`);
    const card = openConsoleListing(db, "vllm", "k1")!;
    html = await (await get(db, "/settings")).text();
    expect(html).toContain(`<div id="listing" hx-get="/settings/listing" hx-trigger="every 1s"`);
    expect(html).toContain("waited 0:0");
    expect(html).toContain(">Cancel the listing</button>");
    closeConsoleListing(db, card.id);
    const part = await (await get(db, "/settings/listing")).text();
    expect(part).toBe(`<div id="listing"></div>`);
  });

  test("a refused write still answers with a page htmx can show", async () => {
    const db = setup();
    const res = await handleConsole(deps(db), new Request(`${BASE}/settings/models/probe`, { method: "POST", headers: { [LOGIN_HEADER]: LOGIN, origin: BASE, "content-type": "application/x-www-form-urlencoded", "hx-request": "true" }, body: new URLSearchParams({ model: "vllm/qwen", csrf: "stale" }) }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(`<main class="card">`);
  });
});

describe("the background pass stops what is no longer asked", () => {
  test("a probe cancelled is aborted at the next pass, and its row keeps the last result", async () => {
    const ep = hangingEndpoint();
    const db = setup(ep.url);
    const qwen = findModel(db, "vllm/qwen")!;
    recordProbe(db, qwen.model.id, { status: "ok", error: null, latencyMs: 120, vision: false });
    markProbing(db, qwen.model.id);
    expect(backgroundPass(db, { secretsFile: "/nonexistent" })).toBe(1);
    await until(() => ep.asked.length === 1);
    expect(cancelProbe(db, qwen.model.id)).toBe(true);
    expect(backgroundPass(db, { secretsFile: "/nonexistent" })).toBe(0);
    await until(() => ep.aborted.length === 1);
    await backgroundSettled();
    expect(findModel(db, "vllm/qwen")!.model).toMatchObject({ probeStartedAt: null, probeStatus: "ok", probeLatencyMs: 120 });
  });

  test("a probe asked again is aborted and started afresh; a removed model's probe is aborted", async () => {
    const ep = hangingEndpoint();
    const db = setup(ep.url);
    const qwen = findModel(db, "vllm/qwen")!;
    markProbing(db, qwen.model.id, Date.now() - 5000);
    backgroundPass(db, { secretsFile: "/nonexistent" });
    await until(() => ep.asked.length === 1);
    db.update(models).set({ probeStartedAt: new Date().toISOString() }).where(eq(models.id, qwen.model.id)).run();
    expect(backgroundPass(db, { secretsFile: "/nonexistent" })).toBe(0); // the old one still ending
    await until(() => ep.aborted.length === 1);
    await until(() => backgroundPass(db, { secretsFile: "/nonexistent" }) === 1);
    await until(() => ep.asked.length === 2);
    db.delete(models).where(eq(models.id, qwen.model.id)).run();
    backgroundPass(db, { secretsFile: "/nonexistent" });
    await until(() => ep.aborted.length === 2);
    await backgroundSettled();
  });

  test("a listing whose card is closed is aborted at the next pass", async () => {
    const ep = hangingEndpoint();
    const db = setup(ep.url);
    const card = openConsoleListing(db, "vllm", "k2")!;
    expect(backgroundPass(db, { secretsFile: "/nonexistent" })).toBe(1);
    await until(() => ep.asked.includes("/v1/models"));
    closeConsoleListing(db, card.id);
    backgroundPass(db, { secretsFile: "/nonexistent" });
    await until(() => ep.aborted.includes("/v1/models"));
    await backgroundSettled();
    expect(consoleListing(db)).toBeUndefined();
  });
});

describe("migration 0017", () => {
  test("a row left `checking` becomes a probe asked, with no last result", () => {
    const db = setup();
    const qwen = findModel(db, "vllm/qwen")!;
    db.$client.run("update models set probe_status = 'checking', probe_started_at = null where id = ?", [qwen.model.id]);
    const sql = readFileSync(join(import.meta.dir, "../drizzle/0017_probe_started_at.sql"), "utf8").split("--> statement-breakpoint")[1]!;
    db.$client.run(sql);
    const row = findModel(db, "vllm/qwen")!.model;
    expect(row.probeStatus).toBeNull();
    expect(row.probeStartedAt).toBeString();
    expect(findModel(db, "claude/opus")!.model.probeStartedAt).toBeNull();
  });
});
