import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Code } from "@connectrpc/connect";
import type { Db } from "../../store/db.ts";
import { getChat, type Chat } from "../../store/events.ts";
import { createJob, discardJob, finishJob, type Job, type JobKind, type JobPoll } from "../../store/jobs.ts";
import { HOME_DIR, sizeLabel, type ComputerConfig, type Size } from "./config.ts";
import { ComputerError, type Computers } from "./computer.ts";
import { codeOf, describeError, ExecRefused, SIGKILL, SIGTERM } from "./hangar/client.ts";
import { ConditionStatus } from "./hangar/gen/hangar/meta/v1/meta_pb.ts";
import { awaitInbox } from "./files.ts";
import { secretsForChat, type Redaction } from "./secrets.ts";
import { acquireLease, COMPUTER_JOB_KIND, getComputer, releaseLease, runningComputerJobs } from "./state.ts";

/**
 * Running commands on a chat's computer, shaped after workstream's box tools (its src/agent/box-tools.ts:
 * `bash_box`, `run_async_box`, `read_job`, `cancel_job`), with what is box-specific (repos, git, services)
 * dropped and what a chat needs added (secrets, the job result coming back to the chat):
 *
 *   SYNC        `bash -lc <command>` from the home directory, blocking. A timeout (default 120 s, at most
 *               SHUVI_COMPUTER_EXEC_MAX_SEC) after which the process gets SIGTERM, SIGKILL 5 s later, and
 *               the connection is closed 3 s after that (Hangar kills the exec's process group when it
 *               drops); the result then says the command was stopped and to use `background`. As bash_box
 *               learned: say whether the process was killed, and give the output so far.
 *   OUTPUT      stdout, then stderr under `[stderr]`, each trimmed to its head and tail with an elision
 *               marker naming how to see the rest (`trimView`), led by `exit N · <duration>`.
 *   BACKGROUND  as run_async_box, the command is written to `~/.jobs/<id>.sh` through stdin (no quoting
 *               hazards) and run under `setsid` (its own process group, which survives the exec's
 *               connection) with its output in `~/.jobs/<id>.log`, its exit code in `~/.jobs/<id>.exit` and
 *               its process group in `~/.jobs/<id>.pgid`. It is an M6 job of report kind `poll`: the
 *               server's jobs watcher polls it (`computerJobKind`) and its end comes back to the chat as one
 *               `job_done` with a usage line (`exit 0 · ran 2m03s (expected 2m00s) · peak 1.2Gi · avg 1.9
 *               CPU`, measured by GNU time in the job, or wall and CPU from bash where it is missing) and the
 *               log's tail. There is no await_job: waiting is the turn ending, and the result waking the chat
 *               (design §5). `expect_seconds` is the honest estimate, as in run_async_box: past it the job is
 *               `overdue` (read_job says so, the result says how long it really took), and it sets the job's
 *               DEADLINE, three times it (at least 10 minutes more), when a job still running is stopped and
 *               reported; with none, the deadline is an hour.
 *   read_job    the log from a byte offset, with `grep` and `tail`, trimmed, and `nextSince` (read_job).
 *   cancel_job  TERM then KILL to the job's process group (cancel_job), exit 130.
 *
 * Every byte of output is passed through the chat's secret redactor before anyone sees it (secrets.ts).
 */

/** How much of a stream is kept in memory: its first and last bytes. */
const KEEP_BYTES = 64 << 10;
/** What a result shows of one stream: its first and last characters. */
export const VIEW_HEAD = 2_500;
export const VIEW_TAIL = 5_500;
/** After SIGTERM, how long before SIGKILL; after SIGKILL, how long before the connection is closed. */
const KILL_AFTER_MS = 5_000;
const CLOSE_AFTER_MS = 3_000;
/** How much of a finished job's log goes into its job_done. */
const JOB_TAIL_BYTES = 6_000;
/** What read_job reads at most per call. */
const READ_MAX_BYTES = 1 << 20;

