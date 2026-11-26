import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textOf, type ToolDef, type ToolResult } from "agent-runtime";
import { buildSystemPrompt } from "../src/agent/prompt.ts";
import { ownerAuthority, runTurn, type TurnState } from "../src/agent/turn.ts";
import { TriggerScan, type BotIdentity } from "../src/agent/triggers.ts";
import { BROWSER_SECTION, browser, CHECKOUT_NOTE, DELTA_LINE, describeBrowse, DID_NOTHING, renderAnswer, SIGNED_OUT, spentNote, type BrowserConfig } from "../src/capabilities/browser/index.ts";
import { turns, turnSteps } from "../src/store/schema.ts";
import { PURCHASE_KIND } from "../src/capabilities/browser/purchase.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import { chatCapabilities, type TurnContext } from "../src/capabilities/types.ts";
import { answerApproval, expireApprovals, getApproval } from "../src/control/approvals.ts";
import { PorchkitError } from "../src/porchkit/client.ts";
import { parsePolicy, resolveChat, type Policy } from "../src/policy/policy.ts";
import { recordBatch } from "../src/server/poller.ts";
import type { Db } from "../src/store/db.ts";
import { allChats, ensureChat, type Chat } from "../src/store/events.ts";
import { claimTurn } from "../src/store/turns.ts";
import { DELTA_NOTHING, FakePorchkit, PM_MENU_HINT, PROFILE, SHOP, SHOP_CHECKOUT, SHOP_DONE, SIGN_IN, TINY_PNG } from "./fake-porchkit.ts";
import { groupUpdate, memDb, OWNER, ScriptedAdapter } from "./helpers.ts";

const BOT: BotIdentity = { id: 1, username: "shuvi_test_bot" };
const GROUP = -100777;
const ALICE = 2002;

const fakes: { stop(): void }[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) f.stop();
});

function porch(): FakePorchkit {
  const p = new FakePorchkit();
  fakes.push(p);
  return p;
}

const home = () => {
  const h = mkdtempSync(join(tmpdir(), "shuvi-browser-"));
  mkdirSync(join(h, "persona"));
  return h;
};

const policyOf = (text: string): Policy => {
  const r = parsePolicy(text, OWNER);
  if ("error" in r) throw new Error(r.error);
  return r.policy;
};

const text = (r: ToolResult) => textOf(r);

/**
 * The browser's tools for `chat`, called directly: outside a turn (the owner's), or as a turn whose calls act for
 * an operator, or for nobody (anyone else in a chat that enables the browser: `null`).
 */
function toolsFor(db: Db, p: FakePorchkit, chat: Chat, acting?: "operator" | null): Record<string, (args?: Record<string, unknown>) => Promise<ToolResult>> {
  const cfg = browser.enable(p.env()) as BrowserConfig;
  const state = { chat, turnId: 1, passed: false, stopping: false, n: 0, fromSeq: 0, toSeq: 0 } as TurnState;
  if (acting !== undefined) state.acting = () => (acting === "operator" ? { by: "operator", userId: 4242 } : null);
  const ctx: TurnContext = { db, home: home(), chat, turnId: 1, timeZone: "UTC", owner: {}, state, ownerId: OWNER };
  const defs = browser.tools!(ctx, cfg).flatMap((b) => b.tools as ToolDef[]);
  return Object.fromEntries(defs.map((d) => [d.name, (args: Record<string, unknown> = {}) => d.handler(args)]));
}

const dm = (db: Db) => ensureChat(db, { id: OWNER, kind: "private" });
const acts = (p: FakePorchkit): Record<string, unknown>[] => p.calls.filter((c) => c.path.endsWith("/act")).map((c) => ({ path: c.path, ...c.body }));

describe("the capability", () => {
  test("on only with porchkit configured, and in a chat only when its policy enables browser; its section only then", () => {
    const p = porch();
    expect(enabledCapabilities({}).some((c) => c.capability.id === "browser")).toBe(false);
    const on = enabledCapabilities(p.env());
    expect(on.some((c) => c.capability.id === "browser")).toBe(true);
    expect(browser.always).toBeUndefined();
    expect(browser.ownerOnly).toBeUndefined(); // browser_save, which writes to the computer, is the computer's

    const policy = policyOf(`
chats:
  dm:
    tools:
      browser: {}
  "${GROUP}":
    title: Friends
    tools:
      media: {}
`);
    const db = memDb();
    const chat = dm(db);
    const group = ensureChat(db, { id: GROUP, kind: "group", title: "Friends" });
    const dmPolicy = resolveChat(policy, chat, OWNER)!;
    const groupPolicy = resolveChat(policy, group, OWNER)!;
    expect(chatCapabilities(on, dmPolicy.tools).some((c) => c.capability.id === "browser")).toBe(true);
    expect(chatCapabilities(on, groupPolicy.tools).some((c) => c.capability.id === "browser")).toBe(false);
    expect(buildSystemPrompt(home(), chat, {}, chatCapabilities(on, dmPolicy.tools), dmPolicy)).toContain(BROWSER_SECTION);
    expect(buildSystemPrompt(home(), group, {}, chatCapabilities(on, groupPolicy.tools), groupPolicy)).not.toContain("## Your browser");
    expect(buildSystemPrompt(home(), chat, {}, chatCapabilities(enabledCapabilities({}), dmPolicy.tools), dmPolicy)).not.toContain("## Your browser");
  });

  test("the tools, in order", () => {
    const p = porch();
    const db = memDb();
    expect(Object.keys(toolsFor(db, p, dm(db)))).toEqual([
      "browser_open",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_press",
      "browser_scroll",
      "browser_back",
      "browser_tab",
      "browser_wait",
      "browser_dialog",
      "browser_screenshot",
      "browser_pointer",
      "browser_zoom",
      "browser_watch",
      "browser_find",
      "browser_wait_for",
      "browser_hover",
      "browser_select",
      "browser_close",
      "browser_status",
      "browser_request_purchase",
      "browser_downloads",
      "browser_send",
      "browser_upload",
    ]);
  });
});

