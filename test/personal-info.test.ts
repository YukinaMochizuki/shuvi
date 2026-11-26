import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textOf, type ToolDef, type ToolResult } from "agent-runtime";
import type { TurnState } from "../src/agent/turn.ts";
import { consoleGrant, grantsFor, PROVIDE_KIND, requestSecret, secretsForChat } from "../src/capabilities/computer/secrets.ts";
import { info, infoSection, INFO_TOOLS, type InfoConfig } from "../src/capabilities/info/index.ts";
import { INFO_SAVE, requestInfo } from "../src/capabilities/info/request.ts";
import type { TurnContext } from "../src/capabilities/types.ts";
import { CAPABILITIES } from "../src/capabilities/index.ts";
import { allowedHosts, allowedOrigins } from "../src/console/index.ts";
import { MASK } from "../src/console/info.ts";
import { IMMEDIATE } from "../src/store/turns.ts";
import { csrfToken, handleConsole, LOGIN_HEADER, type ConsoleDeps } from "../src/console/server.ts";
import { cardKeyboard, getApproval } from "../src/control/approvals.ts";
import { deleteInfo, getInfo, infoHistory, infoNames, INFO_VERSIONS_KEPT, makeInfo, makeSecret, restoreInfo, writeInfo } from "../src/secrets/info.ts";
import { getNote, noteVarAbouts, setNote } from "../src/secrets/notes.ts";
import { knownFile } from "../src/secrets/redaction.ts";
import { allProfiles, LiveRedaction, profileNames, putProfile, redactionFor, storedProfiles, type SecretSource } from "../src/secrets/source.ts";
import { open, seal } from "../src/secrets/vault.ts";
import { openDb, type Db } from "../src/store/db.ts";
import { ensureChat, type Chat } from "../src/store/events.ts";
import { infoVersions, secretNotes, secretProfiles } from "../src/store/schema.ts";
import { memDb, OWNER, ownerChatId } from "./helpers.ts";

// Made-up data only: the repository is public.
const KEY = new Uint8Array(32).fill(9);
const TOKEN = "ghp_example_token_0000000001";
const ADDRESS = { POSTCODE: "100-0009", CITY: "Example City", STREET: "1-2-3 Sample Street" };

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function source(fileYaml = "arx:\n  KEY: ak-example-file-0000\n", key: Uint8Array | null = KEY): SecretSource {
  const d = mkdtempSync(join(tmpdir(), "shuvi-info-"));
  dirs.push(d);
  const file = join(d, "secrets.yaml");
  writeFileSync(file, fileYaml);
  chmodSync(file, 0o600);
  return { file, key };
}

const known = (src: SecretSource): Record<string, string | string[]> => (existsSync(knownFile(src.file)) ? JSON.parse(readFileSync(knownFile(src.file), "utf8")) : {});
const must = <T extends object>(r: T | { error: string }): T => {
  if ("error" in r) throw new Error(r.error);
  return r;
};
/** Make the known file unwritable and unreadable (a directory stands where it would be). */
function breakKnown(src: SecretSource): void {
  rmSync(knownFile(src.file), { force: true });
  mkdirSync(knownFile(src.file));
}

describe("sealing", () => {
  test("personal info is sealed with its kind: a secret's sealed row does not open as info, nor the reverse", () => {
    const s = seal(KEY, "addr", ADDRESS, "info");
    expect(open(KEY, "addr", s, "info")).toEqual(ADDRESS);
    expect(() => open(KEY, "addr", s)).toThrow();
    expect(() => open(KEY, "addr", seal(KEY, "addr", ADDRESS), "info")).toThrow();
  });
});

describe("the two kinds share storage, never behaviour", () => {
  test("a name is unique within its kind; every reader of secrets leaves info out; info values are never redacted or known", () => {
    const db = memDb();
    const src = source();
    must(putProfile(db, src, "addr", { GH_TOKEN: TOKEN }));
    must(writeInfo(db, src, "addr", { set: ADDRESS }, "console: owner"));
    must(writeInfo(db, src, "phone", { set: { MOBILE: "+00 900 000 001" } }, "console: owner"));
    const all = allProfiles(db, src);
    expect("profiles" in all && all.profiles).toEqual({ arx: { KEY: "ak-example-file-0000" }, addr: { GH_TOKEN: TOKEN } });
    expect(profileNames(db, src)).toEqual(["addr", "arx"]);
    expect(storedProfiles(db).map((p) => p.name)).toEqual(["addr"]);
    expect(infoNames(db)).toEqual(["addr", "phone"]);
    const red = redactionFor(db, src);
    expect(red.redact(`${TOKEN} ${ADDRESS.STREET}`)).toBe(`[REDACTED:addr] ${ADDRESS.STREET}`);
    expect(Object.keys(known(src))).not.toContain(ADDRESS.STREET);
    expect(new LiveRedaction(db, src).redact(ADDRESS.CITY)).toBe(ADDRESS.CITY);
    // A grant of the name is the secret's: what a command gets is the secret's values only.
    const dm = ownerChatId(db);
    consoleGrant(db, "addr", "1d");
    expect(secretsForChat(db, src, dm, true).env).toEqual({ GH_TOKEN: TOKEN });
    expect(secretsForChat(db, src, dm, true).env).not.toHaveProperty("POSTCODE");
    // Notes are kept apart by kind.
    must(setNote(db, src, "addr", { summary: "the token" }, "console"));
    must(setNote(db, src, "addr", { summary: "home address" }, "console", Date.now(), "info"));
    expect(getNote(db, "addr")!.summary).toBe("the token");
    expect(getNote(db, "addr", "info")!.summary).toBe("home address");
    expect(setNote(db, src, "nope", { summary: "x" }, "console", Date.now(), "info")).toEqual({ error: 'There is no personal info "nope".' });
  });

  test("request_secret does not see personal info", () => {
    const db = memDb();
    const src = source();
    must(writeInfo(db, src, "addr", { set: ADDRESS }, "console"));
    const r = requestSecret(db, src, { chatId: ownerChatId(db), profile: "addr", ttl: "1d", reason: "x" });
    expect("error" in r && r.error).toMatch(/there is no secret profile "addr"/);
  });
});

