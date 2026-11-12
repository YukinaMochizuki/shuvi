/**
 * Backend session identity and the OpenAI-compatible driver factory. OpenAI-compatible ids are scoped
 * to endpoint, model and chat; API key rotation keeps the same scope. Unprefixed legacy ids belong to
 * Claude. runTurn checks this scope before resuming and records a changed opening when it differs.
 *
 * History lives in store/conversations.ts. Only a missing row is a lost session; provider failures keep
 * the conversation. Constructor compaction failures become static transcript notes, never raw provider
 * errors or rejected history. Successful compactions use the runtime's run-level callback once.
 */
import { createHash, randomUUID } from "node:crypto";
import { OpenAICompatBackend } from "agent-runtime/openai-compat";
import type { ToolBoundary } from "agent-runtime";
import type { Config } from "../env.ts";
import type { Db } from "../store/db.ts";
import { conversationStore } from "../store/conversations.ts";

function identity(baseURL: string, model: string): string {
  return createHash("sha256").update(`${baseURL}\n${model}`).digest("hex").slice(0, 16);
}

/** Conversation ids carry the backend settings and chat that own their persisted history. */
export function openAIConversationPrefix(config: Config, chatId: number): string {
  if (config.backend !== "openai-compat" || !config.openAICompat || !config.model) throw new Error("OpenAI-compatible backend is not configured");
  return `openai-compat:${identity(config.openAICompat.baseURL, config.model)}:${chatId}:`;
}

/** Whether a saved id belongs to the backend this runner is about to use. */
export function conversationMatchesBackend(sessionId: string, config: Config, chatId: number): boolean {
  if (config.backend === "claude") return !sessionId.startsWith("openai-compat:");
  return sessionId.startsWith(openAIConversationPrefix(config, chatId));
}

export function openAICompatBackend(db: Db, config: Config, chatId: number, boundary: ToolBoundary, note: (text: string) => void = () => {}) {
  const settings = config.openAICompat;
  const model = config.model;
  if (config.backend !== "openai-compat" || !settings || !model) throw new Error("OpenAI-compatible backend is not configured");
  const prefix = openAIConversationPrefix(config, chatId);
  return new OpenAICompatBackend({
    provider: { name: "openai-compat", baseURL: settings.baseURL, ...(settings.apiKey ? { apiKey: settings.apiKey } : {}) },
    defaultModel: model,
    boundary,
    store: conversationStore(db, chatId),
    vision: settings.vision,
    compaction: { contextWindow: settings.contextWindow },
    onCompaction: (report) => {
      if (report.summaryError !== undefined) note("OpenAI-compatible compaction could not summarize the conversation; the runtime kept or pruned its history.");
      if (report.rejected !== undefined) note("OpenAI-compatible compaction rejected the replacement history; the conversation was kept unchanged.");
    },
    newId: () => `${prefix}${randomUUID()}`,
  });
}
