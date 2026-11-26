import { and, asc, desc, eq, notInArray } from "drizzle-orm";
import type { Db } from "../store/db.ts";
import { infoVersions, secretProfiles } from "../store/schema.ts";
import { forgetValues, loadProfiles, rememberValues } from "./redaction.ts";
import { getNote, moveNote } from "./notes.ts";
import { allProfiles, keyProblem, KNOWN_UNWRITABLE, PROFILE_NAME, redactionFor, SECRET, VAR_NAME, type SecretSource } from "./source.ts";
import { open, seal } from "./vault.ts";

/**
 * PERSONAL INFO: data about the owner she must READ to work with it (a postal address to split into a form's fields
 * or translate, a phone, an email, a member number), as against a SECRET, which she never sees (docs/design.md §15).
 * The two share their storage: an info profile is a `secret_profiles` row of kind `info`, its fields sealed under
 * SHUVI_SECRETS_KEY as a secret's are (vault.ts, with the kind in the additional data), its note a `secret_notes` row
 * of kind `info` (notes.ts: its summary is in her prompt, its `- NAME: what it is` lines say what each field is).
 * A profile is one kind or the other; mixed data is two profiles.
 *
 *   READ      by her in any chat, in a turn the owner is in (capabilities/info/, owner-only, never delegable); by the
 *             owner in the console, values shown.
 *   NEVER     an info value is never given out as a secret (no grant, no env, no `browser_type` secret), never
 *   SECRET    added to the known file, never redacted. Every reader of secrets (source.ts `SECRET`) leaves info rows
 *             out. A value holding a known SECRET value is refused (`writeInfo`), so a secret is never copied here.
 *   VERSIONS  every change records the values from BEFORE it (`info_versions`: sealed, when, by whom, which fields;
 *             the creation records `{}`), the newest INFO_VERSIONS_KEPT per profile. Restoring one (`restoreInfo`) is
 *             a change like any other, recorded too.
 *   KINDS     the console turns a secret into personal info (`makeInfo`): its values leave the known file, except one
 *             another secret still holds (refused, nothing changed, when the known file cannot be written); its grants
 *             are revoked by the caller (console/secrets-write.ts). And back (`makeSecret`): its values join the known
 *             file first (refused when they cannot), and its history is dropped. A name the other kind already has
 *             is refused.
 *
 * Every write here wants a usable key; without it the names are listed and nothing opens.
 */

export const INFO_VERSIONS_KEPT = 20;
/** The most fields a profile holds, and characters a value. */
export const INFO_FIELDS_MAX = 40;
export const INFO_VALUE_MAX = 2000;

const INFO = eq(secretProfiles.kind, "info");
type Row = typeof secretProfiles.$inferSelect;

export interface InfoProfile {
  id: number;
  name: string;
  /** Its fields' names, in order. */
  fields: string[];
  /** Its values, by field; absent when they cannot be opened (`unreadable` says why). */
  values?: Record<string, string>;
  unreadable?: string;
  updatedAt: string;
}

const rowOf = (db: Db, name: string): Row | undefined => db.select().from(secretProfiles).where(and(INFO, eq(secretProfiles.name, name))).get();

function opened(src: SecretSource, r: Row): InfoProfile {
  const base = { id: r.id, name: r.name, fields: r.varNames, updatedAt: r.updatedAt };
  if (!src.key) return { ...base, unreadable: keyProblem(src)! };
  try {
    return { ...base, values: open(src.key, r.name, r.sealed, "info") };
  } catch (e) {
    return { ...base, unreadable: `its values do not open with SHUVI_SECRETS_KEY (${e instanceof Error ? e.message : String(e)})` };
  }
}

/** The info profiles' names, sorted, without opening any value (for the prompt). */
export function infoNames(db: Db): string[] {
  return db.select({ name: secretProfiles.name }).from(secretProfiles).where(INFO).orderBy(asc(secretProfiles.name)).all().map((r) => r.name);
}

/** Every info profile, its values opened where they can be, by name. */
export function infoProfiles(db: Db, src: SecretSource): InfoProfile[] {
  return db.select().from(secretProfiles).where(INFO).orderBy(asc(secretProfiles.name)).all().map((r) => opened(src, r));
}

