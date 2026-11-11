import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Api } from "grammy";
import type { Update } from "grammy/types";
import { answerApproval, expireApprovals, getApproval, requestApproval } from "../src/control/approvals.ts";
import { backupPass, KEEP, takeBackup } from "../src/control/backup.ts";
import { CONTROL_OFFSET_KEY, controlPollOnce, controlSendPass, outboundAlertPass, recordControlBatch, statusText, UNREACHABLE_BACKOFF_MS } from "../src/control/bot.ts";
import { isAlive, parseStartTime, processStart } from "../src/server/spawn.ts";
import { KILL_GRACE_MS, wakerPass } from "../src/server/waker.ts";
import { openDb } from "../src/store/db.ts";
import { ALERT_REPEAT_MS, controlMessagesOf, raiseAlert } from "../src/store/control.ts";
import { enqueueOutbound, getChat, kvGet, markFailed, triggersAfter } from "../src/store/events.ts";
import { claimTurn, finishTurn, getTurn, markTerm, MAX_ATTEMPTS, setTurnPid, WALL_CLOCK_STOP } from "../src/store/turns.ts";
import { dmUpdate, FakeTelegram, memDb, OWNER, ownerChatId, ownerSays } from "./helpers.ts";

let tg: FakeTelegram | null = null;
afterEach(() => {
  tg?.stop();
  tg = null;
});
const fakeApi = () => {
  tg = new FakeTelegram();
  return new Api("CONTROL", { apiRoot: tg.apiRoot });
};
const alerts = (db: ReturnType<typeof memDb>) => controlMessagesOf(db, "alert");
const sentAlerts = (db: ReturnType<typeof memDb>) => alerts(db).filter((a) => a.status !== "suppressed");
const deps = { ownerId: OWNER, commit: "abc1234", timeZone: "UTC" };

function callbackUpdate(updateId: number, data: string, from = OWNER): Update {
  return { update_id: updateId, callback_query: { id: `cq${updateId}`, from: { id: from, is_bot: false, first_name: "Owner" }, chat_instance: "x", data } } as unknown as Update;
}

