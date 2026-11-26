import { statSync } from "node:fs";
import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "../store/db.ts";
import { secretProfiles } from "../store/schema.ts";
import { knownFile, loadProfiles, redactionOf, rememberValues, type Profiles, type Redaction } from "./redaction.ts";
import { open, parseKey, seal } from "./vault.ts";

/**
 * WHERE SECRET PROFILES COME FROM, the one reader every use goes through (a chat computer's exec, the redaction
 * of its output and of turn transcripts, a provider's API key, the console):
 *
 *   FILE      SHUVI_SECRETS_FILE (default /etc/shuvi.secrets.yaml, mode 600; redaction.ts `loadProfiles`), put
 *             there by whoever deploys shuvi (in production: infra's sops file). Read only, here and in the
 *             console.
 *   STORE     `secret_profiles`, which the owner keeps in the console (`putProfile`, `deleteProfile`): each
 *             profile's values sealed under SHUVI_SECRETS_KEY (vault.ts). Without the key, or with another one,
 *             their names are known and their values are not: they are left out (`unreadable` says which and
 *             why), and nothing can be added or changed.
 *
 * A name is the file's or the store's, never both: the console refuses a name the file holds, and if the file
 * gains one the store also has, the file's wins and the store's is listed as `shadowed`.
 *
 * Every value either holds, and every value either ever held, is redacted (`redactionFor`: the known file beside
 * SHUVI_SECRETS_FILE keeps them). A value the console replaces or deletes is added to the known file first, so it
 * stays redacted after it is gone.
 */

export interface SecretSource {
  /** SHUVI_SECRETS_FILE. */
  file: string;
  /** SHUVI_SECRETS_KEY, parsed; null when unset or unusable. */
  key: Uint8Array | null;
  /** Why SHUVI_SECRETS_KEY is set but cannot be used. */
  keyError?: string;
}

/** The source from the environment (env.ts and the computer's config both read it this way). */
export function secretSource(env: Record<string, string | undefined>, defaultFile: string): SecretSource {
  const k = parseKey(env.SHUVI_SECRETS_KEY);
  return { file: env.SHUVI_SECRETS_FILE || defaultFile, key: k.key, ...(k.error ? { keyError: k.error } : {}) };
}

/** Just a file, no key (tests, and callers that hold no store). */
export const fileSource = (file: string): SecretSource => ({ file, key: null });

/** Why the store's profiles cannot be read or changed now, or null. */
export function keyProblem(src: SecretSource): string | null {
  if (src.key) return null;
  return src.keyError ?? "SHUVI_SECRETS_KEY is not set";
}

export interface StoredProfile {
  name: string;
  vars: string[];
  updatedAt: string;
}

/** The store's profiles, names only (never a value), by name. */
export function storedProfiles(db: Db): StoredProfile[] {
  return db
    .select({ name: secretProfiles.name, vars: secretProfiles.varNames, updatedAt: secretProfiles.updatedAt })
    .from(secretProfiles)
    .orderBy(asc(secretProfiles.name))
    .all();
}

export interface AllProfiles {
  profiles: Profiles;
  /** Where each profile in `profiles` comes from. */
  from: Record<string, "file" | "store">;
  /** Store profiles left out: their values cannot be opened (no key, another key), with why. */
  unreadable: { name: string; why: string }[];
  /** Store profiles a file profile of the same name hides. */
  shadowed: string[];
}

/**
 * Every profile, the file's and the store's, or why the FILE cannot be used (as `loadProfiles`: then nothing is
 * given out, and redaction keeps to what it knew). A store profile that does not open is only left out.
 */
export function allProfiles(db: Db, src: SecretSource): AllProfiles | { error: string } {
  const file = loadProfiles(src.file);
  if ("error" in file) return file;
  const out: AllProfiles = { profiles: { ...file.profiles }, from: Object.fromEntries(Object.keys(file.profiles).map((n) => [n, "file" as const])), unreadable: [], shadowed: [] };
  const rows = db.select().from(secretProfiles).orderBy(asc(secretProfiles.name)).all();
  for (const r of rows) {
    if (r.name in file.profiles) {
      out.shadowed.push(r.name);
      continue;
    }
    if (!src.key) {
      out.unreadable.push({ name: r.name, why: keyProblem(src)! });
      continue;
    }
    try {
      out.profiles[r.name] = open(src.key, r.name, r.sealed);
      out.from[r.name] = "store";
    } catch (e) {
      out.unreadable.push({ name: r.name, why: `its values do not open with SHUVI_SECRETS_KEY (${e instanceof Error ? e.message : String(e)})` });
    }
  }
  return out;
}