export function getInfo(db: Db, src: SecretSource, name: string): InfoProfile | undefined {
  const r = rowOf(db, name);
  return r && opened(src, r);
}

/** Why `value` (a field's, at `name`) cannot be kept as personal info: too long, or it holds a secret's value. */
function refuseValue(red: ReturnType<typeof redactionFor>, field: string, value: string): string | null {
  if (value.length > INFO_VALUE_MAX) return `${field} is ${value.length} characters; at most ${INFO_VALUE_MAX}.`;
  const leaked = red.contains(Buffer.from(value, "utf8"));
  if (leaked === "?") return `${field} cannot be checked against the secrets (${red.why}), so nothing was saved.`;
  if (leaked) return `${field} holds the value of the secret profile "${leaked}": a secret is never kept as personal info. Nothing was saved.`;
  return null;
}

function record(db: Db, src: SecretSource, profileId: number, name: string, before: Record<string, string>, changed: string[], by: string, at: string): void {
  db.insert(infoVersions).values({ profileId, varNames: Object.keys(before), sealed: seal(src.key!, name, before, "info"), changed, by, at }).run();
  const keep = db.select({ id: infoVersions.id }).from(infoVersions).where(eq(infoVersions.profileId, profileId)).orderBy(desc(infoVersions.id)).limit(INFO_VERSIONS_KEPT).all().map((r) => r.id);
  db.delete(infoVersions).where(and(eq(infoVersions.profileId, profileId), notInArray(infoVersions.id, keep))).run();
}

export interface InfoChange {
  /** A new value for a field, or a new field. */
  set: Record<string, string>;
  /** Fields taken out. */
  remove?: readonly string[];
}

/**
 * Create the info profile `name`, or change some of its fields (`set`, `remove`; the others keep their values). The
 * values from before are recorded as a version first. Refused, nothing changed: without a usable key, for a bad name
 * or field name, a value over INFO_VALUE_MAX or holding a secret's value, a profile left with no field, more than
 * INFO_FIELDS_MAX. `by` says who (`console: <login>`, `assistant in <chat>`). Values are kept as given, trimmed; an
 * empty one is refused (taking a field out is `remove`).
 */
export function writeInfo(db: Db, src: SecretSource, name: string, change: InfoChange, by: string, now = Date.now()): { created: boolean; changed: string[]; fields: string[] } | { error: string } {
  if (!PROFILE_NAME.test(name)) return { error: `"${name.slice(0, 40)}" is not a name for personal info: letters, digits, _ and -, up to 64.` };
  const problem = keyProblem(src);
  if (problem) return { error: `Personal info cannot be kept here: ${problem}.` };
  const set: Record<string, string> = {};
  for (const [k, v0] of Object.entries(change.set)) {
    if (!VAR_NAME.test(k)) return { error: `"${k.slice(0, 40)}" is not a field name (letters, digits and _, not starting with a digit).` };
    const v = v0.replace(/\r\n?/g, "\n").trim();
    if (!v) return { error: `${k} has no value (to take a field out, remove it).` };
    set[k] = v;
  }
  const red = redactionFor(db, src);
  for (const [k, v] of Object.entries(set)) {
    const why = refuseValue(red, k, v);
    if (why) return { error: why };
  }
  const old = rowOf(db, name);
  let before: Record<string, string> = {};
  if (old) {
    try {
      before = open(src.key!, name, old.sealed, "info");
    } catch {
      return { error: `"${name}" is kept under another SHUVI_SECRETS_KEY and cannot be opened to be changed.` };
    }
  }
  const remove = change.remove ?? [];
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(before)) if (!remove.includes(k)) next[k] = set[k] ?? v;
  for (const [k, v] of Object.entries(set)) if (!(k in next) && !remove.includes(k)) next[k] = v;
  if (!Object.keys(next).length) return { error: old ? `That would leave ${name} with no fields; delete it instead.` : "Give at least one field and its value." };
  if (Object.keys(next).length > INFO_FIELDS_MAX) return { error: `A profile holds at most ${INFO_FIELDS_MAX} fields.` };
  const changed = [...new Set([...Object.keys(next), ...Object.keys(before)])].filter((k) => next[k] !== before[k]);
  if (old && !changed.length) return { created: false, changed: [], fields: Object.keys(next) };
  const at = new Date(now).toISOString();
  const sealed = seal(src.key!, name, next, "info");
  let id: number;
  if (old) {
    db.update(secretProfiles).set({ varNames: Object.keys(next), sealed, updatedAt: at }).where(eq(secretProfiles.id, old.id)).run();
    id = old.id;
  } else {
    id = db.insert(secretProfiles).values({ kind: "info", name, varNames: Object.keys(next), sealed, createdAt: at, updatedAt: at }).returning({ id: secretProfiles.id }).get().id;
  }
  record(db, src, id, name, before, changed, by, at);
  return { created: !old, changed, fields: Object.keys(next) };
}

