import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Update } from "grammy/types";
import { textOf } from "agent-runtime";
import { runTurn } from "../src/agent/turn.ts";
import { TriggerScan, type BotIdentity } from "../src/agent/triggers.ts";
import { CAPABILITIES, enabledCapabilities } from "../src/capabilities/index.ts";
import { defineCapability, enableCapabilities } from "../src/capabilities/types.ts";
import { INBOX_FROM_KEY, inboxPass } from "../src/capabilities/computer/files.ts";
import { consoleGrant } from "../src/capabilities/computer/secrets.ts";
import { answerApproval, requestApproval } from "../src/control/approvals.ts";
import { attachmentOfEvent } from "../src/store/media.ts";
import { checkDelegate, explainPolicy } from "../src/policy/explain.ts";
import { checkEntry, entryToDoc, filesCopiedFrom, parsePolicy, resolveChat, type Policy } from "../src/policy/policy.ts";
import { policyDetail, findListed } from "../src/policy/view.ts";
import { recordBatch } from "../src/server/poller.ts";
import type { Db } from "../src/store/db.ts";
import { allChats, getEvent, kvSet, type Chat } from "../src/store/events.ts";
import { createJob, finishJob, getJob } from "../src/store/jobs.ts";
import { activeSchedules, createSchedule, fireDue } from "../src/store/schedules.ts";
import { claimTurn, finishTurn } from "../src/store/turns.ts";
import { classify } from "../src/telegram/inbound.ts";
import { FakeHangar } from "./fake-hangar.ts";
import { groupUpdate as tgGroupUpdate, lastSeq, memDb, OWNER, ScriptedAdapter, type Step } from "./helpers.ts";

/**
 * Operators (policy.ts `operators`, `delegate`; agent/turn.ts `callAuthority`): a group may let people
 * besides the owner ask for the delegable owner-only tools of the capabilities it delegates. The rest stay
 * the owner's; context lines and strangers count for nothing; schedules and jobs carry who authorised them.
 */

const BOT: BotIdentity = { id: 1, username: "shuvi_test_bot" };
const GROUP = -100888;
const ALICE = 2001; // an operator by id
const BOB = 2002; // not one
const OTHER_BOT = 3001;
const NAMES: Record<number, string> = { [OWNER]: "Ownerly", [ALICE]: "Alice", [BOB]: "Bob", [OTHER_BOT]: "Helper" };

const yaml = (entry: string) => `owner: ${OWNER}\nchats:\n  "${GROUP}":\n    title: Friends\n${entry
  .trim()
  .split("\n")
  .map((l) => `    ${l}`)
  .join("\n")}\n`;

const policyOf = (text: string): Policy => {
  const r = parsePolicy(text, OWNER);
  if ("error" in r) throw new Error(r.error);
  return r.policy;
};

const BY_ID = policyOf(yaml(`
tools:
  schedules: {}
  chat: {}
operators: [${ALICE}]
delegate: [schedules]
`));
const MEMBERS = policyOf(yaml(`
tools:
  schedules: {}
  chat: {}
operators: members
delegate: [schedules]
`));
const NONE = policyOf(yaml(`
tools:
  schedules: {}
  chat: {}
`));

let nextUpdate = 9000;
function say(db: Db, policy: Policy, from: number, text: string, extra: Record<string, unknown> = {}): void {
  const u: Update = tgGroupUpdate(nextUpdate++, { id: GROUP, title: "Friends" }, { id: from, first: NAMES[from] ?? "Someone", isBot: from === OTHER_BOT }, text, extra);
  recordBatch(db, [u], OWNER, { botUsername: BOT.username!, policy });
}
const groupChat = (db: Db): Chat => allChats(db).find((c) => c.tgChatId === GROUP)!;

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "shuvi-operators-"));
  for (const d of ["persona", "memory", "chats"]) mkdirSync(join(home, d));
  writeFileSync(join(home, "persona/public.md"), "PUBLIC PERSONA");
  return home;
}

