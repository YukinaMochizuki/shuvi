import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { err, ok, type ToolContent, type ToolDef, type ToolResult } from "agent-runtime";
import type { TurnState } from "../../agent/turn.ts";
import type { Db } from "../../store/db.ts";
import type { JobDonePayload } from "../../store/events.ts";
import { getJob } from "../../store/jobs.ts";
import { raiseAlert } from "../../store/control.ts";
import { getChat, getEvent } from "../../store/events.ts";
import { chatLabel } from "../../store/turns.ts";
import { updateAttachment } from "../../store/media.ts";
import { attachmentOfEvent } from "../../store/media.ts";
import { actingFor } from "../../agent/acting.ts";
import { defineCapability, policyDelegates, policyEnables } from "../types.ts";
import { computerConfig, DISK_MAX, DISK_SIZE, sizeLabel, type ComputerConfig, type Size } from "./config.ts";
import { ComputerError, Computers } from "./computer.ts";
import { BOOST_TERMS, cancelJob, computerJobKind, parseSheets, readJob, runSync, sheetsDir, sheetsIndex, sheetsScript, startJob, syncCommand, type ExecContext } from "./exec.ts";
import { awaitInbox, inboxNote, inboxPass, sendFromComputer } from "./files.ts";
import { browserSaveTool, browserUploadTool } from "./browser-save.ts";
import { applyResultText, DECLARED_PATH } from "./declared.ts";
import { DEFAULT_GRID, GRID_MAX, SHEET_EDGE, SHEET_MAX_FRAMES, sheetActsForOwner, sheetCommand, sheetOptions, type SheetArgs } from "./media.ts";
import { grantedNames, grantsFor, requestSecret, syncGrants, TTLS, untilLabel, type ProvideVar, type Ttl } from "./secrets.ts";
import { allProfiles, profileNames } from "../../secrets/source.ts";
import { allNotes, DETAILS_MAX, getNote, setNote, SUMMARY_MAX } from "../../secrets/notes.ts";
import { allComputers, COMPUTER_JOB_KIND, hasLiveLease, opHeld, acquireOp, releaseOp, runningComputerJobs } from "./state.ts";

/**
 * The computer: each chat's own machine on Hangar (docs/design.md §15), with its home on a disk of its own,
 * started when needed and stopped when idle. What it brings:
 *
 *   tools     exec, read_job, cancel_job (exec.ts, after workstream's box tools); request_secret
 *             (secrets.ts); send_file, send_photo (files.ts); browser_save (a browser download or PDF into
 *             ~/inbox/browser/) and browser_upload_from_computer (a file from here to the browser's page): both in
 *             browser-save.ts, the computer's, so `delegate: [computer]` governs them; video_sheet (media.ts; in a chat that
 *             has the media capability, media gives video_sheet instead, for a link or a file, and runs a
 *             file's here, `localSheet`); apply_computer_config (declared.ts). All act for the owner
 *             (`ownerOnly`; video_sheet on a file, `ownerOnlyWhen`), under the one rule
 *             every owner-only tool shares (`ownerAuthority` in src/agent/turn.ts): the turn's boundary
 *             refuses them unless the owner is in the turn; other people's messages beside his neither
 *             grant nor block. So changing ~/.computer.yaml, which only a computer tool can, is the
 *             owner's, or a delegated group's operators' (below). A group's policy may DELEGATE the computer to its operators (policy.ts
 *             `operators`, `delegate: [computer]`): then they may ask for every computer tool too
 *             (`delegable`), and their commands run as the owner's do, granted secrets included; a secret
 *             they ask for is still granted only by the owner's answer to its card, and that answer counts
 *             as the operator's, never as the owner's (`approvals.requested_by`). A job the owner started
 *             only he can cancel.
 *   declared  ~/.computer.yaml (apt packages, a setup script) is applied as root before the next command
 *             whenever it is not applied on the container's root disk: after a new image, after an edit
 *             (declared.ts).
 *   jobs      the `computer` job kind: background execs, polled by the jobs watcher (exec.ts).
 *   loops     `computer-maintain`: stop a computer idle for SHUVI_COMPUTER_IDLE_MINUTES (no exec, no job
 *             running), put a boosted one back at its size once its job (or exec) is over, and turn
 *             answered secret cards into grants; `computer-inbox`: copy files people send into ~/inbox.
 *   inbox     the owner's files are copied into ~/inbox when the computer next runs, never starting it for
 *             that; a tool that needs the computer waits up to SHUVI_COMPUTER_INBOX_WAIT_SEC for them. Photos
 *             only on `save_photo` (files.ts).
 *   perceive  after a message's line, where its file is on the computer; after a sheets job's result, the
 *             sheets, as images.
 *
 *   SHUVI_HANGAR_API              the Hangar API, e.g. https://hangar.example.com     (all four set: on)
 *   SHUVI_HANGAR_PROJECT          the Hangar project the computers live in
 *   SHUVI_HANGAR_TOKEN            a service token (hgr_…) with project.editor on it
 *   SHUVI_COMPUTER_IMAGE          the base image (computer/Dockerfile), by digest
 *   SHUVI_COMPUTER_REGISTRY_USER / _TOKEN   a read-only login for the image's private registry, kept in the
 *                                 Hangar Secret `shuvi-computer-registry` (registry-auth) and named in each
 *                                 container's imagePullSecrets (unset: pulled anonymously)
 *   SHUVI_COMPUTER_IDLE_MINUTES   stop a computer after this long without an exec (default 15)
 *   SHUVI_COMPUTER_CPU / _MEMORY  its normal size (default 2 / 2Gi)
 *   SHUVI_COMPUTER_EXEC_MAX_SEC   the most a synchronous exec may run (default 600; the default is 120)
 *   SHUVI_COMPUTER_READY_SEC      how long to wait for a start or a stop (default 180)
 *   SHUVI_COMPUTER_POLL_SEC       how often a background job is polled (default 5)
 *   SHUVI_COMPUTER_APPLY_STEP_SEC the most each step of applying ~/.computer.yaml may run (default 900)
 *   SHUVI_COMPUTER_INBOX_WAIT_SEC how long a turn waits for a sent file to land in ~/inbox (default 30)
 *   SHUVI_SECRETS_FILE            the secret profiles (default /etc/shuvi.secrets.yaml, mode 600)
 *   SHUVI_SECRETS_KEY             the key the console's secret profiles are sealed under (src/secrets/vault.ts)
 */

