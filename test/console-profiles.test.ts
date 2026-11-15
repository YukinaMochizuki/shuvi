import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import { readProfile } from "../src/capabilities/memory/layers.ts";
import { allowedHosts, allowedOrigins } from "../src/console/index.ts";
import { csrfToken, handleConsole, LOGIN_HEADER, type ConsoleDeps } from "../src/console/server.ts";
import { getCard, pressCard, profileCommand } from "../src/control/model-cards.ts";
import type { Db } from "../src/store/db.ts";
import { ensureChat, getChat } from "../src/store/events.ts";
import { setChatProfile } from "../src/store/profiles.ts";
import { memDb, OWNER, ownerChatId, ownerSays } from "./helpers.ts";

/** The console's side of profiles (home.ts, home-data.ts, home-write.ts; capabilities/memory/layers.ts). Made-up names. */

const PORT = 8787;
const HOST = `127.0.0.1:${PORT}`;
const BASE = `http://${HOST}`;
const SECRET = "example-csrf-secret";
const LOGIN = "owner@example.com";
const CSRF = csrfToken(SECRET, `login:${LOGIN}`);
const ENV = { SHUVI_OWNER_ID: String(OWNER), SHUVI_WEB: "off" };

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function deps(db: Db, home: string): ConsoleDeps {
  const c = { listen: HOST };
  return {
    db,
    home,
    timeZone: "UTC",
    dataDir: "/nonexistent",
    allowedHosts: allowedHosts(c, PORT),
    allowedOrigins: allowedOrigins(c, PORT),
    csrfSecret: SECRET,
    users: new Set([LOGIN]),
    prompt: { capabilities: enabledCapabilities(ENV), ownerId: OWNER },
  };
}

async function get(db: Db, home: string, path: string): Promise<{ status: number; text: string }> {
  const res = await handleConsole(deps(db, home), new Request(`${BASE}${path}`, { headers: { [LOGIN_HEADER]: LOGIN } }));
  return { status: res.status, text: await res.text() };
}

function post(db: Db, home: string, path: string, fields: Record<string, string>, o: { origin?: string | null; csrf?: string } = {}): Promise<Response> {
  const body = new URLSearchParams({ csrf: o.csrf ?? CSRF, ...fields });
  const headers: Record<string, string> = { [LOGIN_HEADER]: LOGIN, "content-type": "application/x-www-form-urlencoded" };
  if (o.origin !== null) headers.origin = o.origin ?? BASE;
  return handleConsole(deps(db, home), new Request(`${BASE}${path}`, { method: "POST", headers, body }));
}

/** POST, follow the 303, and read the page it leads to (its one-time result included). */
async function act(db: Db, home: string, path: string, fields: Record<string, string>): Promise<string> {
  const res = await post(db, home, path, fields);
  expect(res.status).toBe(303);
  return (await get(db, home, res.headers.get("location")!)).text;
}

function byHand(home: string, files: Record<string, string | null>, message = "by hand"): void {
  if (!existsSync(join(home, ".git"))) Bun.spawnSync(["git", "-C", home, "init", "-q"]);
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) rmSync(join(home, rel));
    else {
      mkdirSync(dirname(join(home, rel)), { recursive: true });
      writeFileSync(join(home, rel), text);
    }
  }
  const env = { ...process.env, GIT_AUTHOR_NAME: "Someone Else", GIT_AUTHOR_EMAIL: "else@example.com", GIT_COMMITTER_NAME: "Someone Else", GIT_COMMITTER_EMAIL: "else@example.com" };
  Bun.spawnSync(["git", "-C", home, "-c", "commit.gpgsign=false", "add", "-A"], { env });
  Bun.spawnSync(["git", "-C", home, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { env });
}

const git = (home: string, ...args: string[]) => Bun.spawnSync(["git", "-C", home, ...args]).stdout.toString().trim();
const read = (home: string, rel: string) => readFileSync(join(home, rel), "utf8");
const commits = (home: string) => Number(git(home, "rev-list", "--count", "HEAD"));

