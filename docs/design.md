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

**runner child**: one process started per turn; it runs that turn through agent-runtime and exits, unless it stays
as its chat's warm runner (below) and runs the chat's next turns too. It is detached,
so where the host lets it (systemd with `KillMode=process`) it outlives the server. In a container it cannot,
so the server drains on SIGTERM instead: it takes nothing new in and waits for the running turns before it
exits (§16). Either way is what makes invariant 3 hold.

**warm runner** (`SHUVI_WARM_RUNNERS`, default off; `src/runner/warm.ts`): a runner child whose turn ran on
Claude may stay after it, holding a resident Claude Code CLI for its chat (agent-runtime's `ClaudeSession`),
so the chat's next turn pays neither cold start (loading shuvi, starting the CLI). One runner serves one chat
only, so permission boundaries never mix. It is the same detached process, with the same liveness (pid and
start time), and while idle it is a `warm_runners` row (`src/store/warm.ts`). The waker HANDS it the chat's
next turn instead of spawning a child: in the claim's transaction the turn takes the runner's pid and the
row is deleted, so the unique index still keeps one turn per chat (invariant 4), then SIGUSR1 wakes it. A
hand-off the runner never took, its runner gone or too slow (then abandoned first, so a late take fails, and
killed), never started: it closes without counting as a failure and is answered again. Two guards keep a
runner's CLI from missing a turn: a runner is never registered while another process runs its chat's turn (it
registers in a transaction that refuses then, and the hand-off is decided in the claim's transaction), and a CLI
that has not seen the chat's last closed turn (one that ran and closed elsewhere while the runner was not
registered) is reopened on a resume before it serves another. A runner on other code or another configuration
than the server's is retired, at the server's start and at a hand-off: its code version (the deployed commit)
and a hash of the whole environment a child gets (each value hashed first, so nothing secret is stored) plus
its enabled capabilities are compared with the server's own. A CLI cannot change its system prompt or tool list, so the runner re-warms AT ONCE when
what the next turn would be given changes (an edit to home/, policy): a new CLI on a resume of the
conversation, in the background, before the next message; a turn that still does not fit opens its CLI
at its start. The runner leaves on SIGUSR2 (retire), on SIGTERM (which keeps meaning "stop the turn"), idle
past `SHUVI_WARM_IDLE_SEC`, after a turn whose conversation was lost, or when its row is deleted, which is
how the server retires it (`/new`, `/newclean`, a switch of model, provider or profile, the drain, a server
on other code). At most `SHUVI_WARM_MAX` wait at once. The owner can PIN a chat warm from the console (Keep warm on its
settings page, `chats.warm_pinned`): its runner never idles out and does not count toward that cap, and the server
starts a turnless runner for it (it opens the chat's CLI and waits, with no turn of its own) whenever it has none,
so after a deploy, a restart, a `/new` or any exit of its runner, the chat is warm again before its next message;
not while draining, and with a backoff and one alert when starts keep failing. Every other retire rule applies to
a pinned runner too. What a turn says, and its idempotency keys, are as for any
turn (invariant 2); the reply of every turn is queued when the driver reports its result, before the CLI has
settled (`src/agent/turn.ts`).

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
  conversation per MODEL: the active one on `chats` (`conversation_model` says whose), the others parked in
  `chat_conversations`. On every switch, between any two models, the owner chooses between lossless (what
  the active conversation gained since it was entered, which is what the target's lacks, is appended to the
  target's; a target with none gets a copy of all of it), lossy (nothing is: the target's conversation
  resumes as it was left, or a fresh one opens with the last 10 messages) and clean start (nothing is, and the
  target's own conversation is dropped: a brand-new one opens with the next turn's input only, not even the
  last messages; her persona, rules, memory and notes are in the system prompt as always, but she has no
  `search_chats` / `read_chat` for as long as that conversation lasts: a CLEAN conversation, `chats.clean_since`,
  which goes where the conversation goes: parked and resumed with it, kept when a lost session restarts it, and
  then shown only what was said since it began). The same clean start without changing model is `/newclean`
  and the console's "Start clean" (`/new` whose next turn opens with its input only, in a clean conversation). A LANE is only where a
  conversation is stored, and so which converter carries it: a Claude login's session files, or the
  OpenAI-compatible tables; within one Claude login a copy is the session itself, forked. A chat that
  follows the default moves lossy to the new default's conversation at its next turn. A switch asked for
  while a turn runs stops the turn first (`model_switch_requests`); the new model answers that turn's
  messages, and a lossless carry stops where that turn began, so it gets them once. The model is never told;
  `model_switches` records each switch, and the turn after it says so in its transcript
  (`src/agent/switch.ts`). A parked conversation whose model left the catalog ages out like an abandoned one.
  `chat_events` is "what actually happened", for people and for retrieval tools.
- **Deleting messages**: append-only has one exception, the owner deleting chat messages from the console
  (`src/store/deletions.ts`). It is a HARD delete with no trace: the rows (a person's message, photo or
  sticker, or hers, with her reactions to them) move out of `chat_events` into `deleted_events`, seq and all,
  so nothing that reads the log sees them again: not a fresh conversation's last 10 messages, not a turn's
  input, not `search_chats` / `read_chat` (their FTS rows go too), not the console. Their verbatim copies go
  with them: a reply's quote of one; the message's line in turn transcripts (input and mid-turn appends, with
  what counts or names it there: "the last N messages", the unread note, the "called by" heading) and in what
  `read_chat` / `search_chats` gave a turn; and a message of hers as the turn that wrote it recorded it (its
  text block, or the `say` call's `text`). Nothing marks where they were, and the model is not told. What is
  NOT touched: the model's conversations (a Claude Code session or `conversation_messages` keeps what it was
  shown, and her thinking or another tool's arguments or results may paraphrase it), Telegram, and the
  backups (they age out). A message in a turn still running, or one of hers not sent yet, is refused. It can
  be undone for 10 seconds, byte for byte (the stash is in `deleted_events` and `deletion_scrubs`); a delete
  while the chat's last one can still be undone joins it, its window starting again, so one undo puts back all
  of them. An undo is refused once the chat has moved on (a turn started since, or the cursor or a running
  turn past a message): put back, it would sit as input never seen, or behind the cursor, never answered.
  Then the server purges it, with any `media/` file nothing kept still names, and a purge due while the
  server was down runs at its next start.
- **Deleting a turn**: the owner can delete a whole turn from the console, so that it is gone entirely: its
  record (`turns`, `turn_steps`, `turn_transcripts`, moved into `deleted_turns`, `deleted_turn_steps`,
  `deleted_turn_transcripts`), the messages it wrote (her messages, stickers, files and reactions), and the
  messages it answered (every trigger event in its input range, in a group other people's chatter too). Those
  messages go through the message delete above, so every scrub applies. It joins the chat's open deletion
  (one Undo for messages and turns deleted in a row), undoes under the same rules, and its purge also drops a
  system prompt (`prompt_texts`) no other turn uses and the turn's pictures nothing else names. A running
  turn, and a turn with a message still to send, are refused. Not undone: what the turn did (home/ commits,
  schedules, jobs) and what the model's conversation holds. Pointers to its id stay as they are
  (`model_switches.turn_id`, `schedules.created_turn_id`, alerts' links, a commit's `Turn:` trailer); the
  console answers them with "this turn was deleted or does not exist". Exactly-once keys survive any delete: a
  deleted row's `idem_key` blocks a new write with it while it waits out its undo, and after the purge the key
  alone is kept (`spent_idem_keys`), so a webhook retried with the same Idempotency-Key is not recorded again.

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
  profiles/<name>/        a profile: only the files it replaces, at their usual paths
    profile.yaml          its label, and the base playbooks and sticker packs it hides
```

**Profiles** (src/capabilities/memory/layers.ts). The owner can run one chat with different sets of her files
for different situations ("work" and "personal" for his DM, say), and switch at any time. A profile is an
OVERLAY: `home/profiles/<name>/` holds only the files it replaces; every other file comes from the BASE (home/
as above). Any of her files can be overlaid: both personas, `directives.md`, `memory/private.md`, a chat's
notes, a playbook (a profile may replace one, add its own, or hide a base one), the sticker preferences and
packs. Not `policy.yaml` or `inbound.yaml`. Each chat uses one profile or none (`chats.profile`), from its
next turn: a running turn finishes on what it began with, and each turn records the profile it ran under
(`turns.profile`). A chat set to a profile that no longer exists runs on the base, and the owner is told once.

SHE NEVER KNOWS profiles exist. One resolver answers, for a LOGICAL path (what she, her tools and the allow-list
see), the file in effect: the profile's own copy if it has one, else the base's; a playbook the profile hides
reads as absent. Every reader and writer of her files goes through it (the prompt, the playbooks, the memory
tools, the sticker library). Her edit goes to the copy in effect; a NEW file goes to the base, except a playbook
the profile hides, which becomes the profile's own. Sticker packs overlay by PACK (a profile's file for a pack
replaces Base's, whatever its file name), and `remove_sticker_pack` on a profile's own copy removes it and hides
the pack in that profile, so it is gone for chats on it while Base, and every chat on Base, keep it. Nothing in her
prompt, a tool's description or its result (errors included) names a profile. Only the owner sees or switches them: on the console's Home and chat pages, and with `/profile`
(§13). Privacy rules apply to the logical path: `profiles/<p>/memory/private.md` still reaches only the owner's DM.

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
  | `say(text, reply_to?)` | say something partway through a turn; with `reply_to`, as a reply to that message |
  | `react(event, emoji)` | react to a message |
  | `sticker(id)` | send a sticker |
  | `send_photo` / `send_file` / `send_voice` | images, files, voice messages |
  | `reply_to(event)` | make the next message (usually the final text) a reply to that message |
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
    text a reply to that message; otherwise sends it plainly. In a DM, no reply by default. A message
    the assistant named a reply target for (`say`'s `reply_to`, or `reply_to` before it) replies to that
    instead, the first one included.
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

Each layer that comes from a file is read through the chat's profile, if it has one (§3): the profile's copy
where it has one, the base's otherwise.

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
  trigger. Anything older is reached with `read_chat`. In a clean conversation (`/newclean`, §5) there is no
  `read_chat`, and none of those messages from before it began is shown.

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
  owner's, except what a group delegates to its operators (below). The framework checks the sender's Telegram user id; the model's judgement is not relied
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
- **A group may have operators.** The owner may name people he trusts in a group (`operators`: their
  user ids, or `members`, everyone there but bots) and the capabilities whose owner-only tools they may
  ask for too (`delegate: [computer, schedules, media, workstream]`). Only the tools a capability declares
  delegable can be handed over (`delegable`, src/capabilities/types.ts); what is the owner's own (his files
  and persona, policy, sending to other chats, the sticker library) never is. Workstream is delegable by
  the owner's choice: its reads only read, held to the chat's products, and whatever an operator's desk
  request would change still waits for the owner's approval on his phone. The same rule then
  decides, with the operator in the owner's place: a message from an operator, or a schedule or job an
  operator's call set up (recorded on its row, `authorised_by`) while policy still names them, lets a
  delegated tool run (`callAuthority` / `operatorAuthority`); context lines count for nothing. Operators are
  trusted as the owner is for what is delegated: their commands get the chat's granted secrets, and their
  files are copied into the chat's computer. Withholding secrets from their commands alone would protect
  nothing, since anyone who can run commands in a home can reach whatever later runs there. A secret is
  still granted only by the owner's answer to its card, and that answer counts as the operator's, never
  as the owner's (`approvals.requested_by`), so pressing it lends them nothing more. What the owner
  started (a schedule, a job) only he can cancel. Lines from operators named by id carry
  `⚙ operator`. Operators are for groups only: the owner's DM is his alone.
- **Policy changes are proposed by the assistant and approved by the owner, or made by the owner himself.**
  `propose_policy` produces a diff; the framework writes and commits it only when the owner's user id agrees
  (or presses the inline button). The owner may also change a chat's entry himself on that chat's settings
  page in the console (docs/console.md): he sees the diff first, the change is checked by the same parser (a
  private layer is refused in a group however the form is posted), only that entry is rewritten (the file's
  comments and the other entries are kept), and it is committed as his, from the console.

The other files in `home/` (persona, directives, memory, playbooks, stickers) are edited by the assistant
directly when the owner asks, with a commit per edit and a one-line note in the chat. Each of her commits records
the turn, the chat and the tool call it was made in (as trailers), so every change to a file can be traced to the
exact call. The owner edits them himself on the console's Home page (docs/console.md), which shows each file's
history, and undoes or restores a version there; or he asks her, or uses git directly. Requests from anyone else
in a group can at most be written into that chat's notes. A profile's files (§3) are committed at their own
paths (`profiles/<name>/…`), so each has its own history; a commit that made a profile's copy from the base (or
brought it up to date with it) says which base commit as the trailer `Base-Commit`, so the console can tell when
the base changed since; every console save of a copy records the base commit its text is based on (a restored
version or an undone change brings back the one in effect then). A profile renamed, duplicated or deleted is one commit.

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
- `poll`: the framework checks the status periodically. A remote that knows when it changed may wake the
  job instead, on a route its capability adds to the hooks (workstream's desk: `/workstream/wake`); the
  wake carries no result, it only moves the next check to now, and the interval stays the fallback.
- Past its deadline with no result, a job is polled once; still nothing, it is marked `expired` and that
  is written back to the origin, so nothing vanishes silently. Repeat reports are deduplicated by job id.
- Whichever way, the result becomes a `job_done` event in the origin chat.

A **schedule** is set by the owner (or, in a group that delegates schedules, by one of its operators,
§8), or proposed by the assistant and set once the owner agrees. When it
comes due, the framework writes a `scheduled` event into the target chat, and the turn runs in that
chat's conversation with its context. The assistant may `pass()` each time. There is no background
patrol (heartbeat) and no unprompted speaking: every wake-up has a stated purpose.

The owner can also **pause** a schedule, and resume or cancel it, from the chat's settings page in the console
(docs/console.md). A paused schedule is kept but never fires; the assistant still sees it, as paused
(`list_schedules`), and can still cancel it. Resumed, it runs next from NOW: nothing it missed while paused is
fired, not even the one catch-up a downtime gives; a paused one-off whose time has passed is cancelled, not run
late (src/store/schedules.ts).

An **inbound source** carries external events the assistant did not start (a monitoring alert, say):
`POST /inbound/<source>`. The chat it lands in, and whether it triggers a turn, are declared in
`home/inbound.yaml`; its token is in the server's environment (`SHUVI_INBOUND_<NAME>_TOKEN`), never in
`home/`, which the assistant can read. It becomes an `external` event in that chat.

## 11. Media

The framework does not filter noise on the assistant's behalf, and does not prefetch links, with one
exception the owner decided (the prewarm, and auto-read on top of it, below); otherwise the assistant calls
a tool when it needs to.
Where a forward came from and the text being replied to are recorded as event fields.

- **Videos from links** go through porchkit, a separate service on the owner's home connection
  (`src/capabilities/media/`, `src/porchkit/`): what a video is, its subtitles, contact sheets, a download.
  It is always anonymous: nothing behind a login is ever fetched, and the assistant says so rather than
  guessing. Its per-site request budgets protect the home IP and porchkit enforces them; told to wait, the
  assistant says it is busy and roughly how long. Anyone may have the assistant LOOK at a video in a chat
  whose policy enables media; a download onto the computer (`video_fetch`) is the owner's, or in a group
  that delegates media, its operators' too (§8).
- **The prewarm** is the one prefetch: every http(s) link of a message that starts a turn (from anyone:
  the waker's own decision, §7; every message in the owner's DM), then of the message it replies to, at
  most 3, is read through porchkit's `/read` as soon as the message is recorded, alongside spawning the
  turn. There is no host list: `/read` reads any link, and for a video site probes the video itself. A
  speculative read, never a download; best effort (a failure is logged and ignored; porchkit refuses it
  when the site's budget is half used). It does not delay the turn, except that a message auto-read
  qualifies for (below) may make its turn wait for it, up to auto-read's cap; a chat whose policy leaves
  media out gets none. The framework only says what is ready ("(Prepared: #53's link — read_link returns at once.)"),
  and the assistant asks when it wants it, except under auto-read. Each prewarm is recorded with whether the
  turn then used it.
- **Auto-read** (`src/capabilities/media/autoread.ts`): a message that opens a turn with one or two links
  and little else (at most `SHUVI_AUTOREAD_MAX_CHARS` characters of its own, default 40), from a sender the
  boundary would let call `read_link`, opens with its links already read, which saves the model's first
  round trip. While its prewarm is in flight its turn waits, up to `SHUVI_AUTOREAD_WAIT_SEC` (default 8 s):
  this is perception gating, so like any hold it holds the chat's turn, and a message after it waits too. A
  message a running turn would take in is not held, and is appended as before. Then, before the model runs,
  the runner child reads each link the prewarm answered through `read_link`'s own handler and the turn's
  tool boundary (the same authority, redaction and accounting as her own call, recorded as the
  framework's), for at most `SHUVI_AUTOREAD_READ_SEC` (default 10 s) and never past a stop. The answer
  follows the message as a framework part that nobody can forge, its page text marked as untrusted fetched
  material. A prewarm past the cap, failed or refused leaves the message as above; a read that fails or does
  not finish leaves a note saying `read_link` is there. It only changes what the model is given: the
  framework still never speaks (§1, 5).
- **Her own browser** goes through porchkit too (`src/capabilities/browser/`): a real Chrome on the
  owner's home machine, signed in to accounts made for her, driven step by step through `/browse` with
  generic tools (no per-site scripts), one window per chat. Unlike reading, it is not anonymous and not
  limited to reading: a chat whose policy enables `browser` may have her act on a site, anyone there may
  ask, and the owner watches or takes over from a live view. Money never moves without him: porchkit
  refuses the action that may place an order (a final-step button anywhere; on a checkout page any button,
  Enter, a submit or accepting a dialog; accepting a dialog that reads like ordering) unless shuvi says it is approved, and shuvi
  says so only for one action carrying an approval card the owner answered (one card, one action, that
  chat only). Google sign-in and account-security pages are the owner's own; the rest of her Google account is
  hers. The browser has 1Password, signed in to an account of hers (never his, and never holding her Google
  credentials): its prompts (fill, sign in, save a login or a passkey) are usable only on a call that acts for
  the owner himself, as a secret is (decided by the owner, 2026-11-26); porchkit refuses them otherwise, and they
  lock whenever the desktop's Chrome restarts, until he unlocks them in the live view. She can give a page a file sent in the chat or downloaded by the browser; a file from her computer only as
  the computer's tool, under the computer's authority.
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
  - `/model <chat>`: a card to switch that chat's model (below); `/model <chat> <provider>/<model>
    lossless|lossy|clean` switches with no card and replies with the result.
  - `/profile <chat>`: a card to switch which profile (§3) that chat uses: Base and every profile, the
    current one ✓; a press switches it, from the chat's next turn, and the card says so.
  - `/models`: the catalog as a card: each model's id, label, default ★, context window, vision and probe
    state, with Make default, Re-probe and Remove (which first names the chats whose own model it is; the
    default cannot be removed). `/models add <provider>/<model> [<context_window>]` adds one directly.
  - `/provider add <name> <base_url> [<profile>.<VAR>]` adds an OpenAI-compatible endpoint; the card then
    lists the endpoint's `/models`, and pressing one adds it with the listed context window. `/provider add
    <name> claude [<config_dir>]` adds a Claude login; its card lists what Claude Code offers that login
    (each alias, which follows new versions, then the fixed version it stands for now), and pressing one adds
    it with its label. `/provider remove <name>` names its models and the
    chats on them, then removes them all. A key is only ever named (`<profile>.<VAR>` in the secrets file),
    never entered or shown.
  - Planned: jobs and cost in `/status`, cancelling jobs, reverting `home/`.
- **The switch card** (src/control/model-cards.ts) is one control-bot message, edited in place, opened by
  `/model` in the main chat (acknowledged there with 👌 only) or by `/model <chat>` here. First the model:
  the catalog, 6 a page, the chat's model ✓ and a model whose last probe got no tool call ⚠ (still
  selectable: without tools she cannot speak). Then the mode, always offered, between any two models:
  Lossless, Lossy and Clean start, each with a line on what it would do in this chat now ("carries 14 new
  messages into X's conversation", "resumes X's conversation from 3 days ago", "starts X fresh, with no
  messages", …), and the running turn it will stop.
  The press asks for the switch (agent/switch.ts `requestSwitch`): the server stops a running turn, then
  switches, and the card goes from "switching…" to the result with no buttons. A card's state is a
  `control_cards` row and a press is recorded in the control batch's transaction, so a restart between
  steps loses nothing, and a press on an old step or a closed card changes nothing ("This card is
  closed."). A newer switch card for the chat, or a newer `/models` card, supersedes the older open ones. An
  open card follows what it shows: `/models` and `/provider add` cards when the catalog changes, a mode
  step when a turn starts or ends in its chat; a relative time moving on alone is not edited.
- **Probes** of OpenAI-compatible models run in the server, in the background (src/server/probes.ts,
  agent-runtime `probeModel`): when a model is added and on Re-probe. The result (tool call ok, text
  instead, or failed and why; latency; whether a picture was accepted) is on the model's row, sets its
  vision unless the owner set it, and edits the cards that show it. One a restart interrupted runs again.
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
  - `/new`: start a fresh conversation context, forgetting every model's conversation of the chat. `chat_events` and the cursor are kept;
    the new conversation opens with the last 10 messages.
  - `/newclean`: as `/new`, but a clean conversation (above): it opens with its new messages only, and she cannot
    look back through what was said (no `search_chats` / `read_chat`) for as long as it lasts.
  - `/stop`: stop the turn running in this chat.
  - `/model`, `/profile`: the control bot sends the owner the card for this chat (above), so nobody else in a
    group sees it.

  The framework acknowledges a command only by reacting to it; it sends no message.
- **CLI**: deep debugging on the machine (reading `chat_events`, turns, jobs).
- **Console** (docs/console.md): a web view of every turn as the model saw it, and of every chat, where the
  owner also edits her files (Home) and the model catalog (Settings); on loopback only and published to the
  owner's tailnet with `tailscale serve`, which names the tailnet user it lets in. Alerts about a turn link to
  its page (`SHUVI_CONSOLE_URL`).

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
  a turn the owner triggered gets `exec` (or, where a group delegates its computer, one its operators
  triggered: §8).

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
computer. The tools are owner-only at call time, unless a group's policy delegates the computer to its
operators (§8), and then theirs too. Reading another chat's home from the DM is not built yet.
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

**Secrets** are named profiles (e.g. `modal`: a set of env vars) kept outside `home/` and git: in a
host-side file, or in the store, sealed under a key only the environment holds; policy names them, never
their values.

- A computer gets a profile only when the owner grants it: on the card the assistant's `request_secret`
  puts to him, or, for every chat, on the console's Secrets page. A grant is for THIS CHAT (4 h / 1 d / 3 d)
  or for EVERY CHAT (4 h / 1 d / 3 d / until revoked). An every-chat grant is the owner's: it goes into a
  command only in a call that acts for him (agent/acting.ts), never in an operator's, so delegating a
  group's computer (§8) never hands it over; an operator's request card does not offer it. A call acts for
  him whenever his own message is in the turn (`ownerAuthority`), so in a group that delegates its computer,
  a turn holding both his message and an operator's runs with every chat's grants: that is his presence
  lending them, as it lends every owner-only tool. The owner can
  revoke any grant on its card in the control bot or from the console, which presses the same card (only
  names are shown there, never a value). Groups have none by default.
- A profile there is not yet is asked for the same way, with the variables it needs and what each one is
  (`request_secret` with `vars`): the owner's card then has only Deny and a link to the console, where he types
  the values and picks the grant; values are never typed into a chat, his or hers. New values for some
  variables of a profile he keeps are asked for the same way (`request_secret_update`): only those change. The console page is opened
  from the card on a phone, so it is built for one.
- A granted profile is injected as env into the one `exec` process that runs, never written to `$HOME`; or
  typed into her browser's page by `browser_type` with `secret` (the owner's call only), which she never sees:
  porchkit masks that field in every picture and page text after, and every browser answer's text is redacted.
  What the mask does not cover: a page that shows the value somewhere else (a confirmation page) shows it in its
  pictures, and anyone who may use the browser in that chat can take a screenshot of it; pictures are never
  redacted. A typing that fails having left part of the value unmasked (porchkit's `left`) is told to her as that,
  and she stops and tells the owner.
- Known secret values are replaced with `[REDACTED:<profile>]` in any output before the model or the
  chat sees it.
- Only a turn the owner triggered can use one, or, in a group that delegates its computer, a turn one of
  its operators triggered (§8), and then only that chat's own grants.
- Each profile may carry a NOTE, which is not secret: a one-line summary in her prompt beside its name (what
  it is for, so she knows it is there) and details she reads when she needs them (scope, account or org
  ids, how to use it), so what was found out once is not found out again. The owner writes it in the console;
  she keeps what she learns with `update_secret_note`, in the owner's turns only. A note holding a secret
  value is refused.
- As built: the file's profiles live in `/etc/shuvi.secrets.yaml` (mode 600); the console's in
  `secret_profiles`, AES-256-GCM under `SHUVI_SECRETS_KEY` with the profile's name as additional data
  (src/secrets/vault.ts), so the database and its backups hold no readable value; a name is one or the
  other, the file's winning (a personal-info profile of the same name is another thing). `request_secret` puts an approval card (§13) naming the variables to the owner;
  every grant puts a "Revoke now" card beside it. Every value either holds, and every value either ever held
  (kept beside the file, mode 600), is redacted, also where output is cut at a byte offset; a file holding
  one is not sent; with nothing to redact by, output is withheld. Notes live in `secret_notes`.

**Personal info** is the owner's data she must READ to work with it: a postal address to split into a form's
fields or translate, a phone, an email, a member number. A secret is wrong for that (she never sees one), and her
prompt or home/ files are wrong too (they are read in every turn, by every chat's model, and nothing records who
changed them). So there are two concepts for her, sharing one storage:

- **A profile is one or the other.** A secret is only typed or injected, never seen, and redacted everywhere;
  personal info is read, and never redacted. Mixed data is two profiles (an address, and the ID number she
  types).
- **Read by the owner's own turns, in any chat, with no grant**: `info_read` is owner-only and not delegable,
  so an operator never gets it; the capability is on in every chat whatever its policy says, and its prompt
  section lists only names and one-line summaries. She is told not to say a value in a group unless the owner
  asks there.
- **Kept by her when the owner tells her** (`info_write`, owner-only, not delegable) or asked for on a card he
  answers in the console (`request_info`, the provide card of secrets with no grant). Every change records the
  values from before it, who made it and which fields; the owner sees the history in the console and restores any
  version. A value holding a secret's is refused, so a secret is never copied into personal info.
- **Changing kind is the owner's, in the console, confirmed**: a secret made personal info leaves the known file
  (but for a value another secret still holds, which stays redacted wherever she reads it) and loses every grant;
  personal info made a secret joins the known file first and loses its history. Either is refused, nothing
  changed, when the known file cannot be written.
- As built (src/secrets/info.ts, src/capabilities/info/): a `secret_profiles` row of kind `info`, sealed as a
  secret's is but with the kind in the additional data, so a row cannot move kinds without being sealed anew; its
  history in `info_versions` (sealed, the newest 20); its note a `secret_notes` row of kind `info`, whose
  `- NAME: what it is` lines label its fields. It needs `SHUVI_SECRETS_KEY`: without it the capability is off.
  In the console its values are masked until the owner shows them.

## 16. Deployment

- Turns run on agent-runtime's drivers: Claude's starts a Claude Code subprocess per turn, so the machine
  needs at least 4 GB of memory for 2–3 turns at once (with warm runners on, each waiting one holds about
  300 MB, a Bun runner and its CLI: at most `SHUVI_WARM_MAX` unpinned ones plus one per chat pinned warm); an OpenAI-compatible model is called from the runner
  child, its tools through the same boundary. Which models exist is the catalog in `shuvi.db`; a first
  start seeds it with the Claude login and `SHUVI_MODEL`.
- Heavy computation runs remotely.

**The container.** shuvi ships as one image (`Dockerfile`): Bun on Debian slim, a non-root user, `tini` as
PID 1, and only the server, the runner and their dependencies (the Claude Code CLI comes with the Agent
SDK). Configuration is the environment (`src/env.ts`). Two volumes hold everything that must survive a
redeploy: `SHUVI_DATA_DIR` (`/data`: `shuvi.db`, `home/`, `media/`, `backups/`) and the Claude login dir
(`SHUVI_CLAUDE_CONFIG_DIR`, `/claude`: the login and Claude Code's session files), both owned by the image's
user. `SHUVI_CLAUDE_CONFIG_DIR`, when set, is applied to the catalog's `claude` login on every start, not only
the first (`reconcileClaudeLogin`, `src/store/models.ts`), so a store moved in from elsewhere uses the volume.
The working directory is fixed (`/app`), which matters because Claude Code files a session under the
directory it runs in: a store moved in from a checkout elsewhere finds none of its Claude sessions once, and
each chat starts over as after a lost session. CI builds the image on every push to `main` once the checks
pass, and pushes it to the GitHub Container Registry (`ghcr.io/<owner>/shuvi`, public, as the code is) with
the workflow's own token; the owner's platform pulls it from there when `:main`'s digest changes, so nothing on
GitHub holds a credential of the platform.

One server per data dir, always: a turn's liveness is its pid and that pid's start time (`spawn.ts`), which
mean nothing across containers, so a second server started on the same `/data` while the first still runs
(or drains) would take its turns for dead and run them again beside the originals, breaking invariants 2 and
4. The old container must have stopped before the new one starts.

Running it from a checkout under systemd, with `KillMode=process`, is the old way; it still works, but a
restart there now drains too: up to `SHUVI_DRAIN_SEC` without polling, where before the server exited at once
and its turns carried on. Accepted, since the container is the deployment.

**Draining shutdown** (`src/server/drain.ts`). In a container, stopping the server stops every process in
it: a runner child can no longer outlive the server, so invariant 3 is kept by waiting instead. On SIGTERM
(tini forwards it to the server alone):

1. the Telegram poller stops, and the waker starts no new turn (it still reaps dead turns and enforces the
   wall-clock limit). The sender, the control bot and every other loop keep running. The drain flag is set
   in the store and every idle warm runner (§2) is retired: a runner in a turn finishes it like any turn,
   sees the flag and exits rather than staying (`src/server/warm.ts`). What the drain counts as running is
   the turns, as before; an idle warm runner is not one. The next server clears the flag, forgets runners
   that are gone, retires those on other code, and adopts the rest;
2. the server waits until no turn runs and nothing is queued to send, up to `SHUVI_DRAIN_SEC` (default
   600). Once the last turn has ended, its messages get at most 30 s more to go out; a row Telegram keeps
   refusing is left for the next server;
3. at the deadline, each turn still running is stopped as a model switch stops one: SIGTERM to its child,
   with the stop placed at the turn's start (`stop_seq` = `from_seq`), so it closes as `stopped` with the
   cursor where it was and the next server answers the same messages again. The row is marked first
   (`DRAIN_STOP`, `src/store/turns.ts`), so whoever closes it records why. A child still there
   `SHUVI_DRAIN_GRACE_SEC` (15) later is killed and its turn closed the same way (by the drain, or by the
   waker's reap, which closes a dead turn that was being stopped as `stopped`, never `failed`). The owner is
   told in the control bot;
4. the senders finish the send in flight (up to 10 s, so a message Telegram accepted is recorded and not
   sent again by the next server), and the server exits 0.

What holds through it:

- Nothing perceived is lost: a message that arrives during the drain is not fetched, so Telegram keeps it
  and hands it to the next server (the offset only moves with what was recorded, §2). Schedules, jobs and
  inbound hooks keep writing to the store.
- Nothing said is lost or said twice: delivery stays with the sender and its idempotency keys; a row still
  pending at exit is sent by the next server. A turn stopped at the deadline may have said part of its
  answer. Its retry resumes the same conversation, which already holds that turn's input and what it said,
  and gets the same messages again; so they come under a framework line saying the previous turn on them
  was cut off by a restart and what was sent stands (`RETRY_NOTE`, `src/agent/render.ts`). The model can
  then finish rather than start over, though nothing forces it not to repeat itself. (A model switch is
  different: the target conversation never held the stopped turn's part, so it needs no such line.)
- A chat stays ordered: a stopped turn is closed before the server exits, so the next one finds none
  running there.

The container's stop timeout must exceed the drain (`stop_grace_period` ≥ `SHUVI_DRAIN_SEC` +
`SHUVI_DRAIN_GRACE_SEC` + 15 s), or the runtime kills it partway. A server that dies without draining
(SIGKILL, a crash, an OOM kill) takes its turns with it in a container; the next server reaps them as failed
and retries them (`src/server/waker.ts`). A second SIGTERM or SIGINT skips the rest of the drain.

**Before a migration.** When the server starts with migrations pending, it first copies the store (`VACUUM
INTO`, a consistent snapshot) to `$SHUVI_DATA_DIR/backups/pre-migrate-<from>-<to>-<time>.db` and keeps the
last 5 (`src/store/migrate-backup.ts`), pruning the older ones before it copies so a disk full of them frees
room first. If the copy still cannot be written, it does not migrate and does not start.

**Health and metrics** (`src/server/health.ts`), on `SHUVI_METRICS_LISTEN` (loopback, default
`127.0.0.1:8788`, anything else refused at startup), always on. Loopback is the container's own network
namespace; Prometheus reaches it through a tailnet sidecar sharing that namespace, which publishes it with
`tailscale serve`:

- `/healthz`: 200 when the store answers and the poller completed a long poll in the last 120 s (or the
  server is draining); 503 otherwise. The image's `HEALTHCHECK` calls it.
- `/metrics`, Prometheus text, counts and times only (never a URL, a chat or any text):

  | metric | type | what |
  |---|---|---|
  | `shuvi_turns_started_total` | counter | turns started |
  | `shuvi_turns_finished_total{outcome}` | counter | turns finished: `done`, `stopped`, `failed` |
  | `shuvi_turns_running` | gauge | turns running now |
  | `shuvi_outbound_pending` | gauge | outbound rows waiting to be sent |
  | `shuvi_outbound_failed_total` | counter | outbound rows Telegram refused for good |
  | `shuvi_poll_errors_total` | counter | failed Telegram long polls (this process) |
  | `shuvi_last_poll_timestamp_seconds` | gauge | when the last long poll completed |
  | `shuvi_draining` | gauge | 1 while draining |
  | `shuvi_drain_deadline_timestamp_seconds` | gauge | when the drain stops what still runs (0: none) |
  | `shuvi_prewarms_total` | counter | links prewarmed through porchkit |
  | `shuvi_prewarm_hits_total` | counter | prewarmed links a turn then used |
  | `shuvi_start_time_seconds` | gauge | when this server process started |

  The turn, outbound and prewarm counts are read from the store at each scrape, so they hold whichever
  process wrote the rows and survive a restart.

**CI** (`.github/workflows/ci.yml`): typecheck, the unit tests and every `scripts/e2e-*.ts` on every push and
pull request, against fakes only, so no secret is needed. `release.yml` builds and pushes the image after
CI passes on `main`.

## 17. Open questions

- Migrating from the previous assistant: splitting persona and rules into the §6 layers; converting
  sticker descriptions to the §12 format; whether to import the old conversation logs as `chat_events`.
