import type { Db } from "../store/db.ts";
import { assetsVersion } from "./assets.ts";
import type { LivePart } from "./html.ts";
import { liveView, type LiveFrame, type LiveView, type LiveWant, type PageContext } from "./pages.ts";

/**
 * Live pages: a chat's log, a segment, a conversation, a turn and the chats list keep themselves current while
 * open, over Server-Sent Events from the console itself (`GET /live`; server.ts routes it, behind the same Host
 * check and sign-in as every page). docs/console.md "Live pages"; DESIGN.md "Live".
 *
 * ONE POLL FOR EVERY STREAM. The runner child writes as a turn goes (agent/transcript.ts: a step per thinking,
 * text, tool call; a tool call's row completed in place; her messages queued as `pending` outbound rows, then
 * sent by the server's sender), so the store is live and nothing in the runner is told about the console. While
 * any stream is open, the hub (`hubOf`, one per store) runs ONE `Watch.poll` every TICK_MS. The poll reads by the
 * existing cursors, each a primary key or a small set, so it costs the same however many streams are open, and
 * nothing at all once none is:
 *   - new rows: `chat_events.seq`, `turns.id`, `turn_steps.id`, `turn_transcripts.turn_id` past the last seen;
 *   - rows that change in place, followed by key while they may: the running turns (their status, range, end,
 *     usage, profile, wall-clock stop), their tool calls still `running`, the outbound rows still `pending`, and the
 *     recent messages whose picture or file is still being fetched (store/media.ts `updateMedia`,
 *     `updateAttachment` rewrite their payload in place);
 *   - deletes and undos (store/deletions.ts): the rows waiting in `deleted_events` and the turns in `deleted_turns`,
 *     counted per chat.
 * What it yields is which chats and turns changed (`Changes`).
 *
 * ONE DRAWING PER PAGE. Streams of the same page (its path and query) share one `PageFeed`: on a change that
 * touches it, the feed draws a frame once (pages.ts `liveView`, the page's own functions, so a live page and a
 * reloaded one are the same; a segment or a chat's log keeps each part between frames and draws again only what
 * changed) and every stream of it sends what its page lacks. The list is drawn at most every LIST_EVERY_MS.
 *
 * PARTS. A page is made of named parts (html.ts `LivePart`, `lb`: a wrapper with `data-k`, its name, and
 * `data-h`, a hash of what it holds): the detail's header (`head`), the list's count line (`count`), each chat's
 * group (`g<chat>`), and the trace's parts: a segment's, a conversation's or a turn page's turns (`t<turn>`), a chat
 * log's rows (`e<seq>` an event, `d<turn>` a turn's divider). A stream sends a part only when its hash differs from
 * the page's; console.js puts it in place, row by row (rows that did not change, and what the reader opened or
 * selected in them, stay as they are).
 *
 * THE CURSOR IS THE PAGE. On (re)connect the page says what it has (`have`: the name and hash of each part that
 * may still change, `data-live`, and of every trace part after the first of those; `last`: its trace's last part).
 * The first frame sends what differs, and every trace part from the first listed one on (or after `last`) that the
 * page lacks; a part before that is on the page as it was (it cannot change). After the first frame the stream
 * knows every part the page has, and sends any other as new. So a reconnect after any outage resumes with no gap
 * and nothing twice, without the server keeping anything of a closed stream.
 *
 * A DELETE (console.js hides the bubbles at once; store/deletions.ts moves the rows out) is not undone by the
 * stream: what it draws comes from `chat_events`, where the rows no longer are; console.js keeps a hidden bubble
 * in place for its undo, and an undo is a change the poll sees, so the chat's parts are drawn again. A DELETED TURN
 * leaves every page that shows it, in every tab: its part and its dividers are taken out (a divider otherwise stays,
 * as history), by the frame's `turnIds` (the chat's turns that exist); the page of the turn itself, or of a segment or
 * conversation named by it, is told to `swap` for the plain page of one that is not there, which is live while the
 * undo can bring it back, and is told to swap back on the undo (console.js loads it in place). A swap is never done
 * by itself on a page holding an undo or a selection: the page offers it.
 *
 * RESOURCES. At most MAX_STREAMS_PER_SESSION tabs per session (sign-in) are live: one more closes the oldest other
 * (told `bye`; console.js offers to resume, which closes the oldest in turn). A tab names itself (`tab`, kept for
 * the tab's life), so its next page's stream replaces its last one at once and a quick navigation never counts
 * twice. A stream ends when its page goes away (the request is aborted). A stream that falls behind (more than
 * MAX_QUEUED bytes not yet taken by the socket) is dropped; the page reconnects and resumes from what it has. A
 * comment line every HEARTBEAT_MS keeps a proxy (`tailscale serve`) from cutting an idle stream; Bun's idle timeout
 * is lifted for /live (server.ts). An idle page costs one heartbeat per HEARTBEAT_MS and its share of the poll.
 *
 * ASSETS. The page names its assets' version (`v`); a stream for a page from before a deploy answers `reload`
 * (its markup would meet an old stylesheet). `probe=1` answers 200 or 204 without a stream: console.js asks it after
 * the stream failed, to tell a page no longer live (204) or a sign-in that ended (401/403) from a passing outage.
 */

