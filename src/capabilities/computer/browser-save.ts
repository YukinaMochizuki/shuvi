import { z } from "zod";
import { err, ok, type ToolDef, type ToolResult } from "agent-runtime";
import { describe, Porchkit, PorchkitError, type PorchkitConfig } from "../../porchkit/client.ts";
import type { ChatPolicy } from "../../policy/policy.ts";
import { describeBrowse, renderAnswer } from "../browser/index.ts";
import { ownKey, sessionOf } from "../browser/keys.ts";
import { UPLOAD_LIMIT, UPLOAD_MODES, uploadedLine, uploadToPage } from "../browser/upload.ts";
import { policyEnables } from "../types.ts";
import { ComputerError } from "./computer.ts";
import { COPY_SLICE_MS, copyInto, homeRun } from "./copy.ts";
import type { ExecContext } from "./exec.ts";
import { readFromComputer, safeName } from "./files.ts";
import { getComputer } from "./state.ts";

/**
 * browser_save(key): one of this chat's browser files (a completed download of its window, or a PDF browser_send
 * made here; browser/keys.ts decides which keys are the chat's) into ~/inbox/browser/<name> on its computer.
 *
 * A COMPUTER tool, not the browser's: it writes onto the computer, so its authority is the computer's. It is
 * owner-only like send_file and exec, and delegable under `delegate: [computer]` exactly as they are; a group
 * that delegates only the browser gives its operators no way onto the computer through it.
 *
 * The file comes from porchkit's file cache through the shared client (src/porchkit/client.ts), by the same
 * resumable copy as save_link and video_fetch (copy.ts): a large file that does not land in one slice is carried
 * on by calling again. Without porchkit configured, or in a chat whose policy does not enable the browser, it
 * refuses and says why.
 *
 * browser_upload_from_computer(path, ref?): the other way, a file on the computer given to this chat's browser
 * page (browser/upload.ts: set on a file input with `ref`, or the next file chooser armed). The computer's tool
 * for the same reason: what leaves the computer is the computer's authority (as send_file), so it is owner-only
 * and delegable only under `delegate: [computer]`. The browser's own browser_upload, anyone's, takes only a file
 * someone sent in the chat or a browser download. Up to 20 MB, checked before reading; a file holding a known
 * secret value is not uploaded (files.ts `readFromComputer`, as for send_file).
 */

const clients = new WeakMap<PorchkitConfig, Porchkit>();
const clientOf = (cfg: PorchkitConfig) => {
  let p = clients.get(cfg);
  if (!p) clients.set(cfg, (p = new Porchkit(cfg)));
  return p;
};

const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const said = (e: unknown) => describe(e).replace("The media service", "The browser's service");

/** Why browser files are out of reach here, or null: porchkit is needed, and the browser in this chat's policy. */
function noBrowser(cfg: { porchkit: PorchkitConfig | null }, chatPolicy: ChatPolicy | undefined, what: string): string | null {
  if (!cfg.porchkit) return `Nothing can be ${what}: there is no browser here (porchkit is not configured).`;
  if (!policyEnables(chatPolicy, "browser")) return `This chat has no browser (its policy does not enable it), so nothing can be ${what}.`;
  return null;
}

export function browserUploadTool(x: ExecContext, chatPolicy: ChatPolicy | undefined): ToolDef<{ path: string; ref?: string }> {
  const { chat, cfg } = x;
  return {
    name: "browser_upload_from_computer",
    description: `Give this chat's browser page a file from your computer (up to 20 MB). ${UPLOAD_MODES} Only the owner may ask for it.`,
    inputSchema: {
      path: z.string().min(1).describe("The file's path on the computer, e.g. ~/out/photo.jpg"),
      ref: z.string().min(1).max(32).optional().describe("A file input's ref from the page text; leave out to arm the page's next file chooser"),
    },
    async handler(a): Promise<ToolResult> {
      const why = noBrowser(cfg, chatPolicy, "uploaded from the computer");
      if (why) return err(why);
      const porch = clientOf(cfg.porchkit!);
      let bytes: Uint8Array;
      try {
        bytes = await readFromComputer(x, cfg, a.path, UPLOAD_LIMIT, (sz) => `${a.path} is ${sz}; a page can be given files up to 20.0 MB. Nothing was uploaded.`, "uploaded");
      } catch (e) {
        return err(e instanceof ComputerError ? e.message : `Reading it failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const name = safeName(a.path);
      try {
        const ans = await uploadToPage(porch, sessionOf(chat), { name, bytes }, a.ref);
        return ok(`${uploadedLine(name, bytes.length, a.ref)}\n${renderAnswer(ans)}`);
      } catch (e) {
        return err(`${describeBrowse(e)} Nothing was uploaded.`);
      }
    },
  };
}

export function browserSaveTool(x: ExecContext, chatPolicy: ChatPolicy | undefined): ToolDef<{ key: string }> {
  const { db, chat, computers, cfg } = x;
  return {
    name: "browser_save",
    description: "Put one of this chat's browser downloads (or a PDF browser_send made) on your computer, in ~/inbox/browser/, by its key (browser_downloads lists them). Only the owner may ask for it.",
    inputSchema: { key: z.string().min(1).max(128).describe("The file's key, from browser_downloads or a PDF's from browser_send") },
    async handler(a): Promise<ToolResult> {
      if (!cfg.porchkit) return err("Nothing can be saved from the browser: there is no browser here (porchkit is not configured).");
      if (!policyEnables(chatPolicy, "browser")) return err("This chat has no browser (its policy does not enable it), so there is no browser file of it to save.");
      const porch = clientOf(cfg.porchkit);
      const k = await ownKey(db, porch, chat, a.key, said);
      if ("error" in k) return err(`${k.error} Nothing was saved.`);
      const path = `inbox/browser/${safeName(k.name)}`;
      try {
        const first = await porch.fileRange(a.key, 0, 0);
        if (first.total === null) return err("The browser's service did not say how large the file is; nothing was saved.");
        const total = first.total;
        const { value } = await computers.withLease(chat, COPY_SLICE_MS + 60_000, async () => {
          const run = homeRun(computers.hangar, getComputer(db, chat.id)!.container);
          await run("set -e; cd ~; mkdir -p inbox/browser");
          return copyInto(porch, run, { key: a.key, path, part: `${path}.part-browser`, total });
        });
        if (!value.done) return ok(`Not all there yet: ${size(value.offset)} of ${size(total)} copied to ~/${path}. Call browser_save again with the same key to carry on: it resumes where it stopped.`);
        return ok(`Saved on your computer: ~/${path} (${size(total)}).`);
      } catch (e) {
        if (e instanceof ComputerError) return err(e.message);
        return err(`Saving failed: ${e instanceof PorchkitError ? said(e) : e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}
