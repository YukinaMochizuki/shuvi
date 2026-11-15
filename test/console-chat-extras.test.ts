import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn } from "../src/agent/turn.ts";
import { computerConfig, type ComputerConfig } from "../src/capabilities/computer/config.ts";
import { liveGrants, requestSecret, syncGrants } from "../src/capabilities/computer/secrets.ts";
import { getComputer, updateComputer } from "../src/capabilities/computer/state.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import { cronWords } from "../src/console/chat-extras.ts";
import { diskFacts } from "../src/console/chat-extras-data.ts";
import { allowedHosts, allowedOrigins } from "../src/console/index.ts";
import { csrfToken, handleConsole, LOGIN_HEADER, type ConsoleDeps } from "../src/console/server.ts";
import { answerApproval, getApproval } from "../src/control/approvals.ts";
import type { Db } from "../src/store/db.ts";
import { ensureChat, recordInbound } from "../src/store/events.ts";
import { createSchedule, getSchedule, pauseSchedule } from "../src/store/schedules.ts";
import { jobs } from "../src/store/schema.ts";
import { claimTurn } from "../src/store/turns.ts";
import { FakeHangar } from "./fake-hangar.ts";
import { memDb, OWNER, ownerChatId, ownerSays, ScriptedAdapter, type Step } from "./helpers.ts";

/**
 * A chat's settings page, its last three sections (console/chat-extras*.ts): schedules (cancel, pause, resume),
 * secrets (revoke), the computer (read only), through the console's write boundary. Made-up names and values.
 */

const PORT = 8787;
const HOST = `127.0.0.1:${PORT}`;
const BASE = `http://${HOST}`;
const SECRET_KEY = "example-csrf-secret";
const LOGIN = "owner@example.com";
const CSRF = csrfToken(SECRET_KEY, `login:${LOGIN}`);
/** A secret VALUE: it must never appear on the page. */
const VALUE = "fake-secret-value-0123456789";
const ALICE = { id: 2002, name: "Alice Example" };
const TZ = "Asia/Taipei";

const fakes: { stop(): void }[] = [];
afterEach(() => fakes.splice(0).forEach((f) => f.stop()));

interface World {
  db: Db;
  dm: number;
  fake: FakeHangar;
  cfg: ComputerConfig;
  env: Record<string, string>;
  secretsFile: string;
  dataDir: string;
  computer?: ComputerConfig | null;
  scheduleOff?: boolean;
}

function world(): World {
  const fake = new FakeHangar();
  fakes.push(fake);
  const dataDir = mkdtempSync(join(tmpdir(), "shuvi-cextras-"));
  const secretsFile = join(dataDir, "secrets.yaml");
  writeFileSync(secretsFile, `modal:\n  MODAL_TOKEN: ${VALUE}\n  MODAL_ID: ak-visible-name\n`);
  chmodSync(secretsFile, 0o600);
  const env = fake.env({ SHUVI_WEB: "off", SHUVI_DATA_DIR: dataDir, SHUVI_SECRETS_FILE: secretsFile, SHUVI_COMPUTER_READY_SEC: "5", SHUVI_COMPUTER_INBOX_WAIT_SEC: "5" });
  const db = memDb();
  ownerSays(db, "hi");
  return { db, dm: ownerChatId(db), fake, cfg: computerConfig(env)!, env, secretsFile, dataDir };
}

function deps(w: World): ConsoleDeps {
  const c = { listen: HOST };
  return {
    db: w.db,
    home: join(w.dataDir, "home"),
    timeZone: TZ,
    dataDir: w.dataDir,
    ownerId: OWNER,
    allowedHosts: allowedHosts(c, PORT),
    allowedOrigins: allowedOrigins(c, PORT),
    csrfSecret: SECRET_KEY,
    users: new Set([LOGIN]),
    prompt: { capabilities: enabledCapabilities({ ...w.env, SHUVI_OWNER_ID: String(OWNER), ...(w.scheduleOff ? { SHUVI_SCHEDULES: "off" } : {}) }), ownerId: OWNER },
    ...(w.computer !== undefined ? { computer: w.computer } : {}),
  };
}