export const TICK_MS = 1000;
export const HEARTBEAT_MS = 15_000;
/**
 * Live tabs per sign-in. Below the 6 connections a browser opens to one host over HTTP/1.1 (the ssh tunnel's plain
 * http): a stream holds one for as long as its page is open, and two are left for loading pages and posting deletes.
 */
export const MAX_STREAMS_PER_SESSION = 4;
export const LIST_EVERY_MS = 2000;
/** Bytes a stream may have waiting for its socket before it is dropped as fallen behind. */
export const MAX_QUEUED = 1024 * 1024;
/** How far back, in events, a picture or file still being fetched is followed (when the hub starts). */
const MEDIA_LOOKBACK = 1000;

/** What changed in the store since the last poll. `redraw`: chats whose every part is drawn again (a delete, an undo, a picture). */
export interface Changes {
  chats: Set<number>;
  turns: Set<number>;
  redraw: Set<number>;
}

const SIG =
  "id, chat_id as chatId, status, to_seq as toSeq, ended_at as endedAt, cost_micro_usd as cost, input_tokens as tin, output_tokens as tout, error, profile, term_at as termAt";
type TurnSig = { id: number; chatId: number; status: string };
const sig = (r: object) => JSON.stringify(r);
const marks = (n: number) => Array(n).fill("?").join(", ");

/** A message's picture or file, while it may still change in place: its state, else null (done, or none). */
function fetching(payload: string | null): string | null {
  if (!payload) return null;
  try {
    const p = JSON.parse(payload) as { media?: { state?: string; path?: string }; attachment?: { state?: string; fileId?: string } };
    const media = p.media && p.media.state === "pending";
    const att = p.attachment?.fileId && ["new", "requested", undefined].includes(p.attachment.state);
    return media || att ? JSON.stringify([p.media ?? null, p.attachment ?? null]) : null;
  } catch {
    return null;
  }
}

/** The store's cursors (see the header), and what is followed by key while it may still change. */
export class Watch {
  private seq: number;
  private stepId: number;
  private turnId: number;
  private transcriptTurn: number;
  private deleted: string;
  private deletedByChat: Map<number, number>;
  /** Running turns: id → the signature of their row. */
  private running = new Map<number, { chatId: number; sig: string }>();
  /** Outbound rows not sent yet: seq → chat, turn, status. */
  private pending = new Map<number, { chatId: number; turnId: number | null; status: string }>();
  /** Tool calls still running: step id → turn. */
  private steps = new Map<number, number>();
  /** Messages whose picture or file is still being fetched: seq → chat, and what it was. */
  private media = new Map<number, { chatId: number; was: string }>();
  /** Turn → chat, for the turns met. */
  private chatOf = new Map<number, number>();

