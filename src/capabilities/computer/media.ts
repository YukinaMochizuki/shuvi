import { readFileSync } from "node:fs";
import { resolvePath, shq } from "./exec.ts";

/**
 * The framework's media tools (docs/design.md §11, §15) as prepared execs: the assistant names a file and
 * gets a result, and never assembles the commands. Each is a bash script run like any exec, in the
 * background by default (the base image, computer/Dockerfile, has what they need).
 *
 *   video_sheet(path, …)   contact sheets of the video: frames every N seconds, N frames spread evenly, or
 *                          one at each scene change, optionally in a window (from / to), tiled C×R per
 *                          sheet with each frame's timestamp under it, plus a text index (duration,
 *                          resolution, each sheet's frames' times). At most SHEET_MAX_FRAMES frames; more is
 *                          refused with how to narrow it. The work is `video-sheet.sh`, beside this file:
 *                          self-contained (bash, awk, ffmpeg, ffprobe), so the same script can run where
 *                          shuvi does not, e.g. a platform service making sheets from URLs. It is sent with
 *                          each call (a heredoc), so changing it needs no new image.
 *
 * Arguments are checked here (`sheetOptions`) as far as they can be without the video; what needs its
 * length (an `every` over the whole video, the default count) the script checks, failing with the same
 * advice.
 *
 * Transcription is not here: it is to come from a shared platform service (docs/design.md §11), not from
 * something each computer installs and keeps up to date itself.
 */

/** The most frames one video_sheet call takes: 4 sheets of the default 4×4 grid. */
export const SHEET_MAX_FRAMES = 64;
/** A sheet's long edge, in pixels, at most. */
export const SHEET_EDGE = 1536;
/** The scene score (0..1) above which a frame counts as a scene change. */
export const SCENE_THRESHOLD = 0.3;
/** Columns or rows of a sheet, at most. */
export const GRID_MAX = 8;
export const DEFAULT_GRID = { cols: 4, rows: 4 };

/** The script itself (video-sheet.sh), sent with every call. */
export const SHEET_SCRIPT = readFileSync(new URL("./video-sheet.sh", import.meta.url), "utf8");
const HEREDOC = "SHUVI_VIDEO_SHEET_EOF";
if (SHEET_SCRIPT.includes(HEREDOC)) throw new Error(`video-sheet.sh must not contain ${HEREDOC}`);

/**
 * Does this video_sheet call act for the owner? On a file of the computer, yes (`ownerOnlyWhen`, for this
 * capability's video_sheet and media's alike); on a link alone (media's `url`), no: anyone may look at a link.
 */
export const sheetActsForOwner = (a: Record<string, unknown>): boolean => typeof a.url !== "string" || a.path !== undefined;

export interface SheetArgs {
  every?: number;
  count?: number;
  scene?: boolean;
  from?: number | string;
  to?: number | string;
  grid?: string;
}

/** Seconds from a number of seconds, `mm:ss` or `hh:mm:ss` (fractions allowed); undefined if neither. */
export function parseTime(v: number | string): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : undefined;
  const parts = v.trim().split(":");
  if (parts.length < 1 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return undefined;
  // Only the last part may have a fraction, and minutes and seconds after the first part stay under 60.
  if (parts.slice(0, -1).some((p) => p.includes("."))) return undefined;
  if (parts.slice(1).some((p) => Number(p) >= 60)) return undefined;
  return parts.reduce((t, p) => t * 60 + Number(p), 0);
}

