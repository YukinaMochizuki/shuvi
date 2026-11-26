import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textOf, type ToolDef, type ToolResult } from "agent-runtime";
import type { TurnState } from "../src/agent/turn.ts";
import { BROWSER_SECTION, browser, type BrowserConfig } from "../src/capabilities/browser/index.ts";
import { matchLines, pointerLines, rememberShot, situationLines, targetText } from "../src/capabilities/browser/look.ts";
import { POINTER_ACTION_FIELD } from "../src/capabilities/browser/pointer.ts";
import type { TurnContext } from "../src/capabilities/types.ts";
import { answerApproval, getApproval } from "../src/control/approvals.ts";
import type { Db } from "../src/store/db.ts";
import { ensureChat, type Chat } from "../src/store/events.ts";
import { CANVAS, CAPTCHA, FakePorchkit, FORM, LOADING_HINT, POPUP_PAGE, SHOP, SHOP_CHECKOUT, SHOP_DONE, SLOW } from "./fake-porchkit.ts";
import { memDb, OWNER } from "./helpers.ts";

const fakes: { stop(): void }[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) f.stop();
});
const home = () => {
  const h = mkdtempSync(join(tmpdir(), "shuvi-browser-look-"));
  mkdirSync(join(h, "persona"));
  return h;
};
const text = (r: ToolResult) => textOf(r);
/** The text parts of a result, in order (the answer, then each image's caption). */
const texts = (r: ToolResult) => r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text);
const images = (r: ToolResult) => r.content.filter((c) => c.type === "image");
/** The answer's own text (the first part), as lines. */
const lines = (r: ToolResult) => texts(r)[0]!.split("\n");

function toolsFor(db: Db, p: FakePorchkit, chat: Chat): Record<string, (args?: Record<string, unknown>) => Promise<ToolResult>> {
  const cfg = browser.enable(p.env({ SHUVI_DATA_DIR: mkdtempSync(join(tmpdir(), "shuvi-look-data-")) })) as BrowserConfig;
  const state = { chat, turnId: 1, passed: false, stopping: false, n: 0, fromSeq: 0, toSeq: 0 } as TurnState;
  const ctx: TurnContext = { db, home: home(), chat, turnId: 1, timeZone: "UTC", owner: {}, state, ownerId: OWNER };
  const defs = browser.tools!(ctx, cfg).flatMap((b) => b.tools as ToolDef[]);
  return Object.fromEntries(defs.map((d) => [d.name, (args: Record<string, unknown> = {}) => d.handler(args)]));
}
function world() {
  const p = new FakePorchkit();
  fakes.push(p);
  const db = memDb();
  const chat = ensureChat(db, { id: OWNER, kind: "private" });
  return { p, db, chat, t: toolsFor(db, p, chat) };
}
const lastAct = (p: FakePorchkit) => p.calls.filter((c) => c.path.endsWith("/act")).at(-1)!.body;

const CANVAS_HINT =
  "Hint: page: canvas-heavy — part of this page is drawn (a map, a canvas); the page text and refs still work for everything else. Only if what you need is not in the page text: browser_screenshot with grid, then browser_pointer.";
const NOT_FOR_POINTER = "for browser_pointer use the screenshot's pixels, not these";

