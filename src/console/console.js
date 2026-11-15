// The console's own script (same origin; the pages work without it, and without htmx). Copy buttons, j / k to
// move through the turn list, a line when the console cannot be reached, and selecting messages to delete
// (below: the "⋯" menu, the pill, the snackbar with its undo; pages.ts `pickable` / `deleteBar`, delete-write.ts).
// htmx (html.ts `page`) swaps pages in place, so nothing here holds on to an element of a page: clicks and keys
// are handled on the document, and what a new page needs is done for each piece htmx puts in (`htmx.onLoad`), or
// once without htmx.
"use strict";

// What shows only with script (the "⋯" on a bubble) is styled under `.js`; <html> stays across htmx's swaps.
document.documentElement.classList.add("js");

/** What a page (or a piece swapped into one) needs once it is in: its copy buttons shown, the selected row in view. */
function arrive(root) {
  for (const b of root.querySelectorAll("button.copy[data-copy][hidden]")) b.hidden = false;
  // A select that acts on change (the chat page's Profile, Home's Preview chat): its button is for no script only.
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
let snacked = { id: null, seqs: new Set(), timer: null };

function hideSnack(snack, detail) {
  clearTimeout(snacked.timer);
  snack.classList.add("fading");
  snacked.timer = setTimeout(() => {
    snack.hidden = true;
    snack.classList.remove("fading");
    detail.classList.remove("snacking");
  }, 300);
}

function showSnack(detail, deleted, answer) {
  const snack = detail.querySelector(".snack");
  if (!snack) return;
  clearTimeout(snacked.timer);
  // The server joins a delete to the chat's open deletion (store/deletions.ts): one snackbar, one Undo, for all.
  if (snacked.id !== answer.id || snack.hidden) snacked = { id: answer.id, seqs: new Set(), timer: null };
  for (const s of deleted) snacked.seqs.add(s);
  const seqs = [...snacked.seqs];
  const what = snack.querySelector(".swhat");
  const undo = snack.querySelector(".sundo");
  what.textContent = `Deleted ${answer.count}`;
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
    setGone(detail, seqs, false);
    snacked.id = null;
    hideSnack(snack, detail);
  };
  snack.hidden = false;
  detail.classList.add("snacking");
  // The window is over: the server purges them, they stay off the page; the snackbar fades.
  snacked.timer = setTimeout(() => hideSnack(snack, detail), answer.seconds * 1000);
}

if (window.htmx) {
  window.htmx.onLoad(arrive);
  // A part of a page that fetches itself (settings.ts `polls`) takes only its own answer: an error or the sign-in
  // page is a whole page, which must not land inside it. It is left as it was and asks again next time.
  document.addEventListener("htmx:beforeSwap", (e) => {
    if (e.detail.xhr.status >= 300 && e.detail.target instanceof Element && e.detail.target.hasAttribute("data-poll")) e.detail.shouldSwap = false;
  });
  // A request that got no answer at all (the server restarting, the tailnet down): say so, until one does.
  const offline = (on) => document.body.classList.toggle("offline", on);
  document.addEventListener("htmx:sendError", () => offline(true));
  document.addEventListener("htmx:afterRequest", (e) => e.detail.xhr?.status && offline(false));
} else document.addEventListener("DOMContentLoaded", () => arrive(document));
