import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commitHomeEdit, commitHomeEdits, consoleEditable, homeHead, readHomeFile, StaleEdit, STICKER_PREFERENCES } from "../capabilities/memory/home.ts";
import { HomeLayers, packOfFile, PLAYBOOK_NAME, PROFILE_NAME, profileDir, profileFile, profileYaml, readProfile } from "../capabilities/memory/layers.ts";
import { PACK_NAME } from "../capabilities/stickers/library.ts";
import type { Db } from "../store/db.ts";
import { chatsOnProfile, clearChatsProfile, renameChatsProfile, setChatProfile } from "../store/profiles.ts";
import { baseSince, blobId, blobText, fileHistory, langOf, merge3, ownFiles, splitPath } from "./home-data.ts";
import { chatName } from "./pages.ts";
import { chatById } from "./queries.ts";
import { href } from "./html.ts";
import type { Form } from "./settings-write.ts";
import type { ConflictState, Flash } from "./home.ts";

/**
 * The Home page's one write: saving a file (server.ts lets it through the console's write boundary: POST only, the
 * Origin, the CSRF token). A commit in home/, authored as the owner from the console (capabilities/memory/home.ts
 * `commitHomeEdit` with `by.console`), its message the note or "Edited in console".
 *
 * A save carries `base`, the version the editor started from (home-data.ts `blobId`). If the file is still that
 * version, the text is saved as it is. If she (or anyone) changed it meanwhile, the two changes are merged
 * (`git merge-file`, base → hers and base → yours): a clean merge is saved, and the answer says hers was kept; a
 * conflict is NOT saved, and the answer is the conflict view, both texts side by side, to resolve and save again
 * (based on the version now). Nothing anyone wrote is ever lost by a save.
 *
 * Line endings: a native form posts CRLF, htmx posts LF (it reads `textarea.value`); either way the text is taken
 * as LF and, when the file itself uses CRLF, given CRLF back, so a save changes no line it was not asked to.
 *
 * The check and the write are one step as far as a racing commit of hers is concerned: the commit is told the text
 * the decision was made on (`commitHomeEdit`'s `expect`) and refuses if the file says anything else by then, and the
 * save then looks again (a few times at most). A file she REMOVED while you edited is not quietly brought back: the
 * answer says so, and your text waits in the editor for a save that creates it again, if you want that.
 *
 * A save that fails after a merge hands back the MERGED text (based on the version now), never yours alone, so
 * saving it again cannot drop her change.
 *
 * The answer is a 303 to the page with `r=<id>`: the result (and a conflict's texts) is kept in memory for
 * `KEEP_MS`, read once, at most `KEEP_MAX` at a time, like Settings' flash.
 */

const KEEP_MS = 10 * 60_000;
const KEEP_MAX = 20;

interface Result {
  at: number;
  path: string;
  flash: Flash;
  conflict?: ConflictState;
  /** A refused save's text, given back to the editor so nothing typed is lost; and the version it is based on. */
  text?: string;
  base?: string;
  note?: string;
  /** The profile the page was in (capabilities/memory/layers.ts), and a refused save's base commit. */
  profile?: string;
  baseCommit?: string;
}

const results = new Map<string, Result>();

function keep(now: number, r: Omit<Result, "at">): string {
  for (const [k, v] of results) if (now - v.at > KEEP_MS) results.delete(k);
  while (results.size >= KEEP_MAX) results.delete(results.keys().next().value!);
  const id = randomBytes(9).toString("base64url");
  results.set(id, { ...r, at: now });
  return id;
}

/** A save's result by its id, once. */
export function takeResult(id: string | null, now: number): Result | undefined {
  if (!id) return undefined;
  const r = results.get(id);
  results.delete(id);
  return r && now - r.at <= KEEP_MS ? r : undefined;
}

export const HOME_WRITES: ReadonlySet<string> = new Set(["/home/save"]);

const field = (form: Form, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};

