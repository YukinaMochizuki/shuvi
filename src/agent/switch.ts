import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { ModelMessage } from "agent-runtime/openai-compat";
import { appendToClaudeSession, claudeSessionMessages, findClaudeSession, forkClaudeSession, readClaudeSession } from "agent-runtime/convert";
import { conversationEnd, conversationExists, conversationSince, insertMessages } from "../store/conversations.ts";
import type { Db } from "../store/db.ts";
import { getChat, type Chat } from "../store/events.ts";
import { chatModel, defaultModel, findModel, getProvider, laneOf, listModels, listProviders, parseLane, SEEDED_PROVIDER, unknownLane, type CatalogModel } from "../store/models.ts";
import { chatConversations, chats, modelSwitches, modelSwitchRequests, turns } from "../store/schema.ts";
import { getTurn, IMMEDIATE, runningTurnFor } from "../store/turns.ts";

/** A read: the store itself, or the handle of a transaction the caller holds. */
type Reader = Pick<Db, "select">;

/**
 * Moving a chat to another model, with the owner's choice of what the conversation keeps.
 *
 * A CONVERSATION PER MODEL. A chat has one conversation per model (`<provider>/<model>`) it has talked on:
 * the ACTIVE one on `chats` (`conversation_model` is whose it is, `backend_session_id` the conversation), the
 * others PARKED in `chat_conversations`, each exactly where it was left. Each session id is in one of the two
 * places, never both. Two models of one provider have two conversations, like any two models.
 *
 * LANES are only where a conversation is STORED, which decides how it is read, written and carried: a Claude
 * login's session files (`claude:<provider>`), or our own tables for every OpenAI-compatible model
 * (`openai-compat`; store/models.ts `laneOf`). A model's lane follows from its provider and is not stored.
 *
 * A SWITCH of the chat from model A (the active conversation's) to model B parks A's conversation under A
 * and makes B's active, in one of two modes the owner picks every time, between any two models:
 *   - `lossless`: B's conversation first receives what A's gained since A's was entered (`chats.entered_at`):
 *     while A's was active, every other one stood still, so that is exactly what B's lacks. It is appended
 *     after what B's already holds, which stays as its driver wrote it; carried into another lane it is
 *     converted (agent-runtime/convert). B with no conversation (none yet, or one that is gone) lacks
 *     everything: it gets a copy of ALL of A's. Within one Claude login that copy is the session itself,
 *     forked as it is (`forkClaudeSession`: signed thinking and all); within the OpenAI-compatible tables it
 *     is A's rows under a new conversation id; into another lane, A's conversation converted.
 *   - `lossy`: nothing is carried. B's conversation resumes as it was left, without what was said on A
 *     meanwhile; B with none starts fresh at the next turn, with the chat's last few messages, like after
 *     `/new`.
 * Either way `entered_at` becomes where B's conversation ends now, so the next switch away carries only what
 * is said from here on. Nothing is added to a conversation to say a switch happened: the model is never told.
 * The `model_switches` row records it, and the next turn's transcript notes it (agent/turn.ts) for the console.
 * Choosing the model the chat is already on, its conversation already that model's, is a no-op that says so
 * (`changed: false`): no row, no change.
 *
 * WHAT IS CARRIED after a compaction: when A's conversation was compacted since it was entered, the position
 * it was entered at is no longer in it, and what is carried is all it now holds: the summary, then what came
 * after. The summary repeats some of what B's has; the switch row says so (`model_switches.compacted`), and
 * the next turn's note too. A source that is gone (its session swept, its provider removed) carries nothing.
 *
 * AN IMPLICIT MOVE: a chat whose model changed without a switch (`chats.model` null follows the default, and
 * the default changed; or its model was set directly) moves lossy to that model's conversation before its
 * next turn (`enterChatModel`), as that switch would have. A chat with no conversation just takes the model.
 *
 * BEFORE MODELS WERE RECORDED, an active conversation with no `conversation_model` (kept by the migration
 * only for a store from before the catalog) is the seeded Claude login's (store/models.ts `seedModels`), and
 * belongs to the first of: the chat's model, the default, any model, that is of that login (`activeModel`).
 *
 * WITH NO ACTIVE CONVERSATION (none yet, or the migration dropped one it could not attribute), taking a model
 * resumes that model's parked conversation, as a lossy move would: `enterChatModel` before a turn, and
 * `switchModel` to the model the chat already runs on, which is then no no-op.
 *
 * WHEN AND WHERE a switch runs: between turns only, in the server process, synchronously. `switchModel`
 * refuses while a turn runs in the chat, and checks again inside its write transaction, so a turn claimed
 * meanwhile makes it refuse. A switch the owner asks for while a turn runs is a REQUEST (`requestSwitch`):
 * the server stops the turn, then applies it once nothing runs, and the waker starts no turn in the chat
 * while one is pending (server/commands.ts `switchRequestPass`). The stopped turn's input is answered again
 * by the new model's next turn (the cursor stays where the stopped turn began), so a lossless switch applied
 * after it carries only up to where the active conversation stood when that turn began (`turns.
 * conversation_start`, recorded by the runner child: `conversationPosition`): the stopped turn's prompt and
 * whatever the driver wrote of it are not carried, and the target receives those messages once, as input.
 * A conversation the stopped turn itself opened (fresh, or restarted after it was lost) carries nothing. When
 * that position is no longer in the conversation (the stopped turn compacted it), everything is carried, as
 * after any compaction. Within one Claude login, a target with no conversation then gets a new session
 * written from that part (converted) instead of a fork, unless the stopped turn wrote nothing. Messages the
 * stopped turn already sent to Telegram are answered again too: accepted (the owner asked to stop it).
 *
 * The one exception to "between turns, in the server" is `enterChatModel`'s implicit move, run by the turn's
 * own runner child before the turn starts. Carrying onto an
 * OpenAI-compatible conversation is in the write transaction. Carrying onto a Claude session (an append, or a
 * fork) writes its file first: a failure after it (that late refusal) leaves the file with the rows
 * unchanged, and a retry carries it again (an orphaned fork ages out with the login's other files). A new
 * Claude session is placed for the working directory of this process, which is the one turns run the CLI in
 * (server/spawn.ts starts the runner child in the server's).
 */

