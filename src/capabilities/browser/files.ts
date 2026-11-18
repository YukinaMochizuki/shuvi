import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { err, ok, type ToolDef, type ToolResult } from "agent-runtime";
import { FILE_KEY, type BrowseAnswer, type Porchkit } from "../../porchkit/client.ts";
import type { Db } from "../../store/db.ts";
import { kvSet, type Chat } from "../../store/events.ts";
import { DOCUMENT_LIMIT, PHOTO_LIMIT, queueBotFile } from "../../store/outbox.ts";
import type { TurnState } from "../../agent/turn.ts";
import { safeName } from "../computer/files.ts";
import { attachmentIn, awaitAttachment, doneWithAttachment, requestAttachment } from "./attachments.ts";
import { downloadsOf, ownKey, pdfKv } from "./keys.ts";
import { overLimit, UPLOAD_MODES, uploadedLine, uploadToPage } from "./upload.ts";

/**
 * What the browser has, out of it: its downloads, a screenshot, the page as a PDF.
 *
 *   browser_downloads()  this chat's window's downloads (porchkit `GET /browse/sessions/<s>/downloads`): name,
 *                        size, type, state, and the key of each completed one.
 *   browser_send(what, key?, caption?)  to THIS chat, through the store and the sender like every message
 *                        (store/outbox.ts; a capability never talks to Telegram): `screenshot` a fresh one as a
 *                        photo, `download` the completed download with that key as a document (its own name),
 *                        `pdf` the page as a PDF document named from its title. Telegram's limits for a bot are
 *                        checked first (photo 10 MB, document 50 MB): over, nothing is sent and the tool says so.
 *                        Anyone whose message starts a turn here may ask, as for every browser tool.
 *   browser_upload(source, ref?)  gives the page a file: one someone sent here (fetched by the server, which alone
 *                        may download from Telegram: attachments.ts) or one of the window's downloads; up to 20 MB,
 *                        checked before anything is posted (upload.ts). Anyone may ask, as for every browser tool.
 *                        A file from the computer is the computer's tool, browser_upload_from_computer.
 *   browser_save(key)    is the COMPUTER's tool (computer/index.ts): saving onto the computer is the computer's
 *                        authority, delegated by `delegate: [computer]`. It uses the same keys (keys.ts).
 *
 * A key is used only if it is this chat's (keys.ts): a completed download of its window, or a PDF browser_send
 * made in it. Any other key is refused.
 */


const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const size = (n: number) => (n >= 1024 * 1024 ? mb(n) : `${Math.max(1, Math.round(n / 1024))} KB`);

/** A PDF's name from the page's title: safe, short, `.pdf`. */
export function pdfName(title: string | null | undefined): string {
  const base = safeName((title ?? "").replace(/[\\/]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80)).replace(/\.pdf$/i, "");
  return `${base === "file" || !base ? "page" : base}.pdf`;
}

export interface FileToolsContext {
  db: Db;
  chat: Chat;
  s: TurnState;
  porch: Porchkit;
  session: string;
  dataDir: string;
  /** This chat has the computer too: the answers mention browser_save (the computer's tool). */
  computer: boolean;
  /** The browser's own error text for a porchkit failure (index.ts `describeBrowse`). */
  describe: (e: unknown) => string;
  /** An action's answer as the model reads it (index.ts `renderAnswer`). */
  render: (a: BrowseAnswer) => string;
  /** How long browser_upload waits for the server to fetch a sent file (attachments.ts). */
  attachWaitMs: number;
}

