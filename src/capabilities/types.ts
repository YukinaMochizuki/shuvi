import type { ToolBundle, ToolContent } from "agent-runtime";
import type { TurnState } from "../agent/turn.ts";
import type { Db } from "../store/db.ts";
import type { Chat, ChatEvent } from "../store/events.ts";
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
 *
 * The turn context carries the chat, so a later per-chat filter (policy.yaml, design §8) can sit in front
 * of `tools` and `section` without changing this interface.
 */

/** What a turn hands a capability's tools. */
export interface TurnContext {
  db: Db;
  chat: Chat;
  turnId: number;
  timeZone: string;
  owner: OwnerInfo;
  /** The turn's speech state (agent/turn.ts). Only speech should need to touch it. */
  state: TurnState;
}

export interface OwnerInfo {
  name?: string;
  /** The language the owner speaks (`SHUVI_OWNER_LANGUAGE`). */
  language?: string;
}

/** What the system prompt hands a capability's section. */
export interface PromptContext {
  home: string;
  chat: Chat;
  owner: OwnerInfo;
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

/** The environment a capability reads its configuration from (`process.env` in production). */
export type Env = Record<string, string | undefined>;

export interface Capability<C = unknown> {
  /** Also the folder name: `src/capabilities/<id>/`. */
  readonly id: string;
  /** Read this capability's configuration from `env`. `null`: it is off in this process. */
  enable(env: Env): C | null;
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
}

/** A capability that is on in this process, with the configuration it read. */
export interface EnabledCapability<C = unknown> {
  capability: Capability<C>;
  config: C;
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

export function capabilityTools(enabled: readonly EnabledCapability[], ctx: TurnContext): ToolBundle[] {
  return enabled.flatMap(({ capability, config }) => capability.tools?.(ctx, config) ?? []);
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

export function capabilityLoops(enabled: readonly EnabledCapability[], ctx: ServerContext): ServerLoop[] {
  return enabled.flatMap(({ capability, config }) => capability.loops?.(ctx, config) ?? []);
}

/** Define a capability with its config type inferred. */
export function defineCapability<C>(c: Capability<C>): Capability<C> {
  return c;
}
