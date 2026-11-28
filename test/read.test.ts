import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textOf, type ToolResult } from "agent-runtime";
import { runTurn } from "../src/agent/turn.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import { prewarmLinks } from "../src/capabilities/media/links.ts";
import { prewarmsOf } from "../src/capabilities/media/prewarm.ts";
import { MAX_READ_IMAGES, readContent, renderRead, SAVE_NOTE } from "../src/capabilities/media/read.ts";
import { capabilityInbound } from "../src/capabilities/types.ts";
import { describeRead, Porchkit, porchkitConfig, PorchkitError, READ_UNAVAILABLE, type Post } from "../src/porchkit/client.ts";
import { parsePolicy, type Policy } from "../src/policy/policy.ts";
import { recordBatch } from "../src/server/poller.ts";
import type { Db } from "../src/store/db.ts";
import { claimTurn } from "../src/store/turns.ts";
import { FakeHangar } from "./fake-hangar.ts";
import { FakePorchkit, LONG_HTML, LONG_MARKDOWN, LONG_PAGE, RAW_JSON, REDDIT_POST, SHORT_PAGE, TINY_JPEG, X_POST } from "./fake-porchkit.ts";
import { dmUpdate, memDb, OWNER, ownerChatId, ownerSays, ScriptedAdapter, type Step } from "./helpers.ts";

const fakes: { stop(): void }[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) f.stop();
});

function porch(): FakePorchkit {
  const p = new FakePorchkit();
  fakes.push(p);
  return p;
}
const client = (p: FakePorchkit) => new Porchkit(porchkitConfig(p.env())!);

const home = () => {
  const h = mkdtempSync(join(tmpdir(), "shuvi-read-"));
  mkdirSync(join(h, "persona"));
  return h;
};

const policyOf = (text: string): Policy => {
  const r = parsePolicy(text, OWNER);
  if ("error" in r) throw new Error(r.error);
  return r.policy;
};

async function dmTurn(db: Db, env: Record<string, string>, script: Step[], policy?: Policy): Promise<ScriptedAdapter> {
  const turn = claimTurn(db, ownerChatId(db))!;
  let adapter!: ScriptedAdapter;
  await runTurn({ db, turnId: turn.id, home: home(), timeZone: "UTC", ownerId: OWNER, capabilities: enabledCapabilities(env), ...(policy ? { policy } : {}), makeAdapter: (b) => (adapter = new ScriptedAdapter(b, script)) });
  return adapter;
}

const text = (r: ToolResult) => textOf(r);
const images = (r: ToolResult) => r.content.filter((c) => c.type === "image");
let upd = 9000;

// ---- rendering, kind by kind ---------------------------------------------------------------------------

