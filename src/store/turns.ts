import { and, desc, eq, gt, inArray, isNull, lte, max } from "drizzle-orm";
import type { TurnUsage } from "agent-runtime";
import type { Db } from "./db.ts";
import { raiseAlert } from "./control.ts";
import { asksForTurn, chatEvents, chats, TRIGGER_KINDS, turns } from "./schema.ts";

/**
 * Turn bookkeeping, and the CURSOR rule that makes a turn's input exactly-once:
 *
 *   - a turn is claimed with `from_seq` = the chat's cursor and `to_seq` = the newest message at the
 *     claim: what it is there to answer, recorded before any process runs, so even a turn that dies
 *     before it reads anything knows what its input was. The child widens `to_seq` further as it shows
 *     the model mid-turn messages;
 *   - the cursor moves only when the turn ENDS, in the same transaction that closes it. So an event is
 *     either inside a turn that finished, or still past the cursor and will be shown again:
 *       done     → the cursor moves to `to_seq`;
 *       stopped  → the cursor moves to the newest message before the `/stop` (`stop_seq`), so what the
 *                  owner sent after stopping is answered by the next turn, not swallowed by this one;
 *       failed   → the cursor stays, and the waker retries the same events after a backoff
 *                  (`retryDelayMs`). After `MAX_ATTEMPTS` failures on the same `from_seq` it moves to
 *                  `to_seq` anyway: one message that always crashes a turn must not wedge the chat.
 *
 * Every failure raises an alert to the owner in the transaction that records it (store/control.ts), so it
 * is raised exactly once whichever process closed the turn: a failed turn (rate-limited per chat), and
 * when the cap gives up, which message went unanswered.
 *
 * The price of retrying: a turn that died after sending some of its messages may say them again on the
 * retry (with different wording, so idempotency keys cannot catch it). That is accepted here; the
 * alternative, never retrying, loses the reply entirely.
 */

export const MAX_ATTEMPTS = 3;
/** The error recorded on a turn the wall-clock limit stopped (server/waker.ts). */
export const WALL_CLOCK_STOP = "stopped: ran past the wall-clock limit";
/** The wait before retrying after the first failure; it doubles with each further one. */
export const RETRY_BASE_MS = 5_000;

/**
 * Transactions that read and then write take the write lock up front. Several processes share the file;
 * a DEFERRED transaction that read a snapshot and then tries to write after another process wrote fails
 * with SQLITE_BUSY at once (the busy timeout does not apply to that case), where an IMMEDIATE one waits.
 */
export const IMMEDIATE = { behavior: "immediate" } as const;

export type Turn = typeof turns.$inferSelect;

/**
 * Claim a turn for a chat, if it has events past its cursor that ask for one (a message, a schedule come
 * due, a job's result, an external event: schema.ts `asksForTurn`) and no turn running. Every kind goes
 * through this same claim and the same cursor, so a framework event is answered exactly once like a
 * message is. The cursor is
 * read INSIDE the claiming transaction: read outside it, a turn that finished in between (moving the
 * cursor) would let the new turn start from the old cursor and answer the same messages twice. Returns
 * null when there is nothing to do or a turn is already running (the unique index is the lock).
 *
 * `trigger`: in a chat where not every message starts a turn (a group, agent/triggers.ts), the waker has
 * found the newest event that does, and names it: the turn is claimed up to it, and only while it is
 * still past the cursor.
 */
export function claimTurn(db: Db, chatId: number, trigger?: number): Turn | null {
  try {
    return db.transaction((tx) => {
      const chat = tx.select().from(chats).where(eq(chats.id, chatId)).get();
      if (!chat) return null;
      if (trigger !== undefined) {
        if (trigger <= chat.cursorSeq) return null;
        return tx.insert(turns).values({ chatId, status: "running", fromSeq: chat.cursorSeq, toSeq: trigger, triggerSeq: trigger }).returning().get();
      }
      const pending = tx
        .select({ m: max(chatEvents.seq) })
        .from(chatEvents)
        .where(and(eq(chatEvents.chatId, chatId), gt(chatEvents.seq, chat.cursorSeq), asksForTurn()))
        .get();
      if (!pending?.m) return null;
      return tx.insert(turns).values({ chatId, status: "running", fromSeq: chat.cursorSeq, toSeq: pending.m, triggerSeq: pending.m }).returning().get();
    }, IMMEDIATE);
  } catch (e) {
    if (String(e).includes("UNIQUE")) return null;
    throw e;
  }
}

export function getTurn(db: Db, id: number): Turn | undefined {
  return db.select().from(turns).where(eq(turns.id, id)).get();
}

export function runningTurns(db: Db): Turn[] {
  return db.select().from(turns).where(eq(turns.status, "running")).all();
}

export function runningTurnFor(db: Db, chatId: number): Turn | undefined {
  return db
    .select()
    .from(turns)
    .where(and(eq(turns.chatId, chatId), eq(turns.status, "running")))
    .get();
}

export function setTurnPid(db: Db, id: number, pid: number, pidStart: string | null = null): void {
  db.update(turns).set({ pid, pidStart }).where(eq(turns.id, id)).run();
}

/** Record that the waker sent SIGTERM for the wall-clock limit (the first time only). */
export function markTerm(db: Db, id: number, at: string): void {
  db.update(turns).set({ termAt: at }).where(and(eq(turns.id, id), isNull(turns.termAt))).run();
}

/** How a chat is named to the owner in the control bot. */
export function chatLabel(chat: { id: number; tgChatId: number; title: string | null }): string {
  return chat.title ? `"${chat.title}" (chat ${chat.id})` : `chat ${chat.id} (tg ${chat.tgChatId})`;
}