describe("each tool's request", () => {
  test("every action goes to /browse/sessions/chat-<id>/act with the wrapper's body, and answers with the page text", async () => {
    const p = porch();
    const db = memDb();
    const chat = dm(db);
    const t = toolsFor(db, p, chat);
    const path = `/browse/sessions/chat-${chat.id}/act`;
    const r = await t.browser_open!({ url: SHOP });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe(
      `URL: ${SHOP}\nTitle: Example Shop\n[e1] link "A teapot"\n[e2] searchbox "Search"\n[e3] button "Show tip"\n[e4] button "Clear history"\n[e5] button "Gift message"`,
    );
    await t.browser_snapshot!();
    await t.browser_type!({ ref: "e2", text: "teapot", submit: true });
    await t.browser_type!({ text: "more" });
    await t.browser_press!({ key: "Escape" });
    await t.browser_scroll!({ direction: "down", amount: 1.5, ref: "e2" });
    await t.browser_scroll!({ direction: "up" });
    await t.browser_click!({ ref: "e1", double: false, button: "left" });
    await t.browser_back!();
    await t.browser_tab!({ index: 0 });
    await t.browser_wait!({ seconds: 2 });
    expect(acts(p)).toEqual([
      { path, action: "open", url: SHOP },
      { path, action: "snapshot" },
      { path, action: "type", text: "teapot", ref: "e2", submit: true },
      { path, action: "type", text: "more" },
      { path, action: "press", key: "Escape" },
      { path, action: "scroll", direction: "down", amount: 1.5, ref: "e2" },
      { path, action: "scroll", direction: "up" },
      { path, action: "click", ref: "e1", double: false, button: "left" },
      { path, action: "back" },
      { path, action: "tab", index: 0 },
      { path, action: "wait", seconds: 2 },
    ]);
    expect(p.calls.every((c) => c.authed)).toBe(true);

    expect(text(await t.browser_close!())).toBe("Closed this chat's browser window.");
    expect(p.calls.at(-1)).toMatchObject({ method: "DELETE", path: `/browse/sessions/chat-${chat.id}` });
  });

  test("an answer of only what changed on the same page says so before it; the whole page is not marked", async () => {
    const p = porch();
    const db = memDb();
    const t = toolsFor(db, p, dm(db));
    const whole = text(await t.browser_open!({ url: SHOP }));
    expect(whole).not.toContain(DELTA_LINE);
    // porchkit's own first line says it is partial: said once, not twice.
    const r = text(await t.browser_scroll!({ direction: "down" }));
    expect(r).toBe(`${DELTA_NOTHING}\nURL: ${SHOP}\nTitle: Example Shop`);
    // The refs of the earlier page text still hold.
    expect((await t.browser_click!({ ref: "e3" })).isError).toBeFalsy();
    expect(text(await t.browser_snapshot!())).not.toContain(DELTA_LINE);
    // A delta whose text does not say so gets the line; its cut says what the offset reads.
    const bare = renderAnswer({ url: SHOP, snapshot: "in page:\n[e9] button \"New\"", snapshot_kind: "delta", next_offset: 40 });
    expect(bare.split("\n")).toEqual([DELTA_LINE, "in page:", '[e9] button "New"', "(The whole page text is cut after 40 lines: browser_snapshot with offset 40 reads what comes after the cut.)"]);
  });

  test("the first page text of a conversation is asked for whole: after /new, a compaction, or an answer that may be lost", async () => {
    const p = porch();
    const db = memDb();
    const chat = dm(db);
    const t = toolsFor(db, p, chat);
    const wholeOf = () => acts(p).at(-1)!.whole;
    await t.browser_scroll!({ direction: "down" }); // nothing seen yet in this conversation
    expect(wholeOf()).toBe(true);
    await t.browser_open!({ url: SHOP });
    expect(wholeOf()).toBeUndefined(); // open never answers a delta
    expect(text(await t.browser_scroll!({ direction: "down" }))).toStartWith(DELTA_NOTHING);
    expect(wholeOf()).toBeUndefined();
    // /new: the next turn opens a fresh conversation.
    db.insert(turns).values({ chatId: chat.id, status: "done", fromSeq: 0, toSeq: 0, opening: "new" }).run();
    expect(text(await t.browser_scroll!({ direction: "down" }))).toContain('[e1] link "A teapot"');
    expect(wholeOf()).toBe(true);
    expect(text(await t.browser_wait!({ seconds: 1 }))).toStartWith(DELTA_NOTHING); // seen whole: deltas again
    // A turn that resumes it changes nothing.
    db.insert(turns).values({ chatId: chat.id, status: "done", fromSeq: 0, toSeq: 0, opening: "resumed" }).run();
    await t.browser_wait!({ seconds: 1 });
    expect(wholeOf()).toBeUndefined();
    // A compaction: the model sees a summary of what came before.
    const turn = db.insert(turns).values({ chatId: chat.id, status: "done", fromSeq: 0, toSeq: 0, opening: "resumed" }).returning().get();
    db.insert(turnSteps).values({ turnId: turn.id, n: 0, kind: "compaction" }).run();
    await t.browser_wait!({ seconds: 1 });
    expect(wholeOf()).toBe(true);
    await t.browser_wait!({ seconds: 1 });
    expect(wholeOf()).toBeUndefined();
    // An answer lost on the way: the model may not have read it.
    p.failNext(`/browse/sessions/chat-${chat.id}/act`, 504, { error: "timeout", detail: "slow" });
    expect((await t.browser_wait!({ seconds: 1 })).isError).toBe(true);
    await t.browser_wait!({ seconds: 1 });
    expect(wholeOf()).toBe(true);
  });

  test("browser_screenshot fetches porchkit's file and returns it as an image", async () => {
    const p = porch();
    const db = memDb();
    const t = toolsFor(db, p, dm(db));
    await t.browser_open!({ url: SHOP });
    const r = await t.browser_screenshot!();
    expect(r.isError).toBeFalsy();
    expect(r.content[0]).toEqual({ type: "text", text: `Screenshot of Example Shop — ${SHOP}. Coordinates are in this image's pixels: 1280×666.` });
    expect(r.content[1]).toEqual({ type: "image", data: TINY_PNG.toString("base64"), mimeType: "image/png" });
    expect(p.calls.at(-1)).toMatchObject({ method: "GET", authed: true });
    expect(p.calls.at(-1)!.path).toMatch(/^\/files\/[0-9a-f]{32}$/);
  });

  test("browser_status: signed in or out, takeover, the live link; only this chat's window is named", async () => {
    const p = porch();
    const db = memDb();
    const chat = dm(db);
    const t = toolsFor(db, p, chat);
    await t.browser_open!({ url: SHOP });
    p.browse.sessions.set("chat-999", ["https://elsewhere.example.com/secret"]);
    let s = text(await t.browser_status!());
    expect(s).toBe(
      [
        "The browser is available.",
        "Google: signed in.",
        "Live view (for the owner; send him this link when he should look or act): https://porchkit.example.ts.net:8444/",
        `This chat's window: Example Shop — ${SHOP}, idle 5s.`,
        "Windows open in other chats: 1.",
      ].join("\n"),
    );
    expect(s).not.toContain("elsewhere");
    p.browse.google = false;
    p.browse.takeover = true;
    s = text(await t.browser_status!());
    expect(s).toContain(`Google: signed out. ${SIGNED_OUT}`);
    expect(s).toContain("The owner has taken it over");
  });

  test("an answer showing Google signed out tells the model to send the owner the live link", async () => {
    const p = porch();
    const db = memDb();
    const t = toolsFor(db, p, dm(db));
    p.failNext(`/browse/sessions/chat-${dm(db).id}/act`, 200, { url: SHOP, title: "Example Shop", snapshot: "URL: x", checkout: false, notes: [], signed_in: { google: false } });
    expect(text(await t.browser_open!({ url: SHOP }))).toBe(`URL: x\n${SIGNED_OUT} The live view: https://porchkit.example.ts.net:8444/`);
  });
});

