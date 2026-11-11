import { resolvePath, shq } from "./exec.ts";

/**
 * The framework's media tools (docs/design.md §11, §15) as prepared execs: the assistant names a file and
 * gets a result, and never assembles the commands. Each is a bash script run like any exec, in the
 * background by default (the base image, computer/Dockerfile, has what they need).
 *
 *   video_frames(path, n)   n evenly spaced frames of the video (ffprobe for its length, then one ffmpeg seek
 *                           to the middle of each n-th of it), scaled to at most 768 px wide, written as
 *                           01.jpg… into `out`. Not keyframes: evenly spaced is what shows a video's course.
 *   transcribe(path)        faster-whisper on the CPU (int8), each segment's text printed as it comes and
 *                           written to `<path>.txt`. Run boosted (SHUVI_COMPUTER_TRANSCRIBE_CPU / _MEMORY).
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

const WHISPER = `import sys
from faster_whisper import WhisperModel
path, out, model = sys.argv[1], sys.argv[2], sys.argv[3]
m = WhisperModel(model, device="cpu", compute_type="int8")
segments, info = m.transcribe(path, vad_filter=True)
print(f"[language: {info.language}, {info.language_probability:.2f}]", flush=True)
with open(out, "w") as f:
    for s in segments:
        line = s.text.strip()
        f.write(line + "\\n")
        f.flush()
        print(line, flush=True)
`;

/** The transcription script: `path` to `<path>.txt` with faster-whisper's `model`. */
export function transcribeCommand(path: string, model: string): string {
  return [
    "set -e",
    `p=${shq(path)}`,
    resolvePath("p"),
    `[ -f "$p" ] || { echo "no such file: $p" >&2; exit 2; }`,
    `python3 -c ${shq(WHISPER)} "$p" "$p.txt" ${shq(model)}`,
  ].join("\n");
}