export interface InfoVersion {
  id: number;
  /** The values before the change (`{}`: the change made the profile); absent when they cannot be opened. */
  before?: Record<string, string>;
  fields: string[];
  changed: string[];
  by: string;
  at: string;
}

/** The recorded versions of info profile `name`, newest first. */
export function infoHistory(db: Db, src: SecretSource, name: string): InfoVersion[] {
  const r = rowOf(db, name);
  if (!r) return [];
  return db
    .select()
    .from(infoVersions)
    .where(eq(infoVersions.profileId, r.id))
    .orderBy(desc(infoVersions.id))
    .all()
    .map((v) => {
      let before: Record<string, string> | undefined;
      if (src.key) {
        try {
          before = open(src.key, name, v.sealed, "info");
        } catch {
          before = undefined;
        }
      }
      return { id: v.id, ...(before ? { before } : {}), fields: v.varNames, changed: v.changed, by: v.by, at: v.at };
    });
}

/**
 * Put info profile `name` back to the values it had before version `versionId`'s change, every field (one it did
 * not have then is taken out). Recorded as a change itself, so it can be undone the same way.
 */
export function restoreInfo(db: Db, src: SecretSource, name: string, versionId: number, by: string, now = Date.now()): { changed: string[]; at: string } | { error: string } {
  const v = infoHistory(db, src, name).find((x) => x.id === versionId);
  if (!v) return { error: `There is no such version of ${name}.` };
  if (!v.before) return { error: `That version of ${name} cannot be opened with SHUVI_SECRETS_KEY.` };
  if (!Object.keys(v.before).length) return { error: `That is when ${name} was made: it had nothing before. Delete it instead.` };
  const cur = getInfo(db, src, name);
  const remove = (cur?.fields ?? []).filter((f) => !(f in v.before!));
  const r = writeInfo(db, src, name, { set: v.before, remove }, by, now);
  return "error" in r ? r : { changed: r.changed, at: v.at };
}

/** Delete info profile `name` and its history (its note is the caller's: console/secrets-write.ts deletes it). */
export function deleteInfo(db: Db, name: string): { deleted: boolean } {
  const r = rowOf(db, name);
  if (!r) return { deleted: false };
  db.delete(infoVersions).where(eq(infoVersions.profileId, r.id)).run();
  db.delete(secretProfiles).where(eq(secretProfiles.id, r.id)).run();
  return { deleted: true };
}

/**
 * Turn the console's secret `name` into personal info, as the module header says: refused when an info profile has
 * the name, when it cannot be opened, when a secret's values cannot all be known (the file unusable, a profile that
 * does not open: one of them might hold the same value), when a value holds another secret's, and when the known file
 * cannot be written. Its grants are the caller's to revoke, in the same transaction.
 */
