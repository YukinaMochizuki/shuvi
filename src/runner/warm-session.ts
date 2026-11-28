import { createHash } from "node:crypto";
import { LostSessionError, type AdapterContinueInput, type AdapterRunInput, type AdapterRunOptions, type AdapterRunResult, type BackendAdapter, type ToolBoundary, type ToolBundle } from "agent-runtime";
import type { ClaudeSession } from "agent-runtime/claude";

/**
 * The resident Claude Code CLI of a runner child with `SHUVI_WARM_RUNNERS` on (runner/warm.ts): one
 * agent-runtime `ClaudeSession` at a time, kept between the turns of the runner's ONE chat.
 *
 * What a running CLI cannot change is fixed when it is opened (agent-runtime claude/live.ts): the system prompt,
 * the tool LIST (names, descriptions, schemas), the login (configDir) and settings, and the conversation it
 * serves, AS IT STOOD: a CLI holds its conversation in memory, so a turn run on the same conversation by another
 * process (a cold child, while this runner was not registered) is not in it. So each CLI remembers the chat's
 * last closed turn it has seen (`basis`: the one before it was opened, then each turn this runner ran on it,
 * `served`), and fits only while that is still the chat's last closed turn (store/turns.ts `lastClosedTurn`);
 * otherwise a new CLI resumes the conversation from its file, which has the other turn. A turn whose prompt,
 * tools, login or conversation differ, or which follows another process's turn, gets a NEW CLI, opened at the
 * turn's start (`ensure`, through `adapter`), the old one closed in the background; one that fits runs on the CLI
 * as it is: the turn's model is set on it (`setModel`), its tool handlers swapped for the turn's (`setTools`:
 * the handlers close over the turn's state), and its prompt sent (`ClaudeBackend` with the session). A changed prompt rides on
 * a resume with `systemPromptSnapshot: false`, so a new CLI on the same conversation carries the new prompt.
 *
 * The runner also opens one AHEAD of a turn (re-warm, runner/warm.ts): when what the next turn would be given
 * changed while it waits (an edit to home/, a policy change), the new CLI is started then, in the background, on
 * a resume of the chat's conversation. Opening one calls no model.
 *
 * `warmFingerprint` is the one hash of what a CLI was opened for: the system prompt, `toolsFingerprint` of the
 * tool bundles, the provider kind, login and settings file. Model and effort are not in it: they change on a
 * running CLI. Nor is the code version: a process's code never changes under it, and a runner on other code than
 * the server's is retired instead (store/warm.ts `code_version`).
 *
 * A LOST conversation (`LostSessionError`) closes the CLI and is remembered (`lost`): the turn starts over on a
 * new one (agent/turn.ts), and the runner does not stay warm after it. A CLI that dies (a stop it could not
 * interrupt, a crash) is dropped; the next turn of this runner, if any, opens another.
 */

/** What a CLI is opened for. */
export interface WarmSpec {
  systemPrompt: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: ToolBundle<any>[];
  /** The provider's login (null: the process's own). */
  configDir: string | null;
  /** The conversation it serves: a resume of it, or null for a fresh one. */
  conversation: string | null;
  /** The model of its first turn (absent: the CLI's default). */
  model?: string;
  /** The chat's last closed turn now (store/turns.ts `lastClosedTurn`): a CLI fits only if it has seen it. */
  lastTurn: number | null;
}

export interface FingerprintParts {
  systemPrompt: string;
  toolsFingerprint: string;
  kind: string;
  configDir: string | null;
  settings: string | null;
}

export function warmFingerprint(p: FingerprintParts): string {
  return createHash("sha256")
    .update(JSON.stringify([p.systemPrompt, p.toolsFingerprint, p.kind, p.configDir, p.settings]))
    .digest("hex");
}

type ClaudeModule = typeof import("agent-runtime/claude");

/** The conversation a session serves: the one it has, or the one it was opened to resume; null: a fresh one, unused. */
const conversationOf = (s: ClaudeSession): string | null => s.sessionId ?? s.resumeSessionId ?? null;

export class WarmClaude {
  /** The current CLI, if any. */
  session: ClaudeSession | null = null;
  /** The configDir the current CLI runs on. */
  private configDir: string | null = null;
  /** When the current CLI was started (ISO). */
  cliStartedAt: string | null = null;
  /** The chat's last closed turn the current CLI has seen (the header). */
  private basis: number | null = null;
  /** How many CLIs this runner has started. */
  starts = 0;
  /** A turn found its conversation lost: the runner does not stay warm. */
  lost = false;
  /** Opening or closing in progress: `ensure` calls run one after another. */
  private chain: Promise<unknown> = Promise.resolve();
  private opening = false;
  private readonly closing = new Set<Promise<unknown>>();

  constructor(
    private readonly claude: ClaudeModule,
    private readonly log: (line: string) => void = (l) => console.log(l),
  ) {}

