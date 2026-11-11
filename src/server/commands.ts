import type { Db } from "../store/db.ts";
import { enqueueOutbound, markCommandDone, pendingCommands, resetConversation, type CommandPayload } from "../store/events.ts";
import { markStop, runningTurnFor } from "../store/turns.ts";

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
 */

export type Kill = (pid: number) => void;

const defaultKill: Kill = (pid) => {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone: the waker reaps it
  }
};

export function commandPass(db: Db, kill: Kill = defaultKill): number {
  let handled = 0;
  for (const cmd of pendingCommands(db)) {
    const p = cmd.payload as unknown as CommandPayload;
    const running = runningTurnFor(db, cmd.chatId);
    if (running) {
      // Before the signal: what the owner sends from this command on is not the stopped turn's to swallow.
      markStop(db, running.id, cmd.seq);
      if (running.pid) kill(running.pid);
    }
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
