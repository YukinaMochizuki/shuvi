import { beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { enabledCapabilities } from "../src/capabilities/index.ts";
import { releases as releasesCap } from "../src/capabilities/releases/index.ts";
import { gitLog, isShallow } from "../src/capabilities/releases/git.ts";
import { loadReleases, logSource, parseLog, selectReleases, summarize, type Release, type ReleaseQuery, type Selection } from "../src/capabilities/releases/log.ts";

// A fixture repository shaped like shuvi's history: an old merge commit (whose branch commits must not be
// listed), then squash-merged PRs, one of which only touches tests.
const repo = mkdtempSync(join(tmpdir(), "shuvi-releases-"));
const gitEnv = (date: string) => ({ ...process.env, GIT_AUTHOR_NAME: "Example Dev", GIT_AUTHOR_EMAIL: "dev@example.com", GIT_COMMITTER_NAME: "Example Dev", GIT_COMMITTER_EMAIL: "dev@example.com", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
function git(date: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", repo, ...args], { env: gitEnv(date), stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
function touch(...paths: string[]) {
  for (const p of paths) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), `${p} ${Math.random()}\n`);
  }
}
function commit(date: string, message: string, ...paths: string[]): string {
  touch(...paths);
  git(date, "add", "-A");
  git(date, "commit", "-q", "-m", message);
  return git(date, "rev-parse", "HEAD");
}

const sha = {} as Record<"initial" | "branch1" | "branch2" | "pr3" | "pr4" | "pr5" | "pr6" | "pr7", string>;
let all: Release[] = [];

beforeAll(() => {
  git("2026-11-01T09:00:00Z", "init", "-q", "-b", "main");
  sha.initial = commit("2026-11-01T09:00:00Z", "Initial commit", "README.md");
  git("2026-11-02T09:00:00Z", "checkout", "-q", "-b", "stickers");
  sha.branch1 = commit("2026-11-02T09:00:00Z", "Stickers: rank by mood", "src/capabilities/stickers/find.ts");
  sha.branch2 = commit("2026-11-02T10:00:00Z", "test: the ranking", "test/stickers.test.ts");
  git("2026-11-03T09:00:00Z", "checkout", "-q", "main");
  git("2026-11-03T09:00:00Z", "merge", "-q", "--no-ff", "-m", "Merge pull request #3 from example/stickers", "-m", "Stickers: send by mood", "stickers");
  sha.pr3 = git("2026-11-03T09:00:00Z", "rev-parse", "HEAD");
  sha.pr4 = commit("2026-11-05T09:00:00Z", "Console: a delete button (#4)\n\n* Console: a delete button\n\nYou can now delete a message\nfrom the log.\n\nA second paragraph.\n\nCo-authored-by: Other Dev <other@example.com>", "src/console/pages.ts", "src/console/style.css", "test/console.test.ts");
  sha.pr5 = commit("2026-11-06T09:00:00Z", "Fix three e2e flakes (#5)", "test/helpers.ts", "scripts/e2e-fake.ts");
  sha.pr6 = commit("2026-11-07T09:00:00Z", "Console: fix the stale banner (#6)", "src/console/live.ts");
  sha.pr7 = commit("2026-11-08T09:00:00Z", "feat(media): show a caption (#7)\n\nA video's own text is shown.", "src/capabilities/media/read.ts", "src/capabilities/media/fetch.ts", "src/store/schema.ts", "drizzle/0001_x.sql", "drizzle/meta/0001_snapshot.json");
  all = parseLog(gitLog(repo));
});

const pick = (q: Partial<ReleaseQuery>): Selection => {
  const s = selectReleases(all, { limit: 30, ...q }, "UTC");
  if (typeof s === "string") throw new Error(s);
  return s;
};
const prs = (s: Selection) => s.shown.map((r) => r.pr);

describe("parsing the log", () => {
  test("main's first parents only, newest first: a merge commit stands for its branch", () => {
    expect(all.map((r) => r.sha)).toEqual([sha.pr7, sha.pr6, sha.pr5, sha.pr4, sha.pr3, sha.initial]);
    expect(all.map((r) => r.sha)).not.toContain(sha.branch1);
  });

  test("a merge commit's title is the PR title in its body, and its areas are its whole branch", () => {
    const m = all.find((r) => r.pr === 3)!;
    expect(m.title).toBe("Stickers: send by mood");
    expect(m.type).toBe("feature");
    expect(m.areas).toEqual(["stickers"]);
    expect(m.at).toBe("2026-11-03T09:00:00.000Z");
  });

  test("a squash commit: the (#N) suffix is the PR, the summary the first prose paragraph", () => {
    const r = all.find((x) => x.pr === 4)!;
    expect(r.title).toBe("Console: a delete button");
    expect(r.summary).toBe("You can now delete a message from the log.");
    expect(r.areas).toEqual(["console"]);
  });

  test("types: tests-only is internal, a Fix past an area prefix is a fix, the rest features", () => {
    expect(Object.fromEntries(all.map((r) => [r.pr ?? "initial", r.type]))).toEqual({ 7: "feature", 6: "fix", 5: "internal", 4: "feature", 3: "feature", initial: "internal" });
  });

  test("core stays when most of the change is core", () => {
    const text = gitLog(repo).replace("src/console/live.ts", "src/console/live.ts\nsrc/agent/turn.ts\nsrc/store/turns.ts");
    expect(parseLog(text).find((r) => r.pr === 6)!.areas).toEqual(["core", "console"]);
  });

  test("a conventional prefix is dropped from the title; core gives way to a named area", () => {
    const r = all.find((x) => x.pr === 7)!;
    expect(r.title).toBe("show a caption");
    expect(r.areas).toEqual(["media"]);
  });

  test("summaries: squash subject lines and trailers go, long ones are cut on a word", () => {
    expect(summarize("* one\n* two\n\nCo-authored-by: A <a@example.com>")).toBe("");
    const long = summarize(`${"word ".repeat(200)}end`);
    expect(long.length).toBeLessThanOrEqual(600);
    expect(long.endsWith("word…")).toBe(true);
  });
});

describe("selecting", () => {
  test("by default the most recent features and fixes, the internal ones counted", () => {
    const s = pick({});
    expect(prs(s)).toEqual([7, 6, 4, 3]);
    expect(s.filteredOut).toEqual({ feature: 0, fix: 0, internal: 2 });
  });

  test("since a date includes that day; until a date includes that day", () => {
    expect(prs(pick({ since: "2026-11-05" }))).toEqual([7, 6, 4]);
    expect(prs(pick({ until: "2026-11-07" }))).toEqual([6, 4, 3]);
    expect(prs(pick({ since: "2026-11-04", until: "2026-11-06" }))).toEqual([4]);
  });

  test("since a PR or a commit is after it; until one includes it", () => {
    expect(prs(pick({ since: "#4" }))).toEqual([7, 6]);
    expect(prs(pick({ since: sha.pr4!.slice(0, 7) }))).toEqual([7, 6]);
    expect(prs(pick({ since: `sha-${sha.pr4!.slice(0, 12)}` }))).toEqual([7, 6]);
    expect(prs(pick({ since: "#3", until: "#6" }))).toEqual([6, 4]);
  });

  test("deployed is the version running now: the newest entry", () => {
    expect(prs(pick({ since: "deployed" }))).toEqual([7]);
  });

  test("types and areas filter, and what they leave out is counted by type", () => {
    const internal = pick({ types: ["internal"] });
    expect(internal.shown.map((r) => r.pr)).toEqual([5, null]);
    expect(internal.filteredOut).toEqual({ feature: 3, fix: 1, internal: 0 });
    expect(prs(pick({ areas: ["Console"] }))).toEqual([6, 4]);
    expect(prs(pick({ types: ["fix"], areas: ["console"] }))).toEqual([6]);
  });

  test("past the limit, the older matching ones are counted", () => {
    const s = pick({ limit: 2 });
    expect(prs(s)).toEqual([7, 6]);
    expect(s.more).toBe(2);
  });

  test("dates are days in the owner's time zone", () => {
    // 2026-11-04T20:00Z is already 11-05 in Taipei (UTC+8).
    const late = { ...all[0]!, sha: "f".repeat(40), pr: 90, at: "2026-11-04T20:00:00.000Z" };
    const log = [late, ...all.filter((r) => r.at < late.at)];
    const since = selectReleases(log, { since: "2026-11-05", limit: 30 }, "Asia/Taipei");
    expect(typeof since !== "string" && since.shown.map((r) => r.pr)).toEqual([90]);
    const until = selectReleases(log, { until: "2026-11-04", limit: 30 }, "Asia/Taipei");
    expect(typeof until !== "string" && until.shown.map((r) => r.pr)).toEqual([3]);
  });

  test("only ISO dates are dates: a free-form one is refused, not guessed", () => {
    for (const s of ["Nov 4", "11/14", "2026/11/14"]) expect(selectReleases(all, { since: s, limit: 30 }, "UTC")).toContain("is not a commit, a #PR or a date");
    expect(prs(pick({ since: "2026-11-05 00:00" }))).toEqual([7, 6, 4]);
    expect(prs(pick({ since: "2026-11-05T00:00:00+00:00" }))).toEqual([7, 6, 4]);
  });

  test("a range the wrong way round says so", () => {
    expect(selectReleases(all, { since: "#6", until: "#4", limit: 30 }, "UTC")).toContain("is before since");
    expect(prs(pick({ since: "#6", until: "#6" }))).toEqual([]);
  });

  test("a point that is not in the log says so", () => {
    expect(selectReleases(all, { since: "#99", limit: 30 }, "UTC")).toContain("PR #99");
    expect(selectReleases(all, { since: sha.branch1!.slice(0, 8), limit: 30 }, "UTC")).toContain("only main's own commits");
    expect(selectReleases(all, { since: "last tuesday", limit: 30 }, "UTC")).toContain("is not a commit, a #PR or a date");
  });
});

describe("reading the log", () => {
  test("where it is read: SHUVI_RELEASE_LOG, else git where there is a .git, else release-log.txt, else nothing", () => {
    const bare = mkdtempSync(join(tmpdir(), "shuvi-releases-image-"));
    expect(logSource({ SHUVI_RELEASE_LOG: "/x/log.txt" }, repo)).toEqual({ kind: "file", path: "/x/log.txt" });
    expect(logSource({}, repo)).toEqual({ kind: "git", dir: repo });
    expect(logSource({ SHUVI_COMMIT: sha.pr5 }, repo)).toEqual({ kind: "git", dir: repo, rev: sha.pr5 });
    expect(logSource({ SHUVI_COMMIT: "unknown" }, repo)).toEqual({ kind: "git", dir: repo });
    expect(logSource({}, bare)).toEqual({ kind: "none" });
    writeFileSync(join(bare, "release-log.txt"), gitLog(repo));
    expect(logSource({}, bare)).toEqual({ kind: "file", path: join(bare, "release-log.txt") });
  });

  test("the built file and git read the same", () => {
    const file = join(mkdtempSync(join(tmpdir(), "shuvi-releases-file-")), "release-log.txt");
    writeFileSync(file, gitLog(repo));
    const fromFile = loadReleases({ kind: "file", path: file });
    const fromGit = loadReleases({ kind: "git", dir: repo });
    expect(fromFile).toEqual({ ok: true, releases: all, shallow: false });
    expect(fromGit).toEqual({ ok: true, releases: all, shallow: false });
  });

  test("in a checkout the log starts at the deployment's commit, so nothing newer is listed", () => {
    const r = loadReleases({ kind: "git", dir: repo, rev: sha.pr5 });
    expect(r.ok && r.releases.map((x) => x.pr)).toEqual([5, 4, 3, null]);
  });

  test("no log, or a missing file, is a reason to show rather than a throw", () => {
    const none = loadReleases({ kind: "none" });
    expect(none.ok).toBe(false);
    expect(loadReleases({ kind: "file", path: "/nonexistent/release-log.txt" })).toEqual({ ok: false, reason: "The release log /nonexistent/release-log.txt is missing." });
  });

  test("a shallow clone is seen as one", () => {
    const clone = mkdtempSync(join(tmpdir(), "shuvi-releases-shallow-"));
    Bun.spawnSync(["git", "clone", "-q", "--depth", "1", `file://${repo}`, clone]);
    expect(isShallow(clone)).toBe(true);
    expect(isShallow(repo)).toBe(false);
  });

  test("the writer refuses a shallow clone", () => {
    const clone = mkdtempSync(join(tmpdir(), "shuvi-releases-writer-"));
    Bun.spawnSync(["git", "clone", "-q", "--depth", "1", `file://${repo}`, clone]);
    mkdirSync(join(clone, "src/capabilities/releases"), { recursive: true });
    // The writer reads the checkout it sits in, so it is run from inside the clone.
    copyFileSync(join(import.meta.dir, "../src/capabilities/releases/git.ts"), join(clone, "src/capabilities/releases/git.ts"));
    const r = Bun.spawnSync(["bun", join(clone, "src/capabilities/releases/git.ts")], { stderr: "pipe" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("shallow clone");
  });
});

describe("the release_log tool", () => {
  type Tool = { handler: (a: Record<string, unknown>, extra: unknown) => Promise<{ content: { type: string; text?: string }[]; isError?: boolean }> };
  const toolWith = (env: Record<string, string>): Tool => {
    const cfg = releasesCap.enable(env)!;
    const bundles = releasesCap.tools!({ timeZone: "UTC" } as never, cfg) as { tools: Tool[] }[];
    return bundles[0]!.tools[0]!;
  };
  let file = "";
  beforeAll(() => {
    file = join(mkdtempSync(join(tmpdir(), "shuvi-releases-tool-")), "release-log.txt");
    writeFileSync(file, gitLog(repo));
  });
  const call = async (a: Record<string, unknown>) => {
    const r = await toolWith({ SHUVI_RELEASE_LOG: file }).handler(a, {});
    return { text: r.content.map((c) => c.text ?? "").join(""), isError: r.isError === true };
  };

  test("the answer is sorted out: what runs, counts by type and area, then a section per type", async () => {
    const { text, isError } = await call({ since: "2026-11-04" });
    expect(isError).toBe(false);
    expect(text).toBe(
      [
        `Running now: ${sha.pr7!.slice(0, 12)} from 2026-11-08 (#7).`,
        "3 changes since 2026-11-04: 2 features, 1 fix.",
        "By area: console 2, media 1.",
        "Left out by the filters: 1 internal (types / areas to include them).",
        "",
        "## Features (2)",
        "- 2026-11-08 · #7 · [media] · show a caption",
        "  A video's own text is shown.",
        "- 2026-11-05 · #4 · [console] · Console: a delete button",
        "  You can now delete a message from the log.",
        "",
        "## Fixes (1)",
        "- 2026-11-07 · #6 · [console] · Console: fix the stale banner",
      ].join("\n"),
    );
  });

  test("an entry without a PR is named by its commit", async () => {
    const { text } = await call({ types: ["internal"], until: "2026-11-01" });
    expect(text).toContain(`- 2026-11-01 · ${sha.initial!.slice(0, 7)} · Initial commit`);
  });

  test("an area no change touches lists the areas there are", async () => {
    const { text, isError } = await call({ areas: ["nowhere"] });
    expect(isError).toBe(true);
    expect(text).toBe("No change touches nowhere. The areas are: console, media, stickers.");
  });

  test("nothing in range says so", async () => {
    const { text } = await call({ since: "2026-12-01" });
    expect(text).toContain("No change since 2026-12-01 matches.");
  });

  test("a deployment without a log says so", async () => {
    const r = await toolWith({ SHUVI_RELEASE_LOG: "/nonexistent/log.txt" }).handler({}, {});
    expect(r.isError).toBe(true);
  });

  test("registered, and SHUVI_RELEASES=off turns it off", () => {
    expect(enabledCapabilities({ SHUVI_WEB: "off" }).map((c) => c.capability.id)).toContain("releases");
    expect(enabledCapabilities({ SHUVI_WEB: "off", SHUVI_RELEASES: "off" }).map((c) => c.capability.id)).not.toContain("releases");
  });
});
