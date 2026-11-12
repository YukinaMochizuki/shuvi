import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { ServerWebSocket, Subprocess } from "bun";
import { EXEC_SUBPROTOCOL } from "../src/capabilities/computer/hangar/client.ts";
import { MachineExecRequestSchema, MachineExecResponseSchema } from "../src/capabilities/computer/hangar/gen/hangar/compute/v1alpha1/machine_capability_pb.ts";

/**
 * A fake Hangar for tests and the e2e script, over real HTTP so the vendored Connect client and the exec
 * WebSocket client are what the code under test talks to:
 *
 *   - Connect JSON endpoints for DiskService and ContainerService Get / Apply (Bearer token checked),
 *     keeping the objects in memory with a generation per spec change and the Ready / Stopped conditions
 *     a real apply would reach (after `readyDelayMs`);
 *   - the exec WebSocket (`/v1/projects/{p}/containers/{name}:exec`, subprotocol hangar.exec.v1alpha1),
 *     which runs the command LOCALLY, in a directory standing in for the container's /home/shuvi, and
 *     streams it back as MachineExecResponse messages. As Hangar does: a signal message signals the
 *     process, a dropped connection kills its process group, and an exec it will not run (a container that
 *     is not running, `refuseExecs` for the machine_calls cap) is refused before the upgrade with an HTTP
 *     error. Stopping a container kills every process it started, detached ones (setsid) included, found by
 *     a marker in their environment.
 *
 * The container's own filesystem, outside its home, is two local directories per container: its ROOT DISK
 * (`rootfs(name)`, kept across stop and start, emptied when an apply changes the image, as Hangar rebuilds
 * it) and its /run (`runDir(name)`, a tmpfs in the guest: emptied at every start). An exec's arguments have
 * `/home/shuvi`, `/var/lib/shuvi` and `/run/shuvi` rewritten into those directories, so the framework's
 * scripts that name them work here; nothing else outside home is.
 *
 * `failNext(method, code)` makes the next call of a method fail with a Connect error (e.g.
 * resource_exhausted). `shims` puts stand-in `ffmpeg` / `ffprobe` and `apt-get` on the commands' PATH, so
 * the media tools' scripts and an apply of ~/.computer.yaml run without the real tools; with
 * `{ realMedia: true }` the real ffmpeg and ffprobe on this machine's PATH are used instead (the e2e's
 * video_sheet step, on a generated video). The `ffprobe` stand-in describes a 12 s 640x360 video; the `ffmpeg`
 * one writes a tiny JPEG to its last argument (and finds no scene changes). The `apt-get` stand-in
 * "downloads" a package (prints `Get: <pkg>`) only when its .deb is not in the archives directory it is given
 * (`-o Dir::Cache::Archives=`), "installs" it into the root disk (`<rootfs>/installed/<pkg>`), and fails like
 * apt for a package whose name starts with `fake-missing`.
 */

const HOME_IN_CONTAINER = "/home/shuvi";
const CODES: Record<string, number> = { invalid_argument: 400, not_found: 404, already_exists: 409, resource_exhausted: 429, failed_precondition: 400, unauthenticated: 401, internal: 500 };

type Obj = { apiVersion?: string; kind?: string; metadata: { name: string; project?: string; generation?: string; labels?: Record<string, string> }; spec: Record<string, unknown>; status?: Record<string, unknown> };

interface ExecData {
  container: string;
  proc?: Subprocess<"pipe" | "ignore", "pipe", "pipe">;
  exited?: boolean;
}

export interface ExecRecord {
  container: string;
  command: string[];
  env: Record<string, string>;
  /** As the exec asked ("" is the image's user, "0" root). */
  user: string;
}

export class FakeHangar {
  readonly token = "hgr_fake_token";
  readonly project = "shuvi-test";
  readonly calls: { method: string; body: Record<string, unknown> }[] = [];
  readonly execs: ExecRecord[] = [];
  readonly disks = new Map<string, Obj>();
  readonly containers = new Map<string, Obj>();
  /** Secrets as applied, data included (a real apiserver never answers with it; neither does this one). */
  readonly secrets = new Map<string, Obj>();
  readonly root = mkdtempSync(join(tmpdir(), "fake-hangar-"));
  /** How long an apply takes to reach Ready / Stopped. */
  readyDelayMs = 0;
  /** Refuse every exec before the upgrade with ResourceExhausted (the tenant's machine_calls cap). */
  refuseExecs = false;
  private failures = new Map<string, { code: string; message: string }[]>();
  private server: ReturnType<typeof Bun.serve<ExecData, never>>;
  private shimDir: string;

