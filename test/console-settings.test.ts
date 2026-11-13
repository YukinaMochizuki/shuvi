import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedHosts, allowedOrigins } from "../src/console/index.ts";
import { csrfToken, handleConsole, LOGIN_HEADER, SESSION_COOKIE, type ConsoleDeps } from "../src/console/server.ts";
import { FLASH_MAX, FLASH_MS, flashCount, SETTINGS_WRITES } from "../src/console/settings-write.ts";
import { consoleListing, finishListing, getCard, modelsCommand, openConsoleListing } from "../src/control/model-cards.ts";
import { backgroundPass, backgroundSettled } from "../src/server/probes.ts";
import type { Db } from "../src/store/db.ts";
import { ensureChat } from "../src/store/events.ts";
import { addModel, addProvider, findModel, getProvider, listModels, recordProbe } from "../src/store/models.ts";
import { chats, controlCards } from "../src/store/schema.ts";
import { memDb } from "./helpers.ts";

const PORT = 8787;
const HOST = `127.0.0.1:${PORT}`;
const BASE = `http://${HOST}`;
const URL_ = "https://example-host.example-tailnet.ts.net";
const SECRET = "example-csrf-secret";
const LOGIN = "owner@example.com";
const TOKEN = "example-console-token";

const dirs: string[] = [];
let endpoint: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  endpoint?.stop(true);
  endpoint = null;
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "shuvi-settings-"));
  dirs.push(d);
  return d;
};

function deps(db: Db, extra: Partial<ConsoleDeps> = {}): ConsoleDeps {
  const c = { listen: HOST, url: URL_ };
  return { db, timeZone: "UTC", dataDir: "/nonexistent", allowedHosts: allowedHosts(c, PORT), allowedOrigins: allowedOrigins(c, PORT), csrfSecret: SECRET, users: new Set([LOGIN]), ...extra };
}

const CSRF = csrfToken(SECRET, `login:${LOGIN}`);

/** A catalog: a Claude login with the default, an endpoint with two models, three chats (one on vllm/qwen). */
function setup(): Db {
  const db = memDb();
  addProvider(db, { name: "claude", kind: "claude" });
  addModel(db, { provider: "claude", model: "opus", label: "Opus" });
  addProvider(db, { name: "vllm", kind: "openai-compat", baseUrl: "http://127.0.0.1:9/v1", apiKey: "home.VLLM_KEY" });
  addModel(db, { provider: "vllm", model: "qwen", contextWindow: 32_000 });
  addModel(db, { provider: "vllm", model: "llama", contextWindow: 8_000 });
  const book = ensureChat(db, { id: -100777, kind: "group", title: "Example Book Club" });
  ensureChat(db, { id: 1001, kind: "private" });
  ensureChat(db, { id: 1002, kind: "private" });
  db.update(chats).set({ model: "vllm/qwen" }).where(eq(chats.id, book.id)).run();
  return db;
}

async function get(db: Db, path: string, d: Partial<ConsoleDeps> = {}): Promise<string> {
  const res = await handleConsole(deps(db, d), new Request(`${BASE}${path}`, { headers: { [LOGIN_HEADER]: LOGIN } }));
  expect(res.status).toBe(200);
  return res.text();
}

interface PostOpts {
  origin?: string | null;
  csrf?: string | null;
  headers?: Record<string, string>;
  deps?: Partial<ConsoleDeps>;
}
function post(db: Db, path: string, fields: Record<string, string>, o: PostOpts = {}): Promise<Response> {
  const body = new URLSearchParams(fields);
  const csrf = o.csrf === undefined ? CSRF : o.csrf;
  if (csrf !== null) body.set("csrf", csrf);
  const origin = o.origin === undefined ? BASE : o.origin;
  const headers: Record<string, string> = { [LOGIN_HEADER]: LOGIN, "content-type": "application/x-www-form-urlencoded", ...(origin !== null ? { origin } : {}), ...o.headers };
  return handleConsole(deps(db, o.deps), new Request(`${BASE}${path}`, { method: "POST", headers, body }));
}

