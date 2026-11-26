import { ownerGrants, type OwnerTtl } from "../capabilities/computer/secrets.ts";
import { allProfiles, keyProblem, storedProfiles, type SecretSource } from "../secrets/source.ts";
import { loadProfiles } from "../secrets/redaction.ts";
import { allNotes, DETAILS_MAX, SUMMARY_MAX, varAbouts, type SecretNote } from "../secrets/notes.ts";
import type { Db } from "../store/db.ts";
import { approvals } from "../store/schema.ts";
import { eq } from "drizzle-orm";
import { span, whenDay } from "./chat-extras.ts";
import { ago, href, html, page, when, type Raw } from "./html.ts";
import { kvTable } from "./kv-table.ts";
import { action, anchor, csrfField, inPage, rowNote, writes, type SettingsContext, type SettingsNote } from "./settings.ts";
import { confirmToInfo, infoSection, loadInfo, noteLines, rowMenu, type InfoView } from "./info.ts";

/**
 * The Secrets page (`/settings/secrets`): her credentials. Every secret profile there is, the secrets file's (read
 * only: changed where shuvi is deployed) and those kept here (sealed in the store under SHUVI_SECRETS_KEY,
 * src/secrets/source.ts), with their variables' NAMES, never a value; and the OWNER GRANTS, a profile given to
 * every chat's computer for the owner's own requests (capabilities/computer/secrets.ts), each with its Revoke.
 *
 * This file READS and draws; the writes are secrets-write.ts (`POST /settings/secrets/<verb>`, CSRF-checked as
 * every console write is). A value is only ever typed in (adding a profile, replacing its values: the key/value
 * table of kv-table.ts, shared with personal info) and never drawn back: a refused form comes back with its name and
 * its grant choice, never its values (nor its summary, which may hold one). Delete is a link (GET `?delete=`) to a
 * confirmation, as Settings' Remove is.
 *
 * Below the secrets, the PERSONAL INFO section (info.ts): data she reads, whose values are shown. A secret kept here
 * can be made personal info, and back (`?convert=<name>&to=info|secret`, a confirmation saying what happens).
 */

/** An owner grant, as the page shows it. */
export interface OwnerGrantRow {
  id: number;
  profile: string;
  /** null: until revoked. */
  expiresAt: string | null;
  /** When it was granted: the card's answer, or the console's write. */
  grantedAt: string | null;
  /** Made from her request's card in the control bot, or here. */
  via: "card" | "console";
}

export interface ProfileRow {
  name: string;
  from: "file" | "store";
  /** Its variables' names (never a value). */
  vars: string[];
  /** A store profile: when its values were last set. */
  updatedAt?: string;
  /** A store profile whose values cannot be opened now, and why (no key, another key). */
  unreadable?: string;
  /** A store profile hidden by a file profile of the same name. */
  shadowed?: boolean;
  /** Its live owner grants. */
  grants: OwnerGrantRow[];
  /** What she knows about it (not secret): the summary in her prompt, the details she reads. */
  note?: SecretNote;
}

export interface SecretsPageView {
  file: string;
  fileError?: string;
  /** Why profiles cannot be kept here now (SHUVI_SECRETS_KEY unset or unusable), or null. */
  keyProblem: string | null;
  profiles: ProfileRow[];
  /** Owner grants of a profile there is no longer. */
  orphans: OwnerGrantRow[];
  note?: SettingsNote;
  /** A Delete asked for and not yet confirmed. */
  confirm?: string;
  /** The profile whose Replace form is open. */
  editing?: string;
  /** The profile whose note form is open. */
  noting?: string;
  /** The add form open, with these (never a value). */
  adding?: AddForm;
  /** The Personal info section. */
  info: InfoView;
  /** A change of kind asked for and not yet confirmed: the profile, and what it would become. */
  converting?: { name: string; to: "info" | "secret" };
}

/** What the add form is shown again with after a refusal: its name and grant choice, never the values. */
export interface AddForm {
  name?: string;
  grant?: OwnerTtl | "";
}

