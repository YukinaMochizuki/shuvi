import { randomBytes } from "node:crypto";
import { consoleGrant, pendingProvide, provideSecret, revokeGrant, revokeProfileGrants, untilLabel, type OwnerTtl } from "../capabilities/computer/secrets.ts";
import { answerApproval } from "../control/approvals.ts";
import { allProfiles, deleteProfile, putProfile, storedProfiles, updateProfile, VAR_NAME, type SecretSource } from "../secrets/source.ts";
import { deleteNote, getNote, noteVarAbouts, setNote, varAbouts, type NoteKind } from "../secrets/notes.ts";
import { deleteInfo, getInfo, makeInfo, makeSecret, restoreInfo, writeInfo } from "../secrets/info.ts";
import { provideInfo } from "../capabilities/info/request.ts";
import { infoAnchor, infoOn } from "./info.ts";
import { KV_MAX_NEW } from "./kv-table.ts";
import type { Db } from "../store/db.ts";
import { IMMEDIATE } from "../store/turns.ts";
import { GRANT_CHOICES, type AddForm } from "./secrets.ts";
import { anchor, type SettingsNote } from "./settings.ts";
import { FLASH_MAX, FLASH_MS, type Form } from "./settings-write.ts";

/**
 * The Secrets page's writes, `POST /settings/secrets/<verb>` with form fields (server.ts checks the Origin and the
 * CSRF token before any of them runs):
 *
 *   put      name, summary?, grant?, replace?, and the key/value table's fields (kv-table.ts: v_/a_/del_<KEY>,
 *            nn_/na_/nv_<i>)
 *                                             add a profile kept here (`putProfile`: sealed under SHUVI_SECRETS_KEY),
 *                                             its summary into its note; or with `replace`, change an existing one's
 *                                             variables (an empty value keeps it); `grant` (a duration, or empty)
 *                                             also grants it to every chat (`consoleGrant`)
 *   grant    profile, ttl                     grant a profile there is to every chat, for the owner's requests
 *   revoke   grant                            revoke an owner grant, as its card's "Revoke now" (`revokeGrant`)
 *   delete   name                             delete a profile kept here (`deleteProfile`), revoke its grants (a
 *                                             chat's and every chat's: a later profile of its name inherits none),
 *                                             and delete its note
 *   note     name, summary, details, kind?    set a profile's note (`setNote`; not secret, refused if it holds a value);
 *                                             `kind=info`: a personal-info profile's
 *
 * PERSONAL INFO (info.ts; src/secrets/info.ts), whose values are not secret and are shown:
 *   info-put     name, summary?, replace?, the table's fields   add a profile, or change its fields (an empty or
 *                                             unchanged field keeps its value); each change recorded as a version
 *   info-delete  name                         delete it, its history and its note
 *   info-restore name, version                put back the values from before that version's change (recorded too)
 *   convert      name, to = info | secret     make a secret kept here personal info (its values leave the known
 *                                             file but for one another secret holds; every grant of it revoked), or
 *                                             personal info a secret (its values join the known file; history gone)
 *
 * The answer is a 303 to the page with the result as a FLASH (as settings-write.ts: a random id in `?r=`, kept in
 * memory for FLASH_MS, shown once). A flash never holds a value: a refused add comes back with its name and its
 * grant choice only, and the values are typed again. A note names profiles and variables, never a value.
 *
 * The table's DESCRIPTIONS (`a_<KEY>`, `na_<i>`) go into the profile's note as its `- KEY: what it is` lines
 * (`noteVarAbouts`), a secret's and personal info's alike; an emptied one takes its line out. A description holding
 * a secret value is refused there, as a note is, and the values are saved without it, the answer saying so.
 */

