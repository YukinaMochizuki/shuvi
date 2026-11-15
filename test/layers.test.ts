import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolDef, ToolResult } from "agent-runtime";
import { buildPromptSections, buildSystemPrompt } from "../src/agent/prompt.ts";
import { listPlaybooks } from "../src/agent/playbooks.ts";
import { withCall } from "../src/agent/call-context.ts";
import { chatLayers, type TurnState } from "../src/agent/turn.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import { commitHomeEdit, commitHomeEdits } from "../src/capabilities/memory/home.ts";
import { HomeLayers, profileFile, profileYaml, readProfile } from "../src/capabilities/memory/layers.ts";
import { findStickers } from "../src/capabilities/stickers/find.ts";
import { scopeKeys, syncLibrary } from "../src/capabilities/stickers/library.ts";
import { capabilityTools, type TurnContext } from "../src/capabilities/types.ts";
import type { Db } from "../src/store/db.ts";
import { ensureChat, getChat, recordInbound, type Chat } from "../src/store/events.ts";
import { setChatProfile } from "../src/store/profiles.ts";
import { stickerMeta } from "../src/store/schema.ts";
import { claimTurn } from "../src/store/turns.ts";
import { memDb, OWNER, ownerChatId, ownerSays } from "./helpers.ts";

/**
 * Profiles (capabilities/memory/layers.ts): one resolver for her files, every reader and writer through it, and
 * privacy by the LOGICAL path. Names here are made up.
 */

const ENV = { SHUVI_OWNER_ID: String(OWNER), SHUVI_WEB: "off" };
const GROUP = -100555;

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function newHome(): string {
  const d = mkdtempSync(join(tmpdir(), "shuvi-layers-"));
  dirs.push(d);
  return d;
}

/** Write `files` (path → text) and commit them, as a hand edit. */
function put(home: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(home, rel)), { recursive: true });
    writeFileSync(join(home, rel), text);
  }
  if (!Bun.spawnSync(["git", "-C", home, "rev-parse"]).success) Bun.spawnSync(["git", "-C", home, "init", "-q"]);
  const env = { ...process.env, GIT_AUTHOR_NAME: "Someone", GIT_AUTHOR_EMAIL: "x@example.com", GIT_COMMITTER_NAME: "Someone", GIT_COMMITTER_EMAIL: "x@example.com" };
  Bun.spawnSync(["git", "-C", home, "-c", "commit.gpgsign=false", "add", "-A"], { env });
  Bun.spawnSync(["git", "-C", home, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "by hand"], { env });
}

const read = (home: string, rel: string) => readFileSync(join(home, rel), "utf8");
const git = (home: string, ...args: string[]) => Bun.spawnSync(["git", "-C", home, ...args]).stdout.toString().trim();

/** A home with a base and a profile `work` that overrides directives and memory, adds a playbook and hides one. */
function homeWithWork(): string {
  const home = newHome();
  put(home, {
    "persona/public.md": "You are Example Bot.\n",
    "persona/private.md": "BASE-PRIVATE-PERSONA\n",
    "directives.md": "- base rule\n",
    "memory/private.md": "BASE-MEMORY\n",
    "playbooks/trip.md": "# When a trip is planned\n",
    "playbooks/review.md": "# Every Friday\n",
    [profileFile("work")]: profileYaml({ label: "Work hours", hides: ["trip"] }),
    "profiles/work/directives.md": "- work rule\n",
    "profiles/work/persona/private.md": "WORK-PRIVATE-PERSONA\n",
    "profiles/work/memory/private.md": "WORK-MEMORY\n",
    "profiles/work/playbooks/standup.md": "# Before the standup\n",
  });
  return home;
}

