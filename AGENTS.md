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
bun scripts/e2e-switch.ts   # one chat switched between Claude and an endpoint, lossless, lossy and clean, on the wire
bun scripts/e2e-control.ts  # the same, plus the control bot on a second fake Bot API
bun scripts/e2e-jobs.ts     # the same, for schedules, jobs, inbound sources and the workstream desk
bun scripts/e2e-computer.ts # each chat's computer against a fake Hangar (test/fake-hangar.ts), and personal info
bun scripts/e2e-groups.ts   # the same, for a group: triggers, its turn input, an unknown group approved
bun scripts/e2e-media.ts    # videos from links against a fake porchkit (test/fake-porchkit.ts) and a fake Hangar
bun scripts/e2e-read.ts     # reading links (read_link, save_link, the prewarm) against the same fakes, and her browser (/browse): open, click
bun scripts/e2e-drain.ts    # SIGTERM drains: a running turn finishes and is delivered; the deadline stops and retries
bun scripts/live-demo.ts series   # by hand, needs a local Chromium (CHROME_PATH): the console's live pages in a real browser, screenshots; `idle 10`: resources
bun run db:generate         # after any change to src/store/schema.ts
```

Run typecheck, test and the e2e scripts before calling a change done.

## Where the rules live

| Touching | Read first |
|---|---|
| what is stored, and the exactly-once keys | `src/store/schema.ts` |
| videos from links (porchkit): who may look, who may fetch, the prewarm (which messages: `isTrigger`; which links: all, through `/read`) and its accounting | `src/capabilities/media/index.ts`, then `prewarm.ts`, `fetch.ts`; the client and its error texts: `src/porchkit/client.ts` |
| her own browser (porchkit `/browse`): the tools, the session per chat, a page's dialogs, the error texts, who may use it; a purchase's card and its one-use approval; sending a screenshot, a download or a PDF to the chat, giving a page a file (saving one onto the computer, or uploading one from it, is the computer's: `browser_save`, `browser_upload_from_computer`) | `src/capabilities/browser/index.ts`, `purchase.ts`, `files.ts`, `keys.ts`, `upload.ts`, `attachments.ts`, `pointer.ts` (beyond the page text), `look.ts` (the situation, images) (the outbox: `src/store/outbox.ts`; `src/capabilities/computer/browser-save.ts`); the client: `src/porchkit/client.ts` |
| reading links (porchkit `/read`): read_link's rendering and images, save_link, which links a prewarm reads, web_fetch's removal | `src/capabilities/media/read.ts`, `links.ts` (`prewarmLinks`), `prewarm.ts`; `src/capabilities/web/index.ts` |
| a capability's hook on each new inbound message (with the chat's policy), a tool owner-only in some calls, a capability's own credential | `src/capabilities/types.ts` (`inbound`, `InboundEventContext`, `ownerOnlyWhen` / `ownerOnlyNote`, `secrets`) |
| when a turn may start, the cursor, retries | `src/store/turns.ts` |
| which models exist, which one a chat runs on, the driver a turn runs on | `src/store/models.ts`, `src/agent/backend.ts` |
| switching a chat's model: a conversation per model, lossless, lossy and clean start, what is carried, switch requests | `src/agent/switch.ts` (the conversion: agent-runtime/convert; a clean start's first turn: `opensClean`) |
| an OpenAI-compatible conversation: its rows, positions, retention | `src/store/conversations.ts` |
| how model output becomes messages, `say` / `pass` / `react` | `src/agent/turn.ts` (the tools: `src/capabilities/speech/`) |
| what goes into the system prompt, and in what order | `src/agent/prompt.ts` |
| what a capability is, what it may touch | `src/capabilities/types.ts`, `src/capabilities/index.ts` |
| who may call an owner-only tool, decided per call; a group's operators | `src/agent/turn.ts` (`ownerAuthority`, `operatorAuthority`, `callAuthority`, `turnBoundary`), `src/agent/acting.ts` |
| which home/ files she may read and edit; which chats a chat may search and read | `src/capabilities/memory/home.ts`, `src/capabilities/access.ts` |
| profiles: which copy of her files a chat reads and writes (the one resolver), and switching a chat's profile | `src/capabilities/memory/layers.ts`, `src/store/profiles.ts`; the card: `src/control/model-cards.ts` (`profile`); the console: `src/console/home-data.ts`, `home-write.ts` |
| how events read to the model; framework events that cannot be forged | `src/agent/render.ts` |
| jobs: one result per job, back to its origin; deadlines | `src/store/jobs.ts`, `src/capabilities/jobs/watch.ts` |
| schedules, and firing once after downtime | `src/store/schedules.ts` |
| the hook endpoints and their tokens; a capability's own route (`hookRoutes`) | `src/capabilities/jobs/hooks.ts`, `src/capabilities/jobs/inbound.ts`, `src/capabilities/types.ts` (`HookRoute`) |
| workstream: the reads, desk requests and their follow-ups, the wake | `src/capabilities/workstream/index.ts`, `reads.ts`, `wake.ts` |
| receiving updates and the Telegram offset | `src/server/poller.ts`, `src/telegram/inbound.ts` |
| sending, 429s, long messages | `src/server/sender.ts`, `src/telegram/format.ts` |
| turns outliving the server | `src/server/spawn.ts`, `src/runner/child.ts` (the entry point), `src/runner/run.ts` (the turn's body) |
| shutting down: the drain on SIGTERM, its deadline, what it keeps | `src/server/drain.ts`, `src/server/main.ts` (`shutdown`); docs/design.md §16 |
| the retry of a turn the drain stopped (`DRAIN_STOP`, the retry note) | `src/store/turns.ts`, `src/agent/turn.ts` (`isRetryAfterDrain`), `src/agent/render.ts` (`RETRY_NOTE`) |
| the container, CI and the release | `Dockerfile`, `.github/workflows/ci.yml`, `release.yml`; the README's "Deploying" |
| the release log (`release_log`): its one git format, the file the image carries, how a change is classified (type, areas) and selected | `src/capabilities/releases/log.ts`, `git.ts` (the format and the writer release.yml runs) |
| /healthz and /metrics (names, what they count) | `src/server/health.ts` |
| the copy of the store taken before a migration | `src/store/migrate-backup.ts` |
| turn liveness, the wall-clock limit | `src/server/spawn.ts`, `src/server/waker.ts` |
| telling the owner anything (alerts, /status, approvals) | `src/control/bot.ts`, `src/store/control.ts`, `src/control/approvals.ts` |
| the control bot's model cards (`/model`, `/models`, `/provider`), and probing models in the background | `src/control/model-cards.ts`, `src/server/probes.ts` |
| the sticker library: its format and index, ranking, the rules `sticker` enforces | `src/capabilities/stickers/` (`library.ts`, `find.ts`, `rules.ts`) |
| each chat's computer (Hangar), exec, secrets, files | `src/capabilities/computer/index.ts`, then `state.ts` (who may touch it when) and `secrets.ts` (grants: a chat's, or the owner's for every chat; redaction: `src/secrets/`) |
| what each chat may do (policy.yaml), and changing it: by the owner's approval of a proposal, or his own edit in the console | `src/policy/policy.ts`, `src/policy/load.ts`, `src/policy/write.ts`; the owner's own edit from the console, one entry in place: `src/policy/edit.ts` |
| how policy is described: the owner's `/policy`, the model's `explain_policy` and the check on a proposal | `src/policy/view.ts`, `src/policy/explain.ts` |
| which group messages start a turn (mention, reply, follow-up) | `src/agent/triggers.ts`, `src/server/waker.ts` |
| what a chat may see or send to | `src/capabilities/access.ts` |
| what a turn's transcript records, image references | `src/agent/transcript.ts`, `src/store/transcripts.ts` |
| secret redaction (transcripts and a chat computer's output) | `src/secrets/redaction.ts` (requests and grants: `src/capabilities/computer/secrets.ts`) |
| where secret profiles come from (the file, and the console's sealed under SHUVI_SECRETS_KEY), their notes | `src/secrets/source.ts` (`SecretSource`, `allProfiles`, `redactionFor`), `vault.ts`, `notes.ts` |
| the console's Secrets page: profiles, values typed in and never shown, grants to every chat, notes; the key/value table its forms share (fields, any number of rows) and a row's ⋯ menu | `src/console/secrets.ts` (draws), `kv-table.ts` (the table), `secrets-write.ts` (the writes) |
| personal info (data she READS: an address, a phone): its storage beside secrets (`kind = 'info'`), its history and restore, turning a secret into it and back (the known file), what never treats it as a secret | `src/secrets/info.ts` (and `source.ts` `SECRET`, `redaction.ts` `forgetValues`) |
| her personal-info tools (`info_read`, `info_write`, `request_info`), its prompt section, its provide card | `src/capabilities/info/index.ts`, `request.ts` |
| the console's Personal info section: masked values and Show, edit, History, convert | `src/console/info.ts` (draws), `secrets-write.ts` (the writes), `provide.ts` (her request) |
| asking the owner for a secret there is not yet (a provide card, hidden grant options) and the phone page he answers it on | `src/capabilities/computer/secrets.ts` (PROVIDE), `src/control/approvals.ts` (`hidden`), `src/console/provide.ts`, `secrets-write.ts` (`provideWrite`) |
| typing a secret into her browser (`browser_type` with `secret`, porchkit's `mask`), and the redaction of every browser answer | `src/capabilities/browser/index.ts` (the header's "secrets", `redactingAll`) |
| the console: who may look (loopback, Host, tailnet login, token), its pages and design | `src/console/server.ts`, `pages.ts`, `DESIGN.md`; docs/console.md |
| the console as an installable app (PWA): its manifest, icons, and the service worker that answers only a failed page load with an offline page | `src/console/pwa.ts` (the icons: `src/console/pwa/`, `scripts/pwa-icons.ts`); docs/console.md "Installing it" |
| the console's live pages: the `/live` stream, its one shared poll of the store, the parts it sends and the page's cursor | `src/console/live.ts`; the parts: `pages.ts` (`liveView`); the page's side: `console.js` |
| a chat's settings pages in the console (Chat, Permissions, Automation & machine): its model (the bot's switch), profile, `/new` / `/stop`, its policy entry as a form | `src/console/chat-settings.ts` (draws, `CATEGORIES`), `chat-settings-data.ts` (reads), `chat-settings-write.ts` (the writes), `policy-form.ts` (form ↔ entry); `src/control/model-cards.ts` (`consoleSwitch`) |
| a chat's schedules (pause, resume, cancel), secret grants (revoke) and computer (read only) in the console | `src/console/chat-extras.ts` (draws), `chat-extras-data.ts` (reads; the disk from Hangar), the writes in `chat-settings-write.ts`; `src/store/schedules.ts` (paused), `src/capabilities/computer/secrets.ts` (`revokeGrant`), `declared.ts` (`last_apply`) |
| the console's Home page: editing her files, their history (who changed what, in which turn and call), undo, merge on save | `src/console/home.ts` (draws), `home-data.ts` (reads), `home-write.ts` (the save); the editor: `editor/`; the trailers: `src/capabilities/memory/home.ts`, `src/agent/call-context.ts` |
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
   Of those, the ones a group's policy may hand to its operators (`operators`, `delegate`) go in
   `delegable`; a tool that starts lasting work records who authorised it (`authorisation` in
   `src/agent/acting.ts`). Never make delegable what is the owner's own (his files, policy, other chats).

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
