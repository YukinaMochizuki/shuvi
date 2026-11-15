import { counts, ghDiff } from "./ghdiff.ts";
import { ago, href, html, page, raw, when, type Raw } from "./html.ts";

/**
 * The Home page (DESIGN.md "Home"): her files in home/, edited by hand, with each file's history. Three panes:
 *
 *   files     every editable file, grouped (herself, chat notes, playbooks, stickers), each with who changed it
 *             last and when;
 *   main      the selected file in CodeMirror (editor/editor.ts; a plain textarea without script), or a history
 *             entry's diff (GitHub-style, server-rendered: ghdiff.ts), or a conflict to resolve;
 *   history   the selected file's commits, newest first: who (her: the chat, turn and tool call; you from the
 *             console; or an outside git commit), when, the message, +/−. It folds away.
 *
 * This module only DRAWS: `HomeView` is everything a page shows, put together by home-data.ts, and every write
 * goes through home-write.ts. Under 760px one pane shows at a time, chosen by `?pane=` (files, edit, history).
 */

/** Who made a change. `her`: the assistant, in a chat's turn, by one tool call (when known). */
export type Who =
  | { kind: "her"; chatLabel?: string; turnId?: number; callId?: string; tool?: string; inferred?: boolean }
  | { kind: "owner"; login?: string }
  | { kind: "external"; name: string };

export interface HistEntry {
  commit: string;
  short: string;
  at: string;
  who: Who;
  message: string;
  add: number;
  del: number;
  /** This commit created the file, or removed it. */
  created?: boolean;
  removed?: boolean;
}

export interface FileRow {
  path: string;
  /** What it is, in a few words: "who she is, in every chat" (the row's tooltip). */
  hint: string;
  /** The row's name when the path says nothing (a chat's notes: the chat's name). */
  title?: string;
  exists: boolean;
  last?: { who: Who; at: string };
  /**
   * In a profile's view, where the file in effect comes from: `inherits` (Base's), `own` (the profile's copy of a
   * Base file), `only` (a playbook or pack only this profile has), `hidden` (a Base playbook the profile hides).
   */
  layer?: "inherits" | "own" | "only" | "hidden";
  /** A playbook or a sticker pack: its bar offers Hide / Unhide in a profile's view. */
  hideable?: boolean;
}

/** A chat, as the profile parts name it. */
export interface ChatRef {
  id: number;
  label: string;
}

/** One profile (home/profiles/<name>/profile.yaml), and the chats that use it. */
export interface ProfileInfo {
  name: string;
  label?: string;
  usedBy: ChatRef[];
  /** How many files it has its own copy of (hidden playbooks included). */
  own: number;
}

/** The layer switch and the profile the files pane shows (undefined: Base). */
export interface Layers {
  profiles: ProfileInfo[];
  current?: ProfileInfo;
  /** The chats on no profile. */
  baseUsedBy: ChatRef[];
  /** A panel open under the switch: a new profile, or the ⋯ menu's Rename / Duplicate / Delete. */
  panel?: "new" | "rename" | "duplicate" | "delete";
}

export interface FileGroup {
  label: string;
  files: FileRow[];
}

export interface Flash {
  tone: "ok" | "refused" | "failed";
  text: string;
}

export interface EditState {
  path: string;
  lang: "markdown" | "yaml";
  /** The file as saved (null: it does not exist yet). */
  saved: string | null;
  /** What the editor opens with: `saved`, or a revert / restore loaded unsaved, or the text a refused save carried. */
  text: string;
  /** The version the edit starts from: a save sends it back, so a change made meanwhile is merged, not lost. */
  base: string;
  /** Why the editor holds something other than the saved file ("Undo of 8e41c2a loaded."). */
  loaded?: string;
  /** The note field's value (kept across a refused save). */
  note?: string;
  /**
   * In a profile's view: `inherited` (Base's text, read-only, with "Edit in Base" / "Make a <p> version"), `own`
   * (the profile's copy: it is what is edited and saved), `only` (a file only the profile has).
   */
  layer?: {
    profile: string;
    kind: "inherited" | "own" | "only";
    /** A Base playbook or sticker pack the profile hides (shown read-only, with Unhide). */
    hidden?: boolean;
    /** A playbook or a sticker pack: the bar offers Hide in <p>. */
    hideable?: boolean;
    /** The own version is empty: the bar offers Copy from Base. */
    empty?: boolean;
    /** Base's file changed since the own version was made: how many commits, from which Base commit. */
    baseChanged?: { n: number; since: string };
  };
  /**
   * The Base commit the text in the editor is based on, when it carries Base's text or Base's changes (Copy from
   * Base, Apply them): a save records it as the commit's `Base-Commit` trailer.
   */
  baseCommit?: string;
  /** "Remove the <p> version" asked: the confirmation shows. */
  confirmRemove?: boolean;
}

export interface DiffState {
  entry: HistEntry;
  /** `change`: the commit against its parent; `now`: that version against the file now. */
  compare: "change" | "now";
  layout: "unified" | "split";
  /** The two texts compared, older first. */
  before: string;
  after: string;
  /** `git revert` of this commit on the file now would conflict with later changes. */
  revertConflicts: boolean;
}