export type SwitchMode = "lossless" | "lossy";

export interface SwitchResult {
  mode: SwitchMode;
  /**
   * False when the chat was already on `to`, its conversation `to`'s: nothing happened. True otherwise, also
   * when only `chats.model` changed because the active conversation already was `to`'s (a chat whose model
   * was moved without a switch): that writes no `model_switches` row, as no conversation moved.
   */
  changed: boolean;
  /** The model whose conversation was active (null: none). */
  from: string | null;
  to: string;
  /** Messages carried into the target's conversation (lossless only). */
  carried: number;
  /** What was carried starts with a compaction's summary (see the header). */
  compacted: boolean;
  /** The target's own conversation was taken up (it had one); false: it starts on a new one, or none moved. */
  resumed: boolean;
}

export interface SwitchOptions {
  /** Where a new Claude session is placed: the working directory turns run in. Default: process.cwd(). */
  cwd?: string;
  /** The turn a switch request stopped before this switch: a lossless carry stops where that turn began. */
  stoppedTurnId?: number | null;
}

/** Switch chat `chatId` to model `to` (`<provider>/<model>`). Refuses while a turn is running there. */
export function switchModel(db: Db, chatId: number, to: string, mode: SwitchMode, opts: SwitchOptions = {}): SwitchResult {
  const chat = getChat(db, chatId);
  if (!chat) throw new Error(`there is no chat ${chatId}`);
  if (runningTurnFor(db, chatId)) throw new Error("a turn is running in this chat: stop it first, then switch");
  const target = findModel(db, to);
  if (!target) throw new Error(`there is no model "${to}" in the catalog`);
  const active = activeModel(db, chat);
  // With no active conversation, the target's parked one is resumed: never a no-op then.
  const resume = !chat.backendSessionId && hasParked(db, chat.id, target.id);
  if (resume) return moveChat(db, chat, active === target.id ? null : active, target, mode, opts);
  if (runsOn(db, chat) === target.id && (active === null || active === target.id)) {
    return { mode, changed: false, from: active, to: target.id, carried: 0, compacted: false, resumed: false };
  }
  if (active === target.id) {
    // Its conversation is already the target's (the chat's model was moved without a switch): only the model.
    db.transaction((tx) => {
      refuseIfRunning(tx, chat.id);
      tx.update(chats).set({ model: target.id, conversationModel: target.id }).where(eq(chats.id, chat.id)).run();
    }, IMMEDIATE);
    return { mode, changed: true, from: active, to: target.id, carried: 0, compacted: false, resumed: false };
  }
  return moveChat(db, chat, active, target, mode, opts);
}