describe("alerts", () => {
  test("an alert is raised once per key, and repeats on a topic are suppressed for a while", () => {
    const db = memDb();
    const t0 = Date.parse("2026-11-11T00:00:00Z");
    expect(raiseAlert(db, { key: "a:1", topic: "t", text: "one" }, t0)).toBe("pending");
    expect(raiseAlert(db, { key: "a:1", topic: "t", text: "one again" }, t0)).toBeNull();
    expect(raiseAlert(db, { key: "a:2", topic: "t", text: "two" }, t0 + 60_000)).toBe("suppressed");
    expect(raiseAlert(db, { key: "b:1", topic: "other", text: "other" }, t0 + 60_000)).toBe("pending");
    expect(raiseAlert(db, { key: "a:3", topic: "t", text: "three" }, t0 + ALERT_REPEAT_MS + 1)).toBe("pending");
    expect(sentAlerts(db).map((a) => a.text)).toEqual(["one", "other", "three And 1 more like it since the last alert."]);
  });

  test("a failed turn alerts (rate-limited per chat); giving up alerts every unanswered message, never suppressed", () => {
    const db = memDb();
    const first = ownerSays(db, "the message that always crashes");
    const second = ownerSays(db, "and this one too");
    const chatId = ownerChatId(db);
    for (let i = 0; i < MAX_ATTEMPTS; i++) finishTurn(db, claimTurn(db, chatId)!.id, { status: "failed", error: `boom ${i}` });
    const texts = alerts(db).map((a) => [a.status, a.text] as const);
    expect(texts[0]).toEqual(["pending", "Turn 1 failed in chat 1 (tg 1001): boom 0. It will be retried."]);
    expect(texts[1]![0]).toBe("suppressed");
    expect(texts.slice(2)).toEqual([
      ["pending", `Unanswered in chat 1 (tg 1001): "the message that always crashes" (#${first}). 3 turns failed on it, so it was skipped. Last error: boom 2`],
      ["pending", `Unanswered in chat 1 (tg 1001): "and this one too" (#${second}). 3 turns failed on it, so it was skipped. Last error: boom 2`],
    ]);

    // A second message given up a minute later in the same chat is alerted too.
    const third = ownerSays(db, "a third");
    for (let i = 0; i < MAX_ATTEMPTS; i++) finishTurn(db, claimTurn(db, chatId)!.id, { status: "failed", error: "boom" });
    expect(sentAlerts(db).at(-1)!.text).toContain(`"a third" (#${third})`);
    expect(alerts(db).filter((a) => a.text.startsWith("Unanswered")).every((a) => a.status === "pending")).toBe(true);
  });

  test("the next alert that goes out on a topic says how many were suppressed since the last", () => {
    const db = memDb();
    const t0 = Date.parse("2026-11-11T00:00:00Z");
    raiseAlert(db, { key: "f:1", topic: "t", text: "Turn 1 failed." }, t0);
    raiseAlert(db, { key: "f:2", topic: "t", text: "Turn 2 failed." }, t0 + 1000);
    raiseAlert(db, { key: "f:3", topic: "t", text: "Turn 3 failed." }, t0 + 2000);
    raiseAlert(db, { key: "f:4", topic: "t", text: "Turn 4 failed." }, t0 + ALERT_REPEAT_MS + 1);
    raiseAlert(db, { key: "f:5", topic: "t", text: "Turn 5 failed." }, t0 + 3 * ALERT_REPEAT_MS);
    expect(sentAlerts(db).map((a) => a.text)).toEqual(["Turn 1 failed.", "Turn 4 failed. And 2 more like it since the last alert.", "Turn 5 failed."]);
  });

  test("outbound rows that failed, or stayed pending too long, raise one alert per chat", () => {
    const db = memDb();
    const chatId = ownerChatId(db);
    enqueueOutbound(db, { chatId, kind: "bot_message", payload: { text: "x" }, idemKey: "k1" });
    enqueueOutbound(db, { chatId, kind: "bot_message", payload: { text: "y" }, idemKey: "k2" });
    const now = Date.now();
    expect(outboundAlertPass(db, 10 * 60_000, now)).toBe(0); // fresh: nothing yet
    expect(outboundAlertPass(db, 10 * 60_000, now + 11 * 60_000)).toBe(1);
    expect(sentAlerts(db)[0]!.text).toMatch(/^2 outbound row\(s\) to chat 1 \(tg 1001\) pending for more than 10 min/);

    const db2 = memDb();
    const c2 = ownerChatId(db2);
    enqueueOutbound(db2, { chatId: c2, kind: "bot_message", payload: { text: "x" }, idemKey: "k1" });
    const seq = (db2.$client.query("select max(seq) as s from chat_events").get() as { s: number }).s;
    markFailed(db2, seq, "403 Forbidden: bot was blocked by the user");
    expect(outboundAlertPass(db2, 10 * 60_000)).toBe(1);
    expect(outboundAlertPass(db2, 10 * 60_000)).toBe(0); // once per row
    expect(sentAlerts(db2)[0]!.text).toBe(`A message to chat 1 (tg 1001) could not be delivered (#${seq}): 403 Forbidden: bot was blocked by the user`);
  });
});

describe("turn liveness", () => {
  test("the start time is field 22 of /proc/<pid>/stat, counted from the last ')'", () => {
    const fields = Array.from({ length: 50 }, (_, i) => String(i + 3)); // field 3 is "3", …
    expect(parseStartTime(`123 (we ird) (name) ${fields.join(" ")}`)).toBe("22");
  });

  test("a pid is alive only while its start time matches, so a reused pid does not count", () => {
    const start = processStart(process.pid);
    expect(start).not.toBeNull();
    expect(isAlive(process.pid, start)).toBe(true);
    expect(isAlive(process.pid, "1")).toBe(false);
    expect(isAlive(2 ** 22 + 12345, null)).toBe(false);
  });

  test("the waker reaps a running turn whose pid now belongs to another process", () => {
    const db = memDb();
    ownerSays(db, "hi");
    const t = claimTurn(db, ownerChatId(db))!;
    setTurnPid(db, t.id, process.pid, "1"); // this pid, but not the process that was started
    expect(wakerPass({ db, spawn: () => 1 }).reaped).toEqual([t.id]);
    expect(getTurn(db, t.id)!.status).toBe("failed");
  });

  test("the waker records the start time of the process it spawns", () => {
    const db = memDb();
    ownerSays(db, "hi");
    const { started } = wakerPass({ db, spawn: () => 4242, startOf: () => "777", alive: () => true });
    expect(getTurn(db, started[0]!)).toMatchObject({ pid: 4242, pidStart: "777" });
  });
});