describe("1Password", () => {
  test("the owner's own call sends owner: true, and may use 1Password's menu; its hint says to look", async () => {
    const p = porch();
    const db = memDb();
    const chat = dm(db);
    const t = toolsFor(db, p, chat);
    await t.browser_open!({ url: SIGN_IN });
    await t.browser_click!({ ref: "e1" });
    const r = await t.browser_press!({ key: "ArrowDown" });
    expect(r.isError ?? false).toBe(false);
    expect(text(r)).toContain(PM_MENU_HINT);
    expect(text(r)).toContain("only if the owner himself asked for this, use it (browser_screenshot to see it)");
    expect(p.of(`/browse/sessions/chat-${chat.id}/act`).map((c) => c.owner)).toEqual([true, true, true]);
  });

  for (const acting of ["operator", null] as const) {
    test(`a call for ${acting ?? "anyone else"} sends no owner, and 1Password refuses it; Escape still closes it`, async () => {
      const p = porch();
      const db = memDb();
      const chat = ensureChat(db, { id: GROUP, kind: "group", title: "Friends" });
      const t = toolsFor(db, p, chat, acting);
      await t.browser_open!({ url: SIGN_IN });
      const r = await t.browser_press!({ key: "Enter" });
      expect(r.isError).toBe(true);
      expect(text(r)).toBe(
        'That is 1Password\'s (filling, saving or signing in with a login or passkey): you use it only when the owner himself asked for this. Nothing was done. Type into the page\'s field as text and click the page\'s own buttons by ref; do not pick from 1Password\'s menu or offer. browser_press("Escape") closes its menu when it can, or ask the owner.',
      );
      await t.browser_screenshot!();
      expect(text(await t.browser_pointer!({ kind: "click", x: 10, y: 10 }))).toStartWith("That is 1Password's");
      const esc = await t.browser_press!({ key: "Escape" });
      expect(esc.isError ?? false).toBe(false);
      expect(p.of(`/browse/sessions/chat-${chat.id}/act`).every((c) => c.owner === undefined)).toBe(true);
    });
  }

  test("a 1Password refusal after part of the act was done says so, and marks the page unread; a withheld picture says why", async () => {
    const p = porch();
    const db = memDb();
    const chat = ensureChat(db, { id: GROUP, kind: "group", title: "Friends" });
    const t = toolsFor(db, p, chat, null);
    await t.browser_open!({ url: SHOP });
    const path = `/browse/sessions/chat-${chat.id}/act`;
    p.failNext(path, 403, { error: "owner_only", what: "password_manager", acted: true, detail: "the text was not sent: 1Password's menu is open" });
    const r = await t.browser_type!({ ref: "e2", text: "teapot" });
    expect(text(r)).toStartWith("That reached 1Password");
    expect(text(r)).toContain("Part of the action did happen");
    // The page was marked unread: the next act asks for the whole page text.
    await t.browser_scroll!({ direction: "down" });
    expect(p.of(path).at(-1)!.body.whole).toBe(true);
    expect(describeBrowse(new PorchkitError(409, "picture_withheld", "x", { acted: false }))).toStartWith("No picture was taken: it would have shown 1Password's menu over a password field");
    expect(describeBrowse(new PorchkitError(409, "picture_withheld", "x", { acted: true }))).toContain("The action was done, but its picture");
    const offer = renderAnswer({ url: SIGN_IN, title: "Sign in", snapshot: "x", situation: { hints: ["password-manager: sign-in offer open (only in a screenshot; it closes when the page is used, or with its ×, which is the owner's)"] } });
    expect(offer).toContain("otherwise leave it and use the page: it closes once the page is used");
  });

  test("a Google owner_only still reads as Google's; 1Password locked asks the owner to unlock it", () => {
    expect(describeBrowse(new PorchkitError(403, "owner_only", "x", { what: "google" }))).toStartWith("That page is the owner's (Google sign-in");
    const locked = renderAnswer({ url: SIGN_IN, title: "Sign in", snapshot: "x", situation: { hints: ["password-manager: locked (the owner unlocks it in the live view)"] } });
    expect(locked).toContain("1Password is locked: send the owner the live view link (browser_status) and ask him to unlock it");
    const hidden = renderAnswer({ url: SIGN_IN, title: "Sign up", snapshot: "x", situation: { hints: ["password-manager: password menu hidden from pictures (its first entry is the suggested password: ArrowDown then Enter)"] } });
    expect(hidden).toContain('browser_press("ArrowDown") until a hint says the focus is in 1Password, then browser_press("Enter") takes its first entry');
    expect(BROWSER_SECTION).toContain("on a password field its menu is hidden from your pictures (it shows the password itself); on a new-password field the first entry is the password it suggests");
    expect(BROWSER_SECTION).toContain('`browser_press("ArrowDown")` until it does (once if the menu is already open, twice if not)');
  });

  test("the prompt: 1Password is for the owner's own requests, never Google's, never a typed password", () => {
    expect(BROWSER_SECTION).toContain("Your browser has 1Password, with your own logins for other sites (never Google's). Use it only when the owner himself asked for what you are doing");
    expect(BROWSER_SECTION).toContain("Never type a password yourself.");
    expect(BROWSER_SECTION).toContain("When the hint says 1Password is locked, send the owner the live view link and ask him to unlock it.");
  });
});

