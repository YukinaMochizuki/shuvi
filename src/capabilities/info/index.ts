import { z } from "zod";
import { err, ok, type ToolDef } from "agent-runtime";
import { DEFAULT_SECRETS_FILE } from "../../env.ts";
import { getInfo, infoNames, infoProfiles, INFO_VALUE_MAX, writeInfo, type InfoProfile } from "../../secrets/info.ts";
import { allNotes, getNote, noteVarAbouts, setNote, SUMMARY_MAX, varAbouts } from "../../secrets/notes.ts";
import { redactionFor, secretSource, type SecretSource } from "../../secrets/source.ts";
import type { Db } from "../../store/db.ts";
import { chatLabel, IMMEDIATE } from "../../store/turns.ts";
import { defineCapability } from "../types.ts";
import { requestInfo } from "./request.ts";

/**
 * Personal info (src/secrets/info.ts, docs/design.md §15): what she READS about the owner to work with it (an
 * address to split into a form's fields or translate, a phone, an email, a member number), beside the secrets, which
 * she never sees. Its own capability, not the computer's: it needs no computer, and works in a chat without one.
 *
 *   tools     info_read (the values, what each field is, the note), info_write (create a profile or change some
 *             of its fields; each change recorded as a version, the owner sees and restores them in the console),
 *             request_info (a provide card: the owner types the values in the console; ./request.ts). All three
 *             act for the owner (`ownerOnly`) and NONE is delegable: personal info is the owner's, read and kept in
 *             turns he is in, in any chat, never an operator's. No grant is involved.
 *   section   the profiles' names and their notes' summaries, never a value (byte-stable: sorted, from the store),
 *             and how to use the tools; values are not said in a group unless the owner asks there.
 *   always    on in every chat whatever its policy says: the owner's own turns may read it anywhere (the tools'
 *             boundary keeps everyone else out).
 *
 * What it never does: give a value out as a secret (env, `browser_type` secret), or keep a secret's value (info_write
 * refuses one). What she reads with info_read passes the secrets' redaction, so a value a secret also holds (kept
 * when a secret was made personal info) stays hidden.
 *
 *   SHUVI_SECRETS_KEY    what personal info is sealed under (src/secrets/vault.ts); unset: this capability is off
 *   SHUVI_SECRETS_FILE   the secrets, whose values a write is checked against
 *   SHUVI_CONSOLE_URL    where request_info's card links to
 */

export interface InfoConfig {
  secrets: SecretSource;
  consoleUrl?: string;
}

export const INFO_TOOLS = ["info_read", "info_write", "request_info"] as const;

const INFO_HEAD = `## Personal info

The owner's personal info: data you READ to work with it (an address to split into a form's fields or translate, a phone, an email, a member number), kept by name. Unlike a secret, you see its values.
- \`info_read\` gives the values and what each field is. Read it when a task needs them; do not rely on remembering them from an earlier conversation, they may have changed.
- When the owner tells you something of this kind to keep, or that one has changed (a new address, a new phone), keep it with \`info_write\`: one profile per thing (home-address, phone), one field per part (POSTCODE, CITY, STREET), with what each field is. Each change is recorded; he sees and can undo it in the console.
- When a task needs one nobody has told you, \`request_info\` asks him to type it on his phone; do not guess.
- Passwords, ID numbers, tokens and anything you should only type, never read, are secrets, not personal info (\`request_secret\`); info_write refuses a secret's value.
- In a group, never say a value unless the owner asks for it there.`;

/** The section: the head, and each profile's name with its note's summary (never a value), sorted. */
export function infoSection(names: readonly string[], summaries: ReadonlyMap<string, string>): string {
  if (!names.length) return `${INFO_HEAD}\n- There is none yet.`;
  const lines = names.map((n) => `\n  - ${n}${summaries.get(n) ? `: ${summaries.get(n)}` : ""}`);
  return `${INFO_HEAD}\n- There is:${lines.join("")}`;
}

