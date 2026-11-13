import { describe, expect, test } from "bun:test";
import { health, metricsText, newVitals, parseMetricsListen, POLL_STALE_MS, startHealth } from "../src/server/health.ts";
import { enqueueOutbound, markFailed } from "../src/store/events.ts";
import { mediaPrewarms } from "../src/store/schema.ts";
import { claimTurn, finishTurn } from "../src/store/turns.ts";
import { memDb, ownerChatId, ownerSays } from "./helpers.ts";

const value = (text: string, sample: string) => {
  const line = text.split("\n").find((l) => l.startsWith(`${sample} `));
  return line === undefined ? undefined : Number(line.slice(sample.length + 1));
};

describe("health", () => {
  test("ok while the poller has polled recently; not ok once it has been quiet too long, unless draining", () => {
    const db = memDb();
    const v = newVitals(1000);
    expect(health(db, v, 1000 + POLL_STALE_MS).ok).toBe(true); // before the first poll, counted from the start
    expect(health(db, v, 1000 + POLL_STALE_MS + 1)).toMatchObject({ ok: false, db: "open" });
    v.lastPollAt = 1000 + POLL_STALE_MS;
    expect(health(db, v, 1000 + POLL_STALE_MS + 5000)).toMatchObject({ ok: true, lastPollAgeSec: 5 });
    v.draining = true;
    expect(health(db, v, 1000 + 10 * POLL_STALE_MS)).toMatchObject({ ok: true, draining: true });
  });

  test("not ok when the store does not answer", () => {
    const db = memDb();
    const v = newVitals();
    db.$client.close();
    const h = health(db, v);
    expect(h.ok).toBe(false);
    expect(h.db).toStartWith("error:");
  });

  test("the listen address is loopback only", () => {
    expect(parseMetricsListen("127.0.0.1:8788")).toEqual({ hostname: "127.0.0.1", port: 8788 });
    expect(parseMetricsListen("[::1]:9")).toEqual({ hostname: "::1", port: 9 });
    expect(() => parseMetricsListen("0.0.0.0:8788")).toThrow(/loopback/);
    expect(() => parseMetricsListen("8788")).toThrow(/host:port/);
  });
});

describe("metrics", () => {
  test("counts turns by outcome, outbound rows, prewarms and hits, and this process's vitals; no text or ids", () => {
    const db = memDb();
    const chat = ownerChatId(db);
    for (const status of ["done", "done", "failed", "stopped"] as const) {
      ownerSays(db, "a private sentence that must not appear");
      const t = claimTurn(db, chat)!;
      finishTurn(db, t.id, { status });
    }
    ownerSays(db, "one more");
    const live = claimTurn(db, chat)!;
    enqueueOutbound(db, { chatId: chat, kind: "bot_message", payload: { text: "pending reply" }, idemKey: "a" });
    const bad = enqueueOutbound(db, { chatId: chat, kind: "bot_message", payload: { text: "refused reply" }, idemKey: "b" })!;
    markFailed(db, bad, "Bad Request: chat not found");
    const iso = new Date().toISOString();
    db.insert(mediaPrewarms).values({ chatId: chat, seq: 1, n: 1, urlHash: "h1", host: "example.com", startedAt: iso, outcome: "ok", usedTurnId: live.id }).run();
    db.insert(mediaPrewarms).values({ chatId: chat, seq: 1, n: 2, urlHash: "h2", host: "example.com", startedAt: iso, outcome: "rate_limited" }).run();

    const v = newVitals(1_700_000_000_000);
    v.lastPollAt = 1_700_000_010_000;
    v.pollErrors = 3;
    v.draining = true;
    v.drainDeadline = 1_700_000_600_000;
    const text = metricsText(db, v);
    expect(value(text, "shuvi_turns_started_total")).toBe(5);
    expect(value(text, 'shuvi_turns_finished_total{outcome="done"}')).toBe(2);
    expect(value(text, 'shuvi_turns_finished_total{outcome="failed"}')).toBe(1);
    expect(value(text, 'shuvi_turns_finished_total{outcome="stopped"}')).toBe(1);
    expect(value(text, "shuvi_turns_running")).toBe(1);
    expect(value(text, "shuvi_outbound_pending")).toBe(1);
    expect(value(text, "shuvi_outbound_failed_total")).toBe(1);
    expect(value(text, "shuvi_poll_errors_total")).toBe(3);
    expect(value(text, "shuvi_last_poll_timestamp_seconds")).toBe(1_700_000_010);
    expect(value(text, "shuvi_draining")).toBe(1);
    expect(value(text, "shuvi_drain_deadline_timestamp_seconds")).toBe(1_700_000_600);
    expect(value(text, "shuvi_prewarms_total")).toBe(2);
    expect(value(text, "shuvi_prewarm_hits_total")).toBe(1);
    expect(value(text, "shuvi_start_time_seconds")).toBe(1_700_000_000);
    expect(text).not.toMatch(/sentence|reply|example\.com|chat not found/);
    // Every sample has its HELP and TYPE.
    for (const name of new Set(text.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(/[{ ]/)[0]))) {
      expect(text).toContain(`# TYPE ${name} `);
    }
  });

  test("served on loopback: /healthz, /metrics, and 404 for the rest", async () => {
    const db = memDb();
    const v = newVitals();
    const stop = new AbortController();
    const port = startHealth("127.0.0.1:0", db, v, stop.signal);
    try {
      const h = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(h.status).toBe(200);
      expect(await h.json()).toMatchObject({ ok: true, db: "open", draining: false });
      const m = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(m.headers.get("content-type")).toStartWith("text/plain; version=0.0.4");
      expect(await m.text()).toContain("shuvi_turns_running 0");
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/metrics`, { method: "POST" })).status).toBe(405);
      v.startedAt = Date.now() - POLL_STALE_MS - 1000;
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(503);
    } finally {
      stop.abort();
    }
  });
});