export interface ConflictState {
  path: string;
  lang: "markdown" | "yaml";
  /** The file as it is now (her change included), and yours. */
  theirs: string;
  ours: string;
  /** The current version, which the resolved save is based on. */
  base: string;
  theirsWho: Who;
  /** What happened, when it is not "you and someone changed the same lines" (an undo that overlaps later changes). */
  reason?: string;
  note?: string;
  /** The profile whose copy is being saved (none: Base). */
  profile?: string;
  /** As EditState's: Base's changes being applied, recorded on the save. */
  baseCommit?: string;
  /** The labels over the two sides (default: "Saved now" / "Yours (this is saved)"). */
  sides?: [string, string];
}

/** Base's changes to a file since a profile's own version was made ("View Base's changes"). */
export interface BaseDiffState {
  path: string;
  profile: string;
  /** Base's commit the own version was made from, and the texts compared: Base then, Base now. */
  since: string;
  sinceShort: string;
  before: string;
  after: string;
  /** Base's commits to the file since, newest first. */
  entries: HistEntry[];
}

/** A prompt section in the Preview, and the layer its text came from (`code`: a capability's, not a file). */
export interface PreviewSection {
  label: string;
  text: string;
  source: { kind: "base" } | { kind: "profile"; name: string } | { kind: "code" };
  /** The file it was read from, when one. */
  file?: string;
}

export interface PreviewState {
  chats: (ChatRef & { profile?: string })[];
  chat?: ChatRef & { profile?: string };
  sections: PreviewSection[];
  /** The chat's profile no longer exists: it runs on Base. */
  missingProfile?: string;
}

export type MainPane =
  | { mode: "none" }
  | { mode: "preview"; preview: PreviewState }
  | { mode: "basediff"; basediff: BaseDiffState }
  | { mode: "edit"; edit: EditState }
  | { mode: "diff"; path: string; diff: DiffState }
  | { mode: "conflict"; conflict: ConflictState };

export interface HomeView {
  layers: Layers;
  groups: FileGroup[];
  history: HistEntry[];
  main: MainPane;
  selected?: string;
  historyOpen: boolean;
  /** The narrow layout's pane. */
  pane: "files" | "edit" | "history";
  flash?: Flash;
  csrf: string;
  timeZone: string;
  now: number;
  who?: string;
}

// ---- small parts -------------------------------------------------------------------------------------------

/** Who, in plain words: the assistant by her name in this product, you, or a git author. */
export function whoLabel(w: Who): string {
  if (w.kind === "her") return "shuvi";
  if (w.kind === "owner") return "you";
  return w.name;
}

/** The dot that says who: hers in the accent, yours in amber, anything else grey. */
function whoDot(w: Who): Raw {
  return html`<span class="wdot w-${w.kind}" aria-hidden="true"></span>`;
}

/** The link to the tool call that made a change, in the turn's page. */
export function stepHref(turnId: number, callId?: string): string {
  return `/turns/${turnId}${callId ? `#call-${encodeURIComponent(callId)}` : ""}`;
}

/** Where a change was made: chat · turn #n · tool (the turn a link to the call), or console · login, or git. */
function whoWhere(w: Who): Raw {
  if (w.kind === "her") {
    const parts: Raw[] = [];
    if (w.chatLabel) parts.push(html`<span>${w.chatLabel}</span>`);
    if (w.turnId) parts.push(html`<a href="${stepHref(w.turnId, w.callId)}">turn #${w.turnId}</a>`);
    if (w.tool) parts.push(html`<span class="mono">${w.tool}</span>`);
    if (w.inferred) parts.push(html`<span class="faint" title="Found through the turn's transcript; the commit itself does not record it">inferred</span>`);
    if (!parts.length) parts.push(html`<span class="faint">turn not recorded</span>`);
    return html`${parts.map((p, i) => html`${i ? html`<span class="sep"></span>` : ""}${p}`)}`;
  }
  if (w.kind === "owner") return html`<span>console${w.login ? html`<span class="sep"></span>${w.login}` : ""}</span>`;
  return html`<span>git</span>`;
}

/** The same, as plain short text for a history row: `DM · Owner · #812`. */
function whoShort(w: Who): string {
  if (w.kind === "her") return [w.chatLabel, w.turnId ? `#${w.turnId}` : null].filter(Boolean).join(" · ");
  return w.kind === "owner" ? "console" : "git";
}

function plusMinus(add: number, del: number): Raw {
  return html`<span class="pm"><span class="c-done">+${add}</span> <span class="c-failed">−${del}</span></span>`;
}

const homeHref = (q: Record<string, string | number | undefined>) => href("/home", q);

/**
 * What the open file is for (its row's hint, and for a chat's notes the chat), shown quietly at the right of the
 * editor's header: there when wanted, out of the way otherwise (the owner rarely needs it).
 */
function hintOf(v: HomeView, path: string): string {
  for (const g of v.groups) {
    const f = g.files.find((x) => x.path === path);
    if (f) return [f.title, f.hint].filter(Boolean).join(" · ");
  }
  return "";
}