describe("browser_pointer", () => {
  test("needs a screenshot first: its coordinates are in a screenshot's pixels", async () => {
    const { p, t } = world();
    await t.browser_open!({ url: CANVAS });
    const r = await t.browser_pointer!({ action: "click", x: 150, y: 125 });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("Take a browser_screenshot first: browser_pointer's coordinates are in its pixels. Nothing was done.");
    expect(p.browse.pointers).toHaveLength(0);
  });

  test("a canvas page: the hint, a grid screenshot, a click that hits (situation, target, settling, change; screenshot and close-up as images), then one that misses", async () => {
    const { p, t } = world();
    expect(lines(await t.browser_open!({ url: CANVAS }))[0]).toBe(CANVAS_HINT);
    const shot = await t.browser_screenshot!({ grid: true });
    expect(lastAct(p)).toEqual({ action: "screenshot", grid: true });
    expect(texts(shot)[0]).toEndWith("Coordinates are in this image's pixels: 1280×666. A grid is drawn on it (every 100 px), for browser_pointer.");

    const hit = await t.browser_pointer!({ action: "click", x: 150, y: 125 });
    expect(hit.isError ?? false).toBe(false);
    expect(lastAct(p)).toEqual({ action: "pointer", [POINTER_ACTION_FIELD]: "click", x: 150, y: 125, image_width: 1280 });
    expect(p.browse.canvasHits).toBe(1);
    expect(lines(hit)).toEqual([
      'Changed: canvas "" (+1 −0).',
      "About 12.5% of the screen changed.",
      CANVAS_HINT,
      'Under the pointer: canvas (no name) reads "Start", inside "Game area" (inside a canvas).',
      "After it: the page settled in 120 ms; 12.5% of it changed (around x 100, y 100, 100×50).",
      "(The page text was not read again: the last page text's refs still hold.)",
      `Canvas game — ${CANVAS}`,
    ]);
    expect(texts(hit).slice(1)).toEqual(["Screenshot (coordinates are in this image's pixels: 1280×666):", `Close-up of x 100, y 75, 100×100 at ×2 (200×200; ${NOT_FOR_POINTER}):`]);
    expect(images(hit)).toHaveLength(2);

    const miss = await t.browser_pointer!({ action: "click", x: 10, y: 10 });
    expect(lines(miss)[0]).toBe("Nothing visible changed — your action may have missed. Look (browser_screenshot) or try another way; do not just repeat it.");
    expect(text(miss)).toContain("After it: the page settled in 120 ms; nothing on it changed.");
    expect(p.browse.canvasHits).toBe(1);
  });

  test("dry_run presses nothing and says what is at the point", async () => {
    const { p, t } = world();
    await t.browser_open!({ url: CANVAS });
    await t.browser_screenshot!({ grid: 50 });
    expect(lastAct(p)).toEqual({ action: "screenshot", grid: 50 });
    const r = await t.browser_pointer!({ action: "click", x: 150, y: 125, dry_run: true });
    expect(lastAct(p)).toMatchObject({ [POINTER_ACTION_FIELD]: "click", dry_run: true });
    // A dry run has no situation (nothing was done): no situation lines, and no error for its absence.
    expect(lines(r)).toEqual(['Dry run: nothing was pressed. Under the point: canvas (no name) reads "Start", inside "Game area" (inside a canvas).', `Canvas game — ${CANVAS}`]);
    expect(images(r)).toHaveLength(0);
    expect(p.browse.canvasHits).toBe(0);
  });

  test("coordinates are sent with the last screenshot's width; drag, scroll and press_hold pass their fields", async () => {
    const { p, db, chat, t } = world();
    await t.browser_open!({ url: CANVAS });
    rememberShot(db, chat.id, 640); // a screenshot shown at half size
    await t.browser_pointer!({ action: "click", x: 75, y: 62 });
    expect(lastAct(p)).toMatchObject({ x: 75, y: 62, image_width: 640 });
    expect(p.browse.canvasHits).toBe(1);
    expect(text(await t.browser_pointer!({ action: "drag", x: 1, y: 1 }))).toBe("A drag needs to_x and to_y. Nothing was done.");
    const drag = await t.browser_pointer!({ action: "drag", x: 1, y: 2, to_x: 3, to_y: 4 });
    expect(lastAct(p)).toMatchObject({ [POINTER_ACTION_FIELD]: "drag", to_x: 3, to_y: 4 });
    expect(text(drag)).toContain('Dragged to: canvas (no name) reads "Goal" (inside a canvas).');
    await t.browser_pointer!({ action: "scroll", x: 5, y: 5, direction: "down", amount: 2 });
    expect(lastAct(p)).toMatchObject({ [POINTER_ACTION_FIELD]: "scroll", direction: "down", amount: 2 });
    await t.browser_pointer!({ action: "press_hold", x: 5, y: 5, ms: 1500 });
    expect(lastAct(p)).toMatchObject({ [POINTER_ACTION_FIELD]: "press_hold", ms: 1500 });
  });

  /** At the checkout, a screenshot taken, and approval #id answered approve. */
  async function approvedAtCheckout() {
    const w = world();
    await w.t.browser_open!({ url: SHOP });
    await w.t.browser_click!({ ref: "e1" });
    await w.t.browser_click!({ ref: "e1" });
    expect(w.p.browse.sessions.values().next().value!.at(-1)).toBe(SHOP_CHECKOUT);
    await w.t.browser_screenshot!();
    const refused = await w.t.browser_pointer!({ action: "click", x: 640, y: 600 });
    expect(text(refused)).toStartWith('That places the order or pays (the button that places the order, or accepting a dialog that confirms it; under the point: button "Place order" [e2])');
    const asked = await w.t.browser_request_purchase!({ shop: "Example Shop", items: "1 teapot", total: "NT$1,280" });
    const id = Number(text(asked).match(/approval #(\d+)/)![1]);
    answerApproval(w.db, id, 0, { id: OWNER, name: "Owner" });
    return { ...w, id };
  }

  test("a pressing pointer on a checkout button needs the owner's approval (the target named): refused, then one pointer action through the purchase flow", async () => {
    const { p, db, t, id } = await approvedAtCheckout();
    const done = await t.browser_pointer!({ action: "click", x: 640, y: 600, approval: id });
    expect(done.isError ?? false).toBe(false);
    expect(lastAct(p)).toMatchObject({ action: "pointer", approved: true });
    expect(lines(done).slice(0, 3)).toEqual([`URL changed → ${SHOP_DONE}`, "About 80% of the screen changed.", `(Done with the owner's approval #${id}; it is now used up.)`]);
    expect(getApproval(db, id)!.data).toMatchObject({ used: true });
    expect(text(await t.browser_pointer!({ action: "click", x: 640, y: 600, approval: id }))).toStartWith(`Refused: approval #${id} was already used`);
  });

  test("409 target_changed: something else is at the point now; nothing was done, and the approval is given back", async () => {
    const { p, db, t, id } = await approvedAtCheckout();
    p.browse.targetChangedNext = true;
    const r = await t.browser_pointer!({ action: "click", x: 640, y: 600, approval: id });
    expect(text(r)).toBe(
      `Something else is at that point now (link "Ad"): the page moved since you looked. Nothing was done. Look again (browser_screenshot) and aim from the new screenshot. (Approval #${id} was not used up.)`,
    );
    expect(getApproval(db, id)!.data).toMatchObject({ used: false });
  });
});

describe("the other tools beyond the page text", () => {
  test("browser_screenshot with marks lists where each element is", async () => {
    const { p, t } = world();
    await t.browser_open!({ url: SHOP });
    const marked = await t.browser_screenshot!({ marks: true });
    expect(lastAct(p)).toEqual({ action: "screenshot", marks: true });
    expect(texts(marked)[0]!.split("\n")).toEqual([
      `Screenshot of Example Shop — ${SHOP}. Coordinates are in this image's pixels: 1280×666. Refs are drawn on it: act on one with its ref.`,
      "Marked on the screenshot (in its pixels):",
      '  [e1] link "A teapot" at x 20, y 40, 120×30',
      '  [e2] searchbox "Search" at x 20, y 80, 120×30',
      '  [e3] button "Show tip" at x 20, y 120, 120×30',
      '  [e4] button "Clear history" at x 20, y 160, 120×30',
      '  [e5] button "Gift message" at x 20, y 200, 120×30',
    ]);
  });

  test("browser_zoom and browser_watch: images with their region, factor, frames and sizes", async () => {
    const { p, t } = world();
    await t.browser_open!({ url: SHOP });
    await t.browser_screenshot!();
    const z = await t.browser_zoom!({ x: 10, y: 20, w: 300, h: 200 });
    expect(lastAct(p)).toEqual({ action: "zoom", x: 10, y: 20, w: 300, h: 200, image_width: 1280 });
    expect(texts(z).at(-1)).toBe(`Zoomed region x 10, y 20, 300×200 at ×2 (400×300; ${NOT_FOR_POINTER}):`);
    expect(images(z)).toHaveLength(1);

    const w = await t.browser_watch!({});
    expect(lastAct(p)).toEqual({ action: "watch", seconds: 3, frames: 6 });
    expect(texts(w).at(-1)).toBe("Frames over time, in order (6 frames at 0s, 0.6s, 1.2s, 1.8s, 2.4s, 3s) (960×540); 3.5% changed over them:");
    await t.browser_watch!({ seconds: 5, frames: 4 });
    expect(lastAct(p)).toEqual({ action: "watch", seconds: 5, frames: 4 });
    // A page that moved on while watched says where it went; one URL throughout says nothing of it.
    p.browse.watchUrls = [SHOP, SHOP, SHOP_DONE, SHOP_DONE];
    expect(texts(await t.browser_watch!({ frames: 4 })).at(-1)).toEndWith(`; 3.5% changed over them; the page went ${SHOP} → ${SHOP_DONE}:`);
  });

  test("browser_find: the matching lines, where they are, out of how many; none says so", async () => {
    const { p, t } = world();
    await t.browser_open!({ url: FORM });
    const r = await t.browser_find!({ query: "country" });
    expect(lastAct(p)).toEqual({ action: "find", query: "country" });
    expect(lines(r)).toEqual(['1 match for "country" (act on a ref; a line of text has none, act on what it is in):', '[e2] combobox "Country" — in A long form', `A long form — ${FORM}`]);
    expect(lines(await t.browser_find!({ query: "zebra" }))[0]).toBe('No element matches "zebra" on this page.');
  });

  test("browser_find: every word in any order, a quoted phrase whole; a match held by the lines under it says so", async () => {
    const { p, t } = world();
    await t.browser_open!({ url: FORM });
    expect(lines(await t.browser_find!({ query: "try coun" }))[1]).toBe('[e2] combobox "Country" — in A long form');
    expect(lines(await t.browser_find!({ query: '"try coun"' }))[0]).toBe('No element matches "\"try coun\"" on this page.');
    expect(lastAct(p)).toEqual({ action: "find", query: '"try coun"' });
    const within = matchLines({ query: "最新趨勢話題 顯示更多", total: 1, matches: [{ ref: "e40", line: 'complementary "側欄"', context: "", within: true }] });
    expect(within![1]).toBe('[e40] complementary "側欄" — the words are in its lines (browser_snapshot with ref e40 reads them)');
    // A merged line's refs, as its bracket has them.
    expect(matchLines({ query: "讚", total: 1, matches: [{ ref: "e5 e9", line: 'button "讚" ×2', context: "" }] })![1]).toBe('[e5 e9] button "讚" ×2');
  });

  test("browser_type whose text did not land is an error that says to click the field", async () => {
    const { p, t } = world();
    await t.browser_open!({ url: FORM });
    p.browse.notTypedNext = true;
    const r = await t.browser_type!({ ref: "e1", text: "tea", submit: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toStartWith("The text did not go into the field: the text did not land");
    expect(text(r)).toContain("take a new snapshot (browser_snapshot) before anything else");
    expect((await t.browser_type!({ ref: "e1", text: "tea" })).isError ?? false).toBe(false);
  });

  test("browser_wait_for: met says how long; a timeout says it did not happen; one condition only", async () => {
    const { p, t } = world();
    await t.browser_open!({ url: FORM });
    const met = await t.browser_wait_for!({ text: "Next" });
    expect(lastAct(p)).toEqual({ action: "wait_for", text: "Next", timeout: 10 });
    expect(text(met)).toContain("Waited 0.4s: it happened.");
    await t.browser_wait_for!({ ref: "e3", timeout: 5 });
    expect(lastAct(p)).toEqual({ action: "wait_for", ref: "e3", timeout: 5 });
    expect((await t.browser_wait_for!({ gone: "Loading" })).isError ?? false).toBe(false);
    const late = await t.browser_wait_for!({ text: "Thank you", timeout: 3 });
    expect(late.isError).toBe(true);
    expect(text(late)).toBe('Waited 3s for "Thank you" to appear; it did not happen. Look at the page (browser_snapshot or browser_screenshot) before going on.');
    expect(text(await t.browser_wait_for!({ text: "a", ref: "e1" }))).toBe("Give exactly one of text, ref or gone.");
  });

  test("browser_select says what was chosen; an option that is not there lists the options", async () => {
    const { p, t } = world();
    await t.browser_open!({ url: FORM });
    const r = await t.browser_select!({ ref: "e2", option: "Taiwan" });
    expect(lastAct(p)).toEqual({ action: "select", ref: "e2", option: "Taiwan" });
    expect(text(r)).toContain('Selected "Taiwan" (value taiwan).');
    expect([...p.browse.selected.values()]).toEqual(["Taiwan"]);
    const bad = await t.browser_select!({ ref: "e2", option: "Mars" });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toBe('The browser refused that: no option "Mars". The options are: "Japan", "Taiwan", "United States".');
  });

  test("browser_snapshot of one element, from an offset, and a cut page text says where to read on", async () => {
    const { p, t } = world();
    await t.browser_open!({ url: FORM });
    expect(text(await t.browser_snapshot!({ ref: "e2" }))).toBe(`URL: ${FORM}\nTitle: A long form\n[e2] combobox "Country"`);
    expect(lastAct(p)).toEqual({ action: "snapshot", ref: "e2" });
    p.browse.cutAt = 2;
    const cut = await t.browser_snapshot!({});
    expect(text(cut)).toContain('[e2] combobox "Country"\n(The page text was cut: browser_snapshot with offset 2 reads on.)');
    const rest = await t.browser_snapshot!({ offset: 2 });
    expect(lastAct(p)).toEqual({ action: "snapshot", offset: 2 });
    expect(text(rest)).toContain('[e3] button "Next"\n[e4] link "Terms"');
    expect(text(rest)).not.toContain("cut");
  });

  test("browser_hover and browser_press holding a key; a ref act on a canvas page answers text only, the hint with it", async () => {
    const { p, t } = world();
    await t.browser_open!({ url: FORM });
    expect(text(await t.browser_hover!({ ref: "e4" }))).toContain("Note: hovering e4");
    expect(lastAct(p)).toEqual({ action: "hover", ref: "e4" });
    expect(text(await t.browser_press!({ key: "Space", hold_ms: 800 }))).toContain("Note: held Space for 800 ms");
    expect(lastAct(p)).toEqual({ action: "press", key: "Space", hold_ms: 800 });

    await t.browser_open!({ url: CANVAS });
    const r = await t.browser_click!({ ref: "e1" });
    expect(lines(r)[0]).toBe(CANVAS_HINT);
    expect(text(r)).toContain('[e1] canvas ""');
    expect(text(r)).not.toContain("After it:");
    expect(texts(r)).toHaveLength(1);
    expect(images(r)).toHaveLength(0);
  });

  test("hints as the model reads them: a captcha says to stop and send the owner the live link; a native popup, press Escape", async () => {
    const { p, t } = world();
    expect(lines(await t.browser_open!({ url: CAPTCHA }))[0]).toBe("Hint: blocked-by: captcha — stop here: send the owner the live view link (browser_status) and ask him to get past it.");
    expect(lines(await t.browser_open!({ url: POPUP_PAGE }))[0]).toBe('Hint: native-popup: press Escape — a browser popup is open: browser_press("Escape").');
    await t.browser_press!({ key: "Escape" });
    expect(p.browse.popupClosed).toBe(true);
  });

  test("a page that may still be loading: the hint says to wait and read what changed before acting on it", async () => {
    const { t } = world();
    // An open waits for the new page too (porchkit, round 4), and may give up at its limit.
    expect(lines(await t.browser_open!({ url: SLOW }))).toContain(
      `Hint: ${LOADING_HINT} — the page was still loading when this was read, so what you see may be the old content: browser_wait (1–2 s) and read what changed before acting on it.`,
    );
    expect(lines(await t.browser_click!({ ref: "e1" }))[0]).toBe(
      `Hint: ${LOADING_HINT} — the page was still loading when this was read, so what you see may be the old content: browser_wait (1–2 s) and read what changed before acting on it.`,
    );
  });
});

describe("the situation", () => {
  test("every kind of line, in order; nothing to say, no lines", () => {
    expect(
      situationLines(
        {
          url_changed: true,
          dialog_opened: true,
          popup_opened: true,
          changes: [{ subtree: "page", added: 5, removed: 0 }, { subtree: 'button "Save"', added: 1, removed: 1 }, { subtree: 'iframe "Payment"', added: 2, removed: 0 }],
          visible_change_pct: 3.25,
          nothing_visible_changed: false,
          hints: ["page: canvas-heavy", "something new"],
        },
        { url: "https://a.example/next" },
        "click",
      ),
    ).toEqual([
      "URL changed → https://a.example/next",
      "A popup or new tab opened (browser_tab switches to it).",
      "A dialog opened.",
      'Changed: page (+5 −0), button "Save" (+1 −1), iframe "Payment" (+2 −0).',
      "About 3.3% of the screen changed.",
      CANVAS_HINT,
      "Hint: something new",
    ]);
    expect(situationLines({ url_changed: false, dialog_opened: false, popup_opened: false, hints: [] }, {})).toEqual([]);
  });

  test("a find has no line about the screen; what moved on its own is said when it was left out", () => {
    const still = { visible_change_pct: 0, nothing_visible_changed: true, hints: [] };
    expect(situationLines(still, {}, "find")).toEqual([]);
    expect(situationLines({ ...still, visible_change_pct: 4 }, {}, "find")).toEqual([]);
    expect(situationLines(still, {}, "click")[0]).toStartWith("Nothing visible changed — your action may have missed.");
    expect(situationLines({ visible_change_pct: 1.5, moving_excluded_pct: 46.7, hints: [] }, {}, "click")).toEqual([
      "About 1.5% of the screen changed (not counting the 46.7% of the screen that moves on its own: a carousel, a video).",
    ]);
    expect(situationLines({ ...still, moving_excluded_pct: 40 }, {}, "type")[0]).toBe(
      "Nothing visible changed (not counting the 40% of the screen that moves on its own: a carousel, a video) — your action may have missed. Look (browser_screenshot) or try another way; do not just repeat it.",
    );
    expect(pointerLines({ kind: "click", changed_pct: 0.4, moving_excluded_pct: 30 })).toContain(
      "After it: 0.4% of it changed (not counting the 30% of the screen that moves on its own: a carousel, a video).",
    );
  });

  test("after an open a changed URL is no news; a dialog the answer shows is not announced twice", () => {
    expect(situationLines({ url_changed: true, hints: [] }, { url: "https://a.example/" }, "open")).toEqual([]);
    expect(situationLines({ dialog_opened: true }, { dialog: { type: "confirm", message: "Sure?" } })).toEqual([]);
  });

  test("a target's names show only when its own name does not say what was hit: empty, or a container's", () => {
    expect(targetText({ role: "button", name: "", names: ["Place order", "Order summary", "Checkout", "Page"] })).toBe('button (no name) reads "Place order", inside "Order summary" in "Checkout"');
    expect(targetText({ role: "group", name: "Order summary", names: ["Order summary", "Checkout"] })).toBe('group "Order summary" inside "Checkout"');
    expect(targetText({ role: "button", name: "Pay", ref: "e3", names: ["Pay", "Order summary"] })).toBe('button "Pay" [e3]');
    expect(targetText({ role: "generic", name: "", names: [] })).toBe("generic (no name)");
    expect(targetText({ role: "img", name: "", names: "odd" as never })).toBe("img (no name)");
  });

  test("fields of another shape are skipped, never an error", () => {
    expect(situationLines(undefined, {})).toEqual([]);
    expect(situationLines("odd" as never, {})).toEqual([]);
    expect(situationLines({ changes: "lots" as never, hints: [1, "", "ok"] as never, nothing_visible_changed: "yes" as never, url_changed: "x" as never }, {})).toEqual(["Hint: ok"]);
    expect(pointerLines({ target: "x" as never, changed_pct: "9" as never })).toEqual([]);
  });

  test("the prompt's guide to reading the situation", () => {
    expect(BROWSER_SECTION).toContain("Reading the situation: each answer starts with what your action did");
    for (const s of [
      "`browser_screenshot` with marks",
      "`browser_screenshot` with grid, then `browser_pointer`",
      "`browser_pointer` with dry_run says without pressing",
      "`browser_watch`",
      "`browser_find` before scrolling",
      "`browser_select`",
      "A captcha: stop and send the owner the live view link",
      '`browser_press("Escape")`',
    ])
      expect(BROWSER_SECTION).toContain(s);
  });
});
