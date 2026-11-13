import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { appendToClaudeSession } from "agent-runtime/convert";
import { enterChatModel } from "../src/agent/switch.ts";
import { openDb, type Db } from "../src/store/db.ts";
import { getChat } from "../src/store/events.ts";

/**
 * drizzle/0013 + 0014: a conversation per model. Each conversation a chat had per lane (the active one on
 * `chats.lane`, the parked ones in `chat_lanes`) is moved onto the model it belongs to, on a store built at the
 * previous schema (0012) with rows as round 1 left them.
 */

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A store at the schema of migration `last` and before. */
function storeAt(last: number): { path: string; db: Db } {
  const dir = mkdtempSync(join(tmpdir(), "shuvi-model-migration-"));
  dirs.push(dir);
  const migrations = join(dir, "migrations");
  mkdirSync(join(migrations, "meta"), { recursive: true });
  const source = new URL("../drizzle/", import.meta.url);
  const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", source), "utf8")) as { entries: { idx: number; tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= last);
  for (const entry of journal.entries) copyFileSync(new URL(`${entry.tag}.sql`, source), join(migrations, `${entry.tag}.sql`));
  writeFileSync(join(migrations, "meta/_journal.json"), JSON.stringify(journal));
  const path = join(dir, "shuvi.db");
  const db = openDb(path);
  migrate(db, { migrationsFolder: migrations });
  return { path, db };
}

function catalog(db: Db) {
  const q = db.$client;
  q.run("insert into model_providers (id, name, kind, config_dir) values (1, 'claude', 'claude', null), (3, 'work', 'claude', '/srv/claude-work')");
  q.run("insert into model_providers (id, name, kind, base_url, api_key) values (2, 'vllm', 'openai-compat', 'http://127.0.0.1:8000/v1', 'vllm.API_KEY')");
  q.run(`insert into models (provider_id, model, context_window, is_default) values
    (1, 'opus', null, 1), (1, 'sonnet', null, 0), (2, 'qwen', 32000, 0), (2, 'llama', 32000, 0), (3, 'opus', null, 0)`);
}

