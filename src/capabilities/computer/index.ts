import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { err, ok, type ToolContent, type ToolDef, type ToolResult } from "agent-runtime";
import type { Db } from "../../store/db.ts";
import type { JobDonePayload } from "../../store/events.ts";
import { getJob } from "../../store/jobs.ts";
import { raiseAlert } from "../../store/control.ts";
import { getChat, getEvent } from "../../store/events.ts";
import { chatLabel } from "../../store/turns.ts";
import { updateAttachment } from "../../store/media.ts";
import { attachmentOfEvent } from "../../store/media.ts";
import { defineCapability } from "../types.ts";
import { computerConfig, sizeLabel, type ComputerConfig, type Size } from "./config.ts";
import { ComputerError, Computers } from "./computer.ts";
import { BOOST_TERMS, cancelJob, computerJobKind, framesDir, framesScript, parseFrames, readJob, runSync, startJob, syncCommand, type ExecContext } from "./exec.ts";
import { awaitInbox, inboxNote, inboxPass, sendFromComputer } from "./files.ts";
import { framesCommand, MAX_FRAMES, transcribeCommand } from "./media.ts";
import { liveGrants, requestSecret, syncGrants, TTLS, type Ttl } from "./secrets.ts";
import { allComputers, COMPUTER_JOB_KIND, hasLiveLease, opHeld, acquireOp, releaseOp, runningComputerJobs } from "./state.ts";

/**
 * The computer: each chat's own machine on Hangar (docs/design.md §15), with its home on a disk of its own,
 * started when needed and stopped when idle. What it brings:
 *
 *   tools     exec, read_job, cancel_job (exec.ts, after workstream's box tools); request_secret
 *             (secrets.ts); send_file, send_photo (files.ts); video_frames, transcribe (media.ts). All act
 *             for the owner (`ownerOnly`), under the one rule every owner-only tool shares
 *             (`ownerAuthority` in src/agent/turn.ts): the turn's boundary refuses them unless the owner
 *             is in the turn; other people's messages beside his neither grant nor block.
 *   jobs      the `computer` job kind: background execs, polled by the jobs watcher (exec.ts).
 *   loops     `computer-maintain`: stop a computer idle for SHUVI_COMPUTER_IDLE_MINUTES (no exec, no job
 *             running), put a boosted one back at its size once its job (or exec) is over, and turn
 *             answered secret cards into grants; `computer-inbox`: copy files people send into ~/inbox.
 *   inbox     the owner's files are copied into ~/inbox when the computer next runs, never starting it for
 *             that; a tool that needs the computer waits up to SHUVI_COMPUTER_INBOX_WAIT_SEC for them. Photos
 *             only on `save_photo` (files.ts).
 *   perceive  after a message's line, where its file is on the computer; after a frames job's result, the
 *             frames, as images.
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
 *   SHUVI_COMPUTER_TRANSCRIBE_CPU / _MEMORY   transcribe's boost (default 4 / 8Gi)
 *   SHUVI_COMPUTER_WHISPER_MODEL  faster-whisper's model (default small)
 *   SHUVI_COMPUTER_INBOX_WAIT_SEC how long a turn waits for a sent file to land in ~/inbox (default 30)
 *   SHUVI_SECRETS_FILE            the secret profiles (default /etc/shuvi.secrets.yaml, mode 600)
 */

