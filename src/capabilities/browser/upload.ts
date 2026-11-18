import type { BrowseAnswer, Porchkit } from "../../porchkit/client.ts";

/**
 * Giving a page a file: porchkit holds it for the session (`POST /browse/sessions/<s>/uploads`), then the act
 * `{action: "upload", files: [id], ref?}` uses it. With `ref`, the file is set on that file input; without, the
 * page's NEXT file chooser is armed with it, and the model clicks the page's own upload button ("Change photo")
 * to open it. The browser's browser_upload (a sent file, a download) and the computer's
 * browser_upload_from_computer (a file on the computer) both upload through here; this module imports no
 * capability, so either may import it.
 */

/** What porchkit takes per file, and what a bot may download from Telegram: the same 20 MB. */
export const UPLOAD_LIMIT = 20 * 1024 * 1024;

export const sizeLabel = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Why a file of `bytes` cannot be uploaded, or null. */
export function overLimit(name: string, bytes: number): string | null {
  return bytes > UPLOAD_LIMIT ? `${name} is ${sizeLabel(bytes)}; a page can be given files up to ${sizeLabel(UPLOAD_LIMIT)}. Nothing was uploaded.` : null;
}

/** Post the file, then set it (`ref`) or arm the next file chooser with it. Throws porchkit's errors. */
export async function uploadToPage(porch: Porchkit, session: string, file: { name: string; bytes: Uint8Array }, ref?: string): Promise<BrowseAnswer> {
  const held = await porch.browseUpload(session, file.name, file.bytes);
  return porch.browseAct(session, { action: "upload", files: [held.id], ...(ref ? { ref } : {}) });
}

/** The line before the page text: what happened, and in armed mode what to do next. */
export function uploadedLine(name: string, bytes: number, ref?: string): string {
  return ref
    ? `Put ${name} (${sizeLabel(bytes)}) into the file field ${ref}.`
    : `${name} (${sizeLabel(bytes)}) is ready for the page's next file chooser: now click the page's own upload button (e.g. "Change photo", "Upload") with browser_click, and the chooser gets this file.`;
}

export const UPLOAD_MODES =
  "With `ref` (a file input in the page text) the file is set on it; without, the page's next file chooser is armed with it, so then click the page's own upload button (e.g. \"Change photo\").";
