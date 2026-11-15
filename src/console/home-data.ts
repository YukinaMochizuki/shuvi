import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAYBOOK_NAME } from "../agent/playbooks.ts";
import { buildPromptSections } from "../agent/prompt.ts";
import { AUTHOR, CONSOLE_AUTHOR, consoleEditable, homeHead, readHomeFile, SELF_FILES, STICKER_PREFERENCES, TRAILERS } from "../capabilities/memory/home.ts";
import { HomeLayers, isLayered, listProfiles, profileDir, readProfile } from "../capabilities/memory/layers.ts";
import { chatCapabilities, type EnabledCapability, type OwnerInfo } from "../capabilities/types.ts";
import { defaultPolicy, resolveChat, type Policy } from "../policy/policy.ts";
import type { Db } from "../store/db.ts";
import type { BaseDiffState, ChatRef, ConflictState, DiffState, EditState, FileGroup, FileRow, Flash, HistEntry, HomeView, MainPane, PreviewState, ProfileInfo, Who } from "./home.ts";
import { diffLines } from "./diff.ts";
import { chatName } from "./pages.ts";
import { chatById, type ConsoleChat } from "./queries.ts";

/**
 * What the Home page shows (home.ts draws it), read from home/'s git history and the store. Reads only; the one
 * write is home-write.ts's.
 *
 * WHO made a commit (capabilities/memory/home.ts's header says how each is written):
 *   her      trailers `Turn` / `Tool-Call` / `Chat` / `Tool`: the turn, the call and the chat it was made in;
 *            authored `shuvi` without them (a commit from before trailers, or one made outside a call): the call
 *            is looked for in the turns' transcripts, by the `commit <id>` her tool's result names (`inferred`),
 *            for as long as transcripts are kept;
 *   you      trailer `Edited-In: console` (authored `owner (console)`, the login as the email);
 *   other    anything else: a commit made by hand on the machine, by its author's name.
 */

export const langOf = (path: string): "markdown" | "yaml" => (path.endsWith(".yaml") ? "yaml" : "markdown");

