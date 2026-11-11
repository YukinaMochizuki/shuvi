import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Api } from "grammy";
import { textOf } from "agent-runtime";
import { runTurn } from "../src/agent/turn.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import { capabilityOwnerOnly } from "../src/capabilities/types.ts";
import { computerConfig } from "../src/capabilities/computer/config.ts";
import { Computers } from "../src/capabilities/computer/computer.ts";
import { computerJobKind, parseUsage, trimView } from "../src/capabilities/computer/exec.ts";
import { inboxPass } from "../src/capabilities/computer/files.ts";
import { computerNames } from "../src/capabilities/computer/config.ts";
import { maintainPass } from "../src/capabilities/computer/index.ts";
import { knownFile, liveGrants, redaction, redactor, syncGrants } from "../src/capabilities/computer/secrets.ts";
import { getComputer } from "../src/capabilities/computer/state.ts";
import { jobWatchPass } from "../src/capabilities/jobs/watch.ts";
import { answerApproval } from "../src/control/approvals.ts";
import { sendPass } from "../src/server/sender.ts";
import type { Db } from "../src/store/db.ts";
import { getJob, runningJobs } from "../src/store/jobs.ts";
import { claimTurn } from "../src/store/turns.ts";
import { telegramFiles } from "../src/telegram/files.ts";
import { classify } from "../src/telegram/inbound.ts";
import { recordInbound, ensureChat } from "../src/store/events.ts";
import { FakeHangar } from "./fake-hangar.ts";
import { dmUpdate, FakeTelegram, lastSeq, memDb, OWNER, ownerChatId, ownerSays, ScriptedAdapter, type Step } from "./helpers.ts";

const SECRET = "fake-secret-value-0123456789";
const fakes: { stop(): void }[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) f.stop();
});

function setup(extra: Record<string, string> = {}) {
  const fake = new FakeHangar();
  fakes.push(fake);
  const dataDir = mkdtempSync(join(tmpdir(), "shuvi-computer-"));
  const secretsFile = join(dataDir, "secrets.yaml");
  writeFileSync(secretsFile, `modal:\n  MODAL_TOKEN: ${SECRET}\n  MODAL_ID: ak-visible-name\n`);
  chmodSync(secretsFile, 0o600);
  const env = fake.env({ SHUVI_WEB: "off", SHUVI_DATA_DIR: dataDir, SHUVI_SECRETS_FILE: secretsFile, SHUVI_COMPUTER_POLL_SEC: "1", SHUVI_COMPUTER_READY_SEC: "5", SHUVI_COMPUTER_INBOX_WAIT_SEC: "5", ...extra });
  const cfg = computerConfig(env)!;
  const db = memDb();
  return { fake, dataDir, secretsFile, env, cfg, db, computers: new Computers(db, cfg) };
}

type Setup = ReturnType<typeof setup>;

async function turn(t: Setup, script: Step[]): Promise<ScriptedAdapter> {
  const claimed = claimTurn(t.db, ownerChatId(t.db))!;
  let adapter!: ScriptedAdapter;
  await runTurn({ db: t.db, turnId: claimed.id, home: join(t.dataDir, "home"), timeZone: "UTC", ownerId: OWNER, capabilities: enabledCapabilities(t.env), makeAdapter: (b) => (adapter = new ScriptedAdapter(b, script)) });
  return adapter;
}

const text = (a: ScriptedAdapter, i: number) => textOf(a.toolResults[i]!.result);
const isErr = (a: ScriptedAdapter, i: number) => !!a.toolResults[i]!.result.isError;
const jobDones = (db: Db) => (db.$client.query("select payload from chat_events where kind = 'job_done' order by seq").all() as { payload: string }[]).map((r) => JSON.parse(r.payload) as { jobId: number; state: string; result: string });
const watch = (t: Setup, ahead = 0) => jobWatchPass({ db: t.db, kinds: [computerJobKind(t.cfg, () => t.computers)], now: () => Date.now() + ahead });

async function untilDone(t: Setup, jobId: number, ms = 15_000) {
  const end = Date.now() + ms;
  while (getJob(t.db, jobId)!.state === "running") {
    if (Date.now() > end) throw new Error(`job ${jobId} did not end`);
    await watch(t, 2_000);
    await Bun.sleep(200);
  }
  return getJob(t.db, jobId)!;
}

describe("configuration", () => {
  test("the capability is off unless all four Hangar variables are set", () => {
    expect(computerConfig({})).toBeNull();
    expect(computerConfig({ SHUVI_HANGAR_API: "x", SHUVI_HANGAR_PROJECT: "p", SHUVI_HANGAR_TOKEN: "t" })).toBeNull();
    const cfg = computerConfig({ SHUVI_HANGAR_API: "x", SHUVI_HANGAR_PROJECT: "p", SHUVI_HANGAR_TOKEN: "t", SHUVI_COMPUTER_IMAGE: "i" })!;
    expect(cfg.idleMs).toBe(15 * 60_000);
    expect(enabledCapabilities({ SHUVI_WEB: "off" }).map((c) => c.capability.id)).not.toContain("computer");
  });

  test("every computer tool acts for the owner", () => {
    const t = setup();
    const owner = capabilityOwnerOnly(enabledCapabilities(t.env));
    for (const name of ["exec", "read_job", "cancel_job", "request_secret", "send_file", "send_photo", "video_frames", "transcribe"]) expect(owner.has(name)).toBe(true);
  });
});

