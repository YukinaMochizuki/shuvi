import type { Capability, PolicyParam } from "../capabilities/types.ts";
import { DM_DEFAULT, ENTRY_KEYS, GROUP_DEFAULTS, TOOL_ALIASES, TOP_KEYS, TRIGGERS } from "./policy.ts";

/**
 * What policy.yaml can say, described for the model, in the manner of `kubectl explain` (and Hangar's
 * `hangar explain`): `explain_policy(path?)` (capabilities/groups/) answers from here, read_policy ends
 * with `catalogue`, and propose_policy checks an entry's tools with `checkTools` before any card is sent.
 *
 * Everything is generated from two sources, so the descriptions cannot drift from what is enforced:
 *   - the file's own fields, below (TOP_FIELDS, ENTRY_FIELDS), whose names a test holds equal to the keys
 *     ./policy.ts accepts (TOP_KEYS, ENTRY_KEYS), and whose defaults are read from DM_DEFAULT and
 *     GROUP_DEFAULTS;
 *   - each capability's own metadata (capabilities/types.ts `label`, `gives`, `params`, `ownerOnly`),
 *     which is also what the owner's /policy shows (./view.ts).
 *
 * Paths: `chats.<entry>.trigger`, or just `trigger`; `tools.workstream`, or just `workstream`;
 * `tools.workstream.products`, or `workstream.products`. An unknown path answers with the valid ones near it.
 * Pure: the registry is passed in, so this module never imports the capabilities.
 */

export interface FieldDoc {
  name: string;
  type: string;
  meaning: string;
  values?: readonly string[];
  default?: string;
}

const words = (v: unknown): string => (Array.isArray(v) ? `[${v.join(", ")}]` : typeof v === "object" && v !== null ? (Object.keys(v).length ? JSON.stringify(v) : "{} (none)") : String(v));

export const TOP_FIELDS: readonly FieldDoc[] = [
  { name: "owner", type: "integer", meaning: "The owner's Telegram user id. Optional; when present it must be the server's SHUVI_OWNER_ID, or the file is refused." },
  {
    name: "chats",
    type: "map[string]ChatEntry",
    meaning: 'One entry per chat, keyed "dm" for the owner\'s DM, or by a group\'s Telegram chat id (a negative number, quoted). Without a "dm" entry the DM has its defaults.',
  },
  { name: "unknown_chat", type: "enum", values: ["ignore"], default: "ignore", meaning: "A group not listed in chats: nothing it says is recorded, and the owner gets a card once asking whether to add it." },
];

export const ENTRY_FIELDS: readonly FieldDoc[] = [
  { name: "title", type: "string", meaning: "The chat's name, for people reading the file and the owner's /policy. Optional." },
  {
    name: "trigger",
    type: '"all" | []enum',
    values: ["all", ...TRIGGERS],
    default: `dm: ${words(DM_DEFAULT.trigger)}; group: ${words(GROUP_DEFAULTS.trigger)}`,
    meaning: "Which messages wake you. all: every message. mention: a message naming you. reply: a reply to one of your messages. followup: a message from someone you just answered, within followup_minutes of your last message.",
  },
  { name: "followup_minutes", type: "number", default: String(GROUP_DEFAULTS.followupMinutes), meaning: "How long after your last message a follow-up still wakes you (with trigger followup). A positive number." },
  {
    name: "persona",
    type: "[]enum",
    values: ["public", "private"],
    default: `dm: ${words(DM_DEFAULT.persona)}; group: ${words(GROUP_DEFAULTS.persona)}`,
    meaning: "Which persona layers this chat's prompt has. private: the owner's DM only.",
  },
  {
    name: "memory",
    type: "[]enum",
    values: ["private", "chat"],
    default: `dm: ${words(DM_DEFAULT.memory)}; group: ${words(GROUP_DEFAULTS.memory)}`,
    meaning: "Which memory this chat sees. chat: this chat's own notes. private: your private memory, the owner's DM only.",
  },
  {
    name: "tools",
    type: '"all" | map[string]Parameters',
    default: `dm: ${words(DM_DEFAULT.tools)}; group: ${words(GROUP_DEFAULTS.tools)}`,
    meaning: `Which capabilities this chat has, by id, each with its parameters ({} for none); all: every one. Always-on capabilities are on whatever this says. Aliases: ${Object.entries(TOOL_ALIASES)
      .map(([a, ids]) => `${a} = ${ids.join(" + ")}`)
      .join(", ")}.`,
  },
];

