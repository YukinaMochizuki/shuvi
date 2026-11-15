import type { Database } from "bun:sqlite";
import { existsSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, sep } from "node:path";
// The one line a reply renders as (a pure function): the scrub writes exactly what render.ts would.
import { CALLED_PREFIX, calledHeading, replyLine, unreadNote } from "../agent/render.ts";
import { TRANSCRIPT_MEDIA } from "../agent/transcript.ts";
import type { Db } from "./db.ts";
import type { BotMessagePayload, MessagePayload } from "./events.ts";
import { mediaInUse } from "./media.ts";
import { TRIGGER_KINDS, type TranscriptPart } from "./schema.ts";

/**
 * Deleting chat messages (the console's second write path: console/delete-write.ts). docs/design.md §3.
 *
 * HARD, AND NO TRACE. A delete MOVES the rows out of `chat_events` into `deleted_events` (every column, the seq
 * included) in one IMMEDIATE transaction. Every reader of the log reads `chat_events`, so from that moment none
 * sees them: a fresh conversation's last messages (`recentHistory`), a turn's input (`triggersAfter`), the gap
 * line (`previousEvent`), `lastMessage`, `search_chats` / `read_chat` (their FTS rows go too: `chat_events_fts`
 * has no delete trigger, so they are removed here, and put back on undo), and the console. Nothing marks where
 * they were. In the same transaction the VERBATIM copies elsewhere are scrubbed, and their originals stashed in
 * `deletion_scrubs`:
 *   - a reply's quote of a deleted message (`payload.replyTo.text`; the `replyTo` keeps its ids and name), and
 *     that quote in any transcript line of the reply (`↳ replying to …` reads "a message", as render.ts would);
 *   - the deleted message's own line in a turn's input (`turn_transcripts.input`: the line, its indented lines
 *     and the images shown after it), and what in that input counts or names it: the fresh conversation's "The
 *     last N messages", the unread note's N (a group turn's unread messages it did not show), the "You were
 *     called by #S" heading; and its line in what a turn was appended (`turn_steps` of kind `append`: the line,
 *     and the images that were its picture);
 *   - its line in what `read_chat` and `search_chats` gave any turn (a search's chat left without a hit goes);
 *   - a message of HERS as the turn that wrote it recorded it: the `text` step that became it (its text
 *     emptied), or the `say` call that sent it (its `text` argument taken out of `args`; the call is found by
 *     the turn and the words, as no key ties a message to the call). Nothing marks either.
 * NOT touched, by decision: the model's conversations (Claude Code sessions, `conversation_messages`), her
 * thinking that paraphrases it, any other tool's arguments or results, Telegram, the backups. The model is told
 * nothing.
 *
 * WHAT MAY GO: `message` (a photo or a sticker is one), `bot_message`, `bot_sticker`, `bot_file`; her reactions
 * to a deleted message (`bot_reaction` whose `targetSeq` it is) go with it. REFUSED, with a reason the console
 * shows: a message within a turn still running (in its `(from_seq, to_seq]`, its trigger, or one it wrote), and
 * an outbound row still `pending` (the sender is about to send it), its reactions included.
 *
 * ONE OPEN DELETION PER CHAT: a delete while the chat's last one can still be undone JOINS it (its rows and
 * scrubs added, the window started again). So one undo puts back everything deleted in a row, and a scrub or a
 * restore never meets another deletion's: they apply and unwind in order, last first.
 *
 * UNDO for DELETE_UNDO_MS: the rows go back with their seq, the stash is written back (byte for byte when the
 * scrubbed value was not changed since; a reply's quote alone otherwise). REFUSED once the chat has moved on (a
 * turn started since the first delete, a running turn's range grown over one, the cursor past one that was ahead
 * of it): put back, it would sit as input the model never saw, or behind the cursor, never answered. After the
 * window the PURGE (server/main.ts's `deletions` loop, which also runs at start, so a purge due while the server
 * was down runs then) drops the stash and the files under `media/` nothing kept still names (store/media.ts
 * `mediaInUse`); a picture whose download ends after its message was deleted is the downloader's to drop.
 *
 * Pointers to a deleted seq (`turns.trigger_seq`, a reaction's `targetSeq`, a reply's `replyToSeq`) are left
 * as they are: every reader that follows one finds no row and goes on (the sender, triggers.ts, the console).
 * The waker's trigger memo starts over on any delete, undo or purge in the chat (`deletionsMark`).
 *
 * A WHOLE TURN (`deleteTurns`, the console's "Delete turn"): it goes entirely. Three things, in one IMMEDIATE
 * transaction: its record (`turns`, `turn_steps`, `turn_transcripts`), MOVED into `deleted_turns`,
 * `deleted_turn_steps`, `deleted_turn_transcripts` (every column, ids as they were); the events it WROTE (its
 * outbound rows: messages, stickers, files, reactions); and the events it ANSWERED (every trigger event in its
 * `(from_seq, to_seq]`, anyone's: in a group, the chatter around the mention too). The events take the message
 * path above (`moveEvents`), so every scrub applies to them (replies' quotes, other turns' transcript lines,
 * read_chat / search_chats results); each is marked with the turn that took it (`deleted_events.by_turn`), so the
 * console counts a turn's messages one way everywhere (`turnMessageCount`: answered + written, her reactions not
 * counted). Its own rows move first, so no scrub touches them and the undo puts them back as they were.
 *   - It JOINS the chat's open deletion like any delete: one undo puts back messages and turns deleted in a row.
 *     The undo puts the turns back before restoring any scrub (one made before the turn was deleted is then found
 *     in place), and is refused under the same rules.
 *   - REFUSED, with a reason: a turn still running, a turn with an outbound row still `pending`, and whatever the
 *     message path refuses for its events.
 *   - The PURGE drops the stash, then the `prompt_texts` rows its transcripts named that nothing else names (a
 *     prompt is shared by hash; pruneTranscripts keeps one a stashed transcript names), and the files under
 *     `media/` (its input's and its steps' pictures too) nothing still names.
 *   - NOT touched, as for messages: the model's conversations, Telegram, backups; nor what the turn DID (home/
 *     commits, schedules it set, jobs it started). Pointers to its id are left as they are
 *     (`model_switches.turn_id`, `schedules.created_turn_id`, alerts' `turnId`, a home commit's `Turn:` trailer,
 *     `jobs`): the console answers any of them with "this turn was deleted or does not exist", never a 500.
 *   - EXACTLY-ONCE KEYS survive a delete. A deleted row's `idem_key` (an inbound POST's Idempotency-Key, a
 *     schedule's firing, a job's result, an approval's answer, her outbound rows') blocks a new write with it while
 *     the row waits out its undo (in `deleted_events`), and after the purge the key alone is kept in
 *     `spent_idem_keys` (store/events.ts `idemKeySpent`, checked by `recordFrameworkEvent` and
 *     `recordApprovalEvent`). So a webhook retried after its event was deleted is not recorded again and starts no
 *     turn. A scheduled or job_done event was already safe through its own table; the key changes nothing for it.
 *   - A turn whose range another turn shares (it answered some of the same messages again: a retry after a failure,
 *     or the turn after a `/stop`, whose cursor stopped at `stop_seq`): they go, and the other turn's input is
 *     scrubbed of them as any deleted message's would be. The confirmation names that turn.
 */

