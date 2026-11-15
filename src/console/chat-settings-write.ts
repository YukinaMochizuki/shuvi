import { randomBytes } from "node:crypto";
import { commitHomeEdit, StaleEdit } from "../capabilities/memory/home.ts";
import type { Capability } from "../capabilities/types.ts";
import { consoleSwitch } from "../control/model-cards.ts";
import { rawEntry, replaceEntry } from "../policy/edit.ts";
import { POLICY_FILE, readPolicyText } from "../policy/load.ts";
import { parsePolicy } from "../policy/policy.ts";
import { stopTurn } from "../server/commands.ts";
import type { SignalTurn } from "../server/spawn.ts";
import type { Db } from "../store/db.ts";
import { forgetConversations } from "../store/events.ts";
import { HISTORY_ON_NEW } from "../agent/turn.ts";
import { policyHash, type ChatSettingsResult } from "./chat-settings-data.ts";
import { brokenText } from "./chat-settings.ts";
import { ghDiff } from "./ghdiff.ts";
import { switchChatProfile } from "./home-write.ts";
import { href } from "./html.ts";
import { chatName } from "./pages.ts";
import { entryFromForm, formFromPost, type MultiForm } from "./policy-form.ts";
import { chatById } from "./queries.ts";

/**
 * The writes of a chat's settings page (chat-settings.ts), each a POST to `/chats/<id>/settings/<verb>` through the
 * console's write boundary (server.ts: POST only, the Origin, the CSRF token), answered with a 303 back to the page
 * and its result kept in memory, read once (`?r=<id>`, at most KEEP_MAX for KEEP_MS, as Home's results):
 *
 *   switch   asks for the switch exactly as the control bot's mode step does (control/model-cards.ts
 *            `consoleSwitch`: a switch card with no message, the same `requestSwitch`, finished by the same
 *            `switchCardPass`; the chat's open bot cards are closed as superseded). The server stops a running
 *            turn, then switches; the page follows the request (`/chats/<id>/settings/switching?req=`, a read)
 *            until it is done, and then shows its result once.
 *   profile  switches the chat's profile (home-write.ts `switchChatProfile`).
 *   stop     as `/stop` (server/commands.ts `stopTurn`): the running turn is stopped where the chat's log is now,
 *            so what arrived meanwhile is answered by the next turn. `turn` names the turn the page showed; a
 *            different one running by then is not stopped.
 *   new      as `/new`: a running turn is stopped, then every conversation of the chat is forgotten
 *            (`forgetConversations`); the next turn opens with the last HISTORY_ON_NEW messages.
 *   policy   the chat's entry in policy.yaml, from the Permissions form (policy-form.ts). `action=review` checks it
 *            with the policy parser and answers the diff; `action=save` writes it, as ONE commit in home/ authored
 *            as the owner from the console (`commitHomeEdit`, `by.console`, `expect`: the text it was decided on),
 *            only if the file is still the one reviewed (`base`, its hash); `action=edit` goes back to the form.
 *            The entry is replaced in place (policy/edit.ts): the file's comments and the other chats' entries are
 *            kept. A form the parser refuses comes back as it was typed, with its reason; nothing is written. The
 *            server's policy loop (policy/load.ts `PolicyWatch`) takes the new file up within seconds.
 */

export const CHAT_SETTINGS_WRITE = /^\/chats\/(\d+)\/settings\/(switch|profile|stop|new|policy)$/;

const KEEP_MS = 10 * 60_000;
const KEEP_MAX = 20;
const results = new Map<string, ChatSettingsResult & { at: number }>();

export function keepResult(now: number, r: ChatSettingsResult): string {
  for (const [k, v] of results) if (now - v.at > KEEP_MS) results.delete(k);
  while (results.size >= KEEP_MAX) results.delete(results.keys().next().value!);
  const id = randomBytes(9).toString("base64url");
  results.set(id, { ...r, at: now });
  return id;
}

/** A write's result by its id, once; only on the page of the chat it is about. */
export function takeSettingsResult(id: string | null, chatId: number, now: number): ChatSettingsResult | undefined {
  if (!id) return undefined;
  const r = results.get(id);
  if (!r || r.chatId !== chatId) return undefined;
  results.delete(id);
  return now - r.at <= KEEP_MS ? r : undefined;
}

export interface ChatSettingsWriteDeps {
  db: Db;
  home: string;
  ownerId?: number;
  registry: readonly Capability<any>[];
  /** Who is signed in (the tailnet login), for the commit's trailer. */
  login?: string;
  signal?: SignalTurn;
  now: number;
}

const text = (form: MultiForm, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};

/** The seq of the chat's latest event: where a stop from the console happens in its log. */
function lastSeq(db: Db, chatId: number): number {
  return (db.$client.query("select coalesce(max(seq), 0) as s from chat_events where chat_id = ?").get(chatId) as { s: number }).s;
}