const ENV = { SHUVI_WEB: "off", SHUVI_STICKERS: "off", SHUVI_RETRIEVAL: "off", SHUVI_PLAYBOOKS: "off", SHUVI_RELEASES: "off" };

async function groupTurn(db: Db, policy: Policy, script: Step[], env: Record<string, string> = ENV) {
  const chat = groupChat(db);
  const t = new TriggerScan().newestTrigger(db, chat, resolveChat(policy, chat)!, BOT, policy);
  const turn = claimTurn(db, chat.id, t ?? undefined)!;
  let adapter!: ScriptedAdapter;
  await runTurn({ db, turnId: turn.id, home: newHome(), timeZone: "UTC", ownerId: OWNER, capabilities: enabledCapabilities(env), policy, bot: BOT, makeAdapter: (b) => (adapter = new ScriptedAdapter(b, script)) });
  return adapter;
}
const text = (a: ScriptedAdapter, i: number) => textOf(a.toolResults[i]!.result);
const refused = (a: ScriptedAdapter, i: number) => a.toolResults[i]!.result.isError === true && text(a, i).startsWith("Refused:");
const setOne = { tool: "schedule", args: { at: "+1h", note: "n" } } as const;
function closeTurn(db: Db) {
  const t = claimTurn(db, groupChat(db).id);
  if (t) finishTurn(db, t.id, { status: "done" });
}

describe("policy: operators and delegate", () => {
  test("parsed for a group, written back, and members or ids", () => {
    const e = resolveChat(BY_ID, { kind: "group", tgChatId: GROUP })!;
    expect(e.operators).toEqual([ALICE]);
    expect(e.delegate).toEqual(["schedules"]);
    expect(entryToDoc(e)).toMatchObject({ operators: [ALICE], delegate: ["schedules"] });
    expect(resolveChat(MEMBERS, { kind: "group", tgChatId: GROUP })!.operators).toBe("members");
    expect(entryToDoc(resolveChat(NONE, { kind: "group", tgChatId: GROUP })!)).not.toHaveProperty("operators");
  });

  test("broken files: in the DM, one without the other, a delegate not in tools, a bad id", () => {
    const bad = (entry: Record<string, unknown>, key = String(GROUP)) => {
      const r = checkEntry(key, entry);
      return "error" in r ? r.error : null;
    };
    expect(bad({ tools: "all", operators: members(), delegate: ["computer"] }, "dm")).toContain("the owner's DM is the owner's alone");
    expect(bad({ tools: { schedules: {} }, delegate: ["schedules"] })).toContain("nobody to delegate to");
    expect(bad({ tools: { schedules: {} }, operators: [ALICE] })).toContain("nothing is delegated to them");
    expect(bad({ tools: { web: {} }, operators: [ALICE], delegate: ["schedules"] })).toContain("schedules is not in this entry's tools");
    expect(bad({ tools: { schedules: {} }, operators: ["alice"], delegate: ["schedules"] })).toContain('"alice" is not a Telegram user id');
    expect(bad({ tools: "all", operators: "members", delegate: ["computer"] })).toBeNull();
  });

  test("a proposal may delegate only capabilities with delegable tools; explain_policy lists them", () => {
    expect(checkDelegate(CAPABILITIES, ["computer", "schedules", "media"])).toBeNull();
    expect(checkDelegate(CAPABILITIES, ["memory"])).toContain("memory has no tools that can be delegated");
    expect(checkDelegate(CAPABILITIES, ["workstream"])).toContain("ask_workstream, stay the owner's");
    expect(checkDelegate(CAPABILITIES, ["nope"])).toContain('"nope" is not a capability');
    const doc = explainPolicy(CAPABILITIES, "tools.computer");
    expect("text" in doc && doc.text).toContain("DELEGABLE TO OPERATORS (delegate):\n    exec, read_job");
    expect("text" in explainPolicy(CAPABILITIES, "operators")).toBe(true);
  });

  test("a capability that declares a delegable tool that is not owner-only is refused when capabilities are enabled", () => {
    const bad = defineCapability({ id: "bad", label: "bad", gives: "x", enable: () => ({}), ownerOnly: ["a"], delegable: ["a", "b"] });
    expect(() => enableCapabilities([bad], {})).toThrow('capability bad: delegable "b" is not one of its owner-only tools');
  });

  test("every delegable tool is one of its capability's owner-only tools; the owner's own stay undelegable", () => {
    for (const c of CAPABILITIES) for (const t of c.delegable ?? []) expect([...(c.ownerOnly ?? []), ...Object.keys(c.ownerOnlyWhen ?? {})]).toContain(t);
    const delegable = new Set(CAPABILITIES.flatMap((c) => c.delegable ?? []));
    for (const t of ["edit_home", "write_home", "send", "propose_policy", "ask_workstream", "add_sticker_pack", "remove_sticker_pack"]) expect(delegable.has(t)).toBe(false);
  });

  test("/policy <group> shows who the operators are and what they may ask for", () => {
    const input = { policy: BY_ID, registry: CAPABILITIES };
    const out = policyDetail(input, findListed(input, String(GROUP))!).join("\n");
    expect(out).toContain(`<b>Operators:</b> ${ALICE}, who may also ask for schedules (owner only) (schedule, list_schedules, cancel_schedule)`);
    const none = { policy: NONE, registry: CAPABILITIES };
    expect(policyDetail(none, findListed(none, String(GROUP))!).join("\n")).toContain("<b>Operators:</b> none");
  });
});