/**
 * A transcript picture touched this long before its deletion was made, or since, is not removed by the purge: it may
 * be in use again, its step not written yet (see `purgeDeletions`).
 */
export const REUSE_GRACE_MS = 60_000;

/** How long a delete can be undone. */
export const DELETE_UNDO_MS = 10_000;
/** What may be deleted (the console offers these only). */
export const DELETABLE_KINDS: readonly string[] = ["message", "bot_message", "bot_sticker", "bot_file"];

export type DeleteResult = { ok: true; id: number; count: number; purgeAt: string } | { ok: false; refused: string };
export type UndoResult = { ok: true; count: number; turns: number } | { ok: false; refused: string };

interface Row {
  seq: number;
  chat_id: number;
  kind: string;
  payload: string;
  tg_message_id: number | null;
  status: string | null;
  turn_id: number | null;
}

const COLUMNS = "seq, chat_id, kind, payload, tg_update_id, tg_message_id, idem_key, status, note, turn_id, at";
const marks = (n: number) => Array(n).fill("?").join(", ");
const parse = <T>(s: string): T => JSON.parse(s) as T;

// ---- the text of a transcript ---------------------------------------------------------------------------

/** An event's first line in rendered input (render.ts): `[#12 · Wed 11/11 21:03 · Alice] …`. */
const HEAD = /^\[#(\d+) · /;
/** Its later lines are indented (render.ts BODY_INDENT); the next line at the margin is something else. */
const CONTINUES = (line: string) => line.startsWith("  ");

/**
 * `text` without the lines of the events in `seqs` (each one's first line and the indented lines under it).
 * `endsRemoved`: the text ended inside a removed event (the images that follow it in the input were its own).
 */
export function dropEventLines(text: string, seqs: ReadonlySet<number>): { text: string; changed: boolean; endsRemoved: boolean } {
  const out: string[] = [];
  let removing = false;
  let changed = false;
  for (const line of text.split("\n")) {
    const head = HEAD.exec(line);
    if (head) removing = seqs.has(Number(head[1]));
    else if (!CONTINUES(line)) removing = false;
    if (removing) changed = true;
    else out.push(line);
  }
  return { text: out.join("\n"), changed, endsRemoved: removing };
}

/** `text` with the quote under event `seq`'s line (its `↳ replying to …`) replaced by `line`. */
export function replaceReplyLine(text: string, seq: number, prefix: string, line: string): { text: string; changed: boolean } {
  const lines = text.split("\n");
  let inside = false;
  let at = -1;
  lines.forEach((l, i) => {
    const head = HEAD.exec(l);
    if (head) inside = Number(head[1]) === seq;
    else if (!CONTINUES(l)) inside = false;
    // The last such line of the event: the reply line is added after the message's own lines.
    if (inside && !head && l.startsWith(prefix) && l.endsWith('"')) at = i;
  });
  if (at < 0) return { text, changed: false };
  lines[at] = line;
  return { text: lines.join("\n"), changed: true };
}

/** A turn's input without the deleted events' lines and the images shown after them. */
function scrubInput(parts: TranscriptPart[], seqs: ReadonlySet<number>): TranscriptPart[] {
  const out: TranscriptPart[] = [];
  let dropImages = false;
  for (const p of parts) {
    if (p.type === "image") {
      if (!dropImages) out.push(p);
      continue;
    }
    const r = dropEventLines(p.text, seqs);
    dropImages = r.endsRemoved;
    if (!r.text.trim()) continue;
    const prev = out.at(-1);
    // Two texts now side by side read as one, as render.ts `joinParts` would have joined them.
    if (prev?.type === "text") out[out.length - 1] = { type: "text", text: `${prev.text}\n${r.text}` };
    else out.push({ type: "text", text: r.text });
  }
  return out;
}

// ---- delete ---------------------------------------------------------------------------------------------

/** Why `rows` may not be deleted now, or null. */
function refusal(client: Database, chatId: number, rows: Row[]): string | null {
  const running = client.query("select id, from_seq, to_seq, trigger_seq from turns where chat_id = ? and status = 'running'").all(chatId) as {
    id: number;
    from_seq: number;
    to_seq: number;
    trigger_seq: number | null;
  }[];
  for (const r of rows) {
    const t = running.find((t) => (r.seq > t.from_seq && r.seq <= t.to_seq) || r.seq === t.trigger_seq || r.turn_id === t.id);
    if (t) return `#${r.seq} is part of turn ${t.id}, which is still running. Delete it once the turn has ended.`;
    if (r.status === "pending") return `#${r.seq} has not been sent yet. Delete it once it has gone out (or failed).`;
  }
  return null;
}

/**
 * Delete events `seqs` (one chat's) and her reactions to them. Refused, with the reason, when any of them may not
 * be deleted now; then nothing changes. While the chat has a deletion still OPEN (its window not closed), this
 * one JOINS it: its rows and scrubs are added to it and the window starts again, so one undo puts back all of
 * them, and no scrub or restore ever has to reckon with another open deletion. `count`: the deletion's, joined.
 */
export function deleteMessages(db: Db, seqs: readonly number[], now = Date.now()): DeleteResult {
  const client = db.$client;
  const wanted = [...new Set(seqs)].filter((s) => Number.isSafeInteger(s) && s > 0);
  if (!wanted.length) return { ok: false, refused: "No message was selected." };
  return client.transaction((): DeleteResult => {
    const picked = client.query(`select ${COLUMNS} from chat_events where seq in (${marks(wanted.length)})`).all(...wanted) as Row[];
    const missing = wanted.find((s) => !picked.some((r) => r.seq === s));
    if (missing !== undefined) return { ok: false, refused: `#${missing} is not in the chat's log any more. Reload the page.` };
    const chatId = picked[0]!.chat_id;
    if (picked.some((r) => r.chat_id !== chatId)) return { ok: false, refused: "Those messages are from more than one chat. Delete them one chat at a time." };
    const odd = picked.find((r) => !DELETABLE_KINDS.includes(r.kind));
    if (odd) return { ok: false, refused: `#${odd.seq} is a ${odd.kind.replace("_", " ")}, which cannot be deleted.` };
    const rows = withReactions(client, chatId, picked);
    const why = refusal(client, chatId, rows);
    if (why) return { ok: false, refused: why };
    const { id, purgeAt } = openDeletion(client, chatId, now);
    moveEvents(client, id, chatId, rows);
    return { ok: true, id, count: countOf(client, id), purgeAt };
  }).immediate();
}

/** `rows` and her reactions to them (any turn's), which go with them; in seq order. */
function withReactions(client: Database, chatId: number, rows: Row[]): Row[] {
  const seqs = rows.map((r) => r.seq);
  if (!seqs.length) return [];
  const reactions = (
    client.query(`select ${COLUMNS} from chat_events where chat_id = ? and kind = 'bot_reaction' and json_extract(payload, '$.targetSeq') in (${marks(seqs.length)})`).all(chatId, ...seqs) as Row[]
  ).filter((r) => !seqs.includes(r.seq));
  return [...rows, ...reactions].sort((a, b) => a.seq - b.seq);
}

/** The chat's open deletion, its window started again; or a new one. */
function openDeletion(client: Database, chatId: number, now: number): { id: number; purgeAt: string } {
  const purgeAt = new Date(now + DELETE_UNDO_MS).toISOString();
  const open = client.query("select id from deletions where chat_id = ? and purge_at > ? order by id desc limit 1").get(chatId, new Date(now).toISOString()) as { id: number } | null;
  if (open) {
    client.query("update deletions set purge_at = ? where id = ?").run(purgeAt, open.id);
    return { id: open.id, purgeAt };
  }
  const chat = client.query("select cursor_seq as c, (select coalesce(max(id), 0) from turns where chat_id = ?1) as t from chats where id = ?1").get(chatId) as { c: number; t: number };
  const id = Number(
    (client.query("insert into deletions (chat_id, created_at, purge_at, cursor_seq, last_turn_id) values (?, ?, ?, ?, ?) returning id").get(chatId, new Date(now).toISOString(), purgeAt, chat.c, chat.t) as { id: number }).id,
  );
  return { id, purgeAt };
}

/** Move `rows` out of the log into deletion `id`, and scrub their copies elsewhere (the header). */
function moveEvents(client: Database, id: number, chatId: number, rows: Row[]): void {
  if (!rows.length) return;
  const all = rows.map((r) => r.seq);
  client.query(`insert into deleted_events (deletion_id, ${COLUMNS}) select ?, ${COLUMNS} from chat_events where seq in (${marks(all.length)})`).run(id, ...all);
  client.query(`delete from chat_events_fts where rowid in (${marks(all.length)})`).run(...all);
  client.query(`delete from chat_events where seq in (${marks(all.length)})`).run(...all);
  scrub(client, id, chatId, rows);
}

/** How many messages deletion `id` holds (her reactions, which went with them, not counted). */
const countOf = (client: Database, id: number) => (client.query("select count(*) as n from deleted_events where deletion_id = ? and kind <> 'bot_reaction'").get(id) as { n: number }).n;

function stash(client: Database, id: number, target: "event" | "transcript" | "step", ref: number, original: string, scrubbed: string): void {
  client.query("insert into deletion_scrubs (deletion_id, target, ref, original, scrubbed) values (?, ?, ?, ?, ?)").run(id, target, ref, original, scrubbed);
}

/** Scrub the verbatim copies of `rows` (see the header), stashing each original under deletion `id`. */
function scrub(client: Database, id: number, chatId: number, rows: Row[]): void {
  const seqs = new Set(rows.map((r) => r.seq));
  // Replies to a deleted message, by its Telegram ids (a long message of hers is several).
  const tgIds = new Set<number>();
  for (const r of rows) {
    if (r.tg_message_id) tgIds.add(r.tg_message_id);
    if (r.kind === "bot_message") for (const p of parse<BotMessagePayload>(r.payload).sentParts ?? []) tgIds.add(p);
  }
  const replies: { seq: number; payload: MessagePayload }[] = [];
  if (tgIds.size) {
    const found = client
      .query(
        `select seq, payload from chat_events where chat_id = ? and kind = 'message' and json_extract(payload, '$.replyTo.text') is not null and json_extract(payload, '$.replyTo.tgMessageId') in (${marks(tgIds.size)})`,
      )
      .all(chatId, ...tgIds) as { seq: number; payload: string }[];
    for (const f of found) {
      const p = parse<MessagePayload>(f.payload);
      const { text: _quote, ...replyTo } = p.replyTo!;
      const scrubbed = JSON.stringify({ ...p, replyTo });
      client.query("update chat_events set payload = ? where seq = ?").run(scrubbed, f.seq);
      stash(client, id, "event", f.seq, f.payload, scrubbed);
      replies.push({ seq: f.seq, payload: p });
    }
  }

  // The turns of this chat whose input or appends name a deleted message or a scrubbed reply.
  const named = [...seqs, ...replies.map((r) => r.seq)].map((s) => `[#${s} · `);
  const names = (column: string) => named.map(() => `instr(${column}, ?) > 0`).join(" or ");
  const deletedMedia = new Set(rows.flatMap((r) => (r.kind === "message" ? [parse<MessagePayload>(r.payload).media?.path] : [])).filter((p): p is string => !!p));
  const fixText = (text: string) => {
    let t = dropEventLines(text, seqs).text;
    for (const r of replies) {
      const bare = replyLine({ ...(r.payload.replyTo!.fromName ? { fromName: r.payload.replyTo!.fromName } : {}) });
      t = replaceReplyLine(t, r.seq, bare.slice(0, -"a message".length), bare).text;
    }
    return t;
  };

  // A turn's input names a deleted message by its line, or counts it without one: among the unread messages a
  // group turn did not show (its note says how many). So: the turns naming one, and those whose range holds one.
  const inRange = [...seqs].map(() => "(? > t.from_seq and ? <= t.to_seq)").join(" or ");
  const transcripts = client
    .query(
      `select tt.turn_id, tt.input, t.from_seq, t.to_seq from turn_transcripts tt join turns t on t.id = tt.turn_id where t.chat_id = ? and ((${names("tt.input")}) or ${inRange})`,
    )
    .all(chatId, ...named, ...[...seqs].flatMap((s) => [s, s])) as { turn_id: number; input: string; from_seq: number; to_seq: number }[];
  for (const t of transcripts) {
    const parts = scrubInput(parse<TranscriptPart[]>(t.input), seqs).map((p) => (p.type === "text" ? { ...p, text: fixText(p.text) } : p));
    const fixed = fixHeadings(parts, seqs, hiddenDeleted(client, chatId, t, parts, rows));
    const scrubbed = JSON.stringify(fixed);
    if (scrubbed === t.input) continue;
    client.query("update turn_transcripts set input = ? where turn_id = ?").run(scrubbed, t.turn_id);
    stash(client, id, "transcript", t.turn_id, t.input, scrubbed);
  }

  // What `read_chat` and `search_chats` gave a turn (of any chat: search reaches other chats) shows a deleted
  // message by its line, as the input does: the line goes, and a search's chat left with no hit goes with it.
  // Other tools' results stay.
  const results = client
    .query(`select id, name, result from turn_steps where kind = 'tool' and name in ('read_chat', 'search_chats') and result is not null and (${names("result")})`)
    .all(...named) as { id: number; name: string; result: string }[];
  for (const r of results) {
    let result = fixText(r.result);
    if (r.name === "search_chats" && result !== r.result) result = dropEmptyChats(result);
    if (result !== r.result) scrubStep(client, id, r.id, { result: r.result }, { result });
  }

  const steps = client
    .query(
      `select id, text, images, from_seq, to_seq from turn_steps where kind = 'append' and turn_id in (select id from turns where chat_id = ?) and text is not null and (${names("text")})`,
    )
    .all(chatId, ...named) as { id: number; text: string; images: string | null; from_seq: number | null; to_seq: number | null }[];
  for (const s of steps) {
    // The appended events' pictures: a deleted message's go (one another event still shows stays).
    const kept = new Set(
      (client.query("select json_extract(payload, '$.media.path') as p from chat_events where chat_id = ? and seq > ? and seq <= ? and kind = 'message'").all(chatId, s.from_seq ?? 0, s.to_seq ?? 0) as { p: string | null }[]).map(
        (r) => r.p,
      ),
    );
    const images = s.images === null ? null : parse<{ ref: string; mimeType: string }[]>(s.images).filter((i) => !deletedMedia.has(i.ref) || kept.has(i.ref));
    const text = fixText(s.text);
    const imagesJson = images === null ? null : JSON.stringify(images);
    if (text === s.text && imagesJson === s.images) continue;
    scrubStep(client, id, s.id, { text: s.text, images: s.images }, { text, images: imagesJson });
  }

  // Her own deleted messages, as the turn that wrote them recorded them: the text block that became the message
  // (its text emptied), or the `say` call that sent it (its `text` argument removed). Found by the turn and,
  // for `say`, by the words themselves (queueMessage sends them trimmed); each call stands for one message.
  const claimed = new Set<number>();
  for (const r of rows) {
    if (r.kind !== "bot_message" || r.turn_id === null) continue;
    const said = parse<BotMessagePayload>(r.payload).text;
    const block = client.query("select id, text from turn_steps where turn_id = ? and kind = 'text' and outbound_seq = ? and text is not null and text <> ''").get(r.turn_id, r.seq) as { id: number; text: string } | null;
    if (block) {
      scrubStep(client, id, block.id, { text: block.text }, { text: "" });
      continue;
    }
    const calls = client.query("select id, args from turn_steps where turn_id = ? and kind = 'tool' and name = 'say' and args is not null order by n").all(r.turn_id) as { id: number; args: string }[];
    for (const c of calls) {
      if (claimed.has(c.id)) continue;
      let args: Record<string, unknown>;
      try {
        args = parse<Record<string, unknown>>(c.args);
      } catch {
        continue; // cut short when stored (transcript.ts MAX_STORED): not the words in full
      }
      if (typeof args.text !== "string" || args.text.trim() !== said) continue;
      const { text: _said, ...rest } = args;
      scrubStep(client, id, c.id, { args: c.args }, { args: JSON.stringify(rest) });
      claimed.add(c.id);
      break;
    }
  }
}

/** The columns of a `turn_steps` row a scrub may write. */
type StepColumns = { text?: string | null; images?: string | null; args?: string | null; result?: string | null };

/** A search's result without the chats left with no hit (`chat <name>:` and nothing under it); none left: no hits. */
function dropEmptyChats(result: string): string {
  const blocks = result.split("\n\n").filter((b) => {
    const [first, ...rest] = b.split("\n");
    return !(/^chat .*:$/.test(first ?? "") && !rest.some((l) => HEAD.test(l)));
  });
  return blocks.some((b) => b.split("\n").some((l) => HEAD.test(l))) ? blocks.join("\n\n") : "No hits.";
}

/**
 * How many of the messages turn `t` counted as unread and did not show (its note: render.ts `unreadNote`) are
 * among the `rows` being deleted now. Those it did not show are the first N of its range's inputs (agent/turn.ts):
 * the ones still in the log, and those going now. (One deleted before was taken off N then.)
 */
function hiddenDeleted(client: Database, chatId: number, t: { from_seq: number; to_seq: number }, parts: TranscriptPart[], rows: Row[]): number {
  const n = unreadCount(parts);
  if (!n) return 0;
  const kinds = TRIGGER_KINDS as readonly string[];
  const kept = (client.query(`select seq from chat_events where chat_id = ? and seq > ? and seq <= ? and kind in (${marks(kinds.length)})`).all(chatId, t.from_seq, t.to_seq, ...kinds) as { seq: number }[]).map((r) => r.seq);
  const going = rows.filter((r) => kinds.includes(r.kind) && r.seq > t.from_seq && r.seq <= t.to_seq).map((r) => r.seq);
  const hidden = [...kept, ...going].sort((a, b) => a - b).slice(0, n);
  return hidden.filter((s) => going.includes(s)).length;
}

const UNREAD = /^\((\d+) earlier messages? since your last turn/;
const HISTORY = /^(\(A new conversation\. The last )(\d+)( messages of this chat, for context:\))$/;
const NEW_MESSAGES = "(New messages:)";

function unreadCount(parts: TranscriptPart[]): number {
  for (const p of parts) {
    if (p.type !== "text") continue;
    for (const l of p.text.split("\n")) {
      const m = UNREAD.exec(l);
      if (m) return Number(m[1]);
    }
  }
  return 0;
}

/**
 * What in a turn's input counts or names messages, made true again once `deleted` are gone from it: the fresh
 * conversation's "The last N messages" (the lines left under it), the unread note's N (less `hiddenGone`; none
 * left: no note), and the "You were called by #S" heading (without the deleted; none left: no heading).
 */
function fixHeadings(parts: TranscriptPart[], deleted: ReadonlySet<number>, hiddenGone: number): TranscriptPart[] {
  const lines = (p: TranscriptPart) => (p.type === "text" ? p.text.split("\n") : []);
  // The history lines left: from the heading to "(New messages:)", across the parts (images split them).
  let counting = false;
  let history = 0;
  for (const p of parts) {
    for (const l of lines(p)) {
      if (HISTORY.test(l)) counting = true;
      else if (l === NEW_MESSAGES) counting = false;
      else if (counting && HEAD.test(l)) history++;
    }
  }
  const out = parts.map((p): TranscriptPart => {
    if (p.type !== "text") return p;
    const kept: string[] = [];
    for (const l of p.text.split("\n")) {
      const h = HISTORY.exec(l);
      const u = UNREAD.exec(l);
      if (h) kept.push(`${h[1]}${history}${h[3]}`);
      else if (u && hiddenGone) {
        const left = Number(u[1]) - hiddenGone;
        if (left > 0) kept.push(unreadNote(left));
      } else if (l.startsWith(CALLED_PREFIX)) {
        const called = [...l.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
        const left = called.filter((s) => !deleted.has(s));
        if (left.length === called.length) kept.push(l);
        else if (left.length) kept.push(calledHeading(left));
      } else kept.push(l);
    }
    return { type: "text", text: kept.join("\n") };
  });
  // A part left empty goes; texts now side by side are one, as render.ts `joinParts` joins them.
  const joined: TranscriptPart[] = [];
  for (const p of out) {
    if (p.type === "text" && !p.text.trim()) continue;
    const prev = joined.at(-1);
    if (p.type === "text" && prev?.type === "text") joined[joined.length - 1] = { type: "text", text: `${prev.text}\n${p.text}` };
    else joined.push(p);
  }
  return joined;
}

/** Write `scrubbed` over step `stepId`'s columns, stashing what they held (`original`, the same columns) for undo. */
function scrubStep(client: Database, id: number, stepId: number, original: StepColumns, scrubbed: StepColumns): void {
  const cols = Object.keys(scrubbed) as (keyof StepColumns)[];
  client.query(`update turn_steps set ${cols.map((c) => `${c} = ?`).join(", ")} where id = ?`).run(...cols.map((c) => scrubbed[c] ?? null), stepId);
  stash(client, id, "step", stepId, JSON.stringify(original), JSON.stringify(scrubbed));
}

// ---- deleting a turn: what goes -------------------------------------------------------------------------

/** One event a turn delete would take, as the confirmation lists it. */
export interface TurnDeletionEvent {
  seq: number;
  kind: string;
  payload: string;
  status: string | null;
  at: string;
}

/** What deleting turn `turnId` would take (the console's confirmation), and why it may not go now. */
export interface TurnDeletionPlan {
  turnId: number;
  chatId: number;
  status: string;
  /** The events it answered: the trigger events in its input range `(from_seq, to_seq]`, anyone's. */
  answered: TurnDeletionEvent[];
  /** What it wrote: its outbound rows (messages, stickers, files, reactions). */
  wrote: TurnDeletionEvent[];
  /** Its record: the timeline's steps by kind, its tool calls by name (most first), and whether it has a transcript. */
  steps: { thinking: number; text: number; tool: number; append: number; note: number; compaction: number };
  tools: { name: string; n: number }[];
  transcript: boolean;
  /**
   * Other turns that also answered some of the same events (a retry after a failure; the turn after a stopped one,
   * whose range starts where the stop left the cursor): they lose them from their input.
   */
  shared: number[];
  /** Why it may not be deleted now, or null. */
  refused: string | null;
}

/** What deleting turn `turnId` would take, or undefined when there is no such turn. Reads only. */
export function turnDeletionPlan(db: Db, turnId: number): TurnDeletionPlan | undefined {
  const client = db.$client;
  const t = client.query("select id, chat_id, status, from_seq, to_seq from turns where id = ?").get(turnId) as { id: number; chat_id: number; status: string; from_seq: number; to_seq: number } | null;
  if (!t) return undefined;
  const kinds = TRIGGER_KINDS as readonly string[];
  const cols = "seq, kind, payload, status, at";
  const answered = client.query(`select ${cols} from chat_events where chat_id = ? and seq > ? and seq <= ? and kind in (${marks(kinds.length)}) order by seq`).all(t.chat_id, t.from_seq, t.to_seq, ...kinds) as TurnDeletionEvent[];
  const wrote = client.query(`select ${cols} from chat_events where turn_id = ? order by seq`).all(t.id) as TurnDeletionEvent[];
  const steps = { thinking: 0, text: 0, tool: 0, append: 0, note: 0, compaction: 0 };
  for (const r of client.query("select kind, count(*) as n from turn_steps where turn_id = ? group by kind").all(t.id) as { kind: keyof typeof steps; n: number }[]) steps[r.kind] = r.n;
  const tools = (client.query("select name, count(*) as calls from turn_steps where turn_id = ? and kind = 'tool' group by name order by calls desc, min(n)").all(t.id) as { name: string; calls: number }[]).map((r) => ({ name: r.name, n: r.calls }));
  const transcript = !!client.query("select 1 from turn_transcripts where turn_id = ?").get(t.id);
  const shared = answered.length
    ? (client.query("select id from turns where chat_id = ? and id <> ? and from_seq < ? and to_seq >= ? order by id").all(t.chat_id, t.id, answered.at(-1)!.seq, answered[0]!.seq) as { id: number }[])
        .map((r) => r.id)
        .filter((id) => answered.some((e) => client.query("select 1 from turns where id = ? and ? > from_seq and ? <= to_seq").get(id, e.seq, e.seq)))
    : [];
  const pending = wrote.find((r) => r.status === "pending");
  const refused =
    t.status === "running"
      ? `Turn ${t.id} is still running. Delete it once it has ended.`
      : pending
        ? `#${pending.seq}, which turn ${t.id} wrote, has not been sent yet. Delete the turn once it has gone out (or failed).`
        : null;
  return { turnId: t.id, chatId: t.chat_id, status: t.status, answered, wrote, steps, tools, transcript, shared, refused };
}

/**
 * How many MESSAGES a turn delete takes, by the one definition the console uses everywhere (the confirmation, the
 * snackbar, the no-script notice): every row it answered and every row it wrote, her reactions not counted (they are
 * said apart). The same rows `deleteTurns` marks `by_turn`.
 */
export function turnMessageCount(plan: Pick<TurnDeletionPlan, "answered" | "wrote">): number {
  return plan.answered.length + plan.wrote.filter((e) => e.kind !== "bot_reaction").length;
}

export type TurnDeleteResult = { ok: true; id: number; purgeAt: string; seqs: number[] } | { ok: false; refused: string };

/** The columns of the stashed turn tables, as their sources have them (a column added to one and not the other fails loudly). */
const columnsOf = (client: Database, table: string) => (client.query(`select name from pragma_table_info('${table}')`).all() as { name: string }[]).map((r) => r.name).join(", ");

/**
 * Delete turns `turnIds` (one chat's) entirely: their records (`turns`, `turn_steps`, `turn_transcripts`) MOVED into
 * the stash tables, and with them the events each answered (the trigger events in its `(from_seq, to_seq]`, anyone's)
 * and wrote (its outbound rows), through the same path as `deleteMessages` (her reactions to them go too; every
 * scrub applies). One IMMEDIATE transaction; it joins the chat's open deletion, so one undo puts back messages and
 * turns deleted in a row. Refused, with the reason, for a turn still running or one with an outbound row still
 * `pending`, and as a message delete is (`refusal`). `seqs`: the events this delete took, reactions included.
 */
export function deleteTurns(db: Db, turnIds: readonly number[], now = Date.now()): TurnDeleteResult {
  const client = db.$client;
  const wanted = [...new Set(turnIds)].filter((t) => Number.isSafeInteger(t) && t > 0);
  if (!wanted.length) return { ok: false, refused: "No turn was named." };
  return client.transaction((): TurnDeleteResult => {
    const plans: TurnDeletionPlan[] = [];
    for (const t of wanted) {
      const plan = turnDeletionPlan(db, t);
      if (!plan) return { ok: false, refused: `Turn ${t} is not here any more (deleted already?). Reload the page.` };
      if (plan.refused) return { ok: false, refused: plan.refused };
      plans.push(plan);
    }
    const chatId = plans[0]!.chatId;
    if (plans.some((p) => p.chatId !== chatId)) return { ok: false, refused: "Those turns are from more than one chat. Delete them one chat at a time." };
    const byTurn = new Map<number, number>();
    for (const p of plans) for (const e of [...p.answered, ...p.wrote]) if (!byTurn.has(e.seq)) byTurn.set(e.seq, p.turnId);
    const seqs = [...byTurn.keys()];
    const picked = seqs.length ? (client.query(`select ${COLUMNS} from chat_events where seq in (${marks(seqs.length)})`).all(...seqs) as Row[]) : [];
    const rows = withReactions(client, chatId, picked);
    const why = refusal(client, chatId, rows);
    if (why) return { ok: false, refused: why };

    const { id, purgeAt } = openDeletion(client, chatId, now);
    // The turns' own rows first: then no scrub below touches them (they are put back as they were).
    const ids = plans.map((p) => p.turnId);
    const m = marks(ids.length);
    for (const [table, stashed, key] of [
      ["turn_steps", "deleted_turn_steps", "turn_id"],
      ["turn_transcripts", "deleted_turn_transcripts", "turn_id"],
      ["turns", "deleted_turns", "id"],
    ] as const) {
      const cols = columnsOf(client, table);
      client.query(`insert into ${stashed} (deletion_id, ${cols}) select ?, ${cols} from ${table} where ${key} in (${m})`).run(id, ...ids);
      client.query(`delete from ${table} where ${key} in (${m})`).run(...ids);
    }
    moveEvents(client, id, chatId, rows);
    for (const [seq, turn] of byTurn) client.query("update deleted_events set by_turn = ? where seq = ? and deletion_id = ?").run(turn, seq, id);
    return { ok: true, id, purgeAt, seqs: rows.map((r) => r.seq) };
  }).immediate();
}

// ---- undo -----------------------------------------------------------------------------------------------

/**
 * What the waker's trigger memo (agent/triggers.ts `TriggerScan`) must start over on: anything a deletion did in
 * chat `chatId`. It changes with every delete (a new deletion, or rows or turns joining one), undo and purge.
 */
export function deletionsMark(db: Db, chatId: number): string {
  const r = db.$client
    .query(
      "select (select count(*) from deleted_events where chat_id = ?1) as n, (select count(*) from deleted_turns where chat_id = ?1) as t, (select coalesce(max(seq), 0) from sqlite_sequence where name = 'deletions') as d",
    )
    .get(chatId) as { n: number; t: number; d: number };
  return `${r.n}:${r.t}:${r.d}`;
}

/** A deletion still in its window: what the console's notice and snackbar say. */
export interface DeletionSummary {
  id: number;
  chatId: number;
  purgeAt: string;
  /** Every message it holds, her reactions not counted. */
  count: number;
  /** The turns it holds, each with the messages its delete took (`turnMessageCount`), in order. */
  turns: { id: number; messages: number }[];
  /** Its messages deleted by themselves, not with a turn. */
  loose: number;
}

export function deletionOf(db: Db, id: number): DeletionSummary | undefined {
  const q = db.$client;
  const d = q.query("select id, chat_id as chatId, purge_at as purgeAt from deletions where id = ?").get(id) as { id: number; chatId: number; purgeAt: string } | null;
  if (!d) return undefined;
  const count = countOf(q, id);
  const turns = q
    .query("select t.id, (select count(*) from deleted_events e where e.deletion_id = t.deletion_id and e.by_turn = t.id and e.kind <> 'bot_reaction') as messages from deleted_turns t where t.deletion_id = ? order by t.id")
    .all(id) as { id: number; messages: number }[];
  return { ...d, count, turns, loose: count - turns.reduce((n, t) => n + t.messages, 0) };
}

/**
 * What a deletion is called, the same on the snackbar and the no-script notice: "3 messages", "turn 12 and its 5
 * messages", "turn 12 and its 5 messages, and 2 more messages", "2 turns and their 9 messages".
 */
export function deletionLabel(d: Pick<DeletionSummary, "count" | "turns" | "loose">): string {
  const msgs = (n: number) => `${n} message${n === 1 ? "" : "s"}`;
  if (!d.turns.length) return msgs(d.count);
  const inTurns = d.count - d.loose;
  const head =
    d.turns.length === 1
      ? `turn ${d.turns[0]!.id}${inTurns ? ` and its ${msgs(inTurns)}` : ""}`
      : `${d.turns.length} turns${inTurns ? ` and their ${msgs(inTurns)}` : ""}`;
  return d.loose ? `${head}, and ${d.loose} more message${d.loose === 1 ? "" : "s"}` : head;
}

/**
 * Put deletion `id` back as it was, while its window is open. Refused, with the reason, once the chat has moved
 * on: a turn has started since the (first) delete, a turn running now has taken in messages past one of them, or
 * the cursor has passed one that was ahead of it. Put back then, a message would sit behind the cursor and never
 * be answered, or inside a turn's range as input the model never saw.
 */
export function undoDeletion(db: Db, id: number, now = Date.now()): UndoResult {
  const client = db.$client;
  return client.transaction((): UndoResult => {
    const d = client.query("select chat_id, purge_at, cursor_seq, last_turn_id from deletions where id = ?").get(id) as { chat_id: number; purge_at: string; cursor_seq: number; last_turn_id: number } | null;
    if (!d || Date.parse(d.purge_at) <= now) return { ok: false, refused: "Too late to undo: those messages are gone for good." };
    const rows = client.query(`select ${COLUMNS} from deleted_events where deletion_id = ? order by seq`).all(id) as Row[];
    const inbound = rows.filter((r) => (TRIGGER_KINDS as readonly string[]).includes(r.kind)).map((r) => r.seq);
    if (client.query("select 1 from turns where chat_id = ? and id > ? limit 1").get(d.chat_id, d.last_turn_id)) {
      return { ok: false, refused: "Too late to undo: she has started a turn in this chat since, so they cannot be put back where they were." };
    }
    const running = client.query("select from_seq, to_seq from turns where chat_id = ? and status = 'running'").all(d.chat_id) as { from_seq: number; to_seq: number }[];
    if (inbound.some((s) => running.some((t) => s > t.from_seq && s <= t.to_seq))) {
      return { ok: false, refused: "Too late to undo: the turn running now has taken in the messages around them, so they would show as input she never saw." };
    }
    const cursor = (client.query("select cursor_seq as c from chats where id = ?").get(d.chat_id) as { c: number }).c;
    if (inbound.some((s) => s > d.cursor_seq && s <= cursor)) return { ok: false, refused: "Too late to undo: the chat has moved past them since, so they would never be answered." };
    try {
      client.query(`insert into chat_events (${COLUMNS}) select ${COLUMNS} from deleted_events where deletion_id = ? order by seq`).run(id);
    } catch (e) {
      // A unique key (an update id, an idempotency key) taken again meanwhile: leave the deletion as it is.
      return { ok: false, refused: `They cannot be put back: ${e instanceof Error ? e.message : String(e)}` };
    }
    // The insert trigger indexed the people's messages; hers are indexed once delivered (as the update trigger does).
    const sent = rows.filter((r) => r.kind === "bot_message" && r.status === "sent").map((r) => r.seq);
    if (sent.length) client.query(`insert or replace into chat_events_fts (rowid, text) select seq, json_extract(payload, '$.text') from chat_events where seq in (${marks(sent.length)})`).run(...sent);
    // Its turns back as they were, before any scrub is restored (one made before the turn was deleted, in the same
    // deletion, is then found in place): the turn first, as its steps and transcript refer to it.
    const turns = (client.query("select count(*) as n from deleted_turns where deletion_id = ?").get(id) as { n: number }).n;
    for (const [table, stashed] of [
      ["turns", "deleted_turns"],
      ["turn_transcripts", "deleted_turn_transcripts"],
      ["turn_steps", "deleted_turn_steps"],
    ] as const) {
      const cols = columnsOf(client, table);
      client.query(`insert into ${table} (${cols}) select ${cols} from ${stashed} where deletion_id = ?`).run(id);
      client.query(`delete from ${stashed} where deletion_id = ?`).run(id);
    }
    const scrubs = client.query("select target, ref, original, scrubbed from deletion_scrubs where deletion_id = ? order by id desc").all(id) as {
      target: "event" | "transcript" | "step";
      ref: number;
      original: string;
      scrubbed: string;
    }[];
    for (const s of scrubs) restore(client, s);
    client.query(`delete from deleted_events where deletion_id = ?`).run(id);
    client.query("delete from deletion_scrubs where deletion_id = ?").run(id);
    client.query("delete from deletions where id = ?").run(id);
    return { ok: true, count: rows.filter((r) => r.kind !== "bot_reaction").length, turns };
  }).immediate();
}

/** Write one stashed original back: whole when nothing changed it since the scrub, else (a reply) its quote alone. */
function restore(client: Database, s: { target: "event" | "transcript" | "step"; ref: number; original: string; scrubbed: string }): void {
  if (s.target === "transcript") {
    client.query("update turn_transcripts set input = ? where turn_id = ? and input = ?").run(s.original, s.ref, s.scrubbed);
    return;
  }
  if (s.target === "step") {
    const o = parse<StepColumns>(s.original);
    const w = parse<StepColumns>(s.scrubbed);
    const cols = Object.keys(w) as (keyof StepColumns)[];
    client
      .query(`update turn_steps set ${cols.map((c) => `${c} = ?`).join(", ")} where id = ? and ${cols.map((c) => `${c} is ?`).join(" and ")}`)
      .run(...cols.map((c) => o[c] ?? null), s.ref, ...cols.map((c) => w[c] ?? null));
    return;
  }
  // A reply: the same deletion may have taken it too since, but the undo has put it back already.
  const row = client.query("select payload from chat_events where seq = ?").get(s.ref) as { payload: string } | null;
  if (!row) return;
  if (row.payload === s.scrubbed) client.query("update chat_events set payload = ? where seq = ?").run(s.original, s.ref);
  else {
    const now = parse<MessagePayload>(row.payload);
    const quote = parse<MessagePayload>(s.original).replyTo?.text;
    if (now.replyTo && quote !== undefined) client.query("update chat_events set payload = ? where seq = ?").run(JSON.stringify({ ...now, replyTo: { ...now.replyTo, text: quote } }), s.ref);
  }
}

// ---- purge ----------------------------------------------------------------------------------------------

/**
 * Make every deletion whose window has closed final: drop its rows and stash, then the files under `media/`
 * that only its rows referred to. Returns how many deletions and files went.
 */
export function purgeDeletions(db: Db, dataDir: string, now = Date.now()): { deletions: number; files: number } {
  const client = db.$client;
  const due = client.query("select id from deletions where purge_at <= ? order by id").all(new Date(now).toISOString()) as { id: number }[];
  if (!due.length) return { deletions: 0, files: 0 };
  const ids = due.map((d) => d.id);
  const m = marks(ids.length);
  // The earliest of them: a transcript picture touched since (minus REUSE_GRACE_MS) may be in use again (below).
  const since = Date.parse((client.query(`select min(created_at) as c from deletions where id in (${m})`).get(...ids) as { c: string }).c) - REUSE_GRACE_MS;
  const paths = client.transaction(() => {
    const media = new Set(
      (client.query(`select distinct json_extract(payload, '$.media.path') as p from deleted_events where deletion_id in (${m}) and kind = 'message'`).all(...ids) as { p: string | null }[])
        .map((r) => r.p)
        .filter((p): p is string => !!p),
    );
    // A deleted turn's pictures: those its input showed and those its steps recorded (results, appends).
    for (const r of client.query(`select input from deleted_turn_transcripts where deletion_id in (${m})`).all(...ids) as { input: string }[]) {
      for (const p of parse<TranscriptPart[]>(r.input)) if (p.type === "image") media.add(p.ref);
    }
    for (const r of client.query(`select images from deleted_turn_steps where deletion_id in (${m}) and images is not null`).all(...ids) as { images: string }[]) {
      for (const i of parse<{ ref: string }[]>(r.images)) media.add(i.ref);
    }
    // Exactly-once keys stay spent: a retried webhook (the same Idempotency-Key), a schedule or a job reporting
    // again, is dropped as if the row were still there (store/events.ts `idemKeySpent`). The key alone is kept.
    client.query(`insert or ignore into spent_idem_keys (key) select idem_key from deleted_events where deletion_id in (${m}) and idem_key is not null`).run(...ids);
    const prompts = (client.query(`select distinct prompt_hash as h from deleted_turn_transcripts where deletion_id in (${m}) and prompt_hash is not null`).all(...ids) as { h: string }[]).map((r) => r.h);
    for (const t of ["deleted_events", "deletion_scrubs", "deleted_turn_steps", "deleted_turn_transcripts", "deleted_turns"]) client.query(`delete from ${t} where deletion_id in (${m})`).run(...ids);
    client.query(`delete from deletions where id in (${m})`).run(...ids);
    // A system prompt is shared by hash between turns: only one nothing else points at goes.
    if (prompts.length) {
      client
        .query(
          `delete from prompt_texts where hash in (${marks(prompts.length)}) and not exists (select 1 from turn_transcripts where prompt_hash = prompt_texts.hash) and not exists (select 1 from deleted_turn_transcripts where prompt_hash = prompt_texts.hash)`,
        )
        .run(...prompts);
    }
    // A file another row or the library still names stays. (One downloaded for a message deleted meanwhile is
    // the downloader's to remove: vision/download.ts.)
    return [...media].filter((p) => !mediaInUse(db, p));
  }).immediate();
  let files = 0;
  const root = join(dataDir, "media");
  for (const p of paths) {
    if (!/^media\/(?:transcript\/)?[A-Za-z0-9._-]+$/.test(p)) continue;
    const abs = join(dataDir, p);
    if (!existsSync(abs)) continue;
    try {
      if (!realpathSync(abs).startsWith(`${realpathSync(root)}${sep}`)) continue;
      // A transcript picture is content-addressed and shared: a runner in any chat that shows the same bytes again
      // touches it (agent/transcript.ts `imageRef`) before it writes the step naming it, after the check above. One
      // touched since the deletion is left to the transcripts' own pruning by age (`pruneTranscriptMedia`).
      if (p.startsWith(`${TRANSCRIPT_MEDIA}/`) && statSync(abs).mtimeMs >= since) continue;
      rmSync(abs);
      files++;
    } catch (e) {
      console.error(`deletions: could not remove ${p}:`, e instanceof Error ? e.message : e);
    }
  }
  return { deletions: ids.length, files };
}
