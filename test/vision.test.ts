import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PromptPart } from "agent-runtime";
import { Api } from "grammy";
import { renderMidTurn, renderTurnInput } from "../src/agent/render.ts";
import { runTurn } from "../src/agent/turn.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import { capabilityPerception, type EnabledCapability } from "../src/capabilities/types.ts";
import { downloadPass, MAX_ATTEMPTS } from "../src/capabilities/vision/download.ts";
import { sniffImage } from "../src/store/media.ts";
import { recordBatch } from "../src/server/poller.ts";
import { wakerPass } from "../src/server/waker.ts";
import type { Db } from "../src/store/db.ts";
import { getEvent, triggersAfter, type MessageMedia, type MessagePayload } from "../src/store/events.ts";
import { claimTurn, getTurn } from "../src/store/turns.ts";
import { telegramFiles } from "../src/telegram/files.ts";
import { classify, mediaOf, PHOTO_MAX_SIDE } from "../src/telegram/inbound.ts";
import { dmUpdate, FakeTelegram, memDb, OWNER, ownerChatId, ownerSays, ScriptedAdapter, type Step } from "./helpers.ts";

// A valid 1x1 PNG, and the start of a WebP (the signature is all the download checks).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);

let tg: FakeTelegram | null = null;
afterEach(() => {
  tg?.stop();
  tg = null;
});

const dataDir = () => mkdtempSync(join(tmpdir(), "shuvi-data-"));
const visionOn = (dir: string, waitMs = 5000): EnabledCapability[] => enabledCapabilities({ SHUVI_DATA_DIR: dir, SHUVI_WEB: "off", SHUVI_VISION_WAIT_MS: String(waitMs) });
const mediaAt = (db: Db, seq: number): MessageMedia => (getEvent(db, seq)!.payload as unknown as MessagePayload).media!;

const photoUpdate = (id: number, caption?: string) =>
  dmUpdate(id, undefined as never, OWNER, {
    text: undefined,
    ...(caption ? { caption } : {}),
    photo: [
      { file_id: "p-s", file_unique_id: "ps", width: 90, height: 68 },
      { file_id: "p-m", file_unique_id: "pm", width: 1280, height: 960 },
      { file_id: "p-l", file_unique_id: "pl", width: 2560, height: 1920 },
    ],
  });
const stickerUpdate = (id: number, extra: Record<string, unknown> = {}) =>
  dmUpdate(id, undefined as never, OWNER, { text: undefined, sticker: { file_id: "st", file_unique_id: "stu", emoji: "😳", set_name: "Girl", is_animated: false, is_video: false, width: 512, height: 512, ...extra } });

describe("which file a message shows", () => {
  test(`a photo: the largest size whose longer side is at most ${PHOTO_MAX_SIDE} px; identity is the photo's own`, () => {
    const c = classify(photoUpdate(1, "front side?"), OWNER);
    expect(c).toMatchObject({ kind: "message", payload: { text: "[photo] front side?", placeholder: true } });
    expect((c as { payload: MessagePayload }).payload.media).toEqual({ kind: "photo", fileUniqueId: "pl", file: { fileId: "p-m", fileUniqueId: "pm" }, state: "pending" });
  });

  test("a static sticker is itself; an animated or video sticker is its thumbnail; one with no thumbnail has nothing to fetch", () => {
    expect(mediaOf(stickerUpdate(1).message!)).toEqual({ kind: "sticker", fileUniqueId: "stu", file: { fileId: "st", fileUniqueId: "stu" }, state: "pending" });
    const thumb = { file_id: "th", file_unique_id: "thu", width: 128, height: 128 };
    for (const kind of [{ is_animated: true }, { is_video: true }]) {
      expect(mediaOf(stickerUpdate(1, { ...kind, thumbnail: thumb }).message!)).toEqual({
        kind: "sticker",
        fileUniqueId: "stu",
        file: { fileId: "th", fileUniqueId: "thu", thumbnail: true },
        state: "pending",
      });
    }
    expect(mediaOf(stickerUpdate(1, { is_animated: true }).message!)).toMatchObject({ file: null, state: "none" });
  });

  test("the sticker's placeholder stays in its text, so the emoji and pack are known", () => {
    expect(classify(stickerUpdate(1), OWNER)).toMatchObject({ payload: { text: "[sticker: 😳, Girl]", media: { kind: "sticker" } } });
  });

  test("a voice note or a document has no media: it stays a placeholder", () => {
    expect((classify(dmUpdate(1, undefined as never, OWNER, { text: undefined, voice: { file_id: "v", file_unique_id: "vu", duration: 3 } }), OWNER) as { payload: MessagePayload }).payload.media).toBeUndefined();
  });
});

