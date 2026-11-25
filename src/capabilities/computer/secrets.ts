import { and, eq, isNull, or, sql } from "drizzle-orm";
import { answerApproval, getApproval, requestApproval, type ApprovalOption } from "../../control/approvals.ts";
import type { Db } from "../../store/db.ts";
import { getChat, type Speaker } from "../../store/events.ts";
import { approvals, secretGrants } from "../../store/schema.ts";
import { chatLabel, IMMEDIATE } from "../../store/turns.ts";
import type { Redaction } from "../../secrets/redaction.ts";
import { allProfiles, redactionFor, type SecretSource } from "../../secrets/source.ts";

/**
 * Secrets for the chats' computers, profile A of docs/design.md §15.
 *
 *   PROFILES   named sets of environment variables (src/secrets/source.ts): those of a host-side YAML file
 *              outside home/ and git (SHUVI_SECRETS_FILE, default /etc/shuvi.secrets.yaml), which must be mode
 *              600 (no group or other bits; a file anyone else can read is refused, not used), and those the
 *              owner keeps in the console, sealed in the store under SHUVI_SECRETS_KEY.
 *
 *                  # /etc/shuvi.secrets.yaml
 *                  modal:
 *                    MODAL_TOKEN_ID: ak-...
 *                    MODAL_TOKEN_SECRET: as-...
 *
 *              Both are read when needed, never cached, so an edit counts at the next exec. Only profile and
 *              variable NAMES ever leave this module towards the model, a card, or the store's grants.
 *   REQUEST    `request_secret(profile, ttl, reason)` puts an approval card to the owner in the control bot
 *              (control/approvals.ts), naming the variables, never their values, with the ttl asked for. Its
 *              buttons: THIS CHAT for 4h / 1d / 3d, EVERY CHAT for 4h / 1d / 3d / until revoked (only on a card the
 *              owner's own turn asked for: an operator's turn never gets an owner grant), or deny. The answer wakes
 *              the chat with an `approval` event.
 *   GRANT      one per approved card (`secret_grants`, keyed on the approval), until its ttl from the answer (or
 *              until revoked). A CHAT grant is that chat's; an OWNER grant (`chat_id` null) is every chat's, for
 *              calls that act for the owner only (agent/acting.ts: never an operator's, in a group that delegates
 *              its computer). The owner may also make an owner grant in the console (`consoleGrant`, no card).
 *              Grants are made from the answered cards by whichever process looks first (`syncGrants`, run before
 *              every exec and by the server's loop), which also puts a "Revoke now" card in the control bot for
 *              every grant: pressing it ends the grant at once. The console's "Revoke now" presses the same card
 *              (`revokeGrant`), so the card says it is revoked either way.
 *   USE        a live grant's values go into the `env` of the exec calls it covers (hangar/client.ts): never into a
 *              file, the container's spec, or the store.
 *   REDACTION  (src/secrets/redaction.ts, shared with the turn transcripts) every value of every profile, and
 *              every value either source ever held, is replaced by `[REDACTED:<profile>]` in any output before the
 *              model or the chat sees it (`Redaction`): exec output, job logs and results, file captions, also
 *              where output is cut at a byte offset. A file to be sent that holds a value is refused. With nothing
 *              to redact by, output is withheld.
 */

export const TTLS = { "4h": 4 * 3600_000, "1d": 24 * 3600_000, "3d": 72 * 3600_000 } as const;
export type Ttl = keyof typeof TTLS;
/** How long an owner grant may last: a ttl, or until it is revoked. */
export type OwnerTtl = Ttl | "forever";
export const SECRET_KIND = "secret";
export const REVOKE_KIND = "secret-revoke";
/** How long the owner has to answer a request card. */
const CARD_TTL_MS = 24 * 3600_000;
/** A request card's answer that makes an owner grant: `all-<ttl>`, `all-forever`. */
const ALL_PREFIX = "all-";

const TTL_WORDS: Record<OwnerTtl, string> = { "4h": "4 hours", "1d": "1 day", "3d": "3 days", forever: "until you revoke it" };

