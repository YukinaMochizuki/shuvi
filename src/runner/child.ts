#!/usr/bin/env bun
/**
 * A runner child: one process per turn, started DETACHED by the server (server/spawn.ts) so that the
 * server can restart (a deploy, a crash) while the turn carries on. That is invariant 3 of
 * docs/design.md: thinking is not interrupted by the body restarting.
 *
 * It talks to nothing but the store: it reads its turn and the events past the cursor, and writes what it
 * says back as pending outbound rows for the server's sender. It never calls Telegram, so a child never
 * needs the bot token and two processes never race to send the same message.
 *
 * With `SHUVI_WARM_RUNNERS` on, the child of a Claude turn may stay after it as its chat's WARM RUNNER, holding a
 * resident Claude Code CLI, and run the chat's next turns as the waker hands them over (runner/warm.ts). It is the
 * same detached process, so it outlives a server restart as a turn's child does.
 *
 * Its signals:
 *   SIGTERM  a stop (`/stop`, `/new` or a switch while a turn runs, the wall-clock limit, a drain's deadline): it
 *            aborts the driver, and the turn closes as `stopped`. A warm runner then exits rather than staying;
 *            an idle one exits at once.
 *   SIGUSR1  a warm runner was handed a turn: look now (it also polls the store).
 *   SIGUSR2  retire: a warm runner exits (once its turn is over, if it is in one).
 * Usage: `bun src/runner/child.ts <turnId>`, or `bun src/runner/child.ts --warm <chatId>` for a TURNLESS start: the
 * server keeping a pinned chat warm starts a runner that opens the chat's CLI and waits, with no turn of its own
 * (run.ts `runWarmStart`). What a turn runs on, and how: runner/run.ts.
 *
 * The handlers are installed BEFORE anything else is loaded, which is why this file is only an entry point and
 * the turn's code is imported dynamically (one `await import` of run.ts): static imports are all loaded and
 * evaluated before a module's own first line runs, and a signal that lands while the child is still loading
 * would otherwise kill it with the default action (each of the three ends a process), so the waker would reap the
 * turn as failed and run it again. Keep this file's static imports at none (`import type` is erased).
 */
import type { RunnerSignals } from "./run.ts";

const ac = new AbortController();
let retired = false;
let wake: (() => void) | null = null;
const poke = () => {
  const w = wake;
  wake = null;
  w?.();
};
process.on("SIGTERM", () => {
  ac.abort();
  poke();
});
process.on("SIGUSR1", poke);
process.on("SIGUSR2", () => {
  retired = true;
  poke();
});

const signals: RunnerSignals = {
  stop: ac.signal,
  retired: () => retired,
  wait: (ms) =>
    new Promise<void>((resolve) => {
      if (ac.signal.aborted || retired) return resolve();
      const t = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    }),
};

const warm = process.argv[2] === "--warm";
const id = Number(process.argv[warm ? 3 : 2]);
if (!Number.isSafeInteger(id)) {
  console.error("usage: child.ts <turnId> | child.ts --warm <chatId>");
  process.exit(2);
}

const { runChild, runWarmStart } = await import("./run.ts");
console.log(warm ? await runWarmStart(id, signals) : await runChild(id, signals));
process.exit(0);
