import type { Db } from "../store/db.ts";
import { enqueueOutbound, markCommandDone, pendingCommands, resetConversation, type CommandPayload } from "../store/events.ts";
import { markStop, runningTurnFor, type Turn } from "../store/turns.ts";
import { signalTurn, type SignalTurn } from "./spawn.ts";

/**
 * Owner commands that act on the chat they are sent in (docs/design.md §13):
 *
 *   /stop   stop the turn running in this chat (SIGTERM to its child; it closes as `stopped`)
 *   /new    start a fresh conversation for this chat: the model's conversation is forgotten, the chat's
 *           events and cursor are kept. A running turn is stopped first.
 *
 * The framework does not speak (invariant 5). It acknowledges a command by reacting 👌 to it, so the
 * owner sees it took effect without a message in the assistant's chat that the assistant did not write.
 * Only the owner can send one: inbound.ts records a command only from the owner's id.
 *
 * The control bot's `/stop <chat>` (src/control/bot.ts) goes through `stopTurn` too, so the two mean the
 * same thing.
 */

/**
 * Stop the turn running in a chat, if any. `stopSeq` is where the stop happened in the chat's log: the
 * messages after it are not the stopped turn's to swallow, and the next turn answers them. Marked before
 * the signal, so the turn cannot close in between without knowing it.
 */
export function stopTurn(db: Db, chatId: number, stopSeq: number, signal: SignalTurn = signalTurn): Turn | undefined {
  const running = runningTurnFor(db, chatId);
  if (!running) return undefined;
  markStop(db, running.id, stopSeq);
  if (running.pid) signal(running.pid, running.pidStart, "SIGTERM");
  return running;
}

export function commandPass(db: Db, signal: SignalTurn = signalTurn): number {
  let handled = 0;
  for (const cmd of pendingCommands(db)) {
    const p = cmd.payload as unknown as CommandPayload;
    const running = stopTurn(db, cmd.chatId, cmd.seq, signal);
    let note = running ? `stopped turn ${running.id}` : "no turn running";
    if (p.command === "new") {
      resetConversation(db, cmd.chatId);
      note += "; conversation reset";
    }
    enqueueOutbound(db, { chatId: cmd.chatId, kind: "bot_reaction", payload: { targetSeq: cmd.seq, emoji: "👌" }, idemKey: `command:${cmd.seq}` });
    markCommandDone(db, cmd.seq, note);
    handled++;
  }
  return handled;
}