  constructor(private readonly db: Db) {
    const q = db.$client;
    const one = (s: string) => ((q.query(s).get() as { v: number | null }).v ?? 0);
    this.seq = one("select max(seq) as v from chat_events");
    this.stepId = one("select max(id) as v from turn_steps");
    this.turnId = one("select max(id) as v from turns");
    this.transcriptTurn = one("select max(turn_id) as v from turn_transcripts");
    this.deleted = this.deletedMark();
    this.deletedByChat = this.deletedCounts();
    for (const r of q.query(`select ${SIG} from turns where status = 'running'`).all() as TurnSig[]) this.follow(r);
    for (const r of q.query("select seq, chat_id as chatId, turn_id as turnId, status from chat_events where status = 'pending'").all() as { seq: number; chatId: number; turnId: number | null; status: string }[]) {
      this.pending.set(r.seq, r);
    }
    for (const r of q.query("select seq, chat_id as chatId, payload from chat_events where seq > ? and kind = 'message'").all(this.seq - MEDIA_LOOKBACK) as { seq: number; chatId: number; payload: string }[]) {
      const was = fetching(r.payload);
      if (was) this.media.set(r.seq, { chatId: r.chatId, was });
    }
    const ids = [...this.running.keys()];
    if (ids.length) {
      for (const r of q.query(`select id, turn_id as turnId from turn_steps where status = 'running' and turn_id in (${marks(ids.length)})`).all(...ids) as { id: number; turnId: number }[]) this.steps.set(r.id, r.turnId);
    }
  }

  private follow(r: TurnSig): void {
    this.chatOf.set(r.id, r.chatId);
    if (r.status === "running") this.running.set(r.id, { chatId: r.chatId, sig: sig(r) });
  }

  private deletedMark(): string {
    const r = this.db.$client
      .query("select (select count(*) from deleted_events) + (select count(*) from deleted_turns) as n, (select coalesce(max(seq), 0) from sqlite_sequence where name = 'deletions') as d")
      .get() as { n: number; d: number };
    return `${r.n}:${r.d}`;
  }

  private deletedCounts(): Map<number, number> {
    const rows = this.db.$client.query("select chatId, sum(n) as n from (select chat_id as chatId, count(*) as n from deleted_events group by chat_id union all select chat_id, count(*) from deleted_turns group by chat_id) group by chatId").all() as { chatId: number; n: number }[];
    return new Map(rows.map((r) => [r.chatId, r.n]));
  }

  private chatOfTurn(turnId: number): number | undefined {
    let c = this.chatOf.get(turnId);
    if (c === undefined) {
      c = (this.db.$client.query("select chat_id as c from turns where id = ?").get(turnId) as { c: number } | null)?.c;
      if (c !== undefined) this.chatOf.set(turnId, c);
    }
    return c;
  }