function members(): "members" {
  return "members";
}

describe("authority in a group with operators", () => {
  test("an operator's request runs, recorded as theirs; the prompt says so and marks their line", async () => {
    const db = memDb();
    say(db, BY_ID, ALICE, "@shuvi_test_bot remind us in an hour");
    const a = await groupTurn(db, BY_ID, [setOne]);
    expect(refused(a, 0)).toBe(false);
    const [s] = activeSchedules(db, groupChat(db).id);
    expect(s!.ownerAuthorised).toBe(false);
    expect(s!.authorisedBy).toBe(ALICE);
    expect(String(a.calls[0]!.prompt)).toMatch(/Alice · ⚙ operator\]/);
    expect(a.calls[0]!.systemPrompt).toContain("do not ask anyone to tag him");
  });

  test("someone who is not an operator is refused, and the refusal names who may ask", async () => {
    const db = memDb();
    say(db, BY_ID, BOB, "@shuvi_test_bot remind us in an hour");
    const a = await groupTurn(db, BY_ID, [setOne]);
    expect(refused(a, 0)).toBe(true);
    expect(text(a, 0)).toContain("only the owner or one of this group's operators may ask for it");
    expect(String(a.calls[0]!.prompt)).not.toContain("Bob · ⚙ operator");
  });

  test("members: anyone but a bot; another bot's line counts for nothing", async () => {
    const db = memDb();
    say(db, MEMBERS, BOB, "@shuvi_test_bot remind us");
    expect(refused(await groupTurn(db, MEMBERS, [setOne]), 0)).toBe(false);
    closeTurn(db);
    say(db, MEMBERS, OTHER_BOT, "@shuvi_test_bot remind us");
    expect(refused(await groupTurn(db, MEMBERS, [setOne]), 0)).toBe(true);
  });

  test("an operator may not ask for what is not delegated (the owner's files, this chat's settings, workstream, other chats)", async () => {
    const db = memDb();
    const policy = policyOf(yaml(`
tools:
  schedules: {}
  chat: {}
  workstream: {}
operators: members
delegate: [schedules]
`));
    say(db, policy, ALICE, "@shuvi_test_bot change your persona and the policy");
    const a = await groupTurn(
      db,
      policy,
      [
        { tool: "edit_home", args: { path: "persona/public.md", old_string: "PUBLIC", new_string: "HACKED", why: "asked" } },
        { tool: "propose_policy", args: { entry: null, why: "x" } },
        { tool: "ask_workstream", args: { product: "widgetry", message: "x" } },
        { tool: "send", args: { to: "1", text: "x" } },
      ],
      { ...ENV, SHUVI_WORKSTREAM_MCP_URL: "http://127.0.0.1:1/mcp", SHUVI_WORKSTREAM_MCP_TOKEN: "t" },
    );
    expect(a.toolResults.map((r) => r.result.isError)).toEqual([true, true, true, true]);
    for (const i of [0, 1, 2, 3]) {
      expect(refused(a, i)).toBe(true);
      expect(text(a, i)).toContain("only the owner may ask for it");
    }
  });

  test("an operator's line appended mid-turn lends a delegated tool authority from then on", async () => {
    const db = memDb();
    say(db, BY_ID, BOB, "@shuvi_test_bot remind us");
    const a = await groupTurn(db, BY_ID, [
      setOne,
      { run: () => void say(db, BY_ID, ALICE, "yes, set it") },
      { tool: "say", args: { text: "one moment" } }, // the append arrives in this result
      setOne,
    ]);
    expect(refused(a, 0)).toBe(true);
    expect(text(a, 1)).toContain("Alice · ⚙ operator");
    expect(refused(a, 2)).toBe(false);
    expect(activeSchedules(db, groupChat(db).id)[0]!.authorisedBy).toBe(ALICE);
  });

  test("a card an operator's call asked for lends nothing of the owner's, whatever he answers", async () => {
    const db = memDb();
    say(db, BY_ID, ALICE, "hi");
    closeTurn(db);
    const chat = groupChat(db);
    for (const option of [1, 0]) {
      const id = requestApproval(db, { kind: "secret", title: "t", body: "b", options: [{ id: "yes", label: "Yes" }, { id: "deny", label: "Deny" }], originChatId: chat.id, requestedBy: ALICE });
      answerApproval(db, id, option, { id: OWNER, name: "Ownerly" });
      const a = await groupTurn(db, BY_ID, [{ tool: "edit_home", args: { path: "persona/public.md", old_string: "PUBLIC", new_string: "HACKED", why: "x" } }, setOne]);
      expect(refused(a, 0)).toBe(true);
      expect(refused(a, 1)).toBe(false); // it carries on Alice's request, for what is delegated
      closeTurn(db);
    }
    // The owner's own card still counts as his.
    const id = requestApproval(db, { kind: "secret", title: "t", body: "b", options: [{ id: "yes", label: "Yes" }], originChatId: chat.id });
    answerApproval(db, id, 0, { id: OWNER, name: "Ownerly" });
    const a = await groupTurn(db, BY_ID, [{ tool: "propose_policy", args: { entry: null, why: "x" } }]);
    expect(refused(a, 0)).toBe(false);
  });

  test("Telegram's linked-channel auto-forwards (user 777000) are never an operator, even with members", async () => {
    const db = memDb();
    say(db, MEMBERS, 777000, "@shuvi_test_bot remind us");
    expect(refused(await groupTurn(db, MEMBERS, [setOne]), 0)).toBe(true);
  });

  test("an operator's line among the earlier context (before the call) counts for nothing", async () => {
    const db = memDb();
    say(db, BY_ID, ALICE, "we should set a reminder");
    say(db, BY_ID, BOB, "@shuvi_test_bot remind us");
    const a = await groupTurn(db, BY_ID, [setOne]);
    expect(refused(a, 0)).toBe(true);
  });

  test("without operators nothing changes: only the owner", async () => {
    const db = memDb();
    say(db, NONE, ALICE, "@shuvi_test_bot remind us");
    const a = await groupTurn(db, NONE, [setOne]);
    expect(refused(a, 0)).toBe(true);
    expect(text(a, 0)).toContain("only the owner may ask for it");
    closeTurn(db);
    say(db, NONE, OWNER, "@shuvi_test_bot remind us");
    expect(refused(await groupTurn(db, NONE, [setOne]), 0)).toBe(false);
  });

  test("an operator may not cancel what the owner set; the owner may", async () => {
    const db = memDb();
    say(db, BY_ID, OWNER, "@shuvi_test_bot remind me");
    await groupTurn(db, BY_ID, [setOne]);
    closeTurn(db);
    const id = activeSchedules(db, groupChat(db).id)[0]!.id;
    say(db, BY_ID, ALICE, "@shuvi_test_bot cancel that");
    const a = await groupTurn(db, BY_ID, [{ tool: "cancel_schedule", args: { id } }]);
    expect(text(a, 0)).toContain("was set by the owner; only the owner can cancel it");
    expect(activeSchedules(db, groupChat(db).id)).toHaveLength(1);
  });
});

