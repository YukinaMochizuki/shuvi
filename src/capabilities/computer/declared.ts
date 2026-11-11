import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { raiseAlert } from "../../store/control.ts";
import { getChat, type Chat } from "../../store/events.ts";
import { chatLabel } from "../../store/turns.ts";
import { HOME_DIR } from "./config.ts";
import type { Computers } from "./computer.ts";
import { describeError } from "./hangar/client.ts";
import { secretsForChat } from "./secrets.ts";
import { acquireLease, getComputer, releaseLease } from "./state.ts";

/**
 * `~/.computer.yaml`: what a chat's computer has outside its home, declared in its home (docs/design.md §15).
 * The base image (computer/Dockerfile) stays generic and public; what one chat needs on top is runtime data,
 * private to the owner, and is APPLIED AT START, never built into an image:
 *
 *   apt: [ripgrep, imagemagick]      Debian packages, installed with apt-get
 *   setup: |                         a shell script, run with `bash -e` after them
 *     ...
 *
 * Any other key is an error. Both run as root in the container, from /home/shuvi, each step limited to
 * SHUVI_COMPUTER_APPLY_STEP_SEC (`timeout`, then SIGKILL 10 s later).
 *
 *   WHEN     before every command a model's tool runs (`Computers.withLease`), one short exec, as the user,
 *            reads the file and two markers: `/var/lib/shuvi/computer.applied` on the container's ROOT DISK,
 *            the sha256 of the file last applied, and `/run/shuvi/computer.failed` on the guest's /run (a
 *            tmpfs, so per boot), the sha256 of one that failed. Only when the file's hash is neither does
 *            anything run. Hangar keeps a container's root disk across stop and start and rebuilds it only
 *            when the image changes (hangar docs/decisions/machine-model.md), so a new image is a fresh root
 *            disk without the marker, and the file is applied again on the next command; so is an edited file.
 *   CACHE    apt keeps the .debs it downloads in `~/.cache/computer/apt` (on the home disk): applying again
 *            after a new image installs from there and downloads only what changed. The package lists are
 *            fetched again (`apt-get update`): they live on the root disk.
 *   FAILURE  the step that failed (`parse`, `apt`, `setup`) and its output, trimmed and redacted, go into the
 *            result of the command that triggered it (which then runs anyway, without it), and an alert to
 *            the owner. The hash is NOT recorded as applied, only as failed for this boot: the next start
 *            tries again, and so does `apply_computer_config` (`force`), without waiting for one.
 *   ONE AT A TIME   the apply holds a lock (`flock` on /run/shuvi/apply.lock) and checks the marker again
 *            under it, so two commands starting at once apply once.
 *
 * Changing the file is owner-only because every computer tool is (`ownerOnly`, decided per call by
 * `ownerAuthority` in src/agent/turn.ts); the file is read as the user, and only its parsed content is
 * acted on as root.
 */

export const DECLARED_PATH = "~/.computer.yaml";
export const APPLIED_FILE = "/var/lib/shuvi/computer.applied";
export const FAILED_FILE = "/run/shuvi/computer.failed";
export const APT_CACHE = `${HOME_DIR}/.cache/computer/apt`;
/** The largest file read. */
const MAX_FILE = 64 << 10;
/** The uid the apply runs as. */
const ROOT = "0";

/** A Debian package, optionally with `:arch` and `=version`. */
const PACKAGE = /^[a-z0-9][a-z0-9+.-]*(:[a-z0-9-]+)?(=[A-Za-z0-9.+:~-]+)?$/;

const schema = z.strictObject({
  apt: z.array(z.string().regex(PACKAGE, "is not a Debian package name")).optional(),
  setup: z.string().optional(),
});

export interface Declared {
  apt: string[];
  setup: string;
}

