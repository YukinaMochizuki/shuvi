// The console's own script (same origin; the pages work without it, and without htmx). Copy buttons, j / k to
// move through the turn list, a line when the console cannot be reached, selecting messages to delete
// (below: the "⋯" menu, the pill, the snackbar with its undo; pages.ts `pickable` / `deleteBar`, delete-write.ts),
// the Secrets page's key/value table (kv-table.ts: adding and removing rows, a value's eye) and its rows' "⋯" menus,
// and live pages (the stream from /live that keeps a chat's log, a segment, a turn and the list current; live.ts), and
// last, registering the app's service worker (pwa.ts).
// htmx (html.ts `page`) swaps pages in place, so nothing here holds on to an element of a page: clicks and keys
// are handled on the document, and what a new page needs is done for each piece htmx puts in (`htmx.onLoad`), or
// once without htmx.
"use strict";

// What shows only with script (the "⋯" on a bubble) is styled under `.js`; <html> stays across htmx's swaps.
document.documentElement.classList.add("js");

/** What a page (or a piece swapped into one) needs once it is in: its copy buttons shown, the selected row in view. */
function arrive(root) {
  for (const b of root.querySelectorAll("button.copy[data-copy][hidden]")) b.hidden = false;
  // A whole page in (a load, a boosted swap): its live stream, or none.
  if (root === document || root === document.body || root.querySelector?.("[data-live-page]")) startLive();
  // A select that acts on change (Home's profile switch and Preview chat): its button is for no script only.
  for (const b of root.querySelectorAll("[data-autosubmit-btn]")) b.hidden = true;
  const on = root.querySelector(".rows a.row.on");
  if (on) on.scrollIntoView({ block: "nearest" });
  // A link to one tool call (`#call-<id>`, from Home's history): open that call and bring it into view.
  const hash = decodeURIComponent(location.hash.slice(1));
  const anchor = hash.startsWith("call-") ? document.getElementById(hash) : null;
  const call = anchor?.nextElementSibling;
  if (call instanceof HTMLDetailsElement && root.contains(call)) {
    call.open = true;
    call.classList.add("targeted");
    call.scrollIntoView({ block: "center" });
  }
}

document.addEventListener("click", async (e) => {
  const b = e.target instanceof Element ? e.target.closest("button.copy[data-copy]") : null;
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  const el = document.getElementById(b.dataset.copy);
  if (!el) return;
  try {
    await navigator.clipboard.writeText(el.textContent);
    b.textContent = "copied";
  } catch {
    b.textContent = "copy failed";
  }
  setTimeout(() => (b.textContent = "copy"), 1200);
});

// The Secrets page's key/value table (kv-table.ts): "+ Add a row" puts in its template's row, its fields numbered with
// the table's next index, and focuses its key; a new row's ✕ takes it out. No limit here: the server bounds a write.
document.addEventListener("click", (e) => {
  const t = e.target instanceof Element ? e.target : null;
  const drop = t?.closest(".kvr.kvnew .kvdrop");
  if (drop) return void drop.closest(".kvr").remove();
  const kv = t?.closest("button.kvadd")?.form?.querySelector(".kvtab");
  const tpl = kv?.querySelector("template.kvt");
  if (!tpl) return;
  const i = Number(kv.dataset.next) || 1;
  kv.dataset.next = String(i + 1);
  const row = tpl.content.firstElementChild.cloneNode(true);
  for (const el of row.querySelectorAll("[name]")) el.name = el.name.replace("__i__", String(i));
  kv.insertBefore(row, tpl);
  row.querySelector("input")?.focus();
});

// A masked value's own eye (kv-table.ts): shows or masks that one box again.
document.addEventListener("click", (e) => {
  const eye = e.target instanceof Element ? e.target.closest("button.kveye") : null;
  if (!eye) return;
  const on = eye.getAttribute("aria-pressed") !== "true";
  eye.setAttribute("aria-pressed", String(on));
  eye.title = on ? "Hide this value" : "Show this value";
  eye.setAttribute("aria-label", eye.getAttribute("aria-label").replace(on ? /^show/ : /^hide/, on ? "hide" : "show"));
  eye.closest(".kvvw")?.classList.toggle("on", on);
});

// A profile row's "⋯" menu on the Secrets page (info.ts `rowMenu`): one open at a time, closed by a click outside it or
// Escape (focus back on its ⋯); opened where it fits (`.flip`: from its left edge when the right would leave the page).
function closeRowMenus(except) {
  for (const d of document.querySelectorAll("details.rmenu[open]")) if (d !== except) d.open = false;
}
document.addEventListener("click", (e) => closeRowMenus(e.target instanceof Element ? e.target.closest("details.rmenu") : null));
document.addEventListener(
  "toggle",
  (e) => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement) || !d.matches(".rmenu") || !d.open) return;
    d.classList.remove("flip");
    const list = d.querySelector(".rmenu-list");
    if (list && list.getBoundingClientRect().left < 4) d.classList.add("flip");
  },
  true,
);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const open = document.querySelector("details.rmenu[open]");
  if (!open) return;
  closeRowMenus();
  open.querySelector("summary")?.focus();
});