/**
 * The synchronous wrapper: the command runs in a child bash, and a SIGTERM to the exec's process (the
 * timeout) is passed on to every process of the group, so a pipeline or a script's children stop too, not
 * only the shell. A SIGKILL cannot be passed on; the connection's close (Hangar then kills the exec's process
 * group) is the last resort.
 */
export const SYNC_WRAPPER = `trap 'trap "" TERM; kill -TERM 0 2>/dev/null' TERM
bash -lc "$0" &
p=$!
wait $p; ec=$?
while kill -0 $p 2>/dev/null; do wait $p; ec=$?; done
exit $ec`;

export const syncCommand = (command: string) => ["bash", "-c", SYNC_WRAPPER, command];

/** POSIX single-quote a word for a shell line. */
export const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** A path as the model wrote it, made absolute against the home directory inside a shell script (`$p`). */
export const resolvePath = (varName: string) => `case "$${varName}" in "~") ${varName}="$HOME";; "~/"*) ${varName}="$HOME/\${${varName}#\\~/}";; /*) ;; *) ${varName}="$HOME/$${varName}";; esac`;

/** A duration as a result reads it: `4.2s`, `352s`, `14m05s`, `1h02m` (workstream's `durationLabel`). */
export function durationLabel(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 600) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/**
 * Text cut to its head and tail, each on a line boundary where one is near, with a marker saying how much
 * was elided and how to see it. Unchanged when it fits.
 */
export function trimView(s: string, hint = "use a background job and read_job (grep/tail) for the full output", head = VIEW_HEAD, tail = VIEW_TAIL): string {
  if (s.length <= head + tail + 200) return s;
  let h = s.slice(0, head);
  const hn = h.lastIndexOf("\n");
  if (hn > head / 2) h = h.slice(0, hn + 1);
  let t = s.slice(-tail);
  const tn = t.indexOf("\n");
  if (tn >= 0 && tn < tail / 2) t = t.slice(tn + 1);
  const elided = s.length - h.length - t.length;
  return `${h}${h.endsWith("\n") ? "" : "\n"}… ${elided} characters elided (${hint}) …\n${t}`;
}

/** One stream of output, kept as its first and last KEEP_BYTES. */
class Capture {
  private head: Buffer[] = [];
  private headLen = 0;
  private tail: Buffer[] = [];
  private tailLen = 0;
  total = 0;
  push(b: Uint8Array): void {
    this.total += b.length;
    let buf = Buffer.from(b);
    if (this.headLen < KEEP_BYTES) {
      const take = buf.subarray(0, KEEP_BYTES - this.headLen);
      this.head.push(take);
      this.headLen += take.length;
      buf = buf.subarray(take.length);
    }
    if (!buf.length) return;
    this.tail.push(buf);
    this.tailLen += buf.length;
    while (this.tailLen - this.tail[0]!.length >= KEEP_BYTES) this.tailLen -= this.tail.shift()!.length;
  }
  /**
   * The stream as kept, redacted. Where its middle was dropped, the two cut edges may each hold part of a
   * secret value that a search over the kept text would not find, so a partial value there is removed first.
   */
  text(red: Redaction): string {
    const head = Buffer.concat(this.head).toString("utf8");
    if (!this.tail.length) return red.redact(head);
    const tailBuf = Buffer.concat(this.tail);
    const dropped = this.total - this.headLen - Math.min(this.tailLen, KEEP_BYTES);
    if (dropped <= 0) return red.redact(head + tailBuf.toString("utf8"));
    const tail = tailBuf.subarray(-KEEP_BYTES).toString("utf8");
    return `${red.redact(red.cutEdges(head, false, true))}\n… ${dropped} bytes not kept …\n${red.redact(red.cutEdges(tail, true, false))}`;
  }
}

/** Already-redacted stdout and stderr, as a result shows them. */
export function outputView(stdout: string, stderr: string, hint?: string): string {
  const out = trimView(stdout, hint);
  const err = stderr.trim() ? `\n[stderr]\n${trimView(stderr, hint)}` : "";
  const body = `${out}${err}`;
  return body.trim() ? body : "(no output)";
}

export interface ExecContext {
  db: Db;
  chat: Chat;
  computers: Computers;
  cfg: ComputerConfig;
}

