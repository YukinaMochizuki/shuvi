import { and, desc, eq, gt, isNotNull, isNull, lt } from "drizzle-orm";
import { describe, PorchkitError, type Porchkit, type Probe } from "../../porchkit/client.ts";
import type { Db } from "../../store/db.ts";
import type { ChatEvent, MessagePayload } from "../../store/events.ts";
import { mediaPrewarms } from "../../store/schema.ts";
import { urlKey, videoLinks } from "./links.ts";
import { storedProbe } from "./text.ts";

/**
 * PREWARM (docs: media/index.ts): an owner's message with a link to a known video host is probed through
 * porchkit the moment it is recorded (`speculative: true`, so porchkit refuses it when the site's budget is
 * more than half used), while the waker spawns the turn. Probe only, never a fetch; best effort: a failure
 * is logged (never the URL) and forgotten.
 *
 * WHAT IS KEPT: a row per link with the link's hash (no URL) and host, and for an hour the probe's answer as
 * `probeText` reads it (`storedProbe`: title, uploader, length, chapters, subtitle languages; no URL), so a
 * joined `video_probe` needs no second request. After that `media-prune` drops the answer and only the
 * accounting stays. (The link itself is in the message, in `chat_events`, like everything said.)
 *
 * Every row is written BEFORE the request goes out, synchronously in the server's inbound hook, so a turn
 * whose input is rendered after that sees it (the "(Prepared: …)" line, `preparedLines`), and a
 * `video_probe` of the same link joins it (`joinedProbe`) instead of asking porchkit a second time: the
 * server and the runner child are different processes, so they meet in the store.
 */

export type Prewarm = typeof mediaPrewarms.$inferSelect;

/**
 * How long a prewarm's answer is reused, and its line shown: well inside porchkit's own 6 h probe cache, and
 * long enough for the turn the message started (or the next one).
 */
export const PREWARM_FRESH_MS = 60 * 60_000;
/** A prewarm in flight longer than this is taken as lost (the server restarted under it). */
export const PREWARM_STALE_MS = 150_000;
/**
 * The longest a `video_probe` waits on a prewarm in flight before asking porchkit itself: a prewarm lost to
 * a server restart never finishes, and a slow one is joined at porchkit anyway (it shares identical
 * concurrent requests, and caches the answer), so asking again costs little.
 */
export const JOIN_WAIT_MS = 15_000;

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Start the prewarms of `event`, if it is the owner's message and has links to known hosts. The rows are
 * written now; the requests are left running (their promise is returned for tests). The requests never
 * throw; the synchronous insert can (a busy store), and the caller (capabilityInbound) logs that.
 */
export function startPrewarms(db: Db, porch: Porchkit, event: ChatEvent, ownerId: number, now = Date.now()): Promise<void> {
  if (event.kind !== "message") return Promise.resolve();
  const p = event.payload as unknown as MessagePayload;
  if (p.from?.id !== ownerId || !p.text) return Promise.resolve();
  const flights: Promise<void>[] = [];
  videoLinks(p.text).forEach((link, i) => {
    const row = db
      .insert(mediaPrewarms)
      .values({ chatId: event.chatId, seq: event.seq, n: i + 1, urlHash: urlKey(link.url), host: link.host, startedAt: iso(now) })
      .onConflictDoNothing()
      .returning()
      .get();
    if (!row) return; // already started (the hook ran twice)
    flights.push(
      porch.probe(link.url, true).then(
        (probe) => finishPrewarm(db, row.id, "ok", storedProbe(probe) as unknown as Record<string, unknown>),
        (e: unknown) => {
          const code = e instanceof PorchkitError ? e.code : "failed";
          finishPrewarm(db, row.id, code, null);
          console.log(`media: prewarm of #${event.seq}'s link ${i + 1} (${link.host}) failed: ${code}${e instanceof PorchkitError ? "" : ` (${describe(e)})`}`);
        },
      ),
    );
  });
  return Promise.all(flights).then(() => undefined);
}