/** Parse the file's text. An empty file declares nothing. */
export function parseDeclared(text: string): { declared: Declared } | { error: string } {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch (e) {
    return { error: `${DECLARED_PATH} is not valid YAML: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}` };
  }
  if (doc == null) return { declared: { apt: [], setup: "" } };
  const r = schema.safeParse(doc);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.length ? i.path.join(".") : "the file"}: ${i.message}`);
    return { error: `${DECLARED_PATH} is not valid: ${issues.join("; ")}. It may hold only \`apt\` (a list of Debian package names) and \`setup\` (a shell script).` };
  }
  return { declared: { apt: r.data.apt ?? [], setup: r.data.setup ?? "" } };
}

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export type DeclaredOutcome =
  /** No file: nothing declared, nothing run. */
  | { kind: "none" }
  /** The file as it is was applied on this root disk. */
  | { kind: "current"; hash: string }
  /** It failed earlier in this boot, and is not retried until the next start or an edit (or `force`). */
  | { kind: "failed-before"; hash: string }
  | { kind: "applied"; hash: string; declared: Declared; ms: number; output: string }
  | { kind: "failed"; hash: string; step: string; why: string; output: string };

/** What the read prints: `<applied>|<failed>`, then `y` and the file's bytes, or `n`. Runs as the user. */
export const CHECK_SCRIPT = `printf '%s|%s\\n' "$(cat ${APPLIED_FILE} 2>/dev/null)" "$(cat ${FAILED_FILE} 2>/dev/null)"; if [ -f ~/.computer.yaml ]; then echo y; head -c ${MAX_FILE + 1} ~/.computer.yaml; else echo n; fi`;

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * The apply, as root: under the lock, unless the marker already holds `hash`, apt (through the cache in home),
 * then the setup script (read from stdin into /run/shuvi/setup.sh), then the marker. Each step is announced
 * on stdout as `@@<nonce> step <name>`, a failure as `@@<nonce> fail <name> <exit>`, the end as
 * `@@<nonce> done` (or `current`).
 */
export function applyScript(d: Declared, hash: string, nonce: string, stepSec: number): string {
  const t = `timeout -k 10 ${stepSec}`;
  const apt = "-o Dir::Cache::Archives=$c -o APT::Keep-Downloaded-Packages=true -o APT::Sandbox::User=root -o DPkg::Lock::Timeout=120";
  return [
    "set -u",
    `n=${nonce}; H=${hash}`,
    "mkdir -p /run/shuvi /var/lib/shuvi || exit 1",
    "exec 9>/run/shuvi/apply.lock; flock 9",
    `if [ "$(cat ${APPLIED_FILE} 2>/dev/null)" = "$H" ]; then echo "@@$n current"; exit 0; fi`,
    `fail() { echo "$H" > ${FAILED_FILE}; echo "@@$n fail $1 $2"; exit 1; }`,
    "cat > /run/shuvi/setup.sh",
    ...(d.apt.length
      ? [
          'echo "@@$n step apt"',
          `c=${APT_CACHE}; mkdir -p "$c/partial"`,
          `o="${apt}"`,
          `${t} apt-get $o -q update 2>&1; ec=$?; [ $ec -eq 0 ] || fail apt $ec`,
          `DEBIAN_FRONTEND=noninteractive ${t} apt-get $o -q -y --no-install-recommends install ${d.apt.map(shq).join(" ")} 2>&1; ec=$?; [ $ec -eq 0 ] || fail apt $ec`,
        ]
      : []),
    ...(d.setup.trim()
      ? ['echo "@@$n step setup"', `(cd ${HOME_DIR} && ${t} bash -e /run/shuvi/setup.sh) < /dev/null 2>&1; ec=$?; [ $ec -eq 0 ] || fail setup $ec`]
      : []),
    `echo "$H" > ${APPLIED_FILE}.tmp && mv ${APPLIED_FILE}.tmp ${APPLIED_FILE} || fail record $?`,
    `rm -f ${FAILED_FILE}`,
    'echo "@@$n done"',
  ].join("\n");
}

const what = (d: Declared) => [d.apt.length ? `apt: ${d.apt.join(", ")}` : "", d.setup.trim() ? "the setup script" : ""].filter(Boolean).join("; ") || "nothing declared";

const exitWhy = (code: number, stepSec: number) => (code === 124 || code === 137 ? `timed out after ${stepSec}s` : `exit ${code}`);

