import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textOf, type ToolResult } from "agent-runtime";
import { runTurn } from "../src/agent/turn.ts";
import { TriggerScan, type BotIdentity } from "../src/agent/triggers.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import { capabilityInbound, capabilityTools, withCapabilitySecrets } from "../src/capabilities/types.ts";
import { FETCH_NOTE, mediaSection } from "../src/capabilities/media/index.ts";
import { linksIn, urlKey, videoLinks } from "../src/capabilities/media/links.ts";
import { prewarmsOf } from "../src/capabilities/media/prewarm.ts";
import { SUBS_MAX_CHARS } from "../src/capabilities/media/text.ts";
import { jobWatchPass } from "../src/capabilities/jobs/watch.ts";
import { capabilityJobKinds } from "../src/capabilities/types.ts";
import { turnPrewarms } from "../src/console/queries.ts";
import { describe as describeError, Porchkit, PorchkitError, porchkitConfig, UNAVAILABLE } from "../src/porchkit/client.ts";
import { parsePolicy, resolveChat, type Policy } from "../src/policy/policy.ts";
import { recordBatch } from "../src/server/poller.ts";
import type { Db } from "../src/store/db.ts";
import { allChats, ensureChat, getEvent, recordFrameworkEvent, recordInbound, type Chat } from "../src/store/events.ts";
import { createJob, getJob, runningJobs } from "../src/store/jobs.ts";
import { createSchedule, fireDue } from "../src/store/schedules.ts";
import { mediaPrewarms } from "../src/store/schema.ts";
import { claimTurn, finishTurn } from "../src/store/turns.ts";
import { FakeHangar } from "./fake-hangar.ts";
import { FakePorchkit, TINY_JPEG } from "./fake-porchkit.ts";
import { dmUpdate, groupUpdate, memDb, OWNER, ownerChatId, ownerSays, ScriptedAdapter, type Step } from "./helpers.ts";

const VIDEO = "https://www.youtube.com/watch?v=abc123def45";
const SHORT = "https://youtu.be/abc123def45";
const BOT: BotIdentity = { id: 1, username: "shuvi_test_bot" };
const GROUP = -100888;
const ALICE = 2001;

const fakes: { stop(): void }[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) f.stop();
});

function porch(): FakePorchkit {
  const p = new FakePorchkit();
  fakes.push(p);
  return p;
}

const home = () => {
  const h = mkdtempSync(join(tmpdir(), "shuvi-media-"));
  mkdirSync(join(h, "persona"));
  return h;
};

const policyOf = (text: string): Policy => {
  const r = parsePolicy(text, OWNER);
  if ("error" in r) throw new Error(r.error);
  return r.policy;
};

const GROUP_POLICY = policyOf(`
chats:
  dm:
    tools: all
  "${GROUP}":
    title: Friends
    trigger: [mention]
    tools:
      media: {}
`);

const text = (r: ToolResult) => textOf(r);

async function dmTurn(db: Db, env: Record<string, string>, script: Step[], policy?: Policy): Promise<ScriptedAdapter> {
  const turn = claimTurn(db, ownerChatId(db))!;
  let adapter!: ScriptedAdapter;
  await runTurn({ db, turnId: turn.id, home: home(), timeZone: "UTC", ownerId: OWNER, capabilities: enabledCapabilities(env), ...(policy ? { policy } : {}), makeAdapter: (b) => (adapter = new ScriptedAdapter(b, script)) });
  return adapter;
}

const groupChat = (db: Db): Chat => allChats(db).find((c) => c.tgChatId === GROUP)!;
let upd = 7000;
const inGroup = (from: number, first: string, t: string) => groupUpdate(upd++, { id: GROUP, title: "Friends" }, { id: from, first }, t);


// ---- links --------------------------------------------------------------------------------------------

describe("links", () => {
  test("links are found in text, punctuation after them left off, CJK text around them too", () => {
    expect(linksIn(`look ${SHORT}. and (https://x.com/example/status/1)!`)).toEqual([SHORT, "https://x.com/example/status/1"]);
    expect(linksIn("看這個https://youtu.be/abc123def45很好笑")).toEqual([SHORT]);
    expect(linksIn("https://en.example.org/wiki/Foo_(bar)")).toEqual(["https://en.example.org/wiki/Foo_(bar)"]);
  });

  test("the known hosts, with subdomains; short links as themselves; other sites not", () => {
    const hosts = (t: string) => videoLinks(t).map((l) => l.host);
    expect(hosts(`${VIDEO} https://m.youtube.com/watch?v=x https://vm.tiktok.com/abc https://www.instagram.com/reel/abc`)).toEqual(["www.youtube.com", "m.youtube.com", "vm.tiktok.com"]);
    expect(hosts("https://t.co/abc https://bit.ly/abc https://news.example.com/a https://sub.t.co/x")).toEqual(["t.co", "bit.ly"]);
    expect(hosts("https://threads.net/@x/post/1 https://vimeo.com/1 https://www.bilibili.com/video/BV1 https://x.com/a https://twitter.com/a")).toHaveLength(3);
  });

  test("one key for one link however it is written: scheme, www., case, fragment", () => {
    const k = urlKey(VIDEO);
    expect(urlKey("http://youtube.com/watch?v=abc123def45#t=10")).toBe(k);
    expect(urlKey("www.YouTube.com/watch?v=abc123def45")).toBe(k);
    expect(urlKey(SHORT)).not.toBe(k);
    expect(k).toMatch(/^[0-9a-f]{32}$/);
  });
});

// ---- errors -------------------------------------------------------------------------------------------