describe("a post", () => {
  test("an X post: author, time, whole text, metrics, its images as images, its video's probe, transcript, poster and sheet, the quoted post, links", async () => {
    const p = porch();
    const pk = client(p);
    const r = renderRead(await pk.read({ url: X_POST }), { saveable: false });
    expect(r.text).toBe(
      [
        "Post on X by Example Person (@example), 2026-11-14 09:30 UTC",
        "Link: https://x.com/example/status/1234567890",
        "120 likes · 14 reposts · 9 replies · 5,300 views",
        "",
        "The full text of the post, links expanded: https://example.com/article",
        "",
        'Image 1: image 1 (1200x800, alt: "A chart")',
        "Image 2: image 2 (800x800)",
        "Video 1 (00:43 · 1280x720) — poster: image 3",
        "  Title: Example Person - a short clip",
        "  By: Example Person (example) · uploaded 2026-11-14 · twitter",
        "  Length: 00:43 (43s) · 1280x720",
        "  Subtitles: en; automatic captions: none — video_subs reads them",
        "  Has: video up to 720p",
        "  Transcript (subtitles, en):",
        "    [00:01] Hello from the example clip.",
        "    [00:05] This is the second line.",
        "  Contact sheet: image 4, frames tiled in order with each one's time under it",
        "    video: a short clip · 00:42 (42.5s) · 1280x720",
        "    9 frame(s), spread evenly, on 1 sheet(s) of 3x3",
        "  More from this video: video_subs (all it says, with times) and video_sheet (more frames) with url: https://x.com/example/status/1234567890/video/1",
        "",
        "  Quoted post by Other Example (@other), 2026-11-13 08:00 UTC",
        "  Link: https://x.com/other/status/1234567000",
        "  3 likes",
        "",
        "  The quoted post's text.",
        "",
        "Links: https://example.com/article",
        "",
        "(4 image(s) follow, in order.)",
      ].join("\n"),
    );
    // The images: fetched with the token, handed over as image blocks after a line naming each; no key, no URL.
    const content = await readContent(pk, r);
    expect(content.filter((c) => c.type === "image")).toHaveLength(4);
    expect(content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).slice(1)).toEqual([
      "[image 1: picture 1 of the post, alt: A chart]",
      "[image 2: picture 2 of the post]",
      "[image 3: video 1's poster (its still image)]",
      "[image 4: video 1's contact sheet, frames at 00:03 00:08 00:13]",
    ]);
    const img = content.find((c) => c.type === "image") as { data: string; mimeType: string };
    expect(Buffer.from(img.data, "base64").equals(TINY_JPEG)).toBe(true);
    expect(img.mimeType).toBe("image/jpeg");
    expect(p.of("/files/").length + p.of("/media/sheets/").length).toBe(4);
    expect([...p.of("/files/"), ...p.of("/media/sheets/")].every((c) => c.authed)).toBe(true);
    expect(JSON.stringify(content)).not.toMatch(/\/files\/|\/media\/sheets\/|[0-9a-f]{32}/);
  });

  test("a Reddit post with its replies, flat, each with who and when; a reply's images are counted, not fetched", async () => {
    const p = porch();
    const r = renderRead(await client(p).read({ url: REDDIT_POST, comments: 2 }), { saveable: false });
    expect(r.text).toBe(
      [
        "Post on Reddit by u/example_poster, 2026-11-14 09:00 UTC",
        "Link: https://www.reddit.com/r/example/comments/abc123/an_example_thread/",
        "321 score · 3 comments",
        "",
        "An example thread",
        "",
        "The body of the example thread, made up.",
        "",
        "Replies (2):",
        "- u/first_example, 2026-11-14 10:00 UTC (12 score):",
        "    The first reply.",
        "- u/second_example, 2026-11-14 10:05 UTC (4 score), replying to u/first_example:",
        "    A reply to the first reply,",
        "    over two lines.",
        "    [1 image(s), not shown]",
      ].join("\n"),
    );
    expect(r.images).toHaveLength(0);
  });

  test("a mirror is named, notes are passed on, video: summary says only what the post's data says", async () => {
    const p = porch();
    const a = (await client(p).read({ url: X_POST, comments: 5, video: "summary" })) as Post;
    const r = renderRead({ ...a, via: "mirror:fxtwitter" }, { saveable: false });
    expect(r.text).toContain("Read through a mirror (fxtwitter), not the site itself: it may lag behind it.");
    expect(r.text).toContain("Notes:\n- replies need a login on X; none included");
    expect(r.text).toContain("Video 1 (00:43 · 1280x720)\n  More from this video:");
    expect(r.text).not.toContain("Transcript");
    // `syndication` (the site's own data) is not named.
    expect(renderRead(a, { saveable: false }).text).not.toContain("syndication");
  });

  test("at most MAX_READ_IMAGES images per call; the rest are counted and said so; an image porchkit did not fetch is said so", () => {
    const post: Post = {
      kind: "post",
      source: "x",
      author: { name: "Example" },
      text: "Many pictures",
      media: [...Array.from({ length: MAX_READ_IMAGES + 2 }, (_, i) => ({ type: "image" as const, key: String(i).repeat(32) })), { type: "image", key: null }],
    };
    const r = renderRead(post, { saveable: false });
    expect(r.images).toHaveLength(MAX_READ_IMAGES);
    expect(r.leftOut).toBe(2);
    expect(r.text).toContain(`Image ${MAX_READ_IMAGES + 1}: not shown (one read_link returns at most ${MAX_READ_IMAGES} images)`);
    expect(r.text).toContain(`Image ${MAX_READ_IMAGES + 3}: not fetched by the media service`);
    expect(r.text).toEndWith(`(2 more image(s) not shown: one read_link returns at most ${MAX_READ_IMAGES}.)`);
  });
});