function trim(s: string, head = 1_500, tail = 3_000): string {
  if (s.length <= head + tail + 100) return s;
  return `${s.slice(0, head)}\n… ${s.length - head - tail} characters elided …\n${s.slice(-tail)}`;
}

/** Run the apply exec to its end, as root, closed if it outlives every step's limit. */
async function runApply(computers: Computers, container: string, script: string, stdin: Uint8Array, limitMs: number): Promise<{ code: number | null; out: string; error?: string }> {
  const chunks: Uint8Array[] = [];
  const h = computers.hangar.exec(container, { command: ["bash", "-c", script], user: ROOT, workingDir: HOME_DIR, stdin, onStdout: (b) => void chunks.push(b), onStderr: (b) => void chunks.push(b) });
  const timer = setTimeout(() => h.close(), limitMs);
  try {
    const exit = await h.exit;
    return { code: exit.code, out: Buffer.concat(chunks).toString("utf8") };
  } catch (e) {
    return { code: null, out: Buffer.concat(chunks).toString("utf8"), error: describeError(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Record `hash` as failed for this boot (a file that does not parse), as root. */
async function recordFailed(computers: Computers, container: string, hash: string): Promise<void> {
  await computers.hangar.run(container, { command: ["bash", "-c", `mkdir -p /run/shuvi && echo ${hash} > ${FAILED_FILE}`], user: ROOT, workingDir: HOME_DIR }).catch(() => {});
}

function alert(computers: Computers, chatId: number, o: Extract<DeclaredOutcome, { kind: "failed" }>): void {
  const chat = getChat(computers.db, chatId);
  const label = chat ? chatLabel(chat) : `chat ${chatId}`;
  const tail = o.output.trim() ? `\n${o.output.trim().slice(-600)}` : "";
  raiseAlert(computers.db, {
    key: `computer-config:${chatId}:${o.hash}:${Date.now()}`,
    topic: `computer-config:${chatId}`,
    text: `Applying ${DECLARED_PATH} on the computer of ${label} failed at its ${o.step} step (${o.why}). It is tried again at the computer's next start, when the file changes, or with apply_computer_config.${tail}`,
  });
}

/**
 * Apply the chat's ~/.computer.yaml if it is not applied on this root disk (see the header). The computer
 * runs and the caller holds a lease; before an apply this takes a second one, lasting as long as an apply may
 * run plus `holdMs` (what the caller's command needs after it), and pushes it onto `leases` for the caller to
 * release. `force` retries a file that failed earlier in this boot.
 */
export async function ensureDeclared(computers: Computers, chat: Chat, opts: { force?: boolean; holdMs?: number; leases?: string[] } = {}): Promise<DeclaredOutcome> {
  const row = getComputer(computers.db, chat.id)!;
  const r = await computers.hangar.run(row.container, { command: ["bash", "-c", CHECK_SCRIPT], workingDir: HOME_DIR });
  const buf = Buffer.from(r.stdout);
  const nl = buf.indexOf("\n");
  const [applied = "", failed = ""] = buf.subarray(0, nl).toString("utf8").split("|");
  const nl2 = buf.indexOf("\n", nl + 1);
  if (nl < 0 || nl2 < 0 || buf.subarray(nl + 1, nl2).toString() !== "y") return { kind: "none" };
  const content = buf.subarray(nl2 + 1);
  const hash = sha256(content);
  if (hash === applied.trim()) return { kind: "current", hash };
  if (!opts.force && hash === failed.trim()) return { kind: "failed-before", hash };

  const red = secretsForChat(computers.db, computers.cfg.secretsFile, chat.id).red;
  const parsed = content.length > MAX_FILE ? { error: `${DECLARED_PATH} is larger than ${MAX_FILE >> 10} KiB` } : parseDeclared(content.toString("utf8"));
  if ("error" in parsed) {
    await recordFailed(computers, row.container, hash);
    const o = { kind: "failed" as const, hash, step: "parse", why: "the file is not valid", output: red.redact(parsed.error) };
    alert(computers, chat.id, o);
    return o;
  }

  const d = parsed.declared;
  const stepSec = computers.cfg.applyStepSec;
  // apt update and install, and setup: three steps at most, each limited.
  const limitMs = (3 * stepSec + 60) * 1000;
  const extra = acquireLease(computers.db, chat.id, Date.now() + limitMs + 60_000 + (opts.holdMs ?? 0));
  const own = "lease" in extra && !opts.leases ? extra.lease : undefined;
  if ("lease" in extra) opts.leases?.push(extra.lease);
  const nonce = randomBytes(6).toString("hex");
  const t0 = Date.now();
  let res;
  try {
    res = await runApply(computers, row.container, applyScript(d, hash, nonce, stepSec), new TextEncoder().encode(d.setup), limitMs);
  } finally {
    if (own) releaseLease(computers.db, chat.id, own);
  }
  const ms = Date.now() - t0;

  // Split the output at the markers: what each step printed.
  const marker = `@@${nonce} `;
  let step = "start";
  let end: { kind: "done" | "current" } | { kind: "fail"; step: string; code: number } | undefined;
  const by: Record<string, string[]> = {};
  for (const line of res.out.split("\n")) {
    if (line.startsWith(marker)) {
      const [k, a, b] = line.slice(marker.length).trim().split(" ");
      if (k === "step" && a) step = a;
      else if (k === "done" || k === "current") end = { kind: k };
      else if (k === "fail" && a) end = { kind: "fail", step: a, code: Number(b) };
      continue;
    }
    (by[step] ??= []).push(line);
  }
  const outputOf = (s: string) => trim(red.redact((by[s] ?? []).join("\n").trim()));
  const all = trim(red.redact(Object.values(by).flat().join("\n").trim()));
  if (end?.kind === "current") return { kind: "current", hash };
  if (end?.kind === "done") return { kind: "applied", hash, declared: d, ms, output: all };
  const o =
    end?.kind === "fail"
      ? { kind: "failed" as const, hash, step: end.step, why: exitWhy(end.code, stepSec), output: outputOf(end.step) }
      : { kind: "failed" as const, hash, step, why: res.error ? `the exec ended: ${res.error}` : `exit ${res.code ?? "?"} before it finished`, output: all };
  alert(computers, chat.id, o);
  return o;
}

/** The line a command's result carries about the file, when there is something to say. */
export function declaredNote(o: DeclaredOutcome | undefined): string | undefined {
  if (!o) return undefined;
  if (o.kind === "applied") return `(${DECLARED_PATH} was applied first, in ${Math.round(o.ms / 1000)}s: ${what(o.declared)}.)`;
  if (o.kind === "failed") return failedText(o, "The command ran anyway, without it.");
  return undefined;
}

export function failedText(o: Extract<DeclaredOutcome, { kind: "failed" }>, then = ""): string {
  const body = o.output.trim() ? `\n${o.step === "parse" ? o.output : `its output:\n${o.output}`}` : "";
  return `${DECLARED_PATH} was NOT applied: its ${o.step} step failed (${o.why}).${then ? ` ${then}` : ""} It is tried again at the computer's next start or when the file changes; after fixing it, apply_computer_config applies it at once. The owner has been alerted.${body}`;
}

/** apply_computer_config's text for an outcome. */
export function applyResultText(o: DeclaredOutcome): { text: string; isError: boolean } {
  switch (o.kind) {
    case "none":
      return { text: `There is no ${DECLARED_PATH} on this computer: nothing to apply. Write one first (\`apt:\` a list of Debian packages, \`setup:\` a shell script run as root).`, isError: true };
    case "current":
      return { text: `${DECLARED_PATH} is applied as it is now; nothing ran.`, isError: false };
    case "failed-before":
      return { text: `${DECLARED_PATH} failed earlier and was not retried.`, isError: true };
    case "applied":
      return { text: `Applied ${DECLARED_PATH} in ${Math.round(o.ms / 1000)}s: ${what(o.declared)}. It is applied again by itself whenever the computer's image changes, and whenever the file changes.${o.output ? `\noutput:\n${o.output}` : ""}`, isError: false };
    case "failed":
      return { text: failedText(o), isError: true };
  }
}
