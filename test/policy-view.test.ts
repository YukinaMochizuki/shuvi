import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Api } from "grammy";
import { runTurn } from "../src/agent/turn.ts";
import { CAPABILITIES, enabledCapabilities } from "../src/capabilities/index.ts";
import { CONTROL_COMMANDS, controlSendPass, policyText, recordControlBatch } from "../src/control/bot.ts";
import { catalogue, checkTools, ENTRY_FIELDS, explainablePaths, explainPolicy, TOP_FIELDS } from "../src/policy/explain.ts";
import { ENTRY_KEYS, parsePolicy, TOOL_ALIASES, TOP_KEYS, type Policy } from "../src/policy/policy.ts";
import { packMessages, policyOverview } from "../src/policy/view.ts";
import { controlMessagesOf } from "../src/store/control.ts";
import { claimTurn } from "../src/store/turns.ts";
import { dmUpdate, FakeTelegram, memDb, OWNER, ownerChatId, ownerSays, ScriptedAdapter } from "./helpers.ts";

// Fake chats only: the repository is public.
const BOOK_CLUB = -1001111111111;
const CHESS = -1002222222222;
const UNTITLED = -1003333333333;

const POLICY_YAML = `
owner: ${OWNER}
chats:
  dm:
    tools: all
  "${BOOK_CLUB}":
    title: Book Club
    trigger: [mention, reply, followup]
    followup_minutes: 5
    persona: [public]
    memory: [chat]
    tools:
      web: {}
      stickers: {}
      workstream: { products: [widgetry, gadgetworks] }
      teleport: {}
  "${CHESS}":
    title: Chess <Night> & Co
    trigger: [mention]
    memory: []
  "${UNTITLED}":
    trigger: all
`;

function policyOf(text = POLICY_YAML): Policy {
  const r = parsePolicy(text, OWNER);
  if ("error" in r) throw new Error(r.error);
  return r.policy;
}

let tg: FakeTelegram | null = null;
afterEach(() => {
  tg?.stop();
  tg = null;
});

// ---- the per-capability metadata ---------------------------------------------------------------------

describe("every capability describes itself", () => {
  test("every registered capability has a label, what it gives, and well-formed parameters", () => {
    for (const c of CAPABILITIES) {
      expect(c.label.trim().length, c.id).toBeGreaterThan(0);
      expect(c.gives.trim().length, c.id).toBeGreaterThan(0);
      for (const [name, p] of Object.entries(c.params ?? {})) {
        expect(p.meaning.length, `${c.id}.${name}`).toBeGreaterThan(0);
        expect(p.default.length, `${c.id}.${name}`).toBeGreaterThan(0);
        // Its own example passes its own check.
        expect(checkTools(CAPABILITIES, { [c.id]: { [name]: p.example } }), `${c.id}.${name}`).toBeNull();
      }
    }
    // A capability that reads parameters in `configure` declares them.
    for (const c of CAPABILITIES) if (c.configure) expect(Object.keys(c.params ?? {}).length, c.id).toBeGreaterThan(0);
  });

  test("the catalogue has one line per capability", () => {
    const lines = catalogue(CAPABILITIES).split("\n").slice(1);
    expect(lines).toHaveLength(CAPABILITIES.length);
    for (const [i, c] of CAPABILITIES.entries()) expect(lines[i]).toStartWith(`- ${c.id}: ${c.label}`);
  });
});

// ---- explain_policy ----------------------------------------------------------------------------------

