import type { PolicyParam } from "../capabilities/types.ts";
import { TRIGGERS } from "../policy/policy.ts";
import { dot, href, html, page, raw, secs, short, when, type Raw } from "./html.ts";
import type { Flash } from "./home.ts";
import type { PolicyForm } from "./policy-form.ts";
import { computerSection, schedulesSection, secretsSection, type ComputerView, type SchedulesView, type SecretsView } from "./chat-extras.ts";

/**
 * A chat's settings (DESIGN.md "A chat's settings"): what the control bot's `/model` and `/profile` cards, the
 * chat's `/new` and `/stop`, its entry in policy.yaml, its schedules, secrets and computer decide. Three categories,
 * each a page of its own with its own URL, reached by real tabs at the top of the detail pane:
 *
 *   Chat                   `/chats/<id>/settings` (where every way in lands): Model, Profile, Conversation.
 *   Permissions            `/chats/<id>/settings/permissions`: the chat's entry in policy.yaml.
 *   Automation & machine   `/chats/<id>/settings/automation`: Schedules, Secrets, Computer (chat-extras.ts).
 *
 * Drawn from a view (chat-settings-data.ts loads it); every button is a POST form through the console's write
 * boundary (server.ts), answered with a 303 back to the category it came from and its result shown once
 * (chat-settings-write.ts). Adjacent pieces of inline text are separated by real whitespace in the markup, so a
 * page still reads without its stylesheet.
 *
 *   Model         the catalog as a radio list, by provider. A row is a link (`?to=<model>#model`, a read): the
 *                 page comes back with Lossless / Lossy / Clean start under it, each with what it would do in this chat now
 *                 (the control bot's switch card's lines), and the running turn it would stop.
 *   Profile       Base and every profile; a row is a button that switches.
 *   Conversation  when it began, its segments and context; Stop the turn (only while one runs); New
 *                 conversation, which asks first (`?confirm=new#conversation`); Start clean, as New
 *                 conversation but opening with no messages (agent/switch.ts `startClean`), which asks first too
 *                 (`?confirm=clean`).
 *   Keep warm     the pin (store/warm.ts `setWarmPinned`): with warm runners on, the chat keeps a warm runner all the
 *                 time (server/warm.ts `PinKeeper`). Shows its runner now, and says when pinning does nothing (the
 *                 switch off, a model not on a Claude login).
 *   Permissions   the chat's entry as a form; "Review changes" comes back with the diff to policy.yaml, then
 *                 "Save" writes it; a form the parser refuses comes back as it was typed, with its reason.
 *   Schedules, Secrets, Computer   chat-extras.ts.
 */

export interface ModelRow {
  id: string;
  label?: string;
  contextWindow?: number | null;
  isDefault: boolean;
  /** Its last probe got no tool call. */
  warned: boolean;
}

export interface ModelGroup {
  provider: string;
  kind: string;
  models: ModelRow[];
}

/** The mode step for the model picked (`?to=`), as the control bot's card words it. */
export interface Picked {
  id: string;
  lossless?: string;
  lossy?: string;
  clean?: string;
  /** "turn 24 is running and will be stopped". */
  running?: string | null;
  /** Switching to it would do nothing ("already on …"), or it could not be previewed (why). */
  noop?: string;
  error?: string;
}

/** A switch asked for from this page and not finished yet. */
export interface Switching {
  to: string;
  mode: string;
  requestId: number;
  /** The turn it is stopping, once it stopped one. */
  stopping?: number | null;
}

export interface ProfileRow {
  name: string;
  label?: string;
  own: number;
}

export interface RunningTurn {
  id: number;
  startedAt: string;
}

export interface CapabilityRow {
  id: string;
  label: string;
  gives: string;
  always: boolean;
  /** Set up in this process (its environment turns it on). */
  here: boolean;
  params?: Readonly<Record<string, PolicyParam>>;
  delegable?: readonly string[];
}

