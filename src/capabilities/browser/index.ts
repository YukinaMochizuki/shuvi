import { z } from "zod";
import { err, ok, type ToolContent, type ToolDef, type ToolResult } from "agent-runtime";
import { actingFor } from "../../agent/acting.ts";
import { describe, Porchkit, PorchkitError, porchkitConfig, type BrowseAction, type BrowseAnswer, type BrowseStatus, type BrowseTarget, type PorchkitConfig } from "../../porchkit/client.ts";
import type { Chat } from "../../store/events.ts";
import { DEFAULT_SECRETS_FILE, dataDirFrom } from "../../env.ts";
import { allProfiles, redactionFor, secretSource, type SecretSource } from "../../secrets/source.ts";
import { grantsFor } from "../computer/secrets.ts";
import type { ChatPolicy } from "../../policy/policy.ts";
import { computerConfig } from "../computer/config.ts";
import { defineCapability, policyEnables, type TurnContext } from "../types.ts";
import { attachmentPass } from "./attachments.ts";
import { extraLines, imagesOf, matchLines, pointerLines, rememberShot, situationLines, targetText } from "./look.ts";
import { lookTools } from "./pointer.ts";
import { fileTools } from "./files.ts";
import { seenWhole, unseen, wholeFlag } from "./fresh.ts";
import { sessionOf } from "./keys.ts";
import { CARRY_MS, claimCarry, claimPurchase, grantCarry, hostOf, PURCHASE_TTL_MS, USE_WITHIN_MS, releaseCarry, releasePurchase, requester, requestPurchase } from "./purchase.ts";

/**
 * Browser: shuvi's own desktop, a real Chrome on the owner's home machine logged into accounts made for her,
 * which she drives one action at a time through porchkit's `/browse` (src/porchkit/client.ts). The owner can
 * watch every action, or take the browser over, from the live view on his phone.
 *
 *   tools     browser_open, browser_snapshot, browser_click, browser_type, browser_press, browser_scroll,
 *             browser_back, browser_tab, browser_wait, browser_dialog (answers a page's confirm / prompt): one action each, answered with the page as text (porchkit's
 *             snapshot, passed through as it comes: it is capped there), so she rarely needs browser_snapshot. On the
 *             same page (porchkit's rule, the owner's of 2026-11-22) an action answers only what changed
 *             (`snapshot_kind: "delta"`: porchkit's text says so in its first line, else `DELTA_LINE` does), and the
 *             refs of the page text she already has still hold, but for an element whose role or name changed: it has a
 *             new ref and its old one is refused (porchkit's rule, the owner's, after a Maps filter refilled a result
 *             list; a link that only gains Google Maps' visited-link suffix keeps its ref, porchkit's rule of round 4; a
 *             node the page drew again with the same content keeps its ref when its place is unique, round 6). Identical
 *             siblings come as one line with all their refs (`[e5 e9] button "讚" ×2`), identical lines nothing acts
 *             on as one `×N` line, and a mass rename as one summary line (porchkit's, round 6); `type` whose text did
 *             not land is `not_typed`, a ref act whose point is covered is `covered` (nothing pressed);
 *             browser_snapshot reads the whole page again. A click, Enter or a select waits for the page (up to
 *             1.5 s more, porchkit's), and an open, a back, or an act that changes the URL waits for the new page (up
 *             to 3 s, porchkit's, the owner's of 2026-11-22); its hint when it may still be loading is look.ts's. The first
 *             page text of a conversation (after /new, a switch, a compaction) is asked for whole (fresh.ts);
 *             browser_screenshot: the page as an image (porchkit's file, fetched here with the token);
 *             browser_close; browser_status: the desktop, signed in or not, takeover, the live view's link;
 *             browser_request_purchase: the owner's card before an order is placed (purchase.ts);
 *             browser_downloads, browser_send (a screenshot, a download, the page as a PDF, to this chat):
 *             files.ts. Saving one onto the computer (browser_save) is the computer capability's tool: its
 *             authority is the computer's (`delegate: [computer]`), not the browser's.
 *   who       anyone whose message starts a turn in a chat whose policy enables `browser` (the owner decided
 *             it: groups included). Nothing here is owner-only; the purchase card is the owner's, as every
 *             card is (control/approvals.ts: only he answers).
 *   session   one window per chat: porchkit's session `chat-<chat id>`, opened by its first action and closed by
 *             porchkit after 30 minutes idle (or browser_close). Another chat's window is never named to her.
 *   dialogs   an alert is accepted by porchkit (a note says so); a confirm / prompt stays open and comes back as
 *             the answer's `dialog` (rendered as "The page asks: …"), and every other action is refused (409
 *             `dialog_open`) until browser_dialog answers it.
 *   money     only the act that places the order waits for the owner (decided by him, 2026-11-26): porchkit refuses,
 *             without `approved: true` (403 `approval_required`), a click on a final-step button ("place order",
 *             確認付款, 下單, 購入する …) anywhere and accepting a dialog that reads like placing an order. Everything
 *             before it is hers: on a checkout she fills in the address, a coupon and the payment method herself,
 *             reads the final total, and only then asks (browser_request_purchase, with a screenshot). On a
 *             checkout Enter or a submit is 422 `button_required` (it could send the order's form by itself: she
 *             presses the page's own button instead), never the owner's. Adding to the cart never needs anything.
 *             shuvi sends `approved` only with a usable purchase approval (purchase.ts): one
 *             approval, one action, this chat only; except that an approved action which opens a confirm / prompt
 *             carries the approval to accepting that one dialog (purchase.ts CARRY, 2 minutes, same session).
 *             Payment details (the card the owner keeps for her, as a secret profile) are typed only as `secret`,
 *             masked, on his own requests, never as `text`: the card's balance is what bounds a final step
 *             porchkit's names miss. The prompt makes asking hers whether or not porchkit refuses the button, and
 *             keeps a playbook per shop (`playbooks/shop-<site>.md`, memory's files) that she writes after each
 *             order for the owner: the flow and which personal info / secret each field takes, never a value, never
 *             a step that may go unasked (decided by the owner, 2026-11-27, over a framework that learns).
 *   privacy   typed text and page text are never logged; they live only in the turn's transcript. The
 *             porchkit token is the media capability's and is redacted from transcripts here too.
 *   secrets   `browser_type` with `secret: "<profile>.<VAR>"` instead of `text` types a granted secret's value (a
 *             national id, a password) that she never sees: it is read here from the grants that cover the call
 *             (computer/secrets.ts `grantsFor`: this chat's, and the owner's for every chat when the call acts for
 *             him), and sent with `mask: true`, so porchkit shows that field as dots in every picture and page text
 *             after (its live view too). Such a call is the owner's (`ownerOnlyWhen`; never delegable: the browser
 *             is anyone's in a chat that enables it, a secret is not). Every browser tool's text, an error's too,
 *             is passed through the secrets' redaction before she sees it (`redactingAll`): a page that shows a
 *             value back shows [REDACTED:<profile>]. Pictures cannot be redacted; porchkit's mask is what keeps
 *             a typed value out of them.
 *   1Password the desktop's Chrome has 1Password, signed in to an account of her own (never the owner's, and
 *             never her Google credentials: those stay his). Its prompts on a page (the menu in a field, the
 *             "sign in as" offer, "save this login / passkey") are not in the page text, only in screenshots, and
 *             porchkit lets a call use them only with `owner: true`, which `act` sends when the call acts for the
 *             owner himself (`actingFor`, as a secret is his; decided by the owner, 2026-11-26). Without it they
 *             are 403 `owner_only` with `what: "password_manager"`, and only Escape gets past them. porchkit's
 *             `password-manager:` hints say when one is open, when the keyboard is in it, and when 1Password is
 *             locked (after every Chrome restart; the owner unlocks it in the live view). Its menu on a password
 *             field prints the password it suggests, so porchkit paints it over in every picture she gets (the
 *             owner's decision, 2026-11-26): she takes its first entry blind, ArrowDown until the focus is in
 *             1Password (measured: once if the menu is open, twice if not), then Enter.
 *
 *   beyond the page text  browser_pointer, browser_zoom, browser_watch, browser_find, browser_wait_for, browser_hover,
 *             browser_select (pointer.ts); every answer's `situation` and images (look.ts), read first.
 *   loops     `browser-attachments`: fetch a file someone sent, for browser_upload (attachments.ts; a runner child
 *             never holds the bot token).
 *
 *   SHUVI_PORCHKIT_URL / SHUVI_PORCHKIT_TOKEN   porchkit and shuvi's token there (both set: on; src/porchkit/).
 *                                               porchkit answers 503 `unavailable` when it has no desktop.
 *   SHUVI_BROWSER_ATTACH_WAIT_SEC   how long browser_upload waits for a sent file to be fetched (default 30)
 */

