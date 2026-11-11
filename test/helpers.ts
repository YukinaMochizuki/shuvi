import { runAtBoundary, type AdapterRunOptions, type AdapterRunResult, type BackendAdapter, type Prompt, type ToolBoundary, type ToolDef, type ToolResult } from "agent-runtime";
import type { StickerSet, Update } from "grammy/types";
import { openDb, type Db } from "../src/store/db.ts";
import { ensureChat, recordInbound, type MessagePayload } from "../src/store/events.ts";

export const OWNER = 1001;

export function memDb(): Db {
  return openDb(":memory:", { migrate: true });
}

let nextUpdate = 1;
let nextMsg = 100;

/** Record an owner message in the owner's DM, as the poller would. Returns its seq. */
export function ownerSays(db: Db, text: string, extra: Partial<MessagePayload> = {}): number {
  const chat = ensureChat(db, { id: OWNER, kind: "private" });
  recordInbound(db, { chatId: chat.id, kind: "message", payload: { from: { id: OWNER, name: "Owner" }, text, ...extra }, tgUpdateId: nextUpdate++, tgMessageId: nextMsg++ });
  return lastSeq(db);
}

export function lastSeq(db: Db): number {
  return (db.$client.query("select max(seq) as s from chat_events").get() as { s: number }).s;
}

export function ownerChatId(db: Db): number {
  return ensureChat(db, { id: OWNER, kind: "private" }).id;
}

/** A Telegram update carrying a private message from `from`. */
export function dmUpdate(updateId: number, text: string, from = OWNER, extra: Record<string, unknown> = {}): Update {
  return {
    update_id: updateId,
    message: {
      message_id: 500 + updateId,
      date: 0,
      chat: { id: from, type: "private", first_name: "Owner" },
      from: { id: from, is_bot: false, first_name: "Owner" },
      text,
      ...extra,
    },
  } as unknown as Update;
}

export interface Person {
  id: number;
  first: string;
  username?: string;
  isBot?: boolean;
}

/**
 * A Telegram update carrying a message in a group (a supergroup, as Telegram has most of them). Each
 * `@name` in the text gets a `mention` entity, as Telegram adds one.
 */
export function groupUpdate(updateId: number, chat: { id: number; title: string }, from: Person, text: string, extra: Record<string, unknown> = {}): Update {
  const entities = [...text.matchAll(/@\w+/g)].map((m) => ({ type: "mention", offset: m.index!, length: m[0].length }));
  return {
    update_id: updateId,
    message: {
      message_id: 700 + updateId,
      date: 0,
      chat: { id: chat.id, type: "supergroup", title: chat.title },
      from: { id: from.id, is_bot: !!from.isBot, first_name: from.first, ...(from.username ? { username: from.username } : {}) },
      text,
      ...(entities.length ? { entities } : {}),
      ...extra,
    },
  } as unknown as Update;
}

// ---- a scripted driver ------------------------------------------------------------------------------

export type Step =
  | { token: string; thinking?: boolean }
  | { tool: string; args?: unknown }
  /** Run arbitrary code at this point (e.g. record a message that "arrives" mid-turn). */
  | { run: () => void }
  | { fail: string }
  /** Block until the turn's signal aborts, then throw like the SDK does. */
  | { waitForAbort: true };

/**
 * A BackendAdapter that plays a script through the same callbacks and the same tool boundary the Claude
 * driver uses, so a turn can be tested end to end without a model.
 */
export class ScriptedAdapter implements BackendAdapter {
  readonly id = "scripted";
  readonly calls: { method: "run" | "continueRun"; prompt: Prompt; systemPrompt?: string; backendSessionId?: string; tools: string[] }[] = [];
  readonly toolResults: { name: string; result: ToolResult }[] = [];
  constructor(
    private readonly boundary: ToolBoundary,
    private readonly script: Step[],
  ) {}

  run(input: Parameters<BackendAdapter["run"]>[0], opts: AdapterRunOptions): Promise<AdapterRunResult> {
    this.calls.push({ method: "run", prompt: input.prompt, ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}), tools: input.tools.flatMap((b) => b.tools.map((t) => t.name)) });
    return this.play(input.tools.flatMap((b) => b.tools as ToolDef[]), opts, "fake-session");
  }

  continueRun(input: Parameters<BackendAdapter["continueRun"]>[0], opts: AdapterRunOptions): Promise<AdapterRunResult> {
    this.calls.push({ method: "continueRun", prompt: input.prompt, ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}), backendSessionId: input.backendSessionId, tools: input.tools.flatMap((b) => b.tools.map((t) => t.name)) });
    return this.play(input.tools.flatMap((b) => b.tools as ToolDef[]), opts, input.backendSessionId);
  }

  private async play(tools: ToolDef[], opts: AdapterRunOptions, session: string): Promise<AdapterRunResult> {
    opts.onSessionId?.(session);
    let text = "";
    for (const step of this.script) {
      if ("token" in step) {
        opts.onToken?.(step.token, step.thinking);
        if (!step.thinking) text += step.token;
      } else if ("tool" in step) {
        opts.onTool?.(step.tool, step.args);
        text = "";
        const def = tools.find((t) => t.name === step.tool);
        if (!def) throw new Error(`no tool ${step.tool}`);
        const result = await runAtBoundary(this.boundary, { name: step.tool, recordedName: step.tool, args: step.args ?? {} }, () => def.handler(step.args ?? {}));
        this.toolResults.push({ name: step.tool, result });
      } else if ("run" in step) step.run();
      else if ("fail" in step) throw new Error(step.fail);
      else {
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) resolve();
          opts.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("aborted");
      }
    }
    return { text, backendSessionId: session, usage: { model: "fake", costUsd: 0.001, inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 0 } };
  }
}

