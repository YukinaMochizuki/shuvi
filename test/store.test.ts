import { describe, expect, test } from "bun:test";
import { enqueueOutbound, getChat, pendingOutbound, recordInbound } from "../src/store/events.ts";
import { claimTurn, extendTurn, finishTurn, MAX_ATTEMPTS } from "../src/store/turns.ts";
import { memDb, ownerChatId, ownerSays } from "./helpers.ts";

describe("store: exactly-once keys", () => {
  test("an inbound update recorded twice is recorded once", () => {
    const db = memDb();
    const chatId = ownerChatId(db);
    const e = { chatId, kind: "message" as const, payload: { from: { id: 1, name: "a" }, text: "hi" }, tgUpdateId: 42, tgMessageId: 1 };
    expect(recordInbound(db, e)).toBe(true);
    expect(recordInbound(db, e)).toBe(false);
    expect(db.$client.query("select count(*) as n from chat_events").get()).toEqual({ n: 1 });
  });

  test("an outbound message queued twice under one key is queued once", () => {
    const db = memDb();
    const chatId = ownerChatId(db);
    enqueueOutbound(db, { chatId, kind: "bot_message", payload: { text: "a" }, idemKey: "turn:1:0" });
    enqueueOutbound(db, { chatId, kind: "bot_message", payload: { text: "a (again)" }, idemKey: "turn:1:0" });
    expect(pendingOutbound(db).length).toBe(1);
  });
});

describe("store: turns and the cursor", () => {
  test("a chat has at most one running turn, and no turn is claimed without a message past the cursor", () => {
    const db = memDb();
    const chatId = ownerChatId(db);
    expect(claimTurn(db, chatId)).toBeNull();
    const seq = ownerSays(db, "hi");
    const t = claimTurn(db, chatId);
    expect(t).not.toBeNull();
    expect(claimTurn(db, chatId)).toBeNull();
    extendTurn(db, t!.id, seq); // what the child does when it reads its input
    finishTurn(db, t!.id, { status: "done" });
    expect(claimTurn(db, chatId)).toBeNull(); // the cursor moved: nothing left to answer
  });

  test("the claim reads the cursor itself, so a turn that just finished cannot be answered twice", () => {
    const db = memDb();
    const chatId = ownerChatId(db);
    const seq = ownerSays(db, "hi");
    const t = claimTurn(db, chatId)!;
    extendTurn(db, t.id, seq);
    finishTurn(db, t.id, { status: "done" });
    ownerSays(db, "second");
    const next = claimTurn(db, chatId)!;
    expect(next.fromSeq).toBe(seq);
  });

  test("done and stopped advance the cursor to what the turn was shown; failed does not", () => {
    const db = memDb();
    const chatId = ownerChatId(db);
    const seq = ownerSays(db, "hi");
    for (const status of ["failed", "stopped"] as const) {
      const t = claimTurn(db, chatId)!;
      extendTurn(db, t.id, seq);
      finishTurn(db, t.id, { status });
      expect(getChat(db, chatId)!.cursorSeq).toBe(status === "failed" ? 0 : seq);
    }
  });

  test(`after ${MAX_ATTEMPTS} failures on the same input the cursor moves on, so one bad message cannot wedge a chat`, () => {
    const db = memDb();
    const chatId = ownerChatId(db);
    const seq = ownerSays(db, "the message that always crashes");
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const t = claimTurn(db, chatId)!;
      extendTurn(db, t.id, seq);
      finishTurn(db, t.id, { status: "failed", error: "boom" });
      expect(getChat(db, chatId)!.cursorSeq).toBe(i < MAX_ATTEMPTS ? 0 : seq);
    }
  });

  test("closing a turn twice changes nothing the second time", () => {
    const db = memDb();
    const chatId = ownerChatId(db);
    const seq = ownerSays(db, "hi");
    const t = claimTurn(db, chatId)!;
    extendTurn(db, t.id, seq);
    finishTurn(db, t.id, { status: "failed", error: "reaped" });
    finishTurn(db, t.id, { status: "done" }); // a child finishing after the waker reaped it
    expect(getChat(db, chatId)!.cursorSeq).toBe(0);
  });
});
