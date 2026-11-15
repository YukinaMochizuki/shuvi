import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { currentCall } from "../../agent/call-context.ts";
import { PLAYBOOK_NAME } from "./layers.ts";

/**
 * `home/` as the assistant may touch it: a fixed allow-list of files, and every change a git commit in
 * home/'s own repository (docs/design.md §3, §8).
 *
 * The allow-list is the whole of what is reachable. A path is matched as written, against exact names
 * and one pattern; nothing is normalised first, so `..`, absolute paths, `./x` and backslashes simply do
 * not match. policy.yaml is not on it: policy changes go through the owner's approval (M4), or the owner's own edit of one chat's
 * entry on its settings page (console/chat-settings-write.ts, which commits through `commitHomeEdit`), never here.
 *
 *   persona/public.md, persona/private.md, directives.md, memory/private.md   the assistant herself
 *   chats/<this chat>.md                                                      this chat's notes
 *   playbooks/<name>.md                                                       how-tos
 *   stickers/preferences.md                                                   how she picks stickers
 *   stickers/<pack>.yaml                                                      the sticker library (the
 *                                                                             owner's DM only: a pack's
 *                                                                             dm_only uses stay out of groups)
 *
 * What a chat may SEE is decided here, from `HomeAccess` (data scope follows the chat). Who may CHANGE
 * what is not: that is authority, decided per call by the turn's boundary (memory/index.ts `ownerOnly`).
 *
 * A commit that fails restores the file to what it was before the edit, so the working tree never holds
 * an edit the history does not. home/ is its own repository, created on the first edit; it never commits
 * into a repository it happens to sit inside (data/ inside a checkout, say).
 *
 * WHO CHANGED IT is in each commit, for the console's history (src/console/home-data.ts):
 *   hers           authored `shuvi`; made inside a tool call (agent/call-context.ts), it carries the trailers
 *                  `Turn: <turn id>`, `Tool-Call: <call id>`, `Chat: <chat row id>`, `Tool: <tool name>`
 *   the owner's    made from the console (`by.console`): authored `owner (console)` with the signed-in login as
 *                  the email, and the trailer `Edited-In: console`
 *   either         `Base-Commit: <sha>` on a commit that made a profile's copy of a base file from the base
 *                  (`by.baseCommit`; capabilities/memory/layers.ts)
 * Anything else in home/'s history (a commit made by hand on the machine) is what its author says it is.
 *
 * A profile's files (layers.ts) are committed at their physical paths (`profiles/<name>/<path>`), so a file's
 * history is its own; a change to several files at once (a profile renamed, duplicated or deleted) is ONE commit,
 * `commitHomeEdits`.
 */

/** Where the asking turn runs, as far as home/ is concerned. */
export interface HomeAccess {
  /** The Telegram id of the chat the turn runs in: its notes are `chats/<id>.md`. */
  chatTgId: number;
  /** The turn runs in the owner's DM (it may see the private layers). */
  ownerDm: boolean;
  /**
   * The persona and memory layers the chat's policy gives it (src/policy/): the same ones its system
   * prompt is built from. `persona/public.md` needs `public`, `persona/private.md` needs `private`,
   * `memory/private.md` needs memory `private`, this chat's notes need memory `chat`; the private ones
   * only in the owner's DM in any case. Absent: the chat's defaults (all of them in the DM; `public` and
   * `chat` elsewhere).
   */
  persona?: readonly ("public" | "private")[];
  memory?: readonly ("private" | "chat")[];
}

export const SELF_FILES = ["persona/public.md", "persona/private.md", "directives.md", "memory/private.md"] as const;
/** Files only the owner's DM may see at all (design §6: privacy is structural). */
const PRIVATE_FILES = new Set(["persona/private.md", "memory/private.md"]);

export const chatNotesPath = (chatTgId: number) => `chats/${chatTgId}.md`;

