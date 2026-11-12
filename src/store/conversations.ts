import type { ConversationStore, ModelMessage } from "agent-runtime/openai-compat";
import type { Db } from "./db.ts";

/**
 * OpenAI-compatible histories are shared by runner processes and belong to a chat. `/new` clears the active
 * session but keeps its history until retention expires. A running turn protects its chat's histories, even
 * before its first session callback. Only a missing conversation row is a lost session; malformed message
 * JSON stays an ordinary error. Loads read one coherent SQLite snapshot.
 * Appends, compaction, and pruning use immediate transactions; compaction advances the visible generation,
 * and retention preserves histories used by a chat or running turn.
 */

/** A durable OpenAI-compatible conversation whose stored history no longer exists. */
export class LostConversationError extends Error {
  constructor() {
    super("OpenAI-compatible conversation history was not found");
    this.name = "LostConversationError";
  }
}

/** Model messages share SQLite across runner processes; system prompts are supplied per turn, not stored. */
export function conversationStore(db: Db, chatId: number): ConversationStore {
  return {
    async load(id) {
      const rows = db.$client.query(
        `select m.message
         from conversations c
         left join conversation_messages m
           on m.conversation_id = c.id and m.generation = c.generation
         where c.id = ?
         order by m.seq`,
      ).all(id) as Array<{ message: string | null }>;
      if (!rows.length) throw new LostConversationError();
      return rows.flatMap(({ message }) => message === null ? [] : [JSON.parse(message) as ModelMessage]);
    },
    async append(id, messages) {
      const serialized = messages.map((message) => JSON.stringify(message));
      db.$client.transaction(() => {
        const touchedAt = new Date().toISOString();
        db.$client.query(
          `insert into conversations (id, chat_id, written_at) values (?, ?, ?)
           on conflict(id) do update set written_at = excluded.written_at`,
        ).run(id, chatId, touchedAt);
        const row = db.$client.query("select generation from conversations where id = ?").get(id) as { generation: number };
        const next = db.$client.query(
          "select coalesce(max(seq), -1) + 1 as seq from conversation_messages where conversation_id = ? and generation = ?",
        ).get(id, row.generation) as { seq: number };
        const insert = db.$client.query(
          "insert into conversation_messages (conversation_id, generation, seq, message) values (?, ?, ?, ?)",
        );
        serialized.forEach((message, index) => insert.run(id, row.generation, next.seq + index, message));
      }).immediate();
    },
    async compact(id, messages) {
      const serialized = messages.map((message) => JSON.stringify(message));
      db.$client.transaction(() => {
        const row = db.$client.query("select generation from conversations where id = ?").get(id) as { generation: number } | null;
        const generation = row ? row.generation + 1 : 0;
        if (!row) {
          db.$client.query("insert into conversations (id, chat_id, generation) values (?, ?, ?)").run(id, chatId, generation);
        }
        const touchedAt = new Date().toISOString();
        db.$client.query("update conversations set generation = ?, written_at = ? where id = ?").run(
          generation,
          touchedAt,
          id,
        );
        const insert = db.$client.query(
          "insert into conversation_messages (conversation_id, generation, seq, message) values (?, ?, ?, ?)",
        );
        serialized.forEach((message, seq) => insert.run(id, generation, seq, message));
        db.$client.query("delete from conversation_messages where conversation_id = ? and generation < ?").run(id, generation);
      }).immediate();
    },
  };
}

/** Remove abandoned histories older than `before`, preserving histories used by chats or running turns. */
export function pruneConversations(db: Db, before: string, batch = 500): number {
  let removed = 0;
  for (;;) {
    const count = db.$client.transaction(() => db.$client.query(
      `delete from conversations
       where id in (
         select c.id
         from conversations c
         where c.written_at < ?
           and not exists (select 1 from chats ch where ch.id = c.chat_id and ch.backend_session_id = c.id)
           and not exists (select 1 from turns t where t.chat_id = c.chat_id and t.status = 'running')
         order by c.written_at, c.id
         limit ?
       )`,
    ).run(before, batch).changes).immediate();
    removed += count;
    if (count < batch) return removed;
  }
}
