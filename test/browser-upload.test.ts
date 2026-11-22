import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textOf, type ToolResult } from "agent-runtime";
import { runTurn } from "../src/agent/turn.ts";
import { attachmentPass } from "../src/capabilities/browser/attachments.ts";
import { computerNames } from "../src/capabilities/computer/config.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import { parsePolicy, type Policy } from "../src/policy/policy.ts";
import { recordBatch } from "../src/server/poller.ts";
import type { Db } from "../src/store/db.ts";
import { allChats, kvGet, type MessageAttachment } from "../src/store/events.ts";
import { updateMedia } from "../src/store/media.ts";
import { claimTurn } from "../src/store/turns.ts";
import type { TelegramFiles } from "../src/telegram/files.ts";
import { FakeHangar } from "./fake-hangar.ts";
import { FakePorchkit, PROFILE } from "./fake-porchkit.ts";
import { groupUpdate, memDb, OWNER, ownerChatId, ownerSays, ScriptedAdapter, type Step } from "./helpers.ts";

const GROUP = -100444;
const ALICE = 2004;
const MB = 1024 * 1024;
const fakes: { stop(): void }[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) f.stop();
});

const home = () => {
  const h = mkdtempSync(join(tmpdir(), "shuvi-browser-upload-"));
  mkdirSync(join(h, "persona"));
  return h;
};
const policyOf = (text: string): Policy => {
  const r = parsePolicy(text, OWNER);
  if ("error" in r) throw new Error(r.error);
  return r.policy;
};
const text = (r: ToolResult) => textOf(r);

/** porchkit, a data dir, and (unless `computer: false`) a Hangar. */
function world(computer = true) {
  const p = new FakePorchkit();
  fakes.push(p);
  const dataDir = mkdtempSync(join(tmpdir(), "shuvi-upload-data-"));
  const base = { SHUVI_DATA_DIR: dataDir, SHUVI_WEB: "off", SHUVI_BROWSER_ATTACH_WAIT_SEC: "5", SHUVI_COMPUTER_READY_SEC: "5" };
  let env: Record<string, string> = p.env(base);
  let hangar: FakeHangar | undefined;
  if (computer) {
    hangar = new FakeHangar();
    fakes.push(hangar);
    env = { ...env, ...hangar.env(base) };
  }
  return { p, hangar, env, dataDir };
}

/** The server's side, as its loop would run it: Telegram's files, by file id. */
function serverFiles(db: Db, dataDir: string, files: Record<string, Uint8Array>): { downloads: string[]; stop: () => void } {
  const downloads: string[] = [];
  const tg = {
    async download(fileId: string) {
      downloads.push(fileId);
      const b = files[fileId];
      if (!b) throw new Error("Bad Request: invalid file_id");
      return b;
    },
  } as unknown as TelegramFiles;
  const t = setInterval(() => void attachmentPass(db, tg, dataDir), 30);
  return { downloads, stop: () => clearInterval(t) };
}

async function dmTurn(db: Db, env: Record<string, string>, script: Step[], policy?: Policy): Promise<ScriptedAdapter> {
  const turn = claimTurn(db, ownerChatId(db))!;
  let adapter!: ScriptedAdapter;
  await runTurn({ db, turnId: turn.id, home: home(), timeZone: "UTC", ownerId: OWNER, capabilities: enabledCapabilities(env), ...(policy ? { policy } : {}), makeAdapter: (b) => (adapter = new ScriptedAdapter(b, script)) });
  return adapter;
}

const attachment = (name: string, size: number, fileId = `f-${name}`): MessageAttachment => ({ kind: "document", fileId, fileUniqueId: `u-${name}`, name, size, mimeType: "application/octet-stream" });
const results = (a: ScriptedAdapter) => a.toolResults.map((x) => x.result);