describe("a page", () => {
  test("a long page: title, byline, date, the markdown, and how to read on (and to save it, where there is a computer)", async () => {
    const p = porch();
    const a = await client(p).read({ url: LONG_PAGE });
    const r = renderRead(a, { saveable: true });
    const head = ["Page: An example article — Example News", "By Example Writer · published 2026-11-01 · language en", "Link: https://news.example.com/long-article", "", "# An example article", ""].join("\n");
    expect(r.text.startsWith(head)).toBe(true);
    expect(r.text).toContain(
      `…(cut at character 20,000 of ${LONG_MARKDOWN.length.toLocaleString("en-US")}. To read on, call read_link again with offset: 20000 (free: it comes from the cache). save_link puts the whole text onto your computer (for the owner).)`,
    );
    expect(r.text).toContain("Videos on the page: https://www.youtube.com/watch?v=abc123def45 — video_probe, video_subs and video_sheet look at them.");
    expect(r.text).toContain('Images on the page (1, listed, not fetched): https://news.example.com/a.jpg ("An example picture")');
    expect(r.text).toContain("Links (1): https://news.example.com/next");
    expect(r.images).toHaveLength(0);
    expect(renderRead(a, { saveable: false }).text).not.toContain("save_link");
    // Reading on.
    const next = renderRead(await client(p).read({ url: LONG_PAGE, offset: 20_000 }), { saveable: false });
    expect(next.text).toContain(`(from character 20,000 of ${LONG_MARKDOWN.length.toLocaleString("en-US")})`);
    expect(next.text).toContain(LONG_MARKDOWN.slice(20_000, 20_100).trim().slice(0, 60));
    expect(p.of("/read").map((c) => c.body)).toEqual([{ url: LONG_PAGE }, { url: LONG_PAGE, offset: 20_000 }]);
  });

  test("raw JSON as it came; a page read whole has no read-on line", async () => {
    const p = porch();
    expect(renderRead(await client(p).read({ url: RAW_JSON }), { saveable: true }).text).toBe('Raw text (application/json) from https://api.example.com/data.json:\n\n{"example": true, "items": [1, 2, 3]}');
    const short = renderRead(await client(p).read({ url: SHORT_PAGE }), { saveable: true }).text;
    expect(short).toBe("Page: A short note — Example News\nlanguage en\nLink: https://news.example.com/short-note\n\n# A short note\n\nA short note, read whole.");
  });

  test("raw text that is cut says how to read on", () => {
    const r = renderRead({ kind: "raw", content_type: "text/plain", text: "abc", truncated: true, offset: 0, next_offset: 3, total_chars: 10 }, { saveable: false });
    expect(r.text).toBe("Raw text (text/plain):\n\nabc\n\n…(cut at character 3 of 10. To read on, call read_link again with offset: 3 (free: it comes from the cache).)");
  });
});

describe("porchkit's errors, as the model reads them", () => {
  test("422 unavailable, 429 with how long, 415 naming the type", async () => {
    const p = porch();
    const pk = client(p);
    const fail = async (url: string) => {
      try {
        await pk.read({ url });
      } catch (e) {
        return describeRead(e);
      }
      throw new Error("no error");
    };
    expect(await fail("https://x.com/private/status/1")).toBe(`${READ_UNAVAILABLE} (The site said: Private video. Sign in if you've been granted access.)`);
    expect(await fail("https://x.com/busy/status/1")).toBe(
      "Not now: links are read through the owner's home connection, which keeps a request budget for each site, and that budget is used up for now. It should free up in about 3 minutes. Tell whoever asked that it is busy right now and roughly how long, rather than trying again and again.",
    );
    expect(await fail("https://docs.example.com/report.pdf")).toBe("That link leads to a file of type application/pdf, which read_link does not read: it reads posts, web pages, JSON and plain text. Say what it is rather than guessing at what is in it.");
    expect(describeRead(new PorchkitError(415, "unsupported_type", "an archive"))).toContain("(an archive.)");
    expect(await fail("https://nothing.example.com/")).toBe("Nothing to read there: nothing at that URL.");
  });

  test("read_link returns them as errors", async () => {
    const p = porch();
    const db = memDb();
    ownerSays(db, "read these");
    const a = await dmTurn(db, p.env({ SHUVI_WEB: "off" }), [{ tool: "read_link", args: { url: "https://x.com/private/status/1" } }, { tool: "read_link", args: { url: "ftp://example.com/x" } }, { tool: "pass" }]);
    expect(a.toolResults[0]!.result.isError).toBe(true);
    expect(text(a.toolResults[0]!.result)).toStartWith(READ_UNAVAILABLE);
    expect(a.toolResults[1]!.result.isError).toBe(true);
  });
});

// ---- the tool, in a turn ------------------------------------------------------------------------------

