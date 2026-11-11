import type { Capability, PolicyParam } from "../capabilities/types.ts";
import { DM_DEFAULT, TOOL_ALIASES, type ChatEntry, type Policy, type ToolParams } from "./policy.ts";

/**
 * The owner's view of the policy in effect, for the control bot's `/policy` (control/bot.ts): one block
 * per chat, the owner's DM first, in words and Telegram HTML, never YAML. `/policy <chat>` shows one chat
 * with the capabilities that are off too, so the owner sees what could be turned on.
 *
 * What a capability is called comes from the capability itself (its `label` and `params`,
 * capabilities/types.ts), the same metadata the model's explain_policy reads (./explain.ts), so a new
 * capability cannot be missing here. Pure: the registry, the titles the store knows and the set of
 * capabilities enabled in this process are passed in.
 */

export interface PolicyViewInput {
  policy: Policy;
  /** Every registered capability, in registry order (capabilities/index.ts `CAPABILITIES`). */
  registry: readonly Capability<any>[];
  /** The ids enabled in this process; absent: all of the registry. */
  enabled?: ReadonlySet<string>;
  /** The owner's Telegram user id (the DM's chat id). */
  ownerId?: number;
  /** A group's title as the store knows it, for an entry without one. */
  titleOf?: (tgChatId: number) => string | undefined;
}

/** Telegram's limit is 4096 characters after entities; messages are cut well under it, between blocks. */
export const VIEW_PART_LIMIT = 3500;

export const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface Listed {
  /** The number /policy shows, from 1. */
  n: number;
  key: string;
  entry: ChatEntry;
  title: string;
  /** The Telegram id, when known. */
  tgId?: number;
}

/** The chats in the order /policy lists them: the owner's DM, then the groups as the file lists them. */
export function listedChats(input: PolicyViewInput): Listed[] {
  const { policy, ownerId, titleOf } = input;
  const out: Listed[] = [{ n: 1, key: "dm", entry: policy.chats.dm ?? DM_DEFAULT, title: "Your DM", ...(ownerId !== undefined ? { tgId: ownerId } : {}) }];
  for (const [key, entry] of Object.entries(policy.chats)) {
    if (key === "dm") continue;
    const tgId = Number(key);
    out.push({ n: out.length + 1, key, entry, title: entry.title ?? titleOf?.(tgId) ?? "Untitled group", tgId });
  }
  return out;
}

/** The chat `arg` names: its number in the list, its Telegram id, or "dm". */
export function findListed(input: PolicyViewInput, arg: string): Listed | undefined {
  const chats = listedChats(input);
  const a = arg.trim().toLowerCase();
  if (a === "dm") return chats[0];
  if (!/^-?\d+$/.test(a)) return undefined;
  const n = Number(a);
  return chats.find((c) => c.n === n && n > 0 && n <= chats.length) ?? chats.find((c) => c.tgId === n || c.key === a);
}

function wakes(e: ChatEntry): string {
  if (e.trigger === "all") return "every message";
  if (!e.trigger.length) return "nothing (never woken by a message)";
  return e.trigger.map((t) => (t === "mention" ? "mention" : t === "reply" ? "reply" : `follow-up (${e.followupMinutes} min)`)).join(", ");
}

function wakesInDetail(e: ChatEntry): string {
  if (e.trigger === "all") return "every message";
  if (!e.trigger.length) return "nothing: she is never woken by a message here";
  return e.trigger
    .map((t) => (t === "mention" ? "a message that mentions her" : t === "reply" ? "a reply to one of her messages" : `a follow-up from someone she just answered, within ${e.followupMinutes} min`))
    .join("; ");
}

const PERSONA_WORDS = { public: "public persona", private: "private side" } as const;
const MEMORY_WORDS = { private: "private memory", chat: "this chat's notes" } as const;

function sees(e: ChatEntry): string[] {
  return [...e.persona.map((p) => PERSONA_WORDS[p]), ...e.memory.map((m) => MEMORY_WORDS[m])];
}

function paramValue(p: PolicyParam | undefined, v: unknown): string {
  if (Array.isArray(v)) return v.length ? v.map(String).join(", ") : "none";
  if (p?.type === "boolean" || typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "object" && v !== null) return Object.keys(v).join(", ");
  return String(v);
}

/** One capability as a line: its label, then its parameters in words ("products: widgetry"). */
function capabilityLine(c: Capability<any>, params: ToolParams | undefined): string {
  const ps = Object.entries(params ?? {}).map(([k, v]) => `${k}: ${paramValue(c.params?.[k], v)}`);
  return escapeHtml(ps.length ? `${c.label}, ${ps.join("; ")}` : c.label);
}

interface ToolsInWords {
  on: { c: Capability<any>; params?: ToolParams }[];
  off: Capability<any>[];
  always: Capability<any>[];
  /** Enabled by policy but not set up in this process. */
  notHere: Capability<any>[];
  /** Names policy lists that this build has no capability for. */
  unknown: string[];
}

