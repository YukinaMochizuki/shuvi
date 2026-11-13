# The console

A private web view of what the assistant did: every turn as the model saw it, every chat, and each chat's
timeline. It is for the owner, to debug and tune her. It is read-only, except for one page, **Settings**, which
manages the model catalog (below). Nothing else in it can change anything.

## What it shows

A conversation trace viewer (the design is in `src/console/DESIGN.md`):

- **Chats, conversations, segments** (`/turns`): on the left, every chat, most recently active first. Under
  each, its latest **segments** (runs of turns with no gap over 30 minutes), under the **conversation** they
  belong to: her conversation, the turns that resumed one backend session, from the chat's first turn, a
  `/new`, a lost session's fresh restart, or a switch to another model's conversation (a chat has one per
  model; switching back to an earlier one shows it as a new run with the same session), to the next. Filters
  (outcome, a tool used, a date range in the owner's time zone) and search (thinking, text, tool arguments and
  results, errors, the input) keep the segments holding a matching turn; a chat with none is hidden. `j` / `k`
  move through the segments.
- **A segment** (`/segments/<id>`) or **a whole conversation** (`/conversations/<id>`): one continuous
  exchange, a thin divider at each turn (its outcome, duration, cost, links to the turn and its tabs), a
  dashed one where a conversation went quiet, and a prominent one where it was **compacted** (after which she
  saw only a summary of what came before).
- **One turn**, in three tabs:
  - *Conversation*: what opened it (the trigger marked), then the turn in order: thinking (collapsed),
    tool calls as one-line chips that open onto their arguments and results, her messages with their
    Telegram status, what arrived mid-turn, refusals and errors, and the outcome. A header line holds the
    duration, tokens, cache, cost and model.
  - *System prompt*: by section (persona, directives, this chat, each capability's section, the playbook
    index, memory), each with its size, and a diff against the previous turn's prompt in the chat.
  - *Raw input*: the exact text and images the model received.
- **A chat** (`/chats/<id>`): the chat's whole log, each turn's boundary a divider linking to it.
- **Settings** (`/settings`): the model catalog. See below.

## Settings: the model catalog

The same operations as the control bot's `/models` and `/provider`, through the same code
(`src/store/models.ts`, `src/control/model-cards.ts`), so a change in either shows in the other:

- **Providers**: each one's kind (Claude login or OpenAI-compatible), base URL or config dir, key reference
  (`<profile>.<VAR>`, a name in the secrets file: a key is never entered or shown), and model count. Add one
  (an OpenAI-compatible provider's `/models` is then listed, to add models from with one press; one whose
  listing gives no context length asks for it), list its models again, or remove it with its models.
- **Models**: the default (★), each one's context window, vision (set by you, or from its probe), its last
  probe, and the chats whose own model it is. Make one the default, re-probe it, set vision on, off or auto
  (follow the probe), edit its label and context window, add one by its id, or remove it.
- **Remove** asks first, naming the chats that would lose their model (their next turn fails until they get
  another). The default model, or a provider holding it, cannot be removed: make another model the default
  first.

Probes and listings run in the server, as for the control bot. The page shows them as they stand; reload it
to see one finish.

### The write boundary

Settings is the console's only way in for a write. Every other page answers GET and HEAD only (and
`/login` its POST); a POST to it is refused with 405. Settings' buttons POST to `/settings/<area>/<verb>`, and a
GET there is refused too. A POST there is carried out only if it passes, on top of the sign-in and the Host
check:

- **Origin**: its `Origin` header is the console's own origin: `SHUVI_CONSOLE_URL`'s, or
  `http://127.0.0.1:<port>` (`localhost`, `[::1]`) for the ssh tunnel. A request without one, or from any other
  site, gets 403.
- **A CSRF token**: every form carries a token for your session, an HMAC under a secret the server draws
  at random when it starts. With the tailnet login there is no cookie, so the token is derived from your
  login. With the token sign-in it is derived from your session cookie. A wrong or missing token gets 403.
  After a server restart, a page loaded before it is refused: reload it.

The page needs no script: each write answers with a redirect back to `/settings`, which shows its result once.

