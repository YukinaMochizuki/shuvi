import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textOf, type ToolDef, type ToolResult } from "agent-runtime";
import type { TurnState } from "../src/agent/turn.ts";
import { browser, describeBrowse, type BrowserConfig } from "../src/capabilities/browser/index.ts";
import { PorchkitError } from "../src/porchkit/client.ts";
import { consoleGrant, grantsFor, pendingProvide, provideSecret, PROVIDE_KIND, requestSecret, requestSecretUpdate } from "../src/capabilities/computer/secrets.ts";
import type { TurnContext } from "../src/capabilities/types.ts";
import { allowedHosts, allowedOrigins } from "../src/console/index.ts";
import { csrfToken, handleConsole, LOGIN_HEADER, type ConsoleDeps } from "../src/console/server.ts";
import { answerApproval, cardKeyboard, getApproval } from "../src/control/approvals.ts";
import { getNote, varAbouts, withVarAbouts } from "../src/secrets/notes.ts";
import { loadProvide } from "../src/console/provide.ts";
import { allProfiles, putProfile, redactionFor, type SecretSource } from "../src/secrets/source.ts";
import type { Db } from "../src/store/db.ts";
import { ensureChat, type Chat } from "../src/store/events.ts";
import { FakePorchkit, SHOP } from "./fake-porchkit.ts";
import { memDb, OWNER, ownerChatId } from "./helpers.ts";

const KEY = new Uint8Array(32).fill(7);
const ID = "A123456789";
const PROJECT = "PRJ-example-2026";
const OWNER_SPEAKER = { id: OWNER, name: "Owner" };

const dirs: string[] = [];
const fakes: FakePorchkit[] = [];
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  fakes.splice(0).forEach((f) => f.stop());
});

function source(key: Uint8Array | null = KEY): SecretSource {
  const d = mkdtempSync(join(tmpdir(), "shuvi-provide-"));
  dirs.push(d);
  const file = join(d, "secrets.yaml");
  writeFileSync(file, "arx:\n  KEY: ak-example-0000\n");
  chmodSync(file, 0o600);
  return { file, key };
}

const VARS = [
  { name: "VHC_PROJECT_NO", about: "專案編號（公司 HR 發的）" },
  { name: "NATIONAL_ID", about: "身分證字號" },
];

function ask(db: Db, src: SecretSource, chatId: number, requestedBy?: number) {
  const r = requestSecret(db, src, { chatId, profile: "vhc", ttl: "1d", reason: "預約健檢要登入", vars: VARS, consoleUrl: "https://console.example", ...(requestedBy ? { requestedBy } : {}) });
  if (!("approvalId" in r)) throw new Error(r.error);
  expect(r.provide).toBe(true);
  return r.approvalId;
}

