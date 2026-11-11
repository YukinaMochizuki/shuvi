import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMessage } from "../src/agent/render.ts";
import { handleHook, MAX_BODY_BYTES, parseListen, type HookDeps } from "../src/capabilities/jobs/hooks.ts";
import { jobReportUrl } from "../src/capabilities/jobs/index.ts";
import { jobWatchPass } from "../src/capabilities/jobs/watch.ts";
import { controlMessagesOf } from "../src/store/control.ts";
import type { Db } from "../src/store/db.ts";
import { getEvent, type JobDonePayload } from "../src/store/events.ts";
import { createJob, finishJob, getJob, type JobKind, type JobPoll } from "../src/store/jobs.ts";
import { claimTurn } from "../src/store/turns.ts";
import { memDb, OWNER, ownerChatId, ownerSays } from "./helpers.ts";

const jobDones = (db: Db) => db.$client.query("select seq, chat_id as chatId, payload from chat_events where kind = 'job_done'").all() as { seq: number; chatId: number; payload: string }[];
const eventCount = (db: Db) => (db.$client.query("select count(*) as n from chat_events").get() as { n: number }).n;

function callbackJob(db: Db, deadline = new Date(Date.now() + 60_000)) {
  const origin = ownerSays(db, "transcribe that voice note");
  return { origin, ...createJob(db, { chatId: ownerChatId(db), originSeq: origin, kind: "transcribe", title: "transcribe voice #12", report: "callback", deadline }) };
}

const hookDeps = (db: Db, home = mkdtempSync(join(tmpdir(), "shuvi-home-")), tokens: Record<string, string> = {}): HookDeps => ({ db, home, ownerId: OWNER, inboundTokens: tokens });
const post = (path: string, body: string, headers: Record<string, string> = {}) => new Request(`http://hooks${path}`, { method: "POST", body, headers });

const alerts = (db: Db) => controlMessagesOf(db, "alert").map((m) => m.text);

describe("a job ends once, and its result goes back to the origin chat", () => {
  test("finishJob writes one job_done in the origin chat; a second finish writes nothing", () => {
    const db = memDb();
    const { job } = callbackJob(db);
    const seq = finishJob(db, job.id, { state: "done", result: "hello world" });
    expect(seq).not.toBeNull();
    expect(finishJob(db, job.id, { state: "failed", result: "late" })).toBeNull();
    const done = jobDones(db);
    expect(done).toHaveLength(1);
    expect(done[0]!.chatId).toBe(ownerChatId(db));
    expect(JSON.parse(done[0]!.payload)).toMatchObject({ jobId: job.id, state: "done", result: "hello world", title: "transcribe voice #12" });
    expect(getJob(db, job.id)!.state).toBe("done");
  });

  test("a job_done is a trigger: it claims a turn past the cursor, and renders as a framework event", () => {
    const db = memDb();
    const { job } = callbackJob(db);
    // The message that started the job was answered: move the cursor past it.
    db.$client.run("update chats set cursor_seq = (select max(seq) from chat_events)");
    expect(claimTurn(db, ownerChatId(db))).toBeNull();
    const seq = finishJob(db, job.id, { state: "done", result: "the transcript" })!;
    const turn = claimTurn(db, ownerChatId(db))!;
    expect(turn.toSeq).toBe(seq);
    const line = renderMessage(getEvent(db, seq)!, "UTC");
    expect(line).toMatch(new RegExp(`^\\[#${seq} · \\d\\d/\\d\\d \\d\\d:\\d\\d · ⚙ job ${job.id} · transcribe · done\\] asked: "transcribe voice #12"\\n  the transcript$`));
  });
});