describe("browser_upload: a file someone sent, or a download", () => {
  test("a sent photo, armed: the server fetches it, porchkit holds it, the next file chooser (\"Change photo\") gets it; the copy is gone after", async () => {
    const { p, env, dataDir } = world(false);
    const db = memDb();
    const photo = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
    const seq = ownerSays(db, "make this my profile photo", { attachment: { ...attachment("me.jpg", photo.length, "file-me"), kind: "photo" } });
    const server = serverFiles(db, dataDir, { "file-me": photo });
    try {
      const a = await dmTurn(db, env, [
        { tool: "browser_open", args: { url: PROFILE } },
        { tool: "browser_upload", args: { source: { message: seq } } },
        { tool: "browser_click", args: { ref: "e1" } },
        { tool: "pass" },
      ]);
      const r = results(a);
      expect(r.map((x) => x.isError ?? false)).toEqual([false, false, false, false]);
      expect(text(r[1]!)).toStartWith(`me.jpg (1 KB) is ready for the page's next file chooser: now click the page's own upload button (e.g. "Change photo", "Upload") with browser_click, and the chooser gets this file.\nURL: ${PROFILE}`);
      expect(text(r[1]!)).toContain("Note: the next file chooser gets: me.jpg");
      expect(text(r[2]!)).toContain("Note: file chooser: me.jpg (set)");
      const chat = ownerChatId(db);
      const held = p.browse.uploads.get(`chat-${chat}`)!;
      expect(held.map((u) => [u.name, [...u.bytes]])).toEqual([["me.jpg", [...photo]]]);
      expect(p.browse.chosen.get(`chat-${chat}`)).toEqual(["me.jpg"]);
      expect(p.of(`/browse/sessions/chat-${chat}/act`).find((c) => c.body.action === "upload")!.body).toEqual({ action: "upload", files: ["u1"], whole: true });
      expect(server.downloads).toEqual(["file-me"]);
      expect(kvGet(db, `browser_attach:${seq}`)).toBeUndefined();
      expect(existsSync(join(dataDir, "browser-uploads")) ? readdirSync(join(dataDir, "browser-uploads")) : []).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test("a download, set on a file input by its ref", async () => {
    const { p, env } = world(false);
    const db = memDb();
    ownerSays(db, "upload that pdf");
    const chat = ownerChatId(db);
    const pdf = new TextEncoder().encode("%PDF-1.4 x");
    const key = p.addDownload(`chat-${chat}`, "form.pdf", pdf, "application/pdf")!;
    const a = await dmTurn(db, env, [
      { tool: "browser_open", args: { url: PROFILE } },
      { tool: "browser_upload", args: { source: { download: key }, ref: "e2" } },
      { tool: "pass" },
    ]);
    expect(text(results(a)[1]!)).toStartWith("Put form.pdf (1 KB) into the file field e2.\n");
    expect(p.browse.inputs.get(`chat-${chat} e2`)).toEqual(["form.pdf"]);
    expect(p.browse.armed.size).toBe(0);
    expect(p.of(`/browse/sessions/chat-${chat}/act`).find((c) => c.body.action === "upload")!.body).toEqual({ action: "upload", files: ["u1"], whole: true, ref: "e2" });
  });

  test("over 20 MB is refused before anything is fetched or posted; a bad source, another chat's message or one without a file too", async () => {
    const { p, env, dataDir } = world(false);
    const db = memDb();
    const big = ownerSays(db, "this one", { attachment: attachment("big.zip", 20 * MB + 1) });
    const plain = ownerSays(db, "no file here");
    const chat = ownerChatId(db);
    const key = p.addDownload(`chat-${chat}`, "huge.bin", new Uint8Array(20 * MB + 1), "application/octet-stream")!;
    const server = serverFiles(db, dataDir, {});
    try {
      const a = await dmTurn(db, env, [
        { tool: "browser_open", args: { url: PROFILE } },
        { tool: "browser_upload", args: { source: { message: big } } },
        { tool: "browser_upload", args: { source: { download: key } } },
        { tool: "browser_upload", args: { source: { message: plain } } },
        { tool: "browser_upload", args: { source: { message: 99999 } } },
        { tool: "browser_upload", args: { source: {} } },
        { tool: "pass" },
      ]);
      const r = results(a).map(text);
      expect(r[1]).toBe("big.zip is 20.0 MB; a page can be given files up to 20.0 MB. Nothing was uploaded.");
      expect(r[2]).toBe("huge.bin is 20.0 MB; a page can be given files up to 20.0 MB. Nothing was uploaded.");
      expect(r[3]).toBe(`#${plain} carries no photo or file to upload. Nothing was uploaded.`);
      expect(r[4]).toBe("There is no message #99999 in this chat. Nothing was uploaded.");
      expect(r[5]).toBe("Give exactly one source: {message: <#number>} or {download: <key>}.");
      expect(server.downloads).toEqual([]);
      expect(p.of("/files/")).toHaveLength(0);
      expect(p.of(`/browse/sessions/chat-${chat}/uploads`)).toHaveLength(0);
      expect(kvGet(db, `browser_attach:${big}`)).toBeUndefined();
    } finally {
      server.stop();
    }
  });

  test("a file the server cannot fetch is said plainly", async () => {
    const { env, dataDir } = world(false);
    const db = memDb();
    const seq = ownerSays(db, "upload it", { attachment: attachment("gone.txt", 5, "file-gone") });
    const server = serverFiles(db, dataDir, {});
    try {
      const a = await dmTurn(db, env, [{ tool: "browser_upload", args: { source: { message: seq } } }, { tool: "pass" }]);
      expect(text(results(a)[0]!)).toBe(`#${seq}'s file could not be fetched: Bad Request: invalid file_id. Nothing was uploaded.`);
    } finally {
      server.stop();
    }
  });
});

describe("browser_upload_from_computer (the computer's tool)", () => {
  test("the owner: a file from the computer, set on a file input, or armed", async () => {
    const { p, hangar, env } = world();
    const db = memDb();
    ownerSays(db, "use my avatar");
    const dir = hangar!.home(computerNames(OWNER).container);
    mkdirSync(join(dir, "out"), { recursive: true });
    writeFileSync(join(dir, "out", "avatar.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]));
    const a = await dmTurn(db, env, [
      { tool: "browser_open", args: { url: PROFILE } },
      { tool: "browser_upload_from_computer", args: { path: "~/out/avatar.png", ref: "e2" } },
      { tool: "browser_upload_from_computer", args: { path: "~/out/avatar.png" } },
      { tool: "pass" },
    ]);
    const r = results(a);
    expect(a.calls[0]!.tools).toContain("browser_upload_from_computer");
    expect(text(r[1]!)).toStartWith("Put avatar.png (1 KB) into the file field e2.");
    expect(text(r[2]!)).toStartWith("avatar.png (1 KB) is ready for the page's next file chooser");
    const chat = ownerChatId(db);
    expect(p.browse.inputs.get(`chat-${chat} e2`)).toEqual(["avatar.png"]);
    expect(p.browse.armed.get(`chat-${chat}`)).toEqual(["avatar.png"]);
    expect([...p.browse.uploads.get(`chat-${chat}`)![0]!.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47, 9]);
  });

  test("over 20 MB on the computer is refused before reading it; without porchkit it refuses clearly", async () => {
    const { p, hangar, env } = world();
    const db = memDb();
    ownerSays(db, "upload the big one");
    const dir = hangar!.home(computerNames(OWNER).container);
    writeFileSync(join(dir, "big.bin"), new Uint8Array(20 * MB + 1));
    const a = await dmTurn(db, env, [{ tool: "browser_upload_from_computer", args: { path: "~/big.bin" } }, { tool: "pass" }]);
    expect(text(results(a)[0]!)).toBe("~/big.bin is 20.0 MB; a page can be given files up to 20.0 MB. Nothing was uploaded.");
    expect(p.of("/browse/")).toHaveLength(0);

    const h2 = new FakeHangar();
    fakes.push(h2);
    const db2 = memDb();
    ownerSays(db2, "upload it");
    const b = await dmTurn(db2, h2.env({ SHUVI_DATA_DIR: mkdtempSync(join(tmpdir(), "shuvi-upload-data-")), SHUVI_WEB: "off" }), [{ tool: "browser_upload_from_computer", args: { path: "~/x" } }, { tool: "pass" }]);
    expect(text(results(b)[0]!)).toBe("Nothing can be uploaded from the computer: there is no browser here (porchkit is not configured).");
  });

  /** Alice asks in the group (with a photo); the computer has ~/out/doc.txt. */
  async function groupTurn(policyExtra: string, script: (seq: number) => Step[]) {
    const { p, hangar, env, dataDir } = world();
    const policy = policyOf(`
chats:
  "${GROUP}":
    title: Friends
    trigger: [mention]
${policyExtra}    tools:
      browser: {}
      computer: {}
`);
    const db = memDb();
    const pic = new Uint8Array([0xff, 0xd8, 0xff, 7]);
    recordBatch(db, [groupUpdate(9200, { id: GROUP, title: "Friends" }, { id: ALICE, first: "Alice" }, "@shuvi_test_bot put this on the page", { photo: [{ file_id: "file-alice", file_unique_id: "u-alice", width: 10, height: 10, file_size: pic.length }] })], OWNER, { botUsername: "shuvi_test_bot", policy });
    const chat = allChats(db).find((c) => c.tgChatId === GROUP)!;
    const seq = (db.$client.query("select max(seq) as s from chat_events where chat_id = ? and kind = 'message'").get(chat.id) as { s: number }).s;
    // Vision's loop has downloaded the photo (a member's photo has no `attachment`: only the owner's and operators' files do).
    mkdirSync(join(dataDir, "media"), { recursive: true });
    writeFileSync(join(dataDir, "media", "u-alice"), pic);
    updateMedia(db, seq, { state: "ready", path: "media/u-alice", mimeType: "image/jpeg" });
    const dir = hangar!.home(computerNames(GROUP).container);
    mkdirSync(join(dir, "out"), { recursive: true });
    writeFileSync(join(dir, "out", "doc.txt"), "a document\n");
    const server = serverFiles(db, dataDir, { "file-alice": pic });
    try {
      const turn = claimTurn(db, chat.id)!;
      let a!: ScriptedAdapter;
      await runTurn({ db, turnId: turn.id, home: home(), timeZone: "UTC", ownerId: OWNER, capabilities: enabledCapabilities(env), policy, makeAdapter: (b) => (a = new ScriptedAdapter(b, script(seq))) });
      return { p, chat, a, seq, pic };
    } finally {
      server.stop();
    }
  }

  test("in a group: a member may upload what was sent there, but not from the computer", async () => {
    const { p, chat, a, seq, pic } = await groupTurn("", (seq) => [
      { tool: "browser_open", args: { url: PROFILE } },
      { tool: "browser_upload", args: { source: { message: seq } } },
      { tool: "browser_upload_from_computer", args: { path: "~/out/doc.txt", ref: "e2" } },
      { tool: "pass" },
    ]);
    const r = results(a);
    expect(r[1]!.isError ?? false).toBe(false);
    expect(p.browse.armed.get(`chat-${chat.id}`)).toEqual([`photo-${seq}.jpg`]);
    expect([...p.browse.uploads.get(`chat-${chat.id}`)![0]!.bytes]).toEqual([...pic]);
    expect(text(r[2]!)).toStartWith("Refused: `browser_upload_from_computer` acts for the owner");
    expect(p.browse.inputs.size).toBe(0);
  });

  test("a group that delegates only the browser: its operator's upload from the computer is refused", async () => {
    const { p, a } = await groupTurn(`    operators: [${ALICE}]\n    delegate: [browser]\n`, () => [
      { tool: "browser_open", args: { url: PROFILE } },
      { tool: "browser_upload_from_computer", args: { path: "~/out/doc.txt", ref: "e2" } },
      { tool: "pass" },
    ]);
    expect(text(results(a)[1]!)).toStartWith("Refused: `browser_upload_from_computer` acts for the owner");
    expect(p.browse.uploads.size).toBe(0);
  });

  test("a group that delegates the computer: its operator's upload from the computer goes through", async () => {
    const { p, chat, a } = await groupTurn(`    operators: [${ALICE}]\n    delegate: [computer]\n`, () => [
      { tool: "browser_open", args: { url: PROFILE } },
      { tool: "browser_upload_from_computer", args: { path: "~/out/doc.txt", ref: "e2" } },
      { tool: "pass" },
    ]);
    expect(text(results(a)[1]!)).toStartWith("Put doc.txt (1 KB) into the file field e2.");
    expect(p.browse.inputs.get(`chat-${chat.id} e2`)).toEqual(["doc.txt"]);
  });
});
