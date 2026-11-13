// The console's own script (same origin; the pages work without it, and without htmx). Copy buttons, j / k to
// move through the turn list, and a line when the console cannot be reached. htmx (html.ts `page`) swaps pages
// in place, so nothing here holds on to an element of a page: clicks and keys are handled on the document,
// and what a new page needs is done for each piece htmx puts in (`htmx.onLoad`), or once without htmx.
"use strict";

/** What a page (or a piece swapped into one) needs once it is in: its copy buttons shown, the selected row in view. */
function arrive(root) {
  for (const b of root.querySelectorAll("button.copy[data-copy][hidden]")) b.hidden = false;
  const on = root.querySelector(".rows a.row.on");
  if (on) on.scrollIntoView({ block: "nearest" });
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
