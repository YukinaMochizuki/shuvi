import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { enterChatModel, getSwitchRequest, requestSwitch } from "../src/agent/switch.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import { allowedHosts, allowedOrigins } from "../src/console/index.ts";
import { csrfToken, handleConsole, LOGIN_HEADER, type ConsoleDeps } from "../src/console/server.ts";
import { getCard, modelCommand, SWITCHED_IN_CONSOLE, switchCardPass } from "../src/control/model-cards.ts";
import { replaceEntry } from "../src/policy/edit.ts";
import { parsePolicy } from "../src/policy/policy.ts";
import { switchRequestPass } from "../src/server/commands.ts";
import { appendMessages } from "../src/store/conversations.ts";
import type { Db } from "../src/store/db.ts";
import { ensureChat, getChat } from "../src/store/events.ts";
import { addModel, addProvider } from "../src/store/models.ts";
import { claimTurn, getTurn, saveSession, setTurnPid } from "../src/store/turns.ts";
import { memDb, OWNER, ownerChatId, ownerSays } from "./helpers.ts";

/** A chat's settings page (console/chat-settings*.ts): every write, through the console's write boundary. Made-up names. */

const PORT = 8787;
const HOST = `127.0.0.1:${PORT}`;
const BASE = `http://${HOST}`;
const SECRET = "example-csrf-secret";
const LOGIN = "owner@example.com";
const CSRF = csrfToken(SECRET, `login:${LOGIN}`);
const GROUP = -100777;

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const POLICY = `# Who may do what (an example file).
owner: ${OWNER}
chats:
  dm:
    tools: all

  # The example group: lookups and its notes.
  "${GROUP}":
    title: Example Group   # as people call it
    trigger: [mention, reply]
    persona: [public]
    memory: [chat]
    tools:
      web: {}
      chat: {}        # memory and retrieval

  "-100888":
    title: Other Example
    # keep this one quiet
    trigger: [mention]
    tools: all
unknown_chat: ignore
`;

function byHand(home: string, files: Record<string, string>): void {
  if (!existsSync(join(home, ".git"))) Bun.spawnSync(["git", "-C", home, "init", "-q"]);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(home, rel)), { recursive: true });
    writeFileSync(join(home, rel), text);
  }
  const env = { ...process.env, GIT_AUTHOR_NAME: "Someone Else", GIT_AUTHOR_EMAIL: "else@example.com", GIT_COMMITTER_NAME: "Someone Else", GIT_COMMITTER_EMAIL: "else@example.com" };
  Bun.spawnSync(["git", "-C", home, "-c", "commit.gpgsign=false", "add", "-A"], { env });
  Bun.spawnSync(["git", "-C", home, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "by hand"], { env });
}
const git = (home: string, ...args: string[]) => Bun.spawnSync(["git", "-C", home, ...args]).stdout.toString().trim();
const commits = (home: string) => Number(git(home, "rev-list", "--count", "HEAD"));
const policyText = (home: string) => readFileSync(join(home, "policy.yaml"), "utf8");

interface World {
  db: Db;
  home: string;
  dm: number;
  group: number;
  signals: number[];
}

/** A catalog (opus, the default qwen, llama), the owner's DM that has talked on qwen, a listed group, a profile. */
function world(): World {
  const db = memDb();
  const home = mkdtempSync(join(tmpdir(), "shuvi-cset-"));
  dirs.push(home);
  byHand(home, { "persona/public.md": "You are Example Bot.\n", "policy.yaml": POLICY, "profiles/work/profile.yaml": 'label: "Work hours"\nhides: []\n' });
  addProvider(db, { name: "claude", kind: "claude", configDir: home });
  addModel(db, { provider: "claude", model: "opus" });
  addProvider(db, { name: "vllm", kind: "openai-compat", baseUrl: "http://127.0.0.1:9/v1" });
  addModel(db, { provider: "vllm", model: "qwen", contextWindow: 32_000, isDefault: true });
  addModel(db, { provider: "vllm", model: "llama", contextWindow: 8_000 });
  ownerSays(db, "hi");
  const dm = ownerChatId(db);
  enterChatModel(db, getChat(db, dm)!);
  appendMessages(db, dm, "oa-1", [
    { role: "user", content: "T1-PROMPT" },
    { role: "assistant", content: [{ type: "text", text: "T1-ANSWER" }] },
  ]);
  saveSession(db, dm, "oa-1");
  const group = ensureChat(db, { id: GROUP, kind: "group", title: "Example Group" }).id;
  return { db, home, dm, group, signals: [] };
}