export const SECRETS_WRITES = [
  "/settings/secrets/put",
  "/settings/secrets/grant",
  "/settings/secrets/revoke",
  "/settings/secrets/delete",
  "/settings/secrets/note",
  "/settings/secrets/info-put",
  "/settings/secrets/info-delete",
  "/settings/secrets/info-restore",
  "/settings/secrets/convert",
] as const;
export type SecretsWrite = (typeof SECRETS_WRITES)[number];
export const isSecretsWrite = (path: string): path is SecretsWrite => (SECRETS_WRITES as readonly string[]).includes(path);

interface Flash {
  note: SettingsNote;
  adding?: AddForm;
  addingInfo?: { name?: string };
  exp: number;
}

const flashes = new Map<string, Flash>();

function sweep(now: number): void {
  for (const [k, f] of flashes) if (f.exp < now) flashes.delete(k);
}

/** The flash `id` names (once), if it has not expired. */
export function takeSecretsFlash(id: string | null, now = Date.now()): { note: SettingsNote; adding?: AddForm; addingInfo?: { name?: string } } | undefined {
  sweep(now);
  if (!id) return undefined;
  const f = flashes.get(id);
  flashes.delete(id);
  return f && { note: f.note, ...(f.adding ? { adding: f.adding } : {}), ...(f.addingInfo ? { addingInfo: f.addingInfo } : {}) };
}

function putFlash(f: Omit<Flash, "exp">, now: number): string {
  sweep(now);
  for (const k of flashes.keys()) {
    if (flashes.size < FLASH_MAX) break;
    flashes.delete(k);
  }
  const id = randomBytes(12).toString("base64url");
  flashes.set(id, { ...f, exp: now + FLASH_MS });
  return id;
}

interface Outcome {
  note: SettingsNote;
  anchor?: string;
  adding?: AddForm;
  addingInfo?: { name?: string };
}

const field = (form: Form, name: string): string => {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
};

/** A field as posted, untrimmed (the values, a note: their own parsers trim). */
const rawField = (form: Form, name: string): string => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};

/**
 * The indices of the table's new rows the form holds (`nn_<i>`, `na_<i>`, `nv_<i>`), in order: whatever was posted,
 * since rows are added (and removed) in the page, so the numbers may have gaps. More than KV_MAX_NEW is refused.
 */
function newRowIndices(form: Form): number[] | { error: string } {
  const keys = (form as { keys?: () => Iterable<string> }).keys;
  const names: Iterable<string> = typeof keys === "function" ? keys.call(form) : Array.from({ length: KV_MAX_NEW }, (_, i) => `nn_${i}`);
  const at = new Set<number>();
  for (const k of names) {
    const m = /^n[nav]_(\d{1,6})$/.exec(k);
    if (m) at.add(Number(m[1]));
  }
  if (at.size > KV_MAX_NEW) return { error: `At most ${KV_MAX_NEW} new rows at once.` };
  return [...at].sort((a, b) => a - b);
}

/**
 * The form's new rows (`nn_<i>` key, `na_<i>` what it is, `nv_<i>` value): a row with nothing in it is skipped; a
 * row with a value and no key, or a key and no value, is refused by its place in the table (never echoing what was
 * typed: it may be a value).
 */
function newRowsOf(form: Form, what = "variable"): { set: Record<string, string>; abouts: Record<string, string> } | { error: string } {
  const set: Record<string, string> = {};
  const abouts: Record<string, string> = {};
  const at = newRowIndices(form);
  if ("error" in at) return at;
  for (const [n, i] of at.entries()) {
    const name = field(form, `nn_${i}`);
    const value = rawField(form, `nv_${i}`);
    if (!name && !value.trim()) continue;
    if (!name) return { error: `New ${what} ${n + 1} has a value but no name.` };
    if (!VAR_NAME.test(name)) return { error: `New ${what} ${n + 1}'s name is not a ${what} name (letters, digits and _, not starting with a digit).` };
    if (!value.trim()) return { error: `${name} has no value.` };
    if (name in set) return { error: `${name} is given twice.` };
    set[name] = value;
    const about = field(form, `na_${i}`);
    if (about) abouts[name] = about;
  }
  return { set, abouts };
}

