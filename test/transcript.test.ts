import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt } from "../src/agent/prompt.ts";
import { runAtBoundary } from "agent-runtime";
import { pruneTranscriptMedia, recordingBoundary, redactDeep, TRANSCRIPT_MEDIA, TurnRecorder } from "../src/agent/transcript.ts";
import { runTurn } from "../src/agent/turn.ts";
import { LiveRedaction, redactor } from "../src/secrets/redaction.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import { defineCapability } from "../src/capabilities/types.ts";
import { getChat } from "../src/store/events.ts";
import { getPromptText, getTranscript, pruneTranscripts, stepsOf } from "../src/store/transcripts.ts";
import { claimTurn, getTurn } from "../src/store/turns.ts";
import { buildConsoleFixture } from "./console-fixture.ts";
import { memDb, ownerChatId, ownerSays, ScriptedAdapter, type Step } from "./helpers.ts";

const CAPS = { SHUVI_WEB: "off", SHUVI_VISION: "off", SHUVI_STICKERS: "off", SHUVI_SCHEDULES: "off", SHUVI_MEMORY: "off", SHUVI_RETRIEVAL: "off", SHUVI_PLAYBOOKS: "off", SHUVI_GROUPS: "off" };

describe("the turn transcript", () => {
  test("records the prompt by section, the input with image references, and the timeline in order", async () => {
    const f = await buildConsoleFixture();
    const steps = stepsOf(f.db, f.turns.done);
    expect(steps.map((s) => (s.kind === "tool" ? `tool:${s.name}` : s.kind))).toEqual(["thinking", "text", "tool:look_at", "tool:say", "append", "thinking", "text"]);
    expect(steps.map((s) => s.n)).toEqual([0, 1, 2, 3, 4, 5, 6]);

    // Text blocks: each with the message it became.
    const [first, last] = steps.filter((s) => s.kind === "text");
    expect(first!.text).toBe("Let me take a closer look.");
    expect(first!.sent).toBe(true);
    const out = f.db.$client.query("select seq, payload from chat_events where seq = ?").get(first!.outboundSeq!) as { seq: number; payload: string };
    expect(JSON.parse(out.payload).text).toBe("Let me take a closer look.");
    expect(last!.sent).toBe(true);
    expect(steps[0]!.text).toContain("Look at the picture first");

    // A tool call: its arguments, its result, start and end, and an image result stored as a reference.
    const look = steps[2]!;
    expect(JSON.parse(look.args!)).toEqual({ what: "the photo, enlarged" });
    expect(look.status).toBe("ok");
    expect(look.result).toBe("Here is the photo, enlarged.");
    expect(look.callId).toBeTruthy();
    expect(look.endedAt).toBeTruthy();
    expect(look.images).toHaveLength(1);
    expect(look.images![0]!.ref).toMatch(new RegExp(`^${TRANSCRIPT_MEDIA}/[0-9a-f]{64}\\.png$`));
    expect(existsSync(join(f.dataDir, look.images![0]!.ref))).toBe(true);
    // Never base64 in the store.
    const dump = JSON.stringify(f.db.$client.query("select * from turn_steps").all()) + JSON.stringify(f.db.$client.query("select * from turn_transcripts").all());
    expect(dump).not.toContain("iVBORw0KGgo");

    // The append: which events, after which call.
    const say = steps[3]!;
    const append = steps[4]!;
    expect(append.callId).toBe(say.callId);
    const added = f.db.$client.query("select seq from chat_events where payload like '%next Friday%' and kind = 'message'").get() as { seq: number };
    expect([append.fromSeq, append.toSeq]).toEqual([added.seq - 1, added.seq]);
    expect(append.text).toContain("oh, and the trip is next Friday");

    // The input: text, then the photo as a reference to its media/ file.
    const t = getTranscript(f.db, f.turns.done)!;
    expect(t.resumed).toBe(false);
    expect(t.model).toBe("fake");
    expect(t.input.find((p) => p.type === "image")).toEqual({ type: "image", ref: "media/example-photo", mimeType: "image/png" });

    // The prompt: exactly what was sent, by section.
    const prompt = getPromptText(f.db, t.promptHash!)!;
    const chat = getChat(f.db, ownerChatId(f.db))!;
    expect(prompt.sections.map((s) => s.label)).toEqual(["persona/public.md", "directives.md", "this chat", "capability: speech", "capability: vision", "capability: jobs", "capability: groups"].filter((l) => prompt.sections.some((s) => s.label === l)));
    expect(prompt.sections[0]!.label).toBe("persona/public.md");
    expect(prompt.text.slice(prompt.sections[1]!.start, prompt.sections[1]!.end)).toStartWith("## Rules");
    expect(prompt.text).toContain("## This chat");
    expect(chat.id).toBe(1);
  });

  test("usage, outcome and error are on the turn; a changed home/ is a new prompt text, an unchanged one is shared", async () => {
    const f = await buildConsoleFixture();
    const done = getTurn(f.db, f.turns.done)!;
    expect(done).toMatchObject({ status: "done", inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 0, costMicroUsd: 1000 });
    const failed = getTurn(f.db, f.turns.failed)!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("overloaded");
    expect(stepsOf(f.db, f.turns.failed).map((s) => s.kind)).toEqual(["thinking", "tool"]);
    const hashes = [f.turns.done, f.turns.failed, f.turns.passed].map((id) => getTranscript(f.db, id)!.promptHash);
    expect(hashes[0]).not.toBe(hashes[1]); // directives.md changed between them
    expect(hashes[1]).toBe(hashes[2]);
    expect((f.db.$client.query("select count(*) as n from prompt_texts").get() as { n: number }).n).toBe(3); // two in the DM, one in the group
    expect(getTranscript(f.db, f.turns.failed)!.resumed).toBe(true);
  });

  test("a refused call is recorded with the refusal; text written after pass is recorded as not sent", async () => {
    const db = memDb();
    ownerSays(db, "thanks");
    const turn = claimTurn(db, ownerChatId(db))!;
    const home = mkdtempSync(join(tmpdir(), "shuvi-home-"));
    await runTurn({ db, turnId: turn.id, home, timeZone: "UTC", capabilities: enabledCapabilities(CAPS), makeAdapter: (b) => new ScriptedAdapter(b, [{ tool: "pass" }, { tool: "say", args: { text: "no" } }, { token: "nor this" }]) });
    const steps = stepsOf(db, turn.id);
    expect(steps.map((s) => [s.kind, s.name, s.status])).toEqual([
      ["tool", "pass", "ok"],
      ["tool", "say", "refused"],
      ["text", null, null],
    ]);
    expect(steps[1]!.error).toContain("already passed");
    expect(steps[1]!.callId).toBeNull();
    expect(steps[2]).toMatchObject({ text: "nor this", sent: false, outboundSeq: null });
  });

  test("a tool's own error is recorded as error, and a handler that throws as threw", async () => {
    const db = memDb();
    ownerSays(db, "hi");
    const turn = claimTurn(db, ownerChatId(db))!;
    const home = mkdtempSync(join(tmpdir(), "shuvi-home-"));
    // react to a seq that is not a message: the tool's own error (isError), not a throw.
    await runTurn({ db, turnId: turn.id, home, timeZone: "UTC", capabilities: enabledCapabilities(CAPS), makeAdapter: (b) => new ScriptedAdapter(b, [{ tool: "react", args: { seq: 999, emoji: "👍" } }]) });
    expect(stepsOf(db, turn.id)[0]).toMatchObject({ name: "react", status: "error" });
    expect(stepsOf(db, turn.id)[0]!.result).toContain("not a message");

    ownerSays(db, "again");
    const second = claimTurn(db, ownerChatId(db))!;
    const boom = defineCapability<object>({
      id: "boom",
      label: "boom",
      gives: "a boom tool, for this test.",
      enable: () => ({}),
      tools: () => [{ serverName: "shuvi", tools: [{ name: "boom", description: "Throws.", inputSchema: {}, handler: async () => Promise.reject(new Error("the example service is down")) }] }],
    });
    const outcome = await runTurn({
      db,
      turnId: second.id,
      home,
      timeZone: "UTC",
      capabilities: [...enabledCapabilities(CAPS), { capability: boom as never, config: {} }],
      makeAdapter: (b) => new ScriptedAdapter(b, [{ tool: "boom" }]),
    });
    expect(outcome).toBe("failed"); // the scripted driver lets the throw end the turn
    expect(stepsOf(db, second.id)[0]).toMatchObject({ name: "boom", status: "threw", error: "the example service is down" });
  });

  test("secrets are redacted before anything is stored: prompt, input, thinking, text, arguments, results, appends, errors", async () => {
    const db = memDb();
    // A value JSON would escape (`"` and `\\`): it must be redacted before arguments are serialised.
    const SECRET = 'ex"ample\\not-a-real-key-123';
    const ESCAPED = JSON.stringify(SECRET).slice(1, -1);
    const home = mkdtempSync(join(tmpdir(), "shuvi-home-"));
    mkdirSync(join(home, "persona"));
    writeFileSync(join(home, "persona/public.md"), `You know the example key ${SECRET}.`);
    ownerSays(db, `my key is ${SECRET}`);
    const turn = claimTurn(db, ownerChatId(db))!;
    const echo = defineCapability<object>({
      id: "echo",
      label: "echo",
      gives: "a echo tool, for this test.",
      enable: () => ({}),
      tools: () => [
        {
          serverName: "shuvi",
          tools: [
            { name: "echo", description: "Echo.", inputSchema: {}, handler: async (a: unknown) => ({ content: [{ type: "text" as const, text: `you said ${JSON.stringify(a)} and ${SECRET}` }] }) },
            { name: "boom", description: "Throws.", inputSchema: {}, handler: async () => Promise.reject(new Error(`could not use ${SECRET}`)) },
          ],
        },
      ],
    });
    const script: Step[] = [
      { token: `the key is ${SECRET}`, thinking: true },
      { token: `Got ${SECRET}.` },
      { tool: "echo", args: { deep: [{ value: SECRET }], [SECRET]: "as a key" } },
      { run: () => void ownerSays(db, `and again ${SECRET}`) },
      { tool: "say", args: { text: `saving ${SECRET}` } },
      { tool: "boom" },
    ];
    const outcome = await runTurn({
      db,
      turnId: turn.id,
      home,
      timeZone: "UTC",
      capabilities: [...enabledCapabilities(CAPS), { capability: echo as never, config: {} }],
      makeAdapter: (b) => new ScriptedAdapter(b, script),
      record: { dataDir: mkdtempSync(join(tmpdir(), "shuvi-data-")), redact: redactor({ example: { EXAMPLE_KEY: SECRET } }) },
    });
    expect(outcome).toBe("failed");
    const dump = (q: string) => JSON.stringify(db.$client.query(q).all());
    for (const q of ["select * from turn_steps", "select * from turn_transcripts", "select * from prompt_texts", "select error from turns", "select text from control_messages"]) {
      const stored = dump(q);
      expect(stored).not.toContain(SECRET);
      expect(stored).not.toContain(ESCAPED);
      expect(stored).not.toContain("not-a-real-key");
    }
    expect(dump("select * from prompt_texts")).toContain("[REDACTED:example]");
    expect(getTurn(db, turn.id)!.error).toBe("could not use [REDACTED:example]");
    const steps = stepsOf(db, turn.id);
    expect(steps.map((s) => (s.kind === "tool" ? s.name : s.kind))).toEqual(["thinking", "text", "echo", "say", "append", "boom"]);
    expect(JSON.parse(steps[2]!.args!)).toEqual({ deep: [{ value: "[REDACTED:example]" }], "[REDACTED:example]": "as a key" });
    expect(steps[2]!.result).toContain("[REDACTED:example]");
    expect(steps[4]!.text).toContain("and again [REDACTED:example]");
    expect(steps[5]).toMatchObject({ status: "threw", error: "could not use [REDACTED:example]" });
  });

  test("two argument keys that redact to the same text are both kept", () => {
    const red = redactor({ example: { A: "first-example-secret", B: "second-example-secret" } });
    const out = redactDeep({ "first-example-secret": 1, "second-example-secret": 2, plain: 3 }, (s) => red(s).replace(/\[REDACTED:\w+\]/g, "[REDACTED]"));
    expect(out).toEqual({ "[REDACTED]": 1, "[REDACTED] (2)": 2, plain: 3 });
  });

  test("parallel tool calls: each completes its own row, in the order they started", async () => {
    const db = memDb();
    ownerSays(db, "hi");
    const turn = claimTurn(db, ownerChatId(db))!;
    const rec = new TurnRecorder(db, turn.id, { dataDir: mkdtempSync(join(tmpdir(), "shuvi-data-")) });
    const b = recordingBoundary({}, rec, () => turn.toSeq, () => undefined);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const slow = runAtBoundary(b, { name: "slow", recordedName: "slow", args: { i: 1 } }, async () => {
      await held;
      return { content: [{ type: "text" as const, text: "one" }] };
    });
    const fast = runAtBoundary(b, { name: "fast", recordedName: "fast", args: { i: 2 } }, async () => ({ content: [{ type: "text" as const, text: "two" }] }));
    await fast;
    expect(stepsOf(db, turn.id).map((s) => [s.n, s.name, s.status, s.result])).toEqual([
      [0, "slow", "running", null],
      [1, "fast", "ok", "two"],
    ]);
    release();
    await slow;
    expect(stepsOf(db, turn.id).map((s) => [s.n, s.name, s.status, s.result])).toEqual([
      [0, "slow", "ok", "one"],
      [1, "fast", "ok", "two"],
    ]);
  });

  test("the prompt and the transcript are written together, or not at all", async () => {
    const db = memDb();
    ownerSays(db, "hi");
    db.$client.exec("drop table turn_transcripts");
    const turn = claimTurn(db, ownerChatId(db))!;
    const home = mkdtempSync(join(tmpdir(), "shuvi-home-"));
    const outcome = await runTurn({ db, turnId: turn.id, home, timeZone: "UTC", capabilities: enabledCapabilities(CAPS), makeAdapter: (b) => new ScriptedAdapter(b, [{ token: "ok" }]) });
    expect(outcome).toBe("done");
    expect((db.$client.query("select count(*) as n from prompt_texts").get() as { n: number }).n).toBe(0);
  });

  test("notes open the timeline (an unusable secrets file says so)", async () => {
    const db = memDb();
    ownerSays(db, "hi");
    const turn = claimTurn(db, ownerChatId(db))!;
    const home = mkdtempSync(join(tmpdir(), "shuvi-home-"));
    await runTurn({
      db,
      turnId: turn.id,
      home,
      timeZone: "UTC",
      capabilities: enabledCapabilities(CAPS),
      makeAdapter: (b) => new ScriptedAdapter(b, [{ token: "ok" }]),
      record: { dataDir: mkdtempSync(join(tmpdir(), "shuvi-data-")), notes: ["The secrets file could not be read (an example reason)."] },
    });
    expect(stepsOf(db, turn.id).map((s) => [s.kind, s.text])).toEqual([
      ["note", "The secrets file could not be read (an example reason)."],
      ["text", "ok"],
    ]);
  });

  test("the live redaction follows the secrets file, and says when it cannot be used", () => {
    const dir = mkdtempSync(join(tmpdir(), "shuvi-secrets-"));
    const file = join(dir, "secrets.yaml");
    writeFileSync(file, "example:\n  EXAMPLE_KEY: first-example-value\n", { mode: 0o600 });
    let now = 0;
    const live = new LiveRedaction(file, 1000, () => now);
    expect(live.redact("a first-example-value b")).toBe("a [REDACTED:example] b");
    expect(live.problem()).toBeNull();
    writeFileSync(file, "example:\n  EXAMPLE_KEY: second-example-value\n", { mode: 0o600 });
    utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect(live.redact("second-example-value")).toBe("second-example-value"); // not looked at again yet
    now = 2000;
    expect(live.redact("second-example-value and first-example-value")).toBe("[REDACTED:example] and [REDACTED:example]");
    chmodSync(file, 0o644);
    expect(live.problem()).toContain("readable by others");
  });

  test("a recording failure never breaks the turn", async () => {
    const db = memDb();
    ownerSays(db, "hi");
    db.$client.exec("drop table turn_steps");
    const turn = claimTurn(db, ownerChatId(db))!;
    const home = mkdtempSync(join(tmpdir(), "shuvi-home-"));
    const outcome = await runTurn({ db, turnId: turn.id, home, timeZone: "UTC", capabilities: enabledCapabilities(CAPS), makeAdapter: (b) => new ScriptedAdapter(b, [{ token: "thinking", thinking: true }, { tool: "say", args: { text: "a" } }, { token: "b" }]) });
    expect(outcome).toBe("done");
    expect(getTurn(db, turn.id)!.status).toBe("done");
    expect((db.$client.query("select count(*) as n from chat_events where kind = 'bot_message'").get() as { n: number }).n).toBe(2);
  });

  test("the system prompt sent is byte-identical to buildSystemPrompt (recording changed nothing about it)", async () => {
    const db = memDb();
    ownerSays(db, "hi");
    const turn = claimTurn(db, ownerChatId(db))!;
    const home = mkdtempSync(join(tmpdir(), "shuvi-home-"));
    let sent = "";
    await runTurn({
      db,
      turnId: turn.id,
      home,
      timeZone: "UTC",
      capabilities: enabledCapabilities(CAPS),
      makeAdapter: (b) => {
        const a = new ScriptedAdapter(b, [{ token: "ok" }]);
        const run = a.run.bind(a);
        a.run = (input, opts) => ((sent = input.systemPrompt ?? ""), run(input, opts));
        return a;
      },
    });
    const chat = getChat(db, ownerChatId(db))!;
    expect(sent).toBe(buildSystemPrompt(home, chat, { name: "Owner" }, enabledCapabilities(CAPS)));
    expect(getPromptText(db, getTranscript(db, turn.id)!.promptHash!)!.text).toBe(sent);
  });
});