/**
 * What switching chat `chatId` to `to` would do now, in either mode, computed by the rules `switchModel` follows
 * and without writing anything: for the control bot's switch card (control/model-cards.ts), which offers both
 * modes and says what each would do in this chat.
 */
export interface SwitchPreview {
  to: string;
  /** The chat is already on `to`, its conversation `to`'s: `switchModel` would do nothing. */
  noop: boolean;
  /**
   * lossless: `carry` N messages into the target's conversation, or, the target having none, `copy` the whole
   * current one (N messages). Nothing to carry (no active conversation) is 0.
   */
  lossless: { kind: "carry" | "copy"; messages: number };
  /** lossy: the target's conversation `resume`s as it was left (`since`: when, null: it is the active one already), or it starts `fresh`. */
  lossy: { kind: "resume"; since: string | null } | { kind: "fresh" };
  /** The turn running in the chat, which a switch request stops first (null: none). */
  running: number | null;
}

export function previewSwitch(db: Db, chatId: number, to: string): SwitchPreview {
  const chat = getChat(db, chatId);
  if (!chat) throw new Error(`there is no chat ${chatId}`);
  const target = findModel(db, to);
  if (!target) throw new Error(`there is no model "${to}" in the catalog`);
  const running = runningTurnFor(db, chatId)?.id ?? null;
  const active = activeModel(db, chat);
  // As in switchModel: with no active conversation the target's parked one is resumed.
  const resume = !chat.backendSessionId && hasParked(db, chat.id, target.id);
  const noop = !resume && runsOn(db, chat) === target.id && (active === null || active === target.id);
  if (!resume && active === target.id) return { to: target.id, noop, lossless: { kind: "carry", messages: 0 }, lossy: { kind: "resume", since: null }, running };
  const from = resume && active === target.id ? null : active;
  const parked = parkedConversation(db, chat.id, target.id);
  const hadTarget = !!parked && laneHas(db, laneOf(target.provider), parked.backendSessionId);
  let messages = 0;
  const lane = from && chat.backendSessionId ? laneOfModel(db, from) : null;
  if (lane && chat.backendSessionId) {
    const source = { lane, session: chat.backendSessionId };
    // A request stops the running turn first, and carries only up to where it began (moveChat).
    messages = carryPart(db, source, hadTarget ? chat.enteredAt : null, carryLimit(db, running, source)).messages.length;
  }
  return {
    to: target.id,
    noop,
    lossless: { kind: hadTarget ? "carry" : "copy", messages },
    lossy: hadTarget ? { kind: "resume", since: parked!.parkedAt } : { kind: "fresh" },
    running,
  };
}

/**
 * Before a turn: the chat's active conversation is that of the model it runs on. A chat whose model changed
 * without a switch (the default moved, its model was set directly) moves lossy to that model's conversation,
 * as that switch would have. One with no active conversation resumes the model's parked one, if it has one,
 * the same way; otherwise it just takes the model.
 */
