import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Inbound sources (docs/design.md §10): external systems the assistant did not start (a monitoring alert,
 * say) that POST to `/inbound/<source>` and land in a configured chat as `external` events.
 *
 * WHERE EACH PART LIVES, and why:
 *   - What a source is (its name, the chat it lands in, whether it starts a turn) is declared in
 *     `home/inbound.yaml`, next to the rest of the assistant's configuration. It is read on every request,
 *     so an edit takes effect without a restart.
 *   - Its token is in the server's environment, `SHUVI_INBOUND_<NAME>_TOKEN` (the name upper-cased, any
 *     character outside A-Z 0-9 as `_`), and NEVER in home/: home/ is something the assistant edits, and a
 *     secret it can read is a secret it can say. A source declared without a token in the environment is
 *     not reachable (404), the same as an undeclared one.
 *
 *   # home/inbound.yaml
 *   sources:
 *     grafana:
 *       chat: dm          # "dm" (the owner's DM) or a Telegram chat id
 *       trigger: true     # default true; false: recorded for the next turn, but starts none
 */

export interface InboundSource {
  name: string;
  /** "dm", or a Telegram chat id. */
  chat: "dm" | number;
  trigger: boolean;
}

export const INBOUND_FILE = "inbound.yaml";

/** `SHUVI_INBOUND_<NAME>_TOKEN` for a source name. */
export function inboundTokenVar(name: string): string {
  return `SHUVI_INBOUND_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN`;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * The sources declared in `home/inbound.yaml`. A malformed entry is skipped with a log line rather than
 * failing every source; a file that does not parse yields none (and is logged). Two names that map to the
 * same token variable (`backup-log` and `backup_log`) are BOTH refused: one token must not open two
 * sources, and which one was meant cannot be told.
 */
export function loadInboundSources(home: string): Map<string, InboundSource> {
  const out = new Map<string, InboundSource>();
  const path = join(home, INBOUND_FILE);
  if (!existsSync(path)) return out;
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`inbound: ${path} does not parse:`, e instanceof Error ? e.message : e);
    return out;
  }
  const sources = (doc as { sources?: unknown } | null)?.sources;
  if (!sources || typeof sources !== "object") return out;
  for (const [name, raw] of Object.entries(sources as Record<string, unknown>)) {
    const r = (raw ?? {}) as { chat?: unknown; trigger?: unknown };
    if (!NAME.test(name)) {
      console.error(`inbound: source name "${name}" must be lowercase letters, digits, - and _`);
      continue;
    }
    const chat = r.chat === "dm" ? "dm" : typeof r.chat === "number" && Number.isSafeInteger(r.chat) ? r.chat : typeof r.chat === "string" && /^-?\d+$/.test(r.chat) ? Number(r.chat) : null;
    if (chat === null) {
      console.error(`inbound: source "${name}" needs chat: dm or a Telegram chat id`);
      continue;
    }
    out.set(name, { name, chat, trigger: r.trigger === undefined ? true : r.trigger === true });
  }
  const byVar = new Map<string, string[]>();
  for (const name of out.keys()) byVar.set(inboundTokenVar(name), [...(byVar.get(inboundTokenVar(name)) ?? []), name]);
  for (const [v, names] of byVar) {
    if (names.length < 2) continue;
    console.error(`inbound: sources ${names.map((n) => `"${n}"`).join(", ")} would share ${v}; none of them is reachable until renamed`);
    for (const n of names) out.delete(n);
  }
  return out;
}

/** The token variables present in `env` (captured once, at startup, like every capability's config). */
export function inboundTokens(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (/^SHUVI_INBOUND_.+_TOKEN$/.test(k) && v) out[k] = v;
  return out;
}

/** The text an inbound body becomes: a JSON object's `text` / `message`, else the body itself. Clipped. */
export function inboundText(body: string, contentType: string | null, max = 4000): string {
  let text = body.trim();
  if (contentType?.includes("json")) {
    try {
      const j = JSON.parse(body) as unknown;
      if (typeof j === "string") text = j;
      else if (j && typeof j === "object") {
        const o = j as Record<string, unknown>;
        text = typeof o.text === "string" ? o.text : typeof o.message === "string" ? o.message : JSON.stringify(j);
      }
    } catch {
      // not JSON after all: the raw body is the text
    }
  }
  return text.length > max ? `${text.slice(0, max)}…(cut)` : text;
}