describe("explain_policy", () => {
  const explain = (p?: string) => explainPolicy(CAPABILITIES, p);
  const text = (p?: string) => {
    const r = explain(p);
    if ("error" in r) throw new Error(`${p}: ${r.error}`);
    return r.text;
  };

  test("documents exactly the fields policy.ts accepts", () => {
    expect(TOP_FIELDS.map((f) => f.name).sort()).toEqual([...TOP_KEYS].sort());
    expect(ENTRY_FIELDS.map((f) => f.name).sort()).toEqual([...ENTRY_KEYS].sort());
  });

  test("every policy field, capability and parameter is explainable", () => {
    for (const p of explainablePaths(CAPABILITIES)) expect("text" in explain(p), p).toBe(true);
    for (const f of ENTRY_FIELDS) expect(text(`chats.<entry>.${f.name}`)).toContain(`FIELD:    chats.<entry>.${f.name}`);
    for (const c of CAPABILITIES) expect(text(`tools.${c.id}`)).toContain(`CAPABILITY: ${c.id}`);
    // A bare name is a capability, unless a field has that name (memory): then the field, pointing to it.
    for (const c of CAPABILITIES) if (!ENTRY_KEYS.has(c.id)) expect(text(c.id)).toBe(text(`tools.${c.id}`));
    expect(text("memory")).toContain("SEE ALSO:\n    tools.memory (the capability of that name)");
    for (const a of Object.keys(TOOL_ALIASES)) expect("text" in explain(`tools.${a}`), a).toBe(true);
  });

  test("the root is the file's structure", () => {
    const t = text();
    for (const f of [...TOP_FIELDS, ...ENTRY_FIELDS]) expect(t).toContain(`  ${f.name}\t<${f.type}>`);
  });

  test("a field: its type, values and defaults, by its full path or its bare name", () => {
    const t = text("chats.-1001111111111.trigger");
    expect(t).toBe(text("trigger"));
    expect(t).toContain('FIELD:    chats.<entry>.trigger <"all" | []enum>');
    expect(t).toContain("VALUES:\n    all\n    mention\n    reply\n    followup");
    expect(t).toContain("DEFAULT:\n    dm: all; group: [mention, reply, followup]");
    expect(text("persona")).toContain("private: the owner's DM only");
  });

  test("a capability: what it gives, its parameters, its owner-only tools and an example", () => {
    const t = text("tools.workstream");
    expect(t).toBe(text("workstream"));
    expect(t).toContain("CAPABILITY: workstream");
    expect(t).toContain("  products\t<[]string>");
    expect(t).toContain("default: any product");
    expect(t).toContain("OWNER-ONLY TOOLS:\n    ask_workstream");
    expect(t).toContain("EXAMPLE:\n    tools:\n      workstream: { products: [widgetry] }");
    expect(t).toContain("workstream-read");
    expect(text("tools.web")).toContain("PARAMETERS:\n    none ({})");
    expect(text("groups")).toContain("ALWAYS ON:");
    expect(text("workstream.products")).toBe(text("chats.dm.tools.workstream.products"));
    expect(text("tools.workstream.products")).toContain("FIELD:    chats.<entry>.tools.workstream.products <[]string>");
    expect(text("tools")).toContain("- stickers: stickers");
  });

  test("an unknown path names the valid paths near it", () => {
    const e = (p: string) => {
      const r = explain(p);
      if (!("error" in r)) throw new Error(`${p} should not explain`);
      return r.error;
    };
    expect(e("triger")).toContain("did you mean trigger?");
    expect(e("tools.workstrem")).toContain("did you mean workstream?");
    expect(e("tools.workstrem")).toContain("Valid here: speech, web,");
    expect(e("tools.workstream.product")).toContain("did you mean tools.workstream.products?");
    expect(e("tools.web.depth")).toBe('tools.web has no "depth": nothing is below tools.web. explain_policy("tools.web") describes it.');
    expect(e("nonsense")).toContain("Valid here: owner, chats, unknown_chat, title, trigger,");
  });
});

// ---- checking a proposed entry -----------------------------------------------------------------------

describe("checkTools", () => {
  const check = (tools: unknown) => checkTools(CAPABILITIES, tools);
  test("accepts ids, aliases, declared parameters of the right type, and all", () => {
    expect(check("all")).toBeNull();
    expect(check({ web: {}, chat: {}, "workstream-read": { products: ["widgetry"] } })).toBeNull();
  });
  test("refuses unknown ids, unknown parameters and ill-typed ones, naming the options and the explain path", () => {
    expect(check({ webb: {} })).toContain('"webb" is not a capability (did you mean web?). Valid: speech, web, vision');
    expect(check({ webb: {} })).toContain('explain_policy("tools")');
    expect(check({ web: { depth: 3 } })).toBe('tools.web: "depth" is not a parameter of web; it takes none ({}) (see explain_policy("tools.web"))');
    expect(check({ workstream: { products: "widgetry" } })).toBe('tools.workstream.products must be a list of text, e.g. ["widgetry"] (see explain_policy("tools.workstream.products"))');
    expect(check({ workstream: { product: ["x"] } })).toContain("it takes products");
  });
});

