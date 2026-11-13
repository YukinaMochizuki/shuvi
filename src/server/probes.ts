import { listOpenAICompatModels, probeModel, type ModelProbe, type OpenAICompatProvider } from "agent-runtime/openai-compat";
import { providerKey } from "../agent/backend.ts";
import { cardsListing, catalogChanged, finishListing } from "../control/model-cards.ts";
import type { Db } from "../store/db.ts";
import { getProvider, modelByRowId, modelsToProbe, recordProbe, type ProbeRecord, type Provider } from "../store/models.ts";
import { IMMEDIATE } from "../store/turns.ts";

/**
 * The server's background work on the model catalog (docs/design.md §13), for OpenAI-compatible providers only:
 *
 *   PROBES    a model whose row asks for one (`probe_started_at`; store/models.ts `markProbing`: on add, and on
 *             Re-probe in `/models` or the console) is probed with agent-runtime `probeModel`: one small request
 *             offering a tool, then a small picture unless the owner set the model's vision himself. Its result
 *             is written to the row (`recordProbe`), and the cards showing it are edited (control/model-cards.ts
 *             `catalogChanged`).
 *   LISTINGS  a `/provider add` card waiting for its endpoint's `/models` gets the list
 *             (agent-runtime `listOpenAICompatModels`), or the reason there is none.
 *
 * Both are background promises held HERE, in the server only: the rows say what is asked, so a probe or a
 * listing a restart interrupted is simply started again by the next pass (`backgroundPass`). One at a time per
 * model and per card. The rows are also how one is STOPPED: a probe cancelled (`cancelProbe`) or asked again, a
 * listing card closed, or either's row removed, and the next pass aborts its request in flight; its result,
 * if any, is dropped. The key is read from the secrets file as a turn reads it (agent/backend.ts), only to
 * send it; any trace of it in an endpoint's error is cut before it is stored.
 */

export interface BackgroundDeps {
  /** The secrets file a provider's key is read from (env.ts `SHUVI_SECRETS_FILE`). */
  secretsFile: string;
  /** How long one probe request or listing may take. Default 5 minutes: a scaled-to-zero endpoint boots first. */
  timeoutMs?: number;
  /** Test seam. */
  fetch?: typeof fetch;
}

/** How long one probe request or listing may take by default (the console shows it beside the time waited). */
export const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** A probe or listing running in this process: what it was started for, how to stop it, and its end. */
interface Job {
  /** A probe's `probe_started_at` when it was started: the row asks for THIS probe only while it still says so. */
  asked?: string;
  ctl: AbortController;
  done: Promise<void>;
}

const probing = new Map<number, Job>();
const listing = new Map<number, Job>();

/** Test seam: resolves once every probe and listing started so far has written its result. */
export async function backgroundSettled(): Promise<void> {
  while (probing.size || listing.size) await Promise.all([...probing.values(), ...listing.values()].map((j) => j.done));
}