describe("the resolver", () => {
  test("a logical path resolves to the profile's copy when it has one, else the base's; a hidden playbook reads as absent", () => {
    const home = homeWithWork();
    const work = HomeLayers.of(home, "work");
    expect(work.resolve("directives.md")).toEqual({ logical: "directives.md", physical: "profiles/work/directives.md", from: "profile", hidden: false, exists: true });
    expect(work.resolve("persona/public.md")).toMatchObject({ physical: "persona/public.md", from: "base", hidden: false, exists: true });
    expect(work.resolve("playbooks/trip.md")).toMatchObject({ physical: "playbooks/trip.md", from: "base", hidden: true, exists: false });
    expect(work.read("directives.md")).toBe("- work rule\n");
    expect(work.read("persona/public.md")).toBe("You are Example Bot.\n");
    expect(work.read("playbooks/trip.md")).toBeNull();
    // The base alone, and a profile that does not exist, are the base.
    for (const l of [HomeLayers.base(home), HomeLayers.of(home, "gone")]) {
      expect(l.read("directives.md")).toBe("- base rule\n");
      expect(l.read("playbooks/trip.md")).toBe("# When a trip is planned\n");
    }
  });

  test("the playbooks and packs in effect: the base's minus hidden ones, the profile's own added", () => {
    const home = homeWithWork();
    put(home, { "stickers/ExamplePack.yaml": "pack: ExamplePack\nrole: common\n", "profiles/work/stickers/WorkPack.yaml": "pack: WorkPack\nrole: meme\n" });
    const work = HomeLayers.of(home, "work");
    expect(work.playbookFiles().map((f) => [f.logical, f.from])).toEqual([
      ["playbooks/review.md", "base"],
      ["playbooks/standup.md", "profile"],
    ]);
    expect(listPlaybooks(work).map((b) => b.name)).toEqual(["review", "standup"]);
    expect(listPlaybooks(home).map((b) => b.name)).toEqual(["review", "trip"]);
    expect(work.packFiles().map((f) => f.logical)).toEqual(["stickers/ExamplePack.yaml", "stickers/WorkPack.yaml"]);
    expect(HomeLayers.base(home).packFiles().map((f) => f.logical)).toEqual(["stickers/ExamplePack.yaml"]);
  });

  test("where a write goes: the copy in effect; a new file to the base; a hidden playbook to the profile", () => {
    const home = homeWithWork();
    const work = HomeLayers.of(home, "work");
    expect(work.writePath("directives.md")).toBe("profiles/work/directives.md");
    expect(work.writePath("persona/public.md")).toBe("persona/public.md");
    expect(work.writePath("playbooks/new-one.md")).toBe("playbooks/new-one.md");
    expect(work.writePath("playbooks/trip.md")).toBe("profiles/work/playbooks/trip.md");
    expect(HomeLayers.base(home).writePath("directives.md")).toBe("directives.md");
  });
});

