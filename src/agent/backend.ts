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

export function openAICompatBackend(db: Db, config: Config, chatId: number, boundary: ToolBoundary) {
  const settings = config.openAICompat;
  const model = config.model;
  if (config.backend !== "openai-compat" || !settings || !model) throw new Error("OpenAI-compatible backend is not configured");
  const prefix = openAIConversationPrefix(config, chatId);
  return new OpenAICompatBackend({
    provider: { name: "openai-compat", baseURL: settings.baseURL, ...(settings.apiKey ? { apiKey: settings.apiKey } : {}) },
    defaultModel: model,
    boundary,
    store: conversationStore(db),
    vision: settings.vision,
    compaction: { contextWindow: settings.contextWindow },
    newId: () => `${prefix}${randomUUID()}`,
  });
}