/**
 * The HTML parser drops ONE newline right after `<textarea>`: this one, so a file that starts with a newline keeps it
 * (in the textarea's value, which is what CodeMirror opens and a form posts).
 */
const TEXTAREA_LEAD = raw("\n");

/** A Home URL in the profile the page shows (Base: no `profile`). */
const vHref = (v: HomeView, q: Record<string, string | number | undefined>) => homeHref({ profile: v.layers.current?.name, ...q });

function flashNote(f: Flash | undefined): Raw | "" {
  return f ? html`<p class="notice ${f.tone} hflash" role="status">${f.text}</p>` : "";
}

const chatList = (cs: readonly ChatRef[]): Raw | string => (cs.length ? html`${cs.map((c, i) => html`${i ? ", " : ""}<a href="/chats/${c.id}">${c.label}</a>`)}` : "no chat");

// ---- the layer switch and the profile's parts ----------------------------------------------------------------

const NAME_PATTERN = "[a-z0-9][a-z0-9\\-]{0,31}";
const NAME_TITLE = "Lowercase letters, digits and -, up to 32; it names the folder home/profiles/<name>/";

/**
 * The layer switch, one row: Base, a select of the profiles (any number of them; picking one opens it, console.js
 * submits on change and a Go button does without script), and "+ New profile". The layer shown is the filled one.
 */
