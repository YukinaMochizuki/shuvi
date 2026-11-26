import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consoleGrant, grantedNames, grantsFor, liveGrants, ownerGrants, requestSecret, revokeGrant, secretsForChat, syncGrants } from "../src/capabilities/computer/secrets.ts";
import { allowedHosts, allowedOrigins } from "../src/console/index.ts";
import { csrfToken, handleConsole, LOGIN_HEADER, type ConsoleDeps } from "../src/console/server.ts";
import { answerApproval } from "../src/control/approvals.ts";
import { getNote, setNote } from "../src/secrets/notes.ts";
import { knownFile } from "../src/secrets/redaction.ts";
import { allProfiles, deleteProfile, LiveRedaction, parseVars, putProfile, redactionFor, secretSource, storedProfiles, type SecretSource } from "../src/secrets/source.ts";
import { open, parseKey, seal } from "../src/secrets/vault.ts";
import type { Db } from "../src/store/db.ts";
import { ensureChat } from "../src/store/events.ts";
import { secretGrants, secretProfiles } from "../src/store/schema.ts";
import { memDb, OWNER, ownerChatId } from "./helpers.ts";

const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);
const GH = "ghp_example_value_0123456789";
const GH2 = "ghp_example_rotated_9876543210";
const MODAL = "as-example-modal-secret";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A secrets file holding `modal`, and a source over it with `key`. */
function source(key: Uint8Array | null = KEY): SecretSource {
  const d = mkdtempSync(join(tmpdir(), "shuvi-owner-secrets-"));
  dirs.push(d);
  const file = join(d, "secrets.yaml");
  writeFileSync(file, `modal:\n  MODAL_TOKEN_SECRET: ${MODAL}\n`);
  chmodSync(file, 0o600);
  return { file, key };
}

describe("the vault", () => {
  test("seals and opens; another key, another name or a changed byte does not open", () => {
    const sealed = seal(KEY, "github", { GH_TOKEN: GH });
    expect(sealed.includes(Buffer.from(GH))).toBe(false);
    expect(open(KEY, "github", sealed)).toEqual({ GH_TOKEN: GH });
    expect(() => open(OTHER_KEY, "github", sealed)).toThrow(/does not open/);
    expect(() => open(KEY, "gitlab", sealed)).toThrow(/does not open/);
    const bent = Buffer.from(sealed);
    bent[bent.length - 1]! ^= 1;
    expect(() => open(KEY, "github", bent)).toThrow(/does not open/);
    // Two seals of the same values differ (a random IV each).
    expect(seal(KEY, "github", { GH_TOKEN: GH }).equals(sealed)).toBe(false);
  });

  test("SHUVI_SECRETS_KEY: unset is no key; not base64 or not 32 bytes says why", () => {
    expect(parseKey(undefined)).toEqual({ key: null });
    expect(parseKey("")).toEqual({ key: null });
    expect(parseKey("not base64!").error).toMatch(/not base64/);
    expect(parseKey(Buffer.alloc(16).toString("base64")).error).toMatch(/16 bytes, not 32/);
    expect(parseKey(Buffer.from(KEY).toString("base64")).key).toEqual(KEY);
    const s = secretSource({ SHUVI_SECRETS_KEY: "short" }, "/etc/x.yaml");
    expect(s).toMatchObject({ file: "/etc/x.yaml", key: null });
    expect(s.keyError).toBeDefined();
  });
});

