import { randomBytes } from "node:crypto";
import { addFromConsoleListing, catalogChanged, closeConsoleListing, openConsoleListing } from "../control/model-cards.ts";
import type { Db } from "../store/db.ts";
import {
  addModel,
  addProvider,
  editModel,
  findModel,
  getProvider,
  markProbing,
  providerModels,
  removeModel,
  removeProvider,
  setDefaultModel,
  setModelVision,
  setModelVisionAuto,
} from "../store/models.ts";
import { IMMEDIATE } from "../store/turns.ts";
import { anchor, type ProviderForm, type SettingsNote } from "./settings.ts";

/**
 * The Settings page's writes: the console's ONLY write routes, all `POST /settings/<area>/<verb>` with form
 * fields (server.ts checks the Origin and the CSRF token before any of them runs). Each does what the control
 * bot's command or button does, through the same functions and rules (store/models.ts, control/model-cards.ts):
 *
 *   providers/add      name, kind, base_url, api_key | config_dir  `addProvider`; an OpenAI-compatible one is
 *                      then listed (`openConsoleListing`: a provider_add card with no message)
 *   providers/list     provider                 list its `/models` again
 *   providers/remove   provider                 `removeProvider` (refused while it holds the default)
 *   models/add         provider, model, context_window   `addModel`, then `markProbing`
 *   models/default     model                    `setDefaultModel`
 *   models/probe       model                    `markProbing` (an OpenAI-compatible model only)
 *   models/vision      model, vision=on|off|auto  `setModelVision` / `setModelVisionAuto`
 *   models/edit        model, label, context_window  `editModel`
 *   models/remove      model                    `removeModel` (refused for the default)
 *   listings/add       card, index, context_window   the listed model, as the card's Add (`addFromConsoleListing`)
 *   listings/close     card                     Cancel while listing, Done after (`closeConsoleListing`)
 *
 * Every change to the catalog is followed by `catalogChanged`, so the control bot's open cards show it. Each
 * runs in one IMMEDIATE transaction. Probes and listings run in the server's background pass
 * (server/probes.ts), as the control bot's do.
 *
 * The answer is a 303 to `/settings` (POST, redirect, GET: a reload never repeats a write) carrying the
 * result as a FLASH: a random id in `?r=`, its note kept here in memory for FLASH_MS (at most FLASH_MAX of
 * them, the oldest dropped first; expired ones are swept on every read and write) and shown once. A
 * refusal says why, in the store's words, on the row it is about.
 */

export const FLASH_MS = 10 * 60_000;
/** At most this many flashes are kept: past it the oldest go (a script that never follows its 303s). */
export const FLASH_MAX = 200;

interface Flash {
  note: SettingsNote;
  adding?: ProviderForm;
  exp: number;
}

const flashes = new Map<string, Flash>();

function sweep(now: number): void {
  for (const [k, f] of flashes) if (f.exp < now) flashes.delete(k);
}

/** The flash `id` names (once: it is dropped when read), if it has not expired. */
export function takeFlash(id: string | null, now = Date.now()): { note: SettingsNote; adding?: ProviderForm } | undefined {
  sweep(now);
  if (!id) return undefined;
  const f = flashes.get(id);
  flashes.delete(id);
  return f && { note: f.note, ...(f.adding ? { adding: f.adding } : {}) };
}

/** How many flashes are held (a test seam). */
export const flashCount = () => flashes.size;

function putFlash(f: Omit<Flash, "exp">, now: number): string {
  sweep(now);
  // A Map keeps insertion order: the first keys are the oldest.
  for (const k of flashes.keys()) {
    if (flashes.size < FLASH_MAX) break;
    flashes.delete(k);
  }
  const id = randomBytes(12).toString("base64url");
  flashes.set(id, { ...f, exp: now + FLASH_MS });
  return id;
}

/** The write routes, by path. */
export const SETTINGS_WRITES = [
  "/settings/providers/add",
  "/settings/providers/list",
  "/settings/providers/remove",
  "/settings/models/add",
  "/settings/models/default",
  "/settings/models/probe",
  "/settings/models/vision",
  "/settings/models/edit",
  "/settings/models/remove",
  "/settings/listings/add",
  "/settings/listings/close",
] as const;

export type SettingsWrite = (typeof SETTINGS_WRITES)[number];

export const isSettingsWrite = (path: string): path is SettingsWrite => (SETTINGS_WRITES as readonly string[]).includes(path);

/** What a write did: a note, where on the page to land, and the form to show again. */
interface Outcome {
  note: SettingsNote;
  anchor?: string;
  adding?: ProviderForm;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** A store error as a sentence: capitalised, ending in a full stop. */
const sentence = (s: string) => {
  const t = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?…]$/.test(t) ? t : `${t}.`;
};