describe("porchkit's errors, as the model reads them", () => {
  const e = (status: number, code: string, detail: string, body: Record<string, unknown> = {}, retry?: number) => describeError(new PorchkitError(status, code, detail, body, retry));

  test("429 says it is busy, roughly how long, and not to keep retrying", () => {
    expect(e(429, "rate_limited", "youtube: budget, retry in 180s", { reason: "budget" }, 180)).toBe(
      "Not now: videos are fetched through the owner's home connection, which keeps a request budget for each site, and that budget is used up for now. It should free up in about 3 minutes. Tell whoever asked that it is busy right now and roughly how long, rather than trying again and again.",
    );
    expect(e(429, "rate_limited", "x", { reason: "backoff" }, 45)).toContain("the site asked it to slow down, so it is leaving that site alone for a while. It should free up in about 45 seconds.");
  });

  test("unavailable says a login is never used, and not to guess", () => {
    expect(e(422, "unavailable", "Private video. Sign in if you've been granted access")).toBe(
      "This video can't be had: it is behind a login (members-only, age-restricted or private), or removed or region-locked, and videos are only ever fetched anonymously, without anyone's account. Say so plainly rather than guessing at what it shows. (The site said: Private video. Sign in if you've been granted access.)",
    );
    expect(UNAVAILABLE).toContain("only ever fetched anonymously");
  });

  test("every other code is a plain sentence", () => {
    expect(e(403, "egress_refused", "the address is not public")).toBe("That link does not lead to the public internet (it, a redirect or its address is private), so it was not opened.");
    expect(e(502, "upstream_failed", "the site answered 500.")).toBe("The site (or the downloader) failed: the site answered 500. Trying again later may work.");
    expect(e(504, "upstream_timeout", "no answer within 90s.")).toBe("The site did not answer in time: no answer within 90s. Trying again later may work.");
    expect(e(401, "unauthorized", "no valid bearer token")).toBe("The media service refused shuvi's credentials; the owner needs to check its token. Nothing was fetched.");
    expect(e(400, "bad_request", "a playlist URL; give one video")).toBe("The media service refused the request: a playlist URL; give one video.");
    expect(e(404, "not_found", "no such sheet")).toBe("Not found: no such sheet.");
    expect(e(413, "too_large", "larger than 4GB")).toBe("The video is too large to fetch: larger than 4GB.");
    expect(e(507, "insufficient_storage", "the disk is nearly full")).toBe("The media service has no room for downloads right now: the disk is nearly full. Try again later.");
    expect(e(0, "unreachable", "a ConnectionRefused on the way there")).toBe("The media service could not be reached (a ConnectionRefused on the way there). Nothing was fetched; try again later.");
  });

  test("the client turns each HTTP answer into its error, with Retry-After; the token is sent, never shown", async () => {
    const p = porch();
    const c = new Porchkit(porchkitConfig(p.env())!);
    const fail = async (f: () => Promise<unknown>) => {
      try {
        await f();
      } catch (x) {
        return x as PorchkitError;
      }
      throw new Error("did not fail");
    };
    expect((await fail(() => c.probe("https://www.youtube.com/watch?v=private0001"))).code).toBe("unavailable");
    const busy = await fail(() => c.probe("https://www.youtube.com/watch?v=busy0000001"));
    expect([busy.status, busy.code, busy.retryAfter, busy.body.reason]).toEqual([429, "rate_limited", 180, "budget"]);
    expect((await fail(() => c.probe("http://internal.example/v"))).code).toBe("egress_refused");
    expect((await fail(() => c.subs("https://www.youtube.com/watch?v=broken00001"))).code).toBe("upstream_failed");
    expect((await fail(() => c.subs("https://www.youtube.com/watch?v=slow0000001"))).code).toBe("upstream_timeout");
    const bad = new Porchkit({ ...porchkitConfig(p.env())!, token: "wrong-token-0123456789" });
    expect((await fail(() => bad.probe(VIDEO))).code).toBe("unauthorized");
    const down = new Porchkit({ url: "http://127.0.0.1:1", token: "x".repeat(20), timeoutMs: 2000 });
    const d = await fail(() => down.probe(VIDEO));
    expect(d.code).toBe("unreachable");
    expect(describeError(d)).not.toContain("127.0.0.1");
    expect(p.calls.filter((x) => x.authed).length).toBeGreaterThan(0);
  });
});

// ---- the tools ----------------------------------------------------------------------------------------