/** The sha1 git gives `text` as a blob: what identifies a version of a file, saved or not. */
export function blobId(text: string | null): string {
  if (text === null) return "absent";
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/**
 * The file's text at `rev` (`<commit>`, `<commit>^`), or null when it is not there. Its stdout exactly: homeGit
 * trims, which would eat a file's final newline.
 */
export function fileAt(home: string, rev: string, path: string): string | null {
  const r = Bun.spawnSync(["git", "-C", home, "show", `${rev}:${path}`], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString() : null;
}

/** A blob's text by its id, or null when home/'s repository does not hold it (a version never committed). */
export function blobText(home: string, id: string): string | null {
  if (id === "absent") return "";
  if (!/^[0-9a-f]{40}$/.test(id)) return null;
  const r = Bun.spawnSync(["git", "-C", home, "cat-file", "blob", id], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString() : null;
}

/**
 * Three-way merge (`git merge-file`): `ours` and `theirs` both changed `base`. Clean: the merged text. Else the
 * text with conflict markers, labelled.
 */
export function merge3(ours: string, base: string, theirs: string, labels: [string, string, string]): { clean: boolean; text: string } {
  const dir = mkdtempSync(join(tmpdir(), "shuvi-merge-"));
  try {
    const [o, b, t] = ["ours", "base", "theirs"].map((n) => join(dir, n));
    writeFileSync(o!, ours);
    writeFileSync(b!, base);
    writeFileSync(t!, theirs);
    const r = Bun.spawnSync(["git", "merge-file", "-p", "-L", labels[0], "-L", labels[1], "-L", labels[2], o!, b!, t!], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== null && r.exitCode < 0) throw new Error(r.stderr.toString());
    return { clean: r.exitCode === 0, text: r.stdout.toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `now` with the change `before` → `after` taken out: that change's own diff, with no context lines, applied in
 * reverse (`git apply -R --unidiff-zero`), so a change is found wherever its lines now sit and the lines around it
 * may have changed since (she mostly appends a line under the one she added last time, which a three-way merge would
 * call a conflict). Null when the lines it added, or the place it removed lines from, are not there any more as
 * they were: then only a person can say what undoing it means.
 */
export function undoChange(now: string, before: string, after: string): string | null {
  if (before === after) return now;
  // Without context a line is found by its text alone: when a line the change added (or a line next to where it
  // removed some) occurs more than once in the file now, the patch could land on the wrong one. Then this says it
  // cannot tell, and the caller falls back to a three-way merge.
  const nowLines = now.split("\n");
  const count = (l: string) => nowLines.reduce((n, x) => n + (x === l ? 1 : 0), 0);
  const added = diffLines(before, after).filter((l) => l.op === "add").map((l) => l.text);
  if (added.some((l) => count(l) > 1)) return null;
  const dir = mkdtempSync(join(tmpdir(), "shuvi-undo-"));
  try {
    writeFileSync(join(dir, "a"), before);
    writeFileSync(join(dir, "b"), after);
    const d = Bun.spawnSync(["git", "diff", "--no-index", "--no-color", "-U0", "a", "b"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const patch = d.stdout
      .toString()
      .replace(/^diff --git .*$/m, "diff --git a/f b/f")
      .replace(/^--- .*$/m, "--- a/f")
      .replace(/^\+\+\+ .*$/m, "+++ b/f");
    writeFileSync(join(dir, "f"), now);
    writeFileSync(join(dir, "p"), patch);
    const r = Bun.spawnSync(["git", "apply", "-R", "--unidiff-zero", "--whitespace=nowarn", "p"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    return r.exitCode === 0 ? readFileSync(join(dir, "f"), "utf8") : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- history -------------------------------------------------------------------------------------------------

interface RawCommit {
  commit: string;
  short: string;
  at: string;
  author: string;
  email: string;
  body: string;
  /** Per path: lines added and removed, and whether the commit created or removed it. */
  files: Map<string, { add: number; del: number; created?: boolean; removed?: boolean }>;
}

const FS = "\x1f";
const RS = "\x1e";
const FORMAT = `--format=${RS}%H${FS}%h${FS}%aI${FS}%an${FS}%ae${FS}%B${FS}`;

/** `git log` with numstat and summary, parsed. */
function log(home: string, args: string[]): RawCommit[] {
  if (!existsSync(join(home, ".git"))) return [];
  const r = Bun.spawnSync(["git", "-C", home, "-c", "core.quotepath=false", "log", FORMAT, "--numstat", "--summary", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) return [];
  const out: RawCommit[] = [];
  for (const rec of r.stdout.toString().split(RS).slice(1)) {
    const [commit, short, at, author, email, body, rest] = rec.split(FS) as [string, string, string, string, string, string, string];
    const files: RawCommit["files"] = new Map();
    for (const line of (rest ?? "").split("\n")) {
      const n = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (n) {
        files.set(n[3]!, { add: n[1] === "-" ? 0 : Number(n[1]), del: n[2] === "-" ? 0 : Number(n[2]) });
        continue;
      }
      const s = /^ (create|delete) mode \d+ (.+)$/.exec(line);
      if (s) {
        const f = files.get(s[2]!) ?? { add: 0, del: 0 };
        if (s[1] === "create") f.created = true;
        else f.removed = true;
        files.set(s[2]!, f);
      }
    }
    out.push({ commit, short, at, author, email, body: body ?? "", files });
  }
  return out;
}

/** The trailers of a commit message's last paragraph. */
function trailers(body: string): Map<string, string> {
  const paras = body.trim().split(/\n\s*\n/);
  const last = paras.length > 1 ? paras.at(-1)! : "";
  const out = new Map<string, string>();
  for (const line of last.split("\n")) {
    const m = /^([A-Za-z-]+):\s*(.+)$/.exec(line.trim());
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

/** The message without its trailers: what she (or you) wrote as the why. */
function messageOf(body: string, t: Map<string, string>): string {
  const paras = body.trim().split(/\n\s*\n/);
  const text = t.size && paras.length > 1 ? paras.slice(0, -1).join("\n\n") : body.trim();
  return text || "(no message)";
}

/** Where her commits without trailers were made, by commit id prefix: found through her tools' results. */
type Inferred = Map<string, { turnId: number; callId: string | null; tool: string; chatId: number }>;

/** Her tools that commit to home/, and say the commit in their result. */
const HOME_TOOLS = ["edit_home", "write_home", "edit_chat_notes", "add_sticker_pack", "remove_sticker_pack"];

function inferCalls(db: Db): Inferred {
  const rows = db.$client
    .query(
      `select s.turn_id as turnId, s.call_id as callId, s.name as tool, s.result as result, t.chat_id as chatId
         from turn_steps s join turns t on t.id = s.turn_id
        where s.kind = 'tool' and s.status = 'ok' and s.name in (${HOME_TOOLS.map(() => "?").join(",")}) and s.result like '%commit %'`,
    )
    .all(...HOME_TOOLS) as { turnId: number; callId: string | null; tool: string; result: string; chatId: number }[];
  const out: Inferred = new Map();
  // A result may also name an OLDER commit ("removed from the library before (commit X)", "as it was before commit
  // X"), and an edit's result carries the file's diff, which may quote any id: only the FIRST commit a result names,
  // not after "before", is the one the call made.
  for (const r of rows) {
    const m = [...r.result.matchAll(/(before \(?)?commit ([0-9a-f]{7,40})\b/g)].find((x) => !x[1]);
    if (m) out.set(m[2]!.slice(0, 7), { turnId: r.turnId, callId: r.callId, tool: r.tool, chatId: r.chatId });
  }
  return out;
}

/**
 * `inferCalls`, kept for the process while `turn_steps` gains no row: it scans every tool step of hers, and the page,
 * its watch and a save would otherwise each scan again.
 */
let inferredCache: { db: Db; key: string; map: Inferred } | undefined;
function inferredCalls(db: Db): Inferred {
  const row = db.$client.query("select max(id) as id, count(*) as n from turn_steps").get() as { id: number | null; n: number };
  const key = `${row.id}:${row.n}`;
  if (inferredCache?.db !== db || inferredCache.key !== key) inferredCache = { db, key, map: inferCalls(db) };
  return inferredCache.map;
}

/** Turns commits into history entries for `path` (or each commit's own path, for the all-files page). */
class Whos {
  private chats = new Map<number, ConsoleChat | undefined>();
  private inferred: Inferred | undefined;
  constructor(private db: Db) {}

  private chatLabel(chatId: number | undefined): string | undefined {
    if (!chatId) return undefined;
    if (!this.chats.has(chatId)) this.chats.set(chatId, chatById(this.db, chatId));
    const c = this.chats.get(chatId);
    return c ? chatName(c) : undefined;
  }

  who(c: RawCommit): Who {
    const t = trailers(c.body);
    if (t.get(TRAILERS.editedIn) === "console" || c.author === CONSOLE_AUTHOR) return { kind: "owner", ...(c.email && c.email !== "console@localhost" ? { login: c.email } : {}) };
    const turn = Number(t.get(TRAILERS.turn));
    if (turn) {
      const chat = Number(t.get(TRAILERS.chat)) || undefined;
      const label = this.chatLabel(chat);
      const call = t.get(TRAILERS.call);
      const tool = t.get(TRAILERS.tool);
      return { kind: "her", turnId: turn, ...(label ? { chatLabel: label } : {}), ...(call ? { callId: call } : {}), ...(tool ? { tool } : {}) };
    }
    if (c.author === AUTHOR.name && c.email === AUTHOR.email) {
      this.inferred ??= inferredCalls(this.db);
      const found = this.inferred.get(c.commit.slice(0, 7));
      if (!found) return { kind: "her" };
      const label = this.chatLabel(found.chatId);
      return { kind: "her", inferred: true, turnId: found.turnId, tool: found.tool, ...(found.callId ? { callId: found.callId } : {}), ...(label ? { chatLabel: label } : {}) };
    }
    return { kind: "external", name: c.author || "git" };
  }

  entry(c: RawCommit, path: string): HistEntry {
    const f = c.files.get(path) ?? { add: 0, del: 0 };
    return {
      commit: c.commit,
      short: c.short,
      at: c.at,
      who: this.who(c),
      message: messageOf(c.body, trailers(c.body)),
      add: f.add,
      del: f.del,
      ...(f.created ? { created: true } : {}),
      ...(f.removed ? { removed: true } : {}),
    };
  }
}

/** One file's history, newest first. */
export function fileHistory(db: Db, home: string, path: string, limit = 200): HistEntry[] {
  const whos = new Whos(db);
  return log(home, [`-n${limit}`, "--", path]).map((c) => whos.entry(c, path));
}

/** Every editable file's changes, newest first: `limit` commits, before commit `before` when given. */
export function allHistory(db: Db, home: string, before: string | undefined, limit = 50): { entries: (HistEntry & { path: string })[]; more?: string } {
  const whos = new Whos(db);
  // Older than `before`: from it, skipping it (`<before>^` would fail at the root commit).
  const rev = before && /^[0-9a-f]{7,40}$/.test(before) ? [before, "--skip=1"] : [];
  // Commits that touch none of her files (policy.yaml, inbound.yaml) are left out by git, so a page is never short.
  const commits = log(home, [`-n${limit + 1}`, ...rev, "--", ".", ":(exclude)policy.yaml", ":(exclude)inbound.yaml"]);
  const page = commits.slice(0, limit);
  const entries = page.flatMap((c) => [...c.files.keys()].filter(consoleEditable).map((p) => ({ ...whos.entry(c, p), path: p })));
  return { entries, ...(commits.length > limit ? { more: page.at(-1)!.commit } : {}) };
}

// ---- the file list -----------------------------------------------------------------------------------------------

function listDir(home: string, dir: string, ext: string): string[] {
  const abs = join(home, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => f.endsWith(ext))
    .sort()
    .map((f) => `${dir}/${f}`);
}

/**
 * Every file the console edits, grouped: her own files, each chat's notes (every chat the store knows, created or
 * not, and any notes file on disk), the playbooks, the sticker files. Each with its last change.
 *
 * In a profile's view (`layers` with a profile: capabilities/memory/layers.ts) each row also says where the file in
 * effect comes from (`inherits`, `own`, `only` in the profile, `hidden`), and the profile's own playbooks and packs
 * are listed with the base's. A row's path is always the LOGICAL one; its last change is its copy in effect's.
 */
export function fileGroups(db: Db, home: string, layers: HomeLayers = HomeLayers.base(home)): FileGroup[] {
  const latest = new Map<string, { who: Who; at: string }>();
  const whos = new Whos(db);
  for (const c of log(home, ["-n500"])) for (const p of c.files.keys()) if (!latest.has(p)) latest.set(p, { who: whos.who(c), at: c.at });
  const p = layers.profile;
  const own = p ? profileDir(p.name) : null;
  const row = (path: string, hint: string): FileRow => {
    if (!p) {
      const last = latest.get(path);
      return { path, hint, exists: existsSync(join(home, path)), ...(last ? { last } : {}) };
    }
    const r = layers.resolve(path);
    const inBase = existsSync(join(home, path));
    const layer: FileRow["layer"] = r.hidden ? "hidden" : r.from === "profile" ? (inBase ? "own" : "only") : "inherits";
    const last = latest.get(r.physical);
    return { path, hint, exists: r.hidden ? inBase : r.exists, layer, ...(isHideable(path) ? { hideable: true } : {}), ...(last ? { last } : {}) };
  };
  // The logical paths in `dir`, the base's and (in a profile's view) the profile's own.
  const both = (dir: string, ext: string) => [...new Set([...listDir(home, dir, ext), ...(own ? listDir(home, `${own}/${dir}`, ext).map((x) => x.slice(own.length + 1)) : [])])].sort();
  const self: Record<string, string> = {
    "persona/public.md": "who she is, in every chat",
    "persona/private.md": "her side only your DM sees",
    "directives.md": "your rules for her",
    "memory/private.md": "what she knows about you",
  };
  const chats = db.$client.query(`select id from chats order by kind = 'private' desc, id`).all() as { id: number }[];
  const noteRows = new Map<string, string>();
  for (const { id } of chats) {
    const c = chatById(db, id);
    if (c) noteRows.set(`chats/${c.tgChatId}.md`, chatName(c));
  }
  for (const x of both("chats", ".md")) if (consoleEditable(x) && !noteRows.has(x)) noteRows.set(x, "a chat");
  const playbooks = both("playbooks", ".md").filter((x) => PLAYBOOK_NAME.test(x.slice("playbooks/".length, -3)));
  const packs = both("stickers", ".yaml").filter(consoleEditable);
  return [
    { label: "Herself", files: SELF_FILES.map((x) => row(x, self[x] ?? "")) },
    { label: "Chat notes", files: [...noteRows].map(([x, name]) => ({ ...row(x, "her notes on this chat"), title: name })) },
    { label: "Playbooks", files: playbooks.map((x) => row(x, firstLine(home, layers.resolve(x).physical))) },
    { label: "Stickers", files: [row(STICKER_PREFERENCES, "how she picks stickers"), ...packs.map((x) => row(x, "a sticker pack"))] },
  ];
}

/** A playbook or a sticker pack: what a profile may hide (memory/layers.ts). */
const isHideable = (path: string) => path.startsWith("playbooks/") || (path.startsWith("stickers/") && path !== STICKER_PREFERENCES);

/** A playbook's first line says when to use it (agent/playbooks.ts): its hint here. */
function firstLine(home: string, path: string): string {
  const t = readHomeFile(home, path) ?? "";
  const line = t.split("\n").find((l) => l.trim()) ?? "";
  const s = line.replace(/^#+\s*/, "").trim();
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

// ---- profiles ----------------------------------------------------------------------------------------------------

/** The files a profile has its own copy of (logical paths), by walking its folder. */
export function ownFiles(home: string, name: string): string[] {
  const root = join(home, profileDir(name));
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else if (isLayered(r)) out.push(r);
    }
  };
  walk(root, "");
  return out.sort();
}

const chatRef = (db: Db, id: number): ChatRef | null => {
  const c = chatById(db, id);
  return c ? { id, label: chatName(c) } : null;
};

/** Every profile with the chats on it, and the chats on none (or on one that no longer exists). */
export function profileInfos(db: Db, home: string): { profiles: ProfileInfo[]; baseUsedBy: ChatRef[] } {
  const metas = listProfiles(home);
  const names = new Set(metas.map((m) => m.name));
  const rows = db.$client.query(`select id, profile from chats order by kind = 'private' desc, id`).all() as { id: number; profile: string | null }[];
  const profiles = metas.map((m) => ({
    name: m.name,
    ...(m.label ? { label: m.label } : {}),
    usedBy: rows.filter((r) => r.profile === m.name).flatMap((r) => chatRef(db, r.id) ?? []),
    own: ownFiles(home, m.name).length + m.hides.filter((h) => !existsSync(join(home, profileDir(m.name), "playbooks", `${h}.md`))).length + (m.hidePacks?.length ?? 0),
  }));
  const baseUsedBy = rows.filter((r) => !r.profile || !names.has(r.profile)).flatMap((r) => chatRef(db, r.id) ?? []);
  return { profiles, baseUsedBy };
}

/**
 * The base commit a profile's copy (at `physical`) is based on: the `Base-Commit` trailer of the latest commit to it
 * that has one; without one (a copy made before trailers, or by hand), the commit just before the copy's first.
 * `at`: as of that revision instead of now (the version a Restore or an Undo brings back: its text is based on the
 * base commit that was in effect then). Null when the copy has no history there.
 *
 * Every console save of a copy records the base commit its TEXT is based on (the editor's `basecommit`, set by
 * `loadHome`): a plain edit the current one, a restored version the one at that version, an undo the one before the
 * undone change, Apply and Copy from Base the base's head. So a restore or an undo never hides Base's changes.
 */
export function baseSince(home: string, physical: string, at?: string): string | null {
  const commits = log(home, [...(at ? [at] : []), "--", physical]);
  for (const c of commits) {
    const b = trailers(c.body).get(TRAILERS.baseCommit);
    if (b && /^[0-9a-f]{7,40}$/.test(b)) return b;
  }
  const first = commits.at(-1);
  if (!first) return null;
  const r = Bun.spawnSync(["git", "-C", home, "rev-parse", "--verify", "-q", `${first.commit}^`], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

/** The base's commits to `logical` after `since`, newest first. */
export function baseChangesSince(db: Db, home: string, logical: string, since: string): HistEntry[] {
  const whos = new Whos(db);
  return log(home, [`${since}..HEAD`, "--", logical]).map((c) => whos.entry(c, logical));
}

/** The short form of a commit id. */
const shortOf = (sha: string) => sha.slice(0, 7);

// ---- the main pane -------------------------------------------------------------------------------------------------

export function editState(home: string, path: string, over: Partial<EditState> = {}): EditState {
  const saved = readHomeFile(home, path);
  return { path, lang: langOf(path), saved, text: saved ?? "", base: blobId(saved), ...over };
}

/** A history entry's diff: the change itself, or that version against the file now. */
export function diffState(home: string, path: string, entry: HistEntry, compare: "change" | "now", layout: "unified" | "split"): DiffState {
  const after = entry.removed ? "" : (fileAt(home, entry.commit, path) ?? "");
  const before = entry.created ? "" : (fileAt(home, `${entry.commit}^`, path) ?? "");
  const now = readHomeFile(home, path) ?? "";
  const revertConflicts = undoChange(now, before, after) === null && !merge3(now, after, before, ["now", "this change", "before it"]).clean;
  return compare === "now" ? { entry, compare, layout, before: after, after: now, revertConflicts } : { entry, compare, layout, before, after, revertConflicts };
}

/**
 * "Undo this change": the file now, with what `entry` did taken out (`undoChange`). Loaded into the editor, never
 * saved here. When later changes rewrote the same lines, a three-way merge shows where, as a conflict to resolve.
 */
export function undoPane(home: string, path: string, entry: HistEntry): MainPane {
  const now = readHomeFile(home, path);
  const after = entry.removed ? "" : (fileAt(home, entry.commit, path) ?? "");
  const before = entry.created ? "" : (fileAt(home, `${entry.commit}^`, path) ?? "");
  const loaded = `Undo of ${entry.short} (“${firstOf(entry.message)}”) loaded.`;
  const undone = undoChange(now ?? "", before, after);
  if (undone !== null) return { mode: "edit", edit: editState(home, path, { text: undone, loaded }) };
  // Ambiguous without context, or the lines were rewritten since: a three-way merge decides, or shows the overlap.
  const m = merge3(now ?? "", after, before, ["now", entry.short, `undoing ${entry.short}`]);
  if (m.clean) return { mode: "edit", edit: editState(home, path, { text: m.text, loaded }) };
  const conflict: ConflictState = {
    path,
    lang: langOf(path),
    theirs: now ?? "",
    ours: m.text,
    base: blobId(now),
    theirsWho: entry.who,
    reason: `Later changes rewrote the lines ${entry.short} changed, so undoing it needs you. Left: the file now. Right: the undo, its overlap marked between <<<<<<< and >>>>>>>; tidy it up, then save.`,
  };
  return { mode: "conflict", conflict };
}

/** "Restore this version": the file as it was right after `entry`, loaded into the editor, unsaved. */
export function restorePane(home: string, path: string, entry: HistEntry): MainPane {
  const text = entry.removed ? "" : (fileAt(home, entry.commit, path) ?? "");
  return { mode: "edit", edit: editState(home, path, { text, loaded: `The version from ${entry.short} (“${firstOf(entry.message)}”) loaded.` }) };
}

const firstOf = (s: string) => {
  const l = s.split("\n")[0] ?? "";
  return l.length > 60 ? `${l.slice(0, 59)}…` : l;
};

/** What a save left for the page (home-write.ts `takeResult`). */
export interface SaveResult {
  path: string;
  flash: Flash;
  conflict?: ConflictState;
  text?: string;
  /** The version `text` is based on, when it is not the file as it is now (a file removed meanwhile). */
  base?: string;
  note?: string;
  /** The profile the save was in (the page goes back to it). */
  profile?: string;
  /** A refused save's `basecommit`, kept for the next try. */
  baseCommit?: string;
}

/** What the Preview needs to build a chat's prompt as a turn would (server.ts `ConsoleDeps.prompt`). */
export interface PromptDeps {
  capabilities: readonly EnabledCapability[];
  policy?: () => Policy;
  owner?: OwnerInfo;
  ownerId?: number;
}

/** A logical path, or a profile's physical one (`profiles/<name>/<path>`) split into its profile and path. */
export function splitPath(path: string): { profile?: string; path: string } {
  const m = /^profiles\/([a-z0-9][a-z0-9-]{0,31})\/(.+)$/.exec(path);
  return m ? { profile: m[1]!, path: m[2]! } : { path };
}

/** An edit or conflict pane whose save records `baseCommit` as the base its text is based on (none: left as it is). */
function withBase(m: MainPane, baseCommit: string | null): MainPane {
  if (!baseCommit) return m;
  if (m.mode === "edit") return { ...m, edit: { ...m.edit, baseCommit } };
  if (m.mode === "conflict") return { ...m, conflict: { ...m.conflict, baseCommit } };
  return m;
}

/** A main pane computed on a physical path, shown under its logical one. */
function underLogical(m: MainPane, logical: string): MainPane {
  if (m.mode === "edit") return { ...m, edit: { ...m.edit, path: logical } };
  if (m.mode === "conflict") return { ...m, conflict: { ...m.conflict, path: logical } };
  if (m.mode === "diff") return { ...m, path: logical };
  return m;
}

/**
 * The Preview (home.ts): the system prompt a chat would get now, section by section, with each section's layer.
 * `chat` the one asked for (`?chat=`), else the first chat on the profile shown, else the first chat.
 */
export function previewState(db: Db, home: string, q: URLSearchParams, profile: string | undefined, deps?: PromptDeps): PreviewState {
  const rows = db.$client.query(`select id from chats order by kind = 'private' desc, id`).all() as { id: number }[];
  const all = rows.flatMap(({ id }) => {
    const c = chatById(db, id);
    return c ? [c] : [];
  });
  const chats = all.map((c) => ({ id: c.id, label: chatName(c), ...(c.profile ? { profile: c.profile } : {}) }));
  const asked = Number(q.get("chat"));
  const pick = all.find((c) => c.id === asked) ?? (profile ? all.find((c) => c.profile === profile) : undefined) ?? all[0];
  if (!pick) return { chats, sections: [] };
  const layers = HomeLayers.of(home, pick.profile);
  const policy = deps?.policy?.() ?? defaultPolicy();
  const cp = resolveChat(policy, pick, deps?.ownerId) ?? undefined;
  const caps = deps && cp ? chatCapabilities(deps.capabilities, cp.tools) : [];
  const sections = buildPromptSections(layers, pick, deps?.owner ?? {}, caps, cp, db).map((s) => ({
    label: s.label,
    text: s.text,
    source: s.layer === "code" ? ({ kind: "code" } as const) : s.layer && s.layer !== "base" ? ({ kind: "profile", name: s.layer } as const) : ({ kind: "base" } as const),
  }));
  const chat = chats.find((c) => c.id === pick.id)!;
  return { chats, chat, sections, ...(pick.profile && !layers.profile ? { missingProfile: pick.profile } : {}) };
}

/** A profile's own copy's state against the base: how many base commits since it was made, and from which. */
function baseChanged(db: Db, home: string, logical: string, physical: string): { n: number; since: string } | undefined {
  if (!existsSync(join(home, logical))) return undefined;
  const since = baseSince(home, physical);
  if (!since) return undefined;
  const n = baseChangesSince(db, home, logical, since).length;
  return n ? { n, since } : undefined;
}

/**
 * The page for a URL: `profile` (the layer shown: a profile's name, or none for the base), `file` (the selected
 * file, by its logical path; a profile's physical path is taken apart), `at` (a history entry's diff, with
 * `compare` and `layout`), `undo` / `restore` (a commit's undo, or its version, loaded into the editor unsaved),
 * `hist=0` (history folded), `pane` (the narrow layout's pane), `view=preview` (the Preview, `chat`), `panel` (a
 * profile panel: new, rename, duplicate, delete), and on a profile's own copy `remove=1` (asks to remove it),
 * `copybase=1` (Base's text loaded), `basediff=1` (Base's changes since), `applybase=1` (them merged in, loaded);
 * and the result of a save (`result`).
 */
export function loadHome(
  db: Db,
  home: string,
  q: URLSearchParams,
  ctx: { csrf: string; timeZone: string; now: number; who?: string; prompt?: PromptDeps },
  result?: SaveResult,
): HomeView {
  const split = splitPath(q.get("file") ?? result?.path ?? "");
  const name = split.profile ?? q.get("profile") ?? result?.profile ?? undefined;
  const meta = name ? readProfile(home, name) : null;
  const layers = new HomeLayers(home, meta);
  const groups = fileGroups(db, home, layers);
  const { profiles, baseUsedBy } = profileInfos(db, home);
  const current = meta ? profiles.find((p) => p.name === meta.name) : undefined;
  const panelQ = q.get("panel");
  const panel = panelQ === "new" || (current && (panelQ === "rename" || panelQ === "duplicate" || panelQ === "delete")) ? (panelQ as HomeView["layers"]["panel"]) : undefined;

  const path = split.path && consoleEditable(split.path) && !split.path.startsWith("profiles/") ? split.path : undefined;
  const r = path && meta ? layers.resolve(path) : undefined;
  const own = r?.from === "profile";
  // The file whose history and text are shown: the profile's copy, or the base's (inherited, hidden, or no profile).
  const phys = path ? (own ? r!.physical : path) : undefined;
  const history = phys ? fileHistory(db, home, phys) : [];
  const find = (commit: string | null) => (commit ? history.find((e) => e.commit === commit || e.commit.startsWith(commit)) : undefined);
  const p = meta?.name;
  const hideable = !!path && isHideable(path);
  const inBase = !!path && existsSync(join(home, path));
  const ownLayer = (text: string | null): EditState["layer"] | undefined => {
    if (!p || !path || !own) return undefined;
    const changed = inBase ? baseChanged(db, home, path, phys!) : undefined;
    return { profile: p, kind: inBase ? "own" : "only", ...(hideable ? { hideable: true } : {}), ...(text === "" ? { empty: true } : {}), ...(changed ? { baseChanged: changed } : {}) };
  };

  let main: MainPane = { mode: "none" };
  if (q.get("view") === "preview") main = { mode: "preview", preview: previewState(db, home, q, p, ctx.prompt) };
  else if (path && result?.conflict) main = { mode: "conflict", conflict: { ...result.conflict, ...(result.note ? { note: result.note } : {}) } };
  else if (path && p && !own) {
    // Inherited (or hidden): Base's text, read-only, with what to do about it.
    main = { mode: "edit", edit: { ...editState(home, path), layer: { profile: p, kind: "inherited", ...(r!.hidden ? { hidden: true } : {}), ...(hideable ? { hideable: true } : {}) } } };
  } else if (path && own && q.get("basediff") && inBase) {
    const since = baseSince(home, phys!);
    if (since) {
      const entries = baseChangesSince(db, home, path, since);
      main = { mode: "basediff", basediff: { path, profile: p!, since, sinceShort: shortOf(since), before: fileAt(home, since, path) ?? "", after: readHomeFile(home, path) ?? "", entries } satisfies BaseDiffState };
    }
  } else if (path && own && q.get("applybase") && inBase) main = applyBasePane(db, home, path, phys!, p!, ownLayer);
  else if (path && own && q.get("copybase") && inBase) {
    const head = homeHead(home);
    const text = readHomeFile(home, path) ?? "";
    main = { mode: "edit", edit: { ...editState(home, phys!, { text, loaded: `Base's text${head ? ` (${shortOf(head)})` : ""} loaded.`, ...(head ? { baseCommit: head } : {}) }), path, layer: ownLayer(readHomeFile(home, phys!)) } };
  } else if (phys && find(q.get("undo"))) {
    const entry = find(q.get("undo"))!;
    main = withBase(underLogical(undoPane(home, phys, entry), path!), own && inBase ? (baseSince(home, phys, `${entry.commit}^`) ?? baseSince(home, phys)) : null);
  } else if (phys && find(q.get("restore"))) {
    const entry = find(q.get("restore"))!;
    main = withBase(underLogical(restorePane(home, phys, entry), path!), own && inBase ? (baseSince(home, phys, entry.commit) ?? baseSince(home, phys)) : null);
  }
  else if (phys && find(q.get("at"))) {
    const compare = q.get("compare") === "now" ? "now" : "change";
    const layout = q.get("layout") === "split" ? "split" : "unified";
    main = { mode: "diff", path: path!, diff: diffState(home, phys, find(q.get("at"))!, compare, layout) };
  } else if (phys) {
    const over = result?.text !== undefined ? { text: result.text, ...(result.base ? { base: result.base } : {}), ...(result.note ? { note: result.note } : {}), ...(result.baseCommit ? { baseCommit: result.baseCommit } : {}) } : {};
    const e = editState(home, phys, over);
    main = { mode: "edit", edit: { ...e, path: path!, ...(own ? { layer: ownLayer(e.saved), ...(q.get("remove") ? { confirmRemove: true } : {}) } : {}) } };
    // A plain edit of a copy keeps the base commit its text is based on now (baseSince's header).
    if (own && inBase && !result?.baseCommit) main = withBase(main, baseSince(home, phys));
  }
  // A layer computed for an edit pane's undo / restore too.
  if (own && main.mode === "edit" && !main.edit.layer) main = { ...main, edit: { ...main.edit, layer: ownLayer(main.edit.saved) } };
  if (own && main.mode === "conflict") main = { ...main, conflict: { ...main.conflict, profile: p! } };
  const pane = q.get("pane");
  return {
    layers: { profiles, ...(current ? { current } : {}), baseUsedBy, ...(panel ? { panel } : {}) },
    groups,
    history,
    main,
    ...(path ? { selected: path } : {}),
    historyOpen: q.get("hist") !== "0",
    // Asked for, any of the three (a narrow screen's "‹ Files" names the file, so its row stays marked); else the
    // file's editor when one is selected, the file list when none is.
    pane: pane === "files" || pane === "edit" || pane === "history" ? pane : path || q.get("view") === "preview" ? "edit" : "files",
    ...(result?.flash ? { flash: result.flash } : {}),
    csrf: ctx.csrf,
    timeZone: ctx.timeZone,
    now: ctx.now,
    ...(ctx.who ? { who: ctx.who } : {}),
  };
}

/**
 * "Apply them": Base's changes since the profile's copy was made, merged into the copy (three-way: the copy, Base
 * then, Base now), loaded into the editor UNSAVED; its save records the base commit applied (`Base-Commit`). A
 * conflict opens the conflict pane, saying what happened.
 */
function applyBasePane(db: Db, home: string, logical: string, physical: string, profile: string, ownLayer: (t: string | null) => EditState["layer"] | undefined): MainPane {
  const since = baseSince(home, physical);
  const head = homeHead(home);
  const ours = readHomeFile(home, physical) ?? "";
  if (!since || !head) return { mode: "edit", edit: { ...editState(home, physical), path: logical, layer: ownLayer(ours) } };
  const then = fileAt(home, since, logical) ?? "";
  const now = readHomeFile(home, logical) ?? "";
  const n = baseChangesSince(db, home, logical, since).length;
  const m = merge3(ours, then, now, [`${profile}'s version`, `Base at ${shortOf(since)}`, "Base now"]);
  if (m.clean) {
    return {
      mode: "edit",
      edit: { ...editState(home, physical, { text: m.text, baseCommit: head, loaded: `Base's ${n} change${n === 1 ? "" : "s"} since ${shortOf(since)} applied to ${profile}'s version.` }), path: logical, layer: ownLayer(ours) },
    };
  }
  const conflict: ConflictState = {
    path: logical,
    lang: langOf(logical),
    theirs: ours,
    ours: m.text,
    base: blobId(ours),
    theirsWho: { kind: "external", name: "Base" },
    profile,
    baseCommit: head,
    sides: [`${profile}'s version now`, "With Base's changes (this is saved)"],
    reason: `Base's changes since ${profile}'s version was made (${shortOf(since)} → now) rewrote lines ${profile}'s version also changed. Left: ${profile}'s version as saved. Right: it with Base's changes, the overlap marked between <<<<<<< and >>>>>>>; tidy it up, then save to ${profile}.`,
  };
  return { mode: "conflict", conflict };
}

/**
 * The editor's watch: has `path` changed since the version `base`? Then the latest change to it, when that is
 * what the file now holds; or a bare "changed on disk" when the file was changed without a commit.
 */
export function watch(db: Db, home: string, path: string, base: string): HistEntry | null {
  if (!consoleEditable(path)) return null;
  const now = readHomeFile(home, path);
  if (blobId(now) === base) return null;
  const [latest] = fileHistory(db, home, path, 1);
  if (latest && blobId(latest.removed ? null : fileAt(home, latest.commit, path)) === blobId(now)) return latest;
  return { commit: "", short: "", at: new Date().toISOString(), who: { kind: "external", name: "Someone" }, message: "changed on disk, not committed", add: 0, del: 0 };
}
