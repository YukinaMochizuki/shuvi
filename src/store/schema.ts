import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * The store. One SQLite file, shared by the server and every runner child (WAL, so a child writing its
 * turn never blocks the poller). See docs/design.md §3 for why it is shaped this way.
 *
 * `chat_events` is what HAPPENED in a chat, and nothing else: what people said, what the assistant said,
 * a command. It is not the model's conversation (agent-runtime keeps that) and not bookkeeping about turns
 * (that is `turns`). Everything that must be exactly-once hangs off a unique key here:
 *   - an inbound update off `tg_update_id`, so a re-delivered update is not recorded twice;
 *   - an outbound message off `idem_key`, so a turn that writes the same message twice records it once;
 *   - an outbound message's delivery off `tg_message_id`, so a row that has one is never sent again.
 */

export const chats = sqliteTable("chats", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tgChatId: integer("tg_chat_id").notNull().unique(),
  kind: text("kind", { enum: ["private", "group"] }).notNull(),
  title: text("title"),
  /** The last event seq the assistant has SEEN. The waker opens a turn only for inbound events past it. */
  cursorSeq: integer("cursor_seq").notNull().default(0),
  /** agent-runtime's conversation id; null = the next turn starts a fresh conversation (`/new`). */
  backendSessionId: text("backend_session_id"),
  /** Context occupancy the last turn ended at, handed back to the driver on the next turn. */
  contextTokens: integer("context_tokens"),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

export const EVENT_KINDS = [
  /** Someone wrote in the chat (text, or a placeholder for what this slice cannot read yet). */
  "message",
  /** An owner command (`/new`, `/stop`). Handled by the server; never shown to the model as speech. */
  "command",
  /** The assistant said something. Outbound: pending until the sender fills `tg_message_id`. */
  "bot_message",
  /** The assistant (or the server, acknowledging a command) reacted to a message. Outbound. */
  "bot_reaction",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const OUTBOUND_KINDS: EventKind[] = ["bot_message", "bot_reaction"];
/** Kinds that, past the cursor, ask for a turn. */
export const TRIGGER_KINDS: EventKind[] = ["message"];

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
  (t) => [index("chat_events_chat_seq").on(t.chatId, t.seq), index("chat_events_status").on(t.status)],
);

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
    /** The cursor when the turn started; the events it was given are those after it. */
    fromSeq: integer("from_seq").notNull(),
    /** The last inbound seq the turn has been shown (grows as mid-turn messages are appended). */
    toSeq: integer("to_seq").notNull(),
    /** The `/stop` (or `/new`) that stopped this turn: messages from it on are not the stopped turn's. */
    stopSeq: integer("stop_seq"),
    error: text("error"),
    costMicroUsd: integer("cost_micro_usd"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    startedAt: text("started_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    endedAt: text("ended_at"),
  },
  // One running turn per chat, enforced by the database rather than by the waker remembering to check.
  (t) => [uniqueIndex("turns_one_running_per_chat").on(t.chatId).where(sql`status = 'running'`)],
);

export const kv = sqliteTable("kv", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
