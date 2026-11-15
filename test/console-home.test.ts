import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { withCall } from "../src/agent/call-context.ts";
import { runTurn } from "../src/agent/turn.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import { commitHomeEdit } from "../src/capabilities/memory/home.ts";
import { blobId, fileHistory } from "../src/console/home-data.ts";
import { ghDiff } from "../src/console/ghdiff.ts";
import { allowedHosts, allowedOrigins } from "../src/console/index.ts";
import { csrfToken, handleConsole, LOGIN_HEADER, type ConsoleDeps } from "../src/console/server.ts";
import type { Db } from "../src/store/db.ts";
import { claimTurn } from "../src/store/turns.ts";
import { memDb, OWNER, ownerChatId, ownerSays, ScriptedAdapter } from "./helpers.ts";

const PORT = 8787;
const HOST = `127.0.0.1:${PORT}`;
const BASE = `http://${HOST}`;
const SECRET = "example-csrf-secret";
const LOGIN = "owner@example.com";
const CSRF = csrfToken(SECRET, `login:${LOGIN}`);
const ENV = { SHUVI_OWNER_ID: String(OWNER), SHUVI_WEB: "off" };

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function newHome(): string {
  const d = mkdtempSync(join(tmpdir(), "shuvi-home-"));
  dirs.push(d);
  return d;
}

function deps(db: Db, home: string, extra: Partial<ConsoleDeps> = {}): ConsoleDeps {
  const c = { listen: HOST };
  return { db, home, timeZone: "UTC", dataDir: "/nonexistent", allowedHosts: allowedHosts(c, PORT), allowedOrigins: allowedOrigins(c, PORT), csrfSecret: SECRET, users: new Set([LOGIN]), ...extra };
}

async function get(db: Db, home: string, path: string): Promise<{ status: number; text: string }> {
  const res = await handleConsole(deps(db, home), new Request(`${BASE}${path}`, { headers: { [LOGIN_HEADER]: LOGIN } }));
  return { status: res.status, text: await res.text() };
}

function save(db: Db, home: string, fields: Record<string, string>, o: { origin?: string | null; csrf?: string | null } = {}): Promise<Response> {
  const body = new URLSearchParams(fields);
  const csrf = o.csrf === undefined ? CSRF : o.csrf;
  if (csrf !== null) body.set("csrf", csrf);
  const origin = o.origin === undefined ? BASE : o.origin;
  const headers: Record<string, string> = { [LOGIN_HEADER]: LOGIN, "content-type": "application/x-www-form-urlencoded" };
  if (origin !== null) headers.origin = origin;
  return handleConsole(deps(db, home), new Request(`${BASE}/home/save`, { method: "POST", headers, body }));
}

/** Follow a save's 303 and read the page it leads to. */
async function saveAndLook(db: Db, home: string, fields: Record<string, string>): Promise<string> {
  const res = await save(db, home, fields);
  expect(res.status).toBe(303);
  return (await get(db, home, res.headers.get("location")!)).text;
}

function git(home: string, ...args: string[]): string {
  return Bun.spawnSync(["git", "-C", home, ...args], { stdout: "pipe" }).stdout.toString();
}

/** A commit made by hand on the machine, by someone who is neither her nor the console. */
function byHand(home: string, rel: string, text: string, who = "Someone Else"): void {
  mkdirSync(dirname(join(home, rel)), { recursive: true });
  if (!Bun.spawnSync(["git", "-C", home, "rev-parse"]).success) Bun.spawnSync(["git", "-C", home, "init", "-q"]);
  writeFileSync(join(home, rel), text);
  const env = { ...process.env, GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: "else@example.com", GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: "else@example.com" };
  Bun.spawnSync(["git", "-C", home, "-c", "commit.gpgsign=false", "add", rel], { env });
  Bun.spawnSync(["git", "-C", home, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "by hand"], { env });
}

const read = (home: string, rel: string) => readFileSync(join(home, rel), "utf8");

