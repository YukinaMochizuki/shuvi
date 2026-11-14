// The console's own script (same origin; the pages work without it, and without htmx). Copy buttons, j / k to
// move through the turn list, a line when the console cannot be reached, and selecting messages to delete
// (below: the bar, the "⋯" menu, the toast with its undo; pages.ts `pickable` / `deleteBar`, delete-write.ts).
// htmx (html.ts `page`) swaps pages in place, so nothing here holds on to an element of a page: clicks and keys
// are handled on the document, and what a new page needs is done for each piece htmx puts in (`htmx.onLoad`), or
// once without htmx.
"use strict";

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
// Hover a bubble for its checkbox; a click selects it and starts selecting (the detail gets `.selecting`, the bar
// shows), Shift-click selects the range from the last one clicked, Esc or Cancel stops. Delete hides the bubbles at
// once and posts in the background; the answer is the deletion's id (a toast counts down its undo) or a refusal
// (the bubbles come back, the bar says why). The server holds the deletion for its undo window either way: the
// countdown here only says how long that is.

const SIDES = { you: "you", her: "her", other: "others" };
let anchor = null; // the seq last clicked, where a Shift-click's range starts

const detailOf = (el) => el.closest(".detail");
const picks = (detail) => [...detail.querySelectorAll(".pickable")].filter((p) => !p.classList.contains("gone"));
const boxOf = (p) => p.querySelector(".pick input");

/** Mark every copy of `seq` on the page (a segment can show a message twice) as (un)selected. */
function setPicked(detail, seq, on) {
  for (const p of detail.querySelectorAll(`.pickable[data-seq="${seq}"]`)) {
    p.classList.toggle("on", on);
    boxOf(p).checked = on;
  }
}

function selected(detail) {
  const seen = new Map();
  for (const p of picks(detail)) if (p.classList.contains("on")) seen.set(p.dataset.seq, p.dataset.side);
  return seen;
}

/** The bar's line: "3 selected (you 2, her 1)", and selection mode on or off with it. */
function updateBar(detail, why = "") {
  const bar = detail.querySelector("form.selbar");
  if (!bar) return;
  const sel = selected(detail);
  const n = { you: 0, her: 0, other: 0 };
  for (const side of sel.values()) n[side] = (n[side] ?? 0) + 1;
  const parts = Object.keys(SIDES).filter((k) => n[k]).map((k) => `${SIDES[k]} ${n[k]}`);
  bar.querySelector(".selcount").textContent = `${sel.size} selected${parts.length ? ` (${parts.join(", ")})` : ""}`;
  bar.querySelector(".selwhy").textContent = why;
  bar.classList.toggle("refused", !!why);
  detail.classList.toggle("selecting", sel.size > 0 || !!why);
}

function stopSelecting(detail) {
  for (const p of detail.querySelectorAll(".pickable.on")) setPicked(detail, p.dataset.seq, false);
  anchor = null;
  updateBar(detail);
}

function closeMenus(except) {
  for (const d of document.querySelectorAll("details.bmenu[open]")) if (d !== except) d.open = false;
}

/** A checkbox (or a bubble while selecting) clicked: toggle it (`on`: to this), or with Shift select the range from the anchor. */
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
  updateBar(detail);
}

document.addEventListener("click", (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  if (!t.closest("details.bmenu")) closeMenus();
  else closeMenus(t.closest("details.bmenu"));
  const one = t.closest(".bmenu .pick-one");
  if (one) {
    t.closest("details.bmenu").open = false;
    pick(one.closest(".pickable"), false);
    return;
  }
  if (t.closest(".selbar .cancel")) return stopSelecting(detailOf(t));
  // A checkbox toggles itself; its `change` (below) does the rest. Shift is remembered for it.
  if (t.closest(".pick")) return void (shiftPick = e.shiftKey);
  // While selecting, a click on a bubble (not on a link or a fold in it) selects it too.
  const p = t.closest(".selecting .pickable");
  if (p && !t.closest("a, summary, button, details")) {
    e.preventDefault();
    pick(p, e.shiftKey);
  }
});

let shiftPick = false;
document.addEventListener("change", (e) => {
  const box = e.target instanceof HTMLInputElement ? e.target : null;
  if (!box?.closest(".pick")) return;
  pick(box.closest(".pickable"), shiftPick, box.checked);
  shiftPick = false;
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  closeMenus();
  const detail = document.querySelector(".detail.selecting");
  if (detail) stopSelecting(detail);
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

let toastTimer = null;
/** The deletion the toast is for, and every message it took on this page: a delete while it is open joins it. */
let toasted = { id: null, seqs: new Set() };

/** Hide (or bring back) the bubbles of `seqs`, and her reactions to them, which go with them. */
function setGone(detail, seqs, gone) {
  for (const s of seqs) {
    for (const p of detail.querySelectorAll(`.pickable[data-seq="${s}"], .pill[data-target="${s}"]`)) p.classList.toggle("gone", gone);
  }
}

function showToast(detail, form, deleted, answer) {
  const toast = detail.querySelector(".toast");
  if (!toast) return;
  clearInterval(toastTimer);
  // The server joins a delete to the chat's open deletion (store/deletions.ts): one toast, one Undo, for all.
  if (toasted.id !== answer.id || toast.hidden) toasted = { id: answer.id, seqs: new Set() };
  for (const s of deleted) toasted.seqs.add(s);
  const seqs = [...toasted.seqs];
  const until = Date.now() + answer.seconds * 1000;
  const undo = toast.querySelector(".undo");
  toast.querySelector(".what").textContent = `Deleted ${answer.count}`;
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left > 0) return void (undo.textContent = `Undo (${left})`);
    // The undo window is over: the server purges them; here they leave the page for good.
    clearInterval(toastTimer);
    toast.hidden = true;
    for (const s of seqs) for (const p of detail.querySelectorAll(`.pickable[data-seq="${s}"].gone, .pill[data-target="${s}"].gone`)) p.remove();
  };
  undo.disabled = false;
  undo.onclick = async () => {
    undo.disabled = true;
    const r = await post("/messages/undo", [["csrf", form.elements.csrf.value], ["id", String(answer.id)]]);
    undo.disabled = false;
    if (r.refused) return void (toast.querySelector(".what").textContent = r.refused);
    clearInterval(toastTimer);
    toast.hidden = true;
    setGone(detail, seqs, false);
  };
  toast.hidden = false;
  tick();
  toastTimer = setInterval(tick, 250);
}

document.addEventListener("submit", async (e) => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement) || !form.classList.contains("selbar")) return;
  e.preventDefault();
  const detail = detailOf(form);
  // "Delete" in a bubble's menu deletes that one alone; the bar's Delete, what is selected.
  const only = e.submitter?.name === "only" ? e.submitter.value : null;
  closeMenus();
  const seqs = only ? [only] : [...selected(detail).keys()];
  if (!seqs.length) return;
  setGone(detail, seqs, true);
  if (!only) stopSelecting(detail);
  const answer = await post(form.action, [["csrf", form.elements.csrf.value], ...seqs.map((s) => ["seq", s])]);
  if (answer.refused) {
    setGone(detail, seqs, false);
    for (const s of seqs) setPicked(detail, s, true);
    return updateBar(detail, answer.refused);
  }
  showToast(detail, form, seqs, answer);
});

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