export interface BrowserConfig {
  porchkit: PorchkitConfig;
  /** The data dir: browser_send's files wait in its outbox/ (store/outbox.ts). */
  dataDir: string;
  /** The computer is on in this process: answers may point at its browser_save, in chats that enable it too. */
  computer: boolean;
  /** How long browser_upload waits for the server to fetch a file someone sent (SHUVI_BROWSER_ATTACH_WAIT_SEC). */
  attachWaitMs: number;
  /** Where secret profiles come from: what `browser_type` with `secret` types, and what every answer is redacted by. */
  secrets: SecretSource;
}

export function browserConfig(env: Record<string, string | undefined>): BrowserConfig | null {
  const porchkit = porchkitConfig(env);
  const wait = Number(env.SHUVI_BROWSER_ATTACH_WAIT_SEC);
  return porchkit ? { porchkit, dataDir: dataDirFrom(env), computer: computerConfig(env) !== null, attachWaitMs: (wait > 0 ? wait : 30) * 1000, secrets: secretSource(env, DEFAULT_SECRETS_FILE) } : null;
}

/** This chat has the computer too (on in the process, enabled by its policy): where browser_save works. */
const computerHere = (cfg: BrowserConfig, chatPolicy: ChatPolicy | undefined) => cfg.computer && policyEnables(chatPolicy, "computer");

/** One client per configuration. */
const clients = new WeakMap<PorchkitConfig, Porchkit>();
export function browserClient(cfg: BrowserConfig): Porchkit {
  let p = clients.get(cfg.porchkit);
  if (!p) clients.set(cfg.porchkit, (p = new Porchkit(cfg.porchkit)));
  return p;
}

/** The chat's session at porchkit: `chat-<chat id>`, only `[A-Za-z0-9_-]`. */
export { sessionOf };