describe("who changed a file", () => {
  test("her edit in a turn records the turn, the chat and the very call the transcript has", async () => {
    const db = memDb();
    const home = newHome();
    byHand(home, "directives.md", "- Always be kind\n");
    ownerSays(db, "add a rule: answer briefly");
    const turn = claimTurn(db, ownerChatId(db))!;
    await runTurn({
      db,
      turnId: turn.id,
      home,
      timeZone: "UTC",
      ownerId: OWNER,
      capabilities: enabledCapabilities(ENV),
      makeAdapter: (b) => new ScriptedAdapter(b, [{ tool: "edit_home", args: { path: "directives.md", old_string: "- Always be kind\n", new_string: "- Always be kind\n- Answer briefly\n", why: "Owner wants brief answers" } }]),
    });
    const body = git(home, "log", "-1", "--format=%an%n%B");
    const call = db.$client.query(`select call_id as callId from turn_steps where turn_id = ? and name = 'edit_home'`).get(turn.id) as { callId: string };
    expect(call.callId).toBeTruthy();
    expect(body).toContain("shuvi\nOwner wants brief answers\n\n");
    expect(body).toContain(`Turn: ${turn.id}\nTool-Call: ${call.callId}\nChat: ${ownerChatId(db)}\nTool: edit_home`);
    const [entry] = fileHistory(db, home, "directives.md");
    expect(entry!.who).toMatchObject({ kind: "her", turnId: turn.id, callId: call.callId, tool: "edit_home" });
    expect(entry!.message).toBe("Owner wants brief answers");
    expect(entry).toMatchObject({ add: 1, del: 0 });
  });

  test("a commit outside a call has no trailers; an old one of hers is found through her tool's result", () => {
    const db = memDb();
    const home = newHome();
    const commit = commitHomeEdit(home, "memory/private.md", "- Likes tea\n", "they told me");
    expect(git(home, "log", "-1", "--format=%B").trim()).toBe("they told me");
    // The transcript of the turn that made it, as it was recorded before commits carried trailers.
    const chatId = ownerChatId(db);
    db.$client.run(`insert into turns (chat_id, status, from_seq, to_seq) values (?, 'done', 0, 0)`, [chatId]);
    const turnId = (db.$client.query("select max(id) as id from turns").get() as { id: number }).id;
    db.$client.run(`insert into turn_steps (turn_id, n, kind, name, status, call_id, result) values (?, 0, 'tool', 'write_home', 'ok', 'call-old', ?)`, [turnId, `Saved memory/private.md (commit ${commit}, +1 -0). Mention the change in one line in the chat.`]);
    const [entry] = fileHistory(db, home, "memory/private.md");
    expect(entry!.who).toMatchObject({ kind: "her", inferred: true, turnId, callId: "call-old", tool: "write_home" });
    expect(entry!.created).toBe(true);
  });

  test("a result that names an older commit does not claim it", () => {
    const db = memDb();
    const home = newHome();
    const commit = commitHomeEdit(home, "stickers/ExamplePack.yaml", "pack: ExamplePack\n", "skeleton");
    db.$client.run(`insert into turns (chat_id, status, from_seq, to_seq) values (?, 'done', 0, 0)`, [ownerChatId(db)]);
    db.$client.run(`insert into turn_steps (turn_id, n, kind, name, status, call_id, result) values (1, 0, 'tool', 'add_sticker_pack', 'ok', 'c', ?)`, [`ExamplePack was removed from the library before (commit ${commit}), so this is a fresh skeleton.`]);
    expect(fileHistory(db, home, "stickers/ExamplePack.yaml")[0]!.who).toEqual({ kind: "her" });
  });

  test("a commit by hand is its author's; one from the console is yours", async () => {
    const db = memDb();
    const home = newHome();
    byHand(home, "directives.md", "- one\n");
    await saveAndLook(db, home, { path: "directives.md", base: blobId("- one\n"), text: "- one\n- two\n", note: "add two" });
    const [mine, theirs] = fileHistory(db, home, "directives.md");
    expect(mine!.who).toEqual({ kind: "owner", login: LOGIN });
    expect(mine!.message).toBe("add two");
    expect(theirs!.who).toEqual({ kind: "external", name: "Someone Else" });
    expect(git(home, "log", "-1", "--format=%an <%ae>%n%B")).toBe(`owner (console) <${LOGIN}>\nadd two\n\nEdited-In: console\n\n`);
  });
});