function deps(w: World): ConsoleDeps {
  const c = { listen: HOST };
  return {
    db: w.db,
    home: w.home,
    timeZone: "UTC",
    dataDir: "/nonexistent",
    ownerId: OWNER,
    allowedHosts: allowedHosts(c, PORT),
    allowedOrigins: allowedOrigins(c, PORT),
    csrfSecret: SECRET,
    users: new Set([LOGIN]),
    prompt: { capabilities: enabledCapabilities({ SHUVI_OWNER_ID: String(OWNER), SHUVI_WEB: "off" }), ownerId: OWNER },
    signalTurn: (pid) => void w.signals.push(pid),
  };
}

async function get(w: World, path: string): Promise<Response> {
  return handleConsole(deps(w), new Request(`${BASE}${path}`, { headers: { [LOGIN_HEADER]: LOGIN } }));
}
const page = async (w: World, path: string) => (await get(w, path)).text();

function post(w: World, path: string, fields: [string, string][] | Record<string, string>, o: { origin?: string | null; csrf?: string } = {}): Promise<Response> {
  const body = new URLSearchParams(Array.isArray(fields) ? fields : Object.entries(fields));
  body.set("csrf", o.csrf ?? CSRF);
  const headers: Record<string, string> = { [LOGIN_HEADER]: LOGIN, "content-type": "application/x-www-form-urlencoded" };
  if (o.origin !== null) headers.origin = o.origin ?? BASE;
  return handleConsole(deps(w), new Request(`${BASE}${path}`, { method: "POST", headers, body }));
}

/** POST, check the 303 back to the settings page, and read the page it leads to (its one-time result included). */
async function act(w: World, chatId: number, verb: string, fields: [string, string][] | Record<string, string>): Promise<{ html: string; location: string }> {
  const res = await post(w, `/chats/${chatId}/settings/${verb}`, fields);
  expect(res.status).toBe(303);
  const location = res.headers.get("location")!;
  // Back to the category the write came from: Chat (the bare URL), Permissions.
  expect(location).toMatch(new RegExp(`^/chats/${chatId}/settings${verb === "policy" ? "/permissions" : ""}\\?r=[\\w-]+#\\w+$`));
  return { html: await page(w, location), location };
}

/** The Permissions form of Example Group as it is, with `change` applied (field → values). */
function groupForm(change: Record<string, string[]> = {}): [string, string][] {
  const base: Record<string, string[]> = {
    title: ["Example Group"],
    trigger_mode: ["some"],
    trigger: ["mention", "reply"],
    followup_minutes: ["3"],
    persona: ["public"],
    memory: ["chat"],
    tools_mode: ["some"],
    tool: ["web", "memory", "retrieval"],
    operators_mode: ["none"],
    operator_ids: [""],
    ...change,
  };
  return Object.entries(base).flatMap(([k, vs]) => vs.map((v) => [k, v] as [string, string]));
}

