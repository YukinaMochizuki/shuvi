import { getInfo, infoHistory, infoProfiles, INFO_VERSIONS_KEPT, type InfoVersion } from "../secrets/info.ts";
import { allNotes, DETAILS_MAX, SUMMARY_MAX, varAbouts, type SecretNote } from "../secrets/notes.ts";
import type { SecretSource } from "../secrets/source.ts";
import type { Db } from "../store/db.ts";
import { ago, href, html, when, type Raw } from "./html.ts";
import { kvTable } from "./kv-table.ts";
import { action, anchor, csrfField, inPage, rowNote, writes, type SettingsContext, type SettingsNote } from "./settings.ts";

/**
 * The Personal info section of the Secrets page (`/settings/secrets#info`): data about the owner she READS (an
 * address, a phone, a member number; src/secrets/info.ts), as against the secrets above it, which she never sees. So
 * here the values are there to be seen, HIDDEN until he asks (each profile's Show values: a CSS toggle, no round trip,
 * or `?show=<name>`, that lists them; the edit form's boxes are masked the same), and edited in place in the key/value
 * table (kv-table.ts, the secrets' too): each key with its value filled in (an empty box keeps it, ✕ takes it out),
 * and new keys in new rows. Each profile has its History (who changed which fields when, and
 * the values before), with Restore; and "Make it a secret" (confirmed: its values become redacted, its history goes).
 *
 * This file draws; secrets.ts loads it into the page's view (`loadInfo`) and composes it; the writes are
 * secrets-write.ts (`info-put`, `info-delete`, `info-restore`, `convert`, and `note` with `kind=info`).
 */

export interface InfoRow {
  name: string;
  fields: string[];
  /** Its values; absent when they cannot be opened (`unreadable`). */
  values?: Record<string, string>;
  unreadable?: string;
  updatedAt: string;
  note?: SecretNote;
  /** Who made the last change (its newest version), when there is one. */
  lastBy?: string;
}

export interface InfoView {
  rows: InfoRow[];
  /** The profile whose edit form is open. */
  editing?: string;
  /** The profile whose History is open, with its versions. */
  history?: { name: string; versions: InfoVersion[] };
  /** The profile whose note form is open. */
  noting?: string;
  /** A Delete asked for and not yet confirmed. */
  confirm?: string;
  /** The add form open, with this name (after a refusal: never its values). */
  adding?: { name?: string };
  /** The profile whose values are drawn shown (`?show=`: the link where the Show toggle's CSS cannot work). */
  shown?: string;
}

/** A row's key for a write's note (`SettingsNote.on`): apart from a secret of the same name. */
export const infoOn = (name: string) => `info:${name}`;
export const infoAnchor = (name: string) => anchor("p", `info-${name}`);

export function loadInfo(db: Db, src: SecretSource, q: URLSearchParams, note: SettingsNote | undefined, adding: { name?: string } | undefined): InfoView {
  const notes = allNotes(db, "info");
  const rows: InfoRow[] = infoProfiles(db, src).map((p) => {
    const last = infoHistory(db, { ...src, key: null }, p.name)[0];
    return {
      name: p.name,
      fields: p.fields,
      ...(p.values ? { values: p.values } : {}),
      ...(p.unreadable ? { unreadable: p.unreadable } : {}),
      updatedAt: p.updatedAt,
      ...(notes.get(p.name) ? { note: notes.get(p.name)! } : {}),
      ...(last ? { lastBy: last.by } : {}),
    };
  });
  const v: InfoView = { rows };
  if (adding) v.adding = adding;
  const has = (n: string | null) => !!n && rows.some((r) => r.name === n);
  const e = q.get("iedit");
  if (has(e) && getInfo(db, src, e!)?.values) v.editing = e!;
  const h = q.get("history");
  if (has(h)) v.history = { name: h!, versions: infoHistory(db, src, h!) };
  const n = q.get("inote");
  if (has(n)) v.noting = n!;
  const s = q.get("show");
  if (has(s)) v.shown = s!;
  const d = q.get("idelete");
  if (has(d) && !note) v.confirm = d!;
  return v;
}

// ---- drawing -----------------------------------------------------------------------------------------------

