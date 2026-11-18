import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBound } from "../retrieval/logs.ts";
import { CODE_ROOT, gitLog, isShallow, RS, US } from "./git.ts";

/**
 * The release log: what changed in the code she runs, one entry per change that landed on main, newest
 * first, ending at the commit this code was built from.
 *
 * WHERE IT COMES FROM. There are no versions besides commits (a release is an image `:sha-<12>`,
 * .github/workflows/release.yml), and the image has no .git. So the log is `git log` itself, in ONE format
 * (./git.ts `GIT_LOG_ARGS`), read in one of two ways and parsed by the same `parseLog`:
 *   - a checkout with .git (development): `git log` is run on it;
 *   - the image: release.yml writes that same output to `release-log.txt` before the build
 *     (`bun src/capabilities/releases/git.ts > release-log.txt`, which refuses a shallow clone), and the
 *     Dockerfile copies it to the code root beside src/.
 * `SHUVI_RELEASE_LOG` names another file instead of either.
 *
 * THE NEWEST ENTRY IS WHAT RUNS. The image's file is written from the very commit it is built from. In a
 * checkout, `git log` starts at `SHUVI_COMMIT` when the deployment declares one (a sha), else at HEAD: each
 * turn is a new runner child that loads src/ from disk (server/spawn.ts), so HEAD is the code a turn runs,
 * even if the server process itself is older. A checkout on a branch lists that branch's commits too: there,
 * they are what runs.
 *
 * ONE ENTRY PER CHANGE. Only main's first parents are walked: a squash-merged PR is one commit, an older
 * merge commit stands for its whole branch (its diff against the first parent; its title is the PR title,
 * the first line of its body), and the branch's own commits are not listed.
 *
 * CLASSIFIED HERE, not by the model, so that a filter means the same thing every time:
 *   - type: `internal` when every file it touched is outside what runs (tests, scripts, CI, docs, the
 *     build, dependencies: `isInternalPath`) or its title says so (`test:`, `ci:`, `e2e…`, `Pin …`);
 *     else `fix` when its title starts with Fix (or `fix:` / `fix(…):`); else `feature`.
 *   - areas: what part of her it touched, from its files (`areaOf`), most files first, at most three.
 * The summary is the body's first paragraph of prose, without a squash's `* subject` lines or trailers.
 */

export type ReleaseType = "feature" | "fix" | "internal";
export const RELEASE_TYPES: readonly ReleaseType[] = ["feature", "fix", "internal"];

export interface Release {
  sha: string;
  /** When it landed on main (committer date), ISO. */
  at: string;
  pr: number | null;
  title: string;
  summary: string;
  type: ReleaseType;
  areas: string[];
}

const SUMMARY_MAX = 600;
const MAX_AREAS = 3;

/** Files whose change does not change what she does. */
export function isInternalPath(p: string): boolean {
  if (/^(test|tests|scripts|docs|\.github)\//.test(p)) return true;
  if (/\.md$/i.test(p)) return true;
  if (/^drizzle\/meta\//.test(p)) return true;
  return /^(Dockerfile|\.dockerignore|\.gitignore|\.gitattributes|package\.json|bun\.lock|drizzle\.config\.ts|tsconfig[^/]*\.json)$/.test(p);
}

/** The part of her a file belongs to, or null for one that names none (internal files, the store's migrations). */
export function areaOf(p: string): string | null {
  const cap = /^src\/capabilities\/([^/]+)\//.exec(p);
  if (cap) return cap[1]!;
  if (p.startsWith("src/console/")) return "console";
  if (p.startsWith("src/control/")) return "control bot";
  if (p.startsWith("src/policy/")) return "policy";
  if (p.startsWith("computer/")) return "computer";
  if (p.startsWith("src/")) return "core";
  if (p === "Dockerfile" || p.startsWith(".github/")) return "deploy";
  return null;
}

const INTERNAL_TITLE = /^(?:(?:test|tests|ci|chore|docs|build|refactor)(?:\([^)]*\))?!?:|e2e\b|ci\b|pin\s|refactor\b|rename\b)/i;
const FIX_TITLE = /^fix(?:e[sd])?(?:\b|\([^)]*\)!?:)/i;
/** A conventional-commit type, as in `feat(media): `: dropped from the title shown. */
const CONVENTIONAL = /^(?:feat|fix|perf|chore|refactor|docs|test|ci|build)(?:\([^)]*\))?!?:\s*/i;
/** An area prefix, as in `Console: ` or `Speech: `: looked past when classifying. */
const AREA_PREFIX = /^[A-Za-z][\w ./-]{0,30}:\s+/;

function classify(title: string, files: string[]): ReleaseType {
  const bare = title.replace(AREA_PREFIX, "");
  if (INTERNAL_TITLE.test(title) || INTERNAL_TITLE.test(bare)) return "internal";
  if (files.length > 0 && files.every(isInternalPath)) return "internal";
  if (FIX_TITLE.test(title) || FIX_TITLE.test(bare)) return "fix";
  return "feature";
}

