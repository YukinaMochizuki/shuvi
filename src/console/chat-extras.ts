import { dot, href, html, type Raw } from "./html.ts";
import type { Flash } from "./home.ts";
import { anchor } from "./settings.ts";

/**
 * The last three sections of a chat's settings page (chat-settings.ts draws the page; DESIGN.md "A chat's
 * settings"): what she has set up to happen here later, what she holds, and the machine she runs on. Drawn from a
 * view (chat-extras-data.ts loads it); the writes are POST forms through the console's write boundary, as the rest of
 * the page's (chat-settings-write.ts).
 *
 *   Schedules  each active or paused schedule, soonest first: what it is in words, its next run, its note, who
 *              authorised it; Pause / Resume, and Cancel, which asks first (`?confirm=schedule:<id>#schedules`).
 *   Secrets    the chat's live grants: the profile, its variable NAMES (never a value), time left, who asked;
 *              "Revoke now", the control bot's revoke card's own button. Nothing else here writes.
 *   Computer   read only: its state, when it stops when idle, its disk (fetched from Hangar by itself, after the
 *              page: `/chats/<id>/settings/disk`), its running background jobs, the last apply of ~/.computer.yaml.
 */

export interface ScheduleRow {
  id: number;
  note: string;
  /** A one-off (`at`) or recurring (`cron`). */
  cron: string | null;
  /** The cron in plain words, or null when it cannot be said simply (the raw expression is shown). */
  words: string | null;
  /** Its next run (active), or, paused, when it was due (a one-off) or would next run if resumed now (a cron). */
  nextAt: string | null;
  paused: boolean;
  /** A paused one-off whose time has passed: resuming it cancels it. */
  passed: boolean;
  /** "you", "an operator, Ann", or null when the row does not say. */
  by: string | null;
  lastFiredAt: string | null;
}

export interface SchedulesView {
  /** Why the section has nothing to manage (the capability is off in this process). */
  off?: string;
  rows: ScheduleRow[];
  /** The schedule whose Cancel is being confirmed. */
  confirm?: number;
  flash?: Flash;
}

export interface GrantRow {
  id: number;
  profile: string;
  /** Its variable names, from the secret profiles; null when the secrets file cannot be used. */
  vars: string[] | null;
  /** The profile is no longer there. */
  gone: boolean;
  /** null: until revoked. */
  expiresAt: string | null;
  grantedAt: string | null;
  /** "you", or "an operator, Ann". */
  askedBy: string;
  /** An owner grant: every chat's, for the owner's requests (revoked on the Secrets page). */
  everyChat: boolean;
}

export interface SecretsView {
  off?: string;
  rows: GrantRow[];
  /** The secrets file's path, and why it cannot be used. */
  file: string;
  fileError?: string;
  flash?: Flash;
}

export interface ComputerJob {
  id: number;
  command: string;
  startedAt: string;
  boosted: boolean;
}

export interface ApplyResult {
  at: string;
  ok: boolean;
  /** "applied in 42s: apt: ripgrep" or, failed, the step and its reason. */
  step?: string;
  why?: string;
  /** Its output's tail, redacted at the source. */
  output?: string;
}

export interface ComputerView {
  off?: string;
  state: "none" | "running" | "stopped" | "boosted";
  /** Its normal size, e.g. "2 vCPU / 2Gi". */
  size: string;
  boost?: { size: string; jobId: number | null; since: string };
  /** A run-state change in progress (`stop`, `boost`, `restore`). */
  op?: string;
  /** When it stops if nothing else runs; null: it does not stop (a job, a command running). */
  idleStopAt?: string | null;
  /** What keeps it up. */
  busy?: string;
  lastExecAt: string | null;
  jobs: ComputerJob[];
  apply?: ApplyResult;
  /** The disk as Hangar last said (null: not asked yet; the page asks after it loads). */
  disk?: DiskFacts | null;
}

export type DiskFacts = { size: string; max: string | null } | { error: string };

interface Ctx {
  chatId: number;
  csrf: string;
  timeZone: string;
  now: number;
}

