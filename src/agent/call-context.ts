import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which tool call is running, for code deep inside a tool that needs to say so without every handler passing it
 * down. The turn's boundary (agent/turn.ts `turnBoundary`, agent-runtime's `around`) runs each handler inside
 * one; a home/ commit made in it carries the turn, the chat and the call as trailers (capabilities/memory/home.ts),
 * which is how the console's Home page tells which turn and which call changed a file.
 *
 * Outside a tool call (a server loop, a test, the console) there is none, and nothing may depend on there being
 * one: it labels, and it carries the call's abort signal when the call has one (a framework call's cap or the
 * turn's stop, capabilities/types.ts `PrepareContext.call`), which a handler may pass on to what it waits for.
 */
export interface CallContext {
  turnId: number;
  /** The chat's row id (`chats.id`), not its Telegram id. */
  chatId: number;
  /** The boundary's call id, the one the turn's transcript records the call under (`turn_steps.call_id`). */
  callId: string;
  /** The tool's bare name. */
  tool: string;
  /** Aborts when the caller gives up on the call (agent-runtime's `ToolCall.signal`), when it has one. */
  signal?: AbortSignal;
}

const store = new AsyncLocalStorage<CallContext>();

/** The call this code runs in, if any. */
export function currentCall(): CallContext | undefined {
  return store.getStore();
}

/** Run `fn` as part of call `ctx`. */
export function withCall<T>(ctx: CallContext, fn: () => Promise<T>): Promise<T> {
  return store.run(ctx, fn);
}