  constructor(opts: { realMedia?: boolean } = {}) {
    this.shimDir = this.makeShims(!opts.realMedia);
    this.server = Bun.serve<ExecData, never>({
      port: 0,
      fetch: async (req, server) => {
        const url = new URL(req.url);
        if (req.headers.get("authorization") !== `Bearer ${this.token}`) return this.error("unauthenticated", "bad token");
        const exec = url.pathname.match(/^\/v1\/projects\/([^/]+)\/containers\/([^/]+):exec$/);
        if (exec) {
          if (!(req.headers.get("sec-websocket-protocol") ?? "").split(",").map((s) => s.trim()).includes(EXEC_SUBPROTOCOL)) return this.error("failed_precondition", "subprotocol");
          // As the real apiserver: an exec it will not run is refused BEFORE the upgrade, with an HTTP error
          // (which a WebSocket client only sees as a close with 1006).
          const name = decodeURIComponent(exec[2]!);
          const c = this.containers.get(name);
          if (!c) return this.error("not_found", `container ${name} not found`);
          if (!this.isRunning(c)) return this.error("failed_precondition", `container ${name} is not running`);
          if (this.refuseExecs) return this.error("resource_exhausted", "the tenant's machine_calls are all in use");
          const ok = server.upgrade(req, { data: { container: decodeURIComponent(exec[2]!) }, headers: { "Sec-WebSocket-Protocol": EXEC_SUBPROTOCOL } });
          return ok ? undefined : new Response("upgrade failed", { status: 400 });
        }
        const m = url.pathname.match(/^\/hangar\.(\w+)\.v1alpha1\.(\w+)\/(\w+)$/);
        if (!m || req.method !== "POST") return new Response("not found", { status: 404 });
        const method = m[3]!;
        const body = (await req.json()) as Record<string, unknown>;
        this.calls.push({ method, body });
        const f = this.failures.get(method)?.shift();
        if (f) return this.error(f.code, f.message);
        return this.unary(method, body);
      },
      websocket: {
        open: () => {},
        message: (ws, msg) => this.onExecMessage(ws, msg),
        close: (ws) => {
          // A dropped connection kills the exec's process group, as Hangar does.
          const p = ws.data.proc;
          if (p && !ws.data.exited) {
            try {
              process.kill(-p.pid, "SIGKILL");
            } catch {
              // already gone
            }
          }
        },
      },
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  /** The environment that turns the computer capability on against this fake. */
  env(extra: Record<string, string> = {}): Record<string, string> {
    return { SHUVI_HANGAR_API: this.url, SHUVI_HANGAR_PROJECT: this.project, SHUVI_HANGAR_TOKEN: this.token, SHUVI_COMPUTER_IMAGE: "registry.example/shuvi-computer@sha256:fake", ...extra };
  }

  /** The local directory standing in for a container's /home/shuvi. */
  home(container: string): string {
    const dir = join(this.root, "homes", container);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** The local directory standing in for a container's root disk (only what the framework writes there). */
  rootfs(container: string): string {
    const dir = join(this.root, "roots", container);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** The local directory standing in for a container's /run. */
  runDir(container: string): string {
    const dir = join(this.root, "runs", container);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** An exec's argument with the container's paths outside home made local. */
  private localPaths(container: string, arg: string): string {
    return arg
      .replaceAll(HOME_IN_CONTAINER, this.home(container))
      .replaceAll("/var/lib/shuvi", join(this.rootfs(container), "var/lib/shuvi"))
      .replaceAll("/run/shuvi", join(this.runDir(container), "shuvi"));
  }

  failNext(method: string, code: string, message = `fake ${code}`): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), { code, message }]);
  }

  /** The apply calls, as `<Method> <name> <runState> <cpu>/<memory>`, in order. */
  applies(): string[] {
    return this.calls
      .filter((c) => c.method === "ApplyContainer")
      .map((c) => {
        const o = c.body.container as Obj;
        const r = o.spec.resources as { cpu?: string; memory?: string } | undefined;
        return `${o.metadata.name} ${String(o.spec.runState ?? "").replace("CONTAINER_RUN_STATE_", "")} ${r?.cpu}/${r?.memory}`;
      });
  }

  stop(): void {
    for (const c of this.containers.keys()) this.killAll(c);
    this.server.stop(true);
  }

  // ---- unary --------------------------------------------------------------------------------------

  private error(code: string, message: string): Response {
    return Response.json({ code, message }, { status: CODES[code] ?? 500 });
  }

  private isRunning(c: Obj): boolean {
    const conds = (c.status?.conditions ?? []) as { type: string; status: string }[];
    return c.spec.runState !== "CONTAINER_RUN_STATE_STOPPED" && conds.some((x) => x.type === "Ready" && x.status === "CONDITION_STATUS_TRUE");
  }

  private unary(method: string, body: Record<string, unknown>): Response {
    if (method === "ApplySecret") {
      const o = body.secret as Obj;
      if ((o.spec as { type?: string }).type !== "SECRET_TYPE_REGISTRY_AUTH") return this.error("invalid_argument", "only registry-auth here");
      const created = !this.secrets.has(o.metadata.name);
      this.secrets.set(o.metadata.name, o);
      // Write-only: the answer leaves the data out.
      return Response.json({ secret: { ...o, spec: { type: (o.spec as { type: string }).type } }, created });
    }
    const store = method.endsWith("Disk") ? this.disks : this.containers;
    if (method === "GetDisk" || method === "GetContainer") {
      const o = store.get(String(body.name));
      if (!o) return this.error("not_found", `${body.name} not found`);
      return Response.json(method === "GetDisk" ? { disk: o } : { container: o });
    }
    if (method === "ApplyDisk" || method === "ApplyContainer") {
      const o = (method === "ApplyDisk" ? body.disk : body.container) as Obj;
      const name = o.metadata.name;
      const prev = store.get(name);
      if (prev && body.createOnly) return this.error("already_exists", `${name} exists`);
      const changed = !prev || JSON.stringify(prev.spec) !== JSON.stringify(o.spec);
      const generation = String(Number(prev?.metadata.generation ?? 0) + (changed ? 1 : 0));
      const next: Obj = { ...o, metadata: { ...o.metadata, generation }, status: prev?.status ?? { conditions: [] } };
      store.set(name, next);
      if (method === "ApplyContainer") {
        const stopping = o.spec.runState === "CONTAINER_RUN_STATE_STOPPED";
        if (stopping || changed) this.killAll(name);
        // A new image is a new root disk; any change of spec is a new boot, with an empty /run.
        if (prev && prev.spec.image !== o.spec.image) rmSync(this.rootfs(name), { recursive: true, force: true });
        if (changed) rmSync(this.runDir(name), { recursive: true, force: true });
        const settle = () => {
          const cur = this.containers.get(name);
          if (!cur || cur.metadata.generation !== generation) return;
          cur.status = {
            conditions: [
              { type: "Ready", status: stopping ? "CONDITION_STATUS_FALSE" : "CONDITION_STATUS_TRUE", reason: stopping ? "Stopped" : "Running", observedGeneration: generation },
              { type: "Stopped", status: stopping ? "CONDITION_STATUS_TRUE" : "CONDITION_STATUS_FALSE", observedGeneration: generation },
            ],
          };
        };
        if (changed) {
          // Until it settles, the old conditions describe an older generation.
          if (this.readyDelayMs) setTimeout(settle, this.readyDelayMs);
          else settle();
        }
      }
      return Response.json(method === "ApplyDisk" ? { disk: next, created: !prev } : { container: next, created: !prev });
    }
    return this.error("internal", `unknown method ${method}`);
  }

  // ---- exec ---------------------------------------------------------------------------------------

  private send(ws: ServerWebSocket<ExecData>, m: Parameters<typeof create<typeof MachineExecResponseSchema>>[1]): void {
    ws.send(toBinary(MachineExecResponseSchema, create(MachineExecResponseSchema, m)));
  }

  private onExecMessage(ws: ServerWebSocket<ExecData>, msg: string | Buffer): void {
    if (typeof msg === "string" || msg.length === 0) return; // a keepalive
    const r = fromBinary(MachineExecRequestSchema, new Uint8Array(msg));
    const m = r.message;
    if (m.case === "start") {
      const s = m.value;
      const home = this.home(ws.data.container);
      const env: Record<string, string> = Object.fromEntries(s.env.map((e) => [e.name, e.value]));
      this.execs.push({ container: ws.data.container, command: s.command, env, user: s.user });
      const cwd = !s.workingDir || s.workingDir === HOME_IN_CONTAINER ? home : s.workingDir.replace(HOME_IN_CONTAINER, home);
      const proc = Bun.spawn(
        s.command.map((a) => this.localPaths(ws.data.container, a)),
        {
        cwd,
        env: {
          PATH: `${this.shimDir}:${process.env.PATH}`,
          HOME: home,
          LANG: "C.UTF-8",
          ...env,
          FAKE_HANGAR_CT: ws.data.container,
          FAKE_HANGAR_ROOTFS: this.rootfs(ws.data.container),
        },
        stdin: s.stdin ? "pipe" : "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
        },
      ) as Subprocess<"pipe" | "ignore", "pipe", "pipe">;
      ws.data.proc = proc;
      const pump = async (stream: ReadableStream<Uint8Array>, which: "stdout" | "stderr") => {
        for await (const chunk of stream) {
          for (let i = 0; i < chunk.length; i += 16 << 10) this.send(ws, { message: { case: which, value: chunk.subarray(i, i + (16 << 10)) } });
        }
      };
      void Promise.all([pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr"), proc.exited]).then(() => {
        ws.data.exited = true;
        const sig = proc.signalCode ? (require("node:os").constants.signals[proc.signalCode] as number) : 0;
        this.send(ws, { message: { case: "exit", value: { code: sig ? 128 + sig : (proc.exitCode ?? 0), signal: sig } } });
        ws.close(1000, "");
      });
      return;
    }
    const proc = ws.data.proc;
    if (!proc) return;
    if (m.case === "stdin" && proc.stdin && typeof proc.stdin !== "number") proc.stdin.write(m.value);
    else if (m.case === "stdinClose" && proc.stdin && typeof proc.stdin !== "number") void proc.stdin.end();
    else if (m.case === "signal") {
      try {
        process.kill(proc.pid, m.value);
      } catch {
        // already gone
      }
    }
  }

  /** Kill every process a container's execs started, detached ones included (a stop powers the VM off). */
  killAll(container: string): void {
    for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
      try {
        const env = readFileSync(`/proc/${pid}/environ`, "utf8");
        if (env.split("\0").includes(`FAKE_HANGAR_CT=${container}`)) process.kill(Number(pid), "SIGKILL");
      } catch {
        // gone, or not ours
      }
    }
  }

  // ---- stand-ins for the media tools --------------------------------------------------------------

  private makeShims(media: boolean): string {
    const dir = join(this.root, "shims");
    mkdirSync(dir, { recursive: true });
    const sh = (name: string, body: string) => {
      writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    };
    if (media) {
      sh("ffprobe", 'printf "width=640\\nheight=360\\nsample_aspect_ratio=1:1\\nduration=12.000000\\n"');
      // The last argument is the output file: write a tiny JPEG there ("-" is a scene search's null output).
      sh("ffmpeg", 'out="${@: -1}"; [ "$out" = - ] && exit 0; printf "\\xff\\xd8\\xff\\xe0fakejpeg\\xff\\xd9" > "$out"');
    }
    sh(
      "apt-get",
      [
        'cache=""; cmd=""; pkgs=()',
        'while [ $# -gt 0 ]; do case "$1" in -o) case "$2" in Dir::Cache::Archives=*) cache="${2#*=}";; esac; shift 2;; -*) shift;; update|install) cmd="$1"; shift;; *) pkgs+=("$1"); shift;; esac; done',
        'echo "apt-get $cmd ${pkgs[*]}" >> "$FAKE_HANGAR_ROOTFS/apt.log"',
        '[ "$cmd" = update ] && { echo "Reading package lists... Done"; exit 0; }',
        'for p in "${pkgs[@]}"; do case "$p" in fake-missing*) echo "E: Unable to locate package $p" >&2; exit 100;; esac; done',
        'mkdir -p "$cache" "$FAKE_HANGAR_ROOTFS/installed"',
        'for p in "${pkgs[@]}"; do if [ -f "$cache/$p.deb" ]; then echo "Using cached $p"; else echo "Get: $p"; echo "download $p" >> "$FAKE_HANGAR_ROOTFS/apt.log"; echo "deb of $p" > "$cache/$p.deb"; fi; touch "$FAKE_HANGAR_ROOTFS/installed/$p"; echo "Setting up $p"; done',
      ].join("\n"),
    );
    return dir;
  }
}
