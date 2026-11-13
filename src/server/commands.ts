import type { Api } from "grammy";
import type { BotCommand, BotCommandScope } from "grammy/types";
import { applySwitchRequest, noteStoppedTurn, pendingSwitchRequests, type SwitchOptions, type SwitchRequest } from "../agent/switch.ts";
import { openSwitchCard } from "../control/model-cards.ts";
import type { Policy } from "../policy/policy.ts";
import type { Db } from "../store/db.ts";
import { enqueueOutbound, forgetConversations, markCommandDone, pendingCommands, type CommandPayload } from "../store/events.ts";
import { IMMEDIATE, markStop, runningTurnFor, type Turn } from "../store/turns.ts";
import { signalTurn, type SignalTurn } from "./spawn.ts";

/**
 * Owner commands that act on the chat they are sent in (docs/design.md §13):
 *
 *   /stop   stop the turn running in this chat (SIGTERM to its child; it closes as `stopped`)
 *   /new    start a fresh conversation for this chat: every model's conversation of the chat is forgotten,
 *           the active one and those parked (agent/switch.ts); the chat's events and cursor are kept. A
 *           running turn is stopped first.
 *   /model  switch this chat's model: the control bot sends the owner a card for this chat
 *           (control/model-cards.ts), so nobody else in a group sees it. A running turn is NOT stopped here;
 *           the card says it will be, and the switch it asks for stops it.
 *
 * The framework does not speak (invariant 5). It acknowledges a command by reacting 👌 to it, so the
 * owner sees it took effect without a message in the assistant's chat that the assistant did not write.
 * Only the owner can send one: inbound.ts records a command only from the owner's id.
 *
 * The control bot's `/stop <chat>` (src/control/bot.ts) goes through `stopTurn` too, so the two mean the
 * same thing.
 *
 * SWITCH REQUESTS (agent/switch.ts `requestSwitch`) are applied here too (`switchRequestPass`): a running turn
 * is stopped first, and the switch applied once none runs.
 *
 * `MAIN_COMMANDS` is the one list of them: inbound.ts recognises exactly these, and the server registers
 * them with Telegram at startup (`registerCommands`) so the owner's `/` menu offers them, in his private
 * chat and, for him alone, in every group policy lists (`GroupMenus`). A new command is added here, and
 * handled in `commandPass`.
 */

export const MAIN_COMMANDS = [
  { command: "new", description: "Start a fresh conversation" },
  { command: "stop", description: "Stop the running turn" },
  { command: "model", description: "Switch this chat's model (a card in the control bot)" },
] as const satisfies readonly (BotCommand & { command: CommandPayload["command"] })[];

/**
 * Register a bot's command menu, scoped to the owner's private chat so nobody else sees one. Idempotent
 * (`setMyCommands` replaces the list). A Telegram error is logged and swallowed: a missing menu must never
 * stop the server.
 */
export async function registerCommands(api: Api, ownerId: number, commands: readonly BotCommand[], bot: string): Promise<boolean> {
  return setMenu(api, { type: "chat", chat_id: ownerId }, commands, bot, "register commands");
}