  /** One poll: what changed since the last (see the header). */
  poll(): Changes {
    const q = this.db.$client;
    const out: Changes = { chats: new Set(), turns: new Set(), redraw: new Set() };
    const turn = (id: number | null, chatId?: number) => {
      if (id === null) return;
      out.turns.add(id);
      const c = chatId ?? this.chatOfTurn(id);
      if (c !== undefined) out.chats.add(c);
    };

    for (const e of q.query("select seq, chat_id as chatId, turn_id as turnId, status, kind, payload from chat_events where seq > ? order by seq").all(this.seq) as {
      seq: number;
      chatId: number;
      turnId: number | null;
      status: string | null;
      kind: string;
      payload: string;
    }[]) {
      this.seq = e.seq;
      out.chats.add(e.chatId);
      turn(e.turnId, e.chatId);
      if (e.status === "pending") this.pending.set(e.seq, { chatId: e.chatId, turnId: e.turnId, status: e.status });
      const was = e.kind === "message" ? fetching(e.payload) : null;
      if (was) this.media.set(e.seq, { chatId: e.chatId, was });
    }
    if (this.pending.size) {
      const seqs = [...this.pending.keys()];
      const now = new Map((q.query(`select seq, status from chat_events where seq in (${marks(seqs.length)})`).all(...seqs) as { seq: number; status: string }[]).map((r) => [r.seq, r.status]));
      for (const [seq, p] of this.pending) {
        if (now.get(seq) === "pending") continue;
        this.pending.delete(seq);
        out.chats.add(p.chatId);
        turn(p.turnId, p.chatId);
      }
    }
    if (this.media.size) {
      // A picture downloaded, a file fetched: the message's payload was rewritten in place. Its chat is drawn again
      // whole (the message may be shown by any of its turns).
      const seqs = [...this.media.keys()];
      const now = new Map((q.query(`select seq, payload from chat_events where seq in (${marks(seqs.length)})`).all(...seqs) as { seq: number; payload: string }[]).map((r) => [r.seq, r.payload]));
      for (const [seq, m] of this.media) {
        const p = now.get(seq);
        const is = p === undefined ? null : fetching(p);
        if (is === m.was) continue;
        out.chats.add(m.chatId);
        out.redraw.add(m.chatId);
        if (is) m.was = is;
        else this.media.delete(seq);
      }
    }

    for (const r of q.query(`select ${SIG} from turns where id > ? order by id`).all(this.turnId) as TurnSig[]) {
      this.turnId = r.id;
      this.follow(r);
      turn(r.id, r.chatId);
    }
    if (this.running.size) {
      const ids = [...this.running.keys()];
      const rows = new Map((q.query(`select ${SIG} from turns where id in (${marks(ids.length)})`).all(...ids) as TurnSig[]).map((r) => [r.id, r]));
      for (const [id, was] of this.running) {
        const r = rows.get(id);
        if (r && sig(r) === was.sig) continue;
        turn(id, was.chatId);
        if (!r || r.status !== "running") this.running.delete(id);
        else was.sig = sig(r);
      }
    }

    for (const s of q.query("select id, turn_id as turnId, kind, status from turn_steps where id > ? order by id").all(this.stepId) as { id: number; turnId: number; kind: string; status: string | null }[]) {
      this.stepId = s.id;
      turn(s.turnId);
      if (s.kind === "tool" && s.status === "running") this.steps.set(s.id, s.turnId);
    }
    if (this.steps.size) {
      const ids = [...this.steps.keys()];
      const now = new Map((q.query(`select id, status from turn_steps where id in (${marks(ids.length)})`).all(...ids) as { id: number; status: string | null }[]).map((r) => [r.id, r.status]));
      for (const [id, turnId] of this.steps) {
        if (now.get(id) === "running" && this.running.has(turnId)) continue;
        this.steps.delete(id);
        turn(turnId);
      }
    }

    for (const r of q.query("select turn_id as t from turn_transcripts where turn_id > ? order by turn_id").all(this.transcriptTurn) as { t: number }[]) {
      this.transcriptTurn = r.t;
      turn(r.t);
    }

    const mark = this.deletedMark();
    if (mark !== this.deleted) {
      this.deleted = mark;
      const counts = this.deletedCounts();
      for (const c of new Set([...counts.keys(), ...this.deletedByChat.keys()])) {
        if (counts.get(c) === this.deletedByChat.get(c)) continue;
        out.chats.add(c);
        out.redraw.add(c);
      }
      // A deletion purged and another made in the same chat between two polls leaves its count as it was.
      const last = q.query("select chat_id as c from deletions order by id desc limit 1").get() as { c: number } | null;
      if (last) {
        out.chats.add(last.c);
        out.redraw.add(last.c);
      }
      this.deletedByChat = counts;
    }

    // Turn → chat is kept only for what runs, so the map stays as small as that.
    if (this.chatOf.size > 4096) this.chatOf = new Map([...this.running].map(([id, r]) => [id, r.chatId]));
    return out;
  }
}

// ---- parts, and what a page has of them ---------------------------------------------------------------------

/** A change to a page, as console.js applies it (one SSE `ops` message carries a frame's). */
export type Op =
  | { k: string; h: string; html: string; live: boolean; in?: "trace" | "list"; after?: string | null }
  | { k: string; rm: true }
  | { order: string[]; in: "list" }
  | { newer: true }
  | { swap: true };

const TRACE_KEY = /^[tde]\d+(?:x\d+)?$/;
const regionOf = (k: string): "trace" | "list" | null => (TRACE_KEY.test(k) ? "trace" : /^g\d+$/.test(k) || k === "none" ? "list" : null);