describe("saving from the console", () => {
  test("saves what was typed, as one commit; a browser's CRLF become the file's LF", async () => {
    const db = memDb();
    const home = newHome();
    byHand(home, "persona/public.md", "I am kind.\n");
    const page = await saveAndLook(db, home, { path: "persona/public.md", base: blobId("I am kind.\n"), text: "I am kind.\r\nI am brief.\r\n" });
    expect(read(home, "persona/public.md")).toBe("I am kind.\nI am brief.\n");
    expect(page).toContain("Saved (commit");
    expect(git(home, "log", "-1", "--format=%s")).toBe("Edited in console\n");
  });

  test("a file not created yet is created", async () => {
    const db = memDb();
    const home = newHome();
    await saveAndLook(db, home, { path: "playbooks/trip.md", base: blobId(null), text: "When booking a trip.\n" });
    expect(read(home, "playbooks/trip.md")).toBe("When booking a trip.\n");
  });

  test("her change made meanwhile in other lines is merged in, and the answer says so", async () => {
    const db = memDb();
    const home = newHome();
    const start = "- a\n- b\n- c\n- d\n- e\n";
    byHand(home, "directives.md", start);
    commitHomeEdit(home, "directives.md", start.replace("- e\n", "- e\n- f (hers)\n"), "hers");
    const page = await saveAndLook(db, home, { path: "directives.md", base: blobId(start), text: start.replace("- a\n", "- a (mine)\n") });
    expect(read(home, "directives.md")).toBe("- a (mine)\n- b\n- c\n- d\n- e\n- f (hers)\n");
    expect(page).toContain("that change was kept too");
  });

  test("a change in the same lines is not saved: the page shows both, to resolve", async () => {
    const db = memDb();
    const home = newHome();
    byHand(home, "directives.md", "- a\n");
    commitHomeEdit(home, "directives.md", "- a (hers)\n", "hers");
    const page = await saveAndLook(db, home, { path: "directives.md", base: blobId("- a\n"), text: "- a (mine)\n" });
    expect(read(home, "directives.md")).toBe("- a (hers)\n");
    expect(page).toContain("Merging");
    expect(page).toContain("- a (hers)");
    expect(page).toContain("- a (mine)");
    // Resolved against the version now, it saves.
    await saveAndLook(db, home, { path: "directives.md", base: blobId("- a (hers)\n"), text: "- a (both)\n", resolved: "1" });
    expect(read(home, "directives.md")).toBe("- a (both)\n");
  });

  test("the same text saves nothing", async () => {
    const db = memDb();
    const home = newHome();
    byHand(home, "directives.md", "- a\n");
    const before = git(home, "rev-parse", "HEAD");
    const page = await saveAndLook(db, home, { path: "directives.md", base: blobId("- a\n"), text: "- a\n" });
    expect(page).toContain("Nothing was saved");
    expect(git(home, "rev-parse", "HEAD")).toBe(before);
  });

  test("only her files: policy.yaml, a path out of home/, anything else is refused and untouched", async () => {
    const db = memDb();
    const home = newHome();
    byHand(home, "policy.yaml", "owner: 1\n");
    for (const path of ["policy.yaml", "../escape.md", "inbound.yaml", "playbooks/../policy.yaml", "chats/abc.md"]) {
      const page = await saveAndLook(db, home, { path, base: "absent", text: "x" });
      expect(page).toContain("is not one of her files");
    }
    expect(read(home, "policy.yaml")).toBe("owner: 1\n");
  });

  test("the write boundary: no Origin, another site's, no or a wrong token: 403; a GET: 405", async () => {
    const db = memDb();
    const home = newHome();
    byHand(home, "directives.md", "- a\n");
    const f = { path: "directives.md", base: blobId("- a\n"), text: "- b\n" };
    expect((await save(db, home, f, { origin: null })).status).toBe(403);
    expect((await save(db, home, f, { origin: "https://evil.example" })).status).toBe(403);
    expect((await save(db, home, f, { csrf: null })).status).toBe(403);
    expect((await save(db, home, f, { csrf: "nope" })).status).toBe(403);
    expect((await get(db, home, "/home/save")).status).toBe(405);
    expect(read(home, "directives.md")).toBe("- a\n");
  });
});