describe("writing personal info", () => {
  test("each change records the values before it, who, and which fields; only the newest 20 are kept", () => {
    const db = memDb();
    const src = source();
    expect(must(writeInfo(db, src, "addr", { set: ADDRESS }, "console: owner", 1000))).toEqual({ created: true, changed: ["POSTCODE", "CITY", "STREET"], fields: ["POSTCODE", "CITY", "STREET"] });
    expect(must(writeInfo(db, src, "addr", { set: { STREET: "4-5-6 Sample Avenue", BUILDING: "Demo Tower 1205" }, remove: ["CITY"] }, "assistant in DM", 2000))).toMatchObject({ created: false, changed: ["STREET", "BUILDING", "CITY"] });
    expect(getInfo(db, src, "addr")!.values).toEqual({ POSTCODE: "100-0009", STREET: "4-5-6 Sample Avenue", BUILDING: "Demo Tower 1205" });
    // Nothing different: nothing recorded.
    expect(must(writeInfo(db, src, "addr", { set: { POSTCODE: "100-0009" } }, "x", 3000)).changed).toEqual([]);
    const h = infoHistory(db, src, "addr");
    expect(h.map((v) => [v.by, v.changed, v.before])).toEqual([
      ["assistant in DM", ["STREET", "BUILDING", "CITY"], ADDRESS],
      ["console: owner", ["POSTCODE", "CITY", "STREET"], {}],
    ]);
    // Versions are sealed: no value in the clear.
    expect(JSON.stringify(db.select().from(infoVersions).all())).not.toContain("Sample Street");
    for (let i = 0; i < 25; i++) must(writeInfo(db, src, "addr", { set: { POSTCODE: `100-${String(1000 + i)}` } }, "console", 4000 + i));
    expect(infoHistory(db, src, "addr")).toHaveLength(INFO_VERSIONS_KEPT);
    expect(infoHistory(db, src, "addr")[0]!.before!.POSTCODE).toBe("100-1023");
  });

  test("refused, nothing changed: a secret's value (whole or within), no key, a bad name or field, no fields left", () => {
    const db = memDb();
    const src = source();
    must(putProfile(db, src, "github", { GH_TOKEN: TOKEN }));
    expect(writeInfo(db, src, "addr", { set: { NOTE: `token ${TOKEN} here` } }, "x")).toEqual({ error: expect.stringMatching(/holds the value of the secret profile "github"/) });
    expect(writeInfo(db, src, "addr", { set: { K: "ak-example-file-0000" } }, "x")).toEqual({ error: expect.stringMatching(/"arx"/) });
    expect(writeInfo(db, source(undefined, null), "addr", { set: ADDRESS }, "x")).toEqual({ error: expect.stringMatching(/SHUVI_SECRETS_KEY is not set/) });
    expect(writeInfo(db, src, "a.b", { set: ADDRESS }, "x")).toEqual({ error: expect.stringMatching(/not a name/) });
    expect(writeInfo(db, src, "addr", { set: { "1X": "v" } }, "x")).toEqual({ error: expect.stringMatching(/not a field name/) });
    expect(infoNames(db)).toEqual([]);
    must(writeInfo(db, src, "addr", { set: ADDRESS }, "x"));
    expect(writeInfo(db, src, "addr", { set: {}, remove: Object.keys(ADDRESS) }, "x")).toEqual({ error: expect.stringMatching(/no fields/) });
  });

  test("restore puts back the values from before a change, recorded as a change itself; the creation cannot be restored", () => {
    const db = memDb();
    const src = source();
    must(writeInfo(db, src, "addr", { set: ADDRESS }, "console", 1000));
    must(writeInfo(db, src, "addr", { set: { STREET: "4-5-6 Sample Avenue", EXTRA: "x" } }, "assistant in DM", 2000));
    const [change, made] = infoHistory(db, src, "addr");
    expect(restoreInfo(db, src, "addr", made!.id, "console (restored)")).toEqual({ error: expect.stringMatching(/had nothing before/) });
    expect(must(restoreInfo(db, src, "addr", change!.id, "console (restored)", 3000)).changed.sort()).toEqual(["EXTRA", "STREET"]);
    expect(getInfo(db, src, "addr")!.values).toEqual(ADDRESS);
    expect(infoHistory(db, src, "addr")[0]!.by).toBe("console (restored)");
    expect(deleteInfo(db, "addr")).toEqual({ deleted: true });
    expect(db.select().from(infoVersions).all()).toEqual([]);
  });
});

