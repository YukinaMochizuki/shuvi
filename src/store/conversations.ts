import type { ConversationStore, ModelMessage } from "agent-runtime/openai-compat";
import { eq, sql } from "drizzle-orm";
import type { Db } from "./db.ts";
import { chats, turns } from "./schema.ts";

/**
 * OpenAI-compatible conversation history lives in `kv` and is shared by runner processes. `/new` clears
 * the chat's active session but keeps its history until retention removes it. A missing history row alone
 * is a lost conversation; malformed stored JSON remains an error. Retention preserves chat and running
 * turn sessions. Append, compaction, and pruning serialize on SQLite's immediate write lock. Legacy rows
 * use their latest recorded turn as the age; rows with no associated turn are eligible on the first pass.
 */

const HISTORY_PREFIX = "conversation:";
const RETENTION_PREFIX = "conversation_retention:";

/** A durable OpenAI-compatible conversation whose stored history no longer exists. */
export class LostConversationError extends Error {
  constructor() {
    super("OpenAI-compatible conversation history was not found");
    this.name = "LostConversationError";
  }
}

function historyKey(id: string): string {
  return `${HISTORY_PREFIX}${id}`;
}

function retentionKey(id: string): string {
  return `${RETENTION_PREFIX}${id}`;
}

function parseHistory(value: string): ModelMessage[] {
  const history: unknown = JSON.parse(value);
  if (!Array.isArray(history)) throw new TypeError("OpenAI-compatible conversation history must be an array");
  return history as ModelMessage[];
}

/** Model messages share SQLite across runner processes; system prompts are supplied per turn, not stored. */
export function conversationStore(db: Db): ConversationStore {
  const key = historyKey;
  const save = (id: string, value: string) => {
    db.$client.transaction(() => {
      db.$client.query("insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key(id), value);
      db.$client.query("insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(retentionKey(id), new Date().toISOString());
    }).immediate();
  };
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
        db.$client.query("insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(retentionKey(id), new Date().toISOString());
      }).immediate();
    },
    async compact(id, messages) {
      save(id, JSON.stringify(messages));
    },
  };
}

/** Remove abandoned histories older than `before`, preserving sessions still used by chats or runners. */
export function pruneConversations(db: Db, before: string, batch = 500): number {
  let removed = 0;
  let after = `${HISTORY_PREFIX}`;
  const expiredMetadata = () => db.$client.query(`delete from kv where substr(key, 1, ?) = ? and not exists (select 1 from kv as history where history.key = ? || substr(kv.key, ?))`).run(
    RETENTION_PREFIX.length,
    RETENTION_PREFIX,
    HISTORY_PREFIX,
    RETENTION_PREFIX.length + 1,
  ).changes;
  for (;;) {
    const count = db.$client.transaction(() => {
      const active = new Set<string>();
      for (const row of db.select({ id: chats.backendSessionId }).from(chats).where(sql`${chats.backendSessionId} is not null`).all()) {
        if (row.id) active.add(row.id);
      }
      const runningChatIds = new Set<number>();
      for (const row of db.select({ id: turns.backendSessionId, chatId: turns.chatId }).from(turns).where(eq(turns.status, "running")).all()) {
        runningChatIds.add(row.chatId);
        if (row.id) active.add(row.id);
      }

      const rows = db.$client.query("select key from kv where key like ? and key > ? order by key limit ?").all(`${HISTORY_PREFIX}%`, after, batch) as Array<{ key: string }>;
      if (rows.length) after = rows[rows.length - 1]!.key;
      const old = rows.filter((row) => {
        const id = row.key.slice(HISTORY_PREFIX.length);
        if (active.has(id)) return false;
        // A /new may clear the chat before its runner's first session callback reaches the store.
        const scoped = /^openai-compat:[a-f0-9]{16}:(\d+):/.exec(id);
        if (scoped && runningChatIds.has(Number(scoped[1]))) return false;
        const marker = db.$client.query("select value from kv where key = ?").get(retentionKey(id)) as { value: string } | null;
        const touched = marker?.value ?? (db.$client.query("select max(coalesce(ended_at, started_at)) as touched from turns where backend_session_id = ?").get(id) as { touched: string | null }).touched ?? "0000-01-01T00:00:00.000Z";
        return touched < before;
      });
      if (!old.length) return 0;
      const keys = old.flatMap((row) => [row.key, retentionKey(row.key.slice(HISTORY_PREFIX.length))]);
      const placeholders = keys.map(() => "?").join(", ");
      db.$client.query(`delete from kv where key in (${placeholders})`).run(...keys);
      return old.length;
    }).immediate();
    removed += count;
    if (count === 0 && !db.$client.query("select 1 from kv where key like ? and key > ? limit 1").get(`${HISTORY_PREFIX}%`, after)) break;
  }
  expiredMetadata();
  return removed;
}
