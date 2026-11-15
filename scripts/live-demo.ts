#!/usr/bin/env bun
/**
 * The console's live pages in a real browser, by hand (not CI: it needs a local Chromium, `CHROME_PATH` or
 * `chromium` on PATH). The world is the e2e fakes (fake Telegram, fake Anthropic, fake porchkit and Hangar) around
 * a real server and runner child; the browser is driven over the Chrome DevTools Protocol, no library.
 *
 *   bun scripts/live-demo.ts series [shots dir]   a turn unfolding (screenshots of each state), scrolled up ("↓ N
 *                                                 new"), the server killed mid-turn and restarted, deleting and
 *                                                 undoing, a boosted navigation to the chat's log with its window
 *                                                 sliding (over 200 events), a picture arriving after its turn,
 *                                                 the per-session cap ("paused · Resume"), a newer segment on
 *                                                 /turns ("New activity · Show"), a phone width, the sign-in
 *                                                 ending ("Live updates stopped"). After each step the live page
 *                                                 must show what a reload shows, without having reloaded.
 *   bun scripts/live-demo.ts idle [minutes]        a live page left open with nothing happening: the server's RSS,
 *   bun scripts/live-demo.ts nopage [minutes]      descriptors, threads and CPU every 30 s (nopage: on Settings, the
 *                                                 baseline).
 *
 * Exit 1 if a check failed. Screenshots go to the shots dir (default: a fresh temp dir, printed).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_STREAMS_PER_SESSION } from "../src/console/live.ts";
import { openDb } from "../src/store/db.ts";
import { enqueueOutbound, ensureChat, markSent, recordInbound } from "../src/store/events.ts";
import { claimTurn, finishTurn } from "../src/store/turns.ts";
import { FakeHangar } from "../test/fake-hangar.ts";
import { FakePorchkit } from "../test/fake-porchkit.ts";
import { dmUpdate, FakeTelegram, OWNER } from "../test/helpers.ts";

// What the page functions below see (they run in the browser, sent as their source).
declare const document: any, window: any, location: any, performance: any, innerHeight: number, DOMParser: any, EventSource: any;

const MODE = process.argv[2] ?? "series";
const SHOTS = MODE === "series" ? (process.argv[3] ?? mkdtempSync(join(tmpdir(), "shuvi-live-shots-"))) : "";
const t0 = Date.now();
const log = (m: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const results: string[] = [];
const check = (cond: unknown, m: string) => {
  results.push(`${cond ? "ok  " : "FAIL"} ${m}`);
  log(`${cond ? "ok  " : "FAIL"} ${m}`);
};
async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 60_000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await Bun.sleep(100);
  }
}

// ---- a browser, over the DevTools protocol ---------------------------------------------------------------

class Page {
  private id = 0;
  private waiting = new Map<number, { ok: (v: any) => void; no: (e: Error) => void }>();
  private handlers: Array<(method: string, params: any) => void> = [];
  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (m) => {
      const msg = JSON.parse(String(m.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown };
      if (msg.id !== undefined) {
        const w = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        if (msg.error) w?.no(new Error(msg.error.message));
        else w?.ok(msg.result);
      } else if (msg.method) for (const h of this.handlers) h(msg.method, msg.params);
    });
  }

  static async open(url: string): Promise<Page> {
    const ws = new WebSocket(url);
    await new Promise((ok, no) => {
      ws.addEventListener("open", ok, { once: true });
      ws.addEventListener("error", no, { once: true });
    });
    const p = new Page(ws);
    await p.send("Page.enable");
    await p.send("Runtime.enable");
    await p.send("Log.enable");
    p.on((method, params) => {
      if (method === "Log.entryAdded" && params.entry.level === "error") log(`browser: ${params.entry.text}`);
      if (method === "Runtime.exceptionThrown") log(`browser exception: ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`);
    });
    return p;
  }

  send(method: string, params: object = {}): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((ok, no) => this.waiting.set(id, { ok, no }));
  }

  on(h: (method: string, params: any) => void): void {
    this.handlers.push(h);
  }

  private next(method: string): Promise<void> {
    return new Promise((ok) => {
      const h = (m: string) => {
        if (m !== method) return;
        this.handlers = this.handlers.filter((x) => x !== h);
        ok();
      };
      this.handlers.push(h);
    });
  }

  async goto(url: string): Promise<void> {
    const loaded = this.next("Page.loadEventFired");
    await this.send("Page.navigate", { url });
    await loaded;
  }

  /** Wait for the next load (a form posted, a reload). */
  loaded(): Promise<void> {
    return this.next("Page.loadEventFired");
  }

  async evaluate<T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression: `(${fn.toString()})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`in the page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }

  async screenshot(path: string): Promise<void> {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(r.data as string, "base64"));
  }

  setViewport(width: number, height: number): Promise<void> {
    return this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  }

  click(selector: string): Promise<void> {
    return this.evaluate((s) => document.querySelector(s).click(), selector);
  }

  close(): void {
    this.ws.close();
  }
}

