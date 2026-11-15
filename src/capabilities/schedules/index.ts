import { z } from "zod";
import { err, ok, type ToolDef } from "agent-runtime";
import { raiseAlert } from "../../store/control.ts";
import { actingFor, authorisation } from "../../agent/acting.ts";
import { activeSchedules, cancelSchedule, createSchedule, fireDue, getSchedule, parseAt, type Schedule } from "../../store/schedules.ts";
import { defineCapability, policyDelegates } from "../types.ts";

/**
 * Schedules: `schedule`, `list_schedules`, `cancel_schedule`, and the loop that fires them
 * (docs/design.md §5, §10). "Check again in five minutes" is a schedule, not a turn idling: a due
 * schedule writes a `scheduled` event carrying its note into the chat it was set in (store/schedules.ts),
 * and that event starts a turn there like a message does.
 *
 * All three tools are `ownerOnly`: always offered, and refused at call time unless the owner himself is in
 * the turn (agent/turn.ts `ownerAuthority`). A schedule set that way is recorded as
 * owner-authorised, so the turn it starts may set the next one (a check scheduling its own follow-up).
 * All three are also `delegable`: a group's policy may let its operators ask for them (policy.ts
 * `operators`). A schedule an operator's call set records them (`authorisedBy`), so the turn it starts acts
 * for them, for delegated tools only, while policy still names them. An operator cannot cancel a schedule
 * the owner set.
 *
 * The owner may also pause and resume a schedule from the console (store/schedules.ts): a paused one is listed as
 * paused, never fires, and can still be cancelled here.
 *
 *   SHUVI_SCHEDULES   "off" disables schedules (default on). Cron and wall-clock times are read in SHUVI_TZ.
 */

/** When to reach for the schedule tools. */
export const SCHEDULES = `## Schedules

You can set yourself a wake-up with \`schedule\`: once (\`at\`) or repeating (\`cron\`), with a note saying why. When it comes due you get a \`schedule\` event in this chat carrying the note, and take it from there (do what it says, or \`pass\` if nothing needs saying). Use it whenever the owner asks for a reminder or a recurring check, and when something is worth looking at again later ("check whether it finished in ten minutes"): set the schedule and end your turn, rather than waiting. Write the note for your future self: what to do and why. \`list_schedules\` and \`cancel_schedule\` manage them.`;

/** How often the loop looks for due schedules. */
export const FIRE_EVERY_MS = 1_000;

/** `Wed 2026-11-11 18:30`, in `timeZone`: with the year, since `at` takes one. */
export function fullTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function describe(s: Schedule, timeZone: string, now = Date.now()): string {
  if (s.state === "paused") {
    const due = s.at ?? s.nextAt;
    // A one-off whose time passed while paused is not run late: resuming cancels it (store/schedules.ts).
    const passed = !s.cron && !!due && Date.parse(due) <= now;
    const when = s.cron
      ? `cron "${s.cron}" (${s.timeZone})`
      : `once, due ${due ? fullTime(due, timeZone) : "?"}${passed ? "; its time passed while paused, so resuming cancels it" : ""}`;
    return `#${s.id}: PAUSED by the owner (does not run until he resumes it): ${when}: ${s.note}`;
  }
  const when = s.cron ? `cron "${s.cron}" (${s.timeZone}), next ${s.nextAt ? fullTime(s.nextAt, timeZone) : "never"}` : `once, ${s.nextAt ? fullTime(s.nextAt, timeZone) : "?"}`;
  return `#${s.id}: ${when}: ${s.note}`;
}

