import { randomBytes } from "node:crypto";
import type { Db } from "../store/db.ts";
import { DELETE_UNDO_MS, deleteMessages, deletionOf, undoDeletion } from "../store/deletions.ts";
import { html, type Raw } from "./html.ts";

/**
 * Deleting chat messages from the console: its second write path, beside Settings (settings-write.ts). Both go
 * through the same boundary in server.ts (POST only, the Origin, the CSRF token); what a delete does is
 * store/deletions.ts.
 *
 *   POST /messages/delete   seq (repeated), or only=<seq> ("Delete" in a bubble's menu); back=<the page>
 *   POST /messages/undo     id (the deletion), back
 *
 * With script (console.js, `Accept: application/json`) the answer is JSON: `{id, count, seconds}` for a delete,
 * `{count}` for an undo, or 409 `{refused}` with the reason the bar or the toast shows. Without script it is a
 * 303 back to the page it came from (`back`, a path on this console) carrying a FLASH (`?n=<id>`, as Settings
 * does: kept in memory, read once): the notice at the top of that page, with an Undo button while the deletion
 * can still be undone.
 */

export const DELETE_WRITES = ["/messages/delete", "/messages/undo"] as const;
export const isDeleteWrite = (path: string) => (DELETE_WRITES as readonly string[]).includes(path);

/** The query parameter a flash rides on. */
export const NOTICE_PARAM = "n";
const FLASH_MS = 10 * 60_000;
const FLASH_MAX = 100;

type Flash = { kind: "deleted"; id: number; count: number } | { kind: "undone"; count: number } | { kind: "refused"; text: string };
const flashes = new Map<string, Flash & { exp: number }>();

function putFlash(f: Flash, now: number): string {
  for (const [k, v] of flashes) if (v.exp < now || flashes.size >= FLASH_MAX) flashes.delete(k);
  const id = randomBytes(12).toString("base64url");
  flashes.set(id, { ...f, exp: now + FLASH_MS });
  return id;
}

/** The notice flash `id` carries (once), drawn for the top of the page. `csrf`: the session's, for its Undo. */
export function takeDeleteNotice(db: Db, id: string | null, csrf: string, back: string, now = Date.now()): Raw | undefined {
  if (!id) return undefined;
  const f = flashes.get(id);
  flashes.delete(id);
  if (!f || f.exp < now) return undefined;
  const n = (count: number) => `${count} message${count === 1 ? "" : "s"}`;
  if (f.kind === "refused") return html`<p class="notice refused" role="alert">Not deleted: ${f.text}</p>`;
  if (f.kind === "undone") return html`<p class="notice ok" role="status">Put back ${n(f.count)}.</p>`;
  const d = deletionOf(db, f.id);
  const open = d && Date.parse(d.purgeAt) > now;
  return html`<div class="notice ok" role="status">Deleted ${n(f.count)}.${
    open
      ? html` You can undo it for ${Math.ceil((Date.parse(d.purgeAt) - now) / 1000)} seconds.<form class="inline" method="post" action="/messages/undo"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${f.id}"><input type="hidden" name="back" value="${back}"><button type="submit" class="btn">Undo</button></form>`
      : ""
  }</div>`;
}

/**
 * A path on this console to come back to; anything else goes to the turns. Without the last notice. Checked again
 * once normalised: `/.//evil.example` resolves to `//evil.example`, which a browser takes for another host.
 */
export function backPath(raw: unknown): string {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/turns";
  const u = new URL(raw, "http://console.invalid");
  if (u.origin !== "http://console.invalid") return "/turns";
  u.searchParams.delete(NOTICE_PARAM);
  const out = `${u.pathname}${u.search}`;
  return !out.startsWith("/") || out.startsWith("//") || out.startsWith("/\\") ? "/turns" : out;
}

/** A JSON answer, for server.ts to send with its headers. */
export interface JsonAnswer {
  status: number;
  body: string;
}
const json = (body: unknown, status = 200): JsonAnswer => ({ status, body: JSON.stringify(body) });

/** Carry out a delete write (server.ts has checked the boundary). `wantsJson`: console.js asked. */
export function deleteWrite(db: Db, path: string, form: { get(name: string): unknown; getAll(name: string): unknown[] }, wantsJson: boolean, now = Date.now()): { json: JsonAnswer } | { location: string } {
  const back = backPath(form.get("back"));
  const there = (f: Flash) => {
    const u = new URL(back, "http://console.invalid");
    u.searchParams.set(NOTICE_PARAM, putFlash(f, now));
    return { location: `${u.pathname}${u.search}` };
  };
  if (path === "/messages/undo") {
    const id = Number(form.get("id"));
    const r = Number.isSafeInteger(id) ? undoDeletion(db, id, now) : ({ ok: false, refused: "No such deletion." } as const);
    if (wantsJson) return { json: r.ok ? json({ count: r.count }) : json({ refused: r.refused }, 409) };
    return there(r.ok ? { kind: "undone", count: r.count } : { kind: "refused", text: r.refused });
  }
  const only = form.get("only");
  const seqs = (typeof only === "string" && only ? [only] : form.getAll("seq")).map((s) => Number(s));
  const r = deleteMessages(db, seqs, now);
  if (wantsJson) return { json: r.ok ? json({ id: r.id, count: r.count, seconds: DELETE_UNDO_MS / 1000 }) : json({ refused: r.refused }, 409) };
  return there(r.ok ? { kind: "deleted", id: r.id, count: r.count } : { kind: "refused", text: r.refused });
}
