import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../store/db.ts";
import { secretNotes, secretProfiles } from "../store/schema.ts";
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
 *
 * A PERSONAL-INFO profile (info.ts) has a note too, kept apart by its kind (`NoteKind`): its summary is in her prompt
 * beside its name, and its `- NAME: what it is` lines say what each field is. Every function here takes the kind,
 * a secret's by default.
 */

export type NoteKind = "secret" | "info";

export const SUMMARY_MAX = 200;
export const DETAILS_MAX = 8000;

export type SecretNote = typeof secretNotes.$inferSelect;

/** Every note, by name. */
export function allNotes(db: Db, kind: NoteKind = "secret"): Map<string, SecretNote> {
  return new Map(db.select().from(secretNotes).where(eq(secretNotes.kind, kind)).orderBy(asc(secretNotes.name)).all().map((n) => [n.name, n]));
}

export function getNote(db: Db, name: string, kind: NoteKind = "secret"): SecretNote | undefined {
  return db.select().from(secretNotes).where(and(eq(secretNotes.kind, kind), eq(secretNotes.name, name))).get();
}

/**
 * Whether `name` is a profile of `kind` now (a secret: the file's, or one kept in the store; personal info: one kept
 * in the store), without opening any value.
 */
export function isProfile(db: Db, src: SecretSource, name: string, kind: NoteKind = "secret"): boolean {
  if (kind === "info") return !!db.select({ id: secretProfiles.id }).from(secretProfiles).where(and(eq(secretProfiles.kind, "info"), eq(secretProfiles.name, name))).get();
  const file = loadProfiles(src.file);
  if ("profiles" in file && name in file.profiles) return true;
  return storedProfiles(db).some((p) => p.name === name);
}

/**
 * Set the note of profile `name`: `summary` and/or `details`, each replacing what was there (undefined: kept).
 * `by` says who (`console`, `console: <login>`, `assistant in <chat>`). Refuses a name that is no profile, a
 * summary over one line or SUMMARY_MAX, details over DETAILS_MAX, and anything holding a secret value.
 */
export function setNote(db: Db, src: SecretSource, name: string, a: { summary?: string; details?: string }, by: string, now = Date.now(), kind: NoteKind = "secret"): { note: SecretNote } | { error: string } {
  if (!isProfile(db, src, name, kind)) return { error: kind === "info" ? `There is no personal info "${name.slice(0, 64)}".` : `There is no secret profile "${name.slice(0, 64)}".` };
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
  const old = getNote(db, name, kind);
  const row = { summary: summary ?? old?.summary ?? "", details: details ?? old?.details ?? "", updatedBy: by, updatedAt: at };
  if (old) db.update(secretNotes).set(row).where(and(eq(secretNotes.kind, kind), eq(secretNotes.name, name))).run();
  else db.insert(secretNotes).values({ kind, name, ...row }).run();
  return { note: getNote(db, name, kind)! };
}

/**
 * What each variable is, as the note's details say it: lines `- NAME: what it is` (how a provide card writes them,
 * and the console's fields). Other lines are the note's own and are left alone.
 */
export function varAbouts(note: Pick<SecretNote, "details"> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (note?.details ?? "").split("\n")) {
    const m = /^- ([A-Za-z_][A-Za-z0-9_]*): (.+)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

/**
 * The note's details with each variable's line set (`abouts`: what it is) or taken out (`removed`), in a
 * `Variables:` list at the top (made when there is none); every other line kept as it was.
 */
export function withVarAbouts(details: string, abouts: Record<string, string>, removed: readonly string[] = []): string {
  const lines = details ? details.split("\n") : [];
  const isVar = (l: string) => /^- [A-Za-z_][A-Za-z0-9_]*(: .*)?$/.test(l.trim());
  const nameOf = (l: string) => /^- ([A-Za-z_][A-Za-z0-9_]*)/.exec(l.trim())?.[1];
  const kept = lines.filter((l) => !(isVar(l) && removed.includes(nameOf(l)!)));
  const done = new Set<string>();
  const out = kept.map((l) => {
    const n = isVar(l) ? nameOf(l) : undefined;
    if (n && n in abouts) {
      done.add(n);
      return `- ${n}: ${abouts[n]}`;
    }
    return l;
  });
  const missing = Object.entries(abouts).filter(([n]) => !done.has(n)).map(([n, a]) => `- ${n}: ${a}`);
  if (!missing.length) return out.join("\n");
  const header = out.findIndex((l) => l.trim() === "Variables:");
  if (header < 0) return ["Variables:", ...missing, ...(out.length ? ["", ...out] : [])].join("\n");
  let at = header + 1;
  while (at < out.length && isVar(out[at]!)) at++;
  out.splice(at, 0, ...missing);
  return out.join("\n");
}

/**
 * Keep what each variable is in the profile's note (the console's fields, a provide card's `about`): its lines set
 * or taken out, nothing else of the note changed. Not when there is nothing to change. A refusal (a value in it) is
 * the caller's to show.
 */
export function noteVarAbouts(db: Db, src: SecretSource, name: string, abouts: Record<string, string>, removed: readonly string[], by: string, now = Date.now(), kind: NoteKind = "secret"): { error: string } | null {
  const clean = Object.fromEntries(Object.entries(abouts).map(([k, v]) => [k, v.replace(/\s+/g, " ").trim()]).filter(([, v]) => v));
  if (!Object.keys(clean).length && !removed.length) return null;
  const note = getNote(db, name, kind);
  const details = withVarAbouts(note?.details ?? "", clean, removed);
  if (details === (note?.details ?? "")) return null;
  const r = setNote(db, src, name, { details }, by, now, kind);
  return "error" in r ? r : null;
}

export function deleteNote(db: Db, name: string, kind: NoteKind = "secret"): void {
  db.delete(secretNotes).where(and(eq(secretNotes.kind, kind), eq(secretNotes.name, name))).run();
}

/** Move the note of `name` from one kind to the other (a profile changing kind); one already there is replaced. */
export function moveNote(db: Db, name: string, from: NoteKind, to: NoteKind): void {
  if (from === to || !getNote(db, name, from)) return;
  deleteNote(db, name, to);
  db.update(secretNotes).set({ kind: to }).where(and(eq(secretNotes.kind, from), eq(secretNotes.name, name))).run();
}
