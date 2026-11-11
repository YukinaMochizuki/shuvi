import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { requestApproval } from "../../control/approvals.ts";
import type { Db } from "../../store/db.ts";
import { getChat } from "../../store/events.ts";
import { approvals, secretGrants } from "../../store/schema.ts";
import { chatLabel, IMMEDIATE } from "../../store/turns.ts";

/**
 * Secrets for a chat's computer, profile A of docs/design.md §15.
 *
 *   PROFILES   named sets of environment variables in a host-side YAML file outside home/ and git
 *              (SHUVI_SECRETS_FILE, default /etc/shuvi.secrets.yaml), which must be mode 600 (no group or
 *              other bits): a file anyone else can read is refused, not used.
 *
 *                  # /etc/shuvi.secrets.yaml
 *                  modal:
 *                    MODAL_TOKEN_ID: ak-...
 *                    MODAL_TOKEN_SECRET: as-...
 *
 *              It is read when needed, never cached, so an edit counts at the next exec. Only profile and
 *              variable NAMES ever leave this module towards the model, a card, or the store.
 *   REQUEST    `request_secret(profile, ttl, reason)` puts an approval card to the owner in the control bot
 *              (control/approvals.ts), naming the variables, never their values, with the ttl asked for
 *              and buttons for 4h / 1d / 3d or deny. The answer wakes the chat with an `approval` event.
 *   GRANT      one per approved card (`secret_grants`, keyed on the approval), for that chat only, until
 *              its ttl from the answer. Made from the answered card by whichever process looks first
 *              (`syncGrants`, run before every exec and by the server's loop), which also puts a "Revoke
 *              now" card in the control bot: pressing it ends the grant at once.
 *   USE        a live grant's values go into the `env` of the exec calls in that chat (hangar/client.ts):
 *              never into a file, the container's spec, or the store.
 *   REDACTION  every value of every profile in the file, and every value it ever held, is replaced by
 *              `[REDACTED:<profile>]` in any output before the model or the chat sees it (`Redaction`):
 *              exec output, job logs and results, file captions, also where output is cut at a byte offset.
 *              A file to be sent that holds a value is refused. With nothing to redact by, output is withheld.
 */

export type Profiles = Record<string, Record<string, string>>;
export const TTLS = { "4h": 4 * 3600_000, "1d": 24 * 3600_000, "3d": 72 * 3600_000 } as const;
export type Ttl = keyof typeof TTLS;
export const SECRET_KIND = "secret";
export const REVOKE_KIND = "secret-revoke";
/** A value shorter than this is not redacted: it would mangle ordinary output (and is no secret). */
const MIN_REDACT = 4;
/** How long the owner has to answer a request card. */
const CARD_TTL_MS = 24 * 3600_000;

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