export function fileTools(x: FileToolsContext): ToolDef[] {
  const { db, chat, s, porch } = x;

  const downloads: ToolDef<Record<string, never>> = {
    name: "browser_downloads",
    description: "This chat's browser downloads: name, size, type, state, and the key of each completed one (for browser_send or browser_save).",
    inputSchema: {},
    async handler() {
      const list = await downloadsOf(porch, x.session, x.describe);
      if (typeof list === "string") return err(list);
      if (!list.length) return ok("No downloads in this chat's browser.");
      return ok(
        list
          .map((d) => `${d.name} — ${size(d.bytes)}, ${d.mime || "unknown type"}, ${d.state === "completed" ? `completed, key ${d.key}` : d.state === "in_progress" ? "still downloading" : d.state}`)
          .join("\n"),
      );
    },
  };

  /** Queue `bytes` to this chat. */
  function queue(as: "photo" | "document", name: string, bytes: Uint8Array, source: string, caption?: string): void {
    queueBotFile(db, { dataDir: x.dataDir, chatId: chat.id, turnId: s.turnId, n: s.n++, as, name, bytes, source, ...(caption ? { caption } : {}) });
  }

  const tooLarge = (what: string, n: number, limit: number) =>
    `${what} is ${mb(n)}; Telegram takes ${limit === PHOTO_LIMIT ? "photos" : "files"} from a bot up to ${mb(limit)}. Nothing was sent.`;

  const send: ToolDef<{ what: "screenshot" | "download" | "pdf"; key?: string; caption?: string }> = {
    name: "browser_send",
    description:
      'Send something from your browser to this chat: "screenshot" (the page now, as a photo), "download" (a completed download, by its key from browser_downloads, as a file) or "pdf" (the page as a PDF file).',
    inputSchema: {
      what: z.enum(["screenshot", "download", "pdf"]),
      key: z.string().min(1).max(128).optional().describe('With "download": the download\'s key'),
      caption: z.string().max(1024).optional().describe("A caption (up to 1024 characters)"),
    },
    async handler(a): Promise<ToolResult> {
      if (s.passed) return err("This turn has already passed; nothing was sent.");
      try {
        if (a.what === "screenshot") {
          const ans = await porch.browseAct(x.session, { action: "screenshot" });
          if (!ans.screenshot?.key) return err("The browser answered without a screenshot; nothing was sent.");
          if ((ans.screenshot.bytes ?? 0) > PHOTO_LIMIT) return err(tooLarge("The screenshot", ans.screenshot.bytes!, PHOTO_LIMIT));
          const f = await porch.file(ans.screenshot.key);
          if (f.bytes.length > PHOTO_LIMIT) return err(tooLarge("The screenshot", f.bytes.length, PHOTO_LIMIT));
          queue("photo", "screenshot.png", f.bytes, `browser: screenshot of ${ans.url ?? "the page"}`, a.caption);
          return ok(`Sent a screenshot of ${ans.title || ans.url || "the page"} (${size(f.bytes.length)}).`);
        }
        if (a.what === "download") {
          if (!a.key) return err('Give the download\'s key (browser_downloads lists them) with what: "download".');
          const k = await ownKey(db, porch, chat, a.key, x.describe);
          if ("error" in k) return err(`${k.error} Nothing was sent.`);
          if ((k.bytes ?? 0) > DOCUMENT_LIMIT) return err(`${tooLarge(k.name, k.bytes!, DOCUMENT_LIMIT)}${x.computer ? " browser_save puts it on your computer instead." : ""}`);
          const f = await porch.file(a.key);
          if (f.bytes.length > DOCUMENT_LIMIT) return err(tooLarge(k.name, f.bytes.length, DOCUMENT_LIMIT));
          queue("document", safeName(k.name), f.bytes, `browser: download ${safeName(k.name)}`, a.caption);
          return ok(`Sent ${safeName(k.name)} (${size(f.bytes.length)}).`);
        }
        const ans: BrowseAnswer = await porch.browseAct(x.session, { action: "pdf" });
        if (!ans.pdf?.key || !FILE_KEY.test(ans.pdf.key)) return err("The browser answered without a PDF; nothing was sent.");
        const name = pdfName(ans.title);
        kvSet(db, pdfKv(chat.id, ans.pdf.key), name);
        const later = x.computer ? ` browser_save with key ${ans.pdf.key} puts it on your computer instead.` : "";
        if ((ans.pdf.bytes ?? 0) > DOCUMENT_LIMIT) return err(`${tooLarge(`The PDF of ${ans.title || "the page"}`, ans.pdf.bytes!, DOCUMENT_LIMIT)}${later}`);
        const f = await porch.file(ans.pdf.key);
        if (f.bytes.length > DOCUMENT_LIMIT) return err(`${tooLarge(`The PDF of ${ans.title || "the page"}`, f.bytes.length, DOCUMENT_LIMIT)}${later}`);
        queue("document", name, f.bytes, `browser: pdf of ${ans.url ?? "the page"}`, a.caption);
        return ok(`Sent ${name} (${size(f.bytes.length)}), the page as a PDF (key ${ans.pdf.key}).`);
      } catch (e) {
        return err(`${x.describe(e)} Nothing was sent.`);
      }
    },
  };

  const upload: ToolDef<{ source: { message?: number; download?: string }; ref?: string }> = {
    name: "browser_upload",
    description:
      "Give the page a file: a photo or file someone sent in this chat (`source: {message: <#number>}`) or one of this chat's browser downloads (`source: {download: <key>}`), up to 20 MB. " +
      UPLOAD_MODES,
    inputSchema: {
      source: z
        .object({
          message: z.number().int().positive().optional().describe("The #number of a message with a photo or file"),
          download: z.string().min(1).max(128).optional().describe("A download's key (browser_downloads)"),
        })
        .describe("Exactly one of message or download"),
      ref: z.string().min(1).max(32).optional().describe("A file input's ref from the page text; leave out to arm the page's next file chooser"),
    },
    async handler(a): Promise<ToolResult> {
      const { message, download } = a.source ?? {};
      if ((message === undefined) === (download === undefined)) return err("Give exactly one source: {message: <#number>} or {download: <key>}.");
      let file: { name: string; bytes: Uint8Array };
      if (message !== undefined) {
        const at = attachmentIn(db, chat, message);
        if ("error" in at) return err(at.error.includes("still downloading") ? at.error : `${at.error} Nothing was uploaded.`);
        if ("photo" in at) {
          // A photo anyone sent: vision's copy, already in the data dir.
          let bytes: Uint8Array;
          try {
            bytes = new Uint8Array(readFileSync(join(x.dataDir, at.photo.path)));
          } catch {
            return err(`#${message}'s photo is not on hand any more. Nothing was uploaded.`);
          }
          file = { name: at.photo.name, bytes };
          return finish(file);
        }
        const name = safeName(at.attachment.name);
        if (at.attachment.size) {
          const over = overLimit(name, at.attachment.size);
          if (over) return err(over);
        }
        requestAttachment(db, message);
        const got = await awaitAttachment(db, x.dataDir, message, x.attachWaitMs);
        if ("error" in got) return err(got.pending ? got.error : `${got.error} Nothing was uploaded.`);
        file = { name, bytes: got.bytes };
      } else {
        const k = await ownKey(db, porch, chat, download!, x.describe);
        if ("error" in k) return err(`${k.error} Nothing was uploaded.`);
        const name = safeName(k.name);
        const listed = overLimit(name, k.bytes ?? 0);
        if (listed) return err(listed);
        try {
          file = { name, bytes: (await porch.file(download!)).bytes };
        } catch (e) {
          return err(`${x.describe(e)} Nothing was uploaded.`);
        }
      }
      return finish(file, message);

      async function finish(f: { name: string; bytes: Uint8Array }, fetched?: number): Promise<ToolResult> {
        const over = overLimit(f.name, f.bytes.length);
        if (over) return err(over);
        try {
          const ans = await uploadToPage(porch, x.session, f, a.ref);
          if (fetched !== undefined) doneWithAttachment(db, x.dataDir, fetched);
          return ok(`${uploadedLine(f.name, f.bytes.length, a.ref)}\n${x.render(ans)}`);
        } catch (e) {
          return err(`${x.describe(e)} Nothing was uploaded.`);
        }
      }
    },
  };

  return [downloads, send, upload];
}