describe("asking the owner for a secret there is not yet", () => {
  test("without vars it says how to ask; with vars it is a provide card: Deny its only button, a console link, never a value", () => {
    const db = memDb();
    const src = source();
    const dm = ownerChatId(db);
    expect(requestSecret(db, src, { chatId: dm, profile: "vhc", ttl: "1d", reason: "x" })).toEqual({ error: expect.stringMatching(/give `vars`|with `vars`/) });
    const id = ask(db, src, dm);
    const card = getApproval(db, id)!;
    expect(card.kind).toBe(PROVIDE_KIND);
    expect(card.body).toContain("VHC_PROJECT_NO (專案編號（公司 HR 發的）), NATIONAL_ID (身分證字號)");
    expect(card.body).toContain(`https://console.example/settings/secrets/provide?card=${id}`);
    expect(cardKeyboard(card).map((r) => r[0]!.text)).toEqual(["Deny"]);
    // The text queued for the control bot has the link too (written once the card had its id).
    const queued = db.$client.query("select text from control_messages where approval_id = ?").get(id) as { text: string };
    expect(queued.text).toContain(`/settings/secrets/provide?card=${id}`);
  });

  test("a hidden option cannot be pressed from Telegram", () => {
    const db = memDb();
    const id = ask(db, source(), ownerChatId(db));
    const option = getApproval(db, id)!.options.findIndex((o) => o.id === "1d");
    expect(answerApproval(db, id, option, OWNER_SPEAKER)).toEqual({ result: "closed" });
    expect(getApproval(db, id)!.status).toBe("pending");
  });

  test("provided in the console: kept sealed, granted as chosen, the chat woken, the note says what each variable is", () => {
    const db = memDb();
    const src = source();
    const dm = ownerChatId(db);
    const id = ask(db, src, dm);
    expect(provideSecret(db, src, id, { VHC_PROJECT_NO: PROJECT, NATIONAL_ID: "" }, "1d", OWNER_SPEAKER)).toEqual({ error: expect.stringMatching(/Give NATIONAL_ID a value/) });
    expect(provideSecret(db, src, id, { VHC_PROJECT_NO: PROJECT, NATIONAL_ID: ID }, "nope", OWNER_SPEAKER)).toEqual({ error: expect.stringMatching(/Choose where/) });
    expect(provideSecret(db, src, id, { VHC_PROJECT_NO: ` ${PROJECT}`, NATIONAL_ID: ID }, "1d", OWNER_SPEAKER)).toEqual({ profile: "vhc", label: "This chat, 1 day" });
    const all = allProfiles(db, src);
    // Kept as typed: a value may begin or end with a space.
    expect("profiles" in all && all.profiles.vhc).toEqual({ VHC_PROJECT_NO: ` ${PROJECT}`, NATIONAL_ID: ID });
    const g = grantsFor(db, dm, false);
    expect(g.map((x) => [x.profile, x.chatId])).toEqual([["vhc", dm]]);
    const ev = db.$client.query("select payload from chat_events where chat_id = ? and kind = 'approval'").get(dm) as { payload: string };
    expect(ev.payload).toContain("This chat, 1 day");
    expect(getNote(db, "vhc")!.details).toBe("Variables:\n- VHC_PROJECT_NO: 專案編號（公司 HR 發的）\n- NATIONAL_ID: 身分證字號");
    expect(JSON.stringify(db.$client.query("select * from approvals").all())).not.toContain(ID);
    expect(pendingProvide(db, id)).toEqual({ error: expect.stringMatching(/answered already/) });
  });

  test("an operator's request offers this chat only: an every-chat answer is refused", () => {
    const db = memDb();
    const src = source();
    const group = ensureChat(db, { id: -100777, kind: "group", title: "Example Family" }).id;
    const id = ask(db, src, group, 4242);
    expect(getApproval(db, id)!.options.filter((o) => o.hidden).map((o) => o.id)).toEqual(["4h", "1d", "3d"]);
    expect(loadProvide(db, src, id).ask!.operator).toBe(4242);
    expect(provideSecret(db, src, id, { VHC_PROJECT_NO: PROJECT, NATIONAL_ID: ID }, "all-forever", OWNER_SPEAKER)).toEqual({ error: expect.stringMatching(/Choose where/) });
  });

  test("bad names are refused before a card; no key, no card", () => {
    const db = memDb();
    const dm = ownerChatId(db);
    expect(requestSecret(db, source(), { chatId: dm, profile: "bad.name", ttl: "1d", reason: "x", vars: [{ name: "A" }] })).toEqual({ error: expect.stringMatching(/cannot be a profile's name/) });
    expect(requestSecret(db, source(), { chatId: dm, profile: "ok", ttl: "1d", reason: "x", vars: [{ name: "1bad" }] })).toEqual({ error: expect.stringMatching(/not a variable name/) });
    expect(requestSecret(db, source(null), { chatId: dm, profile: "ok", ttl: "1d", reason: "x", vars: [{ name: "A" }] })).toEqual({ error: expect.stringMatching(/SHUVI_SECRETS_KEY/) });
    // No console address: the card's link would lead nowhere on his phone.
    expect(requestSecret(db, source(), { chatId: dm, profile: "ok", ttl: "1d", reason: "x", vars: [{ name: "A" }] })).toEqual({ error: expect.stringMatching(/SHUVI_CONSOLE_URL/) });
  });
});

describe("asking the owner for new values of a profile he keeps", () => {
  test("an update card asks for only those; saved, the others keep their values, the grants stay, the note learns what each is", async () => {
    const db = memDb();
    const src = source();
    const dm = ownerChatId(db);
    putProfile(db, src, "contact", { WORK_EMAIL: "work@example.com", HOME_ADDRESS: "Example Rd 1" });
    consoleGrant(db, "contact", "forever");
    expect(requestSecretUpdate(db, src, { chatId: dm, profile: "arx", reason: "x", vars: [{ name: "KEY" }], consoleUrl: "https://console.example" })).toEqual({ error: expect.stringMatching(/a profile of the secrets file/) });
    expect(requestSecretUpdate(db, src, { chatId: dm, profile: "nope", reason: "x", vars: [{ name: "A" }], consoleUrl: "https://console.example" })).toEqual({ error: expect.stringMatching(/no secret profile "nope" to update/) });
    const r = requestSecretUpdate(db, src, { chatId: dm, profile: "contact", reason: "門牌號碼不完整", vars: [{ name: "HOME_ADDRESS" }, { name: "PHONE", about: "手機號碼" }], consoleUrl: "https://console.example" });
    if (!("approvalId" in r)) throw new Error(r.error);
    const card = getApproval(db, r.approvalId)!;
    expect(card.title).toContain('new values in the secret "contact"');
    expect(cardKeyboard(card).map((x) => x[0]!.text)).toEqual(["Deny"]);
    const html = await get(db, src, `/settings/secrets/provide?card=${r.approvalId}`);
    expect(text(html)).toContain("New values for contact");
    expect(html).toContain('name="v_HOME_ADDRESS"');
    expect(html).not.toContain('name="v_WORK_EMAIL"');
    expect(html).toContain('value="update" checked');
    expect(provideSecret(db, src, r.approvalId, { HOME_ADDRESS: "Example Rd 1, No. 5, 3F", PHONE: "0900-000-000" }, "update", OWNER_SPEAKER)).toEqual({ profile: "contact", label: "Only the values: its grants stay as they are" });
    const all = allProfiles(db, src);
    expect("profiles" in all && all.profiles.contact).toEqual({ WORK_EMAIL: "work@example.com", HOME_ADDRESS: "Example Rd 1, No. 5, 3F", PHONE: "0900-000-000" });
    expect(grantsFor(db, dm, true).map((g) => [g.profile, g.chatId])).toEqual([["contact", null]]);
    expect(getNote(db, "contact")!.details).toBe("Variables:\n- PHONE: 手機號碼");
    // The old value stays redacted.
    expect(redactionFor(db, src).redact("Example Rd 1")).toBe("[REDACTED:contact]");
  });
});

describe("a variable's description in the note", () => {
  test("set, replaced or taken out; the note's other lines kept", () => {
    expect(withVarAbouts("", { A: "first" })).toBe("Variables:\n- A: first");
    expect(withVarAbouts("Scope: repo.", { A: "first" })).toBe("Variables:\n- A: first\n\nScope: repo.");
    expect(withVarAbouts("Variables:\n- A: first\n\nScope: repo.", { A: "one", B: "two" })).toBe("Variables:\n- A: one\n- B: two\n\nScope: repo.");
    expect(withVarAbouts("Variables:\n- A: one\n- B: two\nmore", {}, ["A"])).toBe("Variables:\n- B: two\nmore");
    expect(varAbouts({ details: "Variables:\n- A: one\n- B\n not: this" })).toEqual({ A: "one" });
  });
});

// ---- the provide page --------------------------------------------------------------------------------------

const PORT = 8787;
const HOST = `127.0.0.1:${PORT}`;
const BASE = `http://${HOST}`;
const LOGIN = "owner@example.com";
const CSRF = csrfToken("example-csrf-secret", `login:${LOGIN}`);
function deps(db: Db, src: SecretSource): ConsoleDeps {
  const c = { listen: HOST };
  return { db, timeZone: "UTC", dataDir: "/nonexistent", allowedHosts: allowedHosts(c, PORT), allowedOrigins: allowedOrigins(c, PORT), csrfSecret: "example-csrf-secret", users: new Set([LOGIN]), ownerId: OWNER, secrets: src };
}
async function get(db: Db, src: SecretSource, path: string): Promise<string> {
  const res = await handleConsole(deps(db, src), new Request(`${BASE}${path}`, { headers: { [LOGIN_HEADER]: LOGIN } }));
  expect(res.status).toBe(200);
  return res.text();
}
async function post(db: Db, src: SecretSource, fields: Record<string, string>): Promise<string> {
  const res = await handleConsole(
    deps(db, src),
    new Request(`${BASE}/settings/secrets/provide`, { method: "POST", headers: { [LOGIN_HEADER]: LOGIN, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...fields, csrf: CSRF }) }),
  );
  expect(res.status).toBe(303);
  return get(db, src, res.headers.get("location")!);
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("the provide page", () => {
  test("shows what she asks for, each field with what it is; a refused save comes back empty; a save answers the card", async () => {
    const db = memDb();
    const src = source();
    const id = ask(db, src, ownerChatId(db));
    let html = await get(db, src, `/settings/secrets/provide?card=${id}`);
    expect(text(html)).toContain("She needs vhc");
    expect(text(html)).toContain("專案編號（公司 HR 發的） VHC_PROJECT_NO");
    expect(html).toContain('name="v_NATIONAL_ID"');
    expect(html).toContain('value="all-forever"');
    html = await post(db, src, { card: String(id), do: "provide", v_VHC_PROJECT_NO: PROJECT, v_NATIONAL_ID: "", grant: "1d" });
    expect(text(html)).toContain("Give NATIONAL_ID a value");
    expect(html).not.toContain(PROJECT);
    html = await post(db, src, { card: String(id), do: "provide", v_VHC_PROJECT_NO: PROJECT, v_NATIONAL_ID: ID, grant: "all-1d", v_EXTRA: "ignored-value" });
    expect(text(html)).toContain("Saved vhc and gave it to her: Every chat, 1 day.");
    expect(html).not.toContain(ID);
    const all = allProfiles(db, src);
    expect("profiles" in all && Object.keys(all.profiles.vhc!)).toEqual(["VHC_PROJECT_NO", "NATIONAL_ID"]);
    // Opened again: it says so, no form.
    html = await get(db, src, `/settings/secrets/provide?card=${id}`);
    expect(text(html)).toContain("vhc was provided: Every chat, 1 day.");
    expect(html).not.toContain('name="v_NATIONAL_ID"');
  });

  test("deny answers the card and tells her", async () => {
    const db = memDb();
    const src = source();
    const dm = ownerChatId(db);
    const id = ask(db, src, dm);
    const html = await post(db, src, { card: String(id), do: "deny" });
    expect(text(html)).toContain("Denied. She has been told.");
    expect(getApproval(db, id)!.answer).toBe("deny");
    expect(grantsFor(db, dm, true)).toEqual([]);
  });
});

// ---- typing a secret in the browser --------------------------------------------------------------------------

function toolsFor(db: Db, p: FakePorchkit, chat: Chat, src: SecretSource, acting: "owner" | "operator" = "owner"): Record<string, (args?: Record<string, unknown>) => Promise<ToolResult>> {
  const cfg = { ...(browser.enable(p.env()) as BrowserConfig), secrets: src };
  const state = { chat, turnId: 1, passed: false, stopping: false, n: 0, fromSeq: 0, toSeq: 0, acting: () => (acting === "owner" ? { by: "owner" } : { by: "operator", userId: 4242 }) } as unknown as TurnState;
  const home = mkdtempSync(join(tmpdir(), "shuvi-browser-"));
  dirs.push(home);
  mkdirSync(join(home, "persona"));
  const ctx: TurnContext = { db, home, chat, turnId: 1, timeZone: "UTC", owner: {}, state, ownerId: OWNER };
  const defs = browser.tools!(ctx, cfg).flatMap((b) => b.tools as ToolDef[]);
  return Object.fromEntries(defs.map((d) => [d.name, (args: Record<string, unknown> = {}) => d.handler(args)]));
}
const typeActs = (p: FakePorchkit) => p.calls.filter((c) => c.path.endsWith("/act") && c.body.action === "type").map((c) => c.body);

describe("browser_type with a secret", () => {
  test("types the granted value with mask, and she sees it only as [REDACTED]", async () => {
    const p = new FakePorchkit();
    fakes.push(p);
    p.browse.echoTyped = true;
    const db = memDb();
    const src = source();
    const chat = ensureChat(db, { id: OWNER, kind: "private" });
    putProfile(db, src, "vhc", { NATIONAL_ID: ID });
    consoleGrant(db, "vhc", "1d");
    const t = toolsFor(db, p, chat, src);
    await t.browser_open!({ url: SHOP });
    const r = await t.browser_type!({ ref: "e2", secret: "vhc.NATIONAL_ID" });
    expect(r.isError).toBeFalsy();
    expect(typeActs(p).at(-1)).toMatchObject({ text: ID, mask: true, ref: "e2" });
    expect(textOf(r)).toContain("[REDACTED:vhc]");
    expect(textOf(r)).not.toContain(ID);
    // Plain text the page shows back is redacted too, whatever typed it.
    const plain = await t.browser_type!({ ref: "e2", text: `again ${ID}` });
    expect(textOf(plain)).not.toContain(ID);
    expect(typeActs(p).at(-1)!.mask).toBeUndefined();
  });

  test("refused, typing nothing: not granted, an unknown variable, both or neither of text and secret, and an operator's call", async () => {
    const p = new FakePorchkit();
    fakes.push(p);
    const db = memDb();
    const src = source();
    const chat = ensureChat(db, { id: OWNER, kind: "private" });
    putProfile(db, src, "vhc", { NATIONAL_ID: ID });
    const t = toolsFor(db, p, chat, src);
    await t.browser_open!({ url: SHOP });
    expect(textOf(await t.browser_type!({ ref: "e2", secret: "vhc.NATIONAL_ID" }))).toContain('"vhc" is not granted here');
    consoleGrant(db, "vhc", "forever");
    expect(textOf(await t.browser_type!({ ref: "e2", secret: "vhc.NOPE" }))).toContain("has no variable NOPE; it has NATIONAL_ID");
    expect(textOf(await t.browser_type!({ ref: "e2", secret: "vhc.NATIONAL_ID", text: "x" }))).toContain("Give either text or secret");
    expect(textOf(await t.browser_type!({ ref: "e2" }))).toContain("Give either text or secret");
    // An owner grant is never an operator's (the boundary refuses the call first; this is the second line).
    const op = toolsFor(db, p, chat, src, "operator");
    expect(textOf(await op.browser_type!({ ref: "e2", secret: "vhc.NATIONAL_ID" }))).toContain('"vhc" is not granted here');
    expect(typeActs(p)).toEqual([]);
  });

  test("a failed masked type says whether anything was left unmasked, from porchkit's `left` (unknown: assumed left)", () => {
    const err = (body: Record<string, unknown>) => new PorchkitError(409, "not_typed", "the field did not take the keys", { error: "not_typed", acted: true, ...body });
    expect(describeBrowse(err({ masked: false, left: false }))).toContain("Nothing of it was left on the page.");
    expect(describeBrowse(err({ masked: true, left: false }))).toContain("What reached the page is masked.");
    expect(describeBrowse(err({ masked: false, left: true }))).toContain("may still be on the page UNMASKED");
    // An older porchkit, without `left`: a key reached the page and it is not masked, so it may be there.
    expect(describeBrowse(err({ masked: false }))).toContain("may still be on the page UNMASKED");
    expect(describeBrowse(err({ masked: false, acted: false }))).toContain("Nothing of it was left on the page.");
  });

  test("a typing the browser does not confirm it masked is reported, not trusted", async () => {
    const p = new FakePorchkit();
    fakes.push(p);
    p.browse.ignoresMask = true;
    const db = memDb();
    const src = source();
    const chat = ensureChat(db, { id: OWNER, kind: "private" });
    putProfile(db, src, "vhc", { NATIONAL_ID: ID });
    consoleGrant(db, "vhc", "1d");
    const t = toolsFor(db, p, chat, src);
    await t.browser_open!({ url: SHOP });
    const r = await t.browser_type!({ ref: "e2", secret: "vhc.NATIONAL_ID" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("did not confirm the field is masked");
  });

  test("a handler that throws has its message redacted too", async () => {
    const db = memDb();
    const src = source();
    putProfile(db, src, "vhc", { NATIONAL_ID: ID });
    const p = new FakePorchkit();
    fakes.push(p);
    const chat = ensureChat(db, { id: OWNER, kind: "private" });
    const cfg = { ...(browser.enable(p.env()) as BrowserConfig), secrets: src };
    const thrower = { name: "x", description: "x", inputSchema: {}, handler: async () => { throw new Error(`boom ${ID}`); } } as unknown as ToolDef;
    // redactingAll is applied to every tool the capability gives; check it on one that throws.
    const { redactingAllForTest } = await import("../src/capabilities/browser/index.ts");
    const [wrapped] = redactingAllForTest({ db, chat } as unknown as TurnContext, cfg, [thrower]);
    await expect(wrapped!.handler({})).rejects.toThrow("boom [REDACTED:vhc]");
  });

  test("a secret typing is the owner's call; plain typing is anyone's", () => {
    const when = browser.ownerOnlyWhen!.browser_type!;
    expect(when({ ref: "e2", secret: "vhc.NATIONAL_ID" })).toBe(true);
    expect(when({ ref: "e2", text: "hello" })).toBe(false);
    expect(browser.delegable ?? []).not.toContain("browser_type");
  });
});
