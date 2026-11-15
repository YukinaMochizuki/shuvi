import { createHash, randomBytes } from "node:crypto";
import { modeLines, probeWarned, switchResultText } from "../control/model-cards.ts";
import { getSwitchRequest, pendingSwitchRequests, previewSwitch } from "../agent/switch.ts";
import { listProfiles } from "../capabilities/memory/layers.ts";
import type { Capability } from "../capabilities/types.ts";
import { rawEntry } from "../policy/edit.ts";
import { readPolicyText } from "../policy/load.ts";
import { parsePolicy, proposedGroupEntry, resolveChat, TOOL_ALIASES, type Policy } from "../policy/policy.ts";
import type { Db } from "../store/db.ts";
import { getChat } from "../store/events.ts";
import { defaultModel, listModels } from "../store/models.ts";
import { runningTurnFor } from "../store/turns.ts";
import type { CapabilityRow, ChatSettingsView, ModelGroup, PermissionsView, Picked, Switching } from "./chat-settings.ts";
import type { Flash } from "./home.ts";
import { ownFiles } from "./home-data.ts";
import { chatName, conversationLabel } from "./pages.ts";
import { formFromEntry, type PolicyForm } from "./policy-form.ts";
import { chatById } from "./queries.ts";
import { chatGrouping, conversations } from "./sessions.ts";
import type { Raw } from "./html.ts";

/**
 * What a chat's settings page shows (chat-settings.ts draws it), read from the store, home/ and policy.yaml. Reads
 * only; the writes are chat-settings-write.ts's.
 */

export interface ChatSettingsDeps {
  db: Db;
  home: string;
  ownerId?: number;
  /** Every registered capability, in registry order (capabilities/index.ts `CAPABILITIES`). */
  registry: readonly Capability<any>[];
  /** The ids set up in this process; absent: all of the registry. */
  enabled?: ReadonlySet<string>;
}

/** The result of a write, shown once on the page it comes back to (chat-settings-write.ts keeps it). */
export interface ChatSettingsResult {
  chatId: number;
  section: "model" | "profile" | "conversation" | "permissions";
  flash?: Flash;
  /** A switch asked for from the page: the page follows it until it is done. */
  switchRequest?: number;
  /** Permissions: the form as posted, and either the parser's refusal or the diff step. */
  form?: PolicyForm;
  refusal?: { text: string; field?: string };
  review?: { diff: Raw; add: number; del: number; base: string; rewritten: boolean; created: boolean };
}

/** A short hash of policy.yaml's text (null: no file), which a Save carries to say what it was reviewed against. */
export const policyHash = (s: string | null) => createHash("sha256").update(s ?? "\u0000none").digest("hex").slice(0, 16);

/** The capabilities as the form lists them: every one of the registry, the always-on ones marked. */
function capabilityRows(deps: ChatSettingsDeps): CapabilityRow[] {
  return deps.registry.map((c) => ({
    id: c.id,
    label: c.label,
    gives: c.gives,
    always: !!c.always,
    here: !deps.enabled || deps.enabled.has(c.id),
    ...(c.params ? { params: c.params } : {}),
    ...(c.delegable?.length ? { delegable: c.delegable } : {}),
  }));
}

/** The chat's Permissions: its entry (or what it would start as) as a form. */
export function loadPermissions(deps: ChatSettingsDeps, chat: { kind: "private" | "group"; tgChatId: number }, result?: ChatSettingsResult): PermissionsView {
  const text = readPolicyText(deps.home);
  const parsed = text === null || !text.trim() ? null : parsePolicy(text, deps.ownerId);
  const broken = parsed && "error" in parsed ? parsed.error : undefined;
  const policy: Policy = parsed && "policy" in parsed ? parsed.policy : { chats: {}, unknownChat: "ignore" };
  const key = chat.kind === "private" ? "dm" : String(chat.tgChatId);
  const resolved = resolveChat(policy, chat, deps.ownerId);
  const listed = !!policy.chats[key];
  // A group not listed starts from what the unknown-group card proposes for it (policy.ts `proposedGroupEntry`).
  const entry = resolved ?? proposedGroupEntry();
  const raw = rawEntry(text, key);
  const known = new Set([...deps.registry.map((c) => c.id), ...Object.keys(TOOL_ALIASES)]);
  const unknown = raw && raw.tools && typeof raw.tools === "object" && !Array.isArray(raw.tools) ? Object.keys(raw.tools).filter((n) => !known.has(n)) : [];
  return {
    key,
    ownerDm: key === "dm",
    listed,
    form: result?.form ?? formFromEntry(entry),
    caps: capabilityRows(deps),
    unknown,
    ...(result?.review ? { review: result.review } : {}),
    ...(result?.refusal ? { refusal: result.refusal } : {}),
    ...(result?.section === "permissions" && result.flash ? { flash: result.flash } : {}),
    ...(broken ? { broken } : {}),
  };
}

