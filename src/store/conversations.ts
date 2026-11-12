import type { ConversationStore, ModelMessage } from "agent-runtime/openai-compat";
import type { Db } from "./db.ts";

/** A durable OpenAI-compatible conversation whose stored history no longer exists. */
export class LostConversationError extends Error {
  constructor() {
    super("OpenAI-compatible conversation history was not found");
    this.name = "LostConversationError";
  }
}

function parseHistory(value: string): ModelMessage[] {
  const history: unknown = JSON.parse(value);
  if (!Array.isArray(history)) throw new TypeError("OpenAI-compatible conversation history must be an array");
  return history as ModelMessage[];
}

/** Model messages share SQLite across runner processes; system prompts are supplied per turn, not stored. */
export function conversationStore(db: Db): ConversationStore {
  const key = (id: string) => `conversation:${id}`;
  return {
    async load(id) {
      const row = db.$client.query("select value from kv where key = ?").get(key(id)) as { value: string } | null;
      if (!row) throw new LostConversationError();
      return parseHistory(row.value);
    },
    async append(id, messages) {
      // Take the write lock before reading, so concurrent runners wait instead of upgrading a stale snapshot.
      db.$client.transaction(() => {
        const q = db.$client.query("select value from kv where key = ?");
        const row = q.get(key(id)) as { value: string } | null;
        const history = row ? parseHistory(row.value) : [];
        db.$client.query("insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key(id), JSON.stringify([...history, ...messages]));
      }).immediate();
    },
    async compact(id, messages) {
      db.$client.query("insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key(id), JSON.stringify(messages));
    },
  };
}
