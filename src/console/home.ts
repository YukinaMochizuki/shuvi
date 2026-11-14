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
}

export type MainPane =
  | { mode: "none" }
  | { mode: "edit"; edit: EditState }
  | { mode: "diff"; path: string; diff: DiffState }
  | { mode: "conflict"; conflict: ConflictState };

export interface HomeView {
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

function flashNote(f: Flash | undefined): Raw | "" {
  return f ? html`<p class="notice ${f.tone} hflash" role="status">${f.text}</p>` : "";
}

// ---- panes -------------------------------------------------------------------------------------------------

function filesPane(v: HomeView): Raw {
  return html`<nav class="hfiles" aria-label="Files">
${v.groups.map(
  (g) => html`<section class="hgroup"><h2>${g.label}</h2>
${g.files.map((f) => {
  const on = f.path === v.selected;
  // One name per row: the file's, or for a chat's notes the chat's (its path means nothing to read). What the file
  // is for, and the path, are in the tooltip; the second line only says who last changed it.
  const name = f.title ?? f.path;
  return html`<a class="hfile${on ? " on" : ""}${f.exists ? "" : " missing"}" href="${homeHref({ file: f.path, pane: "edit" })}" title="${[f.title ? f.path : "", f.hint].filter(Boolean).join(" — ")}"${on ? raw(' aria-current="page"') : ""}>
<span class="hf1"><span class="hpath${f.title ? "" : " mono"}">${name}</span>${f.last ? html`<span class="hwhen">${ago(f.last.at, v.now)}</span>` : ""}</span>
<span class="hf2">${f.exists ? (f.last ? html`${whoDot(f.last.who)}<span>edited by ${whoLabel(f.last.who)}</span>` : html`<span class="faint">no history</span>`) : html`<span class="faint">not created yet</span>`}</span>
</a>`;
})}
</section>`,
)}
</nav>`;
}

function editPane(v: HomeView, e: EditState): Raw {
  const clean = e.text === (e.saved ?? "");
  return html`<form class="hedit" method="post" action="/home/save">
<input type="hidden" name="csrf" value="${v.csrf}"><input type="hidden" name="path" value="${e.path}"><input type="hidden" name="base" value="${e.base}">
<div class="hhead">
  <a class="back" href="${homeHref({ pane: "files", file: e.path })}">‹ Files</a>
  <h1 class="mono">${e.path}</h1>
  <span class="dirty" data-dirty${clean ? raw(" hidden") : ""}>${clean ? "" : "Unsaved"}</span>
  <span class="hhead-r">${hintOf(v, e.path) ? html`<span class="hhint">${hintOf(v, e.path)}</span>` : ""}<a class="btn hist-toggle" href="${homeHref({ file: e.path, pane: "history" })}">History</a></span>
</div>
${flashNote(v.flash)}
<div class="hwatch" hx-get="${href("/home/watch", { file: e.path, base: e.base })}" hx-trigger="every 5s" hx-swap="innerHTML"></div>
${e.loaded ? html`<p class="hloaded">${e.loaded} <span class="faint">Not saved yet: look it over, then save.</span></p>` : ""}
<div class="hcode"><textarea name="text" data-editor data-lang="${e.saved === null && e.path.endsWith(".yaml") ? "yaml" : e.lang}" data-saved="${e.saved ?? ""}" spellcheck="false" aria-label="${e.path}">${TEXTAREA_LEAD}${e.text}</textarea></div>
<div class="hsave">
  <input type="text" name="note" value="${e.note ?? ""}" placeholder="Note (optional): why you changed it" maxlength="200" aria-label="Note (optional)">
  <button class="btn primary" type="submit">Save</button><span class="kbd faint">⌘S</span>
</div>
</form>`;
}

/** The line that says the file changed while you were editing it (the watch route draws it). */
export function changedBanner(entry: HistEntry, path: string): Raw {
  return html`<p class="hchanged" role="status">${whoDot(entry.who)}<span><b>${entry.who.kind === "owner" ? "You" : whoLabel(entry.who)}</b> just changed this file ${plusMinus(entry.add, entry.del)}</span>
<span class="faint">${whoWhere(entry.who)}</span>
<a href="${homeHref({ file: path, at: entry.commit, pane: "edit" })}" target="_blank" rel="noopener">View change</a>
<span class="faint">Your save will keep it.</span></p>`;
}

function diffPane(v: HomeView, path: string, d: DiffState): Raw {
  const e = d.entry;
  const q = (over: Record<string, string>) => homeHref({ file: path, at: e.commit, compare: d.compare, layout: d.layout, pane: "edit", ...over });
  // The whole file, nothing folded: the owner reads a change in its context (editor.ts scrolls to the first one).
  const diff = ghDiff(d.before, d.after, { view: d.layout, full: true });
  return html`<section class="hedit hdiff">
<div class="hhead">
  <a class="back" href="${homeHref({ file: path, pane: "history" })}">‹ History</a>
  <h1 class="mono">${path}</h1>
  <span class="hhead-r"><a class="btn" href="${homeHref({ file: path, pane: "edit" })}">Back to editing</a></span>
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
    <a class="btn" href="${homeHref({ file: path, undo: e.commit, pane: "edit" })}" title="${d.revertConflicts ? "It overlaps later changes: you will merge them by hand" : "Takes out only what this change did; later changes stay. Loaded into the editor, not saved."}">Undo this change${d.revertConflicts ? html`<span class="c-lost hwarn">⚠</span>` : ""}</a>
    ${e.removed ? "" : html`<a class="btn" href="${homeHref({ file: path, restore: e.commit, pane: "edit" })}" title="The whole file as it was right after this change. Loaded into the editor, not saved.">Restore this version</a>`}
  </span>
</div>
<div class="hdiffbody">${d.compare === "now" ? html`<p class="hdnote faint">Left: this version (${e.short}). Right: the file now.</p>` : ""}${diff.html}</div>
</section>`;
}

function conflictPane(v: HomeView, c: ConflictState): Raw {
  return html`<form class="hedit hconflict" method="post" action="/home/save">
<input type="hidden" name="csrf" value="${v.csrf}"><input type="hidden" name="path" value="${c.path}"><input type="hidden" name="base" value="${c.base}"><input type="hidden" name="resolved" value="1">
<div class="hhead"><h1 class="mono">${c.path}</h1><span class="dirty">Merging</span></div>
<p class="notice refused">${c.reason ?? `${c.theirsWho.kind === "owner" ? "You (elsewhere)" : whoLabel(c.theirsWho)} changed the same lines you did. Left: the file as saved now, with that change. Right: yours, which is what gets saved. Tidy up the right side, then save; an arrow copies a block from the left.`}</p>
<div class="hmerge" data-merge data-lang="${c.lang}" data-a="ca" data-b="cb" data-resolve="text" data-collapse="0">
<div class="hsides"><span>Saved now</span><span>Yours (this is saved)</span></div>
<template id="ca">${c.theirs}</template><template id="cb">${c.ours}</template>
<div class="merge-fallback"><div class="label">Saved now</div><pre class="code">${c.theirs}</pre><div class="label">Yours (edit below; this is saved)</div></div>
</div>
<textarea name="text" class="hresolve" spellcheck="false" aria-label="Your version">${TEXTAREA_LEAD}${c.ours}</textarea>
<div class="hsave">
  <input type="text" name="note" value="${c.note ?? ""}" placeholder="Note (optional)" maxlength="200" aria-label="Note (optional)">
  <a class="btn" href="${homeHref({ file: c.path, pane: "edit" })}">Discard mine</a>
  <button class="btn primary" type="submit">Save merged</button>
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
<div class="hhist-head"><a class="back" href="${homeHref({ file: path, pane: "edit" })}">‹ ${path ?? "Files"}</a><h2>History</h2><span class="faint">${v.history.length ? `${v.history.length} change${v.history.length === 1 ? "" : "s"}` : ""}</span><a class="hclose faint" href="${homeHref({ file: path, hist: "0" })}" title="Hide history">⟩</a></div>
${
  v.history.length === 0
    ? html`<p class="empty">${path ? "No changes recorded for this file yet." : "Pick a file to see its history."}</p>`
    : html`<ol class="hents">${v.history.map((e) => historyRow(e, homeHref({ file: path, at: e.commit, pane: "edit" }), e.commit === at, v.now, v.timeZone))}</ol>`
}
<a class="hall" href="/home/history">All history →</a>
</aside>`;
}

// ---- the pages ---------------------------------------------------------------------------------------------

export function homePage(v: HomeView): string {
  const m = v.main;
  const main =
    m.mode === "edit"
      ? editPane(v, m.edit)
      : m.mode === "diff"
        ? diffPane(v, m.path, m.diff)
        : m.mode === "conflict"
          ? conflictPane(v, m.conflict)
          : html`<section class="hedit hnone">${flashNote(v.flash)}<p class="empty">Pick a file to edit. Her persona, your rules, her memory, each chat's notes, the playbooks and the sticker library are on the left.</p></section>`;
  const body = html`<main class="home${v.historyOpen ? "" : " hist-closed"} pane-${v.pane}">
${filesPane(v)}
${main}
${v.historyOpen ? historyPane(v) : html`<a class="hhist-open" href="${homeHref({ file: v.selected, hist: "1" })}" title="Show history">⟨ History</a>`}
</main>`;
  // The editor script on every Home page: a boosted move between files keeps the head, so it must be there.
  return page(v.selected ? `${v.selected} · Home` : "Home", body, v.who, "home", ["/editor.js"]);
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
  return page("All history · Home", body, v.who, "home", ["/editor.js"]);
}
