import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

/**
 * SECRET REDACTION, for everything that might carry a secret value out of the machine: a chat computer's
 * output (src/capabilities/computer/), and the turn transcripts (src/agent/transcript.ts). Core, so the
 * runner child and the computer capability share it without one importing the other.
 *
 * The values come from the secret profiles (src/secrets/source.ts: SHUVI_SECRETS_FILE, default
 * /etc/shuvi.secrets.yaml, mode 600, and the profiles the owner keeps in the console; requests and grants are
 * src/capabilities/computer/secrets.ts) and from every value either ever held (`knownFile`). Every one of them
 * is replaced by `[REDACTED:<profile>]`. This module reads the file and the known file only; `redactionFor` and
 * `LiveRedaction`, which read the store too, are in source.ts.
 */

export type Profiles = Record<string, Record<string, string>>;

/** A value shorter than this is not redacted: it would mangle ordinary output (and is no secret). */
const MIN_REDACT = 4;

/** The profiles in the file, or why it cannot be used. A missing file is no profiles. */
export function loadProfiles(file: string): { profiles: Profiles } | { error: string } {
  let mode: number;
  try {
    mode = statSync(file).mode;
  } catch {
    return { profiles: {} };
  }
  if (mode & 0o077) return { error: `${file} is readable by others (mode ${(mode & 0o777).toString(8)}); make it mode 600` };
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { error: `${file} is not valid YAML: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` };
  }
  const profiles: Profiles = {};
  if (doc && typeof doc === "object") {
    for (const [name, vars] of Object.entries(doc as Record<string, unknown>)) {
      if (!vars || typeof vars !== "object") continue;
      profiles[name] = Object.fromEntries(Object.entries(vars as Record<string, unknown>).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && v != null).map(([k, v]) => [k, String(v)]));
    }
  }
  return { profiles };
}

/**
 * Everything that hides secret values from what the model and the chat see. Built from every value of every
 * profile in the secrets file AND every value ever seen there (the KNOWN file, `<secrets file>.known`, mode
 * 600, beside it, outside the store): a value rotated out of the file, or a file that turns unusable (bad
 * mode, bad YAML), still redacts what it redacted before. When the file cannot be used and nothing is known,
 * `ok` is false and all output is withheld rather than shown unredacted.
 *
 * CUTS: output is often a window of bytes (a log from an offset, its last N bytes, the head and tail kept of
 * a long stream). A cut through a value would leave part of it outside the reach of a plain search. So:
 *   - `window(buf, start, end)`: `buf` is read wider than the window by at least `maxLen` on each side; the
 *     window's edges are moved outward to take in any value they cut, then the window is redacted whole;
 *   - `cutEdges(text, left, right)`: where nothing more can be read (a stream's dropped middle), a partial
 *     value at a cut edge (a suffix of a value at the left, a prefix at the right) is removed.
 */
export interface Redaction {
  ok: boolean;
  /** Why output is withheld, when not ok. */
  why?: string;
  /** The longest known value, in bytes: how much wider than a window to read. */
  maxLen: number;
  redact(s: string): string;
  window(buf: Uint8Array, start: number, end: number): { text: string; start: number; end: number };
  cutEdges(text: string, left: boolean, right: boolean): string;
  /** The profile whose value `bytes` hold, if any ("?" when output is withheld: nothing may be sent). */
  contains(bytes: Uint8Array): string | null;
}

export const knownFile = (file: string) => `${file}.known`;

function readKnown(file: string): Record<string, string> {
  try {
    const path = knownFile(file);
    if (statSync(path).mode & 0o077) return {};
    const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    return doc && typeof doc === "object" ? doc : {};
  } catch {
    return {};
  }
}

/**
 * Add the values of `profiles` to the known file of `file` (value → profile), when any is new. False: a new one could
 * not be written there (a caller about to let a value go refuses rather than stop redacting it).
 */
export function rememberValues(file: string, profiles: Profiles): boolean {
  return remember(file, profiles, readKnown(file));
}