function start(jobs: Map<number, Job>, id: number, what: string, asked: string | undefined, run: (signal: AbortSignal) => Promise<void>): void {
  const ctl = new AbortController();
  const job: Job = {
    ...(asked ? { asked } : {}),
    ctl,
    done: run(ctl.signal)
      .catch((e) => console.error(`${what}: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => jobs.get(id) === job && jobs.delete(id)),
  };
  jobs.set(id, job);
}

/**
 * Abort every running probe and listing its row no longer asks for (cancelled from the console or the control
 * bot, asked again, or removed), then start every one the rows ask for that is not running. An aborted one
 * keeps its place until it has ended, so a probe asked again starts at the pass after. Returns how many it
 * started.
 */
export function backgroundPass(db: Db, deps: BackgroundDeps): number {
  const probes = new Map(modelsToProbe(db).map((m) => [m.model.id, m.model.probeStartedAt!]));
  const cards = new Map(cardsListing(db).map((c) => [c.cardId, c.provider]));
  for (const [id, job] of probing) if (probes.get(id) !== job.asked) job.ctl.abort();
  for (const [id, job] of listing) if (!cards.has(id)) job.ctl.abort();
  let started = 0;
  for (const [rowId, asked] of probes) {
    if (probing.has(rowId)) continue;
    start(probing, rowId, `probe of model row ${rowId}`, asked, (signal) => runProbe(db, rowId, asked, signal, deps));
    started++;
  }
  for (const [cardId, provider] of cards) {
    if (listing.has(cardId)) continue;
    start(listing, cardId, `listing for card ${cardId}`, undefined, (signal) => runListing(db, cardId, provider, signal, deps));
    started++;
  }
  return started;
}

/** The provider as agent-runtime sends to it, with its key read from the secrets file. */
function connection(p: Provider, secretsFile: string): OpenAICompatProvider {
  if (!p.baseUrl) throw new Error(`the provider "${p.name}" has no base URL`);
  const apiKey = p.apiKey ? providerKey(p.apiKey, secretsFile) : undefined;
  return { name: p.name, baseURL: p.baseUrl, ...(apiKey ? { apiKey } : {}) };
}

/** Cut the key out of what an endpoint said. */
const scrub = (text: string, c: OpenAICompatProvider | null) => (c?.apiKey ? text.split(c.apiKey).join("[key]") : text);

const clip = (s: string, n = 200) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A probe's result as the row keeps it. */
export function probeRecord(r: ModelProbe, clean: (s: string) => string = (s) => s): ProbeRecord {
  const vision = r.vision?.result === "accepted" ? true : r.vision?.result === "rejected" ? false : null;
  switch (r.toolCall) {
    case "ok":
      return { status: "ok", error: null, latencyMs: r.latencyMs, vision };
    case "text-instead":
      return { status: "text-instead", error: r.text ? clip(clean(`it wrote: ${r.text}`)) : null, latencyMs: r.latencyMs, vision };
    case "error":
      return { status: "failed", error: clip(clean(r.error ? `${r.error.kind}: ${r.error.message}` : "unknown error")), latencyMs: r.latencyMs, vision };
    default:
      throw new Error(`unknown probe result "${String(r.toolCall satisfies never)}"`);
  }
}

async function runProbe(db: Db, rowId: number, asked: string, signal: AbortSignal, deps: BackgroundDeps): Promise<void> {
  const m = modelByRowId(db, rowId);
  if (!m) return;
  let c: OpenAICompatProvider | null = null;
  let record: ProbeRecord;
  try {
    c = connection(m.provider, deps.secretsFile);
    const r = await probeModel(c, m.model.model, { timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal, vision: !m.model.visionSet, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    record = probeRecord(r, (s) => scrub(s, c));
  } catch (e) {
    // probeModel answers for the endpoint; this is a key that cannot be read, or a bug: still a result.
    record = { status: "failed", error: clip(scrub(e instanceof Error ? e.message : String(e), c)), latencyMs: null, vision: null };
  }
  if (signal.aborted) return; // no longer asked: whatever it got is not this row's result
  db.transaction((tx) => {
    const t = tx as unknown as Db;
    // Cancelled, asked again or removed meanwhile: the row still names this probe only if it is the one it asks for.
    if (modelByRowId(t, rowId)?.model.probeStartedAt !== asked) return;
    recordProbe(t, rowId, record);
    catalogChanged(t);
  }, IMMEDIATE);
}

async function runListing(db: Db, cardId: number, providerName: string, signal: AbortSignal, deps: BackgroundDeps): Promise<void> {
  const p = getProvider(db, providerName);
  let c: OpenAICompatProvider | null = null;
  let result: Parameters<typeof finishListing>[2];
  try {
    if (!p) throw new Error(`there is no provider named "${providerName}"`);
    c = connection(p, deps.secretsFile);
    const listed = await listOpenAICompatModels(c, deps.fetch ?? fetch, AbortSignal.any([signal, AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)]));
    result = { listed: listed.map((l) => ({ model: l.model, ...(l.reported.contextWindow ? { contextWindow: l.reported.contextWindow } : {}) })) };
  } catch (e) {
    result = { error: clip(scrub(e instanceof Error ? e.message : String(e), c)) };
  }
  if (signal.aborted) return; // the card was closed: there is nothing to show it on
  db.transaction((tx) => finishListing(tx as unknown as Db, cardId, result), IMMEDIATE);
}
