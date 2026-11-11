import type { BackendAdapter, Prompt, ToolBoundary } from "agent-runtime";
import { capabilityHolds, capabilityOwnerOnly, capabilityPerception, capabilityTools, type EnabledCapability, type OwnerInfo } from "../capabilities/types.ts";
import type { Db } from "../store/db.ts";
import { raiseAlert } from "../store/control.ts";
import {
  enqueueOutbound,
  getChat,
  recentHistory,
  resetConversation,
  triggersAfter,
  type ApprovalPayload,
  type Chat,
  type ChatEvent,
  type ExternalPayload,
  type JobDonePayload,
  type MessagePayload,
  type ScheduledPayload,
} from "../store/events.ts";
import { getJob } from "../store/jobs.ts";
import { getSchedule } from "../store/schedules.ts";
import { chatLabel, extendTurn, finishTurn, getTurn, saveSession } from "../store/turns.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { renderMidTurn, renderTurnInput, renderWithHistory, type Perceive } from "./render.ts";

/** How many earlier events a fresh conversation opens with (docs/design.md §13, `/new`). */
export const HISTORY_ON_NEW = 10;

/**
 * What the driver's error says when the conversation it was asked to continue no longer exists (the
 * Claude Code session file is gone: a new machine, a cleaned config dir). It is the Claude Code CLI's own
 * text, which agent-runtime appends to its error as `Claude Agent SDK run ended with
 * "error_during_execution": No conversation found with session ID: <id>` (pinned in test/turn.test.ts).
 * Only this exact text counts: a generic failure may be an outage or an expired login, and resetting the
 * conversation on those would throw its context away for nothing.
 */
export const LOST_SESSION_TEXT = "No conversation found with session ID";

export function isLostSession(e: unknown): boolean {
  return (e instanceof Error ? e.message : String(e)).includes(LOST_SESSION_TEXT);
}

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
 * PERCEPTION GATING: a message a capability still holds (a picture still downloading, `Capability.holds`)
 * is not taken in yet, nor anything after it, so the chat stays in order; the next tool call or the next
 * turn takes it, once ready or once the short wait is over. What a message shows (an image) follows its line
 * (`Capability.perceive`), in the turn's input and in what is appended.
 *
 * The turn's tools and the capability sections of its system prompt come from the enabled capabilities
 * (src/capabilities/), in registry order; this module does not know which capabilities exist.
 *
 * A LOST conversation (`continueRun` fails with `LOST_SESSION_TEXT`) is not a failure of the turn: the
 * chat's conversation is reset and the same turn runs again at once, once, as a fresh conversation that
 * opens with the last `HISTORY_ON_NEW` messages (as after `/new`). It costs no failure attempt; the owner
 * is told through the control bot.
 */

