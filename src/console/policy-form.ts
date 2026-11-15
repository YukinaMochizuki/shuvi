import type { Capability } from "../capabilities/types.ts";
import { checkDelegate, checkTools } from "../policy/explain.ts";
import { checkEntry, DM_DEFAULT, GROUP_DEFAULTS, TOOL_ALIASES, TRIGGERS, type ChatEntry, type Trigger } from "../policy/policy.ts";

/** A posted form, as far as this reads it (a `FormData`). */
export interface MultiForm {
  get(name: string): unknown;
  getAll(name: string): unknown[];
  entries(): IterableIterator<[string, unknown]>;
}

/**
 * The Permissions form of a chat's settings page (chat-settings.ts draws it): one chat's entry in policy.yaml as
 * form fields, and a posted form back into an entry, checked by the policy parser itself (policy.ts `checkEntry`)
 * and, for the capabilities it names, by the same check a proposal gets (explain.ts `checkTools`,
 * `checkDelegate`). Pure.
 *
 * The fields: `title`; `trigger_mode` (all | some) with `trigger` (mention, reply, followup) and
 * `followup_minutes`; `persona`, `memory`; `tools_mode` (all | some) with `tool` (a capability id per box ticked)
 * and `param.<id>.<name>` (a parameter, as text: a list is comma-separated); `operators_mode` (none | members |
 * ids) with `operator_ids`, and `delegate`. A form holds what was posted as it was typed, so a refused one is
 * drawn again exactly as the owner left it.
 *
 * WHAT IS WRITTEN is as close to the file as it was as the change allows: a field the entry did not write is
 * left out while it still says the default, names the file gave that this build does not know are kept as they
 * were, and an alias (`chat`: memory and retrieval) stays one while both of its capabilities stay on with the same
 * parameters.
 */

export interface PolicyForm {
  title: string;
  triggerMode: "all" | "some";
  triggers: string[];
  followupMinutes: string;
  persona: string[];
  memory: string[];
  toolsMode: "all" | "some";
  tools: string[];
  /** `<id>.<name>` → the text typed. */
  params: Record<string, string>;
  operatorsMode: "none" | "members" | "ids";
  operatorIds: string;
  delegate: string[];
}

type Registry = readonly Capability<any>[];

const asText = (v: unknown): string => (Array.isArray(v) ? v.map(String).join(", ") : v === undefined || v === null ? "" : String(v));

/** The form for an entry (as the parser resolved it). */
export function formFromEntry(e: ChatEntry): PolicyForm {
  const params: Record<string, string> = {};
  if (e.tools !== "all") for (const [id, ps] of Object.entries(e.tools)) for (const [k, v] of Object.entries(ps)) params[`${id}.${k}`] = asText(v);
  return {
    title: e.title ?? "",
    triggerMode: e.trigger === "all" ? "all" : "some",
    triggers: e.trigger === "all" ? [...TRIGGERS] : [...e.trigger],
    followupMinutes: String(e.followupMinutes),
    persona: [...e.persona],
    memory: [...e.memory],
    toolsMode: e.tools === "all" ? "all" : "some",
    tools: e.tools === "all" ? [] : Object.keys(e.tools),
    params,
    operatorsMode: !e.operators ? "none" : e.operators === "members" ? "members" : "ids",
    operatorIds: Array.isArray(e.operators) ? e.operators.join(", ") : "",
    delegate: [...e.delegate],
  };
}

const all = (form: MultiForm, name: string) => form.getAll(name).filter((v): v is string => typeof v === "string");
const one = (form: MultiForm, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};

/** The form as posted. */
export function formFromPost(form: MultiForm): PolicyForm {
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (k.startsWith("param.") && typeof v === "string") params[k.slice("param.".length)] = v;
  const om = one(form, "operators_mode");
  return {
    title: one(form, "title"),
    triggerMode: one(form, "trigger_mode") === "all" ? "all" : "some",
    triggers: all(form, "trigger"),
    followupMinutes: one(form, "followup_minutes"),
    persona: all(form, "persona"),
    memory: all(form, "memory"),
    toolsMode: one(form, "tools_mode") === "all" ? "all" : "some",
    tools: all(form, "tool"),
    params,
    operatorsMode: om === "members" || om === "ids" ? om : "none",
    operatorIds: one(form, "operator_ids"),
    delegate: all(form, "delegate"),
  };
}

/** A parameter typed as text → its value, by the type the capability declares. */
function paramValue(c: Capability<any> | undefined, name: string, text: string): unknown {
  const t = c?.params?.[name]?.type ?? "string";
  const s = text.trim();
  if (t === "string[]") return s ? s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean) : [];
  if (t === "number") return s === "" ? s : /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s;
  if (t === "boolean") return s === "true" || s === "yes" || s === "on" ? true : s === "false" || s === "no" || s === "off" || s === "" ? false : s;
  return s;
}

/** The field a reason is about, for the form to mark (policy.ts's `field`, or a check's leading `tools.x` / `delegate`). */
function fieldOf(reason: string, field?: string): string | undefined {
  if (field) return field;
  const m = /^(tools(?:\.[\w-]+)?|delegate|operators)\b/.exec(reason);
  return m?.[1];
}

