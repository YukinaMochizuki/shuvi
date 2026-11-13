# Console design note

The console is a **conversation trace viewer**: a turn is read as the exchange it was (who said what, what
she did about it, what she said back), with the machinery (thinking, tool arguments and results, the
system prompt, the exact input) one click away. Goal: comfortable to look at, the gist of a turn at a glance,
every detail findable.

Kept from fleetkit: the palette (ink / surface / line / accent tokens) and the outcome colours (done,
failed, stopped = cancelled grey, running, refused). Everything else is designed for this data.

## Navigation: chat → conversation → segment → turn

What the owner wants to know ("what has she been doing in the book club?", "why did that DM go wrong?") is
about an exchange, not a single turn: a reply often only makes sense next to the two turns before it. So the
unit of the list is a run of turns, grouped by what the model actually saw (`sessions.ts` holds the rules):

- **Chat**: as before, a group in the left pane, ordered by last activity.
- **Conversation**: her conversation, the turns that resumed one backend session. It starts at the chat's
  first turn, at `/new`, after a switch to another model's conversation, or when a lost session was restarted
  fresh, and its header says which. Inside it she
  saw one continuous exchange, except across a **compaction**, after which she saw only a summary: that point
  is a prominent divider (trigger, tokens before → after), and a conversation or segment holding one says so.
  Turns from before openings were recorded get theirs inferred from `/new` commands and lost-session alerts,
  labelled "inferred".
- **Segment**: inside a conversation, a run of turns with no gap over 30 minutes (`SEGMENT_GAP_MS`) between
  one turn's end and the next one's start. What the owner remembers as "that exchange"; the list's rows.
- **Turn**: still its own page, at the same URL, with the tabs that only make sense for one turn.

The left pane: each chat's header (name → its log, last activity, turns, failed), then its latest 5 matching
segments under small conversation sub-headers ("after /new · 10 Nov, 23:24 · 4 turns · 1 compaction", a link
to the whole conversation). A segment row: what started it (in a group, who said it; a leading mention of the
bot dropped), relative time, then start time · span · turns · tools · refused · tool errors · cost,
"compacted", and "n failed" in the failure colour with the row tinted. "n more in this chat" opens the chat
alone (`/turns?chat=<id>`), paged. The group holding the selection is open; with nothing selected, the first 3
are. Each folds (`<details>`).

Filters and search keep the segments that hold a matching turn: the row says "x of y match", and the segment
page marks those turns. `j` / `k` move between segments.

## Pages

```
┌ top bar (40px): shuvi console ······························ owner@… ┐
├──────────────────────┬───────────────────────────────────────────────┤
│ CHATS (360px)        │ SEGMENT, CONVERSATION, TURN, or a chat's log  │
│ search               │ ● 12 Nov, 01:22  DM · Owner       ‹ earlier   │
│ all done failed …    │ Segment 3 of 3 of a fresh conversation, after │
│ ─────────────────    │ /new, which began 10 Nov, 23:22               │
│ ⌄ DM · Owner    3m   │ 5s · 1 turn · 3,120 in / 742 out · $0.0587 …  │
│   direct · 6 · 1 ✕   │ [Segment]                                     │
│   after /new         │ ── ● turn 23 done 5.2s $0.0587 prompt raw ──  │
│   10 Nov · 4 turns   │      ┌ Owner 01:22 ┐                          │
│   ● can you put …    │ +0.1 ● search_notes · "Lakeside" · 0.4s       │
│   ● book the tra…    │ ┃ Compacted  auto  167k tokens → 13k after    │
│   first conv · inf.  │ +2.4         ┌ sent ✓ ┐  (her bubble, right) │
│   ● good morning…    │ ‑‑‑‑‑‑‑ 1h 00m later · 11 Nov, 00:22 ‑‑‑‑‑‑‑  │
└──────────────────────┴───────────────────────────────────────────────┘
```

- **/turns**, **/segments/:id**, **/conversations/:id**, **/turns/:id**, **/chats/:id**: two panes, the list on
  the left. The filters live in the query string and every link keeps them. Without a selection the newest
  segment is shown. Under 760px one pane shows: the list at /turns, the selection (with a back link) otherwise.