/** Save the posted file; returns where to send the browser (see the header). */
export function homeSave(db: Db, home: string, form: Form, login: string | undefined, now: number): string {
  // The file by its logical path, and the profile whose copy it is (none: the base); a physical path is taken apart.
  const split = splitPath(field(form, "path"));
  const path = split.path;
  const profile = split.profile ?? (field(form, "profile") || undefined);
  // A Base-Commit trailer says what a PROFILE'S copy is based on (memory/home.ts); a base file has none to record.
  const baseCommit = profile && /^[0-9a-f]{7,40}$/.test(field(form, "basecommit")) ? field(form, "basecommit") : undefined;
  const back = (r: Omit<Result, "at" | "path">) => href("/home", { profile, file: path, pane: "edit", r: keep(now, { ...r, path, ...(profile ? { profile } : {}), ...(baseCommit && r.text !== undefined ? { baseCommit } : {}) }) });
  if (!consoleEditable(path) || path.startsWith("profiles/")) return href("/home", { r: keep(now, { path: "", flash: { tone: "refused", text: `${path || "That"} is not one of her files.` } }) });
  let phys = path;
  if (profile) {
    const layers = HomeLayers.of(home, profile);
    if (!layers.profile) return href("/home", { r: keep(now, { path, flash: { tone: "refused", text: `There is no profile ${profile}.` } }) });
    // Only the profile's own copy is edited here; an inherited file is Base's (Edit in Base, or Make a version).
    if (!layers.hasOwn(path)) return back({ flash: { tone: "refused", text: `${profile} has no version of ${path} of its own: make one first. Your text is below.` }, text: field(form, "text"), note: field(form, "note") });
    phys = layers.ownPath(path)!;
  }
  const note = field(form, "note").trim();
  const message = note || "Edited in console";
  const base = field(form, "base");
  const typed = field(form, "text").replace(/\r\n/g, "\n");
  const by = { console: login ? { login } : {}, ...(baseCommit ? { baseCommit } : {}) };
  const conflictOf = (current: string | null, ours: string, who: ConflictState["theirsWho"] | undefined): ConflictState => ({
    path,
    lang: langOf(path),
    theirs: current ?? "",
    ours,
    base: blobId(current),
    theirsWho: who ?? { kind: "external", name: "someone" },
    ...(profile ? { profile } : {}),
    ...(baseCommit ? { baseCommit } : {}),
  });

  for (let attempt = 0; ; attempt++) {
    const current = readHomeFile(home, phys);
    const text = current?.includes("\r\n") ? typed.replace(/\n/g, "\r\n") : typed;
    let toSave = text;
    let mergedWith: string | undefined;
    if (blobId(current) !== base) {
      const latest = fileHistory(db, home, phys, 1)[0];
      const whose = latest?.who.kind === "her" ? `shuvi changed it${latest.who.turnId ? ` (turn #${latest.who.turnId})` : ""}` : "it was changed";
      if (current === null) {
        const who = latest?.who.kind === "her" ? "shuvi" : "Someone";
        return back({ flash: { tone: "refused", text: `Not saved: ${who} removed this file while you were editing. Your text is still here; save again to create the file with it.` }, text, base: blobId(null), note });
      }
      const baseText = blobText(home, base);
      if (baseText === null) {
        // The version the edit began from was never committed: there is nothing to merge against.
        return back({ flash: { tone: "refused", text: `Not saved: ${whose} while you were editing. Both versions are below; save the one you want.` }, conflict: conflictOf(current, text, latest?.who), note });
      }
      const m = merge3(text, baseText, current, ["yours", "where you started", "saved now"]);
      if (!m.clean) return back({ flash: { tone: "refused", text: `Not saved yet: ${whose} while you were editing, in the same lines as you. Resolve it below, then save.` }, conflict: conflictOf(current, text, latest?.who), note });
      toSave = m.text;
      mergedWith = whose;
    }
    if (toSave === current) return back({ flash: { tone: "ok", text: "No change: the file already says that. Nothing was saved." } });
    try {
      const commit = commitHomeEdit(home, phys, toSave, message, { ...by, expect: current });
      // A sentence that starts with her name keeps it as written ("shuvi changed it"); "it was changed" is capitalised.
      const sentence = mergedWith?.startsWith("shuvi") ? mergedWith : mergedWith && `${mergedWith[0]!.toUpperCase()}${mergedWith.slice(1)}`;
      const kept = sentence ? ` ${sentence} meanwhile; that change was kept too.` : "";
      return back({ flash: { tone: "ok", text: `Saved${profile ? ` to ${profile}` : ""} (commit ${commit}).${kept} It applies from ${profile ? `the next turn of each chat on ${profile}` : "her next turn"}.` } });
    } catch (e) {
      // She committed between the look and the write: look again (merging her change in), a few times at most.
      if (e instanceof StaleEdit && attempt < 3) continue;
      // Hand back what was about to be saved, based on the version it was decided against: a merged text keeps her
      // change, so saving it again cannot lose it.
      return back({ flash: { tone: "failed", text: `Not saved: ${e instanceof Error ? e.message : String(e)}` }, text: toSave, base: blobId(current), note });
    }
  }
}

// ---- profiles (capabilities/memory/layers.ts) ------------------------------------------------------------------

/** The profile writes: each a POST through server.ts's write boundary, answering 303 with a one-time result. */
export const PROFILE_WRITES: ReadonlySet<string> = new Set(["/home/profile/new", "/home/profile/rename", "/home/profile/duplicate", "/home/profile/delete", "/home/profile/hide", "/home/profile/fork", "/home/profile/unfork"]);

/** Every file in a profile's folder, profile.yaml included, by its path in home/. */
function profileFiles(home: string, name: string): string[] {
  const root = join(home, profileDir(name));
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), `${rel}/${e.name}`);
      else out.push(`${rel}/${e.name}`);
    }
  };
  walk(root, profileDir(name));
  return out.sort();
}