export interface TurnDeps {
  db: Db;
  turnId: number;
  home: string;
  timeZone: string;
  ownerName?: string;
  /** The owner's Telegram user id: a turn whose input holds their message is owner-triggered. */
  ownerId?: number;
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
  /** The cursor the turn started from: what it has been shown is (fromSeq, toSeq]. */
  fromSeq: number;
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

/**
 * The events up to (not including) the first one a capability still holds. Events at or before `always`
 * are kept regardless: the turn was claimed for them.
 */
export function untilHeld(events: ChatEvent[], capabilities: readonly EnabledCapability[], now: number, always = 0): ChatEvent[] {
  const i = events.findIndex((e) => e.seq > always && capabilityHolds(capabilities, e, now));
  return i < 0 ? events : events.slice(0, i);
}

/** Who may make owner-only calls in this turn: the owner's id, and the tools that need them. */
export interface TurnAuthority {
  ownerId?: number;
  ownerOnly: ReadonlySet<string>;
}

/**
 * May this turn act for the owner NOW? Decided at each owner-only call, over everything the turn has been
 * shown so far, (fromSeq, toSeq], the initial input and every mid-turn append alike, because authority
 * follows the sender (design §8) and a turn's senders can change while it runs:
 *
 *   - a `message` must be from the owner's user id: anyone else's line in the turn blocks the call, even
 *     when the owner wrote too (what a stranger wrote may be what the model is acting on);
 *   - a `scheduled` / `job_done` counts as the owner's only when its schedule or job was created by a call
 *     the owner authorised (`owner_authorised` on its row); otherwise it blocks like a stranger's line;
 *   - an `external` event blocks like a stranger's line: text that arrived from outside never rides along
 *     with the owner's authority (the owner can ask again in a turn of their own);
 *   - an answered `approval` counts as the owner's: only the owner can press its button in the control bot.
 *     One that expired unanswered is nobody's: it neither blocks nor counts;
 *   - and at least one event must be the owner's.
 *
 * Returns null when the call may run, or why it may not, in words the model can pass on.
 */
export function ownerAuthority(db: Db, chatId: number, fromSeq: number, toSeq: number, ownerId: number | undefined): string | null {
  let owners = 0;
  for (const e of triggersAfter(db, chatId, fromSeq)) {
    if (e.seq > toSeq) break;
    if (e.kind === "message") {
      const from = (e.payload as unknown as MessagePayload).from;
      if (ownerId === undefined || from.id !== ownerId) return `#${e.seq} in this turn is from ${from.name}, not the owner`;
      owners++;
    } else if (e.kind === "scheduled" || e.kind === "job_done") {
      const authorised =
        e.kind === "scheduled" ? getSchedule(db, (e.payload as unknown as ScheduledPayload).scheduleId)?.ownerAuthorised : getJob(db, (e.payload as unknown as JobDonePayload).jobId)?.ownerAuthorised;
      if (!authorised) return `#${e.seq} in this turn is a ${e.kind === "scheduled" ? "schedule" : "job"} the owner did not set up`;
      owners++;
    } else if (e.kind === "approval") {
      if ((e.payload as unknown as ApprovalPayload).answer !== null) owners++;
    } else if (e.kind === "external") {
      return `#${e.seq} in this turn came from outside (inbound: ${(e.payload as unknown as ExternalPayload).source}), not from the owner`;
    }
  }
  return owners ? null : "nothing in this turn is from the owner";
}

/**
 * The boundary around every tool call of the turn: refuse after `pass`, refuse an owner-only call the
 * turn has no authority for (`ownerAuthority`), append what arrived meanwhile.
 */
export function turnBoundary(
  db: Db,
  s: TurnState,
  timeZone: string,
  capabilities: readonly EnabledCapability[] = [],
  authority: TurnAuthority = { ownerOnly: capabilityOwnerOnly(capabilities) },
): ToolBoundary {
  const perceive: Perceive = (e) => capabilityPerception(capabilities, e);
  return {
    refuse(call) {
      if (s.passed && call.name !== "pass") return "This turn has already passed. End it now; call no more tools.";
      if (authority.ownerOnly.has(call.name)) {
        const why = ownerAuthority(db, s.chat.id, s.fromSeq, s.toSeq, authority.ownerId);
        if (why) return `Refused: \`${call.name}\` acts for the owner, and only the owner may ask for it; ${why}. Nothing was done. If someone asked for this, tell them only the owner can.`;
      }
      return null;
    },
    append() {
      // After `pass` (the turn is over) or a stop (it is being abandoned), a message that arrives is not
      // this turn's to answer: leave it past to_seq, and the next turn answers it.
      if (s.passed || s.stopping) return null;
      const fresh = untilHeld(triggersAfter(db, s.chat.id, s.toSeq), capabilities, Date.now());
      if (!fresh.length) return null;
      s.toSeq = fresh.at(-1)!.seq;
      extendTurn(db, s.turnId, s.toSeq);
      return renderMidTurn(fresh, timeZone, perceive);
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

  const input = untilHeld(triggersAfter(db, chat.id, turn.fromSeq), deps.capabilities, Date.now(), turn.toSeq);
  const perceive: Perceive = (e) => capabilityPerception(deps.capabilities, e);
  // A fresh conversation (the first turn, or after `/new`) opens with the chat's last few exchanges, so
  // starting over forgets the model's context, not what was just being talked about.
  if (!input.length) {
    finishTurn(db, turnId, { status: "done" });
    return "empty";
  }
  // Everything said before the first message being answered, the assistant's own replies included
  // (those come after the cursor, so the cursor is not the bound).
  const history = chat.backendSessionId ? [] : recentHistory(db, chat.id, input[0]!.seq - 1, HISTORY_ON_NEW);
  const s: TurnState = { chat, turnId, passed: false, stopping: deps.signal?.aborted ?? false, n: 0, fromSeq: turn.fromSeq, toSeq: input.at(-1)!.seq };
  deps.signal?.addEventListener("abort", () => (s.stopping = true), { once: true });
  extendTurn(db, turnId, s.toSeq);

  let buf = "";
  const flush = () => {
    queueMessage(db, s, buf);
    buf = "";
  };

  const authority: TurnAuthority = { ...(deps.ownerId !== undefined ? { ownerId: deps.ownerId } : {}), ownerOnly: capabilityOwnerOnly(deps.capabilities) };
  const adapter = deps.makeAdapter(turnBoundary(db, s, deps.timeZone, deps.capabilities, authority));
  const firstOwnerMessage = input.find((e) => e.kind === "message" && (deps.ownerId === undefined || (e.payload as unknown as MessagePayload).from.id === deps.ownerId));
  const ownerName = deps.ownerName ?? (firstOwnerMessage ? (firstOwnerMessage.payload as unknown as MessagePayload).from.name : undefined);
  const owner: OwnerInfo = { ...(ownerName ? { name: ownerName } : {}), ...(deps.ownerLanguage ? { language: deps.ownerLanguage } : {}) };
  const tools = capabilityTools(deps.capabilities, { db, home: deps.home, chat, turnId, timeZone: deps.timeZone, owner, state: s });
  const prompt = history.length ? renderWithHistory(history, input, deps.timeZone, perceive) : renderTurnInput(input, deps.timeZone, perceive);
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

  // Built fresh every turn and sent on a resume too, so an edit to home/ reaches the model from the next
  // turn without `/new`. The driver decides whether a resume honours it: the runner's Claude driver does
  // (`liveSystemPrompt`), and openai-compat always sends the prompt it is given.
  const systemPrompt = buildSystemPrompt(deps.home, chat, owner, deps.capabilities);
  const fresh = (p: Prompt) => adapter.run({ prompt: p, tools, systemPrompt, ...(deps.model ? { model: deps.model } : {}) }, opts);
  try {
    let result;
    if (!chat.backendSessionId) result = await fresh(prompt);
    else {
      try {
        result = await adapter.continueRun(
          { backendSessionId: chat.backendSessionId, prompt, tools, systemPrompt, ...(deps.model ? { model: deps.model } : {}), ...(chat.contextTokens ? { contextTokens: chat.contextTokens } : {}) },
          opts,
        );
      } catch (e) {
        if (deps.signal?.aborted || !isLostSession(e)) throw e;
        resetConversation(db, chat.id);
        raiseAlert(db, {
          key: `lost-session:${turnId}`,
          topic: `lost-session:${chat.id}`,
          text: `The conversation of ${chatLabel(chat)} was lost (${chat.backendSessionId}); turn ${turnId} restarted it fresh with the last ${HISTORY_ON_NEW} messages.`,
        });
        buf = "";
        lastThinking = false;
        const lastSeen = recentHistory(db, chat.id, input[0]!.seq - 1, HISTORY_ON_NEW);
        result = await fresh(lastSeen.length ? renderWithHistory(lastSeen, input, deps.timeZone, perceive) : renderTurnInput(input, deps.timeZone, perceive));
      }
    }
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
