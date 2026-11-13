import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { ModelMessage } from "agent-runtime/openai-compat";
import { appendToClaudeSession, claudeSessionMessages, findClaudeSession, readClaudeSession } from "agent-runtime/convert";
import { conversationEnd, conversationExists, conversationSince, insertMessages } from "../store/conversations.ts";
import type { Db } from "../store/db.ts";
import { getChat, type Chat } from "../store/events.ts";
import { chatModel, defaultModel, findModel, getProvider, laneOf, listProviders, OPENAI_COMPAT_LANE, SEEDED_PROVIDER, type CatalogModel } from "../store/models.ts";
import { chatLanes, chats, modelSwitches, turns } from "../store/schema.ts";
import { IMMEDIATE, runningTurnFor } from "../store/turns.ts";

/**
 * Moving a chat to another model, with the owner's choice of what the conversation keeps.
 *
 * LANES. A conversation lives where its driver keeps it: a Claude login's session files, or our own store
 * for every OpenAI-compatible model (store/models.ts `laneOf`). A chat has one conversation per lane it has
 * been in: the ACTIVE one on `chats` (`lane`, `backend_session_id`), the others PARKED in `chat_lanes`,
 * each exactly where it was left. Each session id is in one of the two places, never both.
 *
 * A SWITCH within a lane only changes `chats.model`: the conversation goes on as it is (Claude resumes its
 * session on the new model; an OpenAI-compatible history is provider-neutral). This is `native`.
 *
 * A SWITCH to another lane parks the active conversation and makes the target lane's active, in one of two
 * modes the owner picks each time:
 *   - `lossless`: what the target lacks is carried onto it first, converted (agent-runtime/convert) and
 *     appended after what it already holds, which stays as its driver wrote it. What it lacks is exactly
 *     what the active conversation gained since its lane was entered (`chats.lane_entered_at`): while one
 *     lane was active, every other one stood still. A target with no conversation yet gets one made of it.
 *   - `lossy`: nothing is carried. The target resumes as it was left, and what happened elsewhere meanwhile
 *     is not in it; a target with no conversation yet starts fresh at the next turn, with the chat's last few
 *     messages, like after `/new`.
 * Either way `lane_entered_at` becomes where the target ends now, so the next switch away carries only what
 * is said from here on. Nothing is added to the conversation to say a switch happened: the model is not
 * told. The `model_switches` row records it, and the next turn's transcript notes it (agent/turn.ts).
 *
 * A target with no conversation (none yet, or one that is gone) lacks everything: lossless carries the
 * whole of the active conversation onto a new one. A source that is gone carries nothing.
 *
 * WHAT IS CARRIED after a compaction: when the active conversation was compacted since its lane was entered,
 * the position it was entered at is no longer in it, and what is carried is all it now holds: the summary,
 * then what came after. The summary repeats some of what the target has; the switch row says so
 * (`model_switches.compacted`), and the next turn's note too.
 *
 * BEFORE LANES, a conversation (`chats.lane` null, a session saved) was the Claude login's the catalog was
 * seeded with (store/models.ts `seedModels`), whatever the chat's model is now.
 *
 * WHEN AND WHERE a switch runs: between turns only, in the server process, synchronously, as the commands
 * that will call it do (server/commands.ts). It refuses while a turn runs in the chat, and checks again
 * inside its write transaction, so a turn the waker claimed meanwhile makes it refuse. The one exception is
 * `enterModelLane`'s implicit move, run by the turn's own runner child before the turn starts. Carrying onto
 * an OpenAI-compatible conversation is in that same transaction. Carrying onto a Claude session writes its
 * file first: a failure after it (that late refusal) leaves the carried part in the file with the rows
 * unchanged, and a retry carries it again. A new Claude session is placed for the working directory of this
 * process, which is the one turns run the CLI in (server/spawn.ts starts the runner child in the server's).
 */

export type SwitchMode = "lossless" | "lossy";

export interface SwitchResult {
  mode: "native" | SwitchMode;
  from: string | null;
  to: string;
  /** Messages carried onto the target (lossless only). */
  carried: number;
  /** What was carried starts with a compaction's summary (see the header). */
  compacted: boolean;
}

export interface SwitchOptions {
  /** Where a new Claude session is placed: the working directory turns run in. Default: process.cwd(). */
  cwd?: string;
}