const get = (w: World, path: string) => handleConsole(deps(w), new Request(`${BASE}${path}`, { headers: { [LOGIN_HEADER]: LOGIN } }));
const page = async (w: World, path: string) => (await get(w, path)).text();

function post(w: World, path: string, fields: Record<string, string>, o: { origin?: string | null; csrf?: string } = {}): Promise<Response> {
  const body = new URLSearchParams(Object.entries(fields));
  body.set("csrf", o.csrf ?? CSRF);
  const headers: Record<string, string> = { [LOGIN_HEADER]: LOGIN, "content-type": "application/x-www-form-urlencoded" };
  if (o.origin !== null) headers.origin = o.origin ?? BASE;
  return handleConsole(deps(w), new Request(`${BASE}${path}`, { method: "POST", headers, body }));
}

/** POST, check the 303 back to the page's section, and read the page it leads to (its one-time result included). */
async function act(w: World, chatId: number, verb: string, fields: Record<string, string>, section: string): Promise<{ html: string; location: string }> {
  const res = await post(w, `/chats/${chatId}/settings/${verb}`, fields);
  expect(res.status).toBe(303);
  const location = res.headers.get("location")!;
  expect(location).toMatch(new RegExp(`^/chats/${chatId}/settings/automation\\?r=[\\w-]+#${section}$`));
  return { html: await page(w, location), location };
}

/** Run one owner turn in the DM with these tool calls (the computer's tools on the fake Hangar). */
async function turn(w: World, script: Step[]): Promise<void> {
  const claimed = claimTurn(w.db, w.dm)!;
  await runTurn({ db: w.db, turnId: claimed.id, home: join(w.dataDir, "home"), timeZone: "UTC", ownerId: OWNER, capabilities: enabledCapabilities(w.env), makeAdapter: (b) => new ScriptedAdapter(b, script) });
}

/** A live grant of "modal" in the DM, as the owner's answer to her request makes it. */
function grant(w: World, requestedBy?: number): number {
  const r = requestSecret(w.db, w.secretsFile, { chatId: w.dm, profile: "modal", ttl: "1d", reason: "to deploy", ...(requestedBy ? { requestedBy } : {}) });
  if (!("approvalId" in r)) throw new Error(r.error);
  answerApproval(w.db, r.approvalId, 1, { id: OWNER, name: "Owner" });
  syncGrants(w.db);
  return liveGrants(w.db, w.dm)[0]!.id;
}

const section = (html: string, id: string) => html.slice(html.indexOf(`<section class="cs" id="${id}">`), html.indexOf("</section>", html.indexOf(`<section class="cs" id="${id}">`)));

describe("cron in plain words", () => {
  test("what can be said simply is; anything else is null (the page shows the expression)", () => {
    expect(cronWords("0 9 * * 1-5")).toBe("every weekday at 09:00");
    expect(cronWords("30 20 * * 0")).toBe("every Sunday at 20:30");
    expect(cronWords("30 20 * * 7")).toBe("every Sunday at 20:30");
    expect(cronWords("0 8 * * mon,wed,fri")).toBe("every Monday, Wednesday and Friday at 08:00");
    expect(cronWords("0 10 * * 0,6")).toBe("every Saturday and Sunday at 10:00");
    expect(cronWords("15 7 * * *")).toBe("every day at 07:15");
    expect(cronWords("0 9,18 * * *")).toBe("every day at 09:00 and 18:00");
    expect(cronWords("*/15 * * * *")).toBe("every 15 minutes");
    expect(cronWords("5 * * * *")).toBe("every hour at :05");
    expect(cronWords("0 */6 * * *")).toBe("every 6 hours from 00:00");
    expect(cronWords("30 8 1 * *")).toBe("on the 1st of every month at 08:30");
    expect(cronWords("@daily")).toBe("every day at 00:00");
    expect(cronWords("*/20 8-18 * * 1-5")).toBeNull();
    expect(cronWords("0 9 1 1 *")).toBeNull();
    expect(cronWords("0 9 1 * 1")).toBeNull();
  });
});