describe("video_probe and video_subs", () => {
  test("video_probe: the metadata as compact text", async () => {
    const p = porch();
    const db = memDb();
    ownerSays(db, "what is this video?");
    const a = await dmTurn(db, p.env({ SHUVI_WEB: "off" }), [{ tool: "video_probe", args: { url: VIDEO } }, { tool: "pass" }]);
    expect(text(a.toolResults[0]!.result)).toBe(
      [
        "Title: Example talk",
        "By: Example Channel (@examplechannel) · uploaded 2026-01-01 · youtube",
        "Length: 10:35 (635s) · 1920x1080 · language en",
        "Chapters (2):",
        "  00:00 Intro",
        "  02:00 The main part",
        "Subtitles: en; automatic captions: en (and 157 machine translations, by name) — video_subs reads them",
        "Has: storyboard previews (quick sheets) · video up to 1080p",
      ].join("\n"),
    );
    expect(p.of("/media/probe")[0]!.body).toEqual({ url: VIDEO });
  });

  test("video_probe: an error is a sentence, and the turn goes on", async () => {
    const p = porch();
    const db = memDb();
    ownerSays(db, "and this one?");
    const a = await dmTurn(db, p.env({ SHUVI_WEB: "off" }), [{ tool: "video_probe", args: { url: "https://www.youtube.com/watch?v=private0001" } }, { tool: "video_probe", args: { url: "https://www.youtube.com/watch?v=busy0000001" } }, { tool: "pass" }]);
    expect(a.toolResults[0]!.result.isError).toBe(true);
    expect(text(a.toolResults[0]!.result)).toStartWith(UNAVAILABLE);
    expect(text(a.toolResults[1]!.result)).toContain("It should free up in about 3 minutes.");
  });

  test("video_subs: the lines, capped with where to read on; from / to read a window", async () => {
    const p = porch();
    p.subtitleLines = 400;
    const db = memDb();
    ownerSays(db, "what do they say?");
    const a = await dmTurn(db, p.env({ SHUVI_WEB: "off" }), [
      { tool: "video_subs", args: { url: VIDEO } },
      { tool: "video_subs", args: { url: VIDEO, from: "10:00", to: "10:20" } },
      { tool: "video_subs", args: { url: VIDEO, from: "nope" } },
      { tool: "pass" },
    ]);
    const first = text(a.toolResults[0]!.result);
    expect(first).toStartWith("subtitles (en), 400 line(s):\n[00:00] This is spoken line number 1 of the example talk.");
    expect(first.length).toBeLessThan(SUBS_MAX_CHARS + 300);
    expect(first).toMatch(/\n…\(cut here at 12000 characters, \d+ more line\(s\); call video_subs again with from: "\d\d:\d\d" to read on\)$/);
    expect(text(a.toolResults[1]!.result)).toBe(
      "subtitles (en), 400 line(s), 10:00–10:20:\n[10:00] This is spoken line number 121 of the example talk.\n[10:05] This is spoken line number 122 of the example talk.\n[10:10] This is spoken line number 123 of the example talk.\n[10:15] This is spoken line number 124 of the example talk.",
    );
    expect(text(a.toolResults[2]!.result)).toBe('from is not a time: "nope". Use seconds, mm:ss or hh:mm:ss.');
  });
});

describe("video_sheet", () => {
  test("a link: porchkit's sheets come back as images with the index, never as URLs", async () => {
    const p = porch();
    const db = memDb();
    ownerSays(db, "show me");
    const a = await dmTurn(db, p.env({ SHUVI_WEB: "off" }), [{ tool: "video_sheet", args: { url: VIDEO, count: 16, grid: "4x4" } }, { tool: "pass" }]);
    const r = a.toolResults[0]!.result;
    expect(r.isError).toBeFalsy();
    const parts = r.content;
    expect(parts[0]).toEqual({ type: "text", text: expect.stringContaining("video: Example talk · 10:35") });
    expect((parts[0] as { text: string }).text).toEndWith("sheet-02.jpg: 05:20 05:40 …\n2 sheet(s), in order:");
    expect(parts.filter((x) => x.type === "image")).toEqual([1, 2].map(() => ({ type: "image", data: TINY_JPEG.toString("base64"), mimeType: "image/jpeg" })));
    expect(JSON.stringify(r)).not.toContain("/media/sheets/");
    expect(p.of("/media/sheet")[0]!.body).toEqual({ url: VIDEO, count: 16, grid: "4x4" });
    expect(p.of("/media/sheets/").every((c) => c.authed)).toBe(true);
  });

  test("409 needs_file: the fetch it started is followed, then the sheet is asked for again", async () => {
    const p = porch();
    p.needsFile.add(VIDEO);
    const db = memDb();
    ownerSays(db, "scenes please");
    const a = await dmTurn(db, p.env({ SHUVI_WEB: "off" }), [{ tool: "video_sheet", args: { url: VIDEO, scene: true } }, { tool: "pass" }]);
    expect(a.toolResults[0]!.result.content.filter((x) => x.type === "image")).toHaveLength(2);
    expect(p.calls.filter((c) => c.path === "/media/sheet")).toHaveLength(2);
    expect(p.of("/media/fetch/").length).toBeGreaterThan(0);
  });

  test("409 needs_file, still downloading after the wait: a clear message and what to do meanwhile", async () => {
    const p = porch();
    p.needsFile.add(VIDEO);
    p.fetchSteps = 1000;
    const db = memDb();
    ownerSays(db, "scenes please");
    const a = await dmTurn(db, p.env({ SHUVI_WEB: "off", SHUVI_MEDIA_SHEET_WAIT_SEC: "1" }), [{ tool: "video_sheet", args: { url: VIDEO, scene: true } }, { tool: "pass" }]);
    expect(text(a.toolResults[0]!.result)).toBe(
      'No sheets yet: the video has to be downloaded for that sheet, and its download is under way on the media service (1.6 MB of 3.1 MB so far). Call video_sheet again with the same arguments in a minute or two. Meanwhile video_probe and video_subs work, and source: "storyboard" gives a quick low-resolution sheet where the site has previews.',
    );
  });

  test("arguments are checked as for a file: one spacing, a real window", async () => {
    const p = porch();
    const db = memDb();
    ownerSays(db, "show me");
    const a = await dmTurn(db, p.env({ SHUVI_WEB: "off" }), [{ tool: "video_sheet", args: { url: VIDEO, every: 5, count: 4 } }, { tool: "video_sheet", args: {} }, { tool: "pass" }]);
    expect(text(a.toolResults[0]!.result)).toStartWith("Give one spacing, not every and count");
    expect(text(a.toolResults[1]!.result)).toBe("Give the video's url.");
    expect(p.of("/media/sheet")).toHaveLength(0);
  });
});

// ---- who may ask --------------------------------------------------------------------------------------