const PAGE = "/settings/secrets";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Who a version or a note says made it: the owner from the console, or her in a chat. */
export function byLabel(by: string): string {
  const conv = / \(made it personal info\)$/.test(by) ? " (made it personal info)" : "";
  const b = by.replace(/ \(made it personal info\)$/, "");
  if (b.startsWith("assistant in ")) return `her, in ${b.slice("assistant in ".length)}${conv}`;
  if (b.startsWith("assistant")) return `her${conv}`;
  if (b.startsWith("console")) return `you${/from her request/.test(b) ? ", on her request" : /restored/.test(b) ? ", restoring" : ""}${conv}`;
  return `${b}${conv}`;
}

/** What a hidden value shows: always the same, so it says nothing of the value's length. */
export const MASK = "••••••••";

/**
 * A value as the page holds it: dots, with the value beside them hidden until its profile's Show is on (the row's
 * `.ishow-t` checked, or the row drawn `shown` by `?show=`). Never anywhere else on the page.
 */
function masked(value: string, cls = ""): Raw {
  return html`<dd class="ival${cls}"><span class="imask" aria-label="hidden value">${MASK}</span><span class="iv">${value}</span></dd>`;
}

/**
 * A profile's Show / Hide: a checkbox at the head of its row that CSS reads (`:has`), so the values show at once,
 * without script or a round trip; where `:has` is not supported, a link to `?show=<name>` draws them shown instead.
 */
function showToggle(r: InfoRow, shownByQuery: boolean, back: Record<string, string>): Raw {
  const id = `show-${infoAnchor(r.name)}`;
  const link = shownByQuery ? href(PAGE, back) : href(PAGE, { ...back, show: r.name });
  return html`<label class="btn ishow-l" for="${id}"><span class="when-hidden">Show values</span><span class="when-shown">Hide values</span></label><a class="btn ishow-a" href="${link}#${infoAnchor(r.name)}"${inPage}>${shownByQuery ? "Hide values" : "Show values"}</a>`;
}

/**
 * Keys and their values, read only, in the key/value table's columns (key | description | value) with no frame: a
 * profile's values once shown (`.vals`, nothing of it while hidden), and History's values from before a change.
 */
function kvList(fields: readonly string[], values: Record<string, string>, abouts: Record<string, string>, cls = "", changed: readonly string[] = []): Raw {
  const missing = changed.filter((c) => !fields.includes(c));
  return html`<dl class="kvlist${cls}">${fields.map((f) => html`<div class="kvli${changed.includes(f) ? " changed" : ""}"><dt class="mono">${f}</dt><dd class="kvla">${abouts[f] ?? ""}</dd>${masked(values[f] ?? "")}</div>`)}${missing.map((c) => html`<div class="kvli changed"><dt class="mono">${c}</dt><dd class="kvla">${abouts[c] ?? ""}</dd><dd class="ival faint">(not there)</dd></div>`)}</dl>`;
}

/**
 * The note under a profile, secret or personal info alike: its summary (what her prompt says), that there are
 * details, and who wrote it.
 */
export function noteLines(ctx: SettingsContext, note: SecretNote | undefined): Raw | "" {
  const n = note;
  if (!n || (!n.summary && !n.details)) return "";
  const by = html` <span class="faint" title="${when(n.updatedAt, ctx.timeZone, true)}">· ${n.updatedBy.startsWith("assistant") ? "written by her" : "written by you"} ${ago(n.updatedAt, ctx.now)}</span>`;
  return html`<p class="note-sum">${n.summary || html`<span class="faint">no summary</span>`}${n.details ? html` <span class="faint">· ${plural(n.details.split("\n").length, "line")} of details</span>` : ""}${by}</p>`;
}

/**
 * A profile row's "⋯" menu: what is not its primary action (a note, History, changing its kind, Delete), each a link as
 * before. A `<details>` popover: keyboard reachable as it is; console.js closes it on a click outside or Escape. Nothing
 * when there is nothing in it.
 */
export function rowMenu(name: string, items: readonly (Raw | "")[]): Raw | "" {
  const its = items.filter((x): x is Raw => x !== "");
  if (!its.length) return "";
  return html`<details class="rmenu"><summary class="btn" title="More" aria-label="More for ${name}">⋯</summary><div class="rmenu-list">${its}</div></details>`;
}