/** Drop the pointer at explain_policy a check adds for the model: the owner reads the form, not that tool. */
const forOwner = (reason: string) => reason.replace(/ \(see explain_policy\("[^"]*"\)\)/g, "").replace(/^chats\.(?:dm|"[^"]*")\./, "");

/**
 * The entry a posted form describes, as it is to be written under `key`; or the parser's reason it is not one,
 * and the field it is about. `raw`: the entry as the file has it now (undefined: not listed).
 */
export function entryFromForm(f: PolicyForm, key: string, raw: Record<string, unknown> | undefined, registry: Registry): { doc: Record<string, unknown> } | { error: string; field?: string } {
  const base: ChatEntry = key === "dm" ? DM_DEFAULT : GROUP_DEFAULTS;
  const had = (k: string) => !!raw && k in raw;
  const doc: Record<string, unknown> = {};
  const title = f.title.trim();
  if (title) doc.title = title;

  const trigger: "all" | string[] = f.triggerMode === "all" ? "all" : (TRIGGERS as readonly string[]).filter((t) => f.triggers.includes(t)).concat(f.triggers.filter((t) => !(TRIGGERS as readonly string[]).includes(t)));
  if (had("trigger") || JSON.stringify(trigger) !== JSON.stringify(base.trigger)) doc.trigger = trigger;
  if (trigger !== "all" && trigger.includes("followup" satisfies Trigger)) {
    const s = f.followupMinutes.trim();
    const n = /^\d+(\.\d+)?$/.test(s) ? Number(s) : s;
    if (had("followup_minutes") || n !== base.followupMinutes) doc.followup_minutes = n;
  } else if (had("followup_minutes")) doc.followup_minutes = raw!.followup_minutes;

  const persona = (["public", "private"] as string[]).filter((p) => f.persona.includes(p)).concat(f.persona.filter((p) => p !== "public" && p !== "private"));
  if (had("persona") || JSON.stringify(persona) !== JSON.stringify(base.persona)) doc.persona = persona;
  const memory = (["private", "chat"] as string[]).filter((m) => f.memory.includes(m)).concat(f.memory.filter((m) => m !== "private" && m !== "chat"));
  if (had("memory") || JSON.stringify(memory) !== JSON.stringify(base.memory)) doc.memory = memory;

  // Tools: the ones ticked, with their parameters; the names the file has that this build does not know, kept.
  let tools: "all" | Record<string, Record<string, unknown>>;
  if (f.toolsMode === "all") tools = "all";
  else {
    const rawTools = raw && raw.tools && typeof raw.tools === "object" && !Array.isArray(raw.tools) ? (raw.tools as Record<string, unknown>) : {};
    const known = new Set(registry.map((c) => c.id));
    // A name this build has no capability for is the file's own business while the file already gives it to this
    // chat (kept below as it is); a form naming any other one was not drawn by this page, and is refused.
    const stranger = f.tools.find((id) => !known.has(id) && !(id in rawTools));
    if (stranger !== undefined) return { error: `tools: "${stranger}" is not a capability of this build`, field: "tools" };
    const byId: Record<string, Record<string, unknown>> = {};
    for (const id of f.tools.filter((x) => known.has(x))) {
      const c = registry.find((x) => x.id === id);
      const ps: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(f.params)) {
        const [pid, name] = [k.slice(0, k.indexOf(".")), k.slice(k.indexOf(".") + 1)];
        if (pid !== id || !name) continue;
        // An empty parameter is left out: it then means its default ("any product").
        if (v.trim() === "") continue;
        ps[name] = paramValue(c, name, v);
      }
      byId[id] = ps;
    }
    const picked: Record<string, Record<string, unknown>> = {};
    tools = picked;
    // In the order the file lists them, so an unchanged line stays where it was; new ones after.
    const take = (id: string) => {
      if (byId[id]) picked[id] = byId[id]!;
      delete byId[id];
    };
    for (const [name, ps] of Object.entries(rawTools)) {
      const ids = TOOL_ALIASES[name];
      if (ids) {
        // An alias stays one while each of its capabilities is on with what the alias gave it.
        const p = ps && typeof ps === "object" ? ps : {};
        if (ids.every((id) => byId[id] && JSON.stringify(byId[id]) === JSON.stringify(p))) {
          picked[name] = p as Record<string, unknown>;
          for (const id of ids) delete byId[id];
        } else ids.forEach(take);
      } else if (!known.has(name)) picked[name] = (ps ?? {}) as Record<string, unknown>;
      else take(name);
    }
    for (const [id, ps] of Object.entries(byId)) picked[id] = ps;
  }
  if (had("tools") || JSON.stringify(tools) !== JSON.stringify(base.tools)) doc.tools = tools;

  if (f.operatorsMode !== "none") {
    doc.operators =
      f.operatorsMode === "members"
        ? "members"
        : f.operatorIds
            .split(/[,\s]+/)
            .filter(Boolean)
            .map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  }
  if (f.delegate.length || had("delegate")) doc.delegate = [...f.delegate];
  if (doc.delegate && (doc.delegate as string[]).length === 0 && !doc.operators) delete doc.delegate;

  const r = checkEntry(key, doc);
  if ("error" in r) return { error: forOwner(r.error), ...(fieldOf(r.error, r.field) ? { field: fieldOf(r.error, r.field)! } : {}) };
  // The capabilities the form names must be ones this build has, with parameters of the right type; a name the
  // file already had that this build does not know is the file's own business and is left alone.
  const named = tools === "all" ? tools : Object.fromEntries(Object.entries(tools).filter(([n]) => registry.some((c) => c.id === n) || TOOL_ALIASES[n]));
  const bad = checkTools(registry, named) ?? checkDelegate(registry, doc.delegate);
  if (bad) return { error: forOwner(bad), ...(fieldOf(bad) ? { field: fieldOf(bad)! } : {}) };
  return { doc };
}
