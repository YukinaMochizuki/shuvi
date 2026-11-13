import { and, asc, eq, inArray } from "drizzle-orm";
import { HISTORY_ON_NEW } from "../agent/turn.ts";
import { getSwitchRequest, previewSwitch, requestSwitch, type SwitchMode, type SwitchPreview, type SwitchRequest, type SwitchResult } from "../agent/switch.ts";
import { cardMessage, queueCardMessage, queueReply } from "../store/control.ts";
import type { Db } from "../store/db.ts";
import { getChat, type Chat } from "../store/events.ts";
import {
  addModel,
  addProvider,
  chatsOn,
  defaultModel,
  findModel,
  getProvider,
  listModels,
  markProbing,
  modelByRowId,
  providerModels,
  removeModel,
  removeProvider,
  setDefaultModel,
  probePending,
  unknownKind,
  type CatalogModel,
} from "../store/models.ts";
import { controlCards } from "../store/schema.ts";
import { chatLabel, IMMEDIATE, runningTurnFor } from "../store/turns.ts";

/**
 * The control bot's cards about models (docs/design.md §13): switching a chat's model, the catalog, and adding
 * or removing a provider. Each card is ONE control-bot message, edited in place at every step.
 *
 *   switch           opened by `/model` in the main chat (server/commands.ts) or `/model <chat>` here.
 *                    1. the model step: the catalog, 6 a page with ‹ ›; the model the chat runs on is marked
 *                       ✓, one whose last probe got no tool call ⚠; Cancel closes the card.
 *                    2. the mode step, once a model is pressed: Lossless, Lossy and ‹ Back, each with a line on
 *                       what it would do in this chat now (agent/switch.ts `previewSwitch`, which writes
 *                       nothing), and the running turn it would stop. The mode is offered for every target.
 *                    3. a mode pressed: a switch request (agent/switch.ts `requestSwitch`; the server stops a
 *                       running turn, then switches). The card says "switching…" (`waiting`) until
 *                       `switchCardPass` sees the request done or failed and edits it to the result.
 *                    The model the chat is already on, pressed, is "already on X" when switching to it would
 *                    do nothing; otherwise (it would take up a parked conversation) it goes on to the mode.
 *                    `/model <chat> <provider>/<model> lossless|lossy` asks for the switch with no card: the
 *                    result is a reply, sent by the same pass.
 *   models           `/models`: every model with its label, ★ default, context window, vision and probe
 *                    state, 6 a page; per model Make default, Re-probe (an OpenAI-compatible one) and Remove,
 *                    which asks first, naming the chats whose own model it is. The default cannot be removed.
 *   provider_add     `/provider add <name> <base_url> [<profile>.<VAR>]`: the provider is added at once, then
 *                    the server lists the endpoint's `/models` (server/probes.ts `backgroundPass`; Cancel
 *                    meanwhile closes the card and drops the listing, the provider stays) and the card
 *                    becomes that list, 6 a page, models already in the catalog ✓; pressing one adds it with
 *                    the listed context window and asks for its probe.
 *   provider_remove  `/provider remove <name>`: names its models and the chats on them, then removes it.
 *
 * A button press is recorded by the control poller in the transaction that advances its offset
 * (control/bot.ts), so a press is handled once. A card's state is its row (`control_cards`): a restart
 * between steps loses nothing. Button data is `cd:<card id>:<version>:<action>`, under Telegram's 64 bytes
 * whatever the catalog holds (a model is named by its row id); a press from an older version of the card,
 * or on a closed one, changes nothing and answers "This card is closed.".
 *
 * A card is rendered from its state whenever that changes, and again when what it shows changed under it
 * (`refreshCards`, never a step: the buttons on screen still count):
 *   - `/models` and `/provider add` cards when the catalog changes (`catalogChanged`: a model added, removed,
 *     made the default or asked to be probed, a provider added or removed, a probe finished);
 *   - an open mode step when a turn starts or ends in its chat (`switchCardPass`), so its counts and its
 *     "turn T is running" line are current.
 * A change of a relative time alone ("from 3 minutes ago") is no change: no edit is queued for it. Opening a
 * switch card for a chat closes that chat's older open ones, and opening `/models` closes the older `/models`
 * cards, each edited to say it was superseded. A card's text is kept under Telegram's 4096 characters by
 * showing only the current page and cutting long lists, its note always first. The sender always shows a
 * card as its row is then (control/bot.ts). Keys are never shown: a provider's key is only its
 * `<profile>.<VAR>` name.
 *
 * TRANSACTIONS. Every write here runs in its caller's transaction: the control batch (control/bot.ts, where
 * each command and press is also its own savepoint, so one that throws is answered with its error instead of
 * rolling back the batch), `commandPass` for `/model` in the chat (server/commands.ts), server/probes.ts. Only
 * `switchCardPass` opens its own, one per card.
 */

export const CARD_PREFIX = "cd:";
export const PAGE_SIZE = 6;
export const CLOSED = "This card is closed.";
export const SUPERSEDED = "Superseded by a newer card.";
/** Under Telegram's 4096, with room for the clip marker. */
export const CARD_TEXT_MAX = 4000;

type Card = typeof controlCards.$inferSelect;
type CardKind = Card["kind"];
type Button = { text: string; callback_data: string };
type Keyboard = Button[][];

/** A listed model of an endpoint, as a provider_add card keeps it. */
interface Listed {
  model: string;
  contextWindow?: number;
}

