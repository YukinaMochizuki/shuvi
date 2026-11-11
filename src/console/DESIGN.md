# Console design note

The console is a **conversation trace viewer**: a turn is read as the exchange it was (who said what, what
she did about it, what she said back), with the machinery (thinking, tool arguments and results, the
system prompt, the exact input) one click away. Goal: comfortable to look at, the gist of a turn at a glance,
every detail findable.

Kept from fleetkit: the palette (ink / surface / line / accent tokens) and the outcome colours (done,
failed, stopped = cancelled grey, running, refused). Everything else is designed for this data.

## Navigation: one tree, chat → turn

Chats and turns are one navigation. A turn belongs to a chat, and what the owner wants to know ("what has she
been doing in the book club?", "why did that DM turn fail?") starts from the chat as often as from the turn. A
separate Chats page and a flat Turns list made him pick one way in and then cross over; one tree answers both.
So the left pane lists the chats, each a group with its latest turns, and the right pane shows whichever was
picked: a turn, or (from the chat's name in its header) the chat as a conversation. `/chats` leads to `/turns`.

- A group's header: the chat's name (a link to its conversation), how long since anything happened there, its
  matching turns, and how many of those failed, in the failure colour. Groups are ordered by last activity.
- Under it, the chat's latest 5 matching turns, newest first; "n more in this chat" opens that chat alone
  (`/turns?chat=<id>`), 50 a page. One windowed query gives every chat's latest few, however many chats there are.
- The group holding the selection is open; with nothing selected, the first 3 are. Each folds (`<details>`).
- Filters and search narrow the turns, and a chat with none left is not listed.
- A row under its chat says what started the turn, without repeating the chat: in a direct chat just the words,
  in a group who said them; a leading mention of the bot is dropped.

## Pages

```
┌ top bar (40px): shuvi console ······························ owner@… ┐
├──────────────────────┬───────────────────────────────────────────────┤
│ CHATS → TURNS (360px)│ TURN, or the chat as a conversation           │
│ search               │ ● Turn 12  DM · Owner  3m ago        ‹ ›      │
│ all done failed …    │ triggered by "…" · 4.2s · 1.2k in / 300 out · │
│ ─────────────────    │ cache 12k / 0 · $0.012 · model                 │
│ ⌄ DM · Owner    3m   │ [Conversation] [System prompt] [Raw input]    │
│   direct · 9 · 1 ✕   │                                               │
│   ● what's on my…    │      ┌ Owner 21:03 ┐                           │
│   ● book the tra…    │      │ what's on…  │                           │
│   4 more in chat     │ +0.1 ▸ thinking: The owner asks…              │
│ › Book Club    5m    │ +0.4 ● search_notes · "trip" · 0.3s           │
│                      │ +1.2         ┌ sent ✓ ┐  (her bubble, right) │
└──────────────────────┴───────────────────────────────────────────────┘
```

- **/turns**, **/turns/:id** and **/chats/:id**: two panes, the tree on the left. The filters live in the
  query string and every link keeps them, so both panes are addressable. Without a selection the newest turn is
  shown. Under 760px one pane shows: the tree at /turns, the turn or the chat (with a back link) otherwise.
- **The turn**, three tabs (`?tab=`): *Conversation* (default), *System prompt*, *Raw input*.
  - Conversation: the incoming messages that opened it (left bubbles; the trigger marked), then the
    timeline in order: thinking as a collapsed one-liner, tool calls as one-line chips that expand, her
    messages as right bubbles with their Telegram status, what arrived mid-turn as left bubbles tagged
    "mid-turn", refusals and errors in their colour, and an end marker with the outcome. A tool's visible
    effects (a `say`, a reaction, a sticker) follow its chip. Offsets from the turn's start sit in a quiet
    left gutter.
  - System prompt: one row per section with its size and a bar proportional to the largest section,
    collapsed; a toggle (`&diff=1`) for the diff against the previous turn's prompt in the chat.
  - Raw input: the exact text and images the model received, the opening prompt and each append, in
    monospace with copy buttons.
- **/chats/:id** (right pane): the chat as a conversation, each turn's boundary a thin divider linking to it.
- **/login**, **403**, **404**: the same shell, a small centred card.

## Components

| component | what it is |
|---|---|
| TopBar | 40px, brand, who is signed in |
| Split | tree pane + detail pane, each scrolling on its own |
| FilterBar | search field, outcome links, "more filters" (`<details>`: tool, from, to) |
| ChatGroup | `<details>`: header (name → conversation, last activity, turns, failed) over its TurnRows, "n more" |
| TurnRow | dot · what started it (1 line) · relative time / `#id · n tools · cost`; failed rows tinted |
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
| Divider | 1px line with a centred label (turn boundary) |
| Banner | failed turn: tinted panel with the error |

## Type and spacing

- Sans (system UI) for prose and UI; monospace only for ids, JSON, code, raw input and aligned numbers.
- Sizes: 12 meta · 13 secondary · 14 UI · 15 prose (base) · 17 titles. Line height 1.55 for prose, 1.35
  for UI rows. Prose measure capped at 68ch.
- One spacing scale: 4 · 8 · 12 · 16 · 24 · 32 · 48 px (`--s1`…`--s7`). Paddings and gaps use only these.
- Borders only where they separate panes or rows of a list; hierarchy otherwise comes from spacing,
  weight and tone (ink → ink-dim → ink-faint).

## Script

`/console.js` (same origin, CSP `script-src 'self'`), optional: copy buttons, and j / k to move through the
turn list. Everything works without it.
