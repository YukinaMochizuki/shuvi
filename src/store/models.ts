import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { EffortLevel } from "agent-runtime";
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
 *
 * EFFORT (how much a Claude turn reasons; agent-runtime's levels `low medium high xhigh max`, EFFORT_LEVELS):
 *
 *   LEVELS      what a Claude model supports is what Claude Code's listing reports (`effort_levels`), recorded when
 *               the login's models are listed or added from a listing (`recordEffortLevels`), and filled in the
 *               background for a model that has none (server/probes.ts `fillEffortLevels`). Null = NOT RECORDED, and
 *               then nothing is offered or sent: a level is never guessed. An OpenAI-compatible model takes none.
 *   TWO LAYERS  a model's default (`models.effort`, `setModelEffort`) and a chat's override (`chats.effort`,
 *               `setChatEffort`); each setter refuses a level the model is not known to support.
 *   RESOLUTION  `resolveEffort`, the one rule, at each turn's start (runner/run.ts): the chat's override, else its
 *               model's default, else none, which sends nothing: the model's own default, exactly as before effort
 *               existed. A value the model is known not to support is skipped with a transcript note (and the next
 *               layer tried); with the levels not recorded, nothing is sent, with a note. The turn records the level
 *               and where it came from (`turns.effort`, `turns.effort_source`).
 *   A SWITCH    keeps a chat's override only if the new model supports it (agent/switch.ts `keepEffortAcross`).
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

/** agent-runtime's effort levels, low → high (its src/effort.ts; kept here so the store loads none of it). */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly EffortLevel[];
// Both ways: a level added to agent-runtime and not here fails to compile.
type _AllLevels = EffortLevel extends (typeof EFFORT_LEVELS)[number] ? true : never;
const _allLevels: _AllLevels = true;
void _allLevels;

export const isEffortLevel = (s: unknown): s is EffortLevel => typeof s === "string" && (EFFORT_LEVELS as readonly string[]).includes(s);

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
  // Never quote what was given: it may be the key itself, pasted where its name goes.
  if (p.apiKey && !KEY_REF.test(p.apiKey)) throw new Error("the key is named as <secrets profile>.<VARIABLE>, not given itself");
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

/**
 * An OpenAI-compatible model needs its context window (a positive number of tokens); a Claude one takes the
 * CLI's, and giving one is refused.
 */
function checkContextWindow(provider: Provider, contextWindow: number | undefined): void {
  switch (provider.kind) {
    case "claude":
      if (contextWindow !== undefined) throw new Error("a Claude model's context window is the CLI's");
      return;
    case "openai-compat":
      if (!(Number.isSafeInteger(contextWindow) && contextWindow! > 0)) {
        throw new Error("an OpenAI-compatible model needs its context window, in tokens: compaction is measured against it");
      }
      return;
    default:
      unknownKind(provider.kind);
  }
}

export const LABEL_MAX = 60;

/** A label as stored: trimmed, null when empty; one line, at most LABEL_MAX characters. */
function checkLabel(label: string | null | undefined): string | null {
  const l = label?.trim() ?? "";
  if (/[\r\n]/.test(l)) throw new Error("a label is one line");
  if (l.length > LABEL_MAX) throw new Error(`a label is at most ${LABEL_MAX} characters`);
  return l || null;
}

/**
 * Add a model of `provider` (its name). The first model of an empty catalog is its default. `effortLevels`: what a
 * Claude login's listing reported for it (kept only for a Claude model).
 */
export function addModel(db: Db, m: { provider: string; model: string; label?: string; contextWindow?: number; vision?: boolean; isDefault?: boolean; effortLevels?: readonly string[] }): CatalogModel {
  const provider = getProvider(db, m.provider);
  if (!provider) throw new Error(`there is no provider named "${m.provider}"`);
  const model = m.model.trim();
  if (!model || /\s/.test(model)) throw new Error(`"${m.model}" is not a model id`);
  checkContextWindow(provider, m.contextWindow);
  return db.transaction((tx) => {
    const first = !tx.select({ id: models.id }).from(models).limit(1).get();
    const isDefault = m.isDefault ?? first;
    if (isDefault) tx.update(models).set({ isDefault: false }).where(eq(models.isDefault, true)).run();
    const row = tx
      .insert(models)
      .values({
        providerId: provider.id,
        model,
        label: checkLabel(m.label),
        contextWindow: m.contextWindow ?? null,
        vision: m.vision ?? false,
        isDefault,
        effortLevels: provider.kind === "claude" && m.effortLevels ? orderedLevels(m.effortLevels) : null,
      })
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

/** Let model `id`'s vision follow its probes again (what the last one learned, if anything): the owner's setting is dropped. */
export function setModelVisionAuto(db: Db, id: string): void {
  const m = findModel(db, id);
  if (!m) throw new Error(`there is no model "${id}"`);
  db.update(models)
    .set({ visionSet: false, ...(m.model.probeVision === null ? {} : { vision: m.model.probeVision }) })
    .where(eq(models.id, m.model.id))
    .run();
}

/**
 * Change model `id`'s label (empty: none) and, for an OpenAI-compatible model, its context window (required,
 * as when it is added). A Claude model's context window is the CLI's: giving one is refused.
 */
export function editModel(db: Db, id: string, e: { label?: string | null; contextWindow?: number }): CatalogModel {
  const m = findModel(db, id);
  if (!m) throw new Error(`there is no model "${id}"`);
  checkContextWindow(m.provider, e.contextWindow);
  const label = checkLabel(e.label);
  db.update(models)
    .set({ label, ...(m.provider.kind === "openai-compat" ? { contextWindow: e.contextWindow! } : {}) })
    .where(eq(models.id, m.model.id))
    .run();
  return findModel(db, id)!;
}

/**
 * Ask for a probe of model `rowId` (server/probes.ts runs it). Only an OpenAI-compatible model is probed: false
 * for any other (nothing to probe: a Claude login's models are the CLI's). One already asked stays as it is.
 * The last probe's result is kept until the new one finishes, so a cancelled probe (`cancelProbe`) leaves it.
 */
export function markProbing(db: Pick<Db, "select" | "update">, rowId: number, now = Date.now()): boolean {
  const m = modelByRowId(db, rowId);
  if (!m) return false;
  switch (m.provider.kind) {
    case "claude":
      return false;
    case "openai-compat":
      if (!m.model.probeStartedAt) db.update(models).set({ probeStartedAt: new Date(now).toISOString() }).where(eq(models.id, rowId)).run();
      return true;
    default:
      return unknownKind(m.provider.kind);
  }
}

/** Whether a probe of this model is asked or running. */
export const probePending = (m: CatalogModel): boolean => m.model.probeStartedAt !== null;

/**
 * Take back the probe asked of model `rowId`: the row shows its last result again, and the server's next pass
 * aborts the request in flight (server/probes.ts). False when none was asked.
 */
export function cancelProbe(db: Pick<Db, "select" | "update">, rowId: number): boolean {
  const m = modelByRowId(db, rowId);
  if (!m || !probePending(m)) return false;
  db.update(models).set({ probeStartedAt: null }).where(eq(models.id, rowId)).run();
  return true;
}

/** The models a probe was asked for, a restart's interrupted ones included. */
export function modelsToProbe(db: Db): CatalogModel[] {
  return listModels(db).filter(probePending);
}

export interface ProbeRecord {
  status: "ok" | "text-instead" | "failed";
  error: string | null;
  /** Null: nothing was sent (a key that cannot be read). */
  latencyMs: number | null;
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
      probeStartedAt: null,
      probeError: r.error,
      probeLatencyMs: r.latencyMs,
      probedAt: new Date(now).toISOString(),
      probeVision,
      ...(row.visionSet || probeVision === null ? {} : { vision: probeVision }),
    })
    .where(eq(models.id, rowId))
    .run();
}

// ---- effort ------------------------------------------------------------------------------------------------

/** Levels as stored: the known ones, in EFFORT_LEVELS order. */
function orderedLevels(levels: readonly string[]): EffortLevel[] {
  return EFFORT_LEVELS.filter((l) => levels.includes(l));
}

/**
 * The effort levels model `m` supports: null when NOT KNOWN (a Claude model whose listing has not recorded them),
 * `[]` when it takes none (every OpenAI-compatible model, here: shuvi offers it no effort).
 */
export function effortLevelsOf(m: CatalogModel): EffortLevel[] | null {
  switch (m.provider.kind) {
    case "claude":
      return m.model.effortLevels ? orderedLevels(m.model.effortLevels) : null;
    case "openai-compat":
      return [];
    default:
      return unknownKind(m.provider.kind);
  }
}

/** Model `m`'s default effort, if one is set (null: the model's own). */
export const modelEffort = (m: CatalogModel): EffortLevel | null => (isEffortLevel(m.model.effort) ? m.model.effort : null);

/** Why `level` cannot be set on model `m`, or null when it can (null clears, and always can). */
function effortRefusal(m: CatalogModel, level: EffortLevel | null): string | null {
  if (level === null) return null;
  const levels = effortLevelsOf(m);
  if (m.provider.kind !== "claude") return `${m.id} is not on a Claude login: it takes no effort`;
  if (levels === null) return `the effort levels ${m.id} supports are not known yet: list its login's models again`;
  if (!levels.includes(level)) return levels.length ? `${m.id} does not support effort ${level} (it supports ${levels.join(", ")})` : `${m.id} takes no effort`;
  return null;
}

/** Set model `id`'s default effort (null: the model's own). Refused for a level it is not known to support. */
export function setModelEffort(db: Db, id: string, level: EffortLevel | null): CatalogModel {
  const m = findModel(db, id);
  if (!m) throw new Error(`there is no model "${id}"`);
  const why = effortRefusal(m, level);
  if (why) throw new Error(why);
  db.update(models).set({ effort: level }).where(eq(models.id, m.model.id)).run();
  return findModel(db, id)!;
}

/**
 * Set chat `chatId`'s effort override (null: its model's setting), from its next turn. Refused for a level the
 * chat's model (`chatModel`) is not known to support. The console's Effort picker and the control bot's `/effort`
 * both come here. A running turn keeps the effort it began with.
 */
export function setChatEffort(db: Db, chatId: number, level: EffortLevel | null): void {
  const chat = db.select().from(chats).where(eq(chats.id, chatId)).get();
  if (!chat) throw new Error(`there is no chat ${chatId}`);
  if (level !== null) {
    const why = effortRefusal(chatModel(db, chat), level);
    if (why) throw new Error(why);
  }
  db.update(chats).set({ effort: level }).where(eq(chats.id, chatId)).run();
}

export type EffortSource = "chat" | "model" | "none";

/** A turn's effort: the level sent (null: none, the model's own default), where it came from, and what was skipped. */
export interface ResolvedEffort {
  level: EffortLevel | null;
  source: EffortSource;
  /** Lines for the turn's transcript: a set value that was not sent, and why. */
  notes: string[];
}

/**
 * THE rule for a turn's effort (the header's RESOLUTION): the chat's override, else model `m`'s default, else none.
 * A layer whose value `m` is known not to support is skipped, with a note; with `m`'s levels not recorded, nothing
 * is sent, with a note; an OpenAI-compatible model takes none. Reads nothing but its arguments.
 */
export function resolveEffort(chat: Pick<Chat, "effort">, m: CatalogModel): ResolvedEffort {
  const notes: string[] = [];
  const layers: { source: "chat" | "model"; value: string | null; name: string }[] = [
    { source: "chat", value: chat.effort, name: "this chat's effort" },
    { source: "model", value: m.model.effort, name: `${m.id}'s default effort` },
  ];
  const set = layers.filter((l) => l.value !== null);
  if (!set.length) return { level: null, source: "none", notes };
  const levels = effortLevelsOf(m);
  if (m.provider.kind !== "claude") {
    for (const l of set) notes.push(`Effort: ${l.name} (${l.value}) was not sent: ${m.id} is not on a Claude login and takes no effort.`);
    return { level: null, source: "none", notes };
  }
  if (levels === null) {
    const l = set[0]!;
    notes.push(`Effort: ${l.name} (${l.value}) was not sent: the levels ${m.id} supports are not known yet, so it ran at the model's own default.`);
    return { level: null, source: "none", notes };
  }
  for (const l of set) {
    if (isEffortLevel(l.value) && levels.includes(l.value)) return { level: l.value, source: l.source, notes };
    notes.push(`Effort: ${l.name} (${l.value}) was not sent: ${m.id} does not support it${levels.length ? ` (it supports ${levels.join(", ")})` : ""}.`);
  }
  return { level: null, source: "none", notes };
}

/**
 * Record what a listing of Claude login `provider` reported (agent-runtime `ModelChoice`s): each catalog model of it
 * whose id the listing names, as an alias or as the fixed version one stands for (`canonicalId`), gets that entry's
 * levels. Returns how many models it changed. A model the listing does not name keeps what it had.
 */
export function recordEffortLevels(db: Db, provider: string, listed: readonly { id: string; canonicalId?: string; effortLevels?: readonly string[] }[]): number {
  const p = getProvider(db, provider);
  if (!p || p.kind !== "claude") return 0;
  const byId = new Map<string, EffortLevel[]>();
  for (const l of listed) {
    const levels = orderedLevels(l.effortLevels ?? []);
    if (!byId.has(l.id)) byId.set(l.id, levels);
    if (l.canonicalId && !byId.has(l.canonicalId)) byId.set(l.canonicalId, levels);
  }
  let changed = 0;
  for (const m of providerModels(db, provider)) {
    const levels = byId.get(m.model.model);
    if (!levels || JSON.stringify(levels) === JSON.stringify(m.model.effortLevels)) continue;
    db.update(models).set({ effortLevels: levels }).where(eq(models.id, m.model.id)).run();
    changed++;
  }
  return changed;
}

/** The Claude models whose effort levels are not recorded, by their provider's name (server/probes.ts fills them). */
export function modelsMissingLevels(db: Db): Map<string, CatalogModel[]> {
  const out = new Map<string, CatalogModel[]>();
  const rows = db
    .select()
    .from(models)
    .innerJoin(modelProviders, eq(models.providerId, modelProviders.id))
    .where(and(eq(modelProviders.kind, "claude"), isNull(models.effortLevels)))
    .orderBy(asc(models.id))
    .all();
  for (const r of rows) {
    const m = { id: modelId(r.model_providers, r.models), model: r.models, provider: r.model_providers };
    out.set(m.provider.name, [...(out.get(m.provider.name) ?? []), m]);
  }
  return out;
}

/**
 * `SHUVI_CLAUDE_CONFIG_DIR`, when set, is where the seeded Claude login (`SEEDED_PROVIDER`) lives, on every
 * start, not only the first: a store moved to another machine or into a container (where the login is a
 * volume) keeps pointing at the login it is deployed with. The row is updated when it differs, and the change
 * returned for the server to log; null when nothing changed (or there is no such provider, or no variable).
 * The lane is the provider's NAME (`laneOf`), so its conversations stay attributed to it; a session filed
 * under the old directory is not found under the new one, and its chat restarts as after a lost session.
 */
export function reconcileClaudeLogin(db: Db, claudeConfigDir: string | undefined): { from: string | null; to: string } | null {
  if (!claudeConfigDir) return null;
  const p = getProvider(db, SEEDED_PROVIDER);
  if (!p || p.kind !== "claude" || p.configDir === claudeConfigDir) return null;
  db.update(modelProviders).set({ configDir: claudeConfigDir }).where(eq(modelProviders.id, p.id)).run();
  return { from: p.configDir, to: claudeConfigDir };
}

/** On a first start with an empty catalog: what turns ran on before there was one. Idempotent. */
export function seedModels(db: Db, env: { claudeConfigDir?: string; model?: string }): void {
  if (listProviders(db).length) return;
  db.transaction((tx) => {
    const provider = tx.insert(modelProviders).values({ name: SEEDED_PROVIDER, kind: "claude", configDir: env.claudeConfigDir ?? null }).returning().get();
    tx.insert(models).values({ providerId: provider.id, model: env.model ?? CLI_DEFAULT_MODEL, isDefault: true }).run();
  }, IMMEDIATE);
}
