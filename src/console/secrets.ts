import { ownerGrants, type OwnerTtl } from "../capabilities/computer/secrets.ts";
import { allProfiles, keyProblem, storedProfiles, type SecretSource } from "../secrets/source.ts";
import { loadProfiles } from "../secrets/redaction.ts";
import { allNotes, DETAILS_MAX, SUMMARY_MAX, type SecretNote } from "../secrets/notes.ts";
import type { Db } from "../store/db.ts";
import { approvals } from "../store/schema.ts";
import { eq } from "drizzle-orm";
import { span, whenDay } from "./chat-extras.ts";
import { ago, href, html, page, when, type Raw } from "./html.ts";
import { action, anchor, csrfField, inPage, rowNote, writes, type SettingsContext, type SettingsNote } from "./settings.ts";

/**
 * The Secrets page (`/settings/secrets`): her credentials. Every secret profile there is, the secrets file's (read
 * only: changed where shuvi is deployed) and those kept here (sealed in the store under SHUVI_SECRETS_KEY,
 * src/secrets/source.ts), with their variables' NAMES, never a value; and the OWNER GRANTS, a profile given to
 * every chat's computer for the owner's own requests (capabilities/computer/secrets.ts), each with its Revoke.
 *
 * This file READS and draws; the writes are secrets-write.ts (`POST /settings/secrets/<verb>`, CSRF-checked as
 * every console write is). A value is only ever typed in (adding a profile, replacing its values) and never drawn
 * back: a refused form comes back with its name and its grant choice, never its values. Delete is a link (GET
 * `?delete=`) to a confirmation, as Settings' Remove is.
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
export function loadSecretsPage(db: Db, src: SecretSource, q: URLSearchParams, flash?: { note?: SettingsNote; adding?: AddForm }, now = Date.now()): SecretsPageView {
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
  const v: SecretsPageView = { file: src.file, ...("error" in file ? { fileError: file.error } : {}), keyProblem: keyProblem(src), profiles: rows, orphans };
  if (flash?.note) v.note = flash.note;
  if (flash?.adding) v.adding = flash.adding;
  const del = q.get("delete");
  if (del && !v.note && rows.some((r) => r.name === del && r.from === "store")) v.confirm = del;
  const edit = q.get("edit");
  if (edit && rows.some((r) => r.name === edit && r.from === "store")) v.editing = edit;
  const note = q.get("note");
  if (note && rows.some((r) => r.name === note && !r.shadowed)) v.noting = note;
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
  const acts = confirming
    ? ""
    : html`${usable && !p.grants.some((g) => !g.expiresAt) ? grantForm(ctx, p.name) : ""}${
        p.shadowed ? "" : html`<a class="btn${noting ? " on" : ""}" href="${noting ? PAGE : href(PAGE, { note: p.name })}#${id}"${inPage}>${p.note ? "Edit note" : "Add note"}</a>`
      }${
        p.from === "store"
          ? html`${v.keyProblem ? "" : html`<a class="btn${editing ? " on" : ""}" href="${editing ? PAGE : href(PAGE, { edit: p.name })}#${id}"${inPage}>Replace values</a>`}<a class="btn danger" href="${href(PAGE, { delete: p.name })}#${id}"${inPage}>Delete</a>`
          : ""
      }`;
  return html`<div class="srow${p.unreadable || p.shadowed ? " warn" : ""}${confirming ? " confirming" : ""}" id="${id}">
<div class="smain"><div class="sl1"><span class="sname mono">${p.name}</span><span class="tag">${p.from === "file" ? "secrets file" : "kept here"}</span></div>
<p class="sfacts">${facts.map((x, i) => html`${i ? html`<span class="sep"></span><wbr>` : ""}<span class="fact">${x}</span>`)}</p>
${problem}${noteLines(ctx, p)}${p.grants.map((g) => grantLine(ctx, g))}${p.from === "file" ? html`<p class="uses">Its values are changed in the secrets file, where shuvi is deployed.</p>` : ""}
${rowNote(v, p.name)}</div>
<div class="sact">${acts}</div>
${editing ? replaceForm(ctx, p) : ""}${noting ? noteForm(ctx, p) : ""}${confirming ? confirmDelete(ctx, p) : ""}
</div>`;
}

/** The note under a profile: its summary (what her prompt says), and that there are details, with who wrote it. */
function noteLines(ctx: SettingsContext, p: ProfileRow): Raw | "" {
  const n = p.note;
  if (!n || (!n.summary && !n.details)) return "";
  const by = html` <span class="faint" title="${when(n.updatedAt, ctx.timeZone, true)}">· ${n.updatedBy.startsWith("assistant") ? "written by her" : "written by you"} ${ago(n.updatedAt, ctx.now)}</span>`;
  return html`<p class="note-sum">${n.summary || html`<span class="faint">no summary</span>`}${n.details ? html` <span class="faint">· ${plural(n.details.split("\n").length, "line")} of details</span>` : ""}${by}</p>`;
}

