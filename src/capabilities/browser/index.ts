import { z } from "zod";
import { err, ok, type ToolContent, type ToolDef, type ToolResult } from "agent-runtime";
import { actingFor } from "../../agent/acting.ts";
import { describe, Porchkit, PorchkitError, porchkitConfig, type BrowseAction, type BrowseAnswer, type BrowseStatus, type PorchkitConfig } from "../../porchkit/client.ts";
import type { Chat } from "../../store/events.ts";
import { defineCapability, type TurnContext } from "../types.ts";
import { CARRY_MS, claimCarry, claimPurchase, grantCarry, hostOf, PURCHASE_TTL_MS, USE_WITHIN_MS, releaseCarry, releasePurchase, requester, requestPurchase } from "./purchase.ts";

/**
 * Browser: shuvi's own desktop, a real Chrome on the owner's home machine logged into accounts made for her,
 * which she drives one action at a time through porchkit's `/browse` (src/porchkit/client.ts). The owner can
 * watch every action, or take the browser over, from the live view on his phone.
 *
 *   tools     browser_open, browser_snapshot, browser_click, browser_type, browser_press, browser_scroll,
 *             browser_back, browser_tab, browser_wait, browser_dialog (answers a page's confirm / prompt): one action each, answered with the page as text (porchkit's
 *             snapshot, passed through as it comes: it is capped there), so she rarely needs browser_snapshot;
 *             browser_screenshot: the page as an image (porchkit's file, fetched here with the token);
 *             browser_close; browser_status: the desktop, signed in or not, takeover, the live view's link;
 *             browser_request_purchase: the owner's card before an order is placed (purchase.ts).
 *   who       anyone whose message starts a turn in a chat whose policy enables `browser` (the owner decided
 *             it: groups included). Nothing here is owner-only; the purchase card is the owner's, as every
 *             card is (control/approvals.ts: only he answers).
 *   session   one window per chat: porchkit's session `chat-<chat id>`, opened by its first action and closed by
 *             porchkit after 30 minutes idle (or browser_close). Another chat's window is never named to her.
 *   dialogs   an alert is accepted by porchkit (a note says so); a confirm / prompt stays open and comes back as
 *             the answer's `dialog` (rendered as "The page asks: …"), and every other action is refused (409
 *             `dialog_open`) until browser_dialog answers it.
 *   money     porchkit refuses, without `approved: true` (403 `approval_required`): a click on a final-step button
 *             ("place order", 確認付款, 下單 …) anywhere; on a checkout page (`checkout`) any button click, Enter, a
 *             submit and accepting a dialog; accepting a dialog that reads like placing an order. Adding to the cart
 *             never needs it. shuvi sends `approved` only with a usable purchase approval (purchase.ts): one
 *             approval, one action, this chat only; except that an approved action which opens a confirm / prompt
 *             carries the approval to accepting that one dialog (purchase.ts CARRY, 2 minutes, same session).
 *   privacy   typed text and page text are never logged; they live only in the turn's transcript. The
 *             porchkit token is the media capability's and is redacted from transcripts here too.
 *
 *   SHUVI_PORCHKIT_URL / SHUVI_PORCHKIT_TOKEN   porchkit and shuvi's token there (both set: on; src/porchkit/).
 *                                               porchkit answers 503 `unavailable` when it has no desktop.
 */

export interface BrowserConfig {
  porchkit: PorchkitConfig;
}

export function browserConfig(env: Record<string, string | undefined>): BrowserConfig | null {
  const porchkit = porchkitConfig(env);
  return porchkit ? { porchkit } : null;
}

/** One client per configuration. */
const clients = new WeakMap<PorchkitConfig, Porchkit>();
export function browserClient(cfg: BrowserConfig): Porchkit {
  let p = clients.get(cfg.porchkit);
  if (!p) clients.set(cfg.porchkit, (p = new Porchkit(cfg.porchkit)));
  return p;
}

/** The chat's session at porchkit: `chat-<chat id>`, only `[A-Za-z0-9_-]`. */
export const sessionOf = (chat: Pick<Chat, "id">): string => `chat-${String(chat.id).replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64);

export const BROWSER_SECTION = `## Your browser