describe("profiles kept in the store", () => {
  test("added beside the file's; the store holds no value in the clear", () => {
    const db = memDb();
    const src = source();
    expect(putProfile(db, src, "github", { GH_TOKEN: GH })).toEqual({ created: true });
    const all = allProfiles(db, src);
    if ("error" in all) throw new Error(all.error);
    expect(all.profiles).toEqual({ modal: { MODAL_TOKEN_SECRET: MODAL }, github: { GH_TOKEN: GH } });
    expect(all.from).toEqual({ modal: "file", github: "store" });
    const row = db.select().from(secretProfiles).get()!;
    expect(row.varNames).toEqual(["GH_TOKEN"]);
    expect(JSON.stringify(row)).not.toContain(GH);
    expect(Buffer.from(row.sealed).includes(Buffer.from(GH))).toBe(false);
  });

  test("refused: without a key, a name the file holds, a bad name", () => {
    const db = memDb();
    expect(putProfile(db, source(null), "github", { GH_TOKEN: GH })).toEqual({ error: expect.stringMatching(/SHUVI_SECRETS_KEY is not set/) });
    expect(putProfile(db, source(), "modal", { X: "y" })).toEqual({ error: expect.stringMatching(/is a profile of the secrets file/) });
    expect(putProfile(db, source(), "has.dot", { X: "yyyy" })).toEqual({ error: expect.stringMatching(/not a profile name/) });
    expect(db.select().from(secretProfiles).all()).toEqual([]);
  });

  test("without the key, or under another, a kept profile is listed as unreadable and gives nothing", () => {
    const db = memDb();
    const src = source();
    putProfile(db, src, "github", { GH_TOKEN: GH });
    for (const other of [{ ...src, key: null }, { ...src, key: OTHER_KEY }]) {
      const all = allProfiles(db, other);
      if ("error" in all) throw new Error(all.error);
      expect(all.profiles.github).toBeUndefined();
      expect(all.unreadable.map((u) => u.name)).toEqual(["github"]);
    }
  });

  test("a file profile of the same name hides the store's", () => {
    const db = memDb();
    const src = source();
    putProfile(db, src, "github", { GH_TOKEN: GH });
    writeFileSync(src.file, `modal:\n  MODAL_TOKEN_SECRET: ${MODAL}\ngithub:\n  GH_TOKEN: from-the-file-0000\n`);
    const all = allProfiles(db, src);
    if ("error" in all) throw new Error(all.error);
    expect(all.profiles.github).toEqual({ GH_TOKEN: "from-the-file-0000" });
    expect(all.shadowed).toEqual(["github"]);
  });

  test("a replaced or deleted value stays redacted; the known file never holds it in the store", () => {
    const db = memDb();
    const src = source();
    putProfile(db, src, "github", { GH_TOKEN: GH });
    putProfile(db, src, "github", { GH_TOKEN: GH2 });
    let red = redactionFor(db, src);
    expect(red.redact(`old ${GH} new ${GH2}`)).toBe("old [REDACTED:github] new [REDACTED:github]");
    deleteProfile(db, src, "github");
    red = redactionFor(db, src);
    expect(red.redact(`${GH2} ${MODAL}`)).toBe("[REDACTED:github] [REDACTED:modal]");
    expect(existsSync(knownFile(src.file))).toBe(true);
    expect(JSON.stringify(db.select().from(secretProfiles).all())).not.toContain(GH2);
  });

  test("a value cannot go out unless it stays redacted: an unwritable known file refuses the replace and the delete", () => {
    const db = memDb();
    const src = source();
    putProfile(db, src, "github", { GH_TOKEN: GH });
    rmSync(knownFile(src.file));
    mkdirSync(knownFile(src.file)); // a directory: it cannot be written
    expect(putProfile(db, src, "github", { GH_TOKEN: GH2 })).toEqual({ error: expect.stringMatching(/cannot be written/) });
    expect(deleteProfile(db, src, "github")).toEqual({ error: expect.stringMatching(/cannot be written/) });
    const all = allProfiles(db, src);
    expect("profiles" in all && all.profiles.github).toEqual({ GH_TOKEN: GH });
  });

  test("the live redaction of a turn picks up a profile added while it runs", () => {
    const db = memDb();
    const src = source();
    let now = 0;
    const live = new LiveRedaction(db, src, 1000, () => now);
    expect(live.redact(GH)).toBe(GH);
    putProfile(db, src, "github", { GH_TOKEN: GH }, 1);
    now = 2000;
    expect(live.redact(`x ${GH}`)).toBe("x [REDACTED:github]");
  });

  test("NAME=value lines", () => {
    expect(parseVars("# a comment\nGH_TOKEN=abc=def\n\n  OTHER = x ")).toEqual({ vars: { GH_TOKEN: "abc=def", OTHER: "x" } });
    expect(parseVars("just a token")).toEqual({ error: "Line 1 is not NAME=value." });
    expect(parseVars("1BAD=x")).toEqual({ error: expect.stringMatching(/not a variable name/) });
    // A value pasted without a name: never taken for a name, never echoed back.
    expect(parseVars("dGVzdHNlY3JldA==")).toEqual({ error: expect.stringMatching(/^Line 1 looks like a value without a name/) });
    const bent = parseVars("abc+def/ghiSECRETPART==");
    expect("error" in bent && !bent.error.includes("SECRETPART") && !bent.error.includes("abc")).toBe(true);
    expect(parseVars("A=1\nA=2")).toEqual({ error: "A is given twice." });
    expect(parseVars("dGVzdHNlY3JldDE=")).toEqual({ error: 'Line 1 has nothing after its "=": write it as NAME=value.' });
    expect(parseVars("\n\n")).toEqual({ error: "Give at least one NAME=value line." });
  });
});

