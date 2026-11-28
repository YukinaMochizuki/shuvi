import { driverModel } from "../agent/backend.ts";
import { buildPromptSections, joinSections } from "../agent/prompt.ts";
import { hasPendingSwitch } from "../agent/switch.ts";
import type { TurnState } from "../agent/turn.ts";
import { HomeLayers } from "../capabilities/memory/layers.ts";
import { capabilityTools, turnCapabilities } from "../capabilities/types.ts";
import { loadPolicy } from "../policy/load.ts";
import { resolveChat } from "../policy/policy.ts";
import { childEnv, processStart, signalWarm } from "../server/spawn.ts";
import { getChat, pendingCommands, triggersAfter, turnOwnerName, type CommandPayload } from "../store/events.ts";
import { chatModel } from "../store/models.ts";
import { lastClosedTurn, markTurn } from "../store/turns.ts";
import { ackHandoff, isDraining, isPinned, pendingHandoff, registerWarm, removeWarm, updateWarm, warmRunnerFor } from "../store/warm.ts";
import { codeVersion, runnerConfigHash } from "../version.ts";
import { runOne, type RunnerContext, type RunnerSignals, type TurnRun } from "./run.ts";
import { warmFingerprint, type WarmSpec } from "./warm-session.ts";

/**
 * A WARM RUNNER (`SHUVI_WARM_RUNNERS`, env.ts): a runner child that stays after its turn, holding its chat's
 * resident Claude Code CLI (warm-session.ts), and runs the chat's next turns when the waker hands them over. It
 * saves a turn both cold starts: the child's (loading shuvi) and the CLI's. One runner serves ONE chat, ever: the
 * permission boundaries of two chats never meet in one process.
 *
 * STAYING. Once its turn is over, it stays only when all of these hold (`whyNotStay`): the turn ran on a `claude`
 * provider and has a live CLI; it was not stopped (SIGTERM) and the runner was not retired (SIGUSR2); the server is
 * not draining (store/warm.ts `isDraining`); its chat has no `/new` or `/newclean` waiting, no switch of its model
 * waiting (agent/switch.ts), and its conversation was not lost in the turn. It then registers in `warm_runners`
 * (store/warm.ts `registerWarm`), with its code version and its configuration's hash (version.ts), within
 * `SHUVI_WARM_MAX`: one more retires the least recently idle other runner (SIGUSR2), or this one leaves if it is
 * the oldest. It also leaves if another process runs its chat's turn at that moment (a cold child the waker
 * started for a message that was waiting): its CLI would miss that turn.
 *
 * WAITING. It looks at the store every `POLL_MS` (SIGUSR1 wakes it early) for a turn handed to it: a running turn
 * with its pid and start time, its hand-off `pending` (store/turns.ts `claimTurn` sets that, in the claim's
 * transaction). It takes it (`ackHandoff`; one the waker has already given up is not run) and runs it with
 * `runTurn`, as a child runs its first (run.ts `runOne`), then decides again whether to stay.
 *
 * RE-WARM AT ONCE. Right after its turn, and every `CHECK_MS` while it waits, it works out what the chat's next turn
 * would be given (`nextSpec`: the system prompt as agent/prompt.ts builds it, the tool bundles, the login), and its
 * fingerprint (warm-session.ts `warmFingerprint`). When that differs from its CLI's (an edit to home/, a policy
 * change), it closes the CLI and opens one for the new prompt, a resume of the chat's conversation, in the
 * background, before the next message, and records the new fingerprint and CLI start on its row. Opening a CLI calls
 * no model. A turn whose input still differs (a model change between) opens its CLI at its start (warm-session.ts
 * `ensure`): the process is reused either way. So does a CLI that has not seen the chat's last closed turn (one run
 * by another process meanwhile): it is reopened on a resume, which has that turn. The owner's name in the prompt is
 * by the one rule agent/turn.ts uses (store/events.ts `turnOwnerName`).
 *
 * LEAVING (closing its CLI, its row deleted): on SIGUSR2; on SIGTERM while it waits (and after a turn it stopped);
 * idle past `SHUVI_WARM_IDLE_SEC`; its row gone or changed by anyone else (the server retires a runner by deleting
 * its row: `/new`, a switch, a profile switch, a drain, a server on other code or configuration); its CLI dead
 * while it waits (it does not start another to wait with); the drain flag. Its own row is deleted first: once that is done no turn
 * can be handed to it. Finding the row already gone, it first looks for a turn handed to it in between and runs it.
 *
 * PINNED (`chats.warm_pinned`, the console's Keep warm): its runner never idles out (the idle clock is held while the
 * chat is pinned, and starts when it is unpinned) and does not count toward `SHUVI_WARM_MAX` (store/warm.ts). The
 * server starts a TURNLESS runner for a pinned chat that has none (server/warm.ts `PinKeeper`, `child.ts --warm`,
 * run.ts `runWarmStart`): it runs no turn of its own, opens the chat's CLI (on a resume of its conversation, or for
 * a new one when it has none, which its first turn then starts with `run`), registers as above and waits. Every
 * other rule above applies to it alike, the two guards included: a turnless start that finds the chat's turn
 * running elsewhere does not register (guard 1), and its CLI's last-seen turn is the chat's last closed one when it
 * opened (guard 2).
 *
 * Its timings: a handed turn is marked `acked` when it is taken and `ready` when it starts, never `child`;
 * `cli` when the turn had to open a CLI.
 */

