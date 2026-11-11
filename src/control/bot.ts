import { and, asc, count, desc, eq, gte, inArray, lt, max } from "drizzle-orm";
import { GrammyError, HttpError, type Api } from "grammy";
import type { BotCommand, Update } from "grammy/types";
import { formatTime } from "../agent/render.ts";
import { stopTurn } from "../server/commands.ts";
import type { SignalTurn } from "../server/spawn.ts";
import { markControlFailed, markControlSent, pendingControl, queueReply, raiseAlert, approvalCard, type ControlMessage } from "../store/control.ts";
import type { Db } from "../store/db.ts";
import { allChats, getChat, kvGet, kvSet, type Speaker } from "../store/events.ts";
import { approvals, chatEvents, OUTBOUND_KINDS, turns } from "../store/schema.ts";
import { chatLabel, IMMEDIATE, runningTurns } from "../store/turns.ts";
import { answerApproval, cardKeyboard, getApproval, parseCallback } from "./approvals.ts";

/**
 * The control bot (docs/design.md §13): a second Telegram bot, `SHUVI_CONTROL_BOT_TOKEN`, that is the
 * FRAMEWORK's voice to the owner, so the assistant's chats never carry a word the assistant did not write
 * (invariant 5). It answers the owner's user id only; any other sender is ignored without a reply.
 *
 *   /status          running turns, recently failed turns, outbound rows still pending, the deployed commit
 *   /stop <chat>     stop that chat's turn, exactly as `/stop` in the chat does (server/commands.ts
 *                    `stopTurn`); <chat> is the chat number /status shows, or its Telegram id
 *   approval buttons recorded through approvals.ts
 *
 * `CONTROL_COMMANDS` is the one list of the commands: /help is built from it, and the server registers it
 * with Telegram at startup (server/commands.ts `registerCommands`) for the owner's `/` menu. A new command
 * is added there and handled in `handleUpdate`.
 *
 * Inbound works like the main poller (server/poller.ts): its own offset in `kv`
 * (`control_telegram_offset`), advanced in the SAME transaction that handles the batch, so a command is
 * handled once and its reply queued once (keyed on the update). Outbound goes through `control_messages`
 * (store/control.ts) and is delivered by `controlSendPass`, the only code that talks to the control bot's
 * API besides the poller. Signals to stop a turn are sent after the batch commits.
 *
 * Its messages are short, factual and English. `SHUVI_OWNER_LANGUAGE` is deliberately not used here yet:
 * localising the control bot is a later step.
 *
 * Alerts it carries, and where each is raised:
 *   - a turn failed / a message was given up after the retry cap: store/turns.ts `finishTurn`;
 *   - a turn passed the wall-clock limit: server/waker.ts;
 *   - a chat's conversation was lost and restarted: agent/turn.ts;
 *   - outbound rows failed or stuck pending: `outboundAlertPass` here;
 *   - a failed backup: control/backup.ts.
 */

export const CONTROL_OFFSET_KEY = "control_telegram_offset";
/** Telegram's limit on one message. Control messages are short; anything longer is cut. */
const MAX_TEXT = 4096;

export interface ControlDeps {
  ownerId: number;
  /** The deployed commit, shown by /status. */
  commit: string;
  timeZone: string;
  signal?: SignalTurn;
  now?: () => number;
}

export const CONTROL_COMMANDS = [
  { command: "status", description: "Running turns, recent failures, pending outbound, commit" },
  { command: "stop", description: "Stop a chat's turn: /stop <chat> (the number from /status)" },
] as const satisfies readonly BotCommand[];

const HELP = ["Commands:", ...CONTROL_COMMANDS.map((c) => `/${c.command}: ${c.description}`)].join("\n");

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const oneLine = (s: string, n = 160) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * The commit this server runs: `SHUVI_COMMIT` when the deployment sets it (a build without .git), else
 * `git describe --always --dirty` of the code checkout, read once at startup.
 */