/**
 * The descriptions of a profile's existing keys as the table posts them (`a_<KEY>`): those changed, and those emptied
 * (their note line taken out). A key not in the form, or being removed, is left alone.
 */
function keyAbouts(db: Db, name: string, kind: NoteKind, keys: readonly string[], form: Form, removing: readonly string[]): { abouts: Record<string, string>; cleared: string[] } {
  const cur = varAbouts(getNote(db, name, kind));
  const abouts: Record<string, string> = {};
  const cleared: string[] = [];
  for (const k of keys) {
    const posted = form.get(`a_${k}`);
    if (typeof posted !== "string" || removing.includes(k)) continue;
    const about = posted.replace(/\s+/g, " ").trim();
    if (about && about !== cur[k]) abouts[k] = about;
    else if (!about && cur[k]) cleared.push(k);
  }
  return { abouts, cleared };
}

/** A new profile's summary (the add form's), into its note: "" when kept or none was given, else why not. */
function addSummary(db: Db, src: SecretSource, name: string, form: Form, by: string, now: number, kind: NoteKind): string {
  const summary = field(form, "summary");
  if (!summary) return "";
  const r = setNote(db, src, name, { summary }, by, now, kind);
  return "error" in r ? ` The summary was not kept: ${r.error}` : "";
}

function ttlField(form: Form, name: string): OwnerTtl | "" | null {
  const v = field(form, name);
  if (!v) return "";
  return GRANT_CHOICES.some((c) => c.id === v) ? (v as OwnerTtl) : null;
}

const TTL_WORDS: Record<OwnerTtl, string> = { forever: "until you revoke it", "3d": "for 3 days", "1d": "for 1 day", "4h": "for 4 hours" };

