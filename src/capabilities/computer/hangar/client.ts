import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { ContainerRunState, ContainerService, type Container } from "./gen/hangar/compute/v1alpha1/container_pb.ts";
import { ConditionStatus } from "./gen/hangar/meta/v1/meta_pb.ts";
import { MachineExecRequestSchema, MachineExecResponseSchema } from "./gen/hangar/compute/v1alpha1/machine_capability_pb.ts";
import { DiskService, type Disk } from "./gen/hangar/storage/v1alpha1/disk_pb.ts";
import { SecretService, SecretType } from "./gen/hangar/secrets/v1alpha1/secret_pb.ts";

/**
 * The Hangar API, as the computer capability uses it: Disks and Containers over Connect (unary calls, JSON),
 * and exec over Hangar's WebSocket. Built on the generated code vendored from the hangar repo in ./gen
 * (see ./gen/README.md for the pinned commit); shelling out to the hangar CLI would cost a process per exec.
 *
 * Authentication is a service token, `Authorization: Bearer hgr_…`, on the Connect calls and on the exec
 * handshake alike (hangar docs/decisions/authentication.md).
 *
 * EXEC (hangar proto/hangar/compute/v1alpha1/machine_capability.proto, web/src/lib/exec.ts): a WebSocket at
 * `GET /v1/projects/{p}/containers/{name}:exec` with the subprotocol `hangar.exec.v1alpha1`. Each binary
 * message is one MachineExecRequest (the first a start) or one MachineExecResponse (stdout, stderr, then the
 * exit). A refusal after the upgrade closes it with 4000 plus the Connect code. Facts this module is built on:
 *   - there is no timeout field: the caller sends a signal, or closes;
 *   - a dropped connection kills the exec's process group (so background work detaches with setsid);
 *   - the exec's `env` is set over the container's for that process only, never stored in the spec, and the
 *     audit log records the names alone. It is the one place a secret value goes.
 */

export interface HangarConfig {
  /** The API's base URL, e.g. https://hangar.example.com */
  api: string;
  project: string;
  token: string;
}

export const EXEC_SUBPROTOCOL = "hangar.exec.v1alpha1";
/** Stdin goes in pieces no larger than the CLI's (hangar internal/cli/exec.go `stdinChunk`). */
const STDIN_CHUNK = 32 << 10;
/** An empty message this often keeps an idle proxy from closing the socket (web/src/lib/exec.ts). */
const KEEPALIVE_MS = 30_000;
const CLOSE_BASE = 4000;

export const SIGTERM = 15;
export const SIGKILL = 9;

export type ExecStart = MessageInitShape<typeof MachineExecRequestSchema>["message"] & { case: "start" };

export interface ExecRequest {
  command: string[];
  env?: Record<string, string>;
  user?: string;
  workingDir?: string;
  /** Bytes for the process's stdin, closed after them. Without it the process's stdin is closed from the start. */
  stdin?: Uint8Array;
  onStdout?: (b: Uint8Array) => void;
  onStderr?: (b: Uint8Array) => void;
}

export interface ExecExit {
  code: number;
  signal: number;
}

/** A running exec. `exit` rejects with a ConnectError when Hangar refused or ended it, or the connection was lost. */
export interface ExecHandle {
  exit: Promise<ExecExit>;
  /** Send the process a signal (SIGTERM, SIGKILL). */
  signal(n: number): void;
  /** Close the socket: Hangar then kills the exec's process group. */
  close(): void;
}

/**
 * An exec Hangar refused before it opened while its container, as read just after, runs. The cause is not
 * known: it may be the tenant's cap on concurrent machine calls (`machine_calls`), or anything else the
 * apiserver refuses before the upgrade. `state` is what the container looked like.
 */
export class ExecRefused extends ConnectError {
  constructor(
    readonly container: string,
    readonly state: string,
  ) {
    super(`the exec was refused before it opened, though ${container} runs (${state}); it may be Hangar's cap on concurrent exec calls (machine_calls)`, Code.Unknown);
  }
}

/** The Connect code of an error, or undefined for one that is not Hangar's. */
export function codeOf(e: unknown): Code | undefined {
  return e instanceof ConnectError ? e.code : undefined;
}

export class Hangar {
  readonly containers: Client<typeof ContainerService>;
  readonly disks: Client<typeof DiskService>;
  readonly secrets: Client<typeof SecretService>;

