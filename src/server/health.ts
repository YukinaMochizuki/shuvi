import { parseMetricsListen } from "../env.ts";
import type { Db } from "../store/db.ts";
import { OUTBOUND_KINDS } from "../store/schema.ts";

/**
 * The server's health and metrics endpoint, for the container and for Prometheus: `SHUVI_METRICS_LISTEN`
 * (default 127.0.0.1:8788), LOOPBACK ONLY like the console: anything else is refused at startup, by
 * `loadConfig` (src/env.ts). It is always on: the image's HEALTHCHECK calls it.
 *
 * Loopback in a container is the container's own network namespace, so nothing outside it can scrape this
 * directly. It is reached the way the console is: a tailnet sidecar sharing that namespace publishes it with
 * `tailscale serve` (deployment config, not this repository), and Prometheus scrapes it over the tailnet.
 *
 *   GET /healthz   200 when the store answers and the Telegram poller has completed a poll within
 *                  `POLL_STALE_MS` (or the server is draining, when the poller is stopped on purpose);
 *                  503 otherwise. A small JSON body says which.
 *   GET /metrics   Prometheus text: counts and times only, never a URL, a chat or a word of text.
 *
 * The metrics (docs/design.md §16 lists them too):
 *
 *   shuvi_turns_started_total                       counter  turns claimed (rows in `turns`)
 *   shuvi_turns_finished_total{outcome}             counter  turns closed, by outcome: done, stopped, failed
 *   shuvi_turns_running                             gauge    turns running now
 *   shuvi_outbound_pending                          gauge    messages, reactions, stickers… waiting to be sent
 *   shuvi_outbound_failed_total                     counter  outbound rows Telegram refused for good
 *   shuvi_poll_errors_total                         counter  failed Telegram long polls, since this process started
 *   shuvi_last_poll_timestamp_seconds               gauge    when the last long poll completed (0: none yet)
 *   shuvi_draining                                  gauge    1 while the server drains for a shutdown
 *   shuvi_drain_deadline_timestamp_seconds          gauge    when the drain stops what still runs (0: not draining)
 *   shuvi_prewarms_total                            counter  links prewarmed through porchkit (media)
 *   shuvi_prewarm_hits_total                        counter  of those, the ones a turn's video_probe used
 *   shuvi_start_time_seconds                        gauge    when this server process started
 *
 * The turn, outbound and prewarm counts are read from the store at each scrape, so they are the same
 * whichever process wrote the rows (a runner child closes its own turn) and survive a restart. The poll
 * counters are this process's own, and restart from zero with it, as Prometheus counters may.
 */

/** A poller that has not completed a long poll for this long is not alive (a poll is 25 s at most). */
export const POLL_STALE_MS = 120_000;

/** What the server's loops tell the endpoint; main.ts owns the one instance. */
export interface Vitals {
  startedAt: number;
  /** The last completed Telegram long poll. */
  lastPollAt: number | null;
  pollErrors: number;
  draining: boolean;
  drainDeadline: number | null;
}

export const newVitals = (now = Date.now()): Vitals => ({ startedAt: now, lastPollAt: null, pollErrors: 0, draining: false, drainDeadline: null });

export { parseMetricsListen };

export interface Health {
  ok: boolean;
  db: "open" | string;
  draining: boolean;
  /** Seconds since the last completed poll (since the start, before the first one). */
  lastPollAgeSec: number;
}

export function health(db: Db, v: Vitals, now = Date.now()): Health {
  let dbState = "open";
  try {
    db.$client.query("select 1").get();
  } catch (e) {
    dbState = `error: ${e instanceof Error ? e.message : String(e)}`;
  }
  const age = now - (v.lastPollAt ?? v.startedAt);
  const pollerOk = v.draining || age <= POLL_STALE_MS;
  return { ok: dbState === "open" && pollerOk, db: dbState, draining: v.draining, lastPollAgeSec: Math.round(age / 1000) };
}

const n = (x: unknown) => Number(x ?? 0);

/** The Prometheus exposition of the store's counts and `v`. */
export function metricsText(db: Db, v: Vitals): string {
  const c = db.$client;
  const byStatus = new Map((c.query("select status, count(*) as n from turns group by status").all() as { status: string; n: number }[]).map((r) => [r.status, r.n]));
  const started = [...byStatus.values()].reduce((a, b) => a + b, 0);
  const kinds = OUTBOUND_KINDS.map(() => "?").join(", ");
  const outbound = new Map(
    (c.query(`select status, count(*) as n from chat_events where status in ('pending', 'failed') and kind in (${kinds}) group by status`).all(...OUTBOUND_KINDS) as { status: string; n: number }[]).map((r) => [r.status, r.n]),
  );
  const prewarm = c.query("select count(*) as total, count(used_turn_id) as hits from media_prewarms").get() as { total: number; hits: number };
  const sec = (ms: number | null) => (ms == null ? 0 : ms / 1000);

  const out: string[] = [];
  const metric = (name: string, type: "counter" | "gauge", help: string, samples: Array<[string, number]>) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of samples) out.push(`${name}${labels} ${value}`);
  };
  metric("shuvi_turns_started_total", "counter", "Turns started.", [["", started]]);
  metric(
    "shuvi_turns_finished_total",
    "counter",
    "Turns finished, by outcome.",
    (["done", "stopped", "failed"] as const).map((o) => [`{outcome="${o}"}`, n(byStatus.get(o))]),
  );
  metric("shuvi_turns_running", "gauge", "Turns running now.", [["", n(byStatus.get("running"))]]);
  metric("shuvi_outbound_pending", "gauge", "Outbound rows waiting to be sent.", [["", n(outbound.get("pending"))]]);
  metric("shuvi_outbound_failed_total", "counter", "Outbound rows Telegram refused for good.", [["", n(outbound.get("failed"))]]);
  metric("shuvi_poll_errors_total", "counter", "Failed Telegram long polls since this process started.", [["", v.pollErrors]]);
  metric("shuvi_last_poll_timestamp_seconds", "gauge", "When the last Telegram long poll completed (0: none yet).", [["", sec(v.lastPollAt)]]);
  metric("shuvi_draining", "gauge", "1 while the server drains for a shutdown.", [["", v.draining ? 1 : 0]]);
  metric("shuvi_drain_deadline_timestamp_seconds", "gauge", "When the drain stops the turns still running (0: not draining).", [["", sec(v.drainDeadline)]]);
  metric("shuvi_prewarms_total", "counter", "Links prewarmed through porchkit.", [["", n(prewarm.total)]]);
  metric("shuvi_prewarm_hits_total", "counter", "Prewarmed links a turn then used.", [["", n(prewarm.hits)]]);
  metric("shuvi_start_time_seconds", "gauge", "When this server process started.", [["", sec(v.startedAt)]]);
  return `${out.join("\n")}\n`;
}

/** Serve /healthz and /metrics on `listen` (loopback) until `signal` aborts. Returns the bound port. */
export function startHealth(listen: string, db: Db, v: Vitals, signal: AbortSignal): number {
  const { hostname, port } = parseMetricsListen(listen);
  const server = Bun.serve({
    hostname,
    port,
    fetch(req) {
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed\n", { status: 405 });
      const path = new URL(req.url).pathname;
      if (path === "/healthz") {
        const h = health(db, v);
        return Response.json(h, { status: h.ok ? 200 : 503 });
      }
      if (path === "/metrics") return new Response(metricsText(db, v), { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" } });
      return new Response("not found\n", { status: 404 });
    },
  });
  signal.addEventListener("abort", () => void server.stop(true), { once: true });
  return server.port ?? port;
}