describe("errors, as the model reads them", () => {
  const cases: [number, string, string][] = [
    [409, "takeover", "The owner is using the browser right now (he has taken it over in the live view). Nothing was done. Wait, or ask him."],
    [503, "busy", "The browser is busy: 3 chats are browsing at the moment, and there is no room for another window. Nothing was done; try again in a few minutes, or say so."],
    [
      403,
      "approval_required",
      "That places the order or pays (the button that places the order, or accepting a dialog that confirms it), so it needs the owner's approval first. Nothing was done. Fill in everything else first (address, coupon, payment method) so the page shows the final total; then call browser_request_purchase with the shop, the items and that total, end your turn, and once he approves, repeat this action with its approval id.",
    ],
    [
      422,
      "button_required",
      "On a checkout, Enter, Space or a submit could send the whole order form by itself, so it is not used here. Nothing was done. Press the page's own button for what you meant (Apply, 套用, Save, Search) with browser_click and its ref; no approval is needed for that.",
    ],
    [409, "dialog_open", "The page is asking something (a confirm or prompt dialog is open), so nothing else can be done on it. Nothing was done. Answer it first with browser_dialog (accept true or false)."],
    [503, "unavailable", "The browser is not available right now (the desktop is down or not set up): no desktop is configured. Say so, or try again later."],
    [422, "ref_required", "On this page, typing needs the field it goes into. Nothing was done. Give the field's ref from the page text (browser_type with ref)."],
    [409, "stale_page", "The page changed since its last page text. Nothing was done. Take a new snapshot (browser_snapshot) and act on what it shows."],
    [422, "bad_ref", "That ref is not on the page any more (its element is gone, or it is from an earlier page). Nothing was done. Take a new snapshot (browser_snapshot) and use a ref from it."],
    [504, "timeout", "The browser did not finish that in time. It may or may not have happened: take a new snapshot to see where the page is."],
    [502, "desktop", "The browser crashed and is being restarted; its windows are gone. Open the page again."],
  ];
  for (const [status, code, want] of cases) {
    test(`${status} ${code}`, async () => {
      const p = porch();
      const db = memDb();
      const chat = dm(db);
      p.failNext(`/browse/sessions/chat-${chat.id}/act`, status, { error: code, detail: "no desktop is configured" });
      const r = await toolsFor(db, p, chat).browser_click!({ ref: "e1" });
      expect(r.isError).toBe(true);
      expect(text(r)).toBe(want);
    });
  }

  test("owner_only: Google sign-in and account security are the owner's, with the live view link to send him; her own profile is hers", async () => {
    const p = porch();
    const db = memDb();
    const t = toolsFor(db, p, dm(db));
    const r = await t.browser_open!({ url: "https://myaccount.google.com/security" });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(
      "That page is the owner's (Google sign-in or account security: password, 2-Step Verification, recovery, deleting the account): you do not act on it. Nothing was done. Send the owner the live view link and ask him to do it himself there. The live view: https://porchkit.example.ts.net:8444/",
    );
    expect(text(await t.browser_open!({ url: "https://accounts.google.com/signin" }))).toStartWith("That page is the owner's (Google sign-in");
    const mine = await t.browser_open!({ url: PROFILE });
    expect(mine.isError ?? false).toBe(false);
    expect(text(mine)).toContain('[e1] button "Change photo"');
  });

  test("the prompt: sign-in and account security are the owner's; the rest of her Google account is hers", () => {
    expect(BROWSER_SECTION).toContain(
      "Google sign-in and account-security pages (password, 2-Step Verification, recovery, deleting the account) are the owner's: send him the live view link from `browser_status` and let him do it there. The rest of your own Google account (profile, photo, settings) you manage yourself.",
    );
    expect(BROWSER_SECTION).not.toMatch(/Google account, security and payment/);
    expect(describeBrowse(new PorchkitError(403, "owner_only", "x"))).not.toMatch(/payment/);
  });

  test("the fake's own: busy past 3 sessions, takeover, a stale ref, no desktop at all", async () => {
    const p = porch();
    const db = memDb();
    for (const s of ["chat-a", "chat-b", "chat-c"]) p.browse.sessions.set(s, ["about:blank"]);
    const t = toolsFor(db, p, dm(db));
    expect(text(await t.browser_open!({ url: SHOP }))).toStartWith("The browser is busy");
    p.browse.sessions.clear();
    await t.browser_open!({ url: SHOP });
    expect(text(await t.browser_click!({ ref: "e9" }))).toStartWith("That ref is not on the page any more");
    p.browse.takeover = true;
    expect(text(await t.browser_snapshot!())).toStartWith("The owner is using the browser right now");
    p.browse.available = false;
    expect(text(await t.browser_status!())).toStartWith("The browser is not available right now");
  });

  test("a client-side failure never shows porchkit's address or token", () => {
    const s = describeBrowse(new PorchkitError(0, "unreachable", "a TypeError on the way there"));
    expect(s).toBe(
      "The browser's service could not be reached, or the connection dropped (a TypeError on the way there). If this was an action, it may or may not have happened: take a new snapshot to see where the page is.",
    );
  });
});

// ---- dialogs -----------------------------------------------------------------------------------------------

describe("a page's dialogs", () => {
  test("an alert porchkit accepted is a note in the answer", async () => {
    const p = porch();
    const db = memDb();
    const t = toolsFor(db, p, dm(db));
    await t.browser_open!({ url: SHOP });
    expect(text(await t.browser_click!({ ref: "e3" }))).toEndWith('\nNote: dialog: alert "Free shipping today" (accepted)');
  });

  test("a confirm: the page asks → any other action is refused → browser_dialog answers it", async () => {
    const p = porch();
    const db = memDb();
    const chat = dm(db);
    const t = toolsFor(db, p, chat);
    await t.browser_open!({ url: SHOP });
    const asked = await t.browser_click!({ ref: "e4" });
    expect(asked.isError).toBeFalsy();
    expect(text(asked)).toBe(`Example Shop — ${SHOP}\nThe page asks: "Clear your browsing history?" (a confirm) — answer with browser_dialog (accept true or false) before anything else.`);

    const blocked = await t.browser_snapshot!();
    expect(blocked.isError).toBe(true);
    expect(text(blocked)).toStartWith("The page is asking something");

    const answered = await t.browser_dialog!({ accept: false });
    expect(answered.isError).toBeFalsy();
    expect(acts(p).at(-1)).toEqual({ path: `/browse/sessions/chat-${chat.id}/act`, action: "dialog", accept: false });
    expect(text(answered)).toStartWith(`URL: ${SHOP}`);
    expect(text(answered)).toEndWith('Note: dialog: confirm "Clear your browsing history?" (dismissed)');
    expect((await t.browser_snapshot!()).isError).toBeFalsy();
  });

  test("a prompt: its default is shown, and browser_dialog sends the answer's text", async () => {
    const p = porch();
    const db = memDb();
    const t = toolsFor(db, p, dm(db));
    await t.browser_open!({ url: SHOP });
    expect(text(await t.browser_click!({ ref: "e5" }))).toEndWith(
      `The page asks: "Your gift message?" (a prompt, its default "Enjoy!"; give your answer as text) — answer with browser_dialog (accept true or false) before anything else.`,
    );
    await t.browser_dialog!({ accept: true, text: "Happy birthday" });
    expect(acts(p).at(-1)).toMatchObject({ action: "dialog", accept: true, text: "Happy birthday" });
    expect(p.browse.dialogs.size).toBe(0);
  });

  test("adding to the cart (立即購買 too) never needs approval; a final-step button does, wherever it is", async () => {
    const p = porch();
    const db = memDb();
    const t = toolsFor(db, p, dm(db));
    await t.browser_open!({ url: SHOP });
    await t.browser_click!({ ref: "e1" });
    expect(text(await t.browser_click!({ ref: "e3" }))).toContain(`URL: ${SHOP_CHECKOUT}`);
    expect(text(await t.browser_click!({ ref: "e2" }))).toStartWith("That places the order or pays");
  });

  test("on a checkout she fills it in herself: other buttons and typing need no approval, Enter is the page's button's, the order's button is the owner's", async () => {
    const p = porch();
    const db = memDb();
    const chat = dm(db);
    const t = toolsFor(db, p, chat);
    await toCheckout(t);
    expect((await t.browser_type!({ ref: "e1", text: "Leave it at the door" })).isError).toBeFalsy();
    const enter = await t.browser_press!({ key: "Enter" });
    expect(enter.isError).toBe(true);
    expect(text(enter)).toStartWith("On a checkout, Enter, Space or a submit could send the whole order form by itself");
    // "Pay" is not the order's own name: it opens the confirm, and that confirm is the owner's to accept.
    expect(text(await t.browser_click!({ ref: "e3" }))).toContain('The page asks: "Confirm and pay NT$1,280?"');
    expect(text(await t.browser_dialog!({ accept: true }))).toStartWith("That places the order or pays");
    expect((await t.browser_dialog!({ accept: false })).isError).toBeFalsy();
    expect(text(await t.browser_click!({ ref: "e2" }))).toStartWith("That places the order or pays");
    expect(controlCards(db)).toHaveLength(0);
  });

  test("the prompt: payment details only as a secret, and the checkout filled in before the card", () => {
    expect(BROWSER_SECTION).toContain("Payment details (a card number, its expiry and security code) are typed only that way");
    expect(BROWSER_SECTION).toContain("Once the page shows the final total, call `browser_request_purchase`");
    expect(BROWSER_SECTION).not.toContain("Card numbers and payment codes: never");
  });
});