// Held equal to what policy.ts accepts; a test checks it too, this throws at load if they ever differ.
for (const [docs, keys] of [
  [TOP_FIELDS, TOP_KEYS],
  [ENTRY_FIELDS, ENTRY_KEYS],
] as const) {
  const names = docs.map((f) => f.name);
  if (names.length !== keys.size || !names.every((n) => keys.has(n))) throw new Error(`policy/explain.ts documents ${names.join(", ")}, but policy.ts accepts ${[...keys].join(", ")}`);
}

type Registry = readonly Capability<any>[];

/** The capability `name` names in policy (an id, or an alias that stands for exactly one). */
function capabilityNamed(registry: Registry, name: string): Capability<any> | undefined {
  const ids = TOOL_ALIASES[name] ?? [name];
  return ids.length === 1 ? registry.find((c) => c.id === ids[0]) : undefined;
}

const typeName = (p: PolicyParam) => (p.type === "string[]" ? "[]string" : p.type);

/** Read_policy's closing section: one line per capability. */
export function catalogue(registry: Registry): string {
  const lines = registry.map((c) => `- ${c.id}: ${c.label}${c.always ? " [always on]" : ""}. ${c.gives}`);
  return ["Capabilities (the ids `tools` takes; explain_policy(\"tools.<id>\") for one in detail):", ...lines].join("\n");
}

function fieldDoc(path: string, f: FieldDoc, extra: string[] = []): string {
  const out = [`FIELD:    ${path} <${f.type}>`, "", "DESCRIPTION:", `    ${f.meaning}`];
  if (f.values) out.push("", "VALUES:", ...f.values.map((v) => `    ${v}`));
  if (f.default) out.push("", "DEFAULT:", `    ${f.default}`);
  return [...out, ...extra].join("\n");
}

function fieldList(fields: readonly FieldDoc[]): string[] {
  return fields.flatMap((f) => [`  ${f.name}\t<${f.type}>`, `    ${f.meaning}`, ""]);
}

function rootDoc(): string {
  return [
    "FILE:     home/policy.yaml",
    "",
    "DESCRIPTION:",
    "    What each chat may do. Changed only by the owner's approval (propose_policy).",
    "",
    "FIELDS:",
    ...fieldList(TOP_FIELDS),
    "ChatEntry (chats.<entry>):",
    ...fieldList(ENTRY_FIELDS),
    'explain_policy("trigger") for one field, explain_policy("tools") for the capabilities.',
  ].join("\n");
}

function example(c: Capability<any>): string {
  const params = Object.entries(c.params ?? {});
  const body = params.length ? `{ ${params.map(([n, p]) => `${n}: ${Array.isArray(p.example) ? `[${p.example.join(", ")}]` : String(p.example)}`).join(", ")} }` : "{}";
  return ["tools:", `  ${c.id}: ${body}`].map((l) => `    ${l}`).join("\n");
}

