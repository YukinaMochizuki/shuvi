import { and, asc, eq, gt, inArray, lt, max, notExists, sql } from "drizzle-orm";
import type { ConversationStore, ModelMessage } from "agent-runtime/openai-compat";
import type { Db } from "./db.ts";
import { chatLanes, chats, conversationMessages, conversations, turns } from "./schema.ts";
import { IMMEDIATE } from "./turns.ts";

/**
 * OpenAI-compatible histories are shared by runner processes and belong to a chat. `/new` clears the active
 * session but keeps its history until retention expires. A running turn protects its chat's histories, even
 * before its first session callback. Only a missing conversation row is a lost session (`load` returns null,
 * which the driver reports as agent-runtime's `LostSessionError`); malformed message JSON stays an ordinary
 * error. Loads read one coherent SQLite snapshot (one statement).
 * Appends, compaction, and pruning use immediate transactions; compaction advances the visible generation,
 * and retention preserves histories used by a chat (active or parked in `chat_lanes`) or a running turn.
 * Cascade deletion requires `PRAGMA foreign_keys = ON`, which `openDb` sets on every connection.
 *
 * POSITIONS, for carrying a conversation to another lane (agent/switch.ts): `<generation>:<seq>` of the
 * last message (`conversationEnd`); `conversationSince` returns what came after one. A compaction since then
 * (a newer generation) leaves only the compacted history to return, which is all of it.
 */

/** What writes a conversation: the store itself, or a transaction a caller already holds (agent/switch.ts). */
type Writer = Pick<Db, "select" | "insert" | "update" | "delete">;

/** Rows per insert statement, well under SQLite's bound-variable limit (4 per row). */
const INSERT_BATCH = 500;

/** Model messages share SQLite across runner processes; system prompts are supplied per turn, not stored. */
export function conversationStore(db: Db, chatId: number): ConversationStore {
  return {
    async load(id) {
      const rows = db
        .select({ message: conversationMessages.message })
        .from(conversations)
        .leftJoin(
          conversationMessages,
          and(eq(conversationMessages.conversationId, conversations.id), eq(conversationMessages.generation, conversations.generation)),
        )
        .where(eq(conversations.id, id))
        .orderBy(asc(conversationMessages.seq))
        .all();
      if (!rows.length) return null;
      return rows.flatMap(({ message }) => (message === null ? [] : [message]));
    },
    async append(id, messages) {
      appendMessages(db, chatId, id, messages);
    },
    async compact(id, messages) {
      db.transaction((tx) => {
        const row = tx.select({ generation: conversations.generation }).from(conversations).where(eq(conversations.id, id)).get();
        const generation = row ? row.generation + 1 : 0;
        const writtenAt = new Date().toISOString();
        tx.insert(conversations)
          .values({ id, chatId, generation, writtenAt })
          .onConflictDoUpdate({ target: conversations.id, set: { generation, writtenAt } })
          .run();
        insertRows(tx, id, generation, 0, messages);
        tx.delete(conversationMessages)
          .where(and(eq(conversationMessages.conversationId, id), lt(conversationMessages.generation, generation)))
          .run();
      }, IMMEDIATE);
    },
  };
}

/** Append `messages` to conversation `id` of chat `chatId`, creating it when it is new. */
export function appendMessages(db: Db, chatId: number, id: string, messages: ModelMessage[]): void {
  db.transaction((tx) => insertMessages(tx, chatId, id, messages), IMMEDIATE);
}

/** `appendMessages` inside a transaction the caller already holds (agent/switch.ts), through its handle `tx`. */
export function insertMessages(tx: Writer, chatId: number, id: string, messages: ModelMessage[]): void {
  const writtenAt = new Date().toISOString();
  const { generation } = tx
    .insert(conversations)
    .values({ id, chatId, writtenAt })
    .onConflictDoUpdate({ target: conversations.id, set: { writtenAt } })
    .returning({ generation: conversations.generation })
    .get();
  const last = tx
    .select({ seq: max(conversationMessages.seq) })
    .from(conversationMessages)
    .where(and(eq(conversationMessages.conversationId, id), eq(conversationMessages.generation, generation)))
    .get();
  insertRows(tx, id, generation, (last?.seq ?? -1) + 1, messages);
}

function insertRows(tx: Writer, id: string, generation: number, firstSeq: number, messages: ModelMessage[]): void {
  for (let i = 0; i < messages.length; i += INSERT_BATCH) {
    tx.insert(conversationMessages)
      .values(messages.slice(i, i + INSERT_BATCH).map((message, j) => ({ conversationId: id, generation, seq: firstSeq + i + j, message })))
      .run();
  }
}

export function conversationExists(db: Db, id: string): boolean {
  return !!db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, id)).get();
}

/** Where conversation `id` ends now (`<generation>:<seq>`); null for one with no messages, or none at all. */
export function conversationEnd(db: Pick<Db, "select">, id: string): string | null {
  const row = db
    .select({ generation: conversations.generation, seq: max(conversationMessages.seq) })
    .from(conversations)
    .innerJoin(
      conversationMessages,
      and(eq(conversationMessages.conversationId, conversations.id), eq(conversationMessages.generation, conversations.generation)),
    )
    .where(eq(conversations.id, id))
    .get();
  return row && row.seq !== null ? `${row.generation}:${row.seq}` : null;
}

/**
 * The messages of conversation `id` after position `after` (null: all of them). `afterFound` is false when
 * the conversation was compacted since, and all of its current history is returned. A conversation that does
 * not exist has no messages.
 */
export function conversationSince(db: Db, id: string, after: string | null): { messages: ModelMessage[]; afterFound: boolean } {
  const at = after ? /^(\d+):(-?\d+)$/.exec(after) : null;
  const current = db.select({ generation: conversations.generation }).from(conversations).where(eq(conversations.id, id)).get();
  if (!current) return { messages: [], afterFound: !after };
  const sameGeneration = !!at && Number(at[1]) === current.generation;
  const rows = db
    .select({ message: conversationMessages.message })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, id),
        eq(conversationMessages.generation, current.generation),
        gt(conversationMessages.seq, sameGeneration ? Number(at![2]) : -1),
      ),
    )
    .orderBy(asc(conversationMessages.seq))
    .all();
  return { messages: rows.map((r) => r.message), afterFound: !after || sameGeneration };
}

/** Remove abandoned histories older than `before`, preserving histories used by chats or running turns. */
export function pruneConversations(db: Db, before: string, batch = 500): number {
  let removed = 0;
  for (;;) {
    const count = db.transaction((tx) => {
      const abandoned = tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            lt(conversations.writtenAt, before),
            notExists(tx.select({ one: sql`1` }).from(chats).where(and(eq(chats.id, conversations.chatId), eq(chats.backendSessionId, conversations.id)))),
            notExists(
              tx.select({ one: sql`1` }).from(chatLanes).where(and(eq(chatLanes.chatId, conversations.chatId), eq(chatLanes.backendSessionId, conversations.id))),
            ),
            notExists(tx.select({ one: sql`1` }).from(turns).where(and(eq(turns.chatId, conversations.chatId), eq(turns.status, "running")))),
          ),
        )
        .orderBy(asc(conversations.writtenAt), asc(conversations.id))
        .limit(batch);
      return tx.delete(conversations).where(inArray(conversations.id, abandoned)).returning({ id: conversations.id }).all().length;
    }, IMMEDIATE);
    removed += count;
    if (count < batch) return removed;
  }
}
