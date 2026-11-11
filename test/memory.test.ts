import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDef, ToolResult } from "agent-runtime";
import { buildSystemPrompt } from "../src/agent/prompt.ts";
import { runTurn, type TurnState } from "../src/agent/turn.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import { refusal, type HomeAccess } from "../src/capabilities/memory/home.ts";
import { parseBound } from "../src/capabilities/retrieval/logs.ts";
import { capabilityTools, type TurnContext } from "../src/capabilities/types.ts";
import type { Db } from "../src/store/db.ts";
import { enqueueOutbound, ensureChat, getChat, markSent, recordInbound, type Chat } from "../src/store/events.ts";
import { claimTurn } from "../src/store/turns.ts";
import { lastSeq, memDb, OWNER, ownerChatId, ownerSays, ScriptedAdapter } from "./helpers.ts";

const ENV = { SHUVI_OWNER_ID: String(OWNER), SHUVI_WEB: "off" };
const STRANGER = 2002;
const GROUP = -100777;

const newHome = () => mkdtempSync(join(tmpdir(), "shuvi-home-"));
let upd = 10_000;

function says(db: Db, chat: Chat, from: number, text: string): number {
  recordInbound(db, { chatId: chat.id, kind: "message", payload: { from: { id: from, name: from === OWNER ? "Owner" : "Stranger" }, text }, tgUpdateId: upd++, tgMessageId: upd });
  return lastSeq(db);
}
const ownerDm = (db: Db) => getChat(db, ownerChatId(db))!;
const group = (db: Db) => ensureChat(db, { id: GROUP, kind: "group", title: "Friends" });

/** The bot said `text` in `chat`, and it was delivered. */
function botSaid(db: Db, chat: Chat, text: string, delivered = true): number {
  enqueueOutbound(db, { chatId: chat.id, kind: "bot_message", payload: { text }, idemKey: `t:${upd++}` });
  const seq = lastSeq(db);
  if (delivered) markSent(db, seq, upd);
  return seq;
}