/**
 * The names of the profiles that can be given out now, sorted, without opening any value (for the prompt): the
 * file's, and the store's when there is a key. A store profile under another key is listed, and fails when used.
 */
export function profileNames(db: Db, src: SecretSource): string[] {
  const file = loadProfiles(src.file);
  const names = new Set("profiles" in file ? Object.keys(file.profiles) : []);
  if (src.key) for (const p of storedProfiles(db)) names.add(p.name);
  return [...names].sort();
}

/** The redaction for every profile now, and every value either source ever held. */
export function redactionFor(db: Db, src: SecretSource): Redaction {
  return redactionOf(src.file, allProfiles(db, src));
}

/**
 * The redaction kept current for a long-lived reader (a turn's transcript): rebuilt when the file, its known file
 * or the store's profiles change (looked at most once per `checkMs`), so a secret added while a turn runs is
 * redacted from then on.
 */
export class LiveRedaction {
  private red: Redaction;
  private stamp: string;
  private checkedAt = 0;

  constructor(
    private readonly db: Db,
    readonly src: SecretSource,
    private readonly checkMs = 1000,
    private readonly now: () => number = Date.now,
  ) {
    this.stamp = this.stampNow();
    this.red = redactionFor(db, src);
    this.checkedAt = this.now();
  }

  private stampNow(): string {
    const m = (p: string) => {
      try {
        return String(statSync(p).mtimeMs);
      } catch {
        return "-";
      }
    };
    const s = this.db.select({ n: sql<number>`count(*)`, at: sql<string | null>`max(${secretProfiles.updatedAt})` }).from(secretProfiles).get();
    return `${m(this.src.file)}|${m(knownFile(this.src.file))}|${s?.n ?? 0}|${s?.at ?? "-"}`;
  }

  current(): Redaction {
    const t = this.now();
    if (t - this.checkedAt >= this.checkMs) {
      this.checkedAt = t;
      const stamp = this.stampNow();
      if (stamp !== this.stamp) {
        this.stamp = stamp;
        this.red = redactionFor(this.db, this.src);
      }
    }
    return this.red;
  }

  readonly redact = (s: string): string => this.current().redact(s);

  /** Why the file cannot be used now (a missing file is fine: no secrets), or null. */
  problem(): string | null {
    const r = loadProfiles(this.src.file);
    return "error" in r ? r.error : null;
  }
}

const KNOWN_UNWRITABLE = "The file of values to keep redacting (beside the secrets file) cannot be written, so a value going out would no longer be redacted. Nothing was changed; make that directory writable by shuvi.";

/** A profile name: letters, digits, `_` and `-` (no `.`: a provider's key is named `<profile>.<VAR>`). */
export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** A variable name, as an environment variable's. */
export const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse the console's `NAME=value` lines (blank lines and `#` comments skipped; the value is everything after the
 * first `=`, spaces around it trimmed, quotes kept as typed). Refusals name a line, never a value, and never what
 * stood before its `=` either: a value pasted without a name (a base64 token ends in `=`) would be that text.
 */
export function parseVars(text: string): { vars: Record<string, string> } | { error: string } {
  const vars: Record<string, string> = {};
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return { error: `Line ${i + 1} is not NAME=value.` };
    const name = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!VAR_NAME.test(name)) return { error: `Line ${i + 1} is not NAME=value: what comes before its "=" is not a variable name (letters, digits and _, not starting with a digit).` };
    // `TOKEN==`, `TOKEN=`: a base64 value pasted without a name, its padding taken for the `=` and the value. Neither
    // refusal names what came before the `=`: it may be that value.
    if (/^=+$/.test(value)) return { error: `Line ${i + 1} looks like a value without a name (it ends in "="): write it as NAME=value.` };
    if (!value) return { error: `Line ${i + 1} has nothing after its "=": write it as NAME=value.` };
    if (name in vars) return { error: `${name} is given twice.` };
    vars[name] = value;
  }
  if (!Object.keys(vars).length) return { error: "Give at least one NAME=value line." };
  return { vars };
}

/**
 * Add the profile `name` to the store, or replace its variables (all of them: what is not given is gone). The
 * values it held before are added to the known file first, so they stay redacted. Refused without a usable key,
 * for a name the file holds, and for a bad name.
 */
