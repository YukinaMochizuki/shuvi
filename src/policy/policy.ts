/**
 * Each chat's permissions (docs/design.md §8): what `home/policy.yaml` says, parsed and checked. Pure: no
 * file, no store. Loading it (and keeping the last good one) is ./load.ts; changing it, only through the
 * owner's approval, is ./write.ts.
 *
 *   # home/policy.yaml
 *   owner: 1001                    # optional; when present it must be SHUVI_OWNER_ID
 *   chats:
 *     dm:                          # the owner's DM. Absent: DM_DEFAULT, which is how the DM always worked
 *       persona: [public, private]
 *       memory:  [private, chat]
 *       tools:   all
 *     "-1001234567890":            # a group, by its Telegram chat id
 *       title: Friends             # optional, for people reading the file
 *       trigger: [mention, reply, followup]   # or `all`: every message starts a turn
 *       followup_minutes: 3
 *       persona: [public]
 *       memory:  [chat]
 *       tools:
 *         web: {}
 *         retrieval: {}
 *         computer: {}
 *         workstream: { products: [widgetry] }
 *       operators: [2002, 2003]    # or `members`: who besides the owner may ask for delegated tools
 *       delegate: [computer]       # whose delegable owner-only tools operators may ask for
 *   unknown_chat: ignore           # a group not listed: nothing recorded; the owner is asked once
 *
 * The rules this module keeps:
 *   - The owner's DM always works: with no file, or a file without `dm`, it gets DM_DEFAULT, which is
 *     exactly what it had before policy existed. A `dm` entry may narrow it.
 *   - Privacy is structural: `private` persona and memory layers are refused outside the owner's DM, as a
 *     broken file (the last good policy stays), never quietly dropped.
 *   - `tools` names capabilities by id (src/capabilities/index.ts), each with its parameters (`{}` for
 *     none), or `all`. Two names from the design are accepted as aliases: `chat` (memory and retrieval:
 *     this chat's notes and its log) and `workstream-read` (workstream). A name no capability in this
 *     build has is kept, and does nothing, so a file written for a later build is not broken by it. Speech
 *     and the other capabilities marked `always` are on in every chat whatever `tools` says.
 *   - A group listed with no `tools` gets none beyond the always-on ones; with no `trigger`, a mention, a
 *     reply or a follow-up.
 *   - OPERATORS (design §8): a group may name people besides the owner (`operators`: user ids, or
 *     `members`, everyone in it but bots) who may ask for the owner-only tools of the capabilities in
 *     `delegate`, and only those each capability declares delegable (capabilities/types.ts `delegable`).
 *     Who acts is still decided per call by the turn's boundary (agent/turn.ts `callAuthority`). Both are
 *     for groups only, go together (one without the other is a broken file), and `delegate` names only
 *     capabilities the entry's `tools` enables (or any, with `tools: all`).
 */

export const TRIGGERS = ["mention", "reply", "followup"] as const;
export type Trigger = (typeof TRIGGERS)[number];
export type PersonaLayer = "public" | "private";
export type MemoryLayer = "private" | "chat";

/** Parameters policy passes a capability (`{}` for none). */
export type ToolParams = Record<string, unknown>;

export interface ChatEntry {
  title?: string;
  /** `all`: every message starts a turn (the DM). Otherwise only these. */
  trigger: "all" | Trigger[];
  followupMinutes: number;
  persona: PersonaLayer[];
  memory: MemoryLayer[];
  /** `all`, or capability id → parameters. */
  tools: "all" | Record<string, ToolParams>;
  /** Who besides the owner may ask for delegated tools: everyone but bots, or these user ids. Absent: nobody. */
  operators?: Operators;
  /** The capabilities (ids) whose delegable owner-only tools operators may ask for. */
  delegate: string[];
}

export type Operators = "members" | number[];

/**
 * The user id Telegram gives a post auto-forwarded from a linked channel into its discussion group ("Telegram",
 * not a bot). It is nobody in the group, so never an operator, `members` or not.
 */
export const TELEGRAM_SERVICE_ID = 777000;

/** Is `userId` (a message's sender, not a bot) one of `operators`? */
export function isOperator(operators: Operators | undefined, userId: number): boolean {
  if (!operators || userId === TELEGRAM_SERVICE_ID) return false;
  return operators === "members" || operators.includes(userId);
}

