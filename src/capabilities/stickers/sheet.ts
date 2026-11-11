import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createJimp } from "@jimp/core";
import webp from "@jimp/wasm-webp";
import { defaultFormats, defaultPlugins } from "jimp";

/**
 * The numbered contact sheet `add_sticker_pack` shows her: every sticker of a set, in set order, each in
 * its own cell with its number, so she can describe them by number. A set is split into pages of
 * PER_PAGE (6 × 5) so a cell stays large enough to read after the model's API scales the image down;
 * every sticker is on exactly one page, and none is left out (one whose picture is missing gets an empty,
 * hatched cell with its number).
 *
 * Images are composed with Jimp (pure JavaScript; WebP through its WebAssembly codec), so nothing needs a
 * native build. Numbers are drawn from a small built-in digit font rather than Jimp's font loader, which
 * needs files and a fetch that do not work the same in every runtime.
 */

const Jimp = createJimp({ formats: [...defaultFormats, webp], plugins: defaultPlugins });
type Image = InstanceType<typeof Jimp>;

export const COLS = 6;
export const ROWS = 5;
export const PER_PAGE = COLS * ROWS;
export const CELL = 160;
const PAD = 8;
const LABEL_H = 24;

export interface SheetCell {
  n: number;
  /** The picture, relative to `dataDir`; null when there is none. */
  path: string | null;
}

export interface SheetPage {
  /** JPEG bytes. */
  image: Buffer;
  /** The numbers on this page, in order. */
  numbers: number[];
}

// A 5×7 digit font, one string per row ("#" is ink).
const DIGITS: Record<string, string[]> = {
  "0": [" ### ", "#   #", "#  ##", "# # #", "##  #", "#   #", " ### "],
  "1": ["  #  ", " ##  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "],
  "2": [" ### ", "#   #", "    #", "   # ", "  #  ", " #   ", "#####"],
  "3": ["#####", "   # ", "  #  ", "   # ", "    #", "#   #", " ### "],
  "4": ["   # ", "  ## ", " # # ", "#  # ", "#####", "   # ", "   # "],
  "5": ["#####", "#    ", "#### ", "    #", "    #", "#   #", " ### "],
  "6": ["  ## ", " #   ", "#    ", "#### ", "#   #", "#   #", " ### "],
  "7": ["#####", "    #", "   # ", "  #  ", " #   ", " #   ", " #   "],
  "8": [" ### ", "#   #", "#   #", " ### ", "#   #", "#   #", " ### "],
  "9": [" ### ", "#   #", "#   #", " ####", "    #", "   # ", " ##  "],
};
const SCALE = 2;
const GLYPH_W = 5 * SCALE;
const GLYPH_H = 7 * SCALE;

function fill(img: Image, x0: number, y0: number, w: number, h: number, rgba: number): void {
  const { data, width, height } = img.bitmap;
  const r = (rgba >>> 24) & 255, g = (rgba >>> 16) & 255, b = (rgba >>> 8) & 255;
  for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) {
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
}

function drawNumber(img: Image, n: number, x: number, y: number): void {
  const s = String(n);
  const w = s.length * (GLYPH_W + SCALE) + SCALE * 3;
  fill(img, x, y, w, GLYPH_H + SCALE * 4, 0x202020ff);
  [...s].forEach((ch, k) => {
    DIGITS[ch]!.forEach((row, ry) => {
      [...row].forEach((c, rx) => {
        if (c === "#") fill(img, x + SCALE * 2 + k * (GLYPH_W + SCALE) + rx * SCALE, y + SCALE * 2 + ry * SCALE, SCALE, SCALE, 0xffffffff);
      });
    });
  });
}

async function picture(dataDir: string, rel: string | null): Promise<Image | null> {
  if (!rel) return null;
  try {
    return (await Jimp.read(readFileSync(join(dataDir, rel)))) as Image;
  } catch {
    return null;
  }
}

/** Render one page. */
async function page(cells: SheetCell[], dataDir: string): Promise<Buffer> {
  const rows = Math.ceil(cells.length / COLS);
  const sheet = new Jimp({ width: COLS * CELL, height: rows * (CELL + LABEL_H), color: 0xffffffff }) as Image;
  for (const [i, cell] of cells.entries()) {
    const cx = (i % COLS) * CELL;
    const cy = Math.floor(i / COLS) * (CELL + LABEL_H);
    // Cell border, so neighbouring stickers never read as one.
    fill(sheet, cx, cy, CELL, 1, 0xccccccff);
    fill(sheet, cx, cy, 1, CELL + LABEL_H, 0xccccccff);
    const img = await picture(dataDir, cell.path);
    const box = CELL - 2 * PAD;
    if (img) {
      img.contain({ w: box, h: box });
      sheet.composite(img, cx + PAD, cy + LABEL_H + PAD - 4);
    } else {
      for (let d = 0; d < box; d += 12) fill(sheet, cx + PAD + d, cy + LABEL_H + PAD, 2, box - 8, 0xeeeeeeff);
    }
    drawNumber(sheet, cell.n, cx + 3, cy + 3);
  }
  return sheet.getBuffer("image/jpeg", { quality: 85 });
}

/** The pages of a set's contact sheet, PER_PAGE cells each, in the order given. */
export async function renderContactSheet(cells: SheetCell[], dataDir: string): Promise<SheetPage[]> {
  const pages: SheetPage[] = [];
  for (let i = 0; i < cells.length; i += PER_PAGE) {
    const chunk = cells.slice(i, i + PER_PAGE);
    pages.push({ image: await page(chunk, dataDir), numbers: chunk.map((c) => c.n) });
  }
  return pages;
}

/** Where cell `i` (0-based, on its page) sits: its picture box's top-left corner and size. For tests. */
export function cellBox(i: number): { x: number; y: number; size: number } {
  return { x: (i % COLS) * CELL + PAD, y: Math.floor(i / COLS) * (CELL + LABEL_H) + LABEL_H + PAD - 4, size: CELL - 2 * PAD };
}

/** Decode an image (for tests and callers that need pixels). */
export async function decode(bytes: Buffer): Promise<Image> {
  return (await Jimp.read(bytes)) as Image;
}
