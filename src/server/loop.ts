import type { ServerLoop } from "../capabilities/types.ts";

/** Wait `ms`, or less if `signal` aborts first. */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((r) => {
    if (signal.aborted) return r();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      r();
    }
    signal.addEventListener("abort", done, { once: true });
  });

/**
 * What ends a loop's wait early: `kick()` from whoever just wrote what the loop handles (the poller, after it
 * recorded new events, for the waker; a runner child's SIGUSR2, through server/wake.ts, for the sender).
 *
 * A kick while the loop's body runs is kept, and ends the wait after that run at once, so a row written
 * during a pass is not left for the next interval. A run clears it as it starts: it sees everything written
 * before it. Only the loop's own interval is cut short: a longer wait its body asked for (a 429's retry_after)
 * or the backoff after an error is waited out in full.
 */
export class Kick {
  private pending = false;
  private ring: (() => void) | undefined;

  kick(): void {
    this.pending = true;
    this.ring?.();
  }

  /** At the start of a run: what was kicked before it, it handles. */
  clear(): void {
    this.pending = false;
  }

  /** Wait `ms`, or less if `signal` aborts or the loop is kicked (or was, since the run began). */
  sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (this.pending || signal.aborted) return Promise.resolve();
    return new Promise<void>((r) => {
      const t = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(t);
        signal.removeEventListener("abort", done);
        if (self.ring === done) self.ring = undefined;
        r();
      }
      this.ring = done;
      signal.addEventListener("abort", done, { once: true });
    });
  }
}

/**
 * Run `body` forever, `everyMs` apart, until `signal` aborts. `body` may return a longer wait (a 429). A
 * throw is logged and the next run waits longer; it never ends the loop.
 *
 * Polling is the guarantee and a kick only a shortcut. The waker and the sender read the store every
 * `everyMs` whatever happens; with a `kick` (`Kick`) their wait also ends as soon as something is known to
 * be there: the poller kicks the waker after recording new events, and a runner child, which writes from
 * another process, signals the server to kick the sender (server/wake.ts). A kick that is lost (a signal
 * never sent, a child that died first) costs one interval, never a row, since the next poll finds it.
 *
 * The server's own loops and every enabled capability's loops (src/capabilities/) run through this one
 * helper, so they all back off and stop the same way. The wait between runs ends at once when `signal`
 * aborts, so the promise this returns settles as soon as the run in progress (if any) has finished: the
 * server awaits the senders' this way at exit (main.ts), so it never exits in the middle of a send.
 */
export async function loop(name: string, body: () => Promise<number | void>, everyMs: number, signal: AbortSignal, kick?: Kick): Promise<void> {
  while (!signal.aborted) {
    kick?.clear();
    let wait = everyMs;
    // Only the plain interval ends early on a kick; an asked-for wait or an error's backoff does not.
    let kickable = true;
    try {
      const asked = await body();
      if (typeof asked === "number" && asked > wait) {
        wait = asked;
        kickable = false;
      }
    } catch (e) {
      if (signal.aborted) return;
      console.error(`${name}:`, e);
      wait = Math.max(everyMs * 4, 2000);
      kickable = false;
    }
    await (kick && kickable ? kick.sleep(wait, signal) : sleep(wait, signal));
  }
}

/** Start each of `loops` (capability loops) with `loop`; they run until `signal` aborts. */
export function startLoops(loops: readonly ServerLoop[], signal: AbortSignal): void {
  for (const l of loops) void loop(l.name, l.run, l.everyMs, signal);
}
