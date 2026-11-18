import { z } from "zod";
import { err, ok, type ToolDef } from "agent-runtime";
import { defineCapability } from "../types.ts";
import { knownAreas, loadReleases, logSource, RELEASE_TYPES, selectReleases, type LogSource, type Release, type ReleaseType, type Selection } from "./log.ts";

/**
 * Releases: `release_log`, what changed in her (the code she runs) since a date, a commit or a PR, up to the
 * version running now, so she can tell people what is new about her. The log, where it comes from and how
 * an entry is classified are ./log.ts; this module is the tool and how its answer reads.
 *
 * The answer is already sorted out, so the model only has to retell it: a head line (what runs, how many
 * changes of each type and area, what the filters left out), then a section per type, newest first, one
 * line per change and its summary under it. How to retell it (their language, what they can do now, no
 * PR numbers unless the owner asks) is in the tool's description; there is no prompt section, so a chat's
 * system prompt does not grow for a tool used now and then.
 *
 *   SHUVI_RELEASES      "off" disables this capability (default on)
 *   SHUVI_RELEASE_LOG   the log file to read instead of git / release-log.txt (./log.ts)
 */

export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 100;

export interface ReleasesConfig {
  source: LogSource;
}

const HEADINGS: Record<ReleaseType, string> = { feature: "Features", fix: "Fixes", internal: "Internal (tests, CI, docs, build, refactors)" };

/** A day in the owner's time zone, 2026-11-15. */
function day(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function entry(r: Release, timeZone: string): string {
  const head = [day(r.at, timeZone), r.pr !== null ? `#${r.pr}` : r.sha.slice(0, 7), r.areas.length ? `[${r.areas.join(", ")}]` : null, r.title].filter(Boolean).join(" · ");
  return r.summary ? `- ${head}\n  ${r.summary}` : `- ${head}`;
}

/** The tool's answer. */
export function renderSelection(head: Release, sel: Selection, range: string, timeZone: string, shallow: boolean): string {
  const lines = [`Running now: ${head.sha.slice(0, 12)} from ${day(head.at, timeZone)}${head.pr !== null ? ` (#${head.pr})` : ""}.`];
  if (shallow) lines.push("This checkout's history is shallow, so older changes are missing.");
  if (sel.shown.length === 0) {
    lines.push(`No change ${range} matches.`);
  } else {
    const byType = RELEASE_TYPES.map((t) => [t, sel.shown.filter((r) => r.type === t)] as const).filter(([, rs]) => rs.length);
    const counts = byType.map(([t, rs]) => plural(rs.length, t === "fix" ? "fix" : t === "feature" ? "feature" : "internal change", t === "fix" ? "fixes" : undefined)).join(", ");
    lines.push(`${plural(sel.shown.length, "change")} ${range}: ${counts}.`);
    const areas = new Map<string, number>();
    for (const r of sel.shown) for (const a of r.areas) areas.set(a, (areas.get(a) ?? 0) + 1);
    if (areas.size) lines.push(`By area: ${[...areas.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([a, n]) => `${a} ${n}`).join(", ")}.`);
  }
  const out = RELEASE_TYPES.filter((t) => sel.filteredOut[t]).map((t) => `${sel.filteredOut[t]} ${t}`);
  if (out.length) lines.push(`Left out by the filters: ${out.join(", ")} (types / areas to include them).`);
  if (sel.more) lines.push(`${plural(sel.more, "older matching change")} not shown (past the limit): narrow \`since\`, or raise \`limit\`.`);
  for (const t of RELEASE_TYPES) {
    const rs = sel.shown.filter((r) => r.type === t);
    if (!rs.length) continue;
    lines.push("", `## ${HEADINGS[t]} (${rs.length})`, ...rs.map((r) => entry(r, timeZone)));
  }
  return lines.join("\n");
}

/** How the range reads in the answer's head line. */
function describeRange(since: string | undefined, until: string | undefined): string {
  if (since?.trim().toLowerCase() === "deployed") return "in the version running now";
  const parts = [since ? `since ${since}` : "", until ? `up to ${until}` : ""].filter(Boolean);
  return parts.length ? parts.join(", ") : "(the most recent)";
}

export const releases = defineCapability<ReleasesConfig>({
  id: "releases",
  label: "what's new in her",
  gives: "release_log: what changed in the code she runs (features, fixes), since a date, a commit or a PR, up to the version deployed now.",
  enable: (env) => (env.SHUVI_RELEASES === "off" ? null : { source: logSource(env) }),
  tools({ timeZone }, { source }) {
    const log: ToolDef<{ since?: string; until?: string; types?: ReleaseType[]; areas?: string[]; limit?: number }> = {
      name: "release_log",
      description: `What has changed in you: the code you run, change by change, newest first, up to the version running now (nothing that is not deployed yet). Sorted out already: a section per type (feature, fix, internal), each change with the date it went live, the areas of you it touched (console, media, stickers, control bot, …), its title and a summary.

Use it when someone asks what is new, what changed since some day or version, or what you can do now that you could not before, or when you want to tell them about something new. The entries are written by and for developers; retell them in the person's language and from their side: what they can now do or will notice, a few highlights rather than the whole list, grouped as they would think of it. Leave out commit ids, PR numbers and internals unless the owner asks for them.`,
      inputSchema: {
        since: z.string().optional().describe('Only changes after this point: a date or time (2026-11-01, in the owner\'s time zone; that day included), a PR ("#45"), a commit or image tag ("4b92c89", "sha-4b92c89a1b2c"; changes after it), or "deployed" for just the version running now. Default: the most recent'),
        until: z.string().optional().describe("Up to and including this point, in the same forms (a date, a PR, a commit). Default: the version running now"),
        types: z.array(z.enum(RELEASE_TYPES as [ReleaseType, ...ReleaseType[]])).optional().describe('Which types to list. Default ["feature", "fix"]; "internal" is tests, CI, docs, build and refactors'),
        areas: z.array(z.string().min(1)).optional().describe('Only changes touching one of these areas, as the entries name them (e.g. "console", "media", "stickers", "control bot")'),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Most changes to list (default ${DEFAULT_LIMIT})`),
      },
      async handler(a) {
        const loaded = loadReleases(source);
        if (!loaded.ok) return err(loaded.reason);
        const all = loaded.releases;
        if (!all.length) return err("The release log is empty.");
        if (a.areas?.length) {
          const known = new Set(knownAreas(all));
          const unknown = a.areas.filter((x) => !known.has(x.trim().toLowerCase()));
          if (unknown.length === a.areas.length) return err(`No change touches ${unknown.join(", ")}. The areas are: ${[...known].join(", ")}.`);
        }
        const sel = selectReleases(all, { ...(a.since !== undefined ? { since: a.since } : {}), ...(a.until !== undefined ? { until: a.until } : {}), ...(a.types ? { types: a.types } : {}), ...(a.areas ? { areas: a.areas } : {}), limit: a.limit ?? DEFAULT_LIMIT }, timeZone);
        if (typeof sel === "string") return err(sel);
        return ok(renderSelection(all[0]!, sel, describeRange(a.since, a.until), timeZone, loaded.shallow));
      },
    };
    return [{ serverName: "shuvi", tools: [log] as ToolDef[] }];
  },
});