describe("lifecycle", () => {
  test("the first exec creates the disk and the container; later ones reuse them; an idle computer is stopped, never deleted, and started again", async () => {
    const t = setup();
    ownerSays(t.db, "what is on your computer?");
    const a = await turn(t, [{ tool: "exec", args: { command: "echo hello; pwd" } }, { tool: "exec", args: { command: "echo again" } }]);
    expect(a.calls[0]!.systemPrompt).toContain("## Your computer");
    expect(text(a, 0)).toMatch(/^exit 0 · /);
    expect(text(a, 0)).toContain("hello");
    const disk = t.fake.disks.get("home-1001")!;
    expect(disk.spec).toEqual({ size: "5Gi", grow: { max: "50Gi" } });
    const ct = t.fake.containers.get("ct-1001")!;
    expect(ct.spec).toMatchObject({ image: "registry.example/shuvi-computer@sha256:fake", runState: "CONTAINER_RUN_STATE_RUNNING", volumes: [{ source: "home-1001", sourceKind: "Disk", target: "/home/shuvi" }] });
    expect(t.fake.applies()).toEqual(["ct-1001 RUNNING 2/2Gi"]);

    // Not idle yet: nothing happens.
    expect((await maintainPass(t.db, t.computers, t.cfg)).stopped).toEqual([]);
    // Idle: stopped (an apply of STOPPED; nothing is ever deleted).
    const later = Date.now() + 16 * 60_000;
    expect((await maintainPass(t.db, t.computers, t.cfg, later)).stopped).toEqual([ownerChatId(t.db)]);
    expect(t.fake.applies().at(-1)).toBe("ct-1001 STOPPED 2/2Gi");
    expect(t.fake.calls.some((c) => c.method.startsWith("Delete"))).toBe(false);
    expect(getComputer(t.db, ownerChatId(t.db))!.runState).toBe("stopped");

    // A restart: a new process (new Computers) starts it again from the store's state, on the same disk.
    ownerSays(t.db, "again");
    const b = await turn(t, [{ tool: "exec", args: { command: "cat ~/hello.txt 2>/dev/null || echo none; echo kept > ~/hello.txt" } }]);
    expect(text(b, 0)).toContain("none");
    expect(t.fake.applies().at(-1)).toBe("ct-1001 RUNNING 2/2Gi");
    expect(readFileSync(join(t.fake.home("ct-1001"), "hello.txt"), "utf8")).toBe("kept\n");
  });

  test("an idle computer with a background job running is not stopped", async () => {
    const t = setup();
    ownerSays(t.db, "start something long");
    await turn(t, [{ tool: "exec", args: { command: "sleep 20", background: true, expect_seconds: 30 } }]);
    expect((await maintainPass(t.db, t.computers, t.cfg, Date.now() + 60 * 60_000)).stopped).toEqual([]);
  });

  test("Hangar's ResourceExhausted is a clear tool error and an owner alert", async () => {
    const t = setup();
    t.fake.failNext("ApplyContainer", "resource_exhausted", "the plan allows 10 machines");
    ownerSays(t.db, "run it");
    const a = await turn(t, [{ tool: "exec", args: { command: "echo hi" } }]);
    expect(isErr(a, 0)).toBe(true);
    expect(text(a, 0)).toContain("out of quota");
    expect(text(a, 0)).toContain("the plan allows 10 machines");
    const alerts = t.db.$client.query("select text from control_messages where kind = 'alert'").all() as { text: string }[];
    expect(alerts.some((r) => r.text.includes("out of quota"))).toBe(true);
  });
});