// ---- a fake Bot API ---------------------------------------------------------------------------------

export interface FakeCall {
  method: string;
  body: Record<string, unknown>;
}

/**
 * A minimal Telegram Bot API over real HTTP, so grammY's own client (and its error types) is what the
 * code under test talks to. `fail` queues responses for the next calls of a method. `files` are what
 * `getFile` and the file endpoint (`/file/bot<token>/<path>`) serve, by file_id; `downloads` counts the
 * file endpoint's hits per file_id. `stickerSets` are what `getStickerSet` serves, by name.
 */
export class FakeTelegram {
  readonly calls: FakeCall[] = [];
  readonly updates: Update[] = [];
  readonly files = new Map<string, Uint8Array>();
  readonly downloads = new Map<string, number>();
  readonly stickerSets = new Map<string, StickerSet>();
  private failures = new Map<string, { code: number; description: string; retry_after?: number }[]>();
  private nextMessageId = 9000;
  private server: ReturnType<typeof Bun.serve>;

  constructor() {
    this.server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const file = url.pathname.match(/^\/file\/bot[^/]+\/files\/(.+)$/);
        if (file) {
          const id = decodeURIComponent(file[1]!);
          const bytes = this.files.get(id);
          this.downloads.set(id, (this.downloads.get(id) ?? 0) + 1);
          return bytes ? new Response(bytes) : new Response("not found", { status: 404 });
        }
        const method = url.pathname.split("/").at(-1)!;
        let body: Record<string, unknown>;
        if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
          // An upload (sendDocument, sendPhoto): fields as strings, a file as its name and size.
          body = {};
          for (const [k, v] of (await req.formData()).entries()) body[k] = typeof v === "string" ? v : { file: v.name, size: v.size, bytes: new Uint8Array(await v.arrayBuffer()) };
        } else {
          const text = await req.text();
          body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
        }
        this.calls.push({ method, body });
        const f = this.failures.get(method)?.shift();
        if (f) return Response.json({ ok: false, error_code: f.code, description: f.description, ...(f.retry_after ? { parameters: { retry_after: f.retry_after } } : {}) });
        switch (method) {
          case "getMe":
            return Response.json({ ok: true, result: { id: 1, is_bot: true, first_name: "shuvi", username: "shuvi_test_bot" } });
          case "getUpdates": {
            const offset = (body.offset as number | undefined) ?? 0;
            const pending = this.updates.filter((u) => u.update_id >= offset);
            // A long poll with nothing to return waits a little, as Telegram's does, so a poller loop
            // against this fake does not spin.
            if (!pending.length && body.timeout) await Bun.sleep(200);
            return Response.json({ ok: true, result: pending });
          }
          case "getFile": {
            const id = String(body.file_id);
            const bytes = this.files.get(id);
            if (!bytes) return Response.json({ ok: false, error_code: 400, description: "Bad Request: invalid file_id" });
            return Response.json({ ok: true, result: { file_id: id, file_unique_id: `u-${id}`, file_size: bytes.length, file_path: `files/${encodeURIComponent(id)}` } });
          }
          case "setMyCommands":
            return Response.json({ ok: true, result: true });
          case "sendMessage":
            return Response.json({ ok: true, result: { message_id: this.nextMessageId++, date: 0, chat: { id: body.chat_id, type: "private" }, text: body.text } });
          case "sendSticker":
            return Response.json({ ok: true, result: { message_id: this.nextMessageId++, date: 0, chat: { id: body.chat_id, type: "private" }, sticker: { file_id: body.sticker } } });
          case "getStickerSet": {
            const set = this.stickerSets.get(String(body.name));
            return set ? Response.json({ ok: true, result: set }) : Response.json({ ok: false, error_code: 400, description: "Bad Request: STICKERSET_INVALID" });
          }
          case "sendDocument":
          case "sendPhoto":
            return Response.json({ ok: true, result: { message_id: this.nextMessageId++, date: 0, chat: { id: Number(body.chat_id), type: "private" } } });
          default:
            return Response.json({ ok: true, result: true });
        }
      },
    });
  }

  get apiRoot(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  fail(method: string, ...responses: { code: number; description: string; retry_after?: number }[]): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), ...responses]);
  }

  sent(method = "sendMessage"): Record<string, unknown>[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.body);
  }

  stop(): void {
    this.server.stop(true);
  }
}

// ---- a server's log, for the e2e scripts -------------------------------------------------------------

/**
 * Pass a child's output through to ours line by line, and call `onLine` with each line: how an e2e script
 * learns what the server bound (the console on port 0 logs `console: listening on <host>:<port>`).
 */
export function tapLines(stream: ReadableStream<Uint8Array> | number | undefined | null, onLine: (line: string) => void): void {
  if (!stream || typeof stream === "number") return;
  void (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of stream) {
      process.stdout.write(chunk);
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
  })();
}

/** The port in a `console: listening on <host>:<port>` line, if it is one. */
export function consolePortIn(line: string): number | null {
  const m = /console: listening on .*:(\d+) /.exec(line);
  return m ? Number(m[1]) : null;
}