export interface SyncOutcome {
  /** The text for the tool's result. */
  text: string;
  isError: boolean;
  code: number | null;
  stdout: Uint8Array;
}

/**
 * Run `command` to its end (or its timeout) on the chat's computer, with the chat's granted secrets in its
 * environment. `stdoutRaw` keeps stdout's bytes whole (for a framework read of a file), up to `maxStdout`.
 */
export async function runSync(
  x: ExecContext,
  command: string[],
  opts: { timeoutSec: number; secrets?: boolean; label?: string; keepStdout?: number; stdin?: Uint8Array },
): Promise<SyncOutcome> {
  const { env, profiles, red, warning } = secretsForChat(x.db, x.cfg.secretsFile, x.chat.id);
  const useEnv = opts.secrets === false ? {} : env;
  const out = new Capture();
  const err = new Capture();
  const raw: Uint8Array[] = [];
  let rawLen = 0;
  let stopped: "term" | "kill" | null = null;
  const t0 = Date.now();
  let ranMs = 0;
  let row = getComputer(x.db, x.chat.id);
  const { value } = await x.computers.withLease(x.chat, opts.timeoutSec * 1000 + KILL_AFTER_MS + CLOSE_AFTER_MS, async () => {
    // Files sent to the chat that wait for the computer to run are copied by the server now that it does.
    await awaitInbox(x.db, x.chat.id, x.cfg.inboxWaitMs);
    row = getComputer(x.db, x.chat.id);
    const started = Date.now();
    const h = x.computers.hangar.exec(row!.container, {
      command,
      env: useEnv,
      workingDir: HOME_DIR,
      ...(opts.stdin ? { stdin: opts.stdin } : {}),
      onStdout: (b) => {
        out.push(b);
        if (opts.keepStdout && rawLen < opts.keepStdout) {
          raw.push(b);
          rawLen += b.length;
        }
      },
      onStderr: (b) => err.push(b),
    });
    const timers = [
      setTimeout(() => {
        stopped = "term";
        h.signal(SIGTERM);
      }, opts.timeoutSec * 1000),
      setTimeout(() => {
        stopped = "kill";
        h.signal(SIGKILL);
      }, opts.timeoutSec * 1000 + KILL_AFTER_MS),
      setTimeout(() => h.close(), opts.timeoutSec * 1000 + KILL_AFTER_MS + CLOSE_AFTER_MS),
    ];
    try {
      return await h.exit.then(
        (e) => ({ exit: e as { code: number; signal: number } | null, error: null as unknown }),
        (error: unknown) => ({ exit: null, error }),
      );
    } finally {
      timers.forEach(clearTimeout);
      ranMs = Date.now() - started;
    }
  });
  const waited = Date.now() - t0 - ranMs;
  const boosted = row?.boost ? { ...row.boost } : null;
  const notes = [
    boosted ? `on the boosted computer (${sizeLabel(boosted)}${boosted.jobId ? `, boosted for job ${boosted.jobId}` : ""})` : "",
    waited > 3_000 ? `waited ${durationLabel(waited)} for the computer to start or finish a resize` : "",
    profiles.length ? `secrets: ${profiles.join(", ")}` : "",
    warning ?? "",
  ].filter(Boolean);
  const meta = notes.length ? ` · ${notes.join(" · ")}` : "";
  const body = outputView(out.text(red), err.text(red));
  if (stopped) {
    const how = stopped === "term" ? "it was sent SIGTERM and ended" : "it ignored SIGTERM and was killed (SIGKILL)";
    return {
      text: `stopped at the timeout (${opts.timeoutSec}s): ${how}${value.exit ? ` with exit ${value.exit.code}` : ""}${meta}.\nFor work that takes longer, run it with background: true and an honest expect_seconds; its result comes back to this chat when it ends.\noutput so far:\n${body}`,
      isError: true,
      code: value.exit?.code ?? null,
      stdout: Buffer.concat(raw),
    };
  }
  if (!value.exit) {
    const e = value.error;
    if (e instanceof ExecRefused) throw x.computers.refused(x.chat.id, e);
    if (codeOf(e) === Code.ResourceExhausted) throw x.computers.exhausted(x.chat.id, "the exec", e);
    throw new ComputerError(`the exec failed: ${describeError(e)}${body !== "(no output)" ? `\noutput so far:\n${body}` : ""}`);
  }
  const code = value.exit.code;
  return { text: `exit ${code} · ${durationLabel(ranMs)}${meta}\n${body}`, isError: code !== 0, code, stdout: Buffer.concat(raw) };
}

