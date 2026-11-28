/**
 * A client for workstream's desk, as a trusted source sees it: its tools on the `/mcp` endpoint, with the
 * source's Bearer token (workstream's docs/decisions/desk-sources.md, src/server/mcp-endpoint.ts): the
 * eight reads (src/service/desk-reads.ts there, answered from its store with no model in between, see
 * reads.ts here) and the requests, `tell_desk` / `request_status` (src/service/desk-request.ts there).
 *
 * The endpoint is stateless (a fresh server per POST), so each call is a fresh connection: connect, call,
 * close. The two request tools answer in one text block shaped
 *
 *   request <id>: <running | waiting-approval | answered | failed>[ (turn <key>)]
 *   [handed off: <message | answer | workstream> workstream <id> session <id | -> "<workstream title>"
 *    ...one line per handoff...
 *    HANDOFF_NOTE]
 *
 *   <the desk's answer, or what it is waiting on>
 *
 * which `parseDeskReply` reads. The `(turn <key>)` names the state (absent while running, and from a desk
 * older than it): two answers that read the same are told apart by it (index.ts, a follow-up). A tool error (an unknown product or request) comes back as `isError`.
 *
 * The HANDOFF lines (workstream's src/service/desk-request.ts `handoffLines`) say where the request's work
 * went: a message the desk relayed to a session, a question it answered for one, a workstream it opened.
 * They sit right under the first line, with no blank line between, which is how they are told from a desk
 * answer that happens to start with the same words. `answered` is the DESK's turn ending; with handoffs,
 * the work itself has only started, and the owner follows it in workstream, not through us (index.ts says
 * what the job's result then tells the chat). The ids and the title are composed by workstream from its
 * rows, not by a model. A desk older than them sends none, and reads as having handed nothing on.
 *
 * The MCP SDK is imported on the first call, not with this module: it is a large graph (ajv, its schemas) that
 * every runner child would otherwise load before its turn starts, while only a turn that calls the desk uses it.
 */

export interface DeskConfig {
  url: string;
  token: string;
}

export const DESK_CALL_TIMEOUT_MS = 30_000;

export type DeskStatus = "running" | "waiting-approval" | "answered" | "failed";

/** Where a request's work went, as one `handed off:` line names it. */
export interface DeskHandoff {
  /** `message` (relayed to a session), `answer` (to a session's question), `workstream` (opened). */
  kind: string;
  workstream: string;
  /** The session it went to; null for a workstream opened without a director. */
  session: string | null;
  /** The workstream's title, as workstream has it now. */
  title: string;
}

export interface DeskReply {
  request: string;
  status: DeskStatus;
  /** The state's key, `answered:<time>`; null while running (or from a desk that does not say). */
  turn: string | null;
  /** Where the request handed its work on, oldest first; empty when it handed nothing on. */
  handoffs: DeskHandoff[];
  text: string;
}

/** The line that closes the handoff lines, exactly as workstream writes it (its `HANDOFF_NOTE`). */
export const HANDOFF_NOTE = "The work goes on where it was handed off; this request does not report on it.";

/** Call one desk tool; returns its text, or throws (with the desk's own message for a tool error). */
export async function callDesk(cfg: DeskConfig, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([import("@modelcontextprotocol/sdk/client/index.js"), import("@modelcontextprotocol/sdk/client/streamableHttp.js")]);
  const client = new Client({ name: "shuvi", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: { authorization: `Bearer ${cfg.token}` } } });
  try {
    await client.connect(transport, { timeout: DESK_CALL_TIMEOUT_MS, ...(signal ? { signal } : {}) });
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: DESK_CALL_TIMEOUT_MS + 5_000, ...(signal ? { signal } : {}) });
    const content = (res.content ?? []) as { type: string; text?: string }[];
    const text = content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    if (res.isError) throw new Error(text || `${name} failed`);
    return text;
  } finally {
    await client.close().catch(() => {});
  }
}

const TRAILER = /\n\nYou will be woken when it changes;[^\n]*$/;
const HEAD = /^request (\S+): (running|waiting-approval|answered|failed)(?: \(turn ([^)\n]+)\))?$/;
const HANDOFF_LINE = /^handed off: (\S+) workstream (\S+) session (\S+) "(.*)"$/;

/** Read a `tell_desk` / `request_status` reply. Throws if it is not shaped like one. */
export function parseDeskReply(text: string): DeskReply {
  const all = text.trim();
  const nl = all.indexOf("\n");
  const m = HEAD.exec(nl < 0 ? all : all.slice(0, nl));
  if (!m) throw new Error(`unexpected reply from the desk: ${text.slice(0, 200)}`);
  let rest = nl < 0 ? "" : all.slice(nl + 1);
  const handoffs: DeskHandoff[] = [];
  // Handoff lines come right under the first line; after a blank line it is the desk's answer (see the header).
  if (!rest.startsWith("\n")) {
    const lines = rest.split("\n");
    let i = 0;
    for (let h: RegExpExecArray | null; i < lines.length && (h = HANDOFF_LINE.exec(lines[i]!)); i++)
      handoffs.push({ kind: h[1]!, workstream: h[2]!, session: h[3] === "-" ? null : h[3]!, title: h[4]! });
    if (handoffs.length && lines[i] === HANDOFF_NOTE) i++;
    rest = lines.slice(i).join("\n");
  }
  return { request: m[1]!, status: m[2] as DeskStatus, turn: m[3] ?? null, handoffs, text: rest.replace(TRAILER, "").trim() };
}
