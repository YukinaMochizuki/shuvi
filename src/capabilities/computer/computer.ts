import type { MessageInitShape } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { raiseAlert } from "../../store/control.ts";
import type { Db } from "../../store/db.ts";
import { getChat, type Chat } from "../../store/events.ts";
import { chatLabel } from "../../store/turns.ts";
import { DISK_MAX, DISK_SIZE, HOME_DIR, PULL_SECRET, sizeLabel, type ComputerConfig, type Size } from "./config.ts";
import { ensureDeclared, type DeclaredOutcome } from "./declared.ts";
import { codeOf, describeError, ExecRefused, Hangar } from "./hangar/client.ts";
import { ContainerRunState, ContainerService, type Container } from "./hangar/gen/hangar/compute/v1alpha1/container_pb.ts";
import { ConditionStatus } from "./hangar/gen/hangar/meta/v1/meta_pb.ts";
import { acquireLease, acquireOp, ensureComputerRow, getComputer, releaseLease, releaseOp, runningComputerJobs, updateComputer, type ComputerRow } from "./state.ts";

/**
 * A chat's computer on Hangar (docs/design.md §15): its Disk `home-<chat>` (5Gi, growing to 50Gi), mounted at
 * /home/shuvi in its Container `shuvi-<chat>` (the shared base image; Hangar's machine for it is
 * `ct-shuvi-<chat>`, see `computerNames`). Both are made on the first exec and never deleted: the disk
 * outlives the container, and the container is only ever stopped (`spec.runState`).
 *
 *   ensureRunning   make the objects if they are not there, start the container if it is not running at the
 *                   size it should have (normal, or its boost), and wait for its Ready condition
 *   stop            apply STOPPED (at a size) and wait for its Stopped condition
 *   withLease       run an exec under a lease (state.ts), waiting a little for an op (a resize) to finish,
 *                   once ~/.computer.yaml is applied on the running computer (declared.ts)
 *
 * The container's spec is shuvi's alone and always applied whole (Apply replaces it), built from the
 * configuration and the row: nothing else writes it, so there is nothing to merge. It never holds a secret.
 *
 * Hangar refusing for want of quota (`ResourceExhausted`) is a clear error for the tool and an alert for the
 * owner (`exhausted`).
 */

export class ComputerError extends Error {}

type ContainerInit = MessageInitShape<typeof ContainerService.method.applyContainer.input>["container"];

const ready = (c: Container | null, type: "Ready" | "Stopped") => {
  const cond = c?.status?.conditions.find((x) => x.type === type);
  return !!cond && cond.status === ConditionStatus.TRUE && cond.observedGeneration >= (c?.metadata?.generation ?? 0);
};

export class Computers {
  readonly hangar: Hangar;

  constructor(
    readonly db: Db,
    readonly cfg: ComputerConfig,
    hangar?: Hangar,
  ) {
    this.hangar = hangar ?? new Hangar(cfg.hangar);
  }

  row(chat: Chat): ComputerRow {
    return ensureComputerRow(this.db, chat);
  }

  /** The size the computer should run at now: its boost while it has one. */
  sizeOf(row: ComputerRow): Size {
    return row.boost ? { cpu: row.boost.cpu, memory: row.boost.memory } : this.cfg.size;
  }

  spec(row: ComputerRow, size: Size, run: "running" | "stopped", image = this.cfg.image): ContainerInit {
    return {
      apiVersion: "compute.hangarlab.cloud/v1alpha1",
      kind: "Container",
      metadata: { name: row.container, project: this.cfg.hangar.project, labels: { app: "shuvi", "shuvi-chat": String(row.chatId) } },
      spec: {
        image,
        // The base image's own command keeps it up; it is named here so another image cannot exit at once.
        command: ["sleep", "infinity"],
        resources: { cpu: size.cpu, memory: size.memory },
        runState: run === "running" ? ContainerRunState.RUNNING : ContainerRunState.STOPPED,
        volumes: [{ type: "volume", source: row.disk, sourceKind: "Disk", target: HOME_DIR }],
        imagePullSecrets: this.cfg.registry ? [PULL_SECRET] : [],
      },
    };
  }

  /** Raise the owner alert for a refusal for want of quota, and turn it into a tool error. */
  exhausted(chatId: number, what: string, e: unknown): ComputerError {
    const chat = getChat(this.db, chatId);
    const label = chat ? chatLabel(chat) : `chat ${chatId}`;
    const msg = describeError(e);
    raiseAlert(this.db, { key: `computer-exhausted:${chatId}:${Date.now()}`, topic: `computer-exhausted:${chatId}`, text: `Hangar refused ${what} for the computer of ${label}: out of quota (${msg}).` });
    return new ComputerError(`Hangar refused ${what}: the Hangar project is out of quota (${msg}). The owner has been alerted. Nothing ran; try again later, or with a smaller size.`);
  }

