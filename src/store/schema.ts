import { and, inArray, sql } from "drizzle-orm";
import { blob, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
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
  /**
   * Set: the active conversation is a CLEAN one (`/newclean`, the console's Start clean, a clean switch;
   * agent/switch.ts), which began after this event seq. Its turns get no way to look back through what was said
   * (the retrieval capability is left out, agent/turn.ts), and a fresh opening of it (a lost session restarted)
   * is shown only what was said after this seq. It belongs to the conversation, not the chat: parked with it
   * (`chat_conversations.clean_since`), back with it, kept when a lost session restarts it; null for any other
   * conversation (`/new`, another model's).
   */
  cleanSince: integer("clean_since"),
  /**
   * The profile the chat uses (home/profiles/<name>/, capabilities/memory/layers.ts), from its next turn; null =
   * none, the base. One that no longer exists is run on the base (agent/turn.ts `chatLayers`).
   */
  profile: text("profile"),
  /**
   * PINNED WARM (the owner's choice, from the console's chat settings): with `SHUVI_WARM_RUNNERS` on, the chat's warm
   * runner never idles out and does not count toward `SHUVI_WARM_MAX`, and the server starts one whenever the chat
   * has none (server/warm.ts `PinKeeper`), so even the first message after a quiet stretch is handed to a runner.
   */
  warmPinned: integer("warm_pinned", { mode: "boolean" }).notNull().default(false),
  /**
   * This chat's EFFORT OVERRIDE (`low` … `max`, agent-runtime's levels), from its next turn; null = its model's default
   * (`models.effort`), else the model's own. Resolved per turn by store/models.ts `resolveEffort`. A model switch keeps it
   * only when the new model supports it (agent/switch.ts).
   */
  effort: text("effort"),
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
 *
 * An OpenAI-compatible model's PROBE (server/probes.ts) is stored here too. `probe_started_at` is set while one is
 * asked or running (one left set by a restart runs again; cleared when it finishes or is cancelled).
 * `probe_status` is the LAST probe's result, kept while a new one runs so a cancelled probe leaves it as it was:
 * `ok` (a structured tool call came back), `text-instead` (it answered in text: without tools she cannot speak)
 * or `failed` (`probe_error` says why).
 * `probe_vision` is whether the last probe that tried saw a picture accepted (null: not known); it sets
 * `vision` unless the owner set `vision` himself (`vision_set`).
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
    /** The owner set `vision` himself: a probe no longer changes it. */
    visionSet: integer("vision_set", { mode: "boolean" }).notNull().default(false),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    /** The last probe's result. Null: never finished one (a Claude model never is). */
    probeStatus: text("probe_status", { enum: ["ok", "text-instead", "failed"] }),
    /** Set while a probe is asked or running: when it was asked. */
    probeStartedAt: text("probe_started_at"),
    probeError: text("probe_error"),
    probeLatencyMs: integer("probe_latency_ms"),
    probedAt: text("probed_at"),
    probeVision: integer("probe_vision", { mode: "boolean" }),
    /** This model's DEFAULT EFFORT (a Claude model only, one of `effort_levels`); null = the model's own default. */
    effort: text("effort"),
    /**
     * The effort levels this Claude model supports, as Claude Code's model listing reports them (agent-runtime
     * `listClaudeModels` → `effortLevels`), low → high; `[]`: it takes none. Null = NOT RECORDED: no effort is offered
     * or sent for it until a listing records them (server/probes.ts fills them in the background).
     */
    effortLevels: text("effort_levels", { mode: "json" }).$type<string[]>(),
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
    /** As `chats.clean_since`, for this parked conversation: back on `chats` when it is resumed. */
    cleanSince: integer("clean_since"),
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
    mode: text("mode", { enum: ["lossless", "lossy", "clean"] }).notNull(),
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
 * other lacks (`lossless`, `carried` messages) or nothing (`lossy`), or starting the target over with nothing
 * (`clean`: its own conversation dropped, the next turn opens with its input only). `native` (a switch within a lane that
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
    mode: text("mode", { enum: ["native", "lossless", "lossy", "clean"] }).notNull(),
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
    /** Outbound: when the sender marked it sent (ISO). Null until then, and for rows sent before this column. */
    sentAt: text("sent_at"),
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

// ---- deleting messages (store/deletions.ts): the owner deletes chat messages from the console ----------
//
// A delete MOVES the rows out of `chat_events` into `deleted_events` (every column, seq included), so no reader
// of `chat_events` sees them, and stashes the verbatim copies it scrubbed elsewhere (`deletion_scrubs`). For
// DELETE_UNDO_MS the batch can be undone, byte for byte; after it the server's purge drops the stash and the
// media files only those rows referred to. Nothing marks where they were.

/**
 * One delete: the batch an undo puts back and the purge drops. A chat has at most one OPEN (its window not
 * closed): a delete while one is open joins it, and the window starts again.
 */
export const deletions = sqliteTable("deletions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id")
    .notNull()
    .references(() => chats.id),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  /** When the undo window closes and the purge may run (ISO). */
  purgeAt: text("purge_at").notNull(),
  /** The chat's cursor at the first delete: an undo is refused once it has moved past a row to put back. */
  cursorSeq: integer("cursor_seq").notNull(),
  /** The chat's newest turn at the first delete (0: none): an undo is refused once another has started. */
  lastTurnId: integer("last_turn_id").notNull(),
});

