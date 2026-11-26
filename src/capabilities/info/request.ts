import { answerApproval, requestApproval, type ApprovalOption } from "../../control/approvals.ts";
import type { Db } from "../../store/db.ts";
import { getChat, type Speaker } from "../../store/events.ts";
import { chatLabel, IMMEDIATE } from "../../store/turns.ts";
import { getInfo, writeInfo } from "../../secrets/info.ts";
import { getNote, noteVarAbouts, setNote, SUMMARY_MAX } from "../../secrets/notes.ts";
import { PROFILE_NAME, VAR_NAME, type SecretSource } from "../../secrets/source.ts";
import { pendingProvide, PROVIDE_KIND, PROVIDE_VARS_MAX, provideLink, reasonOf, VAR_ABOUT_MAX, type ProvideVar } from "../computer/secrets.ts";

/**
 * Asking the owner for PERSONAL INFO (src/secrets/info.ts) he has not told her: `request_info` puts a provide card
 * (the computer's PROVIDE, capabilities/computer/secrets.ts: kind `secret-provide`, with `kind: "info"` in its data)
 * in the control bot, whose only button is Deny and whose link opens the console's provide page (console/provide.ts),
 * where he types the values. Its one hidden option is `save`: no grant, as personal info needs none. The same card
 * serves a profile there is not yet and new values for one there is: only the fields asked for change, and the change
 * is recorded in its history as his (`console: <login> (from her request)`). The answer wakes the chat as any card's.
 */

export const INFO_SAVE = "save";
/** How long the owner has to answer. */
const CARD_TTL_MS = 24 * 3600_000;

/** Put the card, or why not: a bad name or field, too many, no key, no console URL to link to. */
export function requestInfo(db: Db, src: SecretSource, a: { chatId: number; name: string; fields: ProvideVar[]; reason: string; consoleUrl?: string }, now = Date.now()): { approvalId: number; update: boolean } | { error: string } {
  if (!PROFILE_NAME.test(a.name)) return { error: `"${a.name.slice(0, 64)}" cannot be the name of personal info: letters, digits, _ and -, up to 64.` };
  const seen = new Set<string>();
  const asked: ProvideVar[] = [];
  for (const f of a.fields) {
    const name = f.name.trim();
    if (!VAR_NAME.test(name)) return { error: `"${name.slice(0, 40)}" is not a field name (letters, digits and _, not starting with a digit, e.g. POSTCODE).` };
    if (seen.has(name)) continue;
    seen.add(name);
    const about = f.about?.replace(/\s+/g, " ").trim().slice(0, VAR_ABOUT_MAX);
    asked.push({ name, ...(about ? { about } : {}) });
  }
  if (!asked.length) return { error: "give the fields to ask for (`fields`)." };
  if (asked.length > PROVIDE_VARS_MAX) return { error: `ask for at most ${PROVIDE_VARS_MAX} fields at once.` };
  if (!src.key) return { error: "personal info cannot be kept yet (SHUVI_SECRETS_KEY is not set where shuvi runs). Tell the owner." };
  if (!a.consoleUrl) return { error: "the owner cannot be sent a link to type it in (SHUVI_CONSOLE_URL is not set where shuvi runs). Ask him in the chat instead, or tell him he can add it on the console's Secrets & personal info page." };
  const update = !!getInfo(db, src, a.name);
  const chat = getChat(db, a.chatId);
  const where = chat ? chatLabel(chat) : `chat ${a.chatId}`;
  const options: ApprovalOption[] = [
    { id: INFO_SAVE, label: "Save", hidden: true },
    { id: "deny", label: "Deny" },
  ];
  const approvalId = requestApproval(
    db,
    {
      kind: PROVIDE_KIND,
      title: update ? `She needs new values in your personal info "${a.name}" (${where})` : `She needs your personal info "${a.name}" (${where})`,
      body: "",
      options,
      ttlMs: CARD_TTL_MS,
      originChatId: a.chatId,
      data: { kind: "info", chatId: a.chatId, profile: a.name, vars: asked.map((f) => f.name), ...(update ? { mode: "update" } : {}), about: Object.fromEntries(asked.filter((f) => f.about).map((f) => [f.name, f.about])) },
      bodyFor: (id) =>
        [
          `Reason: ${a.reason}`,
          `Fields: ${asked.map((f) => (f.about ? `${f.name} (${f.about})` : f.name)).join(", ")}`,
          "Personal info: she reads these values (not a secret).",
          "",
          `Type them in the console: ${provideLink(a.consoleUrl, id)}`,
        ].join("\n"),
    },
    now,
  );
  return { approvalId, update };
}

/**
 * Answer personal-info card `cardId` from the console with `values` (every field it asks for, each non-empty): the
 * fields are written (`writeInfo`, a version recorded as `by`), what each is kept in its note, and the card answered
 * `save`, which wakes the chat, in one transaction. Refused, changing nothing, when the card is not pending or not
 * for personal info, a value is missing, or the write is refused (a secret's value in it).
 */
export function provideInfo(db: Db, src: SecretSource, cardId: number, values: Record<string, string>, from: Speaker, by: string, now = Date.now()): { name: string; changed: string[] } | { error: string } {
  const p = pendingProvide(db, cardId, now);
  if ("error" in p) return p;
  if (!p.info) return { error: "This request is for a secret, not personal info." };
  const option = p.card.options.findIndex((o) => o.id === INFO_SAVE && o.hidden);
  if (option < 0) return { error: "This request cannot be answered here." };
  const set: Record<string, string> = {};
  for (const f of p.vars) {
    const v = (values[f] ?? "").trim();
    if (!v) return { error: `Give ${f} a value. Nothing was saved.` };
    set[f] = v;
  }
  return db.transaction((tx) => {
    const tdb = tx as unknown as Db;
    const hadNote = !!getNote(tdb, p.profile, "info");
    const w = writeInfo(tdb, src, p.profile, { set }, by, now);
    if ("error" in w) return { error: `${w.error}` };
    const r = answerApproval(tdb, cardId, option, from, now, { hidden: true });
    if (r.result !== "answered") throw new Error("the request was answered meanwhile");
    if (!hadNote) setNote(tdb, src, p.profile, { summary: reasonOf(p.card.body).replace(/\s+/g, " ").slice(0, SUMMARY_MAX) }, by, now, "info");
    noteVarAbouts(tdb, src, p.profile, Object.fromEntries(p.vars.map((v) => [v, p.about[v] ?? ""])), [], by, now, "info");
    return { name: p.profile, changed: w.changed };
  }, IMMEDIATE);
}