export const BROWSER_SECTION = `## Your browser

This chat has a browser of your own: a real Chrome on the owner's home machine, signed in to your own accounts (not the owner's). Use it when \`read_link\` falls short (a page that needs a login, clicks or a form), or when someone asks you to do something on a site.

Each action answers with the page as text: one line per element, \`[e12] role "name"\`. Act on an element by its ref (\`browser_click\` with ref "e12"). Identical elements side by side are one line with all their refs, \`[e5 e9 e13] button "Like" ×3\`: each ref is its own element, in that order. Identical lines you cannot act on are one line with ×N and no ref. On the same page, an action answers only what changed, and the refs of the page text you already have still hold, also for a part the page drew again with the same content; a ref of an element that is gone, or of an earlier page, is refused. An element whose name changed (a list a filter refilled with other entries) is shown with a new ref, and its old ref is refused: never act on a ref you have not seen with what it names now. When many in one list are renamed at once, one line says so ("in list … [e300]: 70 checkboxes renamed (new refs)"): read them with \`browser_snapshot\` with that ref, or \`browser_find\`. After opening a page, going back, a click, Enter or a choice, the browser waits a moment for the page to load; if it says the page may still be loading, \`browser_wait\` and read what changed. \`browser_snapshot\` reads the whole page again. \`browser_screenshot\` shows you the page as an image when the text is not enough. When the page asks something ("The page asks: …"), answer it with \`browser_dialog\` before anything else.

The owner sees every action you take, live, and can take the browser over. Never type a password, an id number or payment details yourself as \`text\`: a field that needs a credential or personal data the owner keeps as a secret profile is filled with \`browser_type\` and \`secret: "<profile>.<VAR>"\` (only when he is the one asking; the profile must be granted, see \`request_secret\`), which types its value without you seeing it and shows the field as dots afterwards. Payment details (a card number, its expiry and security code) are typed only that way, from the card profile the owner keeps for you, never as \`text\`; when there is none, ask him for one with \`request_secret\`. Buying: fill the checkout in yourself (address, coupon, payment method), pressing the page's own buttons rather than Enter (on a checkout Enter is refused, as it could send the whole order); the address, the recipient and the phone come from the owner's personal info (\`info_read\`), the card only as a secret. Once the page shows the final total, call \`browser_request_purchase\` with the shop, the items and that total, end your turn, and press the button that places the order with the \`approval\` id once he approves. Ask before placing any order or payment whether or not the browser refuses the button: the browser knows that button only by its name and misses some, so a button that went through unasked is no sign that it needed no approval. Spend an approval only on the press that places the order, never on a step before it ("Continue", "前往確認"). Google sign-in and account-security pages (password, 2-Step Verification, recovery, deleting the account) are the owner's: send him the live view link from \`browser_status\` and let him do it there. The rest of your own Google account (profile, photo, settings) you manage yourself.

Keep a playbook per shop, \`shop-<site>\` (e.g. \`shop-mercari\`), whose first line says when to use it ("Buying on Mercari (jp.mercari.com): the checkout, step by step"). Before buying on a shop, read its playbook if there is one and follow it. After every order you placed or tried to place for the owner, write it or bring it up to date (\`write_home\` / \`edit_home\`; buying for him is his asking you to keep it): how the checkout goes, where the address, coupon and payment method are set, which personal info and which secret each field takes (by name, \`home-address\`, \`card.NUMBER\`), the exact name of the button that places the order, whether a confirm follows it, and what went wrong. Never a value: no address, phone or card number (playbooks are read in groups too), and never that a step may go unasked: asking before the order is the rule whatever a playbook says.

Your browser has 1Password, with your own logins for other sites (never Google's). Use it only when the owner himself asked for what you are doing; for anyone else, sign-ins are not yours to do, and if 1Password pops up, leave it: type into the page's fields as text and click the page's own buttons by ref (arrow keys, Enter and Tab would go to its menu, and are refused), or \`browser_press("Escape")\`. Its prompts are not in the page text: a \`password-manager:\` hint says one is open, and a screenshot shows it. Its menu takes keys only once the hint says the focus is in 1Password: \`browser_press("ArrowDown")\` until it does (once if the menu is already open, twice if not), then \`browser_press("Enter")\` takes the highlighted entry. To sign in: click the username field, open its menu that way, look (\`browser_screenshot\`), move to your login with ArrowDown and take it with Enter (or \`browser_pointer\` on it); when it offers "sign in" by itself, Enter takes it. A one-time code is filled the same way on the next page. To sign up or change a password: click the password field and take its menu's first entry the same way, without looking: on a password field its menu is hidden from your pictures (it shows the password itself); on a new-password field the first entry is the password it suggests, on a current-password field your saved one. When it asks to save the login (or a passkey), save it with \`browser_pointer\` on its Save button. Never type a password yourself. When the hint says 1Password is locked, send the owner the live view link and ask him to unlock it.

\`browser_send\` sends this chat a screenshot, a download (\`browser_downloads\` lists them) or the page as a PDF. \`browser_upload\` gives the page a file someone sent here or a download: with the file input's ref, or without one and then click the page's own upload button.

Reading the situation: each answer starts with what your action did (the URL changed, a dialog opened, what changed, or that nothing visible changed) and hints about the page. Use refs and the page text first, on a canvas-heavy page too (a map's side panel is still text). Screenshots and \`browser_pointer\` are the exception, for what the text cannot show: an icon-only or unnamed control (\`browser_screenshot\` with marks, then use its ref); something drawn, such as a place on a map or a game (\`browser_screenshot\` with grid, then \`browser_pointer\` at the point, and check the screenshot it returns). When unsure what is at a point, \`browser_pointer\` with dry_run says without pressing. If the page had not settled or nothing changed, \`browser_watch\` or try another way; do not repeat the same action blindly. On a big page, \`browser_find\` before scrolling. Dropdowns: \`browser_select\`. A captcha: stop and send the owner the live view link. A native popup hint: \`browser_press("Escape")\`.`;


const positiveInt = z.number().int().positive();

