import { and, eq, sql } from "drizzle-orm";
import { getApproval, requestApproval } from "../../control/approvals.ts";
import type { Db } from "../../store/db.ts";
import { triggersAfter, type Chat, type MessagePayload } from "../../store/events.ts";
import { approvals } from "../../store/schema.ts";
import { IMMEDIATE } from "../../store/turns.ts";

/**
 * A purchase's approval: the owner's card in the control bot (control/approvals.ts) that lets ONE browser action
 * place ONE order. The owner decided that money never moves without him: porchkit refuses the action that places
 * an order on a checkout page (403 `approval_required`) unless shuvi says `approved: true`, and shuvi says so only
 * for an action that carries a usable approval of this kind.
 *
 *   ASK      `browser_request_purchase` → `requestPurchase`: a card of kind `purchase`, buttons approve / decline,
 *            `originChatId` the chat (the answer, or the expiry, wakes it), a ttl (`PURCHASE_TTL_MS`), `data`
 *            `{session, used: false, …}`. The card is the owner's whatever the turn: only he answers cards. When
 *            the owner is not in the turn that asks (a group member's request), the card records who did ask
 *            (`requestedBy`), so his answer is never read as the owner speaking in that turn
 *            (agent/turn.ts `ownerAuthority`).
 *   USE      a click / press / type with `approval: <id>` → `claimPurchase`: usable only when the card is of kind
 *            `purchase`, asked from THIS chat, answered `approve` less than `USE_WITHIN_MS` ago, for a page on the host
 *            the session is on now (`data.host`, recorded when it was asked), and not used yet; claiming marks it used
 *            (`data.used`) in the same transaction, so one approval is one approved action. Anything else is
 *            refused before porchkit is asked, with why.
 *   CARRY    an approved action whose answer is a confirm / prompt the page opened ("Confirm and pay?") carries the
 *            approval on to that dialog (`grantCarry`, `data.carry`): ONE more use, only for browser_dialog accepting
 *            it, in the same session, within `CARRY_MS`, without a new card (`claimCarry`). A dialog accepted on a
 *            carried right carries nothing further, so a second dialog needs its own card.
 *   GIVE BACK an action porchkit refused BEFORE contacting the desktop (index.ts `DID_NOTHING`: takeover, busy, a
 *            stale ref or page, an open dialog, owner-only, egress, its own refusals of the request) gives its claim
 *            back (`releasePurchase`), so the owner is not asked twice for nothing. Any other failure (unavailable,
 *            unreachable, a timeout, a crash) may have come after the click: the approval stays spent, and the model
 *            is told the order may or may not have gone through.
 */

export const PURCHASE_KIND = "purchase";
/** How long the owner's card stays answerable. */
export const PURCHASE_TTL_MS = 15 * 60_000;
export const APPROVE = "approve";
export const DECLINE = "decline";
/** How long after the owner's answer an approval stays usable (whatever the card's own expiry). */
export const USE_WITHIN_MS = 15 * 60_000;

/** A page's host, as an approval is bound to it: lowercase, without a port; null for no http(s) page. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** How long an approval carried to the dialog its action opened stays usable. */
export const CARRY_MS = 2 * 60_000;

export interface PurchaseRequest {
  chat: Chat;
  session: string;
  shop: string;
  items: string;
  total: string;
  note?: string;
  /** The page it was asked on (what the screenshot shows). */
  page?: { url?: string | null; title?: string | null };
  /** The host of the session's page when it was asked: the approval is usable only on that host. */
  host: string;
  /** porchkit's file key of the screenshot taken for it. */
  screenshotKey?: string;
  /** The screenshot itself: the card is sent as this photo. */
  screenshot?: Uint8Array;
  /** porchkit's live view, for the owner to look or take over before he answers. */
  liveUrl?: string | null;
  /** Who asked, when it was not the owner (see ASK above). */
  requestedBy?: { id: number; name: string };
}

const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function requestPurchase(db: Db, r: PurchaseRequest, now = Date.now()): number {
  const where = r.chat.kind === "private" ? "your DM" : `the group ${r.chat.title ?? `#${r.chat.id}`}`;
  // Short enough to be a photo's caption (1024 characters with the card's own lines; control/approvals.ts).
  const body = [
    `Shop: ${oneLine(r.shop, 80)}`,
    `Items: ${oneLine(r.items, 240)}`,
    `Total: ${oneLine(r.total, 60)}`,
    ...(r.note ? [`Note: ${oneLine(r.note, 160)}`] : []),
    ...(r.page?.url ? [`Page: ${oneLine(r.page.title ?? "", 60)}${r.page.title ? " — " : ""}${oneLine(r.page.url, 120)}`] : []),
    `Asked in ${oneLine(where, 60)}${r.requestedBy ? `, by ${oneLine(r.requestedBy.name, 40)} (user id ${r.requestedBy.id}), not you` : ""}.`,
    "Approve lets shuvi's browser place this one order (one click / Enter on the checkout page).",
    ...(r.liveUrl ? [`Look first, or take over: ${oneLine(r.liveUrl, 120)}`] : []),
  ].join("\n");
  return requestApproval(
    db,
    {
      kind: PURCHASE_KIND,
      title: `Buy at ${oneLine(r.shop, 80)}: ${oneLine(r.total, 40)}?`,
      body,
      options: [
        { id: APPROVE, label: "Approve this purchase" },
        { id: DECLINE, label: "Decline" },
      ],
      ttlMs: PURCHASE_TTL_MS,
      originChatId: r.chat.id,
      data: { session: r.session, host: r.host, used: false, ...(r.screenshotKey ? { screenshot: r.screenshotKey } : {}) },
      ...(r.requestedBy ? { requestedBy: r.requestedBy.id } : {}),
      ...(r.screenshot ? { photo: r.screenshot } : {}),
    },
    now,
  );
}

