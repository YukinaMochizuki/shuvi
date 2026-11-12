import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promptParts, textOf, type Appended, type Prompt, type ToolBoundary, type ToolCall, type ToolContent, type ToolResult } from "agent-runtime";
import type { Db } from "../store/db.ts";
import { imageFileOf } from "../store/media.ts";
import type { TranscriptPart } from "../store/schema.ts";
import { addStep, completeStep, hashText, markRecordingStarted, savePrompt, saveTranscript, setTranscriptModel, type StepInsert } from "../store/transcripts.ts";
import { SECTION_JOIN, type PromptSection } from "./prompt.ts";

/**
 * The TURN TRANSCRIPT: each turn recorded as the model saw it, for the console (src/console/).
 * The runner child records it while the turn runs; the tables are in store/schema.ts.
 *
 * What is recorded, and from where:
 *   - the SYSTEM PROMPT the turn sent (agent/prompt.ts builds it, and the selected backend receives it),
 *     by hash, with where each section begins;
 *   - the INPUT, the prompt's parts in order;
 *   - the TIMELINE, numbered in the order the turn produced it:
 *       thinking  from `onToken(text, true)`: one row per stretch, closed by text, a tool call or the end;
 *       text      from `onToken(text, false)`: one row per text block, which is one message (agent/turn.ts).
 *                 Its number is taken when its first token arrives, and the row is written when turn.ts
 *                 queues the message (`textFlushed`), with whether it was sent and the outbound seq;
 *       tool      from the tool boundary's record hooks: a `running` row at the start, completed in place
 *                 by call id at the end (result, error, or the throw); a refusal is a row of its own;
 *       append    from the boundary's `append`: which events (from_seq, to_seq] were appended, after which
 *                 call, and the text and images the model was given;
 *       note      framework actions and backend notices (a restart, changed settings, compaction failures);
 *       compaction  the driver compacted the conversation (`onCompaction`): its trigger, tokens before/after.
 *   - the MODEL; usage and the outcome are on `turns` (store/turns.ts `finishTurn`).
 *
 * Every text is passed through `redact` (the computer's secret redaction, computer/secrets.ts) before it
 * is written. An image is never stored as bytes: a part read from a file under the data dir is stored as
 * that path (store/media.ts `imageFromFile`); any other (a contact sheet, a frame from a chat's computer) is
 * written once to `media/transcript/<sha256>.<ext>`, and that path is stored.
 *
 * BEST EFFORT: every method catches its own failure and logs it. A turn never fails, or waits, because its
 * transcript could not be written.
 */

/** Where transcript-only images are kept, under the data dir. */
export const TRANSCRIPT_MEDIA = "media/transcript";
/** The longest text stored for one result or argument list; the rest is cut with a note. */
export const MAX_STORED = 64 * 1024;

export interface RecorderOptions {
  /** The data dir: image references are relative to it. */
  dataDir: string;
  /** The secret redaction applied to every text before it is stored. Default: none. */
  redact?: (s: string) => string;
  /** Notes to open the timeline with (the secrets file could not be read, …). */
  notes?: readonly string[];
}

/**
 * `value` with every string in it (keys included) passed through `redact`, at any depth. Two keys that redact
 * to the same string are both kept: the later one gets a suffix (`[REDACTED:x] (2)`), so no argument is lost.
 */
export function redactDeep(value: unknown, redact: (s: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      let key = redact(k);
      for (let i = 2; Object.hasOwn(out, key); i++) key = `${redact(k)} (${i})`;
      out[key] = redactDeep(v, redact);
    }
    return out;
  }
  return value;
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

function cap(s: string): string {
  return s.length > MAX_STORED ? `${s.slice(0, MAX_STORED)}\n… [${s.length - MAX_STORED} more characters not stored]` : s;
}

export class TurnRecorder {
  private n = 0;
  private thinking: { n: number; text: string; at: string } | null = null;
  private text: { n: number; text: string; at: string } | null = null;
  private failures = 0;
  private readonly redact: (s: string) => string;

  constructor(
    private readonly db: Db,
    readonly turnId: number,
    private readonly opts: RecorderOptions,
  ) {
    this.redact = opts.redact ?? ((s) => s);
    for (const n of opts.notes ?? []) this.note(n);
  }

  /** `s` as it would be stored: redacted. Never throws (a failing redaction withholds the text). */
  redactText(s: string): string {
    try {
      return this.redact(s);
    } catch {
      return "[withheld: the text could not be redacted]";
    }
  }