export const COMPUTER = `## Your computer

This chat has a computer of its own: a Linux machine (Debian, with python3, pip, node, ffmpeg, git, curl, jq, sqlite3) whose home directory, ~, is kept between uses; anything you install or save under ~ stays. The home disk starts at ${DISK_SIZE} and grows by itself as it fills, up to ${DISK_MAX}: when \`df\` shows it nearly full, that is its current size, not a limit. It starts when you use it and stops when idle; the first command after a while takes a little longer.

- \`exec\` runs a shell command there. A synchronous exec has a timeout (120 s by default); anything longer goes in the background (\`background: true\` with an honest \`expect_seconds\`): you get a job id at once, the result comes back to this chat as a job event when it ends, and you end your turn meanwhile. Never wait or poll for a job; \`read_job\` is for looking at its output when you need to, \`cancel_job\` stops it.
- \`boost\` runs one command or job on the same computer made larger, for heavy work (it restarts the computer around it).
- Files the owner sends here are copied into ~/inbox/ when the computer next runs (the message says where; your next command waits for them). Photos are not copied unless you ask: \`save_photo\` with the photo's #number. \`send_file\` and \`send_photo\` send a file from the computer to this chat. \`browser_save\` puts one of this chat's browser downloads (or a PDF \`browser_send\` made) in ~/inbox/browser/; \`browser_upload_from_computer\` gives the browser's page a file from here.
- Installing for yourself needs nothing more: \`pip install --user\`, npm packages installed into ~, programs in ~/.local/bin all stay. Your commands run as a user without root; system packages (apt) go into ${DECLARED_PATH}: \`apt:\` a list of Debian packages, and optionally \`setup:\`, a shell script run after them (both as root; no other keys). It is applied by itself before your next command once it changes, and again whenever the computer's image changes (anything else outside ~ is gone then); \`apply_computer_config\` applies it at once and shows what failed. Keep it to what you need.
- To look at a video, use \`video_sheet\` rather than writing ffmpeg commands yourself: it gives contact sheets, frames tiled in order with each one's time under it, and an index of the times. Start with the whole video (the default spacing), then zoom into a part with a window (\`from\` / \`to\`) and a smaller \`every\`; \`scene: true\` takes a frame at each cut.
- Credentials are never on the computer. If a task needs one (an API key), \`request_secret\` asks the owner for a named profile; once granted, its variables are in the environment of your commands here, and their values are hidden from you as [REDACTED:<profile>]. The owner may grant a profile to this chat only, or to every chat for his own requests (then your commands get it in any chat, whenever he is the one asking).`;

/**
 * The section's lines on the secrets there are now: each profile's name, its note's summary and whether it is
 * granted (never a value, never the note's details), sorted, so the same state gives the same bytes.
 */
