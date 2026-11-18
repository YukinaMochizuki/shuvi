import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textOf, type ToolResult } from "agent-runtime";
import { runTurn } from "../src/agent/turn.ts";
import { browser, BROWSER_SECTION } from "../src/capabilities/browser/index.ts";
import { pdfName } from "../src/capabilities/browser/files.ts";
import { getComputer } from "../src/capabilities/computer/state.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import { parsePolicy, type Policy } from "../src/policy/policy.ts";
import { recordBatch } from "../src/server/poller.ts";
import type { Db } from "../src/store/db.ts";
import { allChats, type BotFilePayload } from "../src/store/events.ts";
import { DOCUMENT_LIMIT, PHOTO_LIMIT } from "../src/store/outbox.ts";
import { claimTurn } from "../src/store/turns.ts";
import { FakeHangar } from "./fake-hangar.ts";
import { FAKE_PDF, FakePorchkit, SHOP, SHOP_CHECKOUT, TINY_PNG } from "./fake-porchkit.ts";
import { groupUpdate, memDb, OWNER, ownerChatId, ownerSays, ScriptedAdapter, type Step } from "./helpers.ts";

const GROUP = -100555;
const ALICE = 2003;
const fakes: { stop(): void }[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) f.stop();
});

const home = () => {
  const h = mkdtempSync(join(tmpdir(), "shuvi-browser-files-"));
  mkdirSync(join(h, "persona"));
  return h;
};
const policyOf = (text: string): Policy => {
  const r = parsePolicy(text, OWNER);
  if ("error" in r) throw new Error(r.error);
  return r.policy;
};
const text = (r: ToolResult) => textOf(r);

/** porchkit, a Hangar, a data dir; `computer: false` leaves the computer off in the process. */
function world(computer = true) {
  const p = new FakePorchkit();
  fakes.push(p);
  const dataDir = mkdtempSync(join(tmpdir(), "shuvi-browser-data-"));
  let env: Record<string, string> = { ...p.env({ SHUVI_DATA_DIR: dataDir, SHUVI_WEB: "off" }) };
  let hangar: FakeHangar | undefined;
  if (computer) {
    hangar = new FakeHangar();
    fakes.push(hangar);
    env = { ...env, ...hangar.env({ SHUVI_DATA_DIR: dataDir, SHUVI_WEB: "off", SHUVI_COMPUTER_READY_SEC: "5" }) };
  }
  return { p, hangar, env, dataDir };
}

async function dmTurn(db: Db, env: Record<string, string>, script: Step[], policy?: Policy): Promise<ScriptedAdapter> {
  const turn = claimTurn(db, ownerChatId(db))!;
  let adapter!: ScriptedAdapter;
  await runTurn({ db, turnId: turn.id, home: home(), timeZone: "UTC", ownerId: OWNER, capabilities: enabledCapabilities(env), ...(policy ? { policy } : {}), makeAdapter: (b) => (adapter = new ScriptedAdapter(b, script)) });
  return adapter;
}

const files = (db: Db, chatId: number) =>
  (db.$client.query("select payload from chat_events where chat_id = ? and kind = 'bot_file' order by seq").all(chatId) as { payload: string }[]).map((r) => JSON.parse(r.payload) as BotFilePayload);

