import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn } from "../src/agent/turn.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import { handleHook } from "../src/capabilities/jobs/hooks.ts";
import { jobWatchPass } from "../src/capabilities/jobs/watch.ts";
import { capabilityHookRoutes } from "../src/capabilities/types.ts";
import { deskJobKind, handedOffNote, isStale, workstream, type WorkstreamConfig } from "../src/capabilities/workstream/index.ts";
import { callDesk, HANDOFF_NOTE, parseDeskReply } from "../src/capabilities/workstream/desk.ts";
import { filterProductLines, READ_TOOL_NAMES, readTools } from "../src/capabilities/workstream/reads.ts";
import { WAKE_PATH } from "../src/capabilities/workstream/wake.ts";
import type { Db } from "../src/store/db.ts";
import { type JobDonePayload } from "../src/store/events.ts";
import { getJob, pollNow, runningJobs, type JobKind } from "../src/store/jobs.ts";
import { claimTurn, finishTurn } from "../src/store/turns.ts";
import { FakeDesk } from "./fake-desk.ts";
import { memDb, OWNER, ownerChatId, ownerSays, ScriptedAdapter, type Step } from "./helpers.ts";

const desk = new FakeDesk();
afterAll(() => desk.stop());
const home = mkdtempSync(join(tmpdir(), "shuvi-home-"));
const env = { SHUVI_WEB: "off", SHUVI_WORKSTREAM_MCP_URL: desk.url, SHUVI_WORKSTREAM_MCP_TOKEN: desk.token, SHUVI_WORKSTREAM_WAKE_TOKEN: "wake-secret", SHUVI_WORKSTREAM_POLL_SEC: "1" };
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
      turn: null,
      handoffs: [],
      text: "The desk is still working on it.",
    });
    expect(parseDeskReply("request r2: answered\n\nYes.\n\nTwo paragraphs.")).toEqual({ request: "r2", status: "answered", turn: null, handoffs: [], text: "Yes.\n\nTwo paragraphs." });
    expect(parseDeskReply("request r3: answered (turn answered:2026-11-27T11:21:53.402Z)\n\nYes.")).toEqual({ request: "r3", status: "answered", turn: "answered:2026-11-27T11:21:53.402Z", handoffs: [], text: "Yes." });
    expect(parseDeskReply("request r4: waiting-approval (turn waiting:d1,d2)\n\nWaiting.").turn).toBe("waiting:d1,d2");
    expect(() => parseDeskReply("something else")).toThrow();
  });

  test("reads the handoff lines under the first line, in the exact shape workstream writes them", () => {
    // The same text workstream's test/desk-session.test.ts pins its `describeDeskState` to.
    expect(HANDOFF_NOTE).toBe("The work goes on where it was handed off; this request does not report on it.");
    const reply =
      "request r5: answered (turn answered:2026-11-28T10:00:00.000Z)\n" +
      'handed off: message workstream ws-billing session s-dir "Billing"\n' +
      'handed off: workstream workstream ws-new session - "Invoice "rounding""\n' +
      `${HANDOFF_NOTE}\n\nSent it.`;
    expect(parseDeskReply(reply)).toEqual({
      request: "r5",
      status: "answered",
      turn: "answered:2026-11-28T10:00:00.000Z",
      handoffs: [
        { kind: "message", workstream: "ws-billing", session: "s-dir", title: "Billing" },
        { kind: "workstream", workstream: "ws-new", session: null, title: 'Invoice "rounding"' },
      ],
      text: "Sent it.",
    });
    // After a blank line it is the desk's answer, whatever it says.
    expect(parseDeskReply('request r6: answered\n\nhanded off: message workstream w session s "x"\nNot really.')).toMatchObject({ handoffs: [], text: 'handed off: message workstream w session s "x"\nNot really.' });
  });

  test("handedOffNote says where the work went and that it is not done", () => {
    const note = handedOffNote([
      { kind: "message", workstream: "w1", session: "s1", title: "Login" },
      { kind: "answer", workstream: "w1", session: "s1", title: "Login" },
      { kind: "workstream", workstream: "w9", session: "s9", title: "Rounding" },
      { kind: "workstream", workstream: "w10", session: null, title: "Later" },
    ]);
    expect(note).toBe(
      [
        "The desk handed this on; the work itself is NOT done yet. It went to:",
        '- a message to session s1 in workstream "Login" (w1)',
        '- an answer to a question of session s1 in workstream "Login" (w1)',
        '- a new workstream "Rounding" (w9), its director session s9 started',
        '- a new workstream "Later" (w10), created without a director',
        "That work goes on in workstream, where the owner follows it; this job hears nothing more about it. Say it was handed off, not that it is done.",
      ].join("\n"),
    );
  });

  test("a wrong token is refused by the desk", async () => {
    await expect(callDesk({ url: desk.url, token: "wrong" }, "request_status", { request: "x" })).rejects.toThrow();
  });
});

