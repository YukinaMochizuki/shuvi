import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, type ToolDef } from "agent-runtime";
import { buildSystemPrompt } from "../src/agent/prompt.ts";
import { runTurn } from "../src/agent/turn.ts";
import { CAPABILITIES, enabledCapabilities } from "../src/capabilities/index.ts";
import { defineCapability, enableCapabilities, capabilityLoops, capabilityTools, type ServerContext } from "../src/capabilities/types.ts";
import { startLoops } from "../src/server/loop.ts";
import { getChat } from "../src/store/events.ts";
import { claimTurn } from "../src/store/turns.ts";
import { memDb, OWNER, ownerChatId, ownerSays, ScriptedAdapter } from "./helpers.ts";

/** The home/ the pinned prompts were produced from, before the capability seam existed. */
function fixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), "shuvi-home-"));
  mkdirSync(join(home, "persona"));
  mkdirSync(join(home, "memory"));
  writeFileSync(join(home, "persona/public.md"), "PUBLIC PERSONA\n");
  writeFileSync(join(home, "persona/private.md"), "PRIVATE PERSONA");
  writeFileSync(join(home, "directives.md"), "- Always be brief.\n");
  writeFileSync(join(home, "memory/private.md"), "PRIVATE MEMORY");
  return home;
}

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

describe("the owner's DM system prompt is byte-identical to before the capability seam", () => {
  // test/fixtures/owner-dm-prompt.*.txt were written by the pre-seam buildSystemPrompt for this home/ and
  // config. They must not be regenerated to make this test pass: a difference is a behaviour change.
  // They pin speech and web; capabilities added since (schedules, memory, …) are turned off here by their own
  // variables, and their sections are tested where they are. Groups stays on: it adds no section to the DM.
  // The prompt is built with the default policy (no policy.yaml), as a bare call does.
  test("web on, language set", () => {
    const db = memDb();
    ownerSays(db, "hi");
    const chat = getChat(db, ownerChatId(db))!;
    const caps = enabledCapabilities({ SHUVI_TAVILY_API_KEY: "tvly-test", SHUVI_SCHEDULES: "off", SHUVI_MEMORY: "off", SHUVI_RETRIEVAL: "off", SHUVI_PLAYBOOKS: "off" });
    expect(buildSystemPrompt(fixtureHome(), chat, { name: "Owner", language: "Traditional Chinese (Taiwan)" }, caps)).toBe(fixture("owner-dm-prompt.web.txt"));
  });

  test("web off, no language", () => {
    const db = memDb();
    ownerSays(db, "hi");
    const chat = getChat(db, ownerChatId(db))!;
    const caps = enabledCapabilities({ SHUVI_WEB: "off", SHUVI_SCHEDULES: "off", SHUVI_MEMORY: "off", SHUVI_RETRIEVAL: "off", SHUVI_PLAYBOOKS: "off" });
    expect(buildSystemPrompt(fixtureHome(), chat, { name: "Owner" }, caps)).toBe(fixture("owner-dm-prompt.no-web.txt"));
  });
});

describe("the registry", () => {
  test("speech is first and always on; web, vision and schedules follow their variables", () => {
    expect(CAPABILITIES.map((c) => c.id)).toEqual(["speech", "web", "vision", "jobs", "schedules", "workstream", "memory", "retrieval", "playbooks", "stickers", "computer", "groups"]);
    expect(enabledCapabilities({}).map((e) => e.capability.id)).toEqual(["speech", "web", "vision", "jobs", "schedules", "memory", "retrieval", "playbooks", "stickers", "groups"]);
    expect(enabledCapabilities({ SHUVI_WEB: "off", SHUVI_VISION: "off", SHUVI_SCHEDULES: "off", SHUVI_MEMORY: "off", SHUVI_RETRIEVAL: "off", SHUVI_PLAYBOOKS: "off", SHUVI_STICKERS: "off", SHUVI_GROUPS: "off" }).map((e) => e.capability.id)).toEqual(["speech", "jobs"]);
  });

  test("workstream is on only with its URL and token", () => {
    const ids = (env: Record<string, string>) => enabledCapabilities(env).map((e) => e.capability.id);
    expect(ids({ SHUVI_WORKSTREAM_MCP_URL: "http://ws/mcp" })).not.toContain("workstream");
    expect(ids({ SHUVI_WORKSTREAM_MCP_URL: "http://ws/mcp", SHUVI_WORKSTREAM_MCP_TOKEN: "t" })).toContain("workstream");
  });

  test("bundles sharing a server name are merged, so the Claude driver (MCP servers keyed by name) keeps them all", async () => {
    const db = memDb();
    ownerSays(db, "hi");
    const turn = claimTurn(db, ownerChatId(db))!;
    let adapter!: ScriptedAdapter;
    await runTurn({
      db,
      turnId: turn.id,
      home: fixtureHome(),
      timeZone: "UTC",
      ownerId: OWNER,
      capabilities: enabledCapabilities({}),
      makeAdapter: (b) => (adapter = new ScriptedAdapter(b, [{ tool: "pass" }])),
    });
    expect(adapter.calls[0]!.tools).toEqual(["say", "react", "pass", "schedule", "list_schedules", "cancel_schedule", "read_home", "edit_home", "write_home", "edit_chat_notes", "search_chats", "read_chat", "read_playbook", "find_sticker", "list_stickers", "view_stickers", "sticker", "add_sticker_pack", "remove_sticker_pack", "send", "propose_policy", "read_policy", "explain_policy", "web_fetch"]);
    const names = capabilityTools(enabledCapabilities({}), { db, home: fixtureHome(), chat: getChat(db, ownerChatId(db))!, turnId: turn.id, timeZone: "UTC", owner: {}, state: {} as never }).map((b) => b.serverName);
    expect(names).toEqual(["shuvi", "web"]);
  });

  test("web reads SHUVI_TAVILY_API_KEY: web_search only with a key", () => {
    expect(enabledCapabilities({}).find((e) => e.capability.id === "web")!.config).toEqual({});
    expect(enabledCapabilities({ SHUVI_TAVILY_API_KEY: "k" }).find((e) => e.capability.id === "web")!.config).toEqual({ tavilyApiKey: "k" });
  });
});