export const POLL_MS = 200;
export const CHECK_MS = 3_000;

type Spec = { spec: WarmSpec; fingerprint: string } | { exit: string };

/**
 * Stay warm after `start`, the turn this child was started for; or, for a TURNLESS start (`{ turnless: chatId }`: a
 * pinned chat with no runner, started by the server, server/warm.ts `PinKeeper`), open the chat's CLI and go straight
 * to waiting.
 */
export async function stayWarm(runner: RunnerContext, start: TurnRun | { turnless: number }, signals: RunnerSignals): Promise<string> {
  const first = "turnless" in start ? null : start;
  const { db, cfg } = runner;
  const pid = process.pid;
  const pidStart = processStart(pid);
  const version = codeVersion();
  const configHash = runner.configHash ?? runnerConfigHash(childEnv(), runner.capabilities.map((c) => c.capability.id));
  const lines = [first ? first.line : `warm start for chat ${"turnless" in start ? start.turnless : "?"}`];
  const log = (chatId: number | undefined, line: string) => console.log(`warm runner ${pid}${chatId !== undefined ? ` (chat ${chatId})` : ""}: ${line}`);
  let last: TurnRun | null = first;
  let chatId = first ? first.chatId : "turnless" in start ? start.turnless : undefined;
  let exit: string | undefined;

  /** What the chat's next turn would be given now, or why it cannot be run here. */
  const nextSpec = (): Spec => {
    if (chatId === undefined) return { exit: "no chat" };
    const chat = getChat(db, chatId);
    if (!chat) return { exit: "the chat is gone" };
    const policy = loadPolicy(db, cfg.home, cfg.ownerId);
    const chatPolicy = resolveChat(policy, chat);
    if (!chatPolicy) return { exit: "the chat is not in the policy" };
    let model;
    try {
      model = chatModel(db, chat);
    } catch (e) {
      return { exit: e instanceof Error ? e.message : String(e) };
    }
    if (model.provider.kind !== "claude") return { exit: `the chat is on a ${model.provider.kind} provider` };
    const capabilities = turnCapabilities(runner.capabilities, chatPolicy.tools, chat);
    // As agent/turn.ts builds them, but with no turn: no alert for a missing profile, a placeholder state (the
    // handlers are swapped for the turn's own at its start).
    const layers = HomeLayers.of(cfg.home, chat.profile);
    // By the turn's own rule (store/events.ts `turnOwnerName`), over what its input would be now.
    const ownerName = turnOwnerName(db, chat.id, cfg.ownerId, triggersAfter(db, chat.id, chat.cursorSeq));
    const owner = { ...(ownerName ? { name: ownerName } : {}), ...(cfg.ownerLanguage ? { language: cfg.ownerLanguage } : {}) };
    const state: TurnState = { chat, turnId: 0, passed: false, stopping: false, n: 0, fromSeq: chat.cursorSeq, toSeq: chat.cursorSeq };
    const tools = capabilityTools(capabilities, { db, home: cfg.home, layers, chat, turnId: 0, timeZone: cfg.timeZone, owner, state, policy, chatPolicy, ownerId: cfg.ownerId });
    const systemPrompt = joinSections(buildPromptSections(layers, chat, owner, capabilities, chatPolicy, db));
    const configDir = model.provider.configDir ?? null;
    const dm = driverModel(model);
    const spec: WarmSpec = { systemPrompt, tools, configDir, conversation: chat.backendSessionId ?? null, lastTurn: lastClosedTurn(db, chat.id), ...(dm ? { model: dm } : {}) };
    return {
      spec,
      fingerprint: warmFingerprint({ systemPrompt, toolsFingerprint: runner.warm!.toolsFingerprint(tools), kind: model.provider.kind, configDir, settings: null }),
    };
  };

  // Its CLI has seen the turn it was started for.
  if (first) runner.warm?.served(first.turnId);
  for (;;) {
    exit = last ? whyNotStay(runner, last, signals) : chatId === undefined ? "no chat" : whyNotWait(runner, chatId, signals);
    if (exit) break;
    // Right after the turn: what the next one would be given, and a new CLI for it if that changed.
    const next = nextSpec();
    if ("exit" in next) {
      exit = next.exit;
      break;
    }
    const misfit = runner.warm!.misfit(next.spec);
    if (misfit) {
      await runner.warm!.ensure(next.spec);
      log(chatId, last ? `re-warmed after its turn: ${misfit}` : "opened its CLI (a turnless start)");
    }
    let fingerprint = next.fingerprint;
    const idleSince = new Date().toISOString();
    const reg = registerWarm(db, { chatId: chatId!, pid, pidStart, fingerprint, codeVersion: version, configHash, idleSince, cliStartedAt: runner.warm!.cliStartedAt }, cfg.warm.max);
    for (const r of reg.retired) {
      log(r.chatId === chatId ? chatId : r.chatId, `retired runner ${r.pid} (${r.chatId === chatId ? "replaced" : "over SHUVI_WARM_MAX"})`);
      signalWarm(r.pid, r.pidStart, "SIGUSR2");
    }
    if (!reg.registered) {
      exit = reg.refused === "busy" ? "another process runs its chat's turn" : "over SHUVI_WARM_MAX, and the least recently idle";
      break;
    }
    log(chatId, "warm, waiting");

    // Waiting.
    let handed: number | undefined;
    let lastCheck = Date.now();
    // The idle clock: from registration, held at now while the chat is pinned (so an unpinned runner's idle time
    // starts when it was unpinned).
    let idleFrom = Date.parse(idleSince);
    for (;;) {
      let why: string | undefined;
      if (signals.stop.aborted) why = "SIGTERM while idle";
      else if (signals.retired()) why = "retired (SIGUSR2)";
      else {
        const t = pendingHandoff(db, pid, pidStart);
        if (t && ackHandoff(db, t.id, pid)) {
          handed = t.id;
          break;
        }
        const row = warmRunnerFor(db, chatId!);
        // Its own row: its pid, start time and fingerprint. `idle_since` is not checked: an unpin sets it to now
        // (store/warm.ts `setWarmPinned`), and the idle clock follows it.
        if (!row || row.pid !== pid || row.pidStart !== pidStart || row.fingerprint !== fingerprint) why = "its row is gone";
        else {
          if (isPinned(db, chatId!)) idleFrom = Date.now();
          else idleFrom = Math.max(idleFrom, Date.parse(row.idleSince));
          if (Date.now() - idleFrom > cfg.warm.idleMs) why = `idle past ${Math.round(cfg.warm.idleMs / 1000)} s`;
        }
        if (!why && isDraining(db)) why = "the server is draining";
        else if (!why && !runner.warm!.alive && !runner.warm!.busy) why = "its CLI died";
      }
      if (why) {
        // Its own row first: once it is gone no turn can be handed here. Already gone: one may have been, just now.
        if (!removeWarm(db, chatId!, pid, pidStart) && !signals.stop.aborted) {
          const t = pendingHandoff(db, pid, pidStart);
          if (t && ackHandoff(db, t.id, pid)) {
            handed = t.id;
            break;
          }
        }
        exit = why;
        break;
      }
      if (Date.now() - lastCheck >= CHECK_MS) {
        lastCheck = Date.now();
        try {
          const n = nextSpec();
          if ("exit" in n) {
            log(chatId, `cannot stay: ${n.exit}`);
            if (!removeWarm(db, chatId!, pid, pidStart)) continue; // handed meanwhile: take it on the next look
            exit = n.exit;
            break;
          }
          const misfit = runner.warm!.misfit(n.spec) ?? (n.fingerprint !== fingerprint ? "its fingerprint changed" : null);
          if (misfit) {
            await runner.warm!.ensure(n.spec);
            if (!updateWarm(db, chatId!, pid, pidStart, { fingerprint: n.fingerprint, cliStartedAt: runner.warm!.cliStartedAt })) continue; // handed or retired: the next look sees which
            fingerprint = n.fingerprint;
            log(chatId, `re-warmed while idle: ${misfit}`);
          }
        } catch (e) {
          log(chatId, `could not work out the next turn: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      await signals.wait(POLL_MS);
    }
    if (handed === undefined) break;

    markTurn(db, handed, { acked: Date.now() });
    last = await runOne(runner, handed, signals.stop);
    runner.warm?.served(handed);
    lines.push(last.line);
    chatId = last.chatId ?? chatId;
  }
  log(chatId, `leaving: ${exit}`);
  await runner.warm?.close();
  return `${lines.join("; ")}; warm runner left (${exit})`;
}

/** Why the runner must not stay after turn `last`, or undefined when it may (the header's list). */
export function whyNotStay(runner: RunnerContext, last: TurnRun, signals: Pick<RunnerSignals, "stop" | "retired">): string | undefined {
  if (signals.stop.aborted || last.outcome === "stopped") return "its turn was stopped";
  if (last.chatId === undefined) return "no chat";
  if (last.kind !== "claude") return last.kind ? `its turn ran on a ${last.kind} provider` : "its turn ran on no model";
  if (runner.warm?.lost) return "its conversation was lost";
  if (!runner.warm?.alive) return "no live CLI";
  return whyNotWait(runner, last.chatId, signals);
}

/** What keeps any runner from waiting for chat `chatId`, after a turn or at a turnless start. */
export function whyNotWait(runner: RunnerContext, chatId: number, signals: Pick<RunnerSignals, "stop" | "retired">): string | undefined {
  const { db } = runner;
  if (signals.stop.aborted) return "SIGTERM";
  if (signals.retired()) return "retired (SIGUSR2)";
  if (isDraining(db)) return "the server is draining";
  if (hasPendingSwitch(db, chatId)) return "a switch of its model is waiting";
  if (pendingCommands(db).some((c) => c.chatId === chatId && ["new", "newclean"].includes((c.payload as unknown as CommandPayload).command))) return "a /new is waiting";
  return undefined;
}