/** POST, expect the 303 back to /settings, and GET where it leads: the page with the write's note. */
async function write(db: Db, path: string, fields: Record<string, string>): Promise<string> {
  const res = await post(db, path, fields);
  expect(res.status).toBe(303);
  const loc = res.headers.get("location")!;
  expect(loc).toMatch(/^\/settings(\?r=[\w-]+)?(#.*)?$/);
  return get(db, loc.replace(/#.*$/, ""));
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("the Settings page reads the catalog", () => {
  test("providers, models, the default, probes, the chats on each, key references only", async () => {
    const db = setup();
    const qwen = findModel(db, "vllm/qwen")!;
    recordProbe(db, qwen.model.id, { status: "ok", error: null, latencyMs: 412, vision: false });
    const llama = findModel(db, "vllm/llama")!;
    recordProbe(db, llama.model.id, { status: "failed", error: "http: HTTP 402 Insufficient credits", latencyMs: null, vision: null });
    const html = await get(db, "/settings");
    const t = text(html);
    expect(t).not.toContain("Placeholder");
    expect(t).toContain("2 providers3 modelsdefault claude/opus");
    expect(t).toContain("★claude/opusOpus");
    expect(t).toContain("key home.VLLM_KEY");
    expect(t).toContain("probe ok, 412 ms");
    expect(t).toContain("⚠ failed");
    expect(t).toContain("http: HTTP 402 Insufficient credits");
    expect(t).toContain("Own model of Example Book Club");
    expect(t).toContain("The default: 2 chats without a model of their own run on it.");
    // Every form posts to a write route, with this session's token.
    const forms = [...html.matchAll(/<form[^>]* action="([^"]+)"/g)].map((m) => m[1]!);
    // vllm's List models; Make default, Re-probe and Vision for each vllm model; add a model; add a provider.
    expect(forms.length).toBe(9);
    expect(html.match(/<form /g)!.length).toBe(forms.length);
    expect(html.match(/<form [^>]*method="post"/g)!.length).toBe(forms.length);
    for (const a of forms) expect(SETTINGS_WRITES as readonly string[]).toContain(a);
    expect(html.match(/name="csrf" value="([^"]+)"/g)!.length).toBe(forms.length);
    expect(html).toContain(`name="csrf" value="${CSRF}"`);
  });

  test("the page lets a browser send its Origin on the forms' POSTs: its referrer policy is same-origin, never no-referrer", async () => {
    // Under `no-referrer` a browser sends `Origin: null` on a form POST (Fetch, "append a request Origin
    // header"), and every write from this page was refused. Checked in real Chromium when it was found.
    const res = await handleConsole(deps(setup()), new Request(`${BASE}/settings`, { headers: { [LOGIN_HEADER]: LOGIN } }));
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
  });

  test("an empty catalog opens the add-provider form", async () => {
    const db = memDb();
    const t = text(await get(db, "/settings"));
    expect(t).toContain("0 providers0 modelsno default");
    expect(t).toContain("No models. Turns cannot run until the catalog has one");
    expect(await get(db, "/settings")).toContain('<details class="addp" open>');
  });

  test("Remove asks first, naming the chats; on the default (or its provider) it is refused, as the control bot words it", async () => {
    const db = setup();
    let t = text(await get(db, "/settings?remove=model:vllm/qwen"));
    expect(t).toContain("Remove vllm/qwen?");
    expect(t).toContain("Chats on it: Example Book Club. Their next turn fails until they get another model.");
    t = text(await get(db, "/settings?remove=provider:vllm"));
    expect(t).toContain("Remove provider vllm and its 2 models (vllm/qwen, vllm/llama)?");
    expect(t).toContain("Chats on them: Example Book Club.");
    t = text(await get(db, "/settings?remove=model:claude/opus"));
    expect(t).toContain("claude/opus is the default: make another model the default first.");
    expect(t).not.toContain("Remove claude/opus?");
    t = text(await get(db, "/settings?remove=provider:claude"));
    expect(t).toContain("claude/opus is the default model: make a model of another provider the default first.");
    expect(text(await get(db, "/settings?edit=vllm/qwen"))).toContain("Context window");
  });
});

describe("the write routes", () => {
  test("models/default, then the note shows once; the control bot's open /models card is redrawn", async () => {
    const db = setup();
    modelsCommand(db, "test:models", "");
    const card = db.select().from(controlCards).all().at(-1)!;
    expect(card.text).toContain("claude/opus (Opus) ★");
    const res = await post(db, "/settings/models/default", { model: "vllm/qwen" });
    expect(res.status).toBe(303);
    const loc = res.headers.get("location")!;
    expect(loc).toMatch(/#model-vllm%2Fqwen$/);
    expect(findModel(db, "vllm/qwen")!.model.isDefault).toBe(true);
    expect(getCard(db, card.id)!.text).toContain("vllm/qwen ★");
    const page = loc.replace(/#.*$/, "");
    expect(text(await get(db, page))).toContain("vllm/qwen is now the default.");
    expect(text(await get(db, page))).not.toContain("is now the default."); // once
  });

  test("models/add adds and asks for a probe; without a context window it is refused, in the store's words", async () => {
    const db = setup();
    let t = text(await write(db, "/settings/models/add", { provider: "vllm", model: "mistral", context_window: "16384" }));
    expect(t).toContain("Added vllm/mistral (16384 tokens). Probing it.");
    expect(findModel(db, "vllm/mistral")!.model).toMatchObject({ contextWindow: 16384, probeStatus: "checking" });
    expect(t).toContain("probe checking…");
    t = text(await write(db, "/settings/models/add", { provider: "vllm", model: "nolen", context_window: "" }));
    expect(t).toContain("Could not add vllm/nolen: an OpenAI-compatible model needs its context window");
    expect(findModel(db, "vllm/nolen")).toBeUndefined();
    t = text(await write(db, "/settings/models/add", { provider: "vllm", model: "x", context_window: "lots" }));
    expect(t).toContain('The context window is a number of tokens, not "lots".');
    t = text(await write(db, "/settings/models/add", { provider: "claude", model: "sonnet", context_window: "" }));
    expect(t).toContain("Added claude/sonnet.");
    expect(t).not.toContain("Probing it");
  });

  test("models/probe asks for a probe of an OpenAI-compatible model only", async () => {
    const db = setup();
    expect(text(await write(db, "/settings/models/probe", { model: "vllm/llama" }))).toContain("Probing vllm/llama.");
    expect(findModel(db, "vllm/llama")!.model.probeStatus).toBe("checking");
    expect(text(await write(db, "/settings/models/probe", { model: "claude/opus" }))).toContain("claude/opus is not probed: only an OpenAI-compatible model is.");
    expect(text(await write(db, "/settings/models/probe", { model: "vllm/gone" }))).toContain("There is no model vllm/gone in the catalog.");
  });

  test("models/vision: on and off are the owner's (a probe no longer changes them), auto follows the probe again", async () => {
    const db = setup();
    const id = findModel(db, "vllm/qwen")!.model.id;
    recordProbe(db, id, { status: "ok", error: null, latencyMs: 1, vision: false });
    expect(text(await write(db, "/settings/models/vision", { model: "vllm/qwen", vision: "on" }))).toContain("vllm/qwen: vision on, set by you.");
    expect(findModel(db, "vllm/qwen")!.model).toMatchObject({ vision: true, visionSet: true });
    recordProbe(db, id, { status: "ok", error: null, latencyMs: 1, vision: false });
    expect(findModel(db, "vllm/qwen")!.model.vision).toBe(true);
    await write(db, "/settings/models/vision", { model: "vllm/qwen", vision: "off" });
    expect(findModel(db, "vllm/qwen")!.model).toMatchObject({ vision: false, visionSet: true });
    await write(db, "/settings/models/vision", { model: "vllm/qwen", vision: "on" });
    expect(text(await write(db, "/settings/models/vision", { model: "vllm/qwen", vision: "auto" }))).toContain("vllm/qwen: vision follows the probe (off now).");
    expect(findModel(db, "vllm/qwen")!.model).toMatchObject({ vision: false, visionSet: false });
    expect(text(await write(db, "/settings/models/vision", { model: "vllm/qwen", vision: "maybe" }))).toContain('Vision is on, off or auto, not "maybe".');
  });

  test("models/edit: label and context window; a context window is required for an endpoint's model", async () => {
    const db = setup();
    expect(text(await write(db, "/settings/models/edit", { model: "vllm/qwen", label: "  Qwen (home)  ", context_window: "40000" }))).toContain("Saved vllm/qwen (Qwen (home)): 40000 tokens.");
    expect(findModel(db, "vllm/qwen")!.model).toMatchObject({ label: "Qwen (home)", contextWindow: 40000 });
    expect(text(await write(db, "/settings/models/edit", { model: "vllm/qwen", label: "", context_window: "" }))).toContain("Could not save vllm/qwen: an OpenAI-compatible model needs its context window");
    expect(findModel(db, "vllm/qwen")!.model.label).toBe("Qwen (home)");
    await write(db, "/settings/models/edit", { model: "claude/opus", label: "" });
    expect(findModel(db, "claude/opus")!.model.label).toBeNull();
    expect(text(await write(db, "/settings/models/edit", { model: "claude/opus", label: "x".repeat(61) }))).toContain("a label is at most 60 characters");
  });

  test("models/remove removes; the default is refused", async () => {
    const db = setup();
    expect(text(await write(db, "/settings/models/remove", { model: "vllm/qwen" }))).toContain("Removed vllm/qwen.");
    expect(findModel(db, "vllm/qwen")).toBeUndefined();
    expect(text(await write(db, "/settings/models/remove", { model: "claude/opus" }))).toContain("claude/opus is the default: make another model the default first.");
    expect(findModel(db, "claude/opus")).toBeDefined();
  });

  test("providers/remove removes it and its models; one holding the default is refused", async () => {
    const db = setup();
    expect(text(await write(db, "/settings/providers/remove", { provider: "claude" }))).toContain("claude/opus is the default model: make a model of another provider the default first.");
    expect(getProvider(db, "claude")).toBeDefined();
    expect(text(await write(db, "/settings/providers/remove", { provider: "vllm" }))).toContain("Removed provider vllm and its 2 models (vllm/qwen, vllm/llama).");
    expect(getProvider(db, "vllm")).toBeUndefined();
    expect(text(await write(db, "/settings/providers/remove", { provider: "vllm" }))).toContain("There is no provider vllm.");
  });

  test("providers/add: a Claude login; a bad one is refused and the form keeps what was typed", async () => {
    const db = setup();
    expect(text(await write(db, "/settings/providers/add", { name: "work", kind: "claude", config_dir: "/home/example/.claude-work" }))).toContain("Added Claude login work (/home/example/.claude-work).");
    expect(getProvider(db, "work")).toMatchObject({ kind: "claude", configDir: "/home/example/.claude-work" });
    const html = await write(db, "/settings/providers/add", { name: "lab", kind: "openai-compat", base_url: "ftp://example.net", api_key: "lab.KEY" });
    expect(text(html)).toContain("Could not add provider lab: the base URL must be http(s)");
    expect(html).toContain('value="ftp://example.net"');
    expect(html).toContain('<details class="addp" open>');
    expect(text(await write(db, "/settings/providers/add", { name: "lab", kind: "openai-compat", base_url: "http://x.example/v1", api_key: "sk-not-a-reference" }))).toContain("the key is named as <secrets profile>.<VARIABLE>, not given itself");
    expect(getProvider(db, "lab")).toBeUndefined();
  });
});

// ---- a fake OpenAI-compatible endpoint: its /models, and Chat Completions answering the probe ---------------
const sse = (chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const chunk = (delta: unknown, finish: string | null = null) => ({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] });

function fakeEndpoint(o: { refuse?: boolean } = {}): string {
  endpoint = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (o.refuse) return Response.json({ error: { message: "invalid bearer token" } }, { status: 401 });
      if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "qwen3", max_model_len: 32768 }, { id: "nolen" }] });
      const body = (await req.json()) as { tools?: unknown[] };
      if (!body.tools) return Response.json({ error: { message: "this model does not support image input" } }, { status: 400 });
      return sse([chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "ping", arguments: "{}" } }] }), chunk({}, "tool_calls")]);
    },
  });
  return `http://127.0.0.1:${endpoint.port}/v1`;
}

