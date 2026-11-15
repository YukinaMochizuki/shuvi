import { eq } from "drizzle-orm";
import { computersFor } from "../capabilities/computer/index.ts";
import { DISK_MAX, sizeLabel, type ComputerConfig } from "../capabilities/computer/config.ts";
import { describeError } from "../capabilities/computer/hangar/client.ts";
import { liveGrants } from "../capabilities/computer/secrets.ts";
import { getComputer, hasLiveLease, opHeld, runningComputerJobs } from "../capabilities/computer/state.ts";
import { loadProfiles, redactionFor } from "../secrets/redaction.ts";
import type { Db } from "../store/db.ts";
import { activeSchedules, nextAfterResume } from "../store/schedules.ts";
import { approvals } from "../store/schema.ts";
import { cronWords, type ComputerView, type DiskFacts, type GrantRow, type ScheduleRow, type SchedulesView, type SecretsView } from "./chat-extras.ts";
import type { Flash } from "./home.ts";

/**
 * What a chat's settings page shows of its schedules, secrets and computer (chat-extras.ts draws it), read from the
 * store and, for the secrets' variable NAMES, the secrets file (never a value: `loadProfiles` is asked for names
 * only, and a job's command is passed through the chat's redaction before it is shown). Reads only; the one
 * outside call, the disk's size from Hangar, is `diskFacts`, which the page fetches after it has loaded.
 */

export interface ExtrasDeps {
  db: Db;
  /** Schedules are set up in this process (SHUVI_SCHEDULES is not "off"). */
  schedulesOn: boolean;
  /** The computer's configuration, when it is set up in this process (null: off). */
  computer: ComputerConfig | null;
  ownerId?: number;
}

export interface ExtrasResult {
  section: "schedules" | "secrets";
  flash?: Flash;
}

/** How long the page's disk fragment waits for Hangar. */
export const DISK_TIMEOUT_MS = 3_000;

/** A person's name as the chat last saw it (from their latest message there), or their id. */
function personName(db: Db, chatId: number, userId: number): string {
  const r = db.$client
    .query("select json_extract(payload, '$.from.name') as name from chat_events where chat_id = ? and json_extract(payload, '$.from.id') = ? order by seq desc limit 1")
    .get(chatId, userId) as { name: string | null } | null;
  return r?.name ? `an operator, ${r.name}` : `an operator (user id ${userId})`;
}

export function loadSchedules(deps: ExtrasDeps, chatId: number, q: URLSearchParams, now: number, flash?: Flash): SchedulesView {
  if (!deps.schedulesOn) return { rows: [], off: "Schedules are off in this process (SHUVI_SCHEDULES=off)." };
  const at = new Date(now);
  const rows: ScheduleRow[] = activeSchedules(deps.db, chatId).map((s) => {
    const paused = s.state === "paused";
    // Paused: a one-off keeps its time; a cron shows what resuming now would give.
    const next = paused ? (s.cron ? nextAfterResume(s, at)?.toISOString() ?? null : (s.at ?? s.nextAt)) : s.nextAt;
    return {
      id: s.id,
      note: s.note,
      cron: s.cron,
      words: s.cron ? cronWords(s.cron) : null,
      nextAt: next,
      paused,
      passed: paused && !s.cron && (!next || Date.parse(next) <= now),
      by: s.ownerAuthorised ? "you" : s.authorisedBy != null ? personName(deps.db, chatId, s.authorisedBy) : null,
      lastFiredAt: s.lastFiredAt,
    };
  });
  // Soonest first, by the time each row shows (a paused cron's stored next run is stale); none last.
  rows.sort((a, b) => (a.nextAt ?? "~").localeCompare(b.nextAt ?? "~") || a.id - b.id);
  const confirm = /^schedule:(\d+)$/.exec(q.get("confirm") ?? "");
  return { rows, ...(confirm && rows.some((r) => r.id === Number(confirm[1])) ? { confirm: Number(confirm[1]) } : {}), ...(flash ? { flash } : {}) };
}

export function loadSecrets(deps: ExtrasDeps, chatId: number, now: number, flash?: Flash): SecretsView {
  const cfg = deps.computer;
  if (!cfg) return { rows: [], file: "", off: "The computer is off in this process, so no secret can be granted here.", ...(flash ? { flash } : {}) };
  const file = loadProfiles(cfg.secretsFile);
  const names = "profiles" in file ? Object.fromEntries(Object.entries(file.profiles).map(([p, vars]) => [p, Object.keys(vars)])) : null;
  const rows: GrantRow[] = liveGrants(deps.db, chatId, now).map((g) => {
    const card = deps.db.select({ requestedBy: approvals.requestedBy, answeredAt: approvals.answeredAt }).from(approvals).where(eq(approvals.id, g.approvalId)).get();
    return {
      id: g.id,
      profile: g.profile,
      vars: names ? (names[g.profile] ?? []) : null,
      gone: !!names && !names[g.profile],
      expiresAt: g.expiresAt,
      grantedAt: card?.answeredAt ?? null,
      askedBy: card?.requestedBy != null ? personName(deps.db, chatId, card.requestedBy) : "you",
    };
  });
  return { rows, file: cfg.secretsFile, ...("error" in file ? { fileError: file.error } : {}), ...(flash ? { flash } : {}) };
}