describe("read_link in a turn", () => {
  test("the model gets the text and the images, never porchkit's JSON, a file key or the token", async () => {
    const p = porch();
    const db = memDb();
    ownerSays(db, "what does this say");
    const a = await dmTurn(db, p.env({ SHUVI_WEB: "off" }), [{ tool: "read_link", args: { url: X_POST } }, { tool: "read_link", args: { url: REDDIT_POST, comments: 3 } }, { tool: "pass" }]);
    expect(a.calls[0]!.tools).toContain("read_link");
    expect(a.calls[0]!.tools).not.toContain("save_link"); // no computer here
    const post = a.toolResults[0]!.result;
    expect(post.isError ?? false).toBe(false);
    expect(text(post)).toStartWith("Post on X by Example Person (@example)");
    expect(images(post)).toHaveLength(4);
    const all = JSON.stringify(a.toolResults);
    expect(all).not.toContain('"kind":"post"');
    expect(all).not.toContain(p.token);
    expect(all).not.toMatch(/\/files\/[0-9a-f]{32}/);
    expect(text(a.toolResults[1]!.result)).toContain("Replies (3):");
    expect(p.of("/read").map((c) => c.body)).toEqual([{ url: X_POST }, { url: REDDIT_POST, comments: 3 }]);
    expect(a.calls[0]!.systemPrompt).toContain("## Reading links");
  });
});

// ---- web_fetch, and the web section -------------------------------------------------------------------

describe("web_fetch where porchkit reads links", () => {
  test("not offered where porchkit is configured and media is on; the web section says read_link", async () => {
    const p = porch();
    const db = memDb();
    ownerSays(db, "hi");
    const a = await dmTurn(db, p.env({ SHUVI_TAVILY_API_KEY: "tvly-k" }), [{ tool: "pass" }]);
    const tools = a.calls[0]!.tools;
    expect(tools).toContain("web_search");
    expect(tools).not.toContain("web_fetch");
    expect(tools).toContain("read_link");
    expect(a.calls[0]!.systemPrompt).toContain("Use `web_search` to find pages, and `read_link` to read any URL");
    expect(a.calls[0]!.systemPrompt).not.toContain("web_fetch");
  });

  test("without a search key, no web tool is left at all, and the section still points to read_link", async () => {
    const p = porch();
    const db = memDb();
    ownerSays(db, "hi");
    const a = await dmTurn(db, p.env(), [{ tool: "pass" }]);
    expect(a.calls[0]!.tools.filter((t) => t.startsWith("web_"))).toEqual([]);
    expect(a.calls[0]!.systemPrompt).toContain("Use `read_link` to read any URL");
  });

  test("kept where porchkit is not configured, or where the chat's policy leaves media out", async () => {
    const db = memDb();
    ownerSays(db, "hi");
    const a = await dmTurn(db, {}, [{ tool: "pass" }]);
    expect(a.calls[0]!.tools).toContain("web_fetch");
    expect(a.calls[0]!.tools).not.toContain("read_link");
    expect(a.calls[0]!.systemPrompt).toContain("`web_fetch` to read one you have a URL for");

    const p = porch();
    const db2 = memDb();
    ownerSays(db2, "hi");
    const b = await dmTurn(db2, p.env(), [{ tool: "pass" }], policyOf("chats:\n  dm:\n    tools:\n      web: {}\n"));
    expect(b.calls[0]!.tools).toContain("web_fetch");
    expect(b.calls[0]!.tools).not.toContain("read_link");
  });
});

// ---- the prewarm ---------------------------------------------------------------------------------------