function secrets(): string {
  const f = join(tmp(), "secrets.yaml");
  writeFileSync(f, "lab:\n  LAB_KEY: sk-example-not-real\n", { mode: 0o600 });
  return f;
}

describe("adding a provider lists its models through the server's background pass", () => {
  test("listing, listed, Add (with the listed context window, or one typed in), probes, Done", async () => {
    const db = setup();
    const url = fakeEndpoint();
    const secretsFile = secrets();
    let html = await write(db, "/settings/providers/add", { name: "lab", kind: "openai-compat", base_url: url, api_key: "lab.LAB_KEY" });
    expect(text(html)).toContain("Added provider lab. Listing its models…");
    expect(text(html)).toContain("Listing the models of lab");
    const l = consoleListing(db)!;
    expect(l).toMatchObject({ provider: "lab", state: "listing" });
    expect(getCard(db, l.cardId)!.idemKey).toStartWith("console-listing:");
    // The same pass that serves the control bot's cards.
    expect(backgroundPass(db, { secretsFile })).toBe(1);
    await backgroundSettled();
    html = await get(db, "/settings");
    expect(text(html)).toContain("lists 2 models. ✓ = in the catalog.");
    expect(text(html)).toContain("no context length listed");

    html = await write(db, "/settings/listings/add", { card: String(l.cardId), index: "0" });
    expect(text(html)).toContain("Added lab/qwen3 (32768 tokens); probing it.");
    expect(text(html)).toContain("✓ in the catalog");
    html = await write(db, "/settings/listings/add", { card: String(l.cardId), index: "1", context_window: "8192" });
    expect(text(html)).toContain("Added lab/nolen (8192 tokens); probing it.");
    expect(findModel(db, "lab/nolen")!.model).toMatchObject({ contextWindow: 8192, probeStatus: "checking" });
    expect(text(await write(db, "/settings/listings/add", { card: String(l.cardId), index: "0" }))).toContain("lab/qwen3 is already in the catalog.");
    expect(text(await write(db, "/settings/listings/add", { card: String(l.cardId), index: "7" }))).toContain("That listing is closed");

    expect(backgroundPass(db, { secretsFile })).toBe(2);
    await backgroundSettled();
    expect(findModel(db, "lab/qwen3")!.model.probeStatus).toBe("ok");
    expect(text(await get(db, "/settings"))).toContain("probe ok,");

    await write(db, "/settings/listings/close", { card: String(l.cardId) });
    expect(consoleListing(db)).toBeUndefined();
    expect(getCard(db, l.cardId)!.status).toBe("closed");
    expect(text(await get(db, "/settings"))).not.toContain("lists 2 models");
  });

  test("Cancel while listing closes the card and the provider stays; List again opens a new listing", async () => {
    const db = setup();
    await write(db, "/settings/providers/add", { name: "lab", kind: "openai-compat", base_url: "http://127.0.0.1:9/v1" });
    const first = consoleListing(db)!;
    await write(db, "/settings/listings/close", { card: String(first.cardId) });
    expect(consoleListing(db)).toBeUndefined();
    expect(getProvider(db, "lab")).toBeDefined();
    expect(backgroundPass(db, { secretsFile: secrets() })).toBe(0);
    await write(db, "/settings/providers/list", { provider: "lab" });
    expect(consoleListing(db)).toMatchObject({ provider: "lab", state: "listing" });
    expect(consoleListing(db)!.cardId).not.toBe(first.cardId);
    expect(text(await write(db, "/settings/providers/list", { provider: "claude" }))).toContain("claude is a Claude login: it has no /models to list.");
  });

  test("a failed listing says why until it is dismissed; the provider stays", async () => {
    const db = setup();
    const url = fakeEndpoint({ refuse: true });
    await write(db, "/settings/providers/add", { name: "lab", kind: "openai-compat", base_url: url, api_key: "lab.LAB_KEY" });
    backgroundPass(db, { secretsFile: secrets() });
    await backgroundSettled();
    const l = consoleListing(db)!;
    expect(l.state).toBe("failed");
    const t = text(await get(db, "/settings"));
    expect(t).toContain("Listing the models of lab");
    expect(t).toContain("failed:");
    expect(t).toContain("401");
    expect(t).not.toContain("sk-example-not-real");
    await write(db, "/settings/listings/close", { card: String(l.cardId) });
    expect(consoleListing(db)).toBeUndefined();
    expect(getProvider(db, "lab")).toBeDefined();
  });
});