export function putProfile(db: Db, src: SecretSource, name: string, vars: Record<string, string>, now = Date.now()): { created: boolean } | { error: string } {
  if (!PROFILE_NAME.test(name)) return { error: `"${name.slice(0, 40)}" is not a profile name: letters, digits, _ and -, up to 64.` };
  const problem = keyProblem(src);
  if (problem) return { error: `Secrets cannot be kept here: ${problem}.` };
  const file = loadProfiles(src.file);
  if ("error" in file) return { error: `The secrets file cannot be used (${file.error}), so a new value could not be redacted reliably.` };
  if (name in file.profiles) return { error: `"${name}" is a profile of the secrets file (${src.file}); change it there, or use another name.` };
  for (const k of Object.keys(vars)) if (!VAR_NAME.test(k)) return { error: "A variable's name is not a variable name (letters, digits and _, not starting with a digit)." };
  const old = db.select().from(secretProfiles).where(eq(secretProfiles.name, name)).get();
  // Before anything changes: the values going out stay redacted, and so do the new ones from now on.
  if (old) {
    let before: Record<string, string>;
    try {
      before = open(src.key!, name, old.sealed);
    } catch {
      return { error: `"${name}" is kept under another SHUVI_SECRETS_KEY and cannot be opened to be replaced safely; delete it first.` };
    }
    if (!rememberValues(src.file, { [name]: before })) return { error: KNOWN_UNWRITABLE };
  }
  if (!rememberValues(src.file, { [name]: vars })) return { error: KNOWN_UNWRITABLE };
  const at = new Date(now).toISOString();
  const sealed = seal(src.key!, name, vars);
  if (old) db.update(secretProfiles).set({ varNames: Object.keys(vars), sealed, updatedAt: at }).where(eq(secretProfiles.id, old.id)).run();
  else db.insert(secretProfiles).values({ name, varNames: Object.keys(vars), sealed, createdAt: at, updatedAt: at }).run();
  return { created: !old };
}

/**
 * Change some of the variables of the store's profile `name`: `set` (a new value, or a new variable), `remove`
 * (taken out); the others keep their values. Refused when there would be none left (delete the profile instead),
 * and as `putProfile` refuses. The values going out stay redacted (`putProfile` remembers them).
 */
export function updateProfile(db: Db, src: SecretSource, name: string, change: { set: Record<string, string>; remove?: readonly string[] }, now = Date.now()): { vars: string[] } | { error: string } {
  const problem = keyProblem(src);
  if (problem) return { error: `Secrets cannot be kept here: ${problem}.` };
  const old = db.select().from(secretProfiles).where(eq(secretProfiles.name, name)).get();
  if (!old) return { error: `There is no profile ${name} kept here.` };
  let vars: Record<string, string>;
  try {
    vars = open(src.key!, name, old.sealed);
  } catch {
    return { error: `"${name}" is kept under another SHUVI_SECRETS_KEY and cannot be opened to be changed safely; delete it first.` };
  }
  // Order kept: the old variables where they were, new ones after.
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) if (!change.remove?.includes(k)) next[k] = change.set[k] ?? v;
  for (const [k, v] of Object.entries(change.set)) if (!(k in next) && !change.remove?.includes(k)) next[k] = v;
  if (!Object.keys(next).length) return { error: `That would leave ${name} with no variables; delete the profile instead.` };
  const r = putProfile(db, src, name, next, now);
  return "error" in r ? r : { vars: Object.keys(next) };
}

/**
 * Delete the store's profile `name`. Its values are added to the known file first when they can be opened (they
 * were added there whenever they were used, too); refused when they cannot be. Grants naming it are not touched
 * here: the console revokes them first (capabilities/computer/secrets.ts `revokeProfileGrants`), so a profile
 * added later under the same name starts with none.
 */
export function deleteProfile(db: Db, src: SecretSource, name: string): { deleted: boolean } | { error: string } {
  const old = db.select().from(secretProfiles).where(eq(secretProfiles.name, name)).get();
  if (!old) return { deleted: false };
  if (src.key) {
    let vars: Record<string, string> | null = null;
    try {
      vars = open(src.key, name, old.sealed);
    } catch {
      // Under another key: they were remembered when they were last used, if ever.
    }
    if (vars && !rememberValues(src.file, { [name]: vars })) return { error: KNOWN_UNWRITABLE };
  }
  db.delete(secretProfiles).where(eq(secretProfiles.id, old.id)).run();
  return { deleted: true };
}
