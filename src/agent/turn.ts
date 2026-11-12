import { dirname } from "node:path";
import type { BackendAdapter, Prompt, ToolBoundary } from "agent-runtime";
import {
  capabilityHolds,
  capabilityOwnerOnly,
  capabilityOwnerOnlyNotes,
  capabilityOwnerOnlyWhen,
  capabilityPerception,
  capabilityTools,
  chatCapabilities,
  type EnabledCapability,
  type OwnerInfo,
} from "../capabilities/types.ts";
import { defaultPolicy, resolveChat, type Policy } from "../policy/policy.ts";
import type { Db } from "../store/db.ts";
import { LostConversationError } from "../store/conversations.ts";
import { raiseAlert } from "../store/control.ts";
import {
  enqueueOutbound,
  getChat,
  previousEvent,
  recentHistory,
  resetConversation,
  triggersAfter,
  type ApprovalPayload,
  type BotMessagePayload,
  type Chat,
  type ChatEvent,
  type ExternalPayload,
  type JobDonePayload,
  type MessagePayload,
  type ScheduledPayload,
} from "../store/events.ts";
import { getJob } from "../store/jobs.ts";
import { getSchedule } from "../store/schedules.ts";
import { chatLabel, extendTurn, finishTurn, getTurn, hadEarlierTurn, saveSession, setTurnConversation } from "../store/turns.ts";
import { buildPromptSections, joinSections } from "./prompt.ts";
import { renderMidTurn, renderTurnInput, renderWithHistory, timeNote, type InputOptions, type Perceive } from "./render.ts";
import { recordingBoundary, TurnRecorder, type RecorderOptions } from "./transcript.ts";
import { isTrigger, type BotIdentity } from "./triggers.ts";

/** How many earlier events a fresh conversation opens with (docs/design.md §13, `/new`). */
export const HISTORY_ON_NEW = 10;
/** In a group, how many unseen messages before the ones that woke the turn it opens with (design §7). */
export const GROUP_CONTEXT = 10;
/**
 * A turn whose first input event comes more than this many minutes after the chat's previous event opens
 * with the "It is now…" line (render.ts `timeNote`); a fresh conversation always does.
 */
export const GAP_NOTE_MINUTES = 60;

/**
 * The "It is now…" line for a turn whose input starts at `first`, or undefined when none is due: when the
 * chat's previous event (store/events.ts `previousEvent`) is more than `GAP_NOTE_MINUTES` before `first`,
 * when there is none, and always when the conversation is `fresh` (the first turn, `/new`, a lost session).
 * `nowIso` is the turn's start. Mid-turn appends never get one.
 */
export function openingTimeNote(db: Db, chatId: number, first: ChatEvent, nowIso: string, timeZone: string, fresh: boolean): string | undefined {
  const prev = previousEvent(db, chatId, first.seq);
  const gap = !prev || Date.parse(first.at) - Date.parse(prev.at) > GAP_NOTE_MINUTES * 60_000;
  return fresh || gap ? timeNote(nowIso, prev?.at, timeZone) : undefined;
}

/**
 * Whether the selected backend's saved conversation no longer exists. Claude reports this through its
 * CLI error text; OpenAI-compatible history uses `LostConversationError` when its durable row is missing.
 * Generic failures may be an outage or an expired login, so they must not discard the conversation.
 */
export const LOST_SESSION_TEXT = "No conversation found with session ID";

