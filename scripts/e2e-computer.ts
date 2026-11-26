#!/usr/bin/env bun
/**
 * Each chat's computer, end to end (M7), with nothing real but the code under test and the Claude Code CLI:
 *
 *   fake Telegram (+ a fake control bot) ⇄ shuvi server ⇄ runner child ⇄ real Claude Code CLI ⇄ fake
 *   Anthropic;  the computer capability ⇄ a fake Hangar (Connect endpoints and an exec WebSocket that runs
 *   commands on this machine)
 *
 *   1. a turn runs a synchronous exec: the disk and the container are created, the output comes back
 *   2. a background exec: the turn ends at once, and the job's end comes back as a job_done turn
 *   3. a secret-gated exec: without a grant the variable is empty; request_secret puts a card in the
 *      control bot; the owner's press wakes the chat, whose exec gets the value in its environment and sees
 *      it only as [REDACTED:modal]; the value never reaches the store or anything the model was sent
 *   4. ~/.computer.yaml: an exec writes it, apply_computer_config applies it as root (apt through the cache
 *      in home, then setup) and records its hash on the root disk
 *   5. the idle computer is stopped (an apply of STOPPED, never a delete)
 *   6. the next command starts it again, and the file, its hash matching, is not applied again
 *   7. video_sheet in the background, with the real ffmpeg on a generated 40 s testsrc video: the job's
 *      result carries the index (two 4x4 sheets, every 2 s), and the job_done turn gets both sheets as
 *      images (skipped, saying so, where ffmpeg is not installed)
 *   8. a group whose policy delegates its computer to an operator (policy.yaml `operators`, `delegate`):
 *      the operator's exec runs on the group's own computer without the owner; someone who is not an
 *      operator is refused, and nothing runs for them
 *   9. a profile kept in the store (sealed under SHUVI_SECRETS_KEY, as the console keeps it) and granted to
 *      every chat until revoked: the owner's turn in the group gets it, hidden as [REDACTED:github]; the
 *      operator's turn in the same group does not; its note's summary is in the prompt, and
 *      update_secret_note keeps what she learned, refusing a note holding the value
 *  10. personal info (src/secrets/info.ts): the owner says his new address in the DM and info_write keeps it
 *      (a version recorded as hers); in the group, the owner's turn reads it back with info_read (the
 *      capability is on in every chat whatever its policy says); an operator's turn is refused info_read
 *
 *   bun scripts/e2e-computer.ts
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Update } from "grammy/types";
import { consoleGrant } from "../src/capabilities/computer/secrets.ts";
import { getNote, setNote } from "../src/secrets/notes.ts";
import { getInfo, infoHistory } from "../src/secrets/info.ts";
import { putProfile } from "../src/secrets/source.ts";
import { openDb } from "../src/store/db.ts";
import { FakeHangar } from "../test/fake-hangar.ts";
import { dmUpdate, FakeTelegram, groupUpdate, OWNER, type Person } from "../test/helpers.ts";

const t0 = Date.now();
const log = (m: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  cleanup();
  process.exit(1);
};
const check = (cond: unknown, m: string) => (cond ? log(`ok  ${m}`) : fail(m));
async function until(what: string, cond: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) fail(`timed out waiting for: ${what}`);
    await Bun.sleep(100);
  }
}

const SECRET = "fake-e2e-secret-value-0123456789";
const GH_SECRET = "fake-e2e-github-token-9876543210";
const SECRETS_KEY = new Uint8Array(32).fill(5);
const HAS_FFMPEG = Bun.spawnSync(["sh", "-c", "command -v ffmpeg && command -v ffprobe"]).exitCode === 0;
let videoStep = false;

// ---- fake Anthropic: answers by what the newest user message holds -----------------------------------
const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
let nextId = 0;
function stream(blocks: Array<{ type: "text"; text: string } | { type: "tool_use"; name: string; input: unknown }>): Response {
  const id = ++nextId;
  let out = ev("message_start", { message: { id: `msg_${id}`, type: "message", role: "assistant", model: "claude-fake", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 1 } } });
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      out += ev("content_block_start", { index, content_block: { type: "text", text: "" } });
      out += ev("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
    } else {
      out += ev("content_block_start", { index, content_block: { type: "tool_use", id: `toolu_${id}`, name: b.name, input: {} } });
      out += ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    out += ev("content_block_stop", { index });
  });
  const tool = blocks.some((b) => b.type === "tool_use");
  out += ev("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } });
  out += ev("message_stop", {});
  return new Response(out, { headers: { "content-type": "text/event-stream" } });
}
const say = (text: string) => stream([{ type: "text", text }]);
const use = (name: string, input: unknown) => stream([{ type: "tool_use", name: `mcp__shuvi__${name}`, input }]);
const seen: string[] = [];
/** Every request body the model was sent, whole: the transcript as the model sees it. */
const bodies: string[] = [];
let toolsOffered: string[] = [];

