import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "./db.ts";
import { type Chat } from "./events.ts";
import { chats, modelProviders, models } from "./schema.ts";
import { IMMEDIATE } from "./turns.ts";

/**
 * The model catalog: where models run (`model_providers`) and which of their models a chat may run on
 * (`models`). Read at turn time by the runner child, so a provider or model added or changed applies from
 * the next turn, with no restart. Who edits it, and how, is the owner's surface (not this module's).
 *
 *   MODEL IDS   `<provider>/<model>`: the provider's `name` (which therefore never changes), then the
 *               provider's own id for the model, which may itself hold slashes (`openrouter/qwen/qwen3`).
 *   KINDS       `claude`: a Claude login (`config_dir`; null = the login of the user the server runs as),
 *               its models the CLI's (`opus`, `claude-sonnet-4-5`, `default` for the CLI's own default).
 *               `openai-compat`: an endpoint (`base_url`) whose models need a `context_window` (compaction
 *               is measured against it) and say whether they take images (`vision`).
 *   KEYS        never stored: `api_key` names one in the secrets file, `<profile>.<VARIABLE>`, which the turn
 *               reads when it builds the request (agent/backend.ts), and which redaction already hides.
 *   DEFAULT     at most one model (a partial unique index); chats without `chats.model` run on it.
 *   CONVERSATIONS  a chat has one per model (agent/switch.ts), whatever its provider.
 *   LANES       only where a model's conversations are STORED, and so which converter carries them: each
 *               Claude login its own (`claude:<provider>`, its sessions are files in that login's config
 *               dir), every OpenAI-compatible provider the same tables (`openai-compat`: the history is ours,
 *               and provider-neutral). Two models of one lane still have two conversations.
 *
 * A first start with an empty catalog seeds it with what turns ran on before there was one (`seedModels`):
 * a `claude` provider on `SHUVI_CLAUDE_CONFIG_DIR`, with `SHUVI_MODEL` (or the CLI's default) as the default.
 *
 *   REMOVING    a model, or a provider with all its models (ON DELETE CASCADE). The default cannot go until
 *               another model is the default. Chats whose `chats.model` it was fail their next turn, saying
 *               so (`chatModel`), until they get another model; their callers name them first (`chatsOn`).
 *   PROBES      an OpenAI-compatible model's last probe is on its row (schema.ts `models`); `markProbing`
 *               asks for one, which the server runs (server/probes.ts) and records (`recordProbe`).
 */

export type Provider = typeof modelProviders.$inferSelect;
export type Model = typeof models.$inferSelect;
export type ProviderKind = Provider["kind"];

/**
 * The `default` of every `switch` on a provider's kind: a kind added to the schema and not handled there fails
 * to compile, and a row holding one this code does not know fails loudly instead of running as another kind.
 */
export function unknownKind(kind: never): never {
  throw new Error(`unknown provider kind "${String(kind)}"`);
}

/** A model as a turn needs it: its id, its row and its provider's. */
export interface CatalogModel {
  id: string;
  model: Model;
  provider: Provider;
}

/** The model id a Claude provider's CLI default is listed under. */
export const CLI_DEFAULT_MODEL = "default";

export const OPENAI_COMPAT_LANE = "openai-compat";

/** The provider a first start seeds (`seedModels`): the Claude login conversations from before the catalog are in. */
export const SEEDED_PROVIDER = "claude";

export function modelId(provider: Pick<Provider, "name">, model: Pick<Model, "model">): string {
  return `${provider.name}/${model.model}`;
}

/** A lane read back: where its conversations are stored (the inverse of `laneOf`). */
export type Lane = { kind: "claude"; provider: string } | { kind: "openai-compat" };

/** What lane `lane` (as `laneOf` wrote it) is. Throws on one this code does not know, never guessing a kind. */
export function parseLane(lane: string): Lane {
  if (lane === OPENAI_COMPAT_LANE) return { kind: "openai-compat" };
  if (lane.startsWith("claude:") && lane.length > "claude:".length) return { kind: "claude", provider: lane.slice("claude:".length) };
  throw new Error(`unknown lane "${lane}"`);
}

/** The `default` of every `switch` on a parsed lane's kind (see `unknownKind`). */
export function unknownLane(lane: never): never {
  throw new Error(`unknown lane kind "${String((lane as { kind?: unknown }).kind)}"`);
}

/** The lane a provider's models keep their conversations in. */
export function laneOf(provider: Pick<Provider, "kind" | "name">): string {
  switch (provider.kind) {
    case "claude":
      return `claude:${provider.name}`;
    case "openai-compat":
      return OPENAI_COMPAT_LANE;
    default:
      return unknownKind(provider.kind);
  }
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const KEY_REF = /^[^.\s]+\.[A-Za-z_][A-Za-z0-9_]*$/;

/** An OpenAI-compatible base URL as requests use it: http(s), no credentials, query or fragment, no trailing slash. */
export function checkBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`"${raw}" is not a URL (e.g. https://api.example.com/v1)`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("the base URL must be http(s)");
  if (url.username || url.password || url.search || url.hash) throw new Error("the base URL must hold no credentials, query or fragment; a key goes in the secrets file");
  return url.toString().replace(/\/+$/, "");
}