function secretsLine(db: Db, cfg: ComputerConfig, chatId: number): string {
  const names = profileNames(db, cfg.secrets);
  if (!names.length) return "";
  const g = grantedNames(db, chatId);
  const notes = allNotes(db);
  const lines = names.map((n) => {
    const summary = notes.get(n)?.summary;
    const granted = g.owner.includes(n) ? " [granted for the owner in every chat]" : g.chat.includes(n) ? " [granted in this chat]" : "";
    return `\n  - ${n}${summary ? `: ${summary}` : ""}${granted}`;
  });
  return `\n- Secret profiles there are (\`secret_info\` gives how to use one; when you learn something about one that would save looking it up again, its scope, an account or org id, what works, keep it with \`update_secret_note\`):${lines.join("")}`;
}

const oneLine = (s: string, n = 120) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const sizeSchema = z
  .object({ cpu: z.string().describe('vCPUs, e.g. "4"'), memory: z.string().describe('memory, e.g. "8Gi"') })
  .describe("Run on the same computer resized to this, then put back. For heavy work (large models, big builds).");

/** The tool's text for a thrown error: a ComputerError says what to do; anything else is unexpected. */
function failure(e: unknown): ToolResult {
  if (e instanceof ComputerError) return err(e.message);
  return err(`The computer failed unexpectedly: ${e instanceof Error ? e.message : String(e)}`);
}

/** One Computers per store, so a turn's tools and the server's loops share nothing else. Shared with media. */
const shared = new WeakMap<Db, Computers>();
export function computersFor(db: Db, cfg: ComputerConfig): Computers {
  let c = shared.get(db);
  // Media reads the same configuration on its own (an equal object, not the same one): that is no change.
  if (!c || (c.cfg !== cfg && JSON.stringify(c.cfg) !== JSON.stringify(cfg))) shared.set(db, (c = new Computers(db, cfg)));
  return c;
}

/**
 * The server's maintenance pass: idle stops, restores after a boost, grants. Each chat is handled on its own:
 * one that fails (Hangar refusing, a bad state) is alerted, rate-limited per chat, and the others carry on.
 * Exported for tests.
 */
export async function maintainPass(db: Db, computers: Computers, cfg: ComputerConfig, now = Date.now()): Promise<{ stopped: number[]; restored: number[]; failed: number[] }> {
  syncGrants(db, now);
  const stopped: number[] = [];
  const restored: number[] = [];
  const failed: number[] = [];
  for (const row of allComputers(db)) {
    try {
      if (opHeld(row, now)) continue;
      if (row.boost) {
        const jobLive = row.boost.jobId != null && getJob(db, row.boost.jobId)?.state === "running";
        const execLive = row.boost.jobId == null && (hasLiveLease(row, now) || now - Date.parse(row.boost.since) < 60_000);
        if (!jobLive && !execLive && (await computers.restore(row.chatId, 0))) restored.push(row.chatId);
        continue;
      }
      if (row.runState !== "running" || hasLiveLease(row, now)) continue;
      if (row.lastExecAt && now - Date.parse(row.lastExecAt) < cfg.idleMs) continue;
      if (runningComputerJobs(db, row.chatId).length) continue;
      if (!acquireOp(db, row.chatId, "stop", now + 3 * cfg.readyMs, { quietJobs: true, now }).ok) continue;
      try {
        await computers.stop(row.chatId, cfg.size);
        releaseOp(db, row.chatId, { runState: "stopped" });
        stopped.push(row.chatId);
      } catch (e) {
        releaseOp(db, row.chatId);
        throw e;
      }
    } catch (e) {
      failed.push(row.chatId);
      const chat = getChat(db, row.chatId);
      raiseAlert(db, {
        key: `computer-maintain:${row.chatId}:${now}`,
        topic: `computer-maintain:${row.chatId}`,
        text: `Maintaining the computer of ${chat ? chatLabel(chat) : `chat ${row.chatId}`} failed (${row.boost ? "putting it back after a boost" : "stopping it when idle"}): ${e instanceof Error ? e.message : String(e)}. It is tried again.`,
      });
    }
  }
  return { stopped, restored, failed };
}

/** What a refusal of video_sheet on a file says (the boundary's, agent/turn.ts). */
export const SHEET_FILE_NOTE =
  "A file on the computer is the owner's to look at. With the video's link (url), video_sheet works for anyone, where it is offered; otherwise tell them only the owner can have that file looked at.";