export function finishPrewarm(db: Db, id: number, outcome: string, result: Record<string, unknown> | null, now = Date.now()): void {
  try {
    db.update(mediaPrewarms).set({ finishedAt: iso(now), outcome, result }).where(eq(mediaPrewarms.id, id)).run();
  } catch (e) {
    console.log(`media: could not record prewarm ${id}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function prewarmsOf(db: Db, seq: number): Prewarm[] {
  return db.select().from(mediaPrewarms).where(eq(mediaPrewarms.seq, seq)).orderBy(mediaPrewarms.n).all();
}

const inFlight = (r: Prewarm, now: number) => r.finishedAt === null && now - Date.parse(r.startedAt) < PREWARM_STALE_MS;

/**
 * The lines shown after a message's line for its prewarmed links: what is ready or in flight, never what it
 * found. None for a link whose prewarm failed, or that is older than `PREWARM_FRESH_MS`.
 */
export function preparedLines(db: Db, event: ChatEvent, now = Date.now()): string[] {
  const every = prewarmsOf(db, event.seq);
  const rows = every.filter((r) => now - Date.parse(r.startedAt) < PREWARM_FRESH_MS);
  const all = every.length;
  const name = (r: Prewarm) => (all > 1 ? `#${event.seq}'s link ${r.n} (${r.host})` : `#${event.seq}'s link`);
  return rows.flatMap((r) => {
    if (r.outcome === "ok") return [`(Prepared: ${name(r)} — video_probe returns at once.)`];
    if (inFlight(r, now)) return [`(Preparing: ${name(r)} — video_probe joins it.)`];
    return [];
  });
}

/** Mark the chat's recent prewarms of `hash` as used by `turnId` (the first turn to ask counts). */
export function markUsed(db: Db, chatId: number, hash: string, turnId: number, now = Date.now()): void {
  db.update(mediaPrewarms)
    .set({ usedTurnId: turnId, usedAt: iso(now) })
    .where(and(eq(mediaPrewarms.chatId, chatId), eq(mediaPrewarms.urlHash, hash), isNull(mediaPrewarms.usedTurnId), gt(mediaPrewarms.startedAt, iso(now - PREWARM_FRESH_MS))))
    .run();
}

/** The chat's newest fresh prewarm of `hash`. */
function latest(db: Db, chatId: number, hash: string, now: number): Prewarm | undefined {
  return db
    .select()
    .from(mediaPrewarms)
    .where(and(eq(mediaPrewarms.chatId, chatId), eq(mediaPrewarms.urlHash, hash), gt(mediaPrewarms.startedAt, iso(now - PREWARM_FRESH_MS))))
    .orderBy(desc(mediaPrewarms.id))
    .get();
}

/** In this process, the probes in flight by link key: two `video_probe` calls of one link share one request. */
const flights = new Map<string, Promise<Probe>>();

/**
 * `video_probe`'s request, SINGLE-FLIGHT: a prewarm of the same link in this chat that is still in flight is
 * waited for (in the store, polled), and its answer used; one that answered is used as it is. Otherwise (none,
 * or it failed, e.g. refused as speculative) porchkit is asked, once per link however many calls ask at once.
 * The prewarm, if any, is marked used by `turnId`.
 */
export async function joinedProbe(db: Db, porch: Porchkit, chatId: number, turnId: number, url: string, opts: { pollMs?: number; waitMs?: number } = {}): Promise<{ probe: Probe; joined: "prewarm" | "flight" | null }> {
  const hash = urlKey(url);
  markUsed(db, chatId, hash, turnId);
  const end = Date.now() + (opts.waitMs ?? JOIN_WAIT_MS);
  let row = latest(db, chatId, hash, Date.now());
  while (row && inFlight(row, Date.now()) && Date.now() < end) {
    await Bun.sleep(opts.pollMs ?? 100);
    row = db.select().from(mediaPrewarms).where(eq(mediaPrewarms.id, row.id)).get();
  }
  if (row?.outcome === "ok" && row.result) return { probe: row.result as unknown as Probe, joined: "prewarm" };
  const shared = flights.get(hash);
  if (shared) return { probe: await shared, joined: "flight" };
  const p = porch.probe(url).finally(() => flights.delete(hash));
  flights.set(hash, p);
  return { probe: await p, joined: null };
}

/** Drop the answers of prewarms older than `PREWARM_FRESH_MS` (the accounting stays). Returns how many. */
export function pruneResults(db: Db, now = Date.now()): number {
  return db
    .update(mediaPrewarms)
    .set({ result: null })
    .where(and(lt(mediaPrewarms.startedAt, iso(now - PREWARM_FRESH_MS)), isNotNull(mediaPrewarms.result)))
    .returning({ id: mediaPrewarms.id })
    .all().length;
}