describe("ask_workstream as a job", () => {
  test("asks the desk with wait 0, records a poll job with the request id, and the answer comes back as one job_done", async () => {
    const db = memDb();
    const origin = ownerSays(db, "is the widgetry login PR merged?");
    const adapter = await turnWith(db, [{ tool: "ask_workstream", args: { product: "widgetry", message: "is the login PR merged?" } }]);
    expect(adapter.calls[0]!.tools).toContain("ask_workstream");
    expect(adapter.calls[0]!.systemPrompt).toContain("## Workstream");
    expect(desk.calls.at(-1)).toEqual({ tool: "tell_desk", args: { product: "widgetry", message: "is the login PR merged?", wait: 0 } });
    const [job] = runningJobs(db);
    expect(job).toMatchObject({ kind: "workstream", report: "poll", chatId: ownerChatId(db), originSeq: origin, title: "widgetry: is the login PR merged?" });
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

  test("an answer that handed the work on ends the job with a result that says so, ahead of the desk's words", async () => {
    const db = memDb();
    ownerSays(db, "tell the login director to hold the PR");
    await turnWith(db, [{ tool: "ask_workstream", args: { product: "widgetry", message: "tell the login director to hold the PR" } }]);
    const job = runningJobs(db)[0]!;
    Object.assign(desk.requests.get(String(job.spec.request))!, {
      status: "answered",
      text: "Sent it.",
      handoffs: ['handed off: message workstream w1 session s1 "Login"'],
    });
    await jobWatchPass({ db, kinds: [deskJobKind(cfg)], now: () => Date.now() + 10_000 });
    const done = jobDones(db);
    expect(done).toHaveLength(1);
    const payload = JSON.parse(done[0]!.payload) as JobDonePayload;
    expect(payload.state).toBe("done");
    expect(payload.result).toBe(`${handedOffNote([{ kind: "message", workstream: "w1", session: "s1", title: "Login" }])}\n\nThe desk's answer:\nSent it.`);
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
    await turnWith(db, [{ tool: "ask_workstream", args: { product: "widgetry", message: "q" } }]);
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
    await runTurn({ db, turnId: turn.id, home, timeZone: "UTC", ownerId: OWNER, capabilities: enabledCapabilities(env), makeAdapter: (b) => (adapter = new ScriptedAdapter(b, [{ tool: "ask_workstream", args: { product: "widgetry", message: "q" } }])) });
    expect(adapter.calls[0]!.tools).toContain("ask_workstream");
    expect(adapter.toolResults[0]!.result.isError).toBe(true);
    expect(resultText(adapter)).toContain("from Someone, not the owner");
    expect(desk.calls.length).toBe(asked);
    expect(runningJobs(db)).toHaveLength(0);
    finishTurn(db, turn.id, { status: "done" });
  });
});

describe("the reads", () => {
  test("are offered and owner-only, answer inside the turn, and pass their arguments through", async () => {
    const db = memDb();
    ownerSays(db, "what's waiting on me?");
    const adapter = await turnWith(db, [
      { tool: "workstream_waiting", args: {} },
      { tool: "workstream_brief", args: { workstream: "Login", product: "widgetry" } },
    ]);
    for (const name of READ_TOOL_NAMES) expect(adapter.calls[0]!.tools).toContain(name);
    expect(resultText(adapter, 0)).toBe("waiting {}");
    expect(resultText(adapter, 1)).toBe('workstream_brief {"workstream":"Login","product":"widgetry"}');
    // No job: a read is answered at once.
    expect(runningJobs(db)).toHaveLength(0);
  });

  test("refused, before workstream is asked, in a turn the owner is not in", async () => {
    const db = memDb();
    ownerSays(db, "hi", { from: { id: 4242, name: "Someone" } });
    const asked = desk.calls.length;
    const adapter = await turnWith(db, [{ tool: "workstream_waiting", args: {} }]);
    expect(adapter.toolResults[0]!.result.isError).toBe(true);
    expect(desk.calls.length).toBe(asked);
  });

  test("a chat held to some products: every read needs one of them, passed on; list_products is filtered", async () => {
    const only = workstream.configure!(cfg, { products: ["widgetry"] });
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const fake = (async (_c: unknown, name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return name === "list_products" ? desk.listProducts : "ok";
    }) as typeof callDesk;
    const tools = new Map(readTools(only, fake).map((t) => [t.name, t]));
    const run = (name: string, args: Record<string, unknown>) => tools.get(name)!.handler(args as never);

    // All eight are there, product required on all but list_products.
    expect([...tools.keys()].sort()).toEqual([...READ_TOOL_NAMES].sort());
    for (const r of await Promise.all([run("workstream_waiting", {}), run("workstream_brief", { workstream: "Login" }), run("workstream_issues", { workstream: "M6", product: "shuvi" })])) expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);

    expect((await run("workstream_session_log", { workstream: "Login", product: "widgetry" })).isError).toBeFalsy();
    expect(calls.at(-1)).toEqual({ name: "session_log", args: { workstream: "Login", product: "widgetry" } });

    const list = await run("workstream_list_products", {});
    const text = list.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toContain("Widgetry (product widgetry)");
    expect(text).not.toContain("Shuvi");
  });

  test("filterProductLines matches a product by id or by name, and says so when none is left", () => {
    const lines = "Widgetry (product w-1): a\nShuvi (product s-2): b";
    expect(filterProductLines(lines, ["w-1"])).toBe("Widgetry (product w-1): a");
    expect(filterProductLines(lines, ["shuvi"])).toBe("Shuvi (product s-2): b");
    expect(filterProductLines(lines, ["nope"])).toContain("None of the products");
    // A workstream title that reads like another product's line does not let that line through.
    expect(filterProductLines("Hangar (product p1): Fix (product w-1): x [active]", ["w-1"])).toContain("None of the products");
    // Names compare as workstream compares them.
    expect(filterProductLines("Widget Ry (product w-1): a", ["widget-ry"])).toBe("Widget Ry (product w-1): a");
  });
});

describe("following up on a request", () => {
  test("is refused while the request's job is still running", async () => {
    const db = memDb();
    ownerSays(db, "ask");
    await turnWith(db, [{ tool: "ask_workstream", args: { product: "widgetry", message: "q" } }]);
    const job = runningJobs(db)[0]!;
    ownerSays(db, "and also");
    const adapter = await turnWith(db, [{ tool: "ask_workstream", args: { product: "widgetry", message: "also", request: String(job.spec.request) } }]);
    expect(adapter.toolResults[0]!.result.isError).toBe(true);
    expect(resultText(adapter)).toContain(`still working on request ${job.spec.request} (job ${job.id})`);
    expect(runningJobs(db)).toHaveLength(1);
  });

  test("after the answer, continues the same request in a new job that ends with the NEW answer, even if the old one still shows", async () => {
    const db = memDb();
    ownerSays(db, "ask");
    await turnWith(db, [{ tool: "ask_workstream", args: { product: "widgetry", message: "which store?" } }]);
    const first = runningJobs(db)[0]!;
    const request = String(first.spec.request);
    Object.assign(desk.requests.get(request)!, { status: "answered", text: "SQLite.", turn: "answered:t1" });
    const kinds = [deskJobKind(cfg)];
    let t = Date.now() + 10_000;
    await jobWatchPass({ db, kinds, now: () => t });
    expect(getJob(db, first.id)!.state).toBe("done");

    // The desk's turn is still ending as the follow-up arrives: it reads as the old answer for a moment.
    desk.followUpLeavesAnswer = true;
    ownerSays(db, "why?");
    const adapter = await turnWith(db, [{ tool: "ask_workstream", args: { product: "widgetry", message: "why SQLite?", request } }]);
    desk.followUpLeavesAnswer = false;
    expect(desk.calls.findLast((c) => c.tool === "tell_desk")!.args).toEqual({ product: "widgetry", message: "why SQLite?", wait: 0, request });
    const second = runningJobs(db)[0]!;
    expect(second.id).not.toBe(first.id);
    expect(second.spec).toMatchObject({ request, stale: { status: "answered", turn: "answered:t1", text: "SQLite." } });
    expect(resultText(adapter)).toContain(`Followed up with the widgetry desk on workstream request ${request} (running)`);

    t += 2000;
    await jobWatchPass({ db, kinds, now: () => t });
    expect(getJob(db, second.id)!.state).toBe("running");

    // The follow-up's own turn, in the SAME words as the old one: told apart by its turn alone.
    Object.assign(desk.requests.get(request)!, { status: "answered", text: "SQLite.", turn: "answered:t2" });
    t += 2000;
    await jobWatchPass({ db, kinds, now: () => t });
    expect(getJob(db, second.id)).toMatchObject({ state: "done", result: "SQLite." });
  });

  test("is refused while the desk itself is still working, even with no job running here (one that expired)", async () => {
    const db = memDb();
    ownerSays(db, "ask");
    await turnWith(db, [{ tool: "ask_workstream", args: { product: "widgetry", message: "q" } }]);
    const job = runningJobs(db)[0]!;
    const request = String(job.spec.request);
    db.$client.query("update jobs set state = 'expired' where id = ?").run(job.id);
    desk.requests.get(request)!.status = "waiting-approval";
    const told = desk.calls.filter((c) => c.tool === "tell_desk").length;
    ownerSays(db, "and also");
    const adapter = await turnWith(db, [{ tool: "ask_workstream", args: { product: "widgetry", message: "also", request } }]);
    expect(adapter.toolResults[0]!.result.isError).toBe(true);
    expect(resultText(adapter)).toContain(`still working on request ${request} (waiting-approval)`);
    expect(desk.calls.filter((c) => c.tool === "tell_desk").length).toBe(told);
    expect(runningJobs(db)).toHaveLength(0);
  });

  test("a desk that names no turns is compared by status and words", () => {
    const stale = { status: "answered" as const, turn: null, text: "Done." };
    expect(isStale(stale, { status: "answered", turn: null, text: "Done." })).toBe(true);
    expect(isStale(stale, { status: "answered", turn: null, text: "Other." })).toBe(false);
    expect(isStale({ ...stale, turn: "answered:t1" }, { status: "answered", turn: "answered:t2", text: "Done." })).toBe(false);
    expect(isStale(undefined, { status: "answered", turn: null, text: "Done." })).toBe(false);
  });
});

describe("the wake", () => {
  const routes = capabilityHookRoutes(enabledCapabilities(env));
  const deps = (db: Db) => ({ db, home, ownerId: OWNER, inboundTokens: {}, routes });
  const wake = (body: unknown, token = "wake-secret") =>
    new Request(`http://hooks${WAKE_PATH}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

  test("is a route only with SHUVI_WORKSTREAM_WAKE_TOKEN", () => {
    expect(routes.map((r) => r.path)).toEqual([WAKE_PATH]);
    expect(capabilityHookRoutes(enabledCapabilities({ ...env, SHUVI_WORKSTREAM_WAKE_TOKEN: undefined }))).toHaveLength(0);
  });

  test("moves the request's job to the next pass; a wrong token or no request touches nothing", async () => {
    const db = memDb();
    ownerSays(db, "ask");
    await turnWith(db, [{ tool: "ask_workstream", args: { product: "widgetry", message: "q" } }]);
    const job = runningJobs(db)[0]!;
    const before = job.nextPollAt;
    expect(Date.parse(before!)).toBeGreaterThan(Date.now());

    expect((await handleHook(deps(db), wake({ request: job.spec.request }, "wrong"))).status).toBe(401);
    expect((await handleHook(deps(db), wake({ status: "answered" }))).status).toBe(400);
    expect(getJob(db, job.id)!.nextPollAt).toBe(before);

    // Someone else's request, or one already over: 200, nothing moves.
    expect((await handleHook(deps(db), wake({ request: "req_unknown", status: "answered" }))).status).toBe(200);
    expect(getJob(db, job.id)!.nextPollAt).toBe(before);

    const res = await handleHook(deps(db), wake({ text: "[workstream] request …", request: job.spec.request, status: "answered" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(Date.parse(getJob(db, job.id)!.nextPollAt!)).toBeLessThanOrEqual(Date.now());
  });

  test("a wrong token is refused before the body is read", async () => {
    let pulled = false;
    const body = new ReadableStream({
      pull(c) {
        pulled = true;
        c.enqueue(new TextEncoder().encode('{"request":"x"}'));
        c.close();
      },
    }, { highWaterMark: 0 }); // pulled only when someone reads it
    const req = new Request(`http://hooks${WAKE_PATH}`, { method: "POST", headers: { authorization: "Bearer wrong" }, body, duplex: "half" } as RequestInit);
    expect((await handleHook(deps(memDb()), req)).status).toBe(401);
    expect(pulled).toBe(false);
  });

  test("a wake that lands while a poll is out is not overwritten by that poll's interval", async () => {
    const db = memDb();
    ownerSays(db, "ask");
    await turnWith(db, [{ tool: "ask_workstream", args: { product: "widgetry", message: "q" } }]);
    const job = runningJobs(db)[0]!;
    // A poll that reads "running", and the wake arriving while it is out.
    const kind: JobKind = {
      kind: "workstream",
      pollEveryMs: 120_000,
      async poll() {
        pollNow(db, job.id);
        return { state: "running" };
      },
    };
    await jobWatchPass({ db, kinds: [kind], now: () => Date.now() + 10_000 });
    expect(Date.parse(getJob(db, job.id)!.nextPollAt!)).toBeLessThanOrEqual(Date.now());
  });
});