describe("POST /jobs/<id>/report", () => {
  test("an unknown job is 404 and a wrong token 401, and neither writes anything", async () => {
    const db = memDb();
    const { job, token } = callbackJob(db);
    const before = eventCount(db);
    expect((await handleHook(hookDeps(db), post(`/jobs/9999/report`, "x", { authorization: `Bearer ${token}` }))).status).toBe(404);
    expect((await handleHook(hookDeps(db), post(`/jobs/abc/report`, "x", { authorization: `Bearer ${token}` }))).status).toBe(404);
    expect((await handleHook(hookDeps(db), post(`/jobs/${job.id}/report`, "x", { authorization: "Bearer wrong" }))).status).toBe(401);
    expect((await handleHook(hookDeps(db), post(`/jobs/${job.id}/report`, "x"))).status).toBe(401);
    expect(eventCount(db)).toBe(before);
    expect(getJob(db, job.id)!.state).toBe("running");
  });

  test("the right token writes the result once; a repeat report is accepted and writes nothing", async () => {
    const db = memDb();
    const { job, token } = callbackJob(db);
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const r1 = await handleHook(hookDeps(db), post(`/jobs/${job.id}/report`, JSON.stringify({ status: "done", result: { words: 42 } }), auth));
    expect(r1.status).toBe(200);
    const r2 = await handleHook(hookDeps(db), post(`/jobs/${job.id}/report`, JSON.stringify({ status: "failed", result: "again" }), auth));
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ ok: true, already: "done" });
    const done = jobDones(db);
    expect(done).toHaveLength(1);
    expect((JSON.parse(done[0]!.payload) as JobDonePayload).result).toContain('"words": 42');
  });

  test("plain text is a done result; a bad status is 400 and writes nothing", async () => {
    const db = memDb();
    const { job, token } = callbackJob(db);
    const bad = await handleHook(hookDeps(db), post(`/jobs/${job.id}/report`, JSON.stringify({ status: "maybe" }), { authorization: `Bearer ${token}`, "content-type": "application/json" }));
    expect(bad.status).toBe(400);
    expect(jobDones(db)).toHaveLength(0);
    const okRes = await handleHook(hookDeps(db), post(`/jobs/${job.id}/report`, "it worked", { authorization: `Bearer ${token}`, "content-type": "text/plain" }));
    expect(okRes.status).toBe(200);
    expect((JSON.parse(jobDones(db)[0]!.payload) as JobDonePayload).result).toBe("it worked");
  });

  test("a poll job cannot be reported to (404), and only the token's hash is stored", async () => {
    const db = memDb();
    const origin = ownerSays(db, "ask the desk");
    const { job, token } = createJob(db, { chatId: ownerChatId(db), originSeq: origin, kind: "workstream", title: "q", report: "poll", deadline: new Date(Date.now() + 60_000) });
    expect(token).toBeUndefined();
    expect((await handleHook(hookDeps(db), post(`/jobs/${job.id}/report`, "x", { authorization: "Bearer anything" }))).status).toBe(404);
    const cb = callbackJob(db);
    expect(JSON.stringify(getJob(db, cb.job.id))).not.toContain(cb.token!);
  });

  test("the body cap is counted in bytes, not characters", async () => {
    const db = memDb();
    const { job, token } = callbackJob(db);
    // Under the cap in UTF-16 units, over it in UTF-8 bytes (each character is 3 bytes).
    const body = "界".repeat(Math.floor(MAX_BODY_BYTES / 3) + 10);
    expect(body.length).toBeLessThan(MAX_BODY_BYTES);
    const res = await handleHook(hookDeps(db), new Request(`http://hooks/jobs/${job.id}/report`, { method: "POST", body: new TextEncoder().encode(body), headers: { authorization: `Bearer ${token}` } }));
    expect(res.status).toBe(413);
    expect(jobDones(db)).toHaveLength(0);
  });

  test("the report URL and the listen address", () => {
    expect(jobReportUrl({ SHUVI_HOOK_LISTEN: "100.64.0.5:8787" }, 7)).toBe("http://100.64.0.5:8787/jobs/7/report");
    expect(jobReportUrl({ SHUVI_HOOK_LISTEN: "100.64.0.5:8787", SHUVI_HOOK_URL: "http://shuvi.tail/" }, 7)).toBe("http://shuvi.tail/jobs/7/report");
    expect(jobReportUrl({}, 7)).toBeNull();
    expect(parseListen("100.64.0.5:8787")).toEqual({ hostname: "100.64.0.5", port: 8787 });
    expect(parseListen("[fd7a::1]:8787")).toEqual({ hostname: "fd7a::1", port: 8787 });
  });
});

