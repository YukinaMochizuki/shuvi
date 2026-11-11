# AGENTS.md

shuvi: a one-person assistant on Telegram, built on agent-runtime. This file is an index; the rules a
module owns are in its header, because that is what is open when you are about to break one.

Read [docs/design.md](docs/design.md) first. Its five invariants (§1) are what every module protects.

## Commands

```bash
bun run typecheck
bun test                    # fresh in-memory DB per test
bun scripts/e2e-fake.ts     # server + runner child + real Claude Code CLI, fake Telegram and Anthropic
bun scripts/e2e-control.ts  # the same, plus the control bot on a second fake Bot API
bun scripts/e2e-jobs.ts     # the same, for schedules, jobs, inbound sources and the workstream desk
bun run db:generate         # after any change to src/store/schema.ts
```

Run typecheck, test and the e2e scripts before calling a change done.

## Where the rules live

| Touching | Read first |
|---|---|
| what is stored, and the exactly-once keys | `src/store/schema.ts` |
| when a turn may start, the cursor, retries | `src/store/turns.ts` |
| how model output becomes messages, `say` / `pass` / `react` | `src/agent/turn.ts` (the tools: `src/capabilities/speech/`) |
| what goes into the system prompt, and in what order | `src/agent/prompt.ts` |
| what a capability is, what it may touch | `src/capabilities/types.ts`, `src/capabilities/index.ts` |
| who may call an owner-only tool, decided per call | `src/agent/turn.ts` (`ownerAuthority`, `turnBoundary`) |
| which home/ files she may read and edit; which chats a chat may search and read | `src/capabilities/memory/home.ts`, `src/capabilities/access.ts` |
| how events read to the model; framework events that cannot be forged | `src/agent/render.ts` |
| jobs: one result per job, back to its origin; deadlines | `src/store/jobs.ts`, `src/capabilities/jobs/watch.ts` |
| schedules, and firing once after downtime | `src/store/schedules.ts` |
| the hook endpoints and their tokens | `src/capabilities/jobs/hooks.ts`, `src/capabilities/jobs/inbound.ts` |
| receiving updates and the Telegram offset | `src/server/poller.ts`, `src/telegram/inbound.ts` |
| sending, 429s, long messages | `src/server/sender.ts`, `src/telegram/format.ts` |
| turns outliving the server | `src/server/spawn.ts`, `src/runner/child.ts` |
| turn liveness, the wall-clock limit | `src/server/spawn.ts`, `src/server/waker.ts` |
| telling the owner anything (alerts, /status, approvals) | `src/control/bot.ts`, `src/store/control.ts`, `src/control/approvals.ts` |
| the sticker library: its format and index, ranking, the rules `sticker` enforces | `src/capabilities/stickers/` (`library.ts`, `find.ts`, `rules.ts`) |

## Adding a capability

A capability (speech, web, …) is one folder plus one line:

1. Create `src/capabilities/<id>/index.ts` exporting a `Capability` (`defineCapability`, see
   `src/capabilities/types.ts`): its `id`, `enable(env)` (read your own `SHUVI_*` variables here and list
   them in the module header; return `null` when off), and any of `tools`, `section`, `loops`, `jobKinds`,
   `ownerOnly`, and for what a message shows, `holds` (perception gating: hold a turn for a few seconds
   while it is not ready) and `perceive` (image parts after the message's line). A loop gets a read-only
   file downloader (`ServerContext.files`), never the bot API.
2. Append it to `CAPABILITIES` in `src/capabilities/index.ts`. Append, do not insert: registry order is
   part of the prompt-cache prefix. Speech stays first.
   - Prompt sections follow registry order.
   - Tools are grouped by MCP server (`serverName`): servers in the order each first appears in the
     registry, and within a server, tools in registry order. shuvi's own tools all use `shuvi`, so a later
     capability's `shuvi` tools come before an earlier capability's `web` server. Two tools with the same
     name are refused when the tools are assembled.
3. A tool that acts for the owner (sets a schedule, asks workstream, edits memory) goes in `ownerOnly`.
   Do not hide it in turns the owner did not start: it is always offered, and the turn's boundary refuses
   the call unless everyone the turn has been shown is the owner (`ownerAuthority` in `src/agent/turn.ts`).

Do not edit `src/agent/turn.ts`, `src/agent/prompt.ts`, `src/server/main.ts` or `src/env.ts` for it. A
capability never talks to Telegram: its tools and loops queue rows, and the sender sends them.

The line between the two: a change to a CORE concept (an event kind, who has authority, how framework
events are rendered, the cursor) is a seam change and belongs in the core files (`src/store/`,
`src/agent/`, `src/capabilities/types.ts`), made once for every capability. What one capability needs
for itself does not go there.

## Migrations on parallel branches

A branch commits the migration `bun run db:generate` produced for it. Whoever rebases that branch onto a
`main` that has gained other migrations since deletes the branch's own migration files (its
`drizzle/NNNN_*.sql`, its `drizzle/meta/NNNN_snapshot.json`, and its entry in `drizzle/meta/_journal.json`)
and re-runs `bun run db:generate` after the rebase, so migration numbers never collide and each snapshot
builds on the one before it.

## Things that are easy to get wrong

- The framework never speaks in the assistant's chat. A command is acknowledged with a reaction; anything
  else for the owner is an alert in the control bot (`raiseAlert`), never a `chat_events` row.
- Only the senders talk to Telegram (`src/server/sender.ts`, and `src/control/bot.ts` for the control
  bot). A runner child queues rows; it has neither bot token.
- `home/` and `data/` are private and never committed.
- The repository is public. Anything about the owner (names, ids, chats, sticker packs, preferences,
  persona) lives only in `home/` or the environment, never in code, tests, docs or examples. Examples and
  tests use obviously fake names (`ExamplePack/3`).