/** What video_sheet does, in its description (this capability's and media's). */
export const SHEET_DESCRIPTION =
  "frames tiled in order, each with its time (mm:ss) under it, plus an index (duration, resolution, each sheet's frames' times). " +
  "Spacing, at most one of: `every` (seconds between frames), `count` (frames spread evenly), `scene: true` (the start and a frame at each scene change); none: a count chosen from the length (16 for a short clip, more for a long one). " +
  `\`from\` / \`to\` sheet only that window: to look closer at a part, give its window and a smaller \`every\` rather than sheeting the whole video again. At most ${SHEET_MAX_FRAMES} frames per call; more is refused with how to narrow it. ` +
  `Each sheet is \`grid\` (columns x rows, default ${DEFAULT_GRID.cols}x${DEFAULT_GRID.rows}) frames, at most ${SHEET_EDGE} px on its long edge.`;

const time = z.union([z.number().nonnegative(), z.string()]);
/** video_sheet's spacing, window and grid (this capability's and media's). */
export const sheetSchema = {
  every: z.number().positive().optional().describe("Seconds between frames, e.g. 10, or 0.5 inside a short window"),
  count: z.number().int().positive().optional().describe(`How many frames, spread evenly (at most ${SHEET_MAX_FRAMES})`),
  scene: z.boolean().optional().describe("true: a frame at each scene change (cut) instead"),
  from: time.optional().describe('Start of the window: seconds, or "mm:ss" / "hh:mm:ss" (default: the start)'),
  to: time.optional().describe("End of the window, as from (default: the end)"),
  grid: z.string().optional().describe(`Columns x rows per sheet, e.g. "4x4" (default), "3x2"; each 1 to ${GRID_MAX}`),
};

export type LocalSheetInput = SheetArgs & { path: string; background?: boolean };

/**
 * video_sheet on a file of the computer: in the background as a `computer` job by default (the sheets come back
 * with its result), or waited for. Shared with media's video_sheet, whose `path` calls run here.
 */
export async function localSheet(x: ExecContext, s: TurnState, a: LocalSheetInput): Promise<ToolResult> {
  const plan = sheetOptions(a);
  if (!plan.ok) return err(plan.error);
  const title = `video_sheet ${oneLine(a.path)}${plan.title ? ` (${plan.title})` : ""}`;
  try {
    if (a.background !== false) {
      const { text } = await startJob(x, { spec: { tool: "video_sheet", command: sheetCommand(a.path, plan.options, '"$SHUVI_JOB.sheets"', false) }, title, originSeq: s.toSeq, acting: actingFor(s, "video_sheet") });
      return ok(text);
    }
    const dir = '"$HOME/.cache/shuvi-sheets"';
    const script = `${sheetCommand(a.path, plan.options, dir, false)}\n${sheetsScript(dir)}`;
    const r = await runSync(x, ["bash", "-c", script], { timeoutSec: x.cfg.execDefaultSec, secrets: false, keepStdout: 32 << 20 });
    if (r.isError) return err(r.text);
    const files = parseSheets(Buffer.from(r.stdout).toString("utf8"));
    const sheets = files.filter((f) => f.name.endsWith(".jpg"));
    const content: ToolContent[] = [
      { type: "text", text: `${sheetsIndex(files) || `${a.path}:`}\n${sheets.length} sheet(s), in order:` },
      ...sheets.map((f) => ({ type: "image" as const, data: f.data, mimeType: "image/jpeg" })),
    ];
    return { content };
  } catch (e) {
    return failure(e);
  }
}