describe("exec", () => {
  test("a synchronous exec past its timeout is stopped, the whole process group with it, and says to use background", async () => {
    const t = setup();
    ownerSays(t.db, "go");
    const t0 = Date.now();
    const a = await turn(t, [{ tool: "exec", args: { command: "echo before; sleep 300 | cat; echo after", timeout: 1 } }]);
    expect(Date.now() - t0).toBeLessThan(8_000);
    expect(isErr(a, 0)).toBe(true);
    expect(text(a, 0)).toContain("stopped at the timeout (1s)");
    expect(text(a, 0)).toContain("background: true");
    expect(text(a, 0)).toContain("before");
    expect(text(a, 0)).not.toContain("after");
    const left = Bun.spawnSync(["pgrep", "-f", "sleep 300"]).stdout.toString().trim();
    expect(left).toBe("");
  });

  test("output is capped and trimmed to its head and tail, with the exit code", async () => {
    const t = setup();
    ownerSays(t.db, "go");
    const a = await turn(t, [{ tool: "exec", args: { command: "seq 1 200000; exit 4" } }]);
    const out = text(a, 0);
    expect(isErr(a, 0)).toBe(true);
    expect(out).toMatch(/^exit 4 · /);
    expect(out).toContain("characters elided");
    expect(out).toMatch(/\n1\n2\n/);
    expect(out).toContain("200000");
    expect(out.length).toBeLessThan(10_000);
    expect(trimView("short")).toBe("short");
  });

  test("background: a job id at once, a job_done with the exit code, usage and log tail; read_job and cancel_job", async () => {
    const t = setup();
    ownerSays(t.db, "go");
    const a = await turn(t, [
      { tool: "exec", args: { command: "for i in $(seq 1 5); do echo line $i; done; echo marker-$((6*7)); sleep 1; echo end", background: true, expect_seconds: 60 } },
      { tool: "exec", args: { command: "echo working; sleep 60", background: true, expect_seconds: 5 } },
    ]);
    expect(text(a, 0)).toMatch(/^Started job (\d+) in the background/);
    const [j1, j2] = runningJobs(t.db);
    expect(j1!.report).toBe("poll");
    expect(j1!.ownerAuthorised).toBe(true);
    await Bun.sleep(500);

    ownerSays(t.db, "how is it going?");
    const b = await turn(t, [
      { tool: "read_job", args: { id: j1!.id, grep: "^line", tail: 2 } },
      { tool: "read_job", args: { id: j1!.id, since: 3 } },
      { tool: "cancel_job", args: { id: j2!.id } },
      { tool: "read_job", args: { id: 999 } },
    ]);
    expect(text(b, 0)).toContain("5 matching line(s)");
    expect(text(b, 0)).toContain("line 4\nline 5");
    expect(text(b, 0)).not.toContain("line 3");
    expect(text(b, 0)).toMatch(/nextSince \d+/);
    expect(text(b, 1)).toMatch(/^job \d+ · running/);
    expect(text(b, 1)).toContain("e 1\n"); // from byte 3 of "line 1"
    expect(text(b, 2)).toStartWith(`Cancelled job ${j2!.id}.`);
    expect(isErr(b, 3)).toBe(true);
    expect(getJob(t.db, j2!.id)!.state).toBe("failed");
    expect(getJob(t.db, j2!.id)!.result).toContain("cancelled (exit 130)");

    const done = await untilDone(t, j1!.id);
    expect(done.state).toBe("done");
    const ev = jobDones(t.db).find((d) => d.jobId === j1!.id)!;
    expect(ev.result).toMatch(/^exit 0 · ran [\d.]+s \(expected 60s\)/);
    expect(ev.result).toContain("marker-42");
    expect(ev.result).toContain(`read_job(${j1!.id})`);
    expect(jobDones(t.db).filter((d) => d.jobId === j1!.id)).toHaveLength(1);
    expect(existsSync(join(t.fake.home("ct-1001"), ".jobs", `${j1!.id}.log`))).toBe(true);
  });

  test("a job still running at its deadline is stopped and reported", async () => {
    const t = setup();
    ownerSays(t.db, "go");
    await turn(t, [{ tool: "exec", args: { command: "echo started; sleep 300", background: true, expect_seconds: 1 } }]);
    const [job] = runningJobs(t.db);
    await Bun.sleep(1200);
    // Its deadline (three times the estimate, at least ten minutes more) passes.
    t.db.$client.run("update jobs set deadline = ? where id = ?", [new Date(Date.now() - 1000).toISOString(), job!.id]);
    await watch(t);
    const done = getJob(t.db, job!.id)!;
    expect(done.state).toBe("failed");
    expect(done.result).toContain("Stopped at its deadline");
    expect(done.result).toContain("overdue");
    expect(done.result).toContain("started");
  });

  test("usage lines parse GNU time and bash's times", () => {
    expect(parseUsage("gnu 12.50 20.00 1.00 1048576")).toEqual({ wallMs: 12_500, cpuMs: 21_000, peakBytes: 1 << 30 });
    expect(parseUsage("times 2000 0m1.500s 0m0.500s")).toEqual({ wallMs: 2000, cpuMs: 2000 });
    expect(parseUsage("")).toBeUndefined();
  });
});

describe("boost", () => {
  test("a boosted job: stop, resize, start, run; background jobs are refused and other execs run boosted meanwhile; then it is put back", async () => {
    const t = setup();
    ownerSays(t.db, "warm up");
    await turn(t, [{ tool: "exec", args: { command: "true" } }]);
    ownerSays(t.db, "heavy work");
    const a = await turn(t, [
      { tool: "exec", args: { command: "nproc >/dev/null; sleep 2; echo heavy-done", background: true, boost: { cpu: "8", memory: "16Gi" }, expect_seconds: 30 } },
      { tool: "exec", args: { command: "echo other", background: true } },
      { tool: "exec", args: { command: "echo quick" } },
    ]);
    expect(text(a, 0)).toContain("boosted to 8 vCPU / 16Gi");
    expect(text(a, 0)).toContain("everything on its disk carries over");
    expect(isErr(a, 1)).toBe(true);
    expect(text(a, 1)).toContain("boosted (8 vCPU / 16Gi) for job");
    expect(text(a, 2)).toContain("quick");
    expect(text(a, 2)).toContain("on the boosted computer (8 vCPU / 16Gi, boosted for job");
    expect(t.fake.applies()).toEqual(["ct-1001 RUNNING 2/2Gi", "ct-1001 STOPPED 8/16Gi", "ct-1001 RUNNING 8/16Gi"]);

    const [job] = runningJobs(t.db);
    // While its job runs, the boost stays.
    expect((await maintainPass(t.db, t.computers, t.cfg)).restored).toEqual([]);
    await untilDone(t, job!.id);
    expect(getJob(t.db, job!.id)!.result).toContain("boosted (8 vCPU / 16Gi)");
    expect((await maintainPass(t.db, t.computers, t.cfg)).restored).toEqual([ownerChatId(t.db)]);
    expect(t.fake.applies().at(-1)).toBe("ct-1001 STOPPED 2/2Gi");
    expect(getComputer(t.db, ownerChatId(t.db))!.boost).toBeNull();
  });

  test("a boost is refused while a background job runs, and a synchronous boosted exec is put back at once", async () => {
    const t = setup();
    ownerSays(t.db, "go");
    const a = await turn(t, [
      { tool: "exec", args: { command: "sleep 30", background: true, expect_seconds: 60 } },
      { tool: "exec", args: { command: "echo big", boost: { cpu: "4", memory: "8Gi" } } },
    ]);
    expect(isErr(a, 1)).toBe(true);
    expect(text(a, 1)).toContain("cannot boost now");
    const [job] = runningJobs(t.db);
    ownerSays(t.db, "stop it and go big");
    const b = await turn(t, [
      { tool: "cancel_job", args: { id: job!.id } },
      { tool: "exec", args: { command: "echo big", boost: { cpu: "4", memory: "8Gi" } } },
    ]);
    expect(text(b, 1)).toContain("big");
    expect(text(b, 1)).toContain("on the boosted computer (4 vCPU / 8Gi)");
    expect(text(b, 1)).toContain("back at its normal size");
    expect(t.fake.applies().slice(-3)).toEqual(["ct-1001 STOPPED 4/8Gi", "ct-1001 RUNNING 4/8Gi", "ct-1001 STOPPED 2/2Gi"]);
  });
});

