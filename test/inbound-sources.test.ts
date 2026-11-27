import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMessage } from "../src/agent/render.ts";
import { runTurn } from "../src/agent/turn.ts";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import { handleHook } from "../src/capabilities/jobs/hooks.ts";
import { READ_TOOL_NAMES } from "../src/capabilities/workstream/reads.ts";
import { inboundText, inboundTokens, inboundTokenVar, loadInboundSources } from "../src/capabilities/jobs/inbound.ts";
import type { Db } from "../src/store/db.ts";
import { DELETE_UNDO_MS, deleteTurns, purgeDeletions } from "../src/store/deletions.ts";
import { getChat, getEvent, triggersAfter, type ExternalPayload } from "../src/store/events.ts";
import { claimTurn, finishTurn } from "../src/store/turns.ts";
import { memDb, OWNER, ownerChatId, ScriptedAdapter } from "./helpers.ts";

/** What the next turn of chat `chatId` would be given: null when nothing asks for one. */
const nextTurnInput = (db: Db, chatId: number) => (triggersAfter(db, chatId, getChat(db, chatId)!.cursorSeq).length ? "something" : null);

function homeWith(yaml: string): string {
  const home = mkdtempSync(join(tmpdir(), "shuvi-home-"));
  writeFileSync(join(home, "inbound.yaml"), yaml);
  return home;
}

const HOME = homeWith(`sources:
  grafana:
    chat: dm
  backup-log:
    chat: dm
    trigger: false
  untokened:
    chat: dm
`);
const TOKENS = inboundTokens({ SHUVI_INBOUND_GRAFANA_TOKEN: "g-secret", SHUVI_INBOUND_BACKUP_LOG_TOKEN: "b-secret", SHUVI_OTHER: "x" });
const deps = (db: Db) => ({ db, home: HOME, ownerId: OWNER, inboundTokens: TOKENS });
const post = (path: string, body: string, headers: Record<string, string> = {}) => new Request(`http://hooks${path}`, { method: "POST", body, headers });
const externals = (db: Db) => db.$client.query("select seq, payload from chat_events where kind = 'external'").all() as { seq: number; payload: string }[];

describe("home/inbound.yaml and the token variables", () => {
  test("sources are read from home/, tokens only from the environment", () => {
    const s = loadInboundSources(HOME);
    expect([...s.keys()]).toEqual(["grafana", "backup-log", "untokened"]);
    expect(s.get("grafana")).toEqual({ name: "grafana", chat: "dm", trigger: true });
    expect(s.get("backup-log")!.trigger).toBe(false);
    expect(inboundTokenVar("backup-log")).toBe("SHUVI_INBOUND_BACKUP_LOG_TOKEN");
    expect(TOKENS).toEqual({ SHUVI_INBOUND_GRAFANA_TOKEN: "g-secret", SHUVI_INBOUND_BACKUP_LOG_TOKEN: "b-secret" });
  });

  test("names that would share a token variable are all refused", () => {
    const s = loadInboundSources(homeWith(`sources:\n  backup-log:\n    chat: dm\n  backup_log:\n    chat: dm\n  grafana:\n    chat: dm\n`));
    expect([...s.keys()]).toEqual(["grafana"]);
  });

  test("a malformed entry is skipped; a missing file is no sources", () => {
    const s = loadInboundSources(homeWith(`sources:\n  "Bad Name":\n    chat: dm\n  nochat: {}\n  group:\n    chat: -100123\n`));
    expect([...s.keys()]).toEqual(["group"]);
    expect(s.get("group")!.chat).toBe(-100123);
    expect(loadInboundSources(mkdtempSync(join(tmpdir(), "shuvi-home-"))).size).toBe(0);
  });

  test("the body becomes text: a JSON object's text or message, else the body", () => {
    expect(inboundText(JSON.stringify({ text: "disk 91%" }), "application/json")).toBe("disk 91%");
    expect(inboundText(JSON.stringify({ message: "m" }), "application/json")).toBe("m");
    expect(inboundText(JSON.stringify({ alert: 1 }), "application/json")).toBe('{"alert":1}');
    expect(inboundText("  plain  ", "text/plain")).toBe("plain");
  });
});