/** The tools of a turn just claimed in `chat`, the chat's layers as a turn sets them (agent/turn.ts `chatLayers`). */
function turnTools(db: Db, chat: Chat, home: string) {
  const turn = claimTurn(db, chat.id)!;
  const fresh = getChat(db, chat.id)!;
  const state: TurnState = { chat: fresh, turnId: turn.id, passed: false, stopping: false, n: 0, fromSeq: turn.fromSeq, toSeq: turn.toSeq };
  const ctx: TurnContext = { db, home, layers: chatLayers(db, home, fresh), chat: fresh, turnId: turn.id, timeZone: "UTC", owner: { name: "Owner" }, state };
  const tools = capabilityTools(enabledCapabilities(ENV), ctx).flatMap((b) => b.tools as ToolDef[]);
  const call = async (name: string, args: unknown): Promise<{ text: string; isError: boolean }> => {
    const r: ToolResult = await withCall({ turnId: turn.id, chatId: chat.id, callId: "call-1", tool: name }, () => tools.find((t) => t.name === name)!.handler(args));
    return { text: r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"), isError: !!r.isError };
  };
  return { call, ctx };
}

describe("her tools and her prompt, on a profile", () => {
  test("the prompt carries the profile's copies, each section labelled with its layer; nothing in it names the profile", () => {
    const db = memDb();
    const home = homeWithWork();
    ownerSays(db, "hi");
    const chat = getChat(db, ownerChatId(db))!;
    setChatProfile(db, chat.id, "work");
    const layers = chatLayers(db, home, getChat(db, chat.id)!);
    const sections = buildPromptSections(layers, chat, { name: "Owner" }, enabledCapabilities(ENV), undefined, db);
    const byLabel = Object.fromEntries(sections.map((s) => [s.label, s]));
    expect(byLabel["directives.md"]!.text).toContain("- work rule");
    expect(byLabel["directives.md"]!.layer).toBe("work");
    expect(byLabel["persona/public.md"]!.layer).toBe("base");
    expect(byLabel["memory/private.md"]!.text).toContain("WORK-MEMORY");
    expect(byLabel["playbooks index"]!.text).toContain("`standup`");
    expect(byLabel["playbooks index"]!.text).not.toContain("`trip`");
    const prompt = sections.map((s) => s.text).join("\n\n");
    expect(prompt).not.toMatch(/\bprofiles?\b/i);
    expect(prompt).not.toContain("Work hours");
    // The base, for a chat on none.
    expect(buildSystemPrompt(home, chat, { name: "Owner" })).toContain("- base rule");
  });

  test("her edit lands in the copy in effect, with its trailers; her results speak only of the logical path", async () => {
    const db = memDb();
    const home = homeWithWork();
    ownerSays(db, "change the rules");
    const chat = getChat(db, ownerChatId(db))!;
    setChatProfile(db, chat.id, "work");
    const { call } = turnTools(db, chat, home);
    const read = await call("read_home", { path: "directives.md" });
    expect(read.text).toContain("work rule");
    const edit = await call("edit_home", { path: "directives.md", old_string: "- work rule", new_string: "- work rule, revised", why: "revise" });
    expect(edit.isError).toBe(false);
    expect(edit.text).toContain("Saved directives.md");
    expect(edit.text).not.toContain("profiles/");
    expect(readFileSync(join(home, "profiles/work/directives.md"), "utf8")).toBe("- work rule, revised\n");
    expect(read2(home, "directives.md")).toBe("- base rule\n");
    // The commit is to the physical path, with her trailers: the console's history of that file shows it.
    expect(git(home, "log", "-1", "--format=%B", "--", "profiles/work/directives.md")).toContain("Tool: edit_home");
    // An inherited file is edited in the base; a new file goes to the base.
    expect((await call("read_home", { path: "persona/public.md" })).isError).toBe(false);
    await call("edit_home", { path: "persona/public.md", old_string: "Example Bot", new_string: "Example Bot, kindly", why: "kinder" });
    expect(read2(home, "persona/public.md")).toBe("You are Example Bot, kindly.\n");
    await call("write_home", { path: "playbooks/new-one.md", content: "# A new one\n", why: "new" });
    expect(read2(home, "playbooks/new-one.md")).toBe("# A new one\n");
    // A playbook the profile hides is absent for her; writing it makes the profile's own.
    expect((await call("read_home", { path: "playbooks/trip.md" })).text).toContain("does not exist yet");
    expect((await call("read_playbook", { name: "trip" })).isError).toBe(true);
    await call("write_home", { path: "playbooks/trip.md", content: "# Work trips\n", why: "work trips" });
    expect(read2(home, "profiles/work/playbooks/trip.md")).toBe("# Work trips\n");
    expect(read2(home, "playbooks/trip.md")).toBe("# When a trip is planned\n");
    expect((await call("read_playbook", { name: "trip" })).text).toBe("# Work trips\n");
  });

  test("privacy is the logical path's: a group on a profile that overrides the private files reaches neither", async () => {
    const db = memDb();
    const home = homeWithWork();
    const group = ensureChat(db, { id: GROUP, kind: "group", title: "Example Group" });
    setChatProfile(db, group.id, "work");
    const g = getChat(db, group.id)!;
    const layers = chatLayers(db, home, g);
    const prompt = buildSystemPrompt(layers, g, { name: "Owner" }, enabledCapabilities(ENV), undefined, db);
    expect(prompt).not.toContain("WORK-PRIVATE-PERSONA");
    expect(prompt).not.toContain("WORK-MEMORY");
    expect(prompt).not.toContain("BASE-MEMORY");
    recordInbound(db, { chatId: g.id, kind: "message", payload: { from: { id: OWNER, name: "Owner" }, text: "hi" }, tgUpdateId: 777001, tgMessageId: 1 });
    const { call } = turnTools(db, g, home);
    for (const path of ["persona/private.md", "memory/private.md"]) {
      const r = await call("read_home", { path });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("not available in this chat");
      expect(r.text).not.toContain("WORK-");
    }
  });

  test("a chat set to a profile that no longer exists runs on the base, and the owner is told once", () => {
    const db = memDb();
    const home = homeWithWork();
    ownerSays(db, "hi");
    const chat = getChat(db, ownerChatId(db))!;
    setChatProfile(db, chat.id, "gone");
    const a = chatLayers(db, home, getChat(db, chat.id)!);
    const b = chatLayers(db, home, getChat(db, chat.id)!);
    expect(a.profile).toBeNull();
    expect(b.read("directives.md")).toBe("- base rule\n");
    const alerts = db.$client.query("select text from control_messages where idem_key like 'profile-missing:%'").all() as { text: string }[];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.text).toContain("profile gone, which no longer exists");
  });

  test("the sticker library in effect: a profile's own copy of a pack replaces the base's, for chats on it only", () => {
    const db = memDb();
    const home = homeWithWork();
    const pack = (desc: string) => `pack: ExamplePack\nrole: common\nstickers:\n  - n: 1\n    file_unique_id: u1\n    desc: ${desc}\n    use: hello\n`;
    put(home, { "stickers/ExamplePack.yaml": pack("a base wave"), "profiles/work/stickers/ExamplePack.yaml": pack("a work wave") });
    db.insert(stickerMeta).values({ fileUniqueId: "u1", setName: "ExamplePack", position: 1, fileId: "f1", width: 512, height: 512, format: "static", narrow: false }).run();
    expect(syncLibrary(db, home).errors).toEqual([]);
    const descOf = (layers: HomeLayers) => findStickers(db, { terms: ["hello"], inDm: true, scope: scopeKeys(layers) }).candidates.map((c) => c.desc);
    expect(descOf(HomeLayers.base(home))).toEqual(["a base wave"]);
    expect(descOf(HomeLayers.of(home, "work"))).toEqual(["a work wave"]);
    // Without a scope (a caller from before profiles): the base's.
    expect(findStickers(db, { terms: ["hello"], inDm: true }).candidates.map((c) => c.desc)).toEqual(["a base wave"]);
  });
});

