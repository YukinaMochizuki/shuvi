import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn } from "../src/agent/turn.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import { jobWatchPass } from "../src/capabilities/jobs/watch.ts";
import { deskJobKind, type WorkstreamConfig } from "../src/capabilities/workstream/index.ts";
import { callDesk, parseDeskReply } from "../src/capabilities/workstream/desk.ts";
import type { Db } from "../src/store/db.ts";
import { type JobDonePayload } from "../src/store/events.ts";
import { getJob, runningJobs } from "../src/store/jobs.ts";
import { claimTurn, finishTurn } from "../src/store/turns.ts";
import { FakeDesk } from "./fake-desk.ts";
import { memDb, OWNER, ownerChatId, ownerSays, ScriptedAdapter, type Step } from "./helpers.ts";

const desk = new FakeDesk();
afterAll(() => desk.stop());
const home = mkdtempSync(join(tmpdir(), "shuvi-home-"));
const env = { SHUVI_WEB: "off", SHUVI_WORKSTREAM_MCP_URL: desk.url, SHUVI_WORKSTREAM_MCP_TOKEN: desk.token, SHUVI_WORKSTREAM_POLL_SEC: "1" };
const cfg: WorkstreamConfig = { url: desk.url, token: desk.token, pollEveryMs: 1000, deadlineMs: 60_000 };

async function turnWith(db: Db, script: Step[]) {
  const turn = claimTurn(db, ownerChatId(db))!;
  let adapter!: ScriptedAdapter;
  await runTurn({ db, turnId: turn.id, home, timeZone: "UTC", ownerId: OWNER, capabilities: enabledCapabilities(env), makeAdapter: (b) => (adapter = new ScriptedAdapter(b, script)) });
  return adapter;
}
const resultText = (a: ScriptedAdapter, i = 0) => a.toolResults[i]!.result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
const jobDones = (db: Db) => db.$client.query("select seq, chat_id as chatId, payload from chat_events where kind = 'job_done'").all() as { seq: number; chatId: number; payload: string }[];

describe("the desk client", () => {
  test("parses the desk's reply shape, with or without the wake trailer", () => {
    expect(parseDeskReply('request r1: running\n\nThe desk is still working on it.\n\nYou will be woken when it changes; request_status("r1") reads it any time.')).toEqual({
      request: "r1",
      status: "running",
      text: "The desk is still working on it.",
    });
    expect(parseDeskReply("request r2: answered\n\nYes.\n\nTwo paragraphs.")).toEqual({ request: "r2", status: "answered", text: "Yes.\n\nTwo paragraphs." });
    expect(() => parseDeskReply("something else")).toThrow();
  });

  test("a wrong token is refused by the desk", async () => {
    await expect(callDesk({ url: desk.url, token: "wrong" }, "request_status", { request: "x" })).rejects.toThrow();
  });
});

