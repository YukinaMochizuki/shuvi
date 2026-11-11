import type { BackendAdapter, ToolBoundary } from "agent-runtime";
import { capabilityTools, type EnabledCapability, type OwnerInfo } from "../capabilities/types.ts";
import type { Db } from "../store/db.ts";
import { enqueueOutbound, getChat, recentHistory, triggersAfter, type Chat, type MessagePayload } from "../store/events.ts";
import { extendTurn, finishTurn, getTurn, saveSession } from "../store/turns.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { renderMidTurn, renderTurnInput, renderWithHistory } from "./render.ts";

/** How many earlier events a fresh conversation opens with (docs/design.md §13, `/new`). */
export const HISTORY_ON_NEW = 10;

/**
 * One turn, from the events it answers to the messages it leaves queued. The runner child calls this; it
 * takes the driver as a factory so tests can run the whole turn on a scripted adapter.
 *
 * How the model's output becomes messages (docs/design.md §4, "C'"):
 *   - Reply TEXT (not thinking) is buffered and becomes one message at each boundary: when a tool call
 *     arrives (`onTool`, which fires before the tool runs, so the text before a `say` is queued before the
 *     `say`), and when the turn ends. Thinking is never sent: on Opus 5.5 it carries reasoning summaries
 *     that cannot be told apart from progress notes.
 *   - `say` queues a message mid-turn, for progress the model wants the person to see. The `say`, `react`
 *     and `pass` tools live in src/capabilities/speech/; the rules they rely on (queueMessage, the
 *     boundary) stay here.
 *   - `pass` ends the turn's speech: nothing written after it is sent, and every later tool call is
 *     refused with a note to stop.
 * Each queued message carries the idempotency key `turn:<id>:<n>`, numbered in the order the turn
 * produced them.
 *
 * Messages that arrive WHILE the turn runs are appended to the next tool result (the runtime's tool
 * boundary), and the turn's `to_seq` widens to cover them, so the cursor rule in store/turns.ts counts
 * them as answered by this turn. One that arrives after the last tool call is left for the next turn.
 *
 * The turn's tools and the capability sections of its system prompt come from the enabled capabilities
 * (src/capabilities/), in registry order; this module does not know which capabilities exist.
 */

export interface TurnDeps {
  db: Db;
  turnId: number;
  home: string;
  timeZone: string;
  ownerName?: string;
  /** The language the owner speaks (`SHUVI_OWNER_LANGUAGE`), named in the system prompt. */
  ownerLanguage?: string;
  model?: string;
  /** The capabilities enabled in this process, in registry order (capabilities/index.ts). */
  capabilities: readonly EnabledCapability[];
  /** The driver for this turn, built around the boundary the turn supplies. */
  makeAdapter: (boundary: ToolBoundary) => BackendAdapter;
  signal?: AbortSignal;
}

export interface TurnState {
  chat: Chat;
  turnId: number;
  passed: boolean;
  /** The turn is being stopped: nothing more is appended to it. */
  stopping: boolean;
  /** Next message number within the turn (the `n` of the idempotency key). */
  n: number;
  /** The last inbound seq the model has been shown. */
  toSeq: number;
}

/** Queue one message of the turn. After `pass` nothing is queued: that is where `pass` closes speech. */
export function queueMessage(db: Db, s: TurnState, text: string): void {
  const body = text.trim();
  if (!body || s.passed) return;
  enqueueOutbound(db, { chatId: s.chat.id, kind: "bot_message", payload: { text: body }, idemKey: `turn:${s.turnId}:${s.n++}`, turnId: s.turnId });
}

export function queueReaction(db: Db, s: TurnState, targetSeq: number, emoji: string): void {
  enqueueOutbound(db, { chatId: s.chat.id, kind: "bot_reaction", payload: { targetSeq, emoji }, idemKey: `turn:${s.turnId}:${s.n++}`, turnId: s.turnId });
}

