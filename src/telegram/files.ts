import type { Api } from "grammy";
import type { StickerSet } from "grammy/types";

/**
 * Downloading a file someone sent (`getFile`, then the Bot API's file endpoint), and reading a sticker
 * set (`getStickerSet`, for the sticker library). READ-ONLY on purpose:
 * this is what a server loop may be handed, where the full `Api` would let it send, and only the sender
 * sends. It needs the bot token, so it exists only in the server; a runner child never has one.
 */
export interface TelegramFiles {
  /** The bytes of the file `fileId`. Throws on a Bot API error or a file over `maxBytes`. */
  download(fileId: string, maxBytes: number): Promise<Uint8Array>;
  /** The sticker set `name`, as `getStickerSet` gives it. */
  stickerSet(name: string): Promise<StickerSet>;
}

export const DEFAULT_API_ROOT = "https://api.telegram.org";

export function telegramFiles(api: Api, token: string, apiRoot = DEFAULT_API_ROOT): TelegramFiles {
  return {
    async download(fileId, maxBytes) {
      const f = await api.getFile(fileId);
      if (!f.file_path) throw new Error(`getFile gave no path for ${fileId}`);
      if (f.file_size && f.file_size > maxBytes) throw new Error(`file is ${f.file_size} bytes, over ${maxBytes}`);
      const res = await fetch(`${apiRoot}/file/bot${token}/${f.file_path}`);
      if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > maxBytes) throw new Error(`file is ${bytes.length} bytes, over ${maxBytes}`);
      return bytes;
    },
    stickerSet: (name) => api.getStickerSet(name),
  };
}
