import { describe, expect, test } from "bun:test";
import { loop } from "../src/server/loop.ts";

describe("loop", () => {
  test("awaiting a stopped loop waits for the run in flight, not for the wait after it", async () => {
    const stop = new AbortController();
    let finished = false;
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    // A run that takes 300 ms (a send in flight), then asks for a long wait (a 429's backoff).
    const done = loop(
      "test",
      async () => {
        started();
        await Bun.sleep(300);
        finished = true;
        return 60_000;
      },
      10,
      stop.signal,
    );
    await running;
    const t0 = Date.now();
    stop.abort();
    await done;
    expect(finished).toBe(true); // the send was not cut off
    expect(Date.now() - t0).toBeLessThan(2000); // and the backoff did not hold the exit
  });

  test("an aborted loop runs nothing more", async () => {
    const stop = new AbortController();
    let runs = 0;
    const done = loop("test", async () => void runs++, 5_000, stop.signal);
    await Bun.sleep(20);
    stop.abort();
    await done;
    expect(runs).toBe(1);
  });
});