/**
 * Where each trace part stands, as a number comparable across frames: a turn by its id, an event by its seq, a
 * divider just before the event that follows it.
 */
export function orders(trace: readonly LivePart[]): Map<string, number> {
  const out = new Map<string, number>();
  let next = Infinity;
  for (let i = trace.length - 1; i >= 0; i--) {
    const k = trace[i]!.k;
    const n = k.startsWith("d") ? next - 0.5 : Number(k.slice(1));
    out.set(k, n);
    if (!k.startsWith("d")) next = n;
  }
  return out;
}

/** What the page says it has, from `have` (`k.h,k.h`). */
export function parseHave(have: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of (have ?? "").split(",")) {
    const m = /^([a-z]+\d*(?:x\d+)?)\.([A-Za-z0-9_-]{1,32})$/.exec(item);
    if (m && out.size < 5000) out.set(m[1]!, m[2]!);
  }
  return out;
}

/**
 * One open page's stream: what the page has of each part (`sent`: name → hash), and the ops that bring it to a
 * frame. The socket is behind `write` / `end`, so a test drives it with frames.
 */
export class LiveStream {
  /** What the page has: part → hash. */
  private sent: Map<string, string>;
  /** The page's own account, until the first frame is matched against it (see the header). */
  private connect: { last: string | null } | null;
  private listOrder: string[] | null = null;
  private newerSaid = false;
  private swapSaid = false;
  lastWrite = 0;
  closed = false;
  feed: PageFeed | null = null;

  constructor(
    have: Map<string, string>,
    last: string | null,
    private readonly write: (chunk: string) => void,
    private readonly end: () => void,
    readonly session = "",
    readonly tab = "",
    private readonly csrf = "",
  ) {
    this.sent = new Map(have);
    this.connect = { last };
  }

  /** Said first: the assets' version and this session's CSRF token as the server derives it now (after a restart, a new secret: the page's deletes still pass). */
  hello(now: number): void {
    this.send(`event: hello\ndata: ${JSON.stringify({ v: assetsVersion(), ...(this.csrf ? { csrf: this.csrf } : {}) })}\n\n`, now);
  }

  /** Send what the page lacks of `frame`. */
  push(frame: LiveFrame, now: number): void {
    const ops = this.diff(frame);
    if (ops.length) this.send(`event: ops\ndata: ${JSON.stringify(ops)}\n\n`, now);
  }

  beat(now: number): void {
    if (now - this.lastWrite >= HEARTBEAT_MS) this.send(": \n\n", now);
  }