describe("secrets", () => {
  test("request_secret raises a card with names, never values; a grant goes into the exec's env only; output is redacted; revoking ends it", async () => {
    const t = setup();
    ownerSays(t.db, "deploy to modal");
    const a = await turn(t, [
      { tool: "exec", args: { command: 'echo "token=[$MODAL_TOKEN]"' } },
      { tool: "request_secret", args: { profile: "modal", ttl: "1d", reason: "to deploy the app" } },
      { tool: "request_secret", args: { profile: "nope", ttl: "4h", reason: "x" } },
    ]);
    expect(text(a, 0)).toContain("token=[]");
    expect(text(a, 1)).toContain("approval #");
    expect(text(a, 2)).toContain('no secret profile "nope"');
    const card = t.db.$client.query("select id, title, body, options from approvals where kind = 'secret'").get() as { id: number; body: string; options: string };
    expect(card.body).toContain("MODAL_TOKEN, MODAL_ID");
    expect(card.body).not.toContain(SECRET);
    expect(card.body).toContain("to deploy the app");
    expect(JSON.parse(card.options).map((o: { id: string }) => o.id)).toEqual(["4h", "1d", "3d", "deny"]);

    answerApproval(t.db, card.id, 1, { id: OWNER, name: "Owner" });
    // The approval event wakes the chat; that turn (the owner's answer) may use the grant.
    const b = await turn(t, [
      { tool: "exec", args: { command: 'echo "token=[$MODAL_TOKEN] id=[$MODAL_ID]"; echo "$MODAL_TOKEN" > ~/leak.txt' } },
      { tool: "exec", args: { command: 'echo "$MODAL_TOKEN" | rev; echo "$MODAL_TOKEN"', background: true } },
      { tool: "send_file", args: { path: "~/leak.txt", caption: `look ${SECRET}` } },
    ]);
    expect(text(b, 0)).toContain("token=[[REDACTED:modal]]");
    expect(text(b, 0)).toContain("secrets: modal");
    expect(text(b, 0)).not.toContain(SECRET);
    expect(isErr(b, 2)).toBe(true);
    expect(text(b, 2)).toContain('contains the value of the secret profile "modal"');
    const withEnv = t.fake.execs.filter((e) => e.env.MODAL_TOKEN === SECRET);
    expect(withEnv.length).toBe(2);
    // Never in the spec, never in the store.
    expect(JSON.stringify(t.fake.containers.get("ct-1001"))).not.toContain(SECRET);

    const [job] = runningJobs(t.db);
    await untilDone(t, job!.id);
    expect(getJob(t.db, job!.id)!.result).toContain("[REDACTED:modal]");

    // A revoke card exists; pressing it ends the grant.
    const revoke = t.db.$client.query("select id, body from approvals where kind = 'secret-revoke'").get() as { id: number; body: string };
    expect(revoke.body).toContain("Press to end it now");
    answerApproval(t.db, revoke.id, 0, { id: OWNER, name: "Owner" });
    ownerSays(t.db, "once more");
    const c = await turn(t, [{ tool: "exec", args: { command: 'echo "token=[$MODAL_TOKEN]"' } }]);
    expect(text(c, 0)).toContain("token=[]");

    // Nowhere in the store, nor in anything the model was shown.
    const dump = (t.db.$client.query("select * from chat_events").all() as unknown[]).concat(t.db.$client.query("select * from jobs").all(), t.db.$client.query("select * from approvals").all(), t.db.$client.query("select * from secret_grants").all(), t.db.$client.query("select * from control_messages").all(), t.db.$client.query("select * from computers").all());
    expect(JSON.stringify(dump)).not.toContain(SECRET);
    for (const ad of [a, b, c]) {
      expect(JSON.stringify(ad.toolResults)).not.toContain(SECRET);
      expect(JSON.stringify(ad.calls)).not.toContain(SECRET);
    }
  });

  test("a secrets file readable by others is refused", async () => {
    const t = setup();
    chmodSync(t.secretsFile, 0o644);
    ownerSays(t.db, "go");
    const a = await turn(t, [{ tool: "request_secret", args: { profile: "modal", ttl: "4h", reason: "x" } }]);
    expect(isErr(a, 0)).toBe(true);
    expect(text(a, 0)).toContain("make it mode 600");
  });

  test("redaction replaces the longest values first and leaves short ones", () => {
    const r = redactor({ a: { X: "abcdefgh", Y: "abcdefghijkl", Z: "ab" } });
    expect(r("abcdefghijkl abcdefgh ab")).toBe("[REDACTED:a] [REDACTED:a] ab");
  });
});

