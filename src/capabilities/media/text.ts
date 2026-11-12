import type { Probe, Subs } from "../../porchkit/client.ts";
import { parseTime, timeLabel } from "../computer/media.ts";

/**
 * What video_probe and video_subs return: compact text, never porchkit's JSON. A probe is a few lines; a
 * subtitle track is cut at `SUBS_MAX_CHARS`, saying where and how to read on (`from` / `to`, applied here to
 * the `[mm:ss]` lines porchkit sends: its subtitles endpoint has no window, and its answer is cached, so a
 * second page costs nothing upstream).
 */

export const MAX_CHAPTERS = 40;
export const SUBS_MAX_CHARS = 12_000;

const date = (d: string | null | undefined) => (d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : d || undefined);

const LIVE: Record<string, string> = { is_live: "live now", is_upcoming: "upcoming (not started yet)", was_live: "a recorded live stream", post_live: "a live stream that just ended (still processing)" };

/** A probe as the model reads it. */
export function probeText(p: Probe): string {
  const lines: string[] = [];
  lines.push(`Title: ${p.title?.trim() || "(untitled)"}`);
  const by = [p.uploader ? `${p.uploader}${p.uploader_id && p.uploader_id !== p.uploader ? ` (${p.uploader_id})` : ""}` : p.uploader_id, date(p.upload_date) && `uploaded ${date(p.upload_date)}`, p.extractor].filter(Boolean);
  if (by.length) lines.push(`By: ${by.join(" · ")}`);
  const len = [
    typeof p.duration === "number" ? `${timeLabel(p.duration)} (${Math.round(p.duration)}s)` : "length unknown",
    p.width && p.height ? `${p.width}x${p.height}` : undefined,
    p.language ? `language ${p.language}` : undefined,
    p.live_status && LIVE[p.live_status],
  ].filter(Boolean);
  lines.push(`Length: ${len.join(" · ")}`);
  const ch = p.chapters ?? [];
  if (ch.length) {
    const shown = ch.slice(0, MAX_CHAPTERS).map((c) => `  ${timeLabel(c.start)} ${c.title}`);
    lines.push(`Chapters (${ch.length}):`, ...shown, ...(ch.length > MAX_CHAPTERS ? [`  …and ${ch.length - MAX_CHAPTERS} more`] : []));
  }
  const subs = p.subtitles ?? [];
  const auto = p.auto_captions ?? [];
  const t = p.auto_caption_translations ?? 0;
  lines.push(
    `Subtitles: ${subs.length ? subs.join(", ") : "none"}; automatic captions: ${auto.length ? auto.join(", ") : "none"}${t ? ` (and ${t} machine translations, by name)` : ""}${subs.length || auto.length ? " — video_subs reads them" : ""}`,
  );
  const heights = p.formats?.video_heights ?? [];
  const extra = [p.storyboard?.available ? "storyboard previews (quick sheets)" : undefined, heights.length ? `video up to ${Math.max(...heights)}p` : undefined, p.formats?.audio === false ? "no audio" : undefined].filter(Boolean);
  if (extra.length) lines.push(`Has: ${extra.join(" · ")}`);
  return lines.join("\n");
}

/**
 * What a prewarm keeps of a probe (media_prewarms.result, for an hour): exactly what `probeText` reads, and
 * so no URL (not `canonical_url`, not porchkit's `id`). The title, uploader and chapters stay, which is what
 * a joined `video_probe` answers with.
 */
export function storedProbe(p: Probe): Probe {
  return {
    id: "",
    ...(p.title != null ? { title: p.title } : {}),
    ...(p.uploader != null ? { uploader: p.uploader } : {}),
    ...(p.uploader_id != null ? { uploader_id: p.uploader_id } : {}),
    ...(p.upload_date != null ? { upload_date: p.upload_date } : {}),
    ...(p.extractor ? { extractor: p.extractor } : {}),
    ...(p.duration != null ? { duration: p.duration } : {}),
    ...(p.width != null ? { width: p.width } : {}),
    ...(p.height != null ? { height: p.height } : {}),
    ...(p.language != null ? { language: p.language } : {}),
    ...(p.live_status != null ? { live_status: p.live_status } : {}),
    chapters: (p.chapters ?? []).map((c) => ({ start: c.start, title: c.title })),
    subtitles: p.subtitles ?? [],
    auto_captions: p.auto_captions ?? [],
    auto_caption_translations: p.auto_caption_translations ?? 0,
    storyboard: { available: !!p.storyboard?.available },
    formats: { video_heights: p.formats?.video_heights ?? [], ...(p.formats?.audio !== undefined ? { audio: p.formats.audio } : {}) },
  };
}

export type SubsPage = { ok: true; text: string } | { ok: false; error: string };

/** The `[mm:ss]` / `[h:mm:ss]` time a subtitle line starts at, in seconds. */
function lineTime(line: string): number | undefined {
  const m = line.match(/^\[(\d+(?::\d{1,2}){1,2}(?:\.\d+)?)\]/);
  return m ? parseTime(m[1]!) : undefined;
}

/** A track as the model reads it: a header, the lines in the window, cut at `max` characters with how to go on. */
export function subsText(s: Subs, a: { from?: number | string; to?: number | string }, max = SUBS_MAX_CHARS): SubsPage {
  const from = a.from !== undefined ? parseTime(a.from) : undefined;
  const to = a.to !== undefined ? parseTime(a.to) : undefined;
  if (a.from !== undefined && from === undefined) return { ok: false, error: `from is not a time: ${JSON.stringify(a.from)}. Use seconds, mm:ss or hh:mm:ss.` };
  if (a.to !== undefined && to === undefined) return { ok: false, error: `to is not a time: ${JSON.stringify(a.to)}. Use seconds, mm:ss or hh:mm:ss.` };
  if (from !== undefined && to !== undefined && to <= from) return { ok: false, error: `The window is empty: to (${timeLabel(to)}) must be after from (${timeLabel(from)}).` };
  const all = s.text.split("\n").filter((l) => l.trim());
  const inWindow = all.filter((l) => {
    const t = lineTime(l);
    if (t === undefined) return true;
    return (from === undefined || t >= from) && (to === undefined || t < to);
  });
  const kind = s.kind === "manual" ? "subtitles" : s.kind === "auto" || s.kind === "automatic" ? "automatic captions" : s.kind;
  const window = from !== undefined || to !== undefined ? `, ${from !== undefined ? timeLabel(from) : "start"}–${to !== undefined ? timeLabel(to) : "end"}` : "";
  const head = `${kind} (${s.lang}), ${s.lines} line(s)${window}:`;
  // Nothing at all is not the same as nothing in the window asked for: only a window can exclude lines.
  if (!all.length) return { ok: true, text: `${kind} (${s.lang}): this video's subtitles are empty.` };
  if (!inWindow.length) return { ok: true, text: `${head}\n(no lines in this window)` };
  const out: string[] = [];
  let used = head.length;
  let cut: string | undefined;
  for (const l of inWindow) {
    if (used + l.length + 1 > max && out.length) {
      cut = l;
      break;
    }
    out.push(l);
    used += l.length + 1;
  }
  if (!cut) return { ok: true, text: `${head}\n${out.join("\n")}` };
  const next = lineTime(cut);
  const more = next !== undefined ? `call video_subs again with from: "${timeLabel(next)}"${to !== undefined ? ` (and the same to)` : ""} to read on` : "the rest did not fit";
  return { ok: true, text: `${head}\n${out.join("\n")}\n…(cut here at ${max} characters, ${inWindow.length - out.length} more line(s); ${more})` };
}