function toolsOf(input: PolicyViewInput, e: ChatEntry): ToolsInWords {
  const { registry, enabled } = input;
  const here = (c: Capability<any>) => !enabled || enabled.has(c.id);
  const out: ToolsInWords = { on: [], off: [], always: [], notHere: [], unknown: [] };
  for (const c of registry) {
    if (c.always) {
      if (here(c)) out.always.push(c);
      continue;
    }
    const params = e.tools === "all" ? {} : e.tools[c.id];
    if (params === undefined) out.off.push(c);
    else if (!here(c)) out.notHere.push(c);
    else out.on.push({ c, params });
  }
  if (e.tools !== "all") {
    const known = new Set([...registry.map((c) => c.id), ...Object.keys(TOOL_ALIASES)]);
    out.unknown = Object.keys(e.tools).filter((k) => !known.has(k));
  }
  return out;
}

function title(l: Listed): string {
  return `<b>${l.n}. ${escapeHtml(l.title)}</b>${l.tgId !== undefined ? `  <i>${l.tgId}</i>` : ""}`;
}

function block(input: PolicyViewInput, l: Listed): string {
  const e = l.entry;
  const t = toolsOf(input, e);
  const lines = [title(l), `<b>Wakes her:</b> ${wakes(e)}`, `<b>Sees:</b> ${escapeHtml(sees(e).join(", ") || "only this chat's messages")}`];
  if (!t.on.length) lines.push(`<b>Can use:</b> nothing beyond talking`);
  else lines.push(`<b>Can use${e.tools === "all" ? " (everything)" : ""}:</b>`, ...t.on.map(({ c, params }) => `• ${capabilityLine(c, params)}`));
  if (t.notHere.length) lines.push(`<i>Listed but not set up on this server: ${escapeHtml(t.notHere.map((c) => c.label).join(", "))}</i>`);
  return lines.join("\n");
}

const UNKNOWN_CHATS = "<b>Unknown groups:</b> ignored. Nothing they say is kept; you get one card asking whether to add each.";

/** Cut blocks into messages under the limit, never inside a block. */
export function packMessages(blocks: string[], limit = VIEW_PART_LIMIT): string[] {
  const out: string[] = [];
  let cur = "";
  for (const b of blocks) {
    const piece = b.length > limit ? `${b.slice(0, limit - 1)}…` : b;
    if (cur && cur.length + 2 + piece.length > limit) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n\n${piece}` : piece;
  }
  if (cur) out.push(cur);
  return out;
}

/** What `/policy` says: every chat, one block each, as messages of Telegram HTML. */
export function policyOverview(input: PolicyViewInput): string[] {
  const chats = listedChats(input);
  const head = `<b>Policy</b>: ${chats.length} chat${chats.length === 1 ? "" : "s"}`;
  return packMessages([head, ...chats.map((l) => block(input, l)), UNKNOWN_CHATS, `<i>/policy &lt;number&gt; for one chat in detail, with what is off.</i>`]);
}

/** What `/policy <chat>` says: one chat in more detail, with the capabilities that are off. */
export function policyDetail(input: PolicyViewInput, l: Listed): string[] {
  const e = l.entry;
  const t = toolsOf(input, e);
  const seen = sees(e);
  const unseen = [...(["public", "private"] as const).filter((p) => !e.persona.includes(p)).map((p) => PERSONA_WORDS[p]), ...(["private", "chat"] as const).filter((m) => !e.memory.includes(m)).map((m) => MEMORY_WORDS[m])];
  const lines = [
    title(l),
    `<i>${l.key === "dm" ? 'listed as "dm"' : `listed as "${escapeHtml(l.key)}"`} in policy.yaml${l.key === "dm" && !input.policy.chats.dm ? " (not listed: its defaults)" : ""}</i>`,
    "",
    `<b>Wakes her:</b> ${escapeHtml(wakesInDetail(e))}`,
    `<b>Sees:</b> ${escapeHtml(seen.join(", ") || "only this chat's messages")}`,
  ];
  if (unseen.length) lines.push(`<b>Does not see:</b> ${escapeHtml(unseen.join(", "))}${l.key === "dm" ? "" : " (private layers are never seen in a group)"}`);
  lines.push("", `<b>On${e.tools === "all" ? " (everything)" : ""}:</b>`);
  if (t.on.length) lines.push(...t.on.map(({ c, params }) => `• ${capabilityLine(c, params)}`));
  else lines.push("• nothing beyond talking");
  if (t.notHere.length) lines.push("", "<b>Listed, but not set up on this server:</b>", ...t.notHere.map((c) => `• ${escapeHtml(c.label)}`));
  if (t.off.length) lines.push("", "<b>Off:</b>", ...t.off.map((c) => `• ${escapeHtml(c.label)}`));
  if (t.always.length) lines.push("", `<b>Always on:</b> ${escapeHtml(t.always.map((c) => c.label).join(", "))}`);
  if (t.unknown.length) lines.push("", `<b>Not known to this build</b> (does nothing): ${escapeHtml(t.unknown.join(", "))}`);
  return packMessages(lines.join("\n").split("\n\n"));
}