/** Where a write is posted. */
const base = (c: Ctx) => `/chats/${c.chatId}/settings`;
/** This category's page (chat-settings.ts `categoryHref`). */
const here = (c: Ctx) => `/chats/${c.chatId}/settings/automation`;
const csrfField = (c: Ctx) => html`<input type="hidden" name="csrf" value="${c.csrf}">`;
const flashLine = (f: Flash | undefined) => (f ? html`<p class="notice ${f.tone}" role="status">${f.text}</p>` : "");

/** A time in the owner's zone with its weekday: `Mon 17 Nov, 09:00` (the year when it is not this one's). */
export function whenDay(iso: string, timeZone: string, now: number): string {
  const d = new Date(iso);
  const year = (t: Date) => t.toLocaleString("en-GB", { timeZone, year: "numeric" });
  return d.toLocaleString("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, ...(year(d) !== year(new Date(now)) ? { year: "numeric" } : {}) });
}

/** A span of time in words: `45 s`, `12 min`, `3 h 12 min`, `2 days 4 h`. */
export function span(ms: number): string {
  const m = Math.round(Math.abs(ms) / 60_000);
  if (Math.abs(ms) < 60_000) return `${Math.round(Math.abs(ms) / 1000)} s`;
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} days ${h % 24} h` : `${d} days`;
}

const relative = (iso: string, now: number) => {
  const ms = Date.parse(iso) - now;
  return ms >= 0 ? `in ${span(ms)}` : `${span(ms)} ago`;
};

// ---- schedules ---------------------------------------------------------------------------------------------

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_ABBR = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const NICKNAMES: Record<string, string> = {
  "@yearly": "every 1 January at 00:00",
  "@annually": "every 1 January at 00:00",
  "@monthly": "on the 1st of every month at 00:00",
  "@weekly": "every Sunday at 00:00",
  "@daily": "every day at 00:00",
  "@midnight": "every day at 00:00",
  "@hourly": "every hour, on the hour",
};

const pad = (n: number) => String(n).padStart(2, "0");
const andList = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** A cron field of plain numbers (`5`, `1,15`, `1-5`) within [lo, hi], expanded; null for anything else (steps, `*`). */
function numbers(field: string, lo: number, hi: number, names: readonly string[] = []): number[] | null {
  const one = (s: string) => {
    const i = names.indexOf(s);
    if (i >= 0) return i;
    return /^\d+$/.test(s) && Number(s) >= lo && Number(s) <= hi ? Number(s) : null;
  };
  const out: number[] = [];
  for (const part of field.split(",")) {
    const r = /^([a-z0-9]+)-([a-z0-9]+)$/.exec(part);
    if (r) {
      const a = one(r[1]!);
      const b = one(r[2]!);
      if (a === null || b === null || a > b) return null;
      for (let i = a; i <= b; i++) out.push(i);
    } else {
      const n = one(part);
      if (n === null) return null;
      out.push(n);
    }
  }
  return [...new Set(out)].sort((x, y) => x - y);
}

/**
 * A cron expression in plain words ("every weekday at 09:00", "every 15 minutes", "on the 1st of every month at
 * 08:30"), or null when it cannot be said simply: the page then shows the expression itself.
 */
export function cronWords(cron: string): string | null {
  const c = cron.trim().toLowerCase();
  if (c.startsWith("@")) return NICKNAMES[c] ?? null;
  const f = c.split(/\s+/);
  if (f.length !== 5) return null;
  const [mi, h, dom, mon, dow] = f as [string, string, string, string, string];
  const step = (s: string) => /^\*\/(\d+)$/.exec(s)?.[1];
  if (dom === "*" && mon === "*" && dow === "*") {
    if (mi === "*" && h === "*") return "every minute";
    const ms = step(mi);
    if (ms && h === "*") return Number(ms) === 1 ? "every minute" : `every ${Number(ms)} minutes`;
    const m1 = numbers(mi, 0, 59);
    if (m1?.length === 1 && h === "*") return m1[0] === 0 ? "every hour, on the hour" : `every hour at :${pad(m1[0]!)}`;
    const hs = step(h);
    if (m1?.length === 1 && hs) return `every ${Number(hs)} hours from 00:${pad(m1[0]!)}`;
  }
  const minutes = numbers(mi, 0, 59);
  const hours = numbers(h, 0, 23);
  if (!minutes || !hours || minutes.length !== 1 || hours.length > 4 || mon !== "*") return null;
  const at = `at ${andList(hours.map((x) => `${pad(x)}:${pad(minutes[0]!)}`))}`;
  if (dom === "*" && dow === "*") return `every day ${at}`;
  if (dom === "*") {
    const days = numbers(dow, 0, 7, DAY_ABBR)?.map((d) => d % 7);
    if (!days) return null;
    const set = [...new Set(days)].sort((x, y) => x - y);
    if (set.join() === "1,2,3,4,5") return `every weekday ${at}`;
    if (set.join() === "0,6") return `every Saturday and Sunday ${at}`;
    if (set.length === 7) return `every day ${at}`;
    // Monday first, as people list a week.
    return `every ${andList([...set.filter((d) => d > 0), ...set.filter((d) => d === 0)].map((d) => DAY_NAMES[d]!))} ${at}`;
  }
  if (dow === "*") {
    const days = numbers(dom, 1, 31);
    if (!days || days.length > 3) return null;
    return `on the ${andList(days.map(ordinal))} of every month ${at}`;
  }
  return null;
}

function scheduleWhen(c: Ctx, s: ScheduleRow): Raw {
  if (s.paused && !s.cron) return s.passed ? html`was due <b>${whenDay(s.nextAt!, c.timeZone, c.now)}</b>, which has passed` : html`due <b>${whenDay(s.nextAt!, c.timeZone, c.now)}</b> if resumed`;
  if (s.paused) return s.nextAt ? html`if resumed now, next <b>${whenDay(s.nextAt, c.timeZone, c.now)}</b>` : html`no run after now`;
  if (!s.cron && s.nextAt) return html`at <b>${whenDay(s.nextAt, c.timeZone, c.now)}</b> <span class="faint">${relative(s.nextAt, c.now)}</span>`;
  return s.nextAt ? html`next <b>${whenDay(s.nextAt, c.timeZone, c.now)}</b> <span class="faint">${relative(s.nextAt, c.now)}</span>` : html`no next run`;
}

function scheduleRow(c: Ctx, v: SchedulesView, s: ScheduleRow): Raw {
  const what = s.cron ? (s.words ?? html`<span class="mono">${s.cron}</span>`) : "once";
  const meta = [
    s.cron ? html`recurring${s.words ? html` · <span class="mono">${s.cron}</span>` : ""}` : html`one-off`,
    s.by ? html`set by ${s.by}` : html`who set it is not recorded`,
    ...(s.lastFiredAt ? [html`last ran ${whenDay(s.lastFiredAt, c.timeZone, c.now)}`] : []),
    html`<span class="mono">#${s.id}</span>`,
  ];
  const form = (verb: string, label: string, cls = "btn") =>
    html`<form method="post" action="${base(c)}/schedule-${verb}">${csrfField(c)}<input type="hidden" name="id" value="${s.id}"><button type="submit" class="${cls}">${label}</button></form>`;
  const confirming = v.confirm === s.id;
  const actions = confirming
    ? ""
    : html`<div class="sacts">${s.paused ? form("resume", "Resume") : form("pause", "Pause")} <a class="btn ghost" href="${href(here(c), { confirm: `schedule:${s.id}` })}#schedule-${s.id}">Cancel</a></div>`;
  const confirm = confirming
    ? html`<div class="confirm" role="alertdialog" aria-label="Cancel schedule ${s.id}"><p><b>Cancel schedule #${s.id}?</b> ${
        s.cron ? "She is not woken by it again." : "She is not woken by it."
      } She can set a new one when asked; nothing she already did is undone.</p>
<form method="post" action="${base(c)}/schedule-cancel">${csrfField(c)}<input type="hidden" name="id" value="${s.id}"><button type="submit" class="btn danger solid">Cancel schedule</button> <a class="btn ghost" href="${here(c)}#schedule-${s.id}">Keep it</a></form></div>`
    : "";
  return html`<div class="srow2${s.paused ? " paused" : ""}${confirming ? " confirming" : ""}" id="schedule-${s.id}"><div class="smain"><div class="swhat"><b>${what}</b> ${s.paused ? html`<span class="ptag">paused</span> ` : ""}<span class="swhen">${scheduleWhen(c, s)}</span></div>
<p class="snote">${s.note}</p>
<div class="smeta">${meta.map((m, i) => html`${i ? html` <span class="sep"></span> ` : ""}<span>${m}</span>`)}</div>${
    s.passed ? html`<p class="row-note refused">Its time passed while it was paused: Resume cancels it rather than run it late.</p>` : ""
  }</div>${actions}</div>${confirm}`;
}