// ---- background jobs --------------------------------------------------------------------------------

export type JobTool = "exec" | "video_frames" | "transcribe";

export interface JobSpec {
  tool: JobTool;
  command: string;
  /** The estimate it was started with, if any. */
  expectSeconds?: number;
  /** The boost it runs on, if any. */
  boost?: Size;
  /** transcribe: the transcript's path; video_frames: how many frames. */
  output?: string;
  frames?: number;
  /** When it was started (ISO). */
  startedAt?: string;
}

/** The launcher: write the command to ~/.jobs/<id>.sh from stdin, run it detached in its own session. */
export function launcher(jobId: number): string {
  const inner = [
    'echo $$ > "$0.pgid"; export SHUVI_JOB="$0"; cd ~; s=$(date +%s%N)',
    'if [ -x /usr/bin/time ]; then /usr/bin/time -f "gnu %e %U %S %M" -o "$0.usage" bash "$0.sh" > "$0.log" 2>&1; ec=$?',
    'else bash "$0.sh" > "$0.log" 2>&1; ec=$?; echo "times $(( ($(date +%s%N) - s) / 1000000 )) $(times | tail -n 1)" > "$0.usage"; fi',
    'echo $ec > "$0.exit.tmp"; mv "$0.exit.tmp" "$0.exit"',
  ].join("\n");
  return `set -e; mkdir -p ~/.jobs; cat > ~/.jobs/${jobId}.sh; rm -f ~/.jobs/${jobId}.exit; setsid -f bash -c ${shq(inner)} "$HOME/.jobs/${jobId}" < /dev/null > /dev/null 2>&1`;
}

/** A job's deadline from its estimate: three times it, at least ten minutes past it; an hour with none. */
export function deadlineSeconds(cfg: ComputerConfig, expectSeconds?: number): number {
  if (!expectSeconds) return cfg.jobDefaultSec;
  return Math.min(Math.max(expectSeconds * 3, expectSeconds + 600), cfg.jobMaxSec);
}

/** What it says about a boost, in every result that ran on one: what carries over and what does not. */
export const BOOST_TERMS =
  "A boost restarts the computer at the larger size and, when it ends, restarts it at its normal size (stopped until the next exec): everything on its disk carries over (home and the rest of its filesystem), running processes do not (so a boost is refused while a background job runs, and background jobs are refused while a job holds a boost); other execs meanwhile run on the boosted computer.";

