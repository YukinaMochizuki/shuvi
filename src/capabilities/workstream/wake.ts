import { sameSecret } from "../../secrets/compare.ts";
import type { Db } from "../../store/db.ts";
import { pollNow, runningJobs } from "../../store/jobs.ts";
import type { HookRoute } from "../types.ts";

/**
 * `POST /workstream/wake`: workstream's desk telling us one of our requests changed (its
 * src/service/desk-callback.ts). The body is `{text, request, status}` and carries NO ANSWER, by
 * workstream's design: the answer is read the way it always is, by polling `request_status`. So a wake
 * only moves that request's running job to the watcher's next pass (`pollNow`); the job's interval
 * (SHUVI_WORKSTREAM_POLL_SEC) stays as the fallback for a wake that never came (a workstream restart
 * mid-retry, a tailnet blip).
 *
 * Authenticated by `Authorization: Bearer <SHUVI_WORKSTREAM_WAKE_TOKEN>`, compared in constant time, the
 * same value workstream holds as this source's callback token (`workstream source add
 * --callback-token-file`). Nothing is touched unless it checked out; without the variable the route does
 * not exist (404). A request with no running job (already answered, never ours) is a 200 that does
 * nothing, so workstream does not retry it; the answer says no more than `ok`.
 */

export const WAKE_PATH = "/workstream/wake";

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status });

/** The request id a wake names, or null. */
export function wakeRequest(body: string): string | null {
  try {
    const o = JSON.parse(body) as { request?: unknown };
    return typeof o?.request === "string" && o.request.trim() ? o.request.trim() : null;
  } catch {
    return null;
  }
}

/** Move every running workstream job for `request` to the next pass. Returns how many. */
export function wakeJobs(db: Db, kind: string, request: string): number {
  let n = 0;
  for (const job of runningJobs(db)) if (job.kind === kind && String(job.spec.request ?? "") === request && pollNow(db, job.id)) n++;
  return n;
}

export function wakeRoute(token: string, kind: string): HookRoute {
  return {
    path: WAKE_PATH,
    authorize(req) {
      const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
      return !!m && sameSecret(m[1]!, token);
    },
    handle(_req, body, { db }) {
      const request = wakeRequest(body);
      if (!request) return json(400, { error: "the body names no request" });
      const n = wakeJobs(db, kind, request);
      console.log(`workstream: woken for request ${request} (${n ? "polling it now" : "no running job"})`);
      return json(200, { ok: true });
    },
  };
}
