import { and, eq, isNotNull, lt } from "drizzle-orm";
import { queueControl } from "../store/control.ts";
import type { Db } from "../store/db.ts";
import { lastMessage, recordApprovalEvent, type MessagePayload, type Speaker } from "../store/events.ts";
import { approvals } from "../store/schema.ts";
import { IMMEDIATE } from "../store/turns.ts";

/**
 * The generic approval API (docs/design.md §13): put a question to the owner as a card with buttons in
 * the control bot, and get the answer back durably. The first real callers (policy changes, secrets,
 * schedules) are later milestones; this module knows nothing about what an answer means.
 *
 *   requestApproval({ kind, title, body, options, ttlMs?, originChatId?, data? }) → id
 *       records the approval and queues its card in the same transaction. Callable from any process
 *       (a runner child's tool included): it only writes rows, and the control sender sends the card.
 *   getApproval(id)
 *       read the answer: `pending`, `answered` (with the option id), or `expired`.
 *   originChatId
 *       when set, the answer (or the expiry) is also written into that chat as an `approval` event, which
 *       is a trigger: the chat that asked is woken by it with a turn, like a message would.
 *
 * A button press is recorded once, by the control poller, in the transaction that advances its offset
 * (`answerApproval`), and only from the owner (bot.ts checks the sender). Pressing a button on a card that
 * is no longer pending changes nothing. Once answered or expired, the card is edited to say so and loses
 * its buttons.
 *
 * Button data is `ap:<approval id>:<option index>`, well under Telegram's 64-byte limit whatever the
 * option ids are.
 */

export interface ApprovalOption {
  id: string;
  label: string;
}

export interface ApprovalRequest {
  /** Who asks, e.g. `policy`. */
  kind: string;
  title: string;
  body: string;
  /** The buttons, in order (1 to 8). */
  options: ApprovalOption[];
  /** How long the card stays answerable (default: until answered). */
  ttlMs?: number;
  /** The chat to wake with an `approval` event once it is answered or expires. */
  originChatId?: number;
  /** Anything the caller wants to find again with the answer. */
  data?: Record<string, unknown>;
}

export type Approval = typeof approvals.$inferSelect;

export const CALLBACK_PREFIX = "ap:";

export function cardText(a: Approval): string {
  const expiry = a.expiresAt ? `Expires ${a.expiresAt.slice(0, 16).replace("T", " ")} UTC` : "No expiry";
  return `Approval #${a.id} (${a.kind})\n${a.title}\n\n${a.body}\n\n${expiry}`;
}

function closedText(a: Approval): string {
  const label = a.options.find((o) => o.id === a.answer)?.label ?? a.answer;
  return `${cardText(a)}\n\n→ ${a.status === "answered" ? `Answered: ${label}` : "Expired unanswered"}`;
}

/** The inline keyboard of a pending card: one button per row. */
export function cardKeyboard(a: Approval): { text: string; callback_data: string }[][] {
  return a.options.map((o, i) => [{ text: o.label, callback_data: `${CALLBACK_PREFIX}${a.id}:${i}` }]);
}

export function requestApproval(db: Db, req: ApprovalRequest, now = Date.now()): number {
  if (!req.options.length || req.options.length > 8) throw new Error("an approval needs 1 to 8 options");
  if (new Set(req.options.map((o) => o.id)).size !== req.options.length) throw new Error("approval option ids must be unique");
  return db.transaction((tx) => {
    const a = tx
      .insert(approvals)
      .values({
        kind: req.kind,
        title: req.title,
        body: req.body,
        options: req.options,
        originChatId: req.originChatId ?? null,
        data: req.data ?? null,
        status: "pending",
        expiresAt: req.ttlMs ? new Date(now + req.ttlMs).toISOString() : null,
        createdAt: new Date(now).toISOString(),
      })
      .returning()
      .get();
    queueControl(tx as unknown as Db, { kind: "approval", text: cardText(a), key: `approval:${a.id}`, approvalId: a.id });
    return a.id;
  }, IMMEDIATE);
}

export function getApproval(db: Db, id: number): Approval | undefined {
  return db.select().from(approvals).where(eq(approvals.id, id)).get();
}

/** Parse button data. Null: not an approval button. */
export function parseCallback(data: string | undefined): { approvalId: number; option: number } | null {
  const m = data?.match(/^ap:(\d+):(\d+)$/);
  return m ? { approvalId: Number(m[1]), option: Number(m[2]) } : null;
}

/** Close a pending approval (answered or expired): edit its card, and wake the chat that asked. */
function close(db: Db, a: Approval, from: Speaker): void {
  queueControl(db, { kind: "approval_closed", text: closedText(a), key: `approval-closed:${a.id}`, approvalId: a.id });
  if (a.originChatId != null) {
    const label = a.options.find((o) => o.id === a.answer)?.label ?? null;
    recordApprovalEvent(db, a.originChatId, { from, approvalId: a.id, kind: a.kind, title: a.title, answer: a.answer, label });
  }
}

/**
 * Record the owner's button press. Call inside the transaction that records the update. Returns what it
 * did: `answered`, or `closed` when the card was already answered or expired (or the button is unknown).
 */
export function answerApproval(db: Db, approvalId: number, option: number, from: Speaker, now = Date.now()): { result: "answered" | "closed"; label?: string } {
  const a = getApproval(db, approvalId);
  const chosen = a?.options[option];
  if (!a || !chosen || a.status !== "pending") return { result: "closed" };
  if (a.expiresAt && Date.parse(a.expiresAt) <= now) return { result: "closed" }; // the expiry pass closes it
  const updated = db
    .update(approvals)
    .set({ status: "answered", answer: chosen.id, answeredAt: new Date(now).toISOString() })
    .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
    .returning()
    .get();
  if (!updated) return { result: "closed" };
  close(db, updated, from);
  return { result: "answered", label: chosen.label };
}

/** Expire every pending approval past its ttl. Returns how many. */
export function expireApprovals(db: Db, ownerId: number, now = Date.now()): number {
  const due = db
    .select()
    .from(approvals)
    .where(and(eq(approvals.status, "pending"), isNotNull(approvals.expiresAt), lt(approvals.expiresAt, new Date(now).toISOString())))
    .all();
  for (const a of due) {
    db.transaction((tx) => {
      const tdb = tx as unknown as Db;
      const updated = tx
        .update(approvals)
        .set({ status: "expired" })
        .where(and(eq(approvals.id, a.id), eq(approvals.status, "pending")))
        .returning()
        .get();
      if (!updated) return;
      // The `from` here is SYNTHETIC: nobody pressed anything, and this is not a message the owner sent. It
      // exists only because runTurn takes the owner's name from `input[0].payload.from`, and an expiry
      // event can be the first input of a turn. So it borrows the owner's name from their last message in
      // the chat, or falls back to "Owner". Drop it once the turn takes the owner's name from elsewhere.
      const last = a.originChatId != null ? lastMessage(tdb, a.originChatId, Number.MAX_SAFE_INTEGER) : undefined;
      const lastFrom = (last?.payload as unknown as MessagePayload | undefined)?.from;
      close(tdb, updated, lastFrom?.id === ownerId ? lastFrom : { id: ownerId, name: "Owner" });
    }, IMMEDIATE);
  }
  return due.length;
}
