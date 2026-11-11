import { GrammyError, HttpError, type Api } from "grammy";
import type { Db } from "../store/db.ts";
import {
  getChat,
  getEvent,
  markFailed,
  markSent,
  pendingOutbound,
  recordPartSent,
  type BotMessagePayload,
  type BotReactionPayload,
  type ChatEvent,
} from "../store/events.ts";
import { renderParts } from "../telegram/format.ts";

/**
 * The only code that sends anything to Telegram. Runner children queue; this delivers, in seq order.
 *
 * Exactly-once, as far as Telegram allows: a row is sent only while `pending`, and each delivered part of
 * a long message is recorded before the next is sent, so a restart resumes after the last recorded part.
 * Two windows are left, both where Telegram accepted a part but we never learned so, and the part is
 * sent once more: a crash between the response and recording it, and a network error (a timeout, a
 * lost response) on a request Telegram did carry out. The Bot API has no idempotency key to close either.
 *
 * Failures, by kind:
 *   - 429: wait `retry_after`, then try the same row again. Nothing after it in the queue is sent first,
 *     so the chat keeps its order.
 *   - the HTML was refused ("can't parse entities"): send that part as plain markdown instead.
 *   - any other 4xx: the row is `failed` with Telegram's reason; the queue moves on.
 *   - a network error or a 5xx: the row stays `pending` and is retried on the next pass.
 */

export interface SendResult {
  sent: number;
  failed: number;
  /** Milliseconds the caller should wait before the next pass (a 429 or a network error). */
  backoffMs: number;
}

const isParseError = (e: GrammyError) => e.error_code === 400 && /can't parse entities|unsupported start tag|can't find end/i.test(e.description);

/** The Telegram message id of an event, whichever side wrote it. */
function tgIdOf(e: ChatEvent | undefined): number | undefined {
  if (!e) return undefined;
  if (e.tgMessageId) return e.tgMessageId;
  return (e.payload as unknown as BotMessagePayload).sentParts?.[0];
}

async function sendMessage(db: Db, api: Api, row: ChatEvent, tgChatId: number): Promise<void> {
  const p = row.payload as unknown as BotMessagePayload;
  const parts = renderParts(p.text);
  const replyTo = p.replyToSeq ? tgIdOf(getEvent(db, p.replyToSeq)) : undefined;
  let payload = p;
  for (let i = payload.sentParts?.length ?? 0; i < parts.length; i++) {
    const part = parts[i]!;
    const reply = i === 0 && replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {};
    let msg;
    try {
      msg = await api.sendMessage(tgChatId, part.html, { parse_mode: "HTML", link_preview_options: { is_disabled: false }, ...reply });
    } catch (e) {
      if (!(e instanceof GrammyError) || !isParseError(e)) throw e;
      msg = await api.sendMessage(tgChatId, part.plain, reply);
    }
    recordPartSent(db, row.seq, payload, msg.message_id);
    payload = { ...payload, sentParts: [...(payload.sentParts ?? []), msg.message_id] };
  }
  markSent(db, row.seq, payload.sentParts?.[0] ?? null);
}

async function sendReaction(db: Db, api: Api, row: ChatEvent, tgChatId: number): Promise<void> {
  const p = row.payload as unknown as BotReactionPayload;
  const target = tgIdOf(getEvent(db, p.targetSeq));
  if (!target) {
    // The target is an outbound message not delivered yet; leave the reaction for a later pass.
    const t = getEvent(db, p.targetSeq);
    if (t?.status === "pending") throw new Pending();
    markFailed(db, row.seq, `target #${p.targetSeq} has no Telegram message`);
    return;
  }
  await api.setMessageReaction(tgChatId, target, [{ type: "emoji", emoji: p.emoji as never }]);
  markSent(db, row.seq, null);
}

class Pending extends Error {}

/** One pass over the queue. Stops at the first row that must wait, so a chat's order is never broken. */
export async function sendPass(db: Db, api: Api): Promise<SendResult> {
  const res: SendResult = { sent: 0, failed: 0, backoffMs: 0 };
  for (const row of pendingOutbound(db)) {
    const chat = getChat(db, row.chatId);
    if (!chat) {
      markFailed(db, row.seq, "unknown chat");
      res.failed++;
      continue;
    }
    try {
      if (row.kind === "bot_message") await sendMessage(db, api, row, chat.tgChatId);
      else await sendReaction(db, api, row, chat.tgChatId);
      res.sent++;
    } catch (e) {
      if (e instanceof Pending) return res;
      if (e instanceof GrammyError && e.error_code === 429) {
        res.backoffMs = ((e.parameters.retry_after ?? 1) + 0.5) * 1000;
        return res;
      }
      if (e instanceof GrammyError && e.error_code >= 400 && e.error_code < 500) {
        markFailed(db, row.seq, `${e.error_code} ${e.description}`);
        res.failed++;
        continue;
      }
      if (e instanceof HttpError || (e instanceof GrammyError && e.error_code >= 500)) {
        res.backoffMs = 2000;
        return res;
      }
      throw e;
    }
  }
  return res;
}
