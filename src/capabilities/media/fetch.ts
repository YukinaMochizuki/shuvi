import { describe, Porchkit, PorchkitError, type FetchStatus } from "../../porchkit/client.ts";
import type { Db } from "../../store/db.ts";
import { getChat } from "../../store/events.ts";
import { createJob, runningJobs, updateJobSpec, type Job, type JobKind, type JobPoll } from "../../store/jobs.ts";
import { HOME_DIR, type ComputerConfig } from "../computer/config.ts";
import { computersFor } from "../computer/index.ts";
import { shq } from "../computer/exec.ts";
import { getComputer } from "../computer/state.ts";

/**
 * `video_fetch`: porchkit downloads the video into its file cache, and a `video_fetch` job (polled by the jobs
 * watcher, like every job: store/jobs.ts) brings it onto the chat's computer:
 *
 *   1. porchkit's download is polled (`GET /media/fetch/<key>`) until it is done, or failed (the job fails
 *      with porchkit's reason, in words: client.ts `describe`);
 *   2. then `GET /files/<key>` is streamed into `~/inbox/<name>.part` in ranges of `CHUNK` bytes, each
 *      appended over an exec's stdin (the token never goes near the computer), for at most `COPY_SLICE_MS`
 *      per poll so a large file does not hold the watcher;
 *   3. RESUMABLE: each poll starts from the size of the `.part` file on the computer (the truth, whatever the
 *      store says), so a restart of the server, the computer, or a failed range just carries on;
 *   4. complete, it is renamed into place, and the job ends `done` with the path: the `job_done` event in
 *      the chat that asked.
 */

export const FETCH_JOB_KIND = "video_fetch";
/** porchkit's key for a download (hex): checked before it goes into a URL path or a file name. */
export const FETCH_KEY = /^[0-9a-f]{32}$/;
/** Bytes per range request (and per exec appending it). */
export const CHUNK = 8 << 20;
/** How long one poll copies before it lets the watcher go on (the rest at the next poll). */
export const COPY_SLICE_MS = 45_000;
/** A fetch job's deadline: porchkit's own download limit is an hour; the copy needs a while after that. */
export const FETCH_DEADLINE_MS = 3 * 3600_000;

const EXT: Record<string, string> = { "video/mp4": "mp4", "video/webm": "webm", "video/x-matroska": "mkv", "audio/mp4": "m4a" };
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

interface FetchSpec {
  key: string;
  quality: "low" | "best";
  /** From the home directory: `inbox/video-<key>.mp4`, decided at the first range. */
  path?: string;
  total?: number;
}

/** Start porchkit's download and the job that brings it onto the computer. Returns the tool's text. */
export async function startFetch(db: Db, porch: Porchkit, a: { chatId: number; originSeq: number; url: string; quality?: "low" | "best"; title: string }): Promise<{ ok: true; text: string; job: Job } | { ok: false; text: string }> {
  let st: FetchStatus;
  try {
    st = await porch.fetch(a.url, a.quality);
  } catch (e) {
    return { ok: false, text: describe(e) };
  }
  if (st.state === "failed") return { ok: false, text: failedText(st) };
  if (!FETCH_KEY.test(st.key ?? "")) return { ok: false, text: "The media service answered with a download key that is not its own; nothing was started." };
  // The same download (same link and quality) already on its way to this chat's computer: join it.
  const same = runningJobs(db).find((j) => j.kind === FETCH_JOB_KIND && j.chatId === a.chatId && (j.spec as unknown as FetchSpec).key === st.key);
  if (same) {
    return {
      ok: true,
      job: same,
      text: `That video is already on its way to your computer as job ${same.id}; its result, with the file's path, comes back to this chat as a job event. End your turn meanwhile; do not wait or poll for it.`,
    };
  }
  const spec: FetchSpec = { key: st.key, quality: a.quality ?? "low" };
  const { job } = createJob(db, {
    chatId: a.chatId,
    originSeq: a.originSeq,
    kind: FETCH_JOB_KIND,
    title: a.title,
    report: "poll",
    spec: spec as unknown as Record<string, unknown>,
    deadline: new Date(Date.now() + FETCH_DEADLINE_MS),
    // video_fetch is owner-only: the boundary let this call run only with the owner in the turn.
    ownerAuthorised: true,
  });
  const where = st.state === "done" ? "it is already downloaded there" : `it is ${st.state === "queued" ? "queued" : "downloading"} there`;
  return {
    ok: true,
    job,
    text: `Started job ${job.id} in the background: the media service fetches the video (${where}), then it is copied into ~/inbox/ on your computer. Its result, with the file's path, comes back to this chat as a job event when it is there. End your turn meanwhile; do not wait or poll for it.`,
  };
}

function failedText(st: FetchStatus): string {
  const e = st.error;
  if (!e) return "The download failed (the media service gave no reason).";
  return describe(new PorchkitError(0, e.error, e.detail ?? "", e as Record<string, unknown>, e.retry_after));
}

