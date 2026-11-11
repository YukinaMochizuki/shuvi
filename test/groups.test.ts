import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Update } from "grammy/types";
import { CALLED_PREFIX, CONTEXT_HEADING } from "../src/agent/render.ts";
import { runTurn } from "../src/agent/turn.ts";
import { isTrigger, TriggerScan, type BotIdentity } from "../src/agent/triggers.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import { chatCapabilities } from "../src/capabilities/types.ts";
import { answerApproval, getApproval } from "../src/control/approvals.ts";
import { LAST_GOOD_KEY, loadPolicy, PolicyWatch } from "../src/policy/load.ts";
import { checkEntry, DM_DEFAULT, parsePolicy, resolveChat, type Policy } from "../src/policy/policy.ts";
import { applyChange, applyPolicyApprovals, lineDiff, requestPolicyChange } from "../src/policy/write.ts";
import { recordBatch } from "../src/server/poller.ts";
import { wakerPass } from "../src/server/waker.ts";
import { controlMessagesOf } from "../src/store/control.ts";
import type { Db } from "../src/store/db.ts";
import { allChats, enqueueOutbound, getChat, kvGet, markSent, type BotMessagePayload, type Chat, type ChatEvent, type MessagePayload } from "../src/store/events.ts";
import { claimTurn, finishTurn, getTurn } from "../src/store/turns.ts";
import { classify } from "../src/telegram/inbound.ts";
import { dmUpdate, groupUpdate as tgGroupUpdate, lastSeq, memDb, OWNER, ownerChatId, ownerSays, ScriptedAdapter, type Step } from "./helpers.ts";

const BOT: BotIdentity = { id: 1, username: "shuvi_test_bot" };
const GROUP = -100777;
const ALICE = 2001;
const BOB = 2002;
const OTHER_BOT = 3001;

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "shuvi-groups-"));
  mkdirSync(join(home, "persona"));
  mkdirSync(join(home, "memory"));
  writeFileSync(join(home, "persona/public.md"), "PUBLIC PERSONA");
  writeFileSync(join(home, "persona/private.md"), "PRIVATE PERSONA");
  writeFileSync(join(home, "memory/private.md"), "PRIVATE MEMORY");
  mkdirSync(join(home, "chats"));
  writeFileSync(join(home, `chats/${GROUP}.md`), "GROUP NOTES");
  return home;
}

const POLICY_YAML = `
owner: ${OWNER}
chats:
  dm:
    persona: [public, private]
    memory: [private, chat]
    tools: all
  "${GROUP}":
    title: Friends
    trigger: [mention, reply, followup]
    persona: [public]
    tools:
      chat: {}
      web: {}
      workstream-read: { products: [widgetry] }
unknown_chat: ignore
`;

const policyOf = (text = POLICY_YAML): Policy => {
  const r = parsePolicy(text, OWNER);
  if ("error" in r) throw new Error(r.error);
  return r.policy;
};

let nextUpdate = 5000;
const NAMES: Record<number, [string, string?]> = { [OWNER]: ["Ownerly", "ownerly_test"], [ALICE]: ["Alice", "alice"], [BOB]: ["Bob Lee"], [OTHER_BOT]: ["Helper", "helper_bot"] };

/** A Telegram update: a message in a group, from one of the people above. */
function groupUpdate(text: string, from: number, extra: Record<string, unknown> = {}, chat = GROUP, title = "Friends"): Update {
  const [first, username] = NAMES[from] ?? ["Someone"];
  return tgGroupUpdate(nextUpdate++, { id: chat, title }, { id: from, first, ...(username ? { username } : {}), isBot: from === OTHER_BOT }, text, extra);
}

function record(db: Db, policy: Policy, ...updates: Update[]): void {
  recordBatch(db, updates, OWNER, { botUsername: BOT.username!, policy });
}

const groupChat = (db: Db): Chat => allChats(db).find((c) => c.tgChatId === GROUP)!;
const events = (db: Db, chat: Chat): ChatEvent[] => db.$client.query("select * from chat_events where chat_id = ? order by seq").all(chat.id).map((r: any) => ({ ...r, chatId: r.chat_id, payload: JSON.parse(r.payload) })) as never;

const setAt = (db: Db, seq: number, at: Date) => db.$client.query("update chat_events set at = ? where seq = ?").run(at.toISOString(), seq);

// ---- policy.yaml ----------------------------------------------------------------------------------------