describe("files", () => {
  test("a file the owner sends waits for the computer's next run (never starting it), and the next command waits for it; photos only on save_photo", async () => {
    const t = setup();
    const tg = new FakeTelegram();
    fakes.push(tg);
    const files = telegramFiles(new Api("TOKEN", { apiRoot: tg.apiRoot }), "TOKEN", tg.apiRoot);
    await inboxPass(t.db, files, t.computers, OWNER); // the capability's first pass: nothing before it is copied
    tg.files.set("doc-1", new TextEncoder().encode("a,b\n1,2\n"));
    tg.files.set("photo-big", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    const chat = ensureChat(t.db, { id: OWNER, kind: "private" });
    const record = (id: number, extra: Record<string, unknown>) => {
      const c = classify(dmUpdate(id, "", OWNER, { text: undefined, ...extra }), OWNER);
      if (c.kind !== "message") throw new Error("not a message");
      recordInbound(t.db, { chatId: chat.id, kind: "message", payload: c.payload, tgUpdateId: id, tgMessageId: c.tgMessageId });
      return { c, seq: lastSeq(t.db) };
    };
    const doc = record(7, { caption: "the numbers", document: { file_id: "doc-1", file_unique_id: "u-doc-1", file_name: "data.csv", file_size: 8 } });
    expect(doc.c.kind === "message" && doc.c.payload.attachment).toMatchObject({ kind: "document", name: "data.csv" });
    expect(doc.c.kind === "message" && doc.c.payload.attachment?.state).toBeUndefined();
    const photo = record(8, { photo: [{ file_id: "photo-small", file_unique_id: "ps", width: 90, height: 90 }, { file_id: "photo-big", file_unique_id: "pb", width: 1280, height: 960 }] });

    // No computer runs: nothing is copied, and Hangar is not even asked.
    expect(await inboxPass(t.db, files, t.computers, OWNER)).toBe(0);
    expect(t.fake.calls).toHaveLength(0);

    // The next exec starts the computer; the server copies the file then, and the command waits for it.
    let on = true;
    const loop = (async () => {
      while (on) {
        await inboxPass(t.db, files, t.computers, OWNER);
        await Bun.sleep(100);
      }
    })();
    const a = await turn(t, [{ tool: "exec", args: { command: "cat ~/inbox/*-data.csv; ls ~/inbox" } }]);
    expect(JSON.stringify(a.calls[0]!.prompt)).toContain(`copied to your computer as ~/inbox/${doc.c.tgMessageId}-data.csv when it next runs`);
    expect(text(a, 0)).toContain("1,2");
    expect(text(a, 0)).not.toContain("photo.jpg");

    ownerSays(t.db, "keep that photo");
    const b = await turn(t, [{ tool: "save_photo", args: { seq: photo.seq } }, { tool: "save_photo", args: { seq: doc.seq } }]);
    on = false;
    await loop;
    expect(text(b, 0)).toBe(`Saved on your computer as ~/inbox/${photo.c.tgMessageId}-photo.jpg`);
    expect(readFileSync(join(t.fake.home("ct-1001"), "inbox", `${photo.c.tgMessageId}-photo.jpg`))).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    expect(isErr(b, 1)).toBe(true);
  });

  test("files sent before the capability first ran are left alone", async () => {
    const t = setup();
    ownerSays(t.db, "old", { attachment: { kind: "document", fileId: "x", fileUniqueId: "ux", name: "old.txt" } });
    const tg = new FakeTelegram();
    fakes.push(tg);
    await inboxPass(t.db, telegramFiles(new Api("TOKEN", { apiRoot: tg.apiRoot }), "TOKEN", tg.apiRoot), t.computers, OWNER);
    const row = t.db.$client.query("select payload from chat_events where kind = 'message'").get() as { payload: string };
    expect(JSON.parse(row.payload).attachment.state).toBe("skipped");
    // The pending scan uses its partial index.
    const plan = JSON.stringify(t.db.$client.query("explain query plan select * from chat_events where json_extract(payload, '$.attachment.fileId') IS NOT NULL AND coalesce(json_extract(payload, '$.attachment.state'), 'new') IN ('new', 'requested') and kind = 'message' order by seq").all());
    expect(plan).toContain("chat_events_attachment_pending");
  });

  test("send_file and send_photo go through the sender; Telegram's limits are stated when exceeded", async () => {
    const t = setup();
    ownerSays(t.db, "send me things");
    const a = await turn(t, [
      { tool: "exec", args: { command: "mkdir -p out; printf 'report' > out/report.txt; truncate -s 51M out/big.bin; truncate -s 11M out/big.png" } },
      { tool: "send_file", args: { path: "~/out/report.txt", caption: "the report" } },
      { tool: "send_file", args: { path: "out/big.bin" } },
      { tool: "send_photo", args: { path: "~/out/big.png" } },
      { tool: "send_file", args: { path: "~/missing.txt" } },
    ]);
    expect(text(a, 1)).toContain("Sent the file ~/out/report.txt");
    expect(isErr(a, 2)).toBe(true);
    expect(text(a, 2)).toContain("50 MB");
    expect(isErr(a, 3)).toBe(true);
    expect(text(a, 3)).toContain("10 MB");
    expect(text(a, 4)).toContain("no such file");

    const tg = new FakeTelegram();
    fakes.push(tg);
    await sendPass(t.db, new Api("TOKEN", { apiRoot: tg.apiRoot }));
    const sent = tg.sent("sendDocument");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.caption).toBe("the report");
    // grammY uploads the file as its own part and names it in the field: `attach://<part>`.
    const part = sent[0]![String(sent[0]!.document).replace("attach://", "")] as { file: string; bytes: Uint8Array };
    expect(part.file).toBe("report.txt");
    expect(new TextDecoder().decode(part.bytes)).toBe("report");
    const row = t.db.$client.query("select status, payload from chat_events where kind = 'bot_file'").get() as { status: string; payload: string };
    expect(row.status).toBe("sent");
    expect(existsSync(JSON.parse(row.payload).file)).toBe(false);
  });
});

