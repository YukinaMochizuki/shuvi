import { POLICY_FILE } from "./load.ts";
import { checkEntry, DM_DEFAULT, entryToDoc, parsePolicy, type Policy } from "./policy.ts";
import { applyChange } from "./write.ts";

/**
 * Replacing ONE chat's entry in `home/policy.yaml` as TEXT, for the owner's own edits from the console
 * (console/chat-settings-write.ts). Everything outside that entry is kept byte for byte: the comments, the
 * other chats' entries, the order, the quoting. Only the entry's own lines are written again (from its
 * parsed form, with Bun's YAML writer, as ./write.ts writes a whole file), under its key line, which is
 * kept as it was (an inline comment on it included). A chat not listed yet is added at the end of `chats`.
 *
 * When the file is laid out in a way this cannot edit in place (no file yet, `chats` written inline as
 * `chats: {...}`, a key that is not on a line of its own), the file is written whole from its parsed form,
 * as ./write.ts does, and the answer says that its comments are not kept (`rewritten`).
 *
 * The result is checked before anyone sees it: it must parse as a valid policy (policy.ts), the edited entry
 * must read back as exactly the entry asked for, and every OTHER chat's entry, and the file's other keys, must
 * say exactly what they said before. An in-place edit that fails any of these (a duplicate key, a key written
 * `-0100:` that reads as "-100", an alias into the lines it replaced) falls back to the whole-file rewrite; if
 * even that would not read back as asked, it is refused with the reason. A key this cannot decode is refused,
 * never guessed. Pure: no file is read or written here.
 */

export interface EntryEdit {
  text: string;
  /** The file was written whole from its parsed form: comments in it are gone. */
  rewritten: boolean;
}

const KEY_LINE = /^(\s+)("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#:'"][^#:]*?)\s*:(.*)$/;
const indentOf = (l: string) => /^\s*/.exec(l)![0].length;
const blankOrComment = (l: string) => /^\s*(#.*)?$/.test(l);
/** A key as written, decoded the way the YAML reader reads it (`-0100:` is "-100"); null when it cannot be. */
const unquote = (k: string): string | null => {
  try {
    const doc = Bun.YAML.parse(`${k.trim()}: 0`) as unknown;
    const keys = doc && typeof doc === "object" && !Array.isArray(doc) ? Object.keys(doc) : [];
    return keys.length === 1 ? keys[0]! : null;
  } catch {
    return null;
  }
};

/** A scalar as YAML: plain when it reads back as the same string, else quoted. */
function scalar(v: unknown): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null || v === undefined) return "null";
  const s = String(v);
  if (/^[A-Za-z_][\w .\-/]*$/.test(s) && !/\s$/.test(s) && !/^(true|false|null|yes|no|on|off|~)$/i.test(s)) {
    try {
      if ((Bun.YAML.parse(`k: ${s}`) as { k: unknown }).k === s) return s;
    } catch {}
  }
  return JSON.stringify(s);
}

const flat = (v: unknown) => v === null || typeof v !== "object";

/** A value inline: `[a, b]`, `{}`, `{ k: [x] }`; null when it is not simple enough to write on one line. */
function inline(v: unknown): string | null {
  if (flat(v)) return scalar(v);
  if (Array.isArray(v)) return v.every(flat) ? `[${v.map(scalar).join(", ")}]` : null;
  const es = Object.entries(v as Record<string, unknown>);
  if (!es.length) return "{}";
  const parts = es.map(([k, x]) => (flat(x) || (Array.isArray(x) && x.every(flat)) ? `${scalar(k)}: ${inline(x)}` : null));
  return parts.every((p) => p !== null) ? `{ ${parts.join(", ")} }` : null;
}

/**
 * `doc` as block YAML in the hand-written style of policy.yaml (policy.ts's header): lists of names in flow style
 * (`[mention, reply]`), a capability's parameters inline (`workstream: { products: [widgetry] }`).
 */
