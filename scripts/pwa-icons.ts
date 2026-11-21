/**
 * Render the console's app icons (src/console/pwa/*.png) from src/console/pwa/icon.svg, by hand, after the SVG
 * changes: needs a local Chromium (`CHROME_PATH`, else `chromium` on PATH). The PNGs are committed; the console
 * serves them as files (src/console/pwa.ts) and never renders anything itself.
 *
 *   icon-192.png, icon-512.png   the icon as drawn ("any")
 *   icon-maskable-512.png        its `#mark` at 80%, centred, so a launcher's mask (a circle, a squircle) cuts
 *                                only background: the safe zone is the centre circle of 40% radius
 *   apple-touch-icon.png         180 px, for iOS's home screen (it rounds the corners itself)
 *
 *   bun scripts/pwa-icons.ts
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..", "src", "console", "pwa");
const svg = readFileSync(join(DIR, "icon.svg"), "utf8");
const maskable = svg.replace('<g id="mark">', '<g id="mark" transform="translate(51.2 51.2) scale(.8)">');
if (maskable === svg) throw new Error('icon.svg has no <g id="mark">');

const OUT: [string, string, number][] = [
  ["icon-192.png", svg, 192],
  ["icon-512.png", svg, 512],
  ["icon-maskable-512.png", maskable, 512],
  ["apple-touch-icon.png", svg, 180],
];

const tmp = mkdtempSync(join(tmpdir(), "pwa-icons-"));
try {
  for (const [name, text, size] of OUT) {
    const page = join(tmp, `${name}.html`);
    writeFileSync(page, `<!doctype html><style>html,body{margin:0;overflow:hidden}svg{display:block;width:${size}px;height:${size}px}</style>${text}`);
    const p = Bun.spawnSync([process.env.CHROME_PATH ?? "chromium", "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", `--window-size=${size},${size}`, `--screenshot=${join(DIR, name)}`, `file://${page}`], { stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`chromium failed for ${name}: ${p.stderr.toString().slice(-500)}`);
    console.log(`${name}: ${size}x${size}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
