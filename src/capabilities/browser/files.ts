import { z } from "zod";
import { err, ok, type ToolDef, type ToolResult } from "agent-runtime";
import { FILE_KEY, type BrowseAnswer, type Porchkit } from "../../porchkit/client.ts";
import type { Db } from "../../store/db.ts";
import { kvSet, type Chat } from "../../store/events.ts";
import { DOCUMENT_LIMIT, PHOTO_LIMIT, queueBotFile } from "../../store/outbox.ts";
import type { TurnState } from "../../agent/turn.ts";
import { safeName } from "../computer/files.ts";
import { downloadsOf, ownKey, pdfKv } from "./keys.ts";

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

  return [downloads, send];
}