type State =
  /**
   * `listingFailed`: a provider_add card whose listing failed, with why (the console shows it until it is
   * `dismissed`).
   */
  | { step: "closed"; text: string; listingFailed?: { provider: string; error: string }; dismissed?: boolean }
  // switch
  | { step: "model"; page: number; note?: string }
  /** `running`: the turn running in the chat when it was drawn (switchCardPass redraws it when that changes). */
  | { step: "mode"; page: number; model: string; running?: number | null }
  | { step: "switching"; model: string; mode: SwitchMode; direct?: boolean }
  // models
  | { step: "list"; page: number; note?: string }
  | { step: "confirm"; page: number; model: string }
  // provider_add
  | { step: "listing"; provider: string }
  | { step: "listed"; provider: string; page: number; listed: Listed[]; note?: string }
  // provider_remove
  | { step: "confirm_provider"; provider: string };

function unknownCardKind(kind: never): never {
  throw new Error(`unknown card kind "${String(kind)}"`);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 days ago", "5 minutes ago", "just now". */
export function relativeTime(at: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${plural(m, "minute")} ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${plural(h, "hour")} ago`;
  return `${plural(Math.floor(h / 24), "day")} ago`;
}

/** The last probe got no structured tool call: she cannot speak on it. */
export function probeWarned(m: CatalogModel): boolean {
  return !probePending(m) && (m.model.probeStatus === "text-instead" || m.model.probeStatus === "failed");
}

/** A model's probe state in a few words; null when it has never been probed (a Claude model never is). */
export function probeText(m: CatalogModel): string | null {
  const ms = m.model.probeLatencyMs != null ? `, ${m.model.probeLatencyMs} ms` : "";
  if (probePending(m)) return "checking…";
  switch (m.model.probeStatus) {
    case null:
      return null;
    case "ok":
      return `ok${ms}`;
    case "text-instead":
      return `⚠ text-instead${ms}`;
    case "failed":
      return `⚠ failed: ${m.model.probeError ?? "unknown"}${ms}`;
    default:
      return exhausted(m.model.probeStatus, "probe status");
  }
}

/** The `default` of a `switch` that covers every case: a case added and not handled fails to compile. */
function exhausted(x: never, what: string): never {
  throw new Error(`unknown ${what} "${String(typeof x === "object" && x ? (x as { kind?: unknown }).kind : x)}"`);
}

// ---- the card store ------------------------------------------------------------------------------------

export function getCard(db: Pick<Db, "select">, id: number): Card | undefined {
  return db.select().from(controlCards).where(eq(controlCards.id, id)).get();
}

const stateOf = (c: Card) => c.state as unknown as State;

/** A text with its relative times blanked: two that differ only in those show the same thing. */
const sansRelativeTime = (t: string) => t.replace(/\b(just now|\d+ (minute|hour|day)s? ago)\b/g, "…");

/**
 * `head` (always shown: a title, a note) then as many of `rest` as fit under CARD_TEXT_MAX, ending with how
 * many were left out.
 */
function fit(head: readonly string[], rest: readonly string[]): string {
  const out = [...head];
  let len = out.join("\n").length;
  for (let i = 0; i < rest.length; i++) {
    if (len + rest[i]!.length + 1 > CARD_TEXT_MAX - 40) {
      out.push(`… and ${rest.length - i} more`);
      break;
    }
    out.push(rest[i]!);
    len += rest[i]!.length + 1;
  }
  const text = out.join("\n");
  return text.length > CARD_TEXT_MAX ? `${text.slice(0, CARD_TEXT_MAX - 1)}…` : text;
}

/** At most `max` names, then how many more. */
const names = (all: readonly string[], max = 10) => (all.length > max ? `${all.slice(0, max).join(", ")} and ${all.length - max} more` : all.join(", "));

/**
 * Open a card: its row, rendered, and (unless `send` is false: a switch with no card, whose result is a reply)
 * the message that sends it. Null when `idemKey` already opened one.
 */
function openCard(db: Db, c: { kind: CardKind; chatId?: number; idemKey?: string; state: State; status?: Card["status"] }, send = true): Card | null {
  const row = db
    .insert(controlCards)
    .values({ kind: c.kind, chatId: c.chatId ?? null, idemKey: c.idemKey ?? null, state: c.state as unknown as Record<string, unknown>, status: c.status ?? "open", text: "", keyboard: [] })
    .onConflictDoNothing()
    .returning()
    .get();
  if (!row) return null;
  const r = render(db, row, c.state);
  db.update(controlCards).set({ text: r.text, keyboard: r.keyboard }).where(eq(controlCards.id, row.id)).run();
  if (send) queueCardMessage(db, "card", row.id, 0);
  return { ...row, text: r.text, keyboard: r.keyboard };
}

/**
 * Move card `card` to `state` (a step of the owner's, `step`: its buttons drawn before no longer count), render
 * it, and queue an edit of its message when what it shows changed (and it was ever sent).
 */
function setState(db: Db, card: Card, state: State, o: { step?: boolean; status?: Card["status"] } = {}): Card {
  const status = state.step === "closed" ? "closed" : (o.status ?? card.status);
  const version = card.version + (o.step ? 1 : 0);
  const next = { ...card, state: state as unknown as Record<string, unknown>, status, version };
  const r = render(db, next, state);
  const sameKeys = JSON.stringify(r.keyboard) === JSON.stringify(card.keyboard);
  // What it shows is unchanged, or only a relative time moved on: keep the text as sent, and no edit.
  if (sameKeys && sansRelativeTime(r.text) === sansRelativeTime(card.text)) r.text = card.text;
  const changed = r.text !== card.text || !sameKeys;
  const rev = card.rev + (changed ? 1 : 0);
  db.update(controlCards).set({ state: next.state, status, version, text: r.text, keyboard: r.keyboard, rev }).where(eq(controlCards.id, card.id)).run();
  if (changed && cardMessage(db, card.id)) queueCardMessage(db, "card_edit", card.id, rev);
  return { ...next, text: r.text, keyboard: r.keyboard, rev };
}

const close = (db: Db, card: Card, text: string) => setState(db, card, { step: "closed", text }, { step: true });

/** Close the open cards of `kind` (of chat `chatId`, for a switch card) older than `newer`: superseded by it. */
function supersede(db: Db, kind: CardKind, newer: number, chatId?: number): void {
  const open = db
    .select()
    .from(controlCards)
    .where(and(eq(controlCards.kind, kind), eq(controlCards.status, "open"), chatId === undefined ? undefined : eq(controlCards.chatId, chatId)))
    .all();
  for (const c of open) if (c.id < newer) close(db, c, SUPERSEDED);
}

/**
 * Render the open cards of `kinds` again (not card `except`, which its caller is moving itself), and edit those
 * whose text or buttons changed under them. Not a step: the buttons on screen still count.
 */
export function refreshCards(db: Db, kinds: readonly CardKind[], except?: number): number {
  let edited = 0;
  const open = db
    .select()
    .from(controlCards)
    .where(and(eq(controlCards.status, "open"), inArray(controlCards.kind, [...kinds])))
    .orderBy(asc(controlCards.id))
    .all();
  for (const card of open) {
    if (card.id === except) continue;
    if (setState(db, card, stateOf(card)).rev !== card.rev) edited++;
  }
  return edited;
}

/** The catalog changed (a model added, removed, made the default, probed; a provider added or removed): redraw the cards showing it. */
export function catalogChanged(db: Db, except?: number): number {
  return refreshCards(db, ["models", "provider_add"], except);
}

// ---- rendering -----------------------------------------------------------------------------------------

function render(db: Db, card: Card, state: State): { text: string; keyboard: Keyboard } {
  const cb = (action: string) => `${CARD_PREFIX}${card.id}:${card.version}:${action}`;
  if (state.step === "closed") return { text: state.text, keyboard: [] };
  switch (card.kind) {
    case "switch":
      return renderSwitch(db, card, state, cb);
    case "models":
      return renderModels(db, state, cb);
    case "provider_add":
      return renderProviderAdd(db, state, cb);
    case "provider_remove":
      return renderProviderRemove(db, state, cb);
    default:
      return unknownCardKind(card.kind);
  }
}

function wrongStep(state: State): never {
  throw new Error(`a card cannot be at step "${state.step}" here`);
}

/** Page `page` of `items`, clamped, and the ‹ › row for it (empty with one page). */
function paged<T>(items: readonly T[], page: number, cb: (a: string) => string): { items: T[]; page: number; pages: number; nav: Button[] } {
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const nav: Button[] = [];
  if (p > 0) nav.push({ text: "‹", callback_data: cb(`p${p - 1}`) });
  if (p < pages - 1) nav.push({ text: "›", callback_data: cb(`p${p + 1}`) });
  return { items: items.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE), page: p, pages, nav };
}

const pageNote = (p: { page: number; pages: number }) => (p.pages > 1 ? ` (page ${p.page + 1}/${p.pages})` : "");

function chatOf(db: Db, card: Card): Chat {
  const chat = card.chatId != null ? getChat(db, card.chatId) : undefined;
  if (!chat) throw new Error(`card ${card.id} names no chat`);
  return chat;
}

/** The model the chat runs on: its own, else the default. */
function runsOn(db: Db, chat: Chat): string | null {
  return chat.model ?? defaultModel(db)?.id ?? null;
}

/** The mode step's two lines, as `previewSwitch` computed them. */
export function modeLines(p: SwitchPreview, now = Date.now()): { lossless: string; lossy: string; running: string | null } {
  const x = p.to;
  const lossless = p.lossless.kind === "carry" ? `carries ${plural(p.lossless.messages, "new message")} into ${x}'s conversation` : `copies the whole conversation (${plural(p.lossless.messages, "message")}) to ${x}`;
  let lossy: string;
  switch (p.lossy.kind) {
    case "resume":
      lossy = p.lossy.since ? `resumes ${x}'s conversation from ${relativeTime(p.lossy.since, now)}` : `keeps ${x}'s conversation as it is`;
      break;
    case "fresh":
      lossy = `${x} starts fresh with the last ${HISTORY_ON_NEW} messages`;
      break;
    default:
      lossy = exhausted(p.lossy, "lossy preview");
  }
  return { lossless, lossy, running: p.running ? `turn ${p.running} is running and will be stopped` : null };
}

function renderSwitch(db: Db, card: Card, state: State, cb: (a: string) => string): { text: string; keyboard: Keyboard } {
  const chat = chatOf(db, card);
  const label = chatLabel(chat);
  switch (state.step) {
    case "model": {
      const current = runsOn(db, chat);
      const all = listModels(db);
      const p = paged(all, state.page, cb);
      const lines = [`Model for ${label}: now ${current ?? "none"}${pageNote(p)}.`];
      if (state.note) lines.push("", state.note);
      if (all.some(probeWarned)) lines.push("⚠: its last probe got no tool call.");
      const keyboard: Keyboard = p.items.map((m) => [{ text: `${m.id === current ? "✓ " : ""}${probeWarned(m) ? "⚠ " : ""}${m.id}`, callback_data: cb(`m${m.model.id}`) }]);
      if (p.nav.length) keyboard.push(p.nav);
      keyboard.push([{ text: "Cancel", callback_data: cb("x") }]);
      return { text: fit(lines, []), keyboard };
    }
    case "mode": {
      const back = [[{ text: "‹ Back", callback_data: cb("b") }]];
      let preview: SwitchPreview;
      try {
        preview = previewSwitch(db, chat.id, state.model);
      } catch (e) {
        return { text: `${label} → ${state.model}: ${e instanceof Error ? e.message : String(e)}`, keyboard: back };
      }
      const l = modeLines(preview);
      const lines = [`Switch ${label} to ${state.model}:`, `Lossless: ${l.lossless}`, `Lossy: ${l.lossy}`];
      if (l.running) lines.push(l.running);
      return {
        text: lines.join("\n"),
        keyboard: [[{ text: "Lossless", callback_data: cb("L") }, { text: "Lossy", callback_data: cb("Y") }], ...back],
      };
    }
    case "switching":
      return { text: `${label} → ${state.model} (${state.mode}): switching…`, keyboard: [] };
    default:
      return wrongStep(state);
  }
}

function modelLine(m: CatalogModel, n: number): string {
  const head = `${n}. ${m.id}${m.model.label ? ` (${m.model.label})` : ""}${m.model.isDefault ? " ★" : ""}`;
  let detail: string;
  switch (m.provider.kind) {
    case "claude":
      detail = "Claude login";
      break;
    case "openai-compat": {
      const probe = probeText(m);
      detail = [m.model.contextWindow ? `${m.model.contextWindow} tokens` : "no context window", m.model.vision ? "vision" : "no vision", probe ? `probe ${probe}` : "not probed"].join(" · ");
      break;
    }
    default:
      detail = unknownKind(m.provider.kind);
  }
  return `${head}\n   ${detail}`;
}

function renderModels(db: Db, state: State, cb: (a: string) => string): { text: string; keyboard: Keyboard } {
  const all = listModels(db);
  switch (state.step) {
    case "list": {
      const p = paged(all, state.page, cb);
      const first = p.page * PAGE_SIZE;
      const head = [`Models${pageNote(p)}, ★ = default:`];
      if (state.note) head.push(state.note, "");
      if (!all.length) head.push("None. Add one with /models add <provider>/<model> [<context_window>].");
      const keyboard: Keyboard = p.items.map((m, i) => {
        const n = first + i + 1;
        const row: Button[] = [];
        if (!m.model.isDefault) row.push({ text: `${n} · Make default`, callback_data: cb(`d${m.model.id}`) });
        if (m.provider.kind === "openai-compat" && !probePending(m)) row.push({ text: `${n} · Re-probe`, callback_data: cb(`q${m.model.id}`) });
        row.push({ text: `${n} · Remove`, callback_data: cb(`r${m.model.id}`) });
        return row;
      });
      if (p.nav.length) keyboard.push(p.nav);
      keyboard.push([{ text: "Done", callback_data: cb("x") }]);
      return { text: fit(head, p.items.map((m, i) => modelLine(m, first + i + 1))), keyboard };
    }
    case "confirm": {
      const chats = chatsOn(db, [state.model]);
      const lines = [`Remove ${state.model}?`, chats.length ? `Chats on it: ${names(chats.map(chatLabel))}. Their next turn fails until they get another model.` : "No chat has it as its own model."];
      return {
        text: fit(lines, []),
        keyboard: [[{ text: `Remove ${state.model}`, callback_data: cb("R") }], [{ text: "‹ Back", callback_data: cb("b") }]],
      };
    }
    default:
      return wrongStep(state);
  }
}

function renderProviderAdd(db: Db, state: State, cb: (a: string) => string): { text: string; keyboard: Keyboard } {
  const provider = "provider" in state ? getProvider(db, state.provider) : undefined;
  if (!provider || !("provider" in state)) return { text: `The provider is no longer in the catalog.`, keyboard: [] };
  const where = `${provider.name} (${provider.baseUrl}${provider.apiKey ? `, key ${provider.apiKey}` : ""})`;
  switch (state.step) {
    case "listing":
      return { text: fit([`Added provider ${where}. Listing its models…`], []), keyboard: [[{ text: "Cancel", callback_data: cb("x") }]] };
    case "listed": {
      const ours = new Map(providerModels(db, provider.name).map((m) => [m.model.model, m]));
      const p = paged(state.listed, state.page, cb);
      const head = [`${where} lists ${plural(state.listed.length, "model")}${pageNote(p)}. Press one to add it. ✓ = in the catalog.`];
      if (state.note) head.push(state.note);
      // The probes of this page's models only: the text stays short however many the provider has.
      const probes = p.items.flatMap((l) => {
        const m = ours.get(l.model);
        const probe = m && probeText(m);
        return probe ? [`${m.id}: probe ${probe}`] : [];
      });
      const lines = probes.length ? ["", ...probes] : [];
      const first = p.page * PAGE_SIZE;
      const keyboard: Keyboard = p.items.map((l, i) => {
        const have = ours.get(l.model);
        const mark = `${have ? "✓ " : ""}${have && probeWarned(have) ? "⚠ " : ""}`;
        return [{ text: `${mark}${l.model} · ${l.contextWindow ? `${l.contextWindow} tokens` : "no context length"}`, callback_data: cb(`a${first + i}`) }];
      });
      if (p.nav.length) keyboard.push(p.nav);
      keyboard.push([{ text: "Done", callback_data: cb("x") }]);
      return { text: fit(head, lines), keyboard };
    }
    default:
      return wrongStep(state);
  }
}

function renderProviderRemove(db: Db, state: State, cb: (a: string) => string): { text: string; keyboard: Keyboard } {
  if (state.step !== "confirm_provider") return wrongStep(state);
  const its = providerModels(db, state.provider);
  const chats = chatsOn(
    db,
    its.map((m) => m.id),
  );
  const lines = [
    its.length ? `Remove provider ${state.provider} and its ${plural(its.length, "model")} (${names(its.map((m) => m.id))})?` : `Remove provider ${state.provider}? It has no models.`,
    chats.length ? `Chats on them: ${names(chats.map(chatLabel))}. Their next turn fails until they get another model.` : its.length ? "No chat has one of them as its own model." : "",
  ].filter(Boolean);
  return {
    text: fit(lines, []),
    keyboard: [[{ text: `Remove ${state.provider}`, callback_data: cb("R") }], [{ text: "Cancel", callback_data: cb("x") }]],
  };
}

// ---- opening cards, and the commands -------------------------------------------------------------------

/** Open a switch card for chat `chatId`, closing its older open ones. Null when `idemKey` already opened one. */
export function openSwitchCard(db: Db, chatId: number, idemKey: string): Card | null {
  const card = openCard(db, { kind: "switch", chatId, idemKey, state: { step: "model", page: 0 } });
  if (card) supersede(db, "switch", card.id, chatId);
  return card;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const MODEL_USAGE = "Usage: /model <chat> [<provider>/<model> lossless|lossy]";
const MODELS_USAGE = "Usage: /models, or /models add <provider>/<model> [<context_window>]";
const PROVIDER_USAGE = "Usage: /provider add <name> <base_url> [<profile>.<VAR>], /provider add <name> claude [<config_dir>], or /provider remove <name>";

/**
 * `/model <chat>` (a card) and `/model <chat> <provider>/<model> lossless|lossy` (no card: a switch request,
 * and a reply with its result). `chat` resolves `<chat>` as `/stop <chat>` does.
 */
export function modelCommand(db: Db, key: string, arg: string, chat: (arg: string) => Chat | undefined): void {
  const [which, to, mode, ...rest] = arg.split(/\s+/).filter(Boolean);
  if (!which || rest.length || (to && !mode)) return queueReply(db, key, MODEL_USAGE);
  const c = chat(which);
  if (!c) return queueReply(db, key, `No chat ${which}. Use its number from /status, or its Telegram id.`);
  if (!to) return void openSwitchCard(db, c.id, key);
  if (mode !== "lossless" && mode !== "lossy") return queueReply(db, key, MODEL_USAGE);
  if (!findModel(db, to)) return queueReply(db, key, `There is no model ${to} in the catalog. /models lists them.`);
  let noop: boolean;
  try {
    noop = previewSwitch(db, c.id, to).noop;
  } catch (e) {
    return queueReply(db, key, `${chatLabel(c)} → ${to} failed: ${errorText(e)}`);
  }
  if (noop) return queueReply(db, key, `${chatLabel(c)}: already on ${to}`);
  const card = openCard(db, { kind: "switch", chatId: c.id, idemKey: key, state: { step: "switching", model: to, mode, direct: true }, status: "waiting" }, false);
  if (card) db.update(controlCards).set({ switchRequestId: requestSwitch(db, c.id, to, mode).id }).where(eq(controlCards.id, card.id)).run();
}

/** `/models` (a card) and `/models add <provider>/<model> [<context_window>]`. */
export function modelsCommand(db: Db, key: string, arg: string): void {
  const [sub, id, ctx, ...rest] = arg.split(/\s+/).filter(Boolean);
  if (!sub) {
    const card = openCard(db, { kind: "models", idemKey: key, state: { step: "list", page: 0 } });
    if (card) supersede(db, "models", card.id);
    return;
  }
  if (sub !== "add" || !id || rest.length) return queueReply(db, key, MODELS_USAGE);
  const slash = id.indexOf("/");
  if (slash <= 0) return queueReply(db, key, MODELS_USAGE);
  if (ctx !== undefined && !/^\d+$/.test(ctx)) return queueReply(db, key, `The context window is a number of tokens, not "${ctx}".`);
  try {
    const m = addModel(db, { provider: id.slice(0, slash), model: id.slice(slash + 1), ...(ctx ? { contextWindow: Number(ctx) } : {}) });
    const probing = markProbing(db, m.model.id);
    catalogChanged(db);
    queueReply(db, key, `Added ${m.id}${m.model.contextWindow ? ` (${m.model.contextWindow} tokens)` : ""}.${probing ? " Probing it." : ""}`);
  } catch (e) {
    queueReply(db, key, `Could not add ${id}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** `/provider add …` and `/provider remove <name>`. */
export function providerCommand(db: Db, key: string, arg: string): void {
  const [sub, name, where, extra, ...rest] = arg.split(/\s+/).filter(Boolean);
  if (sub === "remove" && name && !where) {
    if (!getProvider(db, name)) return queueReply(db, key, `There is no provider ${name}.`);
    const def = providerModels(db, name).find((m) => m.model.isDefault);
    if (def) return queueReply(db, key, `${def.id} is the default model: make a model of another provider the default first.`);
    return void openCard(db, { kind: "provider_remove", idemKey: key, state: { step: "confirm_provider", provider: name } });
  }
  if (sub !== "add" || !name || !where || rest.length) return queueReply(db, key, PROVIDER_USAGE);
  try {
    if (where === "claude") {
      const p = addProvider(db, { name, kind: "claude", configDir: extra ?? null });
      catalogChanged(db);
      return queueReply(db, key, `Added Claude login ${p.name} (${p.configDir ?? "the server user's login"}). Add its models with /models add ${p.name}/<model>.`);
    }
    const p = addProvider(db, { name, kind: "openai-compat", baseUrl: where, apiKey: extra ?? null });
    catalogChanged(db);
    openCard(db, { kind: "provider_add", idemKey: key, state: { step: "listing", provider: p.name } });
  } catch (e) {
    queueReply(db, key, `Could not add provider ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---- button presses ------------------------------------------------------------------------------------

export function isCardButton(data: string | undefined): boolean {
  return !!data?.startsWith(CARD_PREFIX);
}

/**
 * Record the owner's press of a card button. Call inside the transaction that records the update. Returns the
 * text to answer the press with ("" for none).
 */
export function pressCard(db: Db, data: string): string {
  const m = /^cd:(\d+):(\d+):([A-Za-z])(\d*)$/.exec(data);
  const card = m ? getCard(db, Number(m[1])) : undefined;
  if (!m || !card || card.status !== "open" || card.version !== Number(m[2])) return CLOSED;
  const action = m[3]!;
  const n = m[4] ? Number(m[4]) : null;
  const state = stateOf(card);
  if (action === "x") {
    // Done keeps what the card showed; Cancel while a listing runs drops the listing (finishListing finds the card closed).
    if (card.kind === "provider_add" && state.step === "listing") close(db, card, `Cancelled. The provider ${state.provider} stays; /provider remove ${state.provider} removes it.`);
    else close(db, card, card.kind === "models" || card.kind === "provider_add" ? card.text : "Cancelled.");
    return "";
  }
  switch (card.kind) {
    case "switch":
      return pressSwitch(db, card, state, action, n);
    case "models":
      return pressModels(db, card, state, action, n);
    case "provider_add":
      return pressProviderAdd(db, card, state, action, n);
    case "provider_remove":
      return pressProviderRemove(db, card, action);
    default:
      return unknownCardKind(card.kind);
  }
}

const pageOf = (state: State) => ("page" in state ? state.page : 0);

function pressSwitch(db: Db, card: Card, state: State, action: string, n: number | null): string {
  const chat = chatOf(db, card);
  if (action === "p" && n !== null && state.step === "model") return void setState(db, card, { step: "model", page: n }, { step: true }), "";
  if (action === "b" && state.step === "mode") return void setState(db, card, { step: "model", page: state.page }, { step: true }), "";
  if (action === "m" && n !== null && state.step === "model") {
    const m = modelByRowId(db, n);
    if (!m) return void setState(db, card, { step: "model", page: state.page }, { step: true }), "That model is no longer in the catalog.";
    let preview: SwitchPreview;
    try {
      preview = previewSwitch(db, chat.id, m.id);
    } catch (e) {
      return void setState(db, card, { step: "model", page: state.page, note: `${m.id}: ${errorText(e)}` }, { step: true }), "";
    }
    if (preview.noop) return void close(db, card, `${chatLabel(chat)}: already on ${m.id}`), "";
    return void setState(db, card, { step: "mode", page: state.page, model: m.id, running: preview.running }, { step: true }), "";
  }
  if ((action === "L" || action === "Y") && state.step === "mode") {
    const mode: SwitchMode = action === "L" ? "lossless" : "lossy";
    let req: SwitchRequest;
    try {
      req = requestSwitch(db, chat.id, state.model, mode);
    } catch (e) {
      return void close(db, card, `${chatLabel(chat)} → ${state.model} failed: ${e instanceof Error ? e.message : String(e)}`), "";
    }
    db.update(controlCards).set({ switchRequestId: req.id }).where(eq(controlCards.id, card.id)).run();
    setState(db, { ...card, switchRequestId: req.id }, { step: "switching", model: state.model, mode }, { step: true, status: "waiting" });
    return "";
  }
  return CLOSED; // a button this step does not have
}

function pressModels(db: Db, card: Card, state: State, action: string, n: number | null): string {
  const page = pageOf(state);
  const list = (note?: string) => void setState(db, card, { step: "list", page, ...(note ? { note } : {}) }, { step: true });
  if (state.step === "list") {
    if (action === "p" && n !== null) return void setState(db, card, { step: "list", page: n }, { step: true }), "";
    if (!["d", "q", "r"].includes(action) || n === null) return CLOSED;
    const m = modelByRowId(db, n);
    if (!m) return list("That model is no longer in the catalog."), "";
    switch (action) {
      case "d":
        setDefaultModel(db, m.id);
        catalogChanged(db, card.id);
        return list(`${m.id} is now the default.`), "";
      case "q": {
        const probing = markProbing(db, m.model.id);
        catalogChanged(db, card.id);
        return list(probing ? undefined : `${m.id} is not probed: only an OpenAI-compatible model is.`), "";
      }
      case "r":
        if (m.model.isDefault) return list(`${m.id} is the default: make another model the default first.`), "";
        return void setState(db, card, { step: "confirm", page, model: m.id }, { step: true }), "";
    }
  }
  if (state.step === "confirm") {
    if (action === "b") return list(), "";
    if (action === "R") {
      try {
        removeModel(db, state.model);
        catalogChanged(db, card.id);
        return list(`Removed ${state.model}.`), "";
      } catch (e) {
        return list(`Could not remove ${state.model}: ${e instanceof Error ? e.message : String(e)}`), "";
      }
    }
  }
  return CLOSED;
}

function pressProviderAdd(db: Db, card: Card, state: State, action: string, n: number | null): string {
  if (state.step !== "listed") return CLOSED;
  if (action === "p" && n !== null) return void setState(db, card, { ...state, page: n, note: undefined }, { step: true }), "";
  if (action !== "a" || n === null || !state.listed[n]) return CLOSED;
  addListed(db, card, state, n);
  return "";
}

/**
 * Add the `n`th model a listing card lists, and say how it went on the card (its note): already in the catalog,
 * no context length (unless `contextWindow` gives one: the console asks for it), or added and asked to be probed.
 * The control bot's press and the console's Add both come here.
 */
function addListed(db: Db, card: Card, state: Extract<State, { step: "listed" }>, n: number, contextWindow?: number): string {
  const l = state.listed[n]!;
  const ctx = l.contextWindow ?? contextWindow;
  const id = `${state.provider}/${l.model}`;
  let note: string;
  if (findModel(db, id)) note = `${id} is already in the catalog.`;
  else if (!ctx) note = `The listing gives no context length for ${l.model}. Add it with /models add ${id} <context_window>.`;
  else {
    try {
      const m = addModel(db, { provider: state.provider, model: l.model, contextWindow: ctx });
      markProbing(db, m.model.id);
      catalogChanged(db, card.id);
      note = `Added ${id} (${ctx} tokens); probing it.`;
    } catch (e) {
      note = `Could not add ${id}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  setState(db, card, { ...state, note }, { step: true });
  return note;
}

function pressProviderRemove(db: Db, card: Card, action: string): string {
  const state = stateOf(card);
  if (action !== "R" || state.step !== "confirm_provider") return CLOSED;
  try {
    const gone = removeProvider(db, state.provider);
    catalogChanged(db);
    close(db, card, `Removed provider ${state.provider}${gone.length ? ` and its ${plural(gone.length, "model")} (${names(gone.map((m) => m.id))})` : ""}.`);
  } catch (e) {
    close(db, card, `Could not remove ${state.provider}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return "";
}

// ---- the server's side: results that arrive later ------------------------------------------------------

/** What a finished switch request did, in one line. */
export function switchResultText(chat: Chat, req: SwitchRequest): string {
  const label = chatLabel(chat);
  const stopped = req.stoppedTurnId ? `; stopped turn ${req.stoppedTurnId}` : "";
  if (req.status === "failed") return `${label} → ${req.toModel} failed: ${req.error ?? "unknown error"}${stopped}`;
  const r = req.result as unknown as SwitchResult;
  if (!r.changed) return `${label}: already on ${r.to}${stopped}`;
  let what: string;
  if (r.from === null || r.from === r.to) what = r.resumed ? "took up its own conversation" : "no conversation to carry";
  else {
    switch (r.mode) {
      case "lossless":
        what = `lossless, ${plural(r.carried, "message")} carried`;
        break;
      case "lossy":
        what = r.resumed ? "lossy, its own conversation resumed" : `lossy, starting fresh with the last ${HISTORY_ON_NEW} messages`;
        break;
      default:
        what = exhausted(r.mode, "switch mode");
    }
  }
  return `${label} → ${r.to} (${what})${stopped}`;
}

/**
 * Edit every switch card whose request is done or failed to its result, with no buttons; a switch asked for
 * with no card gets its result as a reply. And redraw each open mode step whose chat's running turn changed
 * since it was drawn (one started or ended). Run by the server after its switch requests (server/main.ts).
 * Returns how many it finished.
 */
export function switchCardPass(db: Db): number {
  let n = 0;
  const open = db
    .select()
    .from(controlCards)
    .where(and(eq(controlCards.kind, "switch"), eq(controlCards.status, "open")))
    .all();
  for (const card of open) {
    const state = stateOf(card);
    if (state.step !== "mode" || card.chatId == null) continue;
    const running = runningTurnFor(db, card.chatId)?.id ?? null;
    if (running === (state.running ?? null)) continue;
    db.transaction((tx) => {
      const t = tx as unknown as Db;
      const now = getCard(t, card.id);
      const s = now && stateOf(now);
      if (!now || now.status !== "open" || s?.step !== "mode") return;
      setState(t, now, { ...s, running: runningTurnFor(t, card.chatId!)?.id ?? null });
    }, IMMEDIATE);
  }
  const waiting = db
    .select()
    .from(controlCards)
    .where(and(eq(controlCards.kind, "switch"), eq(controlCards.status, "waiting")))
    .all();
  for (const card of waiting) {
    const req = card.switchRequestId != null ? getSwitchRequest(db, card.switchRequestId) : undefined;
    if (req?.status === "pending") continue;
    db.transaction((tx) => {
      const t = tx as unknown as Db;
      const now = getCard(t, card.id);
      if (!now || now.status !== "waiting") return;
      const text = req ? switchResultText(chatOf(t, now), req) : "The switch request is gone.";
      const state = stateOf(now);
      if (state.step === "switching" && state.direct) queueReply(t, `card-result:${now.id}`, text);
      close(t, now, text);
      n++;
    }, IMMEDIATE);
  }
  return n;
}

// ---- the console's listings ----------------------------------------------------------------------------
//
// The console's Settings page lists a provider's `/models` through a provider_add card of its own, opened
// with no message (its idem key starts CONSOLE_LISTING): the same row, the same background listing
// (server/probes.ts), the same Add rules (`addListed`) and Cancel / Done (`pressCard`). The page shows the
// newest such card while it is open, or closed by a failed listing until that is dismissed.

export const CONSOLE_LISTING = "console-listing:";

/** What the console shows of its listing card. */
export type ConsoleListing =
  | { cardId: number; provider: string; state: "listing"; since: string }
  | { cardId: number; provider: string; state: "listed"; listed: Listed[]; note?: string }
  | { cardId: number; provider: string; state: "failed"; error: string };

function consoleCards(db: Db): Card[] {
  return db
    .select()
    .from(controlCards)
    .where(eq(controlCards.kind, "provider_add"))
    .orderBy(asc(controlCards.id))
    .all()
    .filter((c) => c.idemKey?.startsWith(CONSOLE_LISTING));
}

/**
 * List provider `provider`'s `/models` for the console: a provider_add card with no message, closing (as
 * superseded) the console's older open ones. `key` makes a repeated request open one card.
 */
export function openConsoleListing(db: Db, provider: string, key: string): Card | null {
  const card = openCard(db, { kind: "provider_add", idemKey: `${CONSOLE_LISTING}${key}`, state: { step: "listing", provider } }, false);
  if (card) for (const c of consoleCards(db)) if (c.id < card.id && c.status === "open") close(db, c, SUPERSEDED);
  return card;
}

/** The console's newest listing card, as the page shows it; undefined when there is none to show. */
export function consoleListing(db: Db): ConsoleListing | undefined {
  const card = consoleCards(db).at(-1);
  if (!card) return undefined;
  const s = stateOf(card);
  switch (s.step) {
    case "listing":
      return card.status === "open" ? { cardId: card.id, provider: s.provider, state: "listing", since: card.createdAt } : undefined;
    case "listed":
      return card.status === "open" ? { cardId: card.id, provider: s.provider, state: "listed", listed: s.listed, ...(s.note ? { note: s.note } : {}) } : undefined;
    case "closed":
      return s.listingFailed && !s.dismissed ? { cardId: card.id, provider: s.listingFailed.provider, state: "failed", error: s.listingFailed.error } : undefined;
    default:
      return undefined;
  }
}

/** The console's Add on its listing card: the `n`th listed model, with `contextWindow` where the listing gave none. */
export function addFromConsoleListing(db: Db, cardId: number, n: number, contextWindow?: number): string {
  const card = getCard(db, cardId);
  const state = card && stateOf(card);
  if (!card || !card.idemKey?.startsWith(CONSOLE_LISTING) || card.status !== "open" || state?.step !== "listed" || !state.listed[n]) throw new Error("That listing is closed: list the provider again.");
  return addListed(db, card, state, n, contextWindow);
}

/** The console's Cancel (while listing) or Done (once listed or failed) on its listing card. */
export function closeConsoleListing(db: Db, cardId: number): void {
  const card = getCard(db, cardId);
  if (!card || !card.idemKey?.startsWith(CONSOLE_LISTING)) throw new Error("There is no such listing.");
  const s = stateOf(card);
  if (card.status === "open") return void pressCard(db, `${CARD_PREFIX}${card.id}:${card.version}:x`);
  if (s.step === "closed" && s.listingFailed && !s.dismissed) db.update(controlCards).set({ state: { ...s, dismissed: true } as unknown as Record<string, unknown> }).where(eq(controlCards.id, card.id)).run();
}

/** The provider_add cards waiting for their endpoint's `/models` (server/probes.ts `backgroundPass`). */
export function cardsListing(db: Db): { cardId: number; provider: string }[] {
  return db
    .select()
    .from(controlCards)
    .where(and(eq(controlCards.kind, "provider_add"), eq(controlCards.status, "open")))
    .all()
    .flatMap((c) => {
      const s = stateOf(c);
      return s.step === "listing" ? [{ cardId: c.id, provider: s.provider }] : [];
    });
}

/**
 * Show what the endpoint listed on card `cardId` (or why it could not be listed: the provider stays). Not a
 * step: nothing the owner had on screen pointed anywhere.
 */
export function finishListing(db: Db, cardId: number, r: { listed: Listed[] } | { error: string }): void {
  const card = getCard(db, cardId);
  const state = card && stateOf(card);
  if (!card || card.status !== "open" || state?.step !== "listing") return;
  if ("error" in r) {
    const p = getProvider(db, state.provider);
    const text = `Added provider ${state.provider}${p?.baseUrl ? ` (${p.baseUrl})` : ""}. Listing its models failed: ${r.error}\nThe provider stays. Add a model with /models add ${state.provider}/<model> <context_window>.`;
    setState(db, card, { step: "closed", text, listingFailed: { provider: state.provider, error: r.error } }, { step: true });
    return;
  }
  setState(db, card, { step: "listed", provider: state.provider, page: 0, listed: r.listed }, { step: true });
}
