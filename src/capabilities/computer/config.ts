import { DEFAULT_SECRETS_FILE, dataDirFrom } from "../../env.ts";
import type { Env } from "../types.ts";
import type { HangarConfig } from "./hangar/client.ts";

/**
 * The computer capability's configuration, from its own variables (listed in ./index.ts). Off unless all of
 * SHUVI_HANGAR_API, SHUVI_HANGAR_PROJECT, SHUVI_HANGAR_TOKEN and SHUVI_COMPUTER_IMAGE are set.
 */

export interface Size {
  cpu: string;
  memory: string;
}

export interface ComputerConfig {
  hangar: HangarConfig;
  /** The shared base image (computer/Dockerfile), best named by digest. */
  image: string;
  /**
   * A login for a private registry the image is pulled from (SHUVI_COMPUTER_REGISTRY_USER / _TOKEN): shuvi
   * keeps it in a Hangar Secret of type registry-auth, named in each container's imagePullSecrets. Unset: the
   * image is pulled anonymously.
   */
  registry?: { host: string; user: string; token: string };
  dataDir: string;
  /** The size a computer normally runs at. */
  size: Size;
  /** Stopped after this long without an exec (and with no background job running). */
  idleMs: number;
  /** A synchronous exec's default timeout, and the most it may ask for. */
  execDefaultSec: number;
  execMaxSec: number;
  /** A background job's deadline when it names none, and the most it may name. */
  jobDefaultSec: number;
  jobMaxSec: number;
  /** How long to wait for a start (or a stop) to take effect. */
  readyMs: number;
  /** How often a background job is polled. */
  pollEveryMs: number;
  /** The host-side file of secret profiles (outside home/ and git, mode 600). */
  secretsFile: string;
  /** The most each step of applying ~/.computer.yaml (apt, setup) may run (declared.ts). */
  applyStepSec: number;
  /** How long a turn waits for a file someone sent to land in ~/inbox before showing it anyway. */
  inboxWaitMs: number;
}

/** Where the chat's home is mounted, and whose it is, in the base image. */
export const HOME_DIR = "/home/shuvi";
export const USER = "shuvi";

/** The disk a chat's home lives on: created at this size, growing to the max as it fills. */
export const DISK_SIZE = "5Gi";
export const DISK_MAX = "50Gi";

function positive(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : fallback;
}

export function computerConfig(env: Env): ComputerConfig | null {
  const api = env.SHUVI_HANGAR_API;
  const project = env.SHUVI_HANGAR_PROJECT;
  const token = env.SHUVI_HANGAR_TOKEN;
  const image = env.SHUVI_COMPUTER_IMAGE;
  if (!api || !project || !token || !image) return null;
  const execMaxSec = positive(env.SHUVI_COMPUTER_EXEC_MAX_SEC, 600);
  const regUser = env.SHUVI_COMPUTER_REGISTRY_USER;
  const regToken = env.SHUVI_COMPUTER_REGISTRY_TOKEN;
  return {
    hangar: { api, project, token },
    image,
    ...(regUser && regToken ? { registry: { host: registryHost(image), user: regUser, token: regToken } } : {}),
    dataDir: dataDirFrom(env),
    size: { cpu: env.SHUVI_COMPUTER_CPU || "2", memory: env.SHUVI_COMPUTER_MEMORY || "2Gi" },
    idleMs: positive(env.SHUVI_COMPUTER_IDLE_MINUTES, 15) * 60_000,
    execDefaultSec: Math.min(120, execMaxSec),
    execMaxSec,
    jobDefaultSec: 3600,
    jobMaxSec: 24 * 3600,
    readyMs: positive(env.SHUVI_COMPUTER_READY_SEC, 180) * 1000,
    pollEveryMs: positive(env.SHUVI_COMPUTER_POLL_SEC, 5) * 1000,
    secretsFile: env.SHUVI_SECRETS_FILE || DEFAULT_SECRETS_FILE,
    applyStepSec: positive(env.SHUVI_COMPUTER_APPLY_STEP_SEC, 900),
    inboxWaitMs: positive(env.SHUVI_COMPUTER_INBOX_WAIT_SEC, 30) * 1000,
  };
}

/**
 * The Hangar names of a chat's disk and container, from its Telegram chat id so they survive a new store:
 * `home-<id>` / `shuvi-<id>`, a group's negative id written `g<digits>` (a name is a DNS label).
 *
 * Hangar names the Machine a container runs as `ct-<container>` itself (hangar internal/apiserver/
 * controllers.go, `machineName`), so the container carries no `ct-` of its own: its machine reads
 * `ct-shuvi-<id>`, which also says whose it is in a shared project. Computers made before this were named
 * `ct-<id>` (machine `ct-ct-<id>`); they keep that name, since every use reads the name recorded in the
 * store's `computers` row (state.ts), which is written once, when the row is made, and never recomputed.
 */
export function computerNames(tgChatId: number): { disk: string; container: string } {
  const id = tgChatId < 0 ? `g${-tgChatId}` : String(tgChatId);
  return { disk: `home-${id}`, container: `shuvi-${id}` };
}

/** The registry host of an image reference, as Docker reads it: `ghcr.io/o/i@sha256:…` is ghcr.io; `debian` is Docker Hub. */
export function registryHost(image: string): string {
  const first = image.split("/")[0]!;
  return image.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost") ? first : "index.docker.io";
}

/** The Hangar Secret holding the registry login. */
export const PULL_SECRET = "shuvi-computer-registry";

export const sizeLabel = (s: Size) => `${s.cpu} vCPU / ${s.memory}`;