function write(db: Db, src: SecretSource, path: SecretsWrite, form: Form, who: { id: number; name: string } | null, login: string | undefined, now: number): Outcome {
  switch (path) {
    case "/settings/secrets/put": {
      const name = field(form, "name");
      const replace = field(form, "replace") === "1";
      const grant = ttlField(form, "grant");
      const adding: AddForm = { name, grant: grant ?? "" };
      const on = replace ? name : "add";
      const refused = (text: string): Outcome => ({ note: { tone: "refused", text, on }, anchor: replace ? anchor("p", name) : "add", ...(replace ? {} : { adding }) });
      if (grant === null) return refused("That is not a duration a grant can have.");
      const exists = storedProfiles(db).some((p) => p.name === name);
      if (replace && !exists) return refused(`There is no profile ${name} kept here to replace.`);
      if (!replace && exists) return refused(`A profile ${name} is kept here already: use its Replace values, or another name.`);
      const rows = newRowsOf(form);
      if ("error" in rows) return refused(`${rows.error} Nothing was saved; type the values again.`);
      const by = login ? `console: ${login}` : "console";
      if (replace) {
        const vars = storedProfiles(db).find((p) => p.name === name)!.vars;
        // An empty value keeps its value; ✕ takes it out; what each is goes to the note.
        const set: Record<string, string> = { ...rows.set };
        const remove: string[] = [];
        for (const v of vars) {
          if (field(form, `del_${v}`) === "1") remove.push(v);
          else if (rawField(form, `v_${v}`).trim()) set[v] = rawField(form, `v_${v}`);
        }
        for (const n of Object.keys(rows.set)) if (vars.includes(n)) return refused(`${n} is already a variable of ${name}: fill in its own row. Nothing was saved; type the values again.`);
        const ka = keyAbouts(db, name, "secret", vars, form, remove);
        const abouts: Record<string, string> = { ...ka.abouts, ...rows.abouts };
        if (!Object.keys(set).length && !remove.length) {
          const nr = noteVarAbouts(db, src, name, abouts, ka.cleared, by, now);
          return nr ? refused(nr.error) : { note: { tone: "ok", text: `Nothing to change in the values of ${name}; the descriptions are saved.`, on: name }, anchor: anchor("p", name) };
        }
        const r = updateProfile(db, src, name, { set, remove }, now);
        if ("error" in r) return refused(`${r.error} Nothing was saved; type the values again.`);
        const nr = noteVarAbouts(db, src, name, abouts, [...remove, ...ka.cleared], by, now);
        const what = [Object.keys(set).length ? `set ${Object.keys(set).join(", ")}` : "", remove.length ? `removed ${remove.join(", ")}` : ""].filter(Boolean).join("; ");
        return { note: { tone: nr ? "refused" : "ok", text: `${name}: ${what}. Commands started from now on get the new values.${nr ? ` The note was not changed: ${nr.error}` : ""}`, on: name }, anchor: anchor("p", name) };
      }
      if (!Object.keys(rows.set).length) return refused("Give at least one variable: its name and its value.");
      const r = putProfile(db, src, name, rows.set, now);
      if ("error" in r) return refused(`${r.error} Nothing was saved; type the values again.`);
      const nr = noteVarAbouts(db, src, name, rows.abouts, [], by, now);
      const names = Object.keys(rows.set).join(", ");
      const noteLine = `${nr ? ` What each is was not kept: ${nr.error}` : ""}${addSummary(db, src, name, form, by, now, "secret")}`;
      if (grant) {
        const g = consoleGrant(db, name, grant, now);
        return { note: { tone: "ok", text: `Added ${name} (${names}) and granted it to every chat ${TTL_WORDS[grant]} (grant #${g.id}): her commands get it in turns you start.${noteLine}`, on: name }, anchor: anchor("p", name) };
      }
      return { note: { tone: "ok", text: `Added ${name} (${names}). She can ask for it with request_secret, or grant it to every chat here.${noteLine}`, on: name }, anchor: anchor("p", name) };
    }
    case "/settings/secrets/grant": {
      const name = field(form, "profile");
      const ttl = ttlField(form, "ttl");
      if (!ttl) return { note: { tone: "refused", text: "Choose how long the grant lasts.", on: name }, anchor: anchor("p", name) };
      const all = allProfiles(db, src);
      if ("error" in all) return { note: { tone: "refused", text: `The secrets file cannot be used (${all.error}), so nothing can be given out now.`, on: name }, anchor: anchor("p", name) };
      if (!all.profiles[name]) {
        const u = all.unreadable.find((x) => x.name === name);
        return { note: { tone: "refused", text: u ? `${name} cannot be given out: ${u.why}.` : `There is no profile ${name}.`, on: name }, anchor: anchor("p", name) };
      }
      const g = consoleGrant(db, name, ttl, now);
      return { note: { tone: "ok", text: `Granted ${name} to every chat ${TTL_WORDS[ttl]} (grant #${g.id}): her commands get it in turns you start, never an operator's. Its revoke card is in the control bot.`, on: name }, anchor: anchor("p", name) };
    }
    case "/settings/secrets/revoke": {
      const id = Number(field(form, "grant"));
      if (!who) return { note: { tone: "refused", text: "The owner is not configured (SHUVI_OWNER_ID), so nothing can be revoked as him." } };
      const r = revokeGrant(db, id, null, who, now);
      if ("error" in r) return { note: { tone: "refused", text: r.error } };
      const g = "already" in r ? r.already : r.revoked;
      if ("already" in r) return { note: { tone: "ok", text: `${g.profile} (grant #${g.id}) had already ended: nothing to revoke.`, on: g.profile }, anchor: anchor("p", g.profile) };
      return { note: { tone: "ok", text: `Revoked ${g.profile} for every chat (grant #${g.id}, ${untilLabel(g)}): commands started from now on no longer get it, and its card in the control bot says so.`, on: g.profile }, anchor: anchor("p", g.profile) };
    }
    case "/settings/secrets/delete": {
      const name = field(form, "name");
      if (!who) return { note: { tone: "refused", text: "The owner is not configured (SHUVI_OWNER_ID), so its grants cannot be revoked as him; nothing was deleted.", on: name }, anchor: anchor("p", name) };
      const r = deleteProfile(db, src, name);
      if ("error" in r) return { note: { tone: "refused", text: r.error, on: name }, anchor: anchor("p", name) };
      if (!r.deleted) return { note: { tone: "refused", text: `There is no profile ${name} kept here.` }, anchor: "profiles" };
      const revoked = revokeProfileGrants(db, name, who, now);
      deleteNote(db, name);
      return { note: { tone: "ok", text: `Deleted ${name}${revoked ? ` and revoked its ${revoked === 1 ? "grant" : `${revoked} grants`}` : ""}. Its values stay redacted from what she sees.` }, anchor: "profiles" };
    }
    case "/settings/secrets/note": {
      const name = field(form, "name");
      const info = field(form, "kind") === "info";
      const on = info ? infoOn(name) : name;
      const at = info ? infoAnchor(name) : anchor("p", name);
      const r = setNote(db, src, name, { summary: rawField(form, "summary"), details: rawField(form, "details") }, login ? `console: ${login}` : "console", now, info ? "info" : "secret");
      // A refused note is not shown back: it may hold the value it was refused for.
      if ("error" in r) return { note: { tone: "refused", text: r.error, on }, anchor: at };
      return { note: { tone: "ok", text: `Saved the note of ${name}. Her prompt has the summary from her next turn.`, on }, anchor: at };
    }
    case "/settings/secrets/info-put": {
      const name = field(form, "name");
      const replace = field(form, "replace") === "1";
      const by = login ? `console: ${login}` : "console";
      const on = replace ? infoOn(name) : "add-info";
      const refused = (text: string): Outcome => ({ note: { tone: "refused", text, on }, anchor: replace ? infoAnchor(name) : "add-info", ...(replace ? {} : { addingInfo: { name } }) });
      const cur = getInfo(db, src, name);
      if (replace && !cur) return refused(`There is no personal info ${name} to change.`);
      if (!replace && cur) return refused(`There is personal info named ${name} already: use its Edit, or another name.`);
      const rows = newRowsOf(form, "field");
      if ("error" in rows) return refused(`${rows.error} Nothing was saved.`);
      if (replace) {
        if (!cur!.values) return refused(`${name} cannot be opened now: ${cur!.unreadable ?? "its values do not open"}.`);
        // A field as it was, or emptied, keeps its value; Remove takes it out; what each is goes to the note.
        const set: Record<string, string> = { ...rows.set };
        const remove: string[] = [];
        for (const f of cur!.fields) {
          if (field(form, `del_${f}`) === "1") remove.push(f);
          else {
            const v = rawField(form, `v_${f}`).replace(/\r\n?/g, "\n").trim();
            if (v && v !== cur!.values[f]) set[f] = v;
          }
        }
        for (const n of Object.keys(rows.set)) if (cur!.fields.includes(n)) return refused(`${n} is already a field of ${name}: change it in its own row. Nothing was saved.`);
        const ka = keyAbouts(db, name, "info", cur!.fields, form, remove);
        const nr0 = (): string => {
          const nr = noteVarAbouts(db, src, name, { ...ka.abouts, ...rows.abouts }, [...remove, ...ka.cleared], by, now, "info");
          return nr ? ` What each field is was not kept: ${nr.error}` : "";
        };
        if (!Object.keys(set).length && !remove.length) return { note: { tone: "ok", text: `Nothing changed in ${name}.${nr0()}`, on }, anchor: infoAnchor(name) };
        const r = writeInfo(db, src, name, { set, remove }, by, now);
        if ("error" in r) return refused(r.error);
        const extra = nr0();
        const what = [Object.keys(set).length ? `set ${Object.keys(set).join(", ")}` : "", remove.length ? `removed ${remove.join(", ")}` : ""].filter(Boolean).join("; ");
        return { note: { tone: extra ? "refused" : "ok", text: `${name}: ${what}. The values before are in its History.${extra}`, on }, anchor: infoAnchor(name) };
      }
      if (!Object.keys(rows.set).length) return refused("Give at least one field: its name and its value.");
      const r = writeInfo(db, src, name, { set: rows.set }, by, now);
      if ("error" in r) return refused(r.error);
      const nr = noteVarAbouts(db, src, name, rows.abouts, [], by, now, "info");
      const sum = addSummary(db, src, name, form, by, now, "info");
      return { note: { tone: nr || sum ? "refused" : "ok", text: `Added ${name} (${r.fields.join(", ")}). She reads it with info_read, in turns you start.${nr ? ` What each field is was not kept: ${nr.error}` : ""}${sum}`, on: infoOn(name) }, anchor: infoAnchor(name) };
    }
    case "/settings/secrets/info-delete": {
      const name = field(form, "name");
      const r = deleteInfo(db, name);
      if (!r.deleted) return { note: { tone: "refused", text: `There is no personal info ${name}.` }, anchor: "info" };
      deleteNote(db, name, "info");
      return { note: { tone: "ok", text: `Deleted ${name}, its history and its note.` }, anchor: "info" };
    }
    case "/settings/secrets/info-restore": {
      const name = field(form, "name");
      const r = restoreInfo(db, src, name, Number(field(form, "version")), `${login ? `console: ${login}` : "console"} (restored)`, now);
      if ("error" in r) return { note: { tone: "refused", text: r.error, on: infoOn(name) }, anchor: infoAnchor(name) };
      return { note: { tone: "ok", text: r.changed.length ? `${name}: restored the values from before the change of ${r.at.slice(0, 16).replace("T", " ")} UTC (${r.changed.join(", ")}). That is in its History too.` : `${name} holds those values already: nothing changed.`, on: infoOn(name) }, anchor: infoAnchor(name) };
    }
    case "/settings/secrets/convert": {
      const name = field(form, "name");
      const to = field(form, "to");
      if (to === "info") {
        if (!who) return { note: { tone: "refused", text: "The owner is not configured (SHUVI_OWNER_ID), so its grants cannot be revoked as him; nothing was changed.", on: name }, anchor: anchor("p", name) };
        const r = makeInfo(db, src, name, login ? `console: ${login}` : "console", now);
        if ("error" in r) return { note: { tone: "refused", text: r.error, on: name }, anchor: anchor("p", name) };
        const revoked = revokeProfileGrants(db, name, who, now);
        return {
          note: { tone: "ok", text: `${name} is personal info now: she reads it with info_read, and its values are no longer redacted${r.kept ? ` (but for ${r.kept === 1 ? "one value" : `${r.kept} values`} another secret also holds)` : ""}.${revoked ? ` Revoked its ${revoked === 1 ? "grant" : `${revoked} grants`}.` : ""}`, on: infoOn(name) },
          anchor: infoAnchor(name),
        };
      }
      if (to === "secret") {
        if (!who) return { note: { tone: "refused", text: "The owner is not configured (SHUVI_OWNER_ID), so grants left under its name cannot be revoked as him; nothing was changed.", on: infoOn(name) }, anchor: infoAnchor(name) };
        const r = makeSecret(db, src, name, now);
        if ("error" in r) return { note: { tone: "refused", text: r.error, on: infoOn(name) }, anchor: infoAnchor(name) };
        // A grant of the name may have outlived a secret of that name (the secrets file dropped it): this one starts
        // with none, as its confirmation says.
        const revoked = revokeProfileGrants(db, name, who, now);
        return {
          note: { tone: "ok", text: `${name} is a secret now: its values are redacted from what she sees, and it has no grant (she asks with request_secret, or grant it here).${revoked ? ` Revoked ${revoked === 1 ? "a grant" : `${revoked} grants`} left under its name.` : ""} Its history was deleted.`, on: name },
          anchor: anchor("p", name),
        };
      }
      return { note: { tone: "refused", text: "Make it personal info, or a secret." } };
    }
    default:
      throw new Error(`unknown secrets write "${String(path satisfies never)}"`);
  }
}