/** What the model is told when a `/browse` call failed: plain sentences, what to do next. */
export function describeBrowse(e: unknown, liveUrl?: string | null): string {
  if (!(e instanceof PorchkitError)) return `The browser failed unexpectedly: ${e instanceof Error ? e.message : String(e)}.`;
  const detail = e.detail.trim().replace(/\.?$/, ".");
  const live = liveUrl ? ` The live view: ${liveUrl}` : " (browser_status gives the live view's link.)";
  switch (e.code) {
    case "takeover":
      return "The owner is using the browser right now (he has taken it over in the live view). Nothing was done. Wait, or ask him.";
    case "busy":
      return "The browser is busy: 3 chats are browsing at the moment, and there is no room for another window. Nothing was done; try again in a few minutes, or say so.";
    case "approval_required": {
      const under = targetText(e.body.target as BrowseTarget | undefined);
      return `That places the order or pays (the button that places the order, or accepting a dialog that confirms it${under ? `; under the point: ${under}` : ""}), so it needs the owner's approval first. Nothing was done. Fill in everything else first (address, coupon, payment method) so the page shows the final total; then call browser_request_purchase with the shop, the items and that total, end your turn, and once he approves, repeat this action with its approval id.`;
    }
    case "button_required":
      return "On a checkout, Enter, Space or a submit could send the whole order form by itself, so it is not used here. Nothing was done. Press the page's own button for what you meant (Apply, 套用, Save, Search) with browser_click and its ref; no approval is needed for that.";
    case "target_changed": {
      const now = targetText(e.body.target as BrowseTarget | undefined);
      return `Something else is at that point now${now ? ` (${now})` : ""}: the page moved since you looked. Nothing was done. Look again (browser_screenshot) and aim from the new screenshot.`;
    }
    case "dialog_open":
      return "The page is asking something (a confirm or prompt dialog is open), so nothing else can be done on it. Nothing was done. Answer it first with browser_dialog (accept true or false).";
    case "owner_only":
      if (e.body.what === "password_manager")
        return e.body.acted === true
          ? `That reached 1Password (filling, saving or signing in with a login or passkey), which you use only when the owner himself asked for this, so it was stopped there: ${detail} Part of the action did happen (the click on the field, or the text before it). Take a new snapshot before anything else; to type into the field, type the text without submitting, then click the page's own button by its ref.`
          : `That is 1Password's (filling, saving or signing in with a login or passkey): you use it only when the owner himself asked for this. Nothing was done. Type into the page's field as text and click the page's own buttons by ref; do not pick from 1Password's menu or offer. browser_press("Escape") closes its menu when it can, or ask the owner.`;
      return `That page is the owner's (Google sign-in or account security: password, 2-Step Verification, recovery, deleting the account): you do not act on it. Nothing was done. Send the owner the live view link and ask him to do it himself there.${live}`;
    case "picture_withheld":
      return `${e.body.acted === true ? "The action was done, but its picture" : "No picture was taken: it"} would have shown 1Password's menu over a password field (which prints the password itself), and that menu could not be hidden, so the picture was held back.${e.body.acted === true ? " Take a new snapshot to see where the page is." : " Nothing was done."} Close the menu (browser_press("Escape")) or, if the owner himself asked for this, take its first entry blind (ArrowDown until the focus is in 1Password, then Enter); then look again.`;
    case "unavailable":
      return `The browser is not available right now (the desktop is down or not set up): ${detail} Say so, or try again later.`;
    case "ref_required":
      return "On this page, typing needs the field it goes into. Nothing was done. Give the field's ref from the page text (browser_type with ref).";
    case "not_typed":
      // A masked type (a secret) that failed. porchkit's `left` says whether some of the value may still be on the page
      // UNMASKED (it could neither mask nor clear it); without `left` (an older porchkit), a failure after a key reached
      // the page is taken as that, to be safe. `masked: true`: what reached the page is masked.
      if (e.body.masked !== undefined) {
        const left = e.body.left === true || (e.body.left === undefined && e.body.masked === false && e.body.acted !== false);
        if (left)
          return `The secret did not go into the field, and part of it may still be on the page UNMASKED: ${detail} Do not take a screenshot, zoom, watch or send anything of this page. Tell the owner at once, with the live view link from browser_status, so he can clear it himself; do nothing else on the page.`;
        return e.body.masked === true
          ? `The secret did not fully go into the field: ${detail} What reached the page is masked. Take a new snapshot (browser_snapshot) before anything else; then click the field and type the secret again with its ref.`
          : `The secret did not go into the field: ${detail} Nothing of it was left on the page. Click the field first (browser_click with its ref), then type the secret again with its ref; if the field takes keys only by its own script, the owner fills it himself in the live view.`;
      }
      // `acted: false` (porchkit's): no click and no key reached the page. Otherwise something may have happened there.
      return e.body.acted === false
        ? `The text did not go into the field: ${detail} Nothing was done. Click the field first (browser_click with its ref), then browser_type again with its ref.`
        : `The text did not go into the field: ${detail} The click or some keys did reach the page (a newline or a tab in the text may have submitted or pressed something), so take a new snapshot (browser_snapshot) before anything else; then click the field and type again with its ref.`;
    case "covered":
      return `That element is covered at the point it would be clicked: ${detail} Nothing was pressed. Close or scroll away what covers it (a banner, a dialog, a menu), or scroll it into view, then try again.`;
    case "stale_page":
      return "The page changed since its last page text. Nothing was done. Take a new snapshot (browser_snapshot) and act on what it shows.";
    case "bad_ref":
      return "That ref is not on the page any more (its element is gone, or it is from an earlier page). Nothing was done. Take a new snapshot (browser_snapshot) and use a ref from it.";
    case "timeout":
      return "The browser did not finish that in time. It may or may not have happened: take a new snapshot to see where the page is.";
    case "desktop":
    case "chrome":
      return "The browser crashed and is being restarted; its windows are gone. Open the page again.";
    case "egress_refused":
      return "That link does not lead to the public internet (it, a redirect or its address is private), so it was not opened.";
    case "unauthorized":
      return "porchkit refused shuvi's credentials; the owner needs to check its token. Nothing was done.";
    case "forbidden":
      return `porchkit does not let shuvi use the browser: ${detail} The owner needs to check its configuration.`;
    case "bad_request": {
      const options = Array.isArray(e.body.options)
        ? e.body.options
            .map((o) => (typeof o === "string" ? o : o && typeof o === "object" ? String((o as Record<string, unknown>).text ?? (o as Record<string, unknown>).label ?? (o as Record<string, unknown>).value ?? "") : ""))
            .filter(Boolean)
        : [];
      return `The browser refused that: ${detail}${options.length ? ` The options are: ${options.map((o) => `"${o}"`).join(", ")}.` : ""}`;
    }
    case "unreachable":
      return `The browser's service could not be reached, or the connection dropped (${e.detail}). If this was an action, it may or may not have happened: take a new snapshot to see where the page is.`;
    default:
      return describe(e).replace("The media service", "The browser's service");
  }
}

/**
 * Errors porchkit raises BEFORE it contacts the desktop, so nothing was clicked and a purchase approval's claim is
 * given back. Nothing else is: `unavailable`, `unreachable`, a timeout or a crash can come after the wrapper acted
 * (a dropped connection while the answer was read), and giving the approval back then could place two orders.
 */
export const DID_NOTHING: ReadonlySet<string> = new Set(["takeover", "busy", "bad_ref", "ref_required", "button_required", "stale_page", "target_changed", "covered", "dialog_open", "owner_only", "egress_refused", "forbidden", "bad_request", "unauthorized"]);

/** What follows the error when an approved action failed in a way that may have come after the click. */
export const spentNote = (id: number) =>
  ` Approval #${id} is used up all the same: the order may or may not have gone through. Take a snapshot or a screenshot, and tell the owner plainly what you see there (do not try to place it again).`;

export const SIGNED_OUT =
  "You are signed out of Google in the browser. Send the owner the live view link and ask him to sign you in there (you never type passwords).";

export const CHECKOUT_NOTE =
  "This page is a checkout. Fill it in yourself (address, coupon, payment method), pressing the page's own buttons rather than Enter; only the button that places the order needs the owner's approval. Once the page shows the final total, call browser_request_purchase with the shop, the items and that total.";

/** The line for a confirm / prompt the page has open. */
export function dialogLine(d: NonNullable<BrowseAnswer["dialog"]>): string {
  const kind = d.type === "prompt" ? `a prompt${d.default_prompt ? `, its default "${d.default_prompt}"` : ""}; give your answer as text` : `a ${d.type || "dialog"}`;
  return `The page asks: "${d.message ?? ""}" (${kind}) — answer with browser_dialog (accept true or false) before anything else.`;
}

/**
 * The line before a page text that is only what changed (porchkit's `snapshot_kind: "delta"`), when porchkit's text
 * does not begin by saying so itself (its own first line, `(same page as your last page text: ...)`).
 */
export const DELTA_LINE =
  "Only what changed on this page is below; the rest of your last page text, and its refs, still hold (an element whose name changed is below with a new ref; browser_snapshot reads the whole page):";

/** The acts whose answer may be only what changed (porchkit's own list: not open, snapshot or tab). */
const MAY_DELTA: ReadonlySet<string> = new Set(["click", "type", "press", "scroll", "back", "forward", "wait", "wait_for", "hover", "select", "upload", "dialog"]);