describe("propose_policy checks the entry before any card", () => {
  test("an invalid entry is an error naming the valid options and an explain path; no card is sent", async () => {
    const db = memDb();
    const home = mkdtempSync(join(tmpdir(), "shuvi-policy-view-"));
    writeFileSync(join(home, "policy.yaml"), POLICY_YAML);
    Bun.spawnSync(["git", "-C", home, "init", "-q"]);
    ownerSays(db, "change the book club");
    const turn = claimTurn(db, ownerChatId(db))!;
    const propose = (entry: unknown) => ({ tool: "propose_policy", args: { chat: String(BOOK_CLUB), entry, why: "The owner asked." } });
    let adapter!: ScriptedAdapter;
    await runTurn({
      db,
      turnId: turn.id,
      home,
      timeZone: "UTC",
      ownerId: OWNER,
      capabilities: enabledCapabilities({}),
      policy: policyOf(),
      makeAdapter: (b) =>
        (adapter = new ScriptedAdapter(b, [
          propose({ tools: { webb: {} } }),
          propose({ tools: { workstream: { products: "widgetry" } } }),
          propose({ tools: { web: { depth: 2 } } }),
          propose({ memory: ["private"] }),
          propose({ trigger: ["mentions"] }),
          { tool: "explain_policy", args: { path: "tools.workstream" } },
          { tool: "read_policy" },
          { tool: "pass" },
        ])),
    });
    const results = adapter.toolResults.map((r) => ({ name: r.name, error: !!r.result.isError, text: r.result.content.map((c) => (c.type === "text" ? c.text : "")).join("") }));
    const [webb, ill, depth, priv, trig, explained, read] = results;
    for (const r of [webb, ill, depth, priv, trig]) {
      expect(r!.error).toBe(true);
      expect(r!.text).toContain("Nothing was proposed.");
      expect(r!.text).toContain("explain_policy(");
    }
    expect(webb!.text).toContain("did you mean web?");
    expect(ill!.text).toContain('explain_policy("tools.workstream.products")');
    expect(depth!.text).toContain("it takes none");
    expect(priv!.text).toContain("in a group memory may only be [chat]");
    expect(priv!.text).toContain('explain_policy("memory")');
    expect(trig!.text).toContain("is not one of mention / reply / followup");
    expect(trig!.text).toContain('explain_policy("trigger")');
    expect(controlMessagesOf(db, "approval")).toHaveLength(0);
    expect(explained!.error).toBe(false);
    expect(explained!.text).toContain("CAPABILITY: workstream");
    expect(read!.text).toContain(`title: Book Club`);
    expect(read!.text).toContain("Capabilities (the ids `tools` takes");
    expect(read!.text).toContain("- computer: computer (owner only).");
  });
});

// ---- /policy in the control bot ----------------------------------------------------------------------

const deps = (policy: Policy, enabled?: string[]) => ({ ownerId: OWNER, commit: "abc1234", timeZone: "UTC", policy: () => policy, ...(enabled ? { enabled: new Set(enabled) } : {}) });