const read2 = (home: string, rel: string) => read(home, rel);

describe("no code path reads one of her files without the resolver", () => {
  // Every reader and writer of an A-layer file takes the chat's layers (capabilities/memory/layers.ts). These read
  // her files: none of them may touch the file system or read home/ by itself.
  const READERS = [
    "src/agent/prompt.ts",
    "src/agent/playbooks.ts",
    "src/capabilities/playbooks/index.ts",
    "src/capabilities/memory/index.ts",
    "src/capabilities/stickers/index.ts",
    "src/capabilities/stickers/find.ts",
  ];
  test("the readers import nothing from node:fs and call no home reader of their own", () => {
    for (const f of READERS) {
      const src = readFileSync(f, "utf8");
      expect({ f, fs: /from "node:fs"/.test(src) }).toEqual({ f, fs: false });
      expect({ f, read: /readHomeFile\(|join\(home|join\(ctx\.home/.test(src) }).toEqual({ f, read: false });
    }
  });

  test("outside the resolver, home.ts and the console (which shows physical files), nothing calls readHomeFile", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && readFileSync(p, "utf8").includes("readHomeFile(")) hits.push(p);
      }
    };
    walk("src");
    expect(hits.filter((p) => !p.startsWith("src/console/") && p !== "src/capabilities/memory/layers.ts" && p !== "src/capabilities/memory/home.ts")).toEqual([]);
  });

  test("the sticker index reads every layer's packs only in syncLibrary, and her tools see only the packs in effect", () => {
    const src = readFileSync("src/capabilities/stickers/index.ts", "utf8");
    for (const fn of ["findStickers(db, {", "listStickers(db, {", "getSticker(db, id", "fileOfPack(db, name", "libraryPacks(db, "]) {
      const at = src.indexOf(fn);
      expect({ fn, found: at >= 0 }).toEqual({ fn, found: true });
      expect({ fn, scoped: /scope|sc\b|sc\)/.test(src.slice(at, src.indexOf("\n", at))) }).toEqual({ fn, scoped: true });
    }
  });

  test("repo-wide: outside the resolver, home.ts, the sticker index and the console, nothing reads a file of hers from home/ directly", () => {
    // The console shows physical files to the owner, and stickers/library.ts `packSources` indexes every layer's
    // packs (each chat then sees only its scope): both by design. Anything else reads through memory/layers.ts.
    const ALLOWED = new Set(["src/capabilities/memory/layers.ts", "src/capabilities/memory/home.ts", "src/capabilities/stickers/library.ts"]);
    const FS = /\b(readFileSync|existsSync|readdirSync|statSync|openSync|createReadStream|readFile|Bun\.file)\(/;
    const HOME = /\b(ctx\.|deps\.|cfg\.|this\.)?home\b|stickersDir\(/;
    const A_LAYER = /["'`/](persona\/|directives\.md|memory\/private|chats\/|playbooks|stickers\/|preferences\.md)/;
    const JOINED = /join\((ctx\.|deps\.|cfg\.)?home\b,\s*["'`](persona|directives|memory|chats|playbooks|stickers)/;
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !ALLOWED.has(p) && !p.startsWith("src/console/")) {
          readFileSync(p, "utf8")
            .split("\n")
            .forEach((line, i) => {
              if (/^\s*(\*|\/\/)/.test(line)) return;
              const read = FS.test(line) && (HOME.test(line) || A_LAYER.test(line)) && !/\.git\b/.test(line);
              if (read || JOINED.test(line)) hits.push(`${p}:${i + 1}: ${line.trim()}`);
            });
        }
      }
    };
    walk("src");
    expect(hits).toEqual([]);
  });

  test("behaviour: her edit lands in the profile's copy in a chat on it, and in Base in a chat on none", async () => {
    const db = memDb();
    const home = homeWithWork();
    ownerSays(db, "edit please");
    const dm = getChat(db, ownerChatId(db))!;
    setChatProfile(db, dm.id, "work");
    const onWork = turnTools(db, dm, home);
    await onWork.call("edit_home", { path: "directives.md", old_string: "- work rule", new_string: "- work rule!", why: "w" });
    expect(read(home, "profiles/work/directives.md")).toBe("- work rule!\n");
    expect(read(home, "directives.md")).toBe("- base rule\n");
    db.$client.run("update turns set status = 'done', ended_at = '2026-01-01T00:00:00Z' where status = 'running'");
    setChatProfile(db, dm.id, null);
    ownerSays(db, "and again");
    const onBase = turnTools(db, getChat(db, dm.id)!, home);
    await onBase.call("edit_home", { path: "directives.md", old_string: "- base rule", new_string: "- base rule!", why: "b" });
    expect(read(home, "directives.md")).toBe("- base rule!\n");
    expect(read(home, "profiles/work/directives.md")).toBe("- work rule!\n");
  });
});