export const COMPUTER = `## Your computer

This chat has a computer of its own: a Linux machine (Debian, with python3, pip, node, ffmpeg, yt-dlp, git, curl, jq, sqlite3, faster-whisper) whose home directory, ~, is kept between uses; anything you install or save under ~ stays. It starts when you use it and stops when idle; the first command after a while takes a little longer.

- \`exec\` runs a shell command there. A synchronous exec has a timeout (120 s by default); anything longer goes in the background (\`background: true\` with an honest \`expect_seconds\`): you get a job id at once, the result comes back to this chat as a job event when it ends, and you end your turn meanwhile. Never wait or poll for a job; \`read_job\` is for looking at its output when you need to, \`cancel_job\` stops it.
- \`boost\` runs one command or job on the same computer made larger, for heavy work (it restarts the computer around it).
- Files the owner sends here are copied into ~/inbox/ when the computer next runs (the message says where; your next command waits for them). Photos are not copied unless you ask: \`save_photo\` with the photo's #number. \`send_file\` and \`send_photo\` send a file from the computer to this chat.
- \`video_frames\` and \`transcribe\` do the common media work for you; use them rather than writing ffmpeg or whisper commands yourself.
- Credentials are never on the computer. If a task needs one (an API key), \`request_secret\` asks the owner for a named profile; once granted, its variables are in the environment of your commands here, and their values are hidden from you as [REDACTED:<profile>].`;

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