describe("the write boundary", () => {
  const before = (db: Db) => JSON.stringify(listModels(db).map((m) => [m.id, m.model.isDefault]));

  test("a missing, null or foreign Origin is refused with 403, and nothing changes", async () => {
    const db = setup();
    const was = before(db);
    for (const origin of [null, "null", "https://evil.example", "http://127.0.0.1:9999", "https://example-host.example-tailnet.ts.net.evil.example"]) {
      const res = await post(db, "/settings/models/default", { model: "vllm/qwen" }, { origin });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("did not come from the console");
    }
    expect(before(db)).toBe(was);
    // The console's own origins: the public URL's, and the loopback ones of its port.
    for (const origin of [URL_, BASE, `http://localhost:${PORT}`]) expect((await post(db, "/settings/models/probe", { model: "vllm/qwen" }, { origin })).status).toBe(303);
  });

  test("with no allowed origins configured, every write is refused", async () => {
    const db = setup();
    expect((await post(db, "/settings/models/default", { model: "vllm/qwen" }, { deps: { allowedOrigins: undefined } })).status).toBe(403);
  });

  test("a missing or wrong CSRF token is refused with 403, and nothing changes", async () => {
    const db = setup();
    const was = before(db);
    for (const csrf of [null, "", "nope", csrfToken(SECRET, "login:someone@example.com"), csrfToken("another-secret", `login:${LOGIN}`)]) {
      const res = await post(db, "/settings/models/default", { model: "vllm/qwen" }, { csrf });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("no valid token");
    }
    expect(before(db)).toBe(was);
  });

  test("token sign-in: the token is the session cookie's, so another session's does not do", async () => {
    const db = setup();
    const d: Partial<ConsoleDeps> = { users: undefined, token: TOKEN };
    const login = await handleConsole(deps(db, d), new Request(`${BASE}/login`, { method: "POST", body: new URLSearchParams({ token: TOKEN }) }));
    const cookie = /shuvi_console=([^;]+)/.exec(login.headers.get("set-cookie")!)![1]!;
    const headers = { cookie: `${SESSION_COOKIE}=${cookie}` };
    const page = await handleConsole(deps(db, d), new Request(`${BASE}/settings`, { headers }));
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
    expect(csrf).toBe(csrfToken(SECRET, `cookie:${cookie}`));
    expect((await post(db, "/settings/models/probe", { model: "vllm/qwen" }, { csrf: CSRF, headers, deps: d })).status).toBe(403);
    expect((await post(db, "/settings/models/probe", { model: "vllm/qwen" }, { csrf, headers, deps: d })).status).toBe(303);
    // Not signed in: the sign-in, before any token is looked at.
    expect((await post(db, "/settings/models/probe", { model: "vllm/qwen" }, { csrf, headers: {}, deps: d })).status).toBe(401);
    // A script with the bearer token reads its token from the page too.
    const bearer = { authorization: `Bearer ${TOKEN}` };
    expect((await post(db, "/settings/models/probe", { model: "vllm/qwen" }, { csrf: csrfToken(SECRET, "bearer"), headers: bearer, deps: d })).status).toBe(303);
  });

  test("a login not on the list is refused before anything else", async () => {
    const db = setup();
    expect((await post(db, "/settings/models/default", { model: "vllm/qwen" }, { headers: { [LOGIN_HEADER]: "someone@example.com" } })).status).toBe(403);
    expect(findModel(db, "vllm/qwen")!.model.isDefault).toBe(false);
  });

  test("a write route answers POST only: a GET or HEAD gets 405", async () => {
    const db = setup();
    for (const path of SETTINGS_WRITES) {
      for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
        const res = await handleConsole(deps(db), new Request(`${BASE}${path}`, { method, headers: { [LOGIN_HEADER]: LOGIN, origin: BASE } }));
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("POST");
      }
    }
  });

  test("every read-only page still refuses POST, /settings itself and paths beside the write routes included", async () => {
    const db = setup();
    for (const path of ["/turns", "/settings", "/settings/models", "/settings/models/rename", "/settings/models/default/x", "/chats/1", "/turns/1", "/media", "/"]) {
      const res = await post(db, path, { model: "vllm/qwen" });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
    }
    expect(findModel(db, "vllm/qwen")!.model.isDefault).toBe(false);
  });

  test("a misdirected Host is refused before the write is looked at", async () => {
    const db = setup();
    const res = await post(db, "/settings/models/default", { model: "vllm/qwen" }, { headers: { host: "evil.example" } });
    expect(res.status).toBe(421);
  });
});