  constructor(readonly cfg: HangarConfig) {
    const auth: Interceptor = (next) => (req) => {
      req.header.set("Authorization", `Bearer ${cfg.token}`);
      return next(req);
    };
    const transport = createConnectTransport({ baseUrl: cfg.api.replace(/\/+$/, ""), useBinaryFormat: false, interceptors: [auth] });
    this.containers = createClient(ContainerService, transport);
    this.disks = createClient(DiskService, transport);
    this.secrets = createClient(SecretService, transport);
  }

  /**
   * Create or update a registry-auth Secret holding one login, as `docker login` writes it (one key,
   * `.dockerconfigjson`). Values are write-only in Hangar, so every apply carries them; an apply with the
   * same data is no change there (hangar docs/decisions/secrets.md).
   */
  async applyRegistrySecret(name: string, login: { host: string; user: string; token: string }): Promise<void> {
    const auth = Buffer.from(`${login.user}:${login.token}`).toString("base64");
    const config = JSON.stringify({ auths: { [login.host]: { username: login.user, password: login.token, auth } } });
    await this.secrets.applySecret({
      secret: {
        apiVersion: "secrets.hangarlab.cloud/v1alpha1",
        kind: "Secret",
        metadata: { name, project: this.cfg.project, labels: { app: "shuvi" } },
        spec: { type: SecretType.REGISTRY_AUTH, data: { ".dockerconfigjson": new TextEncoder().encode(config) } },
      },
    });
  }

  async getDisk(name: string, signal?: AbortSignal): Promise<Disk | null> {
    try {
      return (await this.disks.getDisk({ project: this.cfg.project, name }, { ...(signal ? { signal } : {}) })).disk ?? null;
    } catch (e) {
      if (codeOf(e) === Code.NotFound) return null;
      throw e;
    }
  }

  /** Create a disk, leaving one that exists as it is. */
  async createDisk(disk: MessageInitShape<typeof DiskService.method.applyDisk.input>["disk"]): Promise<void> {
    try {
      await this.disks.applyDisk({ disk, createOnly: true });
    } catch (e) {
      if (codeOf(e) !== Code.AlreadyExists) throw e;
    }
  }

  async getContainer(name: string, signal?: AbortSignal): Promise<Container | null> {
    try {
      return (await this.containers.getContainer({ project: this.cfg.project, name }, { ...(signal ? { signal } : {}) })).container ?? null;
    } catch (e) {
      if (codeOf(e) === Code.NotFound) return null;
      throw e;
    }
  }

  /** Apply a container's whole spec (Apply replaces it). */
  async applyContainer(container: MessageInitShape<typeof ContainerService.method.applyContainer.input>["container"]): Promise<Container> {
    const r = await this.containers.applyContainer({ container });
    return r.container!;
  }

  /** The exec URL of a container. */
  execUrl(name: string): string {
    const u = new URL(this.cfg.api);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = `${u.pathname.replace(/\/+$/, "")}/v1/projects/${encodeURIComponent(this.cfg.project)}/containers/${encodeURIComponent(name)}:exec`;
    return u.toString();
  }

