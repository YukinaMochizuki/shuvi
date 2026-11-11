import { defineCapability, type Env, type ServerLoop } from "../types.ts";
import { serveHooks } from "./hooks.ts";
import { inboundTokens } from "./inbound.ts";
import { jobWatchPass } from "./watch.ts";

/**
 * Jobs: the machinery under every kind of background work (docs/design.md §10), and the hook endpoints
 * the outside world reports through. It gives the model no tools of its own: a capability that starts
 * work (workstream, later exec) creates the job (store/jobs.ts) and declares its kind (`jobKinds`); this
 * one watches them and takes their reports.
 *
 *   the watcher   polls `poll` jobs, and expires any job past its deadline (watch.ts)
 *   the hooks     POST /jobs/<id>/report and POST /inbound/<source> (hooks.ts, inbound.ts), served only
 *                 when SHUVI_HOOK_LISTEN is set
 *
 *   SHUVI_HOOK_LISTEN            host:port the hooks listen on, meant to be a tailnet address
 *                                (e.g. 100.64.0.5:8787). Unset: no hooks (jobs are still watched)
 *   SHUVI_HOOK_URL               the base URL callers reach the hooks at (default http://<SHUVI_HOOK_LISTEN>),
 *                                for the per-job report URL handed to a callback job
 *   SHUVI_INBOUND_<NAME>_TOKEN   each inbound source's token (inbound.ts); the sources themselves are
 *                                declared in home/inbound.yaml
 */

export interface JobsConfig {
  listen?: string;
  inboundTokens: Record<string, string>;
}

/** How often the watcher looks at the running jobs. Polls themselves are per kind (`pollEveryMs`). */
export const WATCH_EVERY_MS = 1_000;

/** The URL a callback job reports to, from the environment (`SHUVI_HOOK_URL` / `SHUVI_HOOK_LISTEN`). */
export function jobReportUrl(env: Env, jobId: number): string | null {
  const base = env.SHUVI_HOOK_URL ?? (env.SHUVI_HOOK_LISTEN ? `http://${env.SHUVI_HOOK_LISTEN}` : null);
  return base ? `${base.replace(/\/+$/, "")}/jobs/${jobId}/report` : null;
}

export const jobs = defineCapability<JobsConfig>({
  id: "jobs",
  label: "background jobs",
  gives: "the watcher and hooks under background work; no tools of its own.",
  enable: (env) => ({ ...(env.SHUVI_HOOK_LISTEN ? { listen: env.SHUVI_HOOK_LISTEN } : {}), inboundTokens: inboundTokens(env) }),
  loops(ctx, config) {
    const loops: ServerLoop[] = [
      {
        name: "jobs",
        everyMs: WATCH_EVERY_MS,
        run: async () => {
          const { finished, expired } = await jobWatchPass({ db: ctx.db, kinds: ctx.jobKinds ?? [], signal: ctx.signal });
          if (finished.length || expired.length) console.log(`jobs: finished ${finished.join(", ") || "-"}; expired ${expired.join(", ") || "-"}`);
        },
      },
    ];
    if (config.listen) {
      let served = false;
      loops.push({
        name: "hooks",
        everyMs: 5_000,
        // Started from the loop so a failure to bind is logged and retried like any loop error.
        run: async () => {
          if (served) return;
          serveHooks({ db: ctx.db, home: ctx.home, ownerId: ctx.ownerId, inboundTokens: config.inboundTokens }, config.listen!, ctx.signal);
          served = true;
        },
      });
    }
    return loops;
  },
});