/** A card's buttons: this chat for each ttl, then (for the owner's own request) every chat, then deny. */
function requestOptions(ownerAsks: boolean): ApprovalOption[] {
  return [
    ...(Object.keys(TTLS) as Ttl[]).map((t) => ({ id: t, label: `This chat, ${TTL_WORDS[t]}` })),
    ...(ownerAsks ? (["4h", "1d", "3d", "forever"] as OwnerTtl[]).map((t) => ({ id: `${ALL_PREFIX}${t}`, label: t === "forever" ? "Every chat, until revoked" : `Every chat, ${TTL_WORDS[t]}` })) : []),
    { id: "deny", label: "Deny" },
  ];
}

/** What a card's answer grants: its scope and ttl, or null (deny, or not a grant). */
function answerGrant(answer: string | null): { all: boolean; ttl: OwnerTtl } | null {
  if (!answer) return null;
  if (answer in TTLS) return { all: false, ttl: answer as Ttl };
  if (answer.startsWith(ALL_PREFIX)) {
    const t = answer.slice(ALL_PREFIX.length);
    if (t in TTLS || t === "forever") return { all: true, ttl: t as OwnerTtl };
  }
  return null;
}

const expiryFrom = (from: number, ttl: OwnerTtl): string | null => (ttl === "forever" ? null : new Date(from + TTLS[ttl]).toISOString());

/** "until 2026-11-26 03:00 UTC", or "until revoked". */
export function untilLabel(g: { expiresAt: string | null }): string {
  return g.expiresAt ? `until ${g.expiresAt.slice(0, 16).replace("T", " ")} UTC` : "until revoked";
}

/** Ask the owner for `profile` in this chat. Returns the approval id, or why it cannot be asked. */
export function requestSecret(db: Db, src: SecretSource, a: { chatId: number; profile: string; ttl: Ttl; reason: string; requestedBy?: number }): { approvalId: number } | { error: string } {
  const r = allProfiles(db, src);
  if ("error" in r) return { error: `the secrets file cannot be used: ${r.error}` };
  const vars = r.profiles[a.profile];
  if (!vars) {
    const unreadable = r.unreadable.find((u) => u.name === a.profile);
    if (unreadable) return { error: `the secret profile "${a.profile}" cannot be used now: ${unreadable.why}. Tell the owner.` };
    return { error: `there is no secret profile "${a.profile}". Known profiles: ${Object.keys(r.profiles).join(", ") || "none"}` };
  }
  const chat = getChat(db, a.chatId);
  const where = chat ? chatLabel(chat) : `chat ${a.chatId}`;
  const approvalId = requestApproval(db, {
    kind: SECRET_KIND,
    title: `Secret "${a.profile}" for the computer of ${where}`,
    body: [
      `Reason: ${a.reason}`,
      `Variables: ${Object.keys(vars).join(", ") || "(none)"} (values are never shown)`,
      `Asked for: ${a.ttl}`,
      ...(a.requestedBy !== undefined
        ? [`Asked by: an operator of this group (user id ${a.requestedBy}), not you`]
        : ["\"Every chat\" gives it to every chat's computer, in your own turns only (never an operator's)."]),
    ].join("\n"),
    options: requestOptions(a.requestedBy === undefined),
    ttlMs: CARD_TTL_MS,
    originChatId: a.chatId,
    data: { chatId: a.chatId, profile: a.profile, ttl: a.ttl },
    ...(a.requestedBy !== undefined ? { requestedBy: a.requestedBy } : {}),
  });
  return { approvalId };
}

/**
 * An owner grant of `profile` made by the owner in the console, for `ttl` from now (or until revoked). Its revoke
 * card follows (`syncGrants`). Whether the profile exists is the caller's to check.
 */
export function consoleGrant(db: Db, profile: string, ttl: OwnerTtl, now = Date.now()): Grant {
  const g = db.insert(secretGrants).values({ chatId: null, profile, approvalId: null, expiresAt: expiryFrom(now, ttl), createdAt: new Date(now).toISOString() }).returning().get();
  syncGrants(db, now);
  return db.select().from(secretGrants).where(eq(secretGrants.id, g.id)).get()!;
}

/**
 * Make the grants that answered request cards stand for (once per card), and give every live grant its revoke
 * card. Safe to run from any process, any number of times.
 */
