import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMessage } from "../src/agent/render.ts";
import { runTurn } from "../src/agent/turn.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import type { Db } from "../src/store/db.ts";
import { getEvent, type ScheduledPayload } from "../src/store/events.ts";
import { capabilityLoops } from "../src/capabilities/types.ts";
import { controlMessagesOf } from "../src/store/control.ts";
import { activeSchedules, cancelSchedule, createSchedule, fireDue, getSchedule, MIN_CRON_INTERVAL_MS, parseAt, validateCron } from "../src/store/schedules.ts";
import { claimTurn, finishTurn, getTurn } from "../src/store/turns.ts";
import { memDb, OWNER, ownerChatId, ownerSays, ScriptedAdapter, type Step } from "./helpers.ts";

const TZ = "Asia/Taipei";
const home = mkdtempSync(join(tmpdir(), "shuvi-home-"));
const scheduledEvents = (db: Db) => db.$client.query("select seq, chat_id as chatId, payload from chat_events where kind = 'scheduled'").all() as { seq: number; chatId: number; payload: string }[];

async function turnWith(db: Db, script: Step[], ownerId: number | undefined = OWNER) {
  const turn = claimTurn(db, ownerChatId(db))!;
  let adapter!: ScriptedAdapter;
  const outcome = await runTurn({
    db,
    turnId: turn.id,
    home,
    timeZone: TZ,
    ...(ownerId !== undefined ? { ownerId } : {}),
    capabilities: enabledCapabilities({ SHUVI_WEB: "off", SHUVI_MEMORY: "off", SHUVI_RETRIEVAL: "off", SHUVI_PLAYBOOKS: "off" }),
    makeAdapter: (b) => (adapter = new ScriptedAdapter(b, script)),
  });
  return { outcome, adapter, turn: getTurn(db, turn.id)! };
}
const resultText = (a: ScriptedAdapter, i = 0) => a.toolResults[i]!.result.content.map((c) => (c.type === "text" ? c.text : "")).join("");

describe("times", () => {
  const now = new Date("2026-11-11T10:00:00Z");
  test("relative offsets, wall-clock times in SHUVI_TZ, and explicit offsets", () => {
    expect(parseAt("+10m", TZ, now).toISOString()).toBe("2026-11-11T10:10:00.000Z");
    expect(parseAt("+1h30m", TZ, now).toISOString()).toBe("2026-11-11T11:30:00.000Z");
    expect(parseAt("+1d", TZ, now).toISOString()).toBe("2026-11-12T10:00:00.000Z");
    expect(parseAt("2026-11-12 08:00", TZ, now).toISOString()).toBe("2026-11-12T00:00:00.000Z");
    expect(parseAt("2026-11-12T08:00:00Z", TZ, now).toISOString()).toBe("2026-11-12T08:00:00.000Z");
    expect(() => parseAt("tomorrow", TZ, now)).toThrow();
  });

  test("a one-shot in the past, both or neither of at/cron, or a bad cron, is refused", () => {
    const db = memDb();
    ownerSays(db, "hi");
    const chatId = ownerChatId(db);
    expect(() => createSchedule(db, { chatId, note: "n", at: new Date(now.getTime() - 1), timeZone: TZ }, now)).toThrow("in the past");
    expect(() => createSchedule(db, { chatId, note: "n", timeZone: TZ }, now)).toThrow("exactly one");
    expect(() => createSchedule(db, { chatId, note: "n", cron: "every day", timeZone: TZ }, now)).toThrow("cron");
  });

  test("cron: five fields or a nickname only; a seconds field is refused; never more often than once a minute", () => {
    const db = memDb();
    ownerSays(db, "hi");
    const chatId = ownerChatId(db);
    expect(() => createSchedule(db, { chatId, note: "n", cron: "*/5 * * * * *", timeZone: TZ }, now)).toThrow("a seconds field is not allowed");
    expect(() => createSchedule(db, { chatId, note: "n", cron: "0 0 8 * * * 2027", timeZone: TZ }, now)).toThrow("not a five-field cron expression");
    expect(() => createSchedule(db, { chatId, note: "n", cron: "@every5s", timeZone: TZ }, now)).toThrow("nickname");
    expect(validateCron("* * * * *", TZ, now)).toBeUndefined();
    expect(createSchedule(db, { chatId, note: "n", cron: "@daily", timeZone: TZ }, now).nextAt).toBe("2026-11-11T16:00:00.000Z");
    expect(MIN_CRON_INTERVAL_MS).toBe(60_000);
  });
});