let warnedKnown = false;
/** Add the profiles' current values to the known file (value → profile), when any is new. */
function remember(file: string, profiles: Profiles, known: Record<string, string>): boolean {
  let changed = false;
  for (const [p, vars] of Object.entries(profiles)) {
    for (const v of Object.values(vars)) {
      if (v.length >= MIN_REDACT && known[v] !== p) {
        known[v] = p;
        changed = true;
      }
    }
  }
  if (!changed) return true;
  try {
    const tmp = `${knownFile(file)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(known), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, knownFile(file));
    return true;
  } catch (e) {
    if (!warnedKnown) console.error(`secrets: cannot write ${knownFile(file)} (${e instanceof Error ? e.message : String(e)}); values rotated out of ${file} will no longer be redacted`);
    warnedKnown = true;
    return false;
  }
}

/** A redaction over `pairs` (value → profile). */
export function redaction(known: Record<string, string>, withheld?: string): Redaction {
  // Each value also in the form JSON gives it (`"` and `\` escaped): a tool that prints its input or a
  // response as JSON carries the secret that way, and the raw value would not match it.
  const forms = Object.entries(known).flatMap(([v, p]) => {
    const json = JSON.stringify(v).slice(1, -1);
    return json === v ? [[v, p] as const] : [[v, p] as const, [json, p] as const];
  });
  const pairs = forms.filter(([v]) => v.length >= MIN_REDACT).sort((a, b) => b[0].length - a[0].length);
  const values = pairs.map(([v]) => Buffer.from(v));
  const maxLen = Math.max(0, ...values.map((v) => v.length));
  const redact = (s: string) => {
    if (withheld) return `[output withheld: ${withheld}; it cannot be shown without hiding the secrets in it]`;
    let out = s;
    for (const [v, p] of pairs) if (out.includes(v)) out = out.split(v).join(`[REDACTED:${p}]`);
    return out;
  };
  return {
    ok: !withheld,
    ...(withheld ? { why: withheld } : {}),
    maxLen,
    redact,
    window(bytes, start, end) {
      const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let a = Math.max(0, start);
      let b = Math.min(buf.length, end);
      for (let moved = true; moved; ) {
        moved = false;
        for (const v of values) {
          for (let i = buf.indexOf(v); i >= 0; i = buf.indexOf(v, i + 1)) {
            const e = i + v.length;
            if (i < a && a < e) (a = i), (moved = true);
            if (i < b && b < e) (b = e), (moved = true);
          }
        }
      }
      return { text: redact(buf.subarray(a, b).toString("utf8")), start: a, end: b };
    },
    cutEdges(text, left, right) {
      let t = text;
      for (const [v] of pairs) {
        for (let n = Math.min(v.length - 1, t.length); n > 0; n--) {
          if (left && t.startsWith(v.slice(-n))) {
            t = t.slice(n);
            break;
          }
        }
        for (let n = Math.min(v.length - 1, t.length); n > 0; n--) {
          if (right && t.endsWith(v.slice(0, n))) {
            t = t.slice(0, -n);
            break;
          }
        }
      }
      return t;
    },
    contains(bytes) {
      if (withheld) return "?";
      const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (const [v, p] of pairs) if (buf.includes(v)) return p;
      return null;
    },
  };
}

/**
 * The redaction for `loaded` (every profile now, source.ts `allProfiles`, or why the file cannot be used), and
 * every value the known file beside `file` holds; the values in `loaded` are added to it.
 */
export function redactionOf(file: string, loaded: { profiles: Profiles } | { error: string }): Redaction {
  const known = readKnown(file);
  if ("profiles" in loaded) {
    remember(file, loaded.profiles, known);
    return redaction(known);
  }
  // Unusable: the values known so far still redact; with none known, output is withheld.
  return Object.keys(known).length ? redaction(known) : redaction({}, `the secrets file is unusable (${loaded.error})`);
}

/** Replace every value in `profiles` (tests, and callers with profiles in hand). */
export function redactor(profiles: Profiles): (s: string) => string {
  return redaction(Object.fromEntries(Object.entries(profiles).flatMap(([p, vars]) => Object.values(vars).map((v) => [v, p])))).redact;
}