/** `setMyCommands` (or, with `commands` null, `deleteMyCommands`) for one scope; an error is logged, not thrown. */
async function setMenu(api: Api, scope: BotCommandScope, commands: readonly BotCommand[] | null, bot: string, what: string): Promise<boolean> {
  try {
    if (commands) await api.setMyCommands([...commands], { scope });
    else await api.deleteMyCommands({ scope });
    return true;
  } catch (e) {
    const where = scope.type === "chat_member" ? ` in group ${scope.chat_id}` : "";
    console.error(`${bot}: could not ${what}${where}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** The groups policy lists: every `chats` key but `dm` (policy.ts refuses any other private chat). */
export function listedGroups(policy: Policy): number[] {
  return Object.keys(policy.chats)
    .filter((k) => k !== "dm")
    .map(Number)
    .sort((a, b) => a - b);
}

/**
 * The owner's `/` menu in groups. Telegram offers a bot's commands only where a scope covers, so each group
 * policy lists gets the commands with scope `chat_member` (that group, the owner only: nobody else in it
 * sees a menu). `sync` is called with the current policy at startup and on every policy pass; it calls
 * Telegram only when the set of listed groups changed: a group added gets the menu, a group removed has its
 * scope deleted. A group whose call failed (the bot was removed, the chat is gone) is logged and retried at
 * the next change, never thrown: one group never stops the others or the server.
 */
export class GroupMenus {
  /** The listed groups as of the last sync; null before the first. */
  private listed: string | null = null;
  /** Groups that have the menu, as far as we know. */
  private readonly menued = new Set<number>();
  /** Groups whose setMyCommands / deleteMyCommands failed: tried again at the next change. */
  private readonly failed = new Set<number>();

  constructor(
    private readonly api: Api,
    private readonly ownerId: number,
    private readonly commands: readonly BotCommand[] = MAIN_COMMANDS,
    private readonly bot = "main bot",
  ) {}

  /** Bring the group menus in line with `policy`. Returns how many Telegram calls it made (0: nothing changed). */
  async sync(policy: Policy): Promise<number> {
    const groups = listedGroups(policy);
    const key = groups.join(",");
    if (key === this.listed) return 0;
    this.listed = key;
    const want = new Set(groups);
    const retry = [...this.failed];
    this.failed.clear();
    let calls = 0;
    for (const g of groups) {
      if (this.menued.has(g) && !retry.includes(g)) continue;
      calls++;
      if (await setMenu(this.api, this.scope(g), this.commands, this.bot, "register commands")) this.menued.add(g);
      else this.failed.add(g);
    }
    // A group whose delete failed is still in `menued`, so it is tried again here.
    for (const g of [...this.menued]) {
      if (want.has(g)) continue;
      calls++;
      if (await setMenu(this.api, this.scope(g), null, this.bot, "clear commands")) this.menued.delete(g);
      else this.failed.add(g);
    }
    return calls;
  }

  private scope(groupId: number): BotCommandScope {
    return { type: "chat_member", chat_id: groupId, user_id: this.ownerId };
  }
}

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

/**
 * Apply the pending switch requests (agent/switch.ts), each chat's in the order they were asked. A chat with a
 * turn running has it stopped (SIGTERM, once per turn, noted on the request) and waits for a later pass: the
 * waker starts no turn there meanwhile (server/waker.ts). The stop is placed at the turn's start (`stopSeq` =
 * its `from_seq`), so the cursor does not move past what it was answering: those messages are answered by the
 * next turn, on the new model, and a lossless switch carries only what the conversation held when the stopped
 * turn began, so the new model gets them once, as input (agent/switch.ts). Whatever the stopped turn already
 * sent to Telegram is answered again: accepted, the owner asked to stop it. Once nothing runs the switch is
 * applied, and its result or error stored on the request. Returns the requests finished in this pass.
 */
export function switchRequestPass(db: Db, signal: SignalTurn = signalTurn, opts: SwitchOptions = {}): SwitchRequest[] {
  const finished: SwitchRequest[] = [];
  const waiting = new Set<number>();
  for (const req of pendingSwitchRequests(db)) {
    if (waiting.has(req.chatId)) continue;
    const running = runningTurnFor(db, req.chatId);
    if (running) {
      if (req.stoppedTurnId !== running.id) {
        stopTurn(db, req.chatId, running.fromSeq, signal);
        noteStoppedTurn(db, req.id, running.id);
      }
      waiting.add(req.chatId);
      continue;
    }
    finished.push(applySwitchRequest(db, req, opts));
  }
  return finished;
}

export function commandPass(db: Db, signal: SignalTurn = signalTurn): number {
  let handled = 0;
  for (const cmd of pendingCommands(db)) {
    const p = cmd.payload as unknown as CommandPayload;
    let note: string;
    switch (p.command) {
      case "stop":
      case "new": {
        const running = stopTurn(db, cmd.chatId, cmd.seq, signal);
        note = running ? `stopped turn ${running.id}` : "no turn running";
        if (p.command === "new") {
          forgetConversations(db, cmd.chatId);
          note += "; conversation reset";
        }
        break;
      }
      case "model":
        // One transaction: the card, its message, the 👌 and the command marked done all happen, or none does,
        // so a crash in between never leaves the command done with no card (or a card's key used with none).
        db.transaction((tx) => {
          const t = tx as unknown as Db;
          const card = openSwitchCard(t, cmd.chatId, `command:${cmd.seq}`);
          acknowledge(t, cmd.chatId, cmd.seq, card ? `model card ${card.id} sent to the control bot` : "model card already sent");
        }, IMMEDIATE);
        handled++;
        continue;
      default:
        throw new Error(`unknown command "${String(p.command satisfies never)}"`);
    }
    acknowledge(db, cmd.chatId, cmd.seq, note);
    handled++;
  }
  return handled;
}

/** React 👌 to command `seq` and mark it done. */
function acknowledge(db: Db, chatId: number, seq: number, note: string): void {
  enqueueOutbound(db, { chatId, kind: "bot_reaction", payload: { targetSeq: seq, emoji: "👌" }, idemKey: `command:${seq}` });
  markCommandDone(db, seq, note);
}