  /** The ops that bring the page from what it has to `frame` (and note that it has them). */
  diff(frame: LiveFrame): Op[] {
    const ops: Op[] = [];
    if (frame.newer && !this.newerSaid) {
      this.newerSaid = true;
      ops.push({ newer: true });
    }
    // A turn's (segment's, conversation's) page and the plain page of one that is not there are two pages: a page
    // showing the other than a load now would is told to swap, once, and nothing else.
    if (frame.swap) {
      const shows = this.sent.has("gone") ? "gone" : "page";
      if (frame.swap !== shows) {
        if (!this.swapSaid) ops.push({ swap: true });
        this.swapSaid = true;
        return ops;
      }
      this.swapSaid = false;
    }
    let first = this.connect;
    const put = (p: LivePart, region: "trace" | "list" | null, after: string | null, isNew: (k: string) => boolean) => {
      const had = this.sent.get(p.k);
      if (had === p.h) return;
      if (had === undefined && region === "trace" && !isNew(p.k)) {
        // On the page as it was drawn (it cannot change): noted, not sent.
        this.sent.set(p.k, p.h);
        return;
      }
      this.sent.set(p.k, p.h);
      ops.push({ k: p.k, h: p.h, html: p.html, live: p.live, ...(region ? { in: region, after } : {}) });
    };
    for (const p of frame.fixed) put(p, null, null, () => true);
    if (frame.trace) {
      const at = orders(frame.trace);
      // On (re)connect: new to the page is what stands from the first part it listed on, or after its last part.
      let from = -Infinity;
      if (first) {
        const listed = frame.trace.filter((p) => this.sent.has(p.k)).map((p) => at.get(p.k)!);
        const last = first.last && at.has(first.last) ? at.get(first.last)! + 0.25 : first.last && TRACE_KEY.test(first.last) && !first.last.startsWith("d") ? Number(first.last.slice(1).split("x")[0]) + 0.25 : 0;
        from = listed.length ? Math.min(...listed) - 0.5 : last;
      }
      let prev: string | null = null;
      for (const p of frame.trace) {
        put(p, "trace", prev, (k) => at.get(k)! >= from);
        prev = p.k;
      }
      // Gone from the page: an event or a turn within the range drawn. One that only fell off the start of a chat's
      // newest page, and a divider, stay, as history; but not a deleted turn's (below). A chat's log says where its
      // window starts (`since`), so an event deleted at its start is gone, not fallen off.
      const lowest = frame.since !== undefined ? frame.since + 0.5 : Math.min(...[...at.entries()].filter(([k]) => !k.startsWith("d")).map(([, n]) => n));
      for (const k of [...this.sent.keys()]) {
        if (regionOf(k) !== "trace" || at.has(k) || k.startsWith("d")) continue;
        if (Number(k.slice(1)) < lowest) continue;
        this.sent.delete(k);
        ops.push({ k, rm: true });
      }
      if (first) this.connect = first = null;
    }
    // A DELETED TURN (store/deletions.ts `deleteTurns`): its part (`t<turn>`) and its dividers (`d<turn>`, `d<turn>x2`)
    // go from every page that has them, wherever they stand; an undo draws them again, as new parts in place.
    if (frame.turnIds) {
      const at = new Set(frame.trace?.map((p) => p.k) ?? []);
      for (const k of [...this.sent.keys()]) {
        if (!/^[td]\d/.test(k) || at.has(k) || frame.turnIds.has(Number(k.slice(1).split("x")[0]))) continue;
        this.sent.delete(k);
        ops.push({ k, rm: true });
      }
    }
    if (frame.list) {
      let prev: string | null = null;
      for (const p of frame.list) {
        put(p, "list", prev, () => true);
        prev = p.k;
      }
      const now = new Set(frame.list.map((p) => p.k));
      for (const k of [...this.sent.keys()]) {
        if (regionOf(k) !== "list" || now.has(k)) continue;
        this.sent.delete(k);
        ops.push({ k, rm: true });
      }
      const order = frame.list.map((p) => p.k);
      if (!this.listOrder || order.join() !== this.listOrder.join()) ops.push({ order, in: "list" });
      this.listOrder = order;
    }
    return ops;
  }

  private send(chunk: string, now: number): void {
    if (this.closed) return;
    try {
      this.write(chunk);
      this.lastWrite = now;
    } catch {
      // Closed, or fallen behind (`openLive`): dropped; the page reconnects and resumes from what it has.
      this.close();
    }
  }

  /** End it (`bye`: told so first; console.js then offers to resume rather than reconnecting). */
  close(bye = false): void {
    if (this.closed) return;
    if (bye) this.send("event: bye\ndata: {}\n\n", Date.now());
    this.closed = true;
    this.feed?.leave(this);
    try {
      this.end();
    } catch {}
  }
}

/**
 * One page's feed: its view (with what it keeps between frames), the streams showing it, and the last of each
 * part it drew, so a stream joining later starts from that without another drawing.
 */
export class PageFeed {
  readonly streams = new Set<LiveStream>();
  private listDue = true;
  private listAt = -Infinity;
  private fixed = new Map<string, LivePart>();
  private trace: LivePart[] | undefined;
  private list: LivePart[] | undefined;
  private newer = false;
  private swap: LiveFrame["swap"];
  private turnIds: LiveFrame["turnIds"];
  private drawn = false;
  /** Frames drawn (for tests and checks: one per change, however many streams). */
  frames = 0;

  constructor(
    readonly key: string,
    readonly view: LiveView,
    private readonly ctx: () => PageContext,
    private readonly onEmpty: (f: PageFeed) => void = () => {},
  ) {}