describe("policy.yaml", () => {
  test("parses design §8's shape; aliases map to capabilities; a group gets its defaults", () => {
    const p = policyOf();
    expect(p.owner).toBe(OWNER);
    expect(p.chats.dm).toEqual(DM_DEFAULT);
    const g = p.chats[String(GROUP)]!;
    expect(g.trigger).toEqual(["mention", "reply", "followup"]);
    expect(g.followupMinutes).toBe(3);
    expect(g.memory).toEqual(["chat"]);
    expect(g.tools).toEqual({ memory: {}, retrieval: {}, web: {}, workstream: { products: ["widgetry"] } });
  });

  test("the owner's DM works with no file, and with a file that does not list it, exactly as before", () => {
    for (const policy of [policyOf(""), policyOf(`chats:\n  "${GROUP}": {}\n`)]) {
      expect(resolveChat(policy, { kind: "private", tgChatId: OWNER }, OWNER)).toEqual({ ...DM_DEFAULT, key: "dm", ownerDm: true });
    }
    expect(resolveChat(policyOf(""), { kind: "group", tgChatId: GROUP })).toBeNull();
    expect(resolveChat(policyOf(""), { kind: "private", tgChatId: 999 }, OWNER)).toBeNull();
  });

  test("a broken file is refused with the reason: private layers in a group, unknown keys, another owner, bad triggers", () => {
    const bad = [
      [`chats:\n  "${GROUP}":\n    persona: [public, private]\n`, "owner's DM only"],
      [`chats:\n  "${GROUP}":\n    memory: [private]\n`, "owner's DM only"],
      [`chats:\n  "${GROUP}":\n    trigerr: [mention]\n`, 'unknown key "trigerr"'],
      [`owner: 42\n`, "SHUVI_OWNER_ID"],
      [`chats:\n  "${GROUP}":\n    trigger: [shout]\n`, '"shout"'],
      [`chats:\n  "12345": {}\n`, "private chat"],
      [`chats: [\n`, "YAML"],
      [`unknown_chat: answer\n`, "unknown_chat"],
    ] as const;
    for (const [text, reason] of bad) {
      const r = parsePolicy(text, OWNER);
      expect("error" in r && r.error).toContain(reason);
    }
  });

  test("a broken file keeps the last good policy and alerts once; the child reads the same; a missing file is the default", () => {
    const db = memDb();
    const home = newHome();
    writeFileSync(join(home, "policy.yaml"), POLICY_YAML);
    const watch = new PolicyWatch(db, home, OWNER);
    expect(Object.keys(watch.current().chats)).toEqual(["dm", String(GROUP)]);
    expect(kvGet(db, LAST_GOOD_KEY)).toBeTruthy();

    writeFileSync(join(home, "policy.yaml"), `${POLICY_YAML}\n  oops: [`);
    expect(watch.refresh()).toBe(true);
    expect(Object.keys(watch.current().chats)).toEqual(["dm", String(GROUP)]);
    // A runner child, started now, reads the same file and falls back to the same last good policy.
    expect(loadPolicy(db, home, OWNER)).toEqual(watch.current());
    expect(watch.refresh()).toBe(false);
    const alerts = controlMessagesOf(db, "alert").filter((a) => a.text.includes("policy.yaml is broken"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.text).toContain("last good policy stays");

    writeFileSync(join(home, "policy.yaml"), `chats:\n  "${GROUP}":\n    trigger: all\n`);
    watch.refresh();
    expect(watch.current().chats[String(GROUP)]!.trigger).toBe("all");
  });
});

// ---- per-chat filtering ---------------------------------------------------------------------------------

describe("per-chat capabilities and layers", () => {
  const ENV = { SHUVI_WORKSTREAM_MCP_URL: "http://127.0.0.1:1/mcp", SHUVI_WORKSTREAM_MCP_TOKEN: "t" };

  test("only the capabilities the chat enables, with their parameters; speech and groups always", () => {
    const caps = enabledCapabilities(ENV);
    const g = resolveChat(policyOf(), { kind: "group", tgChatId: GROUP })!;
    const used = chatCapabilities(caps, g.tools);
    expect(used.map((c) => c.capability.id)).toEqual(["speech", "web", "workstream", "memory", "retrieval", "groups"]);
    expect((used.find((c) => c.capability.id === "workstream")!.config as { products?: string[] }).products).toEqual(["widgetry"]);
    expect(chatCapabilities(caps, "all").map((c) => c.capability.id)).toEqual(caps.map((c) => c.capability.id));
  });

  async function groupTurn(db: Db, policy: Policy, script: Step[], env: Record<string, string> = ENV, home = newHome()) {
    const chat = groupChat(db);
    const t = new TriggerScan().newestTrigger(db, chat, resolveChat(policy, chat)!, BOT, policy);
    const turn = claimTurn(db, chat.id, t ?? undefined)!;
    let adapter!: ScriptedAdapter;
    const outcome = await runTurn({ db, turnId: turn.id, home, timeZone: "UTC", ownerId: OWNER, capabilities: enabledCapabilities(env), policy, bot: BOT, makeAdapter: (b) => (adapter = new ScriptedAdapter(b, script)) });
    return { adapter, outcome, turn: getTurn(db, turn.id)! };
  }

  test("a group's prompt has the public persona and its notes, never the private layers; its tools are the policy's", async () => {
    const db = memDb();
    const policy = policyOf();
    record(db, policy, groupUpdate("@shuvi_test_bot hello", ALICE));
    const { adapter } = await groupTurn(db, policy, [{ tool: "pass" }]);
    const sp = adapter.calls[0]!.systemPrompt!;
    expect(sp).toContain("PUBLIC PERSONA");
    expect(sp).toContain("GROUP NOTES");
    expect(sp).toContain('The group "Friends"');
    expect(sp).toContain("## In a group");
    expect(sp).not.toContain("PRIVATE PERSONA");
    expect(sp).not.toContain("PRIVATE MEMORY");
    expect(sp).toContain("only these products: widgetry");
    expect(adapter.calls[0]!.tools).toEqual(["say", "react", "pass", "ask_workstream", "read_home", "edit_home", "write_home", "edit_chat_notes", "search_chats", "read_chat", "send", "propose_policy", "read_policy", "explain_policy", "web_fetch"]);
  });

  test("workstream-read limits ask_workstream to its products, before the desk is asked", async () => {
    const db = memDb();
    const policy = policyOf();
    record(db, policy, groupUpdate("@shuvi_test_bot ask the shuvi desk", OWNER));
    const { adapter } = await groupTurn(db, policy, [{ tool: "ask_workstream", args: { product: "shuvi", message: "x" } }, { tool: "pass" }]);
    const r = adapter.toolResults[0]!.result;
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("only widgetry");
  });

  test("the DM with the default policy gets every capability and every layer", async () => {
    const db = memDb();
    ownerSays(db, "hi");
    const turn = claimTurn(db, ownerChatId(db))!;
    let adapter!: ScriptedAdapter;
    await runTurn({ db, turnId: turn.id, home: newHome(), timeZone: "UTC", ownerId: OWNER, capabilities: enabledCapabilities({}), makeAdapter: (b) => (adapter = new ScriptedAdapter(b, [{ tool: "pass" }])) });
    const sp = adapter.calls[0]!.systemPrompt!;
    expect(sp).toContain("PRIVATE PERSONA");
    expect(sp).toContain("PRIVATE MEMORY");
    expect(sp).not.toContain("## In a group");
  });

  const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");

  test("S2: memory's tools follow the chat's layers: a group with no persona and no notes reaches neither", async () => {
    const db = memDb();
    const policy = policyOf(`chats:\n  "${GROUP}":\n    title: Friends\n    trigger: [mention]\n    persona: []\n    memory: []\n    tools: { memory: {} }\n`);
    record(db, policy, groupUpdate("@shuvi_test_bot remember I like tea", OWNER));
    const { adapter } = await groupTurn(db, policy, [
      { tool: "read_home", args: { path: "persona/public.md" } },
      { tool: "read_home", args: { path: `chats/${GROUP}.md` } },
      { tool: "edit_chat_notes", args: { content: "- likes tea", why: "asked" } },
      { tool: "read_home", args: { path: "directives.md" } },
      { tool: "pass" },
    ]);
    const [persona, notes, edit, directives] = adapter.toolResults.map((r) => r.result);
    expect(persona!.isError).toBe(true);
    expect(notes!.isError).toBe(true);
    expect(edit!.isError).toBe(true);
    expect(textOf(edit!)).toContain("not available in this chat");
    expect(directives!.isError).toBeFalsy();
    const sp = adapter.calls[0]!.systemPrompt!;
    expect(sp).not.toContain("PUBLIC PERSONA");
    expect(sp).not.toContain("GROUP NOTES");
    expect(sp).not.toContain("edit_chat_notes");
    expect(sp).not.toContain(`chats/${GROUP}.md`);
  });

  test("S2: a DM narrowed to memory: [chat] cannot read memory/private.md", async () => {
    const db = memDb();
    ownerSays(db, "what do you remember about me?");
    const policy = policyOf("chats:\n  dm:\n    memory: [chat]\n");
    const turn = claimTurn(db, ownerChatId(db))!;
    let adapter!: ScriptedAdapter;
    await runTurn({ db, turnId: turn.id, home: newHome(), timeZone: "UTC", ownerId: OWNER, capabilities: enabledCapabilities({}), policy, makeAdapter: (b) => (adapter = new ScriptedAdapter(b, [{ tool: "read_home", args: { path: "memory/private.md" } }, { tool: "read_home", args: { path: "persona/private.md" } }, { tool: "pass" }])) });
    expect(adapter.toolResults[0]!.result.isError).toBe(true);
    expect(adapter.toolResults[1]!.result.isError).toBeFalsy();
    const sp = adapter.calls[0]!.systemPrompt!;
    expect(sp).not.toContain("PRIVATE MEMORY");
    expect(sp).not.toContain("`memory/private.md`");
    expect(sp).toContain("PRIVATE PERSONA");
  });
});

// ---- group inbound ---------------------------------------------------------------------------------------

describe("group inbound", () => {
  test("a listed group's messages are recorded from anyone, other bots included, with display names and mentions", () => {
    const policy = policyOf();
    const c = classify(groupUpdate("hi @Shuvi_Test_Bot and @alice", BOB), OWNER, BOT.username, policy);
    expect(c).toMatchObject({ kind: "message", chat: { id: GROUP, type: "group", title: "Friends" }, payload: { from: { id: BOB, name: "Bob Lee" }, mentions: { usernames: ["shuvi_test_bot", "alice"], userIds: [] } } });
    expect(classify(groupUpdate("beep", OTHER_BOT), OWNER, BOT.username, policy)).toMatchObject({ kind: "message", payload: { from: { name: "Helper", isBot: true } } });
    const tm = classify(groupUpdate("hey you", ALICE, { entities: [{ type: "text_mention", offset: 4, length: 3, user: { id: BOT.id, is_bot: true, first_name: "shuvi" } }] }), OWNER, BOT.username, policy);
    expect(tm).toMatchObject({ payload: { mentions: { userIds: [BOT.id] } } });
    const reply = classify(groupUpdate("yes", ALICE, { reply_to_message: { message_id: 9, from: { id: BOT.id, is_bot: true, first_name: "shuvi" }, text: "want tea?" } }), OWNER, BOT.username, policy);
    expect(reply).toMatchObject({ payload: { replyTo: { fromId: BOT.id, fromName: "shuvi" } } });
  });

  test("in a group a command counts only from the owner; anyone else's is something they said", () => {
    const policy = policyOf();
    expect(classify(groupUpdate("/stop@shuvi_test_bot", OWNER), OWNER, BOT.username, policy)).toMatchObject({ kind: "command", payload: { command: "stop" } });
    expect(classify(groupUpdate("/stop@shuvi_test_bot", ALICE), OWNER, BOT.username, policy).kind).toBe("message");
  });

  test("an unlisted group is not recorded; its first message asks the owner once, with a proposed entry; approving writes it", () => {
    const db = memDb();
    const home = newHome();
    const ctx = { botUsername: BOT.username!, policy: policyOf(""), home };
    recordBatch(db, [groupUpdate("anyone here?", ALICE, {}, -100555, "Strangers"), groupUpdate("hello?", BOB, {}, -100555, "Strangers")], OWNER, ctx);
    recordBatch(db, [groupUpdate("hello??", BOB, {}, -100555, "Strangers")], OWNER, ctx);
    expect(allChats(db)).toHaveLength(0);
    const cards = controlMessagesOf(db, "approval");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text).toContain('Add the group "Strangers" (-100555)?');
    expect(cards[0]!.text).toContain("Alice (@alice), user id 2001 wrote in");
    expect(cards[0]!.text).toContain('+   "-100555":');
    expect(cards[0]!.text).toContain("+       - mention");

    expect(answerApproval(db, cards[0]!.approvalId!, 0, { id: OWNER, name: "Ownerly" }).result).toBe("answered");
    expect(applyPolicyApprovals(db, home, OWNER)).toBe(1);
    expect(applyPolicyApprovals(db, home, OWNER)).toBe(0);
    const written = policyOf(readFileSync(join(home, "policy.yaml"), "utf8"));
    expect(written.chats["-100555"]).toMatchObject({ title: "Strangers", trigger: ["mention", "reply", "followup"], persona: ["public"] });
    expect(written.chats.dm).toEqual(DM_DEFAULT);
    const log = Bun.spawnSync(["git", "-C", home, "log", "--format=%an|%s"]).stdout.toString().trim();
    expect(log).toBe(`shuvi|Policy: Add the group "Strangers" (-100555) (approval #${cards[0]!.approvalId})`);

    // Now listed: recorded.
    recordBatch(db, [groupUpdate("now?", BOB, {}, -100555, "Strangers")], OWNER, { ...ctx, policy: written });
    expect(allChats(db).map((c) => c.tgChatId)).toEqual([-100555]);
  });

  test("ignoring an unknown group writes nothing", () => {
    const db = memDb();
    const home = newHome();
    recordBatch(db, [groupUpdate("hi", ALICE, {}, -100556)], OWNER, { policy: policyOf(""), home });
    const card = controlMessagesOf(db, "approval")[0]!;
    answerApproval(db, card.approvalId!, 1, { id: OWNER, name: "Ownerly" });
    expect(applyPolicyApprovals(db, home, OWNER)).toBe(0);
    expect(() => readFileSync(join(home, "policy.yaml"))).toThrow();
  });

  test("a non-owner's private chat is ignored, and alerts at most once per user per day", () => {
    const db = memDb();
    const day1 = Date.parse("2026-11-11T10:00:00Z");
    recordBatch(db, [dmUpdate(nextUpdate++, "hello?", 777), dmUpdate(nextUpdate++, "hello??", 777)], OWNER, {}, day1);
    recordBatch(db, [dmUpdate(nextUpdate++, "anyone?", 777)], OWNER, {}, day1 + 3600_000);
    recordBatch(db, [dmUpdate(nextUpdate++, "hi", 778)], OWNER, {}, day1);
    recordBatch(db, [dmUpdate(nextUpdate++, "next day", 777)], OWNER, {}, day1 + 24 * 3600_000);
    const alerts = controlMessagesOf(db, "alert").filter((a) => a.text.includes("private chat"));
    expect(alerts.map((a) => a.idemKey)).toEqual(["stranger:777:2026-11-11", "stranger:778:2026-11-11", "stranger:777:2026-11-12"]);
    expect(allChats(db)).toHaveLength(0);
  });
});