describe("the job watcher", () => {
  function pollKind(answers: (JobPoll | Error)[]): JobKind & { polls: number } {
    const k = {
      kind: "probe",
      pollEveryMs: 1000,
      polls: 0,
      async poll() {
        const a = answers[Math.min(k.polls++, answers.length - 1)]!;
        if (a instanceof Error) throw a;
        return a;
      },
    };
    return k;
  }
  function pollJob(db: Db, deadlineInMs: number) {
    const origin = ownerSays(db, "look into it");
    return createJob(db, { chatId: ownerChatId(db), originSeq: origin, kind: "probe", title: "look into it", report: "poll", deadline: new Date(Date.now() + deadlineInMs) }).job;
  }

  test("a poll job is polled when due; running moves the next poll, a result ends it", async () => {
    const db = memDb();
    const job = pollJob(db, 60_000);
    const kind = pollKind([{ state: "running", note: "waiting-approval: a card" }, { state: "done", result: "the answer" }]);
    let t = Date.now();
    await jobWatchPass({ db, kinds: [kind], now: () => t });
    expect(kind.polls).toBe(1);
    expect(getJob(db, job.id)!.note).toBe("waiting-approval: a card");
    await jobWatchPass({ db, kinds: [kind], now: () => t });
    expect(kind.polls).toBe(1); // not due yet
    t += 1500;
    const r = await jobWatchPass({ db, kinds: [kind], now: () => t });
    expect(r.finished).toEqual([job.id]);
    expect((JSON.parse(jobDones(db)[0]!.payload) as JobDonePayload).result).toBe("the answer");
  });

  test("a failing poll is noted and retried", async () => {
    const db = memDb();
    const job = pollJob(db, 60_000);
    const kind = pollKind([new Error("connection refused"), { state: "failed", result: "desk failed" }]);
    let t = Date.now();
    await jobWatchPass({ db, kinds: [kind], now: () => t });
    expect(getJob(db, job.id)!.note).toBe("poll failed: connection refused");
    t += 1500;
    await jobWatchPass({ db, kinds: [kind], now: () => t });
    expect(getJob(db, job.id)!.state).toBe("failed");
  });

  test("past the deadline: polled once more; still nothing, expired, written back, and the owner told", async () => {
    const db = memDb();
    const job = pollJob(db, 1_000);
    const kind = pollKind([{ state: "running" }]);
    const r = await jobWatchPass({ db, kinds: [kind], now: () => Date.now() + 5_000 });
    expect(kind.polls).toBe(1);
    expect(r.expired).toEqual([job.id]);
    expect(getJob(db, job.id)!.state).toBe("expired");
    const done = jobDones(db);
    expect(done).toHaveLength(1);
    expect(JSON.parse(done[0]!.payload)).toMatchObject({ state: "expired" });
    expect(alerts(db)).toHaveLength(1);
    expect(alerts(db)[0]).toContain(`Job ${job.id}`);
    // Nothing more on later passes.
    await jobWatchPass({ db, kinds: [kind], now: () => Date.now() + 10_000 });
    expect(jobDones(db)).toHaveLength(1);
    expect(alerts(db)).toHaveLength(1);
  });

  test("the last poll at the deadline can still bring the result in", async () => {
    const db = memDb();
    const job = pollJob(db, 1_000);
    const kind = pollKind([{ state: "done", result: "just in time" }]);
    await jobWatchPass({ db, kinds: [kind], now: () => Date.now() + 5_000 });
    expect(getJob(db, job.id)!.state).toBe("done");
  });

  test("polls run concurrently with their own timeout: a hung poll stalls neither another job's result nor a deadline", async () => {
    const db = memDb();
    const hung = pollJob(db, 60_000);
    const fine = pollJob(db, 60_000);
    const { job: late } = callbackJob(db, new Date(Date.now() + 1_000));
    const settled: number[] = [];
    const kind: JobKind = {
      kind: "probe",
      pollTimeoutMs: 300,
      poll: (job) => (job.id === hung.id ? new Promise<JobPoll>(() => {}) : Promise.resolve({ state: "done", result: "ok" })),
    };
    const pass = jobWatchPass({ db, kinds: [kind], now: () => Date.now() + 5_000 }).then((r) => settled.push(...r.finished, ...r.expired));
    await Bun.sleep(50);
    // Before the hung poll's timeout: the other job and the deadline are already settled.
    expect(getJob(db, fine.id)!.state).toBe("done");
    expect(getJob(db, late.id)!.state).toBe("expired");
    expect(getJob(db, hung.id)!.state).toBe("running");
    await pass;
    expect(getJob(db, hung.id)!.note).toBe("poll failed: no answer within 0.3s");
    expect(settled.sort()).toEqual([fine.id, late.id].sort());
  });

  test("a callback job past its deadline, with no poller, expires; a late report then writes nothing", async () => {
    const db = memDb();
    const { job, token } = callbackJob(db, new Date(Date.now() + 1_000));
    await jobWatchPass({ db, kinds: [], now: () => Date.now() + 5_000 });
    expect(getJob(db, job.id)!.state).toBe("expired");
    const late = await handleHook(hookDeps(db), post(`/jobs/${job.id}/report`, "finally", { authorization: `Bearer ${token}` }));
    expect(late.status).toBe(200);
    expect(await late.json()).toEqual({ ok: true, already: "expired" });
    expect(jobDones(db)).toHaveLength(1);
  });
});