let warnedKnown = false;
/** Add the file's current values to the known file (value → profile), when any is new. */
function remember(file: string, profiles: Profiles, known: Record<string, string>): void {
  let changed = false;
  for (const [p, vars] of Object.entries(profiles)) {
    for (const v of Object.values(vars)) {
      if (v.length >= MIN_REDACT && known[v] !== p) {
        known[v] = p;
        changed = true;
      }
    }
  }
  if (!changed) return;
  try {
    const tmp = `${knownFile(file)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(known), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, knownFile(file));
  } catch (e) {
    if (!warnedKnown) console.error(`secrets: cannot write ${knownFile(file)} (${e instanceof Error ? e.message : String(e)}); values rotated out of ${file} will no longer be redacted`);
    warnedKnown = true;
  }
}

/** A redaction over `pairs` (value → profile). */
export function redaction(known: Record<string, string>, withheld?: string): Redaction {
  const pairs = Object.entries(known)
    .filter(([v]) => v.length >= MIN_REDACT)
    .sort((a, b) => b[0].length - a[0].length);
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

/** The redaction for the secrets file as it is now, and every value it ever held. */
export function redactionFor(file: string): Redaction {
  const known = readKnown(file);
  const r = loadProfiles(file);
  if ("profiles" in r) {
    remember(file, r.profiles, known);
    return redaction(known);
  }
  // Unusable: the values known so far still redact; with none known, output is withheld.
  return Object.keys(known).length ? redaction(known) : redaction({}, `the secrets file is unusable (${r.error})`);
}

/** Replace every value in `profiles` (tests, and callers with profiles in hand). */
export function redactor(profiles: Profiles): (s: string) => string {
  return redaction(Object.fromEntries(Object.entries(profiles).flatMap(([p, vars]) => Object.values(vars).map((v) => [v, p])))).redact;
}

/** Ask the owner for `profile` in this chat. Returns the approval id, or why it cannot be asked. */
export function requestSecret(db: Db, file: string, a: { chatId: number; profile: string; ttl: Ttl; reason: string }): { approvalId: number } | { error: string } {
  const r = loadProfiles(file);
  if ("error" in r) return { error: `the secrets file cannot be used: ${r.error}` };
  const vars = r.profiles[a.profile];
  if (!vars) return { error: `there is no secret profile "${a.profile}". Known profiles: ${Object.keys(r.profiles).join(", ") || "none"}` };
  const chat = getChat(db, a.chatId);
  const where = chat ? chatLabel(chat) : `chat ${a.chatId}`;
  const approvalId = requestApproval(db, {
    kind: SECRET_KIND,
    title: `Secret "${a.profile}" for the computer of ${where}`,
    body: [`Reason: ${a.reason}`, `Variables: ${Object.keys(vars).join(", ") || "(none)"} (values are never shown)`, `Asked for: ${a.ttl}`].join("\n"),
    options: [
      { id: "4h", label: "Grant for 4 hours" },
      { id: "1d", label: "Grant for 1 day" },
      { id: "3d", label: "Grant for 3 days" },
      { id: "deny", label: "Deny" },
    ],
    ttlMs: CARD_TTL_MS,
    originChatId: a.chatId,
    data: { chatId: a.chatId, profile: a.profile, ttl: a.ttl },
  });
  return { approvalId };
}

/**
 * Make the grants that answered request cards stand for (once per card), each with its revoke card. Safe to
 * run from any process, any number of times.
 */
export function syncGrants(db: Db, now = Date.now()): void {
  const answered = db
    .select()
    .from(approvals)
    .where(and(eq(approvals.kind, SECRET_KIND), eq(approvals.status, "answered")))
    .all();
  for (const a of answered) {
    if (!a.answer || !(a.answer in TTLS) || !a.data) continue;
    const chatId = Number(a.data.chatId);
    const profile = String(a.data.profile);
    const expiresAt = new Date(Date.parse(a.answeredAt ?? new Date(now).toISOString()) + TTLS[a.answer as Ttl]);
    db.insert(secretGrants).values({ chatId, profile, approvalId: a.id, expiresAt: expiresAt.toISOString() }).onConflictDoNothing().run();
  }
  // A grant without its revoke card (just made, or a crash before the card was queued) gets one. The check
  // and the card are one IMMEDIATE transaction, so two processes never both queue one.
  for (const g0 of db.select().from(secretGrants).all()) {
    if (g0.revokeApprovalId != null || Date.parse(g0.expiresAt) <= now) continue;
    db.transaction((tx) => {
      const tdb = tx as unknown as Db;
      const g = tx.select().from(secretGrants).where(eq(secretGrants.id, g0.id)).get();
      if (!g || g.revokeApprovalId != null) return;
      const chat = getChat(tdb, g.chatId);
      const revokeId = requestApproval(
        tdb,
        {
          kind: REVOKE_KIND,
          title: `Secret "${g.profile}" is granted to the computer of ${chat ? chatLabel(chat) : `chat ${g.chatId}`}`,
          body: `Grant #${g.id}, until ${g.expiresAt.slice(0, 16).replace("T", " ")} UTC. Press to end it now: commands started from then on no longer get it. A background job already running keeps the values it started with (cancel it with the assistant, or wait for it to end).`,
          options: [{ id: "revoke", label: "Revoke now" }],
          ttlMs: Date.parse(g.expiresAt) - now,
          data: { grantId: g.id },
        },
        now,
      );
      tx.update(secretGrants).set({ revokeApprovalId: revokeId }).where(eq(secretGrants.id, g.id)).run();
    }, IMMEDIATE);
  }
}

export type Grant = typeof secretGrants.$inferSelect;

/** Whether any revoke card for the grant has been pressed (any: a duplicate card revokes as well as the one recorded). */
function revoked(db: Db, grantId: number): boolean {
  return !!db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.kind, REVOKE_KIND), eq(approvals.answer, "revoke"), sql`json_extract(${approvals.data}, '$.grantId') = ${grantId}`))
    .get();
}

/** The grants live in a chat now: not past their ttl, not revoked. */
export function liveGrants(db: Db, chatId: number, now = Date.now()): Grant[] {
  syncGrants(db, now);
  return db
    .select()
    .from(secretGrants)
    .where(eq(secretGrants.chatId, chatId))
    .all()
    .filter((g) => Date.parse(g.expiresAt) > now && !revoked(db, g.id));
}

/**
 * What an exec in this chat gets: the env of every live grant (later grants of the same variable win), the
 * profile names, and the redaction. A file that cannot be used gives no env and says why in `warning`.
 */
export function secretsForChat(db: Db, file: string, chatId: number, now = Date.now()): { env: Record<string, string>; profiles: string[]; red: Redaction; warning?: string } {
  const red = redactionFor(file);
  const r = loadProfiles(file);
  if ("error" in r) return { env: {}, profiles: [], red, warning: `secrets unavailable: ${r.error}` };
  const env: Record<string, string> = {};
  const names: string[] = [];
  for (const g of liveGrants(db, chatId, now)) {
    const vars = r.profiles[g.profile];
    if (!vars) continue;
    Object.assign(env, vars);
    if (!names.includes(g.profile)) names.push(g.profile);
  }
  return { env, profiles: names, red };
}