/**
 * The base commit to record on a commit that copies a profile's files to new paths (Rename, Duplicate): the
 * oldest of their copies' (home-data.ts `baseSince`), so a copy never looks more up to date with the base than the
 * file it came from; the head when none has one.
 */
function oldestBase(home: string, name: string): string | undefined {
  const sinces = ownFiles(home, name).flatMap((f) => baseSince(home, `${profileDir(name)}/${f}`) ?? []);
  let oldest: string | undefined;
  for (const s of sinces) {
    if (!oldest) oldest = s;
    else if (Bun.spawnSync(["git", "-C", home, "merge-base", "--is-ancestor", s, oldest]).exitCode === 0) oldest = s;
  }
  return oldest ?? homeHead(home) ?? undefined;
}

const labelOf = (form: Form) => field(form, "label").trim().slice(0, 60);

/** A profile write; returns where to send the browser. */
export function profileWrite(db: Db, home: string, path: string, form: Form, login: string | undefined, now: number): string {
  const by = { console: login ? { login } : {} };
  const name = field(form, "profile");
  const file = field(form, "path");
  const to = (where: { profile?: string; file?: string; pane?: string; panel?: string }, flash: Flash) =>
    href("/home", { profile: where.profile, file: where.file, pane: where.pane ?? (where.file ? "edit" : "files"), panel: where.panel, r: keep(now, { path: where.file ?? "", flash, ...(where.profile ? { profile: where.profile } : {}) }) });
  const failed = (where: Parameters<typeof to>[0], e: unknown) => to(where, { tone: "failed", text: `Nothing was changed: ${e instanceof Error ? e.message : String(e)}` });

  if (path === "/home/profile/new") {
    const n = field(form, "name").trim();
    if (!PROFILE_NAME.test(n)) return to({ panel: "new" }, { tone: "refused", text: `"${n}" cannot name a profile: lowercase letters, digits and -, up to 32, starting with a letter or digit.` });
    if (existsSync(join(home, profileDir(n)))) return to({ profile: n }, { tone: "refused", text: `There is already a profile ${n}.` });
    try {
      const commit = commitHomeEdits(home, [{ rel: profileFile(n), content: profileYaml({ label: labelOf(form), hides: [] }) }], `New profile ${n}`, by);
      return to({ profile: n }, { tone: "ok", text: `Created ${n} (commit ${commit}). Every file comes from Base until you make its own version.` });
    } catch (e) {
      return failed({ panel: "new" }, e);
    }
  }

  const meta = readProfile(home, name);
  if (!meta) return to({}, { tone: "refused", text: `There is no profile ${name || "by that name"}.` });

  if (path === "/home/profile/rename" || path === "/home/profile/duplicate") {
    const rename = path === "/home/profile/rename";
    const n = field(form, "name").trim();
    const label = labelOf(form);
    const panel = rename ? "rename" : "duplicate";
    if (!PROFILE_NAME.test(n)) return to({ profile: name, panel }, { tone: "refused", text: `"${n}" cannot name a profile: lowercase letters, digits and -, up to 32, starting with a letter or digit.` });
    const yaml = profileYaml({ label, hides: meta.hides, ...(meta.hidePacks ? { hidePacks: meta.hidePacks } : {}) });
    if (rename && n === name) {
      try {
        const commit = commitHomeEdits(home, [{ rel: profileFile(name), content: yaml }], `Relabel profile ${name}`, by);
        return to({ profile: name }, { tone: "ok", text: `${name}'s label saved (commit ${commit}).` });
      } catch (e) {
        return failed({ profile: name }, e);
      }
    }
    if (existsSync(join(home, profileDir(n)))) return to({ profile: name, panel }, { tone: "refused", text: `There is already a profile ${n}.` });
    const files = profileFiles(home, name);
    const copies = files.map((f) => ({ rel: `${profileDir(n)}${f.slice(profileDir(name).length)}`, content: f === profileFile(name) ? yaml : readFileSync(join(home, f), "utf8") }));
    const changes = rename ? [...files.map((f) => ({ rel: f, content: null })), ...copies] : copies;
    // A rename moves its chats once the new files are on disk and before the old ones go (`commitHomeEdits`), so a
    // turn starting meanwhile finds its profile under either name; a failed commit moves them back.
    let moved = false;
    try {
      const commit = commitHomeEdits(home, changes, rename ? `Rename profile ${name} to ${n}` : `Duplicate profile ${name} as ${n}`, { ...by, ...(ownFiles(home, name).length ? { baseCommit: oldestBase(home, name) } : {}) }, rename ? () => {
        renameChatsProfile(db, name, n);
        moved = true;
      } : undefined);
      return to({ profile: n }, { tone: "ok", text: rename ? `Renamed ${name} to ${n} (commit ${commit}); its chats stay on it.` : `Duplicated ${name} as ${n} (commit ${commit}). No chat uses it yet.` });
    } catch (e) {
      if (moved) renameChatsProfile(db, n, name);
      return failed({ profile: name, panel }, e);
    }
  }

  if (path === "/home/profile/delete") {
    const chats = chatsOnProfile(db, name);
    try {
      const commit = commitHomeEdits(home, profileFiles(home, name).map((rel) => ({ rel, content: null })), `Delete profile ${name}`, by);
      clearChatsProfile(db, name);
      return to({}, { tone: "ok", text: `Deleted ${name} (commit ${commit}); its files stay in history.${chats.length ? ` ${chats.length} chat${chats.length === 1 ? "" : "s"} went back to Base.` : ""}` });
    } catch (e) {
      return failed({ profile: name, panel: "delete" }, e);
    }
  }

  // Hide / Unhide: a playbook (by name) or a sticker pack (by its file's name, its pack: memory/layers.ts).
  const pb = /^playbooks\/(.+)\.md$/.exec(file)?.[1];
  const pack = file === STICKER_PREFERENCES ? undefined : packOfFile(file);
  if (path === "/home/profile/hide") {
    const what = pb && PLAYBOOK_NAME.test(pb) ? pb : pack && PACK_NAME.test(pack) ? pack : undefined;
    if (!what) return to({ profile: name, file }, { tone: "refused", text: `${file} is not a playbook or a sticker pack.` });
    const hide = field(form, "hide") !== "0";
    const flip = (list: readonly string[]) => (hide ? [...list, what] : list.filter((h) => h !== what));
    const next = { ...(meta.label ? { label: meta.label } : {}), hides: pb ? flip(meta.hides) : meta.hides, hidePacks: pack ? flip(meta.hidePacks ?? []) : (meta.hidePacks ?? []) };
    const kind = pb ? "playbook" : "sticker pack";
    try {
      const commit = commitHomeEdits(home, [{ rel: profileFile(name), content: profileYaml(next) }], `${hide ? "Hide" : "Unhide"} ${kind} ${what} in ${name}`, by);
      return to({ profile: name, file }, { tone: "ok", text: hide ? `Chats on ${name} no longer see the ${kind} ${what} (commit ${commit}).` : `Chats on ${name} see the ${kind} ${what} again (commit ${commit}).` });
    } catch (e) {
      return failed({ profile: name, file }, e);
    }
  }

  if (!consoleEditable(file) || file.startsWith("profiles/")) return to({ profile: name }, { tone: "refused", text: `${file || "That"} is not one of her files.` });
  const own = `${profileDir(name)}/${file}`;
  if (path === "/home/profile/fork") {
    const text = readHomeFile(home, file);
    if (existsSync(join(home, own))) return to({ profile: name, file }, { tone: "refused", text: `${name} already has its own version of ${file}.` });
    if (text === null) return to({ profile: name, file }, { tone: "refused", text: `Base has no ${file} to copy.` });
    const head = homeHead(home);
    try {
      const commit = commitHomeEdits(home, [{ rel: own, content: text }], `Make a ${name} version of ${file}`, { ...by, ...(head ? { baseCommit: head } : {}) });
      return to({ profile: name, file }, { tone: "ok", text: `Made a ${name} version of ${file} (commit ${commit}). Chats on ${name} get it from their next turn.` });
    } catch (e) {
      return failed({ profile: name, file }, e);
    }
  }
  // unfork
  if (!existsSync(join(home, own))) return to({ profile: name, file }, { tone: "refused", text: `${name} has no version of ${file} of its own.` });
  try {
    const commit = commitHomeEdit(home, own, null, `Remove the ${name} version of ${file}`, by);
    return to({ profile: name, file }, { tone: "ok", text: `Removed ${name}'s version of ${file} (commit ${commit}); its text stays in history.${existsSync(join(home, file)) ? ` Chats on ${name} get Base's text from their next turn.` : ""}` });
  } catch (e) {
    return failed({ profile: name, file }, e);
  }
}

/** Where a chat page's Profile select posts: `/chats/<id>/profile`. */
export const CHAT_PROFILE_WRITE = /^\/chats\/(\d+)\/profile$/;

/** Switch a chat's profile (store/profiles.ts); answers 303 to the chat's page with the result, once. */
export function chatProfileWrite(db: Db, home: string, chatId: number, form: Form, now: number): string {
  const back = (flash: Flash) => href(`/chats/${chatId}`, { r: keep(now, { path: "", flash }) });
  const chat = chatById(db, chatId);
  if (!chat) return back({ tone: "refused", text: "There is no such chat." });
  const name = field(form, "profile") || null;
  if (name && !readProfile(home, name)) return back({ tone: "refused", text: `There is no profile ${name}.` });
  const label = chatName(chat);
  if (name === chat.profile) return back({ tone: "ok", text: `${label} is already on ${name ?? "Base"}.` });
  setChatProfile(db, chatId, name);
  return back({ tone: "ok", text: `${label} now runs on ${name ?? "Base"}, from its next turn.` });
}
