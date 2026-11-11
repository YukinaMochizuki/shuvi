import type { ServerLoop } from "../capabilities/types.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `body` forever, `everyMs` apart, until `signal` aborts. The waker and the sender poll the store
 * rather than being signalled: a child writes from another process, and a 300 ms read of a local SQLite
 * file is cheaper than any cross-process wake-up would be to get right. `body` may return a longer wait
 * (a 429). A throw is logged and the next run waits longer; it never ends the loop.
 *
 * The server's own loops and every enabled capability's loops (src/capabilities/) run through this one
 * helper, so they all back off and stop the same way.
 */
export async function loop(name: string, body: () => Promise<number | void>, everyMs: number, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    let wait = everyMs;
    try {
      const asked = await body();
      if (typeof asked === "number" && asked > wait) wait = asked;
    } catch (e) {
      if (signal.aborted) return;
      console.error(`${name}:`, e);
      wait = Math.max(everyMs * 4, 2000);
    }
    await sleep(wait);
  }
}

/** Start each of `loops` (capability loops) with `loop`; they run until `signal` aborts. */
export function startLoops(loops: readonly ServerLoop[], signal: AbortSignal): void {
  for (const l of loops) void loop(l.name, l.run, l.everyMs, signal);
}