describe("turn wall-clock limit", () => {
  test("past the limit: SIGTERM and an alert, SIGKILL after the grace, and the turn closes as stopped with its input handled", () => {
    const db = memDb();
    const seq = ownerSays(db, "something that hangs");
    const chatId = ownerChatId(db);
    const t = claimTurn(db, chatId)!;
    setTurnPid(db, t.id, 4242, "s");
    const started = Date.parse(t.startedAt);
    const signals: string[] = [];
    let alive = true;
    const pass = (now: number) => wakerPass({ db, spawn: () => 1, alive: () => alive, signal: (pid, _s, sig) => signals.push(`${pid}:${sig}`), now: () => now, maxTurnMs: 15 * 60_000 });

    pass(started + 15 * 60_000);
    expect(signals).toEqual([]);
    expect(pass(started + 15 * 60_000 + 1).limited).toEqual([t.id]);
    expect(signals).toEqual(["4242:SIGTERM"]);
    pass(started + 15 * 60_000 + 2); // within the grace: SIGTERM again (it may never have been sent)
    expect(signals).toEqual(["4242:SIGTERM", "4242:SIGTERM"]);
    expect(sentAlerts(db).length).toBe(1); // alerted once
    pass(started + 15 * 60_000 + 2 + KILL_GRACE_MS);
    expect(signals.at(-1)).toBe("4242:SIGKILL");

    alive = false;
    expect(pass(started + 16 * 60_000 + KILL_GRACE_MS).reaped).toEqual([t.id]);
    expect(getTurn(db, t.id)).toMatchObject({ status: "stopped", error: WALL_CLOCK_STOP });
    expect(getChat(db, chatId)!.cursorSeq).toBe(seq); // not retried
    expect(sentAlerts(db).map((a) => a.text)).toEqual([`Turn ${t.id} in chat 1 (tg 1001) ran past the wall-clock limit (15 min) and is being stopped. Its messages will not be retried.`]);
  });

  test("a turn the child closes itself after the limit's SIGTERM records the limit as its reason; an owner /stop does not", () => {
    const db = memDb();
    ownerSays(db, "one");
    const chatId = ownerChatId(db);
    const limited = claimTurn(db, chatId)!;
    markTerm(db, limited.id, new Date().toISOString());
    finishTurn(db, limited.id, { status: "stopped" }); // what the child does on SIGTERM
    expect(getTurn(db, limited.id)).toMatchObject({ status: "stopped", error: WALL_CLOCK_STOP });
    ownerSays(db, "two");
    const owner = claimTurn(db, chatId)!;
    finishTurn(db, owner.id, { status: "stopped" });
    expect(getTurn(db, owner.id)).toMatchObject({ status: "stopped", error: null, termAt: null });
  });
});

