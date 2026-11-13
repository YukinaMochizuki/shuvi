# AGENTS.md

shuvi: a one-person assistant on Telegram, built on agent-runtime. This file is an index; the rules a
module owns are in its header, because that is what is open when you are about to break one.

Read [docs/design.md](docs/design.md) first. Its five invariants (§1) are what every module protects.

## Commands

```bash
bun run typecheck
bun test                    # fresh in-memory DB per test
bun scripts/e2e-fake.ts     # server + runner child + real Claude Code CLI, fake Telegram and Anthropic
bun scripts/e2e-openai-compat.ts # the same on an OpenAI-compatible model, against a fake Chat Completions endpoint
bun scripts/e2e-switch.ts   # one chat switched between Claude and an endpoint, lossless and lossy, on the wire
bun scripts/e2e-control.ts  # the same, plus the control bot on a second fake Bot API
bun scripts/e2e-jobs.ts     # the same, for schedules, jobs, inbound sources and the workstream desk
bun scripts/e2e-computer.ts # each chat's computer against a fake Hangar (test/fake-hangar.ts)
bun scripts/e2e-groups.ts   # the same, for a group: triggers, its turn input, an unknown group approved
bun scripts/e2e-media.ts    # videos from links against a fake porchkit (test/fake-porchkit.ts) and a fake Hangar
bun scripts/e2e-drain.ts    # SIGTERM drains: a running turn finishes and is delivered; the deadline stops and retries
bun run db:generate         # after any change to src/store/schema.ts
```

Run typecheck, test and the e2e scripts before calling a change done.

## Where the rules live

| Touching | Read first |
|---|---|
| what is stored, and the exactly-once keys | `src/store/schema.ts` |
| videos from links (porchkit): who may look, who may fetch, the prewarm and its accounting | `src/capabilities/media/index.ts`, then `prewarm.ts`, `fetch.ts`; the client and its error texts: `src/porchkit/client.ts` |
| a capability's hook on each new inbound message, a tool owner-only in some calls, a capability's own credential | `src/capabilities/types.ts` (`inbound`, `ownerOnlyWhen` / `ownerOnlyNote`, `secrets`) |
| when a turn may start, the cursor, retries | `src/store/turns.ts` |
| which models exist, which one a chat runs on, the driver a turn runs on | `src/store/models.ts`, `src/agent/backend.ts` |
| switching a chat's model: a conversation per model, lossless and lossy, what is carried, switch requests | `src/agent/switch.ts` (the conversion: agent-runtime/convert) |
| an OpenAI-compatible conversation: its rows, positions, retention | `src/store/conversations.ts` |
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
| turns outliving the server | `src/server/spawn.ts`, `src/runner/child.ts` (the entry point), `src/runner/run.ts` (the turn's body) |
| shutting down: the drain on SIGTERM, its deadline, what it keeps | `src/server/drain.ts`, `src/server/main.ts` (`shutdown`); docs/design.md §16 |
| the retry of a turn the drain stopped (`DRAIN_STOP`, the retry note) | `src/store/turns.ts`, `src/agent/turn.ts` (`isRetryAfterDrain`), `src/agent/render.ts` (`RETRY_NOTE`) |
| /healthz and /metrics (names, what they count) | `src/server/health.ts` |
| the copy of the store taken before a migration | `src/store/migrate-backup.ts` |
| turn liveness, the wall-clock limit | `src/server/spawn.ts`, `src/server/waker.ts` |
| telling the owner anything (alerts, /status, approvals) | `src/control/bot.ts`, `src/store/control.ts`, `src/control/approvals.ts` |
| the control bot's model cards (`/model`, `/models`, `/provider`), and probing models in the background | `src/control/model-cards.ts`, `src/server/probes.ts` |
| the sticker library: its format and index, ranking, the rules `sticker` enforces | `src/capabilities/stickers/` (`library.ts`, `find.ts`, `rules.ts`) |
| each chat's computer (Hangar), exec, secrets, files | `src/capabilities/computer/index.ts`, then `state.ts` (who may touch it when) and `secrets.ts` (redaction: `src/secrets/`) |
| what each chat may do (policy.yaml), and changing it only by approval | `src/policy/policy.ts`, `src/policy/load.ts`, `src/policy/write.ts` |
| how policy is described: the owner's `/policy`, the model's `explain_policy` and the check on a proposal | `src/policy/view.ts`, `src/policy/explain.ts` |
| which group messages start a turn (mention, reply, follow-up) | `src/agent/triggers.ts`, `src/server/waker.ts` |
| what a chat may see or send to | `src/capabilities/access.ts` |
| what a turn's transcript records, image references | `src/agent/transcript.ts`, `src/store/transcripts.ts` |
| secret redaction (transcripts and a chat computer's output) | `src/secrets/redaction.ts` (requests and grants: `src/capabilities/computer/secrets.ts`) |
| the console: who may look (loopback, Host, tailnet login, token), its pages and design | `src/console/server.ts`, `pages.ts`, `DESIGN.md`; docs/console.md |
| how the console groups turns: conversations (backend session, `/new`, lost), 30-minute segments, compaction | `src/console/sessions.ts`; what a turn records: `turns.opening` / `backend_session_id` (`src/agent/turn.ts`) |

## Adding a capability

A capability (speech, web, …) is one folder plus one line:

1. Create `src/capabilities/<id>/index.ts` exporting a `Capability` (`defineCapability`, see
   `src/capabilities/types.ts`): its `id`, its `label` and `gives` (how /policy and explain_policy name and
   describe it), its policy `params` if `configure` reads any, `enable(env)` (read your own `SHUVI_*` variables here and list
   them in the module header; return `null` when off), and any of `tools`, `section`, `loops`, `jobKinds`,
   `ownerOnly`, and for what a message shows, `holds` (perception gating: hold a turn for a few seconds
   while it is not ready) and `perceive` (image or note parts after the message's line; it may read the
   store). A loop gets a read-only file downloader (`ServerContext.files`), never the bot API. `inbound` is
   the server's hook on each new message (start work, never wait on it); `secrets` names a credential the
   capability holds, redacted from transcripts.
2. Append it to `CAPABILITIES` in `src/capabilities/index.ts`. Append, do not insert: registry order is
   part of the prompt-cache prefix. Speech stays first.
   - Prompt sections follow registry order.
   - Tools are grouped by MCP server (`serverName`): servers in the order each first appears in the
     registry, and within a server, tools in registry order. shuvi's own tools all use `shuvi`, so a later
     capability's `shuvi` tools come before an earlier capability's `web` server. Two tools with the same
     name are refused when the tools are assembled.
   - Per chat, only the capabilities its policy enables are used (`chatCapabilities`); a capability that
     takes parameters from policy (`workstream: { products: [...] }`) narrows its config in `configure`.
     Mark it `always` only if no chat can do without it (speech).
3. A tool that acts for the owner (sets a schedule, asks workstream, edits memory) goes in `ownerOnly`.
   Do not hide it in turns the owner did not start: it is always offered, and the turn's boundary refuses
   the call unless the owner himself is in the turn (`ownerAuthority` in `src/agent/turn.ts`).
   A tool that acts for the owner only in some calls (video_sheet of a file, not of a link) goes in
   `ownerOnlyWhen`; `ownerOnlyNote` gives its refusal a reason and an alternative the model can relay.

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