document.addEventListener("change", (e) => {
  const s = e.target instanceof HTMLSelectElement && e.target.hasAttribute("data-autosubmit") ? e.target : null;
  if (s?.form) s.form.requestSubmit();
});

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
  const step = e.key === "j" ? 1 : e.key === "k" ? -1 : 0;
  if (!step) return;
  const rows = [...document.querySelectorAll(".rows a.row")];
  if (!rows.length) return;
  const on = rows.findIndex((r) => r.classList.contains("on"));
  const next = rows[Math.min(rows.length - 1, Math.max(0, (on < 0 ? -1 : on) + step))];
  // A click, so htmx takes it as it takes the owner's (a plain navigation without htmx).
  if (next && next !== rows[on]) next.click();
});

// ---- deleting messages -------------------------------------------------------------------------------------
// Idle, nothing shows. Hovering a bubble fades in its "⋯" (a long press opens the same menu on a touch screen):
// Select, Delete. Select (or `x` with the pointer over a bubble) starts selecting: the detail gets `.selecting`, every
// bubble a round check, and the pill floats at the bottom ("3 selected · Delete · ✕"); a click toggles a bubble,
// Shift-click selects the range from the last one clicked, `Delete` deletes, `Esc` or ✕ stops. A delete hides the
// bubbles at once and posts in the background; the answer is the deletion's id (the snackbar "Deleted 3 · Undo"
// counts down its window with a thin line) or a refusal (the bubbles come back selected, the pill says why). The
// server holds the deletion for its undo window either way: the countdown here only says how long that is.

const SIDES = { you: "you", her: "her", other: "others" };
let anchor = null; // the seq last clicked, where a Shift-click's range starts
let hovered = null; // the bubble under the mouse, for `x`

const detailOf = (el) => el.closest(".detail");
const picks = (detail) => [...detail.querySelectorAll(".pickable")].filter((p) => !p.classList.contains("gone"));
const csrfOf = (detail) => detail.querySelector(".delui")?.dataset.csrf ?? "";
const typing = (t) => t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);

/** Mark every copy of `seq` on the page (a segment can show a message twice) as (un)selected. */
function setPicked(detail, seq, on) {
  for (const p of detail.querySelectorAll(`.pickable[data-seq="${seq}"]`)) {
    p.classList.toggle("on", on);
    p.querySelector(".dsel")?.setAttribute("aria-pressed", String(on));
  }
}

function selected(detail) {
  const seen = new Map();
  for (const p of picks(detail)) if (p.classList.contains("on")) seen.set(p.dataset.seq, p.dataset.side);
  return seen;
}

/** Selection mode on while anything is selected, and the pill with it: "3 selected", a refusal's reason under it. */
function render(detail, why = "") {
  const sel = selected(detail);
  const on = sel.size > 0;
  const was = detail.classList.contains("selecting");
  detail.classList.toggle("selecting", on);
  for (const b of detail.querySelectorAll(".pickable .dsel")) b.tabIndex = on ? 0 : -1;
  const pill = detail.querySelector(".selpill");
  if (!pill) return;
  const n = { you: 0, her: 0, other: 0 };
  for (const side of sel.values()) n[side] = (n[side] ?? 0) + 1;
  pill.querySelector(".pn").textContent = `${sel.size} selected`;
  pill.title = Object.keys(SIDES).filter((k) => n[k]).map((k) => `${SIDES[k]} ${n[k]}`).join(", ");
  pill.querySelector(".pwhy").textContent = why;
  pill.classList.toggle("refused", !!why);
  pill.hidden = !on;
  if (on && !was) closeMenus();
}

function stopSelecting(detail) {
  for (const p of detail.querySelectorAll(".pickable.on")) setPicked(detail, p.dataset.seq, false);
  anchor = null;
  render(detail);
}

/** A bubble clicked while selecting (or Selected from its menu): toggle it (`on`: to this), or with Shift select the range from the anchor. */
function pick(p, shift, on = !p.classList.contains("on")) {
  const detail = detailOf(p);
  const all = picks(detail);
  const from = anchor === null ? -1 : all.findIndex((x) => x.dataset.seq === anchor);
  if (shift && from >= 0) {
    const to = all.indexOf(p);
    const [a, b] = from < to ? [from, to] : [to, from];
    for (const x of all.slice(a, b + 1)) setPicked(detail, x.dataset.seq, true);
  } else setPicked(detail, p.dataset.seq, on);
  anchor = p.dataset.seq;
  render(detail);
}