export function enterChatModel(db: Db, chat: Chat): CatalogModel {
  const m = chatModel(db, chat);
  const active = activeModel(db, chat);
  if (active && active !== m.id) {
    moveChat(db, chat, active, m, "lossy", {}, { implicit: true });
    Object.assign(chat, getChat(db, chat.id));
  } else if (!chat.backendSessionId && hasParked(db, chat.id, m.id)) {
    moveChat(db, chat, null, m, "lossy", {}, { implicit: true });
    Object.assign(chat, getChat(db, chat.id));
  } else if (chat.conversationModel !== m.id) {
    db.update(chats).set({ conversationModel: m.id }).where(eq(chats.id, chat.id)).run();
    chat.conversationModel = m.id;
  }
  return m;
}

/** The switches of this chat since its last turn, oldest first, now recorded by `turnId`. */
export function claimSwitches(db: Db, chatId: number, turnId: number): Switch[] {
  return db.transaction((tx) => {
    const unclaimed = and(eq(modelSwitches.chatId, chatId), isNull(modelSwitches.turnId));
    const rows = tx.select().from(modelSwitches).where(unclaimed).orderBy(asc(modelSwitches.id)).all();
    if (rows.length) tx.update(modelSwitches).set({ turnId }).where(unclaimed).run();
    return rows.map((r) => ({ ...r, turnId }));
  }, IMMEDIATE);
}

type Switch = typeof modelSwitches.$inferSelect;

/** What a turn's transcript says of a switch it records (for the console: the model never sees it). */
export function switchNote(s: Pick<Switch, "fromModel" | "toModel" | "mode" | "carried" | "compacted" | "toSessionId">): string {
  const head = s.fromModel
    ? `Model switched from ${s.fromModel} to ${s.toModel}`
    : `The chat moved to ${s.toModel} without a switch (its default changed, or it took up that model's parked conversation)`;
  switch (s.mode) {
    case "native": // only in rows from before a conversation per model
      return `${head}; the conversation went on as it was.`;
    case "lossless": {
      const what = `${s.carried} message${s.carried === 1 ? "" : "s"} carried into its conversation`;
      return `${head}, lossless: ${what}${s.compacted ? ", beginning with a compaction's summary of what came before" : ""}.`;
    }
    case "lossy":
      return s.toSessionId
        ? `${head}, lossy: its own conversation resumed as it was left, without what was said on the other model.`
        : `${head}, lossy: it had no conversation, so a fresh one opens with the chat's last messages.`;
    default:
      throw new Error(`unknown switch mode "${String(s.mode satisfies never)}"`);
  }
}

// ---- switch requests: a switch asked for while a turn may be running (server/commands.ts) -------------

export type SwitchRequest = typeof modelSwitchRequests.$inferSelect;

/**
 * Ask for chat `chatId` to switch to `to`. Applied by the server's next pass, after stopping a running turn
 * (server/commands.ts `switchRequestPass`); until then the waker starts no turn in the chat. Requests of one
 * chat are applied in the order they were asked. Returns the request.
 */
export function requestSwitch(db: Db, chatId: number, to: string, mode: SwitchMode): SwitchRequest {
  if (!getChat(db, chatId)) throw new Error(`there is no chat ${chatId}`);
  if (!findModel(db, to)) throw new Error(`there is no model "${to}" in the catalog`);
  return db.insert(modelSwitchRequests).values({ chatId, toModel: to, mode }).returning().get();
}

/** Pending requests, oldest first: every chat's, or one chat's. */
export function pendingSwitchRequests(db: Reader, chatId?: number): SwitchRequest[] {
  const pending = eq(modelSwitchRequests.status, "pending");
  return db
    .select()
    .from(modelSwitchRequests)
    .where(chatId === undefined ? pending : and(pending, eq(modelSwitchRequests.chatId, chatId)))
    .orderBy(asc(modelSwitchRequests.id))
    .all();
}

export function hasPendingSwitch(db: Reader, chatId: number): boolean {
  return !!db
    .select({ id: modelSwitchRequests.id })
    .from(modelSwitchRequests)
    .where(and(eq(modelSwitchRequests.chatId, chatId), eq(modelSwitchRequests.status, "pending")))
    .limit(1)
    .get();
}

export function getSwitchRequest(db: Reader, id: number): SwitchRequest | undefined {
  return db.select().from(modelSwitchRequests).where(eq(modelSwitchRequests.id, id)).get();
}