function layerSwitch(v: HomeView): Raw {
  const L = v.layers;
  const cur = L.current?.name;
  return html`<div class="hlayers">
<div class="hlrow"><a class="hlbase${cur ? "" : " on"}" href="${homeHref({ file: v.selected, pane: "files" })}"${cur ? "" : raw(' aria-current="true"')}>Base</a>
<form class="hlpick${cur ? " on" : ""}" method="get" action="/home">${v.selected ? html`<input type="hidden" name="file" value="${v.selected}">` : ""}<input type="hidden" name="pane" value="files"><select name="profile" data-autosubmit aria-label="Profile"${L.profiles.length ? "" : raw(" disabled")}>${cur ? "" : html`<option value="" selected disabled>${L.profiles.length ? `Profile… (${L.profiles.length})` : "No profiles yet"}</option>`}${L.profiles.map(
    (p) => html`<option value="${p.name}"${p.name === cur ? raw(" selected") : ""}>${p.label ? `${p.label} · ${p.name}` : p.name}</option>`,
  )}</select><button class="btn tiny" type="submit" data-autosubmit-btn>Go</button></form>
<a class="hlnew${L.panel === "new" ? " on" : ""}" href="${vHref(v, { file: v.selected, panel: "new", pane: "files" })}">+ New profile</a></div>
${L.current ? profileHead(v, L.current) : html`<div class="hprof"><p class="hp2">shuvi's files as they are; a profile replaces some of them.</p><p class="hp2">Used by: ${chatList(L.baseUsedBy)}</p></div>`}
${L.panel ? layerPanel(v, L.panel) : ""}
</div>`;
}

function profileHead(v: HomeView, p: ProfileInfo): Raw {
  const act = (panel: string) => vHref(v, { file: v.selected, panel, pane: "files" });
  return html`<div class="hprof">
<div class="hp1"><b>${p.label ?? p.name}</b>${p.label ? html`<span class="mono faint">${p.name}</span>` : ""}
<details class="pmenu"><summary aria-label="Profile actions" title="Rename, duplicate or delete ${p.name}">⋯</summary><div class="pmenu-list"><a href="${act("rename")}">Rename</a><a href="${act("duplicate")}">Duplicate</a><a class="c-failed" href="${act("delete")}">Delete</a></div></details></div>
<p class="hp2">Used by: ${chatList(p.usedBy)}</p>
<p class="hp3 faint">${p.own ? `${p.own} file${p.own === 1 ? "" : "s"} of its own` : "No files of its own yet"}; everything else from Base.</p>
</div>`;
}

function layerPanel(v: HomeView, panel: NonNullable<Layers["panel"]>): Raw {
  const p = v.layers.current;
  const cancel = html`<a class="btn" href="${vHref(v, { file: v.selected, pane: "files" })}">Cancel</a>`;
  const hidden = html`<input type="hidden" name="csrf" value="${v.csrf}">${p ? html`<input type="hidden" name="profile" value="${p.name}">` : ""}`;
  const nameField = (label: string, value = "") =>
    html`<label>${label}<input type="text" name="name" value="${value}" required pattern="${NAME_PATTERN}" maxlength="32" title="${NAME_TITLE}" autocomplete="off" spellcheck="false"></label>`;
  const labelField = (value = "") => html`<label>Label <span class="faint">(optional)</span><input type="text" name="label" value="${value}" maxlength="60" autocomplete="off"></label>`;
  if (panel === "new" || !p)
    return html`<form class="hpanel" method="post" action="/home/profile/new">${hidden}
<p class="hpt">New profile</p>
${nameField("Name")}${labelField()}
<p class="faint">It starts with nothing of its own: every file comes from Base until you make its own version. Switch a chat to it on that chat's settings page (⚙ Settings beside its name), or with /profile in the control bot.</p>
<div class="hpbtns"><button class="btn primary" type="submit">Create</button>${cancel}</div></form>`;
  if (panel === "rename")
    return html`<form class="hpanel" method="post" action="/home/profile/rename">${hidden}
<p class="hpt">Rename ${p.name}</p>
${nameField("New name", p.name)}${labelField(p.label)}
<p class="faint">Its files move to profiles/&lt;new name&gt;/ in one commit; ${p.usedBy.length ? "its chats stay on it" : "no chat uses it"}.</p>
<div class="hpbtns"><button class="btn primary" type="submit">Rename</button>${cancel}</div></form>`;
  if (panel === "duplicate")
    return html`<form class="hpanel" method="post" action="/home/profile/duplicate">${hidden}
<p class="hpt">Duplicate ${p.name}</p>
${nameField("Name of the copy", `${p.name}-copy`.slice(0, 32))}${labelField(p.label ? `${p.label} (copy)` : "")}
<p class="faint">A copy of its own files and what it hides, in one commit. No chat uses the copy until you switch one to it.</p>
<div class="hpbtns"><button class="btn primary" type="submit">Duplicate</button>${cancel}</div></form>`;
  return html`<form class="hpanel danger" method="post" action="/home/profile/delete">${hidden}
<p class="hpt">Delete ${p.name}?</p>
<p>${p.own ? `Its ${p.own} file${p.own === 1 ? "" : "s"} of its own ${p.own === 1 ? "is" : "are"} removed in one commit; the text stays in history.` : "It has no files of its own."}</p>
<p>${p.usedBy.length ? html`These chats go back to Base: ${chatList(p.usedBy)}.` : "No chat uses it."}</p>
<div class="hpbtns"><button class="btn danger solid" type="submit">Delete ${p.name}</button>${cancel}</div></form>`;
}

/** A file row's status in a profile's view, at the start of its second line. */
function layerMark(f: FileRow, profile: string): Raw | "" {
  if (f.layer === "inherits") return html`<span class="lmark inh">inherits</span><span class="sep"></span>`;
  if (f.layer === "own") return html`<span class="lmark own">own</span><span class="sep"></span>`;
  if (f.layer === "only") return html`<span class="lmark own">only in ${profile}</span><span class="sep"></span>`;
  if (f.layer === "hidden") return html`<span class="lmark lhidden">hidden</span><span class="sep"></span>`;
  return "";
}

// ---- panes -------------------------------------------------------------------------------------------------

function filesPane(v: HomeView): Raw {
  const p = v.layers.current;
  return html`<nav class="hfiles" aria-label="Files">
${layerSwitch(v)}
${v.groups.map(
  (g) => html`<section class="hgroup"><h2>${g.label}</h2>
${g.files.map((f) => {
  const on = f.path === v.selected && v.main.mode !== "preview";
  // One name per row: the file's, or for a chat's notes the chat's (its path means nothing to read). What the file
  // is for, and the path, are in the tooltip; the second line says only, in a profile, where the file comes from,
  // and who last changed it.
  const name = f.title ?? f.path;
  const cls = `hfile${on ? " on" : ""}${f.exists ? "" : " missing"}${f.layer === "hidden" ? " hidden-pb" : ""}${f.layer === "inherits" ? " inh" : ""}`;
  return html`<a class="${cls}" href="${vHref(v, { file: f.path, pane: "edit" })}" title="${[f.title ? f.path : "", f.hint].filter(Boolean).join(" — ")}"${on ? raw(' aria-current="page"') : ""}>
<span class="hf1"><span class="hpath${f.title ? "" : " mono"}">${name}</span>${f.last ? html`<span class="hwhen">${ago(f.last.at, v.now)}</span>` : ""}</span>
<span class="hf2">${p ? layerMark(f, p.name) : ""}${f.exists ? (f.last ? html`${whoDot(f.last.who)}<span>edited by ${whoLabel(f.last.who)}</span>` : html`<span class="faint">no history</span>`) : html`<span class="faint">not created yet</span>`}</span>
</a>`;
})}
</section>`,
)}
</nav>`;
}

/** The tabs over the main pane: the file, and the Preview of a chat's system prompt. */
function mainTabs(v: HomeView): Raw {
  const preview = v.main.mode === "preview";
  return html`<div class="htabs" role="tablist"><a role="tab" class="${preview ? "" : "on"}" href="${vHref(v, { file: v.selected, pane: "edit" })}"${preview ? "" : raw(' aria-selected="true"')}>${v.selected ? html`<span class="mono">${v.selected}</span>` : "File"}</a><a role="tab" class="${preview ? "on" : ""}" href="${vHref(v, { file: v.selected, view: "preview", pane: "edit" })}"${preview ? raw(' aria-selected="true"') : ""}>Preview</a></div>`;
}

/** A small POST form of one button (a profile write), carrying the page's CSRF token, the profile and the file. */
function actionForm(v: HomeView, action: string, profile: string, path: string, label: string, cls = "btn", extra: Record<string, string> = {}): Raw {
  return html`<form class="hlform" method="post" action="${action}"><input type="hidden" name="csrf" value="${v.csrf}"><input type="hidden" name="profile" value="${profile}"><input type="hidden" name="path" value="${path}">${Object.entries(extra).map(([k, val]) => html`<input type="hidden" name="${k}" value="${val}">`)}<button class="${cls}" type="submit">${label}</button></form>`;
}

/** The bar over a file in a profile's view: where its text comes from, and what to do about it. */
function layerBar(v: HomeView, e: EditState): Raw | "" {
  const l = e.layer;
  if (!l) return "";
  const p = l.profile;
  const inBase = html`<a class="btn" href="${homeHref({ file: e.path, pane: "edit" })}">Edit in Base</a>`;
  const hide = l.hideable ? actionForm(v, "/home/profile/hide", p, e.path, `Hide in ${p}`, "btn", { hide: "1" }) : "";
  if (l.hidden)
    return html`<div class="hlbar hid"><span><b>Hidden in ${p}.</b> <span class="faint">Chats on ${p} do not see this ${e.path.startsWith("stickers/") ? "sticker pack" : "playbook"}. This is Base's text.</span></span><span class="hlact">${inBase}${actionForm(v, "/home/profile/hide", p, e.path, "Unhide", "btn", { hide: "0" })}</span></div>`;
  if (l.kind === "inherited")
    return html`<div class="hlbar inh"><span><b>Inherited from Base.</b> <span class="faint">Chats on ${p} get Base's text; read-only here.</span></span><span class="hlact">${inBase}${hide}${actionForm(v, "/home/profile/fork", p, e.path, `Make a ${p} version`, "btn primary")}</span></div>`;
  const removeLabel = l.kind === "own" ? `Remove the ${p} version` : `Remove it from ${p}`;
  if (e.confirmRemove)
    return html`<div class="hlbar ask"><span>${l.kind === "own" ? `Remove ${p}'s version of ${e.path}? Chats on ${p} go back to Base's text.` : `Remove ${e.path} from ${p}?`} <span class="faint">Its text stays in this file's history.</span></span><span class="hlact">${actionForm(v, "/home/profile/unfork", p, e.path, removeLabel, "btn danger solid")}<a class="btn" href="${vHref(v, { file: e.path, pane: "edit" })}">Cancel</a></span></div>`;
  const what = l.kind === "own" ? html`<b>${p}'s own version.</b> <span class="faint">Chats on ${p} get this text instead of Base's.</span>` : html`<b>Only in ${p}.</b> <span class="faint">Base has no such file.</span>`;
  const copy = l.kind === "own" && l.empty ? html`<a class="btn primary" href="${vHref(v, { file: e.path, pane: "edit", copybase: "1" })}" title="Loads Base's text into the editor; nothing is saved until you save">Copy from Base</a>` : "";
  const changed = l.baseChanged;
  return html`<div class="hlbar own"><span class="ldot" aria-hidden="true"></span><span>${what}</span><span class="hlact">${copy}${l.kind === "own" ? html`<a class="btn" href="${homeHref({ file: e.path, pane: "edit" })}">Base's version</a>` : ""}${hide}<a class="btn" href="${vHref(v, { file: e.path, pane: "edit", remove: "1" })}">${removeLabel}</a></span>${
    changed
      ? html`<span class="hlchanged"><span class="c-lost">Base changed since this version was made</span> <span class="faint">(${changed.n} change${changed.n === 1 ? "" : "s"})</span><span class="sep"></span><a href="${vHref(v, { file: e.path, pane: "edit", basediff: "1" })}">View Base's changes</a><a class="btn" href="${vHref(v, { file: e.path, pane: "edit", applybase: "1" })}" title="Merges Base's changes into this version and loads it into the editor; nothing is saved until you save">Apply them</a></span>`
      : ""
  }</div>`;
}

function editPane(v: HomeView, e: EditState): Raw {
  const clean = e.text === (e.saved ?? "");
  const readOnly = e.layer?.kind === "inherited" || !!e.layer?.hidden;
  const p = e.layer?.profile;
  // The bar's buttons are forms of their own (a profile write is small; a save carries the whole file), so the save
  // form is only the editor and its row (`display: contents`: it takes no box in the pane's column).
  return html`<section class="hedit">
