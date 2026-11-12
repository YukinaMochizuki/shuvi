import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, lt, notInArray, sql } from "drizzle-orm";
import type { Db } from "./db.ts";
import { kv, promptTexts, turns, turnSteps, turnTranscripts, type TranscriptPart } from "./schema.ts";

/**
 * Turn transcripts in the store (schema.ts `prompt_texts`, `turn_transcripts`, `turn_steps`): written by
 * the runner child through agent/transcript.ts, read by the console (src/console/), pruned by
 * the server's transcript loop (server/main.ts).
 *
 * Nothing here decides anything about a turn: a transcript is a record for people. The writers are called
 * best effort (a throw is caught and logged by the recorder), and nothing in the turn waits on them beyond
 * one local SQLite write.
 *
 * PRUNING (`pruneTranscripts`) removes the transcript of every turn that ended before the cutoff (its steps
 * and its `turn_transcripts` row), then every prompt text no transcript points at. It never touches
 * `chat_events`, and keeps the `turns` row itself, with its usage: the console still lists the turn, with
 * no timeline.
 *
 * WHY A TURN HAS NO TRANSCRIPT (`transcriptAbsence`): the first turn ever recorded is kept in `kv`
 * (FIRST_RECORDED_KEY), set by the first transcript written and, for a store recorded before that key
 * existed, by the first pruning pass, from the oldest transcript left (nothing had been pruned before then).
 * So a turn before it ran before recording began; one after it whose transcript is gone and that ended
 * past the retention window was pruned; any other was not recorded (it never reached the model).
 */

/** `kv` key: the id of the first turn whose transcript was ever recorded. */
export const FIRST_RECORDED_KEY = "transcripts.first_turn";

/** Note that recording has begun, at turn `turnId`, if it was not noted already. */
export function markRecordingStarted(db: Db, turnId: number): void {
  // Through the query builder, not `$client`: this runs inside the recorder's transaction, whose handle has none.
  db.insert(kv).values({ key: FIRST_RECORDED_KEY, value: String(turnId) }).onConflictDoNothing().run();
}

/** The first turn whose transcript was ever recorded, with when it started; null before any was. */
export function firstRecordedTurn(db: Db): { id: number; startedAt: string } | null {
  const kv = db.$client.query("select value from kv where key = ?").get(FIRST_RECORDED_KEY) as { value: string } | null;
  const id = kv ? Number(kv.value) : (db.$client.query("select min(turn_id) as id from turn_transcripts").get() as { id: number | null }).id;
  if (id === null || !Number.isSafeInteger(id)) return null;
  const t = db.$client.query("select started_at as startedAt from turns where id = ?").get(id) as { startedAt: string } | null;
  return t ? { id, startedAt: t.startedAt } : null;
}

/**
 * Why turn `turn` has no transcript: it ran `before` recording began (with the first recorded turn), its
 * transcript was `pruned` (it ended more than `days` ago), or it was `missing` (never recorded).
 */
export function transcriptAbsence(
  db: Db,
  turn: { id: number; endedAt: string | null },
  days: number,
  now = Date.now(),
): { why: "before"; first: { id: number; startedAt: string } | null } | { why: "pruned"; days: number } | { why: "missing" } {
  const first = firstRecordedTurn(db);
  if (!first || turn.id < first.id) return { why: "before", first };
  if (turn.endedAt && Date.parse(turn.endedAt) < now - days * 24 * 3600_000) return { why: "pruned", days };
  return { why: "missing" };
}

export type Step = typeof turnSteps.$inferSelect;
export type Transcript = typeof turnTranscripts.$inferSelect;
export type PromptText = typeof promptTexts.$inferSelect;
export type StepInsert = Omit<typeof turnSteps.$inferInsert, "id" | "turnId" | "n">;

export const hashText = (s: string) => createHash("sha256").update(s).digest("hex");

/** Store a system prompt once, by its hash; returns the hash. */
export function savePrompt(db: Db, text: string, sections: PromptText["sections"]): string {
  const hash = hashText(text);
  db.insert(promptTexts).values({ hash, text, sections }).onConflictDoNothing().run();
  return hash;
}

/** Record (or replace: a lost conversation run again) what a turn sent the model to open with. */
export function saveTranscript(db: Db, turnId: number, t: { promptHash: string | null; input: TranscriptPart[]; resumed: boolean }): void {
  db.insert(turnTranscripts)
    .values({ turnId, ...t })
    .onConflictDoUpdate({ target: turnTranscripts.turnId, set: { promptHash: t.promptHash, input: t.input, resumed: t.resumed } })
    .run();
}