function capabilityDoc(c: Capability<any>): string {
  const params = Object.entries(c.params ?? {});
  const out = [`CAPABILITY: ${c.id}`, `LABEL:      ${c.label}`, `PATH:       chats.<entry>.tools.${c.id}`, "", "GIVES:", `    ${c.gives}`];
  if (c.always) out.push("", "ALWAYS ON:", "    On in every chat, whatever tools says.");
  out.push("", "PARAMETERS:");
  if (params.length) for (const [n, p] of params) out.push(`  ${n}\t<${typeName(p)}>`, `    ${p.meaning}`, `    default: ${p.default}`, "");
  else out.push("    none ({})", "");
  out.push("OWNER-ONLY TOOLS:", `    ${c.ownerOnly?.length ? c.ownerOnly.join(", ") : "none"}`, "", "EXAMPLE:", example(c));
  const aliases = Object.entries(TOOL_ALIASES).filter(([, ids]) => ids.includes(c.id));
  if (aliases.length) out.push("", "ALSO NAMED:", ...aliases.map(([a, ids]) => `    ${a} (= ${ids.join(" + ")})`));
  return out.join("\n");
}

function paramDoc(c: Capability<any>, name: string, p: PolicyParam): string {
  return fieldDoc(`chats.<entry>.tools.${c.id}.${name}`, { name, type: typeName(p), meaning: p.meaning, default: p.default }, ["", "EXAMPLE:", example(c)]);
}

/** Levenshtein distance, for "did you mean". */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

/** The closest of `options` to `name`, when it is close enough to be a likely typo. */
export function closest(name: string, options: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const o of options) {
    const dist = distance(name.toLowerCase(), o.toLowerCase());
    if (dist < bestD) [best, bestD] = [o, dist];
  }
  return best !== undefined && bestD <= Math.max(2, Math.floor(name.length / 3)) ? best : undefined;
}

function unknown(where: string, name: string, options: readonly string[]): { error: string } {
  if (!options.length) return { error: `${where} has no "${name}": nothing is below ${where}. explain_policy("${where}") describes it.` };
  // Compare the name with each option's own last part (`products` of `tools.workstream.products`).
  const last = (o: string) => o.slice(o.lastIndexOf(".") + 1);
  const near = closest(name, options.map(last));
  const full = near === undefined ? undefined : options.find((o) => last(o) === near);
  return { error: `${where} has no "${name}"${full ? `; did you mean ${full}?` : "."} Valid here: ${options.join(", ")}.` };
}

/** Every path explain_policy answers (for tests and the "valid paths" of an unknown one). */
export function explainablePaths(registry: Registry): string[] {
  return [
    "",
    ...TOP_FIELDS.map((f) => f.name),
    "chats.<entry>",
    ...ENTRY_FIELDS.map((f) => f.name),
    ...registry.flatMap((c) => [`tools.${c.id}`, ...Object.keys(c.params ?? {}).map((p) => `tools.${c.id}.${p}`)]),
  ];
}

/**
 * explain_policy's answer for `path` ("" or absent: the file's structure). `{ error }` for a path that
 * names nothing, with the valid paths near it.
 */