/** A time as the sheets label it: `mm:ss`, or `h:mm:ss` past an hour. */
export function timeLabel(sec: number): string {
  const t = Math.round(sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export type SheetPlan = { ok: true; options: string[]; title: string } | { ok: false; error: string };

/**
 * Check video_sheet's arguments and turn them into the script's options (and a job title). Refuses what is
 * wrong whatever the video: two spacings at once, a bad time or window, a grid out of range, a count over the
 * cap, and an `every` over a window that would take more than the cap.
 */
export function sheetOptions(a: SheetArgs): SheetPlan {
  const fail = (error: string): SheetPlan => ({ ok: false, error });
  const given = [a.every !== undefined && "every", a.count !== undefined && "count", a.scene === true && "scene: true"].filter(Boolean) as string[];
  if (given.length > 1) return fail(`Give one spacing, not ${given.join(" and ")}: every (seconds between frames), count (frames spread evenly) or scene: true (a frame at each scene change).`);
  const opts: string[] = [];
  const title: string[] = [];
  if (a.every !== undefined) {
    if (!(a.every > 0) || !Number.isFinite(a.every)) return fail("every must be a positive number of seconds.");
    opts.push("--every", String(a.every));
    title.push(`every ${a.every}s`);
  }
  if (a.count !== undefined) {
    if (!Number.isInteger(a.count) || a.count < 1) return fail("count must be a whole number of frames, at least 1.");
    if (a.count > SHEET_MAX_FRAMES) return fail(`count is at most ${SHEET_MAX_FRAMES} frames. For more detail, sheet a window (from/to) at a time.`);
    opts.push("--count", String(a.count));
    title.push(`${a.count} frames`);
  }
  if (a.scene === true) {
    opts.push("--scene", String(SCENE_THRESHOLD));
    title.push("scenes");
  }
  let from: number | undefined;
  let to: number | undefined;
  if (a.from !== undefined) {
    from = parseTime(a.from);
    if (from === undefined) return fail(`from is not a time: ${JSON.stringify(a.from)}. Use seconds, mm:ss or hh:mm:ss.`);
  }
  if (a.to !== undefined) {
    to = parseTime(a.to);
    if (to === undefined) return fail(`to is not a time: ${JSON.stringify(a.to)}. Use seconds, mm:ss or hh:mm:ss.`);
  }
  if (from !== undefined && to !== undefined && to <= from) return fail(`The window is empty: to (${timeLabel(to)}) must be after from (${timeLabel(from)}).`);
  if (from !== undefined) opts.push("--from", String(from));
  if (to !== undefined) opts.push("--to", String(to));
  if (from !== undefined || to !== undefined) title.push(`${from !== undefined ? timeLabel(from) : "start"}–${to !== undefined ? timeLabel(to) : "end"}`);
  if (a.every !== undefined && from !== undefined && to !== undefined) {
    const n = Math.floor((to - from - 0.0005) / a.every) + 1;
    if (n > SHEET_MAX_FRAMES) {
      const least = Math.ceil(((to - from) / SHEET_MAX_FRAMES) * 10) / 10;
      return fail(`every ${a.every}s from ${timeLabel(from)} to ${timeLabel(to)} is ${n} frames, more than ${SHEET_MAX_FRAMES}. Use a larger every (at least ${least}s here), or a narrower window.`);
    }
  }
  let grid = DEFAULT_GRID;
  if (a.grid !== undefined) {
    const m = a.grid.trim().match(/^(\d+)\s*[x×*]\s*(\d+)$/i);
    if (!m) return fail(`grid is columns × rows, e.g. "4x4", not ${JSON.stringify(a.grid)}.`);
    grid = { cols: Number(m[1]), rows: Number(m[2]) };
    if (grid.cols < 1 || grid.rows < 1 || grid.cols > GRID_MAX || grid.rows > GRID_MAX) return fail(`grid columns and rows are each 1 to ${GRID_MAX}.`);
    title.push(`${grid.cols}x${grid.rows}`);
  }
  opts.push("--cols", String(grid.cols), "--rows", String(grid.rows), "--max", String(SHEET_MAX_FRAMES), "--edge", String(SHEET_EDGE));
  return { ok: true, options: opts, title: title.join(", ") };
}

/**
 * The sheets script: video-sheet.sh, written to a temporary file, run on `path` with `options` (from
 * `sheetOptions`) into the directory `out` (a shell word, e.g. `"$HOME/.jobs/7.sheets"`). The index is in
 * `out`/index.txt; `print` also prints it (a background job does not: its result carries the index already,
 * so its log holds only what went wrong).
 */
export function sheetCommand(path: string, options: string[], out: string, print = true): string {
  return [
    "set -e",
    `p=${shq(path)}`,
    resolvePath("p"),
    `out=${out}`,
    's=$(mktemp); trap \'rm -f "$s"\' EXIT',
    `cat > "$s" <<'${HEREDOC}'`,
    SHEET_SCRIPT.trimEnd(),
    HEREDOC,
    `bash "$s" ${options.map(shq).join(" ")} "$p" "$out"${print ? "" : " > /dev/null"}`,
  ].join("\n");
}
