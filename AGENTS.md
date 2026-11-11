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
| how model output becomes messages, `say` / `pass` / `react` | `src/agent/turn.ts` |
| what goes into the system prompt, and in what order | `src/agent/prompt.ts` |
| receiving updates and the Telegram offset | `src/server/poller.ts`, `src/telegram/inbound.ts` |
| sending, 429s, long messages | `src/server/sender.ts`, `src/telegram/format.ts` |
| turns outliving the server | `src/server/spawn.ts`, `src/runner/child.ts` |

## Things that are easy to get wrong

- The framework never speaks in the assistant's chat. A command is acknowledged with a reaction.
- Only the sender talks to Telegram. A runner child queues rows; it does not have the bot token.
- `home/` and `data/` are private and never committed.
