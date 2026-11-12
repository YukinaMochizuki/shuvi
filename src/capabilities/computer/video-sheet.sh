#!/bin/bash
# video-sheet.sh: contact sheets of a video, each frame's timestamp burned in under it.
#
#   video-sheet.sh [--every SEC | --count N | --scene THRESHOLD] [--from T] [--to T]
#                  [--cols C] [--rows R] [--max N] [--edge PX] VIDEO OUTDIR
#
# Self-contained: it needs bash, awk, ffmpeg and ffprobe (with drawtext, so libfreetype and a font through
# fontconfig) and nothing of shuvi's, so the same script can run anywhere those are. T is seconds or
# mm:ss / hh:mm:ss. The spacing is one of:
#
#   --every SEC        a frame every SEC seconds from the window's start;
#   --count N          N frames spread evenly (each at the middle of its N-th of the window);
#   --scene THRESHOLD  a frame at the window's start and at each scene change (ffmpeg's scene score above
#                      THRESHOLD, 0..1), at most --max of them. This one decodes the window once, scaled
#                      down; the others never decode more than a short stretch per frame.
#
# none of them: --count chosen from the window's length. More frames than --max (default 64) is an error
# that says how to narrow the request. Every frame is one ffmpeg call with input seeking (-ss before -i),
# scaled to its tile and labelled; then each sheet is one ffmpeg `tile` over its frames. A sheet is
# C×R tiles (default 4×4; the last sheet has only the rows it needs), each tile keeping the video's aspect
# ratio, its long edge at most --edge px (default 1536), JPEG at quality 2 (-q:v, 2 best .. 31), so text in
# frames stays readable.
#
# Into OUTDIR (emptied first): sheet-01.jpg, sheet-02.jpg, … and index.txt, which is also printed: the
# duration, the resolution, and one line per sheet with its frames' times. Exit 2: no such file or bad
# arguments; 3: not a video ffprobe can read; 4: over --max; 5: ffmpeg failed.
set -euo pipefail

die() { echo "$2" >&2; exit "$1"; }

# Seconds from seconds, mm:ss or hh:mm:ss.
secs() {
  awk -v s="$1" 'BEGIN {
    n = split(s, p, ":"); if (n < 1 || n > 3) exit 1
    t = 0; for (i = 1; i <= n; i++) { if (p[i] !~ /^[0-9]+(\.[0-9]+)?$/) exit 1; t = t * 60 + p[i] }
    printf "%.3f", t }' || die 2 "not a time: $1 (seconds, mm:ss or hh:mm:ss)"
}
# A label: mm:ss, h:mm:ss past an hour; with a tenth (mm:ss.s) when $2 is 1.
label() {
  awk -v t="$1" -v d="$2" 'BEGIN {
    if (d) { t = int(t * 10 + 0.5) / 10 } else { t = int(t + 0.5) }
    h = int(t / 3600); m = int((t - h * 3600) / 60); s = t - h * 3600 - m * 60
    f = d ? "%04.1f" : "%02d"
    if (h > 0) printf("%d:%02d:" f, h, m, s); else printf("%02d:" f, m, s) }'
}
calc() { awk "BEGIN { printf \"%s\", $1 }"; }

mode="" every="" count="" scene="" from="" to="" cols=4 rows=4 max=64 edge=1536
while [ $# -gt 2 ]; do
  case "$1" in
    --every) mode="${mode}every"; every="$2" ;;
    --count) mode="${mode}count"; count="$2" ;;
    --scene) mode="${mode}scene"; scene="$2" ;;
    --from) from="$2" ;;
    --to) to="$2" ;;
    --cols) cols="$2" ;;
    --rows) rows="$2" ;;
    --max) max="$2" ;;
    --edge) edge="$2" ;;
    *) die 2 "unknown option: $1" ;;
  esac
  shift 2
done
[ $# -eq 2 ] || die 2 "usage: video-sheet.sh [--every SEC | --count N | --scene T] [--from T] [--to T] [--cols C] [--rows R] [--max N] VIDEO OUTDIR"
video="$1" out="$2"
case "$mode" in ""|every|count|scene) ;; *) die 2 "give at most one of --every, --count and --scene" ;; esac
for v in "$cols" "$rows" "$max" "$edge" ${count:+"$count"}; do [[ "$v" =~ ^[1-9][0-9]*$ ]] || die 2 "not a positive whole number: $v"; done
if [ -n "$every" ]; then [[ "$every" =~ ^[0-9]*\.?[0-9]+$ ]] && [ "$(calc "($every > 0) ? 1 : 0")" = 1 ] || die 2 "--every must be a positive number of seconds"; fi
if [ -n "$scene" ]; then [[ "$scene" =~ ^[0-9]*\.?[0-9]+$ ]] && [ "$(calc "($scene > 0 && $scene < 1) ? 1 : 0")" = 1 ] || die 2 "--scene must be a threshold between 0 and 1"; fi
[ -f "$video" ] || die 2 "no such file: $video"