describe("pruning", () => {
  test("removes old transcripts and unreferenced prompt texts, never chat_events or the turns themselves", async () => {
    const f = await buildConsoleFixture();
    const events = (f.db.$client.query("select count(*) as n from chat_events").get() as { n: number }).n;
    const turns = (f.db.$client.query("select count(*) as n from turns").get() as { n: number }).n;
    // The first two turns ended long ago.
    f.db.$client.query("update turns set ended_at = '2020-01-01T00:00:00.000Z' where id in (?, ?)").run(f.turns.done, f.turns.failed);
    const r = pruneTranscripts(f.db, "2024-01-01T00:00:00.000Z");
    expect(r.transcripts).toBe(2);
    expect(r.steps).toBe(7 + 2);
    // The first turn's prompt is referenced by nothing now; the second's is still the third turn's.
    expect(r.prompts).toBe(1);
    expect(stepsOf(f.db, f.turns.done)).toEqual([]);
    expect(getTranscript(f.db, f.turns.done)).toBeUndefined();
    expect(stepsOf(f.db, f.turns.passed).length).toBeGreaterThan(0);
    expect(getPromptText(f.db, getTranscript(f.db, f.turns.passed)!.promptHash!)).toBeTruthy();
    expect((f.db.$client.query("select count(*) as n from chat_events").get() as { n: number }).n).toBe(events);
    expect((f.db.$client.query("select count(*) as n from turns").get() as { n: number }).n).toBe(turns);
    // Again: nothing more to do.
    expect(pruneTranscripts(f.db, "2024-01-01T00:00:00.000Z")).toEqual({ transcripts: 0, steps: 0, prompts: 0 });
  });

  test("transcript-only images go once unused for long enough", async () => {
    const f = await buildConsoleFixture();
    const ref = stepsOf(f.db, f.turns.done).find((s) => s.images)!.images![0]!.ref;
    const abs = join(f.dataDir, ref);
    expect(pruneTranscriptMedia(f.dataDir, Date.now() - 3600_000)).toBe(0);
    utimesSync(abs, new Date("2020-01-01"), new Date("2020-01-01"));
    expect(statSync(abs).mtimeMs).toBeLessThan(Date.now() - 3600_000);
    expect(pruneTranscriptMedia(f.dataDir, Date.now() - 3600_000)).toBe(1);
    expect(existsSync(abs)).toBe(false);
    expect(existsSync(join(f.dataDir, "media", "example-photo"))).toBe(true); // a chat's own media is never touched
  });
});