export function deployedCommit(repoDir: string, env: Record<string, string | undefined> = process.env): string {
  if (env.SHUVI_COMMIT) return env.SHUVI_COMMIT;
  const r = Bun.spawnSync(["git", "-C", repoDir, "describe", "--always", "--dirty"], { stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "unknown";
}

/** What /status says. */
export function statusText(db: Db, deps: ControlDeps): string {
  const now = (deps.now ?? Date.now)();
  const label = (chatId: number) => {
    const c = getChat(db, chatId);
    return c ? chatLabel(c) : `chat ${chatId}`;
  };
  const lines = [`shuvi, commit ${deps.commit}`];

  const running = runningTurns(db);
  lines.push("", `Running turns: ${running.length}`);
  for (const t of running) {
    lines.push(`- ${label(t.chatId)}: turn ${t.id}, running ${ago(now - Date.parse(t.startedAt))}, pid ${t.pid ?? "none yet"}${t.termAt ? ", stopping (wall-clock limit)" : ""}`);
  }

  const since = new Date(now - 24 * 3600_000).toISOString();
  const failed = db.select().from(turns).where(and(eq(turns.status, "failed"), gte(turns.endedAt, since))).orderBy(desc(turns.id)).limit(5).all();
  const failedCount = db.select({ n: count() }).from(turns).where(and(eq(turns.status, "failed"), gte(turns.endedAt, since))).get()?.n ?? 0;
  lines.push("", `Failed turns, last 24h: ${failedCount}${failedCount > failed.length ? ` (latest ${failed.length})` : ""}`);
  for (const t of failed) lines.push(`- turn ${t.id}, ${label(t.chatId)}, ${formatTime(t.endedAt!, deps.timeZone)}: ${oneLine(t.error ?? "unknown")}`);

  const pending = db
    .select({ n: count() })
    .from(chatEvents)
    .where(and(inArray(chatEvents.kind, OUTBOUND_KINDS), eq(chatEvents.status, "pending")))
    .get();
  const oldest = db
    .select({ at: chatEvents.at })
    .from(chatEvents)
    .where(and(inArray(chatEvents.kind, OUTBOUND_KINDS), eq(chatEvents.status, "pending")))
    .orderBy(asc(chatEvents.seq))
    .limit(1)
    .get();
  lines.push("", `Outbound pending: ${pending?.n ?? 0}${oldest ? ` (oldest ${ago(now - Date.parse(oldest.at))} old)` : ""}`);

  const waiting = db.select({ n: count() }).from(approvals).where(eq(approvals.status, "pending")).get()?.n ?? 0;
  if (waiting) lines.push(`Approvals waiting: ${waiting}`);
  return lines.join("\n");
}

/** Find a chat by the number /status shows, or by its Telegram id. */
function findChat(db: Db, arg: string) {
  const n = Number(arg);
  if (!arg || !Number.isSafeInteger(n)) return undefined;
  return getChat(db, n) ?? allChats(db).find((c) => c.tgChatId === n);
}

/** The newest seq in the store: a stop made now sits after every event recorded so far. */
function currentSeq(db: Db): number {
  return db.select({ m: max(chatEvents.seq) }).from(chatEvents).get()?.m ?? 0;
}

interface Handled {
  /** Callback queries to answer once the batch is committed. */
  callbacks: { id: string; text: string }[];
  /** Signals to send once the batch is committed. */
  signals: { pid: number; start: string | null }[];
}

function speakerOf(u: { id: number; first_name: string; last_name?: string; username?: string }): Speaker {
  return { id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || String(u.id) };
}

function handleUpdate(db: Db, u: Update, deps: ControlDeps, out: Handled): void {
  const now = (deps.now ?? Date.now)();
  const cq = u.callback_query;
  if (cq) {
    if (cq.from.id !== deps.ownerId) return; // not the owner: no answer at all
    const parsed = parseCallback(cq.data);
    const r = parsed ? answerApproval(db, parsed.approvalId, parsed.option, speakerOf(cq.from), now) : { result: "closed" as const };
    out.callbacks.push({ id: cq.id, text: r.result === "answered" ? `Recorded: ${r.label}` : "This card is closed." });
    return;
  }
  const m = u.message;
  if (!m || m.chat.type !== "private" || m.from?.id !== deps.ownerId) return;
  const key = `update:${u.update_id}`;
  const cmd = m.text?.match(/^\/(\w+)(?:@\w+)?(?:\s+(.*))?$/s);
  const name = cmd?.[1];
  const arg = cmd?.[2]?.trim() ?? "";
  if (name === "status") return queueReply(db, key, statusText(db, deps));
  if (name === "stop") {
    const chat = findChat(db, arg);
    if (!chat) return queueReply(db, key, arg ? `No chat ${arg}. /status lists the chats with running turns.` : "Usage: /stop <chat>");
    const stopped = stopTurn(db, chat.id, currentSeq(db), (pid, start) => out.signals.push({ pid, start }));
    return queueReply(db, key, stopped ? `Stopping turn ${stopped.id} in ${chatLabel(chat)}.` : `No turn is running in ${chatLabel(chat)}.`);
  }
  queueReply(db, key, HELP);
}

/** Handle one batch and advance the offset past it, atomically. */
export function recordControlBatch(db: Db, updates: Update[], deps: ControlDeps): Handled {
  const out: Handled = { callbacks: [], signals: [] };
  if (!updates.length) return out;
  db.transaction((tx) => {
    const tdb = tx as unknown as Db;
    for (const u of updates) handleUpdate(tdb, u, deps, out);
    kvSet(tdb, CONTROL_OFFSET_KEY, String(updates.at(-1)!.update_id + 1));
  }, IMMEDIATE);
  return out;
}

/** One long-poll round of the control bot. */
export async function controlPollOnce(db: Db, api: Api, deps: ControlDeps & { signal: SignalTurn }, timeoutSec = 25, abort?: AbortSignal): Promise<number> {
  const v = kvGet(db, CONTROL_OFFSET_KEY);
  const updates = await api.getUpdates(
    { ...(v ? { offset: Number(v) } : {}), timeout: timeoutSec, allowed_updates: ["message", "callback_query"] },
    abort as never, // grammY types its own AbortSignal shim
  );
  const out = recordControlBatch(db, updates, deps);
  for (const s of out.signals) deps.signal(s.pid, s.start, "SIGTERM");
  // Best effort: an unanswered callback only leaves the button's spinner on for a few seconds.
  for (const c of out.callbacks) await api.answerCallbackQuery(c.id, { text: c.text }).catch(() => {});
  return updates.length;
}

const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);

class Wait extends Error {}

async function deliver(db: Db, api: Api, ownerId: number, row: ControlMessage): Promise<void> {
  if (row.kind === "approval") {
    const a = getApproval(db, row.approvalId!);
    // A card answered or expired before it was ever sent has nothing left to ask.
    if (!a || a.status !== "pending") return markControlSent(db, row.id, null);
    const msg = await api.sendMessage(ownerId, clip(row.text), { reply_markup: { inline_keyboard: cardKeyboard(a) } });
    return markControlSent(db, row.id, msg.message_id);
  }
  if (row.kind === "approval_closed") {
    const card = approvalCard(db, row.approvalId!);
    if (card?.status === "pending") throw new Wait(); // the card itself goes first (it is older; this only guards)
    if (!card?.tgMessageId) return markControlSent(db, row.id, null);
    try {
      await api.editMessageText(ownerId, card.tgMessageId, clip(row.text), { reply_markup: { inline_keyboard: [] } });
    } catch (e) {
      if (!(e instanceof GrammyError && /message is not modified/i.test(e.description))) throw e;
    }
    return markControlSent(db, row.id, card.tgMessageId);
  }
  const msg = await api.sendMessage(ownerId, clip(row.text));
  markControlSent(db, row.id, msg.message_id);
}

/** How long to wait before trying again while the control bot cannot reach the owner at all. */
export const UNREACHABLE_BACKOFF_MS = 60_000;

/**
 * The owner has not opened a chat with the control bot yet (or blocked it): Telegram answers 403, or 400
 * "chat not found". That is about the chat, not the row, so nothing is marked failed: every row waits
 * until the owner sends the bot /start.
 */
const isUnreachable = (e: GrammyError) => e.error_code === 403 || (e.error_code === 400 && /chat not found/i.test(e.description));
let warnedUnreachable = false;

/**
 * Deliver the control outbox, oldest first, with the main sender's failure rules (server/sender.ts): a
 * 429 waits and retries the same row; another 4xx marks it failed; a network error or 5xx retries later.
 * One exception: an owner the bot cannot reach (`isUnreachable`) is "retry later", logged loudly once,
 * never a permanent failure, so the alerts queued meanwhile are delivered once the owner sends /start.
 * Delivery is therefore at-least-once: a send whose response is lost is sent again.
 */
export async function controlSendPass(db: Db, api: Api, ownerId: number): Promise<{ sent: number; failed: number; backoffMs: number }> {
  const res = { sent: 0, failed: 0, backoffMs: 0 };
  for (const row of pendingControl(db)) {
    try {
      await deliver(db, api, ownerId, row);
      res.sent++;
      warnedUnreachable = false;
    } catch (e) {
      if (e instanceof Wait) return res;
      if (e instanceof GrammyError && e.error_code === 429) {
        res.backoffMs = ((e.parameters.retry_after ?? 1) + 0.5) * 1000;
        return res;
      }
      if (e instanceof GrammyError && isUnreachable(e)) {
        if (!warnedUnreachable) {
          console.error(
            `CONTROL BOT CANNOT REACH THE OWNER (${e.error_code} ${e.description}): send /start to the control bot from user ${ownerId}. ` +
              `${pendingControl(db).length} message(s) wait for it; retrying every ${UNREACHABLE_BACKOFF_MS / 1000}s.`,
          );
          warnedUnreachable = true;
        }
        res.backoffMs = UNREACHABLE_BACKOFF_MS;
        return res;
      }
      if (e instanceof GrammyError && e.error_code >= 400 && e.error_code < 500) {
        markControlFailed(db, row.id, `${e.error_code} ${e.description}`);
        console.error(`control: could not deliver #${row.id}: ${e.description}`);
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

/**
 * Alert on the assistant's outbound rows that are not getting through: a row that FAILED (Telegram
 * refused it) in the last day, and a row still pending after `staleMs`. One alert per row at most (keyed
 * on its seq), rate-limited per chat.
 */
export function outboundAlertPass(db: Db, staleMs: number, now = Date.now()): number {
  let raised = 0;
  const dayAgo = new Date(now - 24 * 3600_000).toISOString();
  const failed = db
    .select()
    .from(chatEvents)
    .where(and(inArray(chatEvents.kind, OUTBOUND_KINDS), eq(chatEvents.status, "failed"), gte(chatEvents.at, dayAgo)))
    .all();
  for (const r of failed) {
    const chat = getChat(db, r.chatId);
    const what = r.kind === "bot_message" ? "A message" : r.kind === "bot_file" ? "A file" : "A reaction";
    if (raiseAlert(db, { key: `outbound-failed:${r.seq}`, topic: `outbound:${r.chatId}`, text: `${what} to ${chat ? chatLabel(chat) : `chat ${r.chatId}`} could not be delivered (#${r.seq}): ${oneLine(r.note ?? "unknown")}` }, now) === "pending") raised++;
  }
  const staleBefore = new Date(now - staleMs).toISOString();
  const stale = db
    .select({ chatId: chatEvents.chatId, seq: chatEvents.seq, at: chatEvents.at })
    .from(chatEvents)
    .where(and(inArray(chatEvents.kind, OUTBOUND_KINDS), eq(chatEvents.status, "pending"), lt(chatEvents.at, staleBefore)))
    .orderBy(asc(chatEvents.seq))
    .all();
  const firstPerChat = new Map<number, (typeof stale)[number]>();
  for (const r of stale) if (!firstPerChat.has(r.chatId)) firstPerChat.set(r.chatId, r);
  for (const r of firstPerChat.values()) {
    const chat = getChat(db, r.chatId);
    const n = stale.filter((s) => s.chatId === r.chatId).length;
    const text = `${n} outbound row(s) to ${chat ? chatLabel(chat) : `chat ${r.chatId}`} pending for more than ${Math.round(staleMs / 60_000)} min (oldest #${r.seq}, ${ago(now - Date.parse(r.at))} old).`;
    if (raiseAlert(db, { key: `outbound-stale:${r.seq}`, topic: `outbound:${r.chatId}`, text }, now) === "pending") raised++;
  }
  return raised;
}