export function syncGrants(db: Db, now = Date.now()): void {
  const answered = db
    .select()
    .from(approvals)
    .where(and(eq(approvals.kind, SECRET_KIND), eq(approvals.status, "answered")))
    .all();
  for (const a of answered) {
    const what = answerGrant(a.answer);
    if (!what || !a.data) continue;
    // An operator's card never had the "every chat" buttons; an answer claiming one is not honoured.
    if (what.all && a.requestedBy != null) continue;
    const chatId = Number(a.data.chatId);
    const profile = String(a.data.profile);
    const from = Date.parse(a.answeredAt ?? new Date(now).toISOString());
    db.insert(secretGrants).values({ chatId: what.all ? null : chatId, profile, approvalId: a.id, expiresAt: expiryFrom(from, what.ttl) }).onConflictDoNothing().run();
  }
  // A grant without its revoke card (just made, or a crash before the card was queued) gets one. The check
  // and the card are one IMMEDIATE transaction, so two processes never both queue one.
  for (const g0 of db.select().from(secretGrants).where(isNull(secretGrants.revokeApprovalId)).all()) {
    if (ended(g0, now)) continue;
    db.transaction((tx) => {
      const tdb = tx as unknown as Db;
      const g = tx.select().from(secretGrants).where(eq(secretGrants.id, g0.id)).get();
      if (!g || g.revokeApprovalId != null) return;
      const chat = g.chatId != null ? getChat(tdb, g.chatId) : undefined;
      const where = g.chatId == null ? "every chat's computer, in your own turns" : `the computer of ${chat ? chatLabel(chat) : `chat ${g.chatId}`}`;
      const revokeId = requestApproval(
        tdb,
        {
          kind: REVOKE_KIND,
          title: `Secret "${g.profile}" is granted to ${where}`,
          body: `Grant #${g.id}${g.approvalId == null ? ", made in the console" : ""}, ${untilLabel(g)}. Press to end it now: commands started from then on no longer get it. A background job already running keeps the values it started with (cancel it with the assistant, or wait for it to end).`,
          options: [{ id: "revoke", label: "Revoke now" }],
          ...(g.expiresAt ? { ttlMs: Date.parse(g.expiresAt) - now } : {}),
          data: { grantId: g.id },
        },
        now,
      );
      tx.update(secretGrants).set({ revokeApprovalId: revokeId }).where(eq(secretGrants.id, g.id)).run();
    }, IMMEDIATE);
  }
}

export type Grant = typeof secretGrants.$inferSelect;

/** Past its ttl (a grant until revoked never is). */
const ended = (g: Grant, now: number) => g.expiresAt != null && Date.parse(g.expiresAt) <= now;

/** Whether any revoke card for the grant has been pressed (any: a duplicate card revokes as well as the one recorded). */
function revoked(db: Db, grantId: number): boolean {
  return !!db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.kind, REVOKE_KIND), eq(approvals.answer, "revoke"), sql`json_extract(${approvals.data}, '$.grantId') = ${grantId}`))
    .get();
}

const live = (db: Db, rows: Grant[], now: number) => rows.filter((g) => !ended(g, now) && !revoked(db, g.id));

/** The chat grants live in a chat now (not owner grants): not past their ttl, not revoked. */
export function liveGrants(db: Db, chatId: number, now = Date.now()): Grant[] {
  syncGrants(db, now);
  return live(db, db.select().from(secretGrants).where(eq(secretGrants.chatId, chatId)).all(), now);
}

/** The owner grants live now: every chat's, in the owner's calls. */
export function ownerGrants(db: Db, now = Date.now()): Grant[] {
  syncGrants(db, now);
  return live(db, db.select().from(secretGrants).where(isNull(secretGrants.chatId)).all(), now);
}

/**
 * The profiles granted now, by name, sorted, for the prompt (index.ts `section`), WITHOUT `syncGrants`: a section
 * only reads. A card answered a moment ago shows once the next exec or the server's loop has made its grant.
 */
export function grantedNames(db: Db, chatId: number, now = Date.now()): { chat: string[]; owner: string[] } {
  const rows = live(db, db.select().from(secretGrants).where(or(eq(secretGrants.chatId, chatId), isNull(secretGrants.chatId))).all(), now);
  const names = (all: boolean) => [...new Set(rows.filter((g) => (g.chatId == null) === all).map((g) => g.profile))].sort();
  return { chat: names(false), owner: names(true) };
}