/** One profile as info_read gives it. */
function describe(p: InfoProfile, note: ReturnType<typeof getNote>): string {
  const abouts = varAbouts(note);
  const head = [`## ${p.name}`, ...(note?.summary ? [`Summary: ${note.summary}`] : [])];
  if (!p.values) return [...head, `(its values cannot be read now: ${p.unreadable ?? "they do not open"}; tell the owner)`].join("\n");
  const fields = p.fields.map((f) => {
    const v = p.values![f] ?? "";
    const value = v.includes("\n") ? `\n    ${v.split("\n").join("\n    ")}` : ` ${v}`;
    return `- ${f}${abouts[f] ? ` (${abouts[f]})` : ""}:${value}`;
  });
  // The note's own lines besides the field lines (`- NAME: ...`), which are shown with the fields above.
  const rest = (note?.details ?? "")
    .split("\n")
    .filter((l) => !/^- [A-Za-z_][A-Za-z0-9_]*: /.test(l.trim()) && l.trim() !== "Variables:" && l.trim() !== "Fields:")
    .join("\n")
    .trim();
  return [...head, "Fields:", ...fields, ...(rest ? ["Note:", rest] : []), `(last changed ${p.updatedAt.slice(0, 16).replace("T", " ")} UTC)`].join("\n");
}

const fieldSchema = z.object({
  name: z.string().min(1).max(64).describe("The field's name: letters, digits and _, e.g. POSTCODE"),
  about: z.string().max(120).optional().describe("What it is, in the owner's language, e.g. 郵遞區號"),
  value: z.string().min(1).max(INFO_VALUE_MAX).describe("Its value"),
});

