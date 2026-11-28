import type { ToolBundle, ToolContent, ToolResult } from "agent-runtime";
import type { TurnState } from "../agent/turn.ts";
import { resolveChat, type ChatPolicy, type Policy, type ToolParams } from "../policy/policy.ts";
import type { Db } from "../store/db.ts";
import { getChat, type Chat, type ChatEvent } from "../store/events.ts";
import type { JobKind } from "../store/jobs.ts";
import { HomeLayers } from "./memory/layers.ts";
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
 *   - A tool that acts for the owner only in SOME calls (video_sheet on a file of the computer, but not on a
 *     link) names the calls in `ownerOnlyWhen`; the boundary decides those the same way. A refusal can say
 *     why and what to offer instead (`ownerOnlyNote`), in words the model can pass on.
 *   - Of its owner-only tools, those a group's policy may hand to that group's OPERATORS (policy.ts
 *     `operators`, `delegate`) are named in `delegable`; the boundary then lets an operator's turn call
 *     them too, and tells the tool who it acts for (TurnState `acting`). A tool that would hand out what is
 *     the owner's (his files, secrets, settings, other chats) is never delegable. A delegable tool that
 *     starts lasting work (a job, a schedule) records who authorised it (`authorisedBy` on the row).
 *   - Its `inbound` hook (the server's, for each new message in a chat whose policy enables it) only starts
 *     work and returns: it never delays recording or the turn.
 *   - A credential it holds (`secrets`) is redacted from turn transcripts like the secret profiles' values.
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
  /**
   * home/ as this chat sees it, its profile overlaid (memory/layers.ts): EVERY read or write of one of her files
   * (persona, directives, memory, notes, playbooks, stickers) goes through it. Absent: the base (`layersIn`).
   */
  layers?: HomeLayers;
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

/** The context's layers: its own, or the base of its home/. */
export const layersIn = (ctx: { home: string; layers?: HomeLayers }): HomeLayers => ctx.layers ?? HomeLayers.base(ctx.home);

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
  /** As TurnContext's. */
  layers?: HomeLayers;
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
  /** The policy in effect now (it is reloaded when home/policy.yaml changes). Absent: the default policy. */
  policy?: () => Policy;
  /** Download a file someone sent. Read-only: it cannot send anything. */
  files: TelegramFiles;
  /** Aborted when the server is shutting down. */
  signal: AbortSignal;
  /** Every enabled capability's job kinds (`jobKinds`), filled by `capabilityLoops`. */
  jobKinds?: readonly JobKind[];
  /** Every enabled capability's hook routes (`hookRoutes`), filled by `capabilityLoops`. */
  hookRoutes?: readonly HookRoute[];
}

/**
 * A route a capability adds to the hook endpoints (jobs/hooks.ts), for a caller that talks to that
 * capability alone (workstream's wake). Served beside `/jobs/<id>/report` and `/inbound/<source>`, under
 * the same body cap, and only when SHUVI_HOOK_LISTEN is set. The route brings its own check, `authorize`,
 * which the hooks server runs BEFORE it reads the body (401 when it fails): nothing of an unauthenticated
 * request is read or written.
 */
export interface HookRoute {
  /** The exact path, e.g. "/workstream/wake". POST only. */
  path: string;
  /** Whether the request may be heard (its token), from its headers alone. */
  authorize(req: Request): boolean;
  /** Only after `authorize`. `body` is the request body as text, already read and held to the cap. */
  handle(req: Request, body: string, ctx: { db: Db }): Response | Promise<Response>;
}

/** What a capability's `perceive` (and `holds`) may read besides the event: the store (read only). */
export interface PerceiveContext {
  db?: Db;
  /**
   * In a turn's input: what each capability's `prepare` returned for this turn, by capability id. A capability's
   * `perceive` is handed its own (`prepared`), never another's.
   */
  prepared?: ReadonlyMap<string, unknown>;
}

/**
 * What a capability's `holds` gets: what `perceive` may read, and where the event is being taken in.
 */
export interface HoldContext extends PerceiveContext {
  /**
   * The event would be APPENDED to a running turn (the boundary's `append`), not open a turn. A hold that only
   * makes sense before a turn opens (media's auto-read: `prepare` runs only then) does not hold it here.
   */
  appending?: boolean;
  /**
   * Would a turn answering this event (up to it) be let call `tool` with `args`, by the boundary's own authority
   * rule (agent/turn.ts `callRefusal`)? Decided without running anything. Absent: not known here (treat as yes;
   * the runner's boundary still decides the call).
   */
  mayCall?(tool: string, args: Record<string, unknown>): boolean;
}

