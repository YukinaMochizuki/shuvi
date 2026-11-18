import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The release log's one format, and its writer (./log.ts reads and parses it). Nothing here imports
 * beyond node: release.yml runs this file before the image is built, with bun but without `bun install`.
 *
 *   bun src/capabilities/releases/git.ts > release-log.txt
 *
 * writes this checkout's log in that format. A shallow clone would write a log that stops short without
 * saying so, so it is refused (release.yml checks out with fetch-depth: 0).
 */

/** Between records, and between a record's fields. Neither occurs in a commit message. */
export const RS = "\x1e";
export const US = "\x1f";

/**
 * hash, committer date, parents, subject, body, then the files it touched, for main's first parents only
 * (a merge commit's files are its diff against its first parent: the whole branch it merged).
 */
export const GIT_LOG_ARGS = ["log", "--first-parent", "--diff-merges=first-parent", "--name-only", `--format=${RS}%H${US}%cI${US}%P${US}%s${US}%b${US}`] as const;

/** The code root: the directory holding src/ (and, in the image, release-log.txt). */
export const CODE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** `git log` of a checkout from `rev` (default HEAD), in the one format. Throws when git fails. */
export function gitLog(dir: string, rev?: string): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...GIT_LOG_ARGS, ...(rev ? [rev, "--"] : [])], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git log failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

/** Is this checkout a shallow clone (its log would stop short)? */
export function isShallow(dir: string): boolean {
  const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--is-shallow-repository"], { stderr: "ignore" });
  return r.stdout.toString().trim() === "true";
}

if (import.meta.main) {
  if (isShallow(CODE_ROOT)) {
    console.error("release log: this is a shallow clone; fetch the whole history (actions/checkout fetch-depth: 0)");
    process.exit(1);
  }
  process.stdout.write(gitLog(CODE_ROOT));
}