export function makeInfo(db: Db, src: SecretSource, name: string, by: string, now = Date.now()): { fields: string[]; kept: number } | { error: string } {
  const problem = keyProblem(src);
  if (problem) return { error: `Nothing can be changed here: ${problem}.` };
  const row = db.select().from(secretProfiles).where(and(SECRET, eq(secretProfiles.name, name))).get();
  if (!row) return { error: `There is no secret ${name} kept here.` };
  if (rowOf(db, name)) return { error: `There is personal info named ${name} already; delete or rename one of them first.` };
  let vars: Record<string, string>;
  try {
    vars = open(src.key!, name, row.sealed);
  } catch {
    return { error: `"${name}" is kept under another SHUVI_SECRETS_KEY and cannot be opened.` };
  }
  const all = allProfiles(db, src);
  if ("error" in all) return { error: `The secrets file cannot be used (${all.error}), so it cannot be told whether another secret holds the same values. Nothing was changed.` };
  if (all.unreadable.length) return { error: `Some secrets cannot be opened now (${all.unreadable.map((u) => u.name).join(", ")}), so it cannot be told whether one holds the same values. Nothing was changed.` };
  // A secrets-file profile of this name hides this one: what is given out under the name is the file's, and its grants
  // are the file's to keep.
  if (all.shadowed.includes(name)) return { error: `The secrets file has a secret named ${name}, which hides this one; delete this one instead. Nothing was changed.` };
  // A value another secret holds now, or any other profile ever held, stays in the known file, and so stays redacted
  // wherever she reads it (info_read).
  const holders = new Map<string, string>();
  for (const [p, v] of Object.entries(all.profiles)) if (p !== name) for (const x of Object.values(v)) holders.set(x, p);
  const forgot = forgetValues(src.file, name, Object.values(vars), holders);
  if (!forgot) return { error: KNOWN_UNWRITABLE };
  const at = new Date(now).toISOString();
  db.update(secretProfiles).set({ kind: "info", sealed: seal(src.key!, name, vars, "info"), updatedAt: at }).where(eq(secretProfiles.id, row.id)).run();
  moveNote(db, name, "secret", "info");
  record(db, src, row.id, name, {}, Object.keys(vars), `${by} (made it personal info)`, at);
  return { fields: Object.keys(vars), kept: forgot.kept };
}

/**
 * Turn info profile `name` into a secret kept in the console: its values join the known file first (refused when they
 * cannot), its history is dropped, its note moves with it. Refused when a secret (the file's or the store's) has the
 * name, and when its note holds one of its values or another secret's (she would read it beside the secret's name:
 * the owner edits the note first). Grants left under the name (one to every chat that outlived a file profile of the
 * name) are the caller's to revoke, in the same transaction, so it starts with none.
 */
export function makeSecret(db: Db, src: SecretSource, name: string, now = Date.now()): { fields: string[] } | { error: string } {
  const problem = keyProblem(src);
  if (problem) return { error: `Nothing can be changed here: ${problem}.` };
  const row = rowOf(db, name);
  if (!row) return { error: `There is no personal info ${name}.` };
  const file = loadProfiles(src.file);
  if ("error" in file) return { error: `The secrets file cannot be used (${file.error}), so a new secret could not be redacted reliably. Nothing was changed.` };
  if (name in file.profiles) return { error: `The secrets file has a secret named ${name}; rename this one first.` };
  if (db.select({ id: secretProfiles.id }).from(secretProfiles).where(and(SECRET, eq(secretProfiles.name, name))).get()) return { error: `There is a secret named ${name} already; delete or rename one of them first.` };
  let vars: Record<string, string>;
  try {
    vars = open(src.key!, name, row.sealed, "info");
  } catch {
    return { error: `"${name}" is kept under another SHUVI_SECRETS_KEY and cannot be opened.` };
  }
  // Its note becomes a secret's note, which she reads: it must hold no secret value, its own values included.
  const note = getNote(db, name, "info");
  const red = redactionFor(db, src);
  for (const [what, text] of [["summary", note?.summary ?? ""], ["details", note?.details ?? ""]] as const) {
    if (!text) continue;
    const own = Object.entries(vars).find(([, v]) => v.length >= 4 && text.includes(v));
    const other = red.contains(Buffer.from(text, "utf8"));
    if (own || other) return { error: `Its note's ${what} holds ${own ? `the value of ${own[0]}` : `the value of the secret ${other === "?" ? "(cannot be checked)" : other}`}; a secret's note never holds a value. Edit the note first. Nothing was changed.` };
  }
  if (!rememberValues(src.file, { [name]: vars })) return { error: KNOWN_UNWRITABLE };
  db.delete(infoVersions).where(eq(infoVersions.profileId, row.id)).run();
  db.update(secretProfiles).set({ kind: "secret", sealed: seal(src.key!, name, vars), updatedAt: new Date(now).toISOString() }).where(eq(secretProfiles.id, row.id)).run();
  moveNote(db, name, "info", "secret");
  return { fields: Object.keys(vars) };
}

/** The note of info profile `name`: its summary, and what each field is (`varAbouts`). */
export const infoNote = (db: Db, name: string) => getNote(db, name, "info");