// ---- triggers --------------------------------------------------------------------------------------------

describe("triggers, case by case", () => {
  const cp = () => resolveChat(policyOf(), { kind: "group", tgChatId: GROUP })!;
  function setup() {
    const db = memDb();
    const policy = policyOf();
    record(db, policy, groupUpdate("good morning all", ALICE));
    return { db, policy, chat: groupChat(db) };
  }
  const last = (db: Db, chat: Chat) => events(db, chat).at(-1)!;
  const trig = (db: Db, chat: Chat) => isTrigger(db, last(db, chat), cp(), BOT);

  test("an unaddressed message does not trigger; a mention (any case) or a text mention does", () => {
    const { db, policy, chat } = setup();
    expect(trig(db, chat)).toBe(false);
    record(db, policy, groupUpdate("@SHUVI_test_bot what time is it", BOB));
    expect(trig(db, chat)).toBe(true);
    record(db, policy, groupUpdate("hey you", ALICE, { entities: [{ type: "text_mention", offset: 4, length: 3, user: { id: BOT.id, is_bot: true, first_name: "shuvi" } }] }));
    expect(trig(db, chat)).toBe(true);
    record(db, policy, groupUpdate("@alice did you see", BOB));
    expect(trig(db, chat)).toBe(false);
  });

  test("a reply to her triggers; a reply to someone else does not", () => {
    const { db, policy, chat } = setup();
    record(db, policy, groupUpdate("thanks!", ALICE, { reply_to_message: { message_id: 1, from: { id: BOT.id, is_bot: true, first_name: "shuvi" }, text: "it is 9" } }));
    expect(trig(db, chat)).toBe(true);
    record(db, policy, groupUpdate("same", BOB, { reply_to_message: { message_id: 2, from: { id: ALICE, is_bot: false, first_name: "Alice" }, text: "x" } }));
    expect(trig(db, chat)).toBe(false);
  });

  /** A group turn woken by `trigger`, which said `texts` and ended at `endedAt`, as the store records it. */
  function turnAnswered(db: Db, chat: Chat, trigger: number, texts: { text: string; replyToSeq?: number }[], endedAt: Date): number {
    const t = claimTurn(db, chat.id, trigger)!;
    for (const [i, p] of texts.entries()) {
      enqueueOutbound(db, { chatId: chat.id, kind: "bot_message", payload: p, idemKey: `turn:${t.id}:${i}`, turnId: t.id });
      markSent(db, lastSeq(db), 90000 + lastSeq(db));
      setAt(db, lastSeq(db), endedAt);
    }
    finishTurn(db, t.id, { status: "done" });
    db.$client.query("update turns set ended_at = ? where id = ?").run(endedAt.toISOString(), t.id);
    return t.id;
  }

  test("followup: from someone her last turn answered, within followup_minutes of its end, not addressed elsewhere", () => {
    const { db, policy, chat } = setup();
    record(db, policy, groupUpdate("@shuvi_test_bot recommend a tea", ALICE));
    const t0 = Date.now() - 10 * 60_000;
    turnAnswered(db, chat, lastSeq(db), [{ text: "Try a sencha." }], new Date(t0));
    const at = (seq: number, ms: number) => setAt(db, seq, new Date(t0 + ms));

    record(db, policy, groupUpdate("hot or cold?", ALICE));
    at(lastSeq(db), 60_000);
    expect(trig(db, chat)).toBe(true); // Alice, a minute later

    record(db, policy, groupUpdate("I like oolong", BOB));
    at(lastSeq(db), 60_000);
    expect(trig(db, chat)).toBe(false); // Bob: she did not answer him
    const oolong = lastSeq(db);

    record(db, policy, groupUpdate("@bob_lee you too?", ALICE));
    at(lastSeq(db), 60_000);
    expect(trig(db, chat)).toBe(false); // addressed to someone else

    record(db, policy, groupUpdate("what about now", ALICE));
    at(lastSeq(db), 4 * 60_000);
    expect(trig(db, chat)).toBe(false); // past 3 minutes

    // The person a message of her last turn replied to counts as answered too.
    record(db, policy, groupUpdate("@shuvi_test_bot and Bob?", ALICE));
    turnAnswered(db, chat, lastSeq(db), [{ text: "Bob, oolong is lovely.", replyToSeq: oolong }], new Date());
    record(db, policy, groupUpdate("right?", BOB));
    expect(trig(db, chat)).toBe(true);
  });

  test("followup: a message from the person she is answering, sent while her turn runs, counts", () => {
    const { db, policy, chat } = setup();
    record(db, policy, groupUpdate("@shuvi_test_bot what's a good name for a cat", ALICE));
    const t = claimTurn(db, chat.id, lastSeq(db))!;
    record(db, policy, groupUpdate("a black one", ALICE));
    expect(trig(db, chat)).toBe(true); // while the turn runs
    record(db, policy, groupUpdate("cats are overrated", BOB));
    expect(trig(db, chat)).toBe(false); // a bystander
    finishTurn(db, t.id, { status: "done" });
    const alice = events(db, chat).find((e) => (e.payload as unknown as MessagePayload).text === "a black one")!;
    expect(isTrigger(db, alice, cp(), BOT)).toBe(true); // and still once it ended
  });

  test("N2: what she says in the group from the owner's DM neither opens nor extends a follow-up window", () => {
    const { db, policy, chat } = setup();
    record(db, policy, groupUpdate("@shuvi_test_bot hi", ALICE));
    const t0 = Date.now() - 10 * 60_000;
    turnAnswered(db, chat, lastSeq(db), [{ text: "Hi Alice!" }], new Date(t0));
    // A DM turn sends into the group two minutes later.
    ownerSays(db, "tell them dinner is at 8");
    const dm = claimTurn(db, ownerChatId(db))!;
    enqueueOutbound(db, { chatId: chat.id, kind: "bot_message", payload: { text: "Dinner is at 8." }, idemKey: `turn:${dm.id}:0`, turnId: dm.id });
    setAt(db, lastSeq(db), new Date(t0 + 2 * 60_000));
    finishTurn(db, dm.id, { status: "done" });

    record(db, policy, groupUpdate("ok", ALICE));
    setAt(db, lastSeq(db), new Date(t0 + 150_000));
    expect(trig(db, chat)).toBe(true); // her window from the group turn is still open
    record(db, policy, groupUpdate("thanks", ALICE));
    setAt(db, lastSeq(db), new Date(t0 + 4 * 60_000));
    expect(trig(db, chat)).toBe(false); // and the DM's message did not extend it
    record(db, policy, groupUpdate("great", BOB));
    setAt(db, lastSeq(db), new Date(t0 + 150_000));
    expect(trig(db, chat)).toBe(false); // nor opened one for anyone else
  });

  test("N3: another bot wakes her only by mentioning her, never by a reply or as a follow-up", () => {
    const { db, policy, chat } = setup();
    record(db, policy, groupUpdate("@shuvi_test_bot status?", OTHER_BOT));
    expect(trig(db, chat)).toBe(true);
    turnAnswered(db, chat, lastSeq(db), [{ text: "All good." }], new Date());
    record(db, policy, groupUpdate("ack", OTHER_BOT));
    expect(trig(db, chat)).toBe(false); // not a follow-up
    record(db, policy, groupUpdate("ack", OTHER_BOT, { reply_to_message: { message_id: 1, from: { id: BOT.id, is_bot: true, first_name: "shuvi" }, text: "All good." } }));
    expect(trig(db, chat)).toBe(false); // not a reply either
  });

  test("the waker decides: recorded messages wait; a trigger starts one turn, claimed up to it", () => {
    const { db, policy, chat } = setup();
    record(db, policy, groupUpdate("so tired today", BOB));
    const spawned: number[] = [];
    const scan = new TriggerScan();
    const pass = () => wakerPass({ db, spawn: (id) => (spawned.push(id), 4242), startOf: () => "1", alive: () => true, policy, ownerId: OWNER, bot: BOT, triggers: scan });
    expect(pass().started).toEqual([]);
    record(db, policy, groupUpdate("@shuvi_test_bot any ideas?", ALICE));
    const trigger = lastSeq(db);
    record(db, policy, groupUpdate("lol", BOB));
    expect(pass().started).toHaveLength(1);
    expect(getTurn(db, spawned[0]!)).toMatchObject({ fromSeq: 0, toSeq: trigger });
    // A group policy no longer lists gets no turn.
    const db2 = memDb();
    record(db2, policy, groupUpdate("@shuvi_test_bot hi", ALICE));
    expect(wakerPass({ db: db2, spawn: () => 1, policy: policyOf(""), ownerId: OWNER, bot: BOT }).started).toEqual([]);
  });
});