export function schedulesSection(c: Ctx, v: SchedulesView): Raw {
  const body = v.off
    ? html`<p class="hint">${v.off}</p>`
    : v.rows.length
      ? html`<div class="slist">${v.rows.map((s) => scheduleRow(c, v, s))}</div>`
      : html`<p class="xline">No schedules here. She sets one when you ask for a reminder or a recurring check.</p>`;
  return html`<section class="cs" id="schedules"><div class="cshd"><h2>Schedules</h2> <span class="faint">when she wakes here by herself, in ${c.timeZone}</span></div>${flashLine(v.flash)}${body}${
    v.rows.length ? html`<p class="hint">Pausing keeps a schedule without running it; resuming runs it next from now, never what was missed meanwhile.</p>` : ""
  }</section>`;
}

// ---- secrets -----------------------------------------------------------------------------------------------

function grantRow(c: Ctx, g: GrantRow): Raw {
  const vars = g.vars === null ? html`<span class="faint">variables unknown while the file cannot be used</span>` : g.gone ? html`<span class="c-refused">no longer a secret profile</span>` : g.vars.length ? html`<span class="mono">${g.vars.join(", ")}</span>` : html`<span class="faint">no variables</span>`;
  const left = g.expiresAt ? html`<span class="faint num">${span(Date.parse(g.expiresAt) - c.now)} left</span>` : html`<span class="faint">until revoked</span>`;
  const until = g.expiresAt ? `until ${whenDay(g.expiresAt, c.timeZone, c.now)} · ` : "";
  const scope = g.everyChat ? "every chat, your turns only" : `asked for by ${g.askedBy}`;
  const act = g.everyChat
    ? html`<a class="btn" href="/settings/secrets#${anchor("p", g.profile)}">On the Secrets page</a>`
    : html`<form method="post" action="${base(c)}/revoke">${csrfField(c)}<input type="hidden" name="grant" value="${g.id}"><button type="submit" class="btn danger">Revoke now</button></form>`;
  return html`<div class="crow grow2"><div class="stext"><b><span class="mono">${g.profile}</span> ${left}</b> <span>${vars}</span> <span>${until}${scope} · grant #${g.id}</span></div>
${act}</div>`;
}

