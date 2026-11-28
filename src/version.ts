import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The checkout this code runs from (src/..). */
export const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The commit this server runs: `SHUVI_COMMIT` when the deployment sets it (a build without .git), else
 * `git describe --always --dirty` of the code checkout, read once at startup.
 */
export function deployedCommit(repoDir: string, env: Record<string, string | undefined> = process.env): string {
  if (env.SHUVI_COMMIT) return env.SHUVI_COMMIT;
  const r = Bun.spawnSync(["git", "-C", repoDir, "describe", "--always", "--dirty"], { stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "unknown";
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Variables a process manager or shell sets anew on every start, so they differ between a runner and the next server
 * with nothing about the configuration changed: hashed, they would make every restart retire every warm runner
 * (under systemd, which the README still supports, a server's INVOCATION_ID is new each time). Left out of
 * `runnerConfigHash`; nothing in shuvi reads them.
 *   systemd: INVOCATION_ID, JOURNAL_STREAM, SYSTEMD_EXEC_PID, MANAGERPID, WATCHDOG_PID, WATCHDOG_USEC,
 *            LISTEN_PID, LISTEN_FDS, LISTEN_FDNAMES
 *   a shell: PWD, OLDPWD, SHLVL, _
 */
export const PER_START_VARIABLES: ReadonlySet<string> = new Set([
  "INVOCATION_ID",
  "JOURNAL_STREAM",
  "SYSTEMD_EXEC_PID",
  "MANAGERPID",
  "WATCHDOG_PID",
  "WATCHDOG_USEC",
  "LISTEN_PID",
  "LISTEN_FDS",
  "LISTEN_FDNAMES",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
]);

/**
 * A hash of the configuration a runner child runs with: its WHOLE environment, as the server gives it to every child
 * (server/spawn.ts `childEnv`: the server's own minus the bot tokens), and the ids of the capabilities it enabled.
 * That covers env.ts, every capability's own settings (`enable(env)`), the values of keys (SHUVI_SECRETS_KEY), and
 * what the resident Claude CLI inherits. Names are sorted and each VALUE is replaced by its own sha256 before the
 * whole is hashed, so the stored hash holds nothing secret. Variables set anew on every start (`PER_START_VARIABLES`)
 * are left out. The server computes it over `childEnv()` of its own
 * environment, the runner over `childEnv()` of its (the same variables) at its start, before anything runs. A warm
 * runner records its own (store/warm.ts `config_hash`); a server with another one retires it, at start and at a
 * hand-off (server/warm.ts, store/turns.ts `claimTurn`), as for other code.
 */
export function runnerConfigHash(env: Record<string, string | undefined>, capabilityIds: readonly string[]): string {
  const vars = Object.keys(env)
    .filter((k) => env[k] !== undefined && !PER_START_VARIABLES.has(k))
    .sort()
    .map((k) => [k, sha256(env[k]!)]);
  return sha256(JSON.stringify({ env: vars, capabilities: [...capabilityIds] }));
}

/**
 * The version of the code a process runs, for telling a warm runner started by other code (runner/warm.ts,
 * server/warm.ts): `deployedCommit`, or the package's version where there is neither `SHUVI_COMMIT` nor .git.
 */
export function codeVersion(env: Record<string, string | undefined> = process.env, repoDir: string = REPO_DIR): string {
  const commit = deployedCommit(repoDir, env);
  if (commit !== "unknown") return commit;
  try {
    return `package ${(JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8")) as { version?: string }).version ?? "unknown"}`;
  } catch {
    return "unknown";
  }
}