export interface PermissionsView {
  /** `dm`, or the group's Telegram id. */
  key: string;
  ownerDm: boolean;
  /** The chat has an entry of its own (the DM without one runs on its defaults; a group without one is ignored). */
  listed: boolean;
  form: PolicyForm;
  caps: CapabilityRow[];
  /** Names the entry gives that this build has no capability for: kept as they are. */
  unknown: string[];
  /** The diff step: the change as it would be written, and the hash of the file it was made against. */
  review?: { diff: Raw; add: number; del: number; base: string; rewritten: boolean; created: boolean };
  /** A refused form: the parser's reason, and the field it is about. */
  refusal?: { text: string; field?: string };
  flash?: Flash;
  /** The file is broken as it is: nothing can be saved from here until it is fixed (Home). */
  broken?: string;
}

export type SettingsCategory = "chat" | "permissions" | "automation";

export const CATEGORIES: readonly { id: SettingsCategory; label: string; path: string }[] = [
  { id: "chat", label: "Chat", path: "" },
  { id: "permissions", label: "Permissions", path: "/permissions" },
  { id: "automation", label: "Automation & machine", path: "/automation" },
];

/** A category's page. */
export const categoryHref = (chatId: number, c: SettingsCategory) => `/chats/${chatId}/settings${CATEGORIES.find((x) => x.id === c)!.path}`;

export interface ChatSettingsView {
  chat: { id: number; name: string; kind: "private" | "group"; tgChatId: number };
  category: SettingsCategory;
  timeZone: string;
  now: number;
  csrf: string;
  model: { current: string | null; defaultId: string | null; groups: ModelGroup[]; picked?: Picked; switching?: Switching; flash?: Flash };
  /** Drawn once per page load: a switch posted twice from it (a double submit) is asked for once (model-cards.ts `consoleSwitch`). */
  pageKey: string;
  profile: { current: string | null; gone: boolean; rows: ProfileRow[]; flash?: Flash };
  /** `clean`: the conversation is a clean one (`chats.clean_since`): she has no search_chats / read_chat in it. */
  conversation: { began: string | null; how?: string; segments: number; contextTokens: number | null; clean?: boolean; running?: RunningTurn; confirmNew: boolean; confirmClean?: boolean; flash?: Flash };
  /**
   * Keep warm (`chats.warm_pinned`): the pin; whether warm runners are on in the server (`on`); whether the chat's model
   * is on a Claude login, the only kind that can be warm (`claude`); its warm runner now, as its row says (`runner`;
   * `alive` by its pid and start time), or a turn handed to one running (`inTurn`).
   */
  warm: { pinned: boolean; on: boolean; claude: boolean; runner?: { pid: number; alive: boolean; idleSince: string; cliStartedAt: string | null }; inTurn?: boolean; flash?: Flash };
  permissions: PermissionsView;
  /** Loaded for the Automation & machine page only. */
  schedules?: SchedulesView;
  secrets?: SecretsView;
  computer?: ComputerView;
  who?: string;
}