describe("who may ask", () => {
  test("in a group, anyone may look (probe, subs, a link's sheet); video_fetch and a file's sheet are refused with why and what instead", async () => {
    const p = porch();
    const hangar = new FakeHangar();
    fakes.push(hangar);
    const env = { ...p.env(), ...hangar.env({ SHUVI_WEB: "off", SHUVI_DATA_DIR: mkdtempSync(join(tmpdir(), "shuvi-media-data-")) }) };
    const policy = policyOf(`
chats:
  "${GROUP}":
    title: Friends
    trigger: [mention]
    tools:
      media: {}
      computer: {}
`);
    const db = memDb();
    recordBatch(db, [inGroup(ALICE, "Alice", `@shuvi_test_bot what is ${VIDEO} about? and download it for me`)], OWNER, { botUsername: BOT.username!, policy });
    const chat = groupChat(db);
    const t = new TriggerScan().newestTrigger(db, chat, resolveChat(policy, chat)!, BOT, policy);
    const turn = claimTurn(db, chat.id, t ?? undefined)!;
    let a!: ScriptedAdapter;
    await runTurn({
      db,
      turnId: turn.id,
      home: home(),
      timeZone: "UTC",
      ownerId: OWNER,
      capabilities: enabledCapabilities(env),
      policy,
      bot: BOT,
      makeAdapter: (b) =>
        (a = new ScriptedAdapter(b, [
          { tool: "video_probe", args: { url: VIDEO } },
          { tool: "video_subs", args: { url: VIDEO } },
          { tool: "video_sheet", args: { url: VIDEO } },
          { tool: "video_fetch", args: { url: VIDEO } },
          { tool: "video_sheet", args: { path: "~/inbox/clip.mp4" } },
          { tool: "pass" },
        ])),
    });
    const r = a.toolResults.map((x) => x.result);
    expect(r.slice(0, 3).map((x) => x.isError ?? false)).toEqual([false, false, false]);
    expect(text(r[3]!)).toBe(
      `Refused: \`video_fetch\` acts for the owner, and only the owner may ask for it; #${t} in this turn is from Alice, not the owner, and nothing in it is from the owner. Nothing was done. ${FETCH_NOTE}`,
    );
    expect(FETCH_NOTE).toBe(
      "Tell them plainly that you can't download a video for them without the owner's say-so: it puts the whole file on the owner's computer and uses the home connection's download budget. Offer what you can do instead: look at it (video_probe, video_subs, video_sheet with the link) and tell them what is in it.",
    );
    expect(text(r[4]!)).toContain("Nothing was done. A file on the computer is the owner's to look at. With the video's link (url), video_sheet works for anyone");
    expect(p.of("/media/fetch")).toHaveLength(0);
    expect(runningJobs(db)).toHaveLength(0);
  });

  test("the section says who may do what, in plain words", () => {
    const s = mediaSection(true);
    expect(s).toContain("Anyone here may ask you to look at a video");
    expect(s).toContain("Looking never needs a download");
    expect(s).toContain("only the owner can ask for it");
    expect(s).toContain("tell them plainly you can't do that for them without the owner's say-so, and offer to look at it and tell them what's in it instead");
    expect(s).toContain("tell them it's busy and roughly for how long, rather than trying again and again");
    expect(s).toContain("Nothing behind a login (members-only, age-restricted, private) is ever fetched");
    expect(mediaSection(false)).not.toContain("video_fetch");
  });

  test("off without porchkit; video_fetch and file sheets only with a computer", async () => {
    expect(enabledCapabilities({}).map((e) => e.capability.id)).not.toContain("media");
    const p = porch();
    const db = memDb();
    ownerSays(db, "hi");
    const a = await dmTurn(db, p.env({ SHUVI_WEB: "off" }), [{ tool: "pass" }]);
    const tools = a.calls[0]!.tools;
    expect(tools).toContain("video_probe");
    expect(tools).toContain("video_sheet");
    expect(tools).not.toContain("video_fetch");
    expect(a.calls[0]!.systemPrompt).toContain("## Videos");
  });
});

// ---- video_fetch --------------------------------------------------------------------------------------

