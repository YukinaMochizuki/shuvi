import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jimp } from "jimp";
import { parseTime, sheetCommand, sheetOptions, SHEET_EDGE, SHEET_MAX_FRAMES, timeLabel } from "../src/capabilities/computer/media.ts";

/**
 * video_sheet: its arguments and caps (media.ts), and video-sheet.sh itself, run with the real ffmpeg on
 * generated videos (skipped where there is no ffmpeg). The timing video is ffmpeg's testsrc with a grey strip
 * along its bottom whose brightness is the time (16 levels a second), so a tile's strip says which moment it
 * shows, not only what its label claims.
 */

const errorOf = (a: Parameters<typeof sheetOptions>[0]) => {
  const p = sheetOptions(a);
  return p.ok ? undefined : p.error;
};

describe("arguments", () => {
  test("times: seconds, mm:ss, hh:mm:ss; labels mm:ss and h:mm:ss", () => {
    expect(parseTime(90)).toBe(90);
    expect(parseTime("90")).toBe(90);
    expect(parseTime("1:30")).toBe(90);
    expect(parseTime("01:02:03.5")).toBe(3723.5);
    for (const bad of ["1:75", "abc", "1.5:00", "-3", "1:2:3:4", ""]) expect(parseTime(bad)).toBeUndefined();
    expect(parseTime(-1)).toBeUndefined();
    expect(timeLabel(65)).toBe("01:05");
    expect(timeLabel(3723)).toBe("1:02:03");
  });

  test("one spacing at most; the default needs none", () => {
    expect(errorOf({ every: 2, count: 4 })).toContain("Give one spacing, not every and count");
    expect(errorOf({ count: 4, scene: true })).toContain("not count and scene: true");
    const d = sheetOptions({});
    expect(d.ok && d.options).toEqual(["--cols", "4", "--rows", "4", "--max", String(SHEET_MAX_FRAMES), "--edge", String(SHEET_EDGE)]);
    const s = sheetOptions({ scene: true, from: "1:00", to: 90 });
    expect(s.ok && s.options.slice(0, 6)).toEqual(["--scene", "0.3", "--from", "60", "--to", "90"]);
    expect(s.ok && s.title).toBe("scenes, 01:00–01:30");
    expect(sheetOptions({ scene: false, count: 3 }).ok).toBe(true);
  });

  test("the caps and the window", () => {
    expect(errorOf({ count: SHEET_MAX_FRAMES })).toBeUndefined();
    expect(errorOf({ count: SHEET_MAX_FRAMES + 1 })).toContain(`count is at most ${SHEET_MAX_FRAMES} frames`);
    expect(errorOf({ count: 0 })).toContain("at least 1");
    expect(errorOf({ every: 0 })).toContain("positive");
    // An every over a known window is checked here: 0:00 to 2:00 every 1 s is 120 frames.
    expect(errorOf({ every: 1, from: 0, to: "2:00" })).toBe("every 1s from 00:00 to 02:00 is 120 frames, more than 64. Use a larger every (at least 1.9s here), or a narrower window.");
    expect(errorOf({ every: 1.9, from: 0, to: "2:00" })).toBeUndefined();
    expect(errorOf({ every: 2, from: "1:00", to: "0:30" })).toContain("The window is empty");
    expect(errorOf({ from: "soon" })).toContain("from is not a time");
  });

  test("grid", () => {
    const g = sheetOptions({ grid: "3x2" });
    expect(g.ok && g.options.slice(0, 4)).toEqual(["--cols", "3", "--rows", "2"]);
    expect(sheetOptions({ grid: "5 × 3" }).ok).toBe(true);
    expect(errorOf({ grid: "9x1" })).toContain("1 to 8");
    expect(errorOf({ grid: "big" })).toContain("columns × rows");
  });

  test("the command carries the script and quotes what the model wrote", () => {
    const p = sheetOptions({ every: 2 });
    const c = sheetCommand("~/inbox/it's.mp4", p.ok ? p.options : [], '"$HOME/out"', false);
    expect(c).toContain(`p='~/inbox/it'\\''s.mp4'`);
    expect(c).toContain("<<'SHUVI_VIDEO_SHEET_EOF'\n#!/bin/bash\n# video-sheet.sh");
    expect(c.trimEnd().endsWith(`bash "$s" '--every' '2' '--cols' '4' '--rows' '4' '--max' '64' '--edge' '1536' "$p" "$out" > /dev/null`)).toBe(true);
  });
});

// ---- the script, on real videos --------------------------------------------------------------------

const hasFfmpeg = Bun.spawnSync(["sh", "-c", "command -v ffmpeg && command -v ffprobe"]).exitCode === 0;
const SCRIPT = new URL("../src/capabilities/computer/video-sheet.sh", import.meta.url).pathname;