/**
 * May files `userId` sends in Telegram chat `tgChatId` be copied into that chat's computer? The owner's, as
 * always; in a group that delegates its computer to its operators (`delegate: [computer]`), theirs too.
 * Bots never (the caller passes `isBot`).
 */
export function filesCopiedFrom(policy: Policy, tgChatId: number, from: { id: number; isBot?: boolean }, ownerId: number): boolean {
  if (from.id === ownerId) return true;
  if (from.isBot) return false;
  const entry = policy.chats[String(tgChatId)];
  return !!entry && tgChatId < 0 && entry.delegate.includes("computer") && isOperator(entry.operators, from.id);
}

export interface Policy {
  owner?: number;
  /** `dm`, or a Telegram chat id as a string. */
  chats: Record<string, ChatEntry>;
  unknownChat: "ignore";
}

/** One chat's policy, resolved: its entry, and whether it is the owner's DM. */
export interface ChatPolicy extends ChatEntry {
  /** The key it is listed under (`dm`, or the chat id). */
  key: string;
  ownerDm: boolean;
}

export const DEFAULT_FOLLOWUP_MINUTES = 3;

export const DM_DEFAULT: ChatEntry = { trigger: "all", followupMinutes: DEFAULT_FOLLOWUP_MINUTES, persona: ["public", "private"], memory: ["private", "chat"], tools: "all", delegate: [] };

export const GROUP_DEFAULTS: ChatEntry = { trigger: [...TRIGGERS] as Trigger[], followupMinutes: DEFAULT_FOLLOWUP_MINUTES, persona: ["public"] as PersonaLayer[], memory: ["chat"] as MemoryLayer[], tools: {}, delegate: [] };

/** Policy names for capabilities, as the design writes them → capability ids. */
export const TOOL_ALIASES: Record<string, string[]> = { chat: ["memory", "retrieval"], "workstream-read": ["workstream"] };

/** The policy when there is no file: the owner's DM, as it always was, and nothing else. */
export function defaultPolicy(): Policy {
  return { chats: {}, unknownChat: "ignore" };
}

/** The entry a group the owner approves from the unknown-chat card starts with. */
export function proposedGroupEntry(title?: string): ChatEntry {
  return {
    ...(title ? { title } : {}),
    ...GROUP_DEFAULTS,
    tools: { web: {}, vision: {}, memory: {}, retrieval: {}, playbooks: {} },
  };
}

/**
 * The policy for one chat, or null when it has none (a group not listed, a private chat that is not the
 * owner's). `ownerId` undefined: any private chat counts as the owner's DM (only the owner's DM is ever
 * recorded, telegram/inbound.ts).
 */
export function resolveChat(policy: Policy, chat: { kind: "private" | "group"; tgChatId: number }, ownerId?: number): ChatPolicy | null {
  if (chat.kind === "private") {
    if (ownerId !== undefined && chat.tgChatId !== ownerId) return null;
    return { ...(policy.chats.dm ?? DM_DEFAULT), key: "dm", ownerDm: true };
  }
  const entry = policy.chats[String(chat.tgChatId)];
  return entry ? { ...entry, key: String(chat.tgChatId), ownerDm: false } : null;
}

/** Whether a group is listed. */
export function listsGroup(policy: Policy, tgChatId: number): boolean {
  return !!policy.chats[String(tgChatId)];
}

// ---- parsing -----------------------------------------------------------------------------------------

/** A broken file or entry. `field`: the entry field it is about (`trigger`, `tools`), for explain_policy. */
class Invalid extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}
const fail = (m: string, field?: string): never => {
  throw new Invalid(m, field);
};

function list<T extends string>(v: unknown, allowed: readonly T[], where: string, field?: string): T[] {
  if (!Array.isArray(v)) fail(`${where} must be a list of ${allowed.join(" / ")}`, field);
  for (const x of v as unknown[]) if (!allowed.includes(x as T)) fail(`${where}: "${String(x)}" is not one of ${allowed.join(" / ")}`, field);
  return [...new Set(v as T[])];
}