# ---- the video -----------------------------------------------------------------------------------
probe=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,sample_aspect_ratio:stream_side_data=rotation:format=duration -of default=nw=1 "$video" 2>&1) || die 3 "ffprobe could not read $video: $probe"
get() { awk -F= -v k="$1" '$1 == k { print $2; exit }' <<< "$probe"; }
w=$(get width) h=$(get height) dur=$(get duration) sar=$(get sample_aspect_ratio) rot=$(get rotation)
[[ "$w" =~ ^[0-9]+$ && "$h" =~ ^[0-9]+$ && "$w" -gt 0 && "$h" -gt 0 ]] || die 3 "$video has no video stream"
[[ "$dur" =~ ^[0-9.]+$ ]] || die 3 "ffprobe could not read the length of $video"
# What a viewer sees: the sample aspect ratio applied, and a quarter turn swapping width and height.
if [[ "$sar" =~ ^([0-9]+):([0-9]+)$ ]] && [ "${BASH_REMATCH[1]}" != 0 ] && [ "${BASH_REMATCH[2]}" != 0 ]; then
  w=$(calc "int($w * ${BASH_REMATCH[1]} / ${BASH_REMATCH[2]} + 0.5)")
fi
case "${rot#-}" in 90|270) t=$w; w=$h; h=$t ;; esac

lo=0 hi=$dur
[ -z "$from" ] || lo=$(secs "$from")
[ -z "$to" ] || hi=$(secs "$to")
[ "$(calc "($hi > $dur) ? 1 : 0")" = 0 ] || hi=$dur
[ "$(calc "($lo < $hi) ? 1 : 0")" = 1 ] || die 2 "the window is empty: from $(label "$lo" 0) to $(label "$hi" 0) of a $(label "$dur" 0) video"
span=$(calc "$hi - $lo")

# ---- the frames' times ---------------------------------------------------------------------------
times=()
case "$mode" in
  every)
    n=$(calc "int(($span - 0.0005) / $every) + 1")
    [ "$n" -le "$max" ] || die 4 "every ${every}s over $(label "$span" 0) is $n frames, more than $max. Use a larger every (at least $(calc "int($span / $max * 10 + 0.999) / 10")s here), or a window (from/to) around the part you want."
    for ((i = 0; i < n; i++)); do times+=("$(calc "$lo + $i * $every")"); done ;;
  scene)
    # Scaled down first: the score does not need detail, and decoding at full size is what costs.
    found=$(ffmpeg -nostdin -v info -hide_banner -ss "$lo" -to "$hi" -i "$video" -an -sn -dn \
      -vf "scale=320:-2,select='gt(scene,$scene)',showinfo" -f null - 2>&1 | awk -F'pts_time:' '/showinfo.*pts_time:/ { split($2, a, " "); print a[1] }') || true
    times+=("$lo")
    total=0
    while read -r t; do
      [ -n "$t" ] || continue
      t=$(calc "$lo + $t")
      # A cut right at the window's start is the frame already taken.
      [ "$(calc "($t - ${times[-1]} >= 0.2) ? 1 : 0")" = 1 ] || continue
      total=$((total + 1))
      if [ "${#times[@]}" -lt "$max" ]; then times+=("$t"); fi
    done <<< "$found" ;;
  *)
    if [ -z "$count" ]; then
      # 16 for a short clip (fewer under 4 s: four a second), more for a long one: 32 at ten minutes, then
      # one more every two minutes, up to --max.
      count=$(calc "int($span < 4 ? $span * 4 : ($span <= 120 ? 16 : ($span <= 600 ? 16 + ($span - 120) / 30 : 32 + ($span - 600) / 120)))")
      [ "$count" -ge 1 ] || count=1
      [ "$count" -le "$max" ] || count=$max
    fi
    [ "$count" -le "$max" ] || die 4 "count $count is more than $max frames. Ask for fewer, or sheet a window (from/to) at a time."
    for ((i = 0; i < count; i++)); do times+=("$(calc "$lo + $span * ($i + 0.5) / $count")"); done ;;