/** Sticker meta for `uid`, so the sticker can be offered (find.ts `offerable`). */
function meta(db: Db, uid: string, set = "ExamplePack", n = 1): void {
  db.insert(stickerMeta).values({ fileUniqueId: uid, setName: set, position: n, fileId: `f-${uid}`, width: 512, height: 512, format: "static", narrow: false }).onConflictDoNothing().run();
}
const packYaml = (pack: string, uid: string, desc: string) => `pack: ${pack}\nrole: common\nstickers:\n  - n: 1\n    file_unique_id: ${uid}\n    desc: ${desc}\n    use: hello\n`;

describe("the sticker library on a profile", () => {
  test("what she reads names logical paths only: two profile files describing one pack", async () => {
    const db = memDb();
    const home = homeWithWork();
    put(home, { "profiles/work/stickers/DupA.yaml": packYaml("Dup", "d1", "one"), "profiles/work/stickers/DupB.yaml": packYaml("Dup", "d2", "two") });
    meta(db, "d1", "Dup");
    meta(db, "d2", "Dup");
    ownerSays(db, "a sticker");
    const dm = getChat(db, ownerChatId(db))!;
    setChatProfile(db, dm.id, "work");
    const { call } = turnTools(db, dm, home);
    const results = [await call("find_sticker", { terms: ["hello"] }), await call("list_stickers", {}), await call("remove_sticker_pack", { name: "Nope", why: "x" })];
    const all = results.map((r) => r.text).join("\n");
    expect(all).toContain("has an error");
    expect(all).toContain("already described in stickers/DupA.yaml");
    expect(all).not.toContain("profiles/");
  });

  test("remove_sticker_pack on a profile's own copy removes it AND hides the pack there; Base and its chats keep it", async () => {
    const db = memDb();
    const home = homeWithWork();
    put(home, { "stickers/ExamplePack.yaml": packYaml("ExamplePack", "u1", "a base wave"), "profiles/work/stickers/ExamplePack.yaml": packYaml("ExamplePack", "u1", "a work wave") });
    meta(db, "u1");
    ownerSays(db, "remove it");
    const dm = getChat(db, ownerChatId(db))!;
    setChatProfile(db, dm.id, "work");
    const group = ensureChat(db, { id: GROUP, kind: "group", title: "Example Group" });
    const { call } = turnTools(db, dm, home);
    expect((await call("find_sticker", { terms: ["hello"] })).text).toContain("a work wave");
    const before = Number(git(home, "rev-list", "--count", "HEAD"));
    const removed = await call("remove_sticker_pack", { name: "ExamplePack", why: "not at work" });
    expect(removed.isError).toBe(false);
    expect(removed.text).toContain("Removed ExamplePack");
    expect(removed.text).not.toContain("profiles/");
    expect(Number(git(home, "rev-list", "--count", "HEAD"))).toBe(before + 1);
    expect(git(home, "show", "--stat", "--format=", "HEAD")).toContain("profile.yaml");
    expect(readProfile(home, "work")!.hidePacks).toEqual(["ExamplePack"]);
    // In this turn and the next, in the chat on work: nothing of the pack.
    expect((await call("find_sticker", { terms: ["hello"] })).text).toContain("No sticker matches");
    expect((await call("find_sticker", { terms: ["ExamplePack/1"] })).text).toContain("No sticker matches");
    expect(findStickers(db, { terms: ["hello"], inDm: true, scope: scopeKeys(HomeLayers.of(home, "work"), db) }).candidates).toEqual([]);
    // Base untouched; a chat on Base still has it.
    expect(read(home, "stickers/ExamplePack.yaml")).toContain("a base wave");
    expect(findStickers(db, { terms: ["hello"], inDm: true, scope: scopeKeys(HomeLayers.base(home), db) }).candidates.map((c) => c.desc)).toEqual(["a base wave"]);
    void group;
  });

  test("the packs in a scope are exactly the files the index reads: .yml and names outside the pack pattern too", () => {
    const db = memDb();
    const home = homeWithWork();
    put(home, { "stickers/Other.yml": packYaml("Other", "o1", "a yml pack"), "stickers/odd-name.yaml": packYaml("OddName", "o2", "an odd name") });
    meta(db, "o1", "Other");
    meta(db, "o2", "OddName");
    syncLibrary(db, home);
    const indexed = (db.$client.query("select file from sticker_packs where file not like 'profiles/%' order by file").all() as { file: string }[]).map((r) => r.file);
    expect(scopeKeys(HomeLayers.base(home)).sort()).toEqual(indexed);
    expect(scopeKeys(HomeLayers.of(home, "work"), db).sort()).toEqual(indexed);
    for (const layers of [HomeLayers.base(home), HomeLayers.of(home, "work")]) {
      expect(findStickers(db, { terms: ["hello"], inDm: true, scope: scopeKeys(layers, db) }).candidates.map((c) => c.desc).sort()).toEqual(["a yml pack", "an odd name"]);
    }
  });

  test("a profile's copy under another file name replaces Base's pack (the overlay is keyed by pack)", () => {
    const db = memDb();
    const home = homeWithWork();
    put(home, { "stickers/ExamplePack.yaml": packYaml("ExamplePack", "u1", "a base wave"), "profiles/work/stickers/WorkWaves.yaml": packYaml("ExamplePack", "u1", "a work wave") });
    meta(db, "u1");
    expect(syncLibrary(db, home).errors).toEqual([]);
    const descs = (l: HomeLayers) => findStickers(db, { terms: ["hello"], inDm: true, scope: scopeKeys(l, db) }).candidates.map((c) => c.desc);
    expect(descs(HomeLayers.of(home, "work"))).toEqual(["a work wave"]);
    expect(descs(HomeLayers.base(home))).toEqual(["a base wave"]);
  });

  test("the stickers section is labelled with the profile when its packs come from the profile", () => {
    const db = memDb();
    const home = homeWithWork();
    put(home, { "stickers/BasePack.yaml": packYaml("BasePack", "b1", "a base wave"), "profiles/work/stickers/WorkPack.yaml": packYaml("WorkPack", "w1", "a work wave") });
    meta(db, "b1", "BasePack");
    meta(db, "w1", "WorkPack");
    syncLibrary(db, home);
    ownerSays(db, "hi");
    const chat = getChat(db, ownerChatId(db))!;
    const label = (layers: HomeLayers) => buildPromptSections(layers, chat, { name: "Owner" }, enabledCapabilities(ENV), undefined, db).find((s) => s.label === "capability: stickers")?.layer;
    expect(label(HomeLayers.of(home, "work"))).toBe("work");
    expect(label(HomeLayers.base(home))).toBe("code");
  });
});