describe("media tools", () => {
  test("video_frames: synchronous frames come back as images; in the background they follow the job's result", async () => {
    const t = setup();
    mkdirSync(join(t.fake.home("ct-1001"), "inbox"), { recursive: true });
    writeFileSync(join(t.fake.home("ct-1001"), "inbox", "clip.mp4"), "not really a video");
    ownerSays(t.db, "what happens in the clip?");
    const a = await turn(t, [
      { tool: "video_frames", args: { path: "~/inbox/clip.mp4", n: 3, background: false } },
      { tool: "video_frames", args: { path: "~/inbox/clip.mp4", n: 2 } },
    ]);
    const sync = a.toolResults[0]!.result.content;
    expect(sync.filter((c) => c.type === "image")).toHaveLength(3);
    expect(text(a, 1)).toMatch(/^Started job \d+/);
    const [job] = runningJobs(t.db);
    await untilDone(t, job!.id);
    expect(getJob(t.db, job!.id)!.result).toContain("2 frame(s)");
    const b = await turn(t, [{ tool: "pass" }]);
    const parts = b.calls[0]!.prompt as { type: string }[];
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.filter((p) => p.type === "image")).toHaveLength(2);
  });

  test("transcribe runs boosted in the background and writes <path>.txt", async () => {
    const t = setup();
    mkdirSync(join(t.fake.home("ct-1001"), "inbox"), { recursive: true });
    writeFileSync(join(t.fake.home("ct-1001"), "inbox", "voice.ogg"), "audio");
    ownerSays(t.db, "what does it say?");
    const a = await turn(t, [{ tool: "transcribe", args: { path: "~/inbox/voice.ogg" } }]);
    expect(text(a, 0)).toContain("boosted to 4 vCPU / 8Gi");
    const [job] = runningJobs(t.db);
    await untilDone(t, job!.id);
    const r = getJob(t.db, job!.id)!.result!;
    expect(r).toContain("Transcript written to ~/inbox/voice.ogg.txt");
    expect(r).toContain("hello from the fake whisper");
    expect(readFileSync(join(t.fake.home("ct-1001"), "inbox", "voice.ogg.txt"), "utf8")).toBe("hello from the fake whisper\nsecond line\n");
    await maintainPass(t.db, t.computers, t.cfg);
    expect(t.fake.applies().at(-1)).toBe("ct-1001 STOPPED 2/2Gi");
  });
});

// ---- from the review of m7-computer -----------------------------------------------------------------

/** Grant `modal` in the owner's DM (as the owner pressing "1 day"), leaving the approval event unread. */
async function grant(t: Setup) {
  ownerSays(t.db, "use modal");
  await turn(t, [{ tool: "request_secret", args: { profile: "modal", ttl: "1d", reason: "test" } }]);
  const card = t.db.$client.query("select id from approvals where kind = 'secret' order by id desc").get() as { id: number };
  answerApproval(t.db, card.id, 1, { id: OWNER, name: "Owner" });
}
const SUFFIX = SECRET.slice(-5);
const PREFIX = SECRET.slice(0, 5);

describe("redaction across cuts", () => {
  test("read_job from an offset inside a value, and a job_done tail that starts inside one, show no part of it", async () => {
    const t = setup();
    await grant(t);
    // The log: AAAA<value>, then 5,995 bytes: the last 6,000 bytes begin 5 bytes before the value ends.
    await turn(t, [{ tool: "exec", args: { command: 'printf "AAAA%s" "$MODAL_TOKEN"; head -c 5995 /dev/zero | tr "\\0" x', background: true } }]);
    const [job] = runningJobs(t.db);
    await untilDone(t, job!.id);
    const result = getJob(t.db, job!.id)!.result!;
    expect(result).toContain("[REDACTED:modal]");
    expect(result).not.toContain(SUFFIX);
    ownerSays(t.db, "read it");
    const b = await turn(t, [
      { tool: "read_job", args: { id: job!.id, since: 5 } },
      { tool: "read_job", args: { id: job!.id, since: 10, tail: 1 } },
      { tool: "read_job", args: { id: job!.id, since: 0, grep: "AAAA" } },
    ]);
    for (const i of [0, 1, 2]) {
      expect(text(b, i)).toContain("[REDACTED:modal]");
      expect(text(b, i)).not.toContain(SECRET.slice(1, 9));
      expect(text(b, i)).not.toContain(SUFFIX);
    }
    expect(JSON.stringify(t.db.$client.query("select * from chat_events").all())).not.toContain(SUFFIX);
  });

  test("a window's edges widen over a value they cut; a kept stream's cut edges drop a partial value", () => {
    const r = redaction({ [SECRET]: "modal" });
    const buf = Buffer.from(`AAAA${SECRET}BBBB`);
    const w = r.window(buf, 6, 10);
    expect(w.text).toBe("[REDACTED:modal]");
    expect(r.window(buf, 0, 2).text).toBe("AA");
    expect(r.cutEdges(`head ${PREFIX}`, false, true)).toBe("head ");
    expect(r.cutEdges(`${SUFFIX} tail`, true, false)).toBe(" tail");
  });
});