function areasOf(files: string[]): string[] {
  const n = new Map<string, number>();
  for (const f of files) {
    if (isInternalPath(f) && !f.startsWith(".github/") && f !== "Dockerfile") continue;
    const a = areaOf(f);
    if (a) n.set(a, (n.get(a) ?? 0) + 1);
  }
  const ranked = [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([a]) => a);
  // `core` says little next to a named area: kept only where most of the change is (a refactor of the core
  // that touched one console file is core first, not console).
  const areas = ranked[0] === "core" ? ranked : ranked.filter((a) => a !== "core");
  return areas.slice(0, MAX_AREAS);
}

/** The first paragraph of prose in a body: no squash `* subject` lines, no trailers, folded to one line. */
export function summarize(body: string): string {
  const paras = body
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .split("\n")
        .filter((l) => !/^\s*\*\s/.test(l) && !/^[A-Z][\w-]*(?:-by|-authored-by):\s/i.test(l.trim()) && !/^-{3,}$/.test(l.trim()))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
  const first = paras[0] ?? "";
  return first.length > SUMMARY_MAX ? `${first.slice(0, SUMMARY_MAX - 1).replace(/\s+\S*$/, "")}…` : first;
}

const MERGE_PR = /^Merge pull request #(\d+) from \S+/;
const SQUASH_PR = /\s*\(#(\d+)\)\s*$/;

/** Parse `GIT_LOG_ARGS` output, newest first as git gives it. */
export function parseLog(text: string): Release[] {
  const out: Release[] = [];
  for (const rec of text.split(RS)) {
    if (!rec.trim()) continue;
    const f = rec.split(US);
    if (f.length < 6) continue;
    const [sha, at, parents, subject, body, rest] = f as [string, string, string, string, string, string];
    const files = rest.split("\n").map((l) => l.trim()).filter(Boolean);
    let title = subject.trim();
    let summaryBody = body;
    let pr: number | null = null;
    const merge = parents.trim().split(/\s+/).length > 1 ? MERGE_PR.exec(title) : null;
    if (merge) {
      pr = Number(merge[1]);
      // A merge commit's body is the PR's title, then (sometimes) its description.
      const lines = body.replace(/\r/g, "").split("\n");
      const head = lines.findIndex((l) => l.trim() !== "");
      if (head >= 0) {
        title = lines[head]!.trim();
        summaryBody = lines.slice(head + 1).join("\n");
      }
    } else {
      const sq = SQUASH_PR.exec(title);
      if (sq) {
        pr = Number(sq[1]);
        title = title.slice(0, sq.index).trim();
      }
    }
    const type = classify(title, files);
    out.push({ sha: sha.trim(), at: new Date(at.trim()).toISOString(), pr, title: title.replace(CONVENTIONAL, "") || title, summary: summarize(summaryBody), type, areas: areasOf(files) });
  }
  return out;
}

// ---- reading ------------------------------------------------------------------------------------------

export const LOG_FILE = "release-log.txt";

/** `rev`: where `git log` starts (the deployment's `SHUVI_COMMIT`); absent: HEAD. */
export type LogSource = { kind: "file"; path: string } | { kind: "git"; dir: string; rev?: string } | { kind: "none" };

/** Where this process reads its log: `SHUVI_RELEASE_LOG`, else git where there is a .git, else the built file. */
export function logSource(env: Record<string, string | undefined>, root = CODE_ROOT): LogSource {
  if (env.SHUVI_RELEASE_LOG) return { kind: "file", path: env.SHUVI_RELEASE_LOG };
  if (existsSync(join(root, ".git"))) {
    const rev = env.SHUVI_COMMIT?.trim();
    return /^[0-9a-f]{7,40}$/i.test(rev ?? "") ? { kind: "git", dir: root, rev: rev! } : { kind: "git", dir: root };
  }
  const file = join(root, LOG_FILE);
  return existsSync(file) ? { kind: "file", path: file } : { kind: "none" };
}

export type Loaded = { ok: true; releases: Release[]; shallow: boolean } | { ok: false; reason: string };

/** Read and parse the log. Read on every call: it is small, and the file never changes under a running image. */
export function loadReleases(source: LogSource): Loaded {
  try {
    if (source.kind === "none") return { ok: false, reason: "This deployment carries no release log (no .git, and no release-log.txt beside the code)." };
    if (source.kind === "file") {
      if (!existsSync(source.path)) return { ok: false, reason: `The release log ${source.path} is missing.` };
      return { ok: true, releases: parseLog(readFileSync(source.path, "utf8")), shallow: false };
    }
    return { ok: true, releases: parseLog(gitLog(source.dir, source.rev)), shallow: isShallow(source.dir) };
  } catch (e) {
    return { ok: false, reason: `The release log could not be read: ${(e as Error).message}` };
  }
}

// ---- selecting ----------------------------------------------------------------------------------------

export interface ReleaseQuery {
  /** After this point: a commit (prefix, or an image tag `sha-…`), `#PR`, a date or time, or `deployed`. */
  since?: string;
  /** Up to and including this point, in the same forms (no `deployed`). */
  until?: string;
  /** Default: feature and fix. */
  types?: ReleaseType[];
  /** Only entries touching one of these areas. */
  areas?: string[];
  limit: number;
}

/** A point in the log: the index of an entry (newest = 0), or an instant. */
type Point = { index: number } | { at: string };

/** Read a `since` / `until` value against the log. A string is an error to show the model. */
function point(s: string, releases: Release[], timeZone: string, edge: "start" | "end"): Point | string {
  const v = s.trim();
  const pr = /^#?(\d{1,5})$/.exec(v);
  if (pr && (v.startsWith("#") || v.length < 4)) {
    const i = releases.findIndex((r) => r.pr === Number(pr[1]));
    return i >= 0 ? { index: i } : `No change in the log is PR #${pr[1]}.`;
  }
  const sha = /^(?:sha-)?([0-9a-f]{4,40})$/i.exec(v);
  if (sha && !/^\d{4}-/.test(v)) {
    const p = sha[1]!.toLowerCase();
    const hits = releases.map((r, i) => (r.sha.startsWith(p) ? i : -1)).filter((i) => i >= 0);
    if (hits.length === 1) return { index: hits[0]! };
    if (hits.length > 1) return `The commit ${v} is ambiguous: give more of it.`;
    // A bare number may still be a PR.
    if (/^\d+$/.test(v)) {
      const i = releases.findIndex((r) => r.pr === Number(v));
      if (i >= 0) return { index: i };
    }
    return `No change on main is commit ${v} (only main's own commits are listed, not those inside a merged branch).`;
  }
  // Only ISO dates: anything else would go through Date.parse, in the server's zone and with guessed years.
  const iso = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(v);
  const at = iso ? parseBound(v, timeZone, edge) : null;
  return at ? { at } : `"${s}" is not a commit, a #PR or a date (2026-11-01, or 2026-11-01 18:00).`;
}

export interface Selection {
  /** The entries to show, newest first. */
  shown: Release[];
  /** Matching the range and filters but past `limit` (older). */
  more: number;
  /** In the range, left out by `types` / `areas`, by type. */
  filteredOut: Record<ReleaseType, number>;
  /** In the range at all. */
  inRange: number;
}

export function selectReleases(releases: Release[], q: ReleaseQuery, timeZone: string): Selection | string {
  let lo = releases.length; // exclusive upper index (older bound)
  let hi = 0; // inclusive lower index (newer bound)
  if (q.since !== undefined) {
    if (q.since.trim().toLowerCase() === "deployed") lo = Math.min(1, releases.length);
    else {
      const p = point(q.since, releases, timeZone, "start");
      if (typeof p === "string") return p;
      if ("index" in p) lo = p.index; // strictly after it
      else lo = countWhile(releases, (r) => r.at >= p.at);
    }
  }
  if (q.until !== undefined) {
    const p = point(q.until, releases, timeZone, "end");
    if (typeof p === "string") return p;
    // A date's end bound is the start of the next day, exclusive (retrieval/logs.ts `parseBound`).
    if ("index" in p) hi = p.index;
    else hi = countWhile(releases, (r) => r.at >= p.at);
  }
  if (q.since !== undefined && q.until !== undefined && hi > lo) return `until (${q.until}) is before since (${q.since}): swap them.`;
  const range = hi < lo ? releases.slice(hi, lo) : [];
  const types = new Set(q.types && q.types.length ? q.types : (["feature", "fix"] as ReleaseType[]));
  const areas = q.areas && q.areas.length ? new Set(q.areas.map((a) => a.trim().toLowerCase())) : null;
  const filteredOut: Record<ReleaseType, number> = { feature: 0, fix: 0, internal: 0 };
  const matching: Release[] = [];
  for (const r of range) {
    if (types.has(r.type) && (!areas || r.areas.some((a) => areas.has(a)))) matching.push(r);
    else filteredOut[r.type]++;
  }
  return { shown: matching.slice(0, q.limit), more: Math.max(0, matching.length - q.limit), filteredOut, inRange: range.length };
}

/** How many leading entries (newest first) satisfy `f`: the log is ordered by time on main. */
function countWhile(releases: Release[], f: (r: Release) => boolean): number {
  let i = 0;
  while (i < releases.length && f(releases[i]!)) i++;
  return i;
}

/** Every area the log names, for the tool's errors and description. */
export function knownAreas(releases: Release[]): string[] {
  return [...new Set(releases.flatMap((r) => r.areas))].sort();
}