describe("the way in", () => {
  test("⚙ Settings on a chat's pages and in the list; the chat page's old Profile select is gone", async () => {
    const w = world();
    const chat = await page(w, `/chats/${w.dm}`);
    expect(chat).toContain(`href="/chats/${w.dm}/settings"`);
    expect(chat).toContain("⚙ Settings");
    expect(chat).toContain('class="ggear"');
    expect(chat).not.toContain(`/chats/${w.dm}/profile`);
    const s = await page(w, `/chats/${w.dm}/settings`);
    expect(s).toContain("<h1>DM · Owner</h1>");
    // The Chat category: its three sections, and real tabs to the other two pages, Chat marked.
    for (const id of ["model", "profile", "conversation"]) expect(s).toContain(`id="${id}"`);
    expect(s).not.toContain('id="permissions"');
    expect(s).toContain(`<a class="on" href="/chats/${w.dm}/settings" aria-current="page">Chat</a>`);
    expect(s).toContain(`<a href="/chats/${w.dm}/settings/permissions">Permissions</a>`);
    expect(s).toContain(`<a href="/chats/${w.dm}/settings/automation">Automation &amp; machine</a>`);
    const p = await page(w, `/chats/${w.dm}/settings/permissions`);
    expect(p).toContain('id="permissions"');
    expect(p).not.toContain('id="model"');
    expect(p).toContain(`<a class="on" href="/chats/${w.dm}/settings/permissions" aria-current="page">Permissions</a>`);
    const a = await page(w, `/chats/${w.dm}/settings/automation`);
    for (const id of ["schedules", "secrets", "computer"]) expect(a).toContain(`id="${id}"`);
    expect(a).not.toContain('id="model"');
    expect((await get(w, `/chats/${w.dm}/settings/elsewhere`)).status).toBe(404);
    expect(s).toContain('<span class="mid">vllm/qwen</span>');
    expect(s).toContain('<span class="nowtag">current</span>');
    expect((await get(w, "/chats/999/settings")).status).toBe(404);
  });
});

describe("every write is a POST through the write boundary", () => {
  test("405 on GET, 403 without the Origin or the token; nothing changes", async () => {
    const w = world();
    for (const verb of ["switch", "profile", "stop", "new", "policy"]) {
      expect((await get(w, `/chats/${w.dm}/settings/${verb}`)).status).toBe(405);
      expect((await post(w, `/chats/${w.dm}/settings/${verb}`, { profile: "work", to: "claude/opus", mode: "lossy" }, { origin: null })).status).toBe(403);
      expect((await post(w, `/chats/${w.dm}/settings/${verb}`, { profile: "work", to: "claude/opus", mode: "lossy" }, { origin: "https://elsewhere.example" })).status).toBe(403);
      expect((await post(w, `/chats/${w.dm}/settings/${verb}`, { profile: "work", to: "claude/opus", mode: "lossy" }, { csrf: "wrong" })).status).toBe(403);
    }
    expect(getChat(w.db, w.dm)!.profile).toBeNull();
    expect(getChat(w.db, w.dm)!.backendSessionId).toBe("oa-1");
    expect(w.db.$client.query("select count(*) as n from model_switch_requests").get()).toEqual({ n: 0 });
  });
});