/** The answer gave the model the whole page text (not only what changed, a part of it, or find's matches). */
function givesWholePage(body: BrowseAction, a: BrowseAnswer): boolean {
  if (typeof a.snapshot !== "string" || a.snapshot_kind === "delta" || body.action === "find") return false;
  return !(body.action === "snapshot" && (body.ref !== undefined || body.offset !== undefined));
}

/** An action's answer, as the model reads it: the page text as porchkit gives it, then tabs, notes, warnings. */
export function renderAnswer(a: BrowseAnswer, opts: { approved?: number; carries?: boolean; carried?: number; liveUrl?: string | null; action?: string } = {}): string {
  // What the action did, and hints about the page, first (look.ts).
  const out: string[] = situationLines(a.situation, a, opts.action);
  if (opts.approved !== undefined && opts.carries)
    out.push(`(Done with the owner's approval #${opts.approved}. It also covers accepting the dialog this opened, once, within ${CARRY_MS / 60_000} minutes: answer it with browser_dialog; no new card is needed.)`);
  else if (opts.approved !== undefined) out.push(`(Done with the owner's approval #${opts.approved}; it is now used up.)`);
  if (opts.carried !== undefined) out.push(`(Accepted with the owner's approval #${opts.carried}, carried from the action that opened this dialog; it is now fully used up.)`);
  out.push(...pointerLines(a));
  const matches = matchLines(a);
  if (matches) out.push(...matches);
  const snap = a.snapshot?.trimEnd();
  if (snap && a.snapshot_kind === "delta" && !snap.startsWith("(same page")) out.push(DELTA_LINE);
  out.push(snap ? snap : `${a.title ?? "(no title)"} — ${a.url ?? "(no address)"}`);
  out.push(...extraLines(a));
  const tabs = a.tabs ?? [];
  if (tabs.length > 1) out.push(`Tabs: ${tabs.map((t) => `${t.index}${t.active ? " (this one)" : ""}: ${t.title || t.url || "(blank)"}`).join(" · ")}`);
  for (const n of a.notes ?? []) out.push(`Note: ${n}`);
  if (a.dialog) out.push(dialogLine(a.dialog));
  if (a.checkout) out.push(CHECKOUT_NOTE);
  if (a.signed_in?.google === false) out.push(`${SIGNED_OUT}${opts.liveUrl ? ` The live view: ${opts.liveUrl}` : ""}`);
  return out.join("\n");
}

/** browser_status, as the model reads it. Only this chat's window is named; other chats' are a count. */
export function renderStatus(s: BrowseStatus, session: string): string {
  const out: string[] = [];
  out.push(s.available ? "The browser is available." : "The browser is not available right now (the desktop is down or not set up).");
  if (s.takeover) out.push("The owner has taken it over in the live view: your actions are refused until he lets go.");
  const google = s.signed_in?.google;
  out.push(google === true ? "Google: signed in." : google === false ? `Google: signed out. ${SIGNED_OUT}` : "Google: not known.");
  out.push(s.live_url ? `Live view (for the owner; send him this link when he should look or act): ${s.live_url}` : "Live view: no link configured.");
  const mine = s.sessions?.find((x) => x.session === session);
  const others = (s.sessions ?? []).filter((x) => x.session !== session).length;
  out.push(
    mine
      ? `This chat's window: ${mine.title || "(no title)"} — ${mine.url || "(blank)"}${mine.idle_seconds != null ? `, idle ${Math.round(mine.idle_seconds)}s` : ""}.`
      : "This chat has no window open (browser_open opens one).",
  );
  out.push(`Windows open in other chats: ${others}.`);
  return out.join("\n");
}

const link = z
  .string()
  .min(1)
  .regex(/^https?:\/\/\S+$/i, "an http(s) link")
  .describe("The page's address (http or https)");
const ref = z.string().min(1).max(32).describe('An element\'s ref from the page text, e.g. "e12"');
const approval = positiveInt.optional().describe("The owner's purchase approval id, only for the one action that places an approved order");

type Approved = { approval?: number };