describe("a capability added to the registry", () => {
  let loopRuns = 0;
  const probe = defineCapability<{ greeting: string }>({
    id: "probe",
    label: "probe",
    gives: "a probe tool, for this test.",
    enable: (env) => (env.SHUVI_PROBE ? { greeting: env.SHUVI_PROBE } : null),
    tools: (ctx, config) => {
      const tool: ToolDef<Record<string, never>> = {
        name: "probe",
        description: "A throwaway tool.",
        inputSchema: {},
        async handler() {
          return ok(`${config.greeting} from turn ${ctx.turnId} in chat ${ctx.chat.id}`);
        },
      };
      return [{ serverName: "probe", tools: [tool] as ToolDef[] }];
    },
    section: () => "## Probing\n\nPROBE SECTION",
    loops: (_ctx: ServerContext, config) => [{ name: "probe", everyMs: 5, run: async () => void (loopRuns += config.greeting.length > 0 ? 1 : 0) }],
  });
  const registry = [...CAPABILITIES, probe];

  test("is off unless its own variable enables it", () => {
    expect(enableCapabilities(registry, {}).map((e) => e.capability.id)).toEqual(["speech", "web", "vision", "jobs", "schedules", "memory", "retrieval", "playbooks", "stickers", "groups"]);
  });

  test("its tool reaches the turn after the others, and its section reaches the prompt in registry order", async () => {
    const db = memDb();
    ownerSays(db, "probe it");
    const turn = claimTurn(db, ownerChatId(db))!;
    let adapter!: ScriptedAdapter;
    const outcome = await runTurn({
      db,
      turnId: turn.id,
      home: fixtureHome(),
      timeZone: "UTC",
      capabilities: enableCapabilities(registry, { SHUVI_PROBE: "hello" }),
      makeAdapter: (b) => (adapter = new ScriptedAdapter(b, [{ tool: "probe" }, { token: "done" }])),
    });
    expect(outcome).toBe("done");
    expect(adapter.calls[0]!.tools).toEqual(["say", "react", "pass", "schedule", "list_schedules", "cancel_schedule", "read_home", "edit_home", "write_home", "edit_chat_notes", "search_chats", "read_chat", "read_playbook", "find_sticker", "list_stickers", "view_stickers", "sticker", "add_sticker_pack", "remove_sticker_pack", "send", "propose_policy", "read_policy", "explain_policy", "web_fetch", "probe"]);
    const result = adapter.toolResults[0]!.result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(result).toContain(`hello from turn ${turn.id}`);

    const sp = adapter.calls[0]!.systemPrompt!;
    const order = ["This chat", "How you speak here", "Looking things up", "PROBE SECTION", "PRIVATE MEMORY"].map((s) => sp.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("its loop runs through the server's loop helper, and stops with the server", async () => {
    const db = memDb();
    const stop = new AbortController();
    const files = { download: async () => new Uint8Array(), stickerSet: async () => Promise.reject(new Error("unused")) };
    const ctx: ServerContext = { db, home: fixtureHome(), timeZone: "UTC", ownerId: 1, files, signal: stop.signal };
    const loops = capabilityLoops(enableCapabilities(registry, { SHUVI_PROBE: "hello", SHUVI_VISION: "off" }), ctx);
    expect(loops.map((l) => l.name)).toEqual(["jobs", "schedules", "stickers", "probe"]);
    loopRuns = 0;
    startLoops(loops.filter((l) => l.name === "probe"), stop.signal);
    await Bun.sleep(40);
    stop.abort();
    expect(loopRuns).toBeGreaterThanOrEqual(2);
    const after = loopRuns;
    await Bun.sleep(30);
    expect(loopRuns).toBeLessThanOrEqual(after + 1);
  });
});