/** Note the turn a request stopped (the first one only). */
export function noteStoppedTurn(db: Db, id: number, turnId: number): void {
  db.update(modelSwitchRequests).set({ stoppedTurnId: turnId }).where(and(eq(modelSwitchRequests.id, id), isNull(modelSwitchRequests.stoppedTurnId))).run();
}

/** Apply pending request `req` now: `switchModel`, its result or its error stored on the row. */
export function applySwitchRequest(db: Db, req: SwitchRequest, opts: SwitchOptions = {}): SwitchRequest {
  const doneAt = () => new Date().toISOString();
  try {
    const result = switchModel(db, req.chatId, req.toModel, req.mode, { ...opts, stoppedTurnId: req.stoppedTurnId });
    db.update(modelSwitchRequests).set({ status: "done", result: { ...result }, doneAt: doneAt() }).where(eq(modelSwitchRequests.id, req.id)).run();
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    db.update(modelSwitchRequests).set({ status: "failed", error, doneAt: doneAt() }).where(eq(modelSwitchRequests.id, req.id)).run();
  }
  return getSwitchRequest(db, req.id)!;
}

// ---- the move ------------------------------------------------------------------------------------------

/** The model the chat runs on: its own, else the default (null: neither). Does not throw. */
function runsOn(db: Db, chat: Chat): string | null {
  return chat.model ?? defaultModel(db)?.id ?? null;
}

/**
 * The model the chat's active conversation belongs to: `chats.conversation_model`; for a conversation from
 * before models were recorded, the seeded Claude login's model (see the header). Null when it has none.
 */
export function activeModel(db: Db, chat: Chat): string | null {
  if (chat.conversationModel) return chat.conversationModel;
  if (!chat.backendSessionId) return null;
  const seeded = getProvider(db, SEEDED_PROVIDER) ?? listProviders(db).find((p) => p.kind === "claude");
  if (!seeded) return null;
  const lane = laneOf(seeded);
  const inLane = (id: string | null | undefined) => (id && laneOfModel(db, id) === lane ? id : null);
  return inLane(chat.model) ?? inLane(defaultModel(db)?.id) ?? listModels(db).find((m) => laneOf(m.provider) === lane)?.id ?? null;
}

/**
 * Where the chat's active conversation stands now: its session, and the position of its end (null when it has
 * none, or it cannot be read). The runner child records it on a turn before the driver writes anything
 * (`turns.conversation_start`), so a lossless switch after stopping that turn knows what the turn added.
 */
export function conversationPosition(db: Db, chat: Chat): { session: string | null; position: string | null } {
  const session = chat.backendSessionId;
  const model = activeModel(db, chat);
  const lane = session && model ? laneOfModel(db, model) : null;
  if (!session || !lane) return { session, position: null };
  try {
    return { session, position: laneEnd(db, lane, session) };
  } catch {
    return { session, position: null }; // a session that cannot be read: the turn will find it lost
  }
}

function hasParked(db: Reader, chatId: number, model: string): boolean {
  return !!parkedConversation(db, chatId, model);
}

function parkedConversation(db: Reader, chatId: number, model: string) {
  return db
    .select()
    .from(chatConversations)
    .where(and(eq(chatConversations.chatId, chatId), eq(chatConversations.model, model)))
    .get();
}

/**
 * What a lossless switch carries of `source`: what it holds after `after` (null: all of it), cut where `limit`
 * says. `whole` when `after` was compacted away, so that is all it holds.
 */
function carryPart(db: Db, source: { lane: string; session: string }, after: string | null, limit: CarryLimit): { messages: ModelMessage[]; whole: boolean } {
  if (limit.kind === "none") return { messages: [], whole: false };
  const p = laneRead(db, source.lane, source.session, after);
  if (limit.kind === "upTo") {
    const added = laneRead(db, source.lane, source.session, limit.position);
    if (!added.whole) p.messages = p.messages.slice(0, Math.max(0, p.messages.length - added.messages.length));
  }
  return p;
}