This chat has a browser of your own: a real Chrome on the owner's home machine, signed in to your own accounts (not the owner's). Use it when \`read_link\` falls short (a page that needs a login, clicks or a form), or when someone asks you to do something on a site.

Each action answers with the page as text: one line per element, \`[e12] role "name"\`. Act on an element by its ref (\`browser_click\` with ref "e12"). Refs belong to the latest page text only; after anything changes the page, use the new ones. \`browser_screenshot\` shows you the page as an image when the text is not enough. When the page asks something ("The page asks: …"), answer it with \`browser_dialog\` before anything else.

The owner sees every action you take, live, and can take the browser over. Never type a password or payment details (card numbers, codes); if a site asks for them, stop and ask the owner. Placing an order or paying needs the owner's approval first: call \`browser_request_purchase\`, end your turn, and act with the \`approval\` id once he approves. Google account, security and payment pages are the owner's: send him the live view link from \`browser_status\` and let him do it there.`;

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
    case "approval_required":
      return "That could place an order or pay (a button that places the order, or on a checkout page any button, Enter, a submit or accepting a dialog), so it needs the owner's approval first. Nothing was done. If it is meant to place the order, call browser_request_purchase with the shop, the items and the total, end your turn, and once he approves, repeat this action with its approval id.";
    case "dialog_open":
      return "The page is asking something (a confirm or prompt dialog is open), so nothing else can be done on it. Nothing was done. Answer it first with browser_dialog (accept true or false).";
    case "owner_only":
      return `That page is the owner's (a Google account, security or payment page): you do not act on it. Nothing was done. Send the owner the live view link and ask him to do it himself there.${live}`;
    case "unavailable":
      return `The browser is not available right now (the desktop is down or not set up): ${detail} Say so, or try again later.`;
    case "ref_required":
      return "On this page, typing needs the field it goes into. Nothing was done. Give the field's ref from the page text (browser_type with ref).";
    case "stale_page":
      return "The page changed since its last page text. Nothing was done. Take a new snapshot (browser_snapshot) and act on what it shows.";
    case "bad_ref":
      return "That ref is not on the latest page text (refs change whenever the page does). Nothing was done. Take a new snapshot (browser_snapshot) and use a ref from it.";
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
    case "bad_request":
      return `The browser refused that: ${detail}`;
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
export const DID_NOTHING: ReadonlySet<string> = new Set(["takeover", "busy", "bad_ref", "ref_required", "stale_page", "dialog_open", "owner_only", "egress_refused", "forbidden", "bad_request", "unauthorized"]);

/** What follows the error when an approved action failed in a way that may have come after the click. */
export const spentNote = (id: number) =>
  ` Approval #${id} is used up all the same: the order may or may not have gone through. Take a snapshot or a screenshot, and tell the owner plainly what you see there (do not try to place it again).`;

export const SIGNED_OUT =
  "You are signed out of Google in the browser. Send the owner the live view link and ask him to sign you in there (you never type passwords).";

export const CHECKOUT_NOTE =
  "This page is a checkout: any button here, Enter, a submit or accepting a dialog is refused until the owner approves. Before placing the order, call browser_request_purchase with the shop, the items and the total.";

/** The line for a confirm / prompt the page has open. */
export function dialogLine(d: NonNullable<BrowseAnswer["dialog"]>): string {
  const kind = d.type === "prompt" ? `a prompt${d.default_prompt ? `, its default "${d.default_prompt}"` : ""}; give your answer as text` : `a ${d.type || "dialog"}`;
  return `The page asks: "${d.message ?? ""}" (${kind}) — answer with browser_dialog (accept true or false) before anything else.`;
}