/** Start `spec` as a background job (boosted first if it asks). Returns the tool's text, or throws ComputerError. */
export async function startJob(x: ExecContext, a: { spec: JobSpec; title: string; originSeq: number }): Promise<{ job: Job; text: string }> {
  const row = x.computers.row(x.chat);
  if (row.boost) {
    const holder = row.boost.jobId != null ? `job ${row.boost.jobId}, and is restarted at its normal size when that ends` : "a command, and is restarted at its normal size once it is done";
    throw new ComputerError(`the computer is boosted (${sizeLabel(row.boost)}) for ${holder}, which would kill a job started now. Start this once it is back at its normal size${row.boost.jobId != null ? ` (after job ${row.boost.jobId}'s result arrives)` : ""}.`);
  }
  const expect = a.spec.expectSeconds ? Math.min(Math.max(a.spec.expectSeconds, 1), x.cfg.jobMaxSec) : undefined;
  const deadline = deadlineSeconds(x.cfg, expect);
  const now = Date.now();
  const { job } = createJob(x.db, {
    chatId: x.chat.id,
    originSeq: a.originSeq,
    kind: COMPUTER_JOB_KIND,
    title: a.title,
    report: "poll",
    spec: { ...a.spec, ...(expect ? { expectSeconds: expect } : {}), startedAt: new Date(now).toISOString() } as unknown as Record<string, unknown>,
    deadline: new Date(now + deadline * 1000),
    firstPollAt: new Date(now + x.cfg.pollEveryMs),
    // Only reachable through the boundary's owner check (`ownerOnly`).
    ownerAuthorised: true,
  });
  let boosted = false;
  try {
    if (a.spec.boost) {
      await x.computers.boost(x.chat, a.spec.boost, job.id);
      boosted = true;
    }
    // Only a model's own exec gets the chat's secrets; the framework's media jobs never do.
    const s = a.spec.tool === "exec" ? secretsForChat(x.db, x.cfg.secretsFile, x.chat.id) : { env: {}, profiles: [] as string[], warning: undefined };
    const { env, profiles, warning } = s;
    const r = await x.computers.withLease(x.chat, 60_000, async () => {
      await awaitInbox(x.db, x.chat.id, x.cfg.inboxWaitMs);
      return x.computers.hangar.run(getComputer(x.db, x.chat.id)!.container, { command: ["bash", "-c", launcher(job.id)], env, workingDir: HOME_DIR, stdin: new TextEncoder().encode(a.spec.command) });
    });
    if (r.value.code !== 0) throw new ComputerError(`the job could not be started (exit ${r.value.code}): ${r.value.stderr.trim().slice(0, 500)}`);
    const notes = [boosted ? `boosted to ${sizeLabel(a.spec.boost!)}. ${BOOST_TERMS}` : "", profiles.length ? `secrets: ${profiles.join(", ")}` : "", warning ?? ""].filter(Boolean);
    const when = expect ? `expected ${durationLabel(expect * 1000)}, overdue past that; stopped if still running at ${durationLabel(deadline * 1000)}` : `no estimate given; stopped if still running at ${durationLabel(deadline * 1000)}`;
    return {
      job,
      text: `Started job ${job.id} in the background (${when}; log ~/.jobs/${job.id}.log).${notes.length ? ` ${notes.join(" ")}` : ""} Its result, with its exit code, how long it took and what it used, comes back to this chat as a job event when it ends. read_job(${job.id}) shows its output so far; cancel_job(${job.id}) stops it. Do not wait or check on it: end your turn when you have nothing else to do.`,
    };
  } catch (e) {
    discardJob(x.db, job.id);
    if (boosted) await x.computers.restore(x.chat.id).catch(() => {});
    throw e;
  }
}

export interface JobUsage {
  wallMs: number;
  cpuMs?: number;
  /** The largest resident set of any one process of the job, in bytes (GNU time's %M). */
  peakBytes?: number;
}

/** Parse `~/.jobs/<id>.usage`: GNU time's `gnu <wall s> <user s> <sys s> <maxrss KiB>`, or bash's `times <wall ms> <user> <sys>`. */
export function parseUsage(line: string): JobUsage | undefined {
  const g = line.match(/gnu ([\d.]+) ([\d.]+) ([\d.]+) (\d+)/);
  if (g) return { wallMs: Number(g[1]) * 1000, cpuMs: (Number(g[2]) + Number(g[3])) * 1000, peakBytes: Number(g[4]) * 1024 };
  const t = line.match(/times (\d+) (\d+)m([\d.]+)s (\d+)m([\d.]+)s/);
  if (t) return { wallMs: Number(t[1]), cpuMs: (Number(t[2]) * 60 + Number(t[3]) + Number(t[4]) * 60 + Number(t[5])) * 1000 };
  return undefined;
}

const bytesLabel = (n: number) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)}Gi` : `${Math.round(n / (1 << 20))}Mi`);

/**
 * The line a finished job's result opens with, as workstream's `usageLine`: `exit 0 · ran 2m03s (expected
 * 1m00s, overdue) · peak 1.2Gi · avg 1.9 CPU · boosted (4 vCPU / 8Gi)`, so the next estimate can be better.
 */
export function usageLine(job: Job, exit: number, usage: JobUsage | undefined): string {
  const spec = job.spec as unknown as JobSpec;
  const wall = usage?.wallMs ?? (spec.startedAt ? Date.now() - Date.parse(spec.startedAt) : undefined);
  const parts = [exit === 130 ? "cancelled (exit 130)" : exit === 137 ? "killed (exit 137)" : `exit ${exit}`];
  if (wall !== undefined) {
    const expected = spec.expectSeconds ? ` (expected ${durationLabel(spec.expectSeconds * 1000)}${wall > spec.expectSeconds * 1000 ? ", overdue" : ""})` : "";
    parts.push(`ran ${durationLabel(wall)}${expected}`);
  }
  if (usage?.peakBytes) parts.push(`peak ${bytesLabel(usage.peakBytes)}`);
  if (usage?.cpuMs !== undefined && wall) parts.push(`avg ${(usage.cpuMs / wall).toFixed(1)} CPU`);
  if (spec.boost) parts.push(`boosted (${sizeLabel(spec.boost)})`);
  return parts.join(" · ");
}

/**
 * The result a finished job's `job_done` carries. `log` is the log's last JOB_TAIL_BYTES plus `red.maxLen` more
 * (the scripts below read that much), so the tail's first edge can be widened over a secret it cuts.
 */
export function jobResult(job: Job, exit: number, log: Uint8Array, red: Redaction, extra = "", usage?: JobUsage): { state: "done" | "failed"; result: string } {
  const w = red.window(log, Math.max(0, log.length - JOB_TAIL_BYTES), log.length);
  const tail = w.text.trim() ? trimView(w.text.trimEnd(), `read_job(${job.id}) for the full log`, 1_000, 4_000) : "(no output)";
  return { state: exit === 0 ? "done" : "failed", result: `${usageLine(job, exit, usage)}${extra ? `\n${extra}` : ""}\n${tail}\n(Full log: read_job(${job.id}), or ~/.jobs/${job.id}.log on the computer.)` };
}

/**
 * Kill a job's process group (TERM, then KILL) and mark it exited 130, then print the log's tail (`extra`
 * bytes more than a result shows, for redaction). The group is signalled only when its pgid was recorded in
 * THIS boot of the computer (the pgid file is newer than the boot): a pgid from an earlier boot names nothing
 * of the job's any more, and may name someone else's processes.
 */
export const killScript = (jobId: number, extra = 0) =>
  `cd ~/.jobs; for i in 1 2 3 4 5 6 7 8 9 10; do [ -s ${jobId}.pgid ] && break; sleep 0.2; done; p=$(cat ${jobId}.pgid 2>/dev/null); ` +
  `u=$(cut -d. -f1 /proc/uptime); boot=$(( $(date +%s) - u - 2 )); [ -n "$p" ] && [ "$(stat -c %Y ${jobId}.pgid)" -lt "$boot" ] && p=; ` +
  `if [ -n "$p" ]; then kill -TERM -- -$p 2>/dev/null; for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 -- -$p 2>/dev/null || break; sleep 0.2; done; kill -KILL -- -$p 2>/dev/null; fi; ` +
  `[ -f ${jobId}.exit ] || echo 130 > ${jobId}.exit; tail -c ${JOB_TAIL_BYTES + extra} ${jobId}.log 2>/dev/null; true`;

/**
 * Status of a job on its computer, one header line `exit|log size|usage|started` (exit empty while it runs;
 * started `y` once its launcher recorded its process group), then the log's tail once it ended (`extra` bytes
 * more than a result shows, for redaction).
 */
export const statusScript = (jobId: number, extra = 0) =>
  `cd ~/.jobs 2>/dev/null || { echo "|0||"; exit 0; }; printf '%s|%s|%s|%s\\n' "$(cat ${jobId}.exit 2>/dev/null)" "$(stat -c %s ${jobId}.log 2>/dev/null || echo 0)" "$(tail -n 1 ${jobId}.usage 2>/dev/null)" "$([ -s ${jobId}.pgid ] && echo y)"; [ -f ${jobId}.exit ] && tail -c ${JOB_TAIL_BYTES + extra} ${jobId}.log 2>/dev/null; true`;

/** Read frames a job left in ~/.jobs/<id>.frames (or `dir`) as `@@ name` lines, each followed by its base64. */
export const framesScript = (dir: string) => `d=${dir}; for f in "$d"/*.jpg; do [ -f "$f" ] || continue; echo "@@ $(basename "$f")"; base64 -w0 "$f"; echo; done`;

export function parseFrames(text: string): { name: string; data: string }[] {
  const out: { name: string; data: string }[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^@@ (.+)$/);
    if (m && lines[i + 1]) out.push({ name: m[1]!, data: lines[++i]!.trim() });
  }
  return out;
}

/** Where a frames job's frames are kept for the model, by job id. */
export const framesDir = (dataDir: string, jobId: number) => join(dataDir, "computer", "frames", String(jobId));

