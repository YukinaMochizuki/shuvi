import { describe, expect, test } from "bun:test";
import { classify } from "../src/telegram/inbound.ts";
import { dmUpdate, OWNER } from "./helpers.ts";

describe("classify", () => {
  test("only the owner's private chat is taken", () => {
    expect(classify(dmUpdate(1, "hi", 777), OWNER).kind).toBe("ignore");
    const group = { update_id: 2, message: { message_id: 1, date: 0, chat: { id: -5, type: "group", title: "g" }, from: { id: OWNER, is_bot: false, first_name: "O" }, text: "hi" } };
    expect(classify(group as never, OWNER).kind).toBe("unknown_chat"); // not listed in policy (test/groups.test.ts)
    expect(classify(dmUpdate(3, "hi"), OWNER).kind).toBe("message");
  });

  test("/new and /stop are commands, with or without this bot's name; other slash text is a message", () => {
    expect(classify(dmUpdate(1, "/new"), OWNER, "shuvi_bot")).toMatchObject({ kind: "command", payload: { command: "new" } });
    expect(classify(dmUpdate(2, "/stop@shuvi_bot"), OWNER, "shuvi_bot")).toMatchObject({ kind: "command", payload: { command: "stop" } });
    expect(classify(dmUpdate(3, "/stop@other_bot"), OWNER, "shuvi_bot").kind).toBe("message");
    expect(classify(dmUpdate(4, "/new thing"), OWNER, "shuvi_bot").kind).toBe("message");
  });

  test("content without text becomes a placeholder, keeping a caption", () => {
    const sticker = classify(dmUpdate(1, undefined as never, OWNER, { text: undefined, sticker: { emoji: "😳", set_name: "Girl" } }), OWNER);
    expect(sticker).toMatchObject({ kind: "message", payload: { text: "[sticker: 😳, Girl]", placeholder: true } });
    const photo = classify(dmUpdate(2, undefined as never, OWNER, { text: undefined, photo: [{}], caption: "is this the front side" }), OWNER);
    expect(photo).toMatchObject({ payload: { text: "[photo] is this the front side" } });
  });

  test("a reply carries what it replies to", () => {
    const c = classify(dmUpdate(1, "yes", OWNER, { reply_to_message: { message_id: 9, from: { id: 1, first_name: "shuvi" }, text: "want me to check" } }), OWNER);
    expect(c).toMatchObject({ payload: { replyTo: { tgMessageId: 9, fromName: "shuvi", text: "want me to check" } } });
  });
});