export const info = defineCapability<InfoConfig>({
  id: "info",
  label: "personal info (owner only)",
  gives: "the owner's personal info (address, phone, member numbers): read, keep, ask for.",
  always: true,
  // Nothing can be kept without the key it is sealed under: without SHUVI_SECRETS_KEY there is no personal info.
  enable: (env) => (env.SHUVI_SECRETS_KEY?.trim() ? { secrets: secretSource(env, DEFAULT_SECRETS_FILE), ...(env.SHUVI_CONSOLE_URL?.trim() ? { consoleUrl: env.SHUVI_CONSOLE_URL.trim() } : {}) } : null),
  ownerOnly: [...INFO_TOOLS],
  tools({ db, chat }, cfg) {
    const src = cfg.secrets;
    const readTool: ToolDef<{ name?: string }> = {
      name: "info_read",
      description:
        "Read the owner's personal info: each profile's fields with their values and what each one is, and its note. Give `name` for one profile, or omit it for all. Use the values for the task at hand (fill a form, write a letter, translate an address); in a group, do not say them unless the owner asks there.",
      inputSchema: { name: z.string().optional().describe("One profile, e.g. home-address; omit for all") },
      async handler(a) {
        const all = infoProfiles(db, src);
        const pick = a.name ? all.filter((p) => p.name === a.name) : all;
        if (!pick.length) return a.name ? err(`There is no personal info "${a.name}". There is: ${all.map((p) => p.name).join(", ") || "none"}. To ask the owner for it, use request_info.`) : ok("There is no personal info yet. Keep what the owner tells you with info_write, or ask him with request_info.");
        const text = pick.map((p) => describe(p, getNote(db, p.name, "info"))).join("\n\n");
        // A value a secret also holds (a secret made personal info, sharing a value with another) stays hidden.
        const red = redactionFor(db, src);
        return ok(red.ok ? red.redact(text) : text);
      },
    };

    const writeTool: ToolDef<{ name: string; fields?: { name: string; about?: string; value: string }[]; remove?: string[]; summary?: string }> = {
      name: "info_write",
      description:
        "Keep the owner's personal info: create a profile, or change some of its fields (the others keep their values). `fields`: each field to set, its name, what it is and its value; `remove`: fields to take out; `summary`: one line on what the profile is, shown beside its name in your prompt (never a value in it). " +
        "Only what the owner told you, or asked you to keep. Each change is recorded with the values before it, so he can see and undo it in the console. A secret's value (a password, a token) is refused: ask for those with request_secret.",
      inputSchema: {
        name: z.string().min(1).max(64).describe("The profile's name: letters, digits, _ and -, e.g. home-address"),
        fields: z.array(fieldSchema).max(40).optional().describe("Fields to set"),
        remove: z.array(z.string()).max(40).optional().describe("Fields to take out"),
        summary: z.string().max(SUMMARY_MAX).optional().describe("One line: what this profile is (never a value)"),
      },
      async handler(a) {
        const set: Record<string, string> = {};
        const abouts: Record<string, string> = {};
        for (const f of a.fields ?? []) {
          if (f.name in set) return err(`${f.name} is given twice.`);
          set[f.name] = f.value;
          if (f.about) abouts[f.name] = f.about;
        }
        if (!Object.keys(set).length && !a.remove?.length && a.summary === undefined) return err("Give the fields to set (`fields`), to take out (`remove`), or a `summary`.");
        const by = `assistant in ${chatLabel(chat)}`;
        if (a.summary !== undefined && /[\r\n]/.test(a.summary)) return err("The summary is one line.");
        // Read, merge and write in one IMMEDIATE transaction: an edit made meanwhile in the console (another process)
        // is either before all of it or after, never lost between the read and the write.
        const out = db.transaction((tx): { error: string } | { text: string } => {
          const tdb = tx as unknown as Db;
          const existed = !!getInfo(tdb, src, a.name);
          if (!existed && !Object.keys(set).length) return { error: `There is no personal info "${a.name}" yet: give its fields to create it.` };
          let changed: string[] = [];
          if (Object.keys(set).length || a.remove?.length) {
            const w = writeInfo(tdb, src, a.name, { set, remove: a.remove ?? [] }, by);
            if ("error" in w) return w;
            changed = w.changed;
          }
          const notes: string[] = [];
          const nr = noteVarAbouts(tdb, src, a.name, abouts, a.remove ?? [], by, Date.now(), "info");
          if (nr) notes.push(`What each field is was not kept: ${nr.error}`);
          if (a.summary !== undefined) {
            const s = setNote(tdb, src, a.name, { summary: a.summary }, by, Date.now(), "info");
            if ("error" in s) notes.push(`The summary was not kept: ${s.error}`);
          }
          const what = !existed ? `Created "${a.name}" (${changed.join(", ")})` : changed.length ? `Changed ${changed.join(", ")} of "${a.name}"` : `Nothing changed in the values of "${a.name}"`;
          return { text: `${what}.${changed.length ? " The values before are kept in its history; the owner can undo it in the console." : ""}${notes.length ? ` ${notes.join(" ")}` : ""}` };
        }, IMMEDIATE);
        return "error" in out ? err(out.error) : ok(out.text);
      },
    };

    const requestTool: ToolDef<{ name: string; fields: { name: string; about?: string }[]; reason: string }> = {
      name: "request_info",
      description:
        "Ask the owner for personal info nobody has told you (a new profile, or new values for some fields of one): he gets a card with a link and types the values in the console. Only the fields asked for change. His answer arrives here as an approval event; end your turn after asking. For a password or an ID number you should only type, use request_secret instead.",
      inputSchema: {
        name: z.string().min(1).max(64).describe("The profile's name, e.g. home-address"),
        fields: z.array(z.object({ name: z.string().min(1).max(64).describe("The field's name, e.g. POSTCODE"), about: z.string().max(120).optional().describe("What it is, in the owner's language") })).min(1).max(10),
        reason: z.string().min(1).describe("Why you need it, in a sentence the owner reads"),
      },
      async handler(a) {
        const r = requestInfo(db, src, { chatId: chat.id, name: a.name, fields: a.fields, reason: a.reason, ...(cfg.consoleUrl ? { consoleUrl: cfg.consoleUrl } : {}) });
        if ("error" in r) return err(r.error);
        return ok(`Asked the owner for ${r.update ? "new values in" : "the personal info"} "${a.name}" (${a.fields.map((f) => f.name).join(", ")}), approval #${r.approvalId}: he types them in the console. His answer comes back to this chat as an approval event. End your turn now; do not wait for it.`);
      },
    };

    return [{ serverName: "shuvi", tools: [readTool, writeTool, requestTool] as ToolDef[] }];
  },
  section: (ctx) => {
    if (!ctx.db) return infoSection([], new Map());
    const notes = allNotes(ctx.db, "info");
    return infoSection(infoNames(ctx.db), new Map([...notes].map(([n, x]) => [n, x.summary])));
  },
});