/**
 * How much of `source` a lossless switch carries, given the turn a switch request stopped (see the header):
 * `all` (no stopped turn, or one that recorded nothing), `none` (the stopped turn opened the source itself,
 * or it began empty), or what lies up to `position`.
 */
type CarryLimit = { kind: "all" } | { kind: "none" } | { kind: "upTo"; position: string };
function carryLimit(db: Db, stoppedTurnId: number | null | undefined, source: { session: string }): CarryLimit {
  const start = stoppedTurnId ? getTurn(db, stoppedTurnId)?.conversationStart : null;
  if (!start) return { kind: "all" };
  if (start.session !== source.session || start.position === null) return { kind: "none" };
  return { kind: "upTo", position: start.position };
}

/** Where model `id`'s conversations are stored: its provider's lane; null when the provider is gone. */
function laneOfModel(db: Reader, id: string): string | null {
  const slash = id.indexOf("/");
  const p = slash > 0 ? getProvider(db, id.slice(0, slash)) : undefined;
  return p ? laneOf(p) : null;
}

function moveChat(db: Db, chat: Chat, from: string | null, target: CatalogModel, mode: SwitchMode, opts: SwitchOptions, how: { implicit?: boolean } = {}): SwitchResult {
  // The conversation left: A's, where A's provider keeps it (null lane: the provider is gone, nothing to read).
  const source = from && chat.backendSessionId ? { model: from, session: chat.backendSessionId, lane: laneOfModel(db, from) } : null;
  const toLane = laneOf(target.provider);
  const parked = parkedConversation(db, chat.id, target.id);
  let session = parked && laneHas(db, toLane, parked.backendSessionId) ? parked.backendSessionId : null;
  const resumed = !!session;
  let contextTokens = session ? (parked?.contextTokens ?? null) : null;
  let carried = 0;
  let compacted = false;
  // Rows to write into the OpenAI-compatible tables, inside the transaction.
  let rows: ModelMessage[] | null = null;

  if (mode === "lossless" && source?.lane) {
    const from = { lane: source.lane, session: source.session };
    const limit = carryLimit(db, opts.stoppedTurnId, source);
    const hadTarget = !!session;
    // What B lacks: what A's gained since it was entered; all of it, when B has no conversation. Never what a
    // stopped turn added (`limit`). Sets `carried` and `compacted`.
    const part = (): ModelMessage[] => {
      const p = carryPart(db, from, hadTarget ? chat.enteredAt : null, limit);
      carried = p.messages.length;
      compacted = carried > 0 && p.whole && hadTarget && !!chat.enteredAt;
      if (carried) contextTokens = null; // grown by what was carried: let the driver measure it again
      return p.messages;
    };
    const to = parseLane(toLane);
    switch (to.kind) {
      case "claude": {
        // B has none, within one Claude login: A's session itself, copied as it is (when all of it is carried).
        const login = loginOf(db, to.provider);
        const canFork = !hadTarget && from.lane === toLane && !!login && !!findClaudeSession(from.session, login.dir);
        const whole = limit.kind === "all" || (limit.kind === "upTo" && canFork && limit.position === laneEnd(db, from.lane, from.session));
        if (canFork && whole && login) {
          session = forkClaudeSession(from.session, login.dir ? { configDir: login.dir } : {}).sessionId;
          // Counted as every other carry is (and as `previewSwitch` counts it): in converted messages, not in
          // the session's own entries (a tool result and text in one user entry are two).
          carried = laneRead(db, from.lane, from.session, null).messages.length;
          contextTokens = chat.contextTokens; // the same conversation, the same size
        } else {
          const messages = part();
          if (messages.length) session = appendToClaude(db, to.provider, session, messages, opts);
        }
        break;
      }
      case "openai-compat": {
        const messages = part();
        if (messages.length) rows = messages;
        break;
      }
      default:
        unknownLane(to);
    }
  }

  // The row names the model left: the active conversation's, else the one the chat ran on; none for an implicit move.
  const fromModel = how.implicit ? null : (from ?? runsOn(db, chat));
  db.transaction((tx) => {
    if (!how.implicit) refuseIfRunning(tx, chat.id);
    if (rows) {
      session ??= randomUUID();
      insertMessages(tx, chat.id, session, rows);
    }
    const enteredAt = session ? laneEnd(tx, toLane, session) : null;
    if (source) {
      const park = { backendSessionId: source.session, contextTokens: chat.contextTokens, parkedAt: new Date().toISOString() };
      tx.insert(chatConversations)
        .values({ chatId: chat.id, model: source.model, ...park })
        .onConflictDoUpdate({ target: [chatConversations.chatId, chatConversations.model], set: park })
        .run();
    }
    tx.delete(chatConversations).where(and(eq(chatConversations.chatId, chat.id), eq(chatConversations.model, target.id))).run();
    tx.update(chats)
      .set({ model: how.implicit ? chat.model : target.id, conversationModel: target.id, backendSessionId: session, enteredAt, contextTokens })
      .where(eq(chats.id, chat.id))
      .run();
    tx.insert(modelSwitches)
      .values({ chatId: chat.id, fromModel, toModel: target.id, mode, fromSessionId: chat.backendSessionId, toSessionId: session, carried, compacted })
      .run();
  }, IMMEDIATE);
  return { mode, changed: true, from, to: target.id, carried, compacted, resumed };
}