describe("browser_downloads and browser_send", () => {
  test("downloads are listed; a screenshot goes as a photo, a download and the page's PDF as documents, through the outbox", async () => {
    const { p, env, dataDir } = world(false);
    const db = memDb();
    ownerSays(db, "send me what you found");
    const chat = ownerChatId(db);
    const session = `chat-${chat}`;
    const report = new TextEncoder().encode("a made-up report\n");
    const key = p.addDownload(session, "report 2026/11.csv", report, "text/csv")!;
    p.addDownload(session, "big.iso", new Uint8Array(10), "application/octet-stream", "in_progress");
    const a = await dmTurn(db, env, [
      { tool: "browser_open", args: { url: SHOP } },
      { tool: "browser_downloads" },
      { tool: "browser_send", args: { what: "screenshot", caption: "the shop" } },
      { tool: "browser_send", args: { what: "download", key } },
      { tool: "browser_send", args: { what: "pdf" } },
      { tool: "pass" },
    ]);
    const r = a.toolResults.map((x) => x.result);
    expect(r.map((x) => x.isError ?? false)).toEqual([false, false, false, false, false, false]);
    expect(text(r[1]!)).toBe(`report 2026/11.csv — 1 KB, text/csv, completed, key ${key}\nbig.iso — 1 KB, application/octet-stream, still downloading`);
    expect(text(r[2]!)).toBe("Sent a screenshot of Example Shop (1 KB).");
    expect(text(r[3]!)).toBe("Sent 11.csv (1 KB).");
    expect(text(r[4]!)).toMatch(/^Sent Example Shop\.pdf \(1 KB\), the page as a PDF \(key [0-9a-f]{32}\)\.$/);

    const sent = files(db, chat);
    expect(sent.map((f) => [f.as, f.name, f.caption ?? null])).toEqual([
      ["photo", "screenshot.png", "the shop"],
      ["document", "11.csv", null],
      ["document", "Example Shop.pdf", null],
    ]);
    for (const f of sent) expect(f.file.startsWith(join(dataDir, "outbox"))).toBe(true);
    expect(new Uint8Array(readFileSync(sent[0]!.file))).toEqual(new Uint8Array(TINY_PNG));
    expect(new Uint8Array(readFileSync(sent[1]!.file))).toEqual(report);
    expect(new Uint8Array(readFileSync(sent[2]!.file))).toEqual(FAKE_PDF);
    expect(p.of(`/browse/sessions/${session}/downloads`).every((c) => c.authed)).toBe(true);
  });

  test("a PDF is named from the page's title, safely", () => {
    expect(pdfName("Checkout - Example Shop")).toBe("Checkout - Example Shop.pdf");
    expect(pdfName("a/b\\c: report?")).toBe("a-b-c_ report_.pdf");
    expect(pdfName("")).toBe("page.pdf");
    expect(pdfName(null)).toBe("page.pdf");
    expect(pdfName("notes.PDF")).toBe("notes.pdf");
  });

  test("over Telegram's limits nothing is sent: a photo over 10 MB, a document over 50 MB (listed or fetched)", async () => {
    const { p, env } = world(false);
    const db = memDb();
    ownerSays(db, "send them");
    const chat = ownerChatId(db);
    const session = `chat-${chat}`;
    const huge = p.addDownload(session, "huge.zip", new Uint8Array(DOCUMENT_LIMIT + 1), "application/zip")!;
    // A download listed small whose file is over the limit: the fetched size is checked too.
    const lying = p.addDownload(session, "lying.bin", new Uint8Array(DOCUMENT_LIMIT + 1), "application/octet-stream")!;
    p.browse.downloads.get(session)!.at(-1)!.bytes = 10;
    const fetchesBefore = () => p.of("/files/").length;
    const a = await dmTurn(db, env, [
      { tool: "browser_open", args: { url: SHOP } },
      { tool: "browser_send", args: { what: "download", key: huge } },
      { tool: "browser_send", args: { what: "download", key: lying } },
      { tool: "pass" },
    ]);
    const r = a.toolResults.map((x) => x.result);
    expect(text(r[1]!)).toBe("huge.zip is 50.0 MB; Telegram takes files from a bot up to 50.0 MB. Nothing was sent.");
    expect(text(r[2]!)).toBe("lying.bin is 50.0 MB; Telegram takes files from a bot up to 50.0 MB. Nothing was sent.");
    expect(r[1]!.isError && r[2]!.isError).toBe(true);
    expect(fetchesBefore()).toBe(1); // only the lying one was fetched; the listed-huge one never

    p.browse.reportBytes = PHOTO_LIMIT + 1;
    ownerSays(db, "and the page");
    const b = await dmTurn(db, env, [{ tool: "browser_send", args: { what: "screenshot" } }, { tool: "pass" }]);
    expect(text(b.toolResults[0]!.result)).toBe("The screenshot is 10.0 MB; Telegram takes photos from a bot up to 10.0 MB. Nothing was sent.");
    p.browse.reportBytes = DOCUMENT_LIMIT + 1;
    ownerSays(db, "as a pdf then");
    const c = await dmTurn(db, env, [{ tool: "browser_send", args: { what: "pdf" } }, { tool: "pass" }]);
    expect(text(c.toolResults[0]!.result)).toBe("The PDF of Example Shop is 50.0 MB; Telegram takes files from a bot up to 50.0 MB. Nothing was sent.");
    expect(files(db, chat)).toHaveLength(0);
  });

  test("only this chat's keys: another chat's download, an unfinished one, or no key at all is refused", async () => {
    const { p, env } = world(false);
    const db = memDb();
    ownerSays(db, "send it");
    const chat = ownerChatId(db);
    const theirs = p.addDownload("chat-999", "theirs.pdf", FAKE_PDF, "application/pdf")!;
    p.addDownload(`chat-${chat}`, "half.zip", new Uint8Array(4), "application/zip", "in_progress");
    const a = await dmTurn(db, env, [
      { tool: "browser_send", args: { what: "download", key: theirs } },
      { tool: "browser_send", args: { what: "download" } },
      { tool: "browser_send", args: { what: "download", key: "../../etc/passwd" } },
      { tool: "pass" },
    ]);
    const r = a.toolResults.map((x) => text(x.result));
    expect(r[0]).toStartWith("No download or PDF of this chat's browser has that key.");
    expect(r[1]).toBe('Give the download\'s key (browser_downloads lists them) with what: "download".');
    expect(r[2]).toStartWith("That is not a file key of the browser's.");
    expect(p.of("/files/")).toHaveLength(0);
    expect(files(db, chat)).toHaveLength(0);
  });
});