function object(v: unknown, where: string, field?: string): Record<string, unknown> {
  if (v === null || v === undefined) return {};
  if (typeof v !== "object" || Array.isArray(v)) fail(`${where} must be a mapping`, field);
  return v as Record<string, unknown>;
}

/** The fields of a chat's entry, as the file writes them (src/policy/explain.ts documents each). */
export const ENTRY_KEYS: ReadonlySet<string> = new Set(["title", "trigger", "followup_minutes", "persona", "memory", "tools", "operators", "delegate"]);

/** One chat's entry, as written in the file, checked. Throws `Invalid`. */
function parseEntry(key: string, raw: unknown): ChatEntry {
  const where = key === "dm" ? "chats.dm" : `chats."${key}"`;
  const r = object(raw, where);
  for (const k of Object.keys(r)) if (!ENTRY_KEYS.has(k)) fail(`${where}: unknown key "${k}" (known: ${[...ENTRY_KEYS].join(", ")})`);
  const base = key === "dm" ? DM_DEFAULT : GROUP_DEFAULTS;

  let trigger: ChatEntry["trigger"] = base.trigger;
  if (r.trigger !== undefined) trigger = r.trigger === "all" ? "all" : list(r.trigger, TRIGGERS, `${where}.trigger`, "trigger");

  let followupMinutes = base.followupMinutes;
  if (r.followup_minutes !== undefined) {
    if (typeof r.followup_minutes !== "number" || !(r.followup_minutes > 0)) fail(`${where}.followup_minutes must be a positive number`, "followup_minutes");
    followupMinutes = r.followup_minutes as number;
  }

  const persona = r.persona === undefined ? base.persona : list(r.persona, ["public", "private"] as const, `${where}.persona`, "persona");
  const memory = r.memory === undefined ? base.memory : list(r.memory, ["private", "chat"] as const, `${where}.memory`, "memory");
  if (key !== "dm" && persona.includes("private")) fail(`${where}.persona: private is for the owner's DM only; in a group persona may only be [public]`, "persona");
  if (key !== "dm" && memory.includes("private")) fail(`${where}.memory: private is for the owner's DM only; in a group memory may only be [chat]`, "memory");

  let tools: ChatEntry["tools"] = base.tools;
  if (r.tools !== undefined) {
    if (r.tools === "all") tools = "all";
    else {
      tools = {};
      for (const [name, params] of Object.entries(object(r.tools, `${where}.tools`, "tools"))) {
        const p = object(params, `${where}.tools.${name}`, `tools.${name}`);
        for (const id of TOOL_ALIASES[name] ?? [name]) tools[id] = { ...(tools[id] ?? {}), ...p };
      }
    }
  }

  let operators: Operators | undefined;
  if (r.operators !== undefined) {
    if (key === "dm") fail(`${where}.operators: the owner's DM is the owner's alone; operators are for groups`, "operators");
    if (r.operators === "members") operators = "members";
    else {
      if (!Array.isArray(r.operators)) fail(`${where}.operators must be members or a list of Telegram user ids`, "operators");
      const ids = (r.operators as unknown[]).map((x) => (typeof x === "string" && /^\d+$/.test(x) ? Number(x) : x));
      for (const id of ids) if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) fail(`${where}.operators: "${String(id)}" is not a Telegram user id`, "operators");
      operators = [...new Set(ids as number[])];
    }
  }
  let delegate: string[] = [];
  if (r.delegate !== undefined) {
    if (key === "dm") fail(`${where}.delegate: the owner's DM is the owner's alone; delegate is for groups`, "delegate");
    if (!Array.isArray(r.delegate) || (r.delegate as unknown[]).some((x) => typeof x !== "string")) fail(`${where}.delegate must be a list of capability names`, "delegate");
    for (const name of r.delegate as string[]) for (const id of TOOL_ALIASES[name] ?? [name]) if (!delegate.includes(id)) delegate.push(id);
    if (tools !== "all") for (const id of delegate) if (tools[id] === undefined) fail(`${where}.delegate: ${id} is not in this entry's tools, so there is nothing of it to delegate`, "delegate");
  }
  if (delegate.length && !operators) fail(`${where}.delegate: nobody to delegate to; name the operators (members, or user ids)`, "delegate");
  if (operators && !delegate.length) fail(`${where}.operators: nothing is delegated to them; list the capabilities in delegate`, "operators");

  if (r.title !== undefined && typeof r.title !== "string") fail(`${where}.title must be text`, "title");
  return { ...(typeof r.title === "string" ? { title: r.title } : {}), trigger, followupMinutes, persona, memory, tools, ...(operators ? { operators } : {}), delegate };
}