describe("owner grants: every chat, the owner's calls only", () => {
  function world() {
    const db = memDb();
    const src = source();
    putProfile(db, src, "github", { GH_TOKEN: GH });
    const dm = ownerChatId(db);
    const group = ensureChat(db, { id: -100555, kind: "group", title: "Example Group" }).id;
    return { db, src, dm, group };
  }

  test("an owner grant from the console gives every chat's owner calls the values, never an operator's", () => {
    const { db, src, dm, group } = world();
    const g = consoleGrant(db, "github", "forever");
    expect(g).toMatchObject({ chatId: null, approvalId: null, expiresAt: null });
    expect(g.revokeApprovalId).not.toBeNull();
    for (const chat of [dm, group]) {
      expect(secretsForChat(db, src, chat, true)).toMatchObject({ env: { GH_TOKEN: GH }, profiles: ["github"] });
      expect(secretsForChat(db, src, chat, false)).toMatchObject({ env: {}, profiles: [] });
    }
    expect(liveGrants(db, group)).toEqual([]);
    expect(grantedNames(db, group)).toEqual({ chat: [], owner: ["github"] });
    // Until revoked means it does not end with time.
    expect(grantsFor(db, dm, true, Date.now() + 365 * 24 * 3600_000).map((x) => x.id)).toEqual([g.id]);
  });

  test("revoked from the console as its card is pressed; a chat's page cannot revoke it", () => {
    const { db, src, dm } = world();
    const g = consoleGrant(db, "github", "1d");
    expect(revokeGrant(db, g.id, dm, { id: OWNER, name: "Owner" })).toEqual({ error: expect.stringMatching(/no grant/) });
    expect(revokeGrant(db, g.id, null, { id: OWNER, name: "Owner" })).toMatchObject({ revoked: { id: g.id } });
    expect(ownerGrants(db)).toEqual([]);
    expect(secretsForChat(db, src, dm, true).env).toEqual({});
    expect(revokeGrant(db, g.id, null, { id: OWNER, name: "Owner" })).toMatchObject({ already: { id: g.id } });
  });

  test("a card: \"every chat\" buttons for the owner's own request, none for an operator's; an all- answer to one is not honoured", () => {
    const { db, src, dm, group } = world();
    const mine = requestSecret(db, src, { chatId: dm, profile: "github", ttl: "1d", reason: "issues" });
    if (!("approvalId" in mine)) throw new Error(mine.error);
    const theirs = requestSecret(db, src, { chatId: group, profile: "github", ttl: "1d", reason: "issues", requestedBy: 4242 });
    if (!("approvalId" in theirs)) throw new Error(theirs.error);
    const options = (id: number) => (db.$client.query("select options from approvals where id = ?").get(id) as { options: string }).options;
    expect(JSON.parse(options(mine.approvalId)).map((o: { id: string }) => o.id)).toEqual(["4h", "1d", "3d", "all-4h", "all-1d", "all-3d", "all-forever", "deny"]);
    expect(JSON.parse(options(theirs.approvalId)).map((o: { id: string }) => o.id)).toEqual(["4h", "1d", "3d", "deny"]);

    answerApproval(db, mine.approvalId, 6, { id: OWNER, name: "Owner" }); // all-forever
    // Forged: an operator's card answered with an option it never had.
    db.$client.query("update approvals set status = 'answered', answer = 'all-forever', answered_at = ? where id = ?").run(new Date().toISOString(), theirs.approvalId);
    syncGrants(db);
    const grants = db.select().from(secretGrants).all();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ chatId: null, approvalId: mine.approvalId, expiresAt: null, profile: "github" });
  });

  test("a granted profile whose values cannot be opened says so, and gives nothing", () => {
    const { db, src, dm } = world();
    consoleGrant(db, "github", "forever");
    const r = secretsForChat(db, { ...src, key: OTHER_KEY }, dm, true);
    expect(r.env).toEqual({});
    expect(r.warning).toMatch(/granted but unavailable: github \(its values do not open/);
  });
});

