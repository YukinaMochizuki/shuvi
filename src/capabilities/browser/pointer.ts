import { z } from "zod";
import { err, type ToolDef, type ToolResult } from "agent-runtime";
import type { BrowseAction } from "../../porchkit/client.ts";
import type { Db } from "../../store/db.ts";
import { lastShotWidth } from "./look.ts";

/**
 * Tools for where the page text (the accessibility tree) falls short: a pointer at screen coordinates
 * (browser_pointer), a closer look (browser_zoom), watching something move (browser_watch), finding an element on
 * a big page (browser_find), waiting for something to appear or go (browser_wait_for), hovering and choosing from
 * a dropdown (browser_hover, browser_select). Each is one porchkit act, through index.ts's `act`, so the answer's
 * situation, page text and images (look.ts) read as every other action's, and an approval works the same.
 *
 * COORDINATES are in the pixels of the last screenshot the model was shown (look.ts `lastShotWidth`, sent as
 * `image_width` so porchkit can scale them to the window). Without one yet, browser_pointer asks for a
 * screenshot first rather than guessing.
 *
 * MONEY: porchkit refuses a pressing pointer kind (click, double, right, press_hold, drag) on a checkout or
 * final-step target (403 `approval_required`, with the `target`) unless approved, as for a click: browser_pointer
 * takes `approval` and goes through the same purchase flow (purchase.ts), carried right for a dialog included.
 * `dry_run` presses nothing and says what is at the point: for an unclear canvas target, before pressing.
 * A 409 `target_changed` (the point holds something else now) did nothing, and gives an approval back.
 *
 * porchkit's bounds, held here so a call outside them is refused before it is sent: pointer amount 1–20 and
 * ms 100–5000; watch seconds ≤ 6 and frames 4–6; wait_for timeout 0.5–15 s.
 */

/** The body field naming the pointer's own action (porchkit's: `action` names the act, "pointer"). */
export const POINTER_ACTION_FIELD = "kind";

type Act = (body: BrowseAction, approvalId?: number, carriedId?: number, opts?: { timeout?: string }) => Promise<ToolResult>;

const coord = z.number().int().nonnegative();
const ref = z.string().min(1).max(32);