${mainTabs(v)}
<div class="hhead">
  <a class="back" href="${vHref(v, { pane: "files", file: e.path })}">‹ Files</a>
  <h1 class="mono">${p && !readOnly ? html`<span class="hlayer-of">${p} /</span> ` : ""}${e.path}</h1>
  <span class="dirty" data-dirty${clean ? raw(" hidden") : ""}>${clean ? "" : "Unsaved"}</span>
  <span class="hhead-r">${hintOf(v, e.path) ? html`<span class="hhint">${hintOf(v, e.path)}</span>` : ""}<a class="btn hist-toggle" href="${vHref(v, { file: e.path, pane: "history" })}">History</a></span>
</div>
${layerBar(v, e)}
${flashNote(v.flash)}
<div class="hwatch" hx-get="${href("/home/watch", { file: e.path, base: e.base, profile: readOnly ? undefined : p })}" hx-trigger="every 5s" hx-swap="innerHTML"></div>
${e.loaded ? html`<p class="hloaded">${e.loaded} <span class="faint">Not saved yet: look it over, then save.</span></p>` : ""}
<form class="hform" method="post" action="/home/save">
<input type="hidden" name="csrf" value="${v.csrf}"><input type="hidden" name="path" value="${e.path}"><input type="hidden" name="base" value="${e.base}">${p ? html`<input type="hidden" name="profile" value="${p}">` : ""}${e.baseCommit ? html`<input type="hidden" name="basecommit" value="${e.baseCommit}">` : ""}
<div class="hcode${readOnly ? " ro" : ""}"><textarea name="text" data-editor data-lang="${e.saved === null && e.path.endsWith(".yaml") ? "yaml" : e.lang}" data-saved="${e.saved ?? ""}"${readOnly ? raw(" readonly data-readonly") : ""} spellcheck="false" aria-label="${e.path}">${TEXTAREA_LEAD}${e.text}</textarea></div>
${
  readOnly
    ? ""
    : html`<div class="hsave">
  <input type="text" name="note" value="${e.note ?? ""}" placeholder="Note (optional): why you changed it" maxlength="200" aria-label="Note (optional)">
  <button class="btn primary" type="submit">Save${p ? ` to ${p}` : ""}</button><span class="kbd faint">⌘S</span>
</div>`
}
</form>
</section>`;
}

/** Base's changes to a file since a profile's own version of it was made: Base then → Base now. */
function baseDiffPane(v: HomeView, b: BaseDiffState): Raw {
  const diff = ghDiff(b.before, b.after, { view: "unified", full: true });
  return html`<section class="hedit hdiff">