describe("every write is a POST through the write boundary", () => {
  test("405 on GET, 403 without the Origin or the token; nothing changes", async () => {
    const w = world();
    const s = createSchedule(w.db, { chatId: w.dm, note: "check", cron: "0 9 * * *", timeZone: TZ, ownerAuthorised: true });
    const g = grant(w);
    for (const verb of ["schedule-cancel", "schedule-pause", "schedule-resume", "revoke"]) {
      const fields = { id: String(s.id), grant: String(g) };
      expect((await get(w, `/chats/${w.dm}/settings/${verb}?id=${s.id}`)).status).toBe(405);
      expect((await post(w, `/chats/${w.dm}/settings/${verb}`, fields, { origin: null })).status).toBe(403);
      expect((await post(w, `/chats/${w.dm}/settings/${verb}`, fields, { origin: "https://elsewhere.example" })).status).toBe(403);
      expect((await post(w, `/chats/${w.dm}/settings/${verb}`, fields, { csrf: "wrong" })).status).toBe(403);
    }
    expect(getSchedule(w.db, s.id)!.state).toBe("active");
    expect(liveGrants(w.db, w.dm).map((x) => x.id)).toEqual([g]);
  });
});

describe("schedules", () => {
  test("listed soonest first, paused ones too: in words or as the expression, the next run in the owner's zone, the note, who set it", async () => {
    const w = world();
    const now = new Date();
    const later = createSchedule(w.db, { chatId: w.dm, note: "Look at the price page again.", cron: "*/20 8-18 * * 1-5", timeZone: TZ, ownerAuthorised: true }, now);
    const soon = createSchedule(w.db, { chatId: w.dm, note: "Stretch <now>.", at: new Date(now.getTime() + 60_000), timeZone: TZ, ownerAuthorised: true }, now);
    const weekly = createSchedule(w.db, { chatId: w.dm, note: "Post the reading list.", cron: "30 20 * * 0", timeZone: TZ, authorisedBy: ALICE.id }, now);
    recordInbound(w.db, { chatId: w.dm, kind: "message", payload: { from: ALICE, text: "hello" }, tgUpdateId: 900, tgMessageId: 900 });
    pauseSchedule(w.db, weekly.id, w.dm);
    createSchedule(w.db, { chatId: ensureChat(w.db, { id: -100555, kind: "group", title: "Elsewhere" }).id, note: "not this chat", at: new Date(now.getTime() + 30_000), timeZone: TZ }, now);
    const html = section(await page(w, `/chats/${w.dm}/settings/automation`), "schedules");
    expect(html.indexOf(`id="schedule-${soon.id}"`)).toBeLessThan(html.indexOf(`id="schedule-${later.id}"`));
    expect(html).not.toContain("not this chat");
    expect(html).toContain("Stretch &lt;now&gt;.");
    expect(html).toContain('<span class="mono">*/20 8-18 * * 1-5</span>');
    expect(html).toContain("<b>every Sunday at 20:30</b>");
    expect(html).toContain('<span class="ptag">paused</span>');
    expect(html).toContain("set by an operator, Alice Example");
    expect(html).toContain("set by you");
    expect(html).toContain(`action="/chats/${w.dm}/settings/schedule-resume"`);
    // The next run, in the owner's zone (Asia/Taipei: UTC+8).
    const hhmm = new Date(soon.nextAt!).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
    expect(html).toContain(hhmm);
  });

  test("Cancel asks first, in place; then cancels; its result shows once", async () => {
    const w = world();
    const s = createSchedule(w.db, { chatId: w.dm, note: "check", cron: "0 9 * * 1-5", timeZone: TZ, ownerAuthorised: true });
    const asking = section(await page(w, `/chats/${w.dm}/settings/automation?confirm=schedule:${s.id}`), "schedules");
    expect(asking).toContain(`<b>Cancel schedule #${s.id}?</b>`);
    expect(asking).toContain('role="alertdialog"');
    expect(getSchedule(w.db, s.id)!.state).toBe("active");
    const { html, location } = await act(w, w.dm, "schedule-cancel", { id: String(s.id) }, "schedules");
    expect(getSchedule(w.db, s.id)!.state).toBe("cancelled");
    expect(html).toContain(`Cancelled schedule #${s.id}. She is not woken by it again.`);
    expect(section(html, "schedules")).not.toContain(`id="schedule-${s.id}"`);
    expect(await page(w, location)).not.toContain("Cancelled schedule");
    // Another chat's schedule is not this page's to cancel.
    const other = createSchedule(w.db, { chatId: ensureChat(w.db, { id: -100555, kind: "group", title: "Elsewhere" }).id, note: "x", cron: "0 9 * * *", timeZone: TZ });
    expect((await act(w, w.dm, "schedule-cancel", { id: String(other.id) }, "schedules")).html).toContain(`There is no schedule #${other.id} in this chat.`);
    expect(getSchedule(w.db, other.id)!.state).toBe("active");
  });

  test("Pause, then Resume: from now, saying when it runs next", async () => {
    const w = world();
    const s = createSchedule(w.db, { chatId: w.dm, note: "check", cron: "0 9 * * *", timeZone: TZ, ownerAuthorised: true });
    const paused = await act(w, w.dm, "schedule-pause", { id: String(s.id) }, "schedules");
    expect(getSchedule(w.db, s.id)!.state).toBe("paused");
    expect(paused.html).toContain(`Paused schedule #${s.id}`);
    expect(section(paused.html, "schedules")).toContain('<span class="ptag">paused</span>');
    const resumed = await act(w, w.dm, "schedule-resume", { id: String(s.id) }, "schedules");
    const row = getSchedule(w.db, s.id)!;
    expect(row.state).toBe("active");
    expect(Date.parse(row.nextAt!)).toBeGreaterThan(Date.now());
    expect(resumed.html).toContain(`Resumed schedule #${s.id}: it runs next`);
    expect(resumed.html).toContain("09:00");
  });

  test("Resume of a paused one-off whose time has passed cancels it, and the page says so", async () => {
    const w = world();
    const t0 = new Date(Date.now() - 3 * 3600_000);
    const s = createSchedule(w.db, { chatId: w.dm, note: "tell them the meeting moved", at: new Date(t0.getTime() + 3600_000), timeZone: TZ, ownerAuthorised: true }, t0);
    pauseSchedule(w.db, s.id, w.dm);
    const before = section(await page(w, `/chats/${w.dm}/settings/automation`), "schedules");
    expect(before).toContain("which has passed");
    expect(before).toContain("Resume cancels it rather than run it late");
    const { html } = await act(w, w.dm, "schedule-resume", { id: String(s.id) }, "schedules");
    expect(getSchedule(w.db, s.id)!.state).toBe("cancelled");
    expect(html).toContain(`Schedule #${s.id} was a one-off`);
    expect(html).toContain("it was cancelled, not resumed or run late");
    expect(w.db.$client.query("select count(*) as n from chat_events where kind = 'scheduled'").get()).toEqual({ n: 0 });
  });

  test("with schedules off in this process, the section says so", async () => {
    const w = world();
    w.scheduleOff = true;
    expect(section(await page(w, `/chats/${w.dm}/settings/automation`), "schedules")).toContain("Schedules are off in this process");
  });
});