describe("what the review found", () => {
  test("a merged save whose commit fails hands back the MERGED text, so saving it again keeps her change", async () => {
    const db = memDb();
    const home = newHome();
    const start = "a\nb\nc\nd\ne\n";
    byHand(home, "directives.md", start);
    commitHomeEdit(home, "directives.md", `${start}HERS\n`, "hers");
    writeFileSync(join(home, ".git/index.lock"), "");
    const page = await saveAndLook(db, home, { path: "directives.md", base: blobId(start), text: start.replace("a\n", "MINE\n") });
    expect(page).toContain("Not saved");
    expect(page).toContain(">\nMINE\nb\nc\nd\ne\nHERS\n</textarea>");
    rmSync(join(home, ".git/index.lock"));
    const base = /name="base" value="([0-9a-f]+)"/.exec(page)![1]!;
    await saveAndLook(db, home, { path: "directives.md", base, text: "MINE\nb\nc\nd\ne\nHERS\n" });
    expect(read(home, "directives.md")).toBe("MINE\nb\nc\nd\ne\nHERS\n");
  });

  test("a file she removed while you edited is not brought back by itself; saving again creates it with your text", async () => {
    const db = memDb();
    const home = newHome();
    byHand(home, "playbooks/old.md", "Old.\n");
    commitHomeEdit(home, "playbooks/old.md", null, "remove it");
    const page = await saveAndLook(db, home, { path: "playbooks/old.md", base: blobId("Old.\n"), text: "Old.\n" });
    expect(page).toContain("removed this file while you were editing");
    expect(Bun.file(join(home, "playbooks/old.md")).size).toBe(0);
    expect(await Bun.file(join(home, "playbooks/old.md")).exists()).toBe(false);
    await saveAndLook(db, home, { path: "playbooks/old.md", base: blobId(null), text: "Old.\n" });
    expect(read(home, "playbooks/old.md")).toBe("Old.\n");
  });

  test("a file that starts with a newline keeps it: the textarea's lead newline is the parser's", async () => {
    const db = memDb();
    const home = newHome();
    byHand(home, "directives.md", "\n# Rules\n");
    const { text } = await get(db, home, "/home?file=directives.md");
    expect(text).toContain('aria-label="directives.md">\n\n# Rules\n</textarea>');
  });

  test("a CRLF file stays CRLF whether the form posts CRLF (native) or LF (htmx)", async () => {
    const db = memDb();
    const home = newHome();
    byHand(home, "directives.md", "a\r\nb\r\n");
    await saveAndLook(db, home, { path: "directives.md", base: blobId("a\r\nb\r\n"), text: "a\nb\nc\n" });
    expect(read(home, "directives.md")).toBe("a\r\nb\r\nc\r\n");
    await saveAndLook(db, home, { path: "directives.md", base: blobId("a\r\nb\r\nc\r\n"), text: "a\r\nb\r\nc\r\nd\r\n" });
    expect(read(home, "directives.md")).toBe("a\r\nb\r\nc\r\nd\r\n");
  });

  test("a commit told what the file should say refuses when it says anything else, writing nothing", () => {
    const home = newHome();
    byHand(home, "directives.md", "a\n");
    expect(() => commitHomeEdit(home, "directives.md", "b\n", "x", { expect: "stale\n" })).toThrow("changed meanwhile");
    expect(read(home, "directives.md")).toBe("a\n");
  });

  test("two calls running at once each sign their own commit", async () => {
    const home = newHome();
    const one = withCall({ turnId: 1, chatId: 1, callId: "call-a", tool: "edit_home" }, async () => {
      await Bun.sleep(20);
      commitHomeEdit(home, "directives.md", "a\n", "from a");
    });
    const two = withCall({ turnId: 1, chatId: 1, callId: "call-b", tool: "write_home" }, async () => {
      await Bun.sleep(5);
      commitHomeEdit(home, "memory/private.md", "b\n", "from b");
    });
    await Promise.all([one, two]);
    expect(git(home, "log", "-1", "--format=%B", "--", "directives.md")).toContain("Tool-Call: call-a\nChat: 1\nTool: edit_home");
    expect(git(home, "log", "-1", "--format=%B", "--", "memory/private.md")).toContain("Tool-Call: call-b\nChat: 1\nTool: write_home");
  });

  test("undo of one of two identical lines does not guess: the three-way merge takes out the right one", async () => {
    const db = memDb();
    const home = newHome();
    byHand(home, "memory/private.md", "# list\n- buy milk\n- call mom\n");
    commitHomeEdit(home, "memory/private.md", "# list\n- buy milk\n- call mom\n- buy milk\n", "milk again");
    commitHomeEdit(home, "memory/private.md", "new1\nnew2\n# list\n- buy milk\n- call mom\n- buy milk\n", "two at the top");
    const [, milk] = git(home, "log", "--format=%H").trim().split("\n");
    const { text } = await get(db, home, `/home?file=memory/private.md&undo=${milk}`);
    expect(text).toContain(">\nnew1\nnew2\n# list\n- buy milk\n- call mom\n</textarea>");
  });

  test("the watch answers nothing for a file the console does not edit", async () => {
    const db = memDb();
    const home = newHome();
    byHand(home, "policy.yaml", "owner: 1\n");
    expect((await get(db, home, "/home/watch?file=policy.yaml&base=x")).text).toBe("");
  });

  test("only her tool's own commit is inferred, not one its diff quotes", () => {
    const db = memDb();
    const home = newHome();
    const quoted = commitHomeEdit(home, "directives.md", "a\n", "first");
    const mine = commitHomeEdit(home, "directives.md", "a\nb\n", "second");
    db.$client.run(`insert into turns (chat_id, status, from_seq, to_seq) values (?, 'done', 0, 0)`, [ownerChatId(db)]);
    db.$client.run(`insert into turn_steps (turn_id, n, kind, name, status, call_id, result) values (1, 0, 'tool', 'edit_home', 'ok', 'c2', ?)`, [`Saved directives.md (commit ${mine}, +1 -0).\n+see (commit ${quoted})`]);
    const [second, first] = fileHistory(db, home, "directives.md");
    expect(second!.who).toMatchObject({ kind: "her", inferred: true, callId: "c2" });
    expect(first!.who).toEqual({ kind: "her" });
  });

  test("only a Home save and a delete may be large", async () => {
    const big = (path: string) => new Request(`${BASE}${path}`, { method: "POST", headers: { "content-length": String(64 * 1024) }, body: "x".repeat(64 * 1024) });
    expect((await handleConsole(deps(memDb(), newHome()), big("/login"))).status).toBe(413);
    expect((await handleConsole(deps(memDb(), newHome()), big("/settings/model/add"))).status).toBe(413);
    // A delete of a page's worth of messages is past the small limit: it reaches the write checks (no Origin: 403).
    expect((await handleConsole(deps(memDb(), newHome()), big("/messages/delete"))).status).toBe(403);
  });
});