${mainTabs(v)}
<div class="hhead">
  <a class="back" href="${vHref(v, { file: b.path, pane: "edit" })}">‹ ${b.profile}'s version</a>
  <h1 class="mono">${b.path}</h1>
  <span class="hhead-r"><a class="btn" href="${vHref(v, { file: b.path, pane: "edit" })}">Back to editing</a></span>
</div>
<div class="hcommit"><p class="hc1"><b>Base's changes since ${b.profile}'s version was made</b><span class="faint">from <span class="mono">${b.sinceShort}</span> to now · ${b.entries.length} change${b.entries.length === 1 ? "" : "s"}</span></p>
<ul class="hbchanges">${b.entries.map((e) => html`<li>${whoDot(e.who)}<b>${whoLabel(e.who)}</b><span class="hmsg">${e.message}</span><span class="faint">${ago(e.at, v.now)} · <span class="mono">${e.short}</span></span>${plusMinus(e.add, e.del)}</li>`)}</ul></div>
<div class="hdbar">${counts(diff.add, diff.del)}<span class="hdact"><a class="btn primary" href="${vHref(v, { file: b.path, pane: "edit", applybase: "1" })}" title="Merges these changes into ${b.profile}'s version and loads it into the editor, unsaved">Apply them to ${b.profile}'s version</a></span></div>
<div class="hdiffbody"><p class="hdnote faint">Left: Base when ${b.profile}'s version was made (${b.sinceShort}). Right: Base now.</p>${diff.html}</div>
</section>`;
}

const sourceLabel = (s: PreviewSection["source"]) => (s.kind === "profile" ? s.name : s.kind === "base" ? "base" : "code");

/** The Preview: the system prompt a chat would get now, section by section, each with the layer it came from. */
function previewPane(v: HomeView, pv: PreviewState): Raw {
  const p = v.layers.current?.name;
  const sizes = pv.sections.map((s) => s.text.length);
  const max = Math.max(1, ...sizes);
  const fromProfile = pv.sections.filter((s) => s.source.kind === "profile").length;
  return html`<section class="hedit hpreview">
${mainTabs(v)}
<div class="hhead">
  <a class="back" href="${vHref(v, { pane: "files", file: v.selected })}">‹ Files</a>
  <h1>System prompt</h1>
  <form class="hpick" method="get" action="/home">${p ? html`<input type="hidden" name="profile" value="${p}">` : ""}${v.selected ? html`<input type="hidden" name="file" value="${v.selected}">` : ""}<input type="hidden" name="view" value="preview"><input type="hidden" name="pane" value="edit">
  <label>for <select name="chat" data-autosubmit aria-label="Chat">${pv.chats.map((c) => html`<option value="${c.id}"${c.id === pv.chat?.id ? raw(" selected") : ""}>${c.label} · ${c.profile ?? "Base"}</option>`)}</select></label>
  <button class="btn" type="submit" data-autosubmit-btn>Show</button></form>
