import { sameSecret } from "../../secrets/compare.ts";
import type { Db } from "../../store/db.ts";
import { ensureChat, recordFrameworkEvent } from "../../store/events.ts";
import { checkJobToken, finishJob, getJob } from "../../store/jobs.ts";
import { inboundText, inboundTokenVar, loadInboundSources } from "./inbound.ts";

/**
 * The hook endpoints (docs/design.md §2): the one place the outside world writes into shuvi over HTTP.
 * Served on `SHUVI_HOOK_LISTEN`, meant to be a tailnet address; the tokens below are checked anyway, the
 * address is not the auth.
 *
 *   POST /jobs/<id>/report      a callback job's result. `Authorization: Bearer <the job's token>`.
 *                               Body: JSON `{ "status": "done" | "failed", "result": <string or JSON> }`,
 *                               or plain text (= done, the text is the result).
 *   POST /inbound/<source>      an external event. `Authorization: Bearer <SHUVI_INBOUND_<NAME>_TOKEN>`.
 *                               Body: JSON (its `text` or `message`, else the JSON) or plain text. An
 *                               `Idempotency-Key` header makes a retried POST land once.
 *
 * Answers, and the rule that NOTHING IS WRITTEN unless the token checked out:
 *   404  no such job (or not a callback job) / no such source (undeclared, or no token in the env)
 *   401  missing or wrong token (compared in constant time, as hashes)
 *   400  an empty or unreadable body;  413  a body over MAX_BODY_BYTES (counted in bytes; Bun.serve's
 *        `maxRequestBodySize` holds the same cap before the body is buffered at all)
 *   200  written, or already written (a job reported twice: the first report stands, nothing more)
 *
 * The response never says more than that: no job titles, no chat ids, nothing a caller did not send.
 */

export const MAX_BODY_BYTES = 256 * 1024;

export interface HookDeps {
  db: Db;
  home: string;
  ownerId: number;
  /** `SHUVI_INBOUND_*_TOKEN` values, by variable name. */
  inboundTokens: Record<string, string>;
}

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status });
const notFound = () => json(404, { error: "not found" });
const unauthorized = () => json(401, { error: "unauthorized" });

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1]! : null;
}

async function readBody(req: Request): Promise<string | Response> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) return json(413, { error: "body too large" });
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) return json(413, { error: "body too large" });
  return new TextDecoder().decode(bytes);
}

async function jobReport(deps: HookDeps, req: Request, idRaw: string): Promise<Response> {
  const id = /^\d+$/.test(idRaw) ? Number(idRaw) : NaN;
  const job = Number.isSafeInteger(id) ? getJob(deps.db, id) : undefined;
  if (!job || job.report !== "callback" || !job.tokenHash) return notFound();
  const token = bearer(req);
  if (!token || !checkJobToken(job, token)) return unauthorized();
  const body = await readBody(req);
  if (body instanceof Response) return body;
  if (job.state !== "running") return json(200, { ok: true, already: job.state });

  let state: "done" | "failed" = "done";
  let result = body.trim();
  if ((req.headers.get("content-type") ?? "").includes("json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return json(400, { error: "body is not JSON" });
    }
    const o = (parsed && typeof parsed === "object" ? parsed : { result: parsed }) as { status?: unknown; result?: unknown };
    if (o.status !== undefined && o.status !== "done" && o.status !== "failed") return json(400, { error: 'status must be "done" or "failed"' });
    state = (o.status as "done" | "failed" | undefined) ?? "done";
    result = o.result === undefined ? "" : typeof o.result === "string" ? o.result : JSON.stringify(o.result, null, 2);
  }
  if (!result) result = state === "done" ? "(no result given)" : "(failed, no reason given)";
  const seq = finishJob(deps.db, job.id, { state, result });
  return json(200, seq == null ? { ok: true, already: "reported" } : { ok: true });
}

async function inbound(deps: HookDeps, req: Request, name: string): Promise<Response> {
  const source = loadInboundSources(deps.home).get(name);
  const expected = source ? deps.inboundTokens[inboundTokenVar(name)] : undefined;
  if (!source || !expected) return notFound();
  const token = bearer(req);
  if (!token || !sameSecret(token, expected)) return unauthorized();
  const body = await readBody(req);
  if (body instanceof Response) return body;
  const text = inboundText(body, req.headers.get("content-type"));
  if (!text) return json(400, { error: "empty body" });
  const chat = source.chat === "dm" ? ensureChat(deps.db, { id: deps.ownerId, kind: "private" }) : ensureChat(deps.db, { id: source.chat, kind: source.chat < 0 ? "group" : "private" });
  const key = req.headers.get("idempotency-key")?.trim();
  const seq = recordFrameworkEvent(deps.db, {
    chatId: chat.id,
    kind: "external",
    payload: { source: name, text, trigger: source.trigger },
    idemKey: key ? `inbound:${name}:${key.slice(0, 200)}` : null,
  });
  return json(200, seq == null ? { ok: true, already: "recorded" } : { ok: true });
}

/** Route one request. Exported so tests run it without a socket. */
export async function handleHook(deps: HookDeps, req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  const job = /^\/jobs\/([^/]+)\/report\/?$/.exec(path);
  const src = /^\/inbound\/([^/]+)\/?$/.exec(path);
  if (!job && !src) return notFound();
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  try {
    return job ? await jobReport(deps, req, decodeURIComponent(job[1]!)) : await inbound(deps, req, decodeURIComponent(src![1]!));
  } catch (e) {
    console.error(`hooks: ${req.method} ${path} failed:`, e);
    return json(500, { error: "internal error" });
  }
}

/** `host:port` (or `[v6]:port`, or a bare port) → Bun.serve's options. */
export function parseListen(listen: string): { hostname: string; port: number } {
  const m = /^(?:\[([^\]]+)\]|([^:]*)):(\d+)$/.exec(listen.trim()) ?? /^()()(\d+)$/.exec(listen.trim());
  if (!m) throw new Error(`SHUVI_HOOK_LISTEN must be host:port, not "${listen}"`);
  return { hostname: m[1] || m[2] || "127.0.0.1", port: Number(m[3]) };
}

/** Serve the hooks on `listen` until `signal` aborts. */
export function serveHooks(deps: HookDeps, listen: string, signal: AbortSignal): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({ ...parseListen(listen), maxRequestBodySize: MAX_BODY_BYTES, fetch: (req) => handleHook(deps, req) });
  signal.addEventListener("abort", () => void server.stop(true), { once: true });
  console.log(`hooks: listening on ${server.hostname}:${server.port}`);
  return server;
}