function yamlLines(doc: Record<string, unknown>, indent: number): string[] {
  const pad = " ".repeat(indent);
  const out: string[] = [];
  for (const [k, v] of Object.entries(doc)) {
    const one = flat(v) || Array.isArray(v) || Object.keys(v as object).length === 0 ? inline(v) : null;
    if (one !== null) out.push(`${pad}${scalar(k)}: ${one}`);
    else if (Array.isArray(v)) out.push(`${pad}${scalar(k)}:`, ...v.map((x) => `${pad}  - ${inline(x) ?? JSON.stringify(x)}`));
    else {
      out.push(`${pad}${scalar(k)}:`);
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        const i2 = inline(v2);
        if (i2 !== null) out.push(`${pad}  ${scalar(k2)}: ${i2}`);
        else out.push(`${pad}  ${scalar(k2)}:`, ...yamlLines(v2 as Record<string, unknown>, indent + 4));
      }
    }
  }
  return out;
}

/** A line without its trailing comment and spaces, to tell a line that only carries a comment from a changed one. */
const bare = (l: string) => l.replace(/\s+#[^"']*$/, "").trimEnd();

/** A line's key, with its indentation (`    trigger`), to place the comments above it; null for a list item. */
const keyOf = (l: string) => /^(\s*)([^\s#:-][^#:]*?)\s*:/.exec(l)?.slice(1, 3).join("") ?? null;

/**
 * The entry written under its key: `doc` as YAML, each line indented by `indent`. A line that says what a line of
 * the entry already said is that line as it was, its comment and spacing included; comment (and blank) lines stay
 * above the key they were above, whatever it now says; those after the last line stay at the end. A comment above
 * a key the entry no longer has goes with it.
 */
function entryLines(doc: Record<string, unknown>, indent: number, old: string[] = []): string[] {
  const byBare = new Map<string, string[]>();
  const above = new Map<string, string[]>();
  let pending: string[] = [];
  for (const l of old) {
    if (blankOrComment(l)) {
      pending.push(l);
      continue;
    }
    byBare.set(bare(l), [...(byBare.get(bare(l)) ?? []), l]);
    const k = keyOf(l);
    if (k !== null && !above.has(k)) above.set(k, pending);
    pending = [];
  }
  const out: string[] = [];
  for (const l of yamlLines(doc, indent)) {
    const k = keyOf(l);
    if (k !== null && above.has(k)) {
      out.push(...above.get(k)!);
      above.delete(k);
    }
    out.push(byBare.get(l)?.shift() ?? l);
  }
  return [...out, ...pending];
}

/** Where `key`'s entry sits in the lines of `chats`: its key line and the line after its last one. */
function locate(lines: string[], key: string): { chatsAt: number; end: number; childIndent: number | null; at?: { line: number; end: number; inline: boolean } } | { error: string } | null {
  const chatsAt = lines.findIndex((l) => /^chats\s*:\s*(#.*)?$/.test(l));
  if (chatsAt < 0) return null;
  let end = lines.length;
  for (let i = chatsAt + 1; i < lines.length; i++) {
    if (!blankOrComment(lines[i]!) && indentOf(lines[i]!) === 0) {
      end = i;
      break;
    }
  }
  // Trailing blank lines and comments at the top level belong to what follows, not to `chats`.
  while (end > chatsAt + 1 && blankOrComment(lines[end - 1]!) && (lines[end - 1]!.trim() === "" || indentOf(lines[end - 1]!) === 0)) end--;
  let childIndent: number | null = null;
  const seen = new Set<string>();
  let found: { line: number; end: number; inline: boolean } | undefined;
  for (let i = chatsAt + 1; i < end; i++) {
    const l = lines[i]!;
    if (blankOrComment(l)) continue;
    childIndent ??= indentOf(l);
    if (indentOf(l) !== childIndent) continue;
    const m = KEY_LINE.exec(l);
    if (!m) return null; // `chats` holds something that is not a mapping of keys: not ours to edit in place
    const name = unquote(m[2]!);
    if (name === null) return { error: `${POLICY_FILE} has a key under chats this cannot read (${l.trim()}); fix it on the machine shuvi runs on first` };
    // Two lines naming one chat: which one the reader keeps is not ours to guess, so not edited in place.
    if (seen.has(name)) return null;
    seen.add(name);
    if (name !== key || found) continue;
    const rest = m[3]!.trim();
    const inline = rest !== "" && !rest.startsWith("#");
    let last = i;
    for (let j = i + 1; j < end; j++) {
      const n = lines[j]!;
      if (n.trim() === "") continue;
      if (indentOf(n) <= childIndent) break;
      last = j;
    }
    found = { line: i, end: last + 1, inline };
  }
  return { chatsAt, end, childIndent, ...(found ? { at: found } : {}) };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Does `after` say what `before` said everywhere but `key`'s entry? */
function othersKept(before: Policy, after: Policy, key: string): boolean {
  if (before.owner !== after.owner || before.unknownChat !== after.unknownChat) return false;
  const keys = new Set([...Object.keys(before.chats), ...Object.keys(after.chats)]);
  keys.delete(key);
  for (const k of keys) if (!sameJson(before.chats[k], after.chats[k])) return false;
  return true;
}

/**
 * `text` (null: no file yet) with `key`'s entry replaced by `doc` (as policy.ts `checkEntry` accepted it, written
 * the way the file writes it). Returns the new text, or why it cannot be written.
 */
export function replaceEntry(text: string | null, key: string, doc: Record<string, unknown>, ownerId: number): EntryEdit | { error: string } {
  const before = text === null || !text.trim() ? null : parsePolicy(text, ownerId);
  if (before && "error" in before) return { error: `${POLICY_FILE} is broken as it is (${before.error}); fix it on the machine shuvi runs on first` };
  const wanted = checkEntry(key, doc);
  if ("error" in wanted) return { error: wanted.error };
  /** Does `next` parse, say exactly `doc` for `key`, and what the file said everywhere else? */
  const holds = (next: string): boolean => {
    const check = parsePolicy(next, ownerId);
    return "policy" in check && sameJson(check.policy.chats[key], wanted.entry) && (!before || !("policy" in before) || othersKept(before.policy, check.policy, key));
  };
  const whole = (): EntryEdit | { error: string } => {
    const r = applyChange(text, { chat: key, entry: doc }, ownerId);
    if ("error" in r) return r;
    if (!holds(r.text)) return { error: `${POLICY_FILE} cannot be written so that it says exactly this (its layout reads back differently); edit it on the machine shuvi runs on` };
    return { text: r.text, rewritten: text !== null && /#/.test(text) };
  };
  if (!before) return whole();
  const eol = text!.includes("\r\n") ? "\r\n" : "\n";
  const lines = text!.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const where = locate(lines, key);
  if (where && "error" in where) return where;
  // Listed, yet its key line was not found: written some way this cannot see (a flow mapping, a complex key).
  if (!where || where.at?.inline || (!where.at && key in before.policy.chats)) return whole();
  const childIndent = where.childIndent ?? 2;
  let out: string[];
  if (where.at) {
    // Comment lines inside the entry stay with what they were above (entryLines).
    const old = lines.slice(where.at.line + 1, where.at.end);
    const lead = old.slice(0, Math.max(0, old.findIndex((l) => !blankOrComment(l))));
    const entryIndent = old.find((l) => !blankOrComment(l));
    out = [...lines.slice(0, where.at.line + 1), ...lead, ...entryLines(doc, entryIndent ? indentOf(entryIndent) : childIndent + 2, old.slice(lead.length)), ...lines.slice(where.at.end)];
  } else {
    const keyLine = `${" ".repeat(childIndent)}${JSON.stringify(key)}:`;
    out = [...lines.slice(0, where.end), keyLine, ...entryLines(doc, childIndent + 2), ...lines.slice(where.end)];
  }
  const next = `${out.join(eol)}${eol}`;
  // Edited in place, the file must still parse, say exactly `doc` for this chat (a duplicate key, `-0100:` read as
  // "-100", an alias into the old entry would not) and the same as before for everything else; otherwise it is
  // written whole from its parsed form, and the review says so.
  if (!holds(next)) return whole();
  return { text: next, rewritten: false };
}

/** A chat's entry as the file has it, unparsed (aliases and unknown names as written); undefined: not listed. */
export function rawEntry(text: string | null, key: string): Record<string, unknown> | undefined {
  if (text === null || !text.trim()) return undefined;
  try {
    const doc = Bun.YAML.parse(text) as { chats?: Record<string, unknown> } | null;
    const e = doc?.chats?.[key];
    return e && typeof e === "object" && !Array.isArray(e) ? (e as Record<string, unknown>) : e === null ? {} : undefined;
  } catch {
    return undefined;
  }
}

/** What an unlisted DM is written as when it is first given an entry: its defaults, explicitly. */
export const DM_DOC = entryToDoc(DM_DEFAULT);