/** [what the newest user message contains, what the model does]: the first match wins (matched as JSON). */
const SCRIPT: Array<[RegExp, (text: string) => Response]> = [
  [/run something on your computer/, () => use("exec", { command: "echo computer-says-$((6*7)); whoami >/dev/null" })],
  [/exit 0 · [^"]*computer-says-42/, () => say("The computer says 42.")],
  [/start the long job/, () => use("exec", { command: "sleep 2; echo bg-finished", background: true, expect_seconds: 10 })],
  [/sheet the test video/, () => use("video_sheet", { path: "~/inbox/test.mp4", every: 2 })],
  [/Started job \d+ in the background/, () => say(videoStep ? "Sheeting it in the background." : "Started it in the background.")],
  [/· ⚙ job \d+ · computer · done\] asked: \\"video_sheet [^\n]*20 frame\(s\), every 2s, on 2 sheet\(s\) of 4x4:/, (t) => say(`I saw ${t.split('"type":"image"').length - 1} sheet(s).`)],
  [/· ⚙ job \d+ · computer · done\] asked: [^\n]*\\n  exit 0 · ran [^"]*bg-finished/, () => say("The job finished: bg-finished.")],
  [/deploy with modal/, () => use("exec", { command: 'echo "token=[$MODAL_TOKEN]"' })],
  [/token=\[\[REDACTED:modal\]\]/, () => say("Deployed; the token stayed hidden.")],
  [/token=\[\]/, () => use("request_secret", { profile: "modal", ttl: "1d", reason: "to deploy the app" })],
  [/Asked the owner for \\"modal\\"/, () => say("I asked the owner for the modal secret.")],
  [/· ⚙ approval\] Approval #\d+ \(secret\)[^\n]*This chat, 1 day/, () => use("exec", { command: 'echo "token=[$MODAL_TOKEN]"' })],
  [/push with github/, () => use("exec", { command: 'echo "gh=[$GH_TOKEN]"' })],
  [/gh=\[\[REDACTED:github\]\]/, () => say("Pushed with github.")],
  [/gh=\[\]/, () => say("There is no github token for this.")],
  [/remember the github org/, () => use("update_secret_note", { profile: "github", details: "Org: example-org (id 1234)." })],
  [/keep the github token in the note/, () => use("update_secret_note", { profile: "github", details: `token ${GH_SECRET}` })],
  [/Saved the note of \\"github\\"/, () => say("Noted the github org.")],
  [/holds the value of the secret profile/, () => say("I cannot keep a secret value in a note.")],
  [/my new address is/, () => use("info_write", { name: "home-address", summary: "Home address", fields: [{ name: "POSTCODE", about: "postcode", value: "200-0002" }, { name: "CITY", about: "city", value: "Sample City" }, { name: "STREET", about: "street", value: "4-5-6 Example Avenue" }] })],
  [/Created \\"home-address\\"/, () => say("Kept your new address.")],
  [/fill the form with my address/, () => use("info_read", { name: "home-address" })],
  [/what is the owner's address/, () => use("info_read", { name: "home-address" })],
  [/- STREET \(street\): 4-5-6 Example Avenue/, () => say("The form gets 4-5-6 Example Avenue, Sample City 200-0002.")],
  [/Refused: `info_read` acts for the owner, and only the owner may ask for it/, () => say("Only the owner can have me read his personal info.")],
  [/declare a package/, () => use("exec", { command: "printf 'apt: [example-tool]\\nsetup: echo configured > configured.txt\\n' > ~/.computer.yaml && echo declared-ok" })],
  [/exit 0 · [^"]*declared-ok/, () => use("apply_computer_config", {})],
  [/Applied ~\/\.computer\.yaml in \d+s: apt: example-tool; the setup script/, () => say("The computer config is applied.")],
  [/run something after the restart/, () => use("exec", { command: "echo after-restart" })],
  [/please sort the data/, () => use("exec", { command: "echo sorted-for-$((40+2))" })],
  [/exit 0 · [^"]*sorted-for-42/, () => say("Sorted it for the group.")],
  [/Refused: `exec` acts for the owner, and here only the owner or one of this group's operators may ask for it/, () => say("Only the owner or an operator can have me run that.")],
  [/exit 0 · [^"]*after-restart/, (t) => say(t.includes(".computer.yaml") ? "It applied the config again." : "Back after the restart.")],
];

const anthropic = Bun.serve({
  port: 0,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const raw = req.method === "POST" ? await req.text() : "";
    const body = (raw ? JSON.parse(raw) : {}) as { messages?: Array<{ role: string; content: unknown }>; tools?: Array<{ name: string }> };
    if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 10 });
    if (!url.pathname.endsWith("/v1/messages")) return Response.json({});
    bodies.push(raw);
    if (!body.tools?.some((t) => t.name === "mcp__shuvi__say")) return say("ok"); // the CLI's side requests
    toolsOffered = body.tools.map((t) => t.name);
    const last = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
    const text = JSON.stringify(last?.content ?? "");
    seen.push(text);
    for (const [re, act] of SCRIPT) if (re.test(text)) return act(text);
    return say(`(no script for: ${text.slice(0, 160)})`);
  },
});

// ---- the world ---------------------------------------------------------------------------------------
const tg = new FakeTelegram();
const control = new FakeTelegram();
const hangar = new FakeHangar({ realMedia: HAS_FFMPEG });
const dataDir = mkdtempSync(join(tmpdir(), "shuvi-e2e-computer-"));
mkdirSync(join(dataDir, "home"), { recursive: true });
const GROUP = { id: -100555, title: "Data friends" };
const alice: Person = { id: 2001, first: "Alice", username: "alice" };
const bob: Person = { id: 2002, first: "Bob" };
// The owner's DM keeps its default (everything); the group delegates its computer to Alice.
writeFileSync(
  join(dataDir, "home", "policy.yaml"),
  `owner: ${OWNER}\nchats:\n  "${GROUP.id}":\n    title: ${GROUP.title}\n    tools:\n      computer: {}\n    operators: [${alice.id}]\n    delegate: [computer]\n`,
);
const secretsFile = join(mkdtempSync(join(tmpdir(), "shuvi-e2e-secrets-")), "shuvi.secrets.yaml");
writeFileSync(secretsFile, `modal:\n  MODAL_TOKEN: ${SECRET}\n`);
chmodSync(secretsFile, 0o600);
const env = {
  ...process.env,
  SHUVI_DATA_DIR: dataDir,
  SHUVI_BOT_TOKEN: "TOKEN",
  SHUVI_OWNER_ID: String(OWNER),
  SHUVI_TELEGRAM_API_ROOT: tg.apiRoot,
  SHUVI_CONTROL_BOT_TOKEN: "CONTROL",
  SHUVI_CONTROL_API_ROOT: control.apiRoot,
  SHUVI_MODEL: "claude-sonnet-4-5",
  SHUVI_TZ: "Asia/Taipei",
  SHUVI_WEB: "off",
  ...hangar.env(),
  SHUVI_SECRETS_FILE: secretsFile,
  SHUVI_SECRETS_KEY: Buffer.from(SECRETS_KEY).toString("base64"),
  SHUVI_COMPUTER_POLL_SEC: "1",
  SHUVI_COMPUTER_IDLE_MINUTES: "0.1",
  ANTHROPIC_BASE_URL: `http://localhost:${anthropic.port}`,
  ANTHROPIC_API_KEY: "sk-ant-fake",
};
let serverOut = "";
const server = Bun.spawn([process.execPath, "src/server/main.ts"], { env, stdout: "pipe", stderr: "pipe", detached: true });
for (const [from, to] of [
  [server.stdout, process.stdout],
  [server.stderr, process.stderr],
] as const) {
  void (async () => {
    const dec = new TextDecoder();
    for await (const chunk of from) {
      const s = dec.decode(chunk);
      serverOut += s;
      to.write(s);
    }
  })();
}
function cleanup() {
  try {
    process.kill(-server.pid, "SIGKILL");
  } catch {}
  tg.stop();
  control.stop();
  hangar.stop();
  anthropic.stop(true);
}
const texts = () => tg.sent().map((b) => String(b.text));
const count = (t: string) => texts().filter((x) => x === t).length;
async function replied(text: string, what: string) {
  await until(what, () => count(text) >= 1);
  await Bun.sleep(800); // room for a duplicate to show up
  check(count(text) === 1, `${what}: "${text}" reached Telegram exactly once`);
}
const db = openDb(join(dataDir, "shuvi.db"));
const turnsIdle = () => (db.$client.query("select count(*) as n from turns where status = 'running'").get() as { n: number }).n === 0;
await until("the server to start", () => serverOut.includes("shuvi server:"), 20_000);

// ---- 1. a synchronous exec ---------------------------------------------------------------------------
tg.updates.push(dmUpdate(1, "run something on your computer"));
await replied("The computer says 42.", "a turn ran a synchronous exec and answered from its output");
check(toolsOffered.includes("mcp__shuvi__exec") && toolsOffered.includes("mcp__shuvi__read_job") && toolsOffered.includes("mcp__shuvi__request_secret"), "the computer's tools are offered");
check(hangar.disks.has("home-1001") && hangar.containers.has("shuvi-1001"), "the chat's disk and container were created on the first exec");
check(hangar.applies()[0] === "shuvi-1001 RUNNING 2/2Gi", `the container was started (${hangar.applies().join(", ")})`);
await until("the turn to close", turnsIdle);

// ---- 2. a background exec ----------------------------------------------------------------------------
tg.updates.push(dmUpdate(2, "start the long job"));
await replied("Started it in the background.", "a background exec returned a job id and the turn ended");
await replied("The job finished: bg-finished.", "the job's end came back to the chat as a job_done and started a turn");
const job = db.$client.query("select state, report, result from jobs where kind = 'computer'").get() as { state: string; report: string; result: string };
check(job.state === "done" && job.report === "poll" && job.result.startsWith("exit 0 · ran"), `the job is done, with its usage line (${JSON.stringify(job.result.split("\n")[0])})`);
await until("the turn to close", turnsIdle);

// ---- 3. a secret-gated exec --------------------------------------------------------------------------
tg.updates.push(dmUpdate(3, "deploy with modal"));
await replied("I asked the owner for the modal secret.", "without a grant the variable was empty, and the assistant asked for the secret");
const controlTexts = () => control.sent().map((b) => String(b.text));
await until("the secret card", () => controlTexts().some((t) => t.includes('Secret "modal"')));
const card = control.calls.find((c) => c.method === "sendMessage" && String(c.body.text).includes('Secret "modal"'))!.body;
check(String(card.text).includes("Variables: MODAL_TOKEN") && !String(card.text).includes(SECRET), "the card names the variables, never the values");
const keyboard = (card.reply_markup as { inline_keyboard: { callback_data: string; text: string }[][] }).inline_keyboard;
check(
  keyboard.map((r) => r[0]!.text).join("|") === "This chat, 4 hours|This chat, 1 day|This chat, 3 days|Every chat, 4 hours|Every chat, 1 day|Every chat, 3 days|Every chat, until revoked|Deny",
  "the card offers this chat or every chat, for 4h / 1d / 3d (every chat: or until revoked), and deny",
);
control.updates.push({ update_id: 1, callback_query: { id: "cq1", from: { id: OWNER, is_bot: false, first_name: "Owner" }, chat_instance: "x", data: keyboard[1]![0]!.callback_data } } as unknown as Update);
await replied("Deployed; the token stayed hidden.", "the owner's grant woke the chat, and its exec saw the value only as [REDACTED:modal]");
check(hangar.execs.some((e) => e.env.MODAL_TOKEN === SECRET), "the value went into that exec's environment");
await until("the revoke card", () => controlTexts().some((t) => t.includes("is granted to the computer")));
check(true, "a revoke card was put in the control bot");
const dump = ["chat_events", "jobs", "approvals", "secret_grants", "control_messages", "computers", "turns"].map((t) => JSON.stringify(db.$client.query(`select * from ${t}`).all())).join("\n");
check(!dump.includes(SECRET), "the value is nowhere in the store");
check(bodies.length > 0 && !bodies.some((b) => b.includes(SECRET)), "the value is in nothing the model was sent");
check(!JSON.stringify([...hangar.containers.values()]).includes(SECRET), "nor in the container's spec");
await until("the turn to close", turnsIdle);

// ---- 4. ~/.computer.yaml -----------------------------------------------------------------------------
const rootRuns = () => hangar.execs.filter((e) => e.user === "0" && e.command.join(" ").includes("flock")).length;
tg.updates.push(dmUpdate(4, "declare a package"));
await replied("The computer config is applied.", "an exec wrote ~/.computer.yaml and apply_computer_config applied it at once");
check(toolsOffered.includes("mcp__shuvi__apply_computer_config") && !toolsOffered.includes("mcp__shuvi__transcribe"), "apply_computer_config is offered, transcribe is not");
check(rootRuns() === 1, `it was applied once, as root (${rootRuns()})`);
check(existsSync(join(hangar.rootfs("shuvi-1001"), "installed", "example-tool")), "its apt package was installed on the root disk");
check(existsSync(join(hangar.home("shuvi-1001"), ".cache/computer/apt/example-tool.deb")), "through the apt cache in home");
check(readFileSync(join(hangar.home("shuvi-1001"), "configured.txt"), "utf8") === "configured\n", "its setup script ran");
check(existsSync(join(hangar.rootfs("shuvi-1001"), "var/lib/shuvi/computer.applied")), "its hash was recorded on the root disk");
await until("the turn to close", turnsIdle);

// ---- 5. idle stop ------------------------------------------------------------------------------------
await until("the idle computer to be stopped", () => hangar.applies().at(-1) === "shuvi-1001 STOPPED 2/2Gi", 30_000);
check(!hangar.calls.some((c) => c.method.startsWith("Delete")), "the idle computer was stopped, never deleted");

// ---- 6. the next start: the file's hash matches, nothing is applied -----------------------------------
tg.updates.push(dmUpdate(5, "run something after the restart"));
await replied("Back after the restart.", "the next command started the computer again");
check(hangar.applies().at(-1) === "shuvi-1001 RUNNING 2/2Gi", "it was started again");
check(rootRuns() === 1, "~/.computer.yaml, unchanged on the same root disk, was not applied again");
await until("the turn to close", turnsIdle);

// ---- 7. video_sheet, with the real ffmpeg ------------------------------------------------------------
if (!HAS_FFMPEG) {
  log("SKIP 7. video_sheet: no ffmpeg/ffprobe on this machine (install ffmpeg to run it)");
} else {
  const inbox = join(hangar.home("shuvi-1001"), "inbox");
  mkdirSync(inbox, { recursive: true });
  const gen = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=d=40:s=640x360:r=25", "-pix_fmt", "yuv420p", join(inbox, "test.mp4")], { stderr: "pipe" });
  check(gen.exitCode === 0, `a 40 s test video was generated${gen.exitCode ? `: ${gen.stderr.toString()}` : ""}`);
  videoStep = true;
  tg.updates.push(dmUpdate(6, "sheet the test video"));
  await replied("Sheeting it in the background.", "video_sheet started a background job and the turn ended");
  await replied("I saw 2 sheet(s).", "the job's end came back with its index, and the turn got both sheets as images");
  const sheetJob = db.$client.query("select state, title, result from jobs where kind = 'computer' order by id desc").get() as { state: string; title: string; result: string };
  check(sheetJob.state === "done" && sheetJob.title === "video_sheet ~/inbox/test.mp4 (every 2s)", `the sheets job is done (${sheetJob.state}, ${sheetJob.title})`);
  check(
    sheetJob.result.includes("video: test.mp4 · 00:40 (40.0s) · 640x360") &&
      sheetJob.result.includes("sheet-01.jpg: 00:00 00:02 00:04 00:06 00:08 00:10 00:12 00:14 00:16 00:18 00:20 00:22 00:24 00:26 00:28 00:30") &&
      sheetJob.result.includes("sheet-02.jpg: 00:32 00:34 00:36 00:38"),
    "its result is the index: duration, resolution, each sheet's times",
  );
  await until("the turn to close", turnsIdle);
}

// ---- 8. a group's operator ---------------------------------------------------------------------------
const execsBefore = hangar.execs.length;
tg.updates.push(groupUpdate(20, GROUP, alice, "@shuvi_test_bot please sort the data"));
await replied("Sorted it for the group.", "8. an operator's exec ran without the owner");
const groupContainers = [...hangar.containers.keys()].filter((k) => k !== "shuvi-1001");
check(groupContainers.length === 1, `8. on the group's own computer (${[...hangar.containers.keys()].join(", ")})`);
check(hangar.execs.slice(execsBefore).some((e) => e.command.join(" ").includes("sorted-for-")), "8. the command reached Hangar");
await until("the turn to close", turnsIdle);
const execsAfterAlice = hangar.execs.filter((e) => e.command.join(" ").includes("sorted-for-")).length;
tg.updates.push(groupUpdate(21, GROUP, bob, "@shuvi_test_bot please sort the data"));
await replied("Only the owner or an operator can have me run that.", "8. someone who is not an operator is refused");
check(hangar.execs.filter((e) => e.command.join(" ").includes("sorted-for-")).length === execsAfterAlice, "8. and nothing ran for them");
await until("the turn to close", turnsIdle);

// ---- 9. a profile kept in the store, granted to every chat for the owner ----------------------------------
// As the console's Secrets page does it: sealed under the server's key, a note, an owner grant until revoked.
const src = { file: secretsFile, key: SECRETS_KEY };
check("created" in putProfile(db, src, "github", { GH_TOKEN: GH_SECRET }), "9. a profile was kept in the store");
check("note" in setNote(db, src, "github", { summary: "GitHub token for example-org" }, "console"), "9. with a note");
consoleGrant(db, "github", "forever");
const ownerPerson: Person = { id: OWNER, first: "Owner" };
let before = hangar.execs.length;
tg.updates.push(groupUpdate(30, GROUP, ownerPerson, "@shuvi_test_bot push with github"));
await replied("Pushed with github.", "9. the owner's turn in the group got the owner grant, seeing it only as [REDACTED:github]");
check(hangar.execs.slice(before).some((e) => e.env.GH_TOKEN === GH_SECRET), "9. the value went into that exec's environment");
check(bodies.some((b) => b.includes("github: GitHub token for example-org [granted for the owner in every chat]")), "9. the prompt names the profile with its summary, granted");
await until("the turn to close", turnsIdle);
before = hangar.execs.length;
tg.updates.push(groupUpdate(31, GROUP, alice, "@shuvi_test_bot push with github"));
await replied("There is no github token for this.", "9. the operator's turn in the same group did not get it");
check(!hangar.execs.slice(before).some((e) => e.env.GH_TOKEN), "9. no GH_TOKEN in the operator's exec");
await until("the turn to close", turnsIdle);
tg.updates.push(dmUpdate(32, "remember the github org"));
await replied("Noted the github org.", "9. update_secret_note kept what she learned");
check(getNote(db, "github")?.details === "Org: example-org (id 1234)." && getNote(db, "github")?.summary === "GitHub token for example-org", "9. the details were replaced, the summary kept");
await until("the turn to close", turnsIdle);
const dump9 = ["chat_events", "secret_profiles", "secret_grants", "secret_notes", "turns"].map((t) => JSON.stringify(db.$client.query(`select * from ${t}`).all())).join("\n");
check(!dump9.includes(GH_SECRET), "9. the value is nowhere in the store in the clear");
check(!bodies.some((b) => b.includes(GH_SECRET)), "9. nor in anything the model was sent");
// A model that somehow had the value (this fake one is scripted to) cannot keep it in a note.
tg.updates.push(dmUpdate(33, "keep the github token in the note"));
await replied("I cannot keep a secret value in a note.", "9. a note holding the value was refused");
check(!JSON.stringify(db.$client.query("select * from secret_notes").all()).includes(GH_SECRET), "9. the value is in no note");
await until("the turn to close", turnsIdle);

// ---- 10. personal info ----------------------------------------------------------------------------------
tg.updates.push(dmUpdate(40, "my new address is 4-5-6 Example Avenue, Sample City 200-0002"));
await replied("Kept your new address.", "10. info_write kept the address the owner said");
const kept = getInfo(db, src, "home-address");
check(kept?.values?.STREET === "4-5-6 Example Avenue" && kept.values.POSTCODE === "200-0002", "10. sealed in the store as personal info");
check(infoHistory(db, src, "home-address")[0]?.by.startsWith("assistant in ") === true, "10. its version says she wrote it");
check(!JSON.stringify(db.$client.query("select * from secret_profiles").all()).includes("Example Avenue"), "10. not in the store in the clear");
await until("the turn to close", turnsIdle);
tg.updates.push(groupUpdate(41, GROUP, ownerPerson, "@shuvi_test_bot fill the form with my address"));
await replied("The form gets 4-5-6 Example Avenue, Sample City 200-0002.", "10. the owner's turn in the group read it with info_read");
check(bodies.some((b) => b.includes("## Personal info") && b.includes("home-address: Home address")), "10. the group's prompt names it with its summary");
await until("the turn to close", turnsIdle);
tg.updates.push(groupUpdate(42, GROUP, alice, "@shuvi_test_bot what is the owner's address"));
await replied("Only the owner can have me read his personal info.", "10. an operator's turn is refused info_read");
check(seen.some((t) => /Refused: `info_read` acts for the owner, and only the owner may ask for it/.test(t)), "10. the call was refused at the boundary, not answered");
await until("the turn to close", turnsIdle);

log("PASS");
cleanup();
process.exit(0);
