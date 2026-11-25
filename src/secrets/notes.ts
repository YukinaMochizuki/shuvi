import { asc, eq } from "drizzle-orm";
import type { Db } from "../store/db.ts";
import { secretNotes } from "../store/schema.ts";
import { loadProfiles } from "./redaction.ts";
import { redactionFor, storedProfiles, type SecretSource } from "./source.ts";

/**
 * NOTES on secret profiles (`secret_notes`): what the assistant knows about a profile, so she need not find it out
 * again. They are NOT secret: the owner reads and edits them in the console, and she reads them.
 *
 *   SUMMARY   one line (at most SUMMARY_MAX characters), in her prompt beside the profile's name
 *             (capabilities/computer/index.ts): what it is for, so she knows it is there.
 *   DETAILS   up to DETAILS_MAX characters, read with `secret_info`: its scope, the accounts or org ids it acts on,
 *             how to use it, what was tried and failed.
 *
 * Written by the owner in the console, or by her with `update_secret_note` (owner-only: only in a turn he
 * started). Either replaces what it gives (summary, details or both) whole. A note is refused when it holds the
 * value of any secret (every value redaction knows, now or ever), or when nothing can be checked (redaction
 * unusable), so a token is never copied into one. A note is kept by the profile's name: deleting a profile kept in
 * the console deletes its note (console/secrets-write.ts); a profile the secrets file drops keeps its note, shown
 * again if the file gains it back.
 */

export const SUMMARY_MAX = 200;
export const DETAILS_MAX = 8000;

export type SecretNote = typeof secretNotes.$inferSelect;

/** Every note, by name. */
export function allNotes(db: Db): Map<string, SecretNote> {
  return new Map(db.select().from(secretNotes).orderBy(asc(secretNotes.name)).all().map((n) => [n.name, n]));
}

export function getNote(db: Db, name: string): SecretNote | undefined {
  return db.select().from(secretNotes).where(eq(secretNotes.name, name)).get();
}

/** Whether `name` is a profile now (the file's, or one kept in the store), without opening any value. */
export function isProfile(db: Db, src: SecretSource, name: string): boolean {
  const file = loadProfiles(src.file);
  if ("profiles" in file && name in file.profiles) return true;
  return storedProfiles(db).some((p) => p.name === name);
}

/**
 * Set the note of profile `name`: `summary` and/or `details`, each replacing what was there (undefined: kept).
 * `by` says who (`console`, `console: <login>`, `assistant in <chat>`). Refuses a name that is no profile, a
 * summary over one line or SUMMARY_MAX, details over DETAILS_MAX, and anything holding a secret value.
 */
export function setNote(db: Db, src: SecretSource, name: string, a: { summary?: string; details?: string }, by: string, now = Date.now()): { note: SecretNote } | { error: string } {
  if (!isProfile(db, src, name)) return { error: `There is no secret profile "${name.slice(0, 64)}".` };
  const summary = a.summary?.trim();
  const details = a.details?.replace(/\r\n?/g, "\n").trim();
  if (summary === undefined && details === undefined) return { error: "Give a summary, details, or both." };
  if (summary !== undefined && /[\r\n\u2028\u2029]/.test(summary)) return { error: "The summary is one line." };
  if (summary !== undefined && summary.length > SUMMARY_MAX) return { error: `The summary is ${summary.length} characters; at most ${SUMMARY_MAX}.` };
  if (details !== undefined && details.length > DETAILS_MAX) return { error: `The details are ${details.length} characters; at most ${DETAILS_MAX}.` };
  const red = redactionFor(db, src);
  for (const [what, text] of [["summary", summary], ["details", details]] as const) {
    if (!text) continue;
    const leaked = red.contains(Buffer.from(text, "utf8"));
    if (leaked === "?") return { error: `The note cannot be checked for secret values (${red.why}), so it was not saved.` };
    if (leaked) return { error: `The ${what} holds the value of the secret profile "${leaked}"; a note never holds a secret value. Nothing was saved.` };
  }
  const at = new Date(now).toISOString();
  const old = getNote(db, name);
  const row = { summary: summary ?? old?.summary ?? "", details: details ?? old?.details ?? "", updatedBy: by, updatedAt: at };
  if (old) db.update(secretNotes).set(row).where(eq(secretNotes.name, name)).run();
  else db.insert(secretNotes).values({ name, ...row }).run();
  return { note: getNote(db, name)! };
}

export function deleteNote(db: Db, name: string): void {
  db.delete(secretNotes).where(eq(secretNotes.name, name)).run();
}
