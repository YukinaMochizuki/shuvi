import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runTurn } from "../src/agent/turn.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import { defineCapability, type EnabledCapability } from "../src/capabilities/types.ts";
import { parsePolicy } from "../src/policy/policy.ts";
import type { Db } from "../src/store/db.ts";
import { ensureChat, markSent, recordInbound, type MessagePayload } from "../src/store/events.ts";
import { claimTurn } from "../src/store/turns.ts";
import { lastSeq, memDb, OWNER, ScriptedAdapter, type Step } from "./helpers.ts";

/**
 * Console fixture data: a store with a few turns recorded through the real turn (agent/turn.ts) and its
 * transcript recorder, on a scripted driver. Used by the console's tests and by scripts/console-fixture.ts
 * for screenshots. Every name in it is made up (the repository is public).
 *
 *   chat 1, the owner's DM
 *     turn 1  done: thinking, a text block, `look_at` (an image result), a message arriving mid-turn and
 *             appended, `say`, the final text; its input carries a photo
 *     turn 2  failed: the system prompt changed (directives.md edited), a tool call, then the driver fails
 *     turn 3  done: `pass`, then a `say` the boundary refuses
 *   chat 2, "Example Group"
 *     turn 4  done: a reaction and a reply, the owner's line marked
 */

/** A 24x24 PNG checkerboard in two colours, small enough to keep inline. */
export const FIXTURE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAoElEQVR4AbXBQXUEQAhEwb+8kYIVFOAmcnJHAVbwscfk2ga66vPz+/1DbDaqblCbjaob1GajArPALDB7m42qG9Rmo+oGtdmoukEFZoFZYPbqBrXZqLpBbTaqblCbjQrMArPA7G02qm5Qm42qG9Rmo+oGFZgFZoHZqxvUZqPqBrXZqLpBbTYqMAvMArO32ai6QW02qm5Qm42qG1RgFpgFZv83kzd+XasDkgAAAABJRU5ErkJggg==",
  "base64",
);

export const FIXTURE_GROUP = { id: -100123, title: "Example Group" };
export const ALICE = { id: 2002, name: "Alice Example" };

export interface ConsoleFixture {
  db: Db;
  dataDir: string;
  home: string;
  turns: { done: number; failed: number; passed: number; group: number };
}

/** A capability with one tool that answers with a picture (not read from a file: stored as a transcript copy). */
const lookAt = defineCapability<object>({
  id: "lookat",
  label: "lookat",
  gives: "a lookat tool, for this test.",
  enable: () => ({}),
  tools: (_ctx, _config) => [
    {
      serverName: "shuvi",
      tools: [
        {
          name: "look_at",
          description: "Look at an example picture.",
          inputSchema: { what: z.string() },
          handler: async ({ what }: { what: string }) => ({
            content: [
              { type: "text" as const, text: `Here is ${what}.` },
              { type: "image" as const, data: FIXTURE_PNG.toString("base64"), mimeType: "image/png" },
            ],
          }),
        },
      ],
    },
  ],
});

/** Made-up notes and pages for the research tools to return: long, so the console's folding has work to do. */
const NOTE = (title: string) =>
  [
    `# ${title}`,
    "",
    "Planned with the owner over three weeks; everything here is an example.",
    "",
    "## Getting there",
    ...Array.from({ length: 14 }, (_, i) => `- Leg ${i + 1}: example line ${i + 1}, departs ${String(7 + i).padStart(2, "0")}:15 from Example Central, platform ${(i % 6) + 1}.`),
    "",
    "## The cabin",
    "Lakeside Cabin (example listing 4471). Check-in from 15:00, the key is in the lockbox by the door.",
    "Pets: ask the host first; the listing says small dogs are fine on request.",
    "",
    "## Open questions",
    ...Array.from({ length: 10 }, (_, i) => `- Question ${i + 1}: something still to settle about day ${i + 1}.`),
  ].join("\n");
const PAGE = Array.from({ length: 40 }, (_, i) => `Example Rail timetable, line ${i + 1}: Example Central ${String(6 + (i % 14)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")} → Lakeside ${String(8 + (i % 14)).padStart(2, "0")}:${String((i * 11) % 60).padStart(2, "0")}, reserved seats available.`).join("\n");

/** How long a research tool takes (with `pauses`): a lookup a few hundred ms, a page fetch longer. */
let toolLatency: ((name: string) => number) | null = null;