  private draw(want: LiveWant, now: number): LiveFrame | null {
    if (want.list) {
      this.listDue = false;
      this.listAt = now;
    }
    let frame: LiveFrame | null;
    try {
      frame = this.view.frame(this.ctx(), want);
    } catch (e) {
      console.error("console: live frame failed:", e);
      return null;
    }
    this.frames++;
    if (!frame) return null;
    // The plain page of a deleted turn: nothing of the page it was is kept for a stream joining later.
    if (frame.swap && frame.swap !== this.swap) {
      this.fixed.clear();
      this.trace = undefined;
    }
    for (const p of frame.fixed) this.fixed.set(p.k, p);
    if (frame.trace) this.trace = frame.trace;
    if (frame.list) this.list = frame.list;
    if (frame.newer) this.newer = true;
    if (frame.swap) this.swap = frame.swap;
    if (frame.turnIds) this.turnIds = frame.turnIds;
    this.drawn = true;
    return frame;
  }

  /** A stream joins: it gets the page as last drawn (drawn now if never). */
  join(s: LiveStream, now: number): void {
    this.streams.add(s);
    s.feed = this;
    s.hello(now);
    if (!this.drawn) this.draw({ detail: "all", list: true }, now);
    if (!this.drawn) return;
    s.push({ fixed: [...this.fixed.values()], ...(this.trace ? { trace: this.trace } : {}), ...(this.list ? { list: this.list } : {}), ...(this.newer ? { newer: true } : {}), ...(this.swap ? { swap: this.swap } : {}), ...(this.turnIds ? { turnIds: this.turnIds } : {}) }, now);
  }

  leave(s: LiveStream): void {
    this.streams.delete(s);
    if (!this.streams.size) this.onEmpty(this);
  }

  /** A poll's changes: draw once what they touch (the list at most every LIST_EVERY_MS), and every stream sends its share. */
  tick(ch: Changes, now: number): void {
    const chat = this.view.chatId;
    const mine = chat !== undefined && ch.chats.has(chat);
    if (ch.chats.size) this.listDue = true;
    const list = this.listDue && now - this.listAt >= LIST_EVERY_MS;
    const frame = mine || list ? this.draw({ ...(mine ? { detail: ch.redraw.has(chat!) ? "all" : ch.turns } : {}), list }, now) : null;
    for (const s of [...this.streams]) {
      if (frame) s.push(frame, now);
      s.beat(now);
    }
  }
}

// ---- the hub: one poll, one feed per page ------------------------------------------------------------------------