export const GRANT_CHOICES: { id: OwnerTtl; label: string }[] = [
  { id: "forever", label: "until revoked" },
  { id: "3d", label: "for 3 days" },
  { id: "1d", label: "for 1 day" },
  { id: "4h", label: "for 4 hours" },
];

/** The page's view now, with what the query asks for (`delete`, `edit`) and the last write's note. */
export function loadSecretsPage(db: Db, src: SecretSource, q: URLSearchParams, flash?: { note?: SettingsNote; adding?: AddForm; addingInfo?: { name?: string } }, now = Date.now()): SecretsPageView {
  const grants: OwnerGrantRow[] = ownerGrants(db, now).map((g) => {
    const card = g.approvalId != null ? db.select({ answeredAt: approvals.answeredAt }).from(approvals).where(eq(approvals.id, g.approvalId)).get() : undefined;
    return { id: g.id, profile: g.profile, expiresAt: g.expiresAt, grantedAt: card?.answeredAt ?? g.createdAt, via: g.approvalId == null ? "console" : "card" };
  });
  const file = loadProfiles(src.file);
  const all = allProfiles(db, src);
  const rows: ProfileRow[] = [];
  if ("profiles" in file) for (const [name, vars] of Object.entries(file.profiles)) rows.push({ name, from: "file", vars: Object.keys(vars), grants: [] });
  for (const p of storedProfiles(db)) {
    const unreadable = "unreadable" in all ? all.unreadable.find((u) => u.name === p.name)?.why : undefined;
    const shadowed = "shadowed" in all && all.shadowed.includes(p.name);
    rows.push({ name: p.name, from: "store", vars: p.vars, updatedAt: p.updatedAt, ...(unreadable ? { unreadable } : {}), ...(shadowed ? { shadowed } : {}), grants: [] });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.from.localeCompare(b.from));
  const notes = allNotes(db);
  for (const r of rows) {
    const n = notes.get(r.name);
    if (n && !r.shadowed) r.note = n;
  }
  const orphans: OwnerGrantRow[] = [];
  for (const g of grants) {
    const r = rows.find((x) => x.name === g.profile && !x.shadowed);
    if (r) r.grants.push(g);
    else orphans.push(g);
  }
  const info = loadInfo(db, src, q, flash?.note, flash?.addingInfo);
  const v: SecretsPageView = { file: src.file, ...("error" in file ? { fileError: file.error } : {}), keyProblem: keyProblem(src), profiles: rows, orphans, info };
  if (flash?.note) v.note = flash.note;
  if (flash?.adding) v.adding = flash.adding;
  const del = q.get("delete");
  if (del && !v.note && rows.some((r) => r.name === del && r.from === "store")) v.confirm = del;
  const edit = q.get("edit");
  if (edit && rows.some((r) => r.name === edit && r.from === "store")) v.editing = edit;
  const note = q.get("note");
  if (note && rows.some((r) => r.name === note && !r.shadowed)) v.noting = note;
  const conv = q.get("convert");
  const to = q.get("to");
  if (conv && !v.note && !v.keyProblem) {
    if (to === "info" && rows.some((r) => r.name === conv && r.from === "store" && !r.unreadable)) v.converting = { name: conv, to };
    if (to === "secret" && info.rows.some((r) => r.name === conv)) v.converting = { name: conv, to };
  }
  return v;
}

// ---- drawing -----------------------------------------------------------------------------------------------

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const PAGE = "/settings/secrets";

function untilLine(ctx: SettingsContext, g: OwnerGrantRow): Raw {
  if (!g.expiresAt) return html`<b>until revoked</b>`;
  return html`<b>${span(Date.parse(g.expiresAt) - ctx.now)} left</b> <span class="faint">until ${whenDay(g.expiresAt, ctx.timeZone, ctx.now)}</span>`;
}