function tools(ctx: TurnContext, cfg: BrowserConfig): ToolDef[] {
  const { db, chat, state: s } = ctx;
  const porch = browserClient(cfg);
  const session = sessionOf(chat);

  /** Whether porchkit's last answer said it masked what was typed (`browser_type` with `secret` checks it). */
  let maskedLast = false;

  /** The live view's link, best effort (for an owner-only page, or signed out). */
  const liveUrl = async (): Promise<string | null> => {
    try {
      return (await porch.browseStatus()).live_url ?? null;
    } catch {
      return null;
    }
  };

  /**
   * One action; with `approvalId`, only after the approval is claimed (purchase.ts), and then `approved: true`;
   * with `carriedId`, on the right an approved action carried to the dialog it opened (already claimed).
   */
  async function act(body: BrowseAction, approvalId?: number, carriedId?: number, opts: { timeout?: string } = {}): Promise<ToolResult> {
    if (approvalId !== undefined) {
      // The approval is bound to the host it was asked on: check where this chat's window is now.
      let host: string | null;
      try {
        host = hostOf((await porch.browseStatus()).sessions?.find((x) => x.session === session)?.url);
      } catch (e) {
        return err(`Could not check which page the browser is on, so the approval was not used: ${describeBrowse(e)}`);
      }
      const why = claimPurchase(db, approvalId, chat, session, host);
      if (why) return err(`Refused: ${why}. Nothing was done. Without a usable approval, call browser_request_purchase and wait for the owner's answer.`);
    }
    if (approvalId !== undefined || carriedId !== undefined) body = { ...body, approved: true };
    // 1Password's prompts are usable only on the owner's own calls (the module header, "1Password"). Whether a
    // call acts for the owner does not depend on the tool (agent/turn.ts `callAuthority` asks that first), so one
    // name asks it for all of them; an operator's call is never the owner's.
    if (actingFor(s, "browser_click")?.by === "owner") body = { ...body, owner: true };
    // The first page text of a conversation is whole: the model has not read porchkit's last one (fresh.ts).
    const asked = MAY_DELTA.has(String(body.action)) ? { ...body, ...wholeFlag(db, chat.id) } : body;
    let a: BrowseAnswer;
    try {
      a = await porch.browseAct(session, asked);
    } catch (e) {
      // A refusal that came after part of the act reached the page (1Password's, porchkit's `acted`) did something.
      const nothing = e instanceof PorchkitError && DID_NOTHING.has(e.code) && e.body.acted !== true;
      // porchkit may have given a page text the model never got (not when it refused before the desktop).
      if (!nothing && !(e instanceof PorchkitError && e.code === "approval_required")) unseen(db, chat.id);
      if (nothing && approvalId !== undefined) releasePurchase(db, approvalId);
      if (nothing && carriedId !== undefined) releaseCarry(db, carriedId);
      const used = approvalId ?? carriedId;
      const kept = used === undefined ? "" : nothing ? ` (Approval #${used} was not used up.)` : spentNote(used);
      if (opts.timeout && e instanceof PorchkitError && e.code === "timeout") return err(opts.timeout);
      return err(`${describeBrowse(e, e instanceof PorchkitError && e.code === "owner_only" ? await liveUrl() : undefined)}${kept}`);
    }
    if (givesWholePage(body, a)) seenWhole(db, chat.id);
    maskedLast = a.masked === true;
    // An approved action that opened a confirm / prompt carries its approval on to that one dialog (not a carried one).
    const carries = approvalId !== undefined && !!a.dialog;
    if (carries) grantCarry(db, approvalId!, session);
    const text = renderAnswer(a, {
      action: String(body.action),
      ...(approvalId !== undefined ? { approved: approvalId, carries } : {}),
      ...(carriedId !== undefined ? { carried: carriedId } : {}),
      ...(a.signed_in?.google === false ? { liveUrl: await liveUrl() } : {}),
    });
    // Any image the answer carries (a pointer's screenshot and close-up, a zoom, a watch sheet), fetched (look.ts).
    const images = await imagesOf(porch, db, chat.id, a);
    return { content: [{ type: "text", text }, ...images] };
  }

  const open: ToolDef<{ url: string }> = {
    name: "browser_open",
    description: "Open a page in your browser (this chat's window). Answers with the page as text once it has loaded (it waits a few seconds at most), its elements with refs.",
    inputSchema: { url: link },
    handler: (a) => act({ action: "open", url: a.url }),
  };

  const snapshot: ToolDef<{ ref?: string; offset?: number }> = {
    name: "browser_snapshot",
    description:
      "The whole current page as text again. Every other action answers with the page too, but on the same page only with what changed (the refs of earlier page text still hold); this reads it all. `ref`: only that part of the page (links whole); `offset`: read on where a long page text was cut.",
    inputSchema: {
      ref: ref.optional().describe("Only this element and what is inside it"),
      offset: z.number().int().nonnegative().optional().describe("Where to start, as the cut page text says"),
    },
    handler: (a) => act({ action: "snapshot", ...(a.ref ? { ref: a.ref } : {}), ...(a.offset !== undefined ? { offset: a.offset } : {}) }),
  };

  const click: ToolDef<{ ref: string; double?: boolean; button?: "left" | "right" | "middle" } & Approved> = {
    name: "browser_click",
    description: "Click an element by its ref. Answers with the page after the click.",
    inputSchema: {
      ref,
      double: z.boolean().optional().describe("Double-click"),
      button: z.enum(["left", "right", "middle"]).optional().describe("Default left"),
      approval,
    },
    handler: (a) => act({ action: "click", ref: a.ref, ...(a.double !== undefined ? { double: a.double } : {}), ...(a.button ? { button: a.button } : {}) }, a.approval),
  };

  const type: ToolDef<{ ref?: string; text?: string; secret?: string; submit?: boolean } & Approved> = {
    name: "browser_type",
    description:
      "Type text, into the element `ref` (clicked first) or the field that has the focus. `submit` presses Enter after. If the text does not land in the field, it is an error and nothing is submitted: click the field, then type with its ref. " +
      'Give either `text`, or `secret`: a granted secret\'s variable as "<profile>.<VAR>" (e.g. "vhc.NATIONAL_ID"), whose value is typed without you seeing it; the field then shows as dots in screenshots and page text. Use `secret` for a password, an id number, payment details (a card number, its expiry and code) or anything the owner keeps as a secret, only when he is the one asking; never type such a value as `text`.',
    inputSchema: {
      ref: ref.optional(),
      text: z.string().max(5000).optional().describe("What to type (not with secret)"),
      secret: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z_][A-Za-z0-9_]*$/, '"<profile>.<VAR>"')
        .optional()
        .describe('A granted secret to type instead of text: "<profile>.<VAR>"'),
      submit: z.boolean().optional().describe("Press Enter after typing"),
      approval,
    },
    handler: async (a) => {
      const where = { ...(a.ref ? { ref: a.ref } : {}), ...(a.submit !== undefined ? { submit: a.submit } : {}) };
      if ((a.text === undefined) === (a.secret === undefined)) return err("Give either text or secret (one of them). Nothing was typed.");
      if (a.text !== undefined) return act({ action: "type", text: a.text, ...where }, a.approval);
      const value = secretValue(a.secret!);
      if ("error" in value) return err(`${value.error} Nothing was typed.`);
      const r = await act({ action: "type", text: value.value, mask: true, ...where }, a.approval);
      // A porchkit that took the act but did not say it masked the field may have typed it in the clear.
      if (!r.isError && !maskedLast) return err("The secret was typed, but the browser did not confirm the field is masked, so it may be readable on the page. Do not take a screenshot or send anything of this page; tell the owner (porchkit may need updating), with the live view link from browser_status.");
      return r;
    },
  };

  /**
   * The value `<profile>.<VAR>` names, from the grants that cover this call (this chat's; every chat's only when it
   * acts for the owner, which the boundary has already made sure of: `ownerOnlyWhen`). Errors name the reference,
   * never a value.
   */
  function secretValue(ref: string): { value: string } | { error: string } {
    const dot = ref.indexOf(".");
    const profile = ref.slice(0, dot);
    const name = ref.slice(dot + 1);
    const forOwner = actingFor(s, "browser_type")?.by === "owner";
    if (!grantsFor(db, chat.id, forOwner).some((g) => g.profile === profile))
      return { error: `The secret profile "${profile}" is not granted here. Ask the owner with request_secret (it can also ask him for a profile that does not exist yet), end your turn, and type it once he has granted it.` };
    const all = allProfiles(db, cfg.secrets);
    if ("error" in all) return { error: `The secrets cannot be read now: ${all.error}.` };
    const vars = all.profiles[profile];
    if (!vars) return { error: `The secret profile "${profile}" cannot be used now${all.unreadable.some((u) => u.name === profile) ? " (its values cannot be opened; tell the owner)" : " (it is gone)"}.` };
    const value = vars[name];
    if (value === undefined) return { error: `The secret profile "${profile}" has no variable ${name}; it has ${Object.keys(vars).join(", ") || "none"}.` };
    return { value };
  }

  const press: ToolDef<{ key: string; hold_ms?: number } & Approved> = {
    name: "browser_press",
    description: 'Press a key or a combination: "Enter", "Escape", "Tab", "PageDown", "Control+A". `hold_ms` holds it down that long (a game, a press-and-hold).',
    inputSchema: { key: z.string().min(1).max(40).describe("The key, e.g. Enter"), hold_ms: z.number().int().min(30).max(5000).optional().describe("Hold it down this many ms (30–5000)"), approval },
    handler: (a) => act({ action: "press", key: a.key, ...(a.hold_ms !== undefined ? { hold_ms: a.hold_ms } : {}) }, a.approval),
  };

  const scroll: ToolDef<{ direction: "up" | "down" | "left" | "right"; amount?: number; ref?: string }> = {
    name: "browser_scroll",
    description: "Scroll the page (or the element `ref`) by pages. Answers with the page text after.",
    inputSchema: {
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.number().positive().max(20).optional().describe("Pages, default 1"),
      ref: ref.optional(),
    },
    handler: (a) => act({ action: "scroll", direction: a.direction, ...(a.amount !== undefined ? { amount: a.amount } : {}), ...(a.ref ? { ref: a.ref } : {}) }),
  };

  const back: ToolDef<Record<string, never>> = {
    name: "browser_back",
    description: "Go back one page.",
    inputSchema: {},
    handler: () => act({ action: "back" }),
  };

  const tab: ToolDef<{ index: number }> = {
    name: "browser_tab",
    description: "Switch to another tab of this chat's window, by the index the page text lists.",
    inputSchema: { index: z.number().int().nonnegative() },
    handler: (a) => act({ action: "tab", index: a.index }),
  };

  const wait: ToolDef<{ seconds: number }> = {
    name: "browser_wait",
    description:
      "Wait for the page to finish something (loading, a search), up to 10 seconds, then see what changed. Opening a page, going back, a click, Enter or a choice already waits a moment for the page; use this when the answer says it may still be loading, or for something slower.",
    inputSchema: { seconds: z.number().positive().max(10) },
    handler: (a) => act({ action: "wait", seconds: a.seconds }),
  };

  const dialog: ToolDef<{ accept: boolean; text?: string } & Approved> = {
    name: "browser_dialog",
    description: 'Answer the question the page asks ("The page asks: …"): accept (OK) or not (Cancel); for a prompt, `text` is the answer typed in. Nothing else works on the page until it is answered.',
    inputSchema: {
      accept: z.boolean().describe("true: OK; false: Cancel"),
      text: z.string().max(2000).optional().describe("For a prompt: what to answer"),
      approval,
    },
    handler(a) {
      const body: BrowseAction = { action: "dialog", accept: a.accept, ...(a.text !== undefined ? { text: a.text } : {}) };
      // Accepting the dialog an approved action opened uses that approval's carried right, with no new card.
      const carried = a.accept ? claimCarry(db, chat, session, a.approval) : null;
      return carried !== null ? act(body, undefined, carried) : act(body, a.approval);
    },
  };

  /** The page as an image (`marks`: refs drawn on it; `grid`: a coordinate grid, `true` or its spacing); null with the reason when it could not be had. */
  async function shot(look: { marks?: boolean; grid?: boolean | number } = {}): Promise<{ content: ToolContent[]; key: string; bytes: Uint8Array; answer: BrowseAnswer } | { error: string; code?: string }> {
    let a: BrowseAnswer;
    try {
      a = await porch.browseAct(session, { action: "screenshot", ...(look.marks ? { marks: true } : {}), ...(look.grid ? { grid: look.grid } : {}) });
    } catch (e) {
      return { error: describeBrowse(e, e instanceof PorchkitError && e.code === "owner_only" ? await liveUrl() : undefined), ...(e instanceof PorchkitError ? { code: e.code } : {}) };
    }
    if (!a.screenshot?.key) return { error: "The browser answered without a screenshot. Try browser_snapshot instead." };
    let file: { bytes: Uint8Array; type: string | null };
    try {
      file = await porch.file(a.screenshot.key);
    } catch (e) {
      return { error: `The screenshot was taken but could not be read back: ${describeBrowse(e)}` };
    }
    const size = a.screenshot.width && a.screenshot.height ? ` Coordinates are in this image's pixels: ${a.screenshot.width}×${a.screenshot.height}.` : "";
    const mime = file.type?.startsWith("image/") ? file.type.split(";")[0]! : "image/png";
    rememberShot(db, chat.id, a.screenshot.width);
    const marked = look.marks ? " Refs are drawn on it: act on one with its ref." : look.grid ? ` A grid is drawn on it${typeof a.grid === "number" ? ` (every ${a.grid} px)` : ""}, for browser_pointer.` : "";
    const situation = situationLines(a.situation, a, "screenshot");
    const marks = extraLines({ marks: a.marks ?? null });
    return {
      key: a.screenshot.key,
      bytes: file.bytes,
      answer: a,
      content: [
        { type: "text", text: `${situation.length ? `${situation.join("\n")}\n` : ""}Screenshot of ${a.title || "(no title)"} — ${a.url || "(no address)"}.${size}${marked}${marks.length ? `\n${marks.join("\n")}` : ""}` },
        { type: "image", data: Buffer.from(file.bytes).toString("base64"), mimeType: mime },
      ],
    };
  }

  const screenshot: ToolDef<{ marks?: boolean; grid?: boolean | number }> = {
    name: "browser_screenshot",
    description:
      "See the current page as an image (what the owner sees), when the page text is not enough. `marks`: each element's ref drawn on it, and listed with where it is (for icon-only or unnamed controls). `grid`: a coordinate grid (true, or its spacing in pixels, 20–1000), for browser_pointer on drawn or canvas pages.",
    inputSchema: {
      marks: z.boolean().optional().describe("Draw each element's ref on it"),
      grid: z.union([z.boolean(), z.number().int().min(20).max(1000)]).optional().describe("Draw a coordinate grid on it: true, or its spacing in pixels"),
    },
    async handler(a) {
      const r = await shot({ ...(a.marks ? { marks: true } : {}), ...(a.grid ? { grid: a.grid } : {}) });
      return "error" in r ? err(r.error) : { content: r.content };
    },
  };

  const close: ToolDef<Record<string, never>> = {
    name: "browser_close",
    description: "Close this chat's browser window when you are done (it also closes by itself after 30 idle minutes).",
    inputSchema: {},
    async handler() {
      try {
        await porch.browseClose(session);
        return ok("Closed this chat's browser window.");
      } catch (e) {
        return err(describeBrowse(e));
      }
    },
  };

  const status: ToolDef<Record<string, never>> = {
    name: "browser_status",
    description: "The browser's state: available, signed in to Google or not, whether the owner has taken it over, this chat's window, and the live view link for the owner.",
    inputSchema: {},
    async handler() {
      try {
        return ok(renderStatus(await porch.browseStatus(), session));
      } catch (e) {
        return err(describeBrowse(e));
      }
    },
  };

  const purchase: ToolDef<{ shop: string; items: string; total: string; note?: string }> = {
    name: "browser_request_purchase",
    description:
      "Ask the owner to approve placing an order (or any payment) on the page open now. Fill the checkout in first (address, coupon, payment method), so the page and its screenshot show the final total; only the button that places the order is left. He gets a card with what you give here and a screenshot, and answers it himself; end your turn after this. His answer wakes this chat; if he approves, do the one action that places the order with `approval` set to the id.",
    inputSchema: {
      shop: z.string().min(1).max(200).describe("The shop or site"),
      items: z.string().min(1).max(1000).describe("What is bought, with quantities"),
      total: z.string().min(1).max(100).describe('The final total as the page shows it (coupons and shipping included), with currency, e.g. "NT$1,280"'),
      note: z.string().max(500).optional().describe("Anything he should know: delivery, who asked, why"),
    },
    async handler(a) {
      // A confirm the page holds open ("Place this order?") refuses the screenshot: the card goes without one.
      const r0 = await shot();
      if ("error" in r0 && r0.code !== "dialog_open") return err(`${r0.error} (No approval was asked for.)`);
      const r = "error" in r0 ? { content: [] as ToolContent[], key: undefined, bytes: undefined, answer: {} as BrowseAnswer } : r0;
      // The approval is bound to the host of the page it is asked on (purchase.ts USE); the card links the live view.
      let pageUrl = r.answer.url ?? null;
      let live: string | null = null;
      try {
        const st = await porch.browseStatus();
        pageUrl = st.sessions?.find((x) => x.session === session)?.url ?? pageUrl;
        live = st.live_url ?? null;
      } catch {
        // the screenshot's own URL, when there is one
      }
      const host = hostOf(pageUrl);
      if (!host) return err("There is no web page open in this chat's browser to buy on. Open the shop's checkout page first. (No approval was asked for.)");
      const acting = actingFor(s, "browser_request_purchase");
      const id = requestPurchase(db, {
        chat,
        session,
        shop: a.shop,
        items: a.items,
        total: a.total,
        ...(a.note ? { note: a.note } : {}),
        host,
        page: { url: pageUrl, title: r.answer.title ?? null },
        ...(r.key ? { screenshotKey: r.key } : {}),
        ...(r.bytes ? { screenshot: r.bytes } : {}),
        liveUrl: live,
        ...(acting?.by === "owner" ? {} : { requestedBy: requester(db, chat.id, s.fromSeq, s.toSeq, ctx.ownerId) }),
      });
      const minutes = Math.round(PURCHASE_TTL_MS / 60_000);
      return {
        content: [
          {
            type: "text",
            text: `Asked the owner to approve this purchase (approval #${id})${r.bytes ? ", with the screenshot below" : " (no screenshot: a dialog is open)"}${live ? " and the live view's link" : ""}; the card is his alone to answer, and it expires in ${minutes} minutes. End your turn now and do not place the order. His answer wakes this chat: if he approves, do the one action that places the order with approval: ${id}, on this site (${host}) and within ${USE_WITHIN_MS / 60_000} minutes of his answer. One approval is one action.`,
          },
          ...r.content,
        ],
      };
    },
  };

  const files = fileTools({
    db,
    chat,
    s,
    porch,
    session,
    dataDir: cfg.dataDir,
    computer: computerHere(cfg, ctx.chatPolicy),
    describe: (e) => describeBrowse(e),
    render: (a) => renderAnswer(a),
    attachWaitMs: cfg.attachWaitMs,
  });
  const look = lookTools({ act, db, chatId: chat.id });
  return [open, snapshot, click, type, press, scroll, back, tab, wait, dialog, screenshot, ...look, close, status, purchase, ...files] as ToolDef[];
}