describe("model", () => {
  test("a row shows the bot's Lossless / Lossy lines; a switch is the bot's request; open bot cards follow; the result shows once", async () => {
    const w = world();
    // An open /model card in the control bot for the chat, at its mode step.
    modelCommand(w.db, "update:1", String(w.dm), (a) => getChat(w.db, Number(a)));
    const card = w.db.$client.query("select id from control_cards where kind = 'switch'").get() as { id: number };
    const picked = await page(w, `/chats/${w.dm}/settings?to=vllm/llama`);
    expect(picked).toContain("Switch from <span class=\"mono\">vllm/qwen</span> to <span class=\"mono\">vllm/llama</span>. How?");
    expect(picked).toContain("copies the whole conversation (2 messages) to vllm/llama");
    expect(picked).toContain("vllm/llama starts fresh with the last 10 messages");

    const { html, location } = await act(w, w.dm, "switch", { to: "vllm/llama", mode: "lossless" });
    expect(html).toContain("Switching to <span class=\"mono\">vllm/llama</span> (lossless)");
    expect(getCard(w.db, card.id)!.status).toBe("closed");
    expect(getCard(w.db, card.id)!.text).toBe(SWITCHED_IN_CONSOLE);
    const req = w.db.$client.query("select id from model_switch_requests").get() as { id: number };
    expect(getSwitchRequest(w.db, req.id)!.status).toBe("pending");
    // The page's own card: no message to the bot.
    expect(w.db.$client.query("select count(*) as n from control_cards where idem_key like 'console-switch:%'").get()).toEqual({ n: 1 });
    expect((await page(w, `/chats/${w.dm}/settings/switching?req=${req.id}`))).toContain("Switching to");

    // The server's passes apply it, as for the bot.
    switchRequestPass(w.db, () => {});
    expect(switchCardPass(w.db)).toBe(1);
    expect(getChat(w.db, w.dm)!.model).toBe("vllm/llama");
    const done = await get(w, `/chats/${w.dm}/settings/switching?req=${req.id}`);
    const to = done.headers.get("hx-redirect")!;
    expect(to).toMatch(new RegExp(`^/chats/${w.dm}/settings\\?r=`));
    const after = await page(w, to);
    // The control bot's own words for the result (model-cards.ts `switchResultText`).
    expect(after).toContain(" → vllm/llama (lossless, 2 messages carried)</p>");
    expect(after).toMatch(/<span class="mid">vllm\/llama<\/span>(?:(?!<\/a>).)*<span class="nowtag">current<\/span>/s);
    expect(await page(w, to)).not.toContain("2 messages carried");
    expect(await page(w, location)).not.toContain("Switching to");

    // The model it is already on.
    expect((await act(w, w.dm, "switch", { to: "vllm/llama", mode: "lossy" })).html).toContain("already on vllm/llama");
    expect((await act(w, w.dm, "switch", { to: "nope/none", mode: "lossy" })).html).toContain("There is no model nope/none in the catalog.");
  });
});

describe("profile", () => {
  test("a press switches the chat, from its next turn; the result shows once; an unknown profile is refused", async () => {
    const w = world();
    const { html, location } = await act(w, w.dm, "profile", { profile: "work" });
    expect(getChat(w.db, w.dm)!.profile).toBe("work");
    expect(html).toContain("DM · Owner now runs on work, from its next turn.");
    expect(html).toMatch(/class="prow cur"[^>]*><span class="radio-dot"[^>]*><\/span> <span class="pname">work<\/span>/);
    expect(await page(w, location)).not.toContain("now runs on work");
    expect((await act(w, w.dm, "profile", { profile: "nope" })).html).toContain("There is no profile nope.");
    await act(w, w.dm, "profile", { profile: "" });
    expect(getChat(w.db, w.dm)!.profile).toBeNull();
  });
});

describe("conversation", () => {
  test("Stop the turn: as /stop, the running turn is signalled and marked; a turn that has ended is not", async () => {
    const w = world();
    expect(await page(w, `/chats/${w.dm}/settings`)).not.toContain("Stop the turn");
    const turn = claimTurn(w.db, w.dm)!;
    setTurnPid(w.db, turn.id, 4242, "1");
    expect(await page(w, `/chats/${w.dm}/settings`)).toContain(`Turn ${turn.id} is running`);
    expect((await act(w, w.dm, "stop", { turn: String(turn.id + 1) })).html).toContain(`Turn ${turn.id + 1} has ended`);
    expect(w.signals).toEqual([]);
    const { html } = await act(w, w.dm, "stop", { turn: String(turn.id) });
    expect(html).toContain(`Stopped turn ${turn.id}.`);
    expect(w.signals).toEqual([4242]);
    expect(getTurn(w.db, turn.id)!.stopSeq).not.toBeNull();
  });

  test("New conversation: asks first; then as /new, every conversation forgotten and a running turn stopped", async () => {
    const w = world();
    const confirm = await page(w, `/chats/${w.dm}/settings?confirm=new`);
    expect(confirm).toContain("Start a new conversation?");
    expect(confirm).toContain(`action="/chats/${w.dm}/settings/new"`);
    expect(getChat(w.db, w.dm)!.backendSessionId).toBe("oa-1");
    const turn = claimTurn(w.db, w.dm)!;
    setTurnPid(w.db, turn.id, 4343, "1");
    const { html } = await act(w, w.dm, "new", {});
    expect(html).toContain(`Stopped turn ${turn.id}; DM · Owner starts a new conversation`);
    expect(w.signals).toEqual([4343]);
    expect(getChat(w.db, w.dm)!.backendSessionId).toBeNull();
    expect(w.db.$client.query("select count(*) as n from chat_conversations where chat_id = ?").get(w.dm)).toEqual({ n: 0 });
  });
});