/** The jobs watcher's poll of a fetch: porchkit's progress, then a slice of the copy. */
export function fetchJobKind(porch: Porchkit, computer: ComputerConfig | null): JobKind {
  return {
    kind: FETCH_JOB_KIND,
    pollEveryMs: computer?.pollEveryMs ?? 5_000,
    pollTimeoutMs: COPY_SLICE_MS + 60_000,
    async poll(job, signal, db): Promise<JobPoll> {
      const spec = job.spec as unknown as FetchSpec;
      let st: FetchStatus;
      try {
        st = await porch.fetchStatus(spec.key, signal);
      } catch (e) {
        // Gone from porchkit's cache (expired, evicted) or never known: final. Anything else is retried.
        if (e instanceof PorchkitError && e.code === "not_found") return { state: "failed", result: `The download is gone from the media service (${e.detail}); ask for it again.` };
        throw e;
      }
      if (st.state === "failed") return { state: "failed", result: failedText(st) };
      if (st.state !== "done") return { state: "running", note: `downloading: ${st.bytes ? mb(st.bytes) : "0 MB"}${st.total ? ` of ${mb(st.total)}` : ""}` };
      if (!computer) return { state: "failed", result: "The video is downloaded, but this chat's computer is off, so it could not be copied there." };
      const chat = getChat(db, job.chatId);
      if (!chat) return { state: "failed", result: "The chat is gone." };
      const computers = computersFor(db, computer);
      const { value } = await computers.withLease(chat, COPY_SLICE_MS + 60_000, () => copySlice(db, job, spec, porch, computers.hangar, getComputer(db, chat.id)!.container, signal));
      return value;
    },
  };
}

type Runner = { run(container: string, req: { command: string[]; workingDir?: string; stdin?: Uint8Array }): Promise<{ code: number; stdout: Uint8Array; stderr: string }> };

/**
 * Copy ranges into this job's own `.part-<job id>` for up to `COPY_SLICE_MS`; rename it into place once
 * complete, and check the size of what landed. One part file per job, so two jobs of one file (which
 * `startFetch` avoids, but a race between two turns could still make) never append to the same file.
 */
export async function copySlice(db: Db, job: Job, spec: FetchSpec, porch: Porchkit, hangar: Runner, container: string, signal?: AbortSignal, sliceMs = COPY_SLICE_MS): Promise<JobPoll> {
  const run = async (script: string, stdin?: Uint8Array) => {
    const r = await hangar.run(container, { command: ["bash", "-c", script], workingDir: HOME_DIR, ...(stdin ? { stdin } : {}) });
    if (r.code !== 0) throw new Error(`the copy onto the computer failed (exit ${r.code}): ${r.stderr.trim().slice(0, 300)}`);
    return Buffer.from(r.stdout).toString("utf8").trim();
  };
  let path = spec.path;
  let total = spec.total;
  if (!FETCH_KEY.test(spec.key)) return { state: "failed", result: "The download's key is not the media service's; nothing was copied." };
  if (!path || total === undefined) {
    // The first range names the file (its type) and says its size.
    const first = await porch.fileRange(spec.key, 0, 0, signal);
    const ext = EXT[(first.type ?? "").split(";")[0]!.trim()] ?? "mp4";
    path = `inbox/video-${spec.key.slice(0, 12)}.${ext}`;
    total = first.total ?? undefined;
    if (total === undefined) throw new Error("the media service did not say how large the file is");
    updateJobSpec(db, job.id, { path, total });
  }
  const done = () => ({ state: "done" as const, result: `Saved on your computer as ~/${path} (${mb(total!)}).` });
  const part = `${path}.part-${job.id}`;
  // The file in place already, at its full size (another job of it finished): done. At another size: not
  // to be trusted, so it is replaced.
  const there = await run(
    `set -e; cd ~; mkdir -p inbox; if [ -f ${shq(path)} ]; then echo "final $(stat -c %s -- ${shq(path)})"; fi; if [ -f ${shq(part)} ]; then stat -c %s -- ${shq(part)}; else echo 0; fi`,
  );
  const lines = there.split("\n");
  const final = lines[0]!.startsWith("final ") ? Number(lines.shift()!.slice(6)) : undefined;
  if (final === total) {
    await run(`rm -f -- ${shq(part)}`);
    return done();
  }
  let offset = Number(lines[0]) || 0;
  if (offset > total) {
    // Longer than the file: not ours to trust; start over.
    await run(`rm -f -- ${shq(part)}`);
    offset = 0;
  }
  const end = Date.now() + sliceMs;
  while (offset < total && Date.now() < end) {
    signal?.throwIfAborted();
    const last = Math.min(offset + CHUNK, total) - 1;
    const r = await porch.fileRange(spec.key, offset, last, signal);
    if (!r.bytes.length) throw new Error("the media service sent an empty range");
    await run(`set -e; cd ~; cat >> ${shq(part)}`, r.bytes);
    offset += r.bytes.length;
  }
  if (offset < total) return { state: "running", note: `copying to the computer: ${mb(offset)} of ${mb(total)}` };
  const landed = Number(await run(`set -e; cd ~; mv -f -- ${shq(part)} ${shq(path)}; stat -c %s -- ${shq(path)}`));
  if (landed !== total) {
    // Not what was sent: drop it, and the next poll copies it again from the start.
    await run(`rm -f -- ${shq(path)}`);
    throw new Error(`the copy came out at ${landed} bytes, not ${total}; it is copied again`);
  }
  return done();
}