/** The sticker library's files (src/capabilities/stickers/): a pack file is named by its Telegram set name. */
export const STICKER_PREFERENCES = "stickers/preferences.md";
const STICKER_PACK = /^stickers\/[A-Za-z0-9_]{1,64}\.yaml$/;

/** Why `path` is out of this chat's reach, or null when it is on the allow-list and visible here. */
export function refusal(path: string, access: HomeAccess): string | null {
  const isChatNotes = path === chatNotesPath(access.chatTgId);
  const playbook = /^playbooks\/(.+)\.md$/.exec(path);
  const isPlaybook = !!playbook && PLAYBOOK_NAME.test(playbook[1]!);
  const isSelf = (SELF_FILES as readonly string[]).includes(path);
  const isStickerPack = STICKER_PACK.test(path);
  const isSticker = path === STICKER_PREFERENCES || isStickerPack;
  if (!isChatNotes && !isPlaybook && !isSelf && !isSticker) return `${path} is not one of your files. You can reach: ${allowedFor(access).join(", ")}.`;
  if ((PRIVATE_FILES.has(path) || isStickerPack) && !access.ownerDm) return `${path} is not available in this chat.`;
  const persona = access.persona ?? ["public", "private"];
  const memory = access.memory ?? ["private", "chat"];
  const layer =
    path === "persona/public.md" ? persona.includes("public") : path === "persona/private.md" ? persona.includes("private") : path === "memory/private.md" ? memory.includes("private") : isChatNotes ? memory.includes("chat") : true;
  if (!layer) return `${path} is not available in this chat (its settings do not include it).`;
  return null;
}

/** The allow-list as it applies to `access`, for messages. */
export function allowedFor(access: HomeAccess): string[] {
  const all = [...SELF_FILES, chatNotesPath(access.chatTgId), "playbooks/<name>.md", STICKER_PREFERENCES, "stickers/<pack>.yaml"];
  const probe = (p: string) => (p === "playbooks/<name>.md" ? "playbooks/x.md" : p === "stickers/<pack>.yaml" ? "stickers/x.yaml" : p);
  return all.filter((p) => refusal(probe(p), access) === null);
}

/** The file's text, or null when it does not exist. */
export function readHomeFile(home: string, rel: string): string | null {
  const abs = inside(home, rel);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

/** `rel` under `home`, refusing one that a symlink would carry outside it. */
function inside(home: string, rel: string): string {
  const abs = join(home, rel);
  if (existsSync(home)) {
    const root = realpathSync(home);
    // The deepest existing ancestor of the target, resolved, must still be under home/.
    let probe = abs;
    while (!existsSync(probe)) probe = dirname(probe);
    const real = realpathSync(probe);
    if (real !== root && !relative(root, real).split(sep).every((p) => p && p !== "..")) throw new Error(`${rel} leads outside home/.`);
  }
  return abs;
}

export const AUTHOR = { name: "shuvi", email: "shuvi@localhost" };
export const CONSOLE_AUTHOR = "owner (console)";

/** The trailers a commit's message may end with, by what they say. */
export const TRAILERS = { turn: "Turn", call: "Tool-Call", chat: "Chat", tool: "Tool", editedIn: "Edited-In", baseCommit: "Base-Commit" } as const;

/** Who a commit is by: hers by default; `console`: the owner, from the console, signed in as `login`. */
export interface CommitBy {
  console?: { login?: string };
  /**
   * The text the caller decided on (null: absent). If the file says anything else by the time it is written (she
   * committed meanwhile), nothing is written and `StaleEdit` is thrown, so the caller can look again.
   */
  expect?: string | null;
  /**
   * A profile's copy of a base file made or brought up to date from the base as of this commit (the console's Make
   * a version, Copy from Base, Duplicate, a save that applied Base's changes): the trailer `Base-Commit: <sha>`,
   * which the console reads to tell when the base changed since (console/home-data.ts `baseSince`).
   */
  baseCommit?: string;
}

/** The file changed between the caller's look and the write (`CommitBy.expect`): nothing was written. */
export class StaleEdit extends Error {}

function git(home: string, args: string[], author: { name: string; email: string } = AUTHOR): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", "-C", home, "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).trim() };
}