export function secretsSection(c: Ctx, v: SecretsView): Raw {
  const file = v.fileError
    ? html`<p class="notice failed">The secrets file cannot be used: ${v.fileError}. Commands here get no secret until it is fixed on the machine shuvi runs on; the grants below still stand, and can be revoked.</p>`
    : "";
  const body = v.off
    ? html`<p class="hint">${v.off}</p>`
    : v.rows.length
      ? html`${v.rows.map((g) => grantRow(c, g))}<p class="hint">Only names are shown, never a value. A grant to this chat is made from your answer to her request in the control bot; one to every chat, there or on the <a href="/settings/secrets">Secrets page</a>. A background job already running keeps the values it started with.</p>`
      : html`<p class="xline">No secret is granted here now. She asks with <span class="mono">request_secret</span>; you grant it on its card in the control bot, or to every chat on the <a href="/settings/secrets">Secrets page</a>.</p>`;
  return html`<section class="cs" id="secrets"><div class="cshd"><h2>Secrets</h2> <span class="faint">granted to this chat's computer</span></div>${flashLine(v.flash)}${file}${body}</section>`;
}

// ---- computer ----------------------------------------------------------------------------------------------

const STATE_WORDS: Record<ComputerView["state"], string> = { none: "not created", running: "running", stopped: "stopped", boosted: "boosted" };
const STATE_DOT: Record<ComputerView["state"], string> = { none: "none", running: "running", stopped: "stopped", boosted: "running" };

