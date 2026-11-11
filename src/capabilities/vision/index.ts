import type { ToolContent } from "agent-runtime";
import { dataDirFrom } from "../../env.ts";
import { imageFromFile, mediaOfEvent } from "../../store/media.ts";
import { defineCapability } from "../types.ts";
import { downloadPass } from "./download.ts";

/**
 * Vision: the assistant sees the photos and stickers it is sent (docs/design.md §11), as images beside
 * their line, both in a turn's input and in what is appended mid-turn. The line keeps its placeholder
 * ("[sticker: 😳, Pack]"), so the emoji and the pack are known too.
 *
 *   SHUVI_VISION          "off" disables it: photos and stickers stay placeholders, nothing is downloaded
 *   SHUVI_VISION_WAIT_MS  how long a turn waits for a picture still downloading (default 5000); past it the
 *                         message is shown with its placeholder alone
 *
 * What it brings:
 *   - a server loop downloading each message's picture (download.ts), with the server's read-only file
 *     downloader: a runner child never has the bot token;
 *   - perception gating (`holds`): a message whose picture is still downloading opens no turn and is not
 *     appended yet, for at most SHUVI_VISION_WAIT_MS after it arrived;
 *   - `perceive`: the downloaded picture, read from the data dir, as an image part after the line.
 *
 * Which file is fetched for a message (photo size, sticker, thumbnail) is decided when the message is
 * recorded (telegram/inbound.ts `mediaOf`). Media is never pruned from `chat_events`; only the model's own
 * context is compacted, by the runtime.
 */

export interface VisionConfig {
  dataDir: string;
  waitMs: number;
}

export const DEFAULT_WAIT_MS = 5_000;

export const vision = defineCapability<VisionConfig>({
  id: "vision",
  label: "seeing photos and stickers",
  gives: "the photos and stickers people send, shown to her as images.",
  enable: (env) => {
    if (env.SHUVI_VISION === "off") return null;
    const wait = Number(env.SHUVI_VISION_WAIT_MS);
    return { dataDir: dataDirFrom(env), waitMs: Number.isFinite(wait) && env.SHUVI_VISION_WAIT_MS ? wait : DEFAULT_WAIT_MS };
  },
  loops: ({ db, files }, { dataDir }) => [{ name: "vision-download", everyMs: 500, run: async () => void (await downloadPass(db, files, dataDir)) }],
  holds(event, now, { waitMs }) {
    return mediaOfEvent(event)?.state === "pending" && now - Date.parse(event.at) < waitMs;
  },
  perceive(event, { dataDir }): ToolContent[] {
    const m = mediaOfEvent(event);
    if (m?.state !== "ready" || !m.path) return [];
    try {
      return [imageFromFile(dataDir, m.path, m.mimeType ?? "image/jpeg")];
    } catch {
      return []; // the file is gone (a moved data dir): the placeholder still says what it was
    }
  },
});