test("every lane's conversation is moved onto its model; what maps to nothing is dropped", () => {
  const { path, db: old } = storeAt(12);
  catalog(old);
  const q = old.$client;
  const chat = q.query("insert into chats (id, tg_chat_id, kind, model, lane, backend_session_id, lane_entered_at, context_tokens) values (?, ?, 'private', ?, ?, ?, ?, ?)");
  // 1: opus → lossless → qwen → native → llama → lossy → sonnet (back on the Claude session).
  chat.run(1, 1001, "claude/sonnet", "claude:claude", "S1", "uuid-entered-1", 5000);
  q.run("insert into chat_lanes (chat_id, lane, backend_session_id, context_tokens, parked_at) values (1, 'openai-compat', 'Q1', 900, '2026-11-10T00:00:00.000Z')");
  q.run(`insert into model_switches (chat_id, from_model, to_model, mode, from_session_id, to_session_id, carried) values
    (1, 'claude/opus', 'vllm/qwen', 'lossless', 'S1', 'Q1', 4),
    (1, 'vllm/qwen', 'vllm/llama', 'native', 'Q1', 'Q1', 0),
    (1, 'vllm/llama', 'claude/sonnet', 'lossy', 'Q1', 'S1', 0)`);
  // 2: a conversation from before lanes (no lane), following the default: the seeded login's, the default's.
  chat.run(2, 1002, null, null, "L2", null, null);
  // 3: a lossy switch to the endpoint, no conversation there yet: it is the chat's model's.
  chat.run(3, 1003, "vllm/qwen", "openai-compat", null, null, null);
  // 4: on the endpoint; a conversation parked in the lane of a login since removed: dropped.
  chat.run(4, 1004, "vllm/qwen", "openai-compat", "Q4", "3:7", 100);
  q.run("insert into chat_lanes (chat_id, lane, backend_session_id) values (4, 'claude:gone', 'G4')");
  // 5: in the second login's lane, its model and the default elsewhere: the first model of that login.
  chat.run(5, 1005, "vllm/qwen", "claude:work", "W5", null, null);
  // 6: an active conversation in a removed login's lane: dropped, so the next turn starts fresh.
  chat.run(6, 1006, null, "claude:gone", "X6", "uuid-x", 77);
  old.$client.close();

  for (let attempt = 0; attempt < 2; attempt++) {
    const db = openDb(path, { migrate: true });
    try {
      expect(db.$client.query("select id, model, conversation_model, backend_session_id, entered_at, context_tokens from chats order by id").all()).toEqual([
        { id: 1, model: "claude/sonnet", conversation_model: "claude/sonnet", backend_session_id: "S1", entered_at: "uuid-entered-1", context_tokens: 5000 },
        { id: 2, model: null, conversation_model: "claude/opus", backend_session_id: "L2", entered_at: null, context_tokens: null },
        { id: 3, model: "vllm/qwen", conversation_model: "vllm/qwen", backend_session_id: null, entered_at: null, context_tokens: null },
        { id: 4, model: "vllm/qwen", conversation_model: "vllm/qwen", backend_session_id: "Q4", entered_at: "3:7", context_tokens: 100 },
        { id: 5, model: "vllm/qwen", conversation_model: "work/opus", backend_session_id: "W5", entered_at: null, context_tokens: null },
        { id: 6, model: null, conversation_model: null, backend_session_id: null, entered_at: null, context_tokens: null },
      ]);
      // Q1 was last used on llama (the native switch), and left from there.
      expect(db.$client.query("select chat_id, model, backend_session_id, context_tokens, parked_at from chat_conversations order by chat_id").all()).toEqual([
        { chat_id: 1, model: "vllm/llama", backend_session_id: "Q1", context_tokens: 900, parked_at: "2026-11-10T00:00:00.000Z" },
      ]);
      expect(db.$client.query("select name from sqlite_master where name in ('chat_lanes', '__conversation_models')").all()).toEqual([]);
      const columns = (db.$client.query("pragma table_info(chats)").all() as { name: string }[]).map((c) => c.name);
      expect(columns).not.toContain("lane");
      expect(columns).not.toContain("lane_entered_at");
      // Old rows keep their modes, `native` included.
      expect(db.$client.query("select mode from model_switches order by id").all()).toEqual([{ mode: "lossless" }, { mode: "native" }, { mode: "lossy" }]);
      expect(db.$client.query("pragma foreign_key_check").all()).toEqual([]);
    } finally {
      db.$client.close();
    }
  }
});