- **A segment** (`/segments/:id`, named by its first turn's id) and **a conversation** (`/conversations/:id`):
  one continuous exchange. The header places it ("Segment 2 of 3 of the chat's first conversation, which
  began …"; a conversation: when it began, its session id, segments, compactions) and sums it up (span, turns,
  tokens, cost, tool calls). Each turn opens with a thin divider: its number (a link to the turn), outcome,
  duration, cost, tags (retry, messages only, match) and links to its prompt and raw tabs. Between segments of
  a conversation, a dashed divider says how long the silence was. The badge: a segment shows its worst
  outcome, a conversation its last turn's (an old failure that was retried is history, not its state).
- **The turn** (`/turns/:id`), three tabs (`?tab=`): *Conversation* (default), *System prompt*, *Raw input*,
  as before; a line under the trigger says which segment (turn k of n) and which conversation it belongs to.
  - Conversation: the incoming messages that opened it (left bubbles; the trigger marked), then the
    timeline in order: thinking as a collapsed one-liner, tool calls as one-line chips that expand, her
    messages as right bubbles with their Telegram status, what arrived mid-turn as left bubbles tagged
    "mid-turn", compactions, refusals and errors in their colour, and an end marker with the outcome. A
    tool's visible effects (a `say`, a reaction, a sticker) follow its chip. Offsets from the turn's start
    sit in a quiet left gutter.
  - System prompt: one row per section with its size and a bar proportional to the largest section,
    collapsed; a toggle (`&diff=1`) for the diff against the previous turn's prompt in the chat.
  - Raw input: the exact text and images the model received, the opening prompt and each append, in
    monospace with copy buttons.
- **No transcript**: a turn from before recording began still shows, from `chat_events` (its messages and
  replies), tagged "messages only". Its tabs, and a segment made only of such turns, say in a sentence why:
  it ran before recording started with the console's deployment (with the first recorded turn and its date),
  its transcript was pruned after the retention period, or it was never recorded (it ended before its prompt
  reached the model). The first recorded turn is a marker in `kv`, so the three are told apart.
- **/chats/:id**: a chat's whole log, each turn's boundary a thin divider linking to it.
- **/settings**: the model catalog, the console's one page that changes anything (below).
- **/login**, **403**, **404**: the same shell, a small centred card.

## Settings

One column (max 1080px, centred), reached from the top bar's Turns / Settings. What the control bot's
`/models` and `/provider` cards do (control/model-cards.ts), with the same rules and words:

```
┌ top bar: shuvi console  Turns Settings ················· owner@… ┐
│ Settings  the model catalog                                      │
│ 3 providers · 7 models · default claude/opus                     │
│ PROVIDERS ────────────────────────────────────────────────────── │
│ vllm [OpenAI-compatible]                    [List models][Remove]│
│ http://10.0.0.5:8000/v1 · key home.VLLM_KEY · 3 models           │
│ MODELS  7 models · 1 probing · 2 ⚠ ───────────────────────────── │
│ vllm  OpenAI-compatible · 3 models                               │
│ ┃ vllm/llama-3.1-8b             [Make default][Re-probe][Edit][…]│
│ ┃ 8,192 tokens · no vision (set by you) · ⚠ text-in…[on|off|auto]│
│ ADD A PROVIDER ───────────────────────────────────────────────── │
│ ● lab lists 6 models.  qwen3-32b  32,768 tokens  ✓ in the catalog│
└──────────────────────────────────────────────────────────────────┘
```

- **Providers**: name, kind, base URL or config dir, the key's `<profile>.<VAR>` (never a value), model
  count; List models (an endpoint), Remove.
- **Models**, under their provider: ★ default, id, label; context window, vision with where it came from
  ("set by you" / "from probe" / "not known yet"), the probe (checking with the time waited and a request's
  limit, ok with latency, ⚠ text-instead, ⚠ failed with its reason, when); the chats whose own model it is
  (the default: how many chats run on it). Make default, Re-probe (Cancel probe while one is pending), Vision
  on / off / auto (auto: follow the probe), Edit (label, context window), Remove. A warned row has an amber
  edge, a failed one red.
- **Add a provider**: the form; an endpoint's `/models` listing then shows in a panel (listing… with the time
  waited and Cancel, the list with Add per model, ✓ for those in the catalog and a context-window field where the listing gives none,
  or why it failed), until Done.
- **Remove** is a link: the row opens a red confirmation panel naming what it removes and the chats on it.
  On the default (or its provider) the page shows the control bot's refusal instead. Edit opens a form in
  the row the same way.