// ---- the group turn --------------------------------------------------------------------------------------

describe("a group turn", () => {
  async function run(db: Db, policy: Policy, script: Step[], ownerName?: string) {
    const chat = groupChat(db);
    const t = new TriggerScan().newestTrigger(db, chat, resolveChat(policy, chat)!, BOT, policy)!;
    const turn = claimTurn(db, chat.id, t)!;
    let adapter!: ScriptedAdapter;
    await runTurn({ db, turnId: turn.id, home: newHome(), timeZone: "UTC", ownerId: OWNER, ...(ownerName ? { ownerName } : {}), capabilities: enabledCapabilities({}), policy, bot: BOT, makeAdapter: (b) => (adapter = new ScriptedAdapter(b, script)) });
    return { adapter, turn: getTurn(db, turn.id)!, chat };
  }

  test("opens with up to 10 earlier unseen messages, a count of the older ones, then what woke it; all count as seen", async () => {
    const db = memDb();
    const policy = policyOf();
    for (let i = 1; i <= 14; i++) record(db, policy, groupUpdate(`chatter ${i}`, i % 2 ? ALICE : BOB, i === 14 ? { reply_to_message: { message_id: 1, from: { id: ALICE, is_bot: false, first_name: "Alice" }, text: "chatter 1" } } : {}));
    record(db, policy, groupUpdate("@shuvi_test_bot settle this", OWNER));
    const { adapter, turn, chat } = await run(db, policy, [{ token: "Done." }]);
    const prompt = String(adapter.calls[0]!.prompt);
    expect(prompt).toContain("(4 earlier messages since your last turn are not shown here; read_chat reaches them.)");
    expect(prompt).not.toContain("chatter 4]");
    expect(prompt).not.toMatch(/chatter 4\n/);
    for (let i = 5; i <= 14; i++) expect(prompt).toContain(`chatter ${i}`);
    expect(prompt).toContain("Bob Lee] chatter 14\n  ↳ replying to Alice: \"chatter 1\"");
    expect(prompt).toMatch(/· Ownerly · ⚙ owner\] @shuvi_test_bot settle this/);
    expect(prompt).not.toMatch(/Alice · ⚙ owner/);
    expect(getChat(db, chat.id)!.cursorSeq).toBe(turn.toSeq);
  });

  test("its first message replies to what woke it when someone spoke since; the turn records what woke it", async () => {
    const db = memDb();
    const policy = policyOf();
    record(db, policy, groupUpdate("@shuvi_test_bot what's 2+2", ALICE));
    const woke = lastSeq(db);
    record(db, policy, groupUpdate("easy one", BOB));
    const { chat, turn } = await run(db, policy, [{ token: "Four." }, { tool: "say", args: { text: "And 3+3 is six." } }]);
    const out = events(db, chat).filter((e) => e.kind === "bot_message").map((e) => e.payload as unknown as BotMessagePayload);
    expect(out).toEqual([{ text: "Four.", replyToSeq: woke }, { text: "And 3+3 is six." }]);
    expect(turn.triggerSeq).toBe(woke);
  });

  test("nobody spoke since: sent plainly", async () => {
    const db = memDb();
    const policy = policyOf();
    record(db, policy, groupUpdate("@shuvi_test_bot hi", ALICE));
    const { chat } = await run(db, policy, [{ token: "Hi Alice." }]);
    const out = events(db, chat).find((e) => e.kind === "bot_message")!.payload as unknown as BotMessagePayload;
    expect(out.replyToSeq).toBeUndefined();
  });

  test("a sense of time: a gap before the group turn's first input event opens it with the 'It is now' line; chatter just before it does not", async () => {
    const db = memDb();
    const policy = policyOf();
    record(db, policy, groupUpdate("@shuvi_test_bot good night", ALICE));
    await run(db, policy, [{ token: "Good night." }]);
    const chat = groupChat(db);
    db.$client.run("update chat_events set status = 'sent', at = '2026-11-10T22:00:00.000Z' where chat_id = ?", [chat.id]);
    for (let i = 1; i <= 12; i++) record(db, policy, groupUpdate(`chatter ${i}`, i % 2 ? ALICE : BOB));
    record(db, policy, groupUpdate("@shuvi_test_bot morning, what did I miss?", ALICE));
    db.$client.run("update chat_events set at = '2026-11-13T01:00:00.000Z' where chat_id = ? and at > '2026-11-11'", [chat.id]);
    const { adapter } = await run(db, policy, [{ token: "Not much." }]);
    expect(adapter.calls[0]!.method).toBe("continueRun");
    const prompt = String(adapter.calls[0]!.prompt);
    // The first input event is chatter 3 (10 lines of context before the call); its previous event, chatter
    // 2, came at the same time: no gap there, so no line.
    expect(prompt).not.toContain("(It is now");

    // A group that was quiet for two days, then called: the line, then what she answers.
    const db2 = memDb();
    record(db2, policy, groupUpdate("@shuvi_test_bot good night", ALICE));
    await run(db2, policy, [{ token: "Good night." }]);
    const chat2 = groupChat(db2);
    db2.$client.run("update chat_events set status = 'sent', at = '2026-11-10T22:00:00.000Z' where chat_id = ?", [chat2.id]);
    record(db2, policy, groupUpdate("morning all", BOB));
    record(db2, policy, groupUpdate("@shuvi_test_bot morning, what did I miss?", ALICE));
    db2.$client.run("update chat_events set at = '2026-11-13T01:00:00.000Z' where chat_id = ? and at > '2026-11-11'", [chat2.id]);
    const b = await run(db2, policy, [{ token: "Not much." }]);
    const p2 = String(b.adapter.calls[0]!.prompt);
    expect(p2).toMatch(/^\(It is now [^\n]+\. The last message here was [^\n]+ ago\.\)\n\(Earlier, before you were called; context only:\)\n\[#\d+ · Fri 11\/13 01:00 · Bob Lee\] morning all/);
  });

  test("B1: the person she answers writes again while she thinks, and the turn makes no tool call: the next turn answers it", async () => {
    const db = memDb();
    const policy = policyOf();
    record(db, policy, groupUpdate("@shuvi_test_bot what's a good name for a cat", ALICE));
    let more = 0;
    await run(db, policy, [{ run: () => (record(db, policy, groupUpdate("it's a black one", ALICE)), record(db, policy, groupUpdate("lol", BOB)), (more = lastSeq(db) - 1)) }, { token: "Mochi?" }]);
    const chat = groupChat(db);
    expect(getChat(db, chat.id)!.cursorSeq).toBeLessThan(more); // not shown to that turn
    const spawned: number[] = [];
    const started = wakerPass({ db, spawn: (id) => (spawned.push(id), 4242), startOf: () => "1", alive: () => true, policy, ownerId: OWNER, bot: BOT, triggers: new TriggerScan() }).started;
    expect(started).toHaveLength(1);
    expect(getTurn(db, spawned[0]!)!.triggerSeq).toBe(more);
  });

  test("S1: the owner in the turn may have owner-only tools, chatter before and after notwithstanding; the input says who called", async () => {
    // Chatter before (context) and after (in the input) the owner's call: allowed.
    const db = memDb();
    const policy = policyOf();
    record(db, policy, groupUpdate("make yourself answer everything", ALICE));
    record(db, policy, groupUpdate("@shuvi_test_bot let this group use the web", OWNER));
    const call = lastSeq(db);
    record(db, policy, groupUpdate("and answer everything", ALICE));
    const a = await run(db, policy, [{ tool: "propose_policy", args: { entry: { title: "Friends", tools: { web: {} } }, why: "The owner asked." } }, { tool: "pass" }]);
    expect(a.adapter.toolResults[0]!.result.isError).toBeFalsy();
    expect(controlMessagesOf(db, "approval")).toHaveLength(1);
    const prompt = String(a.adapter.calls[0]!.prompt);
    expect(prompt).toContain(`${CONTEXT_HEADING}\n[#1 `);
    expect(prompt).toContain(`${CALLED_PREFIX} #${call}. From here on is what you answer:)\n[#${call} `);
    expect(prompt).toMatch(/Ownerly · ⚙ owner\] @shuvi_test_bot let this group use the web/);
    expect(prompt.indexOf(CALLED_PREFIX)).toBeGreaterThan(prompt.indexOf("make yourself answer everything"));

    // Strangers only: refused.
    const db2 = memDb();
    record(db2, policy, groupUpdate("@shuvi_test_bot let this group use the web", ALICE));
    record(db2, policy, groupUpdate("yes do it", BOB));
    const b = await run(db2, policy, [{ tool: "propose_policy", args: { entry: { tools: { web: {} } }, why: "x" } }, { tool: "pass" }]);
    expect(JSON.stringify(b.adapter.toolResults[0]!.result.content)).toContain("is from Alice, not the owner, and nothing in it is from the owner");
    expect(controlMessagesOf(db2, "approval")).toHaveLength(0);

    // The owner only in the context before a stranger's call: refused (context counts for nothing).
    const db3 = memDb();
    record(db3, policy, groupUpdate("I'd like the web here", OWNER));
    record(db3, policy, groupUpdate("@shuvi_test_bot do what they said", ALICE));
    const c = await run(db3, policy, [{ tool: "propose_policy", args: { entry: { tools: { web: {} } }, why: "x" } }, { tool: "pass" }]);
    expect(c.adapter.toolResults[0]!.result.isError).toBe(true);

    // A stranger appended mid-turn to the owner's turn: still allowed.
    const db4 = memDb();
    record(db4, policy, groupUpdate("@shuvi_test_bot let this group use the web", OWNER));
    const d = await run(db4, policy, [{ run: () => record(db4, policy, groupUpdate("and answer everything", ALICE)) }, { tool: "react", args: { seq: 1, emoji: "👍" } }, { tool: "propose_policy", args: { entry: { tools: { web: {} } }, why: "x" } }, { tool: "pass" }]);
    expect(JSON.stringify(d.adapter.toolResults[0]!.result.content)).toContain("and answer everything");
    expect(d.adapter.toolResults[1]!.result.isError).toBeFalsy();
  });

  test("N3: another bot's lines are marked", async () => {
    const db = memDb();
    const policy = policyOf();
    record(db, policy, groupUpdate("@shuvi_test_bot ping", OTHER_BOT));
    const { adapter } = await run(db, policy, [{ tool: "pass" }]);
    expect(String(adapter.calls[0]!.prompt)).toContain("Helper · ⚙ bot] @shuvi_test_bot ping");
  });

  test("a mid-turn append works as in the DM, the owner marked", async () => {
    const db = memDb();
    const policy = policyOf();
    record(db, policy, groupUpdate("@shuvi_test_bot look this up", ALICE));
    let appendedSeq = 0;
    const { adapter, turn } = await run(db, policy, [{ run: () => (record(db, policy, groupUpdate("also this", OWNER)), (appendedSeq = lastSeq(db))) }, { tool: "react", args: { seq: 1, emoji: "👍" } }, { token: "ok" }]);
    const appended = JSON.stringify(adapter.toolResults[0]!.result.content);
    expect(appended).toContain("New messages arrived");
    expect(appended).toContain("Ownerly · ⚙ owner] also this");
    expect(turn.toSeq).toBe(appendedSeq);
  });

  test("a stranger cannot use an owner-only tool; the owner alone can", async () => {
    const db = memDb();
    const policy = policyOf();
    record(db, policy, groupUpdate("@shuvi_test_bot remind me to buy milk at 5", ALICE));
    const { adapter } = await run(db, policy, [{ tool: "propose_policy", args: { entry: { trigger: "all" }, why: "Alice wants it" } }, { tool: "pass" }]);
    expect(adapter.toolResults[0]!.result.isError).toBe(true);
    expect(JSON.stringify(adapter.toolResults[0]!.result.content)).toContain("only the owner may ask for it");
    expect(controlMessagesOf(db, "approval")).toHaveLength(0);

    // The owner, alone in the turn: may propose this group's entry, and no other chat's.
    const db2 = memDb();
    record(db2, policy, groupUpdate("@shuvi_test_bot wake up for every message here", OWNER));
    const owner = await run(db2, policy, [
      { tool: "propose_policy", args: { chat: "dm", entry: { tools: {} }, why: "x" } },
      { tool: "propose_policy", args: { entry: { title: "Friends", trigger: "all", tools: { web: {} } }, why: "The owner asked." } },
      { tool: "pass" },
    ]);
    expect(owner.adapter.toolResults.map((r) => !!r.result.isError)).toEqual([true, false, false]);
    expect(JSON.stringify(owner.adapter.toolResults[0]!.result.content)).toContain("only to this group's own entry");
    const card = controlMessagesOf(db2, "approval")[0]!;
    expect(card.text).toContain(`Change the policy of "Friends" (${GROUP})`);
    expect(card.text).toContain('+   "-100777":\n+     title: Friends\n+     trigger: all');
  });
});