// ---- purchases ---------------------------------------------------------------------------------------------

/** Into the fake shop's checkout. */
async function toCheckout(t: ReturnType<typeof toolsFor>): Promise<ToolResult> {
  await t.browser_open!({ url: SHOP });
  await t.browser_click!({ ref: "e1" });
  return t.browser_click!({ ref: "e1" });
}

const controlCards = (db: Db) => db.$client.query("select kind, text, approval_id as approvalId from control_messages where kind = 'approval'").all() as { kind: string; text: string; approvalId: number }[];
const ownerPresses = (db: Db, id: number, option: number) => answerApproval(db, id, option, { id: OWNER, name: "Owner" });
const approvalIdIn = (r: ToolResult) => Number(text(r).match(/approval #(\d+)/)![1]);

describe("a purchase", () => {
  test("request → the owner's card → approve → the next click carries approved: true → a second use is refused", async () => {
    const p = porch();
    const db = memDb();
    const chat = dm(db);
    const t = toolsFor(db, p, chat);
    const at = await toCheckout(t);
    expect(text(at)).toEndWith(CHECKOUT_NOTE);

    // Without approval porchkit refuses the order.
    const refused = await t.browser_click!({ ref: "e2" });
    expect(text(refused)).toStartWith("That places the order or pays");
    expect(acts(p).at(-1)).toEqual({ path: `/browse/sessions/chat-${chat.id}/act`, action: "click", ref: "e2" });

    const asked = await t.browser_request_purchase!({ shop: "Example Shop", items: "1 teapot", total: "NT$1,280", note: "for the kitchen" });
    expect(asked.isError).toBeFalsy();
    const id = approvalIdIn(asked);
    expect(text(asked)).toContain("End your turn now");
    expect(asked.content.some((c) => c.type === "image")).toBe(true);
    const a = getApproval(db, id)!;
    expect(a).toMatchObject({ kind: PURCHASE_KIND, originChatId: chat.id, status: "pending", requestedBy: null });
    expect(a.data).toMatchObject({ session: `chat-${chat.id}`, used: false });
    expect(Date.parse(a.expiresAt!) - Date.parse(a.createdAt)).toBe(15 * 60_000);
    const cards = controlCards(db);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.approvalId).toBe(id);
    expect(cards[0]!.text).toContain("Items: 1 teapot");
    expect(cards[0]!.text).toContain("Total: NT$1,280");

    // Not answered yet: refused here, porchkit never asked.
    const before = acts(p).length;
    expect(text(await t.browser_click!({ ref: "e2", approval: id }))).toStartWith(`Refused: the owner has not answered approval #${id} yet.`);
    expect(acts(p).length).toBe(before);

    ownerPresses(db, id, 0);
    const done = await t.browser_click!({ ref: "e2", approval: id });
    expect(done.isError).toBeFalsy();
    expect(acts(p).at(-1)).toEqual({ path: `/browse/sessions/chat-${chat.id}/act`, action: "click", ref: "e2", approved: true });
    expect(text(done)).toStartWith(`URL changed → ${SHOP_DONE}\n(Done with the owner's approval #${id}; it is now used up.)\nURL: ${SHOP_DONE}`);
    expect(getApproval(db, id)!.data).toMatchObject({ used: true });

    const again = await t.browser_press!({ key: "Enter", approval: id });
    expect(text(again)).toStartWith(`Refused: approval #${id} was already used (one approval is one action).`);
    expect(acts(p).at(-1)!.action).toBe("click");
  });

  test("declined, expired, another chat's, or not a purchase: refused before porchkit is asked", async () => {
    const p = porch();
    const db = memDb();
    const chat = dm(db);
    const t = toolsFor(db, p, chat);
    await toCheckout(t);
    const declined = approvalIdIn(await t.browser_request_purchase!({ shop: "S", items: "i", total: "1" }));
    ownerPresses(db, declined, 1);
    const expired = approvalIdIn(await t.browser_request_purchase!({ shop: "S", items: "i", total: "2" }));
    expireApprovals(db, OWNER, Date.now() + 16 * 60_000);
    expect(getApproval(db, expired)!.status).toBe("expired");

    const other = ensureChat(db, { id: GROUP, kind: "group", title: "Friends" });
    const theirs = toolsFor(db, p, other);
    await toCheckout(theirs);
    const elsewhere = approvalIdIn(await theirs.browser_request_purchase!({ shop: "S", items: "i", total: "3" }));
    ownerPresses(db, elsewhere, 0);

    const before = acts(p).length;
    expect(text(await t.browser_click!({ ref: "e2", approval: declined }))).toStartWith(`Refused: the owner declined approval #${declined}.`);
    expect(text(await t.browser_click!({ ref: "e2", approval: expired }))).toStartWith(`Refused: approval #${expired} expired unanswered.`);
    expect(text(await t.browser_click!({ ref: "e2", approval: elsewhere }))).toStartWith(`Refused: approval #${elsewhere} was asked for in another chat.`);
    expect(text(await t.browser_type!({ text: "x", submit: true, approval: 9999 }))).toStartWith("Refused: there is no purchase approval #9999.");
    expect(acts(p).length).toBe(before);
    // And the other chat's own approval still works there.
    expect((await theirs.browser_click!({ ref: "e2", approval: elsewhere })).isError).toBeFalsy();
  });

  test("an approved action porchkit refused before doing anything does not use the approval up", async () => {
    const p = porch();
    const db = memDb();
    const t = toolsFor(db, p, dm(db));
    await toCheckout(t);
    const id = approvalIdIn(await t.browser_request_purchase!({ shop: "S", items: "i", total: "1" }));
    ownerPresses(db, id, 0);
    const stale = await t.browser_click!({ ref: "e7", approval: id });
    expect(text(stale)).toEndWith(`(Approval #${id} was not used up.)`);
    expect(getApproval(db, id)!.data).toMatchObject({ used: false });
    expect((await t.browser_click!({ ref: "e2", approval: id })).isError).toBeFalsy();
  });

  test("in a group, anyone may browse; the card is still the owner's, recorded as asked by the member, and his answer is not the owner speaking", async () => {
    const p = porch();
    const policy = policyOf(`
chats:
  "${GROUP}":
    title: Friends
    trigger: [mention]
    tools:
      browser: {}
`);
    const db = memDb();
    let upd = 8100;
    recordBatch(db, [groupUpdate(upd++, { id: GROUP, title: "Friends" }, { id: ALICE, first: "Alice" }, "@shuvi_test_bot buy me the teapot")], OWNER, { botUsername: BOT.username!, policy });
    const chat = allChats(db).find((c) => c.tgChatId === GROUP)!;
    const trig = new TriggerScan().newestTrigger(db, chat, resolveChat(policy, chat)!, BOT, policy);
    const turn = claimTurn(db, chat.id, trig ?? undefined)!;
    let a!: ScriptedAdapter;
    await runTurn({
      db,
      turnId: turn.id,
      home: home(),
      timeZone: "UTC",
      ownerId: OWNER,
      capabilities: enabledCapabilities(p.env()),
      policy,
      bot: BOT,
      makeAdapter: (b) =>
        (a = new ScriptedAdapter(b, [
          { tool: "browser_open", args: { url: SHOP } },
          { tool: "browser_click", args: { ref: "e1" } },
          { tool: "browser_click", args: { ref: "e1" } },
          { tool: "browser_request_purchase", args: { shop: "Example Shop", items: "1 teapot", total: "NT$1,280" } },
          { tool: "pass" },
        ])),
    });
    expect(a.calls[0]!.systemPrompt).toContain("## Your browser");
    const results = a.toolResults.filter((r) => r.name.startsWith("browser_"));
    expect(results.map((r) => r.result.isError ?? false)).toEqual([false, false, false, false]);
    expect(text(results[2]!.result)).toContain(SHOP_CHECKOUT);
    const id = approvalIdIn(results[3]!.result);
    expect(getApproval(db, id)).toMatchObject({ originChatId: chat.id, requestedBy: ALICE, status: "pending" });
    expect(controlCards(db)[0]!.text).toContain("by Alice (user id 2002), not you");

    // The owner answers the card; that wakes the group, and does not count as the owner in its turn.
    ownerPresses(db, id, 0);
    const ev = db.$client.query("select seq from chat_events where chat_id = ? and kind = 'approval'").get(chat.id) as { seq: number };
    expect(ev).toBeTruthy();
    expect(ownerAuthority(db, chat.id, ev.seq - 1, ev.seq, OWNER)).not.toBeNull();
    // The approval is usable from that chat.
    const t = toolsFor(db, p, chat);
    expect((await t.browser_click!({ ref: "e2", approval: id })).isError).toBeFalsy();
    expect(acts(p).at(-1)).toMatchObject({ action: "click", ref: "e2", approved: true });
  });

  test("a dialog on a checkout page: another is shuvi's either way; one that places the order needs an approval to accept, sent with browser_dialog's approval", async () => {
    const p = porch();
    const db = memDb();
    const chat = dm(db);
    const session = `chat-${chat.id}`;
    const t = toolsFor(db, p, chat);
    await toCheckout(t);
    p.browse.dialogs.set(session, { type: "confirm", message: "Remove this item?" });
    expect((await t.browser_dialog!({ accept: false })).isError).toBeFalsy();
    p.browse.dialogs.set(session, { type: "confirm", message: "Use this address for delivery?" });
    expect((await t.browser_dialog!({ accept: true })).isError).toBeFalsy();

    p.browse.dialogs.set(session, { type: "confirm", message: "Place this order now?" });
    const refused = await t.browser_dialog!({ accept: true });
    expect(text(refused)).toStartWith("That places the order or pays");
    expect(p.browse.dialogs.has(session)).toBe(true);

    // The screenshot is refused while the dialog is open: the card is asked for without one.
    const asked = await t.browser_request_purchase!({ shop: "Example Shop", items: "1 teapot", total: "NT$1,280" });
    expect(asked.isError).toBeFalsy();
    const id = approvalIdIn(asked);
    expect(asked.content.some((c) => c.type === "image")).toBe(false);
    expect(getApproval(db, id)!.data).toMatchObject({ session, used: false });
    ownerPresses(db, id, 0);

    const done = await t.browser_dialog!({ accept: true, approval: id });
    expect(done.isError).toBeFalsy();
    expect(acts(p).at(-1)).toEqual({ path: `/browse/sessions/${session}/act`, action: "dialog", accept: true, approved: true });
    expect(text(await t.browser_snapshot!())).not.toStartWith("The page is asking");
    expect(text(await t.browser_dialog!({ accept: true, approval: id }))).toStartWith(`Refused: approval #${id} was already used`);
  });

  test("off the checkout page, accepting a dialog that reads like placing an order needs approval too", async () => {
    const p = porch();
    const db = memDb();
    const chat = dm(db);
    const t = toolsFor(db, p, chat);
    await t.browser_open!({ url: SHOP });
    p.browse.dialogs.set(`chat-${chat.id}`, { type: "confirm", message: "Place this order now? 確認付款" });
    expect(text(await t.browser_dialog!({ accept: true }))).toStartWith("That places the order or pays");
    expect((await t.browser_dialog!({ accept: false })).isError).toBeFalsy();
  });

  /** In the DM: at the checkout, an approved click on "Pay", which opens "Confirm and pay NT$1,280?". */
  async function payOpensConfirm(db: Db, p: FakePorchkit) {
    const chat = dm(db);
    const t = toolsFor(db, p, chat);
    await toCheckout(t);
    const id = approvalIdIn(await t.browser_request_purchase!({ shop: "Example Shop", items: "1 teapot", total: "NT$1,280" }));
    ownerPresses(db, id, 0);
    const paid = await t.browser_click!({ ref: "e3", approval: id });
    return { chat, t, id, paid };
  }

  test("an approved action that opens a confirm carries the approval to accepting it, with no new card", async () => {
    const p = porch();
    const db = memDb();
    const { chat, t, id, paid } = await payOpensConfirm(db, p);
    expect(paid.isError).toBeFalsy();
    expect(text(paid)).toStartWith(`(Done with the owner's approval #${id}. It also covers accepting the dialog this opened, once, within 2 minutes`);
    expect(text(paid)).toContain('The page asks: "Confirm and pay NT$1,280?"');
    expect(acts(p).at(-1)).toMatchObject({ action: "click", ref: "e3", approved: true });

    const accepted = await t.browser_dialog!({ accept: true });
    expect(accepted.isError).toBeFalsy();
    expect(acts(p).at(-1)).toEqual({ path: `/browse/sessions/chat-${chat.id}/act`, action: "dialog", accept: true, approved: true });
    expect(text(accepted)).toStartWith(`URL changed → ${SHOP_DONE}\n(Accepted with the owner's approval #${id}, carried from the action that opened this dialog; it is now fully used up.)\nURL: ${SHOP_DONE}`);
    expect(controlCards(db)).toHaveLength(1);
  });

  test("after the carried dialog, a second dialog needs a new card", async () => {
    const p = porch();
    const db = memDb();
    const { chat, t, id } = await payOpensConfirm(db, p);
    await t.browser_dialog!({ accept: true });
    p.browse.dialogs.set(`chat-${chat.id}`, { type: "confirm", message: "Place this order now?" });
    expect(text(await t.browser_dialog!({ accept: true }))).toStartWith("That places the order or pays");
    expect(acts(p).at(-1)).toEqual({ path: `/browse/sessions/chat-${chat.id}/act`, action: "dialog", accept: true });
    expect(text(await t.browser_dialog!({ accept: true, approval: id }))).toStartWith(`Refused: approval #${id} was already used`);
  });

  test("the carried right expires after 2 minutes", async () => {
    const p = porch();
    const db = memDb();
    const { chat, t, id } = await payOpensConfirm(db, p);
    const until = (getApproval(db, id)!.data as { carry: { until: number } }).carry.until;
    expect(until - Date.now()).toBeGreaterThan(110_000);
    expect(until - Date.now()).toBeLessThanOrEqual(120_000);
    db.$client.query("update approvals set data = json_set(data, '$.carry.until', ?) where id = ?").run(Date.now() - 1, id);
    expect(text(await t.browser_dialog!({ accept: true }))).toStartWith("That places the order or pays");
    expect(acts(p).at(-1)).toEqual({ path: `/browse/sessions/chat-${chat.id}/act`, action: "dialog", accept: true });
  });

  test("another session cannot use the carried right; its own session still can", async () => {
    const p = porch();
    const db = memDb();
    const { chat, t, id } = await payOpensConfirm(db, p);
    const other = ensureChat(db, { id: GROUP, kind: "group", title: "Friends" });
    const theirs = toolsFor(db, p, other);
    await toCheckout(theirs);
    p.browse.dialogs.set(`chat-${other.id}`, { type: "confirm", message: "Confirm and pay NT$1,280?" });
    expect(text(await theirs.browser_dialog!({ accept: true }))).toStartWith("That places the order or pays");
    expect(text(await theirs.browser_dialog!({ accept: true, approval: id }))).toStartWith(`Refused: approval #${id} was asked for in another chat.`);
    expect(p.browse.dialogs.has(`chat-${other.id}`)).toBe(true);
    const mine = await t.browser_dialog!({ accept: true });
    expect(mine.isError).toBeFalsy();
    expect(acts(p).at(-1)).toMatchObject({ path: `/browse/sessions/chat-${chat.id}/act`, approved: true });
  });

  /** At the checkout with approval #id answered approve. */
  async function approvedAtCheckout(db: Db, p: FakePorchkit) {
    const chat = dm(db);
    const t = toolsFor(db, p, chat);
    await toCheckout(t);
    const id = approvalIdIn(await t.browser_request_purchase!({ shop: "S", items: "i", total: "1" }));
    ownerPresses(db, id, 0);
    return { chat, t, id };
  }

  for (const [status, code] of [
    [503, "unavailable"],
    [504, "timeout"],
    [502, "desktop"],
  ] as const) {
    test(`an approved click that failed with ${code} (maybe after the click) keeps the approval spent`, async () => {
      const p = porch();
      const db = memDb();
      const { chat, t, id } = await approvedAtCheckout(db, p);
      p.failNext(`/browse/sessions/chat-${chat.id}/act`, status, { error: code, detail: "lost" });
      const r = await t.browser_click!({ ref: "e2", approval: id });
      expect(r.isError).toBe(true);
      expect(text(r)).toEndWith(spentNote(id));
      expect(getApproval(db, id)!.data).toMatchObject({ used: true });
      expect(text(await t.browser_click!({ ref: "e2", approval: id }))).toStartWith(`Refused: approval #${id} was already used`);
    });
  }

  test("an approved click whose answer was cut off (the click happened) keeps the approval spent", async () => {
    const p = porch();
    const db = memDb();
    const { chat, t, id } = await approvedAtCheckout(db, p);
    p.dropNext.add(`/browse/sessions/chat-${chat.id}/act`);
    const r = await t.browser_click!({ ref: "e2", approval: id });
    expect(r.isError).toBe(true);
    expect(p.browse.sessions.get(`chat-${chat.id}`)!.at(-1)).toBe(SHOP_DONE); // the fake did place it
    expect(text(r)).toEndWith(spentNote(id));
    expect(getApproval(db, id)!.data).toMatchObject({ used: true });
  });

  test("an approved click when porchkit is unreachable keeps the approval unclaimed (the page could not be checked)", async () => {
    const p = porch();
    const db = memDb();
    const { t, id } = await approvedAtCheckout(db, p);
    p.stop();
    expect(text(await t.browser_click!({ ref: "e2", approval: id }))).toStartWith("Could not check which page the browser is on, so the approval was not used");
    expect(getApproval(db, id)!.data).toMatchObject({ used: false });
  });

  test("refusals porchkit makes before the desktop give the approval back: each code", async () => {
    expect([...DID_NOTHING].sort()).toEqual(["bad_ref", "bad_request", "busy", "button_required", "covered", "dialog_open", "egress_refused", "forbidden", "owner_only", "ref_required", "stale_page", "takeover", "target_changed", "unauthorized"]);
    const p = porch();
    const db = memDb();
    const { chat, t, id } = await approvedAtCheckout(db, p);
    for (const code of DID_NOTHING) {
      p.failNext(`/browse/sessions/chat-${chat.id}/act`, 409, { error: code, detail: "x" });
      expect(text(await t.browser_click!({ ref: "e2", approval: id }))).toEndWith(`(Approval #${id} was not used up.)`);
      expect(getApproval(db, id)!.data).toMatchObject({ used: false });
    }
  });

  test("type whose text did not land, and a covered element: what happened, and what to do", async () => {
    // Nothing reached the page (porchkit's `acted: false`): nothing was done.
    expect(describeBrowse(new PorchkitError(409, "not_typed", "nothing was typed: no text field has the focus", { acted: false }))).toBe(
      "The text did not go into the field: nothing was typed: no text field has the focus. Nothing was done. Click the field first (browser_click with its ref), then browser_type again with its ref.",
    );
    // The click or keys reached the page (`acted`, or not said): never "nothing was submitted".
    for (const body of [{ acted: true }, {}]) {
      const s = describeBrowse(new PorchkitError(409, "not_typed", "the text did not land: the keys were sent but the field's text did not change", body));
      expect(s).toStartWith("The text did not go into the field: the text did not land");
      expect(s).toContain("take a new snapshot (browser_snapshot) before anything else");
      expect(s).not.toMatch(/Nothing was (done|submitted)/);
    }
    expect(describeBrowse(new PorchkitError(409, "covered", "ref 'e7' is covered by 「廣告」 at its point"))).toBe(
      "That element is covered at the point it would be clicked: ref 'e7' is covered by 「廣告」 at its point. Nothing was pressed. Close or scroll away what covers it (a banner, a dialog, a menu), or scroll it into view, then try again.",
    );
    // An approved type that did not land used its approval: it reached the desktop.
    expect(DID_NOTHING.has("not_typed")).toBe(false);
  });

  test("a ref-less type with an approval, refused ref_required, gives the approval back", async () => {
    const p = porch();
    const db = memDb();
    const { chat, t, id } = await approvedAtCheckout(db, p);
    p.failNext(`/browse/sessions/chat-${chat.id}/act`, 422, { error: "ref_required", detail: "type needs a ref on this page" });
    const r = await t.browser_type!({ text: "note", submit: true, approval: id });
    expect(text(r)).toBe(`On this page, typing needs the field it goes into. Nothing was done. Give the field's ref from the page text (browser_type with ref). (Approval #${id} was not used up.)`);
    expect(getApproval(db, id)!.data).toMatchObject({ used: false });
    expect((await t.browser_type!({ ref: "e1", text: "note", submit: true, approval: id })).isError).toBeFalsy();
  });

  test("an approval is bound to the host it was asked on", async () => {
    const p = porch();
    const db = memDb();
    const { chat, t, id } = await approvedAtCheckout(db, p);
    expect(getApproval(db, id)!.data).toMatchObject({ host: "shop.example.com" });
    await t.browser_open!({ url: "https://other-shop.example.net/checkout" });
    const before = acts(p).length;
    expect(text(await t.browser_click!({ ref: "e2", approval: id }))).toStartWith(
      `Refused: approval #${id} is for a page on shop.example.com, and the browser is on other-shop.example.net now.`,
    );
    expect(acts(p).length).toBe(before);
    expect(getApproval(db, id)!.data).toMatchObject({ used: false });
    // Back on the shop, it works.
    p.browse.sessions.get(`chat-${chat.id}`)!.push(SHOP_CHECKOUT);
    expect((await t.browser_click!({ ref: "e2", approval: id, })).isError).toBeFalsy();
  });

  test("an approval is usable only within 15 minutes of the owner's answer", async () => {
    const p = porch();
    const db = memDb();
    const { t, id } = await approvedAtCheckout(db, p);
    db.$client.query("update approvals set answered_at = ? where id = ?").run(new Date(Date.now() - 15 * 60_000 - 1000).toISOString(), id);
    expect(text(await t.browser_click!({ ref: "e2", approval: id }))).toStartWith(`Refused: approval #${id} was answered more than 15 minutes ago; ask the owner again.`);
    db.$client.query("update approvals set answered_at = ? where id = ?").run(new Date(Date.now() - 14 * 60_000).toISOString(), id);
    expect((await t.browser_click!({ ref: "e2", approval: id })).isError).toBeFalsy();
  });

  test("the purchase card carries the checkout screenshot as its photo and the live view's link, and fits a caption", async () => {
    const p = porch();
    const db = memDb();
    const t = toolsFor(db, p, dm(db));
    await toCheckout(t);
    const long = "x".repeat(2000);
    const id = approvalIdIn(await t.browser_request_purchase!({ shop: long, items: long, total: long.slice(0, 100), note: long.slice(0, 500) }));
    const a = getApproval(db, id)!;
    expect(new Uint8Array(a.photo!)).toEqual(new Uint8Array(TINY_PNG));
    const card = controlCards(db)[0]!.text;
    expect(card).toContain("Look first, or take over: https://porchkit.example.ts.net:8444/");
    expect(card).toContain(`Page: Checkout - Example Shop — ${SHOP_CHECKOUT}`);
    expect(card.length).toBeLessThanOrEqual(1024);
  });

  test("a purchase asked while a dialog blocks the screenshot is a text card, still with the live link", async () => {
    const p = porch();
    const db = memDb();
    const chat = dm(db);
    const t = toolsFor(db, p, chat);
    await toCheckout(t);
    p.browse.dialogs.set(`chat-${chat.id}`, { type: "confirm", message: "Submit this order?" });
    const r = await t.browser_request_purchase!({ shop: "S", items: "i", total: "1" });
    expect(text(r)).toContain("(no screenshot: a dialog is open) and the live view's link");
    expect(getApproval(db, approvalIdIn(r))!.photo).toBeNull();
    expect(controlCards(db)[0]!.text).toContain("Look first, or take over: https://porchkit.example.ts.net:8444/");
  });

  test("no purchase is asked for without a web page open", async () => {
    const p = porch();
    const db = memDb();
    const t = toolsFor(db, p, dm(db));
    const r = await t.browser_request_purchase!({ shop: "S", items: "i", total: "1" });
    expect(r.isError).toBe(true);
    expect(text(r)).toStartWith("There is no web page open in this chat's browser to buy on.");
    expect(controlCards(db)).toHaveLength(0);
  });

  test("the owner's own request in his DM leaves requestedBy empty", async () => {
    const p = porch();
    const db = memDb();
    const t = toolsFor(db, p, dm(db));
    await toCheckout(t);
    const id = approvalIdIn(await t.browser_request_purchase!({ shop: "S", items: "i", total: "1" }));
    expect(getApproval(db, id)!.requestedBy).toBeNull();
    expect(controlCards(db)[0]!.text).toContain("Asked in your DM.");
  });
});