const base = (v: ChatSettingsView) => `/chats/${v.chat.id}/settings`;
const csrfField = (v: ChatSettingsView) => html`<input type="hidden" name="csrf" value="${v.csrf}">`;
const flashLine = (f: Flash | undefined) => (f ? html`<p class="notice ${f.tone}" role="status">${f.text}</p>` : "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ctxSize = (n: number | null | undefined) => (n ? `${short(n)}` : "");

// ---- model -------------------------------------------------------------------------------------------------

function modelRow(v: ChatSettingsView, m: ModelRow): Raw {
  const cur = m.id === v.model.current;
  const picked = v.model.picked?.id === m.id;
  const cls = `mrow${cur ? " cur" : ""}${picked ? " picked" : ""}${m.warned ? " warn" : ""}`;
  const inner = html`<span class="radio-dot" aria-hidden="true"></span> <span class="mid">${m.id}</span> ${m.label ? html`<span class="mlabel">${m.label}</span> ` : ""}${cur ? html`<span class="nowtag">current</span> ` : ""}${
    m.warned ? html`<span class="mwarn" title="its last probe got no tool call">⚠</span> ` : ""
  }${m.isDefault ? html`<span class="mstar" title="the default">★</span> ` : ""}<span class="mctx">${ctxSize(m.contextWindow)}</span>`;
  // A row is a read: it shows the mode step under it. The one being switched to is not a link meanwhile.
  if (v.model.switching) return html`<span class="${cls}" aria-disabled="true">${inner}</span>`;
  return html`<a class="${cls}" href="${href(base(v), picked ? {} : { to: m.id })}#model" role="radio" aria-checked="${cur ? "true" : "false"}">${inner}</a>`;
}

function switchBox(v: ChatSettingsView, p: Picked): Raw {
  const cancel = html`<a class="btn ghost" href="${base(v)}#model">Cancel</a>`;
  if (p.error || p.noop) return html`<div class="switchbox"><div class="swfoot"><span class="${p.error ? "c-failed" : "faint"}">${p.error ?? p.noop}</span> ${cancel}</div></div>`;
  const mode = (m: "lossless" | "lossy" | "clean", name: string, line: string) => html`<form method="post" action="${base(v)}/switch" class="modef">${csrfField(v)}<input type="hidden" name="to" value="${p.id}"><input type="hidden" name="mode" value="${m}"><input type="hidden" name="key" value="${v.pageKey}">
<button type="submit" class="mode"><span class="mname">${name}</span> <span class="mline">${line}</span></button></form>`;
  return html`<div class="switchbox" id="switchbox"><div class="swhead">Switch from <span class="mono">${v.model.current ?? "none"}</span> to <span class="mono">${p.id}</span>. How?</div>
<div class="modes compact">${mode("lossless", "Lossless", p.lossless ?? "")} ${mode("lossy", "Lossy", p.lossy ?? "")} ${mode("clean", "Clean start", p.clean ?? "")}</div>
<div class="swfoot"><span class="faint">Whichever way, her files and notes stay.${p.running ? ` ${p.running[0]!.toUpperCase()}${p.running.slice(1)}.` : ""}</span> ${cancel}</div></div>`;
}

/**
 * The switch asked for and not done yet: fetches itself every second (`/chats/<id>/settings/switching`, a read) until
 * it is; then the page is loaded again with the result (server.ts). Without script, the reload link.
 */
export function switchingLine(v: Pick<ChatSettingsView, "chat">, s: Switching): Raw {
  return html`<p class="notice pending swing" role="status" hx-get="/chats/${v.chat.id}/settings/switching?req=${s.requestId}" hx-trigger="every 1s" hx-target="this" hx-swap="outerHTML" hx-indicator="unset" data-poll><span class="spin" aria-hidden="true"></span>Switching to <span class="mono">${s.to}</span> (${s.mode})${
    s.stopping ? `: stopping turn ${s.stopping} first` : ""
  }… <a href="/chats/${v.chat.id}/settings?req=${s.requestId}#model">reload</a></p>`;
}

function modelSection(v: ChatSettingsView): Raw {
  const m = v.model;
  const rows = m.groups.map(
    (g) =>
      html`<div class="mgroup"><div class="mgh">${g.provider}<span class="faint"> · ${g.kind}</span></div>${g.models.map((r) => html`${modelRow(v, r)}${m.picked?.id === r.id && !m.switching ? switchBox(v, m.picked) : ""}`)}</div>`,
  );
  const warned = m.groups.some((g) => g.models.some((r) => r.warned));
  return html`<section class="cs" id="model"><div class="cshd"><h2>Model</h2> <span class="faint">what her turns here run on</span> <a class="right" href="/settings">The catalog →</a></div>
${m.switching ? switchingLine(v, m.switching) : flashLine(m.flash)}
${m.groups.length ? html`<div class="mlist${m.picked && !m.switching ? " switching" : ""}" role="radiogroup" aria-label="Model">${rows}</div>` : html`<p class="hint">The catalog is empty: add a provider in <a href="/settings">Settings</a>.</p>`}
<div class="pfoot"><span>★ the default, for chats with no model of their own</span>${warned ? html` <span>⚠ its last probe got no tool call</span>` : ""}</div></section>`;
}

// ---- profile -----------------------------------------------------------------------------------------------

function profileSection(v: ChatSettingsView): Raw {
  const p = v.profile;
  const row = (name: string, label: string | undefined, hint: string) => {
    const cur = (p.gone ? null : p.current) === (name || null);
    return html`<button type="submit" name="profile" value="${name}" class="prow${cur ? " cur" : ""}" role="radio" aria-checked="${cur ? "true" : "false"}"><span class="radio-dot" aria-hidden="true"></span> <span class="pname">${name || "Base"}</span> ${
      label ? html`<span class="plabel">${label}</span> ` : ""
    }<span class="phint">${hint}</span></button>`;
  };
  return html`<section class="cs" id="profile"><div class="cshd"><h2>Profile</h2> <span class="faint">which copy of her files this chat reads and writes, from its next turn</span> <a class="right" href="/home">Profiles in Home →</a></div>
${flashLine(p.flash)}${p.gone ? html`<p class="notice refused">This chat is on <b>${p.current}</b>, which no longer exists: it runs on Base.</p>` : ""}
<form method="post" action="${base(v)}/profile" class="plist" role="radiogroup" aria-label="Profile">${csrfField(v)}
${row("", undefined, "her own files, no overlay")}${p.rows.map((r) => row(r.name, r.label, r.own ? `${plural(r.own, "file")} of its own` : "no files of its own yet"))}</form></section>`;
}

// ---- keep warm ---------------------------------------------------------------------------------------------

function warmSection(v: ChatSettingsView): Raw {
  const w = v.warm;
  const now = w.runner
    ? w.runner.alive
      ? html`<p class="xline">${dot("running")}A warm runner waits for this chat now: process <span class="mono">${w.runner.pid}</span>, idle since <b>${when(w.runner.idleSince, v.timeZone)}</b>${
          w.runner.cliStartedAt ? html`, its Claude CLI started <b>${when(w.runner.cliStartedAt, v.timeZone)}</b>` : ""
        }.</p>`
      : html`<p class="xline">Its warm runner (process <span class="mono">${w.runner.pid}</span>) is gone; the next turn starts cold${w.pinned && w.on ? ", unless the server warms it first" : ""}.</p>`
    : w.inTurn
      ? html`<p class="xline">${dot("running")}Its warm runner is running a turn now.</p>`
      : html`<p class="xline">No warm runner for this chat now: its next turn starts cold${w.pinned && w.on && w.claude ? ", unless the server warms it first (within seconds)" : ""}.</p>`;
  const notes = [
    !w.on ? html`<p class="notice refused">Warm runners are off on this server (<span class="mono">SHUVI_WARM_RUNNERS</span>): pinning is saved, but has no effect until they are on.</p>` : "",
    !w.claude ? html`<p class="notice refused">This chat's model is not on a Claude login: only a Claude model can be kept warm, so pinning has no effect while it is on this one.</p>` : "",
  ];
  const button = w.pinned
    ? html`<form method="post" action="${base(v)}/warm">${csrfField(v)}<input type="hidden" name="pin" value="off"><button type="submit" class="btn">Stop keeping warm</button></form>`
    : html`<form method="post" action="${base(v)}/warm">${csrfField(v)}<input type="hidden" name="pin" value="on"><button type="submit" class="btn">Keep warm</button></form>`;
  return html`<section class="cs" id="warm"><div class="cshd"><h2>Keep warm</h2> <span class="faint">a runner and its Claude CLI kept ready for this chat, so a message is answered without starting them</span></div>
${flashLine(w.flash)}${notes}<div class="crow"><div class="stext"><b>${w.pinned ? "Kept warm" : "Not pinned"}</b> <span>${
    w.pinned
      ? "Its runner never idles out and does not count toward the warm limit; the server starts one whenever it has none. It costs memory only (about 300 MB), no model calls."
      : "Its runner stays warm for a while after a turn, as for every chat, within the warm limit."
  }</span></div>${button}</div>${now}</section>`;
}

// ---- conversation ------------------------------------------------------------------------------------------

function conversationSection(v: ChatSettingsView): Raw {
  const c = v.conversation;
  const facts = c.began
    ? html`<p class="xline">The current conversation began <b>${when(c.began, v.timeZone)}</b>${c.how ? ` (${c.how})` : ""} · ${plural(c.segments, "segment")}${
        c.contextTokens ? html` · <b>${short(c.contextTokens)}</b> tokens of context` : ""
      }${c.clean ? html` · <b>clean</b>: she cannot look back through the chat's history in it` : ""}</p>`
    : c.clean
      ? html`<p class="xline">Started clean: her next turn here opens a <b>clean</b> conversation, with its new messages only and no looking back through the chat's history.</p>`
      : html`<p class="xline">No conversation yet: her next turn here starts one.</p>`;
  const stop = c.running
    ? html`<div class="crow running"><div class="stext"><b>${dot("running")}Turn ${c.running.id} is running <span class="faint num">${secs(Math.max(0, v.now - Date.parse(c.running.startedAt)))}</span></b> <span>As <span class="mono">/stop</span> does: she stops now; what she already sent stays.</span></div>
<form method="post" action="${base(v)}/stop">${csrfField(v)}<input type="hidden" name="turn" value="${c.running.id}"><button type="submit" class="btn">Stop the turn</button></form></div>`
    : "";
  const fresh = c.confirmNew
    ? html`<div class="confirm" role="alertdialog" aria-label="New conversation"><p><b>Start a new conversation?</b> Every conversation of this chat is forgotten, on every model; her next turn starts fresh with the chat's last 10 messages.${
        c.running ? ` Turn ${c.running.id} is running and will be stopped.` : ""
      } Her files and notes stay.</p>
<form method="post" action="${base(v)}/new">${csrfField(v)}<button type="submit" class="btn danger solid">New conversation</button> <a class="btn ghost" href="${base(v)}#conversation">Cancel</a></form></div>`
    : html`<div class="crow"><div class="stext"><b>New conversation</b> <span>As <span class="mono">/new</span> does: her next turn starts fresh, opened with the chat's last 10 messages. Her files and notes stay.</span></div><a class="btn" href="${href(base(v), { confirm: "new" })}#conversation">New conversation</a></div>`;
  // As New conversation, but her next turn opens with no messages at all: a clean start of the model it runs on.
  const clean = c.confirmClean
    ? html`<div class="confirm" role="alertdialog" aria-label="Start clean"><p><b>Start clean?</b> Every conversation of this chat is forgotten, on every model; her next turn starts fresh with its new messages only, not the chat's last 10.${
        c.running ? ` Turn ${c.running.id} is running and will be stopped.` : ""
      } Her files and notes stay, but for as long as this conversation lasts she cannot look back through the chat's history (no search_chats, no read_chat). As <span class="mono">/newclean</span> does.</p>
<form method="post" action="${base(v)}/clean">${csrfField(v)}<button type="submit" class="btn danger solid">Start clean</button> <a class="btn ghost" href="${base(v)}#conversation">Cancel</a></form></div>`
    : html`<div class="crow"><div class="stext"><b>Start clean</b> <span>As <span class="mono">/newclean</span> does: a new conversation, but her next turn opens with no earlier messages at all, only the new ones, and she cannot look back through the chat's history while it lasts. Her files and notes stay.</span></div><a class="btn" href="${href(base(v), { confirm: "clean" })}#conversation">Start clean</a></div>`;
  return html`<section class="cs" id="conversation"><div class="cshd"><h2>Conversation</h2> <a class="right" href="/chats/${v.chat.id}">The chat's log →</a></div>${flashLine(c.flash)}${facts}${stop}${fresh}${clean}</section>`;
}

// ---- permissions -------------------------------------------------------------------------------------------

/** What the page says of a policy.yaml that does not parse: what is wrong, and where it can be fixed (not here, not Home). */
export const brokenText = (why: string) =>
  `policy.yaml is broken as it is: ${why}. Nothing can be saved here until it is fixed: edit home/policy.yaml on the machine shuvi runs on, or ask her to propose a change. The last good policy stays in effect meanwhile.`;

const checked = (on: boolean) => (on ? raw(" checked") : "");
const disabledIf = (on: boolean) => (on ? raw(" disabled") : "");

function permissionsSection(v: ChatSettingsView): Raw {
  const p = v.permissions;
  const f = p.form;
  const group = !p.ownerDm;
  const bad = (field: string) => (p.refusal?.field && (p.refusal.field === field || p.refusal.field.startsWith(`${field}.`)) ? " bad" : "");
  const listedAs = p.key === "dm" ? 'listed as "dm"' : html`listed as <span class="mono">"${p.key}"</span>`;

  const triggerRow = html`<div class="prow2${bad("trigger")}${bad("followup_minutes")}"><div class="plab">Wakes her</div><div class="pctl">
<label class="opt"><input type="radio" name="trigger_mode" value="all"${checked(f.triggerMode === "all")}> Every message</label>
<label class="opt"><input type="radio" name="trigger_mode" value="some"${checked(f.triggerMode === "some")}> Only:</label>
<div class="sub">${TRIGGERS.map((t) =>
    t === "followup"
      ? html`<label class="opt"><input type="checkbox" name="trigger" value="followup"${checked(f.triggers.includes("followup"))}> a follow-up from someone she just answered, within <input class="num-in" type="text" inputmode="decimal" name="followup_minutes" value="${f.followupMinutes}" aria-label="follow-up minutes"> min</label>`
      : html`<label class="opt"><input type="checkbox" name="trigger" value="${t}"${checked(f.triggers.includes(t))}> ${t === "mention" ? "a message that mentions her" : "a reply to one of her messages"}</label>`,
  )}</div></div></div>`;

  const layer = (name: "persona" | "memory", value: "public" | "private" | "chat", label: string) => {
    const priv = value === "private";
    const on = (name === "persona" ? f.persona : f.memory).includes(value);
    // A private layer is the owner's DM's only (policy.ts refuses it elsewhere): offered there and nowhere else.
    if (priv && group) return html`<label class="opt off" title="private layers are for your DM only"><input type="checkbox" disabled> ${label} <span class="faint">your DM only</span></label>`;
    return html`<label class="opt"><input type="checkbox" name="${name}" value="${value}"${checked(on)}> ${label}</label>`;
  };
  const seesRow = html`<div class="prow2${bad("persona")}${bad("memory")}"><div class="plab">Sees</div><div class="pctl"><div class="pair"><span class="faint pk">persona</span> ${layer("persona", "public", "public persona")} ${layer("persona", "private", "private side")}</div>
<div class="pair"><span class="faint pk">memory</span> ${layer("memory", "chat", "this chat's notes")} ${layer("memory", "private", "private memory")}</div></div></div>`;

  const capRow = (c: CapabilityRow) => {
    const on = f.toolsMode === "all" || f.tools.includes(c.id);
    const params = Object.entries(c.params ?? {});
    return html`<div class="cap${bad(`tools.${c.id}`)}"><label class="cmain"><input class="sw" type="checkbox" name="tool" value="${c.id}"${checked(on)}${disabledIf(f.toolsMode === "all")} role="switch"> <span class="cname">${c.label}</span> <span class="cgives">${c.gives}</span>${
      c.here ? "" : html` <span class="ctag" title="its environment does not turn it on in this process">not set up here</span>`
    }</label>${
      params.length
        ? html`<div class="cparams">${params.map(
            ([k, d]) =>
              html`<label class="cparam"><span class="mono">${k}</span> <input type="text" name="param.${c.id}.${k}" value="${f.params[`${c.id}.${k}`] ?? ""}" placeholder="${d.default}"${disabledIf(f.toolsMode === "all")}> <span class="faint">${d.meaning}${d.type === "string[]" ? "; comma-separated" : ""}</span></label>`,
          )}</div>`
        : ""
    }</div>`;
  };
  const toolsRow = html`<div class="prow2 tools${bad("tools")}"><div class="plab">Can use</div><div class="pctl">
<label class="opt"><input type="radio" name="tools_mode" value="all"${checked(f.toolsMode === "all")}> Everything, including what is added later</label>
<label class="opt"><input type="radio" name="tools_mode" value="some"${checked(f.toolsMode === "some")}> Only what is on below</label>
<div class="caps">${p.caps.filter((c) => !c.always).map(capRow)}</div>
<p class="hint">Always on, in every chat: ${p.caps
    .filter((c) => c.always)
    .map((c) => c.label)
    .join(" · ")}</p>${p.unknown.length ? html`<p class="hint">Also listed, unknown to this build and kept as it is: <span class="mono">${p.unknown.join(", ")}</span></p>` : ""}</div></div>`;

  const delegable = p.caps.filter((c) => c.delegable?.length);
  const opsRow = group
    ? html`<div class="prow2${bad("operators")}${bad("delegate")}"><div class="plab">Operators</div><div class="pctl">
<label class="opt"><input type="radio" name="operators_mode" value="none"${checked(f.operatorsMode === "none")}> Nobody: only you may ask for what is yours alone</label>
<label class="opt"><input type="radio" name="operators_mode" value="members"${checked(f.operatorsMode === "members")}> Everyone in the group</label>
<label class="opt"><input type="radio" name="operators_mode" value="ids"${checked(f.operatorsMode === "ids")}> These people: <input class="ids-in" type="text" name="operator_ids" value="${f.operatorIds}" placeholder="Telegram user ids, comma-separated" aria-label="operator ids"></label>
<div class="sub"><div class="faint">who may also ask for:</div>${delegable.map(
        (c) => html`<label class="opt"><input type="checkbox" name="delegate" value="${c.id}"${checked(f.delegate.includes(c.id))}> ${c.label} <span class="faint mono">${c.delegable!.join(", ")}</span></label>`,
      )}</div></div></div>`
    : "";

  const titleRow = group ? html`<div class="prow2${bad("title")}"><div class="plab">Title</div><div class="pctl"><input class="title-in" type="text" name="title" value="${f.title}" placeholder="for people reading the file"></div></div>` : "";
  const hidden = html`${csrfField(v)}${p.review ? html`<input type="hidden" name="base" value="${p.review.base}">` : ""}`;

  const intro = !p.listed
    ? p.ownerDm
      ? html`<p class="hint">Your DM has no entry: it runs on its defaults (everything). Saving gives it one.</p>`
      : html`<p class="notice refused">This group is not in policy.yaml, so it is ignored: nothing said there is kept and she is never woken. Saving adds it with what is below.</p>`
    : "";

  const review = p.review
    ? html`<div class="review" id="review"><div class="rvhead"><b>Review: home/policy.yaml</b> ${p.review.created ? html`<span class="faint">does not exist yet; it would be created</span> ` : ""}<span class="faint">one commit, as you, from the console</span></div>
${p.review.rewritten ? html`<p class="notice refused">This file's layout cannot be edited in place, so it would be written whole: its comments would not be kept.</p>` : ""}
${p.review.diff}
<div class="rvfoot"><button type="submit" name="action" value="save" class="btn primary">Save to policy.yaml</button> <button type="submit" name="action" value="edit" class="btn ghost">Back to editing</button> <span class="faint">It applies from her next turn here once the server reloads the file (within seconds).</span></div></div>`
    : "";

  const foot = p.review
    ? ""
    : html`<div class="pfoot2"><button type="submit" name="action" value="review" class="btn primary"${disabledIf(!!p.broken)}>Review changes</button> <a class="btn ghost" href="${categoryHref(v.chat.id, "permissions")}#permissions">Reset</a> <span class="faint">Nothing is written until you have seen the diff.</span></div>`;

  return html`<section class="cs" id="permissions"><div class="cshd"><h2>Permissions</h2> <span class="faint">policy.yaml, ${listedAs}</span></div>
${flashLine(p.flash)}${p.broken ? html`<p class="notice failed">${brokenText(p.broken)}</p>` : ""}
${p.refusal ? html`<p class="notice refused" role="alert"><b>Not saved.</b> ${p.refusal.text}</p>` : ""}${intro}
<form method="post" action="${base(v)}/policy" class="pform${p.review ? " reviewing" : ""}">${hidden}
<fieldset${disabledIf(!!p.review)}>${titleRow}${triggerRow}${seesRow}${toolsRow}${opsRow}</fieldset>
${p.review ? html`<div class="carry">${carryFields(p)}</div>` : ""}${foot}${review}</form></section>`;
}

/** While reviewing, the form is shown disabled, so what it says is carried in hidden fields for Save. */
function carryFields(p: PermissionsView): Raw {
  const f = p.form;
  const h = (name: string, value: string) => html`<input type="hidden" name="${name}" value="${value}">`;
  return html`${h("title", f.title)}${h("trigger_mode", f.triggerMode)}${f.triggers.map((t) => h("trigger", t))}${h("followup_minutes", f.followupMinutes)}${f.persona.map((x) => h("persona", x))}${f.memory.map((x) => h("memory", x))}${h(
    "tools_mode",
    f.toolsMode,
  )}${f.tools.map((x) => h("tool", x))}${Object.entries(f.params).map(([k, x]) => h(`param.${k}`, x))}${h("operators_mode", f.operatorsMode)}${h("operator_ids", f.operatorIds)}${f.delegate.map((x) => h("delegate", x))}`;
}

// ---- the page ----------------------------------------------------------------------------------------------

export function chatSettingsDetail(v: ChatSettingsView): Raw {
  const c = v.chat;
  const conv = v.conversation.began ? `conversation since ${when(v.conversation.began, v.timeZone).replace(/, \d\d:\d\d$/, "")}` : "no conversation yet";
  return html`<div class="detail cset">
<a class="back" href="/chats/${c.id}">← ${c.name}</a>
<div class="head"><div class="title"><h1>${c.name}</h1> <span class="meta">settings · ${c.kind === "group" ? "group" : "direct chat"}</span></div>
<p class="facts">on <span class="mono">${v.model.current ?? "no model"}</span> <span class="sep"></span> profile <b>${v.profile.gone || !v.profile.current ? "Base" : v.profile.current}</b> <span class="sep"></span> ${conv} <span class="sep"></span> <a href="/chats/${c.id}">the chat's log</a></p></div>
<nav class="tabs ctabs" aria-label="Settings">${CATEGORIES.map((t) =>
    t.id === v.category ? html`<a class="on" href="${categoryHref(c.id, t.id)}" aria-current="page">${t.label}</a> ` : html`<a href="${categoryHref(c.id, t.id)}">${t.label}</a> `,
  )}</nav>
${body(v)}
</div>`;
}

/** The sections of the category shown. */
function body(v: ChatSettingsView): Raw {
  if (v.category === "permissions") return permissionsSection(v);
  if (v.category === "automation") {
    const c = { chatId: v.chat.id, csrf: v.csrf, timeZone: v.timeZone, now: v.now };
    return html`${v.schedules ? schedulesSection(c, v.schedules) : ""}${v.secrets ? secretsSection(c, v.secrets) : ""}${v.computer ? computerSection(c, v.computer) : ""}`;
  }
  return html`${modelSection(v)}${profileSection(v)}${conversationSection(v)}${warmSection(v)}`;
}

/** The whole page: the chats list on the left (`pane`), the settings on the right. */
export function chatSettingsPage(v: ChatSettingsView, pane: Raw): string {
  const label = CATEGORIES.find((x) => x.id === v.category)!.label;
  return page(`${v.chat.name}: ${label === "Chat" ? "settings" : label}`, html`<div class="split selected"><aside class="list-pane">${pane}</aside><main class="detail-pane">${chatSettingsDetail(v)}</main></div>`, v.who, "turns");
}