describe("schedules and jobs carry who authorised them", () => {
  function fireOne(db: Db, by: { ownerAuthorised?: boolean; authorisedBy?: number }) {
    createSchedule(db, { chatId: groupChat(db).id, note: "check", at: new Date(Date.now() + 1000), timeZone: "UTC", ...by });
    fireDue(db, new Date(Date.now() + 2000));
  }

  test("an operator's schedule wakes a turn that may use delegated tools, but not the owner's", async () => {
    const db = memDb();
    say(db, BY_ID, BOB, "hi"); // makes the chat
    closeTurn(db);
    fireOne(db, { authorisedBy: ALICE });
    const a = await groupTurn(db, BY_ID, [setOne, { tool: "edit_home", args: { path: "persona/public.md", old_string: "PUBLIC", new_string: "X" } }]);
    expect(refused(a, 0)).toBe(false);
    expect(activeSchedules(db, groupChat(db).id).at(-1)!.authorisedBy).toBe(ALICE);
    expect(refused(a, 1)).toBe(true);
  });

  test("taken off operators: their schedule no longer acts for them", async () => {
    const db = memDb();
    say(db, BY_ID, ALICE, "@shuvi_test_bot remind us every morning");
    await groupTurn(db, BY_ID, [{ tool: "schedule", args: { at: "+1s", note: "check" } }]);
    closeTurn(db);
    expect(activeSchedules(db, groupChat(db).id)[0]!.authorisedBy).toBe(ALICE);
    fireDue(db, new Date(Date.now() + 5000));
    // Alice is taken off: the policy the turn runs under no longer names her.
    const withoutAlice = policyOf(yaml(`
tools:
  schedules: {}
  chat: {}
operators: [${BOB}]
delegate: [schedules]
`));
    const a = await groupTurn(db, withoutAlice, [setOne]);
    expect(refused(a, 0)).toBe(true);
  });

  test("an operator's job's result counts as theirs", async () => {
    const db = memDb();
    say(db, BY_ID, BOB, "hi");
    closeTurn(db);
    const chat = groupChat(db);
    const { job } = createJob(db, { chatId: chat.id, originSeq: 0, kind: "test", title: "t", report: "poll", deadline: new Date(Date.now() + 60_000), authorisedBy: ALICE });
    expect(getJob(db, job.id)!.authorisedBy).toBe(ALICE);
    finishJob(db, job.id, { state: "done", result: "ok" });
    const a = await groupTurn(db, BY_ID, [setOne]);
    expect(refused(a, 0)).toBe(false);
  });

  test("an owner-authorised row never records an operator", () => {
    const db = memDb();
    say(db, BY_ID, BOB, "hi");
    const s = createSchedule(db, { chatId: groupChat(db).id, note: "n", at: new Date(Date.now() + 60_000), timeZone: "UTC", ownerAuthorised: true, authorisedBy: ALICE });
    expect(s.authorisedBy).toBeNull();
  });
});