class Refused extends Error {}

/** A URL with a user or password in it (a key pasted into it, say). */
function hasCredentials(raw: string): boolean {
  try {
    const u = new URL(raw);
    return !!(u.username || u.password);
  } catch {
    return false;
  }
}

/** A posted form, as far as a write reads it. */
export interface Form {
  get(name: string): unknown;
}

const field = (form: Form, name: string): string => {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
};

/** A positive whole number of tokens, or undefined when the field is empty; anything else is refused. */
function tokensField(form: Form, name: string): number | undefined {
  const v = field(form, name);
  if (!v) return undefined;
  if (!/^\d+$/.test(v) || Number(v) <= 0) throw new Refused(`The context window is a number of tokens, not "${v}".`);
  return Number(v);
}

function model(db: Db, form: Form) {
  const id = field(form, "model");
  const m = findModel(db, id);
  if (!m) throw new Refused(`There is no model ${id} in the catalog.`);
  return m;
}

function cardField(form: Form): number {
  const v = field(form, "card");
  if (!/^\d+$/.test(v)) throw new Refused("There is no such listing.");
  return Number(v);
}

function write(db: Db, path: SettingsWrite, form: Form, key: string): Outcome {
  switch (path) {
    case "/settings/providers/add": {
      const name = field(form, "name");
      const kind = field(form, "kind");
      // Shown again after a refusal, so it need not be typed twice: never the key reference (a key may have been
      // pasted there), nor a base URL carrying credentials.
      const baseUrl = field(form, "base_url");
      const adding: ProviderForm = { name, kind, base_url: hasCredentials(baseUrl) ? "" : baseUrl, config_dir: field(form, "config_dir") };
      const apiKey = field(form, "api_key");
      try {
        if (kind === "claude") {
          const p = addProvider(db, { name, kind: "claude", configDir: adding.config_dir || null });
          catalogChanged(db);
          return { note: { tone: "ok", text: `Added Claude login ${p.name} (${p.configDir ?? "the server user's login"}). Add its models by id under Models.`, on: p.name }, anchor: anchor("provider", p.name) };
        }
        if (kind !== "openai-compat") throw new Refused(`"${kind}" is not a kind of provider.`);
        const p = addProvider(db, { name, kind: "openai-compat", baseUrl: baseUrl || null, apiKey: apiKey || null });
        catalogChanged(db);
        openConsoleListing(db, p.name, key);
        return { note: { tone: "ok", text: `Added provider ${p.name}. Listing its models…`, on: p.name }, anchor: "add" };
      } catch (e) {
        return { note: { tone: "refused", text: `Could not add provider ${name || "(no name)"}: ${message(e)}`, on: "add-provider" }, anchor: "add", adding };
      }
    }
    case "/settings/providers/list": {
      const name = field(form, "provider");
      const p = getProvider(db, name);
      if (!p) throw new Refused(`There is no provider ${name}.`);
      if (p.kind !== "openai-compat") throw new Refused(`${name} is a Claude login: it has no /models to list.`);
      openConsoleListing(db, p.name, key);
      return { note: { tone: "ok", text: `Listing the models of ${p.name}…`, on: p.name }, anchor: "add" };
    }
    case "/settings/providers/remove": {
      const name = field(form, "provider");
      if (!getProvider(db, name)) throw new Refused(`There is no provider ${name}.`);
      const def = providerModels(db, name).find((m) => m.model.isDefault);
      if (def) return { note: { tone: "refused", text: `${def.id} is the default model: make a model of another provider the default first.`, on: name }, anchor: anchor("provider", name) };
      const gone = removeProvider(db, name);
      catalogChanged(db);
      return { note: { tone: "ok", text: `Removed provider ${name}${gone.length ? ` and its ${gone.length === 1 ? "model" : `${gone.length} models`} (${gone.map((m) => m.id).join(", ")})` : ""}.` }, anchor: "providers" };
    }
    case "/settings/models/add": {
      const provider = field(form, "provider");
      const name = field(form, "model");
      const id = `${provider}/${name}`;
      try {
        const contextWindow = tokensField(form, "context_window");
        const m = addModel(db, { provider, model: name, ...(contextWindow ? { contextWindow } : {}) });
        const probing = markProbing(db, m.model.id);
        catalogChanged(db);
        return { note: { tone: "ok", text: `Added ${m.id}${m.model.contextWindow ? ` (${m.model.contextWindow} tokens)` : ""}.${probing ? " Probing it." : ""}`, on: m.id }, anchor: anchor("model", m.id) };
      } catch (e) {
        return { note: { tone: "refused", text: `Could not add ${id}: ${message(e)}`, on: "add-model" }, anchor: "add-model" };
      }
    }
    case "/settings/models/default": {
      const m = model(db, form);
      setDefaultModel(db, m.id);
      catalogChanged(db);
      return { note: { tone: "ok", text: `${m.id} is now the default.`, on: m.id }, anchor: anchor("model", m.id) };
    }
    case "/settings/models/probe": {
      const m = model(db, form);
      const probing = markProbing(db, m.model.id);
      catalogChanged(db);
      return { note: probing ? { tone: "ok", text: `Probing ${m.id}.`, on: m.id } : { tone: "refused", text: `${m.id} is not probed: only an OpenAI-compatible model is.`, on: m.id }, anchor: anchor("model", m.id) };
    }
    case "/settings/models/vision": {
      const m = model(db, form);
      const v = field(form, "vision");
      if (v === "on" || v === "off") setModelVision(db, m.id, v === "on");
      else if (v === "auto") setModelVisionAuto(db, m.id);
      else throw new Refused(`Vision is on, off or auto, not "${v}".`);
      catalogChanged(db);
      const now = findModel(db, m.id)!.model.vision;
      return { note: { tone: "ok", text: v === "auto" ? `${m.id}: vision follows the probe (${now ? "on" : "off"} now).` : `${m.id}: vision ${v}, set by you.`, on: m.id }, anchor: anchor("model", m.id) };
    }
    case "/settings/models/edit": {
      const m = model(db, form);
      try {
        const contextWindow = m.provider.kind === "openai-compat" ? tokensField(form, "context_window") : undefined;
        const e = editModel(db, m.id, { label: field(form, "label"), ...(contextWindow ? { contextWindow } : {}) });
        catalogChanged(db);
        return { note: { tone: "ok", text: `Saved ${e.id}${e.model.label ? ` (${e.model.label})` : ""}${e.model.contextWindow && e.provider.kind === "openai-compat" ? `: ${e.model.contextWindow} tokens` : ""}.`, on: m.id }, anchor: anchor("model", m.id) };
      } catch (e) {
        return { note: { tone: "refused", text: `Could not save ${m.id}: ${message(e)}`, on: m.id }, anchor: anchor("model", m.id) };
      }
    }
    case "/settings/models/remove": {
      const m = model(db, form);
      if (m.model.isDefault) return { note: { tone: "refused", text: `${m.id} is the default: make another model the default first.`, on: m.id }, anchor: anchor("model", m.id) };
      removeModel(db, m.id);
      catalogChanged(db);
      return { note: { tone: "ok", text: `Removed ${m.id}.` }, anchor: "models" };
    }
    case "/settings/listings/add": {
      const card = cardField(form);
      const index = field(form, "index");
      if (!/^\d+$/.test(index)) throw new Refused("There is no such model in the listing.");
      const contextWindow = tokensField(form, "context_window");
      // The note goes on the listing card itself (the panel shows it), as the control bot's press does.
      const note = addFromConsoleListing(db, card, Number(index), contextWindow);
      return { note: { tone: /^Added/.test(note) ? "ok" : "refused", text: note, on: "listing" }, anchor: "add" };
    }
    case "/settings/listings/close": {
      closeConsoleListing(db, cardField(form));
      return { note: { tone: "ok", text: "", on: "listing" }, anchor: "add" };
    }
    default:
      throw new Error(`unknown settings write "${String(path satisfies never)}"`);
  }
}

/**
 * Run write `path` with `form` (its CSRF token already checked) and answer where to go next: `/settings`
 * with the flash of its result. `key` names this request (a listing it opens is keyed on it).
 */
export function settingsWrite(db: Db, path: SettingsWrite, form: Form, now = Date.now()): string {
  const key = randomBytes(9).toString("base64url");
  let out: Outcome;
  try {
    out = db.transaction((tx) => write(tx as unknown as Db, path, form, key), IMMEDIATE);
  } catch (e) {
    if (!(e instanceof Refused) && !(e instanceof Error)) throw e;
    // A refusal is worded here already; anything else is the store's error, made a sentence.
    out = e instanceof Refused ? { note: { tone: "refused", text: e.message } } : { note: { tone: "failed", text: sentence(message(e)) } };
  }
  // A listing's own note is on its card; Done needs no note at all.
  const shown = out.note.on === "listing" ? undefined : out.note;
  const r = shown || out.adding ? putFlash({ note: shown ?? { tone: "refused", text: "" }, ...(out.adding ? { adding: out.adding } : {}) }, now) : undefined;
  return `/settings${r ? `?r=${r}` : ""}${out.anchor ? `#${out.anchor}` : ""}`;
}