describe("prewarm routing", () => {
  const DM = policyOf("");
  // Today's path, without auto-read (its own tests: test/autoread.test.ts).
  const ENV = (p: FakePorchkit) => p.env({ SHUVI_WEB: "off", SHUVI_AUTOREAD: "off" });
  function inbound(db: Db, p: FakePorchkit, ...updates: Parameters<typeof recordBatch>[1]) {
    const caps = enabledCapabilities(ENV(p));
    recordBatch(db, updates, OWNER, { botUsername: "shuvi_test_bot", policy: DM, onRecorded: (events) => capabilityInbound(caps, events, DM, { db, ownerId: OWNER }) });
  }
  const lastSeq = (db: Db) => (db.$client.query("select max(seq) as s from chat_events").get() as { s: number }).s;

  test("every http(s) link goes to /read, whatever its host; the first of each link counts; at most 3; the replied-to text's after the message's own", () => {
    const route = (...t: (string | undefined)[]) => prewarmLinks(t).map((l) => `${l.host}:${l.endpoint}`);
    expect(route("https://news.example.com/a https://www.dcard.tw/f/talk/p/1 https://www.tiktok.com/@a/photo/1")).toEqual(["news.example.com:read", "www.dcard.tw:read", "www.tiktok.com:read"]);
    expect(route("https://youtu.be/abc123def45 https://www.ptt.cc/bbs/a/M.1.html https://mastodon.example/@a/1 https://x.com/a/status/1")).toEqual(["youtu.be:read", "www.ptt.cc:read", "mastodon.example:read"]);
    // The same link twice (however it is written) is one; the text replied to comes after, within the cap.
    expect(route("https://x.com/a/status/1 http://www.x.com/a/status/1#top", "see https://x.com/a/status/1 and https://www.youtube.com/watch?v=abc123def45 https://blog.example/p")).toEqual([
      "x.com:read",
      "www.youtube.com:read",
      "blog.example:read",
    ]);
    expect(route(undefined, "https://t.co/abc")).toEqual(["t.co:read"]);
    expect(route("no links here", undefined)).toEqual([]);
  });

  test("an owner's post link is read at once, speculatively; the line says read_link; read_link joins it and asks again, normally", async () => {
    const p = porch();
    p.readDelayMs = 300;
    const db = memDb();
    inbound(db, p, dmUpdate(upd++, `look ${X_POST} and https://youtu.be/abc123def45`));
    const seq = lastSeq(db);
    const rows = prewarmsOf(db, seq);
    expect(rows.map((r) => [r.n, r.host, r.endpoint])).toEqual([
      [1, "x.com", "read"],
      [2, "youtu.be", "read"],
    ]);
    let readsAtFirstTool = -1;
    const a = await dmTurn(db, ENV(p), [{ run: () => (readsAtFirstTool = p.of("/read").length) }, { tool: "read_link", args: { url: X_POST } }, { tool: "pass" }], DM);
    const prompt = JSON.stringify(a.calls[0]!.prompt);
    expect(prompt).toContain(`(Preparing: #${seq}'s link 1 (x.com) — read_link joins it.)`);
    expect(prompt).toContain(`(Preparing: #${seq}'s link 2 (youtu.be) — read_link joins it.)`);
    expect(readsAtFirstTool).toBe(0); // the prewarms are still in flight at porchkit (300 ms)
    // The prewarms went first and were waited for; then the tool's own read, not speculative.
    const reads = p.of("/read").map((c) => c.body);
    expect(reads).toHaveLength(3);
    expect(reads.slice(0, 2)).toContainEqual({ url: X_POST, speculative: true });
    expect(reads.slice(0, 2)).toContainEqual({ url: "https://youtu.be/abc123def45", speculative: true });
    expect(reads[2]).toEqual({ url: X_POST });
    expect(p.of("/media/probe")).toHaveLength(0);
    expect(images(a.toolResults[0]!.result)).toHaveLength(4);
    const row = prewarmsOf(db, seq)[0]!;
    expect(row.outcome).toBe("ok");
    expect(row.usedTurnId).not.toBeNull();
    expect(prewarmsOf(db, seq)[1]!.usedTurnId).toBeNull(); // the other link was not read by the turn
    // What is kept: the kind, and no URL of the link (nor anything else of the post).
    expect(row.result).toEqual({ kind: "post" });
  });

  test("a finished prewarm: the line says read_link returns at once; a refused one leaves no line", async () => {
    const p = porch();
    const db = memDb();
    inbound(db, p, dmUpdate(upd++, X_POST));
    await Bun.sleep(100);
    const seq = lastSeq(db);
    p.failNext("/read", 429, { error: "rate_limited", reason: "speculative", retry_after: 30, detail: "x: speculative" }, { "retry-after": "30" });
    inbound(db, p, dmUpdate(upd++, REDDIT_POST));
    await Bun.sleep(100);
    const a = await dmTurn(db, ENV(p), [{ tool: "pass" }], DM);
    const prompt = JSON.stringify(a.calls[0]!.prompt);
    expect(prompt).toContain(`(Prepared: #${seq}'s link — read_link returns at once.)`);
    expect(prompt).not.toContain(`#${seq + 1}'s link`);
    expect(prewarmsOf(db, seq + 1)[0]!.outcome).toBe("rate_limited");
  });
});

// ---- save_link ----------------------------------------------------------------------------------------

