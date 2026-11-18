import type { Porchkit } from "../../porchkit/client.ts";
import { HOME_DIR } from "./config.ts";
import { shq } from "./exec.ts";

/**
 * Copying a file from porchkit's file cache onto a chat's computer, resumably: what video_fetch's job, media's
 * save_link and the computer's browser_save all use. Ranges of the file are appended to a part file in the home
 * directory, from the size it already has, for up to a slice of time; once complete it is renamed into place
 * and its size checked, so a half-copied file is never there under its own name.
 */

/** Bytes per range request (and per exec appending it). */
export const CHUNK = 8 << 20;
/** How long one poll copies before it lets the watcher go on (the rest at the next poll). */
export const COPY_SLICE_MS = 45_000;

export type Runner = { run(container: string, req: { command: string[]; workingDir?: string; stdin?: Uint8Array }): Promise<{ code: number; stdout: Uint8Array; stderr: string }> };

/** A bash script run in the computer's home, its stdout back (trimmed); a non-zero exit throws. */
export type HomeRun = (script: string, stdin?: Uint8Array) => Promise<string>;

export function homeRun(hangar: Runner, container: string): HomeRun {
  return async (script, stdin) => {
    const r = await hangar.run(container, { command: ["bash", "-c", script], workingDir: HOME_DIR, ...(stdin ? { stdin } : {}) });
    if (r.code !== 0) throw new Error(`the copy onto the computer failed (exit ${r.code}): ${r.stderr.trim().slice(0, 300)}`);
    return Buffer.from(r.stdout).toString("utf8").trim();
  };
}

/**
 * The resumable copy itself (media/fetch.ts steps 2 to 4), for any file in porchkit's file cache: ranges of `key`
 * appended to `part` (from the home directory) for up to `sliceMs`, from the size `part` already has; once
 * complete, renamed to `path` and its size checked. A `path` already there at `total` bytes is done at once.
 * video_fetch's job and save_link both copy through it.
 */
export async function copyInto(porch: Porchkit, run: HomeRun, f: { key: string; path: string; part: string; total: number }, signal?: AbortSignal, sliceMs = COPY_SLICE_MS): Promise<{ done: true } | { done: false; offset: number }> {
  const { key, path, part, total } = f;
  // The file in place already, at its full size (another job of it finished): done. At another size: not
  // to be trusted, so it is replaced.
  const there = await run(
    `set -e; cd ~; mkdir -p inbox; if [ -f ${shq(path)} ]; then echo "final $(stat -c %s -- ${shq(path)})"; fi; if [ -f ${shq(part)} ]; then stat -c %s -- ${shq(part)}; else echo 0; fi`,
  );
  const lines = there.split("\n");
  const final = lines[0]!.startsWith("final ") ? Number(lines.shift()!.slice(6)) : undefined;
  if (final === total) {
    await run(`rm -f -- ${shq(part)}`);
    return { done: true };
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
    const r = await porch.fileRange(key, offset, last, signal);
    if (!r.bytes.length) throw new Error("the media service sent an empty range");
    await run(`set -e; cd ~; cat >> ${shq(part)}`, r.bytes);
    offset += r.bytes.length;
  }
  if (offset < total) return { done: false, offset };
  const landed = Number(await run(`set -e; cd ~; mv -f -- ${shq(part)} ${shq(path)}; stat -c %s -- ${shq(path)}`));
  if (landed !== total) {
    // Not what was sent: drop it, and the next poll copies it again from the start.
    await run(`rm -f -- ${shq(path)}`);
    throw new Error(`the copy came out at ${landed} bytes, not ${total}; it is copied again`);
  }
  return { done: true };
}