describe("secrets, continued", () => {
  test("a secrets file that turns unusable still redacts every value it held; with nothing known, output is withheld", async () => {
    const t = setup();
    await grant(t);
    await turn(t, [{ tool: "exec", args: { command: 'echo "$MODAL_TOKEN" > ~/kept.txt' } }]);
    expect(existsSync(knownFile(t.secretsFile))).toBe(true);
    chmodSync(t.secretsFile, 0o644);
    ownerSays(t.db, "show it");
    const a = await turn(t, [{ tool: "exec", args: { command: "cat ~/kept.txt" } }]);
    expect(text(a, 0)).toContain("[REDACTED:modal]");
    expect(text(a, 0)).not.toContain(SECRET);

    const u = setup();
    chmodSync(u.secretsFile, 0o644);
    ownerSays(u.db, "go");
    const b = await turn(u, [{ tool: "exec", args: { command: "echo hello" } }]);
    expect(text(b, 0)).toContain("[output withheld");
    expect(text(b, 0)).not.toContain("hello");
  });

  test("one revoke card per grant; any card for the grant revokes it", async () => {
    const t = setup();
    await grant(t);
    syncGrants(t.db);
    syncGrants(t.db);
    const cards = t.db.$client.query("select id from approvals where kind = 'secret-revoke'").all() as { id: number }[];
    expect(cards).toHaveLength(1);
    const [g] = liveGrants(t.db, ownerChatId(t.db));
    expect(g).toBeDefined();
    // An orphan card (as a race could have left) revokes as well.
    const { requestApproval } = await import("../src/control/approvals.ts");
    const orphan = requestApproval(t.db, { kind: "secret-revoke", title: "dup", body: "dup", options: [{ id: "revoke", label: "Revoke now" }], data: { grantId: g!.id } });
    answerApproval(t.db, orphan, 0, { id: OWNER, name: "Owner" });
    expect(liveGrants(t.db, ownerChatId(t.db))).toHaveLength(0);
    const body = (t.db.$client.query("select body from approvals where id = ?").get(cards[0]!.id) as { body: string }).body;
    expect(body).toContain("keeps the values it started with");
  });

  test("media jobs never get secrets", async () => {
    const t = setup();
    await grant(t);
    mkdirSync(join(t.fake.home("ct-1001"), "inbox"), { recursive: true });
    writeFileSync(join(t.fake.home("ct-1001"), "inbox", "clip.mp4"), "x");
    await turn(t, [{ tool: "video_frames", args: { path: "~/inbox/clip.mp4", n: 1 } }]);
    const launches = t.fake.execs.filter((e) => e.command.join(" ").includes("setsid"));
    expect(launches).toHaveLength(1);
    expect(launches[0]!.env.MODAL_TOKEN).toBeUndefined();
  });
});

