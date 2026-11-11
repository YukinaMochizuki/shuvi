# AGENTS.md

shuvi: a one-person assistant on Telegram, built on agent-runtime. This file is an index; the rules a
module owns are in its header, because that is what is open when you are about to break one.

Read [docs/design.md](docs/design.md) first. Its five invariants (§1) are what every module protects.

## Commands

```bash
bun run typecheck
bun test                    # fresh in-memory DB per test
bun scripts/e2e-fake.ts     # server + runner child + real Claude Code CLI, fake Telegram and Anthropic
bun run db:generate         # after any change to src/store/schema.ts
```

Run typecheck, test and the e2e script before calling a change done.

## Where the rules live

| Touching | Read first |
|---|---|
| what is stored, and the exactly-once keys | `src/store/schema.ts` |
| when a turn may start, the cursor, retries | `src/store/turns.ts` |
| how model output becomes messages, `say` / `pass` / `react` | `src/agent/turn.ts` (the tools: `src/capabilities/speech/`) |
| what goes into the system prompt, and in what order | `src/agent/prompt.ts` |
| what a capability is, what it may touch | `src/capabilities/types.ts`, `src/capabilities/index.ts` |
| receiving updates and the Telegram offset | `src/server/poller.ts`, `src/telegram/inbound.ts` |
| sending, 429s, long messages | `src/server/sender.ts`, `src/telegram/format.ts` |
| turns outliving the server | `src/server/spawn.ts`, `src/runner/child.ts` |

## Adding a capability

A capability (speech, web, …) is one folder plus one line:

1. Create `src/capabilities/<id>/index.ts` exporting a `Capability` (`defineCapability`, see
   `src/capabilities/types.ts`): its `id`, `enable(env)` (read your own `SHUVI_*` variables here and list
   them in the module header; return `null` when off), and any of `tools`, `section`, `loops`, and for
   what a message shows, `holds` (perception gating: hold a turn for a few seconds while it is not ready)
   and `perceive` (image parts after the message's line). A loop gets a read-only file downloader
   (`ServerContext.files`), never the bot API.
2. Append it to `CAPABILITIES` in `src/capabilities/index.ts`. Append, do not insert: registry order is
   tool order and prompt-section order, and so part of the prompt-cache prefix. Speech stays first.

Do not edit `src/agent/turn.ts`, `src/agent/prompt.ts`, `src/server/main.ts` or `src/env.ts` for it. A
capability never talks to Telegram: its tools and loops queue rows, and the sender sends them.

## Migrations on parallel branches

A branch commits the migration `bun run db:generate` produced for it. Whoever rebases that branch onto a
`main` that has gained other migrations since deletes the branch's own migration files (its
`drizzle/NNNN_*.sql`, its `drizzle/meta/NNNN_snapshot.json`, and its entry in `drizzle/meta/_journal.json`)
and re-runs `bun run db:generate` after the rebase, so migration numbers never collide and each snapshot
builds on the one before it.

## Things that are easy to get wrong

- The framework never speaks in the assistant's chat. A command is acknowledged with a reaction.
- Only the sender talks to Telegram. A runner child queues rows; it does not have the bot token.
- `home/` and `data/` are private and never committed.
