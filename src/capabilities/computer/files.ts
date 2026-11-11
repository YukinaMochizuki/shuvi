import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { max } from "drizzle-orm";
import type { TurnState } from "../../agent/turn.ts";
import type { Db } from "../../store/db.ts";
import { enqueueOutbound, getChat, kvGet, kvSet, type ChatEvent, type MessageAttachment, type MessagePayload } from "../../store/events.ts";
import { attachmentOfEvent, pendingAttachments, updateAttachment } from "../../store/media.ts";
import { chatEvents } from "../../store/schema.ts";
import type { TelegramFiles } from "../../telegram/files.ts";
import { HOME_DIR, type ComputerConfig } from "./config.ts";
import { ComputerError, type Computers } from "./computer.ts";
import { resolvePath, shq, type ExecContext } from "./exec.ts";
import { redactionFor } from "../../secrets/redaction.ts";
import { acquireLease, getComputer, opHeld, releaseLease } from "./state.ts";

/**
 * Files between the chat and its computer (docs/design.md §15).
 *
 * INBOUND: a document, photo, video or audio THE OWNER sends is recorded with its message as an `attachment`
 * with no state (telegram/inbound.ts), a plain fact whether or not this capability is on. The server's
 * `inboxPass` (it holds the bot token; a runner child never does) handles them, and never starts a computer
 * for it:
 *   - a new file is copied into the chat's computer the next time that computer RUNS, which an exec (or any
 *     tool that needs it) makes it do; those tools wait for the chat's pending files to land first
 *     (`awaitInbox`, SHUVI_COMPUTER_INBOX_WAIT_SEC), so a command never runs before the file it is about;
 *   - a photo is not copied at all unless the assistant asks for it (`save_photo`, state `requested`): the
 *     model already sees it;
 *   - files recorded before this capability first ran are left out (`skipped`), once, so turning it on does
 *     not copy a whole history.
 * A copy is downloaded and pushed over an exec's stdin as `~/inbox/<message id>-<name>`, written under a
 * temporary name and renamed, so a half-copied file is never there under its own name. The line the model
 * reads is followed by where the file is (`inboxNote`). A bot may download files up to 20 MB: a larger one is
 * noted as not copied.
 *
 * OUTBOUND: `send_file(path)` and `send_photo(path, caption?)` read a file from the computer and queue it
 * for the sender, which alone talks to Telegram: the bytes wait in `<data dir>/outbox/` until delivered. A
 * bot may send documents up to 50 MB and photos up to 10 MB; past that the tool says so before reading
 * anything. A file holding a known secret value is not sent at all.
 */

/** The Bot API's limits for a bot: what it may download (getFile), and send as a document or a photo. */
export const DOWNLOAD_LIMIT = 20 * 1024 * 1024;
export const DOCUMENT_LIMIT = 50 * 1024 * 1024;
export const PHOTO_LIMIT = 10 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
/** kv: the last seq recorded before the computer capability first ran; files up to it are skipped. */
export const INBOX_FROM_KEY = "computer_inbox_from";

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** A file name safe on the computer: no path, nothing odd, not too long. */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^\.+/, "").trim().slice(-120);
  return clean || "file";
}

/** Where a message's attachment goes, from the home directory. */
export const inboxPath = (e: ChatEvent, name: string) => `inbox/${e.tgMessageId ?? e.seq}-${safeName(name)}`;

/** Whether this attachment is to be copied (a new file that is not a photo, or a photo asked for). */
const wanted = (a: MessageAttachment) => (a.state === undefined && a.kind !== "photo") || a.state === "requested";

/** The chat's files that wait to be copied now. */
export function waitingFiles(db: Db, chatId: number): ChatEvent[] {
  const from = Number(kvGet(db, INBOX_FROM_KEY) ?? 0);
  return pendingAttachments(db, chatId).filter((e) => e.seq > from && wanted(attachmentOfEvent(e)!));
}

/** Wait (up to `ms`) for the chat's waiting files to be copied by the server, now that its computer runs. */
export async function awaitInbox(db: Db, chatId: number, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (waitingFiles(db, chatId).length && Date.now() < end) await Bun.sleep(250);
}

