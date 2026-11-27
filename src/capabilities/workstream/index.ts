import { z } from "zod";
import { err, ok, type ToolDef } from "agent-runtime";
import { actingFor, authorisation } from "../../agent/acting.ts";
import { createJob, runningJobs, type JobKind } from "../../store/jobs.ts";
import { defineCapability } from "../types.ts";
import { callDesk, parseDeskReply, type DeskConfig, type DeskStatus } from "./desk.ts";
import { READ_TOOL_NAMES, readTools } from "./reads.ts";
import { wakeRoute } from "./wake.ts";

/**
 * Workstream: the owner's software work, through workstream's desk (docs/design.md §10; workstream's
 * docs/decisions/desk-sources.md). Two ways in, for two kinds of question:
 *
 *   - THE READS (reads.ts): `workstream_waiting`, `workstream_brief`, `workstream_pull_requests`, … answer
 *     from workstream's store with no model in between, inside this turn. A quick look.
 *   - `ask_workstream(product, message, request?)` brings a request to one product's desk: something to
 *     look into, or something to have done (anything that would change something waits for the owner's
 *     approval on his phone). It starts the request and returns a job id at once; the turn ends, and the
 *     desk's answer comes back to the asking chat as a `job_done` event that starts a new turn. `request`
 *     continues an earlier one (a clarification, the next question on the same thing), in the same desk
 *     conversation.
 *
 * HOW THE ANSWER COMES BACK: A WAKE, THEN A POLL. The job is a `poll` job: the jobs watcher calls
 * `request_status` until it reads `answered` or `failed`. Workstream wakes us when the request changes
 * (`POST /workstream/wake`, wake.ts), which moves the job to the watcher's next pass, so an answer is
 * read within a second of the desk giving it. The wake carries no answer, by workstream's design: the
 * answer is only ever the result of our own `request_status`. The interval (SHUVI_WORKSTREAM_POLL_SEC)
 * is the fallback for a wake that never arrived. `waiting-approval` (a card on the owner's phone) keeps
 * the job running; the deadline then decides.
 *
 * A FOLLOW-UP is refused while the desk is still working on the request (a running job here, or the desk
 * itself reading `running` / `waiting-approval`, which also covers a job that expired while it worked):
 * the desk would take the follow-up into the turn already running, and that turn's one answer would end
 * the follow-up's job while nothing waited for the next. Once it has answered, the follow-up starts a new
 * job on the same request. If the desk still shows the previous answer at that moment (its turn ending as
 * the follow-up arrived), that answer's TURN is recorded on the job as `stale`, and a poll reading the
 * same turn is still running, so the job ends with the next one. By turn, not by text: two answers may
 * read the same ("Done.", or one of the desk's fixed sentences). A desk too old to name its turns is
 * compared by status and text instead.
 *
 * Every tool is `ownerOnly` (each acts or reads for the owner): always offered, refused at call time unless
 * the owner himself is in the turn (agent/turn.ts `ownerAuthority`). Every one is also DELEGABLE: a group
 * whose policy says `delegate: [workstream]` lets its operators use them (the owner decided this, so a
 * group can use the desk without him; agent/acting.ts). That is safe to hand over because nothing here
 * writes by itself: the reads only read (within the chat's products), and whatever a request would change
 * waits on an approval card on the OWNER's phone. An operator's request says so in what the desk reads
 * (`requesterMark`), so the desk does not take it for the owner's, and its job records the operator
 * (`authorisedBy`).
 *
 * POLICY can narrow it per chat (home/policy.yaml, src/policy/): `workstream: { products: [widgetry] }` (or
 * the design's name for it, `workstream-read`) lets that chat ask and read only those products: every tool
 * then takes one of them as its product (reads.ts says how the reads hold to it), and the tool
 * descriptions and the section name them.
 *
 *   SHUVI_WORKSTREAM_MCP_URL       the desk's MCP endpoint, e.g. http://workstream:4319/mcp (unset: off)
 *   SHUVI_WORKSTREAM_MCP_TOKEN     the trusted-source token `workstream source add` printed
 *   SHUVI_WORKSTREAM_WAKE_TOKEN    the token workstream's wake carries (the file given to `workstream source
 *                                  add --callback-token-file`). Unset: no wake route, polling only. The
 *                                  route is served on the hooks (SHUVI_HOOK_LISTEN, capabilities/jobs)
 *   SHUVI_WORKSTREAM_POLL_SEC      how often a request is polled when no wake comes (default 120)
 *   SHUVI_WORKSTREAM_DEADLINE_MIN  how long a request may take before it expires (default 360: a request
 *                                  can wait on an approval card for hours)
 */