describe("notes", () => {
  test("set by her or the owner, any part replaced; never a secret value, never for no profile", () => {
    const db = memDb();
    const src = source();
    putProfile(db, src, "github", { GH_TOKEN: GH });
    expect(setNote(db, src, "github", { summary: "GitHub for example-org", details: "Scope: repo.\nOrg id 1234." }, "assistant in DM")).toMatchObject({ note: { summary: "GitHub for example-org", updatedBy: "assistant in DM" } });
    expect(setNote(db, src, "github", { details: "Scope: repo, read:org." }, "console")).toMatchObject({ note: { summary: "GitHub for example-org", details: "Scope: repo, read:org." } });
    expect(setNote(db, src, "modal", { summary: "Modal, the file's profile" }, "console")).toMatchObject({ note: { name: "modal" } });

    expect(setNote(db, src, "github", { details: `the token is ${GH}` }, "assistant in DM")).toEqual({ error: expect.stringMatching(/holds the value of the secret profile "github"/) });
    expect(setNote(db, src, "github", { summary: `uses ${MODAL}` }, "assistant in DM")).toEqual({ error: expect.stringMatching(/"modal"/) });
    expect(setNote(db, src, "github", { summary: "two\nlines" }, "console")).toEqual({ error: "The summary is one line." });
    expect(setNote(db, src, "github", { summary: "x".repeat(201) }, "console")).toEqual({ error: expect.stringMatching(/at most 200/) });
    expect(setNote(db, src, "nope", { summary: "x" }, "console")).toEqual({ error: expect.stringMatching(/no secret profile/) });
    expect(getNote(db, "github")!.details).toBe("Scope: repo, read:org.");
  });
});

// ---- the console's Secrets page -----------------------------------------------------------------------------

const PORT = 8787;
const HOST = `127.0.0.1:${PORT}`;
const BASE = `http://${HOST}`;
const SECRET = "example-csrf-secret";
const LOGIN = "owner@example.com";
const CSRF = csrfToken(SECRET, `login:${LOGIN}`);