  /** Run `fn`, and log rather than throw: recording never breaks the turn. */
  private safe(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      if (this.failures++ < 5) console.error(`transcript of turn ${this.turnId}: could not record ${what}:`, e instanceof Error ? e.message : e);
    }
  }

  private step(n: number, s: StepInsert): void {
    addStep(this.db, this.turnId, n, s);
  }

  /** A reference for an image part: its file under the data dir, or a transcript-only copy. */
  imageRef(part: { data: string; mimeType: string }): { ref: string; mimeType: string } {
    const known = imageFileOf(part);
    if (known) return { ref: known, mimeType: part.mimeType };
    const bytes = Buffer.from(part.data, "base64");
    const rel = `${TRANSCRIPT_MEDIA}/${createHash("sha256").update(bytes).digest("hex")}.${EXT[part.mimeType] ?? "bin"}`;
    const abs = join(this.opts.dataDir, rel);
    if (existsSync(abs)) {
      const now = new Date();
      utimesSync(abs, now, now); // in use again: pruning goes by age
    } else {
      mkdirSync(join(this.opts.dataDir, TRANSCRIPT_MEDIA), { recursive: true });
      writeFileSync(abs, bytes);
    }
    return { ref: rel, mimeType: part.mimeType };
  }

  private parts(content: readonly ToolContent[]): TranscriptPart[] {
    return content.map((p) => (p.type === "text" ? { type: "text" as const, text: this.redact(p.text) } : { type: "image" as const, ...this.imageRef(p) }));
  }

  private images(content: readonly ToolContent[] | undefined): { ref: string; mimeType: string }[] | null {
    const imgs = (content ?? []).filter((p): p is Extract<ToolContent, { type: "image" }> => p.type === "image").map((p) => this.imageRef(p));
    return imgs.length ? imgs : null;
  }

  private args(args: unknown): string | null {
    if (args === undefined || args === null) return null;
    // Each string is redacted BEFORE serialising: a secret holding `"` or `\` is escaped by JSON.stringify
    // and would no longer match its raw value afterwards.
    return cap(JSON.stringify(redactDeep(args, this.redact)));
  }

  private system: { hash: string; text: string; bounds: { label: string; start: number; end: number }[] } | null = null;

  /** The system prompt, by section. Kept until `input`, which stores both in one transaction. */
  prompt(sections: readonly PromptSection[]): void {
    this.safe("the system prompt", () => {
      const bounds: { label: string; start: number; end: number }[] = [];
      let at = 0;
      let text = "";
      sections.forEach((s, i) => {
        if (i) {
          text += SECTION_JOIN;
          at += SECTION_JOIN.length;
        }
        const t = this.redact(s.text);
        bounds.push({ label: s.label, start: at, end: at + t.length });
        text += t;
        at += t.length;
      });
      this.system = { hash: hashText(text), text, bounds };
    });
  }

  /**
   * What the turn opened with (again, after a lost conversation: it replaces the first), with the system
   * prompt, in one transaction: a transcript never points at a prompt text that is not there.
   */
  input(prompt: Prompt, resumed: boolean): void {
    this.safe("the input", () => {
      const input = this.parts(promptParts(prompt));
      const sys = this.system;
      this.db.transaction((tx) => {
        const t = tx as unknown as Db;
        if (sys) savePrompt(t, sys.text, sys.bounds);
        saveTranscript(t, this.turnId, { promptHash: sys?.hash ?? null, input, resumed });
        markRecordingStarted(t, this.turnId);
      });
    });
  }

  /** A token from the driver (after turn.ts has flushed any text block it ends). */
  token(text: string, thinking: boolean): void {
    this.safe("a token", () => {
      const at = new Date().toISOString();
      if (thinking) {
        this.thinking ??= { n: this.n++, text: "", at };
        this.thinking.text += text;
      } else {
        this.closeThinking();
        this.text ??= { n: this.n++, text: "", at };
        this.text.text += text;
      }
    });
  }

  private closeThinking(): void {
    const t = this.thinking;
    if (!t) return;
    this.thinking = null;
    if (t.text.trim()) this.step(t.n, { kind: "thinking", text: this.redact(t.text), at: t.at, endedAt: new Date().toISOString() });
  }

  /** A tool call is about to run (`onTool`): the thinking before it is over. */
  toolAnnounced(): void {
    this.safe("thinking", () => this.closeThinking());
  }

  /** turn.ts queued the open text block as message `seq` (null: nothing was queued, e.g. after `pass`). */
  textFlushed(seq: number | null): void {
    this.safe("a text block", () => {
      const t = this.text;
      if (!t) return;
      this.text = null;
      if (!t.text.trim()) return;
      this.step(t.n, { kind: "text", text: this.redact(t.text), sent: seq !== null, outboundSeq: seq, at: t.at, endedAt: new Date().toISOString() });
    });
  }

  toolStart(call: ToolCall): void {
    this.safe(`the start of ${call.name}`, () => {
      this.closeThinking();
      this.step(this.n++, { kind: "tool", name: call.name, args: this.args(call.args), status: "running", callId: call.callId ?? null });
    });
  }

  toolEnd(call: ToolCall, res: ToolResult): void {
    this.safe(`the result of ${call.name}`, () => {
      const done = { result: cap(this.redact(textOf(res))), images: this.images(res.content), status: res.isError ? ("error" as const) : ("ok" as const), endedAt: new Date().toISOString() };
      if (!call.callId || !completeStep(this.db, this.turnId, call.callId, done)) this.step(this.n++, { kind: "tool", name: call.name, args: this.args(call.args), callId: call.callId ?? null, ...done });
    });
  }

  toolThrew(call: ToolCall, e: unknown): void {
    this.safe(`the failure of ${call.name}`, () => {
      const done = { status: "threw" as const, error: cap(this.redact(e instanceof Error ? e.message : String(e))), endedAt: new Date().toISOString() };
      if (!call.callId || !completeStep(this.db, this.turnId, call.callId, done)) this.step(this.n++, { kind: "tool", name: call.name, args: this.args(call.args), callId: call.callId ?? null, ...done });
    });
  }

  toolRefused(call: ToolCall, why: string): void {
    this.safe(`the refusal of ${call.name}`, () => {
      this.closeThinking();
      const at = new Date().toISOString();
      this.step(this.n++, { kind: "tool", name: call.name, args: this.args(call.args), status: "refused", error: this.redact(why), at, endedAt: at });
    });
  }

  /** Events (fromSeq, toSeq] were appended to call `callId`'s result, as `content`. */
  append(callId: string | undefined, fromSeq: number, toSeq: number, content: Appended): void {
    this.safe("an append", () => {
      const parts = typeof content === "string" ? [{ type: "text" as const, text: content }] : (content ?? []);
      const text = parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
      this.step(this.n++, { kind: "append", callId: callId ?? null, fromSeq, toSeq, text: this.redact(text), images: this.images(parts) });
    });
  }

  /** The driver compacted the conversation: from here on the model sees a summary of what came before. */
  compaction(e: { trigger: "auto" | "manual"; tokensBefore: number; tokensAfter?: number; summarized?: boolean }): void {
    this.safe("a compaction", () => {
      this.closeThinking();
      const at = new Date().toISOString();
      this.step(this.n++, {
        kind: "compaction",
        name: e.trigger,
        tokensBefore: e.tokensBefore || null,
        tokensAfter: e.tokensAfter ?? null,
        ...(e.summarized !== undefined ? { text: e.summarized ? "summarized" : "pruned" } : {}),
        at,
        endedAt: at,
      });
    });
  }

  note(text: string): void {
    this.safe("a note", () => {
      this.closeThinking();
      this.step(this.n++, { kind: "note", text });
    });
  }

  /** Forget what is open without writing it (a conversation started over: its half-written text is gone). */
  discardOpen(): void {
    this.thinking = null;
    this.text = null;
  }

  /** The turn is over: write what is still open (a text block nobody queued was not sent). */
  end(model?: string): void {
    this.safe("the end", () => {
      this.closeThinking();
      this.textFlushed(null);
      if (model) setTranscriptModel(this.db, this.turnId, model);
    });
  }
}