async function launch(): Promise<{ page: Page; stop: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "shuvi-live-chrome-"));
  const chrome = Bun.spawn([process.env.CHROME_PATH ?? "chromium", "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "about:blank"], {
    stdout: "ignore",
    stderr: "pipe",
  });
  let port = 0;
  const dec = new TextDecoder();
  const reader = chrome.stderr.getReader();
  let buf = "";
  while (!port) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`chromium exited: ${buf}`);
    buf += dec.decode(value);
    port = Number(/DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(buf)?.[1] ?? 0);
  }
  void (async () => {
    while (!(await reader.read()).done);
  })();
  // Its first page shows up a moment after the browser listens.
  let target: { type: string; webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 50 && !target; i++) {
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    target = targets.find((t) => t.type === "page");
    if (!target) await Bun.sleep(100);
  }
  if (!target) throw new Error("chromium opened no page");
  const page = await Page.open(target.webSocketDebuggerUrl);
  return {
    page,
    stop: () => {
      page.close();
      chrome.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---- fake Anthropic: think, say something, then a slow video_probe; after its result, the answer --------------

const VIDEO = "https://www.youtube.com/watch?v=abc123def45";
type Block = { type: string; text?: string };
type Msg = { role: string; content: string | Block[] };
const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
type Out = { type: "text"; text: string } | { type: "thinking"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };
function stream(id: string, blocks: Out[], stop: string): Response {
  let out = ev("message_start", { message: { id, type: "message", role: "assistant", model: "claude-fake", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1 } } });
  blocks.forEach((b, index) => {
    if (b.type === "thinking") {
      out += ev("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } });
      out += ev("content_block_delta", { index, delta: { type: "thinking_delta", thinking: b.text } });
      out += ev("content_block_delta", { index, delta: { type: "signature_delta", signature: "sig-fake" } });
    } else if (b.type === "text") {
      out += ev("content_block_start", { index, content_block: { type: "text", text: "" } });
      out += ev("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
    } else {
      out += ev("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      out += ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    out += ev("content_block_stop", { index });
  });
  out += ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 42 } });
  out += ev("message_stop", {});
  return new Response(out, { headers: { "content-type": "text/event-stream" } });
}
let n = 0;
const anthropic = Bun.serve({
  port: 0,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as { messages?: Msg[]; tools?: Array<{ name: string }> }) : {};
    if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 10 });
    if (!url.pathname.endsWith("/v1/messages")) return Response.json({});
    if (!body.tools?.some((t) => t.name === "mcp__shuvi__say")) return stream("msg_side", [{ type: "text", text: "ok" }], "end_turn");
    n++;
    const last = body.messages?.at(-1);
    const blocks = Array.isArray(last?.content) ? (last!.content as Block[]) : [];
    const latest = JSON.stringify(last ?? "");
    if (blocks.some((b) => b.type === "tool_result")) {
      await Bun.sleep(2500);
      return stream(`msg_${n}`, [{ type: "thinking", text: "The probe says it is a five-minute clip; answer with the train." }, { type: "text", text: "It is a five-minute clip about trains: the 9:15 is the one in it." }], "end_turn");
    }
    if (latest.includes("hello there")) return stream(`msg_${n}`, [{ type: "text", text: "Hi! What can I do?" }], "end_turn");
    if (latest.includes("here is a photo")) return stream(`msg_${n}`, [{ type: "text", text: "I will look once it is here." }], "end_turn");
    await Bun.sleep(1500);
    return stream(
      `msg_${n}`,
      [
        { type: "thinking", text: "The owner asks about the trains in that clip. Look at the video first, then answer." },
        { type: "text", text: "Let me look at that video first." },
        { type: "tool_use", id: `toolu_${n}`, name: "mcp__shuvi__video_probe", input: { url: VIDEO } },
      ],
      "tool_use",
    );
  },
});