describe("firing", () => {
  test("a due one-shot writes one scheduled event into its chat, and is done", () => {
    const db = memDb();
    ownerSays(db, "remind me");
    const t0 = new Date("2026-11-11T10:00:00Z");
    const s = createSchedule(db, { chatId: ownerChatId(db), note: "stretch", at: new Date("2026-11-11T10:05:00Z"), timeZone: TZ }, t0);
    expect(fireDue(db, new Date("2026-11-11T10:04:59Z")).fired).toEqual([]);
    expect(fireDue(db, new Date("2026-11-11T10:05:00Z")).fired).toEqual([s.id]);
    expect(fireDue(db, new Date("2026-11-11T10:06:00Z")).fired).toEqual([]);
    const ev = scheduledEvents(db);
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]!.payload)).toEqual({ scheduleId: s.id, note: "stretch", dueAt: "2026-11-11T10:05:00.000Z" } satisfies ScheduledPayload);
    expect(getSchedule(db, s.id)!.state).toBe("done");
  });

  test("a cron schedule missed through downtime fires once on start, then moves to its next run after now", () => {
    const db = memDb();
    ownerSays(db, "daily");
    const t0 = new Date("2026-11-01T00:00:00Z");
    const s = createSchedule(db, { chatId: ownerChatId(db), note: "morning check", cron: "0 8 * * *", timeZone: TZ }, t0);
    // 08:00 in Taipei is 00:00 UTC; t0 is exactly one, so the next run is the day after.
    expect(s.nextAt).toBe("2026-11-02T00:00:00.000Z");
    // Down for ten days: ten occurrences missed.
    const back = new Date("2026-11-11T03:00:00Z");
    expect(fireDue(db, back)).toEqual({ fired: [s.id], stopped: [] });
    expect(fireDue(db, new Date(back.getTime() + 1000)).fired).toEqual([]);
    expect(scheduledEvents(db)).toHaveLength(1);
    expect(getSchedule(db, s.id)!.nextAt).toBe("2026-11-12T00:00:00.000Z");
    expect(getSchedule(db, s.id)!.state).toBe("active");
  });

  test("a late firing says so when rendered; a timely one does not", () => {
    const db = memDb();
    ownerSays(db, "x");
    const s = createSchedule(db, { chatId: ownerChatId(db), note: "check the deploy", at: new Date(Date.now() + 1000), timeZone: TZ });
    fireDue(db, new Date(Date.now() + 2000));
    const e = getEvent(db, scheduledEvents(db)[0]!.seq)!;
    expect(renderMessage(e, TZ)).toMatch(new RegExp(`^\\[#${e.seq} · \\d\\d/\\d\\d \\d\\d:\\d\\d · ⚙ schedule ${s.id}\\] check the deploy$`));
    db.$client.run("update chat_events set payload = json_set(payload, '$.dueAt', '2026-01-01T00:00:00.000Z') where seq = ?", [e.seq]);
    expect(renderMessage(getEvent(db, e.seq)!, TZ)).toContain("fired late, after downtime");
  });

  test("a cancelled schedule never fires; cancel is per chat", () => {
    const db = memDb();
    ownerSays(db, "x");
    const s = createSchedule(db, { chatId: ownerChatId(db), note: "n", at: new Date(Date.now() + 1000), timeZone: TZ });
    expect(cancelSchedule(db, s.id, ownerChatId(db) + 1)).toBe(false);
    expect(cancelSchedule(db, s.id, ownerChatId(db))).toBe(true);
    expect(cancelSchedule(db, s.id, ownerChatId(db))).toBe(false);
    expect(fireDue(db, new Date(Date.now() + 5000)).fired).toEqual([]);
  });

  test("a cron that no longer parses fires once, stops, and the owner is told", async () => {
    const db = memDb();
    ownerSays(db, "x");
    const s = createSchedule(db, { chatId: ownerChatId(db), note: "n", cron: "0 8 * * *", timeZone: TZ });
    db.$client.run("update schedules set cron = 'no longer valid', next_at = '2000-01-01T00:00:00.000Z' where id = ?", [s.id]);
    const stop = new AbortController();
    const files = { download: async () => new Uint8Array() };
    const loop = capabilityLoops(enabledCapabilities({ SHUVI_WEB: "off" }), { db, home, timeZone: TZ, ownerId: OWNER, files, signal: stop.signal }).find((l) => l.name === "schedules")!;
    await loop.run();
    stop.abort();
    const alerts = controlMessagesOf(db, "alert").map((m) => m.text);
    expect(getSchedule(db, s.id)!.state).toBe("done");
    expect(scheduledEvents(db)).toHaveLength(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain(`Schedule #${s.id} ("no longer valid") stopped`);
  });
});