describe("control bot", () => {
  test("answers the owner only; /status lists running and failed turns, pending outbound and the commit", () => {
    const db = memDb();
    ownerSays(db, "hi");
    const chatId = ownerChatId(db);
    const failed = claimTurn(db, chatId)!;
    finishTurn(db, failed.id, { status: "failed", error: "process 1 died" });
    const t = claimTurn(db, chatId)!;
    setTurnPid(db, t.id, 4242);
    enqueueOutbound(db, { chatId, kind: "bot_message", payload: { text: "x" }, idemKey: "k" });

    recordControlBatch(db, [dmUpdate(1, "/status", 777), dmUpdate(2, "/status")], deps);
    const replies = controlMessagesOf(db, "reply");
    expect(replies.length).toBe(1);
    const s = replies[0]!.text;
    expect(s).toContain("commit abc1234");
    expect(s).toMatch(new RegExp(`chat 1 \\(tg 1001\\): turn ${t.id}, running \\d+s, pid 4242`));
    expect(s).toContain(`turn ${failed.id}, chat 1 (tg 1001)`);
    expect(s).toContain("process 1 died");
    expect(s).toContain("Outbound pending: 1");
    expect(kvGet(db, CONTROL_OFFSET_KEY)).toBe("3");

    // A re-delivered batch replies once.
    recordControlBatch(db, [dmUpdate(2, "/status")], deps);
    expect(controlMessagesOf(db, "reply").length).toBe(1);
    expect(statusText(db, deps)).toContain("Running turns: 1");
  });

  test("/stop <chat> stops that chat's turn the way /stop in the chat does", () => {
    const db = memDb();
    const first = ownerSays(db, "long task");
    const chatId = ownerChatId(db);
    const t = claimTurn(db, chatId)!;
    setTurnPid(db, t.id, 31337, "s");
    const out = recordControlBatch(db, [dmUpdate(5, `/stop ${chatId}`)], deps);
    expect(out.signals).toEqual([{ pid: 31337, start: "s" }]);
    expect(controlMessagesOf(db, "reply")[0]!.text).toBe(`Stopping turn ${t.id} in chat 1 (tg 1001).`);
    // A message sent after the stop is the next turn's, as with the in-chat /stop.
    const after = ownerSays(db, "do B instead");
    db.$client.exec(`update turns set to_seq = ${after} where id = ${t.id}`);
    finishTurn(db, t.id, { status: "stopped" });
    expect(getChat(db, chatId)!.cursorSeq).toBe(first);
    recordControlBatch(db, [dmUpdate(6, "/stop 99")], deps);
    expect(controlMessagesOf(db, "reply")[1]!.text).toContain("No chat 99");
  });

  test("alerts go out through the control bot's own queue, never chat_events", async () => {
    const db = memDb();
    const api = fakeApi();
    raiseAlert(db, { key: "k", topic: "t", text: "Backup failed: disk full" });
    expect((await controlSendPass(db, api, OWNER)).sent).toBe(1);
    expect(tg!.sent()).toEqual([expect.objectContaining({ chat_id: OWNER, text: "Backup failed: disk full" })]);
    expect(db.$client.query("select count(*) as n from chat_events").get()).toEqual({ n: 0 });
    expect((await controlSendPass(db, api, OWNER)).sent).toBe(0); // sent once
  });

  test("an owner the control bot cannot reach yet (403, chat not found) is retry-later, never a failure", async () => {
    const db = memDb();
    const api = fakeApi();
    raiseAlert(db, { key: "k", topic: "t", text: "Something happened" });
    tg!.fail("sendMessage", { code: 403, description: "Forbidden: bot can't initiate conversation with a user" }, { code: 400, description: "Bad Request: chat not found" });
    expect(await controlSendPass(db, api, OWNER)).toEqual({ sent: 0, failed: 0, backoffMs: UNREACHABLE_BACKOFF_MS });
    expect(await controlSendPass(db, api, OWNER)).toEqual({ sent: 0, failed: 0, backoffMs: UNREACHABLE_BACKOFF_MS });
    expect(alerts(db)[0]!.status).toBe("pending");
    // The owner sent /start: it goes out.
    expect((await controlSendPass(db, api, OWNER)).sent).toBe(1);
    expect(alerts(db)[0]!.status).toBe("sent");
  });
});