  /** Alert an exec refused while the computer runs (cause unknown), and turn it into a tool error. */
  refused(chatId: number, e: ExecRefused): ComputerError {
    const chat = getChat(this.db, chatId);
    const label = chat ? chatLabel(chat) : `chat ${chatId}`;
    raiseAlert(this.db, {
      key: `computer-exec-refused:${chatId}:${Date.now()}`,
      topic: `computer-exec-refused:${chatId}`,
      text: `Hangar refused an exec on the running computer of ${label} before it opened. It may be the tenant's cap on concurrent exec calls (machine_calls); the cause is not known. Container state seen: ${e.state}.`,
    });
    return new ComputerError(`Hangar refused the command before it started, though the computer runs; it may be Hangar's cap on concurrent exec calls. The owner has been alerted. Nothing ran; try again shortly.`);
  }

  private pullSecretApplied = false;
  /** Create or update the registry login Secret, once per process (an apply with the same data changes nothing). */
  private async ensurePullSecret(chatId: number): Promise<void> {
    if (!this.cfg.registry || this.pullSecretApplied) return;
    const login = this.cfg.registry;
    await this.call(chatId, "saving the image registry login", () => this.hangar.applyRegistrySecret(PULL_SECRET, login));
    this.pullSecretApplied = true;
  }