export function infoRow(ctx: SettingsContext, v: InfoView, note: SettingsNote | undefined, r: InfoRow, convert?: string): Raw {
  const id = infoAnchor(r.name);
  const editing = v.editing === r.name;
  const showing = v.history?.name === r.name;
  const noting = v.noting === r.name;
  const confirming = v.confirm === r.name;
  const converting = convert === r.name;
  const open = editing || showing || noting || confirming || converting;
  const shown = v.shown === r.name;
  // Where the Show link comes back to: what is open now stays open.
  const back: Record<string, string> = editing ? { iedit: r.name } : showing ? { history: r.name } : {};
  const facts: Raw[] = [
    r.fields.length ? html`<span class="mono">${r.fields.join(", ")}</span>` : html`<span class="faint">no keys</span>`,
    html`<span class="faint" title="${when(r.updatedAt, ctx.timeZone, true)}">changed ${ago(r.updatedAt, ctx.now)}${r.lastBy ? ` by ${byLabel(r.lastBy)}` : ""}</span>`,
  ];
  const toggle = (cls: string, on: boolean, key: string, label: string) => html`<a class="${cls}${on ? " on" : ""}" href="${on ? PAGE : href(PAGE, { [key]: r.name })}#${id}"${inPage}>${label}</a>`;
  const menu = rowMenu(r.name, [
    toggle("mi", showing, "history", "History"),
    toggle("mi", noting, "inote", r.note ? "Edit note" : "Add note"),
    html`<a class="mi" href="${href(PAGE, { convert: r.name, to: "secret" })}#${id}"${inPage}>Make it a secret</a>`,
    html`<a class="mi danger" href="${href(PAGE, { idelete: r.name })}#${id}"${inPage}>Delete…</a>`,
  ]);
  const acts = confirming || converting ? "" : html`${r.values ? showToggle(r, shown, back) : ""}${r.values ? toggle("btn", editing, "iedit", "Edit") : ""}${menu}`;
  const values = r.values
    ? editing
      ? ""
      : kvList(r.fields, r.values, varAbouts(r.note), " vals")
    : html`<p class="why-line c-failed">Its values cannot be shown: ${r.unreadable ?? "they do not open"}.</p>`;
  return html`<div class="srow irow${r.unreadable ? " warn" : ""}${confirming || converting ? " confirming" : ""}${open ? " open" : ""}${shown ? " shown" : ""}" id="${id}"><input type="checkbox" class="ishow-t" id="show-${id}" aria-label="show the values of ${r.name}" ${shown ? "checked" : ""}>
<div class="smain"><div class="sl1"><span class="sname mono">${r.name}</span><span class="tag info">personal info</span></div>
<p class="sfacts">${facts.map((x, i) => html`${i ? html`<span class="sep"></span><wbr>` : ""}<span class="fact">${x}</span>`)}</p>
${noteLines(ctx, r.note)}${values}
${rowNote({ ...(note ? { note } : {}) }, infoOn(r.name))}</div>
<div class="sact">${acts}</div>
${editing ? editForm(ctx, r) : ""}${showing ? historyView(ctx, v.history!.versions, r) : ""}${noting ? noteForm(ctx, r) : ""}${confirming ? confirmDelete(ctx, r) : ""}${converting ? confirmToSecret(ctx, r) : ""}
</div>`;
}

/**
 * Change a profile's values: its keys in the table (kv-table.ts), each with its description and its value, filled in
 * and masked like the rest. A value left as it is, or emptied, keeps it; ✕ takes the key out; new keys go in the
 * empty row and those "+ Add a row" adds. Each change is recorded in its History.
 */
function editForm(ctx: SettingsContext, r: InfoRow): Raw {
  const path = `${PAGE}/info-put`;
  const abouts = varAbouts(r.note);
  return html`<form class="sform kvform" method="post" action="${path}"${writes(path)}>${csrfField(ctx)}<input type="hidden" name="name" value="${r.name}"><input type="hidden" name="replace" value="1">
${kvTable("info", r.fields.map((f) => ({ key: f, value: r.values?.[f] ?? "", ...(abouts[f] ? { about: abouts[f] } : {}) })))}
<p class="hint">Change what is different; a value you empty keeps its value. The values before are kept in History.</p>
<div class="fbtns"><button type="submit" class="btn primary">Save</button><a class="btn" href="${PAGE}#${infoAnchor(r.name)}"${inPage}>Cancel</a></div>
</form>`;
}