export const computer = defineCapability<ComputerConfig>({
  id: "computer",
  label: "computer (owner only)",
  gives: "this chat's own computer: exec, files, secrets, photos, video contact sheets.",
  enable: computerConfig,
  ownerOnly: ["exec", "read_job", "cancel_job", "request_secret", "secret_info", "update_secret_note", "send_file", "send_photo", "save_photo", "browser_save", "browser_upload_from_computer", "apply_computer_config"],
  // A sheet of a file on the computer is the owner's; one of a link (media's video_sheet) is anyone's.
  ownerOnlyWhen: { video_sheet: sheetActsForOwner },
  ownerOnlyNote: { video_sheet: SHEET_FILE_NOTE },
  delegable: ["exec", "read_job", "cancel_job", "request_secret", "secret_info", "send_file", "send_photo", "save_photo", "browser_save", "browser_upload_from_computer", "apply_computer_config", "video_sheet"],
  tools({ db, chat, state: s, chatPolicy }, cfg) {
    const computers = computersFor(db, cfg);
    const x: ExecContext = { db, chat, computers, cfg };

    const exec: ToolDef<{ command: string; timeout?: number; background?: boolean; expect_seconds?: number; boost?: Size }> = {
      name: "exec",
      description:
        "Run a shell command line on this chat's computer (`bash -l`, from ~), blocking until it exits, and get its exit code and output (stdout, then stderr under [stderr]; long output is trimmed to its head and tail). " +
        `It has a timeout (\`timeout\` seconds, default ${cfg.execDefaultSec}, at most ${cfg.execMaxSec}); at the timeout the command is stopped (SIGTERM, then SIGKILL) and you get the output so far. ` +
        "For anything that may take longer (downloads, conversions, installs, builds), use `background: true`: you get a job id at once, the command runs detached with its output in ~/.jobs/<id>.log, and its result (exit code, how long it took, what it used, the log's tail) comes back to this chat as a job event when it ends; end your turn meanwhile, do not wait. " +
        "Give a background job an honest `expect_seconds`: past it the job is overdue, and at three times it (at least ten minutes more) it is stopped. A server that never exits does not belong here. " +
        `\`boost: {cpu, memory}\` runs this command or job on the same computer resized. ${BOOST_TERMS} ` +
        "Granted secret profiles are in the environment; their values are replaced by [REDACTED:<profile>] in what you see.",
      inputSchema: {
        command: z.string().min(1).describe("A shell command line (pipes, &&, redirects and quotes all work)"),
        timeout: z.number().int().positive().optional().describe(`Seconds before a synchronous command is stopped (default ${cfg.execDefaultSec}, at most ${cfg.execMaxSec})`),
        background: z.boolean().optional().describe("Run it detached as a job; its result comes back to this chat later"),
        expect_seconds: z.number().int().positive().optional().describe("With background: how long you honestly expect it to take"),
        boost: sizeSchema.optional(),
      },
      async handler(a) {
        try {
          if (a.background) {
            const { text } = await startJob(x, {
              spec: { tool: "exec", command: a.command, ...(a.expect_seconds ? { expectSeconds: a.expect_seconds } : {}), ...(a.boost ? { boost: a.boost } : {}) },
              title: `$ ${oneLine(a.command)}`,
              originSeq: s.toSeq,
              acting: actingFor(s, "exec"),
            });
            return ok(text);
          }
          const timeout = Math.min(a.timeout ?? cfg.execDefaultSec, cfg.execMaxSec);
          const capped = a.timeout && a.timeout > cfg.execMaxSec ? ` (timeout capped at ${cfg.execMaxSec}s; use background for longer work)` : "";
          // The owner's grants for every chat go only into a command run for the owner, never an operator's.
          const forOwner = actingFor(s, "exec")?.by === "owner";
          if (!a.boost) {
            const r = await runSync(x, syncCommand(a.command), { timeoutSec: timeout, forOwner });
            return r.isError ? err(r.text + capped) : ok(r.text + capped);
          }
          await computers.boost(chat, a.boost, null);
          let r;
          try {
            r = await runSync(x, syncCommand(a.command), { timeoutSec: timeout, forOwner });
          } finally {
            await computers.restore(chat.id).catch(() => false);
          }
          const text = `${r.text}${capped}\n(${BOOST_TERMS} It is back at its normal size, ${sizeLabel(cfg.size)}, now.)`;
          return r.isError ? err(text) : ok(text);
        } catch (e) {
          return failure(e);
        }
      },
    };

    const readJobTool: ToolDef<{ id: number; since?: number; grep?: string; tail?: number }> = {
      name: "read_job",
      description:
        "Read a background job's output so far (its ~/.jobs/<id>.log) without waiting. `since` is a byte offset: 0 (the default) reads from the start; pass the `nextSince` a previous read returned to read only what came after. `grep` keeps only lines matching a regex; `tail` keeps only the last N lines (after grep). The output is trimmed to its head and tail when long. It also says whether the job is still running or overdue. Not for waiting: a job's result comes to this chat by itself.",
      inputSchema: {
        id: z.number().int().positive().describe("The job id exec returned"),
        since: z.number().int().nonnegative().optional().describe("Byte offset to read from (default 0)"),
        grep: z.string().optional().describe("A regex; return only matching lines"),
        tail: z.number().int().positive().optional().describe("Return only the last N lines (after grep)"),
      },
      async handler(a) {
        const job = getJob(db, a.id);
        if (!job || job.chatId !== chat.id || job.kind !== COMPUTER_JOB_KIND) return err(`There is no job ${a.id} on this chat's computer.`);
        try {
          return ok(await readJob(x, job, a));
        } catch (e) {
          return failure(e);
        }
      },
    };

    const cancelJobTool: ToolDef<{ id: number }> = {
      name: "cancel_job",
      description: "Stop a running background job on this chat's computer (its whole process group: SIGTERM, then SIGKILL). Its result (cancelled, with its log's tail) comes back to this chat.",
      inputSchema: { id: z.number().int().positive().describe("The job id") },
      async handler(a) {
        const job = getJob(db, a.id);
        if (!job || job.chatId !== chat.id || job.kind !== COMPUTER_JOB_KIND) return err(`There is no job ${a.id} on this chat's computer.`);
        if (job.state !== "running") return err(`Job ${a.id} is not running (it is ${job.state}).`);
        // As with schedules: an operator may stop what operators started, never what the owner started.
        if (job.ownerAuthorised && actingFor(s, "cancel_job")?.by !== "owner") return err(`Job ${a.id} was started for the owner; only the owner can cancel it.`);
        try {
          return ok(await cancelJob(x, job));
        } catch (e) {
          return failure(e);
        }
      },
    };

    const requestSecretTool: ToolDef<{ profile: string; ttl: Ttl; reason: string; vars?: ProvideVar[] }> = {
      name: "request_secret",
      description:
        "Ask the owner to grant this chat a named secret profile (a set of variables, such as an API token or an id number) for a while: its variables go into the environment of your commands here, and `browser_type` with `secret` can type them into a page. The owner sees the profile's variable names and your reason, never the values, and answers in their control bot: for this chat, or for every chat (his own requests only, possibly until he revokes it). " +
        "For a profile there is NOT yet, give `vars` too: each variable it needs, its name and what it is in the owner's language (e.g. [{\"name\": \"NATIONAL_ID\", \"about\": \"身分證字號\"}]); the owner then gets a link to type the values in the console (never in a chat), and his answer grants it. Never ask anyone to send a secret in a chat. " +
        "Their answer arrives in this chat as an approval event. End your turn after asking.",
      inputSchema: {
        profile: z.string().min(1).describe("The profile's name, e.g. modal (a new one: letters, digits, _ and -)"),
        ttl: z.enum(Object.keys(TTLS) as [Ttl, ...Ttl[]]).describe("How long to ask for: 4h, 1d or 3d"),
        reason: z.string().min(1).describe("Why you need it, in a sentence the owner reads"),
        vars: z
          .array(z.object({ name: z.string().min(1).max(64).describe("The variable's name, e.g. NATIONAL_ID"), about: z.string().max(120).optional().describe("What it is, in the owner's language, e.g. 身分證字號") }))
          .max(10)
          .optional()
          .describe("Only for a profile there is not yet: each variable it needs"),
      },
      async handler(a) {
        const acting = actingFor(s, "request_secret");
        const live = grantsFor(db, chat.id, acting?.by === "owner").find((g) => g.profile === a.profile);
        if (live) return ok(`"${a.profile}" is already granted ${live.chatId == null ? "for the owner in every chat" : "here"} ${untilLabel(live)}; its variables are in your commands' environment.`);
        // An operator's card says so, and its answer counts as theirs, never as the owner's (agent/turn.ts).
        const r = requestSecret(db, cfg.secrets, {
          chatId: chat.id,
          profile: a.profile,
          ttl: a.ttl,
          reason: a.reason,
          ...(a.vars ? { vars: a.vars } : {}),
          ...(cfg.consoleUrl ? { consoleUrl: cfg.consoleUrl } : {}),
          ...(acting?.by === "operator" ? { requestedBy: acting.userId } : {}),
        });
        if ("error" in r) return err(r.error);
        if (r.provide)
          return ok(`Asked the owner to provide a new secret "${a.profile}" (${a.vars!.map((v) => v.name).join(", ")}), approval #${r.approvalId}: he types the values in the console. His answer comes back to this chat as an approval event. End your turn now; do not wait for it, and do not ask for the values in the chat.`);
        return ok(`Asked the owner for "${a.profile}" (${a.ttl}), approval #${r.approvalId}. Their answer comes back to this chat as an approval event. End your turn now; do not wait for it.`);
      },
    };

    const secretInfoTool: ToolDef<{ profile?: string }> = {
      name: "secret_info",
      description:
        "What is known about the secret profiles: each one's variables (names only, never a value), whether it is granted to your commands here, and its note: a one-line summary and the details (its scope, the accounts or org ids it acts on, how to use it, what was tried). Read it before working with a profile, so you need not find out again what is already known.",
      inputSchema: { profile: z.string().optional().describe("One profile; omit for all of them") },
      async handler(a) {
        const all = allProfiles(db, cfg.secrets);
        if ("error" in all) return err(`The secrets file cannot be used: ${all.error}`);
        const names = [...Object.keys(all.profiles), ...all.unreadable.map((u) => u.name)].sort();
        const pick = a.profile ? names.filter((n) => n === a.profile) : names;
        if (!pick.length) return a.profile ? err(`There is no secret profile "${a.profile}". There are: ${names.join(", ") || "none"}.`) : ok("There are no secret profiles.");
        const live = grantsFor(db, chat.id, actingFor(s, "secret_info")?.by === "owner");
        return ok(
          pick
            .map((n) => {
              const vars = all.profiles[n] ? Object.keys(all.profiles[n]!).join(", ") : `(cannot be used now: ${all.unreadable.find((u) => u.name === n)?.why})`;
              const g = live.find((x) => x.profile === n);
              const note = getNote(db, n);
              return [
                `## ${n}`,
                `Variables: ${vars || "(none)"}`,
                `Granted to your commands here: ${g ? `yes, ${g.chatId == null ? "for the owner in every chat" : "in this chat"}, ${untilLabel(g)}` : "no (request_secret asks)"}`,
                `Summary: ${note?.summary || "(none)"}`,
                `Details:${note?.details ? `\n${note.details}` : " (none)"}`,
                ...(note ? [`(note last written by ${note.updatedBy}, ${note.updatedAt.slice(0, 16).replace("T", " ")} UTC)`] : []),
              ].join("\n");
            })
            .join("\n\n"),
        );
      },
    };

    const updateSecretNoteTool: ToolDef<{ profile: string; summary?: string; details?: string }> = {
      name: "update_secret_note",
      description:
        `Keep what you know about a secret profile in its note, for every chat and every later turn: \`summary\` (one line, at most ${SUMMARY_MAX} characters, shown beside the profile's name in your prompt: what it is for) and/or \`details\` (at most ${DETAILS_MAX} characters: its scope, the accounts or org ids it acts on, how to use it, what failed and why). Each one you give REPLACES what was there, so read it with secret_info first and write it back whole. Never a secret value: a note holding one is refused. The owner sees and edits notes in the console.`,
      inputSchema: {
        profile: z.string().min(1).describe("The profile's name"),
        summary: z.string().optional().describe("One line: what it is for"),
        details: z.string().optional().describe("How to use it: scope, ids, what works, what does not"),
      },
      async handler(a) {
        const r = setNote(db, cfg.secrets, a.profile, { ...(a.summary !== undefined ? { summary: a.summary } : {}), ...(a.details !== undefined ? { details: a.details } : {}) }, `assistant in ${chatLabel(chat)}`);
        if ("error" in r) return err(r.error);
        return ok(`Saved the note of "${a.profile}"${a.summary !== undefined ? " (summary" : " ("}${a.summary !== undefined && a.details !== undefined ? " and " : ""}${a.details !== undefined ? "details" : ""}). It is in every chat's prompt from the next turn.`);
      },
    };

    const sendFile: ToolDef<{ path: string; caption?: string }> = {
      name: "send_file",
      description: "Send a file from this chat's computer to this chat, as a document (Telegram takes up to 50 MB from a bot). `path` is on the computer (~ is its home).",
      inputSchema: { path: z.string().min(1).describe("The file's path on the computer, e.g. ~/out/report.pdf"), caption: z.string().optional().describe("A caption (up to 1024 characters)") },
      async handler(a) {
        try {
          return ok(await sendFromComputer(x, s, cfg, { path: a.path, ...(a.caption ? { caption: a.caption } : {}), as: "document" }));
        } catch (e) {
          return failure(e);
        }
      },
    };

    const sendPhoto: ToolDef<{ path: string; caption?: string }> = {
      name: "send_photo",
      description: "Send an image from this chat's computer to this chat as a photo (Telegram takes up to 10 MB; send larger ones with send_file). `path` is on the computer.",
      inputSchema: { path: z.string().min(1).describe("The image's path on the computer, e.g. ~/out/chart.png"), caption: z.string().optional().describe("A caption (up to 1024 characters)") },
      async handler(a) {
        try {
          return ok(await sendFromComputer(x, s, cfg, { path: a.path, ...(a.caption ? { caption: a.caption } : {}), as: "photo" }));
        } catch (e) {
          return failure(e);
        }
      },
    };

    const savePhoto: ToolDef<{ seq: number }> = {
      name: "save_photo",
      description: "Copy a photo sent in this chat into ~/inbox/ on your computer, at its full size, to work on it there (photos are not copied by themselves). `seq` is the photo message's #number. Starts the computer if needed and returns the path.",
      inputSchema: { seq: z.number().int().positive().describe("The photo message's #number") },
      async handler(a) {
        const e = getEvent(db, a.seq);
        const att = e && e.chatId === chat.id ? attachmentOfEvent(e) : undefined;
        if (!e || att?.kind !== "photo") return err(`#${a.seq} is not a photo in this chat.`);
        if (att.state === "ready") return ok(`It is on your computer: ~/${att.path}`);
        if (att.state !== "requested") updateAttachment(db, e.seq, { state: "requested", attempts: 0 });
        try {
          // Starting the computer is what lets the server copy it; then wait for it to land.
          await computers.withLease(chat, 120_000, () => awaitInbox(db, chat.id, cfg.inboxWaitMs));
        } catch (err2) {
          return failure(err2);
        }
        const now = attachmentOfEvent(getEvent(db, a.seq)!);
        if (now?.state === "ready") return ok(`Saved on your computer as ~/${now.path}`);
        if (now?.state === "failed") return err(`The photo could not be copied: ${now.error ?? "unknown error"}`);
        return err("The photo is not on the computer yet (it is still being copied); try again in a moment.");
      },
    };

    const videoSheet: ToolDef<LocalSheetInput> = {
      name: "video_sheet",
      description: `Look at a video on the computer as contact sheets: ${SHEET_DESCRIPTION} In the background by default (the sheets come back to this chat with the job's result); background: false waits for them (short videos, a few frames).`,
      inputSchema: { path: z.string().min(1).describe("The video's path on the computer, e.g. ~/inbox/123-clip.mp4"), ...sheetSchema, background: z.boolean().optional().describe("false: wait for the sheets (default true)") },
      handler: (a) => localSheet(x, s, a),
    };
    // In a chat with the media capability, media's video_sheet (a link or a file) stands in for this one.
    const sheetHere = !(cfg.mediaOn && policyEnables(chatPolicy, "media"));

    const applyConfig: ToolDef<Record<string, never>> = {
      name: "apply_computer_config",
      description:
        `Apply ${DECLARED_PATH} on this chat's computer now, rather than before your next command: its \`apt\` packages (installed through a cache in ~, so a new image does not download them again), then its \`setup\` script, both as root. ` +
        "Nothing runs when the file as it is was already applied. A file that failed is tried again. Returns what ran, or the step that failed and its output. Only the owner can have this done, as only the owner can have the file changed.",
      inputSchema: {},
      async handler() {
        try {
          const { declared } = await computers.withLease(chat, 60_000, async () => undefined, 90_000, { force: true });
          const r = applyResultText(declared);
          return r.isError ? err(r.text) : ok(r.text);
        } catch (e) {
          return failure(e);
        }
      },
    };

    return [{ serverName: "shuvi", tools: [exec, readJobTool, cancelJobTool, requestSecretTool, secretInfoTool, updateSecretNoteTool, sendFile, sendPhoto, savePhoto, browserSaveTool(x, chatPolicy), browserUploadTool(x, chatPolicy), ...(sheetHere ? [videoSheet] : []), applyConfig] as ToolDef[] }];
  },
  section: (ctx, cfg) => {
    const secrets = ctx.db ? secretsLine(ctx.db, cfg, ctx.chat.id) : "";
    return policyDelegates(ctx.chatPolicy, "computer")
      ? `${COMPUTER}${secrets}\n- Here the owner has let this group's operators use this computer too: run what they ask for as you would for him; files they send are copied into ~/inbox/ like his. A secret they need is asked for with \`request_secret\` all the same; only the owner can grant it.`
      : `${COMPUTER}${secrets}`;
  },
  jobKinds: (cfg) => [computerJobKind(cfg, (db) => computersFor(db, cfg))],
  loops: ({ db, files, ownerId, policy }, cfg) => {
    const computers = computersFor(db, cfg);
    return [
      {
        name: "computer-maintain",
        everyMs: 5_000,
        run: async () => {
          const { stopped, restored } = await maintainPass(db, computers, cfg);
          if (stopped.length || restored.length) console.log(`computer: stopped ${stopped.join(", ") || "-"}; restored ${restored.join(", ") || "-"}`);
        },
      },
      { name: "computer-inbox", everyMs: 1_000, run: async () => void (await inboxPass(db, files, computers, ownerId, policy)) },
    ];
  },
  perceive(event, cfg): ToolContent[] {
    const note = inboxNote(event);
    if (note) return [{ type: "text", text: note }];
    if (event.kind !== "job_done") return [];
    const p = event.payload as unknown as JobDonePayload;
    if (p.kind !== COMPUTER_JOB_KIND) return [];
    const dir = sheetsDir(cfg.dataDir, p.jobId);
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".jpg"))
        .sort()
        .map((f) => ({ type: "image" as const, data: readFileSync(join(dir, f)).toString("base64"), mimeType: "image/jpeg" }));
    } catch {
      return [];
    }
  },
});
