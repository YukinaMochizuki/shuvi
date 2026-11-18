import { fileURLToPath } from "node:url";
import type { ModelChoice } from "agent-runtime";
import { listClaudeModels } from "agent-runtime/claude";
import { childEnv } from "./spawn.ts";

/**
 * What Claude Code offers a Claude login (agent-runtime `listClaudeModels`), asked in a CHILD process, never in
 * the server: the CLI it starts gets the environment the runner child gets (spawn.ts `childEnv`: no bot
 * token), and the child's process group, CLI and all, is killed when the listing ends: at once when it is
 * cancelled or outlasts its time (which `listClaudeModels` itself, taking no signal, cannot do), and after it
 * has printed otherwise. The child prints the list as JSON and exits.
 *
 *   bun src/server/list-claude.ts [<config_dir>]
 */

const SELF = fileURLToPath(import.meta.url);

/** The login at `configDir` (null: the server user's), listed in a child; rejects when `signal` aborts, killing it. */
export async function listClaudeInChild(configDir: string | null, signal: AbortSignal): Promise<ModelChoice[]> {
  signal.throwIfAborted();
  // Its own process group (`detached`), so a kill reaches the CLI it started too, not only the child. The group
  // is killed however the listing ends: the child exits as soon as it has printed, and the CLI its query started
  // outlives it otherwise (seen: still running after a finished listing).
  const proc = Bun.spawn([process.execPath, SELF, ...(configDir ? [configDir] : [])], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: childEnv(), detached: true });
  const kill = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // already gone
    }
  };
  signal.addEventListener("abort", kill, { once: true });
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    signal.throwIfAborted();
    if (code !== 0) throw new Error(err.trim().split("\n").at(-1) || `the listing exited with code ${code}`);
    return JSON.parse(out) as ModelChoice[];
  } finally {
    signal.removeEventListener("abort", kill);
    kill();
  }
}

if (import.meta.main) {
  try {
    process.stdout.write(JSON.stringify(await listClaudeModels(process.argv[2] || null)));
    process.exit(0);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
