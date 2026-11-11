// The console's one script (same origin; the pages work without it). Copy buttons, and j / k to move
// through the turn list.
"use strict";

document.addEventListener("DOMContentLoaded", () => {
  for (const b of document.querySelectorAll("button.copy[data-copy]")) {
    b.hidden = false;
    b.addEventListener("click", async (e) => {
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
  }

  const rows = [...document.querySelectorAll(".rows a.row")];
  if (!rows.length) return;
  const on = rows.findIndex((r) => r.classList.contains("on"));
  on >= 0 && rows[on].scrollIntoView({ block: "nearest" });
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
    const step = e.key === "j" ? 1 : e.key === "k" ? -1 : 0;
    if (!step) return;
    const next = rows[Math.min(rows.length - 1, Math.max(0, (on < 0 ? -1 : on) + step))];
    if (next) location.href = next.href;
  });
});
