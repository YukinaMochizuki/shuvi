import { and, eq, isNull, or, sql } from "drizzle-orm";
import { answerApproval, getApproval, requestApproval, type ApprovalOption } from "../../control/approvals.ts";
import type { Db } from "../../store/db.ts";
import { getChat, type Speaker } from "../../store/events.ts";
import { approvals, secretGrants } from "../../store/schema.ts";
import { chatLabel, IMMEDIATE } from "../../store/turns.ts";
import type { Redaction } from "../../secrets/redaction.ts";
import { allProfiles, PROFILE_NAME, putProfile, redactionFor, storedProfiles, updateProfile, VAR_NAME, type SecretSource } from "../../secrets/source.ts";
import { loadProfiles } from "../../secrets/redaction.ts";
import { getNote, noteVarAbouts, setNote, SUMMARY_MAX } from "../../secrets/notes.ts";

/** A card's reason, from its body (`Reason: ...`). */
export function reasonOf(body: string): string {
  const line = body.split("\n").find((l) => l.startsWith("Reason: "));
  return line ? line.slice("Reason: ".length) : "";
}

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
 *   PROVIDE    a profile there is not yet, asked for with the variables it needs (`request_secret(profile, vars,
 *              reason)`), is a PROVIDE card instead (`secret-provide`): the reason, the variable names, and a link to
 *              the console's Secrets page where the owner types the values (never in Telegram). Its only button is
 *              Deny; its grant choices are hidden options (control/approvals.ts) the console answers with once it
 *              has the values (`provideSecret`): the profile is kept (sealed, src/secrets/source.ts) and granted in
 *              one transaction, and the answer wakes the chat as any card's does.
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
export const PROVIDE_KIND = "secret-provide";
/** The most variables a provide card asks for. */
export const PROVIDE_VARS_MAX = 10;
/** The most characters of what a provide card says a variable is. */
export const VAR_ABOUT_MAX = 120;

/** A variable a provide card asks for: its name, and what it is in words the owner reads (e.g. "身分證字號"). */
export interface ProvideVar {
  name: string;
  about?: string;
}
export const REVOKE_KIND = "secret-revoke";
/** How long the owner has to answer a request card. */
const CARD_TTL_MS = 24 * 3600_000;
/** A request card's answer that makes an owner grant: `all-<ttl>`, `all-forever`. */
const ALL_PREFIX = "all-";

const TTL_WORDS: Record<OwnerTtl, string> = { "4h": "4 hours", "1d": "1 day", "3d": "3 days", forever: "until you revoke it" };

/** A card's buttons: this chat for each ttl, then (for the owner's own request) every chat, then deny. */
function requestOptions(ownerAsks: boolean): ApprovalOption[] {
  return [...grantOptions(ownerAsks), { id: "deny", label: "Deny" }];
}

/** The grant choices: this chat for each ttl, then (for the owner's own request) every chat. */
export function grantOptions(ownerAsks: boolean): ApprovalOption[] {
  return [
    ...(Object.keys(TTLS) as Ttl[]).map((t) => ({ id: t, label: `This chat, ${TTL_WORDS[t]}` })),
    ...(ownerAsks ? (["4h", "1d", "3d", "forever"] as OwnerTtl[]).map((t) => ({ id: `${ALL_PREFIX}${t}`, label: t === "forever" ? "Every chat, until revoked" : `Every chat, ${TTL_WORDS[t]}` })) : []),
  ];
}