/** The top-level keys of the file. */
export const TOP_KEYS: ReadonlySet<string> = new Set(["owner", "chats", "unknown_chat"]);

/**
 * Parse and check policy.yaml's text. `ownerId` is SHUVI_OWNER_ID: a file naming another owner is
 * refused. An empty file is the default policy.
 */
export function parsePolicy(text: string, ownerId?: number): { policy: Policy } | { error: string } {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch (e) {
    return { error: `it does not parse as YAML (${e instanceof Error ? e.message : String(e)})` };
  }
  try {
    return { policy: policyFromDoc(doc, ownerId) };
  } catch (e) {
    if (e instanceof Invalid) return { error: e.message };
    throw e;
  }
}

/** The policy a parsed YAML document describes. Throws `Invalid` (an Error) when it is not one. */
export function policyFromDoc(doc: unknown, ownerId?: number): Policy {
  const top = object(doc, "the file");
  for (const k of Object.keys(top)) if (!TOP_KEYS.has(k)) fail(`unknown top-level key "${k}" (known: owner, chats, unknown_chat)`);
  const policy: Policy = defaultPolicy();
  if (top.owner !== undefined) {
    const owner = typeof top.owner === "string" && /^\d+$/.test(top.owner) ? Number(top.owner) : top.owner;
    if (typeof owner !== "number" || !Number.isSafeInteger(owner)) fail("owner must be a Telegram user id");
    if (ownerId !== undefined && owner !== ownerId) fail(`owner is ${String(owner)}, but SHUVI_OWNER_ID is ${ownerId}`);
    policy.owner = owner as number;
  }
  if (top.unknown_chat !== undefined && top.unknown_chat !== "ignore") fail(`unknown_chat: "${String(top.unknown_chat)}" is not supported (only "ignore")`);
  for (const [key, raw] of Object.entries(object(top.chats, "chats"))) {
    if (key !== "dm" && !/^-?\d+$/.test(key)) fail(`chats: "${key}" must be dm or a Telegram chat id`);
    if (key !== "dm" && Number(key) > 0) fail(`chats: "${key}" is a private chat; only the owner's DM (dm) and groups can be listed`);
    policy.chats[key] = parseEntry(key, raw);
  }
  return policy;
}

/**
 * Whether a value (a parsed entry) is a valid entry for `key`; the reason when not, and the entry field it
 * is about when it is about one (`trigger`, `tools.web`).
 */
export function checkEntry(key: string, raw: unknown): { entry: ChatEntry } | { error: string; field?: string } {
  try {
    if (key !== "dm" && !/^-?\d+$/.test(key)) fail(`"${key}" must be dm or a Telegram chat id`);
    return { entry: parseEntry(key, raw) };
  } catch (e) {
    if (e instanceof Invalid) return { error: e.message, ...(e.field ? { field: e.field } : {}) };
    throw e;
  }
}

/** An entry as it is written in the file (the inverse of parseEntry, up to aliases). */
export function entryToDoc(e: ChatEntry): Record<string, unknown> {
  return {
    ...(e.title ? { title: e.title } : {}),
    trigger: e.trigger,
    ...(e.trigger !== "all" ? { followup_minutes: e.followupMinutes } : {}),
    persona: e.persona,
    memory: e.memory,
    tools: e.tools,
    ...(e.operators ? { operators: e.operators, delegate: e.delegate } : {}),
  };
}

/** What a chat's triggers are, in words (the group's prompt section, the approval card). */
export function describeTriggers(t: ChatEntry["trigger"], followupMinutes: number): string {
  if (t === "all") return "every message";
  const words = t.map((x) => (x === "mention" ? "a mention of you" : x === "reply" ? "a reply to one of your messages" : `a follow-up from someone you just answered (within ${followupMinutes} min of your last message)`));
  return words.length ? words.join(", ") : "nothing (you are never woken by a message here)";
}