export interface WorkstreamConfig extends DeskConfig {
  pollEveryMs: number;
  deadlineMs: number;
  /** The token workstream's wake carries. Absent: no wake route. */
  wakeToken?: string;
  /** Only these products (by id or name), from the chat's policy. Absent: any. */
  products?: string[];
}

export const WORKSTREAM_KIND = "workstream";

/** The first poll of a new request, in case its wake is lost: a quick answer still comes back soon. */
export const FIRST_POLL_MS = 5_000;

export const WORKSTREAM = `## Workstream

The owner's software work runs in workstream. Two ways in:

- **To look something up** (what is waiting on him, how a workstream or PR is going, what a session said or asked), use the \`workstream_*\` read tools: they answer right away, in this turn. Start with \`workstream_waiting\`, or \`workstream_list_products\` to resolve a name.
- **To have something looked into or done** (research in the code, a message or answer to a session, opening a workstream), \`ask_workstream\` brings it to that product's desk (anything that would change something waits for the owner's approval on his phone). It returns a job id at once; the desk's answer arrives later in this chat as a job event. So after asking, tell the owner briefly that you asked, and end your turn: do not wait or check on it. To follow up on an answer (a clarification, the next question on the same thing), pass its request id as \`request\`.
- **When a group's operator asks** (in a group whose policy delegates workstream to its operators), both work for them too. But anything that would change something (a message or answer to a session, opening a workstream, anything the desk would do rather than look up) happens only once the owner approves it on his phone: say so when you ask the desk for them, and do not promise it is done until the answer says it was.`;

function positive(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The line an operator's request opens with, so the desk knows the owner did not ask it himself. */
export const requesterMark = (userId: number, chatTitle: string | null | undefined): string =>
  `(Asked by a group operator, Telegram user ${userId}${chatTitle ? `, in "${chatTitle}"` : ""}: not the owner himself. Anything it would change still waits for the owner's approval.)`;

/** What a job records of a desk answer it must not take for its own (see the header, A FOLLOW-UP). */
interface Stale {
  status: DeskStatus;
  turn: string | null;
  text: string;
}

/** Whether `r` is the answer `stale` recorded: the same turn, or (from a desk that names none) the same words. */
export function isStale(stale: Stale | undefined, r: { status: DeskStatus; turn: string | null; text: string }): boolean {
  if (!stale) return false;
  if (stale.turn !== null && stale.turn !== undefined) return r.turn === stale.turn;
  return r.turn === null && stale.status === r.status && stale.text === r.text;
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
      if (isStale(job.spec.stale as Stale | undefined, r)) return { state: "running", note: "the desk has not taken the follow-up yet" };
      if (r.status === "answered") return { state: "done", result: r.text };
      if (r.status === "failed") return { state: "failed", result: r.text };
      return { state: "running", note: `${r.status}: ${r.text}`.slice(0, 500) };
    },
  };
}

const listed = (only: readonly string[]) => (only.length ? only.join(", ") : "none");