export function loadChatSettings(deps: ChatSettingsDeps, chatId: number, q: URLSearchParams, ctx: { timeZone: string; now: number; csrf: string; who?: string }, result?: ChatSettingsResult): ChatSettingsView | null {
  const { db } = deps;
  const chat = chatById(db, chatId);
  if (!chat) return null;
  const flashFor = (s: ChatSettingsResult["section"]) => (result?.section === s ? result.flash : undefined);

  // Model: the catalog by provider, in catalog order.
  const all = listModels(db);
  const def = defaultModel(db)?.id ?? null;
  // The console's chat row leaves the model out (queries.ts); the store's has it.
  const current = getChat(db, chatId)?.model ?? def;
  const groups: ModelGroup[] = [];
  for (const m of all) {
    let g = groups.find((x) => x.provider === m.provider.name);
    if (!g) groups.push((g = { provider: m.provider.name, kind: m.provider.kind === "claude" ? "Claude login" : "OpenAI-compatible", models: [] }));
    g.models.push({ id: m.id, ...(m.model.label ? { label: m.model.label } : {}), contextWindow: m.model.contextWindow, isDefault: m.model.isDefault, warned: probeWarned(m) });
  }
  let picked: Picked | undefined;
  const to = q.get("to");
  if (to) {
    try {
      const p = previewSwitch(db, chatId, to);
      if (p.noop) picked = { id: to, noop: `${chatName(chat)} is already on ${to}.` };
      else {
        const l = modeLines(p, ctx.now);
        picked = { id: to, lossless: l.lossless, lossy: l.lossy, running: l.running };
      }
    } catch (e) {
      picked = { id: to, error: e instanceof Error ? e.message : String(e) };
    }
  }
  let switching: Switching | undefined;
  const reqId = result?.switchRequest ?? (q.get("req") && /^\d+$/.test(q.get("req")!) ? Number(q.get("req")) : undefined);
  let switchFlash: Flash | undefined;
  if (reqId !== undefined) {
    const req = getSwitchRequest(db, reqId);
    if (req && req.chatId === chatId && req.status === "pending") switching = { to: req.toModel, mode: req.mode, requestId: req.id, stopping: req.stoppedTurnId };
    else if (req && req.chatId === chatId) switchFlash = switchResultFlash(db, req);
  }
  // A switch pending for the chat however it was asked (the control bot, another tab): the page follows it too.
  const pending = switching ? undefined : pendingSwitchRequests(db, chatId)[0];
  if (pending) switching = { to: pending.toModel, mode: pending.mode, requestId: pending.id, stopping: pending.stoppedTurnId };

  // Profile.
  const profiles = listProfiles(deps.home);
  const gone = !!chat.profile && !profiles.some((p) => p.name === chat.profile);

  // Conversation: the one the chat's last turn was in, unless the chat has none now (after /new, or never).
  let began: string | null = null;
  let how: string | undefined;
  let segments = 0;
  if (chat.backendSessionId) {
    const places = chatGrouping(db, chatId);
    const last = places.at(-1);
    const conv = last ? conversations(db, [last.conversationId]).get(last.conversationId) : undefined;
    if (conv) {
      began = conv.startedAt;
      how = conversationLabel(conv, "short");
      segments = conv.segments;
    }
  }
  const running = runningTurnFor(db, chatId);

  return {
    chat: { id: chat.id, name: chatName(chat), kind: chat.kind as "private" | "group", tgChatId: chat.tgChatId },
    timeZone: ctx.timeZone,
    now: ctx.now,
    csrf: ctx.csrf,
    pageKey: randomBytes(9).toString("base64url"),
    ...(ctx.who ? { who: ctx.who } : {}),
    model: { current, defaultId: def, groups, ...(picked && !switching ? { picked } : {}), ...(switching ? { switching } : {}), ...((switchFlash ?? flashFor("model")) ? { flash: switchFlash ?? flashFor("model")! } : {}) },
    profile: { current: chat.profile ?? null, gone, rows: profiles.map((p) => ({ name: p.name, ...(p.label ? { label: p.label } : {}), own: ownFiles(deps.home, p.name).length })), ...(flashFor("profile") ? { flash: flashFor("profile")! } : {}) },
    conversation: {
      began,
      ...(how ? { how } : {}),
      segments,
      contextTokens: chat.backendSessionId ? chat.contextTokens : null,
      ...(running ? { running: { id: running.id, startedAt: running.startedAt } } : {}),
      confirmNew: q.get("confirm") === "new",
      ...(flashFor("conversation") ? { flash: flashFor("conversation")! } : {}),
    },
    permissions: loadPermissions(deps, { kind: chat.kind as "private" | "group", tgChatId: chat.tgChatId }, result),
  };
}

/** A finished switch request as the page says it: the control bot's own line (model-cards.ts `switchResultText`). */
export function switchResultFlash(db: Db, req: NonNullable<ReturnType<typeof getSwitchRequest>>): Flash {
  const chat = chatById(db, req.chatId)!;
  return { tone: req.status === "failed" ? "failed" : "ok", text: switchResultText(chat, req) };
}