- **The result of a write** (a flash, once) is drawn on the row it is about, else at the top: green done,
  pink refused, red failed.

Every button is a POST form (to `/settings/<area>/<verb>`, settings-write.ts) carrying the page's CSRF token;
the server answers 303 back to `/settings`, so a reload never repeats a write. With script, the form posts in
the background: the button is disabled and shows a spinner, and the answer's `<main>` replaces the page's in
place (no reload, no jump). A probe or a listing runs in the server; while one is pending, its row or the
listing panel fetches itself every second until it is done (without script, a reload shows it). The write
boundary is in server.ts's header.

## Components

| component | what it is |
|---|---|
| TopBar | 40px, brand, who is signed in |
| Split | tree pane + detail pane, each scrolling on its own |
| FilterBar | search field, outcome links, "more filters" (`<details>`: tool, from, to) |
| ChatGroup | `<details>`: header (name → its log, last activity, turns, failed) over its conversations, "n more" |
| ConversationHead | link: how it started (first, after /new, after a model switch, restarted, inferred), when, turns, compactions |
| SegmentRow | dot · what started it (1 line) · relative time / start · span · turns · tools · cost; failed rows tinted |
| Dot | 8px outcome colour |
| Badge | outcome word in its colour, for headers |
| HeaderStrip | title line + one facts line (middot-separated, numbers tabular) |
| Tabs | text links, the active one underlined in accent |
| TraceRow | gutter (offset) + body |
| Bubble | `in` (surface-2, left), `out` (accent tint, right), `mid` (in + "mid-turn" tag), `unsent` (dashed) |
| SystemNote | centred small text for framework events and markers |
| Thinking | `<details>`: italic faint one-liner, expands to the full text |
| ToolChip | `<details>`: dot · name · arg summary · duration · status word if not ok; expands to Arguments and Result |
| Block | a labelled pre; long content folds (`<details>`) behind "Show all · 4.2 kB · 120 lines"; copy button |
| SizeBar | 4px bar, width proportional |
| Divider | 1px line with a centred label (turn boundary in a chat's log) |
| TurnDivider | in a segment: dot · turn n · outcome · duration · cost · tags · prompt · raw; a match is tinted |
| GapDivider | dashed line between segments: "1h 00m later · 11 Nov, 00:22" |
| Compaction | amber panel: "Compacted", trigger, tokens before → after, what she sees from here on |
| Banner | failed turn: tinted panel with the error |
| SettingsRow | provider or model: what it is (left), its buttons (right; below it under 760px) |
| Btn | 26px button or link: plain, `danger` (red text), `danger solid` (confirm), `primary` (accent) |
| SegButtons | Vision on / off / auto: one form, the current value raised |
| Confirm | red-tinted panel across a row: the question, what it affects, the button, Cancel |
| Notice | a write's result: on its row, or at the top; ok / refused / failed tones |
| Listing | a provider's `/models`: state line, then rows (model, context window, Add or ✓) |

## Type and spacing

- Sans (system UI) for prose and UI; monospace only for ids, JSON, code, raw input and aligned numbers.
- Sizes: 12 meta · 13 secondary · 14 UI · 15 prose (base) · 17 titles. Line height 1.55 for prose, 1.35
  for UI rows. Prose measure capped at 68ch.
- One spacing scale: 4 · 8 · 12 · 16 · 24 · 32 · 48 px (`--s1`…`--s7`). Paddings and gaps use only these.
- Borders only where they separate panes or rows of a list; hierarchy otherwise comes from spacing,
  weight and tone (ink → ink-dim → ink-faint).

## Script

Two scripts, both same origin (CSP `script-src 'self'`, `connect-src 'self'`), both optional: everything
works without them, the Settings page's forms included.

- **htmx** (the pinned npm package, served at `/htmx.min.js`; html.ts `page` holds its configuration). Every
  page is boosted: a link or a form fetches its page in the background and swaps the body, with the URL and
  Back as for a load. A 2px bar under the top bar shows while a request is out (after 150 ms, so a quick one
  does not flash it). Settings swaps only its `<main>`, and pending parts fetch themselves (above).
- **`/console.js`**: copy buttons, j / k to move through the list's rows (segments), and a line in the top bar
  when a request got no answer at all (the server restarting).