/** The rows a deletion moved out of `chat_events`, as they were (same columns, same seq). */
export const deletedEvents = sqliteTable(
  "deleted_events",
  {
    seq: integer("seq").primaryKey(),
    deletionId: integer("deletion_id")
      .notNull()
      .references(() => deletions.id),
    chatId: integer("chat_id").notNull(),
    kind: text("kind").notNull(),
    payload: text("payload").notNull(),
    tgUpdateId: integer("tg_update_id"),
    tgMessageId: integer("tg_message_id"),
    idemKey: text("idem_key"),
    status: text("status"),
    note: text("note"),
    turnId: integer("turn_id"),
    sentAt: text("sent_at"),
    at: text("at").notNull(),
    /** The turn whose delete took this row (it answered or wrote it), null for a message deleted by itself. */
    byTurn: integer("by_turn"),
  },
  (t) => [index("deleted_events_deletion").on(t.deletionId)],
);

/**
 * What a deletion scrubbed besides the rows themselves, with the original value for its undo: a reply's
 * quote of a deleted message (`event`: a `chat_events.payload`), a deleted message's line in a turn's input
 * (`transcript`: `turn_transcripts.input`), in what a turn was appended, or her own deleted message in the turn
 * that wrote it (`step`: the `turn_steps` columns written, as JSON `{text?, images?, args?}`). `scrubbed` is the
 * value written, so an undo knows whether it changed since.
 */
export const deletionScrubs = sqliteTable(
  "deletion_scrubs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    deletionId: integer("deletion_id")
      .notNull()
      .references(() => deletions.id),
    target: text("target", { enum: ["event", "transcript", "step"] }).notNull(),
    /** event: the seq; transcript: the turn id; step: the step's id. */
    ref: integer("ref").notNull(),
    original: text("original").notNull(),
    scrubbed: text("scrubbed").notNull(),
  },
  (t) => [index("deletion_scrubs_deletion").on(t.deletionId)],
);

/**
 * The idempotency keys of deleted rows, kept (the key alone, nothing of the row) once their deletion is purged, so
 * a delete never re-opens an exactly-once key: a webhook retried with the same Idempotency-Key after its event was
 * deleted stays recorded once (store/events.ts `recordFrameworkEvent`, `recordApprovalEvent` check here and in
 * `deleted_events`, which holds the keys of rows still waiting out their undo).
 */