/**
 * What a capability's `prepare` gets: the turn, and a way to call ITS OWN tools (those its `tools` gave this turn,
 * and no other capability's: never `say`, `pass`, `react` or `sticker`, nor another capability's) THROUGH THE
 * TURN'S BOUNDARY (agent/turn.ts `turnBoundary`), exactly as a model's call goes: refused after `pass` or without
 * the authority it needs (`ownerOnly`, `ownerOnlyWhen`), run in its call's context, recorded in the transcript, but
 * marked as made by the framework (`turn_steps.made_by`). Nothing is appended to its result. `capabilityPrepare`
 * binds `call` and `refusal` to the calling capability's tools; a name outside them is answered null.
 */
export interface PrepareContext {
  db: Db;
  chat: Chat;
  turnId: number;
  chatPolicy?: ChatPolicy;
  /** Call one of this capability's tools; null when it is not one of them (or the turn has no such tool). */
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> | null;
  /**
   * Would the boundary refuse that call now (`pass`, authority)? Its refusal text, or null when it would run;
   * nothing is run or recorded. A tool that is not this capability's is always refused.
   */
  refusal(name: string, args: Record<string, unknown>): string | null;
  /** Aborted when the turn is being stopped (`/stop`, the drain's deadline): a prepare gives up then. */
  signal?: AbortSignal;
  /** A note in the turn's transcript (what the framework did, and why). */
  note(text: string): void;
}

/** What the turn hands `capabilityPrepare`: a PrepareContext for any tool, and which capability gave each tool. */
export interface PrepareSeam extends Omit<PrepareContext, "call" | "refusal"> {
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> | null;
  refusal(name: string, args: Record<string, unknown>): string | null;
  /** Tool name → the id of the capability that gave it this turn (`capabilityTools`' `owners`). */
  owners: ReadonlyMap<string, string>;
}

/** What the server hands a capability's `inbound` hook. No Telegram API, as for a loop. */
export interface InboundHookContext {
  db: Db;
  ownerId: number;
  /**
   * Ask the waker for a pass now. Work an inbound hook started in the background calls it when something a
   * hold (`holds`) waits on has become ready (a prewarm finished), so the held turn starts at once rather than
   * at the waker's next poll. Optional and best effort: the waker polls anyway.
   */
  wake?: () => void;
}