/**
 * The `computer` job kind: how the server's jobs watcher polls a background job. It reads the status
 * without starting the computer (a stopped computer means the job died with it), and on the job's end
 * returns its exit and log tail, redacted; a frames job's frames are copied into the data dir first. Past
 * its deadline, a job still running is killed and reported as stopped.
 */
export function computerJobKind(cfg: ComputerConfig, computersOf: (db: Db) => Computers): JobKind {
  return {
    kind: COMPUTER_JOB_KIND,
    pollEveryMs: cfg.pollEveryMs,
    pollTimeoutMs: 120_000,
    async poll(job, _signal, db): Promise<JobPoll> {
      const computers = computersOf(db);
      const row = getComputer(db, job.chatId);
      const chat = getChat(db, job.chatId);
      if (!row || !chat) return { state: "failed", result: "This job's computer is gone." };
      const red = secretsForChat(db, cfg.secretsFile, job.chatId).red;
      const lease = acquireLease(db, job.chatId, Date.now() + 90_000);
      if ("busy" in lease) return { state: "running", note: `the computer is busy (${lease.busy})` };
      try {
        const sh = (script: string) => computers.hangar.run(row.container, { command: ["bash", "-c", script], workingDir: HOME_DIR });
        let r;
        try {
          r = await sh(statusScript(job.id, red.maxLen));
        } catch (e) {
          const c = await computers.hangar.getContainer(row.container).catch(() => null);
          const stopped = c?.status?.conditions.some((x) => x.type === "Stopped" && x.status === ConditionStatus.TRUE);
          if (stopped) return { state: "failed", result: `The computer stopped while job ${job.id} ran, so the job ended with it. Its log so far is ~/.jobs/${job.id}.log.` };
          throw e;
        }
        const out = Buffer.from(r.stdout);
        const nl = out.indexOf("\n");
        const [exitStr, sizeStr, usageStr, startedStr] = (nl >= 0 ? out.subarray(0, nl) : out).toString("utf8").split("|");
        const log = nl >= 0 ? out.subarray(nl + 1) : Buffer.alloc(0);
        const spec = job.spec as unknown as JobSpec;
        if (exitStr) {
          const exit = Number.parseInt(exitStr, 10);
          let extra = "";
          if (spec.tool === "video_frames" && exit === 0) {
            const f = await sh(framesScript(`$HOME/.jobs/${job.id}.frames`));
            const frames = parseFrames(Buffer.from(f.stdout).toString("utf8"));
            const dir = framesDir(cfg.dataDir, job.id);
            rmSync(dir, { recursive: true, force: true });
            mkdirSync(dir, { recursive: true });
            for (const fr of frames) writeFileSync(join(dir, fr.name), Buffer.from(fr.data, "base64"));
            extra = `${frames.length} frame(s), shown after this line.`;
          }
          if (spec.tool === "transcribe" && exit === 0 && spec.output) extra = `Transcript written to ${spec.output} (its text is below).`;
          return jobResult(job, Number.isFinite(exit) ? exit : 1, log, red, extra, parseUsage(usageStr ?? ""));
        }
        // Never launched: shuvi stopped between making the job (and maybe its boost) and starting it. Ended
        // here so its boost is put back (maintainPass) instead of standing until the deadline.
        if (!startedStr?.trim() && spec.startedAt && Date.now() - Date.parse(spec.startedAt) > 3 * cfg.readyMs) {
          return { state: "failed", result: `Job ${job.id} never started: shuvi stopped while it was being started. Nothing ran; start it again if it is still wanted.` };
        }
        if (Date.now() >= Date.parse(job.deadline)) {
          const k = await sh(killScript(job.id, red.maxLen));
          const res = jobResult(job, 137, k.stdout, red);
          return { state: "failed", result: `Stopped at its deadline, still running. ${res.result}` };
        }
        return { state: "running", note: `log ${sizeStr ?? "?"} bytes${overdue(job) ? ", overdue" : ""}` };
      } finally {
        releaseLease(db, job.chatId, lease.lease);
      }
    },
  };
}