export const schedules = defineCapability<true>({
  id: "schedules",
  label: "schedules (owner only)",
  gives: "schedule, list_schedules, cancel_schedule: wake this chat later with a note.",
  enable: (env) => (env.SHUVI_SCHEDULES === "off" ? null : true),
  ownerOnly: ["schedule", "list_schedules", "cancel_schedule"],
  delegable: ["schedule", "list_schedules", "cancel_schedule"],
  tools({ db, chat, turnId, timeZone, state: st }) {
    const schedule: ToolDef<{ at?: string; cron?: string; note: string }> = {
      name: "schedule",
      description:
        `Set a wake-up in this chat. Give exactly one of \`at\` (once) or \`cron\` (repeating), and a note. ` +
        `\`at\` is a relative offset ("+10m", "+2h", "+1d", "+1h30m") or a date and time ("2026-11-12 08:00", read in ${timeZone}). ` +
        `\`cron\` is a five-field cron expression (minute hour day month weekday, no seconds) in ${timeZone} ("0 8 * * 1-5" is weekdays at 08:00). ` +
        `When it comes due, you get a schedule event here with the note.`,
      inputSchema: {
        at: z.string().optional().describe('Once: "+30m", "+2h", "+1d", or "YYYY-MM-DD HH:MM"'),
        cron: z.string().optional().describe('Repeating: a cron expression, e.g. "0 8 * * *"'),
        note: z.string().min(1).describe("What to do when it comes due, and why"),
      },
      async handler({ at, cron, note }) {
        if (!!at === !!cron) return err("Give exactly one of `at` and `cron`.");
        const now = new Date();
        try {
          const by = authorisation(actingFor(st, "schedule"));
          const s = createSchedule(db, { chatId: chat.id, note, ...(at ? { at: parseAt(at, timeZone, now) } : { cron: cron!.trim() }), timeZone, turnId, ...by }, now);
          return ok(`Scheduled ${describe(s, timeZone)}. It is now ${fullTime(now.toISOString(), timeZone)} (${timeZone}).`);
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    };
    const list: ToolDef<Record<string, never>> = {
      name: "list_schedules",
      description: "List this chat's active schedules, soonest first, then its paused ones.",
      inputSchema: {},
      async handler() {
        // The active ones first, soonest first; the paused ones after them.
        const all = activeSchedules(db, chat.id).sort((a, b) => Number(a.state === "paused") - Number(b.state === "paused"));
        return ok(all.length ? all.map((s) => describe(s, timeZone)).join("\n") : "No active schedules in this chat.");
      },
    };
    const cancel: ToolDef<{ id: number }> = {
      name: "cancel_schedule",
      description: "Cancel one of this chat's schedules, by the #id list_schedules shows.",
      inputSchema: { id: z.number().int().describe("The schedule's #id") },
      async handler({ id }) {
        // An operator may cancel what operators set, never what the owner set.
        const acting = actingFor(st, "cancel_schedule");
        if (acting?.by !== "owner" && getSchedule(db, id)?.ownerAuthorised && getSchedule(db, id)?.chatId === chat.id)
          return err(`Schedule #${id} was set by the owner; only the owner can cancel it.`);
        return cancelSchedule(db, id, chat.id) ? ok(`Cancelled schedule #${id}.`) : err(`There is no active schedule #${id} in this chat.`);
      },
    };
    return [{ serverName: "shuvi", tools: [schedule, list, cancel] as ToolDef[] }];
  },
  section: (ctx) =>
    policyDelegates(ctx.chatPolicy, "schedules")
      ? `${SCHEDULES} Here this group's operators may ask for schedules too; a schedule the owner set only he can cancel.`
      : SCHEDULES,
  loops: ({ db }) => [
    {
      name: "schedules",
      everyMs: FIRE_EVERY_MS,
      run: async () => {
        const { fired, stopped } = fireDue(db);
        if (fired.length) console.log(`schedules: fired ${fired.map((id) => `#${id}`).join(", ")}`);
        // A schedule that stops on its own must not go quiet unseen (design §13: the owner is told).
        for (const s of stopped)
          raiseAlert(db, { key: `schedule-stopped:${s.id}`, text: `Schedule #${s.id} ("${s.cron}") stopped: its cron expression no longer parses (${s.error}). It fired one last time.` });
      },
    },
  ],
});