describe("review fixes", () => {
  test("B1: a non-ASCII model id: every write answers its 303, with a percent-encoded fragment that is the row's id", async () => {
    const db = setup();
    addModel(db, { provider: "vllm", model: "qwen-日本", contextWindow: 10 });
    const id = "vllm/qwen-日本";
    const frag = `#model-${encodeURIComponent(id)}`;
    const cases: [string, Record<string, string>][] = [
      ["/settings/models/default", { model: id }],
      ["/settings/models/probe", { model: id }],
      ["/settings/models/vision", { model: id, vision: "on" }],
      ["/settings/models/edit", { model: id, label: "日本語のラベル", context_window: "4096" }],
      ["/settings/models/add", { provider: "vllm", model: "llama-ελληνικά", context_window: "2048" }],
    ];
    for (const [path, fields] of cases) {
      const res = await post(db, path, fields);
      expect(res.status).toBe(303);
      const loc = res.headers.get("location")!;
      expect(loc).toMatch(/^[\x21-\x7e]+$/); // printable ASCII only
      expect(loc.endsWith(path === "/settings/models/add" ? `#model-${encodeURIComponent("vllm/llama-ελληνικά")}` : frag)).toBe(true);
    }
    expect(findModel(db, id)!.model).toMatchObject({ isDefault: true, probeStatus: "checking", vision: true, visionSet: true, label: "日本語のラベル", contextWindow: 4096 });
    expect(findModel(db, "vllm/llama-ελληνικά")).toBeDefined();
    // The page's own anchors are encoded the same way, so the fragment lands on the row.
    const html = await get(db, "/settings");
    expect(html).toContain(`id="${frag.slice(1)}"`);
    expect(html).toContain(`${frag}">Edit</a>`);
    expect(html).not.toMatch(/(href|id)="[^"]*model-vllm\/qwen-日本/);
  });

  test("S2: a key pasted into the key reference is never shown back, nor kept in the flash", async () => {
    const db = setup();
    const key = "sk-REALSECRET123";
    const res = await post(db, "/settings/providers/add", { name: "lab", kind: "openai-compat", base_url: "http://x.example/v1", api_key: key });
    const html = await get(db, res.headers.get("location")!.replace(/#.*$/, ""));
    expect(text(html)).toContain("Could not add provider lab: the key is named as <secrets profile>.<VARIABLE>, not given itself");
    expect(html).not.toContain(key);
    expect(html).toContain('value="http://x.example/v1"'); // the rest of the form is kept
    // Nor a base URL with credentials in it.
    const res2 = await post(db, "/settings/providers/add", { name: "lab", kind: "openai-compat", base_url: "http://u:sk-PASSWORD9@x.example/v1", api_key: key });
    const html2 = await get(db, res2.headers.get("location")!.replace(/#.*$/, ""));
    expect(html2).not.toContain("sk-PASSWORD9");
    expect(html2).not.toContain(key);
    // The store's own words (the control bot replies with them too) never quote it.
    expect(() => addProvider(db, { name: "x", kind: "openai-compat", baseUrl: "https://example/v1", apiKey: key })).toThrow("the key is named as <secrets profile>.<VARIABLE>, not given itself");
  });

  test("S3: hostile model ids, listing errors and labels come out escaped", async () => {
    const db = setup();
    // A listing that names models like markup; under /deny/, one that fails with markup in its body.
    endpoint = Bun.serve({
      port: 0,
      fetch: (req) =>
        !new URL(req.url).pathname.startsWith("/deny/")
          ? Response.json({ data: [{ id: "<img src=x onerror=1>" }, { id: 'q"><script>alert(1)</script>', max_model_len: 1 }] })
          : Response.json({ error: { message: '"><script>alert(2)</script>' } }, { status: 401 }),
    });
    const base = `http://127.0.0.1:${endpoint.port}`;
    await write(db, "/settings/providers/add", { name: "lab", kind: "openai-compat", base_url: `${base}/v1` });
    backgroundPass(db, { secretsFile: secrets() });
    await backgroundSettled();
    let html = await get(db, "/settings");
    expect(consoleListing(db)!.state).toBe("listed");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
    expect(html).toContain("q&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");

    // A listing that fails with markup in its error: whatever of it is shown is escaped.
    const fail = openConsoleListing(db, "lab", "hostile-error")!;
    finishListing(db, fail.id, { error: 'http: 401 "><script>alert(3)</script>' });
    html = await get(db, "/settings");
    expect(consoleListing(db)!.state).toBe("failed");
    expect(html).not.toContain("<script>");
    expect(html).toContain("http: 401 &quot;&gt;&lt;script&gt;alert(3)&lt;/script&gt;");
    // And one that failed against the endpoint's own hostile body.
    await write(db, "/settings/providers/add", { name: "deny", kind: "openai-compat", base_url: `${base}/deny/v1` });
    backgroundPass(db, { secretsFile: secrets() });
    await backgroundSettled();
    expect(consoleListing(db)).toMatchObject({ provider: "deny", state: "failed" });
    expect(await get(db, "/settings")).not.toContain("<script>");

    // A label with quotes and markup, in the row and in the edit form's value.
    await write(db, "/settings/models/edit", { model: "vllm/qwen", label: `Q "dq" 'sq' <b>x</b>`, context_window: "32000" });
    html = await get(db, "/settings?edit=vllm/qwen");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain(`<span class="label">Q &quot;dq&quot; &#39;sq&#39; &lt;b&gt;x&lt;/b&gt;</span>`);
    expect(html).toContain(`name="label" value="Q &quot;dq&quot; &#39;sq&#39; &lt;b&gt;x&lt;/b&gt;"`);
  });

  test("S4: flashes are swept on every write and capped, however many redirects are never followed", async () => {
    const db = setup();
    const T = Date.now() + 365 * 24 * 3600_000; // past every flash the other tests left
    const at = (now: number) => ({ deps: { now: () => now } });
    expect((await post(db, "/settings/models/probe", { model: "vllm/qwen" }, at(T))).status).toBe(303);
    expect(flashCount()).toBe(1);
    for (let i = 0; i < FLASH_MAX + 50; i++) await post(db, "/settings/models/probe", { model: "vllm/qwen" }, at(T));
    expect(flashCount()).toBe(FLASH_MAX);
    await post(db, "/settings/models/probe", { model: "vllm/qwen" }, at(T + FLASH_MS + 1));
    expect(flashCount()).toBe(1);
  });

  test("N5: a Claude model's context window is the CLI's: refused on add, from the console and the control bot alike", async () => {
    const db = setup();
    expect(() => addModel(db, { provider: "claude", model: "sonnet", contextWindow: 200_000 })).toThrow("a Claude model's context window is the CLI's");
    expect(text(await write(db, "/settings/models/add", { provider: "claude", model: "sonnet", context_window: "200000" }))).toContain("Could not add claude/sonnet: a Claude model's context window is the CLI's");
    expect(findModel(db, "claude/sonnet")).toBeUndefined();
    modelsCommand(db, "test:n5", "add claude/sonnet 200000");
    const reply = db.$client.query("select text from control_messages where idem_key = 'test:n5'").get() as { text: string } | null;
    expect(reply?.text).toBe("Could not add claude/sonnet: a Claude model's context window is the CLI's");
    expect(findModel(db, "claude/sonnet")).toBeUndefined();
  });
});