</div>
${
  pv.chat
    ? html`<p class="hpnote">What <b>${pv.chat.label}</b> would get at its next turn, on <b>${pv.chat.profile ?? "Base"}</b>${pv.missingProfile ? html` <span class="c-lost">(its profile ${pv.missingProfile} no longer exists: it runs on Base)</span>` : ""}: ${pv.sections.length} sections${pv.chat.profile ? `, ${fromProfile} from ${pv.chat.profile}` : ""}. ${p && pv.chat.profile !== p ? html`<span class="c-lost">This chat is not on ${p}.</span> ` : ""}<span class="faint">Capability sections are written in code.</span></p>
<div class="sections hpsections">${pv.sections.map(
        (s, i) =>
          html`<details><summary><span class="lbl">${s.label}<span class="psrc src-${s.source.kind}">· ${sourceLabel(s.source)}</span></span><span class="bar"><i style="width:${Math.max(2, Math.round((sizes[i]! / max) * 100))}%"></i></span><span class="size">${s.text.length.toLocaleString("en-US")} chars</span></summary><div class="inner"><pre class="code prose">${s.text}</pre></div></details>`,
      )}</div>`
    : html`<p class="empty">No chat yet: a preview needs one.</p>`
}
</section>`;
}

/** The line that says the file changed while you were editing it (the watch route draws it). */
export function changedBanner(entry: HistEntry, path: string, profile?: string): Raw {
  return html`<p class="hchanged" role="status">${whoDot(entry.who)}<span><b>${entry.who.kind === "owner" ? "You" : whoLabel(entry.who)}</b> just changed this file ${plusMinus(entry.add, entry.del)}</span>
<span class="faint">${whoWhere(entry.who)}</span>
<a href="${homeHref({ profile, file: path, at: entry.commit, pane: "edit" })}" target="_blank" rel="noopener">View change</a>
<span class="faint">Your save will keep it.</span></p>`;
}

function diffPane(v: HomeView, path: string, d: DiffState): Raw {
  const e = d.entry;
  const q = (over: Record<string, string>) => vHref(v, { file: path, at: e.commit, compare: d.compare, layout: d.layout, pane: "edit", ...over });
  // The whole file, nothing folded: the owner reads a change in its context (editor.ts scrolls to the first one).
  const diff = ghDiff(d.before, d.after, { view: d.layout, full: true });
  return html`<section class="hedit hdiff">
<div class="hhead">
  <a class="back" href="${vHref(v, { file: path, pane: "history" })}">‹ History</a>
  <h1 class="mono">${path}</h1>
  <span class="hhead-r"><a class="btn" href="${vHref(v, { file: path, pane: "edit" })}">Back to editing</a></span>
</div>
${flashNote(v.flash)}
<div class="hcommit">
  <p class="hc1">${whoDot(e.who)}<b>${whoLabel(e.who)}</b><span class="hmsg">${e.message}</span></p>
  <p class="hc2 faint">${when(e.at, v.timeZone)}<span class="sep"></span>${whoWhere(e.who)}<span class="sep"></span><span class="mono">${e.short}</span></p>
</div>
<div class="hdbar">
  <span class="seg"><a class="${d.compare === "change" ? "on" : ""}" href="${q({ compare: "change" })}">This change</a><a class="${d.compare === "now" ? "on" : ""}" href="${q({ compare: "now" })}">This version vs now</a></span>
  <span class="seg"><a class="${d.layout === "unified" ? "on" : ""}" href="${q({ layout: "unified" })}">Unified</a><a class="${d.layout === "split" ? "on" : ""}" href="${q({ layout: "split" })}">Split</a></span>
  ${counts(diff.add, diff.del)}
  <span class="hdact">
    <a class="btn" href="${vHref(v, { file: path, undo: e.commit, pane: "edit" })}" title="${d.revertConflicts ? "It overlaps later changes: you will merge them by hand" : "Takes out only what this change did; later changes stay. Loaded into the editor, not saved."}">Undo this change${d.revertConflicts ? html`<span class="c-lost hwarn">⚠</span>` : ""}</a>
    ${e.removed ? "" : html`<a class="btn" href="${vHref(v, { file: path, restore: e.commit, pane: "edit" })}" title="The whole file as it was right after this change. Loaded into the editor, not saved.">Restore this version</a>`}
  </span>
</div>
<div class="hdiffbody">${d.compare === "now" ? html`<p class="hdnote faint">Left: this version (${e.short}). Right: the file now.</p>` : ""}${diff.html}</div>
</section>`;
}

function conflictPane(v: HomeView, c: ConflictState): Raw {
  return html`<form class="hedit hconflict" method="post" action="/home/save">
<input type="hidden" name="csrf" value="${v.csrf}"><input type="hidden" name="path" value="${c.path}"><input type="hidden" name="base" value="${c.base}"><input type="hidden" name="resolved" value="1">${c.profile ? html`<input type="hidden" name="profile" value="${c.profile}">` : ""}${c.baseCommit ? html`<input type="hidden" name="basecommit" value="${c.baseCommit}">` : ""}
<div class="hhead"><h1 class="mono">${c.profile ? html`<span class="hlayer-of">${c.profile} /</span> ` : ""}${c.path}</h1><span class="dirty">Merging</span></div>
<p class="notice refused">${c.reason ?? `${c.theirsWho.kind === "owner" ? "You (elsewhere)" : whoLabel(c.theirsWho)} changed the same lines you did. Left: the file as saved now, with that change. Right: yours, which is what gets saved. Tidy up the right side, then save; an arrow copies a block from the left.`}</p>
<div class="hmerge" data-merge data-lang="${c.lang}" data-a="ca" data-b="cb" data-resolve="text" data-collapse="0">
<div class="hsides"><span>${c.sides?.[0] ?? "Saved now"}</span><span>${c.sides?.[1] ?? "Yours (this is saved)"}</span></div>
<template id="ca">${c.theirs}</template><template id="cb">${c.ours}</template>
<div class="merge-fallback"><div class="label">${c.sides?.[0] ?? "Saved now"}</div><pre class="code">${c.theirs}</pre><div class="label">${c.sides?.[1] ?? "Yours"} (edit below; this is saved)</div></div>
</div>
<textarea name="text" class="hresolve" spellcheck="false" aria-label="Your version">${TEXTAREA_LEAD}${c.ours}</textarea>
<div class="hsave">
  <input type="text" name="note" value="${c.note ?? ""}" placeholder="Note (optional)" maxlength="200" aria-label="Note (optional)">
  <a class="btn" href="${vHref(v, { file: c.path, pane: "edit" })}">Discard mine</a>
  <button class="btn primary" type="submit">Save merged${c.profile ? ` to ${c.profile}` : ""}</button>
