import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

/**
 * A stand-in for workstream's desk `/mcp` endpoint, built the way workstream builds it
 * (src/server/mcp-endpoint.ts there): Bearer auth answered with 401 before any MCP server exists, then a
 * fresh stateless McpServer per POST with JSON responses, and `tell_desk` / `request_status` answering in
 * the desk's text shape (`request <id>: <status>\n\n<text>`, src/service/desk-request.ts there).
 *
 * A request's status is whatever the test sets in `requests`. A follow-up (`tell_desk` with `request`)
 * sets it running again, unless `followUpLeavesAnswer` (the desk's turn still ending as it arrived).
 *
 * The eight reads answer `<tool> <args as JSON>`, or `listProducts` for list_products, in workstream's
 * line shape (`<name> (product <id>): ...`).
 */
export class FakeDesk {
  readonly calls: { tool: string; args: Record<string, unknown> }[] = [];
  /** `turn`: the state's key, printed as `(turn <key>)` on the first line as workstream does; unset: none. */
  readonly requests = new Map<string, { product: string; message: string; status: "running" | "waiting-approval" | "answered" | "failed"; text: string; turn?: string }>();
  readonly products = new Set(["widgetry", "shuvi"]);
  listProducts = "Widgetry (product widgetry): Login [active] (workstream w1)\nShuvi (product shuvi): M6 [active] (workstream w2)";
  followUpLeavesAnswer = false;
  private next = 1;
  private server: ReturnType<typeof Bun.serve>;

  constructor(readonly token = "desk-token") {
    this.server = Bun.serve({ port: 0, fetch: (req) => this.handle(req) });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}/mcp`;
  }

  private describe(id: string): string {
    const r = this.requests.get(id)!;
    const next = r.status === "running" || r.status === "waiting-approval" ? `\n\nYou will be woken when it changes; request_status("${id}") reads it any time.` : "";
    return `request ${id}: ${r.status}${r.turn && r.status !== "running" ? ` (turn ${r.turn})` : ""}\n\n${r.text}${next}`;
  }

  private mcp(): McpServer {
    const server = new McpServer({ name: "workstream-desk", version: "0.1.0" });
    const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
    const failed = (name: string, m: string) => ({ ...text(`${name} failed: ${m}`), isError: true });
    server.registerTool(
      "tell_desk",
      { description: "tell", inputSchema: { product: z.string(), message: z.string(), request: z.string().optional(), wait: z.number().optional() } },
      async (a: { product: string; message: string; request?: string; wait?: number }) => {
        this.calls.push({ tool: "tell_desk", args: a });
        if (!this.products.has(a.product)) return failed("tell_desk", `no product "${a.product}"; list_products names them`);
        if (a.request) {
          const r = this.requests.get(a.request);
          if (!r) return failed("tell_desk", `no request "${a.request}"`);
          if (!this.followUpLeavesAnswer) Object.assign(r, { status: "running", text: "The desk is still working on it." });
          return text(this.describe(a.request));
        }
        const id = `req_${this.next++}`;
        this.requests.set(id, { product: a.product, message: a.message, status: "running", text: "The desk is still working on it." });
        return text(this.describe(id));
      },
    );
    server.registerTool("request_status", { description: "status", inputSchema: { request: z.string() } }, async (a: { request: string }) => {
      this.calls.push({ tool: "request_status", args: a });
      if (!this.requests.has(a.request)) return failed("request_status", `no request "${a.request}"`);
      return text(this.describe(a.request));
    });
    const reads: Record<string, Record<string, z.ZodType>> = {
      list_products: {},
      waiting: { product: z.string().optional() },
      workstream_brief: { workstream: z.string(), product: z.string().optional() },
      session_log: { workstream: z.string().optional(), session: z.string().optional(), entries: z.number().optional(), product: z.string().optional() },
      recent_questions: { workstream: z.string().optional(), product: z.string().optional() },
      pull_requests: { product: z.string().optional() },
      read_note: { workstream: z.string(), title: z.string().optional(), product: z.string().optional() },
      issues: { workstream: z.string(), product: z.string().optional() },
    };
    for (const [name, shape] of Object.entries(reads)) {
      const answer = (a: Record<string, unknown>) => {
        this.calls.push({ tool: name, args: a });
        return text(name === "list_products" ? this.listProducts : `${name} ${JSON.stringify(a)}`);
      };
      if (Object.keys(shape).length) server.registerTool(name, { description: name, inputSchema: shape }, async (a: Record<string, unknown>) => answer(a));
      else server.registerTool(name, { description: name }, async () => answer({}));
    }
    return server;
  }

  private async handle(req: Request): Promise<Response> {
    if (req.headers.get("authorization") !== `Bearer ${this.token}`) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null }), { status: 401, headers: { "content-type": "application/json" } });
    }
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    const server = this.mcp();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      void server.close();
    }
  }

  stop(): void {
    this.server.stop(true);
  }
}