describe("files from operators", () => {
  const COMPUTER_POLICY = policyOf(yaml(`
tools:
  computer: {}
operators: [${ALICE}]
delegate: [computer]
`));
  const doc = { document: { file_id: "F1", file_unique_id: "U1", file_name: "data.csv", file_size: 10 } };

  test("an operator's file is recorded to be copied; a stranger's or a bot's is not; nor without delegating the computer", () => {
    const of = (policy: Policy, from: number) => {
      const u = tgGroupUpdate(nextUpdate++, { id: GROUP, title: "Friends" }, { id: from, first: "X", isBot: from === OTHER_BOT }, "", doc);
      const c = classify(u, OWNER, BOT.username, policy);
      return c.kind === "message" ? c.payload.attachment : undefined;
    };
    expect(of(COMPUTER_POLICY, ALICE)?.name).toBe("data.csv");
    expect(of(COMPUTER_POLICY, OWNER)?.name).toBe("data.csv");
    expect(of(COMPUTER_POLICY, BOB)).toBeUndefined();
    expect(of(BY_ID, ALICE)).toBeUndefined();
    expect(filesCopiedFrom(COMPUTER_POLICY, GROUP, { id: OTHER_BOT, isBot: true }, OWNER)).toBe(false);
  });

  test("the inbox copies an operator's file only while policy still names them", async () => {
    const db = memDb();
    kvSet(db, INBOX_FROM_KEY, "0");
    say(db, COMPUTER_POLICY, ALICE, "", doc);
    const seq = lastSeq(db);
    // Still an operator: left waiting (no state yet) for the computer's next run, which has not come.
    await inboxPass(db, undefined as never, undefined as never, OWNER, () => COMPUTER_POLICY);
    expect(attachmentOfEvent(getEvent(db, seq)!)!.state).toBeUndefined();
    // Taken off: skipped.
    await inboxPass(db, undefined as never, undefined as never, OWNER, () => BY_ID);
    expect(attachmentOfEvent(getEvent(db, seq)!)!.state).toBe("skipped");
  });
});