export const workstream = defineCapability<WorkstreamConfig>({
  id: "workstream",
  label: "workstream (owner only)",
  gives: "workstream_* reads (answered at once) and ask_workstream (a request to a product's desk; the answer comes back later).",
  params: { products: { type: "string[]", meaning: "only these products may be read or asked from this chat (by id or name)", default: "any product", example: ["widgetry"] } },
  enable: (env) =>
    env.SHUVI_WORKSTREAM_MCP_URL && env.SHUVI_WORKSTREAM_MCP_TOKEN
      ? {
          url: env.SHUVI_WORKSTREAM_MCP_URL,
          token: env.SHUVI_WORKSTREAM_MCP_TOKEN,
          ...(env.SHUVI_WORKSTREAM_WAKE_TOKEN ? { wakeToken: env.SHUVI_WORKSTREAM_WAKE_TOKEN } : {}),
          pollEveryMs: positive(env.SHUVI_WORKSTREAM_POLL_SEC, 120) * 1000,
          deadlineMs: positive(env.SHUVI_WORKSTREAM_DEADLINE_MIN, 360) * 60_000,
        }
      : null,
  ownerOnly: ["ask_workstream", ...READ_TOOL_NAMES],
  delegable: ["ask_workstream", ...READ_TOOL_NAMES],
  configure(cfg, params) {
    const products = params.products;
    if (products === undefined) return cfg;
    // A list that cannot be read allows nothing rather than everything.
    const list = Array.isArray(products) ? products.map(String) : [];
    return { ...cfg, products: cfg.products ? cfg.products.filter((p) => list.includes(p)) : list };
  },
  tools({ db, chat, state }, cfg) {
    const only = cfg.products;
    const ask: ToolDef<{ product: string; message: string; request?: string }> = {
      name: "ask_workstream",
      description:
        "Bring a request to the desk of one workstream product: something to look into, or something to have done. " +
        "Returns a job id at once; the desk's answer comes back to this chat later as a job event. End your turn after asking. " +
        "For a quick look, use the workstream_* read tools instead: they answer at once." +
        (only ? ` From this chat, only these products: ${listed(only)}.` : ""),
      inputSchema: {
        product: z.string().min(1).describe("The product, by id or name"),
        message: z.string().min(1).describe("The request, in the owner's words where you have them"),
        request: z.string().optional().describe("An earlier request's id (from its job), to follow up on it in the same desk conversation"),
      },
      async handler({ product, message, request }) {
        if (only && !only.includes(product)) return err(`From this chat you can ask only ${only.length ? only.join(", ") : "no product"}'s desk${only.length === 1 ? "" : "s"}, not ${product}.`);
        if (request) {
          const open = runningJobs(db).find((j) => j.kind === WORKSTREAM_KIND && String(j.spec.request ?? "") === request);
          if (open) return err(`The desk is still working on request ${request} (job ${open.id}). Wait for its answer, then follow up.`);
          // The desk's own word too: a job that expired here may have left it still working.
          let now;
          try {
            now = parseDeskReply(await callDesk(cfg, "request_status", { request }));
          } catch (e) {
            return err(`The workstream desk did not take the follow-up: ${e instanceof Error ? e.message : String(e)}`);
          }
          if (now.status === "running" || now.status === "waiting-approval") return err(`The desk is still working on request ${request} (${now.status}). Wait for its answer, then follow up.`);
        }
        const acting = actingFor(state, "ask_workstream");
        const said = acting?.by === "operator" ? `${requesterMark(acting.userId, chat.title)}\n\n${message}` : message;
        let reply;
        try {
          // wait: 0 returns the request id at once; the answer is woken for and polled (see the header).
          reply = parseDeskReply(await callDesk(cfg, "tell_desk", { product, message: said, wait: 0, ...(request ? { request } : {}) }));
        } catch (e) {
          return err(`The workstream desk did not take the request: ${e instanceof Error ? e.message : String(e)}`);
        }
        // A follow-up that still reads as the previous answer: that one is not this job's (see the header).
        const stale: Stale | null = request && (reply.status === "answered" || reply.status === "failed") ? { status: reply.status, turn: reply.turn, text: reply.text } : null;
        const now = Date.now();
        const oneLine = message.replace(/\s+/g, " ").trim();
        const { job } = createJob(db, {
          chatId: chat.id,
          originSeq: state.toSeq,
          kind: WORKSTREAM_KIND,
          title: `${product}: ${oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine}`,
          report: "poll",
          spec: { product, request: reply.request, ...(stale ? { stale } : {}) },
          deadline: new Date(now + cfg.deadlineMs),
          firstPollAt: new Date(now + Math.min(cfg.pollEveryMs, FIRST_POLL_MS)),
          // The boundary let the call through for the owner or, delegated, for one of the group's operators.
          ...authorisation(acting),
        });
        const status = stale ? "running" : reply.status;
        const what = request ? `Followed up with the ${product} desk on workstream request ${reply.request} (${status})` : `Asked the ${product} desk (workstream request ${reply.request}, ${status})`;
        return ok(`${what}. This is job ${job.id}: its answer comes back to this chat as a job event. End your turn now; do not wait for it.`);
      },
    };
    return [{ serverName: "shuvi", tools: [ask, ...readTools(cfg)] as ToolDef[] }];
  },
  section: (_ctx, cfg) => (cfg.products ? `${WORKSTREAM}\n\nFrom this chat you can read and ask only these products: ${listed(cfg.products)}. Every tool needs one of them as its product.` : WORKSTREAM),
  jobKinds: (cfg) => [deskJobKind(cfg)],
  hookRoutes: (cfg) => (cfg.wakeToken ? [wakeRoute(cfg.wakeToken, WORKSTREAM_KIND)] : []),
  secrets: (cfg) => ({ workstream: cfg.token, ...(cfg.wakeToken ? { "workstream-wake": cfg.wakeToken } : {}) }),
});