esac
n=${#times[@]}

# Tenths in the labels when frames are less than a second apart.
tenths=0
for ((i = 1; i < n; i++)); do
  if [ "$(calc "(${times[i]} - ${times[i - 1]} < 1) ? 1 : 0")" = 1 ]; then tenths=1; break; fi
done

# ---- the layout ----------------------------------------------------------------------------------
[ "$n" -ge "$cols" ] || cols=$n
per=$((cols * rows))
sheets=$(((n + per - 1) / per))
[ "$sheets" -gt 1 ] || rows=$(((n + cols - 1) / cols))
gap=4
# The label strip under each tile, and its text, scaled with the tile but never too small to read.
fit_w=$(calc "int(($edge - ($cols + 1) * $gap) / $cols)")
tw=$((fit_w < w ? fit_w : w))
th=$(calc "int($tw * $h / $w)")
lab=$(calc "int($tw / 9) < 22 ? 22 : (int($tw / 9) > 40 ? 40 : int($tw / 9))")
sheet_h=$(calc "$rows * ($th + $lab) + ($rows + 1) * $gap")
if [ "$sheet_h" -gt "$edge" ]; then
  th=$(calc "int(($edge - ($rows + 1) * $gap) / $rows) - $lab")
  tw=$(calc "int($th * $w / $h)")
fi
tw=$((tw / 2 * 2)) th=$((th / 2 * 2))
[ "$tw" -ge 16 ] && [ "$th" -ge 16 ] || die 2 "a ${cols}x${rows} grid leaves tiles too small for this video; use a smaller grid"
fs=$(calc "int($lab * 0.72)")
font=""
for f in /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf; do
  [ -f "$f" ] && { font="fontfile=$f:"; break; }
done

rm -rf "$out"; mkdir -p "$out/.tiles"
for ((i = 0; i < n; i++)); do
  t=${times[i]}
  text=$(label "$t" "$tenths")
  vf="scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,pad=iw:ih+${lab}:0:0:color=black,drawtext=${font}expansion=none:text='${text//:/\\:}':fontsize=${fs}:fontcolor=white:x=(w-text_w)/2:y=h-${lab}+(${lab}-${fs})/2"
  f="$out/.tiles/$(printf %03d "$i").png"
  # Seeking right at the end can land past the last frame: step back a little until one comes out.
  for back in 0 0.5 1.5 3; do
    s=$(calc "($t - $back < 0) ? 0 : $t - $back")
    ffmpeg -nostdin -v error -y -ss "$s" -i "$video" -frames:v 1 -an -sn -dn -vf "$vf" "$f" 2>"$out/.tiles/err" || true
    if [ -s "$f" ]; then break; fi
  done
  [ -s "$f" ] || die 5 "ffmpeg could not take the frame at $text: $(head -c 500 "$out/.tiles/err")"
done

# ---- the sheets and the index --------------------------------------------------------------------
{
  printf 'video: %s · %s (%.1fs) · %sx%s\n' "$(basename "$video")" "$(label "$dur" 0)" "$dur" "$w" "$h"
  if [ "$(calc "($lo > 0 || $hi < $dur) ? 1 : 0")" = 1 ]; then
    printf 'window: %s to %s\n' "$(label "$lo" "$tenths")" "$(label "$hi" "$tenths")"
  fi
  case "$mode" in
    every) how="every ${every}s" ;;
    scene)
      how="the start and each scene change (threshold $scene): $total change(s) found"
      if [ "$total" -ge "$max" ]; then how="$how, the first $((max - 1)) shown; narrow it with a window (from/to)"; fi ;;
    *) how="spread evenly" ;;
  esac
  printf '%d frame(s), %s, on %d sheet(s) of %dx%d:\n' "$n" "$how" "$sheets" "$cols" "$rows"
} > "$out/index.txt"
for ((k = 0; k < sheets; k++)); do
  first=$((k * per)) m=$((n - k * per)); [ "$m" -le "$per" ] || m=$per
  r=$(((m + cols - 1) / cols))
  name=$(printf 'sheet-%02d.jpg' $((k + 1)))
  ffmpeg -nostdin -v error -y -start_number "$first" -i "$out/.tiles/%03d.png" -frames:v 1 \
    -vf "tile=${cols}x${r}:nb_frames=${m}:padding=${gap}:margin=${gap}:color=0x202020" -q:v 2 "$out/$name" 2>"$out/.tiles/err" \
    || die 5 "ffmpeg could not make $name: $(head -c 500 "$out/.tiles/err")"
  line=""
  for ((i = first; i < first + m; i++)); do line="$line $(label "${times[i]}" "$tenths")"; done
  printf '%s:%s\n' "$name" "$line" >> "$out/index.txt"
done
rm -rf "$out/.tiles"
cat "$out/index.txt"