describe("the computer, delegated", () => {
  const fakes: FakeHangar[] = [];
  afterEach(() => {
    for (const f of fakes.splice(0)) f.stop();
  });

  const SECRET = "fake-operator-secret-0123456789";
  const POLICY = policyOf(yaml(`
tools:
  computer: {}
  chat: {}
operators: members
delegate: [computer]
`));
  function computerEnv() {
    const fake = new FakeHangar();
    fakes.push(fake);
    const dataDir = mkdtempSync(join(tmpdir(), "shuvi-op-computer-"));
    const secretsFile = join(dataDir, "secrets.yaml");
    writeFileSync(secretsFile, `modal:\n  MODAL_TOKEN: ${SECRET}\n`);
    chmodSync(secretsFile, 0o600);
    return { fake, env: fake.env({ ...ENV, SHUVI_DATA_DIR: dataDir, SHUVI_SECRETS_FILE: secretsFile, SHUVI_COMPUTER_READY_SEC: "5", SHUVI_COMPUTER_INBOX_WAIT_SEC: "1" }) };
  }

  test("an operator's secret card says who asked; once granted, their command gets it; the answer lends nothing of the owner's", async () => {
    const { fake, env } = computerEnv();
    const db = memDb();
    say(db, POLICY, BOB, "@shuvi_test_bot use modal");
    await groupTurn(db, POLICY, [{ tool: "request_secret", args: { profile: "modal", ttl: "1d", reason: "sorting" } }], env);
    closeTurn(db);
    const card = db.$client.query("select id, body, requested_by as r from approvals where kind = 'secret'").get() as { id: number; body: string; r: number };
    expect(card.r).toBe(BOB);
    expect(card.body).toContain(`Asked by: an operator of this group (user id ${BOB}), not you`);
    answerApproval(db, card.id, 1, { id: OWNER, name: "Ownerly" });
    const a = await groupTurn(
      db,
      POLICY,
      [
        { tool: "exec", args: { command: 'echo "token=[$MODAL_TOKEN]"' } },
        { tool: "edit_home", args: { path: "persona/public.md", old_string: "PUBLIC", new_string: "HACKED", why: "x" } },
      ],
      env,
    );
    expect(text(a, 0)).toContain("token=[[REDACTED:modal]]");
    expect(fake.execs.some((e) => e.env.MODAL_TOKEN === SECRET)).toBe(true);
    expect(refused(a, 1)).toBe(true);
  });

  test("an operator cannot cancel a job the owner started", async () => {
    const { env } = computerEnv();
    const db = memDb();
    say(db, POLICY, OWNER, "@shuvi_test_bot start the long one");
    await groupTurn(db, POLICY, [{ tool: "exec", args: { command: "sleep 30", background: true, expect_seconds: 30 } }], env);
    closeTurn(db);
    const id = (db.$client.query("select id from jobs where kind = 'computer'").get() as { id: number }).id;
    say(db, POLICY, BOB, "@shuvi_test_bot stop it");
    const a = await groupTurn(db, POLICY, [{ tool: "cancel_job", args: { id } }], env);
    expect(text(a, 0)).toContain("was started for the owner; only the owner can cancel it");
    closeTurn(db);
    say(db, POLICY, OWNER, "@shuvi_test_bot stop it");
    const b = await groupTurn(db, POLICY, [{ tool: "cancel_job", args: { id } }], env);
    expect(b.toolResults[0]!.result.isError).toBeFalsy();
  });

  test("a grant to every chat goes into the owner's commands, sync and background, never an operator's", async () => {
    const { fake, env } = computerEnv();
    const db = memDb();
    consoleGrant(db, "modal", "forever");
    const command = 'echo "token=[$MODAL_TOKEN]"';
    say(db, POLICY, BOB, "@shuvi_test_bot use modal");
    let before = fake.execs.length;
    const a = await groupTurn(db, POLICY, [{ tool: "exec", args: { command } }, { tool: "exec", args: { command, background: true, expect_seconds: 5 } }], env);
    expect(text(a, 0)).toContain("token=[]");
    expect(text(a, 1)).toContain("Started job");
    expect(fake.execs.slice(before).some((e) => e.env.MODAL_TOKEN)).toBe(false);
    closeTurn(db);
    say(db, POLICY, OWNER, "@shuvi_test_bot use modal");
    before = fake.execs.length;
    const b = await groupTurn(db, POLICY, [{ tool: "exec", args: { command } }, { tool: "exec", args: { command, background: true, expect_seconds: 5 } }], env);
    expect(text(b, 0)).toContain("token=[[REDACTED:modal]]");
    expect(fake.execs.slice(before).filter((e) => e.env.MODAL_TOKEN === SECRET)).toHaveLength(2);
  });

  test("an operator's exec runs on the group's computer; their background job records them", async () => {
    const { env } = computerEnv();
    const policy = POLICY;
    const db = memDb();
    say(db, policy, BOB, "@shuvi_test_bot sort the data please");
    const a = await groupTurn(db, policy, [
      { tool: "exec", args: { command: "echo sorted" } },
      { tool: "exec", args: { command: "sleep 0", background: true, expect_seconds: 5 } },
    ], env);
    expect(refused(a, 0)).toBe(false);
    expect(text(a, 0)).toContain("sorted");
    expect(text(a, 1)).toContain("Started job");
    const job = db.$client.query("select owner_authorised as o, authorised_by as b from jobs where kind = 'computer'").get() as { o: number; b: number };
    expect(job).toEqual({ o: 0, b: BOB });
    expect(a.calls[0]!.systemPrompt).toContain("operators use this computer too");
  });
});