## Where the data comes from

The runner child records each turn while it runs (`src/agent/transcript.ts`, tables in
`src/store/schema.ts`): the prompt by hash (`prompt_texts`, shared by every turn that sent the same bytes),
the input (`turn_transcripts`) and the timeline (`turn_steps`). Every text is passed through the secret
redaction first (`src/secrets/redaction.ts`: every value `SHUVI_SECRETS_FILE` holds or ever held, also in its
JSON-escaped form, becomes `[REDACTED:<profile>]`); an unusable secrets file is alerted and noted in the turn.
Images are stored as paths under `media/`, never as bytes. Recording is best effort: a failure is logged and
the turn goes on.

Each turn also records which backend session it ran in and how that session came to be (`turns.opening`: the
chat's first, a fresh one after `/new`, a restart after it was lost, another model's after a model switch, or
resumed), which is what groups turns into conversations. The first turn after a model switch notes it in its
transcript: from what to what, and lossless (how many messages were carried) or lossy. A successful compaction is a
`compaction` step with its trigger and the tokens before and after (recorded when the agent-runtime in use
reports compactions through its `onCompaction` run option); a compaction summary failure or rejection is
recorded as a generic transcript note. Turns from before these were recorded have their conversation inferred
from `/new` commands and lost-session alerts, and say so.

Turns from before recording began (it started with the console's deployment) have no transcript; the console
shows them from the chat's log and says so, with the first recorded turn and its date. The first recorded turn
is kept as a marker, so such a turn is never mistaken for a pruned one.

Transcripts are kept for `SHUVI_TRANSCRIPT_DAYS` (default 30) after a turn ends, then pruned with any prompt
text no transcript points at. An OpenAI-compatible conversation no chat uses any more (not active, not parked
for a model still in the catalog, not a running turn's) is pruned the same time after its last write. Pruning never touches `chat_events`,
and the `turns` row (with its usage) stays.

## Publishing it on the tailnet

The console listens on loopback only (`SHUVI_CONSOLE_LISTEN`, default `127.0.0.1:8787`); the server refuses
to start with any other address. `tailscale serve` publishes it to the tailnet over HTTPS on the machine's
MagicDNS name, and tells it who is asking: it sets `Tailscale-User-Login` on every request it proxies. The
console lets in only the logins listed in `SHUVI_CONSOLE_USERS`; anyone else, or a request without the
header, gets 403.

The header is not a secret: any process on the machine can connect to the loopback port and set it. The
trust boundary is the machine itself (whoever runs code there can read `shuvi.db` anyway). A request must
also name the host of `SHUVI_CONSOLE_URL`, or the console's port on `127.0.0.1`, `localhost` or `[::1]`;
any other `Host` gets 421, so a web page in the owner's browser cannot reach it by DNS rebinding.

```bash
# On the machine shuvi runs on, once (it persists across reboots):
tailscale serve --bg 8787

# In the server's environment (e.g. /etc/shuvi.env):
SHUVI_CONSOLE_USERS=you@example.com               # your tailnet login(s), comma-separated
SHUVI_CONSOLE_URL=https://<host>.<tailnet>.ts.net # what `tailscale serve status` prints
```

`SHUVI_CONSOLE_URL` is how the control bot links to a turn: alerts about a turn (failed, stopped by the
wall-clock limit, given up after the retries) end with its link, and `/turn <id>` answers a paragraph on
the turn and its link.

Use `serve`, never `tailscale funnel`, which publishes to the internet.

## Without Tailscale

With `SHUVI_CONSOLE_USERS` unset and `SHUVI_CONSOLE_TOKEN` set, the console asks for that token instead, at
`/login`, and keeps you signed in with an HttpOnly session cookie for a week (changing the token signs
everyone out). Reach it through an ssh tunnel:

```bash
ssh -L 8787:127.0.0.1:8787 <the shuvi machine>   # then open http://127.0.0.1:8787
```

With neither variable set, the console is off. Transcripts are recorded and pruned either way.

Over the tunnel, open it as `http://127.0.0.1:8787` (or `localhost`): those are the origins a Settings change
is accepted from.