function sh(cmd: string[], cwd?: string) {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
function makeVideos(dir: string) {
  const gen = (args: string) => {
    const r = sh(["bash", "-c", `ffmpeg -v error -y ${args}`], dir);
    if (r.code !== 0) throw new Error(r.err);
  };
  // 16 s, 640x360, a keyframe only every 10 s (so seeking has to decode up to the moment), with the strip.
  gen(`-f lavfi -i testsrc=d=16:s=640x360:r=25 -f lavfi -i "nullsrc=s=640x40:r=25:d=16,geq=lum='clip(T*16\\,0\\,255)':cb=128:cr=128" -filter_complex "[0][1]overlay=0:H-h" -g 250 -pix_fmt yuv420p timing.mp4`);
  // Three shots: red 3 s, testsrc 4 s, blue 3 s.
  gen(`-f lavfi -i "color=c=red:s=640x360:r=25:d=3" -f lavfi -i "testsrc=s=640x360:r=25:d=4" -f lavfi -i "color=c=blue:s=640x360:r=25:d=3" -filter_complex "[0][1][2]concat=n=3:v=1" -pix_fmt yuv420p cuts.mp4`);
  // Portrait.
  gen(`-f lavfi -i testsrc=d=6:s=360x640:r=25 -pix_fmt yuv420p portrait.mp4`);
}
const run = (dir: string, args: string[]) => sh(["bash", SCRIPT, ...args], dir);

describe.skipIf(!hasFfmpeg)("video-sheet.sh on generated videos", () => {
  const dir = hasFfmpeg ? mkdtempSync(join(tmpdir(), "shuvi-sheet-")) : "";
  if (hasFfmpeg) makeVideos(dir);

  test("a window every 0.5 s: two sheets, sizes within the edge, and each tile shows the time its label says", async () => {
    const r = run(dir, ["--every", "0.5", "--from", "0:02", "--to", "14", "timing.mp4", "out"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    // Frames under a second apart are labelled to the tenth.
    const times = Array.from({ length: 24 }, (_, i) => `00:${String(2 + Math.floor(i / 2)).padStart(2, "0")}.${i % 2 ? 5 : 0}`);
    expect(r.out).toBe(
      [
        "video: timing.mp4 · 00:16 (16.0s) · 640x360",
        "window: 00:02.0 to 00:14.0",
        "24 frame(s), every 0.5s, on 2 sheet(s) of 4x4:",
        `sheet-01.jpg: ${times.slice(0, 16).join(" ")}`,
        `sheet-02.jpg: ${times.slice(16).join(" ")}`,
        "",
      ].join("\n"),
    );
    expect(readFileSync(join(dir, "out", "index.txt"), "utf8")).toBe(r.out);
    expect(readdirSync(join(dir, "out")).sort()).toEqual(["index.txt", "sheet-01.jpg", "sheet-02.jpg"]);
    const sheets = [await Jimp.read(join(dir, "out", "sheet-01.jpg")), await Jimp.read(join(dir, "out", "sheet-02.jpg"))];
    // 4 tiles of 378 px and 5 gaps of 4 px; rows of a 212 px tile and its 40 px label.
    expect([sheets[0]!.bitmap.width, sheets[0]!.bitmap.height]).toEqual([1532, 1028]);
    expect([sheets[1]!.bitmap.width, sheets[1]!.bitmap.height]).toEqual([1532, 516]);
    for (const s of sheets) expect(Math.max(s.bitmap.width, s.bitmap.height)).toBeLessThanOrEqual(SHEET_EDGE);
    const tw = 378, th = 212, pitchX = tw + 4, pitchY = th + 40 + 4;
    for (let i = 0; i < 24; i++) {
      const s = sheets[Math.floor(i / 16)]!;
      const k = i % 16;
      const x = 4 + (k % 4) * pitchX + tw / 2;
      const y = 4 + Math.floor(k / 4) * pitchY + th - 6; // in the strip
      const o = (y * s.bitmap.width + x) * 4;
      const grey = s.bitmap.data[o]!;
      // Studio-range luma 16t, as full-range RGB.
      const want = ((16 * (2 + i * 0.5) - 16) * 255) / 219;
      expect(Math.abs(grey - want)).toBeLessThan(6);
    }
  });

  test("the default: 16 frames spread evenly on one sheet", () => {
    const r = run(dir, ["timing.mp4", "out-default"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("16 frame(s), spread evenly, on 1 sheet(s) of 4x4:\nsheet-01.jpg: 00:01 00:02 00:03");
  });

  test("scene changes: the start and each cut", () => {
    const r = run(dir, ["--scene", "0.3", "cuts.mp4", "out-scene"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("3 frame(s), the start and each scene change (threshold 0.3): 2 change(s) found, on 1 sheet(s) of 3x1:\nsheet-01.jpg: 00:00 00:03 00:07\n");
  });

  test("a portrait video keeps its aspect ratio in a 5x2 grid", async () => {
    const r = run(dir, ["--count", "10", "--cols", "5", "--rows", "2", "portrait.mp4", "out-portrait"]);
    expect(r.code).toBe(0);
    const s = await Jimp.read(join(dir, "out-portrait", "sheet-01.jpg"));
    const { width, height } = s.bitmap;
    expect(Math.max(width, height)).toBeLessThanOrEqual(SHEET_EDGE);
    const tw = (width - 6 * 4) / 5;
    const th = (height - 3 * 4) / 2 - 40;
    expect(Math.abs(tw / th - 360 / 640)).toBeLessThan(0.02);
  });

  test("over the cap, and a window past the end, are refused with what to do", () => {
    const over = run(dir, ["--every", "0.2", "timing.mp4", "out-over"]);
    expect(over.code).toBe(4);
    expect(over.err).toContain("every 0.2s over 00:16 is 80 frames, more than 64. Use a larger every (at least 0.3s here), or a window (from/to)");
    const empty = run(dir, ["--from", "20", "timing.mp4", "out-empty"]);
    expect(empty.code).toBe(2);
    expect(empty.err).toContain("the window is empty");
    const missing = run(dir, ["nope.mp4", "out-missing"]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("no such file: nope.mp4");
  });
});