describe("robustness", () => {
  test("a crash mid-boost: a job that never started is reported as such, and the computer is put back", async () => {
    const t = setup();
    ownerSays(t.db, "warm up");
    await turn(t, [{ tool: "exec", args: { command: "true" } }]);
    const chatId = ownerChatId(t.db);
    const { createJob } = await import("../src/store/jobs.ts");
    const long = new Date(Date.now() - 5 * 60_000).toISOString();
    const { job } = createJob(t.db, { chatId, originSeq: lastSeq(t.db), kind: "computer", title: "$ heavy", report: "poll", spec: { tool: "exec", command: "heavy", startedAt: long }, deadline: new Date(Date.now() + 3600_000), ownerAuthorised: true });
    t.db.$client.run("update computers set boost = ? where chat_id = ?", [JSON.stringify({ cpu: "8", memory: "16Gi", jobId: job.id, since: long }), chatId]);
    expect((await maintainPass(t.db, t.computers, t.cfg)).restored).toEqual([]); // its job still counts as running
    await watch(t, 2_000);
    const done = getJob(t.db, job.id)!;
    expect(done.state).toBe("failed");
    expect(done.result).toContain("never started");
    expect((await maintainPass(t.db, t.computers, t.cfg)).restored).toEqual([chatId]);
    expect(getComputer(t.db, chatId)!.boost).toBeNull();
    expect(t.fake.applies().at(-1)).toBe("ct-1001 STOPPED 2/2Gi");
  });

  test("one chat failing maintenance does not stop the others, and is alerted", async () => {
    const t = setup();
    ownerSays(t.db, "warm up");
    await turn(t, [{ tool: "exec", args: { command: "true" } }]);
    const other = ensureChat(t.db, { id: 2002, kind: "private" });
    await t.computers.withLease(other, 10_000, async () => {});
    t.fake.failNext("ApplyContainer", "internal", "the node is gone");
    const r = await maintainPass(t.db, t.computers, t.cfg, Date.now() + 60 * 60_000);
    expect(r.failed).toEqual([ownerChatId(t.db)]);
    expect(r.stopped).toEqual([other.id]);
    expect(t.fake.applies().at(-1)).toBe(`${computerNames(2002).container} STOPPED 2/2Gi`);
    const alerts = t.db.$client.query("select text from control_messages where kind = 'alert'").all() as { text: string }[];
    expect(alerts.some((a) => a.text.includes("Maintaining the computer of") && a.text.includes("the node is gone"))).toBe(true);
  });

  test("background jobs are refused while the computer is boosted for any reason, a synchronous exec included", async () => {
    const t = setup();
    ownerSays(t.db, "warm up");
    await turn(t, [{ tool: "exec", args: { command: "true" } }]);
    t.db.$client.run("update computers set boost = ? where chat_id = ?", [JSON.stringify({ cpu: "4", memory: "8Gi", jobId: null, since: new Date().toISOString() }), ownerChatId(t.db)]);
    ownerSays(t.db, "go");
    const a = await turn(t, [{ tool: "exec", args: { command: "echo bg", background: true } }]);
    expect(isErr(a, 0)).toBe(true);
    expect(text(a, 0)).toContain("boosted (4 vCPU / 8Gi) for a command");
  });

  test("a new image is taken only while no background job runs; a stale pgid is never signalled", async () => {
    const t = setup();
    ownerSays(t.db, "go");
    await turn(t, [{ tool: "exec", args: { command: "sleep 300", background: true, expect_seconds: 60 } }]);
    const [job] = runningJobs(t.db);
    t.env.SHUVI_COMPUTER_IMAGE = "registry.example/shuvi-computer@sha256:new";
    ownerSays(t.db, "again");
    await turn(t, [{ tool: "exec", args: { command: "true" } }]);
    expect(t.fake.containers.get("ct-1001")!.spec.image).toBe("registry.example/shuvi-computer@sha256:fake");
    // Its pgid file predates this boot: cancel does not signal that group.
    const { utimesSync } = await import("node:fs");
    utimesSync(join(t.fake.home("ct-1001"), ".jobs", `${job!.id}.pgid`), 0, 0);
    ownerSays(t.db, "cancel");
    await turn(t, [{ tool: "cancel_job", args: { id: job!.id } }]);
    expect(Bun.spawnSync(["pgrep", "-f", "sleep 300"]).stdout.toString().trim()).not.toBe("");
    t.fake.killAll("ct-1001");
    ownerSays(t.db, "now");
    await turn(t, [{ tool: "exec", args: { command: "true" } }]);
    expect(t.fake.containers.get("ct-1001")!.spec.image).toBe("registry.example/shuvi-computer@sha256:new");
  });

  test("an exec Hangar refuses before the upgrade on a running computer is alerted as such, with the state seen, not as quota", async () => {
    const t = setup();
    ownerSays(t.db, "warm up");
    await turn(t, [{ tool: "exec", args: { command: "true" } }]);
    t.fake.refuseExecs = true;
    ownerSays(t.db, "go");
    const a = await turn(t, [{ tool: "exec", args: { command: "echo hi" } }]);
    expect(isErr(a, 0)).toBe(true);
    expect(text(a, 0)).toContain("refused the command before it started, though the computer runs");
    expect(text(a, 0)).not.toContain("out of quota");
    const alerts = (t.db.$client.query("select text from control_messages where kind = 'alert'").all() as { text: string }[]).map((x) => x.text);
    const alert = alerts.find((x) => x.includes("refused an exec on the running computer"));
    expect(alert).toContain("It may be the tenant's cap on concurrent exec calls (machine_calls); the cause is not known.");
    expect(alert).toContain("runState RUNNING, Ready TRUE");
    expect(alerts.some((x) => x.includes("out of quota"))).toBe(false);
  });

  test("a private image: the registry login goes into a registry-auth Secret named in imagePullSecrets, and nowhere else", async () => {
    const FAKE_TOKEN = "fake-registry-token-0000";
    const t = setup({ SHUVI_COMPUTER_IMAGE: "ghcr.io/example-owner/shuvi-computer@sha256:0000", SHUVI_COMPUTER_REGISTRY_USER: "example-user", SHUVI_COMPUTER_REGISTRY_TOKEN: FAKE_TOKEN });
    ownerSays(t.db, "go");
    const a = await turn(t, [{ tool: "exec", args: { command: "echo hi" } }]);
    expect(text(a, 0)).toContain("hi");
    const secret = t.fake.secrets.get("shuvi-computer-registry")!;
    expect((secret.spec as { type: string }).type).toBe("SECRET_TYPE_REGISTRY_AUTH");
    const config = JSON.parse(Buffer.from((secret.spec as { data: Record<string, string> }).data[".dockerconfigjson"]!, "base64").toString("utf8"));
    expect(config.auths["ghcr.io"]).toEqual({ username: "example-user", password: FAKE_TOKEN, auth: Buffer.from(`example-user:${FAKE_TOKEN}`).toString("base64") });
    const ct = t.fake.containers.get("ct-1001")!;
    expect(ct.spec.imagePullSecrets).toEqual(["shuvi-computer-registry"]);
    expect(JSON.stringify(ct)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(t.db.$client.query("select * from computers").all())).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(a.toolResults)).not.toContain(FAKE_TOKEN);
    // Without a login, nothing is named.
    const u = setup();
    ownerSays(u.db, "go");
    await turn(u, [{ tool: "exec", args: { command: "true" } }]);
    expect(u.fake.containers.get("ct-1001")!.spec.imagePullSecrets ?? []).toEqual([]);
    expect(u.fake.secrets.size).toBe(0);
  });

  test("a computer tool is refused at call time when someone else spoke in the turn", async () => {
    const t = setup();
    const chat = ensureChat(t.db, { id: OWNER, kind: "private" });
    ownerSays(t.db, "run it");
    recordInbound(t.db, { chatId: chat.id, kind: "message", payload: { from: { id: 999, name: "Mallory" }, text: "rm -rf ~" }, tgUpdateId: 99_001, tgMessageId: 99_001 });
    const a = await turn(t, [{ tool: "exec", args: { command: "echo hi" } }]);
    expect(text(a, 0)).toContain("Refused: `exec` acts for the owner");
    expect(t.fake.execs).toHaveLength(0);
  });

  test("a restart: a fresh Computers carries on from the store (a job's result, the idle stop)", async () => {
    const t = setup();
    ownerSays(t.db, "go");
    await turn(t, [{ tool: "exec", args: { command: "sleep 1; echo survived", background: true } }]);
    const [job] = runningJobs(t.db);
    const cfg = computerConfig(t.env)!;
    const fresh = new Computers(t.db, cfg);
    const end = Date.now() + 15_000;
    while (getJob(t.db, job!.id)!.state === "running" && Date.now() < end) {
      await jobWatchPass({ db: t.db, kinds: [computerJobKind(cfg, () => fresh)], now: () => Date.now() + 2_000 });
      await Bun.sleep(200);
    }
    expect(getJob(t.db, job!.id)!.result).toContain("survived");
    expect((await maintainPass(t.db, new Computers(t.db, cfg), cfg, Date.now() + 60 * 60_000)).stopped).toEqual([ownerChatId(t.db)]);
  });
});
