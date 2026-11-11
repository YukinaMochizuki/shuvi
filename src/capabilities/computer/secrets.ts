import { and, eq, sql } from "drizzle-orm";
import { requestApproval } from "../../control/approvals.ts";
import type { Db } from "../../store/db.ts";
import { getChat } from "../../store/events.ts";
import { approvals, secretGrants } from "../../store/schema.ts";
import { chatLabel, IMMEDIATE } from "../../store/turns.ts";
import { loadProfiles, redactionFor, type Redaction } from "../../secrets/redaction.ts";

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
 *   REDACTION  (src/secrets/redaction.ts, shared with the turn transcripts) every value of every profile in
 *              the file, and every value it ever held, is replaced by
 *              `[REDACTED:<profile>]` in any output before the model or the chat sees it (`Redaction`):
 *              exec output, job logs and results, file captions, also where output is cut at a byte offset.
 *              A file to be sent that holds a value is refused. With nothing to redact by, output is withheld.
 */

export const TTLS = { "4h": 4 * 3600_000, "1d": 24 * 3600_000, "3d": 72 * 3600_000 } as const;
export type Ttl = keyof typeof TTLS;
export const SECRET_KIND = "secret";
export const REVOKE_KIND = "secret-revoke";
/** How long the owner has to answer a request card. */
const CARD_TTL_MS = 24 * 3600_000;

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