// ---- the world ---------------------------------------------------------------------------------------------

const PORT = Number(process.env.LIVE_DEMO_PORT ?? 8790);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "live-demo-token-0123456789";
const tg = new FakeTelegram();
// In front of the fake Bot API: a picture's download takes 8 s, so it arrives after its (short) turn has ended.
const slowFiles = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname.startsWith("/file/")) await Bun.sleep(8000);
    return fetch(`${tg.apiRoot}${u.pathname}${u.search}`, { method: req.method, headers: { "content-type": req.headers.get("content-type") ?? "" }, ...(req.method === "GET" ? {} : { body: await req.arrayBuffer() }) });
  },
});
const porch = new FakePorchkit();
porch.probeDelayMs = 7000; // the slow tool call
const hangar = new FakeHangar();
const dataDir = mkdtempSync(join(tmpdir(), "shuvi-live-"));
mkdirSync(join(dataDir, "home"), { recursive: true });
const env = {
  ...process.env,
  SHUVI_DATA_DIR: dataDir,
  SHUVI_BOT_TOKEN: "TOKEN",
  SHUVI_OWNER_ID: String(OWNER),
  SHUVI_TELEGRAM_API_ROOT: `http://127.0.0.1:${slowFiles.port}`,
  SHUVI_MODEL: "claude-sonnet-4-5",
  SHUVI_TZ: "Asia/Taipei",
  SHUVI_WEB: "off",
  SHUVI_VISION_WAIT_MS: "300",
  ...hangar.env(),
  ...porch.env(),
  SHUVI_SECRETS_FILE: join(dataDir, "no-secrets.yaml"),
  SHUVI_CONSOLE_LISTEN: `127.0.0.1:${PORT}`,
  SHUVI_CONSOLE_TOKEN: TOKEN,
  ANTHROPIC_BASE_URL: `http://localhost:${anthropic.port}`,
  ANTHROPIC_API_KEY: "sk-ant-fake",
};
let server: ReturnType<typeof Bun.spawn> | null = null;
let serverOut = "";
/** Every server's output, kept for the end (written beside the screenshots). */
let serverLog = "";
function startServer() {
  serverOut = "";
  server = Bun.spawn([process.execPath, "src/server/main.ts"], { cwd: join(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe", detached: true });
  for (const s of [server.stdout, server.stderr] as ReadableStream<Uint8Array>[]) {
    void (async () => {
      const dec = new TextDecoder();
      for await (const c of s) {
        const t = dec.decode(c);
        serverOut += t;
        serverLog += t;
      }
    })();
  }
}
function killServer() {
  try {
    process.kill(-server!.pid, "SIGKILL");
  } catch {}
}
// However the script ends, its server (and the runner children in its group) goes with it.
process.on("exit", killServer);
const db = openDb(join(dataDir, "shuvi.db"));
const q = <T>(s: string, ...a: unknown[]) => db.$client.query(s).get(...(a as never[])) as T;
const lastTurn = () => q<{ id: number; status: string; chatId: number } | null>("select id, status, chat_id as chatId from turns order by id desc limit 1");
const idle = () => q<{ n: number }>("select count(*) as n from turns where status = 'running'").n === 0 && q<{ n: number }>("select count(*) as n from chat_events where status = 'pending'").n === 0;
let update = 1;
const say = (text: string) => tg.updates.push(dmUpdate(update++, text));
const turnDone = (after: number) => () => lastTurn()!.id > after && lastTurn()!.status === "done" && idle();

startServer();
await until("the console", () => serverOut.includes("console: listening"), 30_000);
log("server up");
const { page, stop } = await launch();
await page.setViewport(1280, 820);
await page.goto(`${BASE}/login`);
const signedIn = page.loaded();
await page.evaluate((token) => {
  document.querySelector('input[name="token"]').value = token;
  document.querySelector("form").submit();
}, TOKEN);
await signedIn;
log(`signed in: ${await page.evaluate(() => location.href)}`);

let shot = 0;
async function snap(label: string) {
  const f = join(SHOTS, `${String(++shot).padStart(2, "0")}-${label}.png`);
  await page.screenshot(f);
  log(`shot ${f}`);
}

/** What the detail shows, in a few words: a new value is a new screenshot. */
const state = () =>
  page.evaluate(() => {
    const d = document.querySelector(".detail-pane");
    const tools = [...d.querySelectorAll("details.step.tool")];
    return JSON.stringify({
      turns: d.querySelectorAll(".tdiv").length,
      bubbles: d.querySelectorAll(".bubble").length,
      thinking: d.querySelectorAll("details.step.thinking").length,
      running: tools.filter((t: any) => t.querySelector(".word.c-running")).length,
      done: tools.filter((t: any) => !t.querySelector(".word")).length,
      pending: d.querySelectorAll(".status.c-running").length,
      delivered: d.querySelectorAll(".status.c-done").length,
      badge: d.querySelector(".head .badge")?.textContent,
    });
  });

let firstTurn = 0;
async function filmUntil(prefix: string, done: () => boolean, ms = 90_000) {
  let prev = "";
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await state();
    if (s !== prev) {
      prev = s;
      log(`state ${s}`);
      await snap(prefix);
    }
    // The reader opens the new turn's first thinking line while it runs: it must stay open, the same node.
    await page.evaluate((first) => {
      const d = [...document.querySelectorAll(`.detail-pane .lb:not([data-k="t${first}"]) details.step.thinking`)][0];
      if (d && !window.__opened) {
        d.open = true;
        window.__opened = d;
      }
    }, firstTurn);
    if (done()) {
      await Bun.sleep(2500);
      const s2 = await state();
      if (s2 !== prev) {
        log(`state ${s2}`);
        await snap(prefix);
      }
      return;
    }
    await Bun.sleep(150);
  }
  throw new Error("filming timed out");
}

/**
 * The detail as live and as a fresh load draws it: the same (a chat's log: the reload's rows are the live page's last
 * ones, since a live log keeps what slid off its window as history), every part on the page once.
 */
async function sameAsReload(what: string, tail = false) {
  const r = await page.evaluate(async (tail) => {
    const rows = (root: any) => {
      const out: string[] = [];
      for (const row of root?.querySelectorAll(".trace > .lb > *, .convo > .lb > *") ?? []) {
        const c = row.cloneNode(true);
        for (const x of c.querySelectorAll("noscript")) x.remove();
        // Deleted, waiting out its undo: hidden on the page (style.css), not in a reload.
        if (row.matches(".pickable.gone, .pill.gone, .tr:has(> .body > .pickable.gone):not(:has(> .body > .pickable:not(.gone)))") || row.querySelector(":scope > .pickable.gone")) continue;
        out.push(`${c.textContent.replace(/\s+/g, " ").trim()}|${c.querySelectorAll("img").length}`);
      }
      return out;
    };
    const live = rows(document.querySelector(".detail-pane"));
    const html = await (await fetch(location.href, { credentials: "same-origin" })).text();
    const fresh = rows(new DOMParser().parseFromString(html, "text/html").querySelector(".detail-pane"));
    const keys = [...document.querySelectorAll(".lb[data-k]")].map((p: any) => p.dataset.k);
    const unique = new Set(keys).size === keys.length;
    const cmp = tail ? live.slice(-fresh.length) : live;
    const same = cmp.length === fresh.length && cmp.every((x, i) => x === fresh[i]);
    return { same, unique, live: live.length, fresh: fresh.length, at: cmp.findIndex((x, i) => x !== fresh[i]) };
  }, tail);
  check(r.same && r.unique, `${what}: the live page shows what a reload shows (${r.live} rows${tail ? " (its tail)" : ""} / reload ${r.fresh}${r.same ? "" : `, first difference at row ${r.at}`}${r.unique ? "" : ", A PART TWICE"})`);
}
const mark = () => page.evaluate(() => (window.__mark = 1));
const noReload = async (what: string) => check((await page.evaluate(() => window.__mark)) === 1, `${what}: without a reload`);
const bar = () => page.evaluate(() => document.querySelector(".livebar")?.textContent ?? null);

let failed = false;
try {
  if (MODE === "series") {
    log(`screenshots in ${SHOTS}`);
    mkdirSync(SHOTS, { recursive: true });
    // ---- 0. a first exchange, so the chat has a segment ----------------------------------------------------
    say("hello there");
    await until("the first turn", () => lastTurn()?.status === "done" && idle());
    const first = lastTurn()!.id;
    firstTurn = first;
    await page.goto(`${BASE}/segments/${first}`);
    await mark();
    await Bun.sleep(1000);
    await snap("a0-open");

    // ---- 1. a message, a turn unfolding: thinking, a slow tool call, her message pending then delivered -----
    tg.fail("sendMessage", { code: 429, description: "Too Many Requests: retry after 4", retry_after: 4 });
    say("check the trains in that clip please");
    await filmUntil("a", turnDone(first));
    await noReload("the turn unfolded");
    const kept = await page.evaluate(() => ({ connected: !!window.__opened?.isConnected, open: !!window.__opened?.open }));
    check(kept.connected && kept.open, `a thinking line opened mid-turn is kept, still open, while later rows arrive (${JSON.stringify(kept)})`);
    await sameAsReload("after the turn");

    // ---- 2. scrolled up during a turn: no jump, "↓ N new", which jumps to the end ---------------------------
    await page.setViewport(1280, 560);
    await Bun.sleep(300);
    await page.evaluate(() => document.querySelector(".detail-pane").scrollTo(0, 0));
    const before = lastTurn()!.id;
    say("and the one after that?");
    await until("the next turn to end", turnDone(before));
    await Bun.sleep(2500);
    const up = await page.evaluate(() => ({ top: document.querySelector(".detail-pane").scrollTop, pill: document.querySelector(".livenew")?.hidden === false ? document.querySelector(".livenew").textContent : null }));
    check(up.top === 0 && !!up.pill, `scrolled up: the view stayed at the top (scrollTop ${up.top}) and says "${up.pill}"`);
    await snap("b1-scrolled-up");
    await page.click(".livenew");
    await Bun.sleep(1200);
    const down = await page.evaluate(() => {
      const p = document.querySelector(".detail-pane");
      return { bottom: p.scrollHeight - p.scrollTop - p.clientHeight < 48, gone: document.querySelector(".livenew").hidden };
    });
    check(down.bottom && down.gone, "the pill jumps to the end, and goes");
    await snap("b2-jumped");
    await page.setViewport(1280, 820);
    await sameAsReload("after the scrolled-up turn");

    // ---- 3. the stream killed mid-turn (the server, SIGKILL) and restored -----------------------------------
    const before3 = lastTurn()!.id;
    say("one more: the evening train?");
    await until("its tool call to be running", () => lastTurn()!.id > before3 && q<{ n: number }>("select count(*) as n from turn_steps where turn_id = ? and status = 'running'", lastTurn()!.id).n > 0);
    await Bun.sleep(1500);
    await snap("c1-before-kill");
    killServer();
    log("server killed mid-turn");
    await Bun.sleep(4000);
    await snap("c2-server-down");
    await until("the turn to end while the server is down", () => lastTurn()!.status !== "running");
    startServer();
    await until("the console again", () => serverOut.includes("console: listening"), 30_000);
    log("server restarted");
    await until("the queued message to be delivered", idle);
    await until("the page to catch up", async () => {
      const s = JSON.parse(await state()) as { badge?: string; pending: number };
      return s.pending === 0 && !!s.badge?.includes("done");
    });
    await Bun.sleep(2500);
    await snap("c3-restored");
    await noReload("after the stream was cut and restored");
    await sameAsReload("after the stream was cut and restored (no gap, nothing twice)");

    // ---- 4. deleting on a live page (after the restart: a new CSRF secret): undo; a delete kept through turns --
    const herLast = await page.evaluate(() => [...document.querySelectorAll(".detail-pane .pickable.her")].at(-1)?.dataset.seq as string);
    const clickDelete = (seq: string) => page.evaluate((s) => document.querySelector(`.pickable[data-seq="${s}"] .dm-del`).click(), seq);
    const visible = (seq: string) => page.evaluate((s) => [...document.querySelectorAll(`.pickable[data-seq="${s}"]`)].filter((e: any) => e.offsetParent !== null).length, seq);
    await clickDelete(herLast);
    await Bun.sleep(800);
    await snap("d1-deleted");
    check((await visible(herLast)) === 0, "a delete on a live page (after a restart) goes through");
    await page.click(".snack .sundo");
    await Bun.sleep(2500);
    check((await visible(herLast)) === 1, "an undo brings the message back on the live page");
    await clickDelete(herLast);
    await Bun.sleep(1000);
    const before4 = lastTurn()!.id;
    say("thanks, that is all");
    await until("another turn to end", turnDone(before4));
    await Bun.sleep(2500);
    check((await visible(herLast)) === 0, "the deleted message does not come back through the stream");
    await snap("d2-after-delete-and-turn");
    await sameAsReload("after the delete and a new turn");

    // ---- 5. a boosted navigation to the chat's log, its window sliding (over 200 events) -------------------
    const chat = lastTurn()!.chatId;
    // Her old notes, as sent messages with no turn (no turn is woken by them): the log now holds more than a page.
    for (let i = 0; i < 205; i++) {
      const s = enqueueOutbound(db, { chatId: chat, kind: "bot_message", payload: { text: `An old note, number ${i}.` }, idemKey: `demo:${i}` })!;
      markSent(db, s, 50_000 + i);
    }
    await page.click(".gname");
    await Bun.sleep(2000);
    await mark();
    await page.evaluate(() => {
      const p = document.querySelector(".detail-pane");
      p.scrollTop = p.scrollHeight;
    });
    log(`navigated to ${await page.evaluate(() => location.href)}`);
    const before5 = lastTurn()!.id;
    say("last one, promise");
    await until("the turn on the chat page", turnDone(before5));
    await Bun.sleep(3000);
    await snap("e1-chat-log-live");
    await noReload("the chat's log");
    await sameAsReload("the chat's log after a turn, its window slid", true);

    // ---- 5b. a picture that arrives after its turn ended (its message rewritten in place) ------------------
    tg.files.set("photo-demo", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64"));
    const before5b = lastTurn()!.id;
    tg.updates.push(dmUpdate(update++, undefined as never, OWNER, { text: undefined, caption: "here is a photo", photo: [{ file_id: "photo-demo", file_unique_id: "pdemo", width: 64, height: 64 }] }));
    await until("the photo's turn to end", turnDone(before5b));
    const ready = () => q<{ s: string | null }>("select json_extract(payload, '$.media.state') as s from chat_events where kind = 'message' order by seq desc limit 1").s;
    check(ready() === "pending", `the turn ended before its picture arrived (${ready()})`);
    await Bun.sleep(1500);
    const imgsBefore = await page.evaluate(() => document.querySelectorAll(".detail-pane .bubble.in img").length);
    await until("the picture to be downloaded", () => ready() === "ready", 30_000);
    await Bun.sleep(2500);
    const imgsAfter = await page.evaluate(() => document.querySelectorAll(".detail-pane .bubble.in img").length);
    check(imgsAfter === imgsBefore + 1, `the picture appears on the live page by itself (${imgsBefore} → ${imgsAfter} pictures)`);
    await snap("e2-picture-arrived");
    await sameAsReload("after the picture", true);

    // ---- 6. the per-session cap: this page paused, then resumed ---------------------------------------------
    await page.evaluate((cap) => {
      const root = document.querySelector("[data-live-page]");
      const v = document.querySelector('meta[name="assets"]').content;
      window.__others = [];
      for (let i = 0; i < cap; i++) {
        const es = new EventSource(`/live?page=${encodeURIComponent(root.dataset.livePage)}&v=${v}&tab=other-${i}`);
        // As console.js does: told bye, it rests (a bare EventSource would reconnect at once).
        es.addEventListener("bye", () => es.close());
        window.__others.push(es);
      }
    }, MAX_STREAMS_PER_SESSION);
    await Bun.sleep(2500);
    const paused = await bar();
    check(paused?.includes("Live updates paused"), `${MAX_STREAMS_PER_SESSION} other tabs: this one says "${paused}"`);
    await snap("f1-paused");
    await page.click(".livebar button");
    await Bun.sleep(2000);
    const before6 = lastTurn()!.id;
    say("are you still there?");
    await until("a turn after resuming", turnDone(before6));
    await Bun.sleep(3000);
    check((await bar()) === null, "Resume: the bar goes");
    await sameAsReload("after Resume, a turn arrived", true);
    await page.evaluate(() => {
      for (const es of window.__others) es.close();
    });

    // ---- 7. /turns with nothing selected: a newer segment is offered, not loaded ------------------------------
    await page.goto(`${BASE}/turns`);
    await mark();
    await page.evaluate(() => {
      const p = document.querySelector(".detail-pane");
      p.scrollTop = 120;
    });
    const top = await page.evaluate(() => document.querySelector(".detail-pane").scrollTop);
    const group = ensureChat(db, { id: -100555, kind: "group", title: "Example Book Club" });
    recordInbound(db, { chatId: group.id, kind: "message", payload: { from: { id: 77, name: "Alice Example" }, text: "who is reading what?" }, tgUpdateId: 990_001, tgMessageId: 990_001 });
    const other = claimTurn(db, group.id)!;
    finishTurn(db, other.id, { status: "done" });
    await until("the bar", async () => (await bar()) !== null, 10_000);
    const offered = await bar();
    check(offered?.includes("New activity"), `a newer segment elsewhere: "${offered}", and the page stays (scrollTop ${top} → ${await page.evaluate(() => document.querySelector(".detail-pane").scrollTop)})`);
    await noReload("a newer segment on /turns");
    await snap("g1-new-activity");
    const loaded = page.loaded();
    await page.click(".livebar button");
    await loaded;
    check((await page.evaluate(() => document.querySelector(".detail-pane .head h1")?.textContent ?? "")) !== "" && (await page.evaluate(() => document.querySelector(".detail-pane")?.textContent ?? "")).includes("Example Book Club"), "Show loads the newer segment");
    await snap("g2-shown");

    // ---- 8. a phone width (the page scrolls as a whole) --------------------------------------------------------
    await page.setViewport(390, 800);
    await page.goto(`${BASE}/segments/${first}`);
    await mark();
    await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
    const before8 = lastTurn()!.id;
    say("on the phone now");
    await until("the phone turn", () => lastTurn()!.id > before8 && lastTurn()!.chatId === chat && lastTurn()!.status === "done" && idle());
    await Bun.sleep(3000);
    await snap("h1-phone-followed");
    check(await page.evaluate(() => document.scrollingElement.scrollHeight - document.scrollingElement.scrollTop - innerHeight < 48), "on a phone, at the bottom: the page follows the new rows");
    await noReload("on a phone");

    // ---- 9. the sign-in ends: the page says so instead of retrying -----------------------------------------
    await page.setViewport(1280, 820);
    await page.goto(`${BASE}/segments/${first}`);
    await Bun.sleep(1000);
    await page.send("Network.clearBrowserCookies");
    killServer();
    startServer();
    await until("the console again", () => serverOut.includes("console: listening"), 30_000);
    await until("the bar", async () => (await bar()) !== null, 20_000);
    check((await bar())?.includes("Live updates stopped"), `signed out: "${await bar()}"`);
    await snap("i1-stopped");
  } else {
    // ---- idle: a live page left open with nothing happening ----------------------------------------------------
    say("hello there");
    await until("the first turn", () => lastTurn()?.status === "done" && idle());
    const pid = server!.pid;
    const sample = () => {
      const st = readFileSync(`/proc/${pid}/status`, "utf8");
      const kb = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(st)?.[1] ?? 0);
      return { rssMb: +(kb("VmRSS") / 1024).toFixed(1), fds: readdirSync(`/proc/${pid}/fd`).length, threads: kb("Threads") };
    };
    // `nopage`: the same, on a page that is not live (Settings), for a baseline.
    await page.goto(MODE === "nopage" ? `${BASE}/settings` : `${BASE}/segments/${lastTurn()!.id}`);
    await Bun.sleep(5000);
    const minutes = Number(process.argv[3] ?? 10);
    const rows: string[] = [];
    const cpu = () => {
      const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(" ");
      return Number(f[13]) + Number(f[14]);
    };
    const startCpu = cpu();
    for (let i = 0; i <= minutes * 2; i++) {
      const s = sample();
      const sockets = readdirSync(`/proc/${pid}/fd`).filter((fd) => {
        try {
          return readlinkSync(`/proc/${pid}/fd/${fd}`).startsWith("socket:");
        } catch {
          return false;
        }
      }).length;
      const h = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
      rows.push(`t=${(i * 30).toString().padStart(3)}s rss=${s.rssMb}MB fds=${s.fds} sockets=${sockets} threads=${s.threads} pageHeap=${(h / 1e6).toFixed(1)}MB`);
      log(rows.at(-1)!);
      if (i < minutes * 2) await Bun.sleep(30_000);
    }
    const live = await page.evaluate(() => document.querySelector("[data-live-page]") !== null);
    console.log(`\n${rows.join("\n")}\nserver CPU over the run: ${((cpu() - startCpu) / 100).toFixed(2)}s; a live page: ${live}`);
  }
} catch (e) {
  failed = true;
  console.error(e);
}
console.log(`\n${results.join("\n")}\n`);
if (SHOTS) writeFileSync(join(SHOTS, "server.log"), serverLog);
stop();
killServer();
tg.stop();
slowFiles.stop(true);
porch.stop();
hangar.stop();
anthropic.stop(true);
process.exit(failed || results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