describe("a schedule firing starts a turn, through the same cursor rule", () => {
  test("scheduled → one turn, which sees the note as a framework event; answered once", async () => {
    const db = memDb();
    ownerSays(db, "remind me to stretch");
    const first = claimTurn(db, ownerChatId(db))!;
    finishTurn(db, first.id, { status: "done" });
    createSchedule(db, { chatId: ownerChatId(db), note: "remind them to stretch", at: new Date(Date.now() + 1000), timeZone: TZ });
    expect(claimTurn(db, ownerChatId(db))).toBeNull();
    fireDue(db, new Date(Date.now() + 2000));
    const { outcome, adapter } = await turnWith(db, [{ token: "Time to stretch!" }]);
    expect(outcome).toBe("done");
    expect(adapter.calls[0]!.prompt).toMatch(/· ⚙ schedule \d+\] remind them to stretch/);
    // What the turn answers is the schedule, not someone speaking (the earlier message is history).
    expect((adapter.calls[0]!.prompt as string).split("(New messages:)").at(-1)).not.toContain("Owner]");
    // A turn a schedule started may set the next one.
    expect(adapter.calls[0]!.tools).toContain("schedule");
    // Answered: nothing left past the cursor.
    expect(claimTurn(db, ownerChatId(db))).toBeNull();
  });
});

describe("the tools", () => {
  test("schedule, list_schedules and cancel_schedule in an owner turn", async () => {
    const db = memDb();
    ownerSays(db, "ping me in ten minutes, and every weekday at 9");
    const { adapter } = await turnWith(db, [
      { tool: "schedule", args: { at: "+10m", note: "ping them" } },
      { tool: "schedule", args: { cron: "0 9 * * 1-5", note: "weekday check" } },
      { tool: "schedule", args: { at: "+10m", cron: "0 9 * * *", note: "both" } },
      { tool: "list_schedules", args: {} },
      { tool: "cancel_schedule", args: { id: 1 } },
      { tool: "cancel_schedule", args: { id: 99 } },
    ]);
    expect(resultText(adapter, 0)).toMatch(/^Scheduled #1: once, \w{3} \d{4}-\d\d-\d\d \d\d:\d\d: ping them\. It is now /);
    expect(resultText(adapter, 1)).toContain(`cron "0 9 * * 1-5" (${TZ})`);
    expect(adapter.toolResults[2]!.result.isError).toBe(true);
    expect(resultText(adapter, 3).split("\n")).toHaveLength(2);
    expect(resultText(adapter, 4)).toBe("Cancelled schedule #1.");
    expect(adapter.toolResults[5]!.result.isError).toBe(true);
    expect(activeSchedules(db, ownerChatId(db)).map((s) => s.note)).toEqual(["weekday check"]);
  });

  test("a turn the owner did not trigger is offered them, and every call is refused", async () => {
    const db = memDb();
    ownerSays(db, "hi");
    // The message's sender is not the configured owner.
    const { adapter } = await turnWith(db, [{ tool: "schedule", args: { at: "+1h", note: "n" } }, { tool: "list_schedules", args: {} }, { tool: "cancel_schedule", args: { id: 1 } }], 4242);
    expect(adapter.calls[0]!.tools).toEqual(["say", "react", "pass", "schedule", "list_schedules", "cancel_schedule"]);
    expect(adapter.toolResults.map((r) => r.result.isError)).toEqual([true, true, true]);
    expect(resultText(adapter, 0)).toStartWith("Refused: `schedule` acts for the owner");
    expect(activeSchedules(db, ownerChatId(db))).toHaveLength(0);
  });

  test("the section is in the prompt when schedules are on", async () => {
    const db = memDb();
    ownerSays(db, "hi");
    const { adapter } = await turnWith(db, [{ tool: "pass" }]);
    expect(adapter.calls[0]!.systemPrompt).toContain("## Schedules");
  });
});
