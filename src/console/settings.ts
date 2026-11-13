import { consoleListing, type ConsoleListing } from "../control/model-cards.ts";
import { DEFAULT_TIMEOUT_MS } from "../server/probes.ts";
import type { Db } from "../store/db.ts";
import { chatsOn, listModels, listProviders, probePending, type CatalogModel, type ProviderKind } from "../store/models.ts";
import { ago, dot, href, html, page, raw, when, type Raw } from "./html.ts";
import { chatName } from "./pages.ts";
import { chatById } from "./queries.ts";

/**
 * The Settings page (`/settings`, DESIGN.md "Settings"): the model catalog's providers and models, their
 * probes, adding a provider and the models its endpoint lists, removing either. The control bot's `/models`
 * and `/provider` cards (control/model-cards.ts) do the same operations, and the texts here are theirs.
 *
 * This file READS and draws: the catalog (store/models.ts), the chats on each model, the console's listing
 * card (model-cards.ts `consoleListing`), and the result of the last write (a flash, settings-write.ts). Every
 * button is a POST form to a route of settings-write.ts carrying the page's CSRF token; Remove and Edit are
 * links (GET `?remove=` / `?edit=`): a confirmation is a state of this page, so it works without script.
 *
 * WITH SCRIPT (htmx, server.ts): a form posts in the background (`hx-post`, `writes`), the button is disabled
 * and marked busy until the answer, and the answer's `<main>` (the page the 303 leads to, or the refusal) takes
 * the place of this one, so the page does not reload or jump; an in-page link does the same with a GET. A probe
 * or a listing runs in the server's background pass: while one is pending, the part showing it (its model's row,
 * the listing panel) fetches itself again every second (`polls`, from `/settings/model` and `/settings/listing`,
 * `modelPart` / `listingPart`) with the time waited and a Cancel, and stops once it is no longer pending.
 * Without script, the page shows it when reloaded.
 */

/** A finished probe's result; null: none has finished. */
export type ProbeResult =
  | null
  | { status: "ok"; latencyMs: number | null; at: string | null }
  | { status: "text-instead"; latencyMs: number | null; at: string | null }
  | { status: "failed"; error: string; latencyMs: number | null; at: string | null };

/** What the page shows: a probe pending since it was asked (with the last result, kept), or the last result. */
export type Probe = ProbeResult | { status: "checking"; since: string | null; last: ProbeResult };

export interface SettingsProvider {
  name: string;
  kind: ProviderKind;
  /** openai-compat */
  baseUrl?: string | null;
  /** claude; null = the login of the user the server runs as */
  configDir?: string | null;
  /** `<profile>.<VAR>`: a name, never a value. */
  apiKey?: string | null;
}

export interface SettingsChat {
  id: number;
  name: string;
}

export interface SettingsModel {
  id: string;
  provider: string;
  kind: ProviderKind;
  label?: string | null;
  isDefault: boolean;
  contextWindow?: number | null;
  vision: boolean;
  /** The owner set vision himself: a probe no longer changes it. */
  visionSet: boolean;
  /** What the last probe that tried saw (null: not known). */
  probeVision?: boolean | null;
  probe: Probe;
  /** The chats whose own model it is (`chats.model`). */
  chats: SettingsChat[];
}

/** The result of a write, shown once on the page it redirects to (settings-write.ts). */
export interface SettingsNote {
  tone: "ok" | "refused" | "failed";
  text: string;
  /** The model or provider it is about: drawn on its row instead of at the top. */
  on?: string;
}

/**
 * What the add-provider form was sent with, to show it again after a refusal. Never the key reference: a key
 * pasted there must not be shown back (settings-write.ts).
 */
export type ProviderForm = Partial<Record<"name" | "kind" | "base_url" | "config_dir", string>>;