/** One Computers per store, so a turn's tools and the server's loops share nothing else. */
const shared = new WeakMap<Db, Computers>();
function computersFor(db: Db, cfg: ComputerConfig): Computers {
  let c = shared.get(db);
  if (!c || c.cfg !== cfg) shared.set(db, (c = new Computers(db, cfg)));
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

export const computer = defineCapability<ComputerConfig>({
  id: "computer",
  enable: computerConfig,
  ownerOnly: ["exec", "read_job", "cancel_job", "request_secret", "send_file", "send_photo", "save_photo", "video_frames", "transcribe"],
  tools({ db, chat, state: s }, cfg) {
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
            });
            return ok(text);
          }
          const timeout = Math.min(a.timeout ?? cfg.execDefaultSec, cfg.execMaxSec);
          const capped = a.timeout && a.timeout > cfg.execMaxSec ? ` (timeout capped at ${cfg.execMaxSec}s; use background for longer work)` : "";
          if (!a.boost) {
            const r = await runSync(x, syncCommand(a.command), { timeoutSec: timeout });
            return r.isError ? err(r.text + capped) : ok(r.text + capped);
          }
          await computers.boost(chat, a.boost, null);
          let r;
          try {
            r = await runSync(x, syncCommand(a.command), { timeoutSec: timeout });
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
        try {
          return ok(await cancelJob(x, job));
        } catch (e) {
          return failure(e);
        }
      },
    };

    const requestSecretTool: ToolDef<{ profile: string; ttl: Ttl; reason: string }> = {
      name: "request_secret",
      description:
        "Ask the owner to grant this chat's computer a named secret profile (a set of environment variables, such as an API token) for a while. The owner sees the profile's variable names and your reason, never the values, and answers in their control bot. Their answer arrives in this chat as an approval event; once granted, the variables are in the environment of every exec here until it expires or they revoke it. End your turn after asking.",
      inputSchema: {
        profile: z.string().min(1).describe("The profile's name, e.g. modal"),
        ttl: z.enum(Object.keys(TTLS) as [Ttl, ...Ttl[]]).describe("How long to ask for: 4h, 1d or 3d"),
        reason: z.string().min(1).describe("Why you need it, in a sentence the owner reads"),
      },
      async handler(a) {
        const live = liveGrants(db, chat.id).find((g) => g.profile === a.profile);
        if (live) return ok(`"${a.profile}" is already granted here until ${live.expiresAt.slice(0, 16).replace("T", " ")} UTC; its variables are in your commands' environment.`);
        const r = requestSecret(db, cfg.secretsFile, { chatId: chat.id, profile: a.profile, ttl: a.ttl, reason: a.reason });
        if ("error" in r) return err(r.error);
        return ok(`Asked the owner for "${a.profile}" (${a.ttl}), approval #${r.approvalId}. Their answer comes back to this chat as an approval event. End your turn now; do not wait for it.`);
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

    const videoFrames: ToolDef<{ path: string; n?: number; background?: boolean }> = {
      name: "video_frames",
      description: `Look at a video on the computer: take n frames spread evenly over it (default 6, at most ${MAX_FRAMES}) and get them as images. In the background by default (the frames come back to this chat with the job's result); background: false waits for them (short videos).`,
      inputSchema: {
        path: z.string().min(1).describe("The video's path on the computer, e.g. ~/inbox/123-clip.mp4"),
        n: z.number().int().min(1).max(MAX_FRAMES).optional().describe("How many frames"),
        background: z.boolean().optional().describe("false: wait for the frames (default true)"),
      },
      async handler(a) {
        const n = a.n ?? 6;
        try {
          if (a.background !== false) {
            const { text } = await startJob(x, { spec: { tool: "video_frames", command: framesCommand(a.path, n, '"$SHUVI_JOB.frames"'), frames: n }, title: `video_frames ${oneLine(a.path)} (${n})`, originSeq: s.toSeq });
            return ok(text);
          }
          const script = `${framesCommand(a.path, n, '"$HOME/.cache/shuvi-frames"')} >&2\n${framesScript('"$HOME/.cache/shuvi-frames"')}`;
          const r = await runSync(x, ["bash", "-c", script], { timeoutSec: cfg.execDefaultSec, secrets: false, keepStdout: 32 << 20 });
          if (r.isError) return err(r.text);
          const frames = parseFrames(Buffer.from(r.stdout).toString("utf8"));
          const content: ToolContent[] = [{ type: "text", text: `${frames.length} frame(s) of ${a.path}, in order:` }, ...frames.map((f) => ({ type: "image" as const, data: f.data, mimeType: "image/jpeg" }))];
          return { content };
        } catch (e) {
          return failure(e);
        }
      },
    };

    const transcribe: ToolDef<{ path: string; background?: boolean; boost?: Size }> = {
      name: "transcribe",
      description: `Transcribe the speech in an audio or video file on the computer with faster-whisper (model ${cfg.whisperModel}), writing it to <path>.txt. Runs boosted (${sizeLabel(cfg.transcribeBoost)} unless \`boost\` says otherwise) and in the background by default: the transcript comes back to this chat with the job's result.`,
      inputSchema: {
        path: z.string().min(1).describe("The file's path on the computer, e.g. ~/inbox/123-voice.ogg"),
        background: z.boolean().optional().describe("false: wait for it (short clips only)"),
        boost: sizeSchema.optional(),
      },
      async handler(a) {
        const boost = a.boost ?? cfg.transcribeBoost;
        const command = transcribeCommand(a.path, cfg.whisperModel);
        try {
          if (a.background !== false) {
            const { text } = await startJob(x, { spec: { tool: "transcribe", command, boost, output: `${a.path}.txt` }, title: `transcribe ${oneLine(a.path)}`, originSeq: s.toSeq });
            return ok(text);
          }
          await computers.boost(chat, boost, null);
          let r;
          try {
            r = await runSync(x, ["bash", "-c", command], { timeoutSec: cfg.execMaxSec, secrets: false });
          } finally {
            await computers.restore(chat.id).catch(() => false);
          }
          const text = `${r.text}\n(Transcript written to ${a.path}.txt. ${BOOST_TERMS})`;
          return r.isError ? err(text) : ok(text);
        } catch (e) {
          return failure(e);
        }
      },
    };

    return [{ serverName: "shuvi", tools: [exec, readJobTool, cancelJobTool, requestSecretTool, sendFile, sendPhoto, savePhoto, videoFrames, transcribe] as ToolDef[] }];
  },
  section: () => COMPUTER,
  jobKinds: (cfg) => [computerJobKind(cfg, (db) => computersFor(db, cfg))],
  loops: ({ db, files, ownerId }, cfg) => {
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
      { name: "computer-inbox", everyMs: 1_000, run: async () => void (await inboxPass(db, files, computers, ownerId)) },
    ];
  },
  perceive(event, cfg): ToolContent[] {
    const note = inboxNote(event);
    if (note) return [{ type: "text", text: note }];
    if (event.kind !== "job_done") return [];
    const p = event.payload as unknown as JobDonePayload;
    if (p.kind !== COMPUTER_JOB_KIND) return [];
    const dir = framesDir(cfg.dataDir, p.jobId);
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