export function addProvider(db: Db, p: { name: string; kind: ProviderKind; configDir?: string | null; baseUrl?: string | null; apiKey?: string | null }): Provider {
  if (!NAME.test(p.name)) throw new Error(`"${p.name}" is not a provider name: lower-case letters, digits, '.', '_' and '-', at most 40`);
  if (getProvider(db, p.name)) throw new Error(`there is already a provider named "${p.name}"`);
  if (p.apiKey && !KEY_REF.test(p.apiKey)) throw new Error(`the key is named as <secrets profile>.<VARIABLE>, not "${p.apiKey}"`);
  return db.insert(modelProviders).values(providerRow(p)).returning().get();
}

function providerRow(p: { name: string; kind: ProviderKind; configDir?: string | null; baseUrl?: string | null; apiKey?: string | null }) {
  switch (p.kind) {
    case "claude":
      return { name: p.name, kind: p.kind, configDir: p.configDir ?? null };
    case "openai-compat":
      if (!p.baseUrl) throw new Error("an OpenAI-compatible provider needs its base URL");
      return { name: p.name, kind: p.kind, baseUrl: checkBaseUrl(p.baseUrl), apiKey: p.apiKey ?? null };
    default:
      return unknownKind(p.kind);
  }
}

export function getProvider(db: Pick<Db, "select">, name: string): Provider | undefined {
  return db.select().from(modelProviders).where(eq(modelProviders.name, name)).get();
}

export function listProviders(db: Db): Provider[] {
  return db.select().from(modelProviders).orderBy(asc(modelProviders.id)).all();
}

/** Add a model of `provider` (its name). The first model of an empty catalog is its default. */
export function addModel(db: Db, m: { provider: string; model: string; label?: string; contextWindow?: number; vision?: boolean; isDefault?: boolean }): CatalogModel {
  const provider = getProvider(db, m.provider);
  if (!provider) throw new Error(`there is no provider named "${m.provider}"`);
  const model = m.model.trim();
  if (!model || /\s/.test(model)) throw new Error(`"${m.model}" is not a model id`);
  switch (provider.kind) {
    case "claude":
      break;
    case "openai-compat":
      if (!(Number.isSafeInteger(m.contextWindow) && m.contextWindow! > 0)) {
        throw new Error("an OpenAI-compatible model needs its context window, in tokens: compaction is measured against it");
      }
      break;
    default:
      unknownKind(provider.kind);
  }
  return db.transaction((tx) => {
    const first = !tx.select({ id: models.id }).from(models).limit(1).get();
    const isDefault = m.isDefault ?? first;
    if (isDefault) tx.update(models).set({ isDefault: false }).where(eq(models.isDefault, true)).run();
    const row = tx
      .insert(models)
      .values({ providerId: provider.id, model, label: m.label ?? null, contextWindow: m.contextWindow ?? null, vision: m.vision ?? false, isDefault })
      .returning()
      .get();
    return { id: modelId(provider, row), model: row, provider };
  }, IMMEDIATE);
}

/** Every model, its provider's first, in the order they were added. */
export function listModels(db: Db): CatalogModel[] {
  return db
    .select()
    .from(models)
    .innerJoin(modelProviders, eq(models.providerId, modelProviders.id))
    .orderBy(asc(modelProviders.id), asc(models.id))
    .all()
    .map((r) => ({ id: modelId(r.model_providers, r.models), model: r.models, provider: r.model_providers }));
}

/** The model `id` names (`<provider>/<model>`), or undefined when the catalog has none by that id. */
export function findModel(db: Db, id: string): CatalogModel | undefined {
  const slash = id.indexOf("/");
  if (slash <= 0) return undefined;
  const r = db
    .select()
    .from(models)
    .innerJoin(modelProviders, eq(models.providerId, modelProviders.id))
    .where(and(eq(modelProviders.name, id.slice(0, slash)), eq(models.model, id.slice(slash + 1))))
    .get();
  return r ? { id, model: r.models, provider: r.model_providers } : undefined;
}

export function defaultModel(db: Db): CatalogModel | undefined {
  const r = db.select().from(models).innerJoin(modelProviders, eq(models.providerId, modelProviders.id)).where(eq(models.isDefault, true)).get();
  return r ? { id: modelId(r.model_providers, r.models), model: r.models, provider: r.model_providers } : undefined;
}

export function setDefaultModel(db: Db, id: string): void {
  const m = findModel(db, id);
  if (!m) throw new Error(`there is no model "${id}"`);
  db.transaction((tx) => {
    tx.update(models).set({ isDefault: false }).where(eq(models.isDefault, true)).run();
    tx.update(models).set({ isDefault: true }).where(eq(models.id, m.model.id)).run();
  }, IMMEDIATE);
}

/**
 * The model a chat runs on: its own, else the default. Throws, saying what to do, when that model is not
 * in the catalog (removed since it was chosen) or the catalog has no default.
 */
