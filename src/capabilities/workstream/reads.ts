import { z } from "zod";
import { err, ok, type ToolDef } from "agent-runtime";
import { callDesk, type DeskConfig } from "./desk.ts";

/**
 * The desk's eight READS, as tools of this chat: workstream answers them from its store with no model in
 * between (its src/service/desk-reads.ts), so a quick look ("what is waiting on me", "how is the login
 * PR") comes back inside this turn, where `ask_workstream` would start a desk session and answer later.
 *
 * Defined here, one by one, rather than proxied from the desk's tool list: the tool list stays the same
 * when workstream is down, and each tool knows where its product is, which is what a chat's policy
 * needs (below). The names, descriptions and arguments follow workstream's; when its reads change, these
 * follow by hand.
 *
 * A CHAT WHOSE POLICY NAMES ITS PRODUCTS (`workstream: { products: [...] }`) gets every read too, held to
 * them: each call must name one of them as `product`, which is passed on; workstream then looks only
 * within it and refuses a workstream or session from another product (its butler-read.ts scope).
 * `list_products` has no such argument, so its answer is filtered here, one line per product. A chat with
 * no list may name any product, or none.
 */

export interface ReadsConfig extends DeskConfig {
  /** Only these products (by id or name), from the chat's policy. Absent: any. */
  products?: string[];
}

const WORKSTREAM = z.string().describe("the workstream's id, or its title as said, with the product if that helps ('hangar tech ask')");

interface ReadSpec {
  /** The tool's name here. */
  name: string;
  /** The desk's own name for it. */
  desk: string;
  description: string;
  args: Record<string, z.ZodType>;
  /** Whether it takes `product` (all but list_products). */
  scoped: boolean;
}

const READS: ReadSpec[] = [
  {
    name: "workstream_waiting",
    desk: "waiting",
    description: "What is waiting on the owner in workstream right now: questions and approvals, PRs in trouble, sessions that finished. The first thing to call when he asks what needs him.",
    args: {},
    scoped: true,
  },
  {
    name: "workstream_list_products",
    desk: "list_products",
    description: "Workstream's products and their workstreams that are not archived. Use it to resolve a name the owner said.",
    args: {},
    scoped: false,
  },
  {
    name: "workstream_brief",
    desk: "workstream_brief",
    description: "How one workstream is going: its goal and plan, the titles of its other notes, and the state of its sessions. Then workstream_session_log for what a session said, workstream_read_note for a note in full.",
    args: { workstream: WORKSTREAM },
    scoped: true,
  },
  {
    name: "workstream_session_log",
    desk: "session_log",
    description: "What a workstream session said lately: what it was told, what it answered, and the questions it asked (pending, answered, or cancelled without an answer).",
    args: {
      workstream: WORKSTREAM.optional(),
      session: z.string().optional().describe("the session's id, or its name as said (director-1); omit for the workstream's latest top-level session"),
      entries: z.number().optional().describe("how many recent entries (default 8, at most 30)"),
    },
    scoped: true,
  },
  {
    name: "workstream_recent_questions",
    desk: "recent_questions",
    description: "The questions workstream's agents asked lately, in every state: still waiting, answered (and how), or cancelled unanswered. For one workstream, one product, or everywhere.",
    args: { workstream: WORKSTREAM.optional() },
    scoped: true,
  },
  {
    name: "workstream_pull_requests",
    desk: "pull_requests",
    description: "Workstream's open PRs, with their CI and whether they merge cleanly.",
    args: {},
    scoped: true,
  },
  {
    name: "workstream_read_note",
    desk: "read_note",
    description: "A workstream's note in full, by title or kind (goal, plan, working, handoff); with no title, the list of its notes.",
    args: { workstream: WORKSTREAM, title: z.string().optional() },
    scoped: true,
  },
  {
    name: "workstream_issues",
    desk: "issues",
    description: "A workstream's issues (its todo list) and their states.",
    args: { workstream: WORKSTREAM },
    scoped: true,
  },
];

/** The names of the read tools, for the capability's `ownerOnly`. */
export const READ_TOOL_NAMES = READS.map((r) => r.name);

/** A product name as workstream matches one (its butler-read.ts `squash`): lowercased, letters and digits only. */
const squash = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * `list_products`' answer with only the lines of `only` (by id or name): `<name> (product <id>): ...`.
 * The FIRST `(product <id>):` on a line is its product's (lazily matched): what follows is its
 * workstreams' titles, which could hold the same words.
 */
export function filterProductLines(text: string, only: readonly string[]): string {
  const ids = new Set(only.map((p) => p.trim().toLowerCase()));
  const names = new Set(only.map(squash));
  const kept = text.split("\n").filter((line) => {
    const m = /^(.*?) \(product ([^)]+)\):/.exec(line);
    return !!m && (ids.has(m[2]!.toLowerCase()) || names.has(squash(m[1]!)));
  });
  return kept.join("\n") || "None of the products this chat may read exist in workstream.";
}

const listed = (only: readonly string[]) => (only.length ? only.join(", ") : "none");

export function readTools(cfg: ReadsConfig, call: typeof callDesk = callDesk): ToolDef[] {
  const only = cfg.products;
  return READS.map((spec): ToolDef => {
    const product = spec.scoped
      ? only
        ? { product: z.string().min(1).describe(`The product, one of: ${listed(only)}`) }
        : { product: z.string().optional().describe("a product id or name: look only within it; omit for all") }
      : {};
    return {
      name: spec.name,
      description: spec.description + (only && spec.scoped ? ` From this chat, name the product: ${listed(only)}.` : "") + (only && !spec.scoped ? ` From this chat, only: ${listed(only)}.` : ""),
      inputSchema: { ...spec.args, ...product },
      async handler(args: Record<string, unknown>) {
        if (only && spec.scoped) {
          const p = typeof args.product === "string" ? args.product : "";
          if (!only.includes(p)) return err(`From this chat you can read only ${listed(only)} in workstream${p ? `, not ${p}` : ""}. Name one of them as product.`);
        }
        let text: string;
        try {
          text = await call(cfg, spec.desk, args);
        } catch (e) {
          return err(`workstream did not answer: ${e instanceof Error ? e.message : String(e)}`);
        }
        return ok(only && !spec.scoped ? filterProductLines(text, only) : text);
      },
    } as ToolDef;
  });
}