/** Switch chat `chatId` to model `to` (`<provider>/<model>`). Refuses while a turn is running there. */
export function switchModel(db: Db, chatId: number, to: string, mode: SwitchMode, opts: SwitchOptions = {}): SwitchResult {
  const chat = getChat(db, chatId);
  if (!chat) throw new Error(`there is no chat ${chatId}`);
  if (runningTurnFor(db, chatId)) throw new Error("a turn is running in this chat: stop it first, then switch");
  const target = findModel(db, to);
  if (!target) throw new Error(`there is no model "${to}" in the catalog`);
  return moveChat(db, chat, target, mode, opts);
}

/**
 * Before a turn: the chat's active conversation is in the lane of the model it runs on. A chat whose model
 * moved lanes without a switch (the default model changed, its model was replaced) moves lossy, as that
 * switch would have; one with no conversation yet just takes the model's lane.
 */
export function enterModelLane(db: Db, chat: Chat): CatalogModel {
  const m = chatModel(db, chat);
  const lane = laneOf(m.provider);
  const current = activeLane(db, chat);
  if (current && current !== lane) {
    moveChat(db, { ...chat, lane: current }, m, "lossy", {}, { implicit: true });
    Object.assign(chat, getChat(db, chat.id));
  } else if (chat.lane !== lane) {
    db.update(chats).set({ lane }).where(eq(chats.id, chat.id)).run();
    chat.lane = lane;
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
export function switchNote(s: Pick<Switch, "fromModel" | "toModel" | "mode" | "carried" | "compacted">): string {
  const head = s.fromModel ? `Model switched from ${s.fromModel} to ${s.toModel}` : `The chat's model moved to ${s.toModel} (its default changed)`;
  if (s.mode === "native") return `${head}; the conversation went on as it was.`;
  if (s.mode === "lossless") {
    const what = `${s.carried} message${s.carried === 1 ? "" : "s"} carried into its conversation`;
    return `${head}, lossless: ${what}${s.compacted ? ", beginning with a compaction's summary of what came before" : ""}.`;
  }
  return `${head}, lossy: its conversation resumed as it was left, without what was said on the other model.`;
}

/**
 * The lane the chat's active conversation is in: `chats.lane`, or for a conversation from before lanes the
 * seeded Claude login's. Null when it has none.
 */
function activeLane(db: Db, chat: Chat): string | null {
  if (chat.lane) return chat.lane;
  if (!chat.backendSessionId) return null;
  const seeded = getProvider(db, SEEDED_PROVIDER) ?? listProviders(db).find((p) => p.kind === "claude");
  return seeded ? laneOf(seeded) : null;
}

function moveChat(db: Db, chat: Chat, target: CatalogModel, mode: SwitchMode, opts: SwitchOptions, how: { implicit?: boolean } = {}): SwitchResult {
  const fromLane = activeLane(db, chat);
  // The model left: the chat's own, or the default its lane was entered on (unknown once the default moved).
  const fallback = defaultModel(db);
  const from = how.implicit ? null : (chat.model ?? (fallback && laneOf(fallback.provider) === fromLane ? fallback.id : null));
  const toLane = laneOf(target.provider);
  const model = how.implicit ? chat.model : target.id;
  const row = { chatId: chat.id, fromModel: from, toModel: target.id, fromSessionId: chat.backendSessionId };

  if (!fromLane || fromLane === toLane) {
    db.transaction((tx) => {
      if (!how.implicit) refuseIfRunning(tx, chat.id);
      tx.update(chats).set({ model, lane: toLane }).where(eq(chats.id, chat.id)).run();
      tx.insert(modelSwitches).values({ ...row, mode: "native", toSessionId: chat.backendSessionId }).run();
    }, IMMEDIATE);
    return { mode: "native", from, to: target.id, carried: 0, compacted: false };
  }

  const parked = db.select().from(chatLanes).where(and(eq(chatLanes.chatId, chat.id), eq(chatLanes.lane, toLane))).get();
  let session = parked && laneHas(db, toLane, parked.backendSessionId) ? parked.backendSessionId : null;
  let contextTokens = session ? (parked?.contextTokens ?? null) : null;
  // What the target lacks: what the active conversation gained since its lane was entered; everything, when
  // the target has no conversation.
  const part = mode === "lossless" && chat.backendSessionId ? laneRead(db, fromLane, chat.backendSessionId, session ? chat.laneEnteredAt : null) : { messages: [], whole: false };
  const carried = part.messages.length;
  const compacted = carried > 0 && part.whole && !!session && !!chat.laneEnteredAt;
  if (carried && toLane !== OPENAI_COMPAT_LANE) {
    session = appendToClaude(db, toLane, session, part.messages, opts); // a file: before the transaction
  }
  if (carried) contextTokens = null; // grown by what was carried: let the driver measure it again

  db.transaction((tx) => {
    if (!how.implicit) refuseIfRunning(tx, chat.id);
    if (carried && toLane === OPENAI_COMPAT_LANE) {
      session ??= randomUUID();
      insertMessages(db, chat.id, session, part.messages);
    }
    const enteredAt = session ? laneEnd(db, toLane, session) : null;
    if (chat.backendSessionId) {
      tx.insert(chatLanes)
        .values({ chatId: chat.id, lane: fromLane, backendSessionId: chat.backendSessionId, contextTokens: chat.contextTokens })
        .onConflictDoUpdate({ target: [chatLanes.chatId, chatLanes.lane], set: { backendSessionId: chat.backendSessionId, contextTokens: chat.contextTokens, parkedAt: new Date().toISOString() } })
        .run();
    }
    tx.delete(chatLanes).where(and(eq(chatLanes.chatId, chat.id), eq(chatLanes.lane, toLane))).run();
    tx.update(chats).set({ model, lane: toLane, backendSessionId: session, laneEnteredAt: enteredAt, contextTokens }).where(eq(chats.id, chat.id)).run();
    tx.insert(modelSwitches).values({ ...row, mode, toSessionId: session, carried, compacted }).run();
  }, IMMEDIATE);
  return { mode, from, to: target.id, carried, compacted };
}

function refuseIfRunning(tx: Pick<Db, "select">, chatId: number): void {
  if (tx.select({ id: turns.id }).from(turns).where(and(eq(turns.chatId, chatId), eq(turns.status, "running"))).get()) {
    throw new Error("a turn is running in this chat: stop it first, then switch");
  }
}

/** The Claude login a `claude:<provider>` lane keeps its sessions in: `dir` undefined = the server user's; null = its provider is gone. */
function loginOf(db: Db, lane: string): { dir: string | undefined } | null {
  const provider = getProvider(db, lane.slice("claude:".length));
  return provider ? { dir: provider.configDir ?? undefined } : null;
}

function laneHas(db: Db, lane: string, session: string): boolean {
  if (lane === OPENAI_COMPAT_LANE) return conversationExists(db, session);
  const login = loginOf(db, lane);
  return !!login && findClaudeSession(session, login.dir) !== null;
}

/**
 * What `session` in `lane` holds after position `after` (null: all of it), as ModelMessage[]; `whole` when
 * that is all it holds because `after` was compacted away. Nothing, when the session or its login is gone.
 */
function laneRead(db: Db, lane: string, session: string, after: string | null): { messages: ModelMessage[]; whole: boolean } {
  if (lane === OPENAI_COMPAT_LANE) {
    const r = conversationSince(db, session, after);
    return { messages: r.messages, whole: !r.afterFound };
  }
  const login = loginOf(db, lane);
  if (!login || !findClaudeSession(session, login.dir)) return { messages: [], whole: false };
  const r = claudeSessionMessages(session, { ...(login.dir ? { configDir: login.dir } : {}), after });
  return { messages: r.messages, whole: !r.afterFound };
}

/** Append `messages` to `session` in a Claude lane (null: a new session). Returns the session. */
function appendToClaude(db: Db, lane: string, session: string | null, messages: ModelMessage[], opts: SwitchOptions): string {
  const login = loginOf(db, lane);
  if (!login) throw new Error(`the lane ${lane} belongs to a provider no longer in the catalog`);
  return appendToClaudeSession(session, messages, { ...(login.dir ? { configDir: login.dir } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}) }).sessionId;
}

/** Where `session` in `lane` ends now. */
function laneEnd(db: Db, lane: string, session: string): string | null {
  if (lane === OPENAI_COMPAT_LANE) return conversationEnd(db, session);
  const login = loginOf(db, lane);
  return login ? readClaudeSession(session, login.dir ? { configDir: login.dir } : {}).end : null;
}
