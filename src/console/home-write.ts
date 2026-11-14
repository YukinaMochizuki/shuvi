import { randomBytes } from "node:crypto";
import { commitHomeEdit, consoleEditable, readHomeFile, StaleEdit } from "../capabilities/memory/home.ts";
import type { Db } from "../store/db.ts";
import { blobId, blobText, fileHistory, langOf, merge3 } from "./home-data.ts";
import { href } from "./html.ts";
import type { Form } from "./settings-write.ts";
import type { ConflictState, Flash } from "./home.ts";

/**
 * The Home page's one write: saving a file (server.ts lets it through the console's write boundary: POST only, the
 * Origin, the CSRF token). A commit in home/, authored as the owner from the console (capabilities/memory/home.ts
 * `commitHomeEdit` with `by.console`), its message the note or "Edited in console".
 *
 * A save carries `base`, the version the editor started from (home-data.ts `blobId`). If the file is still that
 * version, the text is saved as it is. If she (or anyone) changed it meanwhile, the two changes are merged
 * (`git merge-file`, base → hers and base → yours): a clean merge is saved, and the answer says hers was kept; a
 * conflict is NOT saved, and the answer is the conflict view, both texts side by side, to resolve and save again
 * (based on the version now). Nothing anyone wrote is ever lost by a save.
 *
 * Line endings: a native form posts CRLF, htmx posts LF (it reads `textarea.value`); either way the text is taken
 * as LF and, when the file itself uses CRLF, given CRLF back, so a save changes no line it was not asked to.
 *
 * The check and the write are one step as far as a racing commit of hers is concerned: the commit is told the text
 * the decision was made on (`commitHomeEdit`'s `expect`) and refuses if the file says anything else by then, and the
 * save then looks again (a few times at most). A file she REMOVED while you edited is not quietly brought back: the
 * answer says so, and your text waits in the editor for a save that creates it again, if you want that.
 *
 * A save that fails after a merge hands back the MERGED text (based on the version now), never yours alone, so
 * saving it again cannot drop her change.
 *
 * The answer is a 303 to the page with `r=<id>`: the result (and a conflict's texts) is kept in memory for
 * `KEEP_MS`, read once, at most `KEEP_MAX` at a time, like Settings' flash.
 */

const KEEP_MS = 10 * 60_000;
const KEEP_MAX = 20;

interface Result {
  at: number;
  path: string;
  flash: Flash;
  conflict?: ConflictState;
  /** A refused save's text, given back to the editor so nothing typed is lost; and the version it is based on. */
  text?: string;
  base?: string;
  note?: string;
}

const results = new Map<string, Result>();

function keep(now: number, r: Omit<Result, "at">): string {
  for (const [k, v] of results) if (now - v.at > KEEP_MS) results.delete(k);
  while (results.size >= KEEP_MAX) results.delete(results.keys().next().value!);
  const id = randomBytes(9).toString("base64url");
  results.set(id, { ...r, at: now });
  return id;
}

/** A save's result by its id, once. */
export function takeResult(id: string | null, now: number): Result | undefined {
  if (!id) return undefined;
  const r = results.get(id);
  results.delete(id);
  return r && now - r.at <= KEEP_MS ? r : undefined;
}

export const HOME_WRITES: ReadonlySet<string> = new Set(["/home/save"]);

const field = (form: Form, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};

/** Save the posted file; returns where to send the browser (see the header). */
export function homeSave(db: Db, home: string, form: Form, login: string | undefined, now: number): string {
  const path = field(form, "path");
  const back = (r: Omit<Result, "at" | "path">) => href("/home", { file: path, pane: "edit", r: keep(now, { ...r, path }) });
  if (!consoleEditable(path)) return href("/home", { r: keep(now, { path: "", flash: { tone: "refused", text: `${path || "That"} is not one of her files.` } }) });
  const note = field(form, "note").trim();
  const message = note || "Edited in console";
  const base = field(form, "base");
  const typed = field(form, "text").replace(/\r\n/g, "\n");

  for (let attempt = 0; ; attempt++) {
    const current = readHomeFile(home, path);
    const text = current?.includes("\r\n") ? typed.replace(/\n/g, "\r\n") : typed;
    let toSave = text;
    let mergedWith: string | undefined;
    if (blobId(current) !== base) {
      const latest = fileHistory(db, home, path, 1)[0];
      const whose = latest?.who.kind === "her" ? `shuvi changed it${latest.who.turnId ? ` (turn #${latest.who.turnId})` : ""}` : "it was changed";
      if (current === null) {
        const who = latest?.who.kind === "her" ? "shuvi" : "Someone";
        return back({ flash: { tone: "refused", text: `Not saved: ${who} removed this file while you were editing. Your text is still here; save again to create the file with it.` }, text, base: blobId(null), note });
      }
      const baseText = blobText(home, base);
      if (baseText === null) {
        // The version the edit began from was never committed: there is nothing to merge against.
        return back({ flash: { tone: "refused", text: `Not saved: ${whose} while you were editing. Both versions are below; save the one you want.` }, conflict: conflictOf(path, current, text, latest?.who), note });
      }
      const m = merge3(text, baseText, current, ["yours", "where you started", "saved now"]);
      if (!m.clean) return back({ flash: { tone: "refused", text: `Not saved yet: ${whose} while you were editing, in the same lines as you. Resolve it below, then save.` }, conflict: conflictOf(path, current, text, latest?.who), note });
      toSave = m.text;
      mergedWith = whose;
    }
    if (toSave === current) return back({ flash: { tone: "ok", text: "No change: the file already says that. Nothing was saved." } });
    try {
      const commit = commitHomeEdit(home, path, toSave, message, { console: login ? { login } : {}, expect: current });
      // A sentence that starts with her name keeps it as written ("shuvi changed it"); "it was changed" is capitalised.
      const sentence = mergedWith?.startsWith("shuvi") ? mergedWith : mergedWith && `${mergedWith[0]!.toUpperCase()}${mergedWith.slice(1)}`;
      const kept = sentence ? ` ${sentence} meanwhile; that change was kept too.` : "";
      return back({ flash: { tone: "ok", text: `Saved (commit ${commit}).${kept} It applies from her next turn.` } });
    } catch (e) {
      // She committed between the look and the write: look again (merging her change in), a few times at most.
      if (e instanceof StaleEdit && attempt < 3) continue;
      // Hand back what was about to be saved, based on the version it was decided against: a merged text keeps her
      // change, so saving it again cannot lose it.
      return back({ flash: { tone: "failed", text: `Not saved: ${e instanceof Error ? e.message : String(e)}` }, text: toSave, base: blobId(current), note });
    }
  }
}

function conflictOf(path: string, current: string | null, ours: string, who: ConflictState["theirsWho"] | undefined): ConflictState {
  return { path, lang: langOf(path), theirs: current ?? "", ours, base: blobId(current), theirsWho: who ?? { kind: "external", name: "someone" } };
}