/** What a capability's `inbound` hook gets for one event: the server's context, and the event's chat policy. */
export interface InboundEventContext extends InboundHookContext {
  /** The event's chat's policy, resolved (policy.ts `resolveChat`): e.g. to ask `isTrigger` what the waker will. */
  chatPolicy: ChatPolicy;
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
   * It lets her look back through what was said (retrieval: search_chats, read_chat). Left out of a CLEAN
   * conversation's turns (`chats.clean_since`, agent/switch.ts; `turnCapabilities`), tools and section alike.
   */
  looksBack?: boolean;
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
  holds?(event: ChatEvent, now: number, config: C, ctx: HoldContext): boolean;
  /**
   * What the model is shown of `event` beyond its text line (an image, a note), in a turn's input or an
   * append. It only reads: `ctx.db` is there to read what the server recorded about the event.
   */
  perceive?(event: ChatEvent, config: C, ctx: Omit<PerceiveContext, "prepared"> & { prepared?: unknown }): ToolContent[];
  /**
   * Work done in the runner child for a turn's input BEFORE the driver is called (media's auto-read: a short
   * message's link read ahead). `events` are the events the turn answers (no context lines). It may call ITS OWN
   * tools, and only those, through the turn's boundary (`PrepareContext.call`); what it returns is handed back to its own
   * `perceive` (`ctx.prepared`) when the input is rendered. It must never speak (invariant 5) and should be
   * quick: the model waits on it. A throw is logged and the turn goes on without it.
   */
  prepare?(events: readonly ChatEvent[], ctx: PrepareContext, config: C): Promise<unknown>;
  /**
   * The server's hook for each NEW inbound message or command, right after it is recorded and before any
   * turn for it can start, in chats whose policy enables this capability. It may write rows (synchronously,
   * so a turn rendered after it sees them) and start async work, which it must not await: it returns at
   * once. A throw is logged and ignored.
   */
  inbound?(event: ChatEvent, ctx: InboundEventContext, config: C): void;
  /**
   * Credentials this capability holds (a service token), by a label: redacted from turn transcripts as
   * `[REDACTED:<label>]`, like the secret profiles' values.
   */
  secrets?(config: C): Record<string, string>;
  /** The kinds of job it starts (store/jobs.ts): how the jobs watcher polls them. */
  jobKinds?(config: C): JobKind[];
  /** Routes it adds to the hook endpoints (see `HookRoute`). */
  hookRoutes?(config: C): HookRoute[];
  /**
   * The names of its tools that act for the owner. The turn's boundary refuses a call to one unless the
   * owner himself is in the turn (agent/turn.ts `ownerAuthority`).
   */
  ownerOnly?: readonly string[];
  /**
   * Tools that act for the owner only in some calls, with which: `video_sheet: (a) => a.path !== undefined`.
   * Decided by the same boundary, at call time, from the call's arguments.
   */
  ownerOnlyWhen?: Readonly<Record<string, (args: Record<string, unknown>) => boolean>>;
  /**
   * For an owner-only tool (or call), what a refusal adds: why only the owner may ask, and what can be done
   * instead, in a sentence the model can relay. Absent: the boundary's general advice.
   */
  ownerOnlyNote?: Readonly<Record<string, string>>;
  /**
   * Of `ownerOnly` and `ownerOnlyWhen`, the tools a group's policy may delegate to its operators
   * (`delegate: [<this id>]`). Absent: none.
   */
  delegable?: readonly string[];
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

/**
 * The capabilities a turn of `chat` uses: those its policy enables (`chatCapabilities`), less those that look back
 * (`looksBack`) when its conversation is a clean one (`chats.clean_since`, agent/switch.ts). They stay the same for
 * as long as the conversation lasts.
 */
export function turnCapabilities(enabled: readonly EnabledCapability[], tools: ChatPolicy["tools"], chat: { cleanSince: number | null }): EnabledCapability[] {
  const caps = chatCapabilities(enabled, tools);
  return chat.cleanSince == null ? caps : caps.filter((c) => !c.capability.looksBack);
}

/** Whether any of `enabled` lets her look back through what was said (`looksBack`). */
export const looksBack = (enabled: readonly EnabledCapability[]): boolean => enabled.some((c) => c.capability.looksBack);

/** The enabled capabilities of `registry`, in registry order. */
export function enableCapabilities(registry: readonly Capability<any>[], env: Env): EnabledCapability[] {
  const out: EnabledCapability[] = [];
  for (const capability of registry) {
    // A programming error, found by the first start or test: `delegable` hands over owner-only tools only.
    const ownerOnly = new Set([...(capability.ownerOnly ?? []), ...Object.keys(capability.ownerOnlyWhen ?? {})]);
    for (const t of capability.delegable ?? []) if (!ownerOnly.has(t)) throw new Error(`capability ${capability.id}: delegable "${t}" is not one of its owner-only tools`);
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
export function capabilityTools(enabled: readonly EnabledCapability[], ctx: TurnContext, owners?: Map<string, string>): ToolBundle[] {
  const out: ToolBundle[] = [];
  // `owners`, when given, is filled with which capability gave each tool (for `capabilityPrepare`).
  const seen = owners ?? new Map<string, string>();
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

/** The tools owner-only in some calls (`ownerOnlyWhen`), with the test saying which. */
export function capabilityOwnerOnlyWhen(enabled: readonly EnabledCapability[]): Map<string, (args: Record<string, unknown>) => boolean> {
  return new Map(enabled.flatMap(({ capability }) => Object.entries(capability.ownerOnlyWhen ?? {})));
}

/**
 * The owner-only tools this chat's policy delegates to its operators: the `delegable` tools of the enabled
 * capabilities its `delegate` names. Empty without operators.
 */
export function capabilityDelegated(enabled: readonly EnabledCapability[], chatPolicy: ChatPolicy | undefined): Set<string> {
  if (!chatPolicy?.operators) return new Set();
  return new Set(enabled.filter(({ capability }) => chatPolicy.delegate.includes(capability.id)).flatMap(({ capability }) => capability.delegable ?? []));
}

/** Does this chat's policy delegate capability `id`'s delegable tools to operators? */
export function policyDelegates(chatPolicy: ChatPolicy | undefined, id: string): boolean {
  return !!chatPolicy?.operators && chatPolicy.delegate.includes(id);
}

/** What a refusal of each owner-only tool adds (`ownerOnlyNote`). */
export function capabilityOwnerOnlyNotes(enabled: readonly EnabledCapability[]): Map<string, string> {
  return new Map(enabled.flatMap(({ capability }) => Object.entries(capability.ownerOnlyNote ?? {})));
}

/** Every enabled capability's credentials (`secrets`), value → label, for the transcript's redaction. */
export function capabilitySecrets(enabled: readonly EnabledCapability[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const { capability, config } of enabled) for (const [label, value] of Object.entries(capability.secrets?.(config) ?? {})) if (value) out.set(value, label);
  return out;
}

/** `redact`, then every capability credential replaced by `[REDACTED:<label>]` (raw, and as JSON escapes it). */
export function withCapabilitySecrets(redact: (s: string) => string, enabled: readonly EnabledCapability[]): (s: string) => string {
  const pairs = [...capabilitySecrets(enabled)].flatMap(([v, l]) => {
    const json = JSON.stringify(v).slice(1, -1);
    return json === v ? [[v, l] as const] : [[v, l] as const, [json, l] as const];
  });
  if (!pairs.length) return redact;
  return (s) => {
    let out = redact(s);
    for (const [v, l] of pairs) if (out.includes(v)) out = out.split(v).join(`[REDACTED:${l}]`);
    return out;
  };
}

/**
 * The server's inbound hooks for newly recorded events: each event goes to the `inbound` of every capability
 * its chat's policy enables (a chat policy no longer lists: none), with that policy (`InboundEventContext`). A
 * hook that throws is logged; the rest run.
 */
export function capabilityInbound(enabled: readonly EnabledCapability[], events: readonly ChatEvent[], policy: Policy, ctx: InboundHookContext): void {
  if (!enabled.some(({ capability }) => capability.inbound)) return;
  for (const event of events) {
    const chat = getChat(ctx.db, event.chatId);
    const chatPolicy = chat ? resolveChat(policy, chat, ctx.ownerId) : null;
    if (!chatPolicy) continue;
    const eventCtx: InboundEventContext = { ...ctx, chatPolicy };
    for (const { capability, config } of chatCapabilities(enabled, chatPolicy.tools)) {
      if (!capability.inbound) continue;
      try {
        capability.inbound(event, eventCtx, config);
      } catch (e) {
        console.error(`${capability.id}: inbound hook failed on #${event.seq}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

/** Does this chat's policy enable capability `id`? (No policy at all: the default, every capability.) */
export function policyEnables(chatPolicy: ChatPolicy | undefined, id: string): boolean {
  return !chatPolicy || chatPolicy.tools === "all" || chatPolicy.tools[id] !== undefined;
}

/** Whether any enabled capability holds `event` back for now (see `Capability.holds`). */
export function capabilityHolds(enabled: readonly EnabledCapability[], event: ChatEvent, now: number, ctx: HoldContext = {}): boolean {
  return enabled.some(({ capability, config }) => capability.holds?.(event, now, config, ctx) ?? false);
}

/** Everything the enabled capabilities show of `event` beyond its text, in registry order. */
export function capabilityPerception(enabled: readonly EnabledCapability[], event: ChatEvent, ctx: PerceiveContext = {}): ToolContent[] {
  return enabled.flatMap(({ capability, config }) => capability.perceive?.(event, config, { ...ctx, prepared: ctx.prepared?.get(capability.id) }) ?? []);
}

/**
 * Every enabled capability's `prepare` for a turn's `events`, at once; what each returned, by capability id. Each is
 * handed `call` and `refusal` bound to ITS OWN tools (`seam.owners`): a capability's prepare cannot reach speech's
 * `say` / `pass` / `react`, nor any other capability's tool. Never throws.
 */
export async function capabilityPrepare(enabled: readonly EnabledCapability[], events: readonly ChatEvent[], seam: PrepareSeam): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  const { owners, call, refusal, ...rest } = seam;
  await Promise.all(
    enabled.map(async ({ capability, config }) => {
      if (!capability.prepare) return;
      const own = (name: string) => owners.get(name) === capability.id;
      const ctx: PrepareContext = {
        ...rest,
        call: (name, args, signal) => (own(name) ? call(name, args, signal) : null),
        refusal: (name, args) => (own(name) ? refusal(name, args) : `\`${name}\` is not one of ${capability.id}'s tools`),
      };
      try {
        out.set(capability.id, await capability.prepare(events, ctx, config));
      } catch (e) {
        console.error(`${capability.id}: prepare failed for turn ${ctx.turnId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );
  return out;
}

export function capabilityJobKinds(enabled: readonly EnabledCapability[]): JobKind[] {
  return enabled.flatMap(({ capability, config }) => capability.jobKinds?.(config) ?? []);
}

export function capabilityHookRoutes(enabled: readonly EnabledCapability[]): HookRoute[] {
  return enabled.flatMap(({ capability, config }) => capability.hookRoutes?.(config) ?? []);
}

/** Every enabled capability's loops, each handed the job kinds and hook routes of all of them. */
export function capabilityLoops(enabled: readonly EnabledCapability[], ctx: ServerContext): ServerLoop[] {
  const full: ServerContext = { ...ctx, jobKinds: ctx.jobKinds ?? capabilityJobKinds(enabled), hookRoutes: ctx.hookRoutes ?? capabilityHookRoutes(enabled) };
  return enabled.flatMap(({ capability, config }) => capability.loops?.(full, config) ?? []);
}

/** Define a capability with its config type inferred. */
export function defineCapability<C>(c: Capability<C>): Capability<C> {
  return c;
}