function closeMenus(except) {
  for (const d of document.querySelectorAll("details.bmenu[open]")) if (d !== except) d.open = false;
  if (!except) unlift();
}

// ---- a long press on a touch screen: the page dims, the bubble lifts, its menu opens under it ----------------
let press = null; // { p, x, y, timer } while a finger is down on a bubble
let held = false; // the finger that lifted a bubble is still down
let swallow = 0; // until when the click that finger's lifting ends with is not a choice yet

function lift(p) {
  closeMenus();
  p.classList.add("lp");
  const scrim = document.createElement("div");
  scrim.className = "lpscrim";
  document.body.append(scrim);
  const menu = p.querySelector("details.bmenu");
  if (menu) menu.open = true;
  window.getSelection()?.removeAllRanges();
  held = true;
}

function unlift() {
  for (const p of document.querySelectorAll(".pickable.lp")) p.classList.remove("lp");
  for (const s of document.querySelectorAll(".lpscrim")) s.remove();
}

document.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "touch" || !(e.target instanceof Element)) return;
  const p = e.target.closest(".pickable");
  if (!p || e.target.closest(".bmenu, a, button") || p.closest(".selecting")) return;
  press = { p, x: e.clientX, y: e.clientY, timer: setTimeout(() => ((press = null), lift(p)), 500) };
});
const unpress = (e) => {
  if (press) clearTimeout(press.timer);
  press = null;
  if (held && e.type !== "pointermove") {
    held = false;
    swallow = Date.now() + 400;
  }
};
document.addEventListener("pointermove", (e) => press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10 && unpress(e));
document.addEventListener("pointerup", unpress);
document.addEventListener("pointercancel", unpress);
document.addEventListener("contextmenu", (e) => {
  // The long press is the menu: not the browser's as well.
  if (e.target instanceof Element && (press || document.querySelector(".pickable.lp")) && e.target.closest(".pickable, .lpscrim")) e.preventDefault();
});

document.addEventListener("mouseover", (e) => {
  hovered = e.target instanceof Element ? e.target.closest(".pickable") : null;
});