/**
 * The provide page's write (`POST /settings/secrets/provide`, provide.ts): `card`, `do` = provide (with `v_<NAME>` per
 * variable and `grant`) or deny. Answers where to go: the same page, which then shows the result (the card is
 * answered) or, refused, the form again, empty, with why.
 */
export function provideWrite(db: Db, src: SecretSource, form: Form, owner: { id: number; name: string } | null, now = Date.now(), login?: string): string {
  const card = Number(field(form, "card"));
  const back = (note: SettingsNote) => `/settings/secrets/provide?card=${card}&r=${putFlash({ note }, now)}`;
  if (!Number.isInteger(card) || card <= 0) return "/settings/secrets";
  if (!owner) return back({ tone: "refused", text: "The owner is not configured (SHUVI_OWNER_ID), so nothing can be answered as him." });
  const p = pendingProvide(db, card, now);
  if ("error" in p) return back({ tone: "refused", text: p.error });
  if (field(form, "do") === "deny") {
    const r = db.transaction((tx) => answerApproval(tx as unknown as Db, card, p.card.options.findIndex((o) => o.id === "deny"), owner, now), IMMEDIATE);
    return back(r.result === "answered" ? { tone: "ok", text: "Denied. She has been told." } : { tone: "refused", text: "This request was answered meanwhile." });
  }
  // Only the variables the card asks for are read: a field of another name is no part of the profile.
  const values = Object.fromEntries(p.vars.map((v) => [v, rawField(form, `v_${v}`)]));
  if (p.info) {
    let r: ReturnType<typeof provideInfo>;
    try {
      r = provideInfo(db, src, card, values, owner, `${login ? `console: ${login}` : "console"} (from her request)`, now);
    } catch (e) {
      r = { error: `Nothing was saved: ${e instanceof Error ? e.message : String(e)}.` };
    }
    return back("error" in r ? { tone: "refused", text: r.error } : { tone: "ok", text: `Saved ${r.name}${r.changed.length ? ` (${r.changed.join(", ")})` : ""}. She has been told and carries on.` });
  }
  let r: ReturnType<typeof provideSecret>;
  try {
    r = provideSecret(db, src, card, values, field(form, "grant"), owner, now);
  } catch (e) {
    // Never the form: it holds the values.
    r = { error: `Nothing was saved: ${e instanceof Error ? e.message : String(e)}.` };
  }
  return back("error" in r ? { tone: "refused", text: r.error } : { tone: "ok", text: `Saved ${r.profile} and gave it to her: ${r.label}. She has been told and carries on.` });
}

/** Run write `path` with `form` (its CSRF token already checked) and answer where to go next, with its flash. */
export function secretsWrite(db: Db, src: SecretSource, path: SecretsWrite, form: Form, owner: { id: number; name: string } | null, login?: string, now = Date.now()): string {
  let out: Outcome;
  try {
    out = db.transaction((tx) => write(tx as unknown as Db, src, path, form, owner, login, now), IMMEDIATE);
  } catch (e) {
    // Never the form: it may hold a value. The store's error, as it says it.
    out = { note: { tone: "failed", text: `Failed: ${e instanceof Error ? e.message : String(e)}` } };
  }
  const r = putFlash({ note: out.note, ...(out.adding ? { adding: out.adding } : {}), ...(out.addingInfo ? { addingInfo: out.addingInfo } : {}) }, now);
  return `/settings/secrets?r=${r}${out.anchor ? `#${out.anchor}` : ""}`;
}