describe("save_link", () => {
  function world() {
    const p = porch();
    const hangar = new FakeHangar();
    fakes.push(hangar);
    const env = { ...p.env(), ...hangar.env({ SHUVI_WEB: "off", SHUVI_DATA_DIR: mkdtempSync(join(tmpdir(), "shuvi-read-data-")), SHUVI_COMPUTER_READY_SEC: "5" }) };
    return { p, hangar, env };
  }

  test("a long page's whole text and the page as received land in ~/inbox, byte for byte, through the resumable copy", async () => {
    const { p, hangar, env } = world();
    const db = memDb();
    ownerSays(db, "save that article");
    const a = await dmTurn(db, env, [{ tool: "read_link", args: { url: LONG_PAGE } }, { tool: "save_link", args: { url: LONG_PAGE, what: "both" } }, { tool: "pass" }]);
    expect(a.calls[0]!.tools).toContain("save_link");
    expect(text(a.toolResults[0]!.result)).toContain("save_link puts the whole text onto your computer (for the owner).");
    const r = text(a.toolResults[1]!.result);
    expect(a.toolResults[1]!.result.isError ?? false).toBe(false);
    const paths = [...r.matchAll(/~\/(inbox\/[a-z0-9-]+\.(?:md|html))/g)].map((m) => m[1]!);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toMatch(/^inbox\/an-example-article-[0-9a-f]{8}\.md$/);
    expect(r).toStartWith(`Saved on your computer: ~/${paths[0]} (the whole text as markdown,`);
    const dir = hangar.home("shuvi-1001");
    expect(readFileSync(join(dir, paths[0]!), "utf8")).toBe(LONG_MARKDOWN);
    expect(readFileSync(join(dir, paths[1]!), "utf8")).toBe(LONG_HTML);
    expect(p.of("/files/").every((c) => c.authed && c.range)).toBe(true);
  });

  test("a page read whole is written from its text; a post is refused with what to do instead", async () => {
    const { p, hangar, env } = world();
    const db = memDb();
    ownerSays(db, "save it");
    const a = await dmTurn(db, env, [{ tool: "save_link", args: { url: SHORT_PAGE } }, { tool: "save_link", args: { url: SHORT_PAGE, what: "original" } }, { tool: "save_link", args: { url: X_POST } }, { tool: "pass" }]);
    const path = text(a.toolResults[0]!.result).match(/~\/(inbox\/[a-z0-9-]+\.md)/)![1]!;
    expect(path).toMatch(/^inbox\/a-short-note-[0-9a-f]{8}\.md$/);
    expect(readFileSync(join(hangar.home("shuvi-1001"), path), "utf8")).toBe("# A short note\n\nA short note, read whole.\n");
    expect(a.toolResults[1]!.result.isError).toBe(true);
    expect(text(a.toolResults[1]!.result)).toContain("did not keep that page as received");
    expect(text(a.toolResults[2]!.result)).toStartWith("That link is a post: read_link shows it whole");
    expect(p.of("/files/")).toHaveLength(0);
  });

  test("only the owner may ask: in a group, a stranger's call is refused with why and what instead", async () => {
    const { p, env } = world();
    const GROUP = -100777;
    const policy = policyOf(`
chats:
  "${GROUP}":
    title: Friends
    trigger: [mention]
    tools:
      media: {}
      computer: {}
`);
    const { groupUpdate } = await import("./helpers.ts");
    const { allChats } = await import("../src/store/events.ts");
    const db = memDb();
    recordBatch(db, [groupUpdate(upd++, { id: GROUP, title: "Friends" }, { id: 2001, first: "Alice" }, `@shuvi_test_bot save ${LONG_PAGE}`)], OWNER, { botUsername: "shuvi_test_bot", policy });
    const chat = allChats(db).find((c) => c.tgChatId === GROUP)!;
    const turn = claimTurn(db, chat.id)!;
    let a!: ScriptedAdapter;
    await runTurn({ db, turnId: turn.id, home: home(), timeZone: "UTC", ownerId: OWNER, capabilities: enabledCapabilities(env), policy, makeAdapter: (b) => (a = new ScriptedAdapter(b, [{ tool: "read_link", args: { url: LONG_PAGE } }, { tool: "save_link", args: { url: LONG_PAGE } }, { tool: "pass" }])) });
    expect(a.toolResults[0]!.result.isError ?? false).toBe(false);
    expect(text(a.toolResults[1]!.result)).toStartWith("Refused: `save_link` acts for the owner");
    expect(text(a.toolResults[1]!.result)).toEndWith(SAVE_NOTE);
    expect(p.of("/files/")).toHaveLength(0);
  });
});