function grantLine(ctx: SettingsContext, g: OwnerGrantRow): Raw {
  const at = g.grantedAt ? html` <span class="faint" title="${when(g.grantedAt, ctx.timeZone, true)}">${ago(g.grantedAt, ctx.now)}</span>` : "";
  return html`<div class="grantline"><span>Every chat, your turns: ${untilLine(ctx, g)} <span class="faint">· ${g.via === "console" ? "granted here" : "granted on her request"}${at} · grant #${g.id}</span></span>${action(ctx, `${PAGE}/revoke`, "Revoke now", { grant: String(g.id) }, "danger")}</div>`;
}

/** Grant a profile to every chat: a duration and a button, in one form. */
function grantForm(ctx: SettingsContext, name: string): Raw {
  const path = `${PAGE}/grant`;
  return html`<form method="post" action="${path}" class="inline grantf"${writes(path)}>${csrfField(ctx)}<input type="hidden" name="profile" value="${name}"><select name="ttl" aria-label="how long">${GRANT_CHOICES.map((c) => html`<option value="${c.id}">${c.label}</option>`)}</select><button type="submit" class="btn">Grant to every chat</button></form>`;
}

function profileRow(ctx: SettingsContext, v: SecretsPageView, p: ProfileRow): Raw {
  const id = anchor("p", p.name);
  const confirming = v.confirm === p.name && p.from === "store";
  const converting = v.converting?.to === "info" && v.converting.name === p.name && p.from === "store";
  const editing = v.editing === p.name && p.from === "store";
  const noting = v.noting === p.name;
  const facts: Raw[] = [
    p.vars.length ? html`<span class="mono">${p.vars.join(", ")}</span>` : html`<span class="faint">no variables</span>`,
    ...(p.updatedAt ? [html`<span class="faint" title="${when(p.updatedAt, ctx.timeZone, true)}">set ${ago(p.updatedAt, ctx.now)}</span>`] : []),
  ];
  const problem = p.shadowed
    ? html`<p class="why-line c-lost">The secrets file has a profile of this name too: the file's is the one given out. Delete this one, or rename it by adding it again under another name.</p>`
    : p.unreadable
      ? html`<p class="why-line c-failed">Not given out: ${p.unreadable}.</p>`
      : "";
  const usable = !p.shadowed && !p.unreadable;
  // Primary: Replace values and the grant; the rest in the row's "⋯" menu.
  const store = p.from === "store";
  const menu = rowMenu(p.name, [
    p.shadowed ? "" : html`<a class="mi${noting ? " on" : ""}" href="${noting ? PAGE : href(PAGE, { note: p.name })}#${id}"${inPage}>${p.note ? "Edit note" : "Add note"}</a>`,
    store && !v.keyProblem && !p.unreadable ? html`<a class="mi" href="${href(PAGE, { convert: p.name, to: "info" })}#${id}"${inPage}>Make it personal info</a>` : "",
    store ? html`<a class="mi danger" href="${href(PAGE, { delete: p.name })}#${id}"${inPage}>Delete…</a>` : "",
  ]);
  const acts = confirming || converting
    ? ""
    : html`${store && !v.keyProblem ? html`<a class="btn${editing ? " on" : ""}" href="${editing ? PAGE : href(PAGE, { edit: p.name })}#${id}"${inPage}>Replace values</a>` : ""}${
        usable && !p.grants.some((g) => !g.expiresAt) ? grantForm(ctx, p.name) : ""
      }${menu}`;
  return html`<div class="srow${p.unreadable || p.shadowed ? " warn" : ""}${confirming || converting ? " confirming" : ""}" id="${id}">
<div class="smain"><div class="sl1"><span class="sname mono">${p.name}</span><span class="tag">${p.from === "file" ? "secrets file" : "kept here"}</span></div>
<p class="sfacts">${facts.map((x, i) => html`${i ? html`<span class="sep"></span><wbr>` : ""}<span class="fact">${x}</span>`)}</p>
${problem}${noteLines(ctx, p.note)}${p.grants.map((g) => grantLine(ctx, g))}${p.from === "file" ? html`<p class="uses">Its values are changed in the secrets file, where shuvi is deployed.</p>` : ""}
${rowNote(v, p.name)}</div>
<div class="sact">${acts}</div>
${editing ? replaceForm(ctx, p) : ""}${noting ? noteForm(ctx, p) : ""}${confirming ? confirmDelete(ctx, p) : ""}${converting ? confirmToInfo(ctx, p, `${PAGE}#${id}`) : ""}
</div>`;
}

function noteForm(ctx: SettingsContext, p: ProfileRow): Raw {
  const path = `${PAGE}/note`;
  return html`<form class="sform edit note" method="post" action="${path}"${writes(path)}>${csrfField(ctx)}<input type="hidden" name="name" value="${p.name}">
<label>Summary<input type="text" name="summary" maxlength="${SUMMARY_MAX}" value="${p.note?.summary ?? ""}" placeholder="what it is for, in one line" autocomplete="off"><span class="hint">One line, in her prompt beside the name: what it is for.</span></label>
<label>Details<textarea name="details" rows="8" maxlength="${DETAILS_MAX}" placeholder="Variables:&#10;- KEY: what it is&#10;&#10;Scope, the account it acts as, how to use it…">${p.note?.details ?? ""}</textarea><span class="hint">What she reads with <span class="mono">secret_info</span>: scope, account or org ids, how to use it, what failed. She can update it too. Never a secret value: a note holding one is refused.</span></label>
<div class="fbtns"><button type="submit" class="btn primary">Save note</button><a class="btn" href="${PAGE}#${anchor("p", p.name)}"${inPage}>Cancel</a></div>
</form>`;
}

/**
 * Change a profile's values: its keys in the table (kv-table.ts), each with its description (the note's
 * `- NAME: ...` line) and an empty value box. An empty box keeps the value it has; ✕ takes the key out; new keys go
 * in the empty row and those "+ Add a row" adds. Nothing typed here is ever shown back.
 */
function replaceForm(ctx: SettingsContext, p: ProfileRow): Raw {
  const path = `${PAGE}/put`;
  const abouts = varAbouts(p.note);
  return html`<form class="sform kvform" method="post" action="${path}"${writes(path)}>${csrfField(ctx)}<input type="hidden" name="name" value="${p.name}"><input type="hidden" name="replace" value="1">
${kvTable("secret", p.vars.map((n) => ({ key: n, ...(abouts[n] ? { about: abouts[n] } : {}) })))}
<p class="hint">Fill in only what changes: an empty value keeps its value. The old values stay redacted from what she sees.</p>
<div class="fbtns"><button type="submit" class="btn primary">Save</button><a class="btn" href="${PAGE}#${anchor("p", p.name)}"${inPage}>Cancel</a></div>
</form>`;
}

function confirmDelete(ctx: SettingsContext, p: ProfileRow): Raw {
  const effect = `Every grant of it is revoked, ${p.grants.length ? `its ${plural(p.grants.length, "grant")} to every chat and ` : ""}any to a single chat, so a profile added later under this name starts with none; its note is deleted.`;
  return html`<div class="confirm"><p class="q">Delete ${p.name}?</p><p class="effect">${effect} Its values stay redacted from what she sees.</p><div class="cbtns">${action(ctx, `${PAGE}/delete`, `Delete ${p.name}`, { name: p.name }, "danger solid")}<a class="btn" href="${PAGE}#${anchor("p", p.name)}"${inPage}>Cancel</a></div></div>`;
}

function addSection(ctx: SettingsContext, v: SecretsPageView): Raw {
  const f = v.adding ?? {};
  const path = `${PAGE}/put`;
  const body = v.keyProblem
    ? html`${rowNote(v, "add")}<p class="notice refused">Profiles cannot be kept here: ${v.keyProblem}. Set it where shuvi is deployed (32 bytes, base64: <span class="mono">openssl rand -base64 32</span>) and restart; until then, only the secrets file's profiles are there.</p>`
    : html`<details class="addp" id="add-profile" ${v.adding || !v.profiles.length ? "open" : ""}><summary>New profile</summary>
${rowNote(v, "add")}
<form class="sform kvform" method="post" action="${path}"${writes(path)}>${csrfField(ctx)}
<div class="kvtop"><label>Profile<input type="text" name="name" required pattern="[A-Za-z0-9][A-Za-z0-9_\\-]{0,63}" maxlength="64" value="${f.name ?? ""}" placeholder="example" class="mono" autocomplete="off"><span class="hint">what she asks for, and what a key reference starts with (<span class="mono">example.KEY</span>)</span></label>
<label>Summary<input type="text" name="summary" maxlength="${SUMMARY_MAX}" placeholder="what it is for, in one line" autocomplete="off"><span class="hint">in her prompt beside the name; never a value</span></label></div>
${kvTable("secret")}
<p class="hint">Each key with its value; the description goes into the note, for her and for you. Values are sealed when saved and never shown again: not here, not to her.</p>
<label class="kvgrant">Give it to her<select name="grant"><option value="" ${!f.grant ? "selected" : ""}>not yet: she asks when she needs it</option>${GRANT_CHOICES.map((c) => html`<option value="${c.id}" ${f.grant === c.id ? "selected" : ""}>every chat, ${c.label}</option>`)}</select><span class="hint">Every chat's computer gets it, in turns you start only, never an operator's.</span></label>
<div class="fbtns"><button type="submit" class="btn primary">Add profile</button></div>
</form></details>`;
  return html`<section class="sset" id="add"><div class="shd"><h2>Add a secret</h2><span class="meta">kept here, sealed</span></div>${body}</section>`;
}