/** Tools for the rich fixture: lookups with long results, an error, and one owner-only call. */
const research = defineCapability<object>({
  id: "research",
  label: "research",
  gives: "a research tool, for this test.",
  enable: () => ({}),
  ownerOnly: ["set_reminder"],
  section: () =>
    "## Research\n\nYou can search and read the owner's notes (`search_notes`, `read_note`), look at the calendar (`check_calendar`), fetch a page (`fetch_page`), query the bookings table (`run_query`) and set reminders for the owner (`set_reminder`). Prefer the notes over the web; say where an answer came from.",
  tools: () => {
    const t = (name: string, handler: (a: Record<string, unknown>) => { content: { type: "text"; text: string }[]; isError?: boolean }) => ({
      name,
      description: `Example tool ${name}.`,
      inputSchema: {},
      handler: async (a: Record<string, unknown>) => {
        if (toolLatency) await Bun.sleep(toolLatency(name));
        return handler(a);
      },
    });
    const text = (s: string, isError = false) => ({ content: [{ type: "text" as const, text: s }], ...(isError ? { isError } : {}) });
    return [
      {
        serverName: "shuvi",
        tools: [
          t("search_notes", (a) => text(Array.from({ length: 8 }, (_, i) => `notes/trip-${i + 1}.md:${i * 3 + 2}: …${a.query} … (example match ${i + 1})`).join("\n"))),
          t("read_note", (a) => text(NOTE(String(a.path)))),
          t("check_calendar", () => text(JSON.stringify({ events: [{ day: "Friday", title: "Trip to Lakeside", from: "08:00" }, { day: "Saturday", title: "Cabin", from: "all day" }] }, null, 2))),
          t("fetch_page", () => text(PAGE)),
          t("run_query", (a) => (String(a.sql).includes("pets") ? text("Error: no such column: pets (table bookings has: id, place, nights, guests)", true) : text("id | place          | nights | guests\n71 | Lakeside Cabin |      2 |      2"))),
          t("set_reminder", () => text("Reminder set.")),
        ],
      },
    ];
  },
});

/**
 * `pauses`: let some time pass between steps, as a real turn would (for screenshots; tests skip it).
 * `rich`: a longer system prompt from the start, and two more turns after the base four (a group turn with
 * several speakers, a refusal and a mid-turn message; a research turn with a dozen tool calls and long
 * results), for judging the console at scale. The base turns' tests do not use it.
 */