export const spentIdemKeys = sqliteTable("spent_idem_keys", {
  key: text("key").primaryKey(),
  spentAt: text("spent_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

// A deleted TURN (store/deletions.ts `deleteTurns`): its rows MOVED here, every column as it was, under the
// deletion that holds it (the same open deletion as the chat's deleted messages), for the undo to put back and the
// purge to drop. No foreign key to `turns`: the row is not there while it is stashed.

/** The `turns` rows a deletion moved out (same columns, same id). */
export const deletedTurns = sqliteTable(
  "deleted_turns",
  {
    id: integer("id").primaryKey(),
    deletionId: integer("deletion_id")
      .notNull()
      .references(() => deletions.id),
    chatId: integer("chat_id").notNull(),
    status: text("status").notNull(),
    pid: integer("pid"),
    pidStart: text("pid_start"),
    termAt: text("term_at"),
    fromSeq: integer("from_seq").notNull(),
    toSeq: integer("to_seq").notNull(),
    triggerSeq: integer("trigger_seq"),
    stopSeq: integer("stop_seq"),
    error: text("error"),
    costMicroUsd: integer("cost_micro_usd"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheCreationTokens: integer("cache_creation_tokens"),
    backendSessionId: text("backend_session_id"),
    opening: text("opening"),
    conversationStart: text("conversation_start"),
    profile: text("profile"),
    timings: text("timings"),
    handoff: text("handoff"),
    effort: text("effort"),
    effortSource: text("effort_source"),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
  },
  (t) => [index("deleted_turns_deletion").on(t.deletionId)],
);

/** The `turn_steps` rows of a deleted turn (same columns, same id). */
export const deletedTurnSteps = sqliteTable(
  "deleted_turn_steps",
  {
    id: integer("id").primaryKey(),
    deletionId: integer("deletion_id")
      .notNull()
      .references(() => deletions.id),
    turnId: integer("turn_id").notNull(),
    n: integer("n").notNull(),
    kind: text("kind").notNull(),
    text: text("text"),
    sent: integer("sent"),
    outboundSeq: integer("outbound_seq"),
    name: text("name"),
    args: text("args"),
    result: text("result"),
    status: text("status"),
    error: text("error"),
    callId: text("call_id"),
    images: text("images"),
    fromSeq: integer("from_seq"),
    toSeq: integer("to_seq"),
    tokensBefore: integer("tokens_before"),
    tokensAfter: integer("tokens_after"),
    at: text("at").notNull(),
    endedAt: text("ended_at"),
    madeBy: text("made_by"),
  },
  (t) => [index("deleted_turn_steps_deletion").on(t.deletionId)],
);

/** The `turn_transcripts` row of a deleted turn (same columns). Its `prompt_hash` keeps its `prompt_texts` row alive. */
export const deletedTurnTranscripts = sqliteTable(
  "deleted_turn_transcripts",
  {
    turnId: integer("turn_id").primaryKey(),
    deletionId: integer("deletion_id")
      .notNull()
      .references(() => deletions.id),
    promptHash: text("prompt_hash"),
    input: text("input").notNull(),
    model: text("model"),
    resumed: integer("resumed").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("deleted_turn_transcripts_deletion").on(t.deletionId)],
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
    /** The profile the turn ran under (layers.ts), recorded at its start; null = the base. */
    profile: text("profile"),
    /**
     * Where the turn's time went: epoch-ms marks (`TurnTimings`, store/turns.ts `markTurn`), each written by the
     * process that saw it, best effort. A debugging record: nothing reads it to decide anything. Null for a
     * turn that recorded none (one from before this column).
     */
    timings: text("timings", { mode: "json" }).$type<Record<string, number>>(),
    /**
     * A turn the waker HANDED to a chat's warm runner (store/turns.ts `claimTurn`, store/warm.ts) instead of spawning a child:
     * `pending` from the claim until the runner takes it (`acked`). A `pending` turn whose runner is gone never
     * started: the waker closes it without counting a failed attempt, and its input is answered again
     * (server/waker.ts). One whose runner is alive but has not taken it in time is `abandoned` first (so a late
     * take fails), then its runner killed and the turn closed the same way. Null for a turn a child was spawned for.
     */
    handoff: text("handoff", { enum: ["pending", "acked", "abandoned"] }),
    /**
     * The effort the turn ran at (store/models.ts `resolveEffort`), recorded at its start; null = none was sent (the
     * model's own default). `effort_source` says where it came from: `chat` (the chat's override), `model` (its model's
     * default) or `none`. Both null for a turn from before they were recorded, or one that never reached its driver.
     */
    effort: text("effort"),
    effortSource: text("effort_source", { enum: ["chat", "model", "none"] }),
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
  /**
   * `[{ label, start, end, layer? }]`: character offsets into `text`, in order; `layer`, where the section came
   * from: `base`, a profile's name, or `code` (agent/prompt.ts `PromptSection`; absent before profiles).
   */
  sections: text("sections", { mode: "json" }).notNull().$type<{ label: string; start: number; end: number; layer?: string }[]>(),
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
    /**
     * tool: who made the call. Null: the model. `framework`: the framework itself, through the same boundary,
     * before the driver ran (media's auto-read of a short message's link: capabilities/media/autoread.ts).
     */
    madeBy: text("made_by", { enum: ["framework"] }),
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
    /**
     * alert | reply (to a control command; reply_html: its text is Telegram HTML) | approval (a card) |
     * approval_closed (edit a card once answered or expired) | card (send a `control_cards` card as it is
     * then) | card_edit (edit that card's message to what the card is then).
     */
    kind: text("kind", { enum: ["alert", "reply", "reply_html", "approval", "approval_closed", "card", "card_edit"] }).notNull(),
    text: text("text").notNull(),
    idemKey: text("idem_key").unique(),
    topic: text("topic"),
    /** For `approval` / `approval_closed`: the approval it belongs to. */
    approvalId: integer("approval_id"),
    /** For `card` / `card_edit`: the card it belongs to. */
    cardId: integer("card_id"),
    status: text("status", { enum: ["pending", "sent", "failed", "suppressed"] }).notNull(),
    tgMessageId: integer("tg_message_id"),
    note: text("note"),
    /** For `approval`: the card went out as a photo (its text the caption), so closing it edits the caption. */
    asPhoto: integer("as_photo", { mode: "boolean" }).notNull().default(false),
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
  /** The buttons, in order; a `hidden` one is an answer only another surface gives (control/approvals.ts). */
  options: text("options", { mode: "json" }).notNull().$type<{ id: string; label: string; hidden?: boolean }[]>(),
  /** The chat to wake with an `approval` event when it is answered (null: the caller polls). */
  originChatId: integer("origin_chat_id").references(() => chats.id),
  /** Kind-specific data the caller wants back with the answer. */
  data: text("data", { mode: "json" }).$type<Record<string, unknown>>(),
  /**
   * A group's OPERATOR whose delegated call asked for it (their user id); null: the owner or the framework.
   * The answer's `approval` event counts as the owner's in a turn only when this is null (agent/turn.ts
   * `ownerAuthority`); otherwise as the operator's, for delegated tools only.
   */
  requestedBy: integer("requested_by"),
  /** pending → answered | expired. */
  status: text("status", { enum: ["pending", "answered", "expired"] }).notNull(),
  /** The chosen option's id. */
  answer: text("answer"),
  answeredAt: text("answered_at"),
  expiresAt: text("expires_at"),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  /**
   * A picture the card is sent with (PNG or JPEG bytes; a purchase's checkout screenshot): the card then goes as a
   * photo, its text the caption (control/bot.ts). Null: a text card, as every other card.
   */
  photo: blob("photo", { mode: "buffer" }),
});

/**
 * The control bot's cards about models (src/control/model-cards.ts): one control-bot message, edited in
 * place, whose steps are the owner's button presses. A row per card, so a restart in the middle of its steps
 * loses nothing. `state` is where the card is (its kind's business); `text` and `keyboard` are what it shows
 * now, rendered from that state whenever it changes (and when what it shows changed: a probe finished).
 * `version` counts the owner's steps: a button carries the version it was drawn at, and a press from an
 * older one, or on a card no longer `open`, changes nothing. `waiting`: a switch was asked for and the card
 * waits for its result (`switch_request_id`).
 */
export const controlCards = sqliteTable("control_cards", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind", { enum: ["switch", "models", "provider_add", "provider_remove", "profile", "effort"] }).notNull(),
  status: text("status", { enum: ["open", "waiting", "closed"] }).notNull().default("open"),
  /** For `switch`: the chat whose model it switches; for `profile`: its profile; for `effort`: its effort. */
  chatId: integer("chat_id").references(() => chats.id),
  /** What opened it (`command:<seq>`, `update:<id>`), so the same command never opens two. */
  idemKey: text("idem_key").unique(),
  state: text("state", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  text: text("text").notNull(),
  keyboard: text("keyboard", { mode: "json" }).notNull().$type<{ text: string; callback_data: string }[][]>(),
  version: integer("version").notNull().default(0),
  /** Bumped on every change of `text` / `keyboard`: each edit row is keyed on it. */
  rev: integer("rev").notNull().default(0),
  switchRequestId: integer("switch_request_id"),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

/**
 * The WARM RUNNERS (runner/warm.ts, store/warm.ts): a runner child that stayed after its turn, holding a
 * resident Claude Code CLI for its chat, waiting to be handed the chat's next turn. One per chat at most; a row
 * exists only while its runner is IDLE (a hand-off deletes it in the claim's transaction, and the runner puts
 * it back when the turn is over). Deleting a row is how a runner is retired: it exits once it sees it gone.
 */
export const warmRunners = sqliteTable("warm_runners", {
  chatId: integer("chat_id")
    .primaryKey()
    .references(() => chats.id),
  /** The runner's pid and that process's start time (server/spawn.ts `isAlive`), as a turn's are. */
  pid: integer("pid").notNull(),
  pidStart: text("pid_start"),
  /** What its CLI was opened for (runner/warm-session.ts `warmFingerprint`): prompt, tools, provider and login. */
  fingerprint: text("fingerprint").notNull(),
  /** The code the runner runs (version.ts `codeVersion`); a server running other code retires it, at start or at a hand-off. */
  codeVersion: text("code_version").notNull(),
  /**
   * The configuration it runs with (version.ts `runnerConfigHash`: its whole environment, each value hashed, and the
   * enabled capabilities); a server with another retires it, as for `code_version`. '' on a row from before this column.
   */
  configHash: text("config_hash").notNull().default(""),
  /** Since when it waits (ISO): the idle limit and the cap's least recently idle (`SHUVI_WARM_*`). */
  idleSince: text("idle_since").notNull(),
  /** When its current CLI was started (ISO); null when it holds none. */
  cliStartedAt: text("cli_started_at"),
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
    /**
     * The job was started by a delegated call an OPERATOR authorised (policy.ts `operators`): their user id.
     * Its `job_done` then counts as theirs, for delegated tools only, while policy still names them.
     */
    authorisedBy: integer("authorised_by"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    endedAt: text("ended_at"),
  },
  (t) => [index("jobs_state").on(t.state)],
);

/** The last apply of a chat's ~/.computer.yaml, as `computers.last_apply` keeps it. */
export interface LastApply {
  at: string;
  ok: boolean;
  /** Applied: what it did ("apt: ripgrep; the setup script") and how long it took, in ms. */
  what?: string;
  ms?: number;
  /** Failed: the step (`parse`, `apt`, `setup`, …), its reason, and its output's tail, redacted. */
  step?: string;
  why?: string;
  output?: string;
}

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
  /**
   * The last time ~/.computer.yaml was applied (declared.ts `ensureDeclared`): when, whether it worked, and, failed,
   * the step, its reason and its output's tail, redacted before it is written. Null: none recorded yet.
   */
  lastApply: text("last_apply", { mode: "json" }).$type<LastApply>(),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

/**
 * Secret profiles granted to the computers (docs/design.md §15, computer/secrets.ts). A grant is made from the
 * owner's answer to a `secret` approval card, once per approval, or by the owner in the console (no approval);
 * it names the profile, never a value. It ends at `expires_at` (null: when revoked), or when the owner presses
 * "Revoke" on its revoke card (`revoke_approval_id`) in the control bot, or in the console, which presses it.
 *
 * `chat_id` null is an OWNER grant: every chat's computer gets it, in calls that act for the owner only (never
 * an operator's, agent/acting.ts).
 */
export const secretGrants = sqliteTable(
  "secret_grants",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** The chat it is for; null: every chat, for the owner (an owner grant). */
    chatId: integer("chat_id").references(() => chats.id),
    profile: text("profile").notNull(),
    /** The approval the owner granted it on (one grant per approval); null: made by the owner in the console. */
    approvalId: integer("approval_id").unique(),
    /** When it ends; null: when it is revoked. */
    expiresAt: text("expires_at"),
    /** The control-bot card that revokes it. */
    revokeApprovalId: integer("revoke_approval_id"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [index("secret_grants_chat").on(t.chatId)],
);

/**
 * Profiles the owner keeps in the console (src/secrets/source.ts), beside the secrets file's, of two KINDS:
 * `secret` (her credentials: never shown to her, only injected or typed, and redacted everywhere) and `info`
 * (PERSONAL INFO, src/secrets/info.ts: an address, a phone, a member number, which she reads and keeps; never
 * redacted). A name is unique within its kind. The variables' values are SEALED either way (src/secrets/vault.ts:
 * AES-256-GCM under SHUVI_SECRETS_KEY, the name, and for info the kind, as additional data); only the profile's
 * name and its variables' NAMES are stored in the clear.
 */
export const secretProfiles = sqliteTable(
  "secret_profiles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: ["secret", "info"] }).notNull().default("secret"),
    name: text("name").notNull(),
    /** The variables' names, in order, for showing (never a value). */
    varNames: text("var_names", { mode: "json" }).$type<string[]>().notNull(),
    sealed: blob("sealed", { mode: "buffer" }).notNull(),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [uniqueIndex("secret_profiles_kind_name").on(t.kind, t.name)],
);

/**
 * The history of a personal-info profile (src/secrets/info.ts): one row per change, holding the values the profile
 * had BEFORE it (sealed as the profile's are; `{}` for its creation), when, by whom (`console: <login>`,
 * `assistant in <chat>`), and which fields the change touched. The newest INFO_VERSIONS_KEPT per profile are kept.
 * Gone with the profile, and when it becomes a secret.
 */
export const infoVersions = sqliteTable(
  "info_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    profileId: integer("profile_id")
      .notNull()
      .references(() => secretProfiles.id, { onDelete: "cascade" }),
    /** The fields' names before the change, in order (never a value). */
    varNames: text("var_names", { mode: "json" }).$type<string[]>().notNull(),
    sealed: blob("sealed", { mode: "buffer" }).notNull(),
    /** The fields the change set, added or removed. */
    changed: text("changed", { mode: "json" }).$type<string[]>().notNull(),
    by: text("by").notNull(),
    at: text("at").notNull(),
  },
  (t) => [index("info_versions_profile").on(t.profileId, t.id)],
);

/**
 * What the assistant knows about a secret profile, NOT secret (src/secrets/notes.ts): a one-line `summary` that
 * is in her prompt (what it is for), and `details` she reads with `secret_info` (its scope, the account or org
 * ids it acts on, how to use it, what was tried). Keyed by the profile's kind and name, so a profile of the secrets
 * file has one as well as one kept in the console, and a personal-info profile's (kind `info`: its summary in her
 * prompt, its `- NAME: what it is` lines saying what each field is) is apart from a secret's of the same name.
 * Written by the owner in the console or by her (`update_secret_note`, `info_write`); never holding a secret value
 * (refused when it does).
 */
export const secretNotes = sqliteTable(
  "secret_notes",
  {
    /** The kind of profile it is the note of: a secret's and a personal-info profile's of one name are two. */
    kind: text("kind", { enum: ["secret", "info"] }).notNull().default("secret"),
    name: text("name").notNull(),
    summary: text("summary").notNull().default(""),
    details: text("details").notNull().default(""),
    /** Who wrote it last: `console` (the owner, with his login if known) or `assistant` (with the chat). */
    updatedBy: text("updated_by").notNull(),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [primaryKey({ columns: [t.kind, t.name] })],
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
    /**
     * active → done (a one-shot that fired) | cancelled; active ⇄ paused (from the console: store/schedules.ts
     * `pauseSchedule`, `resumeSchedule`). A paused schedule never fires; resumed, it runs next from NOW.
     */
    state: text("state", { enum: ["active", "paused", "done", "cancelled"] }).notNull().default("active"),
    /** The next time it is due (ISO, UTC); null once done or cancelled. Paused: as it was when paused. */
    nextAt: text("next_at"),
    lastFiredAt: text("last_fired_at"),
    createdTurnId: integer("created_turn_id"),
    /** Set by a call the owner authorised: only then does its `scheduled` event count as the owner's. */
    ownerAuthorised: integer("owner_authorised", { mode: "boolean" }).notNull().default(false),
    /** Set by a delegated call an operator authorised: their user id (as `jobs.authorisedBy`). */
    authorisedBy: integer("authorised_by"),
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
  /** The file's key: its name under home/stickers/, or `profiles/<name>/stickers/<file>` (stickers/library.ts). */
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
  // A pack may be described once per layer (the base, or a profile: stickers/library.ts), so n is unique per file.
  (t) => [uniqueIndex("sticker_library_file_n").on(t.file, t.n), index("sticker_library_pack_n").on(t.pack, t.n)],
);

/**
 * Prewarms (src/capabilities/media/prewarm.ts): each link of a message that starts a turn (and of the message
 * it replies to), read through porchkit's `/read` as soon as the message is recorded, alongside the turn being
 * spawned. One row per link of a message (`seq`, `n`); the row keeps the link's hash (`url_hash`, the key a
 * `read_link` call joins by) and host, not the URL. `result` is only the kind porchkit answered
 * (`{kind: "post"}`), kept FOR AN HOUR; media's prune then drops it and the accounting stays. Older `probe` rows
 * hold the probe's answer as video_probe shows it (no URL), which video_probe still joins. `used_turn_id`: the
 * first turn that called the endpoint's tool with the link (the console's "prewarmed: used / unused").
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
    /**
     * The porchkit call it went to: `read` (`/read`, joined by read_link: every new row) or `probe` (older rows: a
     * video host's link went to `/media/probe`, joined by video_probe). Each tool joins only its own.
     */
    endpoint: text("endpoint").notNull().default("probe"),
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