/**
 * Who asked, when the owner is not in the turn: the first message in it from someone else (the turn's own
 * events, (fromSeq, toSeq]). A turn of no message at all (a schedule he never set up) names nobody: 0.
 */
export function requester(db: Db, chatId: number, fromSeq: number, toSeq: number, ownerId: number | undefined): { id: number; name: string } {
  for (const e of triggersAfter(db, chatId, fromSeq)) {
    if (e.seq > toSeq) break;
    if (e.kind !== "message") continue;
    const from = (e.payload as unknown as MessagePayload).from;
    if (from.id !== ownerId) return { id: from.id, name: from.name };
  }
  return { id: 0, name: "nobody in particular (not a message)" };
}

/**
 * Claim approval `id` for one action of `chat`'s `session`, whose page is now on `host`: null when claimed, or why
 * it cannot be used. It must have been asked on that host, and answered within `USE_WITHIN_MS`.
 */
export function claimPurchase(db: Db, id: number, chat: Chat, session: string, host: string | null, now = Date.now()): string | null {
  return db.transaction((tx) => {
    const tdb = tx as unknown as Db;
    const a = getApproval(tdb, id);
    if (!a || a.kind !== PURCHASE_KIND) return `there is no purchase approval #${id}`;
    if (a.originChatId !== chat.id || (a.data as { session?: unknown } | null)?.session !== session) return `approval #${id} was asked for in another chat`;
    if (a.status === "pending") return a.expiresAt && Date.parse(a.expiresAt) <= now ? `approval #${id} expired unanswered` : `the owner has not answered approval #${id} yet`;
    if (a.status === "expired") return `approval #${id} expired unanswered`;
    if (a.answer !== APPROVE) return `the owner declined approval #${id}`;
    if (!a.answeredAt || Date.parse(a.answeredAt) + USE_WITHIN_MS <= now) return `approval #${id} was answered more than ${USE_WITHIN_MS / 60_000} minutes ago; ask the owner again`;
    const asked = (a.data as { host?: unknown } | null)?.host;
    if (typeof asked !== "string" || asked !== host) return `approval #${id} is for a page on ${typeof asked === "string" ? asked : "another site"}, and the browser is on ${host ?? "no web page"} now`;
    if ((a.data as { used?: unknown } | null)?.used === true) return `approval #${id} was already used (one approval is one action)`;
    const done = tx
      .update(approvals)
      .set({ data: sql`json_set(coalesce(${approvals.data}, '{}'), '$.used', json('true'))` })
      .where(and(eq(approvals.id, id), sql`coalesce(json_extract(${approvals.data}, '$.used'), 0) = 0`))
      .returning({ id: approvals.id })
      .get();
    return done ? null : `approval #${id} was already used (one approval is one action)`;
  }, IMMEDIATE);
}

/** Approval `id`'s action opened a dialog in `session`: let one browser_dialog accept it within `CARRY_MS`. */
export function grantCarry(db: Db, id: number, session: string, now = Date.now()): void {
  db.update(approvals)
    .set({ data: sql`json_set(coalesce(${approvals.data}, '{}'), '$.carry', json_object('session', ${session}, 'until', ${now + CARRY_MS}, 'used', json('false')))` })
    .where(and(eq(approvals.id, id), eq(approvals.kind, PURCHASE_KIND)))
    .run();
}

/**
 * Claim a carried right for accepting the dialog open in `chat`'s `session` (approval `id` when the model named one,
 * else the newest such right there): the approval's id, or null when there is none to use.
 */
export function claimCarry(db: Db, chat: Chat, session: string, id?: number, now = Date.now()): number | null {
  return db.transaction((tx) => {
    const row = tx
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.kind, PURCHASE_KIND),
          eq(approvals.originChatId, chat.id),
          sql`json_extract(${approvals.data}, '$.carry.session') = ${session}`,
          sql`coalesce(json_extract(${approvals.data}, '$.carry.used'), 0) = 0`,
          sql`json_extract(${approvals.data}, '$.carry.until') > ${now}`,
          ...(id !== undefined ? [eq(approvals.id, id)] : []),
        ),
      )
      .orderBy(sql`${approvals.id} desc`)
      .limit(1)
      .get();
    if (!row) return null;
    tx.update(approvals)
      .set({ data: sql`json_set(${approvals.data}, '$.carry.used', json('true'))` })
      .where(eq(approvals.id, row.id))
      .run();
    return row.id;
  }, IMMEDIATE);
}

/** Give a carried right back: the dialog was not answered (porchkit refused before doing anything). */
export function releaseCarry(db: Db, id: number): void {
  db.update(approvals)
    .set({ data: sql`json_set(${approvals.data}, '$.carry.used', json('false'))` })
    .where(and(eq(approvals.id, id), sql`json_extract(${approvals.data}, '$.carry') is not null`))
    .run();
}

/** Give a claim back: the action it was for was refused before anything happened. */
export function releasePurchase(db: Db, id: number): void {
  db.update(approvals)
    .set({ data: sql`json_set(coalesce(${approvals.data}, '{}'), '$.used', json('false'))` })
    .where(and(eq(approvals.id, id), eq(approvals.kind, PURCHASE_KIND)))
    .run();
}