describe("browser_save (the computer's tool)", () => {
  test("the owner: a download and a sent PDF land in ~/inbox/browser/ on the computer, byte for byte", async () => {
    const { p, hangar, env } = world();
    const db = memDb();
    ownerSays(db, "keep these");
    const chat = ownerChatId(db);
    const csv = new TextEncoder().encode("a,b\n1,2\n");
    const key = p.addDownload(`chat-${chat}`, "data.csv", csv, "text/csv")!;
    const a = await dmTurn(db, env, [
      { tool: "browser_open", args: { url: SHOP_CHECKOUT } },
      { tool: "browser_save", args: { key } },
      { tool: "browser_send", args: { what: "pdf" } },
      { tool: "pass" },
    ]);
    expect(a.calls[0]!.tools).toContain("browser_save");
    expect(a.calls[0]!.systemPrompt).toContain("`browser_save` puts one of this chat's browser downloads");
    expect(text(a.toolResults[1]!.result)).toBe("Saved on your computer: ~/inbox/browser/data.csv (1 KB).");
    const pdfKey = text(a.toolResults[2]!.result).match(/key ([0-9a-f]{32})/)![1]!;
    ownerSays(db, "and the pdf");
    const b = await dmTurn(db, env, [{ tool: "browser_save", args: { key: pdfKey } }, { tool: "pass" }]);
    expect(text(b.toolResults[0]!.result)).toBe("Saved on your computer: ~/inbox/browser/Checkout - Example Shop.pdf (1 KB).");
    const dir = join(hangar!.home(getComputer(db, chat)!.container), "inbox", "browser");
    expect(new Uint8Array(readFileSync(join(dir, "data.csv")))).toEqual(csv);
    expect(new Uint8Array(readFileSync(join(dir, "Checkout - Example Shop.pdf")))).toEqual(FAKE_PDF);
  });

  test("it is the computer's, not the browser's: absent without the computer; refused clearly without porchkit or without the browser here", async () => {
    // No computer: the browser has no browser_save, and its section says nothing of saving.
    const off = world(false);
    const db = memDb();
    ownerSays(db, "hi");
    const a = await dmTurn(db, off.env, [{ tool: "pass" }]);
    expect(a.calls[0]!.tools).toContain("browser_send");
    expect(a.calls[0]!.tools).not.toContain("browser_save");
    expect(a.calls[0]!.systemPrompt).toContain(BROWSER_SECTION);
    expect(a.calls[0]!.systemPrompt).not.toContain("browser_save");
    expect(browser.ownerOnly).toBeUndefined();

    // The computer without porchkit: offered with the computer, refused with why.
    const hangar = new FakeHangar();
    fakes.push(hangar);
    const db2 = memDb();
    ownerSays(db2, "save it");
    const b = await dmTurn(db2, hangar.env({ SHUVI_DATA_DIR: mkdtempSync(join(tmpdir(), "shuvi-browser-data-")), SHUVI_WEB: "off" }), [{ tool: "browser_save", args: { key: "0".repeat(32) } }, { tool: "pass" }]);
    expect(text(b.toolResults[0]!.result)).toBe("Nothing can be saved from the browser: there is no browser here (porchkit is not configured).");

    // porchkit and the computer, but this chat's policy leaves the browser out.
    const on = world();
    const policy = policyOf(`
chats:
  dm:
    tools:
      computer: {}
`);
    const db3 = memDb();
    ownerSays(db3, "save it");
    const c = await dmTurn(db3, on.env, [{ tool: "browser_save", args: { key: "0".repeat(32) } }, { tool: "pass" }], policy);
    expect(text(c.toolResults[0]!.result)).toBe("This chat has no browser (its policy does not enable it), so there is no browser file of it to save.");
    expect(on.p.of("/browse/")).toHaveLength(0);
  });

  /** Alice asks in the group; `script(key)` runs with a download of the group's window, `data.csv`. */
  async function groupTurn(env: Record<string, string>, p: FakePorchkit, policy: Policy, script: (key: string) => Step[]) {
    const db = memDb();
    recordBatch(db, [groupUpdate(9100, { id: GROUP, title: "Friends" }, { id: ALICE, first: "Alice" }, "@shuvi_test_bot save that download")], OWNER, { botUsername: "shuvi_test_bot", policy });
    const chat = allChats(db).find((c) => c.tgChatId === GROUP)!;
    const key = p.addDownload(`chat-${chat.id}`, "data.csv", new Uint8Array([1, 2, 3]), "text/csv")!;
    const turn = claimTurn(db, chat.id)!;
    let a!: ScriptedAdapter;
    await runTurn({ db, turnId: turn.id, home: home(), timeZone: "UTC", ownerId: OWNER, capabilities: enabledCapabilities(env), policy, makeAdapter: (b) => (a = new ScriptedAdapter(b, script(key))) });
    return { db, chat, a };
  }

  const groupPolicy = (extra: string) =>
    policyOf(`
chats:
  "${GROUP}":
    title: Friends
    trigger: [mention]
${extra}    tools:
      browser: {}
      computer: {}
`);

  test("in a group, a member's save is refused (owner-only); sending is still anyone's", async () => {
    const { p, env } = world();
    const { db, chat, a } = await groupTurn(env, p, groupPolicy(""), (key) => [{ tool: "browser_save", args: { key } }, { tool: "browser_send", args: { what: "download", key } }, { tool: "pass" }]);
    expect(text(a.toolResults[0]!.result)).toStartWith("Refused: `browser_save` acts for the owner");
    expect(a.toolResults[1]!.result.isError ?? false).toBe(false);
    expect(files(db, chat.id)).toHaveLength(1);
    expect(getComputer(db, chat.id)).toBeUndefined(); // the computer was never touched
  });

  test("a group that delegates only the browser: its operator's save is refused", async () => {
    const { p, env } = world();
    const { db, chat, a } = await groupTurn(env, p, groupPolicy(`    operators: [${ALICE}]\n    delegate: [browser]\n`), (key) => [{ tool: "browser_save", args: { key } }, { tool: "pass" }]);
    expect(text(a.toolResults[0]!.result)).toStartWith("Refused: `browser_save` acts for the owner");
    expect(getComputer(db, chat.id)).toBeUndefined();
    expect(p.of("/files/").filter((c) => c.range)).toHaveLength(0);
  });

  test("a group that delegates the computer: its operator's save goes through", async () => {
    const { p, hangar, env } = world();
    const { db, chat, a } = await groupTurn(env, p, groupPolicy(`    operators: [${ALICE}]\n    delegate: [computer]\n`), (key) => [{ tool: "browser_save", args: { key } }, { tool: "pass" }]);
    expect(text(a.toolResults[0]!.result)).toBe("Saved on your computer: ~/inbox/browser/data.csv (1 KB).");
    const container = getComputer(db, chat.id)!.container;
    expect(new Uint8Array(readFileSync(join(hangar!.home(container), "inbox", "browser", "data.csv")))).toEqual(new Uint8Array([1, 2, 3]));
  });
});