/** Run one write; returns where to send the browser. */
export function chatSettingsWrite(deps: ChatSettingsWriteDeps, chatId: number, verb: string, form: MultiForm): string {
  const { db, now } = deps;
  const back = (r: Omit<ChatSettingsResult, "chatId">) => `${href(`/chats/${chatId}/settings`, { r: keepResult(now, { ...r, chatId }) })}#${r.section}`;
  const chat = chatById(db, chatId);
  if (!chat) return href("/turns");
  const label = chatName(chat);
  switch (verb) {
    case "switch": {
      const to = text(form, "to");
      const mode = text(form, "mode");
      if (mode !== "lossless" && mode !== "lossy") return back({ section: "model", flash: { tone: "refused", text: "Pick Lossless or Lossy." } });
      // The page's key (chat-settings.ts `pageKey`): posted twice, the switch is asked for once.
      const key = /^[\w-]{8,40}$/.test(text(form, "key")) ? text(form, "key") : randomBytes(9).toString("base64url");
      const r = consoleSwitch(db, chatId, to, mode, key);
      if ("error" in r) return back({ section: "model", flash: { tone: "refused", text: r.error } });
      if ("already" in r) return back({ section: "model", flash: { tone: "ok", text: r.already } });
      return back({ section: "model", switchRequest: r.request.id });
    }
    case "profile":
      return back({ section: "profile", flash: switchChatProfile(db, deps.home, chatId, text(form, "profile") || null) });
    case "stop": {
      const asked = Number(text(form, "turn"));
      const running = db.$client.query("select id from turns where chat_id = ? and status = 'running'").get(chatId) as { id: number } | null;
      if (!running) return back({ section: "conversation", flash: { tone: "ok", text: "No turn is running: nothing to stop." } });
      if (asked && running.id !== asked) return back({ section: "conversation", flash: { tone: "refused", text: `Turn ${asked} has ended; turn ${running.id} is running now. Stop it again if you mean that one.` } });
      const stopped = stopTurn(db, chatId, lastSeq(db, chatId), deps.signal);
      return back({ section: "conversation", flash: { tone: "ok", text: stopped ? `Stopped turn ${stopped.id}. What she already sent stays.` : "No turn is running: nothing to stop." } });
    }
    case "new": {
      const stopped = stopTurn(db, chatId, lastSeq(db, chatId), deps.signal);
      forgetConversations(db, chatId);
      return back({
        section: "conversation",
        flash: { tone: "ok", text: `${stopped ? `Stopped turn ${stopped.id}; ` : ""}${label} starts a new conversation: her next turn here opens with the chat's last ${HISTORY_ON_NEW} messages.` },
      });
    }
    case "policy":
      return back(policyWrite(deps, { kind: chat.kind as "private" | "group", tgChatId: chat.tgChatId, label }, form));
    default:
      return href(`/chats/${chatId}/settings`);
  }
}

/** The Permissions form posted: back to the form, the diff, a refusal, or the commit (see the header). */
function policyWrite(deps: ChatSettingsWriteDeps, chat: { kind: "private" | "group"; tgChatId: number; label: string }, form: MultiForm): Omit<ChatSettingsResult, "chatId"> {
  const section = "permissions" as const;
  const f = formFromPost(form);
  const action = text(form, "action");
  if (action === "edit") return { section, form: f };
  if (deps.ownerId === undefined) return { section, form: f, refusal: { text: "The owner is not configured (SHUVI_OWNER_ID), so policy.yaml cannot be written." } };
  // A private chat is only ever the owner's DM (policy.ts): its entry is `dm`.
  const key = chat.kind === "private" ? "dm" : String(chat.tgChatId);
  const before = readPolicyText(deps.home);
  if (before !== null && before.trim()) {
    const p = parsePolicy(before, deps.ownerId);
    if ("error" in p) return { section, form: f, refusal: { text: brokenText(p.error) } };
  }
  const r = entryFromForm(f, key, rawEntry(before, key), deps.registry);
  if ("error" in r) return { section, form: f, refusal: { text: r.error, ...(r.field ? { field: r.field } : {}) } };
  const edit = replaceEntry(before, key, r.doc, deps.ownerId);
  if ("error" in edit) return { section, form: f, refusal: { text: edit.error } };
  if (edit.text === before) return { section, flash: { tone: "ok", text: `No change: ${POLICY_FILE} already says that. Nothing was written.` } };
  const review = (): Omit<ChatSettingsResult, "chatId"> => {
    const d = ghDiff(before ?? "", edit.text, { name: `home/${POLICY_FILE}`, context: 3 });
    return { section, form: f, review: { diff: d.html, add: d.add, del: d.del, base: policyHash(before), rewritten: edit.rewritten, created: before === null } };
  };
  if (action !== "save") return review();
  if (text(form, "base") !== policyHash(before)) {
    return { ...review(), flash: { tone: "refused", text: `${POLICY_FILE} changed after you reviewed it. Here is the change against the file as it is now; save again if it is still what you want.` } };
  }
  try {
    const commit = commitHomeEdit(deps.home, POLICY_FILE, edit.text, `Policy: ${chat.label}, from the console`, { console: deps.login ? { login: deps.login } : {}, expect: before });
    return { section, flash: { tone: "ok", text: `Saved ${POLICY_FILE} (commit ${commit}). It applies from her next turn here, once the server has reloaded it (within seconds).` } };
  } catch (e) {
    if (e instanceof StaleEdit) return { ...review(), flash: { tone: "refused", text: `${POLICY_FILE} changed while saving. Here is the change against the file as it is now; save again if it is still what you want.` } };
    return { section, form: f, refusal: { text: `Not written: ${e instanceof Error ? e.message : String(e)}` } };
  }
}
