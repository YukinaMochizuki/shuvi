import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "../runner/child.ts");

/**
 * Start the runner child for a turn, DETACHED: its lifetime is tied to neither this process nor its
 * process group, which is the whole mechanism by which a turn outlives a server restart.
 *
 * Under systemd that also needs the unit's `KillMode=process`, or stopping the unit kills every process
 * in its cgroup, detached or not (see the README's deploy notes). In a container nothing outlives the
 * server, so a stop drains instead (drain.ts): the server waits for its turns before it exits, and `tini`
 * (PID 1) reaps a child whose server has gone. There is no separate supervisor process
 * here (workstream has one); a turn's liveness is its row's pid AND that pid's process start time
 * (`/proc/<pid>/stat`, field 22), both recorded at spawn. A pid alone is not enough: once the child is gone
 * the kernel may hand the same pid to an unrelated process, which would keep a dead turn "running"
 * forever and make a `/stop` signal a stranger. So a pid counts as the turn's only while its start time
 * still matches (`isAlive`), and a signal is sent only then (`signalTurn`). Where /proc is not available
 * the start time is null and the check falls back to the pid alone.
 *
 * The child gets the server's environment minus the bot tokens: it never talks to Telegram. It runs in the
 * server's working directory, and Claude Code files a session under the directory it runs in: a session
 * agent/switch.ts makes is placed for this same one.
 */
export type SpawnTurn = (turnId: number) => number;

export const spawnTurn: SpawnTurn = (turnId) => {
  const env = { ...process.env };
  delete env.SHUVI_BOT_TOKEN;
  delete env.SHUVI_CONTROL_BOT_TOKEN;
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

/**
 * A process's start time, in clock ticks since boot (field 22 of /proc/<pid>/stat), or null when there is
 * no such process or no /proc. The second field (the command name) is in parentheses and may itself hold
 * spaces and parentheses, so the fields are counted from the LAST `)`.
 */
export function processStart(pid: number): string | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  // An exited child its parent has not reaped yet (a zombie) still has a stat file; it is not running.
  if (stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z") return null;
  return parseStartTime(stat);
}

export function parseStartTime(stat: string): string | null {
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  // `rest` starts at field 3 (state), so field 22 is at index 19.
  return rest[19] ?? null;
}

const hasProc = (() => {
  try {
    readFileSync("/proc/self/stat", "utf8");
    return true;
  } catch {
    return false;
  }
})();

/**
 * Is the turn's process alive? With a recorded start time, only if `pid` exists AND started at that time.
 * Without one (no /proc at spawn), signal 0 checks the pid alone.
 */
export function isAlive(pid: number, start: string | null = null): boolean {
  if (start != null && hasProc) return processStart(pid) === start;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but is not ours, which for a child we spawned does not happen; treat as alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type SignalTurn = (pid: number, start: string | null, signal: "SIGTERM" | "SIGKILL") => void;

/** Signal a turn's process, but only if it is still that process. A process already gone is not an error. */
export const signalTurn: SignalTurn = (pid, start, signal) => {
  if (!isAlive(pid, start)) return;
  try {
    process.kill(pid, signal);
  } catch {
    // gone in between: the waker reaps it
  }
};