/** The boundary around every tool call of the turn: refuse after `pass`, append what arrived meanwhile. */
export function turnBoundary(db: Db, s: TurnState, timeZone: string): ToolBoundary {
  return {
    refuse(call) {
      if (s.passed && call.name !== "pass") return "This turn has already passed. End it now; call no more tools.";
      return null;
    },
    append() {
      // After `pass` (the turn is over) or a stop (it is being abandoned), a message that arrives is not
      // this turn's to answer: leave it past to_seq, and the next turn answers it.
      if (s.passed || s.stopping) return null;
      const fresh = triggersAfter(db, s.chat.id, s.toSeq);
      if (!fresh.length) return null;
      s.toSeq = fresh.at(-1)!.seq;
      extendTurn(db, s.turnId, s.toSeq);
      return renderMidTurn(fresh, timeZone);
    },
  };
}

export type TurnOutcome = "done" | "stopped" | "failed" | "empty";

/** Run turn `turnId` to the end and close it. Never throws: a failure is recorded on the turn. */
export async function runTurn(deps: TurnDeps): Promise<TurnOutcome> {
  const { db, turnId } = deps;
  const turn = getTurn(db, turnId);
  if (!turn || turn.status !== "running") return "failed";
  const chat = getChat(db, turn.chatId)!;

  const input = triggersAfter(db, chat.id, turn.fromSeq);
  // A fresh conversation (the first turn, or after `/new`) opens with the chat's last few exchanges, so
  // starting over forgets the model's context, not what was just being talked about.
  if (!input.length) {
    finishTurn(db, turnId, { status: "done" });
    return "empty";
  }
  // Everything said before the first message being answered, the assistant's own replies included
  // (those come after the cursor, so the cursor is not the bound).
  const history = chat.backendSessionId ? [] : recentHistory(db, chat.id, input[0]!.seq - 1, HISTORY_ON_NEW);
  const s: TurnState = { chat, turnId, passed: false, stopping: deps.signal?.aborted ?? false, n: 0, toSeq: input.at(-1)!.seq };
  deps.signal?.addEventListener("abort", () => (s.stopping = true), { once: true });
  extendTurn(db, turnId, s.toSeq);

  let buf = "";
  const flush = () => {
    queueMessage(db, s, buf);
    buf = "";
  };

  const adapter = deps.makeAdapter(turnBoundary(db, s, deps.timeZone));
  const owner: OwnerInfo = { name: deps.ownerName ?? (input[0]!.payload as unknown as MessagePayload).from.name, ...(deps.ownerLanguage ? { language: deps.ownerLanguage } : {}) };
  const tools = capabilityTools(deps.capabilities, { db, chat, turnId, timeZone: deps.timeZone, owner, state: s });
  const prompt = history.length ? renderWithHistory(history, input, deps.timeZone) : renderTurnInput(input, deps.timeZone);
  let lastThinking = false;
  const opts = {
    onToken: (text: string, thinking?: boolean) => {
      // Thinking between two text blocks ends the first block: each text block is its own message, and
      // the runtime joins the prose of one stretch without marking where a block ended.
      if (thinking) lastThinking = true;
      else {
        if (lastThinking) flush();
        lastThinking = false;
        buf += text;
      }
    },
    onTool: () => {
      lastThinking = false;
      flush();
    },
    onSessionId: (id: string) => saveSession(db, chat.id, id),
    ...(deps.signal ? { signal: deps.signal } : {}),
  };

  try {
    const result = chat.backendSessionId
      ? await adapter.continueRun(
          { backendSessionId: chat.backendSessionId, prompt, tools, ...(deps.model ? { model: deps.model } : {}), ...(chat.contextTokens ? { contextTokens: chat.contextTokens } : {}) },
          opts,
        )
      : await adapter.run({ prompt, tools, systemPrompt: buildSystemPrompt(deps.home, chat, owner, deps.capabilities), ...(deps.model ? { model: deps.model } : {}) }, opts);
    flush();
    const u = result.usage;
    finishTurn(db, turnId, { status: "done", usage: u, contextTokens: u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens + u.outputTokens });
    return "done";
  } catch (e) {
    if (deps.signal?.aborted) {
      // A stop: what was half-written is dropped, what was already queued stays queued.
      finishTurn(db, turnId, { status: "stopped" });
      return "stopped";
    }
    finishTurn(db, turnId, { status: "failed", error: e instanceof Error ? e.message : String(e) });
    return "failed";
  }
}