export function isLostSession(e: unknown): boolean {
  return e instanceof LostConversationError || (e instanceof Error ? e.message : String(e)).includes(LOST_SESSION_TEXT);
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
 * PER-CHAT POLICY (src/policy/): the turn uses only the capabilities its chat's policy enables
 * (capabilities/types.ts `chatCapabilities`), and the persona and memory layers it allows (prompt.ts). A
 * chat the policy no longer lists gets no turn: it closes at once, as `empty`.
 *
 * IN A GROUP (design §7) most messages are recorded without waking anyone (agent/triggers.ts), so a turn
 * finds many unseen ones past the cursor. It opens with the messages that woke it, preceded by up to
 * `GROUP_CONTEXT` earlier unseen ones, and a line saying how many older ones it does not show; all of
 * them count as seen when it ends. The owner's lines are marked (render.ts). Its first message is sent as
 * a reply to the message that woke it when anyone has spoken since (design §4); that message is recorded
 * on the turn (`turns.trigger_seq`), which is how a follow-up is recognised. The earlier
 * unseen lines it opens with are CONTEXT: rendered under their own heading, and outside the turn's
 * authority (`ownerAuthority`).
 *
 * A SENSE OF TIME: every stamp carries the weekday (render.ts), and a turn that opens after a gap of more
 * than `GAP_NOTE_MINUTES` since the chat's previous event, or as a fresh conversation, starts its input with
 * one line saying what time it is (the turn's start) and how long it has been (`openingTimeNote`). It is in
 * the input, never the system prompt, so the prompt cache is unaffected.
 *
 * A LOST conversation (`isLostSession` recognises the error) is not a failure of the turn: the
 * chat's conversation is reset and the same turn runs again at once, once, as a fresh conversation that
 * opens with the last `HISTORY_ON_NEW` messages (as after `/new`). It costs no failure attempt; the owner
 * is told through the control bot.
 *
 * THE TRANSCRIPT (agent/transcript.ts): the turn is recorded as the model saw it, best effort: its system
 * prompt by section, its input, and a timeline of thinking, text blocks (with the message each became),
 * tool calls and appends. The boundary's record hooks and the driver callbacks feed it; nothing in the turn
 * depends on it.
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
  /** The policy in effect (default: the owner's DM, as it always was). */
  policy?: Policy;
  /** Who the bot is (agent/triggers.ts), to tell which group messages woke the turn. */
  bot?: BotIdentity;
  /** The driver for this turn, built around the boundary the turn supplies. */
  makeAdapter: (boundary: ToolBoundary) => BackendAdapter;
  signal?: AbortSignal;
  /** How the transcript is recorded (agent/transcript.ts). Default: the data dir above `home`, no redaction. */
  record?: RecorderOptions;
}

export interface TurnState {
  chat: Chat;
  turnId: number;
  passed: boolean;
  /** The turn is being stopped: nothing more is appended to it. */
  stopping: boolean;
  /** Next message number within the turn (the `n` of the idempotency key). */
  n: number;
  /**
   * What the turn answers is (fromSeq, toSeq], and owner authority is judged over it: in the DM, from the
   * cursor; in a group, from the first event that woke the turn (the context lines before it are not in it).
   */
  fromSeq: number;
  /** The last inbound seq the model has been shown. */
  toSeq: number;
  /** In a group: the message that woke the turn (its first message replies to it if others spoke since). */
  wokenBy?: number;
  /** Whether the turn's first message has been queued. */
  spoke?: boolean;
  /** In a group: the owner's id, whose lines are marked. */
  markOwner?: number;
}

/** Has anyone said something in the chat after event `seq`? */
function spokeAfter(db: Db, chatId: number, seq: number): boolean {
  return triggersAfter(db, chatId, seq).some((e) => e.kind === "message");
}

/**
 * Queue one message of the turn. After `pass` nothing is queued: that is where `pass` closes speech.
 * Returns the outbound event's seq, or null when nothing was queued.
 */
export function queueMessage(db: Db, s: TurnState, text: string): number | null {
  const body = text.trim();
  if (!body || s.passed) return null;
  const first = !s.spoke;
  s.spoke = true;
  const payload: BotMessagePayload = { text: body };
  if (s.wokenBy !== undefined && first && spokeAfter(db, s.chat.id, s.wokenBy)) payload.replyToSeq = s.wokenBy;
  return enqueueOutbound(db, { chatId: s.chat.id, kind: "bot_message", payload, idemKey: `turn:${s.turnId}:${s.n++}`, turnId: s.turnId });
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
  /** Tools owner-only in some calls, and which (capabilities/types.ts `ownerOnlyWhen`). */
  ownerOnlyWhen?: ReadonlyMap<string, (args: Record<string, unknown>) => boolean>;
  /** What a refusal of a tool adds: why, and what to offer instead (`ownerOnlyNote`). */
  notes?: ReadonlyMap<string, string>;
}

/** The authority rules the enabled capabilities declare, for `ownerId`. */
export function turnAuthority(capabilities: readonly EnabledCapability[], ownerId?: number): TurnAuthority {
  return {
    ...(ownerId !== undefined ? { ownerId } : {}),
    ownerOnly: capabilityOwnerOnly(capabilities),
    ownerOnlyWhen: capabilityOwnerOnlyWhen(capabilities),
    notes: capabilityOwnerOnlyNotes(capabilities),
  };
}

/**
 * May this turn act for the owner NOW? Decided at each owner-only call, over what the turn answers so far,
 * (fromSeq, toSeq]: the events that woke it and everything after them, the initial input and every
 * mid-turn append alike (design §8, "authority follows the sender"). In a group the turn also opens with
 * earlier unseen lines as CONTEXT (`GROUP_CONTEXT`, under "Earlier, before you were called"); those come
 * before `fromSeq` and count for nothing.
 *
 * THE RULE: the turn may act for the owner when the owner HIMSELF is in it: a message from the owner's
 * user id among those that woke it or came after (appended included), or something only he can produce
 * (below). Nothing else is a veto: the owner is usually in the conversation and people talk after his
 * command, so another person's line, inbound text, or a schedule or job he never authorised neither grants
 * authority nor takes it away. Telling whose request is whose is left to the model, and the framework
 * makes it unmistakable: the owner's lines carry a mark nobody else can produce (render.ts, `⚙ owner`),
 * framework events carry `⚙` labels saying what they are, the input says which messages called her, and
 * the group section tells her to act for the owner only on the owner's own request.
 *
 *   - a `message` from the owner's user id counts; anyone else's neither counts nor blocks;
 *   - a `scheduled` / `job_done` counts as the owner's only when its schedule or job was created by a call
 *     the owner authorised (`owner_authorised` on its row); one that was not neither counts nor blocks;
 *   - an `external` event (inbound text) neither counts nor blocks;
 *   - an answered `approval` counts as the owner's: only the owner can press its button in the control bot.
 *     One that expired unanswered is nobody's: it neither blocks nor counts;
 *   - and at least one event must be the owner's: a turn of strangers only, of inbound events only, or
 *     started only by schedules or jobs he never authorised, never acts for the owner.
 *
 * Returns null when the call may run, or why it may not, in words the model can pass on.
 */
export function ownerAuthority(db: Db, chatId: number, fromSeq: number, toSeq: number, ownerId: number | undefined): string | null {
  let owners = 0;
  /** Why not, from the first thing in the turn that is not the owner's (said only if nothing is his). */
  let why: string | undefined;
  for (const e of triggersAfter(db, chatId, fromSeq)) {
    if (e.seq > toSeq) break;
    if (e.kind === "message") {
      const from = (e.payload as unknown as MessagePayload).from;
      if (ownerId !== undefined && from.id === ownerId) owners++;
      else why ??= `#${e.seq} in this turn is from ${from.name}, not the owner`;
    } else if (e.kind === "scheduled" || e.kind === "job_done") {
      const authorised =
        e.kind === "scheduled" ? getSchedule(db, (e.payload as unknown as ScheduledPayload).scheduleId)?.ownerAuthorised : getJob(db, (e.payload as unknown as JobDonePayload).jobId)?.ownerAuthorised;
      if (authorised) owners++;
      else why ??= `#${e.seq} in this turn is a ${e.kind === "scheduled" ? "schedule" : "job"} the owner did not set up`;
    } else if (e.kind === "approval") {
      if ((e.payload as unknown as ApprovalPayload).answer !== null) owners++;
    } else if (e.kind === "external") {
      why ??= `#${e.seq} in this turn came from outside (inbound: ${(e.payload as unknown as ExternalPayload).source}), not from the owner`;
    }
  }
  if (owners) return null;
  return why ? `${why}, and nothing in it is from the owner` : "nothing in this turn is from the owner";
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
  authority: TurnAuthority = turnAuthority(capabilities),
): ToolBoundary {
  const perceive: Perceive = (e) => capabilityPerception(capabilities, e, { db });
  return {
    refuse(call) {
      if (s.passed && call.name !== "pass") return "This turn has already passed. End it now; call no more tools.";
      const args = (call.args ?? {}) as Record<string, unknown>;
      if (authority.ownerOnly.has(call.name) || authority.ownerOnlyWhen?.get(call.name)?.(args)) {
        const why = ownerAuthority(db, s.chat.id, s.fromSeq, s.toSeq, authority.ownerId);
        const note = authority.notes?.get(call.name) ?? "If someone asked for this, tell them only the owner can.";
        if (why) return `Refused: \`${call.name}\` acts for the owner, and only the owner may ask for it; ${why}. Nothing was done. ${note}`;
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
      return renderMidTurn(fresh, timeZone, perceive, s.markOwner !== undefined ? { owner: s.markOwner } : {});
    },
  };
}

/** A compaction as the driver reports it (agent-runtime `CompactionEvent`, restated so either runtime version builds). */
interface CompactionSeen {
  trigger: "auto" | "manual";
  tokensBefore: number;
  tokensAfter?: number;
  summarized?: boolean;
}

export type TurnOutcome = "done" | "stopped" | "failed" | "empty";

/** Run turn `turnId` to the end and close it. Never throws: a failure is recorded on the turn. */
export async function runTurn(deps: TurnDeps): Promise<TurnOutcome> {
  const { db, turnId } = deps;
  const turn = getTurn(db, turnId);
  if (!turn || turn.status !== "running") return "failed";
  const chat = getChat(db, turn.chatId)!;
  const policy = deps.policy ?? defaultPolicy();
  // Without the owner's id: a private chat is only ever recorded for the owner (telegram/inbound.ts), and
  // the waker, which does check it, decides whether a chat gets a turn at all.
  const chatPolicy = resolveChat(policy, chat);
  if (!chatPolicy) {
    finishTurn(db, turnId, { status: "done" });
    return "empty";
  }
  const capabilities = chatCapabilities(deps.capabilities, chatPolicy.tools);
  const group = chat.kind === "group";

  const unseen = untilHeld(triggersAfter(db, chat.id, turn.fromSeq), deps.capabilities, Date.now(), turn.toSeq);
  const perceive: Perceive = (e) => capabilityPerception(capabilities, e, { db });
  // A fresh conversation (the first turn, or after `/new`) opens with the chat's last few exchanges, so
  // starting over forgets the model's context, not what was just being talked about.
  if (!unseen.length) {
    finishTurn(db, turnId, { status: "done" });
    return "empty";
  }
  // In a group: from up to GROUP_CONTEXT messages before the first that woke the turn.
  let input = unseen;
  let context = 0;
  if (chatPolicy.trigger !== "all") {
    const first = unseen.findIndex((e) => isTrigger(db, e, chatPolicy, deps.bot));
    const woke = first >= 0 ? first : Math.max(0, unseen.findIndex((e) => e.seq >= (turn.triggerSeq ?? turn.toSeq)));
    const start = Math.max(0, woke - GROUP_CONTEXT);
    input = unseen.slice(start);
    context = woke - start;
  }
  const unread = unseen.length - input.length;
  // Everything said before the first message being answered, the assistant's own replies included
  // (those come after the cursor, so the cursor is not the bound).
  const history = chat.backendSessionId ? [] : recentHistory(db, chat.id, unseen[0]!.seq - 1, HISTORY_ON_NEW);
  const s: TurnState = { chat, turnId, passed: false, stopping: deps.signal?.aborted ?? false, n: 0, fromSeq: input[context]!.seq - 1, toSeq: input.at(-1)!.seq };
  if (group) {
    s.wokenBy = turn.triggerSeq ?? turn.toSeq;
    if (deps.ownerId !== undefined) s.markOwner = deps.ownerId;
  }
  // In a group the input names the messages that called her (the first that woke the turn, and any after it).
  const called = group ? input.slice(context).filter((e) => isTrigger(db, e, chatPolicy, deps.bot)).map((e) => e.seq) : [];
  if (group && !called.length) called.push(s.wokenBy!);
  const renderOpts: InputOptions = { ...(s.markOwner !== undefined ? { owner: s.markOwner } : {}), ...(unread ? { unread } : {}), ...(context ? { context } : {}), ...(called.length ? { called } : {}) };
  // The input opens with the "It is now…" line after a gap, and always in a fresh conversation.
  const withNote = (fresh: boolean): InputOptions => {
    const t = openingTimeNote(db, chat.id, input[0]!, turn.startedAt, deps.timeZone, fresh);
    return t ? { ...renderOpts, timeNote: t } : renderOpts;
  };
  deps.signal?.addEventListener("abort", () => (s.stopping = true), { once: true });
  extendTurn(db, turnId, s.toSeq);

  const rec = new TurnRecorder(db, turnId, deps.record ?? { dataDir: dirname(deps.home) });
  let buf = "";
  const flush = () => {
    const seq = queueMessage(db, s, buf);
    rec.textFlushed(seq);
    buf = "";
  };

  const authority = turnAuthority(capabilities, deps.ownerId);
  const adapter = deps.makeAdapter(
    recordingBoundary(turnBoundary(db, s, deps.timeZone, capabilities, authority), rec, () => s.toSeq, (seq) => triggersAfter(db, chat.id, seq)[0]?.seq),
  );
  const firstOwnerMessage = input.find((e) => e.kind === "message" && (deps.ownerId === undefined || (e.payload as unknown as MessagePayload).from.id === deps.ownerId));
  const ownerName = deps.ownerName ?? (firstOwnerMessage ? (firstOwnerMessage.payload as unknown as MessagePayload).from.name : undefined);
  const owner: OwnerInfo = { ...(ownerName ? { name: ownerName } : {}), ...(deps.ownerLanguage ? { language: deps.ownerLanguage } : {}) };
  const tools = capabilityTools(capabilities, {
    db,
    home: deps.home,
    chat,
    turnId,
    timeZone: deps.timeZone,
    owner,
    state: s,
    policy,
    chatPolicy,
    ...(deps.ownerId !== undefined ? { ownerId: deps.ownerId } : {}),
  });
  const opening = withNote(!chat.backendSessionId);
  const prompt = history.length ? renderWithHistory(history, input, deps.timeZone, perceive, opening) : renderTurnInput(input, deps.timeZone, perceive, opening);
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
      rec.token(text, !!thinking);
    },
    onTool: () => {
      lastThinking = false;
      flush();
      rec.toolAnnounced();
    },
    onSessionId: (id: string) => {
      saveSession(db, chat.id, id);
      setTurnConversation(db, turnId, { backendSessionId: id });
    },
    // The driver compacted the conversation (agent-runtime's `onCompaction`, from its claude-compaction-event
    // change on): a step in the transcript. Typed here, so this compiles against a runtime without it too.
    onCompaction: (e: CompactionSeen) => rec.compaction(e),
    ...(deps.signal ? { signal: deps.signal } : {}),
  };

  // Built fresh every turn and sent on a resume too, so an edit to home/ reaches the model from the next
  // turn without `/new`. The driver decides whether a resume honours it: the runner's Claude driver does
  // (`liveSystemPrompt`), and openai-compat always sends the prompt it is given.
  const sections = buildPromptSections(deps.home, chat, owner, capabilities, chatPolicy, db);
  const systemPrompt = joinSections(sections);
  rec.prompt(sections);
  // Which conversation this turn is in: the chat's (resumed), or a fresh one (the chat's first, after `/new`).
  setTurnConversation(db, turnId, { opening: chat.backendSessionId ? "resumed" : hadEarlierTurn(db, chat.id, turnId) ? "new" : "first" });
  const fresh = (p: Prompt) => {
    rec.input(p, false);
    return adapter.run({ prompt: p, tools, systemPrompt, ...(deps.model ? { model: deps.model } : {}) }, opts);
  };
  try {
    let result;
    if (!chat.backendSessionId) result = await fresh(prompt);
    else {
      try {
        rec.input(prompt, true);
        result = await adapter.continueRun(
          { backendSessionId: chat.backendSessionId, prompt, tools, systemPrompt, ...(deps.model ? { model: deps.model } : {}), ...(chat.contextTokens ? { contextTokens: chat.contextTokens } : {}) },
          opts,
        );
      } catch (e) {
        if (deps.signal?.aborted || !isLostSession(e)) throw e;
        resetConversation(db, chat.id);
        setTurnConversation(db, turnId, { opening: "lost" });
        raiseAlert(db, {
          key: `lost-session:${turnId}`,
          turnId,
          topic: `lost-session:${chat.id}`,
          text: `The conversation of ${chatLabel(chat)} was lost (${chat.backendSessionId}); turn ${turnId} restarted it fresh with the last ${HISTORY_ON_NEW} messages.`,
        });
        buf = "";
        lastThinking = false;
        rec.discardOpen();
        rec.note(`The conversation ${chat.backendSessionId} was lost; the turn started over as a fresh conversation, opening with the last ${HISTORY_ON_NEW} messages.`);
        const lastSeen = recentHistory(db, chat.id, unseen[0]!.seq - 1, HISTORY_ON_NEW);
        const restart = withNote(true);
        result = await fresh(lastSeen.length ? renderWithHistory(lastSeen, input, deps.timeZone, perceive, restart) : renderTurnInput(input, deps.timeZone, perceive, restart));
      }
    }
    flush();
    const u = result.usage;
    rec.end(u.model);
    finishTurn(db, turnId, { status: "done", usage: u, contextTokens: u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens + u.outputTokens });
    return "done";
  } catch (e) {
    // What was half-written was not sent; the transcript keeps it as such.
    rec.end();
    if (deps.signal?.aborted) {
      // A stop: what was half-written is dropped, what was already queued stays queued.
      finishTurn(db, turnId, { status: "stopped" });
      return "stopped";
    }
    // Redacted like the transcript: the error is shown in the console and sent in the control bot's alert.
    finishTurn(db, turnId, { status: "failed", error: rec.redactText(e instanceof Error ? e.message : String(e)) });
    return "failed";
  }
}