describe("history, undo, restore", () => {
  /** Three versions: one, then her `two` appended, then your `three` appended. */
  function three(home: string): { c1: string; c2: string; c3: string } {
    byHand(home, "directives.md", "- one\n");
    commitHomeEdit(home, "directives.md", "- one\n- two\n", "add two");
    commitHomeEdit(home, "directives.md", "- one\n- two\n- three\n", "add three", { console: { login: LOGIN } });
    const [c3, c2, c1] = git(home, "log", "--format=%H").trim().split("\n");
    return { c1: c1!, c2: c2!, c3: c3! };
  }

  test("undo takes out only that change, keeps the later ones, and saves nothing", async () => {
    const db = memDb();
    const home = newHome();
    const { c2 } = three(home);
    const { text } = await get(db, home, `/home?file=directives.md&undo=${c2}`);
    expect(text).toContain("Undo of");
    expect(text).toContain(">\n- one\n- three\n</textarea>");
    expect(read(home, "directives.md")).toBe("- one\n- two\n- three\n");
  });

  test("undo of a change whose lines were rewritten since is not guessed: it needs you", async () => {
    const db = memDb();
    const home = newHome();
    byHand(home, "directives.md", "- one\n- two\n");
    commitHomeEdit(home, "directives.md", "- one\n- two (reworded)\n- three\n", "reword two, add three");
    commitHomeEdit(home, "directives.md", "- one\n- two (reworded again)\n- three\n", "reword two again");
    const [, middle] = git(home, "log", "--format=%H").trim().split("\n");
    const { text } = await get(db, home, `/home?file=directives.md&undo=${middle}`);
    expect(text).toContain("Merging");
    expect(text).toContain("Later changes rewrote the lines");
    expect(read(home, "directives.md")).toBe("- one\n- two (reworded again)\n- three\n");
  });

  test("restore loads the file as it was right after that change, and saves nothing", async () => {
    const db = memDb();
    const home = newHome();
    const { c1 } = three(home);
    const { text } = await get(db, home, `/home?file=directives.md&restore=${c1}`);
    expect(text).toContain(">\n- one\n</textarea>");
    expect(read(home, "directives.md")).toBe("- one\n- two\n- three\n");
  });

  test("a history entry shows the whole file as a GitHub-style diff, with who made it", async () => {
    const db = memDb();
    const home = newHome();
    const { c2 } = three(home);
    const { text } = await get(db, home, `/home?file=directives.md&at=${c2}`);
    expect(text).toContain('class="gr gadd" id="first-change"');
    expect(text).toContain("add two");
    expect(text).not.toContain("gfold");
    const hist = await get(db, home, "/home/history");
    expect(hist.text).toContain("add three");
    expect(hist.text).toContain("directives.md");
  });

  test("the watch answers with who changed the file since the editor opened it, and nothing otherwise", async () => {
    const db = memDb();
    const home = newHome();
    byHand(home, "directives.md", "- one\n");
    expect((await get(db, home, `/home/watch?file=directives.md&base=${blobId("- one\n")}`)).text).toBe("");
    commitHomeEdit(home, "directives.md", "- one\n- two\n", "add two");
    const banner = (await get(db, home, `/home/watch?file=directives.md&base=${blobId("- one\n")}`)).text;
    expect(banner).toContain("just changed this file");
    expect(banner).toContain("Your save will keep it");
  });

  test("the page lists her files, with any chat's notes", async () => {
    const db = memDb();
    ownerChatId(db);
    const home = newHome();
    byHand(home, "playbooks/trip.md", "When booking a trip.\n");
    const { status, text } = await get(db, home, "/home");
    expect(status).toBe(200);
    for (const p of ["persona/public.md", "directives.md", "memory/private.md", `chats/${OWNER}.md`, "playbooks/trip.md", "stickers/preferences.md"]) expect(text).toContain(p);
    expect(text).toContain("When booking a trip.");
    expect(text).toContain('src="/editor.js"');
  });

  test("a narrow screen's panes: ‹ Files shows the files even with a file selected", async () => {
    const db = memDb();
    const home = newHome();
    byHand(home, "directives.md", "- one\n");
    const pane = async (q: string) => (await get(db, home, `/home${q}`)).text.match(/<main class="home[^"]*pane-(\w+)"/)?.[1];
    expect(await pane("?file=directives.md")).toBe("edit");
    expect(await pane("?file=directives.md&pane=files")).toBe("files");
    expect(await pane("?file=directives.md&pane=history")).toBe("history");
    expect(await pane("")).toBe("files");
    // The editor's own link back to the files asks for them.
    const edit = (await get(db, home, "/home?file=directives.md&pane=edit")).text;
    const back = edit.match(/<a class="back" href="([^"]+)">‹ Files<\/a>/)?.[1]?.replaceAll("&amp;", "&");
    expect(await pane(back!.slice("/home".length))).toBe("files");
  });

  test("Home lets the on-screen keyboard shrink the page; other pages keep the default", async () => {
    const db = memDb();
    const home = newHome();
    byHand(home, "directives.md", "- one\n");
    expect((await get(db, home, "/home?file=directives.md")).text).toContain('content="width=device-width, initial-scale=1, interactive-widget=resizes-content"');
    expect((await get(db, home, "/home/history")).text).toContain("interactive-widget=resizes-content");
    expect((await get(db, home, "/turns")).text).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
  });
});

