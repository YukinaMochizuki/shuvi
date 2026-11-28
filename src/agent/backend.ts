import type { ClaudeBackend } from "agent-runtime/claude";
import type { OpenAICompatBackend } from "agent-runtime/openai-compat";
import type { BackendAdapter, ToolBoundary } from "agent-runtime";
import { allProfiles, type SecretSource } from "../secrets/source.ts";
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
 * EFFORT is not the driver's to decide: the turn's input carries it (`AdapterRunInput.effort`, agent/turn.ts), as
 * store/models.ts `resolveEffort` gave it at the turn's start: the chat's override, else the model's default, else
 * none (absent: the model's own default, as before effort existed). The Claude driver passes it to `query()` on a
 * cold turn; on a warm runner's resident CLI (runner/warm-session.ts) agent-runtime applies it with `setEffort`
 * before the turn, without reopening the CLI, and it is not part of the warm fingerprint. The CLI sends it as
 * `output_config.effort`. An OpenAI-compatible model is given none (resolution never yields one for it).
 *
 * A conversation id names a conversation, not the model it runs on: a switch within a lane keeps it
 * (agent/switch.ts). Only a missing history is a lost session; provider failures keep the conversation.
 * Compaction failures become fixed transcript notes, never a provider's raw error or the rejected history.
 *
 * Each driver's module (and its SDK: the Claude Agent SDK, or `ai` and its providers) is loaded only for a
 * turn on that kind of provider: `loadDriver` before `makeDriver`, which builds synchronously from what was
 * loaded. A runner child runs one turn on one model, so it never loads the other driver.
 */

export interface DriverOptions {
  db: Db;
  chatId: number;
  model: CatalogModel;
  boundary: ToolBoundary;
  /** A line for the turn's transcript. */
  note: (text: string) => void;
  /** Where the provider's key is read from (env.ts `secrets`: the secrets file, and the console's profiles). */
  secrets: SecretSource;
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

const drivers: { claude?: typeof ClaudeBackend; "openai-compat"?: typeof OpenAICompatBackend } = {};

/** Load the driver module for `kind` (a no-op once loaded, and for a kind no driver serves: `makeDriver` refuses it). */
export async function loadDriver(kind: string): Promise<void> {
  if (kind === "claude") drivers.claude ??= (await import("agent-runtime/claude")).ClaudeBackend;
  else if (kind === "openai-compat") drivers["openai-compat"] ??= (await import("agent-runtime/openai-compat")).OpenAICompatBackend;
}

function loaded<K extends keyof typeof drivers>(kind: K): NonNullable<(typeof drivers)[K]> {
  const d = drivers[kind];
  if (!d) throw new Error(`the ${kind} driver was not loaded (loadDriver)`);
  return d as NonNullable<(typeof drivers)[K]>;
}

/** The turn's driver. Its kind's module must have been loaded first (`loadDriver`). */
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
  const ClaudeBackend = loaded("claude");
  return new ClaudeBackend({ boundary: o.boundary, liveSystemPrompt: true, ...(provider.configDir ? { configDir: provider.configDir } : {}) });
}

function openAICompatDriver(o: DriverOptions): BackendAdapter {
  const { provider, model } = o.model;
  if (!provider.baseUrl) throw new Error(`the provider "${provider.name}" has no base URL`);
  const apiKey = provider.apiKey ? providerKey(o.db, provider.apiKey, o.secrets) : undefined;
  const OpenAICompatBackend = loaded("openai-compat");
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

/**
 * The key `<profile>.<VAR>` names among the secret profiles (the file's or the console's). Throws, naming only the
 * reference, when it is not there.
 * Also what the server's probes and `/models` listings send (server/probes.ts).
 */
export function providerKey(db: Db, ref: string, src: SecretSource): string {
  const dot = ref.indexOf(".");
  const loaded = allProfiles(db, src);
  if ("error" in loaded) throw new Error(`the key ${ref} cannot be read: ${loaded.error}`);
  const value = loaded.profiles[ref.slice(0, dot)]?.[ref.slice(dot + 1)];
  if (!value) throw new Error(`the key ${ref} is not among the secret profiles (the file ${src.file}, or the console's)`);
  return value;
}