/** An action's answer, as the model reads it: the page text as porchkit gives it, then tabs, notes, warnings. */
export function renderAnswer(a: BrowseAnswer, opts: { approved?: number; carries?: boolean; carried?: number; liveUrl?: string | null } = {}): string {
  const out: string[] = [];
  if (opts.approved !== undefined && opts.carries)
    out.push(`(Done with the owner's approval #${opts.approved}. It also covers accepting the dialog this opened, once, within ${CARRY_MS / 60_000} minutes: answer it with browser_dialog; no new card is needed.)`);
  else if (opts.approved !== undefined) out.push(`(Done with the owner's approval #${opts.approved}; it is now used up.)`);
  if (opts.carried !== undefined) out.push(`(Accepted with the owner's approval #${opts.carried}, carried from the action that opened this dialog; it is now fully used up.)`);
  const snap = a.snapshot?.trimEnd();
  out.push(snap ? snap : `${a.title ?? "(no title)"} — ${a.url ?? "(no address)"}`);
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
const ref = z.string().min(1).max(32).describe('An element\'s ref from the latest page text, e.g. "e12"');
const approval = positiveInt.optional().describe("The owner's purchase approval id, only for the one action that places an approved order");

type Approved = { approval?: number };

function tools(ctx: TurnContext, cfg: BrowserConfig): ToolDef[] {
  const { db, chat, state: s } = ctx;
  const porch = browserClient(cfg);
  const session = sessionOf(chat);

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
  async function act(body: BrowseAction, approvalId?: number, carriedId?: number): Promise<ToolResult> {
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
    let a: BrowseAnswer;
    try {
      a = await porch.browseAct(session, body);
    } catch (e) {
      const nothing = e instanceof PorchkitError && DID_NOTHING.has(e.code);
      if (nothing && approvalId !== undefined) releasePurchase(db, approvalId);
      if (nothing && carriedId !== undefined) releaseCarry(db, carriedId);
      const used = approvalId ?? carriedId;
      const kept = used === undefined ? "" : nothing ? ` (Approval #${used} was not used up.)` : spentNote(used);
      return err(`${describeBrowse(e, e instanceof PorchkitError && e.code === "owner_only" ? await liveUrl() : undefined)}${kept}`);
    }
    // An approved action that opened a confirm / prompt carries its approval on to that one dialog (not a carried one).
    const carries = approvalId !== undefined && !!a.dialog;
    if (carries) grantCarry(db, approvalId!, session);
    return ok(
      renderAnswer(a, {
        ...(approvalId !== undefined ? { approved: approvalId, carries } : {}),
        ...(carriedId !== undefined ? { carried: carriedId } : {}),
        ...(a.signed_in?.google === false ? { liveUrl: await liveUrl() } : {}),
      }),
    );
  }

  const open: ToolDef<{ url: string }> = {
    name: "browser_open",
    description: "Open a page in your browser (this chat's window). Answers with the page as text, its elements with refs.",
    inputSchema: { url: link },
    handler: (a) => act({ action: "open", url: a.url }),
  };

  const snapshot: ToolDef<Record<string, never>> = {
    name: "browser_snapshot",
    description: "The current page as text again, with fresh refs. Every other action already answers with it.",
    inputSchema: {},
    handler: () => act({ action: "snapshot" }),
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

  const type: ToolDef<{ ref?: string; text: string; submit?: boolean } & Approved> = {
    name: "browser_type",
    description: "Type text, into the element `ref` (focused first) or wherever the focus is. `submit` presses Enter after. Never a password or payment details.",
    inputSchema: {
      ref: ref.optional(),
      text: z.string().max(5000).describe("What to type"),
      submit: z.boolean().optional().describe("Press Enter after typing"),
      approval,
    },
    handler: (a) => act({ action: "type", text: a.text, ...(a.ref ? { ref: a.ref } : {}), ...(a.submit !== undefined ? { submit: a.submit } : {}) }, a.approval),
  };

  const press: ToolDef<{ key: string } & Approved> = {
    name: "browser_press",
    description: 'Press a key or a combination: "Enter", "Escape", "Tab", "PageDown", "Control+A".',
    inputSchema: { key: z.string().min(1).max(40).describe("The key, e.g. Enter"), approval },
    handler: (a) => act({ action: "press", key: a.key }, a.approval),
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
    description: "Wait for the page to finish something (loading, a search), up to 10 seconds, then see it.",
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

  /** The page as an image; null with the reason when it could not be had. */
  async function shot(): Promise<{ content: ToolContent[]; key: string; bytes: Uint8Array; answer: BrowseAnswer } | { error: string; code?: string }> {
    let a: BrowseAnswer;
    try {
      a = await porch.browseAct(session, { action: "screenshot" });
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
    const size = a.screenshot.width && a.screenshot.height ? ` (${a.screenshot.width}x${a.screenshot.height})` : "";
    const mime = file.type?.startsWith("image/") ? file.type.split(";")[0]! : "image/png";
    return {
      key: a.screenshot.key,
      bytes: file.bytes,
      answer: a,
      content: [
        { type: "text", text: `Screenshot of ${a.title || "(no title)"} — ${a.url || "(no address)"}${size}:` },
        { type: "image", data: Buffer.from(file.bytes).toString("base64"), mimeType: mime },
      ],
    };
  }

  const screenshot: ToolDef<Record<string, never>> = {
    name: "browser_screenshot",
    description: "See the current page as an image (what the owner sees), when the page text is not enough.",
    inputSchema: {},
    async handler() {
      const r = await shot();
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
      "Ask the owner to approve placing an order (or any payment) on the page open now. He gets a card with what you give here and answers it himself; end your turn after this. His answer wakes this chat; if he approves, do the one action that places the order with `approval` set to the id.",
    inputSchema: {
      shop: z.string().min(1).max(200).describe("The shop or site"),
      items: z.string().min(1).max(1000).describe("What is bought, with quantities"),
      total: z.string().min(1).max(100).describe('The total as the page shows it, with currency, e.g. "NT$1,280"'),
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

  return [open, snapshot, click, type, press, scroll, back, tab, wait, dialog, screenshot, close, status, purchase] as ToolDef[];
}

export const browser = defineCapability<BrowserConfig>({
  id: "browser",
  label: "her own browser",
  gives: "a browser of her own (a real Chrome signed in to her own accounts) she drives step by step: open, read, click, type; the owner watches live, and placing an order needs his approval on a card.",
  enable: browserConfig,
  tools: (ctx, cfg) => [{ serverName: "shuvi", tools: tools(ctx, cfg) }],
  section: () => BROWSER_SECTION,
  secrets: (cfg) => ({ porchkit: cfg.porchkit.token }),
});