</div>
</form>`;
}

function historyRow(e: HistEntry, href: string, on: boolean, now: number, timeZone: string, path?: string): Raw {
  return html`<li><a class="hent${on ? " on" : ""}" href="${href}">
<span class="he1">${whoDot(e.who)}<b>${whoLabel(e.who)}</b>${path ? html`<span class="hpath mono">${path}</span>` : ""}<span class="hewhere">${whoShort(e.who)}</span><span class="hwhen">${ago(e.at, now)}</span></span>
<span class="he2">${e.created ? html`<span class="tag">new file</span>` : ""}${e.removed ? html`<span class="tag">removed</span>` : ""}${e.message}</span>
<span class="he3 faint">${when(e.at, timeZone)}<span class="sep"></span>${plusMinus(e.add, e.del)}</span>
</a></li>`;
}

function historyPane(v: HomeView): Raw {
  const path = v.selected;
  const at = v.main.mode === "diff" ? v.main.diff.entry.commit : undefined;
  return html`<aside class="hhist" aria-label="History">
<div class="hhist-head"><a class="back" href="${vHref(v, { file: path, pane: "edit" })}">‹ ${path ?? "Files"}</a><h2>History</h2><span class="faint">${v.history.length ? `${v.history.length} change${v.history.length === 1 ? "" : "s"}` : ""}</span><a class="hclose faint" href="${vHref(v, { file: path, hist: "0" })}" title="Hide history">⟩</a></div>
${
  v.history.length === 0
    ? html`<p class="empty">${path ? "No changes recorded for this file yet." : "Pick a file to see its history."}</p>`
    : html`<ol class="hents">${v.history.map((e) => historyRow(e, vHref(v, { file: path, at: e.commit, pane: "edit" }), e.commit === at, v.now, v.timeZone))}</ol>`
}
<a class="hall" href="/home/history">All history →</a>
</aside>`;
}

// ---- the pages ---------------------------------------------------------------------------------------------

export function homePage(v: HomeView): string {
  const m = v.main;
  const main =
    m.mode === "preview"
      ? previewPane(v, m.preview)
      : m.mode === "basediff"
      ? baseDiffPane(v, m.basediff)
      : m.mode === "edit"
      ? editPane(v, m.edit)
      : m.mode === "diff"
        ? diffPane(v, m.path, m.diff)
        : m.mode === "conflict"
          ? conflictPane(v, m.conflict)
          : html`<section class="hedit hnone">${mainTabs(v)}${flashNote(v.flash)}<p class="empty">Pick a file to edit. Her persona, your rules, her memory, each chat's notes, the playbooks and the sticker library are on the left.</p></section>`;
  const body = html`<main class="home${v.historyOpen ? "" : " hist-closed"} pane-${v.pane}">
${filesPane(v)}
${main}
${v.historyOpen ? historyPane(v) : html`<a class="hhist-open" href="${vHref(v, { file: v.selected, hist: "1" })}" title="Show history">⟨ History</a>`}
</main>`;
  // The editor script on every Home page: a boosted move between files keeps the head, so it must be there.
  return page(v.selected ? `${v.selected} · Home` : "Home", body, v.who, "home", ["/editor.js"], "resizes");
}

/** `/home/history`: every file's changes, newest first. */
export interface ActivityView {
  entries: (HistEntry & { path: string })[];
  timeZone: string;
  now: number;
  who?: string;
  /** Older entries exist past these: the next page's `before`. */
  more?: string;
}

export function activityPage(v: ActivityView): string {
  const body = html`<main class="hactivity">
<div class="hhead"><a class="back-inline" href="/home">‹ Home</a><h1>All history</h1><span class="faint">every change she and you made to her files</span></div>
${
  v.entries.length === 0
    ? html`<p class="empty">No changes yet.</p>`
    : html`<ol class="hents wide">${v.entries.map((e) => historyRow(e, homeHref({ file: e.path, at: e.commit, pane: "edit" }), false, v.now, v.timeZone, e.path))}</ol>`
}
${v.more ? html`<a class="more-link" href="${href("/home/history", { before: v.more })}">Older changes →</a>` : ""}
</main>`;
  return page("All history · Home", body, v.who, "home", ["/editor.js"], "resizes");
}