export function secretsBody(ctx: SettingsContext, v: SecretsPageView): Raw {
  const granted = v.profiles.filter((p) => p.grants.length).length;
  const facts = [
    plural(v.profiles.length, "secret"),
    plural(v.info.rows.length, "personal info profile", "personal info profiles"),
    granted ? `${granted} granted to every chat` : html`<span class="faint">none granted to every chat</span>`,
    v.keyProblem ? html`<span class="c-failed">no key</span>` : "sealed with SHUVI_SECRETS_KEY",
  ];
  const globalNote = v.note && !v.note.on ? html`<div class="notice ${v.note.tone}" role="status">${v.note.text}</div>` : "";
  const fileNote = v.fileError
    ? html`<div class="notice failed">The secrets file cannot be used: ${v.fileError}. No command gets a secret until it is fixed where shuvi is deployed; what is shown of it is what it held.</div>`
    : "";
  return html`<main class="settings secrets">
<div class="head"><div class="title"><h1>Secrets &amp; personal info</h1><span class="meta">what she never sees, and what she reads</span></div>
<p class="facts">${facts.map((x, i) => html`${i ? html`<span class="sep"></span><wbr>` : ""}<span class="fact">${x}</span>`)}</p>
<nav class="jump small"><a href="/settings">← Model catalog</a><a href="#profiles">Secrets</a><a href="#add">Add a secret</a><a href="#info">Personal info</a></nav></div>
${globalNote}${fileNote}
<section class="sset" id="profiles">
<div class="shd"><h2>Secrets</h2><span class="meta">she never sees these · names only</span></div>
${v.profiles.length ? v.profiles.map((p) => profileRow(ctx, v, p)) : html`<p class="empty-s">No secret profiles. Add one below, or in the secrets file (<span class="mono">${v.file}</span>).</p>`}
${v.orphans.length ? html`<div class="sgroup"><div class="sgh"><span class="faint">Granted to every chat, but the profile is gone</span></div>${v.orphans.map((g) => html`<div class="srow warn"><div class="smain"><div class="sl1"><span class="sname mono">${g.profile}</span></div>${grantLine(ctx, g)}</div></div>`)}</div>` : ""}
</section>
${addSection(ctx, v)}
${infoSection(ctx, v.info, v.note, v.keyProblem, v.converting?.to === "secret" ? v.converting.name : undefined)}
<p class="meta foot">She asks for a profile with <span class="mono">request_secret</span>; your answer on its card in the control bot grants it to that chat or to every chat. Grants to single chats are on each chat's settings page. A command already running keeps the values it started with.</p>
</main>`;
}

export function secretsPage(ctx: SettingsContext, v: SecretsPageView): string {
  return page("Secrets", secretsBody(ctx, v), ctx.who, "settings");
}