  /** Run a process in a container. */
  exec(container: string, req: ExecRequest): ExecHandle {
    const ws = new WebSocket(this.execUrl(container), { protocols: [EXEC_SUBPROTOCOL], headers: { Authorization: `Bearer ${this.cfg.token}` } } as never);
    ws.binaryType = "arraybuffer";
    let opened = false;
    let exit: ExecExit | undefined;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    const pending: Uint8Array[] = [];
    const sendMsg = (m: MessageInitShape<typeof MachineExecRequestSchema>["message"]) => {
      const bytes = toBinary(MachineExecRequestSchema, create(MachineExecRequestSchema, { message: m }));
      if (opened && ws.readyState === WebSocket.OPEN) ws.send(bytes);
      else if (!opened) pending.push(bytes);
    };
    const done = new Promise<ExecExit>((resolve, reject) => {
      ws.onopen = () => {
        opened = true;
        const env = Object.entries(req.env ?? {}).map(([name, value]) => ({ name, value }));
        ws.send(
          toBinary(
            MachineExecRequestSchema,
            create(MachineExecRequestSchema, {
              message: { case: "start", value: { command: req.command, stdin: !!req.stdin, tty: false, env, user: req.user ?? "", workingDir: req.workingDir ?? "" } },
            }),
          ),
        );
        if (req.stdin) {
          for (let i = 0; i < req.stdin.length; i += STDIN_CHUNK) {
            ws.send(toBinary(MachineExecRequestSchema, create(MachineExecRequestSchema, { message: { case: "stdin", value: req.stdin.subarray(i, i + STDIN_CHUNK) } })));
          }
          ws.send(toBinary(MachineExecRequestSchema, create(MachineExecRequestSchema, { message: { case: "stdinClose", value: {} } })));
        }
        for (const b of pending.splice(0)) ws.send(b);
        keepalive = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(new Uint8Array(0)), KEEPALIVE_MS);
      };
      ws.onmessage = (e) => {
        const data = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : e.data instanceof Uint8Array ? e.data : null;
        if (!data || data.byteLength === 0) return;
        const r = fromBinary(MachineExecResponseSchema, data);
        if (r.message.case === "stdout") req.onStdout?.(r.message.value);
        else if (r.message.case === "stderr") req.onStderr?.(r.message.value);
        else if (r.message.case === "exit") exit = { code: r.message.value.code, signal: r.message.value.signal };
      };
      ws.onclose = (e) => {
        clearInterval(keepalive);
        if (exit) return resolve(exit);
        if (e.code > CLOSE_BASE && e.code <= CLOSE_BASE + Code.Unauthenticated) return reject(new ConnectError(e.reason, (e.code - CLOSE_BASE) as Code));
        if (!opened) return void this.refusal(container).then(reject, reject);
        reject(new ConnectError(`the exec's connection was lost (close ${e.code}${e.reason ? `: ${e.reason}` : ""})`, Code.Unavailable));
      };
    });
    return {
      exit: done,
      signal: (n) => sendMsg({ case: "signal", value: n }),
      close: () => {
        try {
          ws.close(1000);
        } catch {
          // already closed
        }
      },
    };
  }

  /**
   * Why an exec was refused before its WebSocket opened. Hangar refuses before the upgrade with an HTTP error
   * (FailedPrecondition when the container is not running, ResourceExhausted at the tenant's `machine_calls`
   * cap), but a WebSocket client sees only a close with 1006 and no reason. So the container is read: gone is
   * NotFound, not running is FailedPrecondition, and running is `ExecRefused`, with the state seen: the
   * cause is then not known for certain (the plan's usage has no count of machine calls to check it against).
   * A Get that fails itself means the API could not be reached (Unavailable).
   */
  async refusal(container: string): Promise<ConnectError> {
    let c: Container | null;
    try {
      c = await this.getContainer(container);
    } catch (e) {
      return new ConnectError(`could not open an exec in ${container}: the API could not be reached (${e instanceof Error ? e.message : String(e)})`, Code.Unavailable);
    }
    if (!c) return new ConnectError(`container ${container} does not exist`, Code.NotFound);
    const ready = c.status?.conditions.find((x) => x.type === "Ready");
    if (c.spec?.runState === ContainerRunState.STOPPED || ready?.status !== ConditionStatus.TRUE) return new ConnectError(`container ${container} is not running`, Code.FailedPrecondition);
    const state = `runState ${ContainerRunState[c.spec?.runState ?? 0] ?? "?"}, Ready ${ConditionStatus[ready.status] ?? "?"}${ready.reason ? ` (${ready.reason})` : ""}, generation ${c.metadata?.generation ?? "?"} observed ${ready.observedGeneration}`;
    return new ExecRefused(container, state);
  }

  /** Run a process to its end and collect its output (for short framework commands). */
  async run(container: string, req: Omit<ExecRequest, "onStdout" | "onStderr">, maxBytes = 64 << 20): Promise<{ code: number; signal: number; stdout: Uint8Array; stderr: string }> {
    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    let n = 0;
    const h = this.exec(container, {
      ...req,
      onStdout: (b) => {
        n += b.length;
        if (n > maxBytes) return h.close();
        out.push(b);
      },
      onStderr: (b) => void err.push(b),
    });
    let exit: ExecExit;
    try {
      exit = await h.exit;
    } catch (e) {
      if (n > maxBytes) throw new Error(`the output passed ${maxBytes} bytes and was cut off`);
      throw e;
    }
    return { ...exit, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") };
  }
}

/** A short description of a Hangar error for a tool result or an alert. */
export function describeError(e: unknown): string {
  if (e instanceof ConnectError) return `${Code[e.code] ?? e.code}: ${e.rawMessage}`;
  return e instanceof Error ? e.message : String(e);
}