/** The tools of a turn that has just been claimed in `chat`, by name. */
function turnTools(db: Db, chat: Chat, home: string, env: Record<string, string> = ENV) {
  const turn = claimTurn(db, chat.id)!;
  const fresh = getChat(db, chat.id)!;
  const state: TurnState = { chat: fresh, turnId: turn.id, passed: false, stopping: false, n: 0, fromSeq: turn.fromSeq, toSeq: turn.toSeq };
  const ctx: TurnContext = { db, home, chat: fresh, turnId: turn.id, timeZone: "UTC", owner: { name: "Owner" }, state };
  const tools = capabilityTools(enabledCapabilities(env), ctx).flatMap((b) => b.tools as ToolDef[]);
  const call = async (name: string, args: unknown): Promise<{ text: string; isError: boolean }> => {
    const r: ToolResult = await tools.find((t) => t.name === name)!.handler(args);
    return { text: r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"), isError: !!r.isError };
  };
  return { call, state };
}

const git = (home: string, ...args: string[]) => Bun.spawnSync(["git", "-C", home, ...args]).stdout.toString().trim();

// ---- the allow-list ---------------------------------------------------------------------------------

describe("home/ allow-list", () => {
  const owner: HomeAccess = { chatTgId: OWNER, ownerDm: true };
  test("the listed files are reachable from the owner's DM", () => {
    for (const p of ["persona/public.md", "persona/private.md", "directives.md", "memory/private.md", `chats/${OWNER}.md`, "playbooks/cooking-rice.md", "stickers/preferences.md", "stickers/ExamplePack.yaml"]) {
      expect(refusal(p, owner)).toBeNull();
    }
  });
  test("anything else is refused, traversal and policy.yaml included", () => {
    for (const p of ["policy.yaml", "../secret.md", "/etc/passwd", "persona/../policy.yaml", "./directives.md", "playbooks/../directives.md", "playbooks/.hidden.md", "playbooks/a/b.md", "chats/12345.md", "stickers/../directives.md", "stickers/a/b.yaml", "stickers/notes.md", "persona\\public.md", "memory/other.md", ".git/config", ""]) {
      expect(refusal(p, owner)).not.toBeNull();
    }
  });
  test("outside the owner's DM the private layers do not exist, nor another chat's notes", () => {
    const grp: HomeAccess = { chatTgId: GROUP, ownerDm: false };
    expect(refusal("persona/private.md", grp)).not.toBeNull();
    expect(refusal("memory/private.md", grp)).not.toBeNull();
    expect(refusal("persona/public.md", grp)).toBeNull();
    expect(refusal("playbooks/x.md", grp)).toBeNull();
    expect(refusal(`chats/${GROUP}.md`, grp)).toBeNull();
    expect(refusal(`chats/${OWNER}.md`, grp)).not.toBeNull();
    // Sticker preferences are in every chat's prompt anyway; a pack file can hold dm_only uses.
    expect(refusal("stickers/preferences.md", grp)).toBeNull();
    expect(refusal("stickers/ExamplePack.yaml", grp)).not.toBeNull();
  });
});

// ---- read_home / edit_home / write_home ------------------------------------------------------------

const commits = (home: string) => Number(git(home, "rev-list", "--count", "HEAD"));
const fileIn = (home: string, path: string) => readFileSync(join(home, path), "utf8");
/** A file the owner put in home/ by hand (not committed). */
function byHand(home: string, path: string, text: string): void {
  mkdirSync(join(home, path, ".."), { recursive: true });
  writeFileSync(join(home, path), text);
}

describe("read_home", () => {
  test("lines are numbered like cat -n, with a note when the view is cut short", async () => {
    const db = memDb();
    const home = newHome();
    byHand(home, "directives.md", "- Always a\n- Always b\n- Never c\n");
    ownerSays(db, "x");
    const { call } = turnTools(db, ownerDm(db), home);
    expect((await call("read_home", { path: "directives.md" })).text).toBe("     1\t- Always a\n     2\t- Always b\n     3\t- Never c");
    expect((await call("read_home", { path: "directives.md", offset: 2, limit: 1 })).text).toBe("     2\t- Always b\n(showing lines 2-2 of 3; call again with offset=3 to read on)");
    expect((await call("read_home", { path: "directives.md", offset: 3 })).text).toBe("     3\t- Never c");
    expect((await call("read_home", { path: "memory/private.md" })).text).toBe("(memory/private.md does not exist yet)");
  });
});

describe("edit_home", () => {
  test("a write and an edit are each a commit by shuvi, with the why as message, returning the diff", async () => {
    const db = memDb();
    const home = newHome();
    ownerSays(db, "remember I like green tea");
    const { call } = turnTools(db, ownerDm(db), home);
    const w = await call("write_home", { path: "memory/private.md", content: "- Likes green tea\n- Lives in Taipei", why: "The owner told me their drink" });
    expect(w.isError).toBe(false);
    const first = git(home, "rev-parse", "--short", "HEAD");
    expect(w.text).toBe(`Saved memory/private.md (commit ${first}, +2 -0). Mention the change in one line in the chat.\n@@ -0,0 +1,2 @@\n+- Likes green tea\n+- Lives in Taipei`);
    expect(fileIn(home, "memory/private.md")).toBe("- Likes green tea\n- Lives in Taipei\n");
    const r = await call("edit_home", { path: "memory/private.md", old_string: "green tea", new_string: "oolong", why: "They switched to oolong" });
    expect(r.isError).toBe(false);
    expect(r.text).toBe(`Saved memory/private.md (commit ${git(home, "rev-parse", "--short", "HEAD")}, +1 -1). Mention the change in one line in the chat.\n@@ -1,2 +1,2 @@\n-- Likes green tea\n+- Likes oolong\n - Lives in Taipei`);
    expect(fileIn(home, "memory/private.md")).toBe("- Likes oolong\n- Lives in Taipei\n");
    expect(git(home, "log", "--format=%an <%ae>|%s")).toBe("shuvi <shuvi@localhost>|They switched to oolong\nshuvi <shuvi@localhost>|The owner told me their drink");
    expect(git(home, "status", "--porcelain")).toBe("");
  });

  test("the diff keeps three lines of context around each change, and is capped", async () => {
    const db = memDb();
    const home = newHome();
    byHand(home, "memory/private.md", Array.from({ length: 20 }, (_, i) => `- fact ${i + 1}`).join("\n") + "\n");
    ownerSays(db, "x");
    const { call } = turnTools(db, ownerDm(db), home);
    const r = await call("edit_home", { path: "memory/private.md", old_string: "- fact 10\n", new_string: "- fact ten\n", why: "w" });
    expect(r.text.split("\n").slice(1)).toEqual(["@@ -7,7 +7,7 @@", " - fact 7", " - fact 8", " - fact 9", "-- fact 10", "+- fact ten", " - fact 11", " - fact 12", " - fact 13"]);
    await call("read_home", { path: "memory/private.md" });
    const big = await call("write_home", { path: "memory/private.md", content: Array.from({ length: 400 }, (_, i) => `- a much longer line of memory number ${i}`).join("\n"), why: "w" });
    expect(big.isError).toBe(false);
    expect(big.text).toContain(", +400 -20)");
    expect(big.text).toEndWith("… (diff cut short)");
    expect(big.text.length).toBeLessThan(3300);
  });

  test("replace_all changes every occurrence, in one commit", async () => {
    const db = memDb();
    const home = newHome();
    ownerSays(db, "x");
    const { call } = turnTools(db, ownerDm(db), home);
    await call("write_home", { path: "directives.md", content: "- Always say cat\n- Never say cat twice", why: "w" });
    const r = await call("edit_home", { path: "directives.md", old_string: "cat", new_string: "dog", replace_all: true, why: "w" });
    expect(r.isError).toBe(false);
    expect(fileIn(home, "directives.md")).toBe("- Always say dog\n- Never say dog twice\n");
    expect(commits(home)).toBe(2);
  });

  test("each refusal says how to fix the call, and saves nothing", async () => {
    const db = memDb();
    const home = newHome();
    ownerSays(db, "x");
    const { call } = turnTools(db, ownerDm(db), home);
    await call("write_home", { path: "directives.md", content: "- Always be brief\n- Always be brief\n- Never shout", why: "w" });
    const absent = await call("edit_home", { path: "directives.md", old_string: "- Never shout loudly", new_string: "x", why: "w" });
    expect(absent.isError).toBe(true);
    expect(absent.text).toContain("`old_string` was not found in directives.md");
    expect(absent.text).toContain("read it again with read_home");
    expect(absent.text).toContain("The closest text is at line 3:\n     3\t- Never shout");
    const ambiguous = await call("edit_home", { path: "directives.md", old_string: "Always be brief", new_string: "b", why: "w" });
    expect(ambiguous.text).toContain("occurs 2 times in directives.md (lines 1, 2)");
    expect(ambiguous.text).toContain("pass replace_all: true");
    const same = await call("edit_home", { path: "directives.md", old_string: "Never shout", new_string: "Never shout", why: "w" });
    expect(same.text).toContain("`old_string` and `new_string` are the same");
    expect((await call("edit_home", { path: "directives.md", old_string: "", new_string: "b", why: "w" })).text).toContain("`old_string` is empty");
    expect((await call("edit_home", { path: "directives.md", old_string: "Never", new_string: "b", edits: [], why: "w" })).text).toContain("not both");
    expect((await call("edit_home", { path: "directives.md", old_string: "Never", why: "w" })).text).toContain("needs both");
    expect((await call("edit_home", { path: "persona/public.md", old_string: "a", new_string: "b", why: "w" })).text).toContain("does not exist yet; create it with write_home");
    for (const r of [absent, ambiguous, same]) expect(r.text).toEndWith("Nothing was saved.");
    expect(fileIn(home, "directives.md")).toBe("- Always be brief\n- Always be brief\n- Never shout\n");
    expect(commits(home)).toBe(1);
  });

  test("a batch is located against the original text and saved as one commit, or not at all", async () => {
    const db = memDb();
    const home = newHome();
    ownerSays(db, "x");
    const { call } = turnTools(db, ownerDm(db), home);
    await call("write_home", { path: "memory/private.md", content: "- a\n- b\n- c", why: "first" });
    // The second edit matches the ORIGINAL "- b", not the one the first edit produced.
    const ok = await call("edit_home", { path: "memory/private.md", edits: [{ old_string: "- a", new_string: "- b" }, { old_string: "- b", new_string: "- B" }], why: "batch" });
    expect(ok.isError).toBe(false);
    expect(fileIn(home, "memory/private.md")).toBe("- b\n- B\n- c\n");
    expect(git(home, "log", "--format=%s")).toBe("batch\nfirst");

    const failing = await call("edit_home", { path: "memory/private.md", edits: [{ old_string: "- c", new_string: "- C" }, { old_string: "- z", new_string: "- Z" }], why: "w" });
    expect(failing.isError).toBe(true);
    expect(failing.text).toStartWith("edits[1]: `old_string` was not found");
    const overlapping = await call("edit_home", { path: "memory/private.md", edits: [{ old_string: "- B\n- c", new_string: "x" }, { old_string: "- c", new_string: "y" }], why: "w" });
    expect(overlapping.text).toContain("edits[0] and edits[1] touch the same text (line 3)");
    expect(overlapping.text).toContain("merge them into one edit");
    expect(fileIn(home, "memory/private.md")).toBe("- b\n- B\n- c\n");
    expect(git(home, "log", "--format=%s")).toBe("batch\nfirst");
  });

  test("a change that leaves the file as it was is 'no change', with no commit", async () => {
    const db = memDb();
    const home = newHome();
    ownerSays(db, "x");
    const { call } = turnTools(db, ownerDm(db), home);
    await call("write_home", { path: "directives.md", content: "- Always a\n", why: "w" });
    const sameWrite = await call("write_home", { path: "directives.md", content: "- Always a", why: "w" }); // the newline is kept, so: identical
    expect(sameWrite.isError).toBe(false);
    expect(sameWrite.text).toBe("No change: directives.md already says exactly that. Nothing was saved.");
    const sameEdit = await call("edit_home", { path: "directives.md", old_string: "a\n", new_string: "a", why: "w" });
    expect(sameEdit.text).toStartWith("No change");
    const swap = await call("edit_home", { path: "directives.md", edits: [{ old_string: "Always", new_string: "x" }, { old_string: "x", new_string: "y" }], why: "w" });
    expect(swap.text).toContain("was not found"); // located against the original: there is no "x" in it
    expect(commits(home)).toBe(1);
  });

  test("a trailing newline is kept as it was; a new file gets one", async () => {
    const db = memDb();
    const home = newHome();
    byHand(home, "directives.md", "- Always a"); // the owner wrote it without one
    ownerSays(db, "x");
    const { call } = turnTools(db, ownerDm(db), home);
    await call("read_home", { path: "directives.md" });
    await call("write_home", { path: "directives.md", content: "- Always b\n", why: "w" });
    expect(fileIn(home, "directives.md")).toBe("- Always b");
    await call("edit_home", { path: "directives.md", old_string: "b", new_string: "c\n- Never d\n", why: "w" });
    expect(fileIn(home, "directives.md")).toBe("- Always c\n- Never d");
    await call("write_home", { path: "persona/public.md", content: "I am shuvi.", why: "w" });
    expect(fileIn(home, "persona/public.md")).toBe("I am shuvi.\n");
    await call("edit_home", { path: "persona/public.md", old_string: "shuvi.\n", new_string: "Shuvi.", why: "w" });
    expect(fileIn(home, "persona/public.md")).toBe("I am Shuvi.\n");
  });
});

describe("write_home", () => {
  test("overwriting a file needs it read in this turn, and unchanged since", async () => {
    const db = memDb();
    const home = newHome();
    byHand(home, "directives.md", "- Always be kind\n");
    byHand(home, "memory/private.md", "");
    ownerSays(db, "x");
    const { call } = turnTools(db, ownerDm(db), home);
    const unread = await call("write_home", { path: "directives.md", content: "- Never be kind", why: "w" });
    expect(unread.isError).toBe(true);
    expect(unread.text).toContain("already has text you have not read in this turn. Read it with read_home first");
    await call("read_home", { path: "directives.md" });
    byHand(home, "directives.md", "- Always be kind\n- Always be brief\n"); // the owner edits it meanwhile
    const stale = await call("write_home", { path: "directives.md", content: "- Never be kind", why: "w" });
    expect(stale.text).toContain("has changed since you read it");
    expect(fileIn(home, "directives.md")).toBe("- Always be kind\n- Always be brief\n");
    await call("read_home", { path: "directives.md" });
    expect((await call("write_home", { path: "directives.md", content: "- Never be kind", why: "w" })).isError).toBe(false);
    expect((await call("write_home", { path: "directives.md", content: "- Never be cruel", why: "w" })).isError).toBe(false); // she has seen what she wrote
    // A new file, or an empty one, has nothing to lose.
    expect((await call("write_home", { path: "memory/private.md", content: "- x", why: "w" })).isError).toBe(false);
    expect((await call("write_home", { path: "playbooks/new-one.md", content: "When x", why: "w" })).isError).toBe(false);
    // A new turn starts with nothing read.
    ownerSays(db, "y");
    const next = capabilityTools(enabledCapabilities(ENV), { db, home, chat: ownerDm(db), turnId: 99, timeZone: "UTC", owner: {}, state: {} as never }).flatMap((b) => b.tools as ToolDef[]);
    const again = await next.find((t) => t.name === "write_home")!.handler({ path: "directives.md", content: "- z", why: "w" });
    expect(again.isError).toBe(true);
  });

  test("this chat's notes: edits and whole writes, seen from the start since the prompt shows them", async () => {
    const db = memDb();
    const home = newHome();
    const g = group(db);
    byHand(home, `chats/${GROUP}.md`, "- They like tea\n");
    says(db, g, STRANGER, "remember we like coffee now");
    const { call } = turnTools(db, g, home);
    const e = await call("edit_chat_notes", { old_string: "tea", new_string: "coffee", why: "they said" });
    expect(e.isError).toBe(false);
    expect(e.text).toContain(`Saved chats/${GROUP}.md`);
    expect(e.text).toContain("-- They like tea\n+- They like coffee");
    expect((await call("edit_chat_notes", { content: "- x", old_string: "a", new_string: "b", why: "w" })).text).toContain("not both");
    expect((await call("edit_chat_notes", { content: "- They like coffee\n- Meet on Fridays", why: "w" })).isError).toBe(false);
    expect(fileIn(home, `chats/${GROUP}.md`)).toBe("- They like coffee\n- Meet on Fridays\n");
    byHand(home, `chats/${GROUP}.md`, "- Changed by hand\n");
    expect((await call("edit_chat_notes", { content: "- y", why: "w" })).text).toContain("has changed since you read it");
    expect(commits(home)).toBe(2);
  });
});

describe("home/ edits and failures", () => {

  test("a failed commit leaves the file as it was", async () => {
    const db = memDb();
    const home = newHome();
    ownerSays(db, "x");
    const { call } = turnTools(db, ownerDm(db), home);
    await call("write_home", { path: "directives.md", content: "- Always be brief.", why: "first" });
    writeFileSync(join(home, ".git/index.lock"), ""); // another git process holds the index: add/commit fail
    const changed = await call("write_home", { path: "directives.md", content: "- Never be brief.", why: "second" });
    expect(changed.isError).toBe(true);
    expect(changed.text).toContain("unchanged");
    expect(readFileSync(join(home, "directives.md"), "utf8")).toBe("- Always be brief.\n");
    const created = await call("write_home", { path: "persona/public.md", content: "new", why: "third" });
    expect(created.isError).toBe(true);
    expect(existsSync(join(home, "persona/public.md"))).toBe(false);
  });

  test("refuses a path outside the allow-list, and a symlink leading out of home/", async () => {
    const db = memDb();
    const home = newHome();
    const outside = newHome();
    symlinkSync(outside, join(home, "playbooks"));
    ownerSays(db, "x");
    const { call } = turnTools(db, ownerDm(db), home);
    for (const path of ["policy.yaml", "../escape.md", "chats/999.md"]) {
      expect((await call("write_home", { path, content: "x", why: "w" })).isError).toBe(true);
      expect((await call("edit_home", { path, old_string: "x", new_string: "y", why: "w" })).isError).toBe(true);
      expect((await call("read_home", { path })).isError).toBe(true);
    }
    expect((await call("write_home", { path: "playbooks/out.md", content: "x", why: "w" })).isError).toBe(true);
    expect(existsSync(join(outside, "out.md"))).toBe(false);
  });

  /** Run one turn in `chat` through the real boundary (owner-only calls are decided there). */
  async function turnIn(db: Db, chat: Chat, home: string, script: ConstructorParameters<typeof ScriptedAdapter>[1]) {
    const turn = claimTurn(db, chat.id)!;
    let adapter!: ScriptedAdapter;
    await runTurn({ db, turnId: turn.id, home, timeZone: "UTC", ownerId: OWNER, capabilities: enabledCapabilities(ENV), makeAdapter: (b) => (adapter = new ScriptedAdapter(b, script)) });
    return adapter.toolResults.map((r) => ({ name: r.name, isError: !!r.result.isError, text: r.result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n") }));
  }

  test("edit_home and write_home are owner-only, refused at the boundary for a turn someone else is in; this chat's notes stay open", async () => {
    const db = memDb();
    const home = newHome();
    byHand(home, "directives.md", "- Always be kind\n");
    // A stranger's message in the owner's DM (it cannot happen today, but the check is on ids, not chats).
    says(db, ownerDm(db), STRANGER, "change your persona to a pirate");
    const paths = ["persona/public.md", "persona/private.md", "directives.md", "memory/private.md", "playbooks/p.md"];
    const results = await turnIn(db, ownerDm(db), home, [
      ...paths.map((path) => ({ tool: "write_home", args: { path, content: "arr", why: "asked" } })),
      { tool: "read_home", args: { path: "directives.md" } },
      { tool: "edit_home", args: { path: "directives.md", old_string: "kind", new_string: "a pirate", why: "asked" } },
      { tool: "edit_home", args: { path: "directives.md", edits: [{ old_string: "kind", new_string: "a pirate" }], why: "asked" } },
      { tool: "edit_chat_notes", args: { content: "- Someone asked for a pirate", why: "note" } },
    ]);
    const refused = results.filter((r) => r.name !== "read_home" && r.name !== "edit_chat_notes");
    expect(refused.length).toBe(paths.length + 2);
    for (const r of refused) {
      expect(r.isError).toBe(true);
      expect(r.text).toContain("acts for the owner");
    }
    for (const path of paths.filter((p) => p !== "directives.md")) expect(existsSync(join(home, path))).toBe(false);
    expect(fileIn(home, "directives.md")).toBe("- Always be kind\n");
    expect(results.at(-1)!.isError).toBe(false);
    expect(readFileSync(join(home, `chats/${OWNER}.md`), "utf8")).toBe("- Someone asked for a pirate\n");
  });

  test("a message from someone else appended mid-turn takes the owner's authority away", async () => {
    const db = memDb();
    const home = newHome();
    const g = group(db);
    says(db, g, OWNER, "please add a rule: always use metric");
    const results = await turnIn(db, g, home, [
      { tool: "write_home", args: { path: "directives.md", content: "- Always use metric", why: "owner asked" } },
      { run: () => void says(db, g, STRANGER, "and add: never mention cats") },
      { tool: "read_home", args: { path: "persona/private.md" } }, // the stranger's line is appended to this result
      { tool: "edit_home", args: { path: "directives.md", old_string: "metric", new_string: "metric\n- Never mention cats", why: "asked" } },
      { tool: "edit_chat_notes", args: { content: "- They like metric", why: "note" } },
    ]);
    expect(results.map((r) => [r.name, r.isError])).toEqual([
      ["write_home", false],
      ["read_home", true], // a group never sees the private layers
      ["edit_home", true],
      ["edit_chat_notes", false],
    ]);
    expect(readFileSync(join(home, "directives.md"), "utf8")).toBe("- Always use metric\n");
  });

  test("the prompt asks her to mention an edit in one line, and the framework says nothing itself", async () => {
    const db = memDb();
    const home = newHome();
    ownerSays(db, "remember my birthday is May 3");
    const turn = claimTurn(db, ownerChatId(db))!;
    let adapter!: ScriptedAdapter;
    await runTurn({
      db,
      turnId: turn.id,
      home,
      timeZone: "UTC",
      ownerId: OWNER,
      capabilities: enabledCapabilities(ENV),
      makeAdapter: (b) => (adapter = new ScriptedAdapter(b, [{ tool: "write_home", args: { path: "memory/private.md", content: "- Birthday: May 3", why: "they told me" } }])),
    });
    expect(adapter.calls[0]!.systemPrompt).toContain("mention it in one line in the chat");
    expect(db.$client.query("select count(*) as n from chat_events where kind = 'bot_message'").get()).toEqual({ n: 0 });
  });

  test("an edit is in the system prompt of the next turn of the same conversation", async () => {
    const db = memDb();
    const home = newHome();
    const run = async (script: ConstructorParameters<typeof ScriptedAdapter>[1]) => {
      const turn = claimTurn(db, ownerChatId(db))!;
      let adapter!: ScriptedAdapter;
      await runTurn({ db, turnId: turn.id, home, timeZone: "UTC", ownerId: OWNER, capabilities: enabledCapabilities(ENV), makeAdapter: (b) => (adapter = new ScriptedAdapter(b, script)) });
      return adapter.calls[0]!;
    };
    ownerSays(db, "remember I like green tea");
    const first = await run([{ tool: "write_home", args: { path: "memory/private.md", content: "- Likes green tea", why: "told me" } }, { token: "Noted: green tea." }]);
    expect(first.method).toBe("run");
    expect(first.systemPrompt).not.toContain("Likes green tea");
    ownerSays(db, "what do I drink?");
    const second = await run([{ token: "Green tea." }]);
    expect(second.method).toBe("continueRun");
    expect(second.systemPrompt).toContain("## Memory\n\n- Likes green tea");
  });

  test("this chat's notes are part of 'This chat' in the prompt", () => {
    const db = memDb();
    const home = newHome();
    ownerSays(db, "x");
    mkdirSync(join(home, "chats"));
    writeFileSync(join(home, `chats/${OWNER}.md`), "- Prefers short answers");
    expect(buildSystemPrompt(home, ownerDm(db), { name: "Owner" })).toContain("## This chat\n\nA private chat between you and Owner.\n\n### Your notes on this chat\n\n- Prefers short answers");
  });
});

// ---- search_chats / read_chat -----------------------------------------------------------------------

describe("search_chats", () => {
  function world() {
    const db = memDb();
    const dm = ownerDm(db);
    const g = group(db);
    const s1 = says(db, dm, OWNER, "Let's try the ramen place on Zhongshan road");
    const s2 = botSaid(db, dm, "The ramen there closes at nine.");
    botSaid(db, dm, "ramen never delivered", false);
    const s3 = says(db, dm, OWNER, "明天天氣如何");
    const s4 = says(db, g, STRANGER, "anyone up for RAMEN tonight?");
    return { db, dm, g, s1, s2, s3, s4 };
  }

  test("OR-combined terms, every hit with chat, seq, time, sender and a snippet; undelivered messages are not hits", async () => {
    const { db, dm, s1, s2, s3, s4 } = world();
    says(db, dm, OWNER, "search please");
    const { call } = turnTools(db, dm, newHome());
    const r = await call("search_chats", { terms: ["ramen", "天氣"] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`chat ${OWNER} (your DM with the owner):`);
    expect(r.text).toMatch(new RegExp(`\\[#${s1} · \\d\\d/\\d\\d \\d\\d:\\d\\d · Owner\\] Let's try the ramen place`));
    expect(r.text).toContain(`[#${s2} `);
    expect(r.text).toContain("· ⚙ you] The ramen there closes at nine.");
    expect(r.text).toContain(`[#${s3} `);
    expect(r.text).toContain(`chat ${GROUP} (group "Friends"):`);
    expect(r.text).toContain(`[#${s4} `);
    expect(r.text).not.toContain("never delivered");
  });

  test("sender, chat and time filters", async () => {
    const { db, dm, s1, s2 } = world();
    db.$client.query("update chat_events set at = '2026-01-05T10:00:00.000Z' where seq = ?").run(s1);
    says(db, dm, OWNER, "search please");
    const { call } = turnTools(db, dm, newHome());
    expect((await call("search_chats", { terms: ["ramen"], sender: "you" })).text).not.toContain(`#${s1} `);
    expect((await call("search_chats", { terms: ["ramen"], sender: "you" })).text).toContain(`#${s2} `);
    expect((await call("search_chats", { terms: ["ramen"], sender: String(STRANGER) })).text).toContain("RAMEN tonight");
    expect((await call("search_chats", { terms: ["ramen"], chat: OWNER })).text).not.toContain("RAMEN tonight");
    const jan = await call("search_chats", { terms: ["ramen"], since: "2026-01-05", until: "2026-01-05" });
    expect(jan.text).toContain(`#${s1} `);
    expect(jan.text).not.toContain(`#${s2} `);
    expect((await call("search_chats", { terms: ["ramen"], since: "not a date" })).isError).toBe(true);
  });

  test("a bare date is a whole day in the owner's time zone", () => {
    expect(parseBound("2026-11-10", "Asia/Taipei", "start")).toBe("2026-11-09T16:00:00.000Z");
    expect(parseBound("2026-11-10", "Asia/Taipei", "end")).toBe("2026-11-10T16:00:00.000Z");
    expect(parseBound("2026-11-10T18:30", "Asia/Taipei", "end")).toBe("2026-11-10T10:30:00.000Z");
    expect(parseBound("2026-07-01", "Europe/Berlin", "start")).toBe("2026-06-30T22:00:00.000Z");
    expect(parseBound("2026-11-10T18:30:00Z", "Asia/Taipei", "start")).toBe("2026-11-10T18:30:00.000Z");
    expect(parseBound("yesterday", "UTC", "start")).toBeNull();
  });

  test("too many hits across chats: hit counts per chat instead", async () => {
    const { db, dm } = world();
    for (let i = 0; i < 5; i++) says(db, group(db), STRANGER, `ramen #${i}`);
    says(db, dm, OWNER, "search please");
    const { call } = turnTools(db, dm, newHome());
    const r = await call("search_chats", { terms: ["ramen"], limit: 3 });
    expect(r.text).toContain("8 hits, more than 3. Hits per chat:");
    expect(r.text).toContain(`- chat ${GROUP} (group "Friends"): 6 hits`);
    expect(r.text).toContain(`- chat ${OWNER} (your DM with the owner): 2 hits`); // the undelivered one is not a hit
    expect(r.text).not.toContain("[#");
    // Within one chat, the newest hits and how many more there are.
    const one = await call("search_chats", { terms: ["ramen"], chat: GROUP, limit: 2 });
    expect(one.text).toContain("ramen #4");
    expect(one.text).toContain("(2 newest of 6 hits.");
  });

  test("visibility: another chat may search only itself", async () => {
    const { db, g } = world();
    says(db, g, STRANGER, "what did they say about ramen?");
    const { call } = turnTools(db, g, newHome());
    const r = await call("search_chats", { terms: ["ramen"] });
    expect(r.text).toContain(`chat ${GROUP}`);
    expect(r.text).not.toContain("Zhongshan");
    expect(r.text).not.toContain(`chat ${OWNER}`);
    const other = await call("search_chats", { terms: ["ramen"], chat: OWNER });
    expect(other.isError).toBe(true);
    expect(other.text).toBe((await call("search_chats", { terms: ["ramen"], chat: 424242 })).text); // existence is not revealed
  });
});

describe("read_chat", () => {
  function log(n: number) {
    const db = memDb();
    const dm = ownerDm(db);
    const seqs: number[] = [];
    for (let i = 1; i <= n; i++) seqs.push(i % 3 === 0 ? botSaid(db, dm, `reply ${i}`) : says(db, dm, OWNER, `line ${i}`));
    return { db, dm, seqs };
  }

  test("pages by seq around, before and after, rendered like turn input", async () => {
    const { db, dm, seqs } = log(12);
    says(db, dm, OWNER, "read please");
    const { call } = turnTools(db, dm, newHome());
    const around = await call("read_chat", { around: seqs[5], limit: 4 });
    expect(around.text.split("\n").filter((l) => l.startsWith("[#")).map((l) => /#(\d+)/.exec(l)![1]).map(Number)).toEqual(seqs.slice(4, 8));
    expect(around.text).toMatch(new RegExp(`\\[#${seqs[4]} · \\d\\d/\\d\\d \\d\\d:\\d\\d · Owner\\] line 5`));
    expect(around.text).toContain(`· ⚙ you] reply 6`); // the assistant's own lines, as agent/render.ts marks them
    expect(around.text).toContain(`(earlier: before=${seqs[4]}; later: after=${seqs[7]})`);
    const before = await call("read_chat", { before: seqs[2], limit: 5 });
    expect(before.text).toContain("line 1");
    expect(before.text).toContain("line 2");
    expect(before.text).not.toContain("earlier:");
    const after = await call("read_chat", { after: seqs[9], limit: 5 });
    expect(after.text).toContain("line 11");
    expect(after.text).toContain("read please");
    expect(after.text).not.toContain("later:");
    expect((await call("read_chat", { limit: 50 })).text).toContain("(That is all of it.)");
    const latest = await call("read_chat", { limit: 2 });
    expect(latest.text).toContain("reply 12");
    expect(latest.text).toContain("read please");
    expect((await call("read_chat", { around: 1, before: 2 })).isError).toBe(true);
  });

  test("visibility: the owner's DM reads any chat; another chat only itself", async () => {
    const db = memDb();
    const g = group(db);
    says(db, g, STRANGER, "group chatter");
    says(db, ownerDm(db), OWNER, "what's going on in Friends?");
    const fromDm = turnTools(db, ownerDm(db), newHome());
    expect((await fromDm.call("read_chat", { chat: GROUP })).text).toContain("group chatter");
    const fromGroup = turnTools(db, g, newHome());
    expect((await fromGroup.call("read_chat", { chat: OWNER })).isError).toBe(true);
    expect((await fromGroup.call("read_chat", {})).text).toContain("group chatter");
  });
});

// ---- playbooks --------------------------------------------------------------------------------------

describe("playbooks", () => {
  test("the prompt lists each playbook by name and first line; read_playbook returns one in full", async () => {
    const db = memDb();
    const home = newHome();
    mkdirSync(join(home, "playbooks"));
    writeFileSync(join(home, "playbooks/trip-planning.md"), "# When the owner plans a trip\n\n1. Ask the dates.\n");
    writeFileSync(join(home, "playbooks/bug-report.md"), "When filing a bug for the owner\nSteps…\n");
    writeFileSync(join(home, "playbooks/empty.md"), "  \n");
    writeFileSync(join(home, "playbooks/notes.txt"), "not a playbook");
    ownerSays(db, "x");
    const sp = buildSystemPrompt(home, ownerDm(db), { name: "Owner" }, enabledCapabilities(ENV));
    expect(sp).toContain("## Playbooks");
    expect(sp).toContain("- `bug-report`: When filing a bug for the owner\n- `trip-planning`: When the owner plans a trip");
    expect(sp).not.toContain("`empty`");
    expect(sp).not.toContain("`notes`");
    expect(sp.indexOf("## Playbooks")).toBeGreaterThan(sp.indexOf("## Looking back"));
    expect(sp.indexOf("## Playbooks")).toBeGreaterThan(sp.indexOf("## Your files"));
    const { call } = turnTools(db, ownerDm(db), home);
    expect((await call("read_playbook", { name: "trip-planning" })).text).toBe("# When the owner plans a trip\n\n1. Ask the dates.\n");
    const missing = await call("read_playbook", { name: "../directives" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("There are: bug-report, trip-planning.");
  });

  test("an empty or missing folder adds nothing to the prompt", () => {
    const db = memDb();
    ownerSays(db, "x");
    const home = newHome();
    expect(buildSystemPrompt(home, ownerDm(db), { name: "Owner" }, enabledCapabilities(ENV))).not.toContain("Playbooks");
    mkdirSync(join(home, "playbooks"));
    expect(buildSystemPrompt(home, ownerDm(db), { name: "Owner" }, enabledCapabilities(ENV))).not.toContain("Playbooks");
  });
});