describe("downloading (the server's vision loop)", () => {
  const setup = () => {
    tg = new FakeTelegram();
    const db = memDb();
    const files = telegramFiles(new Api("TOKEN", { apiRoot: tg.apiRoot }), "TOKEN", tg.apiRoot);
    return { db, files, fake: tg };
  };

  test("fetches with getFile and the file endpoint into media/<file_unique_id>, and completes the message's media", async () => {
    const { db, files, fake } = setup();
    fake.files.set("p-m", PNG);
    recordBatch(db, [photoUpdate(1)], OWNER);
    const seq = triggersAfter(db, ownerChatId(db), 0)[0]!.seq;
    const dir = dataDir();
    expect(await downloadPass(db, files, dir)).toBe(1);
    expect(mediaAt(db, seq)).toMatchObject({ state: "ready", path: "media/pm", mimeType: "image/png" });
    expect(existsSync(join(dir, "media/pm"))).toBe(true);
    expect(fake.sent("getFile")).toEqual([{ file_id: "p-m" }]);
    expect(readdirSync(join(dir, "media"))).toEqual(["pm"]); // no temporary file left behind
  });

  test("deduplicated by file_unique_id: the same sticker sent twice is downloaded once, and a file already there is never fetched", async () => {
    const { db, files, fake } = setup();
    fake.files.set("st", WEBP);
    recordBatch(db, [stickerUpdate(1), stickerUpdate(2)], OWNER);
    const dir = dataDir();
    expect(await downloadPass(db, files, dir)).toBe(2);
    expect(fake.downloads.get("st")).toBe(1);
    for (const e of triggersAfter(db, ownerChatId(db), 0)) expect(mediaAt(db, e.seq)).toMatchObject({ state: "ready", path: "media/stu", mimeType: "image/webp" });
    recordBatch(db, [stickerUpdate(3)], OWNER);
    await downloadPass(db, files, dir);
    expect(fake.downloads.get("st")).toBe(1);
    expect(fake.sent("getFile")).toHaveLength(1);
  });

  test(`a failing download is retried, then given up after ${MAX_ATTEMPTS} attempts; nothing else is held up by it`, async () => {
    const { db, files, fake } = setup();
    fake.files.set("st", WEBP);
    recordBatch(db, [photoUpdate(1), stickerUpdate(2)], OWNER); // p-m is not served: getFile fails
    const [photo, sticker] = triggersAfter(db, ownerChatId(db), 0);
    const dir = dataDir();
    await downloadPass(db, files, dir);
    expect(mediaAt(db, sticker!.seq).state).toBe("ready");
    expect(mediaAt(db, photo!.seq)).toMatchObject({ state: "pending", attempts: 1 });
    for (let i = 1; i < MAX_ATTEMPTS; i++) await downloadPass(db, files, dir);
    expect(mediaAt(db, photo!.seq)).toMatchObject({ state: "failed", attempts: MAX_ATTEMPTS });
    expect(mediaAt(db, photo!.seq).error).toContain("invalid file_id");
  });

  test("what is not an image the model can read is refused", async () => {
    const { db, files, fake } = setup();
    fake.files.set("p-m", new TextEncoder().encode("<html>nope</html>"));
    recordBatch(db, [photoUpdate(1)], OWNER);
    await downloadPass(db, files, dataDir());
    expect(mediaAt(db, triggersAfter(db, ownerChatId(db), 0)[0]!.seq).error).toContain("not an image");
    expect(sniffImage(PNG)).toBe("image/png");
  });
});