document.addEventListener("click", (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  // The click a long press ends with (when the browser sends one) is not a choice yet.
  if (Date.now() < swallow && !t.closest(".bmenu .menu")) {
    swallow = 0;
    return void e.preventDefault();
  }
  swallow = 0;
  if (t.closest(".lpscrim")) return closeMenus();
  if (!t.closest("details.bmenu")) closeMenus();
  else closeMenus(t.closest("details.bmenu"));
  const menuItem = t.closest(".bmenu .dm-sel, .bmenu .dm-del");
  if (menuItem) {
    const p = menuItem.closest(".pickable");
    closeMenus();
    if (menuItem.classList.contains("dm-sel")) return pick(p, false, true);
    return void remove(detailOf(p), [p.dataset.seq], false);
  }
  if (t.closest(".selpill .px")) return stopSelecting(detailOf(t));
  if (t.closest(".selpill .pdel")) return void remove(detailOf(t), [...selected(detailOf(t)).keys()], true);
  // While selecting, a click on a bubble (its check, or anywhere not a link or a fold in it) toggles it.
  const p = t.closest(".selecting .pickable");
  if (p && (t.closest(".dsel") || !t.closest("a, summary, button, details"))) {
    e.preventDefault();
    pick(p, e.shiftKey);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const menu = document.querySelector("details.bmenu[open]");
    closeMenus();
    if (menu) return void menu.querySelector("summary")?.focus();
    const detail = document.querySelector(".detail.selecting");
    if (detail) stopSelecting(detail);
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
  if (e.key === "x") {
    // The bubble under the pointer, or the one keyboard focus is in.
    const p = (hovered?.isConnected && hovered) || (document.activeElement instanceof Element ? document.activeElement.closest(".pickable") : null);
    if (!p || p.classList.contains("gone")) return;
    e.preventDefault();
    closeMenus();
    return pick(p, e.shiftKey);
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    const detail = document.querySelector(".detail.selecting");
    if (!detail) return;
    e.preventDefault();
    remove(detail, [...selected(detail).keys()], true);
  }
});

async function post(action, fields) {
  const body = new FormData();
  for (const [k, v] of fields) body.append(k, v);
  try {
    const r = await fetch(action, { method: "POST", body, headers: { accept: "application/json" }, credentials: "same-origin" });
    const answer = (r.headers.get("content-type") ?? "").includes("json") ? await r.json() : {};
    if (r.ok) return answer;
    return { refused: answer.refused ?? (r.status === 403 ? "This page is from before a restart of the console: reload it." : `Not done (${r.status}).`) };
  } catch {
    return { refused: "The console is not answering: nothing was deleted." };
  }
}

/** Hide (or bring back) the bubbles of `seqs`, and her reactions to them, which go with them. */
function setGone(detail, seqs, gone) {
  for (const s of seqs) {
    for (const p of detail.querySelectorAll(`.pickable[data-seq="${s}"], .pill[data-target="${s}"]`)) p.classList.toggle("gone", gone);
  }
}

/** Delete `seqs` (the selection, or one bubble from its menu): gone at once, back with the reason if refused. */
async function remove(detail, seqs, fromSelection) {
  if (!detail || !seqs.length) return;
  setGone(detail, seqs, true);
  if (fromSelection) stopSelecting(detail);
  const answer = await post("/messages/delete", [["csrf", csrfOf(detail)], ...seqs.map((s) => ["seq", s])]);
  if (answer.refused) {
    setGone(detail, seqs, false);
    for (const s of seqs) setPicked(detail, s, true);
    return render(detail, answer.refused);
  }
  showSnack(detail, seqs, answer);
}

/** The deletion the snackbar is for, and every message it took on this page: a delete while it is open joins it. */
let snacked = { id: null, seqs: new Set(), turns: new Set(), timer: null };

function hideSnack(snack, detail) {
  clearTimeout(snacked.timer);
  snack.classList.add("fading");
  snacked.timer = setTimeout(() => {
    snack.hidden = true;
    snack.classList.remove("fading");
    detail.classList.remove("snacking");
  }, 300);
}

/** What the snackbar says: "Deleted 3" (messages alone, as before), or the server's words ("Deleted turn 12 and its 5 messages"). */
function snackText(answer) {
  return answer.turnIds?.length && answer.label ? `Deleted ${answer.label}` : `Deleted ${answer.count}`;
}

/** `undone`: what an Undo does once the server has put them back (default: the hidden rows come back). */
function showSnack(detail, deleted, answer, turn, undone) {
  const snack = detail.querySelector(".snack");
  if (!snack) return;
  clearTimeout(snacked.timer);
  // The server joins a delete to the chat's open deletion (store/deletions.ts): one snackbar, one Undo, for all.
  if (snacked.id !== answer.id || snack.hidden) snacked = { id: answer.id, seqs: new Set(), turns: new Set(), timer: null };
  for (const s of deleted) snacked.seqs.add(s);
  if (turn) snacked.turns.add(String(turn));
  const seqs = [...snacked.seqs];
  const turns = [...snacked.turns];
  const what = snack.querySelector(".swhat");
  const undo = snack.querySelector(".sundo");
  what.textContent = snackText(answer);
  snack.classList.remove("refused", "fading");
  undo.hidden = false;
  undo.disabled = false;
  // The thin line runs out with the window, restarted by a delete that joins it.
  const line = snack.querySelector(".sline");
  line.style.animation = "none";
  void line.offsetWidth;
  line.style.animation = `snack-down ${answer.seconds}s linear forwards`;
  undo.onclick = async () => {
    undo.disabled = true;
    const r = await post("/messages/undo", [["csrf", csrfOf(detail)], ["id", String(answer.id)]]);
    if (r.refused) {
      what.textContent = r.refused;
      snack.classList.add("refused");
      undo.hidden = true;
      line.style.animation = "none";
      clearTimeout(snacked.timer);
      snacked.timer = setTimeout(() => hideSnack(snack, detail), 5000);
      return;
    }
    snacked.id = null;
    if (undone) return undone();
    setGone(detail, seqs, false);
    for (const t of turns) setTurnGone(detail, t, [], false);
    hideSnack(snack, detail);
  };
  snack.hidden = false;
  detail.classList.add("snacking");
  // The window is over: the server purges them, they stay off the page; the snackbar fades.
  snacked.timer = setTimeout(() => hideSnack(snack, detail), answer.seconds * 1000);
}

// ---- deleting a turn -------------------------------------------------------------------------------------------
// "Delete turn…" in a divider's ⋯ menu (a chat's log) and "Delete this turn" (the turn page) are links to the
// confirmation page (`/turns/<id>/delete`, pages.ts `turnDeletePage`); with script its panel is fetched and opened in
// place instead: under the divider, or under the turn page's header. Cancel closes it. Its Delete posts in the
// background (`/turns/delete`, delete-write.ts); the turn leaves the page at once (its divider, every bubble it
// answered or wrote) and the snackbar offers the Undo, joined with any message deleted just before or after it. A
// refusal says why in the panel, which stays open.

/** Where a turn's panel opens: under the divider's row in a chat's log, else under the turn page's header. */
function confirmSpot(link) {
  const divider = link.closest(".divider");
  if (divider) return divider.closest(".lb") ?? divider;
  const head = link.closest(".head");
  return head?.closest(".lb") ?? head;
}

async function openTurnConfirm(link) {
  const spot = confirmSpot(link);
  const detail = detailOf(link);
  if (!spot || !detail) return false;
  for (const old of document.querySelectorAll(".tconfirm.inplace")) old.remove();
  let panel = null;
  try {
    const r = await fetch(link.href, { credentials: "same-origin" });
    if (r.ok) panel = new DOMParser().parseFromString(await r.text(), "text/html").querySelector(".tconfirm");
  } catch {}
  if (!panel) return false;
  panel = document.importNode(panel, true);
  panel.classList.add("inplace");
  spot.after(panel);
  panel.scrollIntoView({ block: "nearest" });
  panel.querySelector("button[type=submit], a.tcancel")?.focus({ preventScroll: true });
  return true;
}

document.addEventListener("click", async (e) => {
  const t = e.target instanceof Element ? e.target : null;
  const cancel = t?.closest(".tconfirm.inplace a.tcancel");
  if (cancel) {
    e.preventDefault();
    return void cancel.closest(".tconfirm").remove();
  }
  const link = t?.closest("a.dm-tdel, a.tdelbtn");
  if (!link || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  e.stopPropagation();
  closeMenus();
  // Not opened in place (the console not answering): the confirmation page itself.
  if (!(await openTurnConfirm(link))) location.href = link.href;
});

/** The turn's rows in a chat's log: its divider(s), and the bubbles of `seqs` (what it answered and wrote). */
function setTurnGone(detail, turn, seqs, gone) {
  for (const d of detail.querySelectorAll(`.divider[data-turn="${turn}"]`)) d.classList.toggle("gone", gone);
  setGone(detail, seqs, gone);
}

/** The page as a load now draws it, in place of this one (no reload: the tab keeps its scroll of the list); live again. */
async function swapPage() {
  stopLive();
  let split = null;
  try {
    const r = await fetch(location.href, { credentials: "same-origin" });
    const doc = new DOMParser().parseFromString(await r.text(), "text/html");
    split = doc.querySelector(".split");
    if (split) document.title = doc.title;
  } catch {}
  const here = document.querySelector(".split");
  if (!split || !here) return false;
  here.replaceWith(document.importNode(split, true));
  arrive(document.body);
  return true;
}

/**
 * The turn page once its turn is deleted: the page as a load would now draw it (the plain "no such turn", the list
 * without its segment) in place of this one, the snackbar on it. Its Undo loads the turn page again.
 */
async function becomeGone(answer) {
  if (!(await swapPage())) return void location.reload();
  const detail = document.querySelector(".detail-pane .detail");
  if (detail) showSnack(detail, [], answer, null, () => location.reload());
}

document.addEventListener("submit", async (e) => {
  const form = e.target instanceof HTMLFormElement ? e.target : null;
  const panel = form?.closest(".tconfirm.inplace");
  if (!panel) return;
  e.preventDefault();
  const detail = detailOf(panel);
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  const csrf = csrfOf(detail) || form.querySelector("input[name=csrf]")?.value || "";
  const answer = await post("/turns/delete", [["csrf", csrf], ["turn", panel.dataset.turn]]);
  if (answer.refused) {
    button.disabled = false;
    let why = panel.querySelector(".row-note.refused");
    if (!why) {
      why = document.createElement("p");
      why.className = "row-note refused";
      why.setAttribute("role", "alert");
      form.before(why);
    }
    why.textContent = answer.refused;
    return;
  }
  panel.remove();
  // On the turn's own page, nothing of it is left to show.
  if (detail.querySelector(".turnpanel")) return void becomeGone(answer);
  const seqs = answer.seqs.map(String);
  setTurnGone(detail, panel.dataset.turn, seqs, true);
  showSnack(detail, seqs, answer, panel.dataset.turn);
});

// ---- live pages ------------------------------------------------------------------------------------------------
// A page drawn with `data-live-page` (pages.ts `split`: a chat's log, a segment, a conversation, a turn) opens an
// EventSource on /live for itself (live.ts). It says what it has: the name and hash of each part that may still change
// (`.lb[data-live]`) and of every trace part after the first of those, and its trace's last part; it gets back the
// parts that differ, drawn by the same code as the page. A part is put in place row by row: a row that did not change
// stays as it is (with what the reader opened or selected in it), a changed row takes the place of the old one (a
// details it had open stays open), new rows go in. A row holding a deleted bubble waiting for its undo (`.gone`) is
// never taken out: the undo brings it back. After an error the stream is opened again from what the page has then (no
// gap, nothing twice), unless the page is no longer live or the sign-in ended (asked with `probe=1`). The view
// follows new rows only when the reader is at the bottom; else "↓ N new". Nothing live ever reloads a page by itself
// while it holds an undo or a selection, or moves it: what needs a load (a newer segment on /turns, a deploy, a
// stopped stream) is said in a quiet bar (`.livebar`) with the button that does it.

const assetsOurs = document.querySelector('meta[name="assets"]')?.content ?? "";
/** This tab, for as long as this script runs in it: its next page's stream replaces its last one (live.ts, the cap). */
const tabId = Math.random().toString(36).slice(2, 12);
const live = { es: null, page: "", timer: null, backoff: 1000, bye: false, fresh: 0 };
/** A row → the HTML the server drew it with, before this script touched it (what the next frame is compared with). */
const drawn = new WeakMap();

/**
 * A row's HTML as drawn, to compare with the next frame's: copy buttons hidden again (`arrive` shows them), and
 * `<noscript>` emptied (a page htmx swapped in has it parsed as elements, one parsed here as text).
 */
function pristine(el) {
  const c = el.cloneNode(true);
  for (const b of c.querySelectorAll("button.copy[data-copy]")) b.hidden = true;
  for (const n of c.querySelectorAll("noscript")) n.textContent = "";
  return c.outerHTML;
}

function stopLive() {
  clearTimeout(live.timer);
  live.timer = null;
  live.es?.close();
  live.es = null;
}

/** The quiet bar: what the page cannot do by itself, and the button that does it (none: `text` alone). */
function liveBar(text, label, act) {
  for (const b of document.querySelectorAll(".livebar")) b.remove();
  const detail = document.querySelector(".detail-pane .detail");
  if (!detail) return;
  const bar = document.createElement("div");
  bar.className = "livebar";
  bar.setAttribute("role", "status");
  const t = document.createElement("span");
  t.textContent = text;
  bar.append(t);
  if (label) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.onclick = () => {
      bar.remove();
      act();
    };
    bar.append(b);
  }
  detail.append(bar);
}

/** A page that may lose something to a load: a pending delete's Undo, a selection. */
const holding = () => !!document.querySelector(".snack:not([hidden]), .detail.selecting");

function startLive() {
  stopLive();
  const root = document.querySelector("[data-live-page]");
  if (!root || !window.EventSource) return;
  live.page = root.dataset.livePage;
  live.bye = false;
  live.backoff = 1000;
  live.fresh = 0;
  for (const part of document.querySelectorAll(".lb[data-k]")) for (const row of part.children) if (!drawn.has(row)) drawn.set(row, pristine(row));
  connect();
}

/** What the page has (live.ts "the cursor is the page"): its live parts, and its trace from the first live one on. */
function pageState() {
  const have = [];
  for (const p of document.querySelectorAll(".lb[data-k][data-live]")) if (!p.parentElement?.matches('[data-region="trace"]')) have.push(`${p.dataset.k}.${p.dataset.h}`);
  const trace = [...document.querySelectorAll('[data-region="trace"] > .lb[data-k]')];
  const from = trace.findIndex((p) => p.hasAttribute("data-live"));
  if (from >= 0) for (const p of trace.slice(from)) have.push(`${p.dataset.k}.${p.dataset.h}`);
  return { have: have.join(","), last: trace.length ? trace[trace.length - 1].dataset.k : "" };
}

function connect() {
  const q = new URLSearchParams({ page: live.page, v: assetsOurs, tab: tabId, ...pageState() });
  const es = new EventSource(`/live?${q}`);
  live.es = es;
  es.addEventListener("hello", (e) => {
    live.backoff = 1000;
    // This sign-in's CSRF token as the server now derives it: after a restart (a new secret), the page's deletes still pass.
    const { csrf } = JSON.parse(e.data);
    if (!csrf) return;
    for (const d of document.querySelectorAll(".delui[data-csrf]")) d.dataset.csrf = csrf;
    for (const i of document.querySelectorAll('input[name="csrf"]')) i.value = csrf;
  });
  es.addEventListener("ops", (e) => apply(JSON.parse(e.data)));
  es.addEventListener("bye", () => {
    // Too many pages of this sign-in open: this one rests until asked (which closes the oldest other).
    live.bye = true;
    stopLive();
    liveBar("Live updates paused (too many pages open)", "Resume", () => {
      live.bye = false;
      connect();
    });
  });
  es.addEventListener("reload", () => {
    // A deploy since this page loaded (its stylesheet and scripts are old). Loaded again, once, unless that would
    // cost an undo or a selection, or it was just tried: then the page says so and waits for the reader.
    stopLive();
    const last = Number(sessionStorage.getItem("shuvi.liveReload") ?? 0);
    if (holding() || Date.now() - last < 15_000) return void liveBar("The console was updated: live updates stopped", "Reload", () => location.reload());
    sessionStorage.setItem("shuvi.liveReload", String(Date.now()));
    location.reload();
  });
  es.onerror = async () => {
    // EventSource would reconnect by itself, but saying what the page had when it first connected: reconnect from now,
    // unless the page is no longer live (204) or the sign-in ended (401, 403).
    es.close();
    if (live.es !== es) return;
    live.es = null;
    if (live.bye) return;
    let status = 0;
    try {
      status = (await fetch(`/live?${new URLSearchParams({ page: live.page, probe: "1" })}`, { credentials: "same-origin" })).status;
    } catch {}
    if (live.es || live.bye || document.querySelector("[data-live-page]")?.dataset.livePage !== live.page) return;
    if (status === 204 || status === 401 || status === 403) return void liveBar("Live updates stopped", "Reload", () => location.reload());
    live.timer = setTimeout(connect, live.backoff);
    live.backoff = Math.min(live.backoff * 2, 30_000);
  };
}

/** What scrolls the detail: its pane when it scrolls (wide screens), else the page (narrow ones, or a short page). */
function scroller() {
  const pane = document.querySelector(".detail-pane");
  return pane && /(auto|scroll)/.test(getComputedStyle(pane).overflowY) && pane.scrollHeight > pane.clientHeight + 1 ? pane : document.scrollingElement;
}
const atBottom = (sc) => sc.scrollHeight - sc.scrollTop - sc.clientHeight < 48;

/** Open or selected state kept from the row a new one replaces. */
function carry(old, row) {
  // A list group keeps its fold even when its class changes (a failure marked, cleared).
  if (old.tagName === "DETAILS" && row.tagName === "DETAILS" && old.classList[0] === row.classList[0]) row.open = old.open;
  const sameStep = old.querySelector(":scope > .at")?.textContent === row.querySelector(":scope > .at")?.textContent;
  const theirs = row.querySelectorAll("details");
  old.querySelectorAll("details").forEach((d, i) => {
    const m = d.id ? row.querySelector(`details#${CSS.escape(d.id)}`) : sameStep ? theirs[i] : null;
    if (m && m.className === d.className) m.open = d.open;
  });
  for (const p of old.querySelectorAll(".pickable.on")) {
    for (const q of row.querySelectorAll(`.pickable[data-seq="${p.dataset.seq}"]`)) {
      q.classList.add("on");
      q.querySelector(".dsel")?.setAttribute("aria-pressed", "true");
    }
  }
}

/** Bring `part`'s rows to `fresh`'s; how many rows it gained. */
function morph(part, fresh) {
  const olds = [...part.children];
  const news = [...fresh.children];
  let j = 0;
  let added = 0;
  const drop = (el) => {
    // A deleted bubble waiting for its undo stays (hidden) where it was, for the undo to bring back.
    if (el.matches(".gone") || el.querySelector(".gone")) return;
    el.remove();
    added--;
  };
  for (const row of news) {
    const s = pristine(row);
    let m = -1;
    for (let x = j; x < olds.length; x++) {
      if (drawn.get(olds[x]) === s) {
        m = x;
        break;
      }
    }
    if (m >= 0) {
      for (let x = j; x < m; x++) drop(olds[x]);
      j = m + 1;
      continue;
    }
    drawn.set(row, s);
    if (olds[j]) carry(olds[j], row);
    part.insertBefore(row, olds[j] ?? null);
    added++;
  }
  for (let x = j; x < olds.length; x++) drop(olds[x]);
  return Math.max(0, added);
}

/** A part's name, version and liveness as the stream says. */
function mark(el, op) {
  el.dataset.k = op.k;
  el.dataset.h = op.h;
  el.toggleAttribute("data-live", !!op.live);
}

/** One frame's ops (live.ts `Op`). */
function apply(ops) {
  // A stream for a page that is no longer the one shown (a swap it was not closed for): its ops are not this page's.
  if (document.querySelector("[data-live-page]")?.dataset.livePage !== live.page) return void startLive();
  const sc = scroller();
  const bottom = atBottom(sc);
  let added = 0;
  for (const op of ops) {
    if (op.newer) {
      // On /turns, a newer segment is what a load would show now: offered, never loaded by itself.
      liveBar("New activity", "Show", () => location.assign(live.page));
      continue;
    }
    if (op.swap) {
      // The turn (segment, conversation) was deleted, or its deletion undone, in this tab or another: a load shows
      // the other page now. Put in place, unless that would cost an undo or a selection: then offered.
      if (holding()) liveBar("This page has changed", "Show", () => location.reload());
      else void swapPage();
      return;
    }
    const region = op.in ? document.querySelector(`[data-region="${op.in}"]`) : null;
    if (op.order) {
      // The list's groups in the order of last activity (moved, not drawn again: a fold stays as it was).
      const now = region ? [...region.children].filter((c) => c.matches(".lb")) : [];
      if (now.map((c) => c.dataset.k).join() === op.order.join()) continue;
      for (const k of op.order) {
        const g = region.querySelector(`:scope > .lb[data-k="${k}"]`);
        if (g) region.append(g);
      }
      continue;
    }
    const el = document.querySelector(`.lb[data-k="${op.k}"]`);
    if (op.rm) {
      if (el && !el.querySelector(".gone")) el.remove();
      continue;
    }
    const tpl = document.createElement("template");
    tpl.innerHTML = op.html;
    if (el) {
      const n = morph(el, tpl.content);
      if (op.in === "trace") added += n;
      mark(el, op);
      settle(el);
      continue;
    }
    if (!region) continue;
    const part = document.createElement("div");
    part.className = "lb";
    mark(part, op);
    for (const row of tpl.content.children) drawn.set(row, pristine(row));
    part.append(tpl.content);
    const after = op.after ? region.querySelector(`:scope > .lb[data-k="${op.after}"]`) : null;
    if (after) after.after(part);
    else if (op.after) region.append(part);
    else region.prepend(part);
    if (op.in === "trace") added += part.children.length;
    settle(part);
  }
  const now = scroller();
  if (bottom) now.scrollTop = now.scrollHeight;
  else if (added) {
    live.fresh += added;
    newPill();
  }
}

/** What a part put in needs: copy buttons shown, links and forms boosted. */
function settle(el) {
  for (const b of el.querySelectorAll("button.copy[data-copy][hidden]")) b.hidden = false;
  window.htmx?.process(el);
}

/** "↓ N new" at the bottom of the detail while the reader is scrolled up. */
function newPill() {
  const detail = document.querySelector(".detail-pane .detail");
  if (!detail) return;
  let b = detail.querySelector(".livenew");
  if (!b) {
    b = document.createElement("button");
    b.type = "button";
    b.className = "livenew";
    detail.append(b);
  }
  b.textContent = `↓ ${live.fresh} new`;
  b.hidden = live.fresh === 0;
}

function clearNew() {
  live.fresh = 0;
  for (const b of document.querySelectorAll(".livenew")) b.hidden = true;
}

document.addEventListener("click", (e) => {
  if (!(e.target instanceof Element) || !e.target.closest(".livenew")) return;
  const sc = scroller();
  sc.scrollTo({ top: sc.scrollHeight, behavior: "smooth" });
  clearNew();
});
document.addEventListener("scroll", () => live.fresh && atBottom(scroller()) && clearNew(), { capture: true, passive: true });
// Leaving the page (or into the back-forward cache): the stream ends; back from the cache, it opens again.
window.addEventListener("pagehide", stopLive);
window.addEventListener("pageshow", (e) => e.persisted && startLive());

if (window.htmx) {
  window.htmx.onLoad(arrive);
  // A boosted navigation swaps the body (htmx:load fires for what is in it, not for it): the new page's stream, or none.
  document.addEventListener("htmx:afterSettle", (e) => e.detail.target === document.body && startLive());
  // A part of a page that fetches itself (settings.ts `polls`) takes only its own answer: an error or the sign-in
  // page is a whole page, which must not land inside it. It is left as it was and asks again next time.
  document.addEventListener("htmx:beforeSwap", (e) => {
    if (e.detail.xhr.status >= 300 && e.detail.target instanceof Element && e.detail.target.hasAttribute("data-poll")) e.detail.shouldSwap = false;
  });
  // A deploy since this page loaded: a boosted swap keeps this head, so the new page would run against the old
  // stylesheet and scripts. When a whole page's `<meta name="assets">` (html.ts `page`, assets.ts) differs from
  // ours, load it in full instead. Only for a GET, which can be asked again; a write's answer is swapped in as it
  // is, and the next navigation loads in full.
  const ours = assetsOurs;
  document.addEventListener("htmx:beforeSwap", (e) => {
    const d = e.detail;
    if (!ours || !d.boosted || d.requestConfig?.verb !== "get") return;
    const theirs = /<meta name="assets" content="([0-9a-f]+)">/.exec(d.xhr.responseText)?.[1];
    if (!theirs || theirs === ours) return;
    d.shouldSwap = false;
    location.assign(d.xhr.responseURL || d.pathInfo?.finalRequestPath || location.href);
  });
  // A request that got no answer at all (the server restarting, the tailnet down): say so, until one does.
  const offline = (on) => document.body.classList.toggle("offline", on);
  document.addEventListener("htmx:sendError", () => offline(true));
  document.addEventListener("htmx:afterRequest", (e) => e.detail.xhr?.status && offline(false));
} else document.addEventListener("DOMContentLoaded", () => arrive(document));

// The app's service worker (pwa.ts): it answers only a page load that cannot reach the console, with its offline
// page. Registering again on every load is what the browser expects; it fetches /sw.js and changes nothing unless
// that changed.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