test("the rules' order, two lanes onto one model, the active one's model, several endpoints, and a chat left with none", () => {
  const { path, db: old } = storeAt(12);
  catalog(old);
  const q = old.$client;
  // A second OpenAI-compatible provider, added later, whose model row is older than vllm's.
  q.run("insert into model_providers (id, name, kind, base_url) values (4, 'groq', 'openai-compat', 'http://127.0.0.1:9000/v1')");
  q.run("update models set id = id + 10");
  q.run("insert into models (id, provider_id, model, context_window) values (1, 4, 'mixtral', 32000)");
  const chat = q.query("insert into chats (id, tg_chat_id, kind, model, lane, backend_session_id) values (?, ?, 'private', ?, ?, ?)");
  const lane = q.query("insert into chat_lanes (chat_id, lane, backend_session_id, parked_at) values (?, ?, ?, ?)");
  const sw = q.query("insert into model_switches (chat_id, from_model, to_model, mode, from_session_id, to_session_id) values (?, ?, ?, ?, ?, ?)");
  const at = (d: number) => `2026-11-0${d}T00:00:00.000Z`;

  // A (S1): follows the default; its session was entered by an implicit move onto sonnet, then the default
  // moved to opus within the lane (no row). The active one goes by the default, not by the row.
  chat.run(1, 1001, null, "claude:claude", "S-A");
  sw.run(1, null, "claude/sonnet", "lossy", null, "S-A");
  // B: a parked conversation by rule 2 (the chat's own model is in its lane); the active one by rule 3.
  chat.run(2, 1002, "vllm/llama", "claude:claude", "S-B");
  lane.run(2, "openai-compat", "P-B", at(1));
  // C: on the second login; a parked endpoint conversation by rule 4, with two endpoints: vllm's first model
  // (the provider added first), not groq's older model row.
  chat.run(3, 1003, "work/opus", "claude:work", "S-C");
  lane.run(3, "openai-compat", "P-C", at(1));
  // D: the active endpoint conversation by rule 4; a parked Claude one by rule 3 (the default).
  chat.run(4, 1004, null, "openai-compat", "Q-D");
  lane.run(4, "claude:claude", "P-D", at(1));
  // E: two parked conversations whose rows both say they were left from claude/opus: the later one is kept.
  chat.run(5, 1005, "vllm/qwen", "openai-compat", "Q-E");
  lane.run(5, "claude:claude", "E-OLD", at(1));
  lane.run(5, "claude:work", "E-NEW", at(5));
  sw.run(5, "claude/opus", "vllm/qwen", "lossy", "E-OLD", "Q-E");
  sw.run(5, "claude/opus", "vllm/qwen", "lossy", "E-NEW", "Q-E");
  // F: a parked conversation whose row names the active one's model: dropped (one per model).
  chat.run(6, 1006, "claude/opus", "claude:claude", "S-F");
  lane.run(6, "claude:work", "W-F", at(1));
  sw.run(6, "claude/opus", "claude/opus", "lossy", "W-F", "S-F");
  sw.run(6, "claude/sonnet", "claude/opus", "lossless", "S-F", "W-F");
  // G (B1): the active conversation is in a removed login's lane (dropped); a parked one is the default's,
  // a real session of the first login.
  const login = mkdtempSync(join(tmpdir(), "shuvi-model-migration-login-"));
  dirs.push(login);
  const sG = appendToClaudeSession(null, [{ role: "user", content: "G-PROMPT" }], { configDir: login, cwd: "/srv" }).sessionId;
  q.run("update model_providers set config_dir = ? where name = 'claude'", [login]);
  chat.run(7, 1007, null, "claude:gone", "X-G");
  lane.run(7, "claude:claude", sG, at(1));
  old.$client.close();

  const db = openDb(path, { migrate: true });
  try {
    expect(db.$client.query("select id, conversation_model as m, backend_session_id as s from chats order by id").all()).toEqual([
      { id: 1, m: "claude/opus", s: "S-A" },
      { id: 2, m: "claude/opus", s: "S-B" },
      { id: 3, m: "work/opus", s: "S-C" },
      { id: 4, m: "vllm/qwen", s: "Q-D" },
      { id: 5, m: "vllm/qwen", s: "Q-E" },
      { id: 6, m: "claude/opus", s: "S-F" },
      { id: 7, m: null, s: null },
    ]);
    expect(db.$client.query("select chat_id as c, model as m, backend_session_id as s from chat_conversations order by chat_id, model").all()).toEqual([
      { c: 2, m: "vllm/llama", s: "P-B" },
      { c: 3, m: "vllm/qwen", s: "P-C" },
      { c: 4, m: "claude/opus", s: "P-D" },
      { c: 5, m: "claude/opus", s: "E-NEW" },
      { c: 7, m: "claude/opus", s: sG },
    ]);
    // G's next turn takes up its model's parked conversation instead of starting fresh beside it.
    expect(enterChatModel(db, getChat(db, 7)!).id).toBe("claude/opus");
    expect(db.$client.query("select conversation_model as m, backend_session_id as s from chats where id = 7").get()).toEqual({ m: "claude/opus", s: sG });
    expect(db.$client.query("select count(*) as n from chat_conversations where chat_id = 7").get()).toEqual({ n: 0 });
    // A's next turn stays on its live conversation.
    enterChatModel(db, getChat(db, 1)!);
    expect(db.$client.query("select conversation_model as m, backend_session_id as s from chats where id = 1").get()).toEqual({ m: "claude/opus", s: "S-A" });
  } finally {
    db.$client.close();
  }
});

test("a store from before the catalog keeps its conversation, for the first turn to attribute", () => {
  const { path, db: old } = storeAt(11);
  old.$client.run("insert into chats (id, tg_chat_id, kind, backend_session_id) values (1, 1001, 'private', 'claude-session')");
  old.$client.close();
  const db = openDb(path, { migrate: true });
  try {
    expect(db.$client.query("select conversation_model, backend_session_id from chats").get()).toEqual({ conversation_model: null, backend_session_id: "claude-session" });
  } finally {
    db.$client.close();
  }
});
