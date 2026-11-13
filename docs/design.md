# shuvi architecture

shuvi is a personal assistant that serves one person (the *owner*), with first-party Telegram support.
The agent itself runs on [agent-runtime](https://github.com/YukinaMochizuki/agent-runtime); shuvi is
everything around it: receiving and sending messages, deciding when to think, assembling the context,
memory, background work, and each chat's permissions.

This document records the shape of the architecture and the reasons behind it. It is not a feature list:
features (stickers, media, work capabilities) are details built on this shape.

## 1. Invariants

The whole design is derived from these five. Before changing any component, check that it breaks none
of them.

1. **Nothing perceived is lost.** Everything that happens outside (a message, a schedule coming due, a
   background job finishing, an external notification) is written to the DB before it is handled.
2. **Nothing said is lost, or said twice.** A message is in one of two states: delivered to Telegram with
   a message id, or waiting to be sent. There is no "not sure whether it went out".
3. **Thinking is not interrupted by the body restarting.** A deploy or restart lets a running turn finish.
4. **A chat is ordered.** One chat has at most one turn at a time, and events are handled in order.
5. **Only the assistant speaks.** The framework never produces a message in the assistant's voice.
   Anything the framework has to tell the owner goes to the control bot (§13).

## 2. Components and flow

```
 Telegram ─poller─┐  schedules ─┐  jobs (exit/callback/poll) ─┐  /inbound/<source> ─┐
                  ▼             ▼                             ▼                    ▼
            ┌──────────────── chat_events (one log per chat, with a cursor) ───────────┐
            └──────────────┬──────────────────────────────────────────────────────────┘
                           ▼ waker: new events past the cursor that match the chat's trigger
                     runner child (one turn; survives a server restart)
                       ├ a text block → one message
                       ├ react / sticker / send_* / edit / send(chat) / pass()
                       ├ start_job → the turn ends now, the result comes back to the origin later
                       └ edits home/ (git commit) / propose_policy (waits for the owner)
                           ▼
                     sender → Telegram (idempotent; the message id is recorded once delivered)
```

The **shuvi server** (an always-on Bun process) runs:

- **telegram poller**: long polling for updates. Updates are written to `chat_events` before the offset
  is committed, and deduplicated by `update_id`. Long polling rather than a webhook, because it needs no
  public endpoint.
- **waker**: decides which chat needs a turn now: new events past its cursor, matching the chat's
  trigger, and no turn already running there. It then spawns a runner child.
- **sender**: delivers queued messages to Telegram and records the message id. A message with an id is
  never sent again. 429 backoff, splitting past 4096 characters and markdown-to-Telegram-HTML all live
  here and nowhere else.
  - Invariant 2 has two gaps that cannot be fully closed:
    - Telegram accepted a part but we never learned so: a crash before the id is recorded, or a network
      error (a timeout, a lost response) on a request Telegram carried out. Either way that part is sent
      once more. The Bot API has no idempotency key to close this.
    - A runner child that crashes mid-turn has its turn re-run (see `src/store/turns.ts`), which may say
      again, in other words, what it already said. This is accepted because the alternative, never
      re-running, loses the reply entirely.
- **job watcher**: watches background jobs and writes an event back to the origin chat when one ends.
- **hook endpoints**: `/jobs/<id>/report` and `/inbound/<source>`, on the tailnet only.

**runner child**: one process per turn; it runs one turn through agent-runtime and exits. It is detached
and outlives the server, which is what makes invariant 3 hold.

## 3. Data

Everything is in one SQLite file (WAL mode).

- **`chat_events`**: an append-only log per chat, holding only what actually happened in that chat:
  messages, stickers, reactions, edits, forwards, `scheduled`, `job_done`, `external`. A message the
  assistant sends is an event too, with an idempotency key and the message id recorded once delivered.
- **cursor**: per chat, "the last event the assistant has seen". The waker only looks past it.
- **turns**: each turn's start, end, usage and cost. This is bookkeeping and is kept out of
  `chat_events`.
- **turn transcripts** (`prompt_texts`, `turn_transcripts`, `turn_steps`): each turn as the model saw it,
  for debugging: the system prompt by hash, the input, and a timeline of thinking, text, tool calls and
  mid-turn appends, secrets redacted and images as paths. Recorded best effort by the runner child, read
  only by the console, pruned after `SHUVI_TRANSCRIPT_DAYS`. Nothing decides anything from it
  (src/agent/transcript.ts, docs/console.md).
- **jobs**, **schedules**: see §10.
- **The conversation the model sees** is kept where its driver keeps it, not rebuilt from `chat_events`:
  a Claude Code session (files in that Claude login's config dir) for the Claude driver; for
  openai-compat, `conversations` and `conversation_messages` (`src/store/conversations.ts`), one JSON
  message per row, appended in order, compacted by replacing the current generation, read from one
  snapshot; deleting a conversation deletes its messages. A history no chat uses any more (after `/new`,
  say) stays until `SHUVI_TRANSCRIPT_DAYS` after its last write, then is pruned. An OpenAI-compatible
  model reports no cost: its turns record 0.
- **Which model** a chat runs on is `chats.model` in the model catalog (`model_providers`, `models`:
  `src/store/models.ts`), else the catalog's default; it is read when the turn starts. A chat keeps one
  conversation per LANE, where a model's driver keeps it (each Claude login its own; every OpenAI-compatible
  endpoint the same one): the active one on `chats`, the others parked in `chat_lanes`. Switching to a model
  of the same lane keeps the conversation; to another lane, the owner chooses each time between lossless
  (what the active conversation gained since its lane was entered, which is what the target lacks, is
  converted and appended to it: agent-runtime/convert; a target with none gets all of it) and lossy
  (nothing is: the target resumes as it was left). The model is never told; `model_switches` records each
  switch, and the turn after it says so in its transcript (`src/agent/switch.ts`).
  `chat_events` is "what actually happened", for people and for retrieval tools.

`home/` is a second data directory, next to the SQLite file and outside the code repository:

```
home/                     a local-only git repo, no remote
  persona/public.md       persona: the side every chat sees
  persona/private.md      persona: the side shown only in the owner's DM
  directives.md           the owner's rules (Always / Never, with the date observed)
  memory/private.md       standing memory, loaded only in the owner's DM
  chats/<id>.md           per-chat notes
  playbooks/<name>.md     how to do a particular thing, in full
  stickers/<pack>.yaml    the sticker library
  stickers/preferences.md principles that apply across stickers
  policy.yaml             each chat's permissions
```

`home/` is highly private. It never enters this repository and is never pushed anywhere. Its history
lives only in the local git repo, and it is backed up with the machine (and daily as a `git bundle`, §13).

## 4. The speech model

The starting point is to follow the model's own habits: the final answer is written as ordinary text,
rather than requiring every sentence to go through a send tool, which is easy to forget during long work.

One constraint shapes this. Models of the Opus 5.5 generation write what they say between tool calls as
progress-update `thinking` blocks, not `text`, and under the summarized display those cannot be told apart
from reasoning summaries (see agent-runtime's `src/claude/stream.ts`). So thinking is never sent, and
anything worth saying mid-turn is said through an explicit tool.

- **One text block is one message.** A text block is sent when it is complete, not streamed token by
  token; in practice it is usually the final answer. Whether to stream a long final answer is a later
  decision and does not change this shape.
- **Mid-turn remarks use `say(text)`**, e.g. "sent it off to run in the background, about three
  minutes". A tool's arguments always arrive whole and are never rewritten into a summary.
- **Thinking is never sent**; it stays in the turn's record.
- **Every other kind of expression is a tool.**

  | tool | purpose |
  |---|---|
  | `say(text)` | say something partway through a turn |
  | `react(event, emoji)` | react to a message |
  | `sticker(id)` | send a sticker |
  | `send_photo` / `send_file` / `send_voice` | images, files, voice messages |
  | `reply_to(event)` | make the next text a reply to that message |
  | `edit` / `delete` | change or remove one of its own messages |
  | `send(chat, …)` | send to another chat (owner's DM only) |
  | `pass(reaction?)` | say nothing, and end the turn |

- **Silence is `pass()`.** It ends the turn; no text produced after it is sent. A turn that only reacts
  or sends a sticker, with no text, is a complete answer. There is no sentinel string (like `NO_REPLY`):
  in a model that sends text block by block, a sentinel mixed into ordinary text leaks out.
- **What the framework does:**
  - sends "typing…" while a turn runs;
  - converts the assistant's markdown to Telegram HTML in the sender;
  - in a group, if someone else has spoken since the message that triggered the turn, makes the first
    text a reply to that message; otherwise sends it plainly. In a DM, no reply by default.
- **Idempotency keys** are `(turn, block number)` or the tool call id. When a turn is picked up after a
  restart, what was already sent is skipped.

## 5. Concurrency

- Turns in different chats run in parallel.
- A chat has one turn at a time. Events arriving while it runs are appended to it at the next tool call,
  through agent-runtime's tool-boundary append; if the turn will make no more tool calls, the next turn
  starts as soon as it ends.
- **Long work always goes to the background.** The tool returns a job id and the turn ends, so the chat
  is never blocked. When the job ends, its result comes back to the origin chat as an event and starts a
  new turn.
- **Waiting is background work too.** "Check again in five minutes" is a scheduled event, not a turn
  idling.
- Interrupting a running turn takes an explicit command (`/stop`); it is not the default.

## 6. Context and visibility

Each chat is one long conversation, kept in bounds by agent-runtime's compaction: no daily reset, no
splitting by topic. System events enter the conversation as events and never pose as the user speaking.

The system prompt is ordered by stability (the most stable first, so the prompt cache keeps the longest
prefix):

1. persona: the persona layers this chat may see
2. directives: global rules; taught once in any chat, they apply everywhere
3. this chat: who is here, a summary of its policy, its notes
4. capability groups: every group the policy enables, with its tools and a short "when to use"
5. playbook index: one line per playbook, its name and when it is needed; `read_playbook(name)` reads
   one in full
6. private memory: the owner's DM only

Preferences used in almost every turn (such as how to pick stickers) go in the capability group's
description; the details of "how to do X" go in a playbook.

**Visibility is one-way.** The owner's DM can read any chat's log through a tool and send to any chat; a
group sees only itself. The privacy boundary is structural: a group turn's context does not contain the
DM-only persona or private memory at all, so nothing can slip out, and no prompt instruction is relied on
to hold it back.

## 7. Groups

- **Recording and triggering are separate.** The poller records every message in a group (this needs
  BotFather's privacy mode off, or the bot as an admin), but recording a message does not trigger a turn.
- **Triggers** are set by policy. The usual ones: a mention, a reply to the assistant, and a follow-up
  in the thread the assistant just spoke in. Follow-ups are judged at the routing layer; a wrong call is
  cheap, since the assistant can `pass()`.
- **Context**: a turn opens with up to 10 of the messages past the cursor that the assistant has not
  seen, each with its sender, time and reply target, plus the count of unread messages since the last
  trigger. Anything older is reached with `read_chat`.

## 8. Policy and permissions

`home/policy.yaml` sets each chat's trigger, persona layers, memory layers and the capability groups it
enables. A capability group can take parameters, e.g. a group allowed to query one workstream product
only:

```yaml
owner: <telegram user id>
chats:
  dm:
    persona: [public, private]
    memory:  [private, chat]
    tools:   all
  "<group id>":
    trigger: [mention, reply, followup]
    persona: [public]
    tools:
      chat: {}
      web: {}
      stickers: {}
      workstream-read: { products: [widgetry] }
unknown_chat: ignore      # a group not listed: no response, and the owner is told via the control bot
```

- **Data scope follows the chat.** Everyone in a group reads the answer, so what may be said depends on
  the chat's audience, not on who asked.
- **Authority follows the sender.** Running commands, assigning work and changing settings are the
  owner's alone. The framework checks the sender's Telegram user id; the model's judgement is not relied
  on. A turn may act for the owner when the owner himself is in it: one of the messages that called her,
  or that were appended to it while it ran, is from the owner's user id. Other people's messages, before
  or after the owner's, neither grant authority nor take it away: the owner is usually in the
  conversation, and people talk after his command. A turn with no message from the owner (strangers only,
  or inbound events only, or started only by schedules or jobs he never authorised) never acts for him; a
  schedule or a job counts as his only when he authorised it. Beside a message of his, inbound text and
  unauthorised schedules or jobs neither grant nor block, like other people's messages. Telling whose
  request is whose is the assistant's, and the framework makes it unmistakable: the owner's lines carry a
  mark nobody else can produce, framework events carry labels saying what they are, a group turn's input
  says which messages called her (the earlier unseen ones are shown as
  context, under their own heading, and count for nothing), and the group section tells her to act for the
  owner only on his own request and to weigh anyone else's instructions as requests, never commands
  (`ownerAuthority` in src/agent/turn.ts).
- **Policy changes are proposed by the assistant and approved by the owner.** `propose_policy` produces
  a diff; the framework writes and commits it only when the owner's user id agrees (or presses the inline
  button).

The other files in `home/` (persona, directives, memory, playbooks, stickers) are edited by the assistant
directly when the owner asks, with a commit per edit and a one-line note in the chat. The owner can ask
for a revert or use git directly. Requests from anyone else in a group can at most be written into that
chat's notes.

## 9. Memory and retrieval

Memory solves two different problems:

- **What should be known without looking it up** goes in standing files (`memory/private.md`,
  `chats/<id>.md`). The assistant curates them, writing when it judges in conversation that something
  will matter later.
- **What only needs to be findable** gets no separate summary: `chat_events` is the complete raw record,
  and it is searched directly.

There are no daily summaries and no background consolidation or "dreaming". An LLM's memory needs are not
a person's; forcing a human memory model onto it only produces one more summary that can be wrong.

The retrieval tools follow workstream's code-search and transcript-reading tools:

- `search_chats(terms[], chat?, sender?, since?, until?)`: several terms, OR-combined. Every hit carries
  its seq; when there are too many, the distribution of hits per chat is returned instead.
- `read_chat(chat, around | before | after seq, limit)`: paged reading by seq.

## 10. Background work, schedules and external events

A **job** is anything whose result appears later: transcription or frame extraction on Hangar, a remote
download, a workstream desk request, a local command.

```
jobs: id, origin(chat, event seq), kind, state(running/done/failed/expired),
      result, deadline, report(exit | callback | poll)
```

- `exit`: work the framework runs itself; the job watcher waits for it to end.
- `callback`: every job has its own URL and token (`/jobs/<id>/report`). An external system only POSTs
  there; it knows nothing of chats or origins.
- `poll`: the framework checks the status periodically.
- Past its deadline with no result, a job is polled once; still nothing, it is marked `expired` and that
  is written back to the origin, so nothing vanishes silently. Repeat reports are deduplicated by job id.
- Whichever way, the result becomes a `job_done` event in the origin chat.

A **schedule** is set by the owner, or proposed by the assistant and set once the owner agrees. When it
comes due, the framework writes a `scheduled` event into the target chat, and the turn runs in that
chat's conversation with its context. The assistant may `pass()` each time. There is no background
patrol (heartbeat) and no unprompted speaking: every wake-up has a stated purpose.

An **inbound source** carries external events the assistant did not start (a monitoring alert, say):
`POST /inbound/<source>`. The chat it lands in, and whether it triggers a turn, are declared in
`home/inbound.yaml`; its token is in the server's environment (`SHUVI_INBOUND_<NAME>_TOKEN`), never in
`home/`, which the assistant can read. It becomes an `external` event in that chat.

## 11. Media

The framework does not filter noise on the assistant's behalf, and does not prefetch links, with one
exception the owner decided (the prewarm, below); otherwise the assistant calls a tool when it needs to.
Where a forward came from and the text being replied to are recorded as event fields.

- **Videos from links** go through porchkit, a separate service on the owner's home connection
  (`src/capabilities/media/`, `src/porchkit/`): what a video is, its subtitles, contact sheets, a download.
  It is always anonymous: nothing behind a login is ever fetched, and the assistant says so rather than
  guessing. Its per-site request budgets protect the home IP and porchkit enforces them; told to wait, the
  assistant says it is busy and roughly how long. Anyone may have the assistant LOOK at a video in a chat
  whose policy enables media; a download onto the computer (`video_fetch`) is the owner's alone.
- **The prewarm** is the one prefetch: a link to a known video site in an OWNER's message is probed as
  soon as the message is recorded, alongside spawning the turn. Probe only, never a download; best effort
  (a failure is logged and ignored; porchkit refuses it when the site's budget is half used); it never
  delays the turn. The framework never puts what was fetched into the turn's input: it only says what is
  ready ("(Prepared: #53's link — video_probe returns at once.)"), and the assistant asks when it wants it.
  Each prewarm is recorded with whether the turn then used it.
- **Images**: photos and static stickers go to the model as images. Animated (tgs) and video (webm)
  stickers become a thumbnail or one frame, with their emoji and pack. The server downloads them
  (`media/<file_unique_id>`, once per file); a turn waits a few seconds at most for one still downloading
  (perception gating), then shows the placeholder alone. The image follows the message's line, in a
  turn's input and in what is appended mid-turn (`src/capabilities/vision/`).
- **Sticker description cache**: a short description keyed by `file_unique_id`, for replay, retrieval
  and the sticker library; the model never sees it instead of the image.
- **Video and large files** never block a turn: the assistant gets a thumbnail and metadata first and
  decides whether to process them. Common processing (frames, compression) is a framework tool that
  runs remotely and returns the result, so the assistant never assembles the commands itself.
- Heavy computation always runs remotely (on Hangar), never on shuvi's machine.
- No speech-to-text in v1. Transcription is to come from a shared service the platform maintains (to be
  designed), not from something each chat's computer installs, tunes and updates on its own (§15).

## 12. Sticker library

```yaml
# home/stickers/<pack>.yaml
pack: <set name>
role: avatar            # avatar / common / meme: the pack's base weight
stickers:
  - n: 10
    file_unique_id: <...>
    desc: an OK hand sign        # what it shows (fact)
    use: OK, got it              # when to use it (preference)
    tier: go-to                  # go-to / (omitted) normal / rare / never
```

- `file_id`, size, static or animated, and whether it is narrow are fetched from Telegram by the
  framework, never written by hand.
- `desc` is a fact anyone can write by looking, and rarely changes; `use` and `tier` are preferences and
  keep changing as the owner adjusts them.
- `find_sticker(terms[], pack?)` matches both `desc` and `use`. Ranking is the match, the pack's `role`
  and `tier`, minus the assistant's recent use of that sticker (so it varies now and then). Which stickers
  the owner sends often is not counted, so the weights stay predictable. Candidates show their `tier` and
  recent use.
- `view_stickers(ids)`: look at thumbnails only when the appearance needs checking.
- `add_sticker_pack(name)`: the framework fetches the pack and renders a numbered contact sheet; the
  assistant looks at it and writes the descriptions.
- **Mechanical rules are the framework's; taste is the assistant's.**
  - Guaranteed by the tool: at most one sticker per message, never echo the sticker just sent, narrow
    stickers are not offered.
  - Left to the assistant: whether a sticker fits, and which one.

## 13. Control and alerts

- **Control bot**: a separate bot (`SHUVI_CONTROL_BOT_TOKEN`) that only the owner can use: it answers the
  owner's user id and ignores everyone else. It is the framework's voice; its messages are short, factual
  and English (localising them is a later step). The server polls it with its own offset in `kv`, advanced
  in the transaction that handles the batch, as the main poller does (src/control/bot.ts).
  - `/status`: running turns (chat, how long, pid), turns that failed in the last day with their error,
    outbound rows still pending, and the deployed commit.
  - `/stop <chat>`: stop that chat's turn, with the same semantics as `/stop` in the chat.
  - `/turn <id>`: one paragraph on a turn, and its link in the console.
  - Planned: jobs and cost in `/status`, cancelling jobs, reverting `home/`.
- **The framework's messages are a durable queue** of their own, `control_messages` (pending → sent), never
  `chat_events`: an alert raised just before a restart is still delivered, and nothing of it reaches the
  assistant's chats. Anything may queue there, a runner child included; only the server sends. Delivery is
  at-least-once: a send whose response is lost (or a crash before it is recorded) is sent again, and
  while the owner has not sent the control bot `/start` (403, "chat not found") everything waits rather
  than failing.
- **Alerts**, each raised once (keyed on what it is about). Genuine repeats, such as one chat's turns
  failing again and again, are rate-limited per topic: a repeat within 30 minutes is recorded as
  suppressed and not sent, and the next alert that does go out says how many were suppressed. An
  unanswered message is never suppressed: each one is alerted, keyed on its seq.
  - a turn that failed (raised in the transaction that records the failure);
  - a chat whose input was given up after the retry cap: which message went unanswered;
  - a turn being stopped by the wall-clock limit;
  - outbound rows that failed, or stayed pending past `SHUVI_ALERT_OUTBOUND_MINUTES` (default 10);
  - a lost conversation restarted fresh, and a failed backup;
  - a broken `policy.yaml` (once per broken version; the last good policy stays), a policy change that was
    approved but could not be written, and a private message from someone other than the owner (at most
    once per person per day). A group policy does not list asks once, as an approval card offering to add
    it (src/server/poller.ts, src/policy/write.ts).
  - Planned: an expired job, persistent 429s.
- **Approvals** (src/control/approvals.ts) are the generic way to ask the owner something:
  `requestApproval({ kind, title, body, options, ttl?, originChatId? })` records the question and queues a
  card with one button per option, and returns its id. A button press from the owner is recorded once,
  durably; the card is then edited to show the answer. The caller reads the answer (`getApproval`), or
  names an origin chat and is woken by an `approval` event there, which triggers a turn like a message.
  A card past its ttl expires, and the origin chat is told so. Policy changes (`propose_policy`, and the
  unknown-group card; an approved one is written into `policy.yaml` and committed by a server loop),
  secrets and schedules are its intended callers.
- **Commands that act on the current chat** are sent in that chat, and only the owner's sender id counts:
  - `/new`: start a fresh conversation context, in every lane. `chat_events` and the cursor are kept;
    the new conversation opens with the last 10 messages.
  - `/stop`: stop the turn running in this chat.

  The framework acknowledges a command only by reacting to it; it sends no message.
- **CLI**: deep debugging on the machine (reading `chat_events`, turns, jobs).
- **Console** (docs/console.md): a read-only web view of every turn as the model saw it, and of every chat,
  on loopback only and published to the owner's tailnet with `tailscale serve`, which names the tailnet
  user it lets in. Alerts about a turn link to its page (`SHUVI_CONSOLE_URL`).

**Reliability** the control bot reports on:

- **Turn wall-clock limit** (`SHUVI_TURN_MAX_MINUTES`, default 15): past it the waker sends SIGTERM, and
  SIGKILL after a grace period. The turn closes as `stopped`, so its input counts as handled: a message
  that hangs every turn is not retried into another hang. The turn records why (`term_at`, and an error
  naming the limit), so `turns` alone tells it from an owner `/stop`.
- **Liveness**: a turn's pid and that process's start time (`/proc/<pid>/stat`) are recorded at spawn. A
  pid counts as the turn's only while the start time still matches, so a reused pid neither keeps a dead
  turn "running" nor receives a `/stop` meant for it.
- **A lost conversation** (Claude reports a missing session, or the OpenAI-compatible history is absent
  from the store; either driver throws agent-runtime's `LostSessionError`, and nothing else counts): the chat's conversation is reset and the same turn runs again at once, once, opening with
  the last 10 messages, as after `/new`. It does not count as a failed attempt.
- **Backups**: once a day a consistent copy of `shuvi.db` (`VACUUM INTO`, online) and a `git bundle` of
  `home/` go to `$SHUVI_DATA_DIR/backups/<time>/`; the last 7 are kept. A failed backup is alerted and
  retried an hour later. They sit on the same disk: copying them off the machine is the deployment's job.

## 14. Tools, and where they live

Most tools are shuvi's own, because they act on its concepts: `say`, `react`, `pass`, stickers, chat
retrieval, policy. Tools that need no host state and that other hosts want too live in agent-runtime's
shared layer (`agent-runtime/tools/*`) and are configured by shuvi, never copied: today that is the web
tools (`web_search`, `web_fetch`; `web_scrape` once a Crawl4AI instance is available). shuvi groups its
tools into capability groups (§6); `web` is one. In the code each group is a capability, one folder
under `src/capabilities/` listed in one registry (`src/capabilities/index.ts`), whose order is the order
of the tools and of the prompt sections.

## 15. Each chat's computer

Work that needs a shell (processing a file, running a CLI, a long job) happens on a computer that
belongs to the chat:

- **The home directory is the chat's persistent volume.** User-level installs, configs and caches
  survive; files received in the chat land in `~/inbox/`. The volume is created on first use and capped.
- **The computer runs only when needed.** The first `exec` starts a sandbox container with the volume as
  `$HOME`; it stops when idle. It holds no secrets.
- **What lives outside home is declared, not mutated.** `~/.computer.yaml` lists apt packages and a
  setup script; the framework applies it on top of the shared base image when the computer starts, and
  again whenever the image changes. User-level installs (`pip install --user`, npm into home,
  `~/.local/bin`) need no declaring: they are in home. Anything else installed outside home is gone when
  the image changes.
- **One computer, three ways to run**, following workstream's box tools: `exec(cmd)` (synchronous,
  time-limited), `exec(cmd, background: true)` (asynchronous; the result returns to the chat as an
  event), and `boost: { cpu, memory }` (on a larger short-lived copy with the same home). Framework media
  tools on a FILE of the computer (`video_sheet` with a `path`: contact sheets with each frame's time) are
  prepared `exec` calls. A sheet of a LINK is not: it comes from porchkit (§11) with no computer involved,
  and `video_fetch` downloads through porchkit and copies the file into `~/inbox/`. Transcription
  is not one: it is to come from a shared platform service (§11), which the computer does not install.
- **Visibility follows §6**: the owner's DM may read other chats' homes; a group sees only its own. Only
  a turn the owner triggered gets `exec`.

As built (v1, `src/capabilities/computer/`): the computer is a Hangar Container `shuvi-<chat>` (Hangar
runs it as the Machine `ct-shuvi-<chat>`; computers made earlier keep their recorded name `ct-<chat>`)
with a Disk `home-<chat>` mounted at `/home/shuvi`, both made on the first exec, stopped after
`SHUVI_COMPUTER_IDLE_MINUTES` without an exec or a running job, never deleted; the store's `computers` row
is what every process knows of it. The home disk starts at 5Gi and grows by itself up to 50Gi. All chats
share one base image (`computer/Dockerfile`), which holds only generic tools (python3 and pip, node,
ffmpeg, git, curl, jq, sqlite3, GNU time) and the `shuvi` user; it is public, and what one chat needs is
not. `exec` follows workstream's box tools: a synchronous run with a
timeout, or a background job (an M6 `poll` job) whose end comes back as `job_done` with a usage line, and
`read_job` / `cancel_job`. A boost resizes the same computer (stop, apply, start, then back), so it is
refused while background jobs run. The owner's files are copied into `~/inbox/` when the computer next
runs (never starting it for that), photos only on `save_photo`; `send_file` and `send_photo` send from the
computer. The tools are owner-only at call time. Reading another chat's home from the DM is not built yet.
A stopped container still holds a Hangar machine, so the plan's machine limit (10) is the most chats that
can have a computer.

`~/.computer.yaml` as built (`declared.ts`) is applied at start, never built into an image: there is no
build service and no registry for it, and nothing about it is public. It holds `apt:` (Debian package
names) and `setup:` (a shell script, run with `bash -e`); any other key is an error the model sees.
Before every command a computer tool runs, one short exec, as the user, reads the file and two markers:
the sha256 of the file last applied, on the container's root disk (`/var/lib/shuvi/computer.applied`), and
of one that failed, on the guest's `/run` (a tmpfs, so for this boot only). Hangar keeps a container's
root disk across stop and start and rebuilds it only when the image changes (hangar
`docs/decisions/machine-model.md`), so a matching hash means nothing runs, and a new image or an edited
file is applied before the next command. The apply runs as root, under a lock, each step (apt, setup)
limited by `SHUVI_COMPUTER_APPLY_STEP_SEC`; apt keeps its downloads in `~/.cache/computer/apt`, so
applying after a new image does not download them again. A failure is reported in that command's result
(the failing step and its output, trimmed and redacted; the command still runs) and as an alert, and
the hash is not recorded, so the next start tries again; `apply_computer_config` (owner-only) applies it at
once. Changing the file is owner-only because every computer tool is: only a computer tool can write it,
and each follows `ownerAuthority` (src/agent/turn.ts), refused at call time in a turn with no message from
the owner.

**Secrets** are named profiles (e.g. `modal`: a set of env vars) kept in a host-side store outside
`home/` and git; policy names them, never their values.

- A chat's computer gets a profile only when the assistant asks (`request_secret`) and the owner
  approves, for 4 h / 1 d / 3 d; the owner can revoke it. Groups have none by default.
- A granted profile is injected as env into the one `exec` process that runs, never written to `$HOME`.
- Known secret values are replaced with `[REDACTED:<profile>]` in any output before the model or the
  chat sees it.
- Only a turn the owner triggered can use one.
- As built: profiles live in `/etc/shuvi.secrets.yaml` (mode 600); `request_secret` puts an approval card
  (§13) naming the variables to the owner; a grant puts a "Revoke now" card beside it. Every value in the
  file, and every value it ever held (kept beside it, mode 600), is redacted, also where output is cut at a
  byte offset; a file holding one is not sent; with nothing to redact by, output is withheld.

## 16. Deployment assumptions

- Turns run on agent-runtime's drivers: Claude's starts a Claude Code subprocess per turn, so the machine
  needs at least 4 GB of memory for 2–3 turns at once; an OpenAI-compatible model is called from the runner
  child, its tools through the same boundary. Which models exist is the catalog in `shuvi.db`; a first
  start seeds it with the Claude login and `SHUVI_MODEL`.
- Heavy computation runs remotely.

## 17. Open questions

- Which machine it runs on.
- Migrating from the previous assistant: splitting persona and rules into the §6 layers; converting
  sticker descriptions to the §12 format; whether to import the old conversation logs as `chat_events`.
