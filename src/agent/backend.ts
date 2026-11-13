import { ClaudeBackend } from "agent-runtime/claude";
import { OpenAICompatBackend } from "agent-runtime/openai-compat";
import type { BackendAdapter, ToolBoundary } from "agent-runtime";
import { loadProfiles } from "../secrets/redaction.ts";
import { conversationStore } from "../store/conversations.ts";
import type { Db } from "../store/db.ts";
import { CLI_DEFAULT_MODEL, unknownKind, type CatalogModel } from "../store/models.ts";

/**
 * The driver a turn runs on, built from the chat's model in the catalog (store/models.ts) when the turn
 * starts, so a change to the catalog applies from the next turn.
 *
 *   claude         agent-runtime's Claude driver on the provider's login (`config_dir`), its system prompt
 *                  live on every turn (`liveSystemPrompt`: an edit to home/ is heard on a resume).
 *   openai-compat  agent-runtime's OpenAI-compatible driver on the provider's endpoint, its history in our
 *                  store (store/conversations.ts), its key read from the secrets file (`<profile>.<VAR>`)
 *                  only here; every value of that file is redacted from transcripts already.
 *
 * A conversation id names a conversation, not the model it runs on: a switch within a lane keeps it
 * (agent/switch.ts). Only a missing history is a lost session; provider failures keep the conversation.
 * Compaction failures become fixed transcript notes, never a provider's raw error or the rejected history.
 */

export interface DriverOptions {
  db: Db;
  chatId: number;
  model: CatalogModel;
  boundary: ToolBoundary;
  /** A line for the turn's transcript. */
  note: (text: string) => void;
  /** The secrets file the provider's key is read from (env.ts `SHUVI_SECRETS_FILE`). */
  secretsFile: string;
}

/** The model id the driver is given for the turn: the provider's own, or none for the CLI's default. */
export function driverModel(m: CatalogModel): string | undefined {
  switch (m.provider.kind) {
    case "claude":
      return m.model.model === CLI_DEFAULT_MODEL ? undefined : m.model.model;
    case "openai-compat":
      return m.model.model;
    default:
      return unknownKind(m.provider.kind);
  }
}

export function makeDriver(o: DriverOptions): BackendAdapter {
  switch (o.model.provider.kind) {
    case "claude":
      return claudeDriver(o);
    case "openai-compat":
      return openAICompatDriver(o);
    default:
      return unknownKind(o.model.provider.kind);
  }
}

function claudeDriver(o: DriverOptions): BackendAdapter {
  const { provider } = o.model;
  return new ClaudeBackend({ boundary: o.boundary, liveSystemPrompt: true, ...(provider.configDir ? { configDir: provider.configDir } : {}) });
}

function openAICompatDriver(o: DriverOptions): BackendAdapter {
  const { provider, model } = o.model;
  if (!provider.baseUrl) throw new Error(`the provider "${provider.name}" has no base URL`);
  const apiKey = provider.apiKey ? providerKey(provider.apiKey, o.secretsFile) : undefined;
  return new OpenAICompatBackend({
    provider: { name: provider.name, baseURL: provider.baseUrl, ...(apiKey ? { apiKey } : {}) },
    defaultModel: model.model,
    boundary: o.boundary,
    store: conversationStore(o.db, o.chatId),
    vision: model.vision,
    ...(model.contextWindow ? { compaction: { contextWindow: model.contextWindow } } : {}),
    onCompaction: (report) => {
      if (report.summaryError !== undefined) o.note("OpenAI-compatible compaction could not summarize the conversation; the runtime kept or pruned its history.");
      if (report.rejected !== undefined) o.note("OpenAI-compatible compaction rejected the replacement history; the conversation was kept unchanged.");
    },
  });
}

/** The key `<profile>.<VAR>` names in the secrets file. Throws, naming only the reference, when it is not there. */
function providerKey(ref: string, file: string): string {
  const dot = ref.indexOf(".");
  const loaded = loadProfiles(file);
  if ("error" in loaded) throw new Error(`the key ${ref} cannot be read: ${loaded.error}`);
  const value = loaded.profiles[ref.slice(0, dot)]?.[ref.slice(dot + 1)];
  if (!value) throw new Error(`the key ${ref} is not in the secrets file ${file}`);
  return value;
}