function refuseIfRunning(tx: Reader, chatId: number): void {
  if (tx.select({ id: turns.id }).from(turns).where(and(eq(turns.chatId, chatId), eq(turns.status, "running"))).get()) {
    throw new Error("a turn is running in this chat: stop it first, then switch");
  }
}

/** The Claude login of provider `provider`: `dir` undefined = the server user's; null = the provider is gone. */
function loginOf(db: Reader, provider: string): { dir: string | undefined } | null {
  const p = getProvider(db, provider);
  return p ? { dir: p.configDir ?? undefined } : null;
}

function laneHas(db: Db, lane: string, session: string): boolean {
  const l = parseLane(lane);
  switch (l.kind) {
    case "openai-compat":
      return conversationExists(db, session);
    case "claude": {
      const login = loginOf(db, l.provider);
      return !!login && findClaudeSession(session, login.dir) !== null;
    }
    default:
      return unknownLane(l);
  }
}

/**
 * What `session` in `lane` holds after position `after` (null: all of it), as ModelMessage[]; `whole` when
 * that is all it holds because `after` was compacted away. Nothing, when the session or its login is gone.
 */
function laneRead(db: Db, lane: string, session: string, after: string | null): { messages: ModelMessage[]; whole: boolean } {
  const l = parseLane(lane);
  switch (l.kind) {
    case "openai-compat": {
      const r = conversationSince(db, session, after);
      return { messages: r.messages, whole: !r.afterFound };
    }
    case "claude": {
      const login = loginOf(db, l.provider);
      if (!login || !findClaudeSession(session, login.dir)) return { messages: [], whole: false };
      const r = claudeSessionMessages(session, { ...(login.dir ? { configDir: login.dir } : {}), after });
      return { messages: r.messages, whole: !r.afterFound };
    }
    default:
      return unknownLane(l);
  }
}

/** Append `messages` to `session` of Claude provider `provider`'s login (null: a new session). Returns the session. */
function appendToClaude(db: Db, provider: string, session: string | null, messages: ModelMessage[], opts: SwitchOptions): string {
  const login = loginOf(db, provider);
  if (!login) throw new Error(`the Claude login of provider "${provider}" is no longer in the catalog`);
  return appendToClaudeSession(session, messages, { ...(login.dir ? { configDir: login.dir } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}) }).sessionId;
}

/** Where `session` in `lane` ends now. `db` may be a transaction's handle. */
function laneEnd(db: Reader, lane: string, session: string): string | null {
  const l = parseLane(lane);
  switch (l.kind) {
    case "openai-compat":
      return conversationEnd(db, session);
    case "claude": {
      const login = loginOf(db, l.provider);
      return login ? readClaudeSession(session, login.dir ? { configDir: login.dir } : {}).end : null;
    }
    default:
      return unknownLane(l);
  }
}
