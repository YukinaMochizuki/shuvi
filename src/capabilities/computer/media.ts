import { resolvePath, shq } from "./exec.ts";

/**
 * The framework's media tools (docs/design.md §11, §15) as prepared execs: the assistant names a file and
 * gets a result, and never assembles the commands. Each is a bash script run like any exec, in the
 * background by default (the base image, computer/Dockerfile, has what they need).
 *
 *   video_frames(path, n)   n evenly spaced frames of the video (ffprobe for its length, then one ffmpeg seek
 *                           to the middle of each n-th of it), scaled to at most 768 px wide, written as
 *                           01.jpg… into `out`. Not keyframes: evenly spaced is what shows a video's course.
 *
 * Transcription is not here: it is to come from a shared platform service (docs/design.md §11), not from
 * something each computer installs and keeps up to date itself.
 */

export const MAX_FRAMES = 16;

/** The frames script: frames of `path` into the directory `out` (a shell word, e.g. `"$HOME/.jobs/7.frames"`). */
export function framesCommand(path: string, n: number, out: string): string {
  return [
    "set -e",
    `p=${shq(path)}`,
    resolvePath("p"),
    `out=${out}`,
    `n=${n}`,
    `[ -f "$p" ] || { echo "no such file: $p" >&2; exit 2; }`,
    'rm -rf "$out"; mkdir -p "$out"',
    'dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$p")',
    '[ -n "$dur" ] || { echo "ffprobe could not read the length of $p" >&2; exit 3; }',
    'echo "duration: ${dur}s"',
    "i=0",
    'while [ "$i" -lt "$n" ]; do',
    '  t=$(awk -v d="$dur" -v i="$i" -v n="$n" \'BEGIN { printf "%.3f", d * (i + 0.5) / n }\')',
    '  f="$out/$(printf %02d $((i + 1))).jpg"',
    '  ffmpeg -v error -y -ss "$t" -i "$p" -frames:v 1 -vf "scale=\'min(768,iw)\':-2" -q:v 4 "$f"',
    '  echo "frame $((i + 1)) at ${t}s"',
    "  i=$((i + 1))",
    "done",
  ].join("\n");
}