describe("permissions", () => {
  test("the form shows the entry; private layers are not offered in a group, and are in the DM", async () => {
    const w = world();
    const g = await page(w, `/chats/${w.group}/settings/permissions`);
    expect(g).toContain(`listed as <span class="mono">"${GROUP}"</span>`);
    expect(g).not.toContain('name="persona" value="private"');
    expect(g).not.toContain('name="memory" value="private"');
    expect(g).toContain('name="tool" value="web" checked');
    const d = await page(w, `/chats/${w.dm}/settings/permissions`);
    expect(d).toContain('name="persona" value="private" checked');
  });

  test("review shows the diff and writes nothing; save is one commit as the owner from the console; comments and other entries kept byte for byte", async () => {
    const w = world();
    const before = policyText(w.home);
    const n = commits(w.home);
    const form = groupForm({ trigger: ["mention", "reply", "followup"], followup_minutes: ["5"], tool: ["web", "memory", "retrieval", "workstream"], "param.workstream.products": ["widgetry"] });
    const review = await act(w, w.group, "policy", [...form, ["action", "review"]]);
    expect(review.html).toContain("Review: home/policy.yaml");
    expect(review.html).toContain("followup_minutes: 5");
    expect(policyText(w.home)).toBe(before);
    expect(commits(w.home)).toBe(n);
    const base = /name="base" value="([0-9a-f]+)"/.exec(review.html)![1]!;

    const saved = await act(w, w.group, "policy", [...form, ["action", "save"], ["base", base]]);
    expect(saved.html).toMatch(/Saved policy\.yaml \(commit [0-9a-f]+\)/);
    expect(commits(w.home)).toBe(n + 1);
    expect(git(w.home, "log", "-1", "--format=%an <%ae>%n%B")).toContain(`<${LOGIN}>`);
    expect(git(w.home, "log", "-1", "--format=%B")).toContain("Edited-In: console");
    expect(git(w.home, "show", "--name-only", "--format=", "HEAD")).toBe("policy.yaml");
    const after = policyText(w.home);
    // Everything outside the group's entry, byte for byte; inside it, an unchanged line keeps its comment.
    const [head] = before.split(`  "${GROUP}":\n`);
    expect(after.startsWith(`${head}  "${GROUP}":\n`)).toBe(true);
    const tail = before.slice(before.indexOf('\n  "-100888":'));
    expect(after.endsWith(tail)).toBe(true);
    expect(after).toContain("    title: Example Group   # as people call it\n");
    expect(after).toContain("      chat: {}        # memory and retrieval\n");
    expect(after).toContain("    trigger: [mention, reply, followup]\n    followup_minutes: 5\n");
    expect(after).toContain("      workstream: { products: [widgetry] }\n");
    const parsed = parsePolicy(after, OWNER);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.policy.chats[String(GROUP)]!.tools).toEqual({ web: {}, memory: {}, retrieval: {}, workstream: { products: ["widgetry"] } });
    expect(parsed.policy.chats[String(GROUP)]!.followupMinutes).toBe(5);
  });

  test("an invalid form is refused with the parser's reason, as it was typed; nothing is written", async () => {
    const w = world();
    const before = policyText(w.home);
    const n = commits(w.home);
    for (const action of ["review", "save"]) {
      const { html } = await act(w, w.group, "policy", [...groupForm({ operators_mode: ["ids"], operator_ids: ["2002, alice"], delegate: ["media"], tool: ["web", "memory", "retrieval", "media"] }), ["action", action]]);
      expect(html).toContain('<b>Not saved.</b> operators: &quot;alice&quot; is not a Telegram user id');
      expect(html).toContain('value="2002, alice"');
      expect(html).toContain('class="prow2 bad"');
    }
    expect((await act(w, w.group, "policy", [...groupForm({ followup_minutes: ["0"], trigger: ["followup"] }), ["action", "review"]])).html).toContain("followup_minutes must be a positive number");
    expect((await act(w, w.group, "policy", [...groupForm({ operators_mode: ["members"] }), ["action", "review"]])).html).toContain("nothing is delegated to them");
    expect(policyText(w.home)).toBe(before);
    expect(commits(w.home)).toBe(n);
  });

  test("a crafted POST cannot grant a private layer to a group, for review or for save", async () => {
    const w = world();
    const before = policyText(w.home);
    for (const [field, reason] of [
      ["persona", "persona: private is for the owner&#39;s DM only"],
      ["memory", "memory: private is for the owner&#39;s DM only"],
    ] as const) {
      for (const action of ["review", "save"]) {
        const form = groupForm({ [field]: field === "persona" ? ["public", "private"] : ["chat", "private"] });
        const { html } = await act(w, w.group, "policy", [...form, ["action", action], ["base", "anything"]]);
        expect(html).toContain(reason);
      }
    }
    expect(policyText(w.home)).toBe(before);
    // The owner's DM may have them.
    const dm = await act(w, w.dm, "policy", [["trigger_mode", "all"], ["persona", "public"], ["persona", "private"], ["memory", "private"], ["memory", "chat"], ["tools_mode", "some"], ["tool", "web"], ["action", "review"]]);
    expect(dm.html).toContain("Review: home/policy.yaml");
  });

  test("a save against a file that changed since the review is not written, and shows the diff against the file now", async () => {
    const w = world();
    const form = groupForm({ trigger: ["mention"] });
    const review = await act(w, w.group, "policy", [...form, ["action", "review"]]);
    const base = /name="base" value="([0-9a-f]+)"/.exec(review.html)![1]!;
    byHand(w.home, { "policy.yaml": POLICY.replace("# keep this one quiet", "# keep this one very quiet") });
    const n = commits(w.home);
    const { html } = await act(w, w.group, "policy", [...form, ["action", "save"], ["base", base]]);
    expect(html).toContain("policy.yaml changed after you reviewed it");
    expect(html).toContain("Review: home/policy.yaml");
    expect(commits(w.home)).toBe(n);
    // An unchanged form is no change at all.
    expect((await act(w, w.group, "policy", [...groupForm(), ["action", "review"]])).html).toContain("No change: policy.yaml already says that.");
  });

  test("a group not listed starts from the unknown-group card's proposal, and saving adds it at the end of chats", async () => {
    const w = world();
    const other = ensureChat(w.db, { id: -100999, kind: "group", title: "New Example" }).id;
    const html = await page(w, `/chats/${other}/settings/permissions`);
    expect(html).toContain("This group is not in policy.yaml");
    const review = await act(w, other, "policy", [["trigger_mode", "some"], ["trigger", "mention"], ["persona", "public"], ["memory", "chat"], ["tools_mode", "some"], ["tool", "web"], ["operators_mode", "none"], ["action", "review"]]);
    const base = /name="base" value="([0-9a-f]+)"/.exec(review.html)![1]!;
    await act(w, other, "policy", [["trigger_mode", "some"], ["trigger", "mention"], ["persona", "public"], ["memory", "chat"], ["tools_mode", "some"], ["tool", "web"], ["operators_mode", "none"], ["action", "save"], ["base", base]]);
    const after = policyText(w.home);
    expect(after).toContain('    tools: all\n  "-100999":\n    trigger: [mention]\n    tools:\n      web: {}\nunknown_chat: ignore\n');
  });
});