function noteForm(ctx: SettingsContext, p: ProfileRow): Raw {
  const path = `${PAGE}/note`;
  return html`<form class="sform edit note" method="post" action="${path}"${writes(path)}>${csrfField(ctx)}<input type="hidden" name="name" value="${p.name}">
<label>Summary<input type="text" name="summary" maxlength="${SUMMARY_MAX}" value="${p.note?.summary ?? ""}" placeholder="GitHub token for the example-org repos (issues, PRs)" autocomplete="off"><span class="hint">One line, in her prompt beside the name: what it is for.</span></label>
<label>Details<textarea name="details" rows="8" maxlength="${DETAILS_MAX}" placeholder="Scope: repo, read:org. Acts as example-bot in example-org (id 1234). Use gh with GH_TOKEN; …">${p.note?.details ?? ""}</textarea><span class="hint">What she reads with <span class="mono">secret_info</span>: scope, account or org ids, how to use it, what failed. She can update it too. Never a secret value: a note holding one is refused.</span></label>
<div class="fbtns"><button type="submit" class="btn primary">Save note</button><a class="btn" href="${PAGE}#${anchor("p", p.name)}"${inPage}>Cancel</a></div>
</form>`;
}

const valuesField = (placeholder: string) =>
  html`<label>Values<textarea name="values" rows="4" required class="mono" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${placeholder}"></textarea><span class="hint">One <span class="mono">NAME=value</span> per line. Sealed when saved, and never shown again: not here, not to her.</span></label>`;

function replaceForm(ctx: SettingsContext, p: ProfileRow): Raw {
  const path = `${PAGE}/put`;
  return html`<form class="sform edit" method="post" action="${path}"${writes(path)}>${csrfField(ctx)}<input type="hidden" name="name" value="${p.name}"><input type="hidden" name="replace" value="1">
${valuesField(p.vars.map((n) => `${n}=…`).join("\n"))}
<p class="hint">Give every variable again: what is left out is gone. The old values stay redacted from what she sees.</p>
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
<form class="sform" method="post" action="${path}"${writes(path)}>${csrfField(ctx)}
<label>Name<input type="text" name="name" required pattern="[A-Za-z0-9][A-Za-z0-9_\\-]{0,63}" maxlength="64" value="${f.name ?? ""}" placeholder="github" class="mono" autocomplete="off"><span class="hint">what she asks for, and what a provider's key reference starts with (<span class="mono">github.GH_TOKEN</span>)</span></label>
${valuesField("GH_TOKEN=ghp_…")}
<label>Give it to her<select name="grant"><option value="" ${!f.grant ? "selected" : ""}>not yet: she asks when she needs it</option>${GRANT_CHOICES.map((c) => html`<option value="${c.id}" ${f.grant === c.id ? "selected" : ""}>every chat, ${c.label}</option>`)}</select><span class="hint">Every chat's computer gets it, in turns you start only, never an operator's.</span></label>
<div class="fbtns"><button type="submit" class="btn primary">Add profile</button></div>
</form></details>`;
  return html`<section class="sset" id="add"><div class="shd"><h2>Add a profile</h2><span class="meta">kept here, sealed</span></div>${body}</section>`;
}

export function secretsBody(ctx: SettingsContext, v: SecretsPageView): Raw {
  const granted = v.profiles.filter((p) => p.grants.length).length;
  const facts = [
    plural(v.profiles.length, "profile"),
    granted ? `${granted} granted to every chat` : html`<span class="faint">none granted to every chat</span>`,
    v.keyProblem ? html`<span class="c-failed">no key</span>` : "sealed with SHUVI_SECRETS_KEY",
  ];
  const globalNote = v.note && !v.note.on ? html`<div class="notice ${v.note.tone}" role="status">${v.note.text}</div>` : "";
  const fileNote = v.fileError
    ? html`<div class="notice failed">The secrets file cannot be used: ${v.fileError}. No command gets a secret until it is fixed where shuvi is deployed; what is shown of it is what it held.</div>`
    : "";
  return html`<main class="settings secrets">
<div class="head"><div class="title"><h1>Secrets</h1><span class="meta">her credentials</span></div>
<p class="facts">${facts.map((x, i) => html`${i ? html`<span class="sep"></span><wbr>` : ""}<span class="fact">${x}</span>`)}</p>
<nav class="jump small"><a href="/settings">← Model catalog</a><a href="#profiles">Profiles</a><a href="#add">Add a profile</a></nav></div>
${globalNote}${fileNote}
<section class="sset" id="profiles">
<div class="shd"><h2>Profiles</h2><span class="meta">names only, never a value</span></div>
${v.profiles.length ? v.profiles.map((p) => profileRow(ctx, v, p)) : html`<p class="empty-s">No secret profiles. Add one below, or in the secrets file (<span class="mono">${v.file}</span>).</p>`}
${v.orphans.length ? html`<div class="sgroup"><div class="sgh"><span class="faint">Granted to every chat, but the profile is gone</span></div>${v.orphans.map((g) => html`<div class="srow warn"><div class="smain"><div class="sl1"><span class="sname mono">${g.profile}</span></div>${grantLine(ctx, g)}</div></div>`)}</div>` : ""}
</section>
${addSection(ctx, v)}
<p class="meta foot">She asks for a profile with <span class="mono">request_secret</span>; your answer on its card in the control bot grants it to that chat or to every chat. Grants to single chats are on each chat's settings page. A command already running keeps the values it started with.</p>
</main>`;
}

export function secretsPage(ctx: SettingsContext, v: SecretsPageView): string {
  return page("Secrets", secretsBody(ctx, v), ctx.who, "settings");
}