/** Record an owner photo whose download is in `state`, with its file in `dir` when ready. */
function ownerPhoto(db: Db, dir: string, state: MessageMedia["state"], text = "[photo] look"): number {
  if (state === "ready") {
    mkdirSync(join(dir, "media"), { recursive: true });
    writeFileSync(join(dir, "media/pm"), PNG);
  }
  const media: MessageMedia = { kind: "photo", fileUniqueId: "pl", file: { fileId: "p-m", fileUniqueId: "pm" }, state, ...(state === "ready" ? { path: "media/pm", mimeType: "image/png" } : {}) };
  return ownerSays(db, text, { placeholder: true, media });
}

describe("rendering into parts", () => {
  test("each message's line, then its image; the placeholder stays in the text; no image is still a plain string", () => {
    const db = memDb();
    const dir = dataDir();
    ownerSays(db, "hello");
    ownerPhoto(db, dir, "ready", "[sticker: 😳, Girl]");
    ownerSays(db, "what is it");
    const caps = visionOn(dir);
    const events = triggersAfter(db, ownerChatId(db), 0);
    const parts = renderTurnInput(events, "UTC", (e) => capabilityPerception(caps, e)) as PromptPart[];
    expect(parts.map((p) => p.type)).toEqual(["text", "image", "text"]);
    expect((parts[0] as { text: string }).text).toMatch(/\] hello\n\[#\d+ · .* · Owner\] \[sticker: 😳, Girl\]$/);
    expect(parts[1]).toEqual({ type: "image", data: PNG.toString("base64"), mimeType: "image/png" });
    expect((parts[2] as { text: string }).text).toContain("what is it");
    expect(typeof renderTurnInput(events, "UTC")).toBe("string");
    const mid = renderMidTurn(events.slice(1, 2), "UTC", (e) => capabilityPerception(caps, e)) as PromptPart[];
    expect(mid.map((p) => p.type)).toEqual(["text", "image"]);
    expect((mid[0] as { text: string }).text).toStartWith("(New messages arrived while you were working:)\n");
  });

  test("a picture that is not ready, or whose file is gone, is shown by its placeholder alone", () => {
    const db = memDb();
    const dir = dataDir();
    ownerPhoto(db, dir, "pending");
    ownerPhoto(db, dir, "failed");
    const caps = visionOn(dir);
    const events = triggersAfter(db, ownerChatId(db), 0);
    expect(typeof renderTurnInput(events, "UTC", (e) => capabilityPerception(caps, e))).toBe("string");
    const seq = ownerPhoto(db, dir, "ready");
    const other = mkdtempSync(join(tmpdir(), "shuvi-moved-"));
    expect(capabilityPerception(visionOn(other), getEvent(db, seq)!)).toEqual([]);
  });

  test("with vision off, nothing is perceived", () => {
    const db = memDb();
    const dir = dataDir();
    const seq = ownerPhoto(db, dir, "ready");
    expect(capabilityPerception(enabledCapabilities({ SHUVI_VISION: "off", SHUVI_DATA_DIR: dir }), getEvent(db, seq)!)).toEqual([]);
  });
});

describe("perception gating", () => {
  const spawned = () => {
    const pids: number[] = [];
    return { pids, spawn: (id: number) => (pids.push(id), 4242) };
  };
  const at = (db: Db, seq: number) => Date.parse(getEvent(db, seq)!.at);

  test("the waker opens no turn while a picture downloads, then opens it once ready", () => {
    const db = memDb();
    const dir = dataDir();
    const seq = ownerPhoto(db, dir, "pending");
    const caps = visionOn(dir);
    const s = spawned();
    expect(wakerPass({ db, spawn: s.spawn, capabilities: caps, now: () => at(db, seq) + 1000 }).started).toEqual([]);
    db.$client.exec(`update chat_events set payload = json_set(payload, '$.media.state', 'ready') where seq = ${seq}`);
    expect(wakerPass({ db, spawn: s.spawn, capabilities: caps, now: () => at(db, seq) + 1000 }).started).toHaveLength(1);
  });

  test("it waits a few seconds at most, then the turn opens with the placeholder", () => {
    const db = memDb();
    const dir = dataDir();
    const seq = ownerPhoto(db, dir, "pending");
    const s = spawned();
    expect(wakerPass({ db, spawn: s.spawn, capabilities: visionOn(dir, 3000), now: () => at(db, seq) + 3001 }).started).toHaveLength(1);
  });

  test("with vision off nothing is held", () => {
    const db = memDb();
    const dir = dataDir();
    const seq = ownerPhoto(db, dir, "pending");
    expect(wakerPass({ db, spawn: spawned().spawn, capabilities: enabledCapabilities({ SHUVI_VISION: "off" }), now: () => at(db, seq) }).started).toHaveLength(1);
  });
});

describe("a turn that sees", () => {
  async function turnWith(db: Db, dir: string, script: Step[], waitMs = 60_000) {
    const turn = claimTurn(db, ownerChatId(db))!;
    let adapter!: ScriptedAdapter;
    const outcome = await runTurn({ db, turnId: turn.id, home: dir, timeZone: "UTC", capabilities: visionOn(dir, waitMs), makeAdapter: (b) => (adapter = new ScriptedAdapter(b, script)) });
    return { outcome, adapter, turn: getTurn(db, turn.id)! };
  }

  test("its input carries the photo as an image part after the message's line", async () => {
    const db = memDb();
    const dir = dataDir();
    ownerPhoto(db, dir, "ready", "[photo] what is this");
    const { outcome, adapter } = await turnWith(db, dir, [{ token: "a fox" }]);
    expect(outcome).toBe("done");
    const prompt = adapter.calls[0]!.prompt as PromptPart[];
    expect(prompt.map((p) => p.type)).toEqual(["text", "image"]);
    expect((prompt[0] as { text: string }).text).toContain("[photo] what is this");
  });

  test("a photo that arrives mid-turn is appended with its image, after the tool's own result", async () => {
    const db = memDb();
    const dir = dataDir();
    ownerSays(db, "look at what I send next");
    const { adapter, turn } = await turnWith(db, dir, [{ run: () => void ownerPhoto(db, dir, "ready", "[photo] this one") }, { tool: "say", args: { text: "looking" } }, { token: "nice" }]);
    const content = adapter.toolResults[0]!.result.content;
    expect(content.map((c) => c.type)).toEqual(["text", "text", "image"]);
    expect(content[0]).toEqual({ type: "text", text: "Sent." });
    expect((content[1] as { text: string }).text).toContain("[photo] this one");
    expect(turn.toSeq).toBe(triggersAfter(db, ownerChatId(db), 0).at(-1)!.seq);
  });

  test("a mid-turn photo still downloading is not taken in yet, nor anything after it; the next turn gets them", async () => {
    const db = memDb();
    const dir = dataDir();
    const first = ownerSays(db, "hi");
    const { adapter, turn } = await turnWith(db, dir, [{ run: () => (ownerPhoto(db, dir, "pending"), void ownerSays(db, "and this")) }, { tool: "say", args: { text: "one sec" } }, { token: "ok" }]);
    expect(adapter.toolResults[0]!.result.content).toEqual([{ type: "text", text: "Sent." }]);
    expect(turn.toSeq).toBe(first);
    expect(triggersAfter(db, ownerChatId(db), turn.toSeq)).toHaveLength(2);
  });
});