describe("policy/edit.ts replaceEntry", () => {
  test("only the entry's lines change; a layout it cannot edit in place is written whole, and says so", () => {
    const r = replaceEntry(POLICY, "-100888", { trigger: ["mention", "reply"], tools: "all" }, OWNER);
    if ("error" in r) throw new Error(r.error);
    expect(r.rewritten).toBe(false);
    expect(r.text).toBe(POLICY.replace("    trigger: [mention]\n", "    trigger: [mention, reply]\n").replace("    title: Other Example\n", ""));
    const flow = `owner: ${OWNER}\nchats: { dm: { tools: all } }  # inline\n`;
    const w = replaceEntry(flow, "dm", { trigger: "all", tools: "all" }, OWNER);
    if ("error" in w) throw new Error(w.error);
    expect(w.rewritten).toBe(true);
    expect(parsePolicy(w.text, OWNER)).toHaveProperty("policy");
    expect(replaceEntry(POLICY, String(GROUP), { persona: ["private"] }, OWNER)).toEqual({ error: expect.stringContaining("private is for the owner's DM only") });
  });
});

describe("without the stylesheet", () => {
  test("adjacent inline pieces are separated by real whitespace, so each page still reads as text", async () => {
    const w = world();
    const text = async (path: string) =>
      (await page(w, path))
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ");
    const chat = await text(`/chats/${w.dm}/settings`);
    expect(chat).toContain("Base her own files, no overlay");
    expect(chat).toContain("work Work hours no files of its own yet");
    expect(chat).toContain("Model what her turns here run on The catalog →");
    expect(chat).toContain("New conversation As /new does:");
    expect(chat).toContain("Chat Permissions Automation & machine");
    const perms = await text(`/chats/${w.group}/settings/permissions`);
    expect(perms).toContain("web lookups web_search");
    expect(perms).toContain("Review changes Reset Nothing is written");
    expect(perms).toContain("persona public persona");
  });
});