/** The commit's author, and its message: `why`, then a blank line and the trailers that say who (see the header). */
function authorship(why: string, by: CommitBy): { author: { name: string; email: string }; message: string } {
  const lines: string[] = [];
  let author = AUTHOR;
  if (by.console) {
    author = { name: CONSOLE_AUTHOR, email: by.console.login?.trim() || "console@localhost" };
    lines.push(`${TRAILERS.editedIn}: console`);
  } else {
    const call = currentCall();
    if (call) lines.push(`${TRAILERS.turn}: ${call.turnId}`, `${TRAILERS.call}: ${call.callId}`, `${TRAILERS.chat}: ${call.chatId}`, `${TRAILERS.tool}: ${call.tool}`);
  }
  if (by.baseCommit) lines.push(`${TRAILERS.baseCommit}: ${by.baseCommit}`);
  // `why` as given (a policy change's message has several lines); the trailers are its last paragraph.
  return { author, message: lines.length ? `${why.trimEnd()}\n\n${lines.join("\n")}` : why };
}

/**
 * The files the console may edit: every file on the allow-list, any chat's notes included (the console is the
 * owner's; what a chat may see is a turn's question, not his).
 */
export function consoleEditable(path: string): boolean {
  // A profile's copy of one of them (layers.ts): `profiles/<name>/<editable path>`, never wider.
  const prof = /^profiles\/([a-z0-9][a-z0-9-]{0,31})\/(.+)$/.exec(path);
  if (prof) return !prof[2]!.startsWith("profiles/") && consoleEditable(prof[2]!);
  if ((SELF_FILES as readonly string[]).includes(path) || path === STICKER_PREFERENCES || STICKER_PACK.test(path)) return true;
  if (/^chats\/-?\d{1,20}\.md$/.test(path)) return true;
  const playbook = /^playbooks\/(.+)\.md$/.exec(path);
  return !!playbook && PLAYBOOK_NAME.test(playbook[1]!);
}

/** Run git in home/ (reads only: the console's history). Exported for console/home-data.ts. */
export function homeGit(home: string, args: string[]): { ok: boolean; out: string } {
  return git(home, args);
}

/** The short id of the latest commit that removed `rel` from home/, or null when none did. */
export function lastRemoval(home: string, rel: string): string | null {
  if (!existsSync(join(home, ".git"))) return null;
  const r = git(home, ["log", "-1", "--diff-filter=D", "--format=%h", "--", rel]);
  return r.ok && r.out ? r.out : null;
}

function ensureRepo(home: string): void {
  mkdirSync(home, { recursive: true });
  if (existsSync(join(home, ".git"))) return;
  const r = git(home, ["init", "-q"]);
  if (!r.ok) throw new Error(`could not create home/'s repository: ${r.out}`);
}

/**
 * Write `content` to `rel` and commit it, with `why` as the message; `content` null removes the file
 * instead (it must be in home/'s history, so what it said stays recoverable). Returns the short commit id.
 * On any failure the file is put back as it was (or removed, if the edit created it) and the error is thrown.
 * `by`: who it is by (see the header); hers by default.
 */
export function commitHomeEdit(home: string, rel: string, content: string | null, why: string, by: CommitBy = {}): string {
  const { author, message } = authorship(why, by);
  ensureRepo(home);
  const abs = inside(home, rel);
  const before = existsSync(abs) ? readFileSync(abs, "utf8") : null;
  if (by.expect !== undefined && before !== by.expect) throw new StaleEdit(`${rel} changed meanwhile`);
  if (before === content) throw new Error(content === null ? `${rel} does not exist; nothing to remove.` : `${rel} already says exactly that; nothing to commit.`);
  if (content === null && !git(home, ["ls-files", "--error-unmatch", "--", rel]).ok) {
    throw new Error(`${rel} was never committed in home/, so removing it could not be undone; it was left in place.`);
  }
  try {
    if (content === null) rmSync(abs);
    else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    const add = git(home, ["add", "-A", "--", rel]);
    if (!add.ok) throw new Error(add.out);
    // Only this path: anything else that changed in home/ (the owner editing by hand) is not swept in.
    const commit = git(home, ["commit", "-q", "-m", message, "--", rel], author);
    if (!commit.ok) throw new Error(commit.out);
    return git(home, ["rev-parse", "--short", "HEAD"]).out;
  } catch (e) {
    if (before === null) rmSync(abs, { force: true });
    else writeFileSync(abs, before);
    git(home, ["reset", "-q", "--", rel]);
    throw new Error(`the edit was not saved (${e instanceof Error ? e.message : String(e)})`);
  }
}