export function chatModel(db: Db, chat: Pick<Chat, "model">): CatalogModel {
  if (chat.model) {
    const m = findModel(db, chat.model);
    if (!m) throw new Error(`this chat runs on "${chat.model}", which is no longer in the model catalog: pick another model for it`);
    return m;
  }
  const d = defaultModel(db);
  if (!d) throw new Error("the model catalog has no default model: add one, or pick a model for this chat");
  return d;
}

/** The model whose row id is `rowId`. */
export function modelByRowId(db: Pick<Db, "select">, rowId: number): CatalogModel | undefined {
  const r = db.select().from(models).innerJoin(modelProviders, eq(models.providerId, modelProviders.id)).where(eq(models.id, rowId)).get();
  return r ? { id: modelId(r.model_providers, r.models), model: r.models, provider: r.model_providers } : undefined;
}

/** The models of provider `name`, in the order they were added. */
export function providerModels(db: Db, name: string): CatalogModel[] {
  return listModels(db).filter((m) => m.provider.name === name);
}

/** The chats whose own model (`chats.model`) is one of `ids`: their next turn fails once it is removed. */
export function chatsOn(db: Pick<Db, "select">, ids: readonly string[]): Chat[] {
  return ids.length ? db.select().from(chats).where(inArray(chats.model, [...ids])).orderBy(asc(chats.id)).all() : [];
}

/** Remove model `id`. Refused for the default: another model is made the default first. */
export function removeModel(db: Db, id: string): CatalogModel {
  const m = findModel(db, id);
  if (!m) throw new Error(`there is no model "${id}"`);
  if (m.model.isDefault) throw new Error(`${id} is the default model: make another model the default first`);
  db.delete(models).where(eq(models.id, m.model.id)).run();
  return m;
}

/** Remove provider `name` and its models. Refused while one of them is the default. Returns the models removed. */
export function removeProvider(db: Db, name: string): CatalogModel[] {
  if (!getProvider(db, name)) throw new Error(`there is no provider named "${name}"`);
  const its = providerModels(db, name);
  const def = its.find((m) => m.model.isDefault);
  if (def) throw new Error(`${def.id} is the default model: make a model of another provider the default first`);
  db.delete(modelProviders).where(eq(modelProviders.name, name)).run();
  return its;
}

/** Set whether model `id` takes images, as the owner says: from now on a probe no longer changes it. */
export function setModelVision(db: Db, id: string, vision: boolean): void {
  const m = findModel(db, id);
  if (!m) throw new Error(`there is no model "${id}"`);
  db.update(models).set({ vision, visionSet: true }).where(eq(models.id, m.model.id)).run();
}

/**
 * Ask for a probe of model `rowId` (server/probes.ts runs it). Only an OpenAI-compatible model is probed: false
 * for any other (nothing to probe: a Claude login's models are the CLI's).
 */
export function markProbing(db: Pick<Db, "select" | "update">, rowId: number): boolean {
  const m = modelByRowId(db, rowId);
  if (!m) return false;
  switch (m.provider.kind) {
    case "claude":
      return false;
    case "openai-compat":
      db.update(models).set({ probeStatus: "checking" }).where(eq(models.id, rowId)).run();
      return true;
    default:
      return unknownKind(m.provider.kind);
  }
}

/** The models a probe was asked for (`checking`), a restart's interrupted ones included. */
export function modelsToProbe(db: Db): CatalogModel[] {
  return listModels(db).filter((m) => m.model.probeStatus === "checking");
}

export interface ProbeRecord {
  status: "ok" | "text-instead" | "failed";
  error: string | null;
  latencyMs: number;
  /** Whether a picture was accepted; null: the probe learned nothing about it. */
  vision: boolean | null;
}

/**
 * Record a finished probe of model `rowId`. Vision follows what it learned, unless the owner set it
 * (`vision_set`); a probe that learned nothing about pictures keeps what the last one did.
 */
export function recordProbe(db: Db, rowId: number, r: ProbeRecord, now = Date.now()): void {
  const row = db.select().from(models).where(eq(models.id, rowId)).get();
  if (!row) return; // removed while it ran
  const probeVision = r.vision ?? row.probeVision;
  db.update(models)
    .set({
      probeStatus: r.status,
      probeError: r.error,
      probeLatencyMs: r.latencyMs,
      probedAt: new Date(now).toISOString(),
      probeVision,
      ...(row.visionSet || probeVision === null ? {} : { vision: probeVision }),
    })
    .where(eq(models.id, rowId))
    .run();
}

/** On a first start with an empty catalog: what turns ran on before there was one. Idempotent. */
export function seedModels(db: Db, env: { claudeConfigDir?: string; model?: string }): void {
  if (listProviders(db).length) return;
  db.transaction((tx) => {
    const provider = tx.insert(modelProviders).values({ name: SEEDED_PROVIDER, kind: "claude", configDir: env.claudeConfigDir ?? null }).returning().get();
    tx.insert(models).values({ providerId: provider.id, model: env.model ?? CLI_DEFAULT_MODEL, isDefault: true }).run();
  }, IMMEDIATE);
}