describe("approvals", () => {
  test("round trip on the fake Bot API: a card with buttons, the owner's press recorded once, the origin chat woken", async () => {
    const db = memDb();
    const api = fakeApi();
    const chatId = ownerChatId(db);
    const id = requestApproval(db, { kind: "throwaway", title: "Allow the test?", body: "Nothing happens either way.", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }], originChatId: chatId });
    expect(getApproval(db, id)!.status).toBe("pending");

    await controlSendPass(db, api, OWNER);
    const card = tg!.sent()[0]!;
    expect(String(card.text)).toContain("Allow the test?");
    expect(card.reply_markup).toEqual({ inline_keyboard: [[{ text: "Yes", callback_data: `ap:${id}:0` }], [{ text: "No", callback_data: `ap:${id}:1` }]] });

    // A stranger's press is ignored outright; the owner's is recorded; a second press changes nothing.
    tg!.updates.push(callbackUpdate(10, `ap:${id}:1`, 777), callbackUpdate(11, `ap:${id}:0`), callbackUpdate(12, `ap:${id}:1`));
    await controlPollOnce(db, api, { ...deps, signal: () => {} }, 0);
    expect(getApproval(db, id)).toMatchObject({ status: "answered", answer: "yes" });
    expect(tg!.sent("answerCallbackQuery")).toEqual([expect.objectContaining({ callback_query_id: "cq11", text: "Recorded: Yes" }), expect.objectContaining({ callback_query_id: "cq12", text: "This card is closed." })]);

    // The chat that asked is woken by an `approval` event.
    const ev = triggersAfter(db, chatId, 0);
    expect(ev.map((e) => e.kind)).toEqual(["approval"]);
    expect(ev[0]!.payload).toMatchObject({ approvalId: id, answer: "yes", label: "Yes", kind: "throwaway" });
    expect(claimTurn(db, chatId)).not.toBeNull();

    // The card is edited to show the answer, without buttons.
    await controlSendPass(db, api, OWNER);
    const edit = tg!.sent("editMessageText")[0]!;
    expect(edit).toMatchObject({ message_id: 9000, reply_markup: { inline_keyboard: [] } }); // the card's id in the fake
    expect(String(edit.text)).toContain("→ Answered: Yes");
  });

  test("a card past its ttl expires, cannot be answered, and wakes the origin chat with no answer", () => {
    const db = memDb();
    const chatId = ownerChatId(db);
    const now = Date.now();
    const id = requestApproval(db, { kind: "throwaway", title: "t", body: "b", options: [{ id: "ok", label: "OK" }], ttlMs: 60_000, originChatId: chatId }, now);
    expect(answerApproval(db, id, 0, { id: OWNER, name: "Owner" }, now + 61_000).result).toBe("closed");
    expect(expireApprovals(db, OWNER, now + 61_000)).toBe(1);
    expect(getApproval(db, id)!.status).toBe("expired");
    expect(triggersAfter(db, chatId, 0)[0]!.payload).toMatchObject({ approvalId: id, answer: null });
    expect(expireApprovals(db, OWNER, now + 120_000)).toBe(0);
  });

  test("a caller without an origin chat reads the answer", () => {
    const db = memDb();
    const id = requestApproval(db, { kind: "throwaway", title: "t", body: "b", options: [{ id: "a", label: "A" }] });
    recordControlBatch(db, [callbackUpdate(3, `ap:${id}:0`)], deps);
    expect(getApproval(db, id)).toMatchObject({ status: "answered", answer: "a" });
    expect(db.$client.query("select count(*) as n from chat_events").get()).toEqual({ n: 0 });
  });
});

describe("backups", () => {
  test("a consistent copy of the db and a bundle of home/, the newest 7 kept, once a day", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "shuvi-backup-"));
    const db = openDb(join(dataDir, "shuvi.db"), { migrate: true });
    ownerSays(db, "remember this");
    const home = join(dataDir, "home");
    Bun.spawnSync(["git", "init", "-q", home]);
    writeFileSync(join(home, "directives.md"), "- Always be brief.");
    Bun.spawnSync(["git", "-C", home, "add", "."]);
    Bun.spawnSync(["git", "-C", home, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);

    const t0 = Date.parse("2026-11-01T00:00:00Z");
    const dir = takeBackup({ db, dataDir, home, now: () => t0 - 3600_000 });
    const copy = openDb(join(dir, "shuvi.db"));
    expect(copy.$client.query("select count(*) as n from chat_events").get()).toEqual({ n: 1 });
    expect(Bun.spawnSync(["git", "bundle", "verify", join(dir, "home.bundle")], { cwd: home }).exitCode).toBe(0);

    for (let d = 0; d < 9; d++) expect(backupPass({ db, dataDir, home, now: () => t0 + d * 24 * 3600_000 })).toBe("taken");
    expect(backupPass({ db, dataDir, home, now: () => t0 + 8 * 24 * 3600_000 + 60_000 })).toBe("not-due");
    const kept = readdirSync(join(dataDir, "backups")).sort();
    expect(kept.length).toBe(KEEP);
    expect(kept.at(-1)).toBe("2026-11-09T00-00-00-000Z");
  });

  test("a failed backup raises an alert", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "shuvi-backup-"));
    writeFileSync(join(dataDir, "backups"), "not a directory");
    const db = memDb();
    expect(backupPass({ db, dataDir, home: join(dataDir, "home") })).toBe("failed");
    expect(sentAlerts(db)[0]!.text).toMatch(/^Backup failed: /);
    expect(existsSync(join(dataDir, "home"))).toBe(false);
  });
});
