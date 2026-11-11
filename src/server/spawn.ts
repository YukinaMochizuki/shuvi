import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "../runner/child.ts");

/**
 * Start the runner child for a turn, DETACHED: its lifetime is tied to neither this process nor its
 * process group, which is the whole mechanism by which a turn outlives a server restart.
 *
 * Under systemd that also needs the unit's `KillMode=process`, or stopping the unit kills every process
 * in its cgroup, detached or not (see the README's deploy notes). There is no separate supervisor process
 * here (workstream has one); a turn's liveness is its row's pid, which the waker checks.
 *
 * The child gets the server's environment minus the bot token: it never talks to Telegram.
 */
export type SpawnTurn = (turnId: number) => number;

export const spawnTurn: SpawnTurn = (turnId) => {
  const env = { ...process.env };
  delete env.SHUVI_BOT_TOKEN;
  const proc = Bun.spawn([process.execPath, CHILD, String(turnId)], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    detached: true,
    env,
  });
  proc.unref();
  return proc.pid;
};

/** Is a process alive? (Signal 0 checks without sending anything.) */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but is not ours, which for a child we spawned does not happen; treat as alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