  /** `toolsFingerprint` of a tool list (agent-runtime). */
  toolsFingerprint(tools: WarmSpec["tools"]): string {
    return this.claude.toolsFingerprint(tools);
  }

  /** Whether a CLI is open and alive. */
  get alive(): boolean {
    return !!this.session?.alive;
  }

  /** Whether `ensure` is opening a CLI now. */
  get busy(): boolean {
    return this.opening;
  }

  /** Does the current CLI fit `spec` as it is (prompt, tools, login, conversation)? */
  fits(spec: WarmSpec): boolean {
    return this.misfit(spec) === null;
  }

  /** Why the current CLI does not fit `spec` (for the log), or null when it does. */
  misfit(spec: WarmSpec): string | null {
    const s = this.session;
    if (!s) return "no CLI";
    if (!s.alive) return "its CLI is gone";
    if (s.busy) return "its CLI is in a turn";
    if (s.systemPrompt !== spec.systemPrompt) return "the system prompt changed";
    if (s.toolsFingerprint !== this.claude.toolsFingerprint(spec.tools)) return "the tools changed";
    if (this.configDir !== spec.configDir) return "the login changed";
    if (conversationOf(s) !== spec.conversation) return "the conversation changed";
    if (this.basis !== spec.lastTurn) return "a turn ran elsewhere since its last one";
    return null;
  }

  /** This runner ran turn `turnId` (closed now): the current CLI, if any, has seen it. */
  served(turnId: number): void {
    if (this.session) this.basis = turnId;
  }

  /**
   * A CLI that fits `spec`: the current one, or a new one (the current one closed in the background). Returns
   * whether it started one. Calls are serialised, so a turn waits for a re-warm in flight and then uses it.
   */
  ensure(spec: WarmSpec): Promise<{ session: ClaudeSession; started: boolean }> {
    const next = this.chain.then(() => {
      const why = this.misfit(spec);
      if (why === null) return { session: this.session!, started: false };
      if (this.session) this.log(`warm: a new Claude Code CLI (${why})`);
      this.opening = true;
      try {
        this.drop();
        const session = new this.claude.ClaudeSession({
          ...(spec.configDir ? { configDir: spec.configDir } : {}),
          systemPrompt: spec.systemPrompt,
          systemPromptSnapshot: false,
          tools: spec.tools,
          ...(spec.model ? { model: spec.model } : {}),
          ...(spec.conversation ? { resumeSessionId: spec.conversation } : {}),
        });
        this.session = session;
        this.configDir = spec.configDir;
        this.basis = spec.lastTurn;
        this.cliStartedAt = new Date().toISOString();
        this.starts++;
        return { session, started: true };
      } finally {
        this.opening = false;
      }
    });
    this.chain = next.catch(() => {});
    return next;
  }

  /** Close the current CLI, in the background. */
  drop(): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    this.cliStartedAt = null;
    const p = s.close().catch((e) => this.log(`warm: closing the CLI failed: ${e instanceof Error ? e.message : String(e)}`));
    this.closing.add(p);
    void p.finally(() => this.closing.delete(p));
  }

  /** Close the CLI and wait for every one closing to be gone (the runner is about to exit). */
  async close(): Promise<void> {
    await this.chain.catch(() => {});
    this.drop();
    await Promise.all([...this.closing]);
  }

  /**
   * The driver of one turn: the turn's input decides the CLI (`ensure`), then agent-runtime's `ClaudeBackend` runs
   * the turn on it (`setTools` with the turn's handlers, `setModel`, `send`), every call through `boundary`.
   * `onCli` is told when the turn had to start a CLI.
   */
  adapter(boundary: ToolBoundary, configDir: string | null, lastTurn: number | null, onCli?: () => void): BackendAdapter {
    const turn = async (input: AdapterRunInput, opts: AdapterRunOptions, conversation: string | null): Promise<AdapterRunResult> => {
      const { session, started } = await this.ensure({
        systemPrompt: input.systemPrompt ?? "",
        tools: input.tools,
        configDir,
        conversation,
        lastTurn,
        ...(input.model ? { model: input.model } : {}),
      });
      if (started) onCli?.();
      const backend = new this.claude.ClaudeBackend({ session, liveSystemPrompt: true, boundary });
      try {
        return conversation ? await backend.continueRun({ ...input, backendSessionId: conversation } as AdapterContinueInput, opts) : await backend.run(input, opts);
      } catch (e) {
        if (e instanceof LostSessionError) this.lost = true;
        // A lost conversation, or a CLI gone (a stop it could not interrupt, a crash): never reused.
        if ((e instanceof LostSessionError || !session.alive) && this.session === session) this.drop();
        throw e;
      }
    };
    return {
      id: "claude-agent-sdk",
      run: (input, opts) => turn(input, opts, null),
      continueRun: (input, opts) => turn(input, opts, input.backendSessionId),
    };
  }
}
