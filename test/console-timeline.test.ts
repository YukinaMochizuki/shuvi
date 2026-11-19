import { describe, expect, test } from "bun:test";
import { dur, merged, MERGE_PCT, ROWS_PER_CALL_MAX, spanAxis, spanTimeline, turnTimes, turnWaterfall, union, type TurnTimes } from "../src/console/timeline.ts";
import type { ChatEvent } from "../src/store/events.ts";
import type { Step } from "../src/store/transcripts.ts";
import type { Turn } from "../src/store/turns.ts";

/**
 * The console's timeline (console/timeline.ts): the model's time derived from the tools' (parallel calls counted
 * once), silences between turns folded, slivers merged, and what the waterfall and the lanes draw.
 */

const T0 = Date.parse("2026-11-19T07:00:00Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

function turn(id: number, from: number, to: number | null, status = "done"): Turn {
  return { id, chatId: 1, startedAt: iso(from), endedAt: to === null ? null : iso(to), status } as unknown as Turn;
}
let n = 0;
const think = (a: number, b: number) => ({ n: n++, kind: "thinking", at: iso(a), endedAt: iso(b) }) as unknown as Step;
const text = (a: number, b: number) => ({ n: n++, kind: "text", at: iso(a), endedAt: iso(b), sent: true }) as unknown as Step;
const append = (a: number) => ({ n: n++, kind: "append", at: iso(a), endedAt: null }) as unknown as Step;
const tool = (name: string, a: number, b: number | null, o: { status?: string; callId?: string; args?: object } = {}) =>
  ({ n: n++, kind: "tool", name, at: iso(a), endedAt: b === null ? null : iso(b), status: o.status ?? (b === null ? "running" : "ok"), callId: o.callId ?? `c${n}`, args: JSON.stringify(o.args ?? {}) }) as unknown as Step;
const out = (s: number, kind = "bot_message") => ({ kind, at: iso(s) }) as unknown as ChatEvent;
const describeArgs = (a: string) => a;
const ms = (s: number) => s * 1000;

describe("a turn's time", () => {
  test("union: overlapping and touching intervals merge, empty ones drop", () => {
    expect(union([[5, 9], [0, 2], [2, 3], [8, 12], [20, 20]])).toEqual([[0, 3], [5, 12]]);
  });

  test("Model + Tools is the wall time; parallel calls count once; thinking and text solid, the rest waiting", () => {
    // 0-2 wait, 2-5 thinking, 5-9 search_notes and 6-11 read_chat in parallel, 11-12 wait, 12-15 text.
    const tt = turnTimes(turn(1, 0, 15), [think(2, 5), tool("search_notes", 5, 9), tool("read_chat", 6, 11), text(12, 15)], [out(15)], T0)!;
    expect(tt.wallMs).toBe(ms(15));
    expect(tt.toolMs).toBe(ms(6));
    expect(tt.modelMs).toBe(ms(9));
    expect(tt.modelMs + tt.toolMs).toBe(tt.wallMs);
    expect(tt.genMs).toBe(ms(6));
    expect(tt.model.map((m) => [m.kind, (m.a - T0) / 1000, (m.b - T0) / 1000])).toEqual([
      ["wait", 0, 2],
      ["think", 2, 5],
      ["wait", 11, 12],
      ["text", 12, 15],
    ]);
    expect(tt.in).toEqual([T0]);
    expect(tt.out).toEqual([T0 + ms(15)]);
  });

  test("a recorded stretch that overlaps a tool is cut to where no tool runs", () => {
    const tt = turnTimes(turn(1, 0, 10), [think(0, 6), tool("bash", 4, 8)], [], T0)!;
    expect(tt.model.map((m) => [m.kind, (m.a - T0) / 1000, (m.b - T0) / 1000])).toEqual([
      ["think", 0, 4],
      ["wait", 8, 10],
    ]);
    expect(tt.modelMs).toBe(ms(6));
  });

  test("a running turn is drawn to now; a call with no result is open to the end", () => {
    const now = T0 + ms(30);
    const tt = turnTimes(turn(1, 0, null, "running"), [think(0, 3), tool("bash", 3, null)], [], now)!;
    expect(tt.running).toBe(true);
    expect(tt.end).toBe(now);
    expect(tt.tools[0]).toMatchObject({ open: true, b: now, state: "running" });
    expect(tt.toolMs).toBe(ms(27));
    // Ended without the call's result: open to the turn's end.
    const ended = turnTimes(turn(1, 0, 12, "failed"), [tool("bash", 3, null)], [], now)!;
    expect(ended.tools[0]).toMatchObject({ open: true, b: T0 + ms(12) });
  });

  test("steps out of order or out of the turn are clamped to it; a call that ends before it starts takes no time", () => {
    const tt = turnTimes(turn(1, 0, 10), [tool("late", 8, 14), text(-3, 2), tool("backwards", 6, 5)], [], T0)!;
    expect(tt.tools.map((c) => [(c.a - T0) / 1000, (c.b - T0) / 1000])).toEqual([
      [8, 10],
      [6, 5],
    ]);
    expect(tt.toolMs).toBe(ms(2));
    expect(tt.modelMs + tt.toolMs).toBe(tt.wallMs);
    expect(tt.model[0]).toMatchObject({ kind: "text", a: T0, b: T0 + ms(2) });
  });

  test("a refusal takes no time; mid-turn messages are In; reactions and failed sends are not Out", () => {
    const failed = { ...out(7), status: "failed" } as ChatEvent;
    const tt = turnTimes(turn(1, 0, 8), [tool("say", 2, 2, { status: "refused" }), append(4)], [out(5, "bot_reaction"), out(6, "bot_sticker"), failed], T0)!;
    expect(tt.toolMs).toBe(0);
    expect(tt.tools[0]!.state).toBe("refused");
    expect(tt.in).toEqual([T0, T0 + ms(4)]);
    expect(tt.out).toEqual([T0 + ms(6)]);
  });

  test("a turn without steps (no transcript) has no timeline", () => {
    expect(turnTimes(turn(1, 0, 8), [], [], T0)).toBeNull();
  });

  test("durations read at their scale", () => {
    expect([0, 420, 3400, 42_000, 62_000, 3_900_000].map(dur)).toEqual(["0s", "420 ms", "3.4s", "42s", "1m 02s", "1h 05m"]);
    // Rounded once, then split: never a minute short, never "60s" or "1000 ms".
    expect([999.6, 9_960, 59_600, 119_600, 3_599_999, 3_629_999].map(dur)).toEqual(["1.0s", "10s", "1m 00s", "2m 00s", "1h 00m", "1h 00m"]);
  });
});

describe("the waterfall", () => {
  test("one row per call, linked to its chip, with the summary; past the cap, one row per tool name", () => {
    const tt = turnTimes(turn(1, 0, 20), [think(0, 2), tool("search_notes", 2, 3, { callId: "a1" }), tool("bash", 3, 18, { callId: "a2", status: "error" }), text(18, 20)], [out(20)], T0)!;
    const h = turnWaterfall(tt, describeArgs).s;
    expect(h).toContain('href="#call-a1"');
    expect(h).toContain('href="#call-a2"');
    expect(h.match(/class="tl-label"/g)!.length).toBe(2);
    expect(h).toContain("k-error");
    expect(h).toContain("Tools <b>16s</b> 80%");
    expect(h).toContain("Model <b>4.0s</b> 20%");

    const many = Array.from({ length: ROWS_PER_CALL_MAX + 1 }, (_, i) => tool(i % 2 ? "read_note" : "search_notes", i, i + 0.5));
    const w = turnWaterfall(turnTimes(turn(2, 0, 30), many, [], T0)!, describeArgs).s;
    expect(w.match(/class="tl-label"/g)!.length).toBe(2);
    expect(w).toContain("× 11");
    expect(w.match(/class="tl-bar k-tool"/g)!.length).toBe(ROWS_PER_CALL_MAX + 1);
  });

  test("text from a tool's arguments is escaped", () => {
    const tt = turnTimes(turn(1, 0, 4), [tool("bash", 1, 2, { args: { cmd: "<script>x</script>" } })], [], T0)!;
    const h = turnWaterfall(tt, describeArgs).s;
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;");
  });
});

describe("the lanes", () => {
  const tt = (id: number, a: number, b: number, steps: Step[] = [think(a, b)]) => turnTimes(turn(id, a, b), steps, [], T0)!;

  test("a silence over FOLD_MS is folded into a break; a short one stays at scale", () => {
    // 10s of work, a 5s pause (at scale), 10s of work, a 9-minute pause (folded), 10s of work.
    const times = [tt(1, 0, 10), tt(2, 15, 25), tt(3, 565, 575)];
    const { x, folds, breakPct } = spanAxis(times);
    expect(folds).toEqual([{ a: T0 + ms(25), b: T0 + ms(565) }]);
    expect(x(T0)).toBe(0);
    expect(x(T0 + ms(575))).toBeCloseTo(100);
    // 35s at scale share 100 - breakPct; the fold is breakPct wide, across which x moves linearly.
    const per = (100 - breakPct) / 35;
    expect(x(T0 + ms(25))).toBeCloseTo(25 * per);
    expect(x(T0 + ms(565))).toBeCloseTo(25 * per + breakPct);
    expect(x(T0 + ms(295))).toBeCloseTo(25 * per + breakPct / 2);
    expect(x(T0 + ms(570))).toBeCloseTo(30 * per + breakPct);
  });

  test("seconds between turns of milliseconds are folded too, so they do not take the axis", () => {
    const short = (id: number, a: number) => tt(id, a, a + 0.005);
    expect(spanAxis([short(1, 0), short(2, 9), short(3, 12)]).folds.length).toBe(2);
  });

  test("overlapping turns: a silence starts only once every turn before it has ended", () => {
    const { folds, x } = spanAxis([tt(1, 0, 20), tt(2, 10, 15), tt(3, 100, 110)]);
    expect(folds).toEqual([{ a: T0 + ms(20), b: T0 + ms(100) }]);
    expect(x(T0 + ms(110))).toBeCloseTo(100);
  });

  test("turns of no length: the breaks share the axis, and the last turn is at its end", () => {
    const { x } = spanAxis([tt(1, 0, 0), tt(2, 60, 60), tt(3, 120, 120)]);
    expect(x(T0)).toBe(0);
    expect(x(T0 + ms(120))).toBeCloseTo(100);
  });

  test("many folds share at most a quarter of the axis", () => {
    const times = Array.from({ length: 40 }, (_, i) => tt(i + 1, i * 100, i * 100 + 5));
    const { folds, breakPct } = spanAxis(times);
    expect(folds.length).toBe(39);
    expect(breakPct * folds.length).toBeLessThanOrEqual(25.0001);
  });

  test("slivers of one kind that nearly touch merge; a bar wide enough to point at keeps its own link", () => {
    const m = merged([
      { x0: 10, x1: 10.1, cls: "k-tool", title: "a · x", link: "#call-1", n: 1 },
      { x0: 10.1 + MERGE_PCT / 2, x1: 10.3, cls: "k-tool", title: "b · y", link: "#call-2", n: 1 },
      { x0: 10.35, x1: 20, cls: "k-tool", title: "c · z", link: "#call-3", n: 1 },
      { x0: 10.12, x1: 10.2, cls: "k-wait", title: "w", n: 1 },
    ]);
    expect(m.filter((b) => b.cls === "k-tool").map((b) => [b.link, b.n])).toEqual([
      ["#call-1", 2],
      ["#call-3", 1],
    ]);
    expect(m.find((b) => b.cls === "k-wait")!.n).toBe(1);
    const titled = merged([
      { x0: 1, x1: 1.1, cls: "k-tool", title: "turn 7 · bash · ls\n+0s → +1s", n: 1 },
      { x0: 1.1, x1: 1.2, cls: "k-tool", title: "turn 7 · read_note · x", n: 1 },
      { x0: 1.2, x1: 1.3, cls: "k-tool", title: "turn 8 · say · y", n: 1 },
    ]);
    expect(titled.map((b) => b.title)).toEqual(["turn 7 · bash · 3 calls, merged at this scale"]);
  });

  test("hundreds of turns: ticks, marks and breaks are thinned, so the head stays small", () => {
    const times = Array.from({ length: 500 }, (_, i) => tt(i + 1, i * 60, i * 60 + 5, [think(i * 60, i * 60 + 1), tool("bash", i * 60 + 1, i * 60 + 4), text(i * 60 + 4, i * 60 + 5)]));
    const h = spanTimeline(times, "UTC", describeArgs)!.s;
    const count = (re: RegExp) => (h.match(re) ?? []).length;
    expect(count(/class="tl-tick k-in"/g)).toBeLessThanOrEqual(100 / 0.5 + 1);
    // Marks and breaks are in two lanes (Model, Tools); here the 499 breaks are too thin to draw at all.
    expect(count(/class="tl-turn"/g)).toBeLessThanOrEqual(2 * (100 / 0.5 + 1));
    expect(count(/class="tl-break"/g)).toBe(0);
    expect(h).toContain("(folded)");
    // Turns too narrow to see into are binned: a bar per bin per lane, each its share of the bin, never one bar
    // grown across the whole axis.
    expect(count(/class="tl-bar k-tool"/g)).toBeLessThanOrEqual(100 / 0.6 + 1);
    const widths = [...h.matchAll(/class="tl-bar k-tool" style="left:[\d.]+%;width:([\d.]+)%/g)].map((m) => Number(m[1]));
    expect(Math.max(...widths)).toBeLessThan(1);
    expect(h).toContain("tools 9.0s of 15s (60%), 3 calls");
    expect(h.length).toBeLessThan(100_000);
  });

  test("turn links keep the page's filters", () => {
    const h = spanTimeline([tt(7, 0, 10)], "UTC", describeArgs, (id) => `/turns/${id}?tool=bash`)!.s;
    expect(h).toContain('href="/turns/7?tool=bash"');
  });

  test("four lanes, turn marks linking to each turn, breaks, the clock at both ends; nothing for no recorded turn", () => {
    const times: TurnTimes[] = [tt(7, 0, 10, [think(0, 2), tool("bash", 2, 8, { callId: "b1" }), text(8, 10)]), tt(8, 600, 610)];
    const h = spanTimeline(times, "UTC", describeArgs)!.s;
    for (const lane of ["In", "Model", "Tools", "Out"]) expect(h).toContain(`>${lane}</div>`);
    expect(h).toContain('href="/turns/7"');
    expect(h).toContain('href="/turns/8"');
    expect(h).toContain('href="#call-b1"');
    expect(h).toContain("9m 50s without a turn");
    expect(h).toContain("07:00:00");
    expect(h).toContain("07:10:10");
    expect(h).toContain("between turns 9m 50s (folded)");
    expect(spanTimeline([], "UTC", describeArgs)).toBeNull();
  });
});