describe("POST /inbound/<source>", () => {
  test("unknown or untokened sources are 404, wrong tokens 401, and nothing is written", async () => {
    const db = memDb();
    expect((await handleHook(deps(db), post("/inbound/nope", "x", { authorization: "Bearer g-secret" }))).status).toBe(404);
    expect((await handleHook(deps(db), post("/inbound/untokened", "x", { authorization: "Bearer " }))).status).toBe(404);
    expect((await handleHook(deps(db), post("/inbound/grafana", "x", { authorization: "Bearer b-secret" }))).status).toBe(401);
    expect((await handleHook(deps(db), post("/inbound/grafana", "x"))).status).toBe(401);
    expect((await handleHook(deps(db), new Request("http://hooks/inbound/grafana", { method: "GET", headers: { authorization: "Bearer g-secret" } }))).status).toBe(405);
    expect((await handleHook(deps(db), post("/elsewhere", "x"))).status).toBe(404);
    expect((db.$client.query("select count(*) as n from chat_events").get() as { n: number }).n).toBe(0);
    expect((db.$client.query("select count(*) as n from chats").get() as { n: number }).n).toBe(0);
  });

  test("the right token lands an external event in the configured chat, which starts a turn there", async () => {
    const db = memDb();
    const res = await handleHook(deps(db), post("/inbound/grafana", JSON.stringify({ text: "disk 91% on vm-3" }), { authorization: "Bearer g-secret", "content-type": "application/json" }));
    expect(res.status).toBe(200);
    const [e] = externals(db);
    expect(JSON.parse(e!.payload)).toEqual({ source: "grafana", text: "disk 91% on vm-3", trigger: true });
    const turn = claimTurn(db, ownerChatId(db))!;
    expect(turn.toSeq).toBe(e!.seq);
    expect(renderMessage(getEvent(db, e!.seq)!, "UTC")).toMatch(/^\[#\d+ · \w{3} \d\d\/\d\d \d\d:\d\d · ⚙ inbound: grafana\]\n  disk 91% on vm-3$/);
  });

  test("an Idempotency-Key makes a retried POST land once", async () => {
    const db = memDb();
    const h = { authorization: "Bearer g-secret", "idempotency-key": "alert-77" };
    expect((await handleHook(deps(db), post("/inbound/grafana", "a", h))).status).toBe(200);
    const again = await handleHook(deps(db), post("/inbound/grafana", "a", h));
    expect(await again.json()).toEqual({ ok: true, already: "recorded" });
    expect(externals(db)).toHaveLength(1);
  });

  test("a turn deleted from the console, with the event it answered, then purged: a retry with the same key is not recorded again", async () => {
    const db = memDb();
    const chat = ownerChatId(db);
    const h = { authorization: "Bearer g-secret", "idempotency-key": "alert-78" };
    await handleHook(deps(db), post("/inbound/grafana", "disk 95%", h));
    const turn = claimTurn(db, chat)!;
    finishTurn(db, turn.id, { status: "done" });
    const r = deleteTurns(db, [turn.id], 1_000);
    expect(r.ok).toBe(true);
    expect(externals(db)).toHaveLength(0);
    // While the undo can still put it back, and after the purge: the key is spent.
    expect(await (await handleHook(deps(db), post("/inbound/grafana", "disk 95%", h))).json()).toEqual({ ok: true, already: "recorded" });
    expect(purgeDeletions(db, "/nonexistent", 1_000 + DELETE_UNDO_MS).deletions).toBe(1);
    expect(await (await handleHook(deps(db), post("/inbound/grafana", "disk 95%", h))).json()).toEqual({ ok: true, already: "recorded" });
    expect(externals(db)).toHaveLength(0);
    expect(nextTurnInput(db, chat)).toBeNull();
    // Another key still lands.
    await handleHook(deps(db), post("/inbound/grafana", "disk 96%", { ...h, "idempotency-key": "alert-79" }));
    expect(externals(db)).toHaveLength(1);
  });

  test("trigger: false is recorded and starts no turn, but the next turn is shown it; and it gives no owner authority", async () => {
    const db = memDb();
    await handleHook(deps(db), post("/inbound/backup-log", "backup ok", { authorization: "Bearer b-secret" }));
    expect(externals(db)).toHaveLength(1);
    expect(claimTurn(db, ownerChatId(db))).toBeNull();
    await handleHook(deps(db), post("/inbound/grafana", "disk 91%", { authorization: "Bearer g-secret" }));
    const turn = claimTurn(db, ownerChatId(db))!;
    let adapter!: ScriptedAdapter;
    await runTurn({
      db,
      turnId: turn.id,
      home: HOME,
      timeZone: "UTC",
      ownerId: OWNER,
      capabilities: enabledCapabilities({ SHUVI_WEB: "off", SHUVI_STICKERS: "off", SHUVI_MEMORY: "off", SHUVI_RETRIEVAL: "off", SHUVI_PLAYBOOKS: "off", SHUVI_RELEASES: "off", SHUVI_GROUPS: "off", SHUVI_WORKSTREAM_MCP_URL: "http://ws/mcp", SHUVI_WORKSTREAM_MCP_TOKEN: "t" }),
      makeAdapter: (b) => (adapter = new ScriptedAdapter(b, [{ tool: "ask_workstream", args: { product: "widgetry", message: "x" } }, { tool: "pass" }])),
    });
    expect(adapter.calls[0]!.prompt).toContain("⚙ inbound: backup-log]\n  backup ok");
    expect(adapter.calls[0]!.prompt).toContain("⚙ inbound: grafana]\n  disk 91%");
    // An outside system is not the owner: the owner-only tools are offered, and refused.
    expect(adapter.calls[0]!.tools).toEqual(["say", "react", "pass", "schedule", "list_schedules", "cancel_schedule", "ask_workstream", ...READ_TOOL_NAMES]);
    expect(adapter.toolResults[0]!.result.isError).toBe(true);
    const p = JSON.parse(externals(db)[0]!.payload) as ExternalPayload;
    expect(p.trigger).toBe(false);
  });
});