export function setTranscriptModel(db: Db, turnId: number, model: string): void {
  db.update(turnTranscripts).set({ model }).where(eq(turnTranscripts.turnId, turnId)).run();
}

export function addStep(db: Db, turnId: number, n: number, step: StepInsert): void {
  db.insert(turnSteps)
    .values({ ...step, turnId, n })
    .onConflictDoUpdate({ target: [turnSteps.turnId, turnSteps.n], set: step })
    .run();
}

/** Complete a tool call's running row in place, by its call id. */
export function completeStep(db: Db, turnId: number, callId: string, step: Partial<StepInsert>): boolean {
  const r = db
    .update(turnSteps)
    .set(step)
    .where(and(eq(turnSteps.turnId, turnId), eq(turnSteps.callId, callId), eq(turnSteps.kind, "tool")))
    .returning({ id: turnSteps.id })
    .all();
  return r.length > 0;
}

export function getTranscript(db: Db, turnId: number): Transcript | undefined {
  return db.select().from(turnTranscripts).where(eq(turnTranscripts.turnId, turnId)).get();
}

export function getPromptText(db: Db, hash: string): PromptText | undefined {
  return db.select().from(promptTexts).where(eq(promptTexts.hash, hash)).get();
}

export function stepsOf(db: Db, turnId: number): Step[] {
  return db.select().from(turnSteps).where(eq(turnSteps.turnId, turnId)).orderBy(asc(turnSteps.n)).all();
}

/**
 * The prompt of the turn before `turnId` in the same chat that has one still stored (for the console's
 * diff), with that turn's id.
 */
export function previousPrompt(db: Db, chatId: number, turnId: number): { turnId: number; prompt: PromptText } | null {
  const row = db
    .select({ turnId: turnTranscripts.turnId, hash: turnTranscripts.promptHash })
    .from(turnTranscripts)
    .innerJoin(turns, eq(turns.id, turnTranscripts.turnId))
    .where(and(eq(turns.chatId, chatId), lt(turns.id, turnId), isNotNull(turnTranscripts.promptHash)))
    .orderBy(sql`${turns.id} desc`)
    .limit(1)
    .get();
  const prompt = row?.hash ? getPromptText(db, row.hash) : undefined;
  return row && prompt ? { turnId: row.turnId, prompt } : null;
}

/** What one pruning pass removed. */
export interface Pruned {
  transcripts: number;
  steps: number;
  prompts: number;
}

/**
 * Remove the transcripts of turns that ended before `before` (ISO), then the prompt texts nothing points at.
 * In batches, so a first run over a large store does not hold the write lock for long.
 */
export function pruneTranscripts(db: Db, before: string, batch = 500): Pruned {
  const out: Pruned = { transcripts: 0, steps: 0, prompts: 0 };
  // Before anything is pruned, note where recording began (a store recorded before the key existed).
  db.$client.exec(`insert into kv (key, value) select '${FIRST_RECORDED_KEY}', cast(min(turn_id) as text) from turn_transcripts where true having min(turn_id) is not null on conflict (key) do nothing`);
  for (;;) {
    const ids = db
      .select({ id: turns.id })
      .from(turns)
      .where(
        and(
          lt(turns.endedAt, before),
          sql`(exists (select 1 from ${turnSteps} where ${turnSteps.turnId} = ${turns.id}) or exists (select 1 from ${turnTranscripts} where ${turnTranscripts.turnId} = ${turns.id}))`,
        ),
      )
      .limit(batch)
      .all()
      .map((r) => r.id);
    if (!ids.length) break;
    db.transaction((tx) => {
      out.steps += tx.delete(turnSteps).where(inArray(turnSteps.turnId, ids)).returning({ id: turnSteps.id }).all().length;
      out.transcripts += tx.delete(turnTranscripts).where(inArray(turnTranscripts.turnId, ids)).returning({ id: turnTranscripts.turnId }).all().length;
    });
    if (ids.length < batch) break;
  }
  const used = db.selectDistinct({ h: turnTranscripts.promptHash }).from(turnTranscripts).where(isNotNull(turnTranscripts.promptHash));
  out.prompts = db.delete(promptTexts).where(notInArray(promptTexts.hash, used)).returning({ h: promptTexts.hash }).all().length;
  return out;
}