/**
 * A profile's History: each change, newest first, with who made it, the fields it touched, and the values from
 * before it (the touched ones marked), and Restore to put those back.
 */
function historyView(ctx: SettingsContext, versions: InfoVersion[], r: InfoRow): Raw {
  if (!versions.length) return html`<div class="ihist"><p class="faint">No changes recorded.</p></div>`;
  const abouts = varAbouts(r.note);
  const one = (v: InfoVersion, i: number) => {
    const made = v.before && !Object.keys(v.before).length;
    const head = html`<div class="ih-head"><b title="${when(v.at, ctx.timeZone, true)}">${when(v.at, ctx.timeZone)}</b><span class="faint">${ago(v.at, ctx.now)}</span><span>by ${byLabel(v.by)}</span></div>`;
    const what = made
      ? html`<p class="ih-what">${/made it personal info/.test(v.by) ? "Made personal info from a secret" : "Made"}, with ${v.changed.map((c, j) => html`${j ? ", " : ""}<span class="mono">${c}</span>`)}</p>`
      : html`<p class="ih-what">Changed ${v.changed.map((c, j) => html`${j ? ", " : ""}<span class="mono">${c}</span>`)}</p>`;
    const before = made
      ? ""
      : v.before
        ? html`<div class="ih-before"><span class="ih-label">Before this change</span>${kvList(v.fields, v.before, abouts, "", v.changed)}${action(ctx, `${PAGE}/info-restore`, "Restore these values", { name: r.name, version: String(v.id) })}</div>`
        : html`<p class="why-line c-failed">The values before cannot be opened with SHUVI_SECRETS_KEY.</p>`;
    return html`<li class="ih-item${i === 0 ? " latest" : ""}">${head}${what}${before}</li>`;
  };
  return html`<div class="ihist"><div class="ih-top"><span class="ih-label">History, newest first · ${plural(versions.length, "change")} (the last ${String(INFO_VERSIONS_KEPT)} are kept)</span><a class="btn" href="${PAGE}#${infoAnchor(r.name)}"${inPage}>Close</a></div><ol class="ih-list">${versions.map(one)}</ol></div>`;
}

function noteForm(ctx: SettingsContext, r: InfoRow): Raw {
  const path = `${PAGE}/note`;
  return html`<form class="sform edit note" method="post" action="${path}"${writes(path)}>${csrfField(ctx)}<input type="hidden" name="name" value="${r.name}"><input type="hidden" name="kind" value="info">
<label>Summary<input type="text" name="summary" maxlength="${SUMMARY_MAX}" value="${r.note?.summary ?? ""}" placeholder="what it is, in one line" autocomplete="off"><span class="hint">One line, in her prompt beside the name: what it is (never the value itself).</span></label>
<label>Details<textarea name="details" rows="6" maxlength="${DETAILS_MAX}" placeholder="Variables:&#10;- KEY: what it is">${r.note?.details ?? ""}</textarea><span class="hint">What she reads with the values (<span class="mono">info_read</span>). Lines <span class="mono">- KEY: what it is</span> are each key's description.</span></label>
<div class="fbtns"><button type="submit" class="btn primary">Save note</button><a class="btn" href="${PAGE}#${infoAnchor(r.name)}"${inPage}>Cancel</a></div>
</form>`;
}

function confirmDelete(ctx: SettingsContext, r: InfoRow): Raw {
  return html`<div class="confirm"><p class="q">Delete ${r.name}?</p><p class="effect">Its values, its history and its note are deleted. She will not know it any more.</p><div class="cbtns">${action(ctx, `${PAGE}/info-delete`, `Delete ${r.name}`, { name: r.name }, "danger solid")}<a class="btn" href="${PAGE}#${infoAnchor(r.name)}"${inPage}>Cancel</a></div></div>`;
}