export interface SettingsView {
  providers: SettingsProvider[];
  models: SettingsModel[];
  /** Chats with no model of their own: they run on the default. */
  onDefault: number;
  note?: SettingsNote;
  listing?: ConsoleListing;
  /** A Remove asked for and not yet confirmed. */
  confirm?: { kind: "model" | "provider"; id: string };
  /** The model whose edit form is open. */
  editing?: string;
  /** The add-provider form open, with these values. */
  adding?: ProviderForm;
}

export interface SettingsContext {
  timeZone: string;
  who?: string;
  now: number;
  /** This session's CSRF token, in every form (server.ts). */
  csrf: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const names = (all: readonly string[], max = 10) => (all.length > max ? `${all.slice(0, max).join(", ")} and ${all.length - max} more` : all.join(", "));
const tokensOf = (n: number) => `${n.toLocaleString("en-US")} tokens`;

// ---- reading -----------------------------------------------------------------------------------------------

function probeOf(m: CatalogModel): Probe {
  const last = lastProbe(m);
  return probePending(m) ? { status: "checking", since: m.model.probeStartedAt, last } : last;
}

function lastProbe(m: CatalogModel): ProbeResult {
  const r = m.model;
  switch (r.probeStatus) {
    case null:
      return null;
    case "ok":
    case "text-instead":
      return { status: r.probeStatus, latencyMs: r.probeLatencyMs, at: r.probedAt };
    case "failed":
      return { status: "failed", error: r.probeError ?? "unknown", latencyMs: r.probeLatencyMs, at: r.probedAt };
    default:
      throw new Error(`unknown probe status "${String(r.probeStatus satisfies never)}"`);
  }
}

/** The page's view of the catalog now, with what the query asks for (`remove`, `edit`) and the last write's note. */
export function loadSettings(db: Db, q: URLSearchParams, flash?: { note?: SettingsNote; adding?: ProviderForm }): SettingsView {
  const providers: SettingsProvider[] = listProviders(db).map((p) => ({ name: p.name, kind: p.kind, baseUrl: p.baseUrl, configDir: p.configDir, apiKey: p.apiKey }));
  const models: SettingsModel[] = listModels(db).map((m) => ({
    id: m.id,
    provider: m.provider.name,
    kind: m.provider.kind,
    label: m.model.label,
    isDefault: m.model.isDefault,
    contextWindow: m.model.contextWindow,
    vision: m.model.vision,
    visionSet: m.model.visionSet,
    probeVision: m.model.probeVision,
    probe: probeOf(m),
    chats: chatsOn(db, [m.id]).map((c) => {
      const cc = chatById(db, c.id);
      return { id: c.id, name: cc ? chatName(cc) : `chat ${c.id}` };
    }),
  }));
  const onDefault = (db.$client.query("select count(*) as n from chats where model is null").get() as { n: number }).n;
  const v: SettingsView = { providers, models, onDefault };
  const listing = consoleListing(db);
  if (listing && providers.some((p) => p.name === listing.provider)) v.listing = listing;
  if (flash?.note) v.note = flash.note;
  if (flash?.adding) v.adding = flash.adding;
  // Remove, asked: the confirmation, or the refusal the control bot gives (the default cannot go).
  const remove = q.get("remove");
  if (remove && !v.note) {
    const [kind, ...rest] = remove.split(":");
    const id = rest.join(":");
    if (kind === "model") {
      const m = models.find((x) => x.id === id);
      if (m?.isDefault) v.note = { tone: "refused", text: `${id} is the default: make another model the default first.`, on: id };
      else if (m) v.confirm = { kind, id };
    } else if (kind === "provider" && providers.some((p) => p.name === id)) {
      const def = models.find((m) => m.provider === id && m.isDefault);
      if (def) v.note = { tone: "refused", text: `${def.id} is the default model: make a model of another provider the default first.`, on: id };
      else v.confirm = { kind, id };
    }
  }
  const edit = q.get("edit");
  if (edit && models.some((m) => m.id === edit)) v.editing = edit;
  return v;
}

// ---- small parts -----------------------------------------------------------------------------------------

/**
 * The id of a row (and the fragment that lands on it): `<kind>-` and the model id or provider name, each UTF-8
 * byte other than an ASCII letter, digit or `-` written `_xx` (so `_` itself too, which keeps it one-to-one). An
 * id may hold `/` and any character an endpoint's `/models` listed; encoded, it is plain ASCII (a `Location`
 * header can carry it) AND a CSS identifier, so `#<anchor>` is a selector as it is: htmx looks a fragment up with
 * one after a swap, and a percent sign there throws.
 */
export const anchor = (kind: "model" | "provider" | "p", id: string) =>
  `${kind}-${[...new TextEncoder().encode(id)].map((b) => (/[A-Za-z0-9-]/.test(String.fromCharCode(b)) && b < 0x80 ? String.fromCharCode(b) : `_${b.toString(16).padStart(2, "0")}`)).join("")}`;

/** A span of milliseconds as m:ss. */
function mss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The time something pending has waited since `iso`, beside how long a request may take before it gives up. */
const waitedLine = (iso: string | null, now: number, each = false) =>
  html`<span class="waited">waited ${mss(iso ? now - Date.parse(iso) : 0)}<span class="faint"> · ${each ? "each request gives up" : "gives up"} after ${mss(DEFAULT_TIMEOUT_MS)}</span></span>`;

/**
 * A write form's htmx attributes: post in the background, mark the form busy and disable its button until the
 * answer, then put the answer's `<main>` (the Settings page, or a refusal) in this page's place.
 */
const writes = (path: string, disable = "find button") =>
  html` hx-post="${path}" hx-target="main.settings" hx-select="main" hx-swap="outerHTML" hx-push-url="false" hx-indicator="#progress, closest form" hx-disabled-elt="${disable}"`;

/** An in-page link's: the same swap, for a GET (an Edit, a Remove asked, a Cancel), keeping the URL. */
const inPage = raw(` hx-target="main.settings" hx-select="main" hx-swap="outerHTML"`);

/**
 * A pending part's: fetch itself from `from` every second, in its own place, inheriting nothing. `data-poll`
 * marks it for console.js, which keeps an answer that is not this part (an error page, the sign-in page after a
 * session ended) out of it.
 */
const polls = (from: string) => html` hx-get="${from}" hx-trigger="every 1s" hx-target="this" hx-swap="outerHTML" hx-indicator="unset" hx-disinherit="*" data-poll`;

const csrfField = (ctx: SettingsContext) => html`<input type="hidden" name="csrf" value="${ctx.csrf}">`;

/** A POST form holding one button. */
function action(ctx: SettingsContext, path: string, label: string, fields: Record<string, string>, cls = ""): Raw {
  return html`<form method="post" action="${path}" class="inline"${writes(path)}>${csrfField(ctx)}${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<button type="submit" class="btn ${cls}">${label}</button></form>`;
}

function kindLabel(kind: ProviderKind): string {
  return kind === "claude" ? "Claude login" : "OpenAI-compatible";
}

function probeLine(p: Probe, ctx: SettingsContext): Raw {
  if (!p) return html`<span class="faint">not probed</span>`;
  const at = (iso: string | null, verb = "probed") => (iso ? html` <span class="faint" title="${when(iso, ctx.timeZone, true)}">${verb} ${ago(iso, ctx.now)}</span>` : "");
  const ms = (n: number | null) => (n !== null ? `, ${n} ms` : "");
  switch (p.status) {
    case "checking":
      return html`<span class="probe c-running">${dot("running")}probe checking…</span> ${waitedLine(p.since, ctx.now, true)}`;
    case "ok":
      return html`<span class="probe c-done">${dot("done")}probe ok${ms(p.latencyMs)}</span>${at(p.at)}`;
    case "text-instead":
      return html`<span class="probe c-lost">${dot("lost")}⚠ text-instead${ms(p.latencyMs)}</span>${at(p.at)}`;
    case "failed":
      return html`<span class="probe c-failed">${dot("failed")}⚠ failed</span>${at(p.at)}`;
  }
}

/** Why a warned probe matters, in a sentence (under the facts). */
function probeWhy(p: Probe): Raw | "" {
  if (p?.status === "text-instead") return html`<p class="why-line c-lost">It answered in text instead of calling a tool: without tools she cannot speak on it.</p>`;
  if (p?.status === "failed") return html`<p class="why-line c-failed">${p.error}</p>`;
  return "";
}

function visionFact(m: SettingsModel): Raw {
  const word = m.vision ? "vision" : "no vision";
  if (m.visionSet) return html`${word} <span class="src">set by you</span>`;
  if (m.probeVision != null) return html`${word} <span class="src">from probe</span>`;
  return html`${word} <span class="src">not known yet</span>`;
}

/** Vision on / off / auto (auto: follow the probe). */
function visionSwitch(ctx: SettingsContext, m: SettingsModel): Raw {
  const now = m.visionSet ? (m.vision ? "on" : "off") : "auto";
  // Its three buttons are in one fieldset, so a press disables them all until the answer.
  return html`<form method="post" action="/settings/models/vision" class="seg-btns" aria-label="vision"${writes("/settings/models/vision", "find fieldset")}>${csrfField(ctx)}<input type="hidden" name="model" value="${m.id}"><span class="seg-label">Vision</span><fieldset class="seg-set">${(["on", "off", "auto"] as const).map(
    (v) => html`<button type="submit" name="vision" value="${v}" class="${v === now ? "on" : ""}" ${v === now ? html`aria-pressed="true"` : ""} title="${v === "auto" ? "follow the probe" : `set ${v} by you`}">${v}</button>`,
  )}</fieldset></form>`;
}

function chatLinks(chats: SettingsChat[]): Raw {
  return html`${chats.map((c, i) => html`${i ? ", " : ""}<a href="/chats/${c.id}">${c.name}</a>`)}`;
}

const rowNote = (v: SettingsView, id: string) => (v.note?.on === id ? html`<p class="row-note ${v.note.tone}" role="status">${v.note.text}</p>` : "");

// ---- providers -------------------------------------------------------------------------------------------

function providerRow(ctx: SettingsContext, v: SettingsView, p: SettingsProvider): Raw {
  const its = v.models.filter((m) => m.provider === p.name);
  const where = p.kind === "claude" ? html`<span class="mono">${p.configDir ?? "the server user's login"}</span>` : html`<span class="mono">${p.baseUrl ?? ""}</span>`;
  const key = p.kind === "claude" ? "" : p.apiKey ? html`key <span class="mono">${p.apiKey}</span>` : html`<span class="faint">no key</span>`;
  const confirming = v.confirm?.kind === "provider" && v.confirm.id === p.name;
  const facts = [where, key, html`<a href="#${anchor("p", p.name)}">${plural(its.length, "model")}</a>`].filter(Boolean);
  return html`<div class="srow${confirming ? " confirming" : ""}" id="${anchor("provider", p.name)}">
<div class="smain"><div class="sl1"><span class="sname">${p.name}</span><span class="tag">${kindLabel(p.kind)}</span></div>
<p class="sfacts">${facts.map((x, i) => html`${i ? html`<span class="sep"></span><wbr>` : ""}<span class="fact">${x}</span>`)}</p>
${rowNote(v, p.name)}</div>
<div class="sact">${
    confirming
      ? ""
      : html`${p.kind === "openai-compat" ? action(ctx, "/settings/providers/list", "List models", { provider: p.name }) : ""}<a class="btn danger" href="${href("/settings", { remove: `provider:${p.name}` })}#${anchor("provider", p.name)}"${inPage}>Remove</a>`
  }</div>
${confirming ? confirmProvider(ctx, v, p) : ""}
</div>`;
}

function confirmProvider(ctx: SettingsContext, v: SettingsView, p: SettingsProvider): Raw {
  const its = v.models.filter((m) => m.provider === p.name);
  const chats = its.flatMap((m) => m.chats);
  const q = its.length ? `Remove provider ${p.name} and its ${plural(its.length, "model")} (${names(its.map((m) => m.id))})?` : `Remove provider ${p.name}? It has no models.`;
  const effect = chats.length ? html`Chats on them: ${chatLinks(chats)}. Their next turn fails until they get another model.` : its.length ? "No chat has one of them as its own model." : "";
  return html`<div class="confirm"><p class="q">${q}</p>${effect ? html`<p class="effect">${effect}</p>` : ""}<div class="cbtns">${action(ctx, "/settings/providers/remove", `Remove ${p.name}`, { provider: p.name }, "danger solid")}<a class="btn" href="/settings#${anchor("provider", p.name)}"${inPage}>Cancel</a></div></div>`;
}

// ---- models ----------------------------------------------------------------------------------------------

function modelRow(ctx: SettingsContext, v: SettingsView, m: SettingsModel): Raw {
  const confirming = v.confirm?.kind === "model" && v.confirm.id === m.id;
  const editing = v.editing === m.id;
  const warned = m.probe?.status === "text-instead" || m.probe?.status === "failed";
  const pending = m.probe?.status === "checking";
  const facts: Raw[] =
    m.kind === "claude"
      ? [html`<span class="faint">Claude login: context window and vision are the CLI's</span>`]
      : [m.contextWindow ? html`<b>${tokensOf(m.contextWindow)}</b>` : html`<span class="c-failed">no context window</span>`, visionFact(m), probeLine(m.probe, ctx)];
  const uses = m.isDefault
    ? html`<p class="uses">The default: ${plural(v.onDefault, "chat")} without a model of ${v.onDefault === 1 ? "its" : "their"} own ${v.onDefault === 1 ? "runs" : "run"} on it${m.chats.length ? html`; own model of ${chatLinks(m.chats)}` : ""}.</p>`
    : m.chats.length
      ? html`<p class="uses">Own model of ${chatLinks(m.chats)}</p>`
      : "";
  const field = { model: m.id };
  const acts = confirming
    ? ""
    : html`${m.isDefault ? "" : action(ctx, "/settings/models/default", "Make default", field)}${
        m.kind === "openai-compat" ? (pending ? action(ctx, "/settings/models/probe-cancel", "Cancel probe", field) : action(ctx, "/settings/models/probe", "Re-probe", field)) : ""
      }<a class="btn${editing ? " on" : ""}" href="${editing ? "/settings" : href("/settings", { edit: m.id })}#${anchor("model", m.id)}"${inPage}>Edit</a><a class="btn danger" href="${href("/settings", { remove: `model:${m.id}` })}#${anchor("model", m.id)}"${inPage}>Remove</a>`;
  // While its probe is pending, the row fetches itself again every second; an open form or confirmation is left alone.
  const live = pending && !confirming && !editing ? polls(href("/settings/model", { id: m.id })) : "";
  return html`<div class="srow${warned ? " warn" : ""}${m.probe?.status === "failed" ? " bad" : ""}${confirming ? " confirming" : ""}" id="${anchor("model", m.id)}"${live}>
<div class="smain"><div class="sl1">${m.isDefault ? html`<span class="star" title="the default model">★</span>` : ""}<span class="sname">${m.id}</span>${m.label ? html`<span class="label">${m.label}</span>` : ""}</div>
<p class="sfacts">${facts.map((x, i) => html`${i ? html`<span class="sep"></span><wbr>` : ""}<span class="fact">${x}</span>`)}</p>
${probeWhy(m.probe)}${uses}
${rowNote(v, m.id)}</div>
<div class="sact">${acts}${m.kind === "openai-compat" && !confirming ? visionSwitch(ctx, m) : ""}</div>
${editing ? editForm(ctx, m) : ""}${confirming ? confirmModel(ctx, m) : ""}
</div>`;
}

function editForm(ctx: SettingsContext, m: SettingsModel): Raw {
  return html`<form class="sform edit" method="post" action="/settings/models/edit"${writes("/settings/models/edit")}>${csrfField(ctx)}<input type="hidden" name="model" value="${m.id}">
<label>Label<input type="text" name="label" value="${m.label ?? ""}" maxlength="60" placeholder="shown beside the id"></label>
${m.kind === "openai-compat" ? html`<label>Context window<input type="number" name="context_window" min="1" step="1" value="${m.contextWindow ?? ""}" required inputmode="numeric"><span class="hint">tokens; compaction is measured against it</span></label>` : ""}
<div class="fbtns"><button type="submit" class="btn primary">Save</button><a class="btn" href="/settings#${anchor("model", m.id)}"${inPage}>Cancel</a></div>
</form>`;
}

function confirmModel(ctx: SettingsContext, m: SettingsModel): Raw {
  const effect = m.chats.length ? html`Chats on it: ${chatLinks(m.chats)}. Their next turn fails until they get another model.` : html`No chat has it as its own model.`;
  return html`<div class="confirm"><p class="q">Remove ${m.id}?</p><p class="effect">${effect}</p><div class="cbtns">${action(ctx, "/settings/models/remove", `Remove ${m.id}`, { model: m.id }, "danger solid")}<a class="btn" href="/settings#${anchor("model", m.id)}"${inPage}>Cancel</a></div></div>`;
}

/** The Models section's count line; `oob`: sent beside a polled row, to take the place of the one on the page. */
export function modelsSummary(v: SettingsView, oob = false): Raw {
  const warned = v.models.filter((m) => m.probe?.status === "text-instead" || m.probe?.status === "failed").length;
  const checking = v.models.filter((m) => m.probe?.status === "checking").length;
  const summary = [plural(v.models.length, "model"), ...(checking ? [`${checking} probing`] : []), ...(warned ? [`${warned} ⚠`] : [])].join(" · ");
  return html`<span class="meta" id="models-summary"${oob ? raw(` hx-swap-oob="true"`) : ""}>${summary}</span>`;
}

function modelsSection(ctx: SettingsContext, v: SettingsView): Raw {
  const groups = v.providers.map((p) => ({ p, ms: v.models.filter((m) => m.provider === p.name) }));
  return html`<section class="sset" id="models">
<div class="shd"><h2>Models</h2>${modelsSummary(v)}</div>
${
  v.models.length
    ? groups.map(
        (g) => html`<div class="sgroup" id="${anchor("p", g.p.name)}"><div class="sgh"><span class="mono">${g.p.name}</span><span class="faint">${kindLabel(g.p.kind)} · ${plural(g.ms.length, "model")}</span></div>
${g.ms.length ? g.ms.map((m) => modelRow(ctx, v, m)) : html`<p class="none">No models yet.</p>`}</div>`,
      )
    : html`<p class="empty-s">No models. Turns cannot run until the catalog has one: add a provider below, then its models.</p>`
}
${v.providers.length ? addModelForm(ctx, v) : ""}
</section>`;
}

/** `/models add <provider>/<model> [<context_window>]`, as a form. */
function addModelForm(ctx: SettingsContext, v: SettingsView): Raw {
  const open = v.note?.on === "add-model";
  return html`<details class="addm" id="add-model" ${open ? "open" : ""}><summary>Add a model by its id</summary>
${rowNote(v, "add-model")}
<form class="sform" method="post" action="/settings/models/add"${writes("/settings/models/add")}>${csrfField(ctx)}
<label>Provider<select name="provider">${v.providers.map((p) => html`<option>${p.name}</option>`)}</select></label>
<label>Model<input type="text" name="model" required placeholder="qwen3-32b" class="mono"></label>
<label>Context window<input type="number" name="context_window" min="1" step="1" inputmode="numeric" placeholder="32768"><span class="hint">tokens; required for an OpenAI-compatible model</span></label>
<div class="fbtns"><button type="submit" class="btn primary">Add</button></div>
</form></details>`;
}

// ---- adding a provider -----------------------------------------------------------------------------------

function addProviderSection(ctx: SettingsContext, v: SettingsView): Raw {
  const l = v.listing;
  const f = v.adding ?? {};
  const open = !!v.adding || (!v.providers.length && !l);
  const kind = f.kind === "claude" ? "claude" : "openai-compat";
  return html`<section class="sset" id="add">
<div class="shd"><h2>Add a provider</h2></div>
${listingPart(ctx, v)}
<details class="addp" ${open ? "open" : ""}><summary>${l ? "Add another provider" : "New provider"}</summary>
${rowNote(v, "add-provider")}
<form class="sform" method="post" action="/settings/providers/add"${writes("/settings/providers/add")}>${csrfField(ctx)}
<label>Name<input type="text" name="name" required pattern="[a-z0-9][a-z0-9._\\-]{0,39}" maxlength="40" value="${f.name ?? ""}" placeholder="vllm" class="mono"><span class="hint">the first part of its models' ids; never changes</span></label>
<fieldset class="kind"><legend>Kind</legend>
<label class="radio"><input type="radio" name="kind" value="openai-compat" ${kind === "openai-compat" ? "checked" : ""}> OpenAI-compatible</label>
<label class="radio"><input type="radio" name="kind" value="claude" ${kind === "claude" ? "checked" : ""}> Claude login</label></fieldset>
<label>Base URL<input type="url" name="base_url" value="${f.base_url ?? ""}" placeholder="http://10.0.0.5:8000/v1" class="mono"><span class="hint">OpenAI-compatible: the endpoint, up to /v1</span></label>
<label>Key reference<input type="text" name="api_key" placeholder="home.VLLM_KEY" class="mono" autocomplete="off"><span class="hint">OpenAI-compatible, optional: <span class="mono">&lt;profile&gt;.&lt;VAR&gt;</span> in the secrets file. Never the key itself.</span></label>
<label>Config dir<input type="text" name="config_dir" value="${f.config_dir ?? ""}" placeholder="/home/shuvi/.claude-work" class="mono"><span class="hint">Claude login, optional: empty for the server user's own login</span></label>
<div class="fbtns"><button type="submit" class="btn primary">Add provider</button><span class="hint">An OpenAI-compatible provider's <span class="mono">/models</span> is listed next, to pick from.</span></div>
</form></details>
</section>`;
}

/**
 * The console's listing panel, in a holder that stays on the page (empty when there is none, so a listing opened
 * elsewhere has a place); it fetches itself again every second while the listing, or a probe of a model added
 * from it, is pending. Also the answer to `GET /settings/listing`.
 */
export function listingPart(ctx: SettingsContext, v: SettingsView): Raw {
  const l = v.listing;
  const pending = l?.state === "listing" || (l?.state === "listed" && v.models.some((m) => m.provider === l.provider && m.probe?.status === "checking"));
  return html`<div id="listing"${pending ? polls("/settings/listing") : ""}>${l ? listingPanel(ctx, v, l) : ""}</div>`;
}

/** A model's row alone, with the count line out of band: the answer to `GET /settings/model?id=`. */
export function modelPart(ctx: SettingsContext, v: SettingsView, id: string): Raw {
  const m = v.models.find((x) => x.id === id);
  return html`${m ? modelRow(ctx, v, m) : ""}${modelsSummary(v, true)}`;
}

function listingPanel(ctx: SettingsContext, v: SettingsView, l: ConsoleListing): Raw {
  const p = v.providers.find((x) => x.name === l.provider);
  const where = html`<span class="mono">${l.provider}</span> <span class="faint">(${p?.baseUrl ?? "?"}${p?.apiKey ? html`, key <span class="mono">${p.apiKey}</span>` : ""})</span>`;
  const card = { card: String(l.cardId) };
  switch (l.state) {
    case "listing":
      return html`<div class="listing"><p class="lh">${dot("running")}<span>Listing the models of ${where}…</span></p>
<p class="meta">${waitedLine(l.since, ctx.now)}. A scaled-to-zero endpoint boots first, which can take minutes.</p>
<div class="cbtns">${action(ctx, "/settings/listings/close", "Cancel the listing", card)}<span class="meta">The provider stays.</span></div></div>`;
    case "failed":
      return html`<div class="listing bad"><p class="lh">${dot("failed")}<span>Listing the models of ${where} failed:</span></p>
<p class="mono err-text">${l.error}</p>
<p class="meta">The provider stays. Add a model by its id under <a href="#models">Models</a>, with its context window, or try again.</p>
<div class="cbtns">${action(ctx, "/settings/providers/list", "List again", { provider: l.provider })}${action(ctx, "/settings/listings/close", "Done", card)}</div></div>`;
    case "listed": {
      const ours = new Map(v.models.filter((m) => m.provider === l.provider).map((m) => [m.id, m]));
      return html`<div class="listing"><p class="lh">${dot("done")}<span>${where} lists ${plural(l.listed.length, "model")}. ✓ = in the catalog.</span></p>
${l.note ? html`<p class="row-note ${/^(Could not|The listing gives no)/.test(l.note) ? "failed" : "ok"}" role="status">${l.note}</p>` : ""}
<div class="lrows">${l.listed.map((x, i) => {
        const have = ours.get(`${l.provider}/${x.model}`);
        let right: Raw;
        if (have) right = html`<span class="have c-done">✓ in the catalog</span>${have.probe ? html`<span class="small">${probeLine(have.probe, ctx)}</span>` : ""}`;
        else if (x.contextWindow) right = action(ctx, "/settings/listings/add", "Add", { ...card, index: String(i) });
        else
          right = html`<form method="post" action="/settings/listings/add" class="inline ctxask"${writes("/settings/listings/add")}>${csrfField(ctx)}<input type="hidden" name="card" value="${card.card}"><input type="hidden" name="index" value="${String(i)}"><input type="number" name="context_window" min="1" step="1" required placeholder="context window" aria-label="context window for ${x.model}" inputmode="numeric"><button type="submit" class="btn">Add</button></form>`;
        return html`<div class="lrow${have ? " have" : ""}"><span class="lname mono">${x.model}</span><span class="lctx">${x.contextWindow ? tokensOf(x.contextWindow) : html`<span class="c-lost">no context length listed</span>`}</span><span class="lact">${right}</span></div>`;
      })}</div>
<div class="cbtns">${action(ctx, "/settings/listings/close", "Done", card)}</div></div>`;
    }
  }
}

// ---- the page --------------------------------------------------------------------------------------------

export function settingsBody(ctx: SettingsContext, v: SettingsView): Raw {
  const def = v.models.find((m) => m.isDefault);
  const facts = [plural(v.providers.length, "provider"), plural(v.models.length, "model"), def ? html`default <span class="mono">${def.id}</span>` : html`<span class="c-failed">no default</span>`];
  const globalNote = v.note && !v.note.on ? html`<div class="notice ${v.note.tone}" role="status">${v.note.text}</div>` : "";
  return html`<main class="settings">
<div class="head"><div class="title"><h1>Settings</h1><span class="meta">the model catalog</span></div>
<p class="facts">${facts.map((x, i) => html`${i ? html`<span class="sep"></span><wbr>` : ""}<span class="fact">${x}</span>`)}</p>
<nav class="jump small"><a href="#providers">Providers</a><a href="#models">Models</a><a href="#add">Add a provider</a></nav></div>
${globalNote}
<section class="sset" id="providers">
<div class="shd"><h2>Providers</h2><span class="meta">where models run</span></div>
${v.providers.length ? v.providers.map((p) => providerRow(ctx, v, p)) : html`<p class="empty-s">No providers.</p>`}
</section>
${modelsSection(ctx, v)}
${addProviderSection(ctx, v)}
<p class="meta foot">The control bot's <span class="mono">/models</span> and <span class="mono">/provider</span> do the same; a change in either shows in both.</p>
</main>`;
}

export function settingsPage(ctx: SettingsContext, v: SettingsView): string {
  return page("Settings", settingsBody(ctx, v), ctx.who, "settings");
}