export function explainPolicy(registry: Registry, path = ""): { text: string } | { error: string } {
  let segs = path
    .trim()
    .replace(/^policy(\.yaml)?\.?/, "")
    .split(".")
    .filter(Boolean);
  if (!segs.length) return { text: rootDoc() };

  const top = TOP_FIELDS.find((f) => f.name === segs[0]);
  if (top && top.name !== "chats") return segs.length === 1 ? { text: fieldDoc(top.name, top) } : unknown(top.name, segs[1]!, []);
  if (top) {
    if (segs.length === 1) return { text: fieldDoc("chats", top, ["", "ChatEntry FIELDS:", ...fieldList(ENTRY_FIELDS)]) };
    if (segs.length === 2) return { text: ["KIND:     ChatEntry (chats.<entry>)", "", "FIELDS:", ...fieldList(ENTRY_FIELDS)].join("\n") };
    segs = segs.slice(2); // chats.<entry>.<field>…
  }

  const ids = registry.map((c) => c.id);
  let cap: Capability<any> | undefined;
  let rest: string[];
  if (segs[0] === "tools") {
    const tools = ENTRY_FIELDS.find((f) => f.name === "tools")!;
    if (segs.length === 1) return { text: fieldDoc("chats.<entry>.tools", tools, ["", catalogue(registry)]) };
    cap = capabilityNamed(registry, segs[1]!);
    if (!cap) return TOOL_ALIASES[segs[1]!] ? { text: fieldDoc("chats.<entry>.tools", tools, ["", catalogue(registry)]) } : unknown("tools", segs[1]!, ids);
    rest = segs.slice(2);
  } else {
    const field = ENTRY_FIELDS.find((f) => f.name === segs[0]);
    // A bare name that is both a field and a capability (`memory`) is the field; the capability is tools.<id>.
    const also = registry.some((c) => c.id === field?.name) ? ["", "SEE ALSO:", `    tools.${field!.name} (the capability of that name)`] : [];
    if (field) return segs.length === 1 ? { text: fieldDoc(`chats.<entry>.${field.name}`, field, also) } : unknown(field.name, segs[1]!, []);
    cap = capabilityNamed(registry, segs[0]!);
    if (!cap) return unknown("policy", segs[0]!, [...TOP_FIELDS.map((f) => f.name), ...ENTRY_FIELDS.map((f) => f.name), ...ids.map((i) => `tools.${i}`)]);
    rest = segs.slice(1);
  }
  if (!rest.length) return { text: capabilityDoc(cap) };
  const p = cap.params?.[rest[0]!];
  if (!p || rest.length > 1) return unknown(`tools.${cap.id}`, rest.join("."), Object.keys(cap.params ?? {}).map((n) => `tools.${cap.id}.${n}`));
  return { text: paramDoc(cap, rest[0]!, p) };
}

const see = (path: string) => ` (see explain_policy("${path}"))`;

function typeOk(p: PolicyParam, v: unknown): boolean {
  if (p.type === "string[]") return Array.isArray(v) && v.every((x) => typeof x === "string");
  return typeof v === p.type;
}

/**
 * Check an entry's `tools`, as proposed (before aliases are expanded), against the capabilities this
 * build has: unknown ids, unknown parameters, parameters of the wrong type. Null when it is fine. The
 * file itself keeps an unknown name (a file written for a later build), but a proposal must not add one.
 */
export function checkTools(registry: Registry, tools: unknown): string | null {
  if (tools === undefined || tools === null || tools === "all" || typeof tools !== "object" || Array.isArray(tools)) return null; // the shape is checkEntry's
  const ids = registry.map((c) => c.id);
  const names = [...ids, ...Object.keys(TOOL_ALIASES)];
  for (const [name, params] of Object.entries(tools as Record<string, unknown>)) {
    const caps = (TOOL_ALIASES[name] ?? [name]).map((id) => registry.find((c) => c.id === id));
    if (caps.some((c) => !c)) {
      const near = closest(name, names);
      return `tools: "${name}" is not a capability${near ? ` (did you mean ${near}?)` : ""}. Valid: ${names.join(", ")}${see("tools")}`;
    }
    if (params === null || params === undefined) continue;
    if (typeof params !== "object" || Array.isArray(params)) return `tools.${name} must be a mapping of its parameters ({} for none)${see(`tools.${caps[0]!.id}`)}`;
    for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
      for (const c of caps as Capability<any>[]) {
        const p = c.params?.[k];
        const declared = Object.keys(c.params ?? {});
        if (!p) return `tools.${name}: "${k}" is not a parameter of ${c.id}; it takes ${declared.length ? declared.join(", ") : "none ({})"}${see(`tools.${c.id}`)}`;
        if (!typeOk(p, v)) return `tools.${name}.${k} must be ${p.type === "string[]" ? "a list of text" : `a ${p.type}`}, e.g. ${JSON.stringify(p.example)}${see(`tools.${c.id}.${k}`)}`;
      }
    }
  }
  return null;
}