/** Where the console takes the values of provide card `cardId` (with the console's own URL, when it is known). */
export function provideLink(consoleUrl: string | undefined, cardId: number): string {
  return `${consoleUrl ? consoleUrl.replace(/\/+$/, "") : ""}/settings/secrets/provide?card=${cardId}`;
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

/**
 * Ask the owner for `profile` in this chat. Returns the approval id (and whether it is a provide card), or why it
 * cannot be asked. A profile there is not yet, with `vars`, is a provide card (the module header).
 */
export function requestSecret(
  db: Db,
  src: SecretSource,
  a: { chatId: number; profile: string; ttl: Ttl; reason: string; requestedBy?: number; vars?: ProvideVar[]; consoleUrl?: string },
): { approvalId: number; provide?: true } | { error: string } {
  const r = allProfiles(db, src);
  if ("error" in r) return { error: `the secrets file cannot be used: ${r.error}` };
  const vars = r.profiles[a.profile];
  if (!vars) {
    const unreadable = r.unreadable.find((u) => u.name === a.profile);
    if (unreadable) return { error: `the secret profile "${a.profile}" cannot be used now: ${unreadable.why}. Tell the owner.` };
    if (!a.vars?.length)
      return { error: `there is no secret profile "${a.profile}". Known profiles: ${Object.keys(r.profiles).join(", ") || "none"}. To ask the owner for a new one, call request_secret again with \`vars\`: the variable names it needs (e.g. ["NATIONAL_ID"]); he types their values in the console.` };
    return requestProvide(db, src, { ...a, vars: a.vars });
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

/** The provide card: refused for a bad name, bad or too many variables, or a name the store keeps without a key. */
function requestProvide(
  db: Db,
  src: SecretSource,
  a: { chatId: number; profile: string; reason: string; requestedBy?: number; vars: ProvideVar[]; consoleUrl?: string; update?: boolean },
): { approvalId: number; provide: true } | { error: string } {
  if (!PROFILE_NAME.test(a.profile)) return { error: `"${a.profile.slice(0, 64)}" cannot be a profile's name: letters, digits, _ and -, up to 64.` };
  const seen = new Set<string>();
  const asked: ProvideVar[] = [];
  for (const v of a.vars) {
    const name = v.name.trim();
    if (!VAR_NAME.test(name)) return { error: `"${name.slice(0, 40)}" is not a variable name (letters, digits and _, not starting with a digit).` };
    if (seen.has(name)) continue;
    seen.add(name);
    const about = v.about?.replace(/\s+/g, " ").trim().slice(0, VAR_ABOUT_MAX);
    asked.push({ name, ...(about ? { about } : {}) });
  }
  if (asked.length > PROVIDE_VARS_MAX) return { error: `ask for at most ${PROVIDE_VARS_MAX} variables at once.` };
  const vars = asked.map((v) => v.name);
  if (!src.key) return { error: `the owner cannot keep a new secret yet (SHUVI_SECRETS_KEY is not set where shuvi runs). Tell him.` };
  // The card's link is what he taps on his phone: without the console's address it would not lead anywhere.
  if (!a.consoleUrl) return { error: `the owner cannot be sent a link to type it in (SHUVI_CONSOLE_URL is not set where shuvi runs). Tell him: he can add the profile himself on the console's Secrets page, then grant it.` };
  const chat = getChat(db, a.chatId);
  const where = chat ? chatLabel(chat) : `chat ${a.chatId}`;
  const approvalId = requestApproval(db, {
    kind: PROVIDE_KIND,
    title: a.update ? `She needs new values in the secret "${a.profile}" for ${where}` : `She needs a new secret "${a.profile}" for ${where}`,
    // The link is added once the card has its id (below): the card's text is written when it is queued, so it is
    // built from a reserved row instead.
    body: "",
    // An update may leave the grants as they are (`update`), or grant it as a new request would.
    options: [
      ...[...(a.update ? [{ id: UPDATE_ONLY, label: "Only the values: its grants stay as they are" }] : []), ...grantOptions(a.requestedBy === undefined)].map((o): ApprovalOption => ({ ...o, hidden: true })),
      { id: "deny", label: "Deny" },
    ],
    ttlMs: CARD_TTL_MS,
    originChatId: a.chatId,
    data: { chatId: a.chatId, profile: a.profile, vars, ...(a.update ? { mode: "update" } : {}), about: Object.fromEntries(asked.filter((v) => v.about).map((v) => [v.name, v.about])) },
    ...(a.requestedBy !== undefined ? { requestedBy: a.requestedBy } : {}),
    bodyFor: (id) =>
      [
        `Reason: ${a.reason}`,
        `Variables: ${asked.map((v) => (v.about ? `${v.name} (${v.about})` : v.name)).join(", ")}`,
        ...(a.requestedBy !== undefined ? [`Asked by: an operator of this group (user id ${a.requestedBy}), not you`] : []),
        "",
        `Type the values in the console (never here): ${provideLink(a.consoleUrl, id)}`,
      ].join("\n"),
  });
  return { approvalId, provide: true };
}

/**
 * Ask the owner for new values of some variables of a profile kept in the console (a changed address, a rotated
 * token), or for variables it does not have yet: a provide card in `update` mode. The others keep their values.
 * A profile of the secrets file is changed where shuvi is deployed, not here.
 */
export function requestSecretUpdate(
  db: Db,
  src: SecretSource,
  a: { chatId: number; profile: string; reason: string; requestedBy?: number; vars: ProvideVar[]; consoleUrl?: string },
): { approvalId: number; provide: true } | { error: string } {
  const file = loadProfiles(src.file);
  if ("profiles" in file && a.profile in file.profiles) return { error: `"${a.profile}" is a profile of the secrets file: the owner changes it where shuvi is deployed. Tell him what needs changing (never the values).` };
  if (!storedProfiles(db).some((p) => p.name === a.profile)) return { error: `there is no secret profile "${a.profile}" to update. To ask for a new one, use request_secret with \`vars\`.` };
  if (!a.vars.length) return { error: "give the variables to update or add (`vars`)." };
  return requestProvide(db, src, { ...a, update: true });
}

/** The hidden answer of an update card that changes the values only, not the grants. */
export const UPDATE_ONLY = "update";

/** A provide card still waiting for its values, or why it is not (gone, answered, expired, not a provide card). */
export function pendingProvide(
  db: Db,
  cardId: number,
  now = Date.now(),
): { card: NonNullable<ReturnType<typeof getApproval>>; profile: string; vars: string[]; about: Record<string, string>; chatId: number; requestedBy: number | null; update: boolean; info: boolean } | { error: string } {
  const card = getApproval(db, cardId);
  if (!card || card.kind !== PROVIDE_KIND || !card.data) return { error: "There is no such request." };
  if (card.status !== "pending" || (card.expiresAt && Date.parse(card.expiresAt) <= now))
    return { error: card.status === "answered" ? `This request was answered already (${card.answer === "deny" ? "denied" : "provided"}).` : "This request has expired; she can ask again." };
  return { card, profile: String(card.data.profile), vars: (card.data.vars as string[]) ?? [], about: (card.data.about as Record<string, string>) ?? {}, chatId: Number(card.data.chatId), requestedBy: card.requestedBy ?? null, update: card.data.mode === "update", info: card.data.kind === "info" };
}

/**
 * Answer provide card `cardId` from the console: keep the profile with `values` (every variable the card asks for,
 * each non-empty) and grant it as `grant` (one of the card's hidden grant options), in one transaction with the
 * answer, which wakes the chat. Refused, changing nothing, when the card is not pending, a value is missing, the
 * name is taken meanwhile, or the profile cannot be kept.
 */
export function provideSecret(db: Db, src: SecretSource, cardId: number, values: Record<string, string>, grant: string, from: Speaker, now = Date.now()): { profile: string; label: string } | { error: string } {
  const p = pendingProvide(db, cardId, now);
  if ("error" in p) return p;
  if (p.info) return { error: "This request is for personal info, not a secret." };
  const option = p.card.options.findIndex((o) => o.id === grant && o.hidden);
  if (option < 0) return { error: "Choose where and how long to grant it." };
  const vars: Record<string, string> = {};
  for (const v of p.vars) {
    // Kept as typed (a password may begin or end with a space); only a field of nothing but spaces is empty.
    const value = values[v] ?? "";
    if (!value.trim()) return { error: `Give ${v} a value. Nothing was saved; type the values again.` };
    vars[v] = value;
  }
  const file = loadProfiles(src.file);
  const exists = ("profiles" in file && p.profile in file.profiles) || storedProfiles(db).some((s) => s.name === p.profile);
  if (!p.update && exists) return { error: `A profile "${p.profile}" exists now (made since she asked). Deny this request, and grant that one on the console's Secrets page instead. Nothing was saved.` };
  if (p.update && !storedProfiles(db).some((s) => s.name === p.profile)) return { error: `The profile "${p.profile}" is not kept here any more. Deny this request. Nothing was saved.` };
  return db.transaction((tx) => {
    const tdb = tx as unknown as Db;
    // An update changes only the variables the card asks for; the others keep their values.
    const put = p.update ? updateProfile(tdb, src, p.profile, { set: vars }, now) : putProfile(tdb, src, p.profile, vars, now);
    if ("error" in put) return { error: `${put.error} Nothing was saved; type the values again.` };
    const r = answerApproval(tdb, cardId, option, from, now, { hidden: true });
    if (r.result !== "answered") throw new Error("the request was answered meanwhile");
    // What she said each variable is, kept in the profile's note (its `- NAME: ...` lines), so she knows them later;
    // a new profile's note also says what it is for.
    if (!p.update && !getNote(tdb, p.profile)) setNote(tdb, src, p.profile, { summary: reasonOf(p.card.body).slice(0, SUMMARY_MAX) }, "console (from her request)", now);
    noteVarAbouts(tdb, src, p.profile, Object.fromEntries(p.vars.map((v) => [v, p.about[v] ?? ""])), [], "console (from her request)", now);
    syncGrants(tdb, now);
    return { profile: p.profile, label: r.label ?? grant };
  }, IMMEDIATE);
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
    .where(and(or(eq(approvals.kind, SECRET_KIND), eq(approvals.kind, PROVIDE_KIND)), eq(approvals.status, "answered")))
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