/**
 * The turn's boundary (agent/turn.ts `turnBoundary`) with the transcript's record hooks added, and its
 * `append` recorded: which events it appended and after which call. `shown()` is the turn's `to_seq`, read
 * before and after; `firstAfter(seq)` is the first event past `seq` the turn takes in (its own outbound rows,
 * which sit between, were not appended). The boundary's own behaviour is unchanged.
 */
export function recordingBoundary(inner: ToolBoundary, rec: TurnRecorder, shown: () => number, firstAfter: (seq: number) => number | undefined): ToolBoundary {
  return {
    ...inner,
    recordRefusal: (call, text) => rec.toolRefused(call, text),
    recordStart: (call) => rec.toolStart(call),
    recordEnd: (call, res: ToolResult) => rec.toolEnd(call, res),
    recordThrow: (call, e) => rec.toolThrew(call, e),
    async append(call, res) {
      const from = shown();
      const out = inner.append ? await inner.append(call, res) : null;
      if (out && (typeof out === "string" || out.length)) {
        const to = shown();
        let first = from + 1;
        try {
          first = firstAfter(from) ?? first;
        } catch {
          // best effort: the range then starts right after what was shown before
        }
        rec.append(call.callId, first - 1, to, out);
      }
      return out;
    },
  };
}

/** Remove transcript-only images not used since `beforeMs` (they are re-touched whenever used again). */
export function pruneTranscriptMedia(dataDir: string, beforeMs: number): number {
  const dir = join(dataDir, TRANSCRIPT_MEDIA);
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    try {
      if (statSync(p).mtimeMs < beforeMs) {
        unlinkSync(p);
        n++;
      }
    } catch {
      // gone meanwhile
    }
  }
  return n;
}
