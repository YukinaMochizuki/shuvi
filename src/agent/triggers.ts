import { and, desc, eq, lt } from "drizzle-orm";
import type { ChatPolicy } from "../policy/policy.ts";
import type { Db } from "../store/db.ts";
import { getEvent, kvGet, kvSet, triggersAfter, type BotMessagePayload, type Chat, type ChatEvent, type ExternalPayload, type MessagePayload } from "../store/events.ts";
import { chatEvents, turns } from "../store/schema.ts";

/**
 * WHICH events start a turn, per chat (docs/design.md §7). In the owner's DM every message does (policy
 * `trigger: all`). In a group every message is recorded, but only these start one:
 *
 *   mention    the message names her: her @username, or a text mention of her user
 *   reply      it replies to one of her messages (Telegram's reply target is her user)
 *   followup   it comes from someone her last turn was answering, while that turn ran or within
 *              `followup_minutes` after it ended (its end, or its last message if later), and is not
 *              addressed to someone else (not a reply to another person, no mention of anyone but her)
 *
 * "Her last turn" is the chat's latest turn woken by an event before this message (`turns.trigger_seq`),
 * so a message sent WHILE a turn runs and not shown to it (the turn made no tool call after it arrived)
 * still counts, and starts the next turn. "Someone it was answering": whoever sent the event that woke it,
 * and whoever its messages replied to. A message she sends into the group from the owner's DM (`send`)
 * belongs to a DM turn, so it neither opens nor closes a follow-up window here.
 *
 * ANOTHER BOT starts a turn only by mentioning her: never by a reply or as a follow-up, so two bots cannot
 * keep waking each other.
 *
 * Framework events (a schedule, a job's result, an approval, an external event that asks for one) start a
 * turn wherever they land, as in the DM.
 *
 * The decision about one event depends on the event and on the chat's turns up to it; it can change only
 * while the turn it follows is still running, and that turn's end moves the cursor, which makes the
 * waker judge again (`TriggerScan`). Followups are judged here, at the routing layer, and cheaply: a wrong
 * call costs a turn in which she can `pass`.
 */

/** Who the bot is, as Telegram says (getMe). The server records it in kv for the runner children. */
export interface BotIdentity {
  id: number;
  username?: string;
}

const BOT_KEY = "bot_identity";

export function saveBotIdentity(db: Db, bot: BotIdentity): void {
  const v = JSON.stringify(bot);
  if (kvGet(db, BOT_KEY) !== v) kvSet(db, BOT_KEY, v);
}

export function botIdentity(db: Db): BotIdentity | undefined {
  const v = kvGet(db, BOT_KEY);
  return v ? (JSON.parse(v) as BotIdentity) : undefined;
}

/** Does the message name the bot (its @username, or a text mention of it)? */
export function mentionsBot(p: MessagePayload, bot: BotIdentity | undefined): boolean {
  if (!bot) return false;
  const name = bot.username?.toLowerCase();
  return (!!name && (p.mentions?.usernames ?? []).includes(name)) || (p.mentions?.userIds ?? []).includes(bot.id);
}

/** Is the message a reply to one of hers? */
export function repliesToBot(p: MessagePayload, bot: BotIdentity | undefined): boolean {
  return !!bot && p.replyTo?.fromId === bot.id;
}

/** Is the message addressed to someone other than her (a reply to them, or a mention of them only)? */
export function addressedElsewhere(p: MessagePayload, bot: BotIdentity | undefined): boolean {
  if (p.replyTo && !repliesToBot(p, bot)) return true;
  const named = (p.mentions?.usernames.length ?? 0) + (p.mentions?.userIds.length ?? 0);
  return named > 0 && !mentionsBot(p, bot);
}

const senderOf = (db: Db, chatId: number, seq: number | null | undefined): number | undefined => {
  if (seq == null) return undefined;
  const t = getEvent(db, seq);
  return t?.kind === "message" && t.chatId === chatId ? (t.payload as unknown as MessagePayload).from.id : undefined;
};

/** Is `e` a follow-up to her last turn? */
export function isFollowup(db: Db, e: ChatEvent, p: MessagePayload, minutes: number, bot: BotIdentity | undefined): boolean {
  if (p.from.isBot || addressedElsewhere(p, bot)) return false;
  const t = db
    .select()
    .from(turns)
    .where(and(eq(turns.chatId, e.chatId), lt(turns.triggerSeq, e.seq)))
    .orderBy(desc(turns.id))
    .limit(1)
    .get();
  if (!t) return false;
  const said = db
    .select()
    .from(chatEvents)
    .where(and(eq(chatEvents.chatId, e.chatId), eq(chatEvents.kind, "bot_message"), eq(chatEvents.turnId, t.id)))
    .all();
  const answered = new Set<number | undefined>([senderOf(db, e.chatId, t.triggerSeq), ...said.map((b) => senderOf(db, e.chatId, (b.payload as unknown as BotMessagePayload).replyToSeq))]);
  if (!answered.has(p.from.id)) return false;
  if (t.status === "running") return true;
  const end = Math.max(Date.parse(t.endedAt ?? t.startedAt), ...said.map((b) => Date.parse(b.at)));
  return Date.parse(e.at) <= end + minutes * 60_000;
}

/** Does `e` start a turn in a chat with policy `cp`? */
export function isTrigger(db: Db, e: ChatEvent, cp: Pick<ChatPolicy, "trigger" | "followupMinutes">, bot: BotIdentity | undefined): boolean {
  if (e.kind === "external") return (e.payload as unknown as ExternalPayload).trigger !== false;
  if (e.kind !== "message") return e.kind === "approval" || e.kind === "scheduled" || e.kind === "job_done";
  if (cp.trigger === "all") return true;
  const p = e.payload as unknown as MessagePayload;
  if (cp.trigger.includes("mention") && mentionsBot(p, bot)) return true;
  if (p.from.isBot) return false; // another bot: a mention only (see the header)
  if (cp.trigger.includes("reply") && repliesToBot(p, bot)) return true;
  return cp.trigger.includes("followup") && isFollowup(db, e, p, cp.followupMinutes, bot);
}

/**
 * The waker's memory of how far it has judged each chat's events, so a busy group's untriggered backlog
 * is read once, not on every pass. Only an optimisation: a new server starts with an empty one and judges
 * the backlog again, to the same answers. Reset for a chat when its cursor moves or the policy changes.
 */
export class TriggerScan {
  private readonly chats = new Map<number, { cursor: number; policy: unknown; checkedTo: number; newest: number | null }>();

  /** The newest event past the chat's cursor that starts a turn, or null. */
  newestTrigger(db: Db, chat: Chat, cp: ChatPolicy, bot: BotIdentity | undefined, policyRef: unknown): number | null {
    let s = this.chats.get(chat.id);
    if (!s || s.cursor !== chat.cursorSeq || s.policy !== policyRef) {
      s = { cursor: chat.cursorSeq, policy: policyRef, checkedTo: chat.cursorSeq, newest: null };
      this.chats.set(chat.id, s);
    }
    for (const e of triggersAfter(db, chat.id, s.checkedTo)) {
      if (isTrigger(db, e, cp, bot)) s.newest = e.seq;
      s.checkedTo = e.seq;
    }
    return s.newest;
  }
}
