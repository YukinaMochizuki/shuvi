import type { ToolContent } from "agent-runtime";
import { FILE_KEY, type BrowseAnswer, type BrowseBox, type BrowseImage, type BrowseSituation, type BrowseTarget, type Porchkit } from "../../porchkit/client.ts";
import type { Db } from "../../store/db.ts";
import { kvGet, kvSet } from "../../store/events.ts";

/**
 * Seeing past the accessibility tree: how an answer tells the model its situation, and the images it carries
 * (porchkit's shapes; every field is still read loosely, a field of another shape skipped, never an error).
 *
 *   situation  every act answer's `situation` becomes a few lines at the TOP: the URL changed (not after an
 *              open, which is the point of it), a popup opened, a dialog opened (when the answer does not show the
 *              dialog itself), what changed where (`changes[].subtree`), how much of the screen changed (leaving out
 *              what moved on its own just before, a carousel or a video: `moving_excluded_pct`, said when there was
 *              any), that nothing visible changed (the action may have missed; never after a find, which only reads:
 *              `READS`), and porchkit's hints verbatim with what to do.
 *   pointer    `target` (or, with dry_run, only that), `settled` / `settle_ms`, `changed_pct`, `changed_bbox`; a
 *              pointer answer has no page text, and says the last one's refs still hold.
 *   find       `matches[].line` (the page text's own line) and where it is, out of `total`; the matches' refs hold
 *              from then on, as a page text's do, and a line of text has none (act on what it is in). A `within`
 *              match holds every word in the lines under it, not in its own.
 *   images     `screenshot`, `closeup`, `zoom`, `sheet` are fetched from `/files/<key>` with the token and returned
 *              as image blocks, each after a line saying what it is and its pixel size. Coordinates for
 *              browser_pointer are in the pixels of the LAST SCREENSHOT the model was shown: its width is kept per
 *              chat (kv `browser_shot:<chat>`) and sent as `image_width`; a zoom, a close-up or a watch sheet is
 *              never that reference, and says so.
 */

const lastShotKey = (chatId: number) => `browser_shot:${chatId}`;

/** A screenshot of this width was shown to the model: browser_pointer's coordinates are in its pixels now. */
export function rememberShot(db: Db, chatId: number, width: number | null | undefined): void {
  if (num(width)) kvSet(db, lastShotKey(chatId), String(width));
}