/**
 * Several files changed as ONE commit (a profile renamed, duplicated or deleted): each `content` written, or the
 * file removed when null (it must be in home/'s history). Returns the short commit id. On any failure every file
 * is put back as it was and the error is thrown. Files that already say what is asked are left out; nothing to
 * change at all is an error.
 */
export function commitHomeEdits(
  home: string,
  changes: readonly { rel: string; content: string | null }[],
  why: string,
  by: CommitBy = {},
  /**
   * Called once every new text is on disk and before anything is removed (a profile renamed: its chats are moved to
   * the new name there, so a turn starting meanwhile finds its profile under either name: console/home-write.ts).
   * If it throws, nothing is committed and every file is put back.
   */
  afterWrites?: () => void,
): string {
  const { author, message } = authorship(why, by);
  ensureRepo(home);
  const todo = changes
    .map((c) => {
      const abs = inside(home, c.rel);
      return { ...c, abs, before: existsSync(abs) ? readFileSync(abs, "utf8") : null };
    })
    .filter((c) => c.before !== c.content);
  if (!todo.length) throw new Error("nothing to change");
  for (const c of todo) {
    if (c.content === null && !git(home, ["ls-files", "--error-unmatch", "--", c.rel]).ok) {
      throw new Error(`${c.rel} was never committed in home/, so removing it could not be undone; nothing was changed.`);
    }
  }
  const rels = todo.map((c) => c.rel);
  try {
    // Writes first, removals after: a reader in between sees every new file, and the old ones still there.
    for (const c of todo) {
      if (c.content === null) continue;
      mkdirSync(dirname(c.abs), { recursive: true });
      writeFileSync(c.abs, c.content);
    }
    afterWrites?.();
    for (const c of todo) if (c.content === null) rmSync(c.abs);
    const add = git(home, ["add", "-A", "--", ...rels]);
    if (!add.ok) throw new Error(add.out);
    const commit = git(home, ["commit", "-q", "-m", message, "--", ...rels], author);
    if (!commit.ok) throw new Error(commit.out);
    // Folders a removal emptied go too (a deleted profile leaves no folder behind to be taken for one).
    for (const c of todo) if (c.content === null) pruneEmpty(home, dirname(c.abs));
    return git(home, ["rev-parse", "--short", "HEAD"]).out;
  } catch (e) {
    for (const c of todo) {
      if (c.before === null) rmSync(c.abs, { force: true });
      else {
        mkdirSync(dirname(c.abs), { recursive: true });
        writeFileSync(c.abs, c.before);
      }
    }
    git(home, ["reset", "-q", "--", ...rels]);
    throw new Error(`nothing was saved (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** Remove `dir` and its parents while they are empty, up to (not including) home/. */
function pruneEmpty(home: string, dir: string): void {
  const root = resolve(home);
  for (let d = resolve(dir); d !== root && d.startsWith(root + sep); d = dirname(d)) {
    try {
      if (readdirSync(d).length) return;
      rmdirSync(d);
    } catch {
      return;
    }
  }
}

/** The full id of home/'s latest commit, or null when it has none. */
export function homeHead(home: string): string | null {
  if (!existsSync(join(home, ".git"))) return null;
  const r = git(home, ["rev-parse", "HEAD"]);
  return r.ok ? r.out : null;
}