describe("secrets", () => {
  test("a live grant: the profile, its variable NAMES, time left, who asked; no secret value anywhere in the page", async () => {
    const w = world();
    grant(w);
    grant(w, ALICE.id);
    recordInbound(w.db, { chatId: w.dm, kind: "message", payload: { from: ALICE, text: "hello" }, tgUpdateId: 901, tgMessageId: 901 });
    // A running job whose command carries the value, and an apply whose output does: both shown redacted.
    w.db.$client.run("insert into computers (chat_id, disk, container, created, run_state) values (?, 'home-1001', 'shuvi-1001', 1, 'running')", [w.dm]);
    w.db.insert(jobs).values({ chatId: w.dm, originSeq: 1, kind: "computer", title: "exec deploy", report: "poll", spec: { tool: "exec", command: `MODAL_TOKEN=${VALUE} ./deploy.sh`, startedAt: new Date().toISOString() }, deadline: new Date(Date.now() + 3600_000).toISOString() }).run();
    updateComputer(w.db, w.dm, { lastApply: { at: new Date().toISOString(), ok: false, step: "setup", why: "exit 1", output: `echo ${VALUE}\nfailed` } });
    const html = await page(w, `/chats/${w.dm}/settings/automation`);
    const s = section(html, "secrets");
    expect(s).toContain('<span class="mono">modal</span>');
    expect(s).toContain("MODAL_TOKEN, MODAL_ID");
    expect(s).toMatch(/(23 h 59 min|24 h) left/);
    expect(s).toContain("asked for by you");
    expect(s).toContain("asked for by an operator, Alice Example");
    expect(s).toContain("Revoke now");
    expect(html).toContain("[REDACTED:modal] ./deploy.sh");
    expect(html).toContain(`echo [REDACTED:modal]`);
    expect(html).not.toContain(VALUE);
    expect(html).not.toContain("ak-visible-name");
  });

  test("Revoke now presses the grant's own revoke card: it is answered and edited in the control bot, and the grant ends", async () => {
    const w = world();
    const g = grant(w);
    const card = (w.db.$client.query("select revoke_approval_id as id from secret_grants where id = ?").get(g) as { id: number }).id;
    const { html, location } = await act(w, w.dm, "revoke", { grant: String(g) }, "secrets");
    expect(liveGrants(w.db, w.dm)).toEqual([]);
    expect(getApproval(w.db, card)).toMatchObject({ status: "answered", answer: "revoke" });
    const closed = w.db.$client.query("select text from control_messages where kind = 'approval_closed' and approval_id = ?").get(card) as { text: string };
    expect(closed.text).toContain("Answered: Revoke now");
    expect(html).toContain(`Revoked &quot;modal&quot; (grant #${g})`);
    expect(section(html, "secrets")).toContain("No secret is granted here now.");
    expect(await page(w, location)).not.toContain("Revoked");
    // Again: it has already ended; nothing more is written.
    expect((await act(w, w.dm, "revoke", { grant: String(g) }, "secrets")).html).toContain("had already ended");
    expect(w.db.$client.query("select count(*) as n from control_messages where kind = 'approval_closed' and approval_id = ?").get(card)).toEqual({ n: 1 });
    // Another chat's grant cannot be revoked from this page.
    expect((await act(w, w.dm, "revoke", { grant: "999" }, "secrets")).html).toContain("There is no grant #999 in this chat.");
  });

  test("an unusable secrets file is said plainly; the grants stay listed, names unknown, revocable", async () => {
    const w = world();
    grant(w);
    chmodSync(w.secretsFile, 0o644);
    const html = await page(w, `/chats/${w.dm}/settings/automation`);
    const s = section(html, "secrets");
    expect(s).toContain("The secrets file cannot be used:");
    expect(s).toContain("readable by others (mode 644)");
    expect(s).toContain("variables unknown while the file cannot be used");
    expect(s).toContain("Revoke now");
    expect(html).not.toContain(VALUE);
  });
});