describe("the editor and the diff", () => {
  test("/editor.js is the bundled editor", async () => {
    const res = await handleConsole(deps(memDb(), newHome()), new Request(`${BASE}/editor.js`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect((await res.text()).length).toBeGreaterThan(100_000);
  }, 30_000);

  test("ghDiff: numbers both sides, marks changed characters in a CJK line, folds only when asked", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "- 回覆簡潔有禮。", "z"].join("\n");
    const after = ["a", "b", "c", "d", "e", "f", "g", "h", "- 回覆像朋友聊天。", "z"].join("\n");
    const folded = ghDiff(before, after).html.s;
    expect(folded).toContain("@@ -6,5 +6,5 @@");
    expect(folded).toContain('<span class="gw">簡潔有禮</span>');
    expect(folded).toContain('<span class="gw">像朋友聊天</span>');
    expect(folded).toContain("gfold");
    const full = ghDiff(before, after, { full: true }).html.s;
    expect(full).not.toContain("gfold");
    expect(full.match(/class="gr"/g)!.length).toBe(9);
    expect(ghDiff(before, after, { view: "split", full: true }).html.s).toContain("gsplit");
    expect(ghDiff("x", "x").html.s).toContain("No changes.");
  });

  test("ghDiff escapes what it shows", () => {
    expect(ghDiff("", "<script>x</script>").html.s).toContain("&lt;script&gt;");
  });
});