function deps(db: Db, src: SecretSource): ConsoleDeps {
  const c = { listen: HOST };
  return { db, timeZone: "UTC", dataDir: "/nonexistent", allowedHosts: allowedHosts(c, PORT), allowedOrigins: allowedOrigins(c, PORT), csrfSecret: SECRET, users: new Set([LOGIN]), ownerId: OWNER, secrets: src };
}
async function get(db: Db, src: SecretSource, path: string): Promise<string> {
  const res = await handleConsole(deps(db, src), new Request(`${BASE}${path}`, { headers: { [LOGIN_HEADER]: LOGIN } }));
  expect(res.status).toBe(200);
  return res.text();
}
/** POST a Secrets write, follow its 303, and give the page it leads to. */
async function write(db: Db, src: SecretSource, path: string, fields: Record<string, string>): Promise<string> {
  const body = new URLSearchParams({ ...fields, csrf: CSRF });
  const res = await handleConsole(deps(db, src), new Request(`${BASE}${path}`, { method: "POST", headers: { [LOGIN_HEADER]: LOGIN, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body }));
  expect(res.status).toBe(303);
  const loc = res.headers.get("location")!;
  expect(loc).toMatch(/^\/settings\/secrets\?r=[\w-]+(#.*)?$/);
  return get(db, src, loc.replace(/#.*$/, ""));
}
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("the Secrets page", () => {
  test("add with a grant, replace, note, revoke, delete: names shown, a value never", async () => {
    const db = memDb();
    ownerChatId(db);
    const src = source();
    let html = await write(db, src, "/settings/secrets/put", { name: "github", nn_0: "GH_TOKEN", na_0: "GitHub token", nv_0: GH, grant: "forever" });
    expect(text(html)).toContain("Added github (GH_TOKEN) and granted it to every chat until you revoke it");
    expect(html).not.toContain(GH);
    expect(ownerGrants(db).map((g) => g.profile)).toEqual(["github"]);
    // What each is, kept in the note, labels its field.
    expect(getNote(db, "github")!.details).toBe("Variables:\n- GH_TOKEN: GitHub token");
    expect(await get(db, src, "/settings/secrets?edit=github")).toContain('name="a_GH_TOKEN" class="kvd" maxlength="120" value="GitHub token"');

    html = await write(db, src, "/settings/secrets/put", { name: "github", nn_0: "GH_TOKEN", nv_0: GH2 });
    expect(text(html)).toContain("A profile github is kept here already");
    html = await write(db, src, "/settings/secrets/put", { name: "github", v_GH_TOKEN: GH2, replace: "1" });
    expect(text(html)).toContain("github: set GH_TOKEN.");
    expect(secretsForChat(db, src, ownerChatId(db), true).env).toEqual({ GH_TOKEN: GH2 });
    expect(html).not.toContain(GH2);
    // A new variable beside it; an empty field keeps its value.
    html = await write(db, src, "/settings/secrets/put", { name: "github", v_GH_TOKEN: "", nn_0: "GH_ORG", na_0: "the org", nv_0: "example-org-0001", replace: "1" });
    expect(secretsForChat(db, src, ownerChatId(db), true).env).toEqual({ GH_TOKEN: GH2, GH_ORG: "example-org-0001" });
    expect(getNote(db, "github")!.details).toBe("Variables:\n- GH_TOKEN: GitHub token\n- GH_ORG: the org");
    // Remove takes it out of the values and the note; nothing filled in is nothing changed.
    html = await write(db, src, "/settings/secrets/put", { name: "github", del_GH_ORG: "1", replace: "1" });
    expect(text(html)).toContain("github: removed GH_ORG.");
    expect(secretsForChat(db, src, ownerChatId(db), true).env).toEqual({ GH_TOKEN: GH2 });
    expect(getNote(db, "github")!.details).toBe("Variables:\n- GH_TOKEN: GitHub token");
    html = await write(db, src, "/settings/secrets/put", { name: "github", del_GH_TOKEN: "1", replace: "1" });
    expect(text(html)).toContain("would leave github with no variables");
    html = await write(db, src, "/settings/secrets/put", { name: "github", nn_0: "GH_TOKEN", nv_0: "x-0000", replace: "1" });
    expect(text(html)).toContain("GH_TOKEN is already a variable of github");
    expect(secretsForChat(db, src, ownerChatId(db), true).env).toEqual({ GH_TOKEN: GH2 });

    html = await write(db, src, "/settings/secrets/note", { name: "github", summary: "GitHub for example-org", details: "Org id 1234." });
    expect(text(html)).toContain("Saved the note of github");
    expect(text(html)).toContain("GitHub for example-org");
    html = await write(db, src, "/settings/secrets/note", { name: "github", summary: `leak ${GH2}`, details: "" });
    expect(text(html)).toContain('holds the value of the secret profile "github"');
    expect(html).not.toContain(GH2);

    const g = ownerGrants(db)[0]!;
    html = await write(db, src, "/settings/secrets/revoke", { grant: String(g.id) });
    expect(text(html)).toContain("Revoked github for every chat");
    expect(ownerGrants(db)).toEqual([]);

    consoleGrant(db, "github", "forever");
    html = await write(db, src, "/settings/secrets/delete", { name: "github" });
    expect(text(html)).toContain("Deleted github and revoked its grant.");
    expect(getNote(db, "github")).toBeUndefined();
    expect(redactionFor(db, src).redact(`${GH} ${GH2}`)).toBe("[REDACTED:github] [REDACTED:github]");
    // A profile added later under the name inherits no grant.
    await write(db, src, "/settings/secrets/put", { name: "github", nn_0: "GH_TOKEN", nv_0: GH });
    expect(secretsForChat(db, src, ownerChatId(db), true).env).toEqual({});
  });

  test("a long note in CJK is not refused for its size", async () => {
    const db = memDb();
    const src = source();
    const html = await write(db, src, "/settings/secrets/note", { name: "modal", summary: "部署用", details: "說明".repeat(3999) });
    expect(text(html)).toContain("Saved the note of modal");
    expect(getNote(db, "modal")!.details.length).toBe(7998);
  });

  test("a refused add keeps its name and grant choice, never its values; without a key nothing can be added", async () => {
    const db = memDb();
    const src = source();
    let html = await write(db, src, "/settings/secrets/put", { name: "github", nv_0: GH, grant: "3d" });
    expect(text(html)).toContain("New variable 1 has a value but no name. Nothing was saved; type the values again.");
    expect(html).toContain('value="github"');
    expect(html).not.toContain(GH);
    const nokey = { ...src, key: null };
    html = await get(db, nokey, "/settings/secrets");
    expect(text(html)).toContain("Profiles cannot be kept here: SHUVI_SECRETS_KEY is not set.");
    html = await write(db, nokey, "/settings/secrets/put", { name: "github", nn_0: "GH_TOKEN", nv_0: GH });
    expect(text(html)).toContain("Secrets cannot be kept here: SHUVI_SECRETS_KEY is not set.");
    expect(readFileSync(src.file, "utf8")).not.toContain(GH);
  });

  test("grant a file profile to every chat; a write without the page's token is refused", async () => {
    const db = memDb();
    const src = source();
    const html = await write(db, src, "/settings/secrets/grant", { profile: "modal", ttl: "1d" });
    expect(text(html)).toContain("Granted modal to every chat for 1 day");
    expect(ownerGrants(db)[0]).toMatchObject({ profile: "modal", chatId: null });
    const res = await handleConsole(deps(db, src), new Request(`${BASE}/settings/secrets/delete`, { method: "POST", headers: { [LOGIN_HEADER]: LOGIN, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ name: "modal" }) }));
    expect(res.status).toBe(403);
  });
});

const varsOf = (db: Db, name: string) => storedProfiles(db).find((p) => p.name === name)?.vars.toSorted();
/** The page's markup outside its `<template>`s (the row console.js clones is not a row of the form). */
const outsideTemplates = (html: string) => html.replace(/<template[\s\S]*?<\/template>/g, "");

describe("the key/value table (kv-table.ts)", () => {
  test("Replace values: each key with its description and an empty value box, one new row and its template, nothing pre-rendered", async () => {
    const db = memDb();
    const src = source();
    putProfile(db, src, "github", { GH_TOKEN: GH, GH_ORG: "example-org-0001" });
    setNote(db, src, "github", { details: "Variables:\n- GH_TOKEN: GitHub token" }, "console");
    const html = await get(db, src, "/settings/secrets?edit=github");
    expect(html).not.toContain(GH);
    expect(html).not.toContain("example-org-0001");
    expect(html).toContain('<span class="kvk mono">GH_TOKEN</span><input type="text" name="a_GH_TOKEN" class="kvd" maxlength="120" value="GitHub token"');
    expect(html).toContain('name="a_GH_ORG" class="kvd" maxlength="120" value=""');
    expect(html).toContain('<input type="text" name="v_GH_TOKEN" class="kvv mono" placeholder="unchanged"');
    expect(html).toContain('<input type="checkbox" name="del_GH_ORG" value="1"');
    // One empty new row; more come from the template, "+ Add a row" (console.js).
    const form = /<input type="hidden" name="replace" value="1">[^]*?<\/form>/.exec(html)![0];
    expect(outsideTemplates(form).match(/name="n[nav]_[^"]*"/g)).toEqual(['name="nn_0"', 'name="na_0"', 'name="nv_0"']);
    expect(html).toContain('<template class="kvt"><div class="kvr kvnew"><input type="text" name="nn___i__"');
    expect(html).toContain('<button type="button" class="kvadd">+ Add a row</button>');
    // A secret's value is never drawn, so it has no eye; and nothing of the old per-field cards.
    expect(html).not.toContain("kveye");
    expect(html).not.toMatch(/vrow|vmore|More variables/);
    // The add form: a profile name and a summary, then the same table, empty.
    const page = await get(db, src, "/settings/secrets");
    expect(page).toMatch(/<form class="sform kvform" method="post" action="\/settings\/secrets\/put"[^>]*>[^]*?name="summary"[^]*?<div class="kvtab" data-next="1">/);
    expect(page).not.toMatch(/placeholder="[^"]*(address|POSTCODE|ghp_|GH_TOKEN)/);
  });

  test("any number of new rows, whatever their numbers, in order; over 100 at once refused; a bad row named by its place, no value echoed", async () => {
    const db = memDb();
    const src = source();
    let html = await write(db, src, "/settings/secrets/put", { name: "many", nn_0: "A_ONE", nv_0: "v-0001", nn_7: "B_TWO", nv_7: "v-0002", nn_42: "C_THREE", na_42: "the third", nv_42: "v-0003", nn_250: "D_FOUR", nv_250: "v-0004" });
    expect(text(html)).toContain("Added many (A_ONE, B_TWO, C_THREE, D_FOUR)");
    expect(varsOf(db, "many")).toEqual(["A_ONE", "B_TWO", "C_THREE", "D_FOUR"]);
    expect(getNote(db, "many")!.details).toBe("Variables:\n- C_THREE: the third");
    // Added to an existing profile the same way, beside its own keys.
    html = await write(db, src, "/settings/secrets/put", { name: "many", replace: "1", nn_3: "E_FIVE", nv_3: "v-0005", nn_9: "F_SIX", nv_9: "v-0006" });
    expect(text(html)).toContain("many: set E_FIVE, F_SIX.");
    expect(varsOf(db, "many")).toEqual(["A_ONE", "B_TWO", "C_THREE", "D_FOUR", "E_FIVE", "F_SIX"]);
    // The second row of the table, whatever its number, is "New variable 2".
    html = await write(db, src, "/settings/secrets/put", { name: "bad", nn_0: "OK", nv_0: "v-0007", nv_5: GH });
    expect(text(html)).toContain("New variable 2 has a value but no name.");
    expect(html).not.toContain(GH);
    const lots: Record<string, string> = { name: "lots" };
    for (let i = 0; i <= 100; i++) Object.assign(lots, { [`nn_${i}`]: `K${i}`, [`nv_${i}`]: `${GH}-${i}` });
    html = await write(db, src, "/settings/secrets/put", lots);
    expect(text(html)).toContain("At most 100 new rows at once.");
    expect(html).not.toContain(GH);
    expect(varsOf(db, "lots")).toBeUndefined();
    lots.nn_100 = "";
    lots.nv_100 = "";
    expect(text(await write(db, src, "/settings/secrets/put", lots))).toContain("At most 100 new rows at once.");
    for (const k of ["nn_100", "nv_100"]) delete lots[k];
    await write(db, src, "/settings/secrets/put", lots);
    expect(varsOf(db, "lots")!.length).toBe(100);
  });

  test("descriptions: a changed one and an emptied one go to the note; one holding a value is refused, the values saved without it, nothing echoed", async () => {
    const db = memDb();
    const src = source();
    await write(db, src, "/settings/secrets/put", { name: "github", nn_0: "GH_TOKEN", na_0: "GitHub token", nv_0: GH, nn_1: "GH_ORG", na_1: "the org", nv_1: "example-org-0001" });
    expect(getNote(db, "github")!.details).toBe("Variables:\n- GH_TOKEN: GitHub token\n- GH_ORG: the org");
    let html = await write(db, src, "/settings/secrets/put", { name: "github", replace: "1", a_GH_TOKEN: "token for example-org", v_GH_TOKEN: "", a_GH_ORG: "", v_GH_ORG: "" });
    expect(text(html)).toContain("Nothing to change in the values of github; the descriptions are saved.");
    expect(getNote(db, "github")!.details).toBe("Variables:\n- GH_TOKEN: token for example-org");
    // A form without the description fields leaves them as they are.
    await write(db, src, "/settings/secrets/put", { name: "github", replace: "1", v_GH_ORG: "example-org-0002" });
    expect(getNote(db, "github")!.details).toBe("Variables:\n- GH_TOKEN: token for example-org");
    html = await write(db, src, "/settings/secrets/put", { name: "github", replace: "1", v_GH_TOKEN: GH2, a_GH_TOKEN: `rotated to ${GH2}` });
    expect(text(html)).toContain("github: set GH_TOKEN.");
    expect(text(html)).toContain("The note was not changed");
    expect(html).not.toContain(GH2);
    expect(getNote(db, "github")!.details).toBe("Variables:\n- GH_TOKEN: token for example-org");
    expect(secretsForChat(db, src, ownerChatId(db), true).env).toEqual({});
    consoleGrant(db, "github", "forever");
    expect(secretsForChat(db, src, ownerChatId(db), true).env).toEqual({ GH_TOKEN: GH2, GH_ORG: "example-org-0002" });
  });

  test("a new profile's summary goes into its note; one holding a value is not kept and not shown", async () => {
    const db = memDb();
    const src = source();
    putProfile(db, src, "github", { GH_TOKEN: GH });
    let html = await write(db, src, "/settings/secrets/put", { name: "example", summary: "An example API, in one line", nn_0: "KEY", nv_0: "v-0001" });
    expect(text(html)).toContain("Added example (KEY).");
    expect(getNote(db, "example")!.summary).toBe("An example API, in one line");
    expect(text(html)).toContain("An example API, in one line");
    html = await write(db, src, "/settings/secrets/put", { name: "other", summary: `leaks ${GH}`, nn_0: "KEY", nv_0: "v-0002" });
    expect(text(html)).toContain("Added other (KEY).");
    expect(text(html)).toContain("The summary was not kept");
    expect(html).not.toContain(GH);
    expect(getNote(db, "other")?.summary ?? "").toBe("");
  });

  test("the ⋯ menu: Replace values and the grant beside the row, the rest in its menu as the same links; Delete still asks first; the writes still need the page's token", async () => {
    const db = memDb();
    const src = source();
    putProfile(db, src, "github", { GH_TOKEN: GH });
    const html = await get(db, src, "/settings/secrets");
    const row = /<div class="srow" id="p-github">[^]*?<div class="sact">([^]*?)<\/div>\n/.exec(html)![1]!;
    const [primary, menu] = row.split('<details class="rmenu">');
    expect(primary).toContain('href="/settings/secrets?edit=github#p-github"');
    expect(primary).toContain('action="/settings/secrets/grant"');
    expect(primary).not.toMatch(/Delete|Make it personal info|note/);
    expect(menu).toContain('<summary class="btn" title="More" aria-label="More for github">⋯</summary>');
    expect(menu).toContain('<a class="mi" href="/settings/secrets?note=github#p-github"');
    expect(menu).toMatch(/<a class="mi" href="\/settings\/secrets\?convert=github&(amp;)?to=info#p-github"[^>]*>Make it personal info<\/a>/);
    expect(menu).toMatch(/<a class="mi danger" href="\/settings\/secrets\?delete=github#p-github"[^>]*>Delete…<\/a>/);
    // The file's profile: the grant and a menu with only its note.
    const file = /<div class="srow" id="p-modal">[^]*?<div class="sact">([^]*?)<\/div>\n/.exec(html)![1]!;
    expect(file).not.toContain("edit=modal");
    expect(file.match(/class="mi[^"]*"/g)).toEqual(['class="mi"']);
    // Following the menu's links: the confirmations as before.
    expect(text(await get(db, src, "/settings/secrets?delete=github"))).toContain("Delete github?");
    expect(text(await get(db, src, "/settings/secrets?convert=github&to=info"))).toContain("Make github personal info?");
    for (const [verb, body] of [
      ["delete", { name: "github" }],
      ["convert", { name: "github", to: "info" }],
      ["note", { name: "github", summary: "x" }],
    ] as const) {
      const res = await handleConsole(deps(db, src), new Request(`${BASE}/settings/secrets/${verb}`, { method: "POST", headers: { [LOGIN_HEADER]: LOGIN, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) }));
      expect(res.status).toBe(403);
    }
    expect(varsOf(db, "github")).toEqual(["GH_TOKEN"]);
    expect(getNote(db, "github")).toBeUndefined();
  });
});