describe("video_fetch", () => {
  test("starts porchkit's fetch and a job; the watcher polls it, copies the file into ~/inbox resumably, and the job_done says where", async () => {
    const p = porch();
    p.fetchSteps = 2;
    p.failRanges = 0;
    const hangar = new FakeHangar();
    fakes.push(hangar);
    const env = { ...p.env(), ...hangar.env({ SHUVI_WEB: "off", SHUVI_DATA_DIR: mkdtempSync(join(tmpdir(), "shuvi-media-data-")), SHUVI_COMPUTER_READY_SEC: "5" }) };
    const db = memDb();
    ownerSays(db, "download it");
    const a = await dmTurn(db, env, [{ tool: "video_fetch", args: { url: VIDEO } }, { tool: "pass" }]);
    const started = text(a.toolResults[0]!.result);
    expect(started).toMatch(/^Started job (\d+) in the background: the media service fetches the video \(it is queued there\), then it is copied into ~\/inbox\/ on your computer\. Its result, with the file's path, comes back to this chat as a job event when it is there\. End your turn meanwhile; do not wait or poll for it\.$/);
    const id = Number(started.match(/job (\d+)/)![1]);
    expect(getJob(db, id)!.ownerAuthorised).toBe(true);
    const kinds = capabilityJobKinds(enabledCapabilities(env));
    // The first poll: still downloading there. A dropped range, then the copy.
    await jobWatchPass({ db, kinds });
    expect(getJob(db, id)!.state).toBe("running");
    expect(getJob(db, id)!.note).toBe("downloading: 1.6 MB of 3.1 MB");
    p.failRanges = 1;
    db.$client.query("update jobs set next_poll_at = ? where id = ?").run(new Date(0).toISOString(), id);
    await jobWatchPass({ db, kinds });
    expect(getJob(db, id)!.state).toBe("running");
    expect(getJob(db, id)!.note).toContain("poll failed");
    db.$client.query("update jobs set next_poll_at = ? where id = ?").run(new Date(0).toISOString(), id);
    await jobWatchPass({ db, kinds });
    const job = getJob(db, id)!;
    expect(job.state).toBe("done");
    const path = `inbox/video-${String(job.spec.key).slice(0, 12)}.mp4`;
    expect(job.result).toBe(`Saved on your computer as ~/${path} (3.1 MB).`);
    const file = join(hangar.home("shuvi-1001"), path);
    expect(new Uint8Array(readFileSync(file))).toEqual(new Uint8Array(p.fileBytes));
    expect(existsSync(`${file}.part-${id}`)).toBe(false);
    // Ranged, in chunks, from where the .part ended.
    expect(p.of("/files/").every((c) => c.authed && /^bytes=\d+-\d+$/.test(c.range ?? ""))).toBe(true);
    const done = db.$client.query("select payload from chat_events where kind = 'job_done'").get() as { payload: string };
    expect(JSON.parse(done.payload).result).toBe(job.result);
  });

  test("a copy picks up from what is already on the computer", async () => {
    const p = porch();
    p.fetchSteps = 1;
    const hangar = new FakeHangar();
    fakes.push(hangar);
    const env = { ...p.env(), ...hangar.env({ SHUVI_WEB: "off", SHUVI_DATA_DIR: mkdtempSync(join(tmpdir(), "shuvi-media-data-")), SHUVI_COMPUTER_READY_SEC: "5" }) };
    const db = memDb();
    ownerSays(db, "download it");
    const a = await dmTurn(db, env, [{ tool: "video_fetch", args: { url: VIDEO, quality: "best" } }, { tool: "pass" }]);
    const id = Number(text(a.toolResults[0]!.result).match(/job (\d+)/)![1]);
    const key = String(getJob(db, id)!.spec.key);
    // Half of it is there already, from a copy cut short.
    const dir = join(hangar.home("shuvi-1001"), "inbox");
    mkdirSync(dir, { recursive: true });
    await Bun.write(join(dir, `video-${key.slice(0, 12)}.mp4.part-${id}`), p.fileBytes.subarray(0, 1_000_000));
    db.$client.query("update jobs set spec = json_set(spec, '$.path', ?, '$.total', ?) where id = ?").run(`inbox/video-${key.slice(0, 12)}.mp4`, p.fileBytes.length, id);
    await jobWatchPass({ db, kinds: capabilityJobKinds(enabledCapabilities(env)) });
    expect(getJob(db, id)!.state).toBe("done");
    expect(p.of("/files/")[0]!.range).toBe(`bytes=1000000-${p.fileBytes.length - 1}`);
    expect(new Uint8Array(readFileSync(join(dir, `video-${key.slice(0, 12)}.mp4`)))).toEqual(new Uint8Array(p.fileBytes));
  });

  test("a failed download fails the job with porchkit's reason, in words", async () => {
    const p = porch();
    const hangar = new FakeHangar();
    fakes.push(hangar);
    const env = { ...p.env(), ...hangar.env({ SHUVI_WEB: "off", SHUVI_DATA_DIR: mkdtempSync(join(tmpdir(), "shuvi-media-data-")) }) };
    const db = memDb();
    ownerSays(db, "download it");
    const a = await dmTurn(db, env, [{ tool: "video_fetch", args: { url: VIDEO } }, { tool: "pass" }]);
    const id = Number(text(a.toolResults[0]!.result).match(/job (\d+)/)![1]);
    const key = String(getJob(db, id)!.spec.key);
    p.failNext(`/media/fetch/${key}`, 200, { key, state: "failed", error: { error: "too_large", detail: "the video is larger than 4GB." } });
    await jobWatchPass({ db, kinds: capabilityJobKinds(enabledCapabilities(env)) });
    expect(getJob(db, id)!.state).toBe("failed");
    expect(getJob(db, id)!.result).toBe("The video is too large to fetch: the video is larger than 4GB.");
  });
});

// ---- prewarm ------------------------------------------------------------------------------------------

describe("prewarm", () => {
  const ENV = (p: FakePorchkit) => p.env({ SHUVI_WEB: "off" });

  function inbound(db: Db, p: FakePorchkit, policy: Policy, ...updates: Parameters<typeof recordBatch>[1]) {
    const caps = enabledCapabilities(ENV(p));
    recordBatch(db, updates, OWNER, { botUsername: BOT.username!, policy, onRecorded: (events) => capabilityInbound(caps, events, policy, { db, ownerId: OWNER }) });
  }

  const DM = policyOf("");

  test("an owner's link is probed at once, speculatively, before the turn's first tool call; the turn's input says it is prepared; video_probe uses it", async () => {
    const p = porch();
    const db = memDb();
    inbound(db, p, DM, dmUpdate(upd++, `what is this ${SHORT}`));
    const seq = db.$client.query("select max(seq) as s from chat_events").get() as { s: number };
    expect(p.of("/media/probe").length).toBe(0); // in flight, not answered yet: the request is on its way
    const rows = prewarmsOf(db, seq.s);
    expect(rows.map((r) => [r.n, r.host, r.urlHash, r.finishedAt])).toEqual([[1, "youtu.be", urlKey(SHORT), null]]);
    await Bun.sleep(100);
    expect(p.of("/media/probe").map((c) => c.body)).toEqual([{ url: SHORT, speculative: true }]);
    let toolSawProbes = -1;
    const a = await dmTurn(db, ENV(p), [{ run: () => (toolSawProbes = p.of("/media/probe").length) }, { tool: "video_probe", args: { url: SHORT } }, { tool: "pass" }], DM);
    expect(toolSawProbes).toBe(1);
    expect(JSON.stringify(a.calls[0]!.prompt)).toContain(`(Prepared: #${seq.s}'s link — video_probe returns at once.)`);
    expect(text(a.toolResults[0]!.result)).toStartWith("Title: Example talk");
    expect(p.of("/media/probe")).toHaveLength(1);
    const row = prewarmsOf(db, seq.s)[0]!;
    expect(row.outcome).toBe("ok");
    expect(row.usedTurnId).not.toBeNull();
    // What is kept of the answer: what video_probe shows, and no URL.
    expect(JSON.stringify(row.result)).not.toMatch(/https?:|youtu\.be|canonical_url|abc123def45/);
    expect(row.result).toMatchObject({ title: "Example talk", duration: 635 });
    expect(turnPrewarms(db, ownerChatId(db), seq.s - 1, seq.s)).toEqual({ used: 1, unused: 0 });
  });

  test("single-flight: a video_probe during the prewarm waits for it instead of asking again", async () => {
    const p = porch();
    p.probeDelayMs = 400;
    const db = memDb();
    inbound(db, p, DM, dmUpdate(upd++, `look ${VIDEO}`));
    const seq = (db.$client.query("select max(seq) as s from chat_events").get() as { s: number }).s;
    const a = await dmTurn(db, ENV(p), [{ tool: "video_probe", args: { url: "http://youtube.com/watch?v=abc123def45" } }, { tool: "pass" }], DM);
    expect(JSON.stringify(a.calls[0]!.prompt)).toContain(`(Preparing: #${seq}'s link — video_probe joins it.)`);
    expect(text(a.toolResults[0]!.result)).toStartWith("Title: Example talk");
    expect(p.of("/media/probe")).toHaveLength(1);
    expect(p.of("/media/probe")[0]!.body.speculative).toBe(true);
  });

  test("a prewarm refused (speculative, 429) leaves no line, and video_probe asks for itself", async () => {
    const p = porch();
    p.failNext("/media/probe", 429, { error: "rate_limited", reason: "speculative", retry_after: 30, detail: "youtube: speculative" }, { "retry-after": "30" });
    const db = memDb();
    inbound(db, p, DM, dmUpdate(upd++, `look ${VIDEO}`));
    await Bun.sleep(100);
    const seq = (db.$client.query("select max(seq) as s from chat_events").get() as { s: number }).s;
    expect(prewarmsOf(db, seq)[0]!.outcome).toBe("rate_limited");
    const a = await dmTurn(db, ENV(p), [{ tool: "video_probe", args: { url: VIDEO } }, { tool: "pass" }], DM);
    expect(JSON.stringify(a.calls[0]!.prompt)).not.toContain("Prepared");
    expect(text(a.toolResults[0]!.result)).toStartWith("Title: Example talk");
    expect(p.of("/media/probe").map((c) => c.body.speculative ?? false)).toEqual([true, false]);
  });

  test("a stranger's link, a site not on the list, or a chat whose policy leaves media out: no prewarm", async () => {
    const p = porch();
    const db = memDb();
    inbound(db, p, GROUP_POLICY, inGroup(ALICE, "Alice", `@shuvi_test_bot ${VIDEO}`));
    inbound(db, p, DM, dmUpdate(upd++, "https://news.example.com/article/1"));
    const noMedia = policyOf("chats:\n  dm:\n    tools:\n      web: {}\n");
    inbound(db, p, noMedia, dmUpdate(upd++, `${VIDEO}`));
    await Bun.sleep(50);
    expect(p.of("/media/probe")).toHaveLength(0);
    expect(db.$client.query("select count(*) as n from media_prewarms").get()).toEqual({ n: 0 });
    // The owner's own link in that group is prewarmed.
    inbound(db, p, GROUP_POLICY, inGroup(OWNER, "Ownerly", `@shuvi_test_bot ${VIDEO}`));
    await Bun.sleep(100);
    expect(p.of("/media/probe")).toHaveLength(1);
  });

  test("a turn that never asks leaves it unused, and the console's turn view says so", async () => {
    const p = porch();
    const db = memDb();
    inbound(db, p, DM, dmUpdate(upd++, `two links ${VIDEO} and https://vimeo.com/123456`));
    await Bun.sleep(100);
    const seq = (db.$client.query("select max(seq) as s from chat_events").get() as { s: number }).s;
    const a = await dmTurn(db, ENV(p), [{ tool: "pass" }], DM);
    const prompt = JSON.stringify(a.calls[0]!.prompt);
    expect(prompt).toContain(`(Prepared: #${seq}'s link 1 (www.youtube.com) — video_probe returns at once.)`);
    expect(prompt).not.toContain("link 2"); // vimeo: not a known video there, so its prewarm failed: no line
    expect(turnPrewarms(db, ownerChatId(db), seq - 1, seq)).toEqual({ used: 0, unused: 2 });
    expect(getEvent(db, seq)).toBeDefined();
  });
});

// ---- the token ----------------------------------------------------------------------------------------

describe("the token", () => {
  test("is redacted from transcripts as [REDACTED:porchkit]", () => {
    const p = porch();
    const redact = withCapabilitySecrets((s) => s, enabledCapabilities(p.env()));
    expect(redact(`Authorization: Bearer ${p.token}`)).toBe("Authorization: Bearer [REDACTED:porchkit]");
  });
});

// ---- review follow-ups --------------------------------------------------------------------------------

describe("video_fetch, twice", () => {
  test("two fetches of one link: the second joins the first; and two jobs of one file never mix their bytes", async () => {
    const p = porch();
    p.fetchSteps = 1;
    p.fileBytes = new Uint8Array(20_000_123).map((_, i) => (i * 7 + 3) & 0xff);
    const hangar = new FakeHangar();
    fakes.push(hangar);
    const env = { ...p.env(), ...hangar.env({ SHUVI_WEB: "off", SHUVI_DATA_DIR: mkdtempSync(join(tmpdir(), "shuvi-media-data-")), SHUVI_COMPUTER_READY_SEC: "5" }) };
    const db = memDb();
    ownerSays(db, "download it, twice");
    const a = await dmTurn(db, env, [{ tool: "video_fetch", args: { url: VIDEO } }, { tool: "video_fetch", args: { url: SHORT } }, { tool: "pass" }]);
    const id1 = Number(text(a.toolResults[0]!.result).match(/job (\d+)/)![1]);
    expect(text(a.toolResults[1]!.result)).toBe(
      `That video is already on its way to your computer as job ${id1}; its result, with the file's path, comes back to this chat as a job event. End your turn meanwhile; do not wait or poll for it.`,
    );
    expect(runningJobs(db).filter((j) => j.kind === "video_fetch")).toHaveLength(1);
    // Two turns racing could still make a second job of the same download: its copy must not mix with the first's.
    const j1 = getJob(db, id1)!;
    const id2 = createJob(db, { chatId: j1.chatId, originSeq: j1.originSeq, kind: "video_fetch", title: "again", report: "poll", spec: { key: j1.spec.key, quality: "low" }, deadline: new Date(Date.now() + 3600_000), ownerAuthorised: true }).job.id;
    const kinds = capabilityJobKinds(enabledCapabilities(env));
    for (let i = 0; i < 5 && runningJobs(db).length; i++) {
      db.$client.query("update jobs set next_poll_at = ?").run(new Date(0).toISOString());
      await jobWatchPass({ db, kinds });
    }
    expect([getJob(db, id1)!.state, getJob(db, id2)!.state]).toEqual(["done", "done"]);
    const path = `inbox/video-${String(j1.spec.key).slice(0, 12)}.mp4`;
    expect(getJob(db, id2)!.result).toBe(getJob(db, id1)!.result);
    const dir = join(hangar.home("shuvi-1001"), "inbox");
    expect(Buffer.from(readFileSync(join(hangar.home("shuvi-1001"), path))).equals(Buffer.from(p.fileBytes))).toBe(true);
    expect(readdirSync(dir).filter((f) => f.includes(".part"))).toEqual([]);
  });

  test("a key that is not porchkit's is refused before it names a file", async () => {
    const p = porch();
    p.failNext("/media/fetch", 200, { key: "../../.bashrc", state: "queued", bytes: 0, total: null });
    const hangar = new FakeHangar();
    fakes.push(hangar);
    const env = { ...p.env(), ...hangar.env({ SHUVI_WEB: "off", SHUVI_DATA_DIR: mkdtempSync(join(tmpdir(), "shuvi-media-data-")) }) };
    const db = memDb();
    ownerSays(db, "download it");
    const a = await dmTurn(db, env, [{ tool: "video_fetch", args: { url: VIDEO } }, { tool: "pass" }]);
    expect(text(a.toolResults[0]!.result)).toBe("The media service answered with a download key that is not its own; nothing was started.");
    expect(runningJobs(db)).toHaveLength(0);
  });
});

describe("a link's schema", () => {
  test("only http(s) links are taken", () => {
    const p = porch();
    const db = memDb();
    const chat = ensureChat(db, { id: OWNER, kind: "private" });
    const media = enabledCapabilities(p.env({ SHUVI_WEB: "off" })).filter((c) => c.capability.id === "media");
    const state = { chat, turnId: 1, passed: false, stopping: false, n: 0, fromSeq: 0, toSeq: 0 };
    const tools = capabilityTools(media, { db, home: home(), chat, turnId: 1, timeZone: "UTC", owner: {}, state }).flatMap((b) => b.tools);
    for (const name of ["video_probe", "video_subs", "video_sheet"]) {
      const shape = z.object(tools.find((t) => t.name === name)!.inputSchema as z.ZodRawShape);
      expect(shape.safeParse({ url: "file:///etc/passwd" }).success).toBe(false);
      expect(shape.safeParse({ url: "javascript:alert(1)" }).success).toBe(false);
      expect(shape.safeParse({ url: VIDEO }).success).toBe(true);
    }
  });
});

describe("a prewarm that never finishes", () => {
  test("lost to a server restart: video_probe waits the join wait only, then asks porchkit itself", async () => {
    const p = porch();
    const db = memDb();
    const seq = ownerSays(db, `look ${VIDEO}`);
    db.insert(mediaPrewarms).values({ chatId: ownerChatId(db), seq, n: 1, urlHash: urlKey(VIDEO), host: "www.youtube.com", startedAt: new Date().toISOString() }).run();
    const t0 = Date.now();
    const a = await dmTurn(db, p.env({ SHUVI_WEB: "off", SHUVI_MEDIA_JOIN_WAIT_SEC: "0.5" }), [{ tool: "video_probe", args: { url: VIDEO } }, { tool: "pass" }]);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(500);
    expect(took).toBeLessThan(3000);
    expect(text(a.toolResults[0]!.result)).toStartWith("Title: Example talk");
    expect(p.of("/media/probe").map((c) => c.body.speculative ?? false)).toEqual([false]);
  });

  test("under load (a slow porchkit): recording returns at once and the turn goes on without waiting", async () => {
    const p = porch();
    p.probeDelayMs = 3000;
    const db = memDb();
    const caps = enabledCapabilities(p.env({ SHUVI_WEB: "off" }));
    const policy = policyOf("");
    const t0 = Date.now();
    recordBatch(db, [dmUpdate(upd++, `look ${VIDEO}`)], OWNER, { policy, onRecorded: (events) => capabilityInbound(caps, events, policy, { db, ownerId: OWNER }) });
    expect(Date.now() - t0).toBeLessThan(200);
    const seq = (db.$client.query("select max(seq) as s from chat_events").get() as { s: number }).s;
    const a = await dmTurn(db, p.env({ SHUVI_WEB: "off" }), [{ tool: "pass" }], policy);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(JSON.stringify(a.calls[0]!.prompt)).toContain(`(Preparing: #${seq}'s link — video_probe joins it.)`);
  });
});

describe("authority, case by case", () => {
  const BOTH = policyOf(`
chats:
  "${GROUP}":
    title: Friends
    trigger: [mention]
    tools:
      media: {}
      computer: {}
`);

  async function groupRun(db: Db, policy: Policy, env: Record<string, string>, script: Step[]): Promise<ScriptedAdapter> {
    const chat = groupChat(db);
    const t = new TriggerScan().newestTrigger(db, chat, resolveChat(policy, chat)!, BOT, policy);
    const turn = claimTurn(db, chat.id, t ?? undefined)!;
    let a!: ScriptedAdapter;
    await runTurn({ db, turnId: turn.id, home: home(), timeZone: "UTC", ownerId: OWNER, capabilities: enabledCapabilities(env), policy, bot: BOT, makeAdapter: (b) => (a = new ScriptedAdapter(b, script)) });
    return a;
  }
  const withHangar = (p: FakePorchkit) => {
    const hangar = new FakeHangar();
    fakes.push(hangar);
    return { ...p.env(), ...hangar.env({ SHUVI_WEB: "off", SHUVI_DATA_DIR: mkdtempSync(join(tmpdir(), "shuvi-media-data-")), SHUVI_COMPUTER_READY_SEC: "5" }) };
  };
  const refusedText = (a: ScriptedAdapter, i: number) => (a.toolResults[i]!.result.isError && text(a.toolResults[i]!.result).startsWith("Refused:") ? text(a.toolResults[i]!.result) : null);

  test("a non-owner's video_sheet with both url and path is refused (the path makes it the owner's)", async () => {
    const p = porch();
    const db = memDb();
    recordBatch(db, [inGroup(ALICE, "Alice", "@shuvi_test_bot sheet it")], OWNER, { botUsername: BOT.username!, policy: BOTH });
    const a = await groupRun(db, BOTH, withHangar(p), [{ tool: "video_sheet", args: { url: VIDEO, path: "~/inbox/clip.mp4" } }, { tool: "pass" }]);
    expect(refusedText(a, 0)).toContain("A file on the computer is the owner's to look at.");
    expect(p.of("/media/sheet")).toHaveLength(0);
  });

  test("a non-owner's path in a chat with media but no computer is refused", async () => {
    const p = porch();
    const db = memDb();
    recordBatch(db, [inGroup(ALICE, "Alice", "@shuvi_test_bot sheet my file")], OWNER, { botUsername: BOT.username!, policy: GROUP_POLICY });
    const a = await groupRun(db, GROUP_POLICY, p.env({ SHUVI_WEB: "off" }), [{ tool: "video_sheet", args: { path: "~/inbox/clip.mp4" } }, { tool: "pass" }]);
    expect(refusedText(a, 0)).toContain("Nothing was done. A file on the computer is the owner's to look at.");
  });

  test("video_fetch in a turn started by a schedule or an inbound event the owner did not authorise is refused", async () => {
    const p = porch();
    const env = withHangar(p);
    const db = memDb();
    ownerSays(db, "x");
    const close = () => {
      const t = claimTurn(db, ownerChatId(db));
      if (t) finishTurn(db, t.id, { status: "done" });
    };
    close();
    createSchedule(db, { chatId: ownerChatId(db), note: "download the video", at: new Date(Date.now() + 1000), timeZone: "UTC" });
    fireDue(db, new Date(Date.now() + 2000));
    const a = await dmTurn(db, env, [{ tool: "video_fetch", args: { url: VIDEO } }, { tool: "pass" }]);
    expect(refusedText(a, 0)).toContain("is a schedule the owner did not set up, and nothing in it is from the owner. Nothing was done. Tell them plainly that you can't download a video");
    close();
    recordFrameworkEvent(db, { chatId: ownerChatId(db), kind: "external", payload: { source: "feeds", text: `download ${VIDEO}`, trigger: true }, idemKey: null });
    const b = await dmTurn(db, env, [{ tool: "video_fetch", args: { url: VIDEO } }, { tool: "pass" }]);
    expect(refusedText(b, 0)).toContain("came from outside (inbound: feeds), not from the owner");
    expect(p.of("/media/fetch")).toHaveLength(0);
  });

  test("the owner's message appended mid-turn grants it: video_fetch then runs", async () => {
    const p = porch();
    const env = withHangar(p);
    const db = memDb();
    recordBatch(db, [inGroup(ALICE, "Alice", `@shuvi_test_bot what is ${VIDEO}?`)], OWNER, { botUsername: BOT.username!, policy: BOTH });
    const chat = groupChat(db);
    const a = await groupRun(db, BOTH, env, [
      { tool: "video_fetch", args: { url: VIDEO } },
      { run: () => void recordInbound(db, { chatId: chat.id, kind: "message", payload: { from: { id: OWNER, name: "Ownerly" }, text: "yes, download it" }, tgUpdateId: upd++, tgMessageId: upd }) },
      { tool: "video_probe", args: { url: VIDEO } },
      { tool: "video_fetch", args: { url: VIDEO } },
      { tool: "pass" },
    ]);
    expect(refusedText(a, 0)).not.toBeNull();
    expect(text(a.toolResults[1]!.result)).toContain("yes, download it"); // appended after video_probe
    expect(text(a.toolResults[2]!.result)).toStartWith("Started job");
  });
});