describe("changing kind", () => {
  test("a secret made personal info: its values leave the known file, but for one another secret (file or store) still holds", () => {
    const db = memDb();
    const src = source("arx:\n  KEY: shared-with-file-0001\n");
    must(putProfile(db, src, "home", { STREET: "1-2-3 Sample Street", PIN: "shared-with-file-0001", ALSO: "shared-with-store-01" }));
    must(putProfile(db, src, "other", { X: "shared-with-store-01" }));
    must(setNote(db, src, "home", { summary: "home" }, "console"));
    redactionFor(db, src); // every value is remembered
    expect(known(src)["1-2-3 Sample Street"]).toBe("home");
    const r = must(makeInfo(db, src, "home", "console: owner"));
    expect(r).toEqual({ fields: ["STREET", "PIN", "ALSO"], kept: 2 });
    expect(known(src)).not.toHaveProperty("1-2-3 Sample Street");
    expect(redactionFor(db, src).redact("1-2-3 Sample Street shared-with-file-0001 shared-with-store-01")).toBe("1-2-3 Sample Street [REDACTED:arx] [REDACTED:other]");
    expect(storedProfiles(db).map((p) => p.name)).toEqual(["other"]);
    expect(getInfo(db, src, "home")!.values!.STREET).toBe("1-2-3 Sample Street");
    expect(getNote(db, "home")).toBeUndefined();
    expect(getNote(db, "home", "info")!.summary).toBe("home");
    expect(infoHistory(db, src, "home")[0]!.by).toBe("console: owner (made it personal info)");
  });

  test("refused, nothing changed: the known file cannot be written, the name taken, a secret that cannot be opened", () => {
    const db = memDb();
    const src = source();
    must(putProfile(db, src, "home", { STREET: "1-2-3 Sample Street" }));
    redactionFor(db, src);
    chmodSync(knownFile(src.file), 0o644); // a known file others may read is not used
    expect(makeInfo(db, src, "home", "x")).toEqual({ error: expect.stringMatching(/cannot be written/) });
    chmodSync(knownFile(src.file), 0o600);
    must(writeInfo(db, src, "home", { set: { A: "a-value" } }, "x"));
    expect(makeInfo(db, src, "home", "x")).toEqual({ error: expect.stringMatching(/personal info named home already/) });
    deleteInfo(db, "home");
    db.insert(secretProfiles).values({ name: "lost", varNames: ["A"], sealed: seal(new Uint8Array(32).fill(1), "lost", { A: "x" }) }).run();
    expect(makeInfo(db, src, "home", "x")).toEqual({ error: expect.stringMatching(/cannot be opened now \(lost\)/) });
    expect(storedProfiles(db).map((p) => p.name)).toEqual(["home", "lost"]);
  });

  test("personal info made a secret: its values join the known file first, its history goes; refused when they cannot, or the name is a secret's", () => {
    const db = memDb();
    const src = source();
    must(writeInfo(db, src, "phone", { set: { MOBILE: "+00 900 000 002" } }, "x"));
    must(writeInfo(db, src, "arx", { set: { A: "a-value-01" } }, "x"));
    expect(makeSecret(db, src, "arx")).toEqual({ error: expect.stringMatching(/secrets file has a secret named arx/) });
    breakKnown(src);
    expect(makeSecret(db, src, "phone")).toEqual({ error: expect.stringMatching(/cannot be written/) });
    expect(infoNames(db)).toContain("phone");
    rmSync(knownFile(src.file), { recursive: true });
    expect(must(makeSecret(db, src, "phone"))).toEqual({ fields: ["MOBILE"] });
    expect(known(src)["+00 900 000 002"]).toBe("phone");
    expect(redactionFor(db, src).redact("+00 900 000 002")).toBe("[REDACTED:phone]");
    expect(db.select().from(infoVersions).all().length).toBe(1); // arx's only
    must(writeInfo(db, src, "phone", { set: { MOBILE: "+00 900 000 003" } }, "x"));
    expect(makeSecret(db, src, "phone")).toEqual({ error: expect.stringMatching(/secret named phone already/) });
  });
});