const excerpt = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Record which command stopped a turn (the first one wins). */
export function markStop(db: Db, id: number, stopSeq: number): void {
  db.update(turns).set({ stopSeq }).where(and(eq(turns.id, id), isNull(turns.stopSeq))).run();
}

/**
 * How long the waker should still wait before retrying a chat whose last turns failed (0 = go). The
 * delay doubles per consecutive failure, so an outage or an expired login does not burn every attempt in
 * a few seconds, and a spawn that always fails does not spin.
 */
export function retryDelayMs(db: Db, chatId: number, now: number): number {
  const recent = db.select().from(turns).where(eq(turns.chatId, chatId)).orderBy(desc(turns.id)).limit(MAX_ATTEMPTS).all();
  let n = 0;
  while (n < recent.length && recent[n]!.status === "failed") n++;
  if (!n || !recent[0]!.endedAt) return 0;
  return Math.max(0, Date.parse(recent[0]!.endedAt) + RETRY_BASE_MS * 2 ** (n - 1) - now);
}

/** Widen what the turn has been shown. Never narrows. */
export function extendTurn(db: Db, id: number, toSeq: number): void {
  const t = getTurn(db, id);
  if (t && toSeq > t.toSeq) db.update(turns).set({ toSeq }).where(eq(turns.id, id)).run();
}

export function saveSession(db: Db, chatId: number, backendSessionId: string): void {
  db.update(chats).set({ backendSessionId }).where(eq(chats.id, chatId)).run();
}

/**
 * Close a turn. `done` and `stopped` advance the cursor to what the turn was shown; `failed` does not,
 * unless this chat has now failed `MAX_ATTEMPTS` times on the same input.
 */
export function finishTurn(
  db: Db,
  id: number,
  outcome: { status: "done" | "stopped" | "failed"; error?: string; usage?: TurnUsage; contextTokens?: number },
): void {
  db.transaction((tx) => {
    const t = tx.select().from(turns).where(eq(turns.id, id)).get();
    if (!t || t.status !== "running") return; // already closed (a stop racing an end, or boot recovery)
    const u = outcome.usage;
    // A turn the wall-clock limit stopped says so on its row, whichever process closes it (the child on
    // SIGTERM, or the waker after SIGKILL): `term_at` plus this error is what tells it from an owner /stop.
    const error = outcome.status === "stopped" && t.termAt ? WALL_CLOCK_STOP : (outcome.error ?? null);
    tx.update(turns)
      .set({
        status: outcome.status,
        error,
        endedAt: new Date().toISOString(),
        ...(u
          ? {
              costMicroUsd: Math.round(u.costUsd * 1_000_000),
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              cacheReadTokens: u.cacheReadTokens,
            }
          : {}),
      })
      .where(eq(turns.id, id))
      .run();

    let cursor: number | null = null;
    if (outcome.status === "done") cursor = t.toSeq;
    else if (outcome.status === "stopped") {
      const limit = t.stopSeq != null ? Math.min(t.toSeq, t.stopSeq) : t.toSeq;
      const last = tx
        .select({ m: max(chatEvents.seq) })
        .from(chatEvents)
        .where(and(eq(chatEvents.chatId, t.chatId), gt(chatEvents.seq, t.fromSeq), lte(chatEvents.seq, limit), inArray(chatEvents.kind, TRIGGER_KINDS)))
        .get();
      cursor = last?.m ?? null;
    } else {
      const recent = tx.select().from(turns).where(eq(turns.chatId, t.chatId)).orderBy(desc(turns.id)).limit(MAX_ATTEMPTS).all();
      const chat = tx.select().from(chats).where(eq(chats.id, t.chatId)).get()!;
      const tdb = tx as unknown as Db;
      if (recent.length === MAX_ATTEMPTS && recent.every((r) => r.status === "failed" && r.fromSeq === t.fromSeq)) {
        cursor = t.toSeq;
        console.error(`chat ${t.chatId}: ${MAX_ATTEMPTS} turns failed on the same input; moving past seq ${t.toSeq} unanswered (${outcome.error ?? ""})`);
        const lost = tx
          .select()
          .from(chatEvents)
          .where(and(eq(chatEvents.chatId, t.chatId), gt(chatEvents.seq, t.fromSeq), lte(chatEvents.seq, t.toSeq), inArray(chatEvents.kind, TRIGGER_KINDS)))
          .orderBy(chatEvents.seq)
          .all();
        // One alert per message, keyed on its seq and never rate-limited: an unanswered message must not
        // go unseen because another one in the same chat was reported a minute earlier.
        for (const e of lost) {
          const p = e.payload as { text?: string; title?: string; note?: string };
          raiseAlert(tdb, {
            key: `unanswered:${e.seq}`,
            text: `Unanswered in ${chatLabel(chat)}: "${excerpt(p.text ?? p.title ?? p.note ?? e.kind)}" (#${e.seq}). ${MAX_ATTEMPTS} turns failed on it, so it was skipped. Last error: ${excerpt(outcome.error ?? "unknown", 300)}`,
          });
        }
      } else {
        raiseAlert(tdb, {
          key: `turn-failed:${t.id}`,
          topic: `turn-failed:${t.chatId}`,
          text: `Turn ${t.id} failed in ${chatLabel(chat)}: ${excerpt(outcome.error ?? "unknown", 300)}. It will be retried.`,
        });
      }
    }
    if (cursor != null && cursor > t.fromSeq) tx.update(chats).set({ cursorSeq: cursor }).where(eq(chats.id, t.chatId)).run();
    if (outcome.contextTokens !== undefined) tx.update(chats).set({ contextTokens: outcome.contextTokens }).where(eq(chats.id, t.chatId)).run();
  }, IMMEDIATE);
}