export async function buildConsoleFixture(opts: { pauses?: boolean; rich?: boolean } = {}): Promise<ConsoleFixture> {
  const pause = (ms: number): Step => ({ run: () => opts.pauses && Bun.sleepSync(ms) });
  toolLatency = opts.pauses ? (name) => ({ fetch_page: 1400, read_note: 240, search_notes: 380, run_query: 120, check_calendar: 310 })[name] ?? 90 : null;
  const dataDir = mkdtempSync(join(tmpdir(), "shuvi-console-"));
  const home = join(dataDir, "home");
  mkdirSync(join(home, "persona"), { recursive: true });
  mkdirSync(join(dataDir, "media"), { recursive: true });
  writeFileSync(
    join(home, "persona/public.md"),
    opts.rich
      ? "You are Shuvi, an example assistant. You are warm, brief and exact.\n\nYou live in Telegram and talk mostly with the owner, sometimes in a few small groups of their friends. You keep answers short unless asked for detail, you say when you are unsure, and you never make up a date, a price or a name.\n\nWhen you look something up, say where it came from in a few words. When a request is ambiguous, ask one short question rather than guessing.\n"
      : "You are Shuvi, an example assistant. You are warm, brief and exact.\n",
  );
  writeFileSync(join(home, "directives.md"), "- Always answer in one short paragraph.\n- Never guess a date; ask.\n");
  writeFileSync(join(dataDir, "media", "example-photo"), FIXTURE_PNG);
  const db = memDb();

  const groupEntry = (id: number) => `  "${id}":\n    trigger: [mention, reply]\n    persona: [public]\n    tools: all\n`;
  const policy = parsePolicy(`owner: ${OWNER}\nchats:\n  dm:\n    tools: all\n${[FIXTURE_GROUP.id, -100201, -100202, -100203].map(groupEntry).join("")}`);
  if ("error" in policy) throw new Error(policy.error);
  const env = { SHUVI_DATA_DIR: dataDir, SHUVI_WEB: "off", SHUVI_SCHEDULES: "off", SHUVI_MEMORY: "off", SHUVI_RETRIEVAL: "off", SHUVI_PLAYBOOKS: "off", SHUVI_STICKERS: "off" };
  const capabilities: EnabledCapability[] = opts.rich
    ? [...enabledCapabilities({ SHUVI_DATA_DIR: dataDir, SHUVI_WEB: "off", SHUVI_STICKERS: "off" }), { capability: lookAt as never, config: {} }, { capability: research as never, config: {} }]
    : [...enabledCapabilities(env), { capability: lookAt as never, config: {} }];

  let update = 1;
  const say = (chatId: number, from: { id: number; name: string }, text: string, extra: Partial<MessagePayload> = {}) => {
    recordInbound(db, { chatId, kind: "message", payload: { from, text, ...extra }, tgUpdateId: update++, tgMessageId: 100 + update });
    return lastSeq(db);
  };
  const turn = async (chatId: number, script: Step[], trigger?: number, usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number }) => {
    const t = claimTurn(db, chatId, trigger)!;
    await runTurn({
      db,
      turnId: t.id,
      home,
      timeZone: "Asia/Taipei",
      ownerId: OWNER,
      policy: policy.policy,
      bot: { id: 1, username: "example_bot" },
      capabilities,
      makeAdapter: (b) => {
        const a = new ScriptedAdapter(b, script);
        if (!usage) return a;
        // A real turn's usage, for the rich fixture's numbers.
        const run = a.run.bind(a);
        const cont = a.continueRun.bind(a);
        a.run = async (i, o) => ({ ...(await run(i, o)), usage: { model: "claude-example-1", ...usage } });
        a.continueRun = async (i, o) => ({ ...(await cont(i, o)), usage: { model: "claude-example-1", ...usage } });
        return a;
      },
      record: { dataDir },
    });
    // Delivered, as the sender would have: the console shows each message's Telegram status.
    for (const r of db.$client.query("select seq from chat_events where turn_id = ? and status = 'pending'").all(t.id) as { seq: number }[]) markSent(db, r.seq, 9000 + r.seq);
    return t.id;
  };

  const dm = ensureChat(db, { id: OWNER, kind: "private" }).id;
  const owner = { id: OWNER, name: "Owner" };
  say(dm, owner, "[photo] what is in this picture? and remind me what we said about the trip", {
    placeholder: true,
    media: { kind: "photo", fileUniqueId: "example-photo", file: { fileId: "f-example", fileUniqueId: "example-photo" }, state: "ready", path: "media/example-photo", mimeType: "image/png" },
  });
  const done = await turn(dm, [
    { token: "The owner sent a photo and asks two things. Look at the picture first, then answer both.", thinking: true },
    pause(120),
    { token: "Let me take a closer look." },
    { tool: "look_at", args: { what: "the photo, enlarged" } },
    pause(200),
    { run: () => void say(dm, owner, "oh, and the trip is next Friday") },
    { tool: "say", args: { text: "It is a small checkerboard in two colours." } },
    pause(150),
    { token: "They added the date. Next Friday; nothing else was decided.", thinking: true },
    { token: "About the trip: next Friday, and nothing else is settled yet." },
  ]);

  writeFileSync(join(home, "directives.md"), "- Always answer in one short paragraph.\n- Never guess a date; ask.\n- Always name the day of the week with a date.\n");
  say(dm, owner, "book the train for it");
  const failed = await turn(dm, [{ token: "Booking needs the computer; check first.", thinking: true }, pause(80), { tool: "say", args: { text: "Looking for trains now." } }, pause(300), { fail: "Claude Agent SDK run ended with \"error_during_execution\": API error 529 overloaded" }]);

  say(dm, owner, "never mind, thanks");
  const passed = await turn(dm, [{ tool: "pass", args: { reaction: "👍" } }, { tool: "say", args: { text: "You're welcome!" } }]);

  const group = ensureChat(db, { id: FIXTURE_GROUP.id, kind: "group", title: FIXTURE_GROUP.title }).id;
  say(group, ALICE, "has anyone tried the new example café?");
  const ask = say(group, owner, "@example_bot what do you know about it?", { mentions: { usernames: ["example_bot"], userIds: [] } });
  const groupTurn = await turn(group, [{ tool: "react", args: { seq: ask, emoji: "👀" } }, pause(60), { token: "Only that it opened last week, as far as this chat goes." }], ask);

  if (opts.rich) {
    // More chats, so the grouped list has groups to fold, and a chat with more turns than it shows.
    const extra = [
      { id: -100201, title: "Book Club Example", people: [{ id: 2101, name: "Dana Example" }, { id: 2102, name: "Eli Example" }], turns: 7, fail: 3 },
      { id: -100202, title: "Family Example", people: [{ id: 2201, name: "Fay Example" }], turns: 3, fail: -1 },
      { id: -100203, title: "Work Example", people: [{ id: 2301, name: "Gus Example" }, { id: 2302, name: "Hal Example" }], turns: 4, fail: -1 },
    ];
    for (const x of extra) {
      const chatId = ensureChat(db, { id: x.id, kind: "group", title: x.title }).id;
      for (let i = 0; i < x.turns; i++) {
        const who = x.people[i % x.people.length]!;
        const seq = say(chatId, who, `@example_bot question ${i + 1} about ${x.title.split(" ")[0]!.toLowerCase()}`, { mentions: { usernames: ["example_bot"], userIds: [] } });
        await turn(chatId, i === x.fail ? [{ token: "Checking.", thinking: true }, { fail: "Claude Agent SDK run ended with \"error_during_execution\": API error 500 internal" }] : [{ token: `Answer ${i + 1}.` }], seq);
        if (i === x.fail) {
          // The retry answers it.
          await turn(chatId, [{ token: `Answer ${i + 1}, on the second try.` }], seq);
        }
      }
    }

    const bob = { id: 2003, name: "Bob Example" };
    const carol = { id: 2004, name: "Carol Example" };
    say(group, carol, "it was busy on Sunday, but the pastries were worth it");
    say(group, ALICE, "we should all go before the trip");
    const bobAsk = say(group, bob, "@example_bot set a reminder for everyone to go Thursday at 6, and what time does it open?", { mentions: { usernames: ["example_bot"], userIds: [] } });
    await turn(
      group,
      [
        { token: "Bob asks for two things. A reminder is the owner's to set; the opening hours I can answer from what was said here.", thinking: true },
        pause(90),
        { tool: "set_reminder", args: { at: "Thursday 18:00", text: "Example café with everyone" } },
        pause(60),
        { run: () => void say(group, carol, "I think it opens at 8") },
        { tool: "say", args: { text: "I can't set reminders for the group; only the owner can ask me for that." } },
        pause(120),
        { token: "Carol says 8. Nobody has contradicted it.", thinking: true },
        { token: "Carol thinks it opens at 8; I have nothing more reliable than that." },
      ],
      bobAsk,
      { inputTokens: 1840, outputTokens: 96, cacheReadTokens: 14200, cacheCreationTokens: 610, costUsd: 0.0124 },
    );

    say(dm, owner, "can you put together everything we have on the Lakeside trip? trains, the cabin, and anything still open");
    await turn(
      dm,
      [
        { token: "The owner wants a summary of the Lakeside trip: trains, the cabin, open questions. Start from the notes, then the calendar, then check the timetable.", thinking: true },
        pause(140),
        { token: "Let me pull together what we have." },
        { tool: "search_notes", args: { query: "Lakeside" } },
        pause(180),
        { tool: "read_note", args: { path: "notes/trip-1.md" } },
        pause(160),
        { tool: "read_note", args: { path: "notes/trip-3.md" } },
        pause(90),
        { token: "Two notes cover it. The calendar should confirm the dates; the bookings table has the cabin.", thinking: true },
        { tool: "check_calendar", args: { from: "Friday", to: "Sunday" } },
        pause(220),
        { tool: "run_query", args: { sql: "select place, nights, pets from bookings where place like '%Lakeside%'" } },
        pause(60),
        { tool: "run_query", args: { sql: "select id, place, nights, guests from bookings where place like '%Lakeside%'" } },
        pause(70),
        { run: () => void say(dm, owner, "also, is the cabin dog-friendly?") },
        { tool: "say", args: { text: "Found the booking (2 nights, 2 guests). Checking train times now." } },
        pause(300),
        { tool: "fetch_page", args: { url: "https://rail.example/timetable?from=central&to=lakeside" } },
        pause(120),
        { tool: "search_notes", args: { query: "dog" } },
        pause(100),
        { tool: "read_note", args: { path: "notes/trip-2.md" } },
        pause(80),
        { tool: "set_reminder", args: { at: "Thursday 20:00", text: "Pack for Lakeside; ask the host about the dog" } },
        pause(150),
        { token: "Answer the dog question from the note: small dogs on request. Then the summary, short.", thinking: true },
        {
          token:
            "Here is the Lakeside trip so far:\n\n**Trains** — Friday, Example Central 08:15 → Lakeside 10:40; reserved seats are still available.\n**Cabin** — Lakeside Cabin, 2 nights, 2 guests; check-in from 15:00, key in the lockbox.\n**Dog** — small dogs are fine on request, so ask the host first. I set a reminder for Thursday evening.\n**Still open** — ten small questions in your notes, mostly about day plans.",
        },
      ],
      undefined,
      { inputTokens: 3120, outputTokens: 742, cacheReadTokens: 38400, cacheCreationTokens: 2210, costUsd: 0.0587 },
    );
  }

  return { db, dataDir, home, turns: { done, failed, passed, group: groupTurn } };
}
