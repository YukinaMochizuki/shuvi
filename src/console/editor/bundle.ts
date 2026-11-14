import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `/editor.js`: the Home page's editor (editor.ts and the pinned CodeMirror packages it imports), bundled by Bun
 * in this process the first time it is asked for, then kept. No build step and nothing generated in the repository;
 * the console warms it when it starts (server.ts `serveConsole`), so the first page does not wait for it. A failed
 * build is not kept: the next request tries again.
 */

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "editor.ts");

let built: Promise<string> | undefined;

export function editorBundle(): Promise<string> {
  built ??= Bun.build({ entrypoints: [ENTRY], target: "browser", minify: true, format: "esm" })
    .then(async (r) => {
      if (!r.success || !r.outputs[0]) throw new Error(`the editor did not build: ${r.logs.map((l) => l.message).join("; ")}`);
      return r.outputs[0].text();
    })
    .catch((e) => {
      built = undefined;
      throw e;
    });
  return built;
}