export class LiveHub {
  readonly feeds = new Map<string, PageFeed>();
  private watch: Watch | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Polls run (for tests and checks). */
  polls = 0;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    private readonly every = TICK_MS,
  ) {}

  get streams(): LiveStream[] {
    return [...this.feeds.values()].flatMap((f) => [...f.streams]);
  }

  get size(): number {
    return this.streams.length;
  }

  /** The feed of page `key`, made with `make` when it has none. */
  feed(key: string, make: () => { view: LiveView; ctx: () => PageContext } | null): PageFeed | null {
    let f = this.feeds.get(key);
    if (!f) {
      const m = make();
      if (!m) return null;
      f = new PageFeed(key, m.view, m.ctx, (gone) => this.empty(gone));
      this.feeds.set(key, f);
    }
    return f;
  }

  /**
   * Open `s` on `feed`: the same tab's earlier stream is replaced at once; past MAX_STREAMS_PER_SESSION tabs in the
   * session, the oldest other is closed (told `bye`). The poll starts with the first stream.
   */
  add(s: LiveStream, feed: PageFeed): void {
    for (const old of this.streams) if (s.tab && old.session === s.session && old.tab === s.tab) old.close();
    const same = this.streams.filter((x) => x.session === s.session);
    for (const old of same.slice(0, Math.max(0, same.length - MAX_STREAMS_PER_SESSION + 1))) old.close(true);
    // The tab's earlier stream may have been its page's last: the feed is kept (or put back) for this one.
    if (this.feeds.get(feed.key) !== feed) this.feeds.set(feed.key, feed);
    if (!this.watch) this.watch = new Watch(this.db);
    feed.join(s, this.now());
    if (!this.timer && this.every > 0) {
      this.timer = setInterval(() => this.tick(), this.every);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  private empty(f: PageFeed): void {
    if (this.feeds.get(f.key) === f) this.feeds.delete(f.key);
    if (this.feeds.size) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watch = null;
  }

  /** One tick: one poll, its changes to every feed. */
  tick(): void {
    if (!this.watch) return;
    let ch: Changes;
    try {
      ch = this.watch.poll();
      this.polls++;
    } catch (e) {
      console.error("console: live poll failed:", e);
      return;
    }
    const now = this.now();
    for (const f of [...this.feeds.values()]) f.tick(ch, now);
  }
}

const hubs = new WeakMap<Db, LiveHub>();

/** The hub of store `db` (one per process and store). */
export function hubOf(db: Db): LiveHub {
  let h = hubs.get(db);
  if (!h) hubs.set(db, (h = new LiveHub(db)));
  return h;
}

// ---- GET /live ---------------------------------------------------------------------------------------------------

export interface LiveRequest {
  db: Db;
  /** The page context of this request (server.ts), without its `notice`. */
  ctx: PageContext;
  now: () => number;
  /** Who: the session the CSRF token is derived from (server.ts `Auth.session`); the cap is per session. */
  session: string;
  url: URL;
  signal: AbortSignal;
  hub?: LiveHub;
}

const encoder = new TextEncoder();

/**
 * Answer `GET /live?page=<path>&v=<assets>&have=<k.h,…>&last=<k>&tab=<id>`: an event stream for that page, or 204
 * for a page that is not live (an EventSource does not reconnect after a 204). `probe=1`: 200 or 204, no stream.
 */
export function openLive(r: LiveRequest, headers: Record<string, string>): Response {
  const page = r.url.searchParams.get("page") ?? "";
  let target: URL;
  try {
    target = new URL(page, "http://console.invalid");
    if (target.origin !== "http://console.invalid" || !page.startsWith("/")) throw new Error("not a path");
  } catch {
    return new Response(null, { status: 204, headers });
  }
  const path = target.pathname.replace(/\/+$/, "") || "/";
  const key = `${path}${target.search}`;
  const { notice: _, csrf, who: __, ...base } = r.ctx;
  // A page's parts hold nothing of who looks (no CSRF token, no login): one drawing serves every stream of it.
  const ctx = (): PageContext => ({ ...base, here: key, now: r.now() });
  const hub = r.hub ?? hubOf(r.db);
  const feed = hub.feed(key, () => {
    const view = liveView(ctx(), path, target.searchParams);
    return view ? { view, ctx } : null;
  });
  if (!feed) return new Response(null, { status: 204, headers });
  if (r.url.searchParams.get("probe") === "1") {
    if (!feed.streams.size) hub.feeds.delete(key);
    return new Response("live", { status: 200, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
  }
  const stale = r.url.searchParams.get("v") !== assetsVersion();
  let stream: LiveStream | null = null;
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const write = (s: string) => {
          // Fallen behind: what was written before is still waiting for the socket. Dropped; the page reconnects from
          // what it has. (Measured before writing, so one large frame on its own always goes out.)
          if ((controller.desiredSize ?? 0) < -MAX_QUEUED) throw new Error("fallen behind");
          controller.enqueue(encoder.encode(s));
        };
        const end = () => {
          try {
            controller.close();
          } catch {}
        };
        if (stale) {
          // A page from before a deploy: its markup would meet another stylesheet. console.js loads it again.
          write("event: reload\ndata: {}\n\n");
          controller.close();
          if (!feed.streams.size) hub.feeds.delete(key);
          return;
        }
        stream = new LiveStream(parseHave(r.url.searchParams.get("have")), r.url.searchParams.get("last"), write, end, r.session, r.url.searchParams.get("tab") ?? "", csrf ?? "");
        hub.add(stream, feed);
        r.signal.addEventListener("abort", () => stream?.close(), { once: true });
      },
      cancel() {
        stream?.close();
      },
    },
    { highWaterMark: 64 * 1024, size: (c) => c?.byteLength ?? 0 },
  );
  return new Response(body, { status: 200, headers: { ...headers, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
