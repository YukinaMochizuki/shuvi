import { describe, expect, test } from "bun:test";
import { allowedHosts, checkConsole, consoleOn } from "../src/console/index.ts";
import { diffLines, hunks } from "../src/console/diff.ts";
import { markdown } from "../src/console/html.ts";
import { dayStart } from "../src/console/queries.ts";
import { conversationOf } from "../src/console/sessions.ts";
import { handleConsole, isLoopback, LOGIN_HEADER, parseConsoleListen, SESSION_COOKIE, type ConsoleDeps } from "../src/console/server.ts";
import { recordControlBatch } from "../src/control/bot.ts";
import { turnSummary } from "../src/control/turn-summary.ts";
import { consoleFromEnv } from "../src/env.ts";
import { consoleTurnUrl, controlMessagesOf, raiseAlert } from "../src/store/control.ts";
import { ensureChat, recordInbound } from "../src/store/events.ts";
import { ALICE, buildConsoleFixture, FIXTURE_GROUP, type ConsoleFixture } from "./console-fixture.ts";
import { memDb, OWNER } from "./helpers.ts";

const HOST = "127.0.0.1:8787";
const BASE = `http://${HOST}`;
const TOKEN = "example-console-token";

let fixture: ConsoleFixture | null = null;
async function f(): Promise<ConsoleFixture> {
  fixture ??= await buildConsoleFixture();
  return fixture;
}
let rich: ConsoleFixture | null = null;
async function r(): Promise<ConsoleFixture> {
  rich ??= await buildConsoleFixture({ rich: true });
  return rich;
}
async function deps(extra: Partial<ConsoleDeps> = { users: new Set(["owner@example.com"]) }, x?: ConsoleFixture): Promise<ConsoleDeps> {
  const fx = x ?? (await f());
  return { db: fx.db, timeZone: "Asia/Taipei", dataDir: fx.dataDir, ownerId: OWNER, allowedHosts: allowedHosts({ listen: HOST, url: "https://example-host.example-tailnet.ts.net" }, 8787), ...extra };
}
const get = (path: string, headers: Record<string, string> = { [LOGIN_HEADER]: "owner@example.com" }) => new Request(`${BASE}${path}`, { headers });
async function page(path: string, x?: ConsoleFixture): Promise<string> {
  const res = await handleConsole(await deps(undefined, x), get(path));
  expect(res.status).toBe(200);
  return res.text();
}

describe("where the console listens", () => {
  test("loopback only: anything else is refused at startup", () => {
    expect(parseConsoleListen("127.0.0.1:8787")).toEqual({ hostname: "127.0.0.1", port: 8787 });
    expect(parseConsoleListen("[::1]:9000")).toEqual({ hostname: "::1", port: 9000 });
    expect(parseConsoleListen("localhost:0")).toEqual({ hostname: "localhost", port: 0 });
    for (const bad of ["0.0.0.0:8787", "100.64.0.5:8787", "[::]:8787", "example.com:80", "8787"]) expect(() => parseConsoleListen(bad)).toThrow();
    expect(() => checkConsole(consoleFromEnv({ SHUVI_CONSOLE_LISTEN: "100.64.0.5:8787", SHUVI_CONSOLE_USERS: "owner@example.com" }))).toThrow(/loopback/);
    expect(() => checkConsole(consoleFromEnv({ SHUVI_CONSOLE_LISTEN: "0.0.0.0:8787" }))).toThrow(/loopback/);
    expect(() => checkConsole(consoleFromEnv({}))).not.toThrow();
    expect(isLoopback("127.1.2.3")).toBe(true);
    expect(isLoopback("10.0.0.1")).toBe(false);
  });

  test("off unless SHUVI_CONSOLE_USERS or SHUVI_CONSOLE_TOKEN is set", () => {
    expect(consoleOn(consoleFromEnv({}))).toBe(false);
    expect(consoleOn(consoleFromEnv({ SHUVI_CONSOLE_USERS: "owner@example.com" }))).toBe(true);
    expect(consoleOn(consoleFromEnv({ SHUVI_CONSOLE_TOKEN: TOKEN }))).toBe(true);
    expect(consoleFromEnv({ SHUVI_CONSOLE_USERS: " a@example.com , b@example.com ," }).users).toEqual(["a@example.com", "b@example.com"]);
    expect(consoleFromEnv({}).listen).toBe("127.0.0.1:8787");
  });

  test("a request naming another host gets 421 (DNS rebinding)", async () => {
    const d = await deps();
    expect((await handleConsole(d, new Request("http://evil.example/turns", { headers: { [LOGIN_HEADER]: "owner@example.com" } }))).status).toBe(421);
    expect((await handleConsole(d, new Request(`${BASE}/turns`, { headers: { [LOGIN_HEADER]: "owner@example.com", host: "evil.example:8787" } }))).status).toBe(421);
    for (const host of ["localhost:8787", "[::1]:8787", "example-host.example-tailnet.ts.net", "127.0.0.1:8787"]) {
      expect((await handleConsole(d, new Request(`${BASE}/turns`, { headers: { [LOGIN_HEADER]: "owner@example.com", host } }))).status).toBe(200);
    }
    expect((await handleConsole(d, new Request(`${BASE}/turns`, { headers: { [LOGIN_HEADER]: "owner@example.com", host: "127.0.0.1:9999" } }))).status).toBe(421);
  });
});