describe("ask_workstream as a job", () => {
  test("asks the desk with wait 0, records a poll job with the request id, and the answer comes back as one job_done", async () => {
    const db = memDb();
    const origin = ownerSays(db, "is the hangar boost PR merged?");
    const adapter = await turnWith(db, [{ tool: "ask_workstream", args: { product: "hangar", message: "is the boost PR merged?" } }]);
    expect(adapter.calls[0]!.tools).toContain("ask_workstream");
    expect(adapter.calls[0]!.systemPrompt).toContain("## Workstream");
    expect(desk.calls.at(-1)).toEqual({ tool: "tell_desk", args: { product: "hangar", message: "is the boost PR merged?", wait: 0 } });
    const [job] = runningJobs(db);
    expect(job).toMatchObject({ kind: "workstream", report: "poll", chatId: ownerChatId(db), originSeq: origin, title: "hangar: is the boost PR merged?" });
    const request = String(job!.spec.request);
    expect(resultText(adapter)).toContain(`This is job ${job!.id}`);

    const kinds = [deskJobKind(cfg)];
    let t = Date.now() + 10_000;
    await jobWatchPass({ db, kinds, now: () => t });
    expect(getJob(db, job!.id)!.state).toBe("running");

    desk.requests.get(request)!.status = "waiting-approval";
    desk.requests.get(request)!.text = 'Waiting for the human on their phone: "merge it?".';
    t += 2000;
    await jobWatchPass({ db, kinds, now: () => t });
    expect(getJob(db, job!.id)!.note).toContain("waiting-approval");

    desk.requests.get(request)!.status = "answered";
    desk.requests.get(request)!.text = "Yes, merged an hour ago as #212.";
    t += 2000;
    await jobWatchPass({ db, kinds, now: () => t });
    t += 2000;
    await jobWatchPass({ db, kinds, now: () => t });
    const done = jobDones(db);
    expect(done).toHaveLength(1);
    expect(done[0]!.chatId).toBe(ownerChatId(db));
    expect(JSON.parse(done[0]!.payload) as JobDonePayload).toMatchObject({ state: "done", kind: "workstream", result: "Yes, merged an hour ago as #212." });
  });

  test("the answer starts a turn in the asking chat", async () => {
    const db = memDb();
    ownerSays(db, "ask the desk");
    await turnWith(db, [{ tool: "ask_workstream", args: { product: "shuvi", message: "what is left for M6?" } }]);
    const job = runningJobs(db)[0]!;
    desk.requests.get(String(job.spec.request))!.status = "failed";
    desk.requests.get(String(job.spec.request))!.text = "The desk session failed.";
    await jobWatchPass({ db, kinds: [deskJobKind(cfg)], now: () => Date.now() + 10_000 });
    const adapter = await turnWith(db, [{ token: "The desk could not answer." }]);
    expect(adapter.calls[0]!.prompt).toMatch(/· ⚙ job \d+ · workstream · failed\] asked: "shuvi: what is left for M6\?"\n  The desk session failed\./);
  });

  test("an unknown product is the tool's error, and no job is made", async () => {
    const db = memDb();
    ownerSays(db, "ask");
    const adapter = await turnWith(db, [{ tool: "ask_workstream", args: { product: "nope", message: "hi" } }]);
    expect(adapter.toolResults[0]!.result.isError).toBe(true);
    expect(resultText(adapter)).toContain('no product "nope"');
    expect(runningJobs(db)).toHaveLength(0);
  });

  test("a desk that cannot be reached leaves the job running with a note, until the deadline", async () => {
    const db = memDb();
    ownerSays(db, "ask");
    await turnWith(db, [{ tool: "ask_workstream", args: { product: "hangar", message: "q" } }]);
    const job = runningJobs(db)[0]!;
    await jobWatchPass({ db, kinds: [deskJobKind({ ...cfg, token: "wrong" })], now: () => Date.now() + 10_000 });
    expect(getJob(db, job.id)!.state).toBe("running");
    expect(getJob(db, job.id)!.note).toStartWith("poll failed:");
  });

  test("a turn the owner did not trigger is offered the tool, and the call is refused before the desk is asked", async () => {
    const db = memDb();
    ownerSays(db, "hi", { from: { id: 4242, name: "Someone" } });
    const turn = claimTurn(db, ownerChatId(db))!;
    let adapter!: ScriptedAdapter;
    const asked = desk.calls.length;
    await runTurn({ db, turnId: turn.id, home, timeZone: "UTC", ownerId: OWNER, capabilities: enabledCapabilities(env), makeAdapter: (b) => (adapter = new ScriptedAdapter(b, [{ tool: "ask_workstream", args: { product: "hangar", message: "q" } }])) });
    expect(adapter.calls[0]!.tools).toContain("ask_workstream");
    expect(adapter.toolResults[0]!.result.isError).toBe(true);
    expect(resultText(adapter)).toContain("from Someone, not the owner");
    expect(desk.calls.length).toBe(asked);
    expect(runningJobs(db)).toHaveLength(0);
    finishTurn(db, turn.id, { status: "done" });
  });
});
