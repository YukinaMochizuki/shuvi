# The console

A private, read-only web view of what the assistant did: every turn as the model saw it, every chat, and each
chat's timeline. It is for the owner, to debug and tune her. Nothing in it can change anything.

## What it shows

A conversation trace viewer (the design is in `src/console/DESIGN.md`):

- **Chats and their turns** (`/turns`): on the left, every chat, most recently active first, each with its
  latest turns (filtered by outcome, a tool the turn used and a date range in the owner's time zone; searched
  across thinking, text, tool arguments and results, errors and the input; a chat with no matching turn is
  hidden). On the right, the selected turn (`/turns/<id>`), or a chat as a conversation (`/chats/<id>`, from
  the chat's name). `j` / `k` move through the turns.
- **One turn**, in three tabs:
  - *Conversation*: what opened it (the trigger marked), then the turn in order: thinking (collapsed),
    tool calls as one-line chips that open onto their arguments and results, her messages with their
    Telegram status, what arrived mid-turn, refusals and errors, and the outcome. A header line holds the
    duration, tokens, cache, cost and model.
  - *System prompt*: by section (persona, directives, this chat, each capability's section, the playbook
    index, memory), each with its size, and a diff against the previous turn's prompt in the chat.
  - *Raw input*: the exact text and images the model received.
- **A chat** (`/chats/<id>`): the chat as a conversation, each turn's boundary a divider linking to it.

## Where the data comes from

The runner child records each turn while it runs (`src/agent/transcript.ts`, tables in
`src/store/schema.ts`): the prompt by hash (`prompt_texts`, shared by every turn that sent the same bytes),
the input (`turn_transcripts`) and the timeline (`turn_steps`). Every text is passed through the secret
redaction first (`src/secrets/redaction.ts`: every value `SHUVI_SECRETS_FILE` holds or ever held, also in its
JSON-escaped form, becomes `[REDACTED:<profile>]`); an unusable secrets file is alerted and noted in the turn.
Images are stored as paths under `media/`, never as bytes. Recording is best effort: a failure is logged and
the turn goes on.

Transcripts are kept for `SHUVI_TRANSCRIPT_DAYS` (default 30) after a turn ends, then pruned with any prompt
text no transcript points at. Pruning never touches `chat_events`, and the `turns` row (with its usage)
stays.

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
