import type { ToolBundle, ToolContent } from "agent-runtime";
import type { TurnState } from "../agent/turn.ts";
import type { ChatPolicy, Policy, ToolParams } from "../policy/policy.ts";
import type { Db } from "../store/db.ts";
import type { Chat, ChatEvent } from "../store/events.ts";
import type { JobKind } from "../store/jobs.ts";
import type { TelegramFiles } from "../telegram/files.ts";

/**
 * A capability: one thing the assistant can do (speak, look things up, …), with everything that thing
 * brings to the framework in one folder, `src/capabilities/<id>/`. The registry (./index.ts) lists them
 * in order; the turn, the system prompt and the server are built from the enabled ones, so a new
 * capability touches none of `src/agent/turn.ts`, `src/agent/prompt.ts`, `src/server/main.ts` or
 * `src/env.ts`.
 *
 * Rules a capability keeps:
 *   - It reads its own configuration (its own `SHUVI_*` variables) in `enable`, inside its own module.
 *     The set of enabled capabilities is fixed per process, from the environment at startup.
 *   - It never talks to Telegram. Its tools and loops queue rows in the store (store/events.ts); the
 *     server's sender is the only thing that sends. That is why a loop is not handed the bot API, only a
 *     read-only file downloader (`ServerContext.files`).
 *   - Its tools run inside the turn's boundary (agent/turn.ts): after `pass` they are refused, and what
 *     arrives while they run is appended to their result. A capability does not get around that.
 *   - A tool that acts FOR THE OWNER (sets a schedule, asks workstream, edits memory) is named in
 *     `ownerOnly`. It is always offered (the tool list and the prompt stay the same turn to turn, so the
 *     cached prefix holds), and the boundary decides at CALL time whether this call may run: only if the
 *     owner himself is in the turn so far (agent/turn.ts `ownerAuthority`). A capability
 *     does not check authority itself, and does not hide its tools to get the same effect.
 *   - Its prompt `section` only reads (PromptContext): building the prompt never changes anything.
 *
 * PER-CHAT POLICY (home/policy.yaml, src/policy/, design §8) sits in front of all this: a turn uses only
 * the capabilities its chat's policy enables (`chatCapabilities`), so only those give it tools, prompt
 * sections and perception. Policy may pass a capability parameters (`workstream: { products: [widgetry] }`),
 * which reach it through `configure`, as a narrower config for that chat. A capability marked `always`
 * (speech, groups) is on in every chat whatever policy says. Loops, job kinds and perception gating are
 * the server's and stay process-wide.
 */

/** What a turn hands a capability's tools. */
export interface TurnContext {
  db: Db;
  /** The assistant's private data directory (docs/design.md §3). */
  home: string;
  chat: Chat;
  turnId: number;
  timeZone: string;
  owner: OwnerInfo;
  /** The turn's speech state (agent/turn.ts). Only speech should need to touch it. */
  state: TurnState;
  /** The policy in effect (src/policy/), and this chat's part of it. Always set by a real turn. */
  policy?: Policy;
  chatPolicy?: ChatPolicy;
  /** The owner's Telegram user id, when known. */
  ownerId?: number;
}

export interface OwnerInfo {
  name?: string;
  /** The language the owner speaks (`SHUVI_OWNER_LANGUAGE`). */
  language?: string;
}

/**
 * What the system prompt hands a capability's section. A section only READS: it is built for every turn and
 * is part of the prompt-cache prefix, so it never writes (not to `db`, not to home/), and the same state
 * must always give the same bytes (a stable order, ties included).
 */
export interface PromptContext {
  home: string;
  chat: Chat;
  owner: OwnerInfo;
  /** This chat's policy (src/policy/). Absent in a bare call: the chat's default. */
  chatPolicy?: ChatPolicy;
  /** The store, to read from only. Absent when the prompt is built without one (a bare call, a test). */
  db?: Db;
}