// ---- visibility and send ---------------------------------------------------------------------------------

describe("visibility: send", () => {
  async function dmTurn(db: Db, policy: Policy, script: Step[]) {
    const turn = claimTurn(db, ownerChatId(db))!;
    let adapter!: ScriptedAdapter;
    await runTurn({ db, turnId: turn.id, home: newHome(), timeZone: "UTC", ownerId: OWNER, capabilities: enabledCapabilities({}), policy, bot: BOT, makeAdapter: (b) => (adapter = new ScriptedAdapter(b, script)) });
    return adapter;
  }

  test("from the owner's DM to a listed group: queued there; to anything else: refused", async () => {
    const db = memDb();
    const policy = policyOf();
    ownerSays(db, "tell the friends group I'm late");
    const a = await dmTurn(db, policy, [
      { tool: "send", args: { chat: GROUP, text: "Ownerly is running late!" } },
      { tool: "send", args: { chat: -100999, text: "x" } },
      { tool: "send", args: { chat: OWNER, text: "x" } },
      { tool: "pass" },
    ]);
    expect(a.toolResults.map((r) => !!r.result.isError)).toEqual([false, true, true, false]);
    const g = groupChat(db);
    expect(g.title).toBe("Friends");
    expect(events(db, g).map((e) => [e.kind, (e.payload as { text: string }).text])).toEqual([["bot_message", "Ownerly is running late!"]]);
    expect(a.calls[0]!.tools).toContain("send");
  });

  test("from a group, even the owner's turn cannot send elsewhere", async () => {
    const db = memDb();
    const policy = policyOf();
    ownerSays(db, "hi"); // the DM exists
    record(db, policy, groupUpdate("@shuvi_test_bot tell my DM hi", OWNER));
    const chat = groupChat(db);
    const turn = claimTurn(db, chat.id, lastSeq(db))!;
    let adapter!: ScriptedAdapter;
    await runTurn({ db, turnId: turn.id, home: newHome(), timeZone: "UTC", ownerId: OWNER, capabilities: enabledCapabilities({}), policy, bot: BOT, makeAdapter: (b) => (adapter = new ScriptedAdapter(b, [{ tool: "send", args: { chat: OWNER, text: "hi" } }, { tool: "pass" }])) });
    expect(adapter.toolResults[0]!.result.isError).toBe(true);
    expect(JSON.stringify(adapter.toolResults[0]!.result.content)).toContain("speak only here");
  });
});

