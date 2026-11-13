import { and, inArray, sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { ModelMessage } from "agent-runtime/openai-compat";

/**
 * The store. One SQLite file, shared by the server and every runner child (WAL, so a child writing its
 * turn never blocks the poller). See docs/design.md §3 for why it is shaped this way.
 *
 * `chat_events` is what HAPPENED in a chat, and nothing else: what people said, what the assistant said,
 * a command. It is not the model's conversation (agent-runtime keeps that) and not bookkeeping about turns
 * (that is `turns`). Everything that must be exactly-once hangs off a unique key here:
 *   - an inbound update off `tg_update_id`, so a re-delivered update is not recorded twice;
 *   - an outbound message off `idem_key`, so a turn that writes the same message twice records it once;
 *   - an outbound message's delivery off `tg_message_id`, so a row that has one is never sent again;
 *   - a framework event off `idem_key` too: `job:<id>` (one `job_done` per job), `schedule:<id>:<due>`
 *     (one `scheduled` per firing), `inbound:<source>:<key>` (an inbound POST retried with the same
 *     Idempotency-Key).
 *
 * OpenAI-compatible histories live in `conversations` and `conversation_messages`, one JSON model message
 * per row. The server prunes abandoned histories with the same retention window as turn transcripts; a
 * chat's histories (its active one, those parked for models still in the catalog, a running turn's) stay.
 *
 * Which models exist is `model_providers` and `models` (store/models.ts); which one a chat runs on is
 * `chats.model`. A chat keeps ONE CONVERSATION PER MODEL (agent/switch.ts): the active one on `chats`
 * (`conversation_model` says whose it is), the others parked in `chat_conversations`; each move from one
 * model's conversation to another's is a `model_switches` row, and one asked for while a turn runs waits in
 * `model_switch_requests`. Where a conversation is stored (its LANE: a Claude login's session files, or the
 * OpenAI-compatible tables above) follows from its model's provider and is not stored.
 */

export const chats = sqliteTable("chats", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tgChatId: integer("tg_chat_id").notNull().unique(),
  kind: text("kind", { enum: ["private", "group"] }).notNull(),
  title: text("title"),
  /** The last event seq the assistant has SEEN. The waker opens a turn only for inbound events past it. */
  cursorSeq: integer("cursor_seq").notNull().default(0),
  /** The model the chat runs on (`<provider>/<model>`, store/models.ts); null = the catalog's default. */
  model: text("model"),
  /**
   * The model the ACTIVE conversation belongs to (`<provider>/<model>`, agent/switch.ts). Null = none yet, so
   * the next turn's model takes it; or, with a session, a conversation from before models were recorded
   * (switch.ts `activeModel`).
   */
  conversationModel: text("conversation_model"),
  /** The active conversation; null = the next turn starts a fresh one (`/new`, or a lossy switch to a model with none). */
  backendSessionId: text("backend_session_id"),
  /**
   * Where the active conversation stood when it was entered (made active): what came after it is what
   * another model's conversation lacks (agent/switch.ts). Null = from its start.
   */
  enteredAt: text("entered_at"),
  /** Context occupancy the last turn ended at, handed back to the driver on the next turn. */
  contextTokens: integer("context_tokens"),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

/**
 * Where models run (store/models.ts). `name` is the first part of every model id (`<name>/<model>`), so it
 * never changes. A `claude` provider is a Claude login (`config_dir`, null = the server user's); an
 * `openai-compat` one an endpoint (`base_url`) whose key, if any, is named by `api_key` as
 * `<secrets profile>.<VARIABLE>` in the secrets file, never stored here.
 */
export const modelProviders = sqliteTable("model_providers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  kind: text("kind", { enum: ["claude", "openai-compat"] }).notNull(),
  configDir: text("config_dir"),
  baseUrl: text("base_url"),
  apiKey: text("api_key"),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

/**
 * The models of a provider a chat may run on, by the provider's own id for it (`model`). `context_window`
 * and `vision` say what an OpenAI-compatible one can do (a Claude model's are the CLI's to know). At most one
 * row is the default, which chats without a model of their own run on.
 */
export const models = sqliteTable(
  "models",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    providerId: integer("provider_id")
      .notNull()
      .references(() => modelProviders.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    label: text("label"),
    contextWindow: integer("context_window"),
    vision: integer("vision", { mode: "boolean" }).notNull().default(false),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [uniqueIndex("models_provider_model").on(t.providerId, t.model), uniqueIndex("models_one_default").on(t.isDefault).where(sql`is_default = 1`)],
);

/**
 * A chat's PARKED conversations: one per model (`<provider>/<model>`) it has had a conversation with and is
 * not on now, each exactly where it was left (agent/switch.ts). A session id is either here or active on
 * `chats`, never both. A row whose model left the catalog stays, but retention no longer protects its history.
 */
export const chatConversations = sqliteTable(
  "chat_conversations",
  {
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    model: text("model").notNull(),
    backendSessionId: text("backend_session_id").notNull(),
    contextTokens: integer("context_tokens"),
    parkedAt: text("parked_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.model] })],
);

/**
 * A switch asked for (agent/switch.ts `requestSwitch`), applied by the server between turns: a running turn
 * is stopped first (`stopped_turn_id`), and the waker starts no turn in the chat while one is `pending`.
 * `result` is the SwitchResult of a `done` one, `error` why a `failed` one did not happen.
 */
export const modelSwitchRequests = sqliteTable(
  "model_switch_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    toModel: text("to_model").notNull(),
    mode: text("mode", { enum: ["lossless", "lossy"] }).notNull(),
    status: text("status", { enum: ["pending", "done", "failed"] }).notNull().default("pending"),
    stoppedTurnId: integer("stopped_turn_id"),
    result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
    error: text("error"),
    requestedAt: text("requested_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    doneAt: text("done_at"),
  },
  (t) => [index("model_switch_requests_pending").on(t.chatId, t.id).where(sql`status = 'pending'`)],
);

/**
 * Each move of a chat from one model's conversation to another's (agent/switch.ts), carrying what the
 * other lacks (`lossless`, `carried` messages) or nothing (`lossy`). `native` (a switch within a lane that
 * kept the conversation) is no longer written, and is only read in rows from before a conversation per model.
 * `turn_id` is the first turn after it, which records it.
 */
export const modelSwitches = sqliteTable(
  "model_switches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    fromModel: text("from_model"),
    toModel: text("to_model").notNull(),
    mode: text("mode", { enum: ["native", "lossless", "lossy"] }).notNull(),
    fromSessionId: text("from_session_id"),
    toSessionId: text("to_session_id"),
    carried: integer("carried").notNull().default(0),
    /** What was carried starts with a compaction's summary, which repeats some of what the target held. */
    compacted: integer("compacted", { mode: "boolean" }).notNull().default(false),
    turnId: integer("turn_id"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [index("model_switches_chat").on(t.chatId, t.id)],
);

/** Durable model histories, scoped to the chat that created them and aged by their latest write. */
export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    generation: integer("generation").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    writtenAt: text("written_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [index("conversations_written_at").on(t.writtenAt)],
);

/** One model message per row; compaction advances the conversation generation. */
export const conversationMessages = sqliteTable(
  "conversation_messages",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    generation: integer("generation").notNull(),
    seq: integer("seq").notNull(),
    message: text("message", { mode: "json" }).notNull().$type<ModelMessage>(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.generation, t.seq] })],
);

export const EVENT_KINDS = [
  /** Someone wrote in the chat (text, or a placeholder for what this slice cannot read yet). */
  "message",
  /** An owner command (`/new`, `/stop`). Handled by the server; never shown to the model as speech. */
  "command",
  /** The assistant said something. Outbound: pending until the sender fills `tg_message_id`. */
  "bot_message",
  /** The assistant (or the server, acknowledging a command) reacted to a message. Outbound. */
  "bot_reaction",
  /** The assistant sent a file or a photo from its computer (capabilities/computer/). Outbound. */
  "bot_file",
  /** The owner answered an approval card in the control bot (src/control/approvals.ts) that asked to wake this chat. */
  "approval",
  /** A schedule came due (store/schedules.ts). Written by the framework, never someone speaking. */
  "scheduled",
  /** A job ended, failed or expired (store/jobs.ts); once per job, keyed `job:<id>`. */
  "job_done",
  /** An external system POSTed to `/inbound/<source>` (capabilities/jobs/inbound.ts). */
  "external",
  /** The assistant sent a sticker (src/capabilities/stickers/). Outbound, like `bot_message`. */
  "bot_sticker",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const OUTBOUND_KINDS: EventKind[] = ["bot_message", "bot_reaction", "bot_sticker", "bot_file"];
/**
 * Kinds that, past the cursor, are a turn's input, and ask for a turn. One exception: an `external` event
 * from a source declared with `trigger: false` is input for the next turn but does not start one
 * (`asksForTurn` below, which the waker's check and the claim use).
 */
export const TRIGGER_KINDS: EventKind[] = ["message", "approval", "scheduled", "job_done", "external"];

/** An event whose attachment is still to be handled (new, or asked for). The partial index and its query share it. */
export const ATTACHMENT_PENDING = sql.raw(
  `json_extract(payload, '$.attachment.fileId') IS NOT NULL AND coalesce(json_extract(payload, '$.attachment.state'), 'new') IN ('new', 'requested')`,
);

export const chatEvents = sqliteTable(
  "chat_events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    kind: text("kind", { enum: EVENT_KINDS }).notNull(),
    /** Kind-specific JSON (see src/store/events.ts for each kind's shape). */
    payload: text("payload", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    /** Inbound: the Telegram update this came from. */
    tgUpdateId: integer("tg_update_id").unique(),
    /** Inbound: the message's id. Outbound: filled by the sender once delivered (the first part's). */
    tgMessageId: integer("tg_message_id"),
    /** Outbound: `turn:<id>:<n>` or `tool:<callId>` — a second write of the same message is a no-op. */
    idemKey: text("idem_key").unique(),
    /** Outbound delivery: pending → sent | failed. A command: pending → done. Null for a message. */
    status: text("status", { enum: ["pending", "sent", "failed", "done"] }),
    /** Why delivery failed, or how a command was handled. */
    note: text("note"),
    /** The turn that wrote it (outbound). */
    turnId: integer("turn_id"),
    at: text("at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    index("chat_events_chat_seq").on(t.chatId, t.seq),
    index("chat_events_status").on(t.status),
    // A turn's outbound rows (the console, /turn), without a scan of the whole log.
    index("chat_events_turn").on(t.turnId),
    // The files waiting to be copied into a chat's computer (store/media.ts `pendingAttachments`): only rows
    // with an attachment still new or asked for, so the scan does not grow with every file ever sent.
    index("chat_events_attachment_pending").on(t.seq).where(ATTACHMENT_PENDING),
  ],
);

/** The events past the cursor that start a turn: TRIGGER_KINDS, minus quiet `external` ones. */
export const asksForTurn = () =>
  and(inArray(chatEvents.kind, TRIGGER_KINDS), sql`(${chatEvents.kind} <> 'external' OR coalesce(json_extract(${chatEvents.payload}, '$.trigger'), 1) = 1)`)!;

export const turns = sqliteTable(
  "turns",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    /** running → done | stopped | failed. */
    status: text("status", { enum: ["running", "done", "stopped", "failed"] }).notNull(),
    pid: integer("pid"),
    /**
     * The pid's process start time (field 22 of /proc/<pid>/stat), recorded at spawn. The pid counts as
     * this turn's process only while the start time still matches, so a reused pid cannot keep a dead
     * turn "running" (server/spawn.ts). Null where /proc is not available.
     */
    pidStart: text("pid_start"),
    /** When the waker sent SIGTERM because the turn passed its wall-clock limit (server/waker.ts). */
    termAt: text("term_at"),
    /** The cursor when the turn started; the events it was given are those after it. */
    fromSeq: integer("from_seq").notNull(),
    /** The last inbound seq the turn has been shown (grows as mid-turn messages are appended). */
    toSeq: integer("to_seq").notNull(),
    /**
     * The event the turn was claimed for: the newest one that asked for a turn (in a group, the newest
     * mention, reply or follow-up, agent/triggers.ts). Unlike `to_seq` it never moves. A group turn's first
     * message replies to it, and whoever sent it is someone she is answering (follow-ups).
     */
    triggerSeq: integer("trigger_seq"),
    /** The `/stop` (or `/new`) that stopped this turn: messages from it on are not the stopped turn's. */
    stopSeq: integer("stop_seq"),
    error: text("error"),
    costMicroUsd: integer("cost_micro_usd"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheCreationTokens: integer("cache_creation_tokens"),
    /**
     * The backend conversation (agent-runtime's session id) the turn ran in: every turn of a chat resumes the
     * same one until `/new`, a switch to another model's conversation or a lost-session restart starts another. Null until
     * the driver names it, and for turns recorded before this column existed.
     */
    backendSessionId: text("backend_session_id"),
    /**
     * How the turn's conversation stood when it began: `resumed` (it went on with the chat's conversation), or
     * it opened a fresh one: `first` (the chat's first turn), `new` (after `/new`), `lost` (the old one was lost
     * and restarted), `switched` (the chat moved to another model's conversation: agent/switch.ts). Null only for
     * turns from before this column existed (the console infers theirs).
     */
    opening: text("opening", { enum: ["first", "new", "lost", "switched", "resumed"] }),
    /**
     * Where the chat's active conversation stood when the turn began, before the driver wrote anything to it
     * (agent/switch.ts `conversationPosition`): its session and the position of its end, each null when there
     * was none. A lossless switch applied after stopping this turn carries only up to it (switch.ts). Null for a
     * turn that did not record it (one from before this column, or one run outside the runner child).
     */
    conversationStart: text("conversation_start", { mode: "json" }).$type<{ session: string | null; position: string | null }>(),
    startedAt: text("started_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    endedAt: text("ended_at"),
  },
  // One running turn per chat, enforced by the database rather than by the waker remembering to check.
  (t) => [
    uniqueIndex("turns_one_running_per_chat").on(t.chatId).where(sql`status = 'running'`),
    // A chat's turns in order (the console's lists, a turn's neighbours, the previous prompt).
    index("turns_chat_id").on(t.chatId, t.id),
  ],
);

// ---- turn transcripts: each turn as the model saw it (src/agent/transcript.ts, src/store/transcripts.ts) ----
//
// Kept apart from `chat_events` (what happened in a chat) and from `turns` (bookkeeping): a transcript is a
// debugging record, written best effort by the runner child, and pruned after SHUVI_TRANSCRIPT_DAYS. Nothing
// reads it to decide anything; losing it loses a view, never a message. Every text in it went through the
// computer's secret redaction before it was written, and an image is a path under the data dir, never bytes.

/**
 * System prompts, by the sha256 of their text: a chat whose home/ did not change sends the same bytes every
 * turn, so a turn stores 64 characters instead of the whole prompt. `sections` are where each part of the
 * prompt begins and ends (agent/prompt.ts `buildPromptSections`), for the console to fold it by section.
 * A text no transcript points at any more is pruned.
 */
export const promptTexts = sqliteTable("prompt_texts", {
  hash: text("hash").primaryKey(),
  text: text("text").notNull(),
  /** `[{ label, start, end }]`: character offsets into `text`, in order. */
  sections: text("sections", { mode: "json" }).notNull().$type<{ label: string; start: number; end: number }[]>(),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

/**
 * One per turn that reached the model: the system prompt it sent (by hash) and the prompt it opened with.
 * `input` is the prompt's parts in order; an image part is `{ type: "image", ref, mimeType }`, `ref` a path
 * relative to the data dir (store/transcripts.ts `ImageRef`). A turn whose conversation was lost and run
 * again fresh records the prompt of the run that answered.
 */
export const turnTranscripts = sqliteTable("turn_transcripts", {
  turnId: integer("turn_id")
    .primaryKey()
    .references(() => turns.id),
  promptHash: text("prompt_hash").references(() => promptTexts.hash),
  input: text("input", { mode: "json" }).notNull().$type<TranscriptPart[]>(),
  /** The driver's model for the turn, from its usage. */
  model: text("model"),
  /** `continueRun` on an existing conversation, rather than a fresh one. */
  resumed: integer("resumed", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

/** A prompt or result part as a transcript stores it: text, or a reference to an image file. */
export type TranscriptPart = { type: "text"; text: string } | { type: "image"; ref: string; mimeType: string };

export const STEP_KINDS = [
  /** A stretch of the model's thinking (never sent). */
  "thinking",
  /** A text block: one message, `sent` with its outbound `outbound_seq`, or not (after `pass`, a stop). */
  "text",
  /** A tool call, from its start to its end, or its refusal. */
  "tool",
  /** What the boundary appended to a tool's result: events that arrived meanwhile, after call `call_id`. */
  "append",
  /** Something the framework did to the turn itself (a lost conversation restarted). */
  "note",
  /** The driver compacted the conversation: from here on the model sees a summary of what came before. */
  "compaction",
] as const;

/**
 * A turn's timeline, in the order the turn produced it (`n`). One row per thinking stretch, text block,
 * tool call, append, note or compaction (its trigger in `name`, `auto` or `manual`). A tool call's row is written as `running` when it starts and completed in
 * place by `call_id` when it returns, so a call that hangs is visible while it hangs, and parallel calls
 * cannot be mixed up.
 */
export const turnSteps = sqliteTable(
  "turn_steps",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    turnId: integer("turn_id")
      .notNull()
      .references(() => turns.id),
    /** Position in the turn, from 0. */
    n: integer("n").notNull(),
    kind: text("kind", { enum: STEP_KINDS }).notNull(),
    /** thinking / text / note: the text. append: the rendered text the model was given. */
    text: text("text"),
    /** text: whether it became a message, and which outbound event. */
    sent: integer("sent", { mode: "boolean" }),
    outboundSeq: integer("outbound_seq"),
    /** tool: its name (bare), its arguments as JSON, its result's text. */
    name: text("name"),
    args: text("args"),
    result: text("result"),
    /** tool: running → ok | error (the tool said so) | threw | refused (the boundary's refusal, in `error`). */
    status: text("status", { enum: ["running", "ok", "error", "threw", "refused"] }),
    error: text("error"),
    /** tool: the boundary's call id. append: the call it was appended to. */
    callId: text("call_id"),
    /** tool / append: the images of the result or the appended events, as references. */
    images: text("images", { mode: "json" }).$type<{ ref: string; mimeType: string }[]>(),
    /** append: the events appended, (from_seq, to_seq]. */
    fromSeq: integer("from_seq"),
    toSeq: integer("to_seq"),
    /** compaction: the context before and after, in tokens (after only when the driver reports it). */
    tokensBefore: integer("tokens_before"),
    tokensAfter: integer("tokens_after"),
    at: text("at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    endedAt: text("ended_at"),
  },
  (t) => [uniqueIndex("turn_steps_turn_n").on(t.turnId, t.n), index("turn_steps_name").on(t.name, t.turnId)],
);

/**
 * The framework's own messages to the owner, through the control bot (docs/design.md §13): alerts,
 * replies to control commands, approval cards, and edits of those cards. Never `chat_events`: nothing
 * here happened in a chat, and the assistant's chats never see it (invariant 5).
 *
 * A durable queue, pending → sent | failed, so an alert raised just before a restart is still delivered.
 * `idem_key` makes raising the same alert twice (a scan repeated after a crash) a no-op. `topic` is what
 * repeats are rate-limited on: an alert whose topic was already raised recently is recorded as
 * `suppressed` and never sent (store/control.ts).
 */
export const controlMessages = sqliteTable(
  "control_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** alert | reply (to a control command; reply_html: its text is Telegram HTML) | approval (a card) | approval_closed (edit a card once answered or expired). */
    kind: text("kind", { enum: ["alert", "reply", "reply_html", "approval", "approval_closed"] }).notNull(),
    text: text("text").notNull(),
    idemKey: text("idem_key").unique(),
    topic: text("topic"),
    /** For `approval` / `approval_closed`: the approval it belongs to. */
    approvalId: integer("approval_id"),
    status: text("status", { enum: ["pending", "sent", "failed", "suppressed"] }).notNull(),
    tgMessageId: integer("tg_message_id"),
    note: text("note"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [index("control_messages_status").on(t.status), index("control_messages_topic").on(t.topic, t.createdAt)],
);

/**
 * Questions put to the owner as a card with buttons in the control bot (src/control/approvals.ts). The
 * answer is recorded here once, durably; an answer to a card that is no longer pending is ignored.
 */
export const approvals = sqliteTable("approvals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Who asked, e.g. `policy`, `secret`, `schedule`. The answer's meaning is the kind's business. */
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  /** The buttons, in order: `[{ id, label }]`. */
  options: text("options", { mode: "json" }).notNull().$type<{ id: string; label: string }[]>(),
  /** The chat to wake with an `approval` event when it is answered (null: the caller polls). */
  originChatId: integer("origin_chat_id").references(() => chats.id),
  /** Kind-specific data the caller wants back with the answer. */
  data: text("data", { mode: "json" }).$type<Record<string, unknown>>(),
  /** pending → answered | expired. */
  status: text("status", { enum: ["pending", "answered", "expired"] }).notNull(),
  /** The chosen option's id. */
  answer: text("answer"),
  answeredAt: text("answered_at"),
  expiresAt: text("expires_at"),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

export const kv = sqliteTable("kv", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/**
 * Background work whose result comes later (docs/design.md §10). A job belongs to the chat and event it
 * was started from, and its result goes back THERE, as one `job_done` event, whichever way it arrives
 * (store/jobs.ts `finishJob`, which closes the row and writes the event in one transaction, the event
 * keyed `job:<id>` so a second report writes nothing).
 */
export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    /** The event the job was started for (the turn's newest input). */
    originSeq: integer("origin_seq").notNull(),
    /** What kind of work it is (`workstream`, …); the capability that owns the kind polls it. */
    kind: text("kind").notNull(),
    /** One line saying what was asked, shown with the result. */
    title: text("title").notNull(),
    state: text("state", { enum: ["running", "done", "failed", "expired"] }).notNull().default("running"),
    /** How the result arrives: a process the framework runs exits, a POST to /jobs/<id>/report, or polling. */
    report: text("report", { enum: ["exit", "callback", "poll"] }).notNull(),
    /** Kind-specific (e.g. the workstream request id). */
    spec: text("spec", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    /** callback: sha256 of the per-job token (hex). The token itself is never stored. */
    tokenHash: text("token_hash"),
    result: text("result"),
    deadline: text("deadline").notNull(),
    /** poll: when the next poll is due. */
    nextPollAt: text("next_poll_at"),
    /** The last poll's error, if it failed (a failed poll is retried until the deadline). */
    note: text("note"),
    /**
     * The job was started by a call the owner authorised (agent/turn.ts, owner-only tools). Only then does
     * its `job_done` count as the owner's when a later turn decides whether owner-only tools may run.
     */
    ownerAuthorised: integer("owner_authorised", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    endedAt: text("ended_at"),
  },
  (t) => [index("jobs_state").on(t.state)],
);

/**
 * Each chat's computer (docs/design.md §15, src/capabilities/computer/): a Hangar Disk mounted as the home
 * of a Hangar Container, both named after the chat, created on the first exec and never deleted. This row is
 * what shuvi knows of them, so every process (the server's loops, each runner child) and a restarted server
 * agree on it. It holds no secret: those go only into one exec's environment.
 *
 * Coordination between processes is on this row, in IMMEDIATE transactions (computer/state.ts):
 *   - an exec holds a LEASE (one entry of `leases`, until a time): while one is live the computer is not
 *     stopped or resized under it; an exec whose process died leaves one that lapses on its own;
 *   - a change of run state that must not race an exec (the idle stop, a boost's resize and restore) holds
 *     the OP (`op`, `op_until`): while one is held no exec starts, and it lapses on its own at `op_until`
 *     if its holder died.
 */
export const computers = sqliteTable("computers", {
  chatId: integer("chat_id")
    .primaryKey()
    .references(() => chats.id),
  /**
   * The Hangar Disk (`home-<chat>`) and Container (`shuvi-<chat>` for a new computer; an older one keeps
   * the name recorded here).
   */
  disk: text("disk").notNull(),
  container: text("container").notNull(),
  /** Both objects have been applied at least once. */
  created: integer("created", { mode: "boolean" }).notNull().default(false),
  /** The run state shuvi last applied. */
  runState: text("run_state", { enum: ["running", "stopped"] }).notNull().default("stopped"),
  /** While boosted: the size it runs at, and the background job it is for (null: a synchronous exec). */
  boost: text("boost", { mode: "json" }).$type<{ cpu: string; memory: string; jobId: number | null; since: string }>(),
  /** A run-state change in progress: `stop` (idle), `boost`, `restore`. Null when none. */
  op: text("op"),
  opUntil: text("op_until"),
  /** Execs in flight, by a random id, each with the time its lease lapses (ISO). */
  leases: text("leases", { mode: "json" }).notNull().default({}).$type<Record<string, string>>(),
  /** When the last exec ended (or started): the idle clock. */
  lastExecAt: text("last_exec_at"),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

/**
 * Secret profiles granted to a chat's computer (docs/design.md §15, computer/secrets.ts). A grant is made
 * from the owner's answer to a `secret` approval card, once per approval; it names the profile, never a
 * value. It ends at `expires_at`, or when the owner presses "Revoke" on its revoke card
 * (`revoke_approval_id`) in the control bot.
 */
export const secretGrants = sqliteTable(
  "secret_grants",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    profile: text("profile").notNull(),
    /** The approval the owner granted it on. One grant per approval. */
    approvalId: integer("approval_id").notNull().unique(),
    expiresAt: text("expires_at").notNull(),
    /** The control-bot card that revokes it. */
    revokeApprovalId: integer("revoke_approval_id"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [index("secret_grants_chat").on(t.chatId)],
);

/**
 * Schedules (docs/design.md §10): a one-shot (`at`) or a cron expression, set in a chat. When `next_at`
 * passes, store/schedules.ts writes one `scheduled` event into that chat and moves `next_at` past NOW (not
 * past the missed time), in one transaction: a schedule missed during downtime fires once, not once per
 * missed occurrence. The event is keyed `schedule:<id>:<next_at>`, so a firing is written once.
 */
export const schedules = sqliteTable(
  "schedules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    note: text("note").notNull(),
    /** One-shot: the instant (ISO, UTC). */
    at: text("at"),
    /** Recurring: a cron expression, read in `time_zone`. */
    cron: text("cron"),
    timeZone: text("time_zone").notNull(),
    /** active → done (a one-shot that fired) | cancelled. */
    state: text("state", { enum: ["active", "done", "cancelled"] }).notNull().default("active"),
    /** The next time it is due (ISO, UTC); null once done or cancelled. */
    nextAt: text("next_at"),
    lastFiredAt: text("last_fired_at"),
    createdTurnId: integer("created_turn_id"),
    /** Set by a call the owner authorised: only then does its `scheduled` event count as the owner's. */
    ownerAuthorised: integer("owner_authorised", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [index("schedules_due").on(t.state, t.nextAt)],
);

// ---- the sticker library (src/capabilities/stickers/, docs/design.md §12) ----------------------------
//
// Two sources, kept apart so neither overwrites the other:
//   - Telegram's side (`sticker_sets`, `sticker_meta`): fetched by the server, never written by hand.
//   - The owner's side (`sticker_packs`, `sticker_library`): an INDEX of home/stickers/<pack>.yaml,
//     rebuilt from the files whenever one changes. The YAML is the truth; these rows can be dropped.
// They meet on `file_unique_id`. How often she used a sticker is not stored here: it is counted from
// `chat_events` (`bot_sticker`).

/** A sticker set as Telegram has it, and whether the server has fetched it. */
export const stickerSets = sqliteTable("sticker_sets", {
  /** The set's name (`getStickerSet`), which is also the YAML's `pack`. */
  name: text("name").primaryKey(),
  title: text("title"),
  /** pending: asked for, the server fetches it; ready: fetched; failed: given up (`error`). */
  state: text("state", { enum: ["pending", "ready", "failed"] }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
  /** How many stickers the set had when fetched. */
  count: integer("count"),
  requestedAt: text("requested_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  fetchedAt: text("fetched_at"),
});

/** One sticker's Telegram-side facts, keyed by its stable `file_unique_id`. */
export const stickerMeta = sqliteTable(
  "sticker_meta",
  {
    fileUniqueId: text("file_unique_id").primaryKey(),
    setName: text("set_name").notNull(),
    /** 1-based position in the set when last fetched: the `n` of a fresh YAML skeleton. */
    position: integer("position").notNull(),
    /** What `sendSticker` takes. */
    fileId: text("file_id").notNull(),
    emoji: text("emoji"),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    format: text("format", { enum: ["static", "animated", "video"] }).notNull(),
    /** Too thin or too wide to read well in a chat (aspect ratio); not offered unless named. */
    narrow: integer("narrow", { mode: "boolean" }).notNull(),
    /** The picture shown for it (vision's rule: a static sticker itself, else its thumbnail), under the data dir. */
    path: text("path"),
    mimeType: text("mime_type"),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [index("sticker_meta_set").on(t.setName, t.position)],
);

/** One home/stickers/*.yaml file, as last indexed. */
export const stickerPacks = sqliteTable("sticker_packs", {
  /** The file's name under home/stickers/. */
  file: text("file").primaryKey(),
  /** A hash of the file's bytes: a different one means re-index it. */
  hash: text("hash").notNull(),
  /** `pack`, from the file; null when the file has never parsed. */
  pack: text("pack"),
  role: text("role", { enum: ["avatar", "common", "meme"] }),
  dmOnly: integer("dm_only", { mode: "boolean" }).notNull().default(false),
  /** Why the file's latest version could not be indexed (its previous stickers are kept meanwhile). */
  error: text("error"),
});

/** One sticker of the library, from its pack's YAML. The full-text index over it is `sticker_fts` (stickers/library.ts). */
export const stickerLibrary = sqliteTable(
  "sticker_library",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    file: text("file").notNull(),
    pack: text("pack").notNull(),
    n: integer("n").notNull(),
    fileUniqueId: text("file_unique_id").notNull(),
    desc: text("desc").notNull().default(""),
    use: text("use").notNull().default(""),
    /** go-to / normal (omitted in the YAML) / rare / never. */
    tier: text("tier", { enum: ["go-to", "normal", "rare", "never"] }).notNull(),
    dmOnly: integer("dm_only", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [uniqueIndex("sticker_library_pack_n").on(t.pack, t.n), index("sticker_library_file").on(t.file)],
);

/**
 * Prewarms (src/capabilities/media/): a link to a known video host in an OWNER's message, probed through
 * porchkit as soon as the message is recorded, alongside the turn being spawned. One row per link of a
 * message (`seq`, `n`); the row keeps the link's hash (`url_hash`, the key a `video_probe` call joins by) and
 * host, not the URL. `result` is the probe's answer as video_probe shows it (title, uploader, length,
 * chapters, subtitle languages; media/text.ts `storedProbe`, no URL), kept FOR AN HOUR so a `video_probe` of
 * the same link needs no second request; media's prune then drops it and the accounting stays. `used_turn_id`:
 * the first turn that called `video_probe` with the link (the console's "prewarmed: used / unused").
 */
export const mediaPrewarms = sqliteTable(
  "media_prewarms",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id),
    seq: integer("seq").notNull(),
    /** The link's place among the message's prewarmed links, from 1. */
    n: integer("n").notNull(),
    urlHash: text("url_hash").notNull(),
    /** The link's host, for the console (`youtu.be`). */
    host: text("host").notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    /** ok, or porchkit's error code (`rate_limited`, `unavailable`, …), `unreachable`, `timeout`. Null while in flight. */
    outcome: text("outcome"),
    result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
    usedTurnId: integer("used_turn_id"),
    usedAt: text("used_at"),
  },
  (t) => [uniqueIndex("media_prewarms_seq_n").on(t.seq, t.n), index("media_prewarms_hash").on(t.chatId, t.urlHash)],
);