/** The disk as Hangar says it (the page fetches it after loading: `/chats/<id>/settings/disk`). */
export function diskLine(chatId: number, d: DiskFacts | null | undefined): Raw {
  if (d === null || d === undefined)
    return html`<span class="cdisk" hx-get="/chats/${chatId}/settings/disk" hx-trigger="load" hx-swap="outerHTML" hx-indicator="unset"><span class="faint">asking Hangar…</span></span>`;
  if ("error" in d) return html`<span class="cdisk"><span class="faint">unknown: ${d.error}</span></span>`;
  return html`<span class="cdisk"><b>${d.size}</b> allocated${d.max ? html`, growing by itself as it fills, up to <b>${d.max}</b>` : ""} <span class="faint">(its size, not how much of it is used)</span></span>`;
}

export function computerSection(c: Ctx, v: ComputerView): Raw {
  const head = html`<div class="cshd"><h2>Computer</h2> <span class="faint">this chat's Linux machine, read only</span></div>`;
  if (v.off) return html`<section class="cs" id="computer">${head}<p class="hint">${v.off}</p></section>`;
  if (v.state === "none")
    return html`<section class="cs" id="computer">${head}<p class="xline cstate">${dot("none")}Not created yet: it is made the first time she runs a command here.</p></section>`;
  const stateLine = html`<p class="xline cstate">${dot(STATE_DOT[v.state])}<b>${STATE_WORDS[v.state]}</b> ${
    v.state === "boosted" && v.boost ? html`at ${v.boost.size}${v.boost.jobId ? ` for job #${v.boost.jobId}` : ""}, since ${whenDay(v.boost.since, c.timeZone, c.now)}; back to ${v.size} after` : html`· ${v.size}`
  }${v.op ? html` · <span class="c-running">${v.op === "stop" ? "stopping" : v.op === "boost" ? "boosting" : "resizing back"}…</span>` : ""}</p>`;
  const idle =
    v.state === "stopped"
      ? html`stopped; it starts when she next runs a command${v.lastExecAt ? html` <span class="faint">(last used ${whenDay(v.lastExecAt, c.timeZone, c.now)})</span>` : ""}`
      : v.idleStopAt
        ? html`stops when idle at <b>${whenDay(v.idleStopAt, c.timeZone, c.now)}</b> <span class="faint">${relative(v.idleStopAt, c.now)}, unless she uses it before</span>`
        : html`stays up while ${v.busy ?? "something runs on it"}`;
  const jobs = v.jobs.length
    ? html`<div class="cjobs">${v.jobs.map(
        (j) =>
          html`<div class="cjob"><span class="mono jid">#${j.id}</span> <span class="mono jcmd" title="${j.command}">${j.command}</span> <span class="faint num">${dot("running")}${span(c.now - Date.parse(j.startedAt))}${j.boosted ? " · boosted" : ""}</span></div>`,
      )}</div>`
    : html`<span class="faint">none running</span>`;
  const a = v.apply;
  const apply = !a
    ? html`<span class="faint">not applied since this was recorded</span>`
    : a.ok
      ? html`<span class="c-done">ok</span> <span class="faint">${whenDay(a.at, c.timeZone, c.now)}${a.step ? ` · ${a.step}` : ""}</span>`
      : html`<span><span class="c-failed">failed at its <b>${a.step}</b> step</span> (${a.why}) <span class="faint">${whenDay(a.at, c.timeZone, c.now)}</span></span>${
          a.output ? html`<pre class="cout">${a.output}</pre>` : ""
        }<span class="faint">It is tried again at the computer's next start, when the file changes, or when she runs apply_computer_config.</span>`;
  const row = (label: string, value: Raw) => html`<div class="kv"><div class="k">${label}</div> <div class="v">${value}</div></div>`;
  return html`<section class="cs" id="computer">${head}${stateLine}<div class="kvs">${row("When idle", idle)}${row("Disk", diskLine(c.chatId, v.disk))}${row(
    `Background jobs${v.jobs.length ? ` (${v.jobs.length})` : ""}`,
    jobs,
  )}${row("~/.computer.yaml", html`<div class="capply">${apply}</div>`)}</div></section>`;
}
