import { and, asc, count, desc, eq, gt, gte, inArray, ne } from "drizzle-orm";
import type { Db } from "./db.ts";
import { controlMessages } from "./schema.ts";

/**
 * The control bot's outbox (`control_messages`, see schema.ts): what the framework has to tell the owner.
 * Anything may queue here, a runner child included (a failed turn raises its alert in the transaction
 * that closes it); only the server's control sender (src/control/bot.ts) delivers.
 *
 * Alerts are raised with up to two keys:
 *   - `key` (idempotency): the one event the alert is about, e.g. `turn-failed:<turnId>`. Raising it again
 *     is a no-op, so a scan that repeats after a crash never alerts twice.
 *   - `topic` (rate limit, optional): what counts as a REPEAT of the same alert, e.g.
 *     `turn-failed:<chatId>`. While an alert on the topic was raised less than `ALERT_REPEAT_MS` ago, a new
 *     one is recorded as `suppressed` and not sent: a chat that fails five times in a row produces one
 *     alert, not five. The next alert on the topic that does go out says how many were suppressed since
 *     the last one. An alert about something that must never go unseen (a message left unanswered) has no
 *     topic, and is always sent.
 *
 * This module never opens a transaction of its own, so it can be called inside the caller's.
 */

export const ALERT_REPEAT_MS = 30 * 60_000;

export type ControlMessage = typeof controlMessages.$inferSelect;

/** Queue an alert for the owner. Returns what became of it (`null`: this key was already raised). */
export function raiseAlert(db: Db, a: { key: string; topic?: string; text: string }, now = Date.now()): "pending" | "suppressed" | null {
  if (db.select({ id: controlMessages.id }).from(controlMessages).where(eq(controlMessages.idemKey, a.key)).get()) return null;
  let status: "pending" | "suppressed" = "pending";
  let text = a.text;
  if (a.topic) {
    const since = new Date(now - ALERT_REPEAT_MS).toISOString();
    const recent = db
      .select({ id: controlMessages.id })
      .from(controlMessages)
      .where(and(eq(controlMessages.topic, a.topic), ne(controlMessages.status, "suppressed"), gte(controlMessages.createdAt, since)))
      .get();
    if (recent) status = "suppressed";
    else {
      // Going out: count what this topic suppressed since its last alert that went out.
      const last = db
        .select({ id: controlMessages.id })
        .from(controlMessages)
        .where(and(eq(controlMessages.topic, a.topic), ne(controlMessages.status, "suppressed")))
        .orderBy(desc(controlMessages.id))
        .get();
      const n =
        db
          .select({ n: count() })
          .from(controlMessages)
          .where(and(eq(controlMessages.topic, a.topic), eq(controlMessages.status, "suppressed"), gt(controlMessages.id, last?.id ?? 0)))
          .get()?.n ?? 0;
      if (n) text += ` And ${n} more like it since the last alert.`;
    }
  }
  if (status === "pending") console.error(`alert: ${text}`);
  const rows = db
    .insert(controlMessages)
    .values({ kind: "alert", text, idemKey: a.key, topic: a.topic ?? null, status, createdAt: new Date(now).toISOString() })
    .onConflictDoNothing()
    .returning({ id: controlMessages.id })
    .all();
  return rows.length ? status : null;
}

/** Queue a reply to a control command (`key`: the command's update, so a re-delivered update replies once). */
export function queueReply(db: Db, key: string, text: string): void {
  db.insert(controlMessages).values({ kind: "reply", text, idemKey: key, status: "pending" }).onConflictDoNothing().run();
}

/**
 * Queue a reply in Telegram HTML, as one message per part, in order (`key` for the first, `key:2`, … after
 * it). The caller escapes what it puts in and keeps each part under Telegram's limit.
 */
export function queueHtmlReply(db: Db, key: string, parts: readonly string[]): void {
  parts.forEach((text, i) => {
    db.insert(controlMessages)
      .values({ kind: "reply_html", text, idemKey: i ? `${key}:${i + 1}` : key, status: "pending" })
      .onConflictDoNothing()
      .run();
  });
}

export function queueControl(db: Db, m: { kind: "approval" | "approval_closed"; text: string; key: string; approvalId: number }): void {
  db.insert(controlMessages).values({ ...m, idemKey: m.key, status: "pending" }).onConflictDoNothing().run();
}

/** Undelivered rows, oldest first. */
export function pendingControl(db: Db): ControlMessage[] {
  return db.select().from(controlMessages).where(eq(controlMessages.status, "pending")).orderBy(asc(controlMessages.id)).all();
}

export function markControlSent(db: Db, id: number, tgMessageId: number | null): void {
  db.update(controlMessages).set({ status: "sent", tgMessageId }).where(eq(controlMessages.id, id)).run();
}

export function markControlFailed(db: Db, id: number, note: string): void {
  db.update(controlMessages).set({ status: "failed", note }).where(eq(controlMessages.id, id)).run();
}

/** The delivered card of an approval (its Telegram message id), if it was sent. */
export function approvalCard(db: Db, approvalId: number): ControlMessage | undefined {
  return db
    .select()
    .from(controlMessages)
    .where(and(eq(controlMessages.approvalId, approvalId), eq(controlMessages.kind, "approval"), inArray(controlMessages.status, ["sent", "pending"])))
    .get();
}

export function controlMessagesOf(db: Db, kind: ControlMessage["kind"]): ControlMessage[] {
  return db.select().from(controlMessages).where(eq(controlMessages.kind, kind)).orderBy(asc(controlMessages.id)).all();
}