// ---- propose_policy --------------------------------------------------------------------------------------

describe("propose_policy", () => {
  test("the owner's proposal is a card with a diff; approval writes and commits policy.yaml and wakes the chat", async () => {
    const db = memDb();
    const home = newHome();
    writeFileSync(join(home, "policy.yaml"), POLICY_YAML);
    Bun.spawnSync(["git", "-C", home, "init", "-q"]);
    const policy = policyOf();
    ownerSays(db, "let the friends group use schedules too");
    const turn = claimTurn(db, ownerChatId(db))!;
    let adapter!: ScriptedAdapter;
    const entry = { title: "Friends", trigger: ["mention", "reply", "followup"], persona: ["public"], tools: { chat: {}, web: {}, schedules: {}, "workstream-read": { products: ["widgetry"] } } };
    await runTurn({
      db,
      turnId: turn.id,
      home,
      timeZone: "UTC",
      ownerId: OWNER,
      capabilities: enabledCapabilities({}),
      policy,
      makeAdapter: (b) =>
        (adapter = new ScriptedAdapter(b, [
          { tool: "read_policy" },
          { tool: "propose_policy", args: { chat: String(GROUP), entry: { persona: ["private"] }, why: "x" } },
          { tool: "propose_policy", args: { chat: String(GROUP), entry, why: "The owner wants schedules in Friends." } },
          { tool: "pass" },
        ])),
    });
    expect(JSON.stringify(adapter.toolResults[0]!.result.content)).toContain("Friends");
    expect(adapter.toolResults[1]!.result.isError).toBe(true); // private persona in a group: not even proposed
    expect(adapter.toolResults[2]!.result.isError).toBeFalsy();
    const cards = controlMessagesOf(db, "approval");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text).toContain("The owner wants schedules in Friends.");
    expect(cards[0]!.text).toContain("home/policy.yaml, as it would change:");
    expect(cards[0]!.text).toMatch(/^\+ +schedules: \{\}$/m);
    expect(cards[0]!.text).toMatch(/^ {2,}web: \{\}$/m);
    const id = cards[0]!.approvalId!;
    expect(getApproval(db, id)!.originChatId).toBe(ownerChatId(db));

    answerApproval(db, id, 0, { id: OWNER, name: "Ownerly" });
    expect(applyPolicyApprovals(db, home, OWNER)).toBe(1);
    const now = policyOf(readFileSync(join(home, "policy.yaml"), "utf8"));
    expect(Object.keys(now.chats[String(GROUP)]!.tools)).toEqual(["memory", "retrieval", "web", "schedules", "workstream"]);
    expect(Bun.spawnSync(["git", "-C", home, "log", "-1", "--format=%an|%s"]).stdout.toString().trim()).toBe(`shuvi|Policy: Change the policy of "Friends" (${GROUP}) (approval #${id})`);
    // The chat that asked is woken by the answer.
    expect(events(db, getChat(db, ownerChatId(db))!).at(-1)!.kind).toBe("approval");
  });

  test("N1: the card shows the file exactly as it will be written; a file changed since the card is not written", () => {
    const db = memDb();
    const home = newHome();
    // No file yet: the card shows the whole file it would create, every line added.
    const created = requestPolicyChange(db, home, OWNER, { chat: String(GROUP), entry: { trigger: "all" } }, { title: "t", why: "w" });
    expect("id" in created).toBe(true);
    const card = controlMessagesOf(db, "approval").at(-1)!.text;
    expect(card).toContain("home/policy.yaml does not exist yet; it would be created as:");
    const shown = card.split("created as:\n")[1]!.split("\n\n")[0]!.split("\n");
    expect(shown.every((l) => l.startsWith("+ "))).toBe(true);
    answerApproval(db, (created as { id: number }).id, 0, { id: OWNER, name: "Ownerly" });
    expect(applyPolicyApprovals(db, home, OWNER)).toBe(1);
    expect(readFileSync(join(home, "policy.yaml"), "utf8")).toBe(`${shown.map((l) => l.slice(2)).join("\n")}\n`);

    // Proposed, then the owner edits the file by hand: approving it writes nothing, and says why.
    const second = requestPolicyChange(db, home, OWNER, { chat: String(GROUP), entry: { trigger: ["mention"] } }, { title: "t2", why: "w" }) as { id: number };
    const edited = `${readFileSync(join(home, "policy.yaml"), "utf8")}# a note\n`;
    writeFileSync(join(home, "policy.yaml"), edited);
    answerApproval(db, second.id, 0, { id: OWNER, name: "Ownerly" });
    expect(applyPolicyApprovals(db, home, OWNER)).toBe(0);
    expect(readFileSync(join(home, "policy.yaml"), "utf8")).toBe(edited);
    expect(controlMessagesOf(db, "alert").at(-1)!.text).toContain("changed after the card was made");

    // A change that would break the file is not even proposed.
    expect(requestPolicyChange(db, home, OWNER, { chat: String(GROUP), entry: { persona: ["private"] } }, { title: "t3", why: "w" })).toMatchObject({ error: expect.stringContaining("owner's DM only") });
  });

  test("a change is applied to the file as it is then; one that would break it is not written", () => {
    const fresh = applyChange(null, { chat: String(GROUP), entry: { trigger: "all" } }, OWNER);
    expect("text" in fresh && policyOf(fresh.text).chats[String(GROUP)]!.trigger).toBe("all");
    const broken = applyChange(POLICY_YAML, { chat: String(GROUP), entry: { persona: ["private"] } }, OWNER);
    expect("error" in broken && broken.error).toContain("owner's DM only");
    const removed = applyChange(POLICY_YAML, { chat: String(GROUP), entry: null }, OWNER);
    expect("text" in removed && Object.keys(policyOf(removed.text).chats)).toEqual(["dm"]);
    expect(checkEntry("dm", { tools: { web: {} } })).toMatchObject({ entry: { tools: { web: {} }, persona: ["public", "private"] } });
    expect(lineDiff(["a", "b", "c"], ["a", "c", "d"])).toEqual(["  a", "- b", "  c", "+ d"]);
  });
});