  private async call<T>(chatId: number, what: string, f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (codeOf(e) === Code.ResourceExhausted) throw this.exhausted(chatId, what, e);
      if (e instanceof ComputerError) throw e;
      throw new ComputerError(`Hangar failed ${what}: ${describeError(e)}`);
    }
  }

  /** Wait until the container's condition `type` is True for its current spec. */
  async waitFor(row: ComputerRow, type: "Ready" | "Stopped"): Promise<void> {
    const end = Date.now() + this.cfg.readyMs;
    let last: Container | null = null;
    for (;;) {
      last = await this.call(row.chatId, "reading the computer", () => this.hangar.getContainer(row.container));
      if (ready(last, type)) return;
      if (Date.now() > end) {
        const cond = last?.status?.conditions.find((c) => c.type === "Ready");
        const why = cond?.reason === "StartDoesNotFit" ? `it waits for room on its node: ${cond.message}` : cond ? `${cond.reason}: ${cond.message}` : "no status yet";
        throw new ComputerError(`the computer did not become ${type === "Ready" ? "ready" : "stopped"} within ${Math.round(this.cfg.readyMs / 1000)}s (${why})`);
      }
      await Bun.sleep(500);
    }
  }

  /** Make the disk and container if needed, and have the container running at its size. */
  async ensureRunning(chatId: number): Promise<void> {
    const row = getComputer(this.db, chatId)!;
    const size = this.sizeOf(row);
    if (!row.created) {
      await this.call(chatId, "creating the computer's disk", () =>
        this.hangar.createDisk({
          apiVersion: "storage.hangarlab.cloud/v1alpha1",
          kind: "Disk",
          metadata: { name: row.disk, project: this.cfg.hangar.project, labels: { app: "shuvi", "shuvi-chat": String(row.chatId) } },
          spec: { size: DISK_SIZE, grow: { max: DISK_MAX } },
        }),
      );
    }
    const c = row.created ? await this.call(chatId, "reading the computer", () => this.hangar.getContainer(row.container)) : null;
    const asked = c?.spec;
    // A new image (SHUVI_COMPUTER_IMAGE changed) rebuilds the root disk, which restarts the container and kills
    // its background jobs: it is taken only while none runs there; until then the image it runs is kept.
    const image = asked?.image && asked.image !== this.cfg.image && runningComputerJobs(this.db, chatId).length ? asked.image : this.cfg.image;
    const right = asked && asked.runState !== ContainerRunState.STOPPED && asked.resources?.cpu === size.cpu && asked.resources?.memory === size.memory && asked.image === image;
    if (!right) {
      await this.ensurePullSecret(chatId);
      await this.call(chatId, `starting the computer (${sizeLabel(size)})`, () => this.hangar.applyContainer(this.spec(row, size, "running", image)));
    }
    updateComputer(this.db, chatId, { created: true, runState: "running" });
    if (right && ready(c, "Ready")) return;
    await this.waitFor(row, "Ready");
  }

  /** Stop the container, at `size` (a restore applies the normal size as it stops). */
  async stop(chatId: number, size?: Size): Promise<void> {
    const row = getComputer(this.db, chatId)!;
    await this.call(chatId, "stopping the computer", () => this.hangar.applyContainer(this.spec(row, size ?? this.sizeOf(row), "stopped")));
    updateComputer(this.db, chatId, { runState: "stopped" });
    await this.waitFor(row, "Stopped");
  }

  /**
   * Run `f` under a lease lasting `ms`, with the container running and its ~/.computer.yaml applied (or its
   * failure in `declared`). While an op holds the computer (a resize, a stop) it waits up to `waitMs`, then
   * refuses. Returns how long it waited. `force` retries a file that failed earlier in this boot.
   */
  async withLease<T>(chat: Chat, ms: number, f: () => Promise<T>, waitMs = 90_000, opts: { force?: boolean } = {}): Promise<{ value: T; waitedMs: number; declared: DeclaredOutcome }> {
    this.row(chat);
    const t0 = Date.now();
    let lease: string | undefined;
    // The lease an apply of ~/.computer.yaml takes, lasting through `f` too.
    const extra: string[] = [];
    for (;;) {
      const r = acquireLease(this.db, chat.id, Date.now() + ms + this.cfg.readyMs);
      if ("lease" in r) {
        lease = r.lease;
        break;
      }
      if (Date.now() - t0 > waitMs) {
        throw new ComputerError(`the computer is busy (${r.busy === "stop" ? "stopping" : r.busy === "boost" ? "being resized for a boost" : "being resized back after a boost"}) and did not free up within ${Math.round(waitMs / 1000)}s; nothing ran. Try again shortly.`);
      }
      await Bun.sleep(250);
    }
    try {
      await this.ensureRunning(chat.id);
      const declared = await ensureDeclared(this, chat, { ...opts, holdMs: ms + this.cfg.readyMs, leases: extra });
      return { value: await f(), waitedMs: Date.now() - t0, declared };
    } catch (e) {
      // An exec refused on a running computer (cause unknown) or for want of quota is alerted.
      if (e instanceof ExecRefused) throw this.refused(chat.id, e);
      if (codeOf(e) === Code.ResourceExhausted) throw this.exhausted(chat.id, "the exec", e);
      throw e;
    } finally {
      releaseLease(this.db, chat.id, lease);
      for (const l of extra) releaseLease(this.db, chat.id, l);
    }
  }

  /**
   * Resize the computer to `size` (stop, apply, start), for a boosted exec or job (`jobId`). Refused while
   * anything else runs on it, since the stop would kill it. On failure it is put back at its normal size.
   */
  async boost(chat: Chat, size: Size, jobId: number | null): Promise<void> {
    const row = this.row(chat);
    if (row.boost) throw new ComputerError(`the computer is already boosted (${sizeLabel(row.boost)}${row.boost.jobId ? ` for job ${row.boost.jobId}` : ""}); start this once that ends`);
    const got = acquireOp(this.db, chat.id, "boost", Date.now() + 3 * this.cfg.readyMs, { quietJobs: true, exceptJob: jobId });
    if (!got.ok) throw new ComputerError(`cannot boost now: ${got.why}, and the resize restarts the computer. Try again once that has ended.`);
    try {
      if (row.created && row.runState === "running") await this.stop(chat.id, size);
      updateComputer(this.db, chat.id, { boost: { ...size, jobId, since: new Date().toISOString() } });
      await this.ensureRunning(chat.id);
      releaseOp(this.db, chat.id);
    } catch (e) {
      // Put it back at its normal size, stopped, whatever happened; the next exec starts it again.
      updateComputer(this.db, chat.id, { boost: null });
      await this.stop(chat.id, this.cfg.size).catch(() => {});
      releaseOp(this.db, chat.id, { runState: "stopped" });
      throw e;
    }
  }

  /**
   * Put a boosted computer back at its normal size, stopped (the next exec starts it). Waits up to `waitMs`
   * for execs still in flight on it. Returns false when it could not take the computer (the server's
   * maintenance loop tries again).
   */
  async restore(chatId: number, waitMs = 30_000): Promise<boolean> {
    const t0 = Date.now();
    for (;;) {
      const row = getComputer(this.db, chatId);
      if (!row?.boost) return true;
      const got = acquireOp(this.db, chatId, "restore", Date.now() + 3 * this.cfg.readyMs);
      if (got.ok) break;
      if (Date.now() - t0 > waitMs) return false;
      await Bun.sleep(250);
    }
    try {
      await this.stop(chatId, this.cfg.size);
      releaseOp(this.db, chatId, { boost: null, runState: "stopped" });
      return true;
    } catch (e) {
      releaseOp(this.db, chatId);
      throw e;
    }
  }
}