/** One pass: copy the files that wait into computers that run. Returns how many landed. */
export async function inboxPass(db: Db, files: TelegramFiles, computers: Computers, ownerId: number): Promise<number> {
  if (kvGet(db, INBOX_FROM_KEY) === undefined) {
    // The first pass ever: what was sent before the capability ran is left alone.
    const last = db.select({ m: max(chatEvents.seq) }).from(chatEvents).get()?.m ?? 0;
    for (const e of pendingAttachments(db, undefined, 100_000)) if (e.seq <= last) updateAttachment(db, e.seq, { state: "skipped", error: "sent before the computer was on" });
    kvSet(db, INBOX_FROM_KEY, String(last));
  }
  let done = 0;
  for (const e of pendingAttachments(db)) {
    const a = attachmentOfEvent(e)!;
    if ((e.payload as unknown as MessagePayload).from.id !== ownerId) {
      updateAttachment(db, e.seq, { state: "skipped", error: "not the owner's" });
      continue;
    }
    if (!wanted(a)) {
      updateAttachment(db, e.seq, { state: "skipped" }); // a photo nobody asked for (save_photo asks)
      continue;
    }
    const chat = getChat(db, e.chatId);
    const row = chat ? getComputer(db, chat.id) : undefined;
    // Never start a computer for a file: it waits for the computer's next run.
    if (!chat || !row || row.runState !== "running" || opHeld(row, Date.now())) continue;
    const path = inboxPath(e, a.name);
    if (a.size && a.size > DOWNLOAD_LIMIT) {
      updateAttachment(db, e.seq, { state: "failed", error: `it is ${mb(a.size)}, over the 20 MB a bot may download from Telegram` });
      continue;
    }
    const lease = acquireLease(db, chat.id, Date.now() + 120_000);
    if ("busy" in lease) continue;
    try {
      const bytes = await files.download(a.fileId, DOWNLOAD_LIMIT);
      const script = `set -e; cd ~; mkdir -p inbox; cat > ${shq(`${path}.part`)}; mv ${shq(`${path}.part`)} ${shq(path)}`;
      const value = await computers.hangar.run(row.container, { command: ["bash", "-c", script], workingDir: HOME_DIR, stdin: bytes });
      if (value.code !== 0) throw new Error(`copying it failed (exit ${value.code}): ${value.stderr.trim().slice(0, 300)}`);
      updateAttachment(db, e.seq, { state: "ready", path });
      done++;
    } catch (err) {
      const attempts = (a.attempts ?? 0) + 1;
      const error = err instanceof Error ? err.message : String(err);
      updateAttachment(db, e.seq, attempts >= MAX_ATTEMPTS ? { state: "failed", attempts, error } : { attempts, error });
    } finally {
      releaseLease(db, chat.id, lease.lease);
    }
  }
  return done;
}

/** What the model reads after a message's line about its file. */
export function inboxNote(e: ChatEvent): string | null {
  const a = attachmentOfEvent(e);
  if (!a) return null;
  if (a.state === "ready") return `  ↳ saved on your computer as ~/${a.path}`;
  if (a.state === "failed") return `  ↳ not copied to your computer: ${a.error ?? "unknown error"}`;
  if (a.kind === "photo") return a.state === "requested" ? `  ↳ being copied to your computer as ~/${inboxPath(e, a.name)}` : null;
  if (a.state === "skipped") return null;
  return `  ↳ copied to your computer as ~/${inboxPath(e, a.name)} when it next runs (your next command there waits for it)`;
}

/**
 * Read `path` from the computer and queue it to be sent. Returns the tool's text, or throws ComputerError.
 */
export async function sendFromComputer(x: ExecContext, s: TurnState, cfg: ComputerConfig, a: { path: string; caption?: string; as: "document" | "photo" }): Promise<string> {
  if (s.passed) throw new ComputerError("This turn has already passed; nothing was sent.");
  const limit = a.as === "photo" ? PHOTO_LIMIT : DOCUMENT_LIMIT;
  const statScript = `p=${shq(a.path)}; ${resolvePath("p")}; [ -f "$p" ] || { echo "no such file: $p" >&2; exit 2; }; stat -L -c %s -- "$p"`;
  const run = (script: string, max?: number) => x.computers.withLease(x.chat, 120_000, async () => (await awaitInbox(x.db, x.chat.id, cfg.inboxWaitMs), x.computers.hangar.run(getComputer(x.db, x.chat.id)!.container, { command: ["bash", "-c", script], workingDir: HOME_DIR }, max)));
  const st = (await run(statScript)).value;
  if (st.code !== 0) throw new ComputerError(st.stderr.trim() || `cannot read ${a.path} (exit ${st.code})`);
  const size = Number(Buffer.from(st.stdout).toString("utf8").trim());
  if (size > limit) {
    throw new ComputerError(
      a.as === "photo"
        ? `${a.path} is ${mb(size)}; Telegram takes photos from a bot up to 10 MB. Send it with send_file (up to 50 MB), or make it smaller (e.g. ffmpeg or convert).`
        : `${a.path} is ${mb(size)}; Telegram's limit for a file sent by a bot is 50 MB. Compress it or split it (e.g. zip, split -b 45m) and send the parts.`,
    );
  }
  const read = (await run(`p=${shq(a.path)}; ${resolvePath("p")}; cat -- "$p"`, limit + 1)).value;
  if (read.code !== 0) throw new ComputerError(read.stderr.trim() || `cannot read ${a.path} (exit ${read.code})`);
  const red = redactionFor(cfg.secretsFile);
  const leaked = red.contains(read.stdout);
  if (leaked === "?") throw new ComputerError(`${a.path} was not sent: ${red.why}, so it cannot be checked for secret values.`);
  if (leaked) throw new ComputerError(`${a.path} contains the value of the secret profile "${leaked}"; it was not sent.`);
  const n = s.n++;
  const name = safeName(a.path);
  const dir = join(cfg.dataDir, "outbox");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${s.turnId}-${n}-${name}`);
  writeFileSync(`${file}.tmp`, read.stdout);
  renameSync(`${file}.tmp`, file);
  const caption = a.caption ? red.redact(a.caption).slice(0, 1024) : undefined;
  enqueueOutbound(x.db, {
    chatId: x.chat.id,
    kind: "bot_file",
    payload: { as: a.as, file, name, source: a.path, bytes: read.stdout.length, ...(caption ? { caption } : {}) },
    idemKey: `turn:${s.turnId}:${n}`,
    turnId: s.turnId,
  });
  return `Sent ${a.as === "photo" ? "the photo" : "the file"} ${a.path} (${mb(read.stdout.length)}).`;
}