/** The width of the last screenshot this chat's model was shown (browser_pointer's `image_width`). */
export function lastShotWidth(db: Db, chatId: number): number | undefined {
  const v = Number(kvGet(db, lastShotKey(chatId)));
  return v > 0 ? v : undefined;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const pct = (v: number) => `${Math.round(v * 10) / 10}%`;
const box = (b: unknown): BrowseBox | undefined => {
  if (!b || typeof b !== "object") return undefined;
  const o = b as Record<string, unknown>;
  const [x, y, w, h] = [num(o.x), num(o.y), num(o.w), num(o.h)];
  return x !== undefined && y !== undefined && w !== undefined && h !== undefined ? { x, y, w, h } : undefined;
};
const boxText = (b: BrowseBox) => `x ${b.x}, y ${b.y}, ${b.w}×${b.h}`;

/** What to do about a hint, by its kind (the part before the colon). The hint itself is shown verbatim. */
function hintAdvice(hint: string): string {
  const h = hint.toLowerCase();
  if (h.startsWith("page: canvas"))
    return "part of this page is drawn (a map, a canvas); the page text and refs still work for everything else. Only if what you need is not in the page text: browser_screenshot with grid, then browser_pointer";
  if (h.startsWith("blocked-by: captcha")) return "stop here: send the owner the live view link (browser_status) and ask him to get past it";
  if (h.startsWith("blocked-by")) return "something stands in the way: look (browser_screenshot) before acting";
  if (h.startsWith("native-popup")) return 'a browser popup is open: browser_press("Escape")';
  if (h.startsWith("password-manager: password menu hidden"))
    return 'only if the owner himself asked for this: browser_press("ArrowDown") until a hint says the focus is in 1Password, then browser_press("Enter") takes its first entry (the suggested password on a new-password field); you cannot and need not see it';
  if (h.startsWith("password-manager: locked")) return "1Password is locked: send the owner the live view link (browser_status) and ask him to unlock it";
  if (h.startsWith("password-manager: sign-in offer"))
    return "only if the owner himself asked for this, take it (Enter while the focus is in 1Password, or browser_pointer on its sign-in button); otherwise leave it and use the page: it closes once the page is used";
  if (h.startsWith("password-manager: focus is in 1Password"))
    return 'keys go to 1Password now: only on the owner\'s own request use them there; otherwise click the page\'s field by its ref to take the focus back, or browser_press("Escape")';
  if (h.startsWith("password-manager:"))
    return 'only if the owner himself asked for this, use it (browser_screenshot to see it); otherwise ignore it: type into the page\'s field as text and click the page\'s own buttons by ref (arrow keys, Enter and Tab would go to its menu)';
  if (h.startsWith("page: may still be loading"))
    return "the page was still loading when this was read, so what you see may be the old content: browser_wait (1–2 s) and read what changed before acting on it";
  return "";
}

/** A find only reads the page: nothing it did could have missed, so no line about what changed on the screen. */
const READS: ReadonlySet<string> = new Set(["find"]);

/** " (not counting the 40% of the screen that moves on its own)", when porchkit left some out. */
function movingText(v: unknown): string {
  const m = num(v);
  return m !== undefined && m > 0 ? ` (not counting the ${pct(m)} of the screen that moves on its own: a carousel, a video)` : "";
}

/**
 * The situation lines for the top of an answer (none when nothing is worth saying). `action`: the act it answers
 * (after `open` a changed URL is no news; after a read, nothing on the screen is); a dialog the answer shows itself
 * (`dialog`) is not announced twice.
 */
export function situationLines(s: BrowseSituation | null | undefined, a: Pick<BrowseAnswer, "url" | "dialog">, action?: string): string[] {
  if (!s || typeof s !== "object") return [];
  const out: string[] = [];
  if (s.url_changed === true && action !== "open") out.push(`URL changed → ${a.url ?? "(a new page)"}`);
  if (s.popup_opened === true) out.push("A popup or new tab opened (browser_tab switches to it).");
  if (s.dialog_opened === true && !a.dialog) out.push("A dialog opened.");
  const changes = Array.isArray(s.changes) ? s.changes.filter((c) => c && typeof c === "object") : [];
  if (changes.length) out.push(`Changed: ${changes.map((c) => `${str(c.subtree) ?? "page"} (+${num(c.added) ?? 0} −${num(c.removed) ?? 0})`).join(", ")}.`);
  const visible = num(s.visible_change_pct);
  const read = action !== undefined && READS.has(action);
  if (!read && visible !== undefined && visible > 0) out.push(`About ${pct(visible)} of the screen changed${movingText(s.moving_excluded_pct)}.`);
  if (!read && s.nothing_visible_changed === true)
    out.push(`Nothing visible changed${movingText(s.moving_excluded_pct)} — your action may have missed. Look (browser_screenshot) or try another way; do not just repeat it.`);
  for (const h of Array.isArray(s.hints) ? s.hints : []) {
    const hint = str(h);
    if (!hint) continue;
    const advice = hintAdvice(hint);
    out.push(`Hint: ${hint}${advice ? ` — ${advice}.` : ""}`);
  }
  return out;
}

/** A target as the model reads it: `button "Pay" [e7] (inside a canvas)`. */
export function targetText(t: BrowseTarget | null | undefined): string | undefined {
  if (!t || typeof t !== "object") return undefined;
  const what = [str(t.role), str(t.name) ? `"${t.name}"` : "(no name)"].filter(Boolean).join(" ");
  return `${what}${str(t.ref) ? ` [${t.ref}]` : ""}${namesText(t)}${t.in_canvas === true ? " (inside a canvas)" : ""}`;
}

/** Roles that name a region, not a control: their own name says little about what was hit. */
const CONTAINERS = new Set(["generic", "group", "region", "section", "main", "article", "document", "list", "listitem", "row", "cell", "gridcell", "table", "form", "dialog", "canvas", "none", "presentation"]);

/**
 * The target's `names` (the hit node's text, then its ancestors' names), when its own name does not say what was
 * hit (empty, or a container's): ` reads "Place order", inside "Order summary"`. At most three, no repeats.
 */
function namesText(t: BrowseTarget): string {
  const own = str(t.name);
  if (own && !CONTAINERS.has((str(t.role) ?? "").toLowerCase())) return "";
  const all = (Array.isArray(t.names) ? t.names : []).map(str).filter((n): n is string => !!n);
  const names = all.filter((n, i) => all.indexOf(n) === i);
  const quote = (n: string) => `"${n.length > 60 ? `${n.slice(0, 59)}…` : n}"`;
  // With a name of its own, that is the hit text already shown: the rest are where it is.
  const hit = own ? undefined : names[0];
  const inside = names.filter((n) => n !== own && n !== hit).slice(0, 2);
  return `${hit ? ` reads ${quote(hit)}` : ""}${inside.length ? `${hit ? "," : ""} inside ${inside.map(quote).join(" in ")}` : ""}`;
}

/** A pointer's lines: what was under the point, and what the action did (a ref act's answer has none of it). */
export function pointerLines(a: BrowseAnswer): string[] {
  const out: string[] = [];
  const target = targetText(a.target);
  if (a.dry_run === true) return [`Dry run: nothing was pressed. Under the point: ${target ?? "nothing known"}.`];
  if (target) out.push(`Under the pointer: ${target}.`);
  const to = a.target && typeof a.target === "object" ? targetText(a.target.to) : undefined;
  if (to) out.push(`Dragged to: ${to}.`);
  const bits: string[] = [];
  const ms = num(a.settle_ms);
  if (a.settled === true) bits.push(`the page settled${ms !== undefined ? ` in ${Math.round(ms)} ms` : ""}`);
  if (a.settled === false) bits.push("the page had not settled (it may still be moving: browser_watch, or look again)");
  const changed = num(a.changed_pct);
  if (changed !== undefined) {
    const b = box(a.changed_bbox);
    bits.push((changed > 0 ? `${pct(changed)} of it changed${b ? ` (around ${boxText(b)})` : ""}` : "nothing on it changed") + movingText(a.moving_excluded_pct));
  }
  if (bits.length) out.push(`After it: ${bits.join("; ")}.`);
  if (a.kind && !a.snapshot) out.push("(The page text was not read again: the last page text's refs still hold.)");
  return out;
}

/** browser_find's matches, or null when the answer is not a find's. */
export function matchLines(a: BrowseAnswer): string[] | null {
  if (!Array.isArray(a.matches)) return null;
  if (!a.matches.length) return [`No element matches${str(a.query) ? ` "${a.query}"` : " that"} on this page.`];
  const total = num(a.total);
  const lines = a.matches.map((m) => {
    const line = str(m.line) ?? (str(m.ref) ? `[${m.ref}]` : "(a match)");
    const withRef = str(m.ref) && !line.includes(`[${m.ref}]`) ? `[${m.ref}] ${line}` : line;
    const first = str(m.ref)?.split(" ")[0];
    const within = m.within === true ? ` — the words are in its lines${first ? ` (browser_snapshot with ref ${first} reads them)` : ""}` : "";
    return `${withRef}${str(m.context) ? ` — in ${m.context}` : ""}${within}`;
  });
  return [
    `${total !== undefined && total > a.matches.length ? `${a.matches.length} of ${total} matches` : `${a.matches.length} match${a.matches.length === 1 ? "" : "es"}`}${str(a.query) ? ` for "${a.query}"` : ""} (act on a ref; a line of text has none, act on what it is in):`,
    ...lines,
  ];
}

/** Lines for what some acts add: a cut page text, a wait, a select, a screenshot's marks and grid. */
export function extraLines(a: BrowseAnswer): string[] {
  const out: string[] = [];
  const next = num(a.next_offset);
  if (next !== undefined)
    out.push(
      a.snapshot_kind === "delta"
        ? `(The whole page text is cut after ${next} lines: browser_snapshot with offset ${next} reads what comes after the cut.)`
        : `(The page text was cut: browser_snapshot with offset ${next} reads on.)`,
    );
  if (a.wait_for && typeof a.wait_for === "object") {
    const s = num(a.wait_for.seconds);
    out.push(a.wait_for.met === false ? `Waited${s !== undefined ? ` ${s}s` : ""}: it did not happen.` : `Waited${s !== undefined ? ` ${s}s` : ""}: it happened.`);
  }
  if (a.select && typeof a.select === "object") {
    const sel = str(a.select.selected);
    const value = str(a.select.value);
    out.push(`Selected${sel ? ` "${sel}"` : ""}${value && value !== sel ? ` (value ${value})` : ""}.`);
  }
  if (Array.isArray(a.marks) && a.marks.length) {
    out.push("Marked on the screenshot (in its pixels):");
    for (const m of a.marks.slice(0, 80)) {
      const b = box(m);
      out.push(`  ${str(m.ref) ? `[${m.ref}] ` : ""}${str(m.role) ?? "element"} "${m.name ?? ""}"${b ? ` at ${boxText(b)}` : ""}`);
    }
    if (a.marks.length > 80) out.push(`  … and ${a.marks.length - 80} more`);
  }
  return out;
}

type ImageField = "screenshot" | "closeup" | "zoom" | "sheet";
const sizeOf = (i: BrowseImage) => (num(i.width) && num(i.height) ? `${i.width}×${i.height}` : "size not given");
const NOT_FOR_POINTER = "for browser_pointer use the screenshot's pixels, not these";

/** The caption before each image: what it is and its size. */
function caption(field: ImageField, a: BrowseAnswer, img: BrowseImage): string {
  switch (field) {
    case "screenshot":
      return `Screenshot (coordinates are in this image's pixels: ${sizeOf(img)}${num(a.grid) ? `; grid every ${a.grid} px` : ""}):`;
    case "closeup": {
      const c = a.closeup!;
      const b = box(c);
      return `Close-up${b ? ` of ${boxText(b)}` : " around the point"}${num(c.factor) ? ` at ×${c.factor}` : ""} (${sizeOf(img)}; ${NOT_FOR_POINTER}):`;
    }
    case "zoom": {
      const b = box(a.region);
      return `Zoomed region${b ? ` ${boxText(b)}` : ""}${num(a.factor) ? ` at ×${a.factor}` : ""} (${sizeOf(img)}; ${NOT_FOR_POINTER}):`;
    }
    case "sheet": {
      const ts = Array.isArray(a.tiles) ? a.tiles.map((t) => num(t?.t)).filter((t): t is number => t !== undefined) : [];
      const changed = num(a.changed_pct);
      const urls = Array.isArray(a.urls) ? a.urls.map(str).filter((u): u is string => !!u) : [];
      const distinct = urls.filter((u, i) => urls.indexOf(u) === i);
      const went = distinct.length > 1 ? `; the page went ${distinct.slice(0, 4).join(" → ")}${distinct.length > 4 ? " → …" : ""}` : "";
      return `Frames over time, in order${ts.length ? ` (${ts.length} frames at ${ts.map((t) => `${Math.round(t * 10) / 10}s`).join(", ")})` : ""} (${sizeOf(img)})${changed !== undefined ? `; ${pct(changed)} changed over them` : ""}${went}:`;
    }
  }
}

/**
 * The images an answer carries, fetched and captioned; a screenshot's width becomes the chat's pointer reference.
 * One that cannot be fetched is a line saying so, never an error for the whole answer.
 */
export async function imagesOf(porch: Porchkit, db: Db, chatId: number, a: BrowseAnswer): Promise<ToolContent[]> {
  const out: ToolContent[] = [];
  for (const field of ["screenshot", "closeup", "zoom", "sheet"] as const) {
    const img = a[field];
    if (!img || typeof img !== "object" || !str(img.key) || !FILE_KEY.test(img.key)) continue;
    try {
      const f = await porch.file(img.key);
      const mime = f.type?.startsWith("image/") ? f.type.split(";")[0]! : "image/png";
      out.push({ type: "text", text: caption(field, a, img) });
      out.push({ type: "image", data: Buffer.from(f.bytes).toString("base64"), mimeType: mime });
      if (field === "screenshot") rememberShot(db, chatId, img.width);
    } catch {
      out.push({ type: "text", text: `(The ${field} could not be read back.)` });
    }
  }
  return out;
}
