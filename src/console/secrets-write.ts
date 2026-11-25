import { randomBytes } from "node:crypto";
import { consoleGrant, revokeGrant, revokeProfileGrants, untilLabel, type OwnerTtl } from "../capabilities/computer/secrets.ts";
import { allProfiles, deleteProfile, parseVars, putProfile, storedProfiles, type SecretSource } from "../secrets/source.ts";
import { deleteNote, setNote } from "../secrets/notes.ts";
import type { Db } from "../store/db.ts";
import { IMMEDIATE } from "../store/turns.ts";
import { GRANT_CHOICES, type AddForm } from "./secrets.ts";
import { anchor, type SettingsNote } from "./settings.ts";
import { FLASH_MAX, FLASH_MS, type Form } from "./settings-write.ts";

/**
 * The Secrets page's writes, `POST /settings/secrets/<verb>` with form fields (server.ts checks the Origin and the
 * CSRF token before any of them runs):
 *
 *   put      name, values, grant?, replace?   add a profile kept here (`putProfile`: sealed under SHUVI_SECRETS_KEY),
 *                                             or with `replace`, set all of an existing one's variables anew; `grant`
 *                                             (a duration, or empty) also grants it to every chat (`consoleGrant`)
 *   grant    profile, ttl                     grant a profile there is to every chat, for the owner's requests
 *   revoke   grant                            revoke an owner grant, as its card's "Revoke now" (`revokeGrant`)
 *   delete   name                             delete a profile kept here (`deleteProfile`), revoke its grants (a
 *                                             chat's and every chat's: a later profile of its name inherits none),
 *                                             and delete its note
 *   note     name, summary, details           set a profile's note (`setNote`; not secret, refused if it holds a value)
 *
 * The answer is a 303 to the page with the result as a FLASH (as settings-write.ts: a random id in `?r=`, kept in
 * memory for FLASH_MS, shown once). A flash never holds a value: a refused add comes back with its name and its
 * grant choice only, and the values are typed again. A note names profiles and variables, never a value.
 */

export const SECRETS_WRITES = ["/settings/secrets/put", "/settings/secrets/grant", "/settings/secrets/revoke", "/settings/secrets/delete", "/settings/secrets/note"] as const;
export type SecretsWrite = (typeof SECRETS_WRITES)[number];
export const isSecretsWrite = (path: string): path is SecretsWrite => (SECRETS_WRITES as readonly string[]).includes(path);

interface Flash {
  note: SettingsNote;
  adding?: AddForm;
  exp: number;
}

const flashes = new Map<string, Flash>();

function sweep(now: number): void {
  for (const [k, f] of flashes) if (f.exp < now) flashes.delete(k);
}

/** The flash `id` names (once), if it has not expired. */
export function takeSecretsFlash(id: string | null, now = Date.now()): { note: SettingsNote; adding?: AddForm } | undefined {
  sweep(now);
  if (!id) return undefined;
  const f = flashes.get(id);
  flashes.delete(id);
  return f && { note: f.note, ...(f.adding ? { adding: f.adding } : {}) };
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
      const vars = parseVars(rawField(form, "values"));
      if ("error" in vars) return refused(`${vars.error} Nothing was saved; type the values again.`);
      const r = putProfile(db, src, name, vars.vars, now);
      if ("error" in r) return refused(`${r.error} Nothing was saved; type the values again.`);
      const names = Object.keys(vars.vars).join(", ");
      if (grant) {
        const g = consoleGrant(db, name, grant, now);
        return { note: { tone: "ok", text: `${r.created ? "Added" : "Replaced the values of"} ${name} (${names}) and granted it to every chat ${TTL_WORDS[grant]} (grant #${g.id}): her commands get it in turns you start.`, on: name }, anchor: anchor("p", name) };
      }
      return { note: { tone: "ok", text: r.created ? `Added ${name} (${names}). She can ask for it with request_secret, or grant it to every chat here.` : `Replaced the values of ${name} (${names}). Commands started from now on get the new ones.`, on: name }, anchor: anchor("p", name) };
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
      const r = setNote(db, src, name, { summary: rawField(form, "summary"), details: rawField(form, "details") }, login ? `console: ${login}` : "console", now);
      // A refused note is not shown back: it may hold the value it was refused for.
      if ("error" in r) return { note: { tone: "refused", text: r.error, on: name }, anchor: anchor("p", name) };
      return { note: { tone: "ok", text: `Saved the note of ${name}. Her prompt has the summary from her next turn.`, on: name }, anchor: anchor("p", name) };
    }
    default:
      throw new Error(`unknown secrets write "${String(path satisfies never)}"`);
  }
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
  const r = putFlash({ note: out.note, ...(out.adding ? { adding: out.adding } : {}) }, now);
  return `/settings/secrets?r=${r}${out.anchor ? `#${out.anchor}` : ""}`;
}