describe("/policy", () => {
  test("is in the command menu", () => {
    expect(CONTROL_COMMANDS.map((c) => c.command)).toContain("policy");
  });

  test("lists every chat, the DM first, in words and HTML, over the fake Bot API", async () => {
    const db = memDb();
    tg = new FakeTelegram();
    const api = new Api("CONTROL", { apiRoot: tg.apiRoot });
    const enabled = CAPABILITIES.map((c) => c.id).filter((id) => id !== "computer" && id !== "workstream");
    recordControlBatch(db, [dmUpdate(1, "/policy")], deps(policyOf(), enabled));
    recordControlBatch(db, [dmUpdate(2, "/policy", 4242)], deps(policyOf(), enabled)); // not the owner: nothing
    expect((await controlSendPass(db, api, OWNER)).sent).toBe(1);
    const [msg] = tg.sent();
    expect(msg!.parse_mode).toBe("HTML");
    const t = String(msg!.text);
    expect(t).not.toMatch(/^\s*\w+:\s*$|tools:|persona:/m); // no YAML
    expect(t.indexOf("<b>1. Your DM</b>  <i>1001</i>")).toBeGreaterThan(-1);
    expect(t.indexOf("<b>1. Your DM</b>")).toBeLessThan(t.indexOf("<b>2. Book Club</b>"));
    expect(t).toContain("<b>Wakes her:</b> every message");
    expect(t).toContain("<b>Sees:</b> public persona, private side, private memory, this chat's notes");
    expect(t).toContain("<b>Can use (everything):</b>\n• web lookups");
    expect(t).not.toContain("• computer (owner only)"); // not set up on this server
    expect(t).toContain(`<b>2. Book Club</b>  <i>${BOOK_CLUB}</i>\n<b>Wakes her:</b> mention, reply, follow-up (5 min)\n<b>Sees:</b> public persona, this chat's notes`);
    expect(t).toContain("• web lookups\n• stickers");
    expect(t).toContain("Listed but not set up on this server: workstream (owner only)");
    expect(t).toContain("<b>3. Chess &lt;Night&gt; &amp; Co</b>"); // escaped
    expect(t).toContain("<b>Wakes her:</b> mention\n<b>Sees:</b> public persona\n<b>Can use:</b> nothing beyond talking");
    expect(t).toContain("<b>4. Untitled group</b>");
    expect(t).toContain("<b>Unknown groups:</b> ignored");
  });

  test("a store title stands in for an entry without one", () => {
    const db = memDb();
    db.$client.exec(`insert into chats (tg_chat_id, kind, title) values (${UNTITLED}, 'group', 'Garden Club')`);
    expect(policyText(db, deps(policyOf()))[0]).toContain("<b>4. Garden Club</b>");
  });

  test("/policy <chat> shows one chat in detail, with what is off, by number or Telegram id", async () => {
    const db = memDb();
    tg = new FakeTelegram();
    const api = new Api("CONTROL", { apiRoot: tg.apiRoot });
    recordControlBatch(db, [dmUpdate(1, "/policy 2"), dmUpdate(2, `/policy ${BOOK_CLUB}`), dmUpdate(3, "/policy 9"), dmUpdate(4, "/policy dm")], deps(policyOf()));
    await controlSendPass(db, api, OWNER);
    const [byNumber, byId, missing, dm] = tg.sent().map((m) => String(m.text));
    expect(byId).toBe(byNumber!);
    expect(byNumber).toContain(`<b>2. Book Club</b>  <i>${BOOK_CLUB}</i>`);
    expect(byNumber).toContain("<b>Wakes her:</b> a message that mentions her; a reply to one of her messages; a follow-up from someone she just answered, within 5 min");
    expect(byNumber).toContain("<b>Does not see:</b> private side, private memory (private layers are never seen in a group)");
    expect(byNumber).toContain("• workstream (owner only), products: widgetry, gadgetworks");
    expect(byNumber).toContain("<b>Off:</b>\n• seeing photos and stickers");
    expect(byNumber).toContain("• computer (owner only)");
    expect(byNumber).toContain("<b>Always on:</b> talking, groups and policy");
    expect(byNumber).toContain("<b>Not known to this build</b> (does nothing): teleport");
    expect(missing).toBe("No chat 9 in policy. Use its number (1 to 4) from /policy, or its Telegram id.");
    expect(dm).toContain("<b>1. Your DM</b>");
    expect(dm).not.toContain("<b>Off:</b>");
  });

  test("a long policy is split across messages between blocks, each under Telegram's limit", async () => {
    const db = memDb();
    tg = new FakeTelegram();
    const api = new Api("CONTROL", { apiRoot: tg.apiRoot });
    const many = `chats:\n${Array.from({ length: 60 }, (_, i) => `  "-100900000${String(i).padStart(4, "0")}":\n    title: Fake Group ${i}\n    tools: { web: {}, stickers: {}, retrieval: {} }\n`).join("")}`;
    const policy = policyOf(many);
    const parts = policyOverview({ policy, registry: CAPABILITIES, ownerId: OWNER });
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(3500);
    recordControlBatch(db, [dmUpdate(1, "/policy")], deps(policy));
    expect((await controlSendPass(db, api, OWNER)).sent).toBe(parts.length);
    const sent = tg.sent();
    expect(sent.map((m) => m.text)).toEqual(parts);
    expect(sent.every((m) => m.parse_mode === "HTML")).toBe(true);
    // Every block is whole in one message.
    for (let i = 0; i < 60; i++) expect(parts.filter((p) => p.includes(`<b>${i + 2}. Fake Group ${i}</b>`) && p.includes(`Fake Group ${i}</b>  <i>`))).toHaveLength(1);
    // Re-delivering the same update queues nothing more.
    recordControlBatch(db, [dmUpdate(1, "/policy")], deps(policy));
    expect(controlMessagesOf(db, "reply_html")).toHaveLength(parts.length);
  });

  test("packMessages never cuts inside a block", () => {
    expect(packMessages(["aaaa", "bbbb", "cccc"], 10)).toEqual(["aaaa\n\nbbbb", "cccc"]);
  });
});
