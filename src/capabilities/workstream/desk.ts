import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * A client for workstream's desk, as a trusted source sees it: `tell_desk` and `request_status` on its
 * `/mcp` endpoint, with the source's Bearer token (workstream's docs/decisions/desk-sources.md,
 * src/server/mcp-endpoint.ts, src/service/desk-request.ts).
 *
 * The endpoint is stateless (a fresh server per POST), so each call is a fresh connection: connect, call,
 * close. Both tools answer in one text block shaped
 *
 *   request <id>: <running | waiting-approval | answered | failed>
 *
 *   <the desk's answer, or what it is waiting on>
 *
 * which `parseDeskReply` reads. A tool error (an unknown product or request) comes back as `isError`.
 */

export interface DeskConfig {
  url: string;
  token: string;
}

export const DESK_CALL_TIMEOUT_MS = 30_000;

export type DeskStatus = "running" | "waiting-approval" | "answered" | "failed";

export interface DeskReply {
  request: string;
  status: DeskStatus;
  text: string;
}

/** Call one desk tool; returns its text, or throws (with the desk's own message for a tool error). */
export async function callDesk(cfg: DeskConfig, name: "tell_desk" | "request_status", args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
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

/** Read a `tell_desk` / `request_status` reply. Throws if it is not shaped like one. */
export function parseDeskReply(text: string): DeskReply {
  const m = /^request (\S+): (running|waiting-approval|answered|failed)\n?\n?([\s\S]*)$/.exec(text.trim());
  if (!m) throw new Error(`unexpected reply from the desk: ${text.slice(0, 200)}`);
  return { request: m[1]!, status: m[2] as DeskStatus, text: m[3]!.replace(TRAILER, "").trim() };
}