function confirmToSecret(ctx: SettingsContext, r: InfoRow): Raw {
  return html`<div class="confirm"><p class="q">Make ${r.name} a secret?</p><ul class="effect clist"><li>She will no longer read its values: they go into her commands or a page only where you grant it, and are <b>redacted</b> from everything she sees.</li><li>It starts with <b>no grant</b>: she asks with <span class="mono">request_secret</span>, or you grant it here.</li><li>Its <b>history is deleted</b> (${plural(r.fields.length, "field")} kept as they are now); its note goes with it.</li><li>What she already read of it stays in past conversations.</li></ul><div class="cbtns">${action(ctx, `${PAGE}/convert`, "Make it a secret", { name: r.name, to: "secret" }, "danger solid")}<a class="btn" href="${PAGE}#${infoAnchor(r.name)}"${inPage}>Cancel</a></div></div>`;
}

/** The confirmation under a SECRET's row (secrets.ts), turning it into personal info. */
export function confirmToInfo(ctx: SettingsContext, p: { name: string; vars: string[]; grants: unknown[] }, back: string): Raw {
  return html`<div class="confirm"><p class="q">Make ${p.name} personal info?</p><ul class="effect clist"><li>She will <b>read its values</b> (${p.vars.map((v, i) => html`${i ? ", " : ""}<span class="mono">${v}</span>`)}) in any chat, in turns you start, and they are <b>no longer redacted</b> from what she sees (a value another secret also holds still is).</li><li><b>Every grant of it is revoked</b>${p.grants.length ? html` (${plural(p.grants.length, "grant")} to every chat, and any to a single chat)` : " (any to a single chat)"}: it is no longer put into her commands.</li><li>From now on each change to it is kept in its History; its note goes with it.</li></ul><div class="cbtns">${action(ctx, `${PAGE}/convert`, "Make it personal info", { name: p.name, to: "info" }, "danger solid")}<a class="btn" href="${back}"${inPage}>Cancel</a></div></div>`;
}

/** New personal info: a profile name and a one-line summary (its note's), then the key/value table. */
export function infoAddForm(ctx: SettingsContext, v: InfoView, note: SettingsNote | undefined, keyProblem: string | null): Raw | "" {
  if (keyProblem) return "";
  const path = `${PAGE}/info-put`;
  return html`<details class="addp" id="add-info" ${v.adding || !v.rows.length ? "open" : ""}><summary>New personal info</summary>
${rowNote({ ...(note ? { note } : {}) }, "add-info")}
<form class="sform kvform" method="post" action="${path}"${writes(path)}>${csrfField(ctx)}
<div class="kvtop"><label>Profile<input type="text" name="name" required pattern="[A-Za-z0-9][A-Za-z0-9_\\-]{0,63}" maxlength="64" value="${v.adding?.name ?? ""}" placeholder="example" class="mono" autocomplete="off"><span class="hint">any name; what she calls it with <span class="mono">info_read</span></span></label>
<label>Summary<input type="text" name="summary" maxlength="${SUMMARY_MAX}" placeholder="what it is, in one line" autocomplete="off"><span class="hint">in her prompt beside the name</span></label></div>
${kvTable("info")}
<p class="hint">Each key with its value, and what it is if the key does not say; she reads these.</p>
<div class="fbtns"><button type="submit" class="btn primary">Add personal info</button></div>
</form></details>`;
}

export function infoSection(ctx: SettingsContext, v: InfoView, note: SettingsNote | undefined, keyProblem: string | null, convert?: string): Raw {
  const body = v.rows.length
    ? v.rows.map((r) => infoRow(ctx, v, note, r, convert))
    : html`<p class="empty-s">No personal info yet. Add some below, or tell her: she keeps what you tell her with <span class="mono">info_write</span>.</p>`;
  return html`<section class="sset" id="info">
<div class="shd"><h2>Personal info</h2><span class="meta">she reads these · hidden here until you show them</span></div>
<p class="sintro">An address, a phone, a member number: what she needs to read to fill in a form or write a letter. She reads them in any chat when you are in the turn, and keeps what you tell her. Not for passwords or ID numbers she should only type: those are secrets.</p>
${body}
${keyProblem ? html`<p class="notice refused">Personal info cannot be kept here: ${keyProblem}.</p>` : infoAddForm(ctx, v, note, keyProblem)}
</section>`;
}