describe("commits", () => {
  test("several files in one commit: new texts are written before anything is removed, and a failing hook puts everything back", () => {
    const home = newHome();
    put(home, { "profiles/work/profile.yaml": "hides: []\n", "profiles/work/directives.md": "- w\n" });
    const changes = [
      { rel: "profiles/work/profile.yaml", content: null },
      { rel: "profiles/work/directives.md", content: null },
      { rel: "profiles/office/profile.yaml", content: "hides: []\n" },
      { rel: "profiles/office/directives.md", content: "- w\n" },
    ];
    const seen: boolean[] = [];
    const before = Number(git(home, "rev-list", "--count", "HEAD"));
    commitHomeEdits(home, changes, "rename", {}, () => {
      // A turn starting here finds the profile under either name.
      seen.push(!!readProfile(home, "work"), !!readProfile(home, "office"));
    });
    expect(seen).toEqual([true, true]);
    expect(Number(git(home, "rev-list", "--count", "HEAD"))).toBe(before + 1);
    expect(readProfile(home, "work")).toBeNull();
    expect(() =>
      commitHomeEdits(home, [{ rel: "profiles/office/directives.md", content: null }, { rel: "profiles/x/profile.yaml", content: "hides: []\n" }], "fails", {}, () => {
        throw new Error("no");
      }),
    ).toThrow("nothing was saved");
    expect(read(home, "profiles/office/directives.md")).toBe("- w\n");
    expect(readProfile(home, "x")).toBeNull();
  });

  test("Base-Commit is a trailer of a commit that says it; her trailers stay", async () => {
    const home = newHome();
    put(home, { "directives.md": "- a\n" });
    const head = git(home, "rev-parse", "HEAD");
    commitHomeEdit(home, "profiles/work/directives.md", "- a\n", "Make a work version", { console: { login: "owner@example.com" }, baseCommit: head });
    const body = git(home, "log", "-1", "--format=%B");
    expect(body).toContain("Edited-In: console");
    expect(body).toContain(`Base-Commit: ${head}`);
    await withCall({ turnId: 7, chatId: 1, callId: "c-1", tool: "edit_home" }, async () => commitHomeEdit(home, "profiles/work/directives.md", "- b\n", "hers"));
    const hers = git(home, "log", "-1", "--format=%B");
    expect(hers).toContain("Turn: 7");
    expect(hers).not.toContain("Base-Commit");
  });
});
