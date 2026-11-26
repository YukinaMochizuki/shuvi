import { getApproval } from "../control/approvals.ts";
import { pendingProvide, PROVIDE_KIND, reasonOf, UPDATE_ONLY } from "../capabilities/computer/secrets.ts";
import { getNote, varAbouts } from "../secrets/notes.ts";
import { keyProblem, type SecretSource } from "../secrets/source.ts";
import type { Db } from "../store/db.ts";
import { getChat } from "../store/events.ts";
import { chatLabel } from "../store/turns.ts";
import { html, page, type Raw } from "./html.ts";
import { csrfField, type SettingsContext, type SettingsNote } from "./settings.ts";

/**
 * The page a provide card links to (`/settings/secrets/provide?card=<id>`, capabilities/computer/secrets.ts
 * PROVIDE): she asked the owner for a secret there is not yet, and he types its values here, never in Telegram.
 * Opened from the control bot, so almost always on a phone: one column, one field per variable, inputs at 16px
 * (iOS zooms into anything smaller), the grant choices as a list of large rows, the buttons full width. Nothing
 * else of the console is on it.
 *
 * A value is only ever typed in: a refused form comes back empty (with why), never with what was typed. Once
 * answered (provided or denied), or expired, the page says so instead of the form. The write is secrets-write.ts
 * `provideWrite`.
 */

export interface ProvideView {
  cardId: number;
  /** Pending: what she asks for. */
  ask?: { profile: string; vars: { name: string; about?: string }[]; reason: string; chat: string; options: { id: string; label: string }[]; operator: number | null; update: boolean };
  /** Not pending: why (answered, denied, expired, unknown). */
  closed?: string;
  /** Why nothing can be kept (no SHUVI_SECRETS_KEY): the form is not offered. */
  keyProblem: string | null;
  note?: SettingsNote;
}


export function loadProvide(db: Db, src: SecretSource, cardId: number, flash?: { note?: SettingsNote }, now = Date.now()): ProvideView {
  const v: ProvideView = { cardId, keyProblem: keyProblem(src), ...(flash?.note ? { note: flash.note } : {}) };
  const p = pendingProvide(db, cardId, now);
  if ("error" in p) {
    const card = getApproval(db, cardId);
    v.closed = card?.kind === PROVIDE_KIND && card.status === "answered" && card.answer !== "deny" ? `${String(card.data?.profile ?? "The secret")} was provided: ${card.options.find((o) => o.id === card.answer)?.label ?? card.answer}.` : p.error;
    return v;
  }
  const chat = getChat(db, p.chatId);
  const noted = varAbouts(getNote(db, p.profile));
  v.ask = {
    profile: p.profile,
    // What each is: as she said it on the card, else as the profile's note says it (an update of a kept profile).
    vars: p.vars.map((name) => {
      const about = p.about[name] ?? noted[name];
      return { name, ...(about ? { about } : {}) };
    }),
    reason: reasonOf(p.card.body),
    chat: chat ? chatLabel(chat) : `chat ${p.chatId}`,
    options: p.card.options.filter((o) => o.hidden).map((o) => ({ id: o.id, label: o.label })),
    operator: p.requestedBy,
    update: p.update,
  };
  return v;
}

/** The grant chosen first: this chat for a day, else the first offered. */
const DEFAULT_GRANT = "1d";

export function provideBody(ctx: SettingsContext, v: ProvideView): Raw {
  const note = v.note ? html`<div class="notice ${v.note.tone}" role="status">${v.note.text}</div>` : "";
  if (!v.ask) {
    return html`<main class="provide"><h1>Secret request</h1>${note}<p class="pv-closed">${v.closed ?? "There is no such request."}</p><p class="pv-foot"><a href="/settings/secrets">All secrets</a></p></main>`;
  }
  const a = v.ask;
  const head = html`<h1>${a.update ? html`New values for <span class="mono">${a.profile}</span>` : html`She needs <span class="mono">${a.profile}</span>`}</h1>
<p class="pv-where">for ${a.chat}</p>
${a.reason ? html`<p class="pv-reason">${a.reason}</p>` : ""}
${a.operator != null ? html`<div class="notice refused">Asked by an operator of this group (user id ${String(a.operator)}), not you. A grant to this chat goes into the commands its operators have her run too.</div>` : ""}`;
  if (v.keyProblem)
    return html`<main class="provide">${head}${note}<div class="notice refused">A secret cannot be kept yet: ${v.keyProblem}. Set it where shuvi is deployed, then open this link again.</div>${denyForm(ctx, v)}</main>`;
  // An update changes the values only, unless he chooses a grant too; a new one is granted for a day in this chat.
  const def = a.update ? UPDATE_ONLY : a.options.some((o) => o.id === DEFAULT_GRANT) ? DEFAULT_GRANT : a.options[0]?.id;
  return html`<main class="provide">${head}${note}
<form method="post" action="/settings/secrets/provide" class="pv-form" autocomplete="off">${csrfField(ctx)}<input type="hidden" name="card" value="${String(v.cardId)}">
${a.vars.map((v) => html`<label class="pv-field">${v.about ? html`<span class="pv-about">${v.about}</span><span class="pv-var mono">${v.name}</span>` : html`<span class="pv-about mono">${v.name}</span>`}<input type="text" name="v_${v.name}" required autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="next"></label>`)}
<fieldset class="pv-grant"><legend>${a.update ? "Its grants" : "Give it to her"}</legend>
${(() => {
  const opt = (o: { id: string; label: string }) =>
    html`<label class="pv-opt"><input type="radio" name="grant" value="${o.id}" ${o.id === def ? "checked" : ""}><span>${o.label}${o.id.startsWith("all-") ? html`<small>in turns you start, never an operator's</small>` : ""}</span></label>`;
  // An update keeps its grants, mostly: the grant choices are folded away until asked for.
  if (!a.update) return a.options.map(opt);
  const [keep, ...grants] = a.options;
  return html`${keep ? opt(keep) : ""}<details class="pv-more"><summary>Also grant it…</summary>${grants.map(opt)}</details>`;
})()}
</fieldset>
<button type="submit" name="do" value="provide" class="btn primary pv-go">${a.update ? "Save the new values" : "Save and give it to her"}</button>
<p class="pv-hint">The values are sealed when saved and never shown again, here or to her: she types them into a page or a command without seeing them.</p>
</form>
${denyForm(ctx, v)}
</main>`;
}

function denyForm(ctx: SettingsContext, v: ProvideView): Raw {
  return html`<form method="post" action="/settings/secrets/provide" class="pv-deny">${csrfField(ctx)}<input type="hidden" name="card" value="${String(v.cardId)}"><button type="submit" name="do" value="deny" class="btn pv-no">Deny</button></form>`;
}

export function providePage(ctx: SettingsContext, v: ProvideView): string {
  return page("Secret request", provideBody(ctx, v), ctx.who, "settings");
}