export function lookTools(x: { act: Act; db: Db; chatId: number }): ToolDef[] {
  const { act } = x;

  const pointer: ToolDef<{
    action: "click" | "double" | "right" | "hover" | "drag" | "scroll" | "press_hold";
    x: number;
    y: number;
    to_x?: number;
    to_y?: number;
    direction?: "up" | "down" | "left" | "right";
    amount?: number;
    ms?: number;
    dry_run?: boolean;
    approval?: number;
  }> = {
    name: "browser_pointer",
    description:
      "Act at a point of the page, in the pixels of your last browser_screenshot: for controls the page text does not name (icons, drawn or canvas pages). " +
      "`action`: click, double, right, hover, drag (to `to_x`, `to_y`), scroll (`direction`, `amount`), press_hold (`ms`). " +
      "Answers with what was under the point, whether the page settled and how much changed, and a new screenshot: check it. `dry_run` presses nothing and only says what is at the point.",
    inputSchema: {
      action: z.enum(["click", "double", "right", "hover", "drag", "scroll", "press_hold"]),
      x: coord.describe("From the left, in the screenshot's pixels"),
      y: coord.describe("From the top, in the screenshot's pixels"),
      to_x: coord.optional().describe("drag: where to"),
      to_y: coord.optional().describe("drag: where to"),
      direction: z.enum(["up", "down", "left", "right"]).optional().describe("scroll: which way"),
      amount: z.number().min(1).max(20).optional().describe("scroll: how far (1–20)"),
      ms: z.number().int().min(100).max(5000).optional().describe("press_hold: how long, 100–5000 ms"),
      dry_run: z.boolean().optional().describe("Press nothing: only say what is at the point"),
      approval: z.number().int().positive().optional().describe("The owner's purchase approval id, only for the one action that places an approved order"),
    },
    handler(a) {
      const width = lastShotWidth(x.db, x.chatId);
      if (width === undefined) return Promise.resolve(err("Take a browser_screenshot first: browser_pointer's coordinates are in its pixels. Nothing was done."));
      if (a.action === "drag" && (a.to_x === undefined || a.to_y === undefined)) return Promise.resolve(err("A drag needs to_x and to_y. Nothing was done."));
      const body: BrowseAction = {
        action: "pointer",
        [POINTER_ACTION_FIELD]: a.action,
        x: a.x,
        y: a.y,
        image_width: width,
        ...(a.to_x !== undefined ? { to_x: a.to_x } : {}),
        ...(a.to_y !== undefined ? { to_y: a.to_y } : {}),
        ...(a.direction ? { direction: a.direction } : {}),
        ...(a.amount !== undefined ? { amount: a.amount } : {}),
        ...(a.ms !== undefined ? { ms: a.ms } : {}),
        ...(a.dry_run ? { dry_run: true } : {}),
      };
      return act(body, a.approval);
    },
  };

  const zoom: ToolDef<{ x: number; y: number; w: number; h: number }> = {
    name: "browser_zoom",
    description: "Look closer at a region of the page, given in your last screenshot's pixels (small text, an icon, a chart).",
    inputSchema: { x: coord, y: coord, w: z.number().int().positive(), h: z.number().int().positive() },
    handler: (a) => act({ action: "zoom", x: a.x, y: a.y, w: a.w, h: a.h, ...(lastShotWidth(x.db, x.chatId) ? { image_width: lastShotWidth(x.db, x.chatId) } : {}) }),
  };

  const watch: ToolDef<{ seconds?: number; frames?: number }> = {
    name: "browser_watch",
    description: "Watch the page for a few seconds (an animation, something loading, a game): frames over time in one image.",
    inputSchema: {
      seconds: z.number().positive().max(6).optional().describe("How long, at most 6 (default 3)"),
      frames: z.number().int().min(4).max(6).optional().describe("How many frames, 4–6 (default 6)"),
    },
    handler: (a) => act({ action: "watch", seconds: a.seconds ?? 3, frames: a.frames ?? 6 }),
  };

  const find: ToolDef<{ query: string }> = {
    name: "browser_find",
    description:
      'Find elements on the page by what they say or are (a button\'s words, a heading, a field\'s label), with their refs: on a big page, before scrolling. Several words match an element that has all of them, in any order (or the part of the page that holds them all); put the query in double quotes for one exact phrase ("顯示更多").',
    inputSchema: { query: z.string().min(1).max(200) },
    handler: (a) => act({ action: "find", query: a.query }),
  };

  const waitFor: ToolDef<{ text?: string; ref?: string; gone?: string; timeout?: number }> = {
    name: "browser_wait_for",
    description: "Wait until the page shows `text`, until element `ref` is there, or until `gone` (a text or a ref) has disappeared; up to `timeout` seconds.",
    inputSchema: {
      text: z.string().min(1).max(200).optional(),
      ref: ref.optional(),
      gone: z.string().min(1).max(200).optional().describe("A text or ref to wait to disappear"),
      timeout: z.number().min(0.5).max(15).optional().describe("Seconds, 0.5–15 (default 10)"),
    },
    handler(a) {
      const given = (["text", "ref", "gone"] as const).filter((k) => a[k] !== undefined);
      if (given.length !== 1) return Promise.resolve(err("Give exactly one of text, ref or gone."));
      const k = given[0]!;
      const timeout = a.timeout ?? 10;
      const what = k === "gone" ? `"${a.gone}" to go` : k === "ref" ? `${a.ref} to appear` : `"${a.text}" to appear`;
      return act({ action: "wait_for", [k]: a[k], timeout }, undefined, undefined, {
        timeout: `Waited ${timeout}s for ${what}; it did not happen. Look at the page (browser_snapshot or browser_screenshot) before going on.`,
      });
    },
  };

  const hover: ToolDef<{ ref: string }> = {
    name: "browser_hover",
    description: "Move the pointer over an element by its ref (a menu that opens on hover, a tooltip).",
    inputSchema: { ref },
    handler: (a) => act({ action: "hover", ref: a.ref }),
  };

  const select: ToolDef<{ ref: string; option: string }> = {
    name: "browser_select",
    description: "Choose an option of a dropdown (a select) by its ref and the option's text or value; better than clicking through it.",
    inputSchema: { ref, option: z.string().min(1).max(300) },
    handler: (a) => act({ action: "select", ref: a.ref, option: a.option }),
  };

  return [pointer, zoom, watch, find, waitFor, hover, select] as ToolDef[];
}