/** What the server hands a capability's loops. No Telegram API: only the sender talks to Telegram. */
export interface ServerContext {
  db: Db;
  home: string;
  timeZone: string;
  ownerId: number;
  /** Download a file someone sent. Read-only: it cannot send anything. */
  files: TelegramFiles;
  /** Aborted when the server is shutting down. */
  signal: AbortSignal;
  /** Every enabled capability's job kinds (`jobKinds`), filled by `capabilityLoops`. */
  jobKinds?: readonly JobKind[];
}

/**
 * A loop the server runs alongside its own (server/loop.ts): `run` every `everyMs`. `run` may return a
 * longer wait in ms. A throw is logged and backed off; it never stops the server.
 */
export interface ServerLoop {
  name: string;
  everyMs: number;
  run: () => Promise<number | void>;
}

/**
 * A parameter policy may pass a capability (`workstream: { products: [widgetry] }`). Declared so that the
 * owner's view (/policy), the model's catalogue (read_policy) and the check on a proposed entry
 * (propose_policy) all read the same list (src/policy/view.ts, src/policy/explain.ts).
 */
export interface PolicyParam {
  type: "string" | "string[]" | "number" | "boolean";
  /** What it means, in one line. */
  meaning: string;
  /** What leaving it out means ("any product"). */
  default: string;
  /** A value to show in an example entry (explain_policy). */
  example: unknown;
}

/** The environment a capability reads its configuration from (`process.env` in production). */
export type Env = Record<string, string | undefined>;

export interface Capability<C = unknown> {
  /** Also the folder name: `src/capabilities/<id>/`. */
  readonly id: string;
  /**
   * What the owner calls it, in a few plain words, as /policy shows it ("web lookups"). Say "(owner only)"
   * when every tool it gives acts for the owner.
   */
  readonly label: string;
  /** What it gives a chat, in one line (read_policy's catalogue, /policy <chat>). */
  readonly gives: string;
  /**
   * The parameters policy may pass it (see `configure`), by name. Absent: none, and a proposed entry
   * passing any is refused (propose_policy).
   */
  readonly params?: Readonly<Record<string, PolicyParam>>;
  /** Read this capability's configuration from `env`. `null`: it is off in this process. */
  enable(env: Env): C | null;
  /** On in every chat, whatever the chat's policy enables (speech: without it nothing can be said). */
  always?: boolean;
  /**
   * The config for one chat, given the parameters its policy passes this capability (`{}` for none, and
   * for a chat whose policy is `tools: all`). Return a narrower config, never a wider one. Absent: the
   * parameters are ignored.
   */
  configure?(config: C, params: ToolParams): C;
  /** The tools this capability gives one turn. */
  tools?(ctx: TurnContext, config: C): ToolBundle[];
  /** Its section of the system prompt ("when to use" these tools), or null for none in this chat. */
  section?(ctx: PromptContext, config: C): string | null;
  /** Loops the server runs for it. */
  loops?(ctx: ServerContext, config: C): ServerLoop[];
  /**
   * PERCEPTION GATING: true while `event` is not ready to be shown (its picture is still downloading), so
   * no turn opens on it yet and a running turn does not take it in yet. Must turn false on its own after
   * a short wait: a held event is then shown as it is.
   */
  holds?(event: ChatEvent, now: number, config: C): boolean;
  /** What the model is shown of `event` beyond its text line (an image), in a turn's input or an append. */
  perceive?(event: ChatEvent, config: C): ToolContent[];
  /** The kinds of job it starts (store/jobs.ts): how the jobs watcher polls them. */
  jobKinds?(config: C): JobKind[];
  /**
   * The names of its tools that act for the owner. The turn's boundary refuses a call to one unless the
   * owner himself is in the turn (agent/turn.ts `ownerAuthority`).
   */
  ownerOnly?: readonly string[];
}

/** A capability that is on in this process, with the configuration it read. */
export interface EnabledCapability<C = unknown> {
  capability: Capability<C>;
  config: C;
}

/**
 * The capabilities a chat uses: those its policy enables (`tools: all`, or by id), with the parameters
 * policy passes them (`configure`), plus every `always` one; in registry order.
 */