describe("review fixes", () => {
  const entry = (text: string, key: string) => {
    const p = parsePolicy(text, OWNER);
    if ("error" in p) throw new Error(p.error);
    return p.policy.chats[key];
  };

  test("a key written so that it reads as another (-0100888) is found and edited in place, never duplicated", () => {
    const text = POLICY.replace('  "-100888":\n', "  -0100888:\n");
    const r = replaceEntry(text, "-100888", { trigger: ["mention", "reply"], tools: "all" }, OWNER);
    if ("error" in r) throw new Error(r.error);
    expect(r.rewritten).toBe(false);
    expect(r.text.match(/100888/g)).toHaveLength(1);
    expect(entry(r.text, "-100888")!.trigger).toEqual(["mention", "reply"]);
  });

  test("two lines naming one chat: not edited in place; written whole, and the result reads back as asked", () => {
    const text = POLICY.replace("unknown_chat: ignore\n", '  "-100888":\n    trigger: [reply]\nunknown_chat: ignore\n');
    const r = replaceEntry(text, "-100888", { trigger: ["mention"], tools: "all" }, OWNER);
    if ("error" in r) throw new Error(r.error);
    expect(r.rewritten).toBe(true);
    expect(r.text.match(/"-100888"|-100888:/g)).toHaveLength(1);
    expect(entry(r.text, "-100888")!.trigger).toEqual(["mention"]);
    expect(entry(r.text, String(GROUP))).toEqual(entry(text, String(GROUP)));
  });

  test("an in-place result that does not parse (an alias into the replaced lines) falls back to the whole-file rewrite", () => {
    const text = POLICY.replace("    tools:\n      web: {}\n      chat: {}        # memory and retrieval\n", "    tools: &lookups\n      web: {}\n").replace("    trigger: [mention]\n    tools: all\n", "    trigger: [mention]\n    tools: *lookups\n");
    expect(entry(text, "-100888")!.tools).toEqual({ web: {} });
    const r = replaceEntry(text, String(GROUP), { trigger: ["mention"], persona: ["public"], memory: ["chat"], tools: { web: {}, vision: {} } }, OWNER);
    if ("error" in r) throw new Error(r.error);
    expect(r.rewritten).toBe(true);
    expect(entry(r.text, String(GROUP))!.tools).toEqual({ web: {}, vision: {} });
    expect(entry(r.text, "-100888")!.tools).toEqual({ web: {} });
  });

  test("a key with a YAML escape JSON does not know is decoded as YAML reads it, not a 500", async () => {
    const w = world();
    byHand(w.home, { "policy.yaml": POLICY.replace(`  "${GROUP}":\n`, `  "\\x2d100777":\n`) });
    expect(entry(policyText(w.home), String(GROUP))).toBeDefined();
    const res = await post(w, `/chats/${w.group}/settings/policy`, [...groupForm({ trigger: ["mention"] }), ["action", "review"]]);
    expect(res.status).toBe(303);
    expect(await page(w, res.headers.get("location")!)).toContain("Review: home/policy.yaml");
  });

  test("a crafted unknown capability is refused; one the file already gives the chat is kept", async () => {
    const w = world();
    const refused = await act(w, w.group, "policy", [...groupForm({ tool: ["web", "memory", "retrieval", "evil-tool"] }), ["action", "review"]]);
    expect(refused.html).toContain("tools: &quot;evil-tool&quot; is not a capability of this build");
    byHand(w.home, { "policy.yaml": POLICY.replace("      web: {}\n", "      web: {}\n      future-thing: {}\n") });
    const kept = await act(w, w.group, "policy", [...groupForm({ tool: ["web", "memory", "retrieval", "future-thing"], trigger: ["mention"] }), ["action", "review"]]);
    expect(kept.html).toContain("Review: home/policy.yaml");
    expect(kept.html).not.toContain("Not saved.");
  });

  test("a broken policy.yaml says what is wrong and where to fix it, with no link to Home", async () => {
    const w = world();
    byHand(w.home, { "policy.yaml": POLICY.replace("trigger: [mention, reply]", "trigger: [shouting]") });
    const html = await page(w, `/chats/${w.group}/settings/permissions`);
    expect(html).toContain("policy.yaml is broken as it is:");
    expect(html).toContain("edit home/policy.yaml on the machine shuvi runs on, or ask her to propose a change");
    expect(html).not.toContain("/home?file=policy.yaml");
    const refused = await act(w, w.group, "policy", [...groupForm(), ["action", "review"]]);
    expect(refused.html).toContain("Not saved.</b> policy.yaml is broken as it is:");
  });

  test("Home's new-profile panel points at a chat's settings page", async () => {
    const w = world();
    expect(await page(w, "/home?panel=new&pane=files")).toContain("on that chat's settings page (⚙ Settings beside its name), or with /profile");
  });

  test("a double submit of one page's switch asks once, and both answers follow the one request", async () => {
    const w = world();
    const key = /name="key" value="([\w-]+)"/.exec(await page(w, `/chats/${w.dm}/settings?to=vllm/llama`))![1]!;
    const first = await act(w, w.dm, "switch", { to: "vllm/llama", mode: "lossless", key });
    const second = await act(w, w.dm, "switch", { to: "vllm/llama", mode: "lossy", key });
    for (const r of [first, second]) expect(r.html).toContain("Switching to <span class=\"mono\">vllm/llama</span> (lossless)");
    expect(w.db.$client.query("select count(*) as n from model_switch_requests").get()).toEqual({ n: 1 });
    expect(w.db.$client.query("select count(*) as n from control_cards where idem_key like 'console-switch:%'").get()).toEqual({ n: 1 });
  });

  test("a switch pending for the chat, asked anywhere, shows on the page", async () => {
    const w = world();
    requestSwitch(w.db, w.dm, "claude/opus", "lossy");
    const html = await page(w, `/chats/${w.dm}/settings`);
    expect(html).toContain("Switching to <span class=\"mono\">claude/opus</span> (lossy)");
    expect(html).toContain('<span class="mrow cur"');
  });
});