describe("review fixes", () => {
  test("B1: the known file keeps every profile that ever held a value: a secret made personal info never unredacts another's past value", () => {
    const db = memDb();
    const src = source();
    must(putProfile(db, src, "A", { PW: "reused-password-1" }));
    must(putProfile(db, src, "B", { PW: "reused-password-1" }));
    redactionFor(db, src);
    must(putProfile(db, src, "A", { PW: "fresh-password-22" }));
    redactionFor(db, src);
    expect(known(src)["reused-password-1"]).toEqual(["A", "B"]);
    expect(must(makeInfo(db, src, "B", "console")).kept).toBe(1);
    // A held it once: it stays redacted, as A's.
    expect(known(src)["reused-password-1"]).toBe("A");
    expect(redactionFor(db, src).redact("reused-password-1")).toBe("[REDACTED:A]");
    // A value only the converted profile ever held leaves the file.
    must(putProfile(db, src, "C", { PW: "only-c-value-0001" }));
    redactionFor(db, src);
    must(makeInfo(db, src, "C", "console"));
    expect(known(src)).not.toHaveProperty("only-c-value-0001");
  });

  test("B1: a known file in the old form (value \u2192 one profile) is read, and written back in it when one holds a value", () => {
    const db = memDb();
    const src = source();
    writeFileSync(knownFile(src.file), JSON.stringify({ "old-rotated-value-1": "gone" }), { mode: 0o600 });
    chmodSync(knownFile(src.file), 0o600);
    expect(redactionFor(db, src).redact("old-rotated-value-1")).toBe("[REDACTED:gone]");
    must(putProfile(db, src, "A", { PW: "old-rotated-value-1", X: "single-holder-01" }));
    redactionFor(db, src);
    expect(known(src)["old-rotated-value-1"]).toEqual(["gone", "A"]);
    expect(known(src)["single-holder-01"]).toBe("A");
    // Labelled as the secret holding it now.
    expect(redactionFor(db, src).redact("old-rotated-value-1")).toBe("[REDACTED:A]");
  });

  test("S1: made a secret, it starts with no grant, even one a secrets-file profile of its name left", async () => {
    const db = memDb();
    const src = source("phone:\n  MOBILE: file-mobile-0001\n");
    consoleGrant(db, "phone", "forever");
    writeFileSync(src.file, "arx:\n  KEY: ak-example-file-0000\n"); // the file drops it; its grant outlives it
    must(writeInfo(db, src, "phone", { set: { MOBILE: "+00 900 000 007" } }, "console"));
    expect(grantsFor(db, ownerChatId(db), true).map((g) => g.profile)).toEqual(["phone"]);
    const html = await post(db, src, "/settings/secrets/convert", { name: "phone", to: "secret" });
    expect(text(html)).toContain("Revoked a grant left under its name.");
    expect(grantsFor(db, ownerChatId(db), true)).toEqual([]);
    expect(secretsForChat(db, src, ownerChatId(db), true).env).toEqual({});
  });

  test("S2: made a secret, refused (nothing changed) while its note holds one of its values or another secret's", () => {
    const db = memDb();
    const src = source();
    must(writeInfo(db, src, "card", { set: { NO: "4000-0000-0000-0001" } }, "console"));
    must(setNote(db, src, "card", { details: "The number is 4000-0000-0000-0001." }, "console", Date.now(), "info"));
    expect(makeSecret(db, src, "card")).toEqual({ error: expect.stringMatching(/note's details holds the value of NO.*Edit the note first/) });
    expect(infoNames(db)).toEqual(["card"]);
    expect(known(src)).not.toHaveProperty("4000-0000-0000-0001");
    must(setNote(db, src, "card", { details: "A card." }, "console", Date.now(), "info"));
    // A note holding another secret's value (written before that secret existed) is refused too.
    db.update(secretNotes).set({ summary: "ak-example-file-0000 card" }).run();
    expect(makeSecret(db, src, "card")).toEqual({ error: expect.stringMatching(/summary holds the value of the secret arx/) });
    db.update(secretNotes).set({ summary: "A card" }).run();
    must(makeSecret(db, src, "card"));
    expect(getNote(db, "card")!.details).toBe("A card.");
  });

  test("S4: info_write reads, merges and writes in one IMMEDIATE transaction", async () => {
    const db = memDb();
    const src = source();
    const seen: unknown[] = [];
    const tx = db.transaction.bind(db);
    (db as unknown as { transaction: unknown }).transaction = (fn: (t: unknown) => unknown, behaviour?: unknown) =>
      tx((t) => {
        seen.push(behaviour);
        const out = fn(t);
        seen.push(infoNames(t as unknown as Db));
        return out;
      }, behaviour as never);
    const r = await tools(db, src, ensureChat(db, { id: OWNER, kind: "private" })).info_write!({ name: "addr", fields: [{ name: "CITY", about: "city", value: "Example City" }], summary: "Home" });
    expect(r.isError).toBeFalsy();
    expect(seen).toEqual([IMMEDIATE, ["addr"]]);
    expect(getNote(db, "addr", "info")!.summary).toBe("Home");
  });

  test("N2: a store secret a secrets-file profile of its name hides is not made personal info", () => {
    const db = memDb();
    const src = source();
    db.insert(secretProfiles).values({ name: "arx", varNames: ["K"], sealed: seal(KEY, "arx", { K: "store-shadowed-01" }) }).run();
    expect(makeInfo(db, src, "arx", "console")).toEqual({ error: expect.stringMatching(/which hides this one/) });
    expect(infoNames(db)).toEqual([]);
  });
});

// ---- the capability ------------------------------------------------------------------------------------------

function tools(db: Db, src: SecretSource, chat: Chat, consoleUrl = "https://console.example"): Record<string, (args?: Record<string, unknown>) => Promise<ToolResult>> {
  const cfg: InfoConfig = { secrets: src, consoleUrl };
  const state = { chat, turnId: 1, passed: false, stopping: false, n: 0, fromSeq: 0, toSeq: 0, acting: () => ({ by: "owner" }) } as unknown as TurnState;
  const ctx: TurnContext = { db, home: "/nonexistent", chat, turnId: 1, timeZone: "UTC", owner: {}, state, ownerId: OWNER };
  const defs = info.tools!(ctx, cfg).flatMap((b) => b.tools as ToolDef[]);
  return Object.fromEntries(defs.map((d) => [d.name, (args: Record<string, unknown> = {}) => d.handler(args)]));
}

describe("the info capability", () => {
  test("appended to the registry; on only with SHUVI_SECRETS_KEY; every tool owner-only, none delegable", () => {
    expect(CAPABILITIES.at(-1)).toBe(info);
    expect(info.enable({})).toBeNull();
    expect(info.enable({ SHUVI_SECRETS_KEY: Buffer.from(KEY).toString("base64"), SHUVI_CONSOLE_URL: "https://c.example" })).toMatchObject({ consoleUrl: "https://c.example" });
    expect(info.always).toBe(true);
    expect([...info.ownerOnly!].sort()).toEqual([...INFO_TOOLS].sort());
    expect(info.delegable ?? []).toEqual([]);
  });

  test("info_write keeps what she is told, by her in that chat; info_read gives values, what each is, and the note", async () => {
    const db = memDb();
    const src = source();
    const t = tools(db, src, ensureChat(db, { id: OWNER, kind: "private" }));
    let r = await t.info_write!({ name: "home-address", fields: [{ name: "POSTCODE", about: "郵遞區號", value: "100-0001" }, { name: "STREET", about: "街道", value: "1-2-3 Sample Street" }], summary: "Home address" });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('Created "home-address" (POSTCODE, STREET)');
    expect(infoHistory(db, src, "home-address")[0]!.by).toMatch(/^assistant in /);
    r = await t.info_write!({ name: "home-address", fields: [{ name: "STREET", value: "4-5-6 Sample Avenue" }] });
    expect(textOf(r)).toContain("Changed STREET");
    r = await t.info_read!({ name: "home-address" });
    expect(textOf(r)).toContain("Summary: Home address");
    expect(textOf(r)).toContain("- POSTCODE (郵遞區號): 100-0001");
    expect(textOf(r)).toContain("- STREET (街道): 4-5-6 Sample Avenue");
    expect((await t.info_read!({ name: "nope" })).isError).toBe(true);
    // A secret's value is refused.
    must(putProfile(db, src, "github", { GH_TOKEN: TOKEN }));
    r = await t.info_write!({ name: "notes", fields: [{ name: "X", value: TOKEN }] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).not.toContain(TOKEN);
  });

  test("info_read hides a value a secret also holds", async () => {
    const db = memDb();
    const src = source("arx:\n  KEY: shared-with-file-0001\n");
    must(putProfile(db, src, "home", { PIN: "shared-with-file-0001", STREET: "1-2-3 Sample Street" }));
    must(makeInfo(db, src, "home", "console"));
    const r = await tools(db, src, ensureChat(db, { id: OWNER, kind: "private" })).info_read!({});
    expect(textOf(r)).toContain("- PIN: [REDACTED:arx]");
    expect(textOf(r)).toContain("- STREET: 1-2-3 Sample Street");
  });

  test("the section names each profile with its summary, never a value, the same bytes for the same state", () => {
    const db = memDb();
    const src = source();
    must(writeInfo(db, src, "phone", { set: { MOBILE: "+00 900 000 004" } }, "x"));
    must(writeInfo(db, src, "addr", { set: ADDRESS }, "x"));
    must(setNote(db, src, "addr", { summary: "Home address" }, "x", Date.now(), "info"));
    const chat = ensureChat(db, { id: OWNER, kind: "private" });
    const s = info.section!({ db, chat, home: "/nonexistent" } as never, { secrets: src });
    expect(s).toContain("\n  - addr: Home address\n  - phone");
    expect(s).not.toContain("Example City");
    expect(s).not.toContain("+00 900");
    expect(s).toContain("In a group, never say a value unless the owner asks for it there.");
    expect(info.section!({ db, chat, home: "/nonexistent" } as never, { secrets: src })).toBe(s!);
    expect(infoSection([], new Map())).toContain("There is none yet.");
  });

  test("request_info: a card with only Deny and a console link; saved there, only those fields change, recorded as his, the chat woken", async () => {
    const db = memDb();
    const src = source();
    const dm = ensureChat(db, { id: OWNER, kind: "private" });
    must(writeInfo(db, src, "addr", { set: ADDRESS }, "console"));
    expect((await tools(db, src, dm, "").request_info!({ name: "addr", fields: [{ name: "POSTCODE" }], reason: "x" })).isError).toBe(true);
    const r = await tools(db, src, dm).request_info!({ name: "addr", fields: [{ name: "POSTCODE", about: "郵遞區號" }, { name: "MEMBER_NO", about: "會員號碼" }], reason: "The shop's form asks for them." });
    expect(textOf(r)).toContain("approval #");
    const id = Number(/approval #(\d+)/.exec(textOf(r))![1]);
    const card = getApproval(db, id)!;
    expect(card.kind).toBe(PROVIDE_KIND);
    expect(card.data).toMatchObject({ kind: "info", profile: "addr", vars: ["POSTCODE", "MEMBER_NO"], mode: "update" });
    expect(card.options.map((o) => [o.id, !!o.hidden])).toEqual([[INFO_SAVE, true], ["deny", false]]);
    expect(cardKeyboard(card).flat().map((b) => b.text)).toEqual(["Deny"]);
    expect(card.body).toContain("/settings/secrets/provide?card=");
    // The provide page: personal info, no grant, a field it has shows what it holds.
    let html = await get(db, src, `/settings/secrets/provide?card=${id}`);
    expect(text(html)).toContain("Personal info · she reads it");
    // What it holds now is masked, as on the Secrets page, until Show (`?show=1` where the CSS toggle cannot).
    expect(text(html)).toContain(`now: ${MASK} 100-0009`);
    expect(placesOf(html, "100-0009")).toEqual([expect.stringMatching(/<span class="iv">$/)]);
    expect(html).toMatch(/<main class="provide irow"><input type="checkbox" class="ishow-t" id="show-now"[^>]* >/);
    expect(await get(db, src, `/settings/secrets/provide?card=${id}&show=1`)).toMatch(/<main class="provide irow shown"><input type="checkbox" class="ishow-t" id="show-now"[^>]* checked>/);
    expect(html).not.toContain('name="grant" value="1d"');
    html = await post(db, src, "/settings/secrets/provide", { card: String(id), do: "provide", grant: "save", v_POSTCODE: "100-0002", v_MEMBER_NO: "" });
    expect(text(html)).toContain("Give MEMBER_NO a value");
    html = await post(db, src, "/settings/secrets/provide", { card: String(id), do: "provide", grant: "save", v_POSTCODE: "100-0002", v_MEMBER_NO: "M-000123" });
    expect(text(html)).toContain("Saved addr (POSTCODE, MEMBER_NO)");
    expect(getInfo(db, src, "addr")!.values).toEqual({ ...ADDRESS, POSTCODE: "100-0002", MEMBER_NO: "M-000123" });
    expect(infoHistory(db, src, "addr")[0]!.by).toBe(`console: ${LOGIN} (from her request)`);
    expect(getApproval(db, id)!.answer).toBe(INFO_SAVE);
    expect(grantsFor(db, dm.id, true)).toEqual([]);
    expect(getNote(db, "addr", "info")!.details).toContain("- MEMBER_NO: 會員號碼");
    const wake = db.$client.query("select count(*) as n from chat_events where kind = 'approval'").get() as { n: number };
    expect(wake.n).toBe(1);
  });

  test("request_info for something new makes it, its note saying why", async () => {
    const db = memDb();
    const src = source();
    const dm = ensureChat(db, { id: OWNER, kind: "private" });
    const r = must(requestInfo(db, src, { chatId: dm.id, name: "loyalty", fields: [{ name: "CARD_NO", about: "卡號" }], reason: "To book a table.", consoleUrl: "https://c.example" }));
    expect(r.update).toBe(false);
    await post(db, src, "/settings/secrets/provide", { card: String(r.approvalId), do: "provide", grant: "save", v_CARD_NO: "L-0001" });
    expect(getInfo(db, src, "loyalty")!.values).toEqual({ CARD_NO: "L-0001" });
    expect(getNote(db, "loyalty", "info")!.summary).toBe("To book a table.");
  });
});

// ---- the console ---------------------------------------------------------------------------------------------

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
async function post(db: Db, src: SecretSource, path: string, fields: Record<string, string>): Promise<string> {
  const res = await handleConsole(
    deps(db, src),
    new Request(`${BASE}${path}`, { method: "POST", headers: { [LOGIN_HEADER]: LOGIN, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...fields, csrf: CSRF }) }),
  );
  expect(res.status).toBe(303);
  return get(db, src, res.headers.get("location")!);
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
/** Every place `value` is on the page, as the 40 characters before it. */
const placesOf = (html: string, value: string) => html.split(value).slice(0, -1).map((before) => before.slice(-40));

describe("the console's Personal info", () => {
  test("values are masked by default: each only in its hidden span, beside a fixed mask; never in the title", async () => {
    const db = memDb();
    const src = source();
    must(writeInfo(db, src, "addr", { set: ADDRESS }, "console"));
    must(noteVarAbouts(db, src, "addr", { STREET: "街道" }, [], "console", Date.now(), "info") ?? {});
    const html = await get(db, src, "/settings/secrets");
    expect(text(html)).toContain("Personal info");
    expect(text(html)).toContain("STREET 街道");
    // Listed only once shown: the list is drawn hidden (`.vals`), its values masked inside it too.
    expect(html).toContain('<dl class="kvlist vals">');
    for (const v of Object.values(ADDRESS)) expect(placesOf(html, v)).toEqual([expect.stringMatching(/<span class="iv">$/)]);
    expect(html.split(MASK).length - 1).toBeGreaterThanOrEqual(3);
    expect(/<title>[^<]*<\/title>/.exec(html)![0]).not.toContain("Example");
    // The Show toggle: a checkbox the CSS reads, unchecked; the row not drawn shown.
    expect(html).toMatch(/<input type="checkbox" class="ishow-t" id="show-p-info-addr"[^>]*aria-label="show the values of addr" >/);
    expect(html).not.toContain("irow shown");
    expect(html).toContain('href="/settings/secrets?show=addr#p-info-addr"');
  });

  test("?show= draws that profile's values shown (the link where the CSS toggle cannot), and only that one", async () => {
    const db = memDb();
    const src = source();
    must(writeInfo(db, src, "addr", { set: ADDRESS }, "console"));
    must(writeInfo(db, src, "phone", { set: { MOBILE: "+00 900 000 005" } }, "console"));
    const html = await get(db, src, "/settings/secrets?show=addr");
    expect(html).toMatch(/class="srow irow shown" id="p-info-addr"><input type="checkbox" class="ishow-t" id="show-p-info-addr"[^>]* checked>/);
    expect(html).toMatch(/class="srow irow" id="p-info-phone"><input type="checkbox" class="ishow-t" id="show-p-info-phone"[^>]* >/);
  });

  test("the edit form: boxes prefilled and masked; an unchanged or emptied box keeps its value; Remove; a new field; recorded", async () => {
    const db = memDb();
    const src = source();
    must(writeInfo(db, src, "addr", { set: ADDRESS }, "console"));
    let html = await get(db, src, "/settings/secrets?iedit=addr");
    expect(html).toContain(`<input type="text" name="v_CITY" class="imasked" value="Example City"`);
    html = await post(db, src, "/settings/secrets/info-put", { name: "addr", replace: "1", v_POSTCODE: "100-0009", v_CITY: "", v_STREET: "4-5-6 Sample Avenue", del_CITY: "1", nn_0: "BUILDING", na_0: "大樓", nv_0: "Demo Tower 1205" });
    expect(text(html)).toContain("addr: set BUILDING, STREET; removed CITY.");
    expect(getInfo(db, src, "addr")!.values).toEqual({ POSTCODE: "100-0009", STREET: "4-5-6 Sample Avenue", BUILDING: "Demo Tower 1205" });
    expect(infoHistory(db, src, "addr")[0]!.by).toBe(`console: ${LOGIN}`);
    expect(getNote(db, "addr", "info")!.details).toContain("- BUILDING: 大樓");
    // The flash names fields, never a value.
    expect(placesOf(html, "Demo Tower 1205").every((b) => b.endsWith('<span class="iv">'))).toBe(true);
  });

  test("the edit table: each value's own eye, masked until pressed, apart from the profile's Show; values only in their boxes", async () => {
    const db = memDb();
    const src = source();
    must(writeInfo(db, src, "addr", { set: { ...ADDRESS, STREET: "1-2-3 Sample Street\nBuilding B" } }, "console"));
    const html = await get(db, src, "/settings/secrets?iedit=addr");
    for (const f of Object.keys(ADDRESS)) expect(html).toContain(`<button type="button" class="kveye" aria-pressed="false" aria-label="show the value of ${f}" title="Show this value">`);
    expect(html.split('class="kveye"').length - 1).toBe(3);
    // Each value in its masked box only (a value of two lines: a textarea), not listed beside the form.
    expect(placesOf(html, "Example City")).toEqual([expect.stringMatching(/name="v_CITY" class="imasked" value="$/)]);
    expect(placesOf(html, "1-2-3 Sample Street\nBuilding B")).toEqual([expect.stringMatching(/autocorrect="off" spellcheck="false">$/)]);
    expect(html).toMatch(/<span class="kvv kvvw"><textarea name="v_STREET" class="imasked" rows="2"/);
    // The profile's Show values stays beside Edit.
    expect(html).toContain('<label class="btn ishow-l" for="show-p-info-addr">');
    // A new row has no eye: what is typed there is not masked.
    const add = (await get(db, src, "/settings/secrets")).match(/<details class="addp" id="add-info"[^]*?<\/details>/)![0];
    expect(add).not.toContain("kveye");
    // The eye's script and its look ship with the console.
    const asset = /<script src="(\/console\.js\?v=[^"]*)"/.exec(await get(db, src, "/settings/secrets"))![1]!;
    expect(await get(db, src, asset)).toContain("button.kveye");
  });

  test("the ⋯ menu: Show values and Edit beside the row, History, the note, Make it a secret and Delete in its menu; Delete asks first; writes need the token", async () => {
    const db = memDb();
    const src = source();
    must(writeInfo(db, src, "addr", { set: ADDRESS }, "console"));
    const html = await get(db, src, "/settings/secrets");
    const row = /id="p-info-addr">[^]*?<div class="sact">([^]*?)<\/div>\n/.exec(html)![1]!;
    const [primary, menu] = row.split('<details class="rmenu">');
    expect(primary).toContain("Show values");
    expect(primary).toContain('href="/settings/secrets?iedit=addr#p-info-addr"');
    expect(primary).not.toMatch(/History|Delete|Make it|note/);
    expect(menu!.match(/<a class="mi[^"]*" href="[^"]*"/g)).toEqual([
      '<a class="mi" href="/settings/secrets?history=addr#p-info-addr"',
      '<a class="mi" href="/settings/secrets?inote=addr#p-info-addr"',
      expect.stringMatching(/^<a class="mi" href="\/settings\/secrets\?convert=addr&(amp;)?to=secret#p-info-addr"$/),
      '<a class="mi danger" href="/settings/secrets?idelete=addr#p-info-addr"',
    ]);
    expect(text(await get(db, src, "/settings/secrets?idelete=addr"))).toContain("Delete addr?");
    for (const [verb, body] of [
      ["info-delete", { name: "addr" }],
      ["convert", { name: "addr", to: "secret" }],
      ["info-put", { name: "addr", replace: "1", v_CITY: "Other City" }],
    ] as const) {
      const res = await handleConsole(deps(db, src), new Request(`${BASE}/settings/secrets/${verb}`, { method: "POST", headers: { [LOGIN_HEADER]: LOGIN, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) }));
      expect(res.status).toBe(403);
    }
    expect(getInfo(db, src, "addr")!.values).toEqual(ADDRESS);
  });

  test("descriptions and the summary: an added profile's summary and each key's description go to its note; an edited or emptied description too", async () => {
    const db = memDb();
    const src = source();
    let html = await post(db, src, "/settings/secrets/info-put", { name: "example", summary: "An example profile", nn_0: "KEY_ONE", na_0: "the first", nv_0: "one", nn_4: "KEY_TWO", nv_4: "two" });
    expect(text(html)).toContain("Added example (KEY_ONE, KEY_TWO)");
    expect(getNote(db, "example", "info")).toMatchObject({ summary: "An example profile", details: "Variables:\n- KEY_ONE: the first" });
    html = await post(db, src, "/settings/secrets/info-put", { name: "example", replace: "1", v_KEY_ONE: "one", a_KEY_ONE: "", v_KEY_TWO: "two", a_KEY_TWO: "the second" });
    expect(text(html)).toContain("Nothing changed in example.");
    expect(getNote(db, "example", "info")!.details).toBe("Variables:\n- KEY_TWO: the second");
    expect(infoHistory(db, src, "example").length).toBe(1);
  });

  test("History shows each change with who, which fields, the values before (masked); Restore puts them back", async () => {
    const db = memDb();
    const src = source();
    must(writeInfo(db, src, "addr", { set: ADDRESS }, "console: owner", Date.now() - 60_000));
    must(writeInfo(db, src, "addr", { set: { STREET: "4-5-6 Sample Avenue" } }, "assistant in DM", Date.now() - 30_000));
    let html = await get(db, src, "/settings/secrets?history=addr");
    expect(text(html)).toContain("by her, in DM");
    expect(text(html)).toContain("Changed STREET");
    expect(text(html)).toMatch(/Made, with POSTCODE ?, CITY ?, STREET/);
    expect(placesOf(html, "1-2-3 Sample Street")).toEqual([expect.stringMatching(/<span class="iv">$/)]);
    const version = infoHistory(db, src, "addr")[0]!.id;
    html = await post(db, src, "/settings/secrets/info-restore", { name: "addr", version: String(version) });
    expect(text(html)).toContain("addr: restored the values from before the change");
    expect(getInfo(db, src, "addr")!.values!.STREET).toBe("1-2-3 Sample Street");
  });

  test("convert: the confirmations say what happens; secret → info revokes every grant; info → secret is redacted from then on", async () => {
    const db = memDb();
    const src = source();
    const dm = ownerChatId(db);
    must(putProfile(db, src, "home", { STREET: "1-2-3 Sample Street" }));
    consoleGrant(db, "home", "forever");
    let html = await get(db, src, "/settings/secrets?convert=home&to=info");
    expect(text(html)).toContain("Make home personal info?");
    expect(text(html)).toContain("Every grant of it is revoked (1 grant to every chat, and any to a single chat)");
    html = await post(db, src, "/settings/secrets/convert", { name: "home", to: "info" });
    expect(text(html)).toContain("home is personal info now");
    expect(text(html)).toContain("Revoked its grant.");
    expect(grantsFor(db, dm, true)).toEqual([]);
    html = await get(db, src, "/settings/secrets?convert=home&to=secret");
    expect(text(html)).toContain("Make home a secret?");
    expect(text(html)).toContain("history is deleted");
    html = await post(db, src, "/settings/secrets/convert", { name: "home", to: "secret" });
    expect(text(html)).toContain("home is a secret now");
    expect(redactionFor(db, src).redact("1-2-3 Sample Street")).toBe("[REDACTED:home]");
    expect(html).not.toContain("1-2-3 Sample Street");
  });

  test("add and delete; a refused add comes back with its name, never its values", async () => {
    const db = memDb();
    const src = source();
    must(putProfile(db, src, "github", { GH_TOKEN: TOKEN }));
    let html = await post(db, src, "/settings/secrets/info-put", { name: "notes", nn_0: "X", nv_0: TOKEN });
    expect(text(html)).toContain('holds the value of the secret profile "github"');
    expect(html).not.toContain(TOKEN);
    expect(html).toContain('value="notes"');
    html = await post(db, src, "/settings/secrets/info-put", { name: "phone", nn_0: "MOBILE", na_0: "手機", nv_0: "+00 900 000 006" });
    expect(text(html)).toContain("Added phone (MOBILE)");
    html = await post(db, src, "/settings/secrets/info-delete", { name: "phone" });
    expect(text(html)).toContain("Deleted phone, its history and its note.");
    expect(infoNames(db)).toEqual([]);
    expect(db.select().from(secretNotes).all().filter((n) => n.kind === "info")).toEqual([]);
  });
});

// ---- the migration -------------------------------------------------------------------------------------------

describe("migration 0028", () => {
  test("existing profiles become secrets, existing notes secrets' notes", () => {
    const d = mkdtempSync(join(tmpdir(), "shuvi-mig-"));
    dirs.push(d);
    const before = join(d, "drizzle");
    cpSync("drizzle", before, { recursive: true });
    const journal = JSON.parse(readFileSync(join(before, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    const at = journal.entries.findIndex((e) => e.tag.startsWith("0028_"));
    expect(at).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, at);
    writeFileSync(join(before, "meta/_journal.json"), JSON.stringify(journal));
    const path = join(d, "shuvi.db");
    const old = openDb(path, { migrate: true, migrationsFolder: before });
    old.$client.run("insert into secret_profiles (name, var_names, sealed) values ('github', '[\"GH_TOKEN\"]', x'00')");
    old.$client.run("insert into secret_notes (name, summary, details, updated_by) values ('github', 'the token', '', 'console')");
    old.$client.close();
    const db = openDb(path, { migrate: true });
    expect(db.select({ kind: secretProfiles.kind, name: secretProfiles.name }).from(secretProfiles).all()).toEqual([{ kind: "secret", name: "github" }]);
    expect(db.select({ kind: secretNotes.kind, name: secretNotes.name, summary: secretNotes.summary }).from(secretNotes).all()).toEqual([{ kind: "secret", name: "github", summary: "the token" }]);
    // A name in both kinds is allowed now; twice in one kind is not.
    db.$client.run("insert into secret_profiles (kind, name, var_names, sealed) values ('info', 'github', '[]', x'00')");
    expect(() => db.$client.run("insert into secret_profiles (kind, name, var_names, sealed) values ('info', 'github', '[]', x'00')")).toThrow();
    db.$client.close();
  });
});