export function loadComputer(deps: ExtrasDeps, chatId: number, now: number): ComputerView {
  const cfg = deps.computer;
  const empty = { size: "", lastExecAt: null, jobs: [] };
  if (!cfg) return { ...empty, state: "none", off: "The computer is off in this process: SHUVI_HANGAR_API, _PROJECT, _TOKEN and SHUVI_COMPUTER_IMAGE are not all set." };
  const row = getComputer(deps.db, chatId);
  if (!row || !row.created) return { ...empty, size: sizeLabel(cfg.size), state: "none" };
  const red = redactionFor(cfg.secretsFile);
  const jobs = runningComputerJobs(deps.db, chatId).map((j) => {
    const spec = j.spec as { command?: string; tool?: string; startedAt?: string; boost?: unknown };
    // Redacted as its output is; with nothing to redact by (the file unusable), not shown at all.
    const command = !red.ok ? `${j.title.split(" ")[0]} (command not shown: the secrets file is unusable)` : spec.command ? red.redact(spec.command) : red.redact(j.title);
    return { id: j.id, command: command.replace(/\s+/g, " ").trim().slice(0, 300), startedAt: spec.startedAt ?? j.createdAt, boosted: !!spec.boost };
  });
  const lease = hasLiveLease(row, now);
  let busy: string | undefined;
  if (jobs.length) busy = jobs.length === 1 ? `job #${jobs[0]!.id} runs` : `${jobs.length} background jobs run`;
  else if (lease) busy = "a command runs on it";
  const running = row.runState === "running" || !!row.boost;
  const idleStopAt = running && !row.boost && !busy ? new Date(Math.max(now, (row.lastExecAt ? Date.parse(row.lastExecAt) : now) + cfg.idleMs)).toISOString() : null;
  const a = row.lastApply;
  return {
    state: row.boost ? "boosted" : row.runState,
    size: sizeLabel(cfg.size),
    ...(row.boost ? { boost: { size: sizeLabel(row.boost), jobId: row.boost.jobId, since: row.boost.since } } : {}),
    ...(opHeld(row, now) && row.op ? { op: row.op } : {}),
    idleStopAt,
    ...(busy ? { busy } : row.boost ? { busy: "it is boosted" } : {}),
    lastExecAt: row.lastExecAt,
    jobs,
    ...(a
      ? {
          apply: a.ok
            ? { at: a.at, ok: true, step: `applied${a.ms !== undefined ? ` in ${Math.round(a.ms / 1000)}s` : ""}${a.what ? `: ${a.what}` : ""}` }
            : { at: a.at, ok: false, step: a.step ?? "?", why: a.why ?? "", ...(a.output && red.ok ? { output: red.redact(a.output) } : {}) },
        }
      : {}),
    disk: null,
  };
}

/**
 * The chat's disk as Hangar says it: the size it is allocated (grown to) and the most it may grow to. Waits at most
 * DISK_TIMEOUT_MS; anything else is "unknown" with why.
 */
export async function diskFacts(db: Db, cfg: ComputerConfig, chatId: number, timeoutMs = DISK_TIMEOUT_MS): Promise<DiskFacts> {
  const row = getComputer(db, chatId);
  if (!row || !row.created) return { error: "the computer is not created yet" };
  try {
    const d = await computersFor(db, cfg).hangar.getDisk(row.disk, AbortSignal.timeout(timeoutMs));
    if (!d) return { error: "Hangar has no such disk" };
    return { size: d.status?.size || d.spec?.size || "?", max: d.spec?.grow?.max || (d.spec?.grow ? DISK_MAX : null) };
  } catch (e) {
    const timeout = e instanceof Error && /abort|timeout|timed out|deadline|cancel/i.test(`${e.name} ${e.message}`);
    return { error: timeout ? `Hangar did not answer within ${timeoutMs / 1000} s` : describeError(e) };
  }
}

export function loadExtras(deps: ExtrasDeps, chatId: number, q: URLSearchParams, now: number, result?: ExtrasResult) {
  return {
    schedules: loadSchedules(deps, chatId, q, now, result?.section === "schedules" ? result.flash : undefined),
    secrets: loadSecrets(deps, chatId, now, result?.section === "secrets" ? result.flash : undefined),
    computer: loadComputer(deps, chatId, now),
  };
}
