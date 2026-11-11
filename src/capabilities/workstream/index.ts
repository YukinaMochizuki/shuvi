import { z } from "zod";
import { err, ok, type ToolDef } from "agent-runtime";
import { createJob, type JobKind } from "../../store/jobs.ts";
import { defineCapability } from "../types.ts";
import { callDesk, parseDeskReply, type DeskConfig } from "./desk.ts";

/**
 * Workstream: `ask_workstream(product, message)` brings a request to workstream's desk, the first real
 * job kind (docs/design.md §10). The tool starts the request and returns a job id at once; the turn ends,
 * and the desk's answer comes back to the asking chat as a `job_done` event that starts a new turn.
 *
 * HOW THE ANSWER COMES BACK: BY POLLING. Workstream's desk does call back, but per SOURCE, not per request:
 * `workstream source add --callback-url` fixes one URL for the source, and the wake it POSTs is an
 * OpenClaw-style `{ text: "[workstream] request <id> <status>. Read it with request_status(...)", mode,
 * agentId }`, never the answer (its docs/decisions/desk-sources.md, src/service/desk-callback.ts). shuvi's
 * callback jobs need a per-job URL and token (`/jobs/<id>/report`), so the job is a `poll` job: the jobs
 * watcher calls `request_status` every SHUVI_WORKSTREAM_POLL_SEC until it reads `answered` or `failed`.
 * `waiting-approval` (a card on the owner's phone) keeps it running; the deadline then decides.
 *
 * The tool is `ownerOnly` (a desk request acts for the owner): always offered, refused at call time unless
 * the owner is the only one the turn has heard from (agent/turn.ts `ownerAuthority`).
 *
 *   SHUVI_WORKSTREAM_MCP_URL       the desk's MCP endpoint, e.g. http://workstream:7400/mcp (unset: off)
 *   SHUVI_WORKSTREAM_MCP_TOKEN     the trusted-source token `workstream source add` printed
 *   SHUVI_WORKSTREAM_POLL_SEC      how often a request is polled (default 20)
 *   SHUVI_WORKSTREAM_DEADLINE_MIN  how long a request may take before it expires (default 360: a request
 *                                  can wait on an approval card for hours)
 */

export interface WorkstreamConfig extends DeskConfig {
  pollEveryMs: number;
  deadlineMs: number;
}

export const WORKSTREAM_KIND = "workstream";

export const WORKSTREAM = `## Workstream

The owner's software work runs in workstream. \`ask_workstream\` brings a request to one product's desk: a question about the work, something to look into, or something to have done (anything that would change something waits for the owner's approval on their phone). It returns a job id at once; the desk's answer arrives later in this chat as a job event. So after asking, tell the owner briefly that you asked, and end your turn: do not wait or check on it.`;

function positive(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** How a desk request stands, as a job poll. */
export function deskJobKind(cfg: WorkstreamConfig, call: typeof callDesk = callDesk): JobKind {
  return {
    kind: WORKSTREAM_KIND,
    pollEveryMs: cfg.pollEveryMs,
    async poll(job, signal) {
      const request = String(job.spec.request ?? "");
      if (!request) return { state: "failed", result: "This job has no workstream request id." };
      const r = parseDeskReply(await call(cfg, "request_status", { request }, signal));
      if (r.status === "answered") return { state: "done", result: r.text };
      if (r.status === "failed") return { state: "failed", result: r.text };
      return { state: "running", note: `${r.status}: ${r.text}`.slice(0, 500) };
    },
  };
}

export const workstream = defineCapability<WorkstreamConfig>({
  id: "workstream",
  enable: (env) =>
    env.SHUVI_WORKSTREAM_MCP_URL && env.SHUVI_WORKSTREAM_MCP_TOKEN
      ? {
          url: env.SHUVI_WORKSTREAM_MCP_URL,
          token: env.SHUVI_WORKSTREAM_MCP_TOKEN,
          pollEveryMs: positive(env.SHUVI_WORKSTREAM_POLL_SEC, 20) * 1000,
          deadlineMs: positive(env.SHUVI_WORKSTREAM_DEADLINE_MIN, 360) * 60_000,
        }
      : null,
  ownerOnly: ["ask_workstream"],
  tools({ db, chat, state }, cfg) {
    const ask: ToolDef<{ product: string; message: string }> = {
      name: "ask_workstream",
      description:
        "Bring a request to the desk of one workstream product: a question about the work, something to look into, or something to have done. " +
        "Returns a job id at once; the desk's answer comes back to this chat later as a job event. End your turn after asking.",
      inputSchema: {
        product: z.string().min(1).describe("The product, by id or name"),
        message: z.string().min(1).describe("The request, in the owner's words where you have them"),
      },
      async handler({ product, message }) {
        let reply;
        try {
          // wait: 0 returns the request id at once; the answer is polled for (see the header).
          reply = parseDeskReply(await callDesk(cfg, "tell_desk", { product, message, wait: 0 }));
        } catch (e) {
          return err(`The workstream desk did not take the request: ${e instanceof Error ? e.message : String(e)}`);
        }
        const now = Date.now();
        const oneLine = message.replace(/\s+/g, " ").trim();
        const { job } = createJob(db, {
          chatId: chat.id,
          originSeq: state.toSeq,
          kind: WORKSTREAM_KIND,
          title: `${product}: ${oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine}`,
          report: "poll",
          spec: { product, request: reply.request },
          deadline: new Date(now + cfg.deadlineMs),
          firstPollAt: new Date(now + Math.min(cfg.pollEveryMs, 5_000)),
          // Only reachable through the boundary's owner check (`ownerOnly`).
          ownerAuthorised: true,
        });
        return ok(`Asked the ${product} desk (workstream request ${reply.request}, ${reply.status}). This is job ${job.id}: its answer comes back to this chat as a job event. End your turn now; do not wait for it.`);
      },
    };
    return [{ serverName: "shuvi", tools: [ask] as ToolDef[] }];
  },
  section: () => WORKSTREAM,
  jobKinds: (cfg) => [deskJobKind(cfg)],
});
