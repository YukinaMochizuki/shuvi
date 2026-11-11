import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { PLAYBOOK_NAME } from "../../agent/playbooks.ts";

/**
 * `home/` as the assistant may touch it: a fixed allow-list of files, and every change a git commit in
 * home/'s own repository (docs/design.md §3, §8).
 *
 * The allow-list is the whole of what is reachable. A path is matched as written, against exact names
 * and one pattern; nothing is normalised first, so `..`, absolute paths, `./x` and backslashes simply do
 * not match. policy.yaml is not on it: policy changes go through the owner's approval (M4), never here.
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
 */

/** Where the asking turn runs, as far as home/ is concerned. */
export interface HomeAccess {
  /** The Telegram id of the chat the turn runs in: its notes are `chats/<id>.md`. */
  chatTgId: number;
  /** The turn runs in the owner's DM (it may see the private layers). */
  ownerDm: boolean;
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

function git(home: string, args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", "-C", home, "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: AUTHOR.name,
      GIT_AUTHOR_EMAIL: AUTHOR.email,
      GIT_COMMITTER_NAME: AUTHOR.name,
      GIT_COMMITTER_EMAIL: AUTHOR.email,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).trim() };
}

function ensureRepo(home: string): void {
  mkdirSync(home, { recursive: true });
  if (existsSync(join(home, ".git"))) return;
  const r = git(home, ["init", "-q"]);
  if (!r.ok) throw new Error(`could not create home/'s repository: ${r.out}`);
}

/**
 * Write `content` to `rel` and commit it, with `why` as the message. Returns the short commit id. On any
 * failure the file is put back as it was (or removed, if the edit created it) and the error is thrown.
 */
export function commitHomeEdit(home: string, rel: string, content: string, why: string): string {
  ensureRepo(home);
  const abs = inside(home, rel);
  const before = existsSync(abs) ? readFileSync(abs, "utf8") : null;
  if (before === content) throw new Error(`${rel} already says exactly that; nothing to commit.`);
  try {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    const add = git(home, ["add", "--", rel]);
    if (!add.ok) throw new Error(add.out);
    // Only this path: anything else that changed in home/ (the owner editing by hand) is not swept in.
    const commit = git(home, ["commit", "-q", "-m", why, "--", rel]);
    if (!commit.ok) throw new Error(commit.out);
    return git(home, ["rev-parse", "--short", "HEAD"]).out;
  } catch (e) {
    if (before === null) rmSync(abs, { force: true });
    else writeFileSync(abs, before);
    git(home, ["reset", "-q", "--", rel]);
    throw new Error(`the edit was not saved (${e instanceof Error ? e.message : String(e)})`);
  }
}