describe("who may look: the tailnet login", () => {
  test("a login on the list gets the page", async () => {
    const res = await handleConsole(await deps(), get("/turns"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("owner@example.com");
  });

  test("a login not on the list gets 403", async () => {
    expect((await handleConsole(await deps(), get("/turns", { [LOGIN_HEADER]: "someone@example.com" }))).status).toBe(403);
  });

  test("no header gets 403, and a token is no way around it; the 403 is a styled page", async () => {
    const res = await handleConsole(await deps(), get("/turns", {}));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('<link rel="stylesheet" href="/style.css">');
    expect((await handleConsole(await deps({ users: new Set(["owner@example.com"]), token: TOKEN }), get("/turns", { authorization: `Bearer ${TOKEN}` }))).status).toBe(403);
    expect((await handleConsole(await deps(), get("/media?ref=media/example-photo", {}))).status).toBe(403);
  });
});

describe("who may look: the token fallback", () => {
  const tokenDeps = () => deps({ token: TOKEN });

  test("no token gets 401 and the (styled) sign-in form", async () => {
    const res = await handleConsole(await tokenDeps(), get("/turns", {}));
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain('action="/login"');
    expect(body).toContain('class="card"');
  });

  test("a wrong token gets 401", async () => {
    expect((await handleConsole(await tokenDeps(), get("/turns", { authorization: "Bearer not-the-token" }))).status).toBe(401);
    const login = new Request(`${BASE}/login`, { method: "POST", body: new URLSearchParams({ token: "not-the-token" }) });
    const res = await handleConsole(await tokenDeps(), login);
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("the token buys an HttpOnly session cookie, and the cookie works", async () => {
    const login = new Request(`${BASE}/login`, { method: "POST", body: new URLSearchParams({ token: TOKEN }) });
    const res = await handleConsole(await tokenDeps(), login);
    expect(res.status).toBe(303);
    const set = res.headers.get("set-cookie")!;
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
    const value = /shuvi_console=([^;]+)/.exec(set)![1]!;
    expect(value).not.toContain(TOKEN);
    expect((await handleConsole(await tokenDeps(), get("/turns", { cookie: `${SESSION_COOKIE}=${value}` }))).status).toBe(200);
    const [exp] = value.split(".");
    expect((await handleConsole(await tokenDeps(), get("/turns", { cookie: `${SESSION_COOKIE}=${exp}.AAAA` }))).status).toBe(401);
    expect((await handleConsole(await tokenDeps(), get("/turns", { cookie: `${SESSION_COOKIE}=${Number(exp) + 1000}.${value.split(".")[1]}` }))).status).toBe(401);
    expect((await handleConsole({ ...(await tokenDeps()), now: () => Number(exp) + 1 }, get("/turns", { cookie: `${SESSION_COOKIE}=${value}` }))).status).toBe(401);
    expect((await handleConsole(await deps({ token: "another-token" }), get("/turns", { cookie: `${SESSION_COOKIE}=${value}` }))).status).toBe(401);
  });

  test("read only: nothing but GET, HEAD and the sign-in", async () => {
    const res = await handleConsole(await deps(), new Request(`${BASE}/turns`, { method: "POST", headers: { [LOGIN_HEADER]: "owner@example.com" } }));
    expect(res.status).toBe(405);
  });
});

describe("pages, against fixture data", () => {
  test("the list: chats, the conversations in them, and their segments, most recently active first; /chats leads there", async () => {
    const x = await f();
    const html = await page("/turns");
    const group = html.indexOf(">Example Group</a>");
    const dm = html.indexOf(">DM · Owner</a>");
    expect(group).toBeGreaterThan(0);
    expect(dm).toBeGreaterThan(group); // the group spoke last
    expect(html).toContain("2 segments, 4 turns in 2 chats, by last activity");
    expect(html).toContain('direct · 3 turns · <span class="c-failed">1 failed</span>');
    // Under the chat, its conversation's header, then the segment (the DM's three turns came within minutes).
    const conv = html.indexOf(`href="/conversations/${x.turns.done}"`);
    const seg = html.indexOf(`href="/segments/${x.turns.done}"`);
    expect(conv).toBeGreaterThan(dm);
    expect(seg).toBeGreaterThan(conv);
    expect(html).toContain('<span class="cl">first conversation</span>');
    expect(html).toMatch(/3 turns · 5 tools · 1 refused · \$0\.0020 · <span class="c-failed">1 failed<\/span>/);
    expect(html).toContain(`href="/segments/${x.turns.group}"`);
    const res = await handleConsole(await deps(), get("/chats"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/turns");
  });

  test("the selected turn's chat is open; filters hide chats with no matching turn", async () => {
    const x = await f();
    const dmTurn = await page(`/turns/${x.turns.done}`);
    expect(dmTurn).toMatch(/<details class="group has-failed" open><summary class="ghead"><span class="gl1"><a class="gname" href="\/chats\/1"/);
    expect(dmTurn).toContain(`class="row on bad" href="/segments/${x.turns.done}"`); // its segment is marked
    expect(dmTurn).toContain(`In <a href="/segments/${x.turns.done}">the segment of`);
    const failed = await page("/turns?outcome=failed");
    expect(failed).toContain("1 segment, 1 turn in 1 chat");
    expect(failed).not.toContain(">Example Group</a>");
    expect(await page("/turns?q=no-such-text-anywhere")).toContain("No turn matches that.");
  });

  test("a segment: one continuous exchange, a thin divider per turn with its outcome and links to its tabs", async () => {
    const x = await f();
    const html = await page(`/segments/${x.turns.done}`);
    expect(html).toContain(`The only segment of <a href="/conversations/${x.turns.done}">the chat&#39;s first conversation</a>`);
    for (const id of [x.turns.done, x.turns.failed, x.turns.passed]) {
      expect(html).toContain(`<a href="/turns/${id}"><span class="dot`);
      expect(html).toContain(`href="/turns/${id}?tab=prompt"`);
      expect(html).toContain(`href="/turns/${id}?tab=raw"`);
    }
    expect(html).toContain('<span class="c-failed">failed</span>');
    expect(html).toContain("Failed: Claude Agent SDK run ended with");
    expect(html).toContain('<span class="tag">retry</span>'); // the turn after the failure answered its message again
    expect((html.match(/>book the train for it<\/div>/g) ?? []).length).toBe(1); // shown once, not per attempt
    expect((html.match(/class="tdiv/g) ?? []).length).toBe(3);
    expect(html).not.toContain("Resumed conversation"); // said once by the segment, not per turn
    expect((await handleConsole(await deps(), get("/segments/99999"))).status).toBe(404);
    // The first address of a segment leads to the new one, filters kept.
    const old = await handleConsole(await deps(), get(`/sessions/${x.turns.done}?tool=look_at`));
    expect(old.status).toBe(301);
    expect(old.headers.get("location")).toBe(`/segments/${x.turns.done}?tool=look_at`);
    // Any turn of it names it too.
    expect(await page(`/segments/${x.turns.passed}`)).toContain(`<a href="/turns/${x.turns.done}"><span class="dot`);
  });

  test("filters keep the segments holding a matching turn, and mark that turn in it", async () => {
    const x = await f();
    const list = await page("/turns?tool=look_at");
    expect(list).toContain("1 segment, 1 turn in 1 chat");
    expect(list).toContain('<span class="c-accent">1 of 3 match</span>');
    const seg = await page(`/segments/${x.turns.done}?tool=look_at`);
    expect((seg.match(/class="tdiv match"/g) ?? []).length).toBe(1);
    expect(seg).toContain('<span class="c-accent">1 of 3 turns</span> match the filter');
  });

  test("a conversation: its segments with the time between them, and a compaction marked where it happened", async () => {
    const x = await r();
    const [last] = x.db.$client.query("select id from turns where chat_id = 1 order by id desc limit 1").all() as { id: number }[];
    const conv = conversationOf(x.db, 1, last!.id)!;
    const html = await page(`/conversations/${conv.id}`, x);
    expect(html).toContain("<h1>A fresh conversation, after /new</h1>");
    expect(html).toContain("3 segments");
    expect((html.match(/class="gapdiv"/g) ?? []).length).toBe(2);
    expect(html).toMatch(/1h 00m later|1d 1h later/);
    expect(html).toContain('<b>Compacted</b><span class="tag">auto</span><span class="num">167k tokens before → 13k after</span>');
    expect(html).toContain("From here on she sees only a summary of what came before.");
    // The list says so too.
    const list = await page("/turns", x);
    expect(list).toContain('<span class="cl">after /new</span>');
    expect(list).toContain('<span class="c-lost">1 compaction</span>');
    expect(list).toContain('<span class="c-lost">compacted</span>');
  });

  test("turns from before the console: their messages from the chat's log, and one plain sentence why there is no more", async () => {
    const x = await r();
    const first = (x.db.$client.query("select id from turns where chat_id = 1 order by id limit 1").get() as { id: number }).id;
    const html = await page(`/segments/${first}`, x);
    expect(html).toContain("the chat&#39;s first conversation (inferred: these turns ran before conversations were recorded)");
    expect(html).toContain('<p class="note left">These turns ran before transcripts were recorded');
    expect(html).toContain("good morning! anything on today?");
    expect(html).toContain("Morning! Nothing on the calendar until the evening.");
    expect(html).toContain('<span class="tag" title="This turn ran before transcripts were recorded');
    expect(html).toContain("recording started with the console&#39;s deployment, and the first recorded turn is turn");
    const prompt = await page(`/turns/${first}?tab=prompt`, x);
    expect(prompt).toContain("This turn ran before transcripts were recorded");
    expect(prompt).not.toContain("pruned");
    expect(await page(`/turns/${first}?tab=raw`, x)).toContain("This turn ran before transcripts were recorded");
  });

  test("at scale: each chat shows its latest few segments, with a link to the rest, paged", async () => {
    const x = await r();
    const html = await page("/turns", x);
    // Groups past the first few start closed when nothing is selected.
    expect((html.match(/<details class="group[^"]*" open>/g) ?? []).length).toBe(3);
    const club = (x.db.$client.query("select id from chats where title = 'Book Club Example'").get() as { id: number }).id;
    const one = await page(`/turns?chat=${club}`, x);
    expect(one).toContain("← all chats");
    expect((one.match(/<a class="row/g) ?? []).length).toBe(2); // two days apart: two segments
  });

  test("many chats stay fast: 400 chats of 20 hour-apart turns render with 5 segments each and a link to the rest", async () => {
    const db = (await buildConsoleFixture()).db;
    const insertChat = db.$client.prepare("insert into chats (tg_chat_id, kind, title) values (?, 'group', ?)");
    const insertTurn = db.$client.prepare("insert into turns (chat_id, status, from_seq, to_seq, started_at, ended_at) values (?, 'done', 0, 0, ?, ?)");
    db.$client.transaction(() => {
      for (let i = 0; i < 400; i++) {
        const id = Number(insertChat.run(-200000 - i, `Load Example ${i}`).lastInsertRowid);
        for (let k = 19; k >= 0; k--) insertTurn.run(id, new Date(Date.now() - k * 3600_000).toISOString(), new Date(Date.now() - k * 3600_000 + 1000).toISOString());
      }
    })();
    const fx = await f();
    const t0 = performance.now();
    const res = await handleConsole({ ...(await deps()), db, dataDir: fx.dataDir }, get("/turns"));
    const ms = performance.now() - t0;
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("in 402 chats");
    expect((html.match(/<a class="row/g) ?? []).length).toBeLessThanOrEqual(402 * 5);
    expect(html).toContain("15 more in this chat");
    console.log(`grouped list, 402 chats: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(3000);
  });

  test("a chat: its events as a conversation, each turn's boundary linking to it", async () => {
    const x = await f();
    const html = await page("/chats/2");
    expect(html).toContain("Alice Example");
    expect(html).toContain('class="tag owner"'); // the owner's line marked, in a group
    expect(html).toContain(`href="/turns/${x.turns.group}"`);
    expect(html).toContain("reacted 👀");
    expect(html).toContain('class="bubble out"');
    const dm = await page("/chats/1");
    expect(dm).toContain('src="/media?ref=media%2Fexample-photo"');
    expect(dm).toContain(`turn ${x.turns.done}`);
    expect(dm).not.toContain('class="tag owner"'); // not in a DM
  });

  test("turns: the newest segment beside the list, and the filters (outcome, chat, tool, date) and search", async () => {
    const x = await f();
    const all = await page("/turns");
    expect(all).toContain(`href="/segments/${x.turns.done}"`);
    expect(all).toContain(`href="/segments/${x.turns.group}"`);
    expect(all).toContain("2 segments, 4 turns in 2 chats");
    expect(all).toContain(`<a href="/turns/${x.turns.group}"><span class="dot`); // the newest segment, beside the list
    const failed = await page("/turns?outcome=failed");
    expect(failed).toContain(`href="/segments/${x.turns.done}?outcome=failed"`);
    expect((failed.match(/<a class="row/g) ?? []).length).toBe(1);
    expect(failed).toContain('class="row on auto bad"');
    expect(await page("/turns?tool=look_at")).toContain("1 segment, 1 turn in 1 chat");
    expect(await page("/turns?chat=2")).toContain("← all chats");
    expect(await page("/turns?q=checkerboard")).toContain("1 segment, 1 turn in 1 chat");
    expect(await page("/turns?from=2001-01-01&to=2001-01-02")).toContain("No turn matches that.");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
    expect(await page(`/turns?from=${today}&to=${today}`)).toContain("2 segments, 4 turns in 2 chats");
  });

  test("date filters are read in the owner's time zone", () => {
    expect(dayStart("2026-11-12", "Asia/Taipei")).toBe("2026-11-11T16:00:00.000Z");
    expect(dayStart("2026-11-12", "UTC")).toBe("2026-11-12T00:00:00.000Z");
    expect(dayStart("2026-03-29", "Europe/Berlin")).toBe("2026-03-28T23:00:00.000Z"); // the day DST starts
  });

  test("one turn, as a conversation: the trigger, thinking, tool calls, her messages with their status, mid-turn messages", async () => {
    const x = await f();
    const html = await page(`/turns/${x.turns.done}`);
    expect(html).toContain('class="split selected"');
    expect(html).toContain('class="tag trig">trigger');
    expect(html).toContain('src="/media?ref=media%2Fexample-photo"'); // the input's photo
    expect(html).toMatch(/src="\/media\?ref=media%2Ftranscript%2F[0-9a-f]{64}\.png"/); // the tool's picture
    expect(html).toContain('<span class="name">look_at</span>');
    expect(html).toContain('class="step thinking"');
    expect(html).toContain("✓ delivered");
    expect(html).toContain("mid-turn · after say");
    expect(html).toContain("oh, and the trip is next Friday");
    expect(html).toContain("10</b> in / <b>5</b> out");
    expect(html).toContain("$0.0010");
    expect(html).toContain("ended done");
  });

  test("one turn: the system prompt by section, the diff on request, and the raw input", async () => {
    const x = await f();
    const prompt = await page(`/turns/${x.turns.done}?tab=prompt`);
    expect(prompt).toContain('<span class="lbl">persona/public.md</span>');
    expect(prompt).toContain('<span class="lbl">capability: speech</span>');
    expect(prompt).toContain("the first recorded in this chat");
    const changed = await page(`/turns/${x.turns.failed}?tab=prompt`);
    expect(changed).toContain(`changed since <a href="/turns/${x.turns.done}?tab=prompt">turn ${x.turns.done}</a>`);
    expect(changed).toContain("Show diff");
    expect(changed).not.toContain('class="diff"');
    const diff = await page(`/turns/${x.turns.failed}?tab=prompt&diff=1`);
    expect(diff).toContain("+ - Always name the day of the week with a date.");
    expect(await page(`/turns/${x.turns.passed}?tab=prompt`)).toContain(`unchanged since <a href="/turns/${x.turns.failed}?tab=prompt">turn ${x.turns.failed}</a>`);
    const raw = await page(`/turns/${x.turns.done}?tab=raw`);
    expect(raw).toContain("the opening prompt (a fresh conversation)");
    expect(raw).toContain("(New messages arrived while you were working:)");
  });

  test("one turn: a failure says why; a refusal is marked with its reason", async () => {
    const x = await f();
    const failed = await page(`/turns/${x.turns.failed}`);
    expect(failed).toContain("Why it ended that way");
    expect(failed).toContain("ended failed");
    const passed = await page(`/turns/${x.turns.passed}`);
    expect(passed).toContain('class="word c-refused">refused');
    expect(passed).toContain("already passed");
  });

  test("at scale: eleven tool calls, long results folded with their size, an error, a group refusal", async () => {
    const x = await r();
    const ids = (x.db.$client.query("select id from turns order by id").all() as { id: number }[]).map((t) => t.id);
    const research = await page(`/turns/${ids.at(-1)}`, x);
    expect((research.match(/class="step tool"/g) ?? []).length).toBe(11);
    expect(research).toContain('class="fold"');
    expect(research).toMatch(/1\.\d kB · 35 lines/);
    expect(research).toContain("no such column: pets");
    expect(research).toContain("<strong>Trains</strong>");
    const group = await page(`/turns/${ids.at(-2)}`, x);
    expect(group).toContain("Bob Example");
    expect(group).toContain("Carol Example");
    expect(group).toContain('class="tag">context');
    expect(group).toContain('class="word c-refused">refused');
    const expanded = await page(`/turns/${ids.at(-1)}?expand=1`, x);
    expect(expanded).not.toContain('class="fold"');
    expect(expanded).toContain('class="step tool" id="s2" open');
  });

  test("text from a chat is escaped, never markup", async () => {
    const x = await f();
    const g = ensureChat(x.db, { id: FIXTURE_GROUP.id, kind: "group" });
    recordInbound(x.db, { chatId: g.id, kind: "message", payload: { from: ALICE, text: '<script>alert("x")</script><img src=x>' }, tgUpdateId: 9999, tgMessageId: 9999 });
    const html = await page(`/chats/${g.id}`);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  test("media: images under media/ only", async () => {
    const d = await deps();
    const ok = await handleConsole(d, get("/media?ref=media/example-photo"));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    for (const bad of ["media/../shuvi.db", "../etc/passwd", "home/persona/public.md", "media/nope", "/etc/passwd"]) {
      expect((await handleConsole(d, get(`/media?ref=${encodeURIComponent(bad)}`))).status).toBe(404);
    }
  });

  test("unknown pages and turns are 404, as a styled page", async () => {
    const res = await handleConsole(await deps(), get("/turns/99999"));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('class="card"');
    expect((await handleConsole(await deps(), get("/nope"))).status).toBe(404);
  });

  test("the stylesheet and the script are served without credentials (the sign-in and error pages need them)", async () => {
    for (const d of [await deps(), await deps({ token: TOKEN })]) {
      const css = await handleConsole(d, get("/style.css", {}));
      expect(css.status).toBe(200);
      expect(css.headers.get("content-type")).toContain("text/css");
      expect((await handleConsole(d, get("/console.js", {}))).status).toBe(200);
    }
    // Still not for a stranger's Host.
    expect((await handleConsole(await deps(), new Request("http://evil.example/style.css"))).status).toBe(421);
  });

  test("the CSP allows this origin's one script and nothing inline; the script is served", async () => {
    const res = await handleConsole(await deps(), get("/chats"));
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    const js = await handleConsole(await deps(), get("/console.js"));
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
  });
});

describe("her markdown", () => {
  test("bold and italic, but never inside inline code; everything escaped", () => {
    expect(markdown("**a** and `**not bold** _nor this_` and _this_").s).toBe("<strong>a</strong> and <code>**not bold** _nor this_</code> and <em>this</em>");
    expect(markdown("`<b>` <i>").s).toBe("<code>&lt;b&gt;</code> &lt;i&gt;");
    expect(markdown("a \u00000\u0000 b").s).toBe("a 0 b"); // a stray placeholder byte cannot pull code in
  });
});

describe("the diff", () => {
  test("line by line, with context around changes", () => {
    const d = diffLines("a\nb\nc\nd\ne\nf\ng\nh\ni\nj", "a\nb\nc\nd\nE\nf\ng\nh\ni\nj\nk");
    expect(d.filter((l) => l.op !== "same")).toEqual([
      { op: "del", text: "e" },
      { op: "add", text: "E" },
      { op: "add", text: "k" },
    ]);
    const h = hunks(diffLines("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15", "1\nX\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\nY"), 1);
    expect(h.map((l) => (l ? `${l.op[0]}${l.text}` : "…"))).toEqual(["s1", "d2", "aX", "s3", "…", "s14", "d15", "aY"]);
  });
});

describe("control bot links", () => {
  test("alerts about a turn carry its console link when SHUVI_CONSOLE_URL is set", () => {
    const db = memDb();
    const prev = process.env.SHUVI_CONSOLE_URL;
    try {
      delete process.env.SHUVI_CONSOLE_URL;
      raiseAlert(db, { key: "a", text: "Turn 7 failed.", turnId: 7 });
      process.env.SHUVI_CONSOLE_URL = "https://example-host.example-tailnet.ts.net/";
      raiseAlert(db, { key: "b", text: "Turn 8 failed.", turnId: 8 });
      raiseAlert(db, { key: "c", text: "A backup failed." });
    } finally {
      if (prev === undefined) delete process.env.SHUVI_CONSOLE_URL;
      else process.env.SHUVI_CONSOLE_URL = prev;
    }
    expect(controlMessagesOf(db, "alert").map((m) => m.text)).toEqual(["Turn 7 failed.", "Turn 8 failed.\nhttps://example-host.example-tailnet.ts.net/turns/8", "A backup failed."]);
    expect(consoleTurnUrl(3, { SHUVI_CONSOLE_URL: "https://h.example" })).toBe("https://h.example/turns/3");
    expect(consoleTurnUrl(3, {})).toBeNull();
  });

  test("/turn <id> answers one paragraph and the link", async () => {
    const x = await f();
    const text = turnSummary(x.db, x.turns.done, "UTC");
    expect(text).toContain(`Turn ${x.turns.done} in chat 1`);
    expect(text).toContain("done after");
    expect(text).toContain("2 tool calls (look_at, say)");
    expect(text).toContain("2 text blocks, 2 sent");
    expect(text).toContain("Tokens: 10 in, 5 out, 100 cache read, 0 cache write; $0.0010 on fake.");
    expect(turnSummary(x.db, x.turns.passed, "UTC")).toContain("1 refused");
    expect(turnSummary(x.db, 999, "UTC")).toBe("No turn 999.");

    const db = memDb();
    const update = { update_id: 1, message: { message_id: 1, date: 0, chat: { id: OWNER, type: "private" }, from: { id: OWNER, is_bot: false, first_name: "Owner" }, text: "/turn 42" } };
    recordControlBatch(db, [update as never], { ownerId: OWNER, commit: "test", timeZone: "UTC" });
    expect(controlMessagesOf(db, "reply").map((m) => m.text)).toEqual(["No turn 42."]);
  });
});