/**
 * Every tool's text, its error's too, passed through the secrets' redaction before the model sees it: a page that
 * shows a secret's value back (an input's value in the page text, a confirmation page) shows [REDACTED:<profile>].
 * The redaction is read once per call (the console may have changed the profiles meanwhile). Images are passed as
 * they are: porchkit's mask keeps a typed secret out of them.
 */
function redactingAll(ctx: TurnContext, cfg: BrowserConfig, all: ToolDef[]): ToolDef[] {
  return all.map((t) => ({
    ...t,
    handler: async (args: Parameters<typeof t.handler>[0]) => {
      let r: ToolResult;
      try {
        r = await t.handler(args);
      } catch (e) {
        // A handler that throws: its message is redacted too, as the turn shows it to the model.
        throw new Error(redactionFor(ctx.db, cfg.secrets).redact(e instanceof Error ? e.message : String(e)));
      }
      const red = redactionFor(ctx.db, cfg.secrets);
      return { ...r, content: r.content.map((c) => (c.type === "text" ? { ...c, text: red.redact(c.text) } : c)) };
    },
  })) as ToolDef[];
}

/** For tests: `redactingAll` on tools of their own. */
export const redactingAllForTest = redactingAll;

export const browser = defineCapability<BrowserConfig>({
  id: "browser",
  label: "her own browser",
  gives: "a browser of her own (a real Chrome signed in to her own accounts) she drives step by step: open, read, click, type; the owner watches live, and placing an order needs his approval on a card.",
  enable: browserConfig,
  tools: (ctx, cfg) => [{ serverName: "shuvi", tools: redactingAll(ctx, cfg, tools(ctx, cfg)) }],
  section: () => BROWSER_SECTION,
  // Typing a secret acts with the owner's credentials: his call only, never an operator's or anyone else's.
  ownerOnlyWhen: { browser_type: (args) => typeof args.secret === "string" },
  ownerOnlyNote: { browser_type: "Typing a secret (secret: ...) fills in the owner's own data, so only he can ask for it. Ask him to do it, or to fill the field himself in the live view." },
  loops: ({ db, files }, cfg) => [{ name: "browser-attachments", everyMs: 500, run: async () => void (await attachmentPass(db, files, cfg.dataDir)) }],
  secrets: (cfg) => ({ porchkit: cfg.porchkit.token }),
});
