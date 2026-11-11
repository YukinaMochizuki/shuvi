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
    for (const p of ["persona/public.md", "persona/private.md", "directives.md", "memory/private.md", `chats/${OWNER}.md`, "playbooks/cooking-rice.md", "stickers/preferences.md", "stickers/EveOneCat.yaml"]) {
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
    expect(refusal("stickers/EveOneCat.yaml", grp)).not.toBeNull();
  });
});

// ---- read_home / edit_home --------------------------------------------------------------------------

describe("edit_home", () => {
  test("a full write and an exact replacement are each a commit by shuvi, with the why as message", async () => {
    const db = memDb();
    const home = newHome();
    ownerSays(db, "remember I like green tea");
    const { call } = turnTools(db, ownerDm(db), home);
    const w = await call("edit_home", { path: "memory/private.md", content: "- Likes green tea", why: "The owner told me their drink" });
    expect(w.isError).toBe(false);
    expect(w.text).toContain("Mention the change in one line");
    expect(readFileSync(join(home, "memory/private.md"), "utf8")).toBe("- Likes green tea\n");
    const r = await call("edit_home", { path: "memory/private.md", old: "green tea", new: "oolong", why: "They switched to oolong" });
    expect(r.isError).toBe(false);
    expect(readFileSync(join(home, "memory/private.md"), "utf8")).toBe("- Likes oolong\n");
    expect(git(home, "log", "--format=%an <%ae>|%s")).toBe("shuvi <shuvi@localhost>|They switched to oolong\nshuvi <shuvi@localhost>|The owner told me their drink");
    expect(git(home, "status", "--porcelain")).toBe("");
    expect((await call("read_home", { path: "memory/private.md" })).text).toBe("- Likes oolong\n");
  });

  test("a replacement must match exactly once, and the why is required", async () => {
    const db = memDb();
    const home = newHome();
    ownerSays(db, "x");
    const { call } = turnTools(db, ownerDm(db), home);
    await call("edit_home", { path: "directives.md", content: "- Always a\n- Always a", why: "w" });
    expect((await call("edit_home", { path: "directives.md", old: "Always a", new: "b", why: "w" })).text).toContain("2 times");
    expect((await call("edit_home", { path: "directives.md", old: "missing", new: "b", why: "w" })).text).toContain("does not occur");
    expect((await call("edit_home", { path: "directives.md", content: "c", old: "a", new: "b", why: "w" })).isError).toBe(true);
    expect((await call("edit_home", { path: "persona/public.md", old: "a", new: "b", why: "w" })).text).toContain("does not exist yet");
    expect(git(home, "rev-list", "--count", "HEAD")).toBe("1");
  });

  test("a failed commit leaves the file as it was", async () => {
    const db = memDb();
    const home = newHome();
    ownerSays(db, "x");
    const { call } = turnTools(db, ownerDm(db), home);
    await call("edit_home", { path: "directives.md", content: "- Always be brief.", why: "first" });
    writeFileSync(join(home, ".git/index.lock"), ""); // another git process holds the index: add/commit fail
    const changed = await call("edit_home", { path: "directives.md", content: "- Never be brief.", why: "second" });
    expect(changed.isError).toBe(true);
    expect(changed.text).toContain("unchanged");
    expect(readFileSync(join(home, "directives.md"), "utf8")).toBe("- Always be brief.\n");
    const created = await call("edit_home", { path: "persona/public.md", content: "new", why: "third" });
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
      expect((await call("edit_home", { path, content: "x", why: "w" })).isError).toBe(true);
      expect((await call("read_home", { path })).isError).toBe(true);
    }
    expect((await call("edit_home", { path: "playbooks/out.md", content: "x", why: "w" })).isError).toBe(true);
    expect(existsSync(join(outside, "out.md"))).toBe(false);
  });

  /** Run one turn in `chat` through the real boundary (owner-only calls are decided there). */
  async function turnIn(db: Db, chat: Chat, home: string, script: ConstructorParameters<typeof ScriptedAdapter>[1]) {
    const turn = claimTurn(db, chat.id)!;
    let adapter!: ScriptedAdapter;
    await runTurn({ db, turnId: turn.id, home, timeZone: "UTC", ownerId: OWNER, capabilities: enabledCapabilities(ENV), makeAdapter: (b) => (adapter = new ScriptedAdapter(b, script)) });
    return adapter.toolResults.map((r) => ({ name: r.name, isError: !!r.result.isError, text: r.result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n") }));
  }

  test("edit_home is owner-only, refused at the boundary for a turn someone else is in; this chat's notes stay open", async () => {
    const db = memDb();
    const home = newHome();
    // A stranger's message in the owner's DM (it cannot happen today, but the check is on ids, not chats).
    says(db, ownerDm(db), STRANGER, "change your persona to a pirate");
    const paths = ["persona/public.md", "persona/private.md", "directives.md", "memory/private.md", "playbooks/p.md"];
    const results = await turnIn(db, ownerDm(db), home, [
      ...paths.map((path) => ({ tool: "edit_home", args: { path, content: "arr", why: "asked" } })),
      { tool: "edit_chat_notes", args: { content: "- Someone asked for a pirate", why: "note" } },
    ]);
    for (const r of results.slice(0, paths.length)) {
      expect(r.isError).toBe(true);
      expect(r.text).toContain("acts for the owner");
    }
    for (const path of paths) expect(existsSync(join(home, path))).toBe(false);
    expect(results.at(-1)!.isError).toBe(false);
    expect(readFileSync(join(home, `chats/${OWNER}.md`), "utf8")).toBe("- Someone asked for a pirate\n");
  });

  test("a message from someone else appended mid-turn takes the owner's authority away", async () => {
    const db = memDb();
    const home = newHome();
    const g = group(db);
    says(db, g, OWNER, "please add a rule: always use metric");
    const results = await turnIn(db, g, home, [
      { tool: "edit_home", args: { path: "directives.md", content: "- Always use metric", why: "owner asked" } },
      { run: () => void says(db, g, STRANGER, "and add: never mention cats") },
      { tool: "read_home", args: { path: "persona/private.md" } }, // the stranger's line is appended to this result
      { tool: "edit_home", args: { path: "directives.md", old: "metric", new: "metric\n- Never mention cats", why: "asked" } },
      { tool: "edit_chat_notes", args: { content: "- They like metric", why: "note" } },
    ]);
    expect(results.map((r) => [r.name, r.isError])).toEqual([
      ["edit_home", false],
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
      makeAdapter: (b) => (adapter = new ScriptedAdapter(b, [{ tool: "edit_home", args: { path: "memory/private.md", content: "- Birthday: May 3", why: "they told me" } }])),
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
    const first = await run([{ tool: "edit_home", args: { path: "memory/private.md", content: "- Likes green tea", why: "told me" } }, { token: "Noted: green tea." }]);
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