export function chatCapabilities(enabled: readonly EnabledCapability[], tools: ChatPolicy["tools"]): EnabledCapability[] {
  const out: EnabledCapability[] = [];
  for (const { capability, config } of enabled) {
    const params = tools === "all" ? {} : tools[capability.id];
    if (params === undefined && !capability.always) continue;
    out.push({ capability, config: capability.configure && params ? capability.configure(config, params) : config });
  }
  return out;
}

/** The enabled capabilities of `registry`, in registry order. */
export function enableCapabilities(registry: readonly Capability<any>[], env: Env): EnabledCapability[] {
  const out: EnabledCapability[] = [];
  for (const capability of registry) {
    const config = capability.enable(env);
    if (config !== null) out.push({ capability, config });
  }
  return out;
}

/**
 * The tools of every enabled capability. Bundles that share a `serverName` (shuvi's own tools are all
 * `shuvi`, whichever capability brings them) are merged into one: the Claude driver keys its MCP servers
 * by name, so a second `shuvi` bundle would replace the first. The order that results:
 *   - servers in the order of their first appearance in the registry;
 *   - within a server, tools in registry order (then in the order each capability lists them).
 * So `[speech: shuvi, web: web, schedules: shuvi]` gives `shuvi: say … pass, schedule …`, then `web`.
 *
 * Two tools with the same name are refused here (a throw: it is a programming error, found by the first
 * turn or test), whatever their servers: a tool's name is what `ownerOnly` and the model refer to it by.
 */
export function capabilityTools(enabled: readonly EnabledCapability[], ctx: TurnContext): ToolBundle[] {
  const out: ToolBundle[] = [];
  const seen = new Map<string, string>();
  for (const { capability, config } of enabled) {
    for (const b of capability.tools?.(ctx, config) ?? []) {
      for (const t of b.tools) {
        const other = seen.get(t.name);
        if (other) throw new Error(`tool "${t.name}" is given by both the ${other} and the ${capability.id} capabilities`);
        seen.set(t.name, capability.id);
      }
      const same = out.findIndex((o) => o.serverName === b.serverName);
      if (same < 0) out.push(b);
      else out[same] = { ...out[same]!, tools: [...out[same]!.tools, ...b.tools] };
    }
  }
  return out;
}

/** The names of every enabled capability's owner-only tools. */
export function capabilityOwnerOnly(enabled: readonly EnabledCapability[]): Set<string> {
  return new Set(enabled.flatMap(({ capability }) => capability.ownerOnly ?? []));
}

export function capabilitySections(enabled: readonly EnabledCapability[], ctx: PromptContext): string[] {
  return enabled.flatMap(({ capability, config }) => capability.section?.(ctx, config) ?? []);
}

/** Whether any enabled capability holds `event` back for now (see `Capability.holds`). */
export function capabilityHolds(enabled: readonly EnabledCapability[], event: ChatEvent, now: number): boolean {
  return enabled.some(({ capability, config }) => capability.holds?.(event, now, config) ?? false);
}

/** Everything the enabled capabilities show of `event` beyond its text, in registry order. */
export function capabilityPerception(enabled: readonly EnabledCapability[], event: ChatEvent): ToolContent[] {
  return enabled.flatMap(({ capability, config }) => capability.perceive?.(event, config) ?? []);
}

export function capabilityJobKinds(enabled: readonly EnabledCapability[]): JobKind[] {
  return enabled.flatMap(({ capability, config }) => capability.jobKinds?.(config) ?? []);
}

/** Every enabled capability's loops, each handed the job kinds of all of them. */
export function capabilityLoops(enabled: readonly EnabledCapability[], ctx: ServerContext): ServerLoop[] {
  const full: ServerContext = { ...ctx, jobKinds: ctx.jobKinds ?? capabilityJobKinds(enabled) };
  return enabled.flatMap(({ capability, config }) => capability.loops?.(full, config) ?? []);
}

/** Define a capability with its config type inferred. */
export function defineCapability<C>(c: Capability<C>): Capability<C> {
  return c;
}