/** What a call in `chatId` gets: the chat's grants, and the owner grants when it acts for the owner. */
export function grantsFor(db: Db, chatId: number, forOwner: boolean, now = Date.now()): Grant[] {
  syncGrants(db, now);
  const where = forOwner ? or(eq(secretGrants.chatId, chatId), isNull(secretGrants.chatId)) : eq(secretGrants.chatId, chatId);
  return live(db, db.select().from(secretGrants).where(where).all(), now);
}

/**
 * Revoke a live grant as the owner pressing its revoke card in the control bot would: the card is answered
 * `revoke` (approvals.ts `answerApproval`, which edits the card to say so), and from then on the grant is not
 * live. `chatId` is the chat whose page it is revoked from, or null for an owner grant (the console's Settings).
 * `already`: it had ended (expired or revoked) before.
 */
export function revokeGrant(db: Db, grantId: number, chatId: number | null, from: Speaker, now = Date.now()): { revoked: Grant } | { already: Grant } | { error: string } {
  syncGrants(db, now);
  const g = db.select().from(secretGrants).where(eq(secretGrants.id, grantId)).get();
  if (!g || g.chatId !== chatId) return { error: chatId == null ? `There is no grant #${grantId} for every chat.` : `There is no grant #${grantId} in this chat.` };
  if (ended(g, now) || revoked(db, g.id)) return { already: g };
  if (g.revokeApprovalId == null) return { error: `Grant #${g.id} has no revoke card yet; try again in a moment.` };
  const r = db.transaction((tx) => {
    const tdb = tx as unknown as Db;
    const card = getApproval(tdb, g.revokeApprovalId!);
    const option = card ? card.options.findIndex((o) => o.id === "revoke") : -1;
    return option < 0 ? { result: "closed" as const } : answerApproval(tdb, card!.id, option, from, now);
  }, IMMEDIATE);
  if (r.result === "answered") return { revoked: g };
  return revoked(db, g.id) ? { already: g } : { error: `Grant #${g.id}'s revoke card is closed; it ends ${untilLabel(g).replace(/^until /, "at ")}.` };
}

/**
 * Revoke every live grant of `profile`, a chat's or every chat's, as their cards' "Revoke now" (a profile being
 * deleted: a later one of the same name must not inherit them). Returns how many were revoked.
 */
export function revokeProfileGrants(db: Db, profile: string, from: Speaker, now = Date.now()): number {
  syncGrants(db, now);
  let n = 0;
  for (const g of live(db, db.select().from(secretGrants).where(eq(secretGrants.profile, profile)).all(), now)) {
    if ("revoked" in revokeGrant(db, g.id, g.chatId, from, now)) n++;
  }
  return n;
}

/**
 * What a call in this chat gets: the env of every live grant it is covered by (`forOwner`: also the owner grants;
 * later grants of the same variable win), the profile names, and the redaction. A file that cannot be used gives
 * no env and says why in `warning`; so does a granted profile whose values cannot be opened.
 */
export function secretsForChat(db: Db, src: SecretSource, chatId: number, forOwner: boolean, now = Date.now()): { env: Record<string, string>; profiles: string[]; red: Redaction; warning?: string } {
  const red = redactionFor(db, src);
  const r = allProfiles(db, src);
  if ("error" in r) return { env: {}, profiles: [], red, warning: `secrets unavailable: ${r.error}` };
  const env: Record<string, string> = {};
  const names: string[] = [];
  const missing = new Map<string, string>();
  for (const g of grantsFor(db, chatId, forOwner, now).sort((a, b) => a.id - b.id)) {
    const vars = r.profiles[g.profile];
    if (!vars) {
      const u = r.unreadable.find((x) => x.name === g.profile);
      if (u) missing.set(g.profile, `${g.profile} (${u.why})`);
      continue;
    }
    Object.assign(env, vars);
    if (!names.includes(g.profile)) names.push(g.profile);
  }
  return { env, profiles: names, red, ...(missing.size ? { warning: `granted but unavailable: ${[...missing.values()].join("; ")}` } : {}) };
}
