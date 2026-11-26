import { getApproval } from "../control/approvals.ts";
import { pendingProvide, PROVIDE_KIND, reasonOf } from "../capabilities/computer/secrets.ts";
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
  ask?: { profile: string; vars: { name: string; about?: string }[]; reason: string; chat: string; options: { id: string; label: string }[]; operator: number | null };
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
  v.ask = {
    profile: p.profile,
    vars: p.vars.map((name) => ({ name, ...(p.about[name] ? { about: p.about[name] } : {}) })),
    reason: reasonOf(p.card.body),
    chat: chat ? chatLabel(chat) : `chat ${p.chatId}`,
    options: p.card.options.filter((o) => o.hidden).map((o) => ({ id: o.id, label: o.label })),
    operator: p.requestedBy,
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
  const head = html`<h1>She needs <span class="mono">${a.profile}</span></h1>
<p class="pv-where">for ${a.chat}</p>
${a.reason ? html`<p class="pv-reason">${a.reason}</p>` : ""}
${a.operator != null ? html`<div class="notice refused">Asked by an operator of this group (user id ${String(a.operator)}), not you. A grant to this chat goes into the commands its operators have her run too.</div>` : ""}`;
  if (v.keyProblem)
    return html`<main class="provide">${head}${note}<div class="notice refused">A secret cannot be kept yet: ${v.keyProblem}. Set it where shuvi is deployed, then open this link again.</div>${denyForm(ctx, v)}</main>`;
  const def = a.options.some((o) => o.id === DEFAULT_GRANT) ? DEFAULT_GRANT : a.options[0]?.id;
  return html`<main class="provide">${head}${note}
<form method="post" action="/settings/secrets/provide" class="pv-form" autocomplete="off">${csrfField(ctx)}<input type="hidden" name="card" value="${String(v.cardId)}">
${a.vars.map((v) => html`<label class="pv-field">${v.about ? html`<span class="pv-about">${v.about}</span><span class="pv-var mono">${v.name}</span>` : html`<span class="pv-about mono">${v.name}</span>`}<input type="text" name="v_${v.name}" required autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="next"></label>`)}
<fieldset class="pv-grant"><legend>Give it to her</legend>
${a.options.map((o) => html`<label class="pv-opt"><input type="radio" name="grant" value="${o.id}" ${o.id === def ? "checked" : ""}><span>${o.label}${o.id.startsWith("all-") ? html`<small>in turns you start, never an operator's</small>` : ""}</span></label>`)}
</fieldset>
<button type="submit" name="do" value="provide" class="btn primary pv-go">Save and give it to her</button>
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