function world(): { db: Db; home: string; dm: number } {
  const db = memDb();
  ownerSays(db, "hi");
  const home = mkdtempSync(join(tmpdir(), "shuvi-home-"));
  dirs.push(home);
  byHand(home, { "persona/public.md": "You are Example Bot.\n", "directives.md": "- one\n- two\n- three\n", "playbooks/trip.md": "# When a trip is planned\n" });
  return { db, home, dm: ownerChatId(db) };
}

describe("profiles on the Home page", () => {
  test("a new profile: profile.yaml in one commit; the switch lists it; every file inherits", async () => {
    const { db, home } = world();
    const page = await act(db, home, "/home/profile/new", { name: "work", label: "Work hours" });
    expect(readProfile(home, "work")).toEqual({ name: "work", label: "Work hours", hides: [] });
    expect(git(home, "log", "-1", "--format=%an%n%B")).toContain("Edited-In: console");
    expect(page).toContain("Created work");
    expect(page).toContain('<option value="work" selected>Work hours · work</option>');
    expect(page).toContain('<span class="lmark inh">inherits</span>');
    expect(page).not.toContain('<span class="lmark own">');
    // A bad name and a taken one are refused.
    expect(await act(db, home, "/home/profile/new", { name: "Bad Name" })).toContain("cannot name a profile");
    expect(await act(db, home, "/home/profile/new", { name: "work" })).toContain("There is already a profile work");
  });

  test("Make a version copies Base's text with a Base-Commit trailer; its save edits the profile's copy, Base untouched", async () => {
    const { db, home } = world();
    await act(db, home, "/home/profile/new", { name: "work" });
    const inherited = (await get(db, home, "/home?profile=work&file=directives.md")).text;
    expect(inherited).toContain("Inherited from Base.");
    expect(inherited).toContain("Make a work version");
    expect(inherited).toContain("readonly data-readonly");
    // A save to a file the profile has no copy of is refused (it is Base's).
    expect(await act(db, home, "/home/save", { path: "directives.md", profile: "work", base: "x", text: "nope\n" })).toContain("has no version of directives.md of its own");
    const head = git(home, "rev-parse", "HEAD");
    const made = await act(db, home, "/home/profile/fork", { profile: "work", path: "directives.md" });
    expect(made).toContain("Made a work version of directives.md");
    expect(read(home, "profiles/work/directives.md")).toBe("- one\n- two\n- three\n");
    expect(git(home, "log", "-1", "--format=%B")).toContain(`Base-Commit: ${head}`);
    expect(made).toContain("work's own version.");
    expect(made).toContain('<span class="lmark own">own</span>');
    // Saving edits the copy; the history shown is the copy's.
    const base = new Bun.CryptoHasher("sha1").update(`blob ${Buffer.byteLength("- one\n- two\n- three\n")}\0- one\n- two\n- three\n`).digest("hex");
    const saved = await act(db, home, "/home/save", { path: "directives.md", profile: "work", base, text: "- one at work\n- two\n- three\n", note: "work rule" });
    expect(saved).toContain("Saved to work");
    expect(read(home, "profiles/work/directives.md")).toBe("- one at work\n- two\n- three\n");
    expect(read(home, "directives.md")).toBe("- one\n- two\n- three\n");
    expect(saved).toContain("work rule");
    // Remove the version: asked first, then the copy goes (its text stays in history).
    expect((await get(db, home, "/home?profile=work&file=directives.md&remove=1")).text).toContain("Its text stays in this file's history.");
    const removed = await act(db, home, "/home/profile/unfork", { profile: "work", path: "directives.md" });
    expect(removed).toContain("Removed work&#39;s version of directives.md");
    expect(existsSync(join(home, "profiles/work/directives.md"))).toBe(false);
    expect(git(home, "log", "--format=%s", "--", "profiles/work/directives.md")).toContain("work rule");
  });

  test("Base changed since the copy was made: the bar says how much; View shows Base then → now; Apply merges it in, unsaved, and its save records the base", async () => {
    const { db, home } = world();
    await act(db, home, "/home/profile/new", { name: "work" });
    await act(db, home, "/home/profile/fork", { profile: "work", path: "directives.md" });
    byHand(home, { "profiles/work/directives.md": "- one at work\n- two\n- three\n" }, "work edit");
    expect((await get(db, home, "/home?profile=work&file=directives.md")).text).not.toContain("Base changed since");
    byHand(home, { "directives.md": "- one\n- two\n- three, in Base\n" }, "base edit");
    const page = (await get(db, home, "/home?profile=work&file=directives.md")).text;
    expect(page).toContain("Base changed since this version was made");
    expect(page).toContain("(1 change)");
    const view = (await get(db, home, "/home?profile=work&file=directives.md&basediff=1")).text;
    expect(view).toContain("Base's changes since work's version was made");
    expect(view).toContain(", in Base</span>");
    const applied = (await get(db, home, "/home?profile=work&file=directives.md&applybase=1")).text;
    expect(applied).toContain("Base&#39;s 1 change since");
    expect(applied).toContain("- one at work\n- two\n- three, in Base");
    const head = git(home, "rev-parse", "HEAD");
    expect(applied).toContain(`name="basecommit" value="${head}"`);
    // Not saved by loading it.
    expect(read(home, "profiles/work/directives.md")).toBe("- one at work\n- two\n- three\n");
    const base = /name="base" value="([0-9a-f]{40})"/.exec(applied)![1]!;
    await act(db, home, "/home/save", { path: "directives.md", profile: "work", base, basecommit: head, text: "- one at work\n- two\n- three, in Base\n" });
    expect(git(home, "log", "-1", "--format=%B")).toContain(`Base-Commit: ${head}`);
    expect((await get(db, home, "/home?profile=work&file=directives.md")).text).not.toContain("Base changed since");
  });

  test("a restore or an undo of a profile copy records the Base commit its text is based on, so Base's changes show again", async () => {
    const { db, home } = world();
    await act(db, home, "/home/profile/new", { name: "work" });
    const h0 = git(home, "rev-parse", "HEAD");
    await act(db, home, "/home/profile/fork", { profile: "work", path: "directives.md" });
    // A plain edit of the copy: its save carries the Base commit the text is based on now (h0).
    let page = (await get(db, home, "/home?profile=work&file=directives.md")).text;
    expect(page).toContain(`name="basecommit" value="${h0}"`);
    const field = (html: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "";
    await act(db, home, "/home/save", { path: "directives.md", profile: "work", base: field(page, "base"), basecommit: field(page, "basecommit"), text: "- one at work\n- two\n- three\n" });
    const edited = git(home, "rev-parse", "HEAD");
    byHand(home, { "directives.md": "- one\n- two\n- three, in Base\n" }, "base edit");
    expect((await get(db, home, "/home?profile=work&file=directives.md")).text).toContain("(1 change)");
    // Apply and save: up to date.
    page = (await get(db, home, "/home?profile=work&file=directives.md&applybase=1")).text;
    await act(db, home, "/home/save", { path: "directives.md", profile: "work", base: field(page, "base"), basecommit: field(page, "basecommit"), text: "- one at work\n- two\n- three, in Base\n" });
    const applied = git(home, "rev-parse", "HEAD");
    expect((await get(db, home, "/home?profile=work&file=directives.md")).text).not.toContain("Base changed since");
    // Restore the version from before Apply: it is based on h0, and saving it says so.
    page = (await get(db, home, `/home?profile=work&file=directives.md&restore=${edited}`)).text;
    expect(field(page, "basecommit")).toBe(h0);
    await act(db, home, "/home/save", { path: "directives.md", profile: "work", base: field(page, "base"), basecommit: field(page, "basecommit"), text: "- one at work\n- two\n- three\n" });
    expect(git(home, "log", "-1", "--format=%B")).toContain(`Base-Commit: ${h0}`);
    expect((await get(db, home, "/home?profile=work&file=directives.md")).text).toContain("(1 change)");
    // Undo of the Apply commit: based on what was in effect before it (h0) too.
    page = (await get(db, home, `/home?profile=work&file=directives.md&undo=${applied}`)).text;
    expect(field(page, "basecommit")).toBe(h0);
  });

  test("a save of a Base file records no Base-Commit, whatever the form says", async () => {
    const { db, home } = world();
    const page = (await get(db, home, "/home?file=directives.md")).text;
    const base = /name="base" value="([0-9a-f]{40})"/.exec(page)![1]!;
    await act(db, home, "/home/save", { path: "directives.md", base, basecommit: git(home, "rev-parse", "HEAD"), text: "- one\n" });
    expect(read(home, "directives.md")).toBe("- one\n");
    expect(git(home, "log", "-1", "--format=%B")).not.toContain("Base-Commit");
  });

  test("Hide / Unhide covers sticker packs: hidden_packs in profile.yaml, the pack's row hidden", async () => {
    const { db, home } = world();
    byHand(home, { "stickers/ExamplePack.yaml": "pack: ExamplePack\nrole: common\n" });
    await act(db, home, "/home/profile/new", { name: "work" });
    expect((await get(db, home, "/home?profile=work&file=stickers/ExamplePack.yaml")).text).toContain("Hide in work");
    const hidden = await act(db, home, "/home/profile/hide", { profile: "work", path: "stickers/ExamplePack.yaml", hide: "1" });
    expect(readProfile(home, "work")!.hidePacks).toEqual(["ExamplePack"]);
    expect(hidden).toContain("do not see this sticker pack");
    expect(hidden).toContain('<span class="lmark lhidden">hidden</span>');
    // Other writes of profile.yaml keep it.
    await act(db, home, "/home/profile/hide", { profile: "work", path: "playbooks/trip.md", hide: "1" });
    await act(db, home, "/home/profile/rename", { profile: "work", name: "work", label: "Work" });
    expect(readProfile(home, "work")).toEqual({ name: "work", label: "Work", hides: ["trip"], hidePacks: ["ExamplePack"] });
    await act(db, home, "/home/profile/hide", { profile: "work", path: "stickers/ExamplePack.yaml", hide: "0" });
    expect(readProfile(home, "work")!.hidePacks).toBeUndefined();
    expect(await act(db, home, "/home/profile/hide", { profile: "work", path: "stickers/preferences.md", hide: "1" })).toContain("is not a playbook or a sticker pack");
  });

  test("Apply that overlaps the copy's own change opens the conflict pane, saving to the profile", async () => {
    const { db, home } = world();
    await act(db, home, "/home/profile/new", { name: "work" });
    await act(db, home, "/home/profile/fork", { profile: "work", path: "directives.md" });
    byHand(home, { "profiles/work/directives.md": "- one\n- two at work\n- three\n" });
    byHand(home, { "directives.md": "- one\n- two in Base\n- three\n" });
    const page = (await get(db, home, "/home?profile=work&file=directives.md&applybase=1")).text;
    expect(page).toContain("hconflict");
    expect(page).toContain("rewrote lines work&#39;s version also changed");
    expect(page).toContain('<input type="hidden" name="profile" value="work">');
    expect(page).toContain("Save merged to work");
  });

  test("a copy without a Base-Commit trailer counts from the base commit just before its first commit", async () => {
    const { db, home } = world();
    await act(db, home, "/home/profile/new", { name: "work" });
    byHand(home, { "directives.md": "- one\n- two\n- three, earlier\n" }, "base edit before the copy");
    byHand(home, { "profiles/work/directives.md": "- one\n- two\n- three, earlier\n" }, "copy by hand");
    expect((await get(db, home, "/home?profile=work&file=directives.md")).text).not.toContain("Base changed since");
    byHand(home, { "directives.md": "- one\n- two\n- three, later\n" }, "base edit after");
    expect((await get(db, home, "/home?profile=work&file=directives.md")).text).toContain("(1 change)");
  });

  test("an empty own version offers Copy from Base, which loads Base's text unsaved with the base it came from", async () => {
    const { db, home } = world();
    await act(db, home, "/home/profile/new", { name: "work" });
    byHand(home, { "profiles/work/persona/public.md": "" });
    expect((await get(db, home, "/home?profile=work&file=persona/public.md")).text).toContain("Copy from Base");
    const loaded = (await get(db, home, "/home?profile=work&file=persona/public.md&copybase=1")).text;
    expect(loaded).toContain("You are Example Bot.");
    expect(loaded).toContain("Base&#39;s text (");
    expect(loaded).toContain(`name="basecommit" value="${git(home, "rev-parse", "HEAD")}"`);
    expect(read(home, "profiles/work/persona/public.md")).toBe("");
  });

  test("Hide / Unhide a playbook from its bar; a hidden one is struck through and read-only", async () => {
    const { db, home } = world();
    await act(db, home, "/home/profile/new", { name: "work" });
    expect((await get(db, home, "/home?profile=work&file=playbooks/trip.md")).text).toContain("Hide in work");
    const hidden = await act(db, home, "/home/profile/hide", { profile: "work", path: "playbooks/trip.md", hide: "1" });
    expect(readProfile(home, "work")!.hides).toEqual(["trip"]);
    expect(hidden).toContain("Hidden in work.");
    expect(hidden).toContain('<span class="lmark lhidden">hidden</span>');
    await act(db, home, "/home/profile/hide", { profile: "work", path: "playbooks/trip.md", hide: "0" });
    expect(readProfile(home, "work")!.hides).toEqual([]);
  });

  test("Rename and Delete are one commit each; the chats follow a rename and go back to Base on a delete; Duplicate copies", async () => {
    const { db, home, dm } = world();
    const group = ensureChat(db, { id: -100321, kind: "group", title: "Example Book Club" }).id;
    await act(db, home, "/home/profile/new", { name: "work", label: "Work hours" });
    await act(db, home, "/home/profile/fork", { profile: "work", path: "directives.md" });
    await act(db, home, "/home/profile/hide", { profile: "work", path: "playbooks/trip.md", hide: "1" });
    setChatProfile(db, dm, "work");
    setChatProfile(db, group, "work");
    const used = (await get(db, home, "/home?profile=work")).text;
    expect(used).toMatch(/Used by: <a href="\/chats\/\d+">DM · Owner<\/a>, <a href="\/chats\/\d+">Example Book Club<\/a>/);
    let n = commits(home);
    await act(db, home, "/home/profile/rename", { profile: "work", name: "office", label: "Office" });
    expect(commits(home)).toBe(n + 1);
    expect(existsSync(join(home, "profiles/work"))).toBe(false);
    expect(read(home, "profiles/office/directives.md")).toBe("- one\n- two\n- three\n");
    expect(readProfile(home, "office")).toEqual({ name: "office", label: "Office", hides: ["trip"] });
    expect(getChat(db, dm)!.profile).toBe("office");
    expect(getChat(db, group)!.profile).toBe("office");
    expect(git(home, "log", "-1", "--format=%B")).toContain("Base-Commit: ");
    n = commits(home);
    await act(db, home, "/home/profile/duplicate", { profile: "office", name: "office-copy", label: "" });
    expect(commits(home)).toBe(n + 1);
    expect(read(home, "profiles/office-copy/directives.md")).toBe("- one\n- two\n- three\n");
    expect(readProfile(home, "office-copy")!.hides).toEqual(["trip"]);
    const ask = (await get(db, home, "/home?profile=office&panel=delete")).text;
    expect(ask).toContain("These chats go back to Base:");
    n = commits(home);
    await act(db, home, "/home/profile/delete", { profile: "office" });
    expect(commits(home)).toBe(n + 1);
    expect(existsSync(join(home, "profiles/office"))).toBe(false);
    expect(getChat(db, dm)!.profile).toBeNull();
    expect(getChat(db, group)!.profile).toBeNull();
  });

  test("the Preview: the system prompt a chat on the profile would get now, each section with its source", async () => {
    const { db, home, dm } = world();
    await act(db, home, "/home/profile/new", { name: "work" });
    await act(db, home, "/home/profile/fork", { profile: "work", path: "directives.md" });
    byHand(home, { "profiles/work/directives.md": "- work only\n" });
    setChatProfile(db, dm, "work");
    const page = (await get(db, home, "/home?profile=work&view=preview")).text;
    expect(page).toContain("System prompt");
    expect(page).toContain('directives.md<span class="psrc src-profile">· work</span>');
    expect(page).toContain('persona/public.md<span class="psrc src-base">· base</span>');
    expect(page).toContain('capability: speech<span class="psrc src-code">· code</span>');
    expect(page).toContain("- work only");
  });

  test("every profile write is a POST through the write boundary: 405 on GET, the Origin and the token checked", async () => {
    const { db, home } = world();
    expect((await get(db, home, "/home/profile/new")).status).toBe(405);
    expect((await post(db, home, "/home/profile/new", { name: "work" }, { origin: null })).status).toBe(403);
    expect((await post(db, home, "/home/profile/new", { name: "work" }, { origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await post(db, home, "/home/profile/new", { name: "work" }, { csrf: "wrong" })).status).toBe(403);
    expect(readProfile(home, "work")).toBeNull();
  });
});

describe("the control bot's /profile card", () => {
  test("it lists Base and the profiles, the current one marked; a press switches the chat and the card says so", async () => {
    const { db, home, dm } = world();
    await act(db, home, "/home/profile/new", { name: "work", label: "Work hours" });
    profileCommand(db, "update:1", String(dm), (a) => getChat(db, Number(a)), home);
    const card = db.$client.query("select id from control_cards where kind = 'profile'").get() as { id: number };
    let c = getCard(db, card.id)!;
    expect(c.text).toContain("now Base.");
    expect(c.keyboard.map((r) => r[0]!.text)).toEqual(["✓ Base", "work · Work hours", "Cancel"]);
    expect(pressCard(db, c.keyboard[0]![0]!.callback_data, home)).toBe("");
    c = getCard(db, card.id)!;
    expect(c.text).toContain("is already on Base.");
    expect(pressCard(db, c.keyboard[1]![0]!.callback_data, home)).toBe("");
    expect(getChat(db, dm)!.profile).toBe("work");
    c = getCard(db, card.id)!;
    expect(c.status).toBe("closed");
    expect(c.text).toContain("now runs on work, from its next turn.");
    // A second press on the closed card changes nothing.
    expect(pressCard(db, c.keyboard.length ? c.keyboard[0]![0]!.callback_data : `cd:${card.id}:${c.version - 1}:o`, home)).toBe("This card is closed.");
    expect(getChat(db, dm)!.profile).toBe("work");
    profileCommand(db, "update:2", "nope", () => undefined, home);
    expect(db.$client.query("select text from control_messages order by id desc limit 1").get()).toEqual({ text: expect.stringContaining("No chat nope") });
  });
});

describe("the /profile card: superseded, and Cancel", () => {
  test("a newer card for the chat supersedes the open one, whose buttons then do nothing; Cancel closes", async () => {
    const { db, home, dm } = world();
    await act(db, home, "/home/profile/new", { name: "work" });
    profileCommand(db, "update:10", String(dm), (a) => getChat(db, Number(a)), home);
    const first = db.$client.query("select id from control_cards where kind = 'profile' order by id desc").get() as { id: number };
    const oldButtons = getCard(db, first.id)!.keyboard;
    profileCommand(db, "update:11", String(dm), (a) => getChat(db, Number(a)), home);
    expect(getCard(db, first.id)!.status).toBe("closed");
    expect(getCard(db, first.id)!.text).toBe("Superseded by a newer card.");
    expect(pressCard(db, oldButtons[1]![0]!.callback_data, home)).toBe("This card is closed.");
    expect(getChat(db, dm)!.profile).toBeNull();
    const second = db.$client.query("select id from control_cards where kind = 'profile' order by id desc").get() as { id: number };
    const c = getCard(db, second.id)!;
    const cancel = c.keyboard.find((r) => r[0]!.text === "Cancel")![0]!.callback_data;
    expect(pressCard(db, cancel, home)).toBe("");
    expect(getCard(db, second.id)!.status).toBe("closed");
    expect(getCard(db, second.id)!.text).toBe("Cancelled.");
    expect(pressCard(db, c.keyboard[1]![0]!.callback_data, home)).toBe("This card is closed.");
    expect(getChat(db, dm)!.profile).toBeNull();
  });
});