describe("computer (read only)", () => {
  test("not created; running with its idle stop; the disk fetched after the page, labelled as its size; jobs; the last apply", async () => {
    const w = world();
    expect(section(await page(w, `/chats/${w.dm}/settings/automation`), "computer")).toContain("Not created yet");
    ownerSays(w.db, "go");
    await turn(w, [{ tool: "exec", args: { command: "echo hi" } }]);
    // The computer exists now, on the fake Hangar; it runs, idle.
    expect(getComputer(w.db, w.dm)!.created).toBe(true);
    const html = section(await page(w, `/chats/${w.dm}/settings/automation`), "computer");
    expect(html).toContain("<b>running</b>");
    expect(html).toContain("2 vCPU / 2Gi");
    expect(html).toContain("stops when idle at");
    expect(html).toContain("none running");
    expect(html).toContain("not applied since this was recorded");
    // The page does not wait on Hangar: it asks for the disk after it loads.
    expect(html).toContain(`hx-get="/chats/${w.dm}/settings/disk"`);
    const disk = await page(w, `/chats/${w.dm}/settings/disk`);
    expect(disk).toContain("<b>5Gi</b> allocated");
    expect(disk).toContain("up to <b>50Gi</b>");
    expect(disk).toContain("not how much of it is used");
    // Nothing on the section writes.
    expect(html).not.toContain("<form");
  });

  test("a failed apply: its step, its reason and its output; boosted for a job; the jobs running", async () => {
    const w = world();
    w.db.$client.run("insert into computers (chat_id, disk, container, created, run_state) values (?, 'home-1001', 'shuvi-1001', 1, 'running')", [w.dm]);
    const job = w.db.insert(jobs).values({ chatId: w.dm, originSeq: 1, kind: "computer", title: "exec train", report: "poll", spec: { tool: "exec", command: "python train.py --epochs 20", startedAt: new Date(Date.now() - 65 * 60_000).toISOString(), boost: { cpu: "8", memory: "32Gi" } }, deadline: new Date(Date.now() + 3600_000).toISOString() }).returning().get();
    updateComputer(w.db, w.dm, {
      boost: { cpu: "8", memory: "32Gi", jobId: job.id, since: new Date().toISOString() },
      lastApply: { at: new Date().toISOString(), ok: false, step: "apt", why: "exit 100", output: "E: Unable to locate package example-missing" },
    });
    const html = section(await page(w, `/chats/${w.dm}/settings/automation`), "computer");
    expect(html).toContain("<b>boosted</b> at 8 vCPU / 32Gi for job #" + job.id);
    expect(html).toContain(`stays up while job #${job.id} runs`);
    expect(html).toContain("python train.py --epochs 20");
    expect(html).toContain("1 h 5 min");
    expect(html).toContain("failed at its <b>apt</b> step</span> (exit 100)");
    expect(html).toContain("E: Unable to locate package example-missing");
  });

  test("the disk: Hangar slower than the timeout is 'unknown', and the page never waited on it", async () => {
    const w = world();
    w.db.$client.run("insert into computers (chat_id, disk, container, created, run_state) values (?, 'home-1001', 'shuvi-1001', 1, 'stopped')", [w.dm]);
    const slow = Bun.serve({ port: 0, fetch: async () => (await Bun.sleep(2_000), new Response("late")) });
    try {
      const cfg = { ...w.cfg, hangar: { ...w.cfg.hangar, api: `http://127.0.0.1:${slow.port}` } };
      const t0 = Date.now();
      expect(await diskFacts(w.db, cfg, w.dm, 200)).toEqual({ error: "Hangar did not answer within 0.2 s" });
      expect(Date.now() - t0).toBeLessThan(1_500);
      w.computer = cfg;
      const p0 = Date.now();
      const html = section(await page(w, `/chats/${w.dm}/settings/automation`), "computer");
      expect(Date.now() - p0).toBeLessThan(1_500);
      expect(html).toContain("<b>stopped</b>");
      expect(html).toContain("asking Hangar…");
    } finally {
      slow.stop(true);
    }
  });

  test("with the computer off in this process, Computer and Secrets say so", async () => {
    const w = world();
    w.computer = null;
    const html = await page(w, `/chats/${w.dm}/settings/automation`);
    expect(section(html, "computer")).toContain("The computer is off in this process");
    expect(section(html, "secrets")).toContain("The computer is off in this process");
    expect(await page(w, `/chats/${w.dm}/settings/disk`)).toContain("the computer is off in this process");
  });
});