/** Running past its estimate. */
export function overdue(job: Job, now = Date.now()): boolean {
  const spec = job.spec as unknown as JobSpec;
  return !!spec.expectSeconds && !!spec.startedAt && now - Date.parse(spec.startedAt) > spec.expectSeconds * 1000;
}

/** read_job: a job's log from byte `since`, filtered, trimmed. */
export async function readJob(x: ExecContext, job: Job, a: { since?: number; grep?: string; tail?: number }): Promise<string> {
  let re: RegExp | undefined;
  if (a.grep) {
    try {
      re = new RegExp(a.grep);
    } catch {
      throw new ComputerError(`bad grep regex: ${a.grep}`);
    }
  }
  const since = a.since ?? 0;
  const { red } = secretsForChat(x.db, x.cfg.secretsFile, x.chat.id);
  // Read wider than asked by the longest secret on each side, so a value the window's edges cut is redacted whole.
  const from = Math.max(0, since - red.maxLen);
  const want = since - from + READ_MAX_BYTES + red.maxLen;
  const { value } = await x.computers.withLease(x.chat, 60_000, () =>
    x.computers.hangar.run(getComputer(x.db, x.chat.id)!.container, {
      command: ["bash", "-c", `tail -c +${from + 1} ~/.jobs/${job.id}.log 2>/dev/null | head -c ${want}; true`],
      workingDir: HOME_DIR,
    }),
  );
  const buf = value.stdout;
  const w = red.window(buf, Math.min(since - from, buf.length), Math.min(buf.length, since - from + READ_MAX_BYTES));
  const next = from + w.end;
  const more = buf.length >= want;
  let lines = w.text.split("\n");
  if (re) lines = lines.filter((l) => re!.test(l));
  const matched = lines.length;
  if (a.tail && lines.length > a.tail) lines = lines.slice(-a.tail);
  const status = job.state === "running" ? `running${overdue(job) ? " · overdue (past its expect_seconds)" : ""}` : `${job.state}`;
  const head = `job ${job.id} · ${status}${a.grep ? ` · ${matched} matching line(s)` : ""} · nextSince ${next}${more ? ` (read up to ${READ_MAX_BYTES} bytes; call again with since=${next} for more)` : ""}`;
  return `${head}\n${trimView(lines.join("\n"), "narrow it with grep or tail, or page with since") || "(no output)"}`;
}

/** cancel_job: stop the job's process group and end the job now. */
export async function cancelJob(x: ExecContext, job: Job): Promise<string> {
  const { red } = secretsForChat(x.db, x.cfg.secretsFile, x.chat.id);
  const { value } = await x.computers.withLease(x.chat, 60_000, () =>
    x.computers.hangar.run(getComputer(x.db, x.chat.id)!.container, { command: ["bash", "-c", killScript(job.id, red.maxLen)], workingDir: HOME_DIR }),
  );
  const res = jobResult(job, 130, value.stdout, red);
  finishJob(x.db, job.id, { state: "failed", result: `Cancelled with cancel_job. ${res.result}` });
  return `Cancelled job ${job.id}.`;
}

/** The running computer jobs of a chat, for the prompt or a refusal. */
export function runningJobsLine(db: Db, chatId: number): string {
  const r = runningComputerJobs(db, chatId);
  return r.length ? r.map((j) => `${j.id} (${j.title})`).join(", ") : "none";
}
