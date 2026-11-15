# The console

A private web view of what the assistant did: every turn as the model saw it, every chat, and each chat's
timeline. It is for the owner, to debug and tune her. It is read-only, except for four things: **Settings**,
which manages the model catalog, **Home**, where her files are edited, **a chat's settings** (its model,
profile, conversation, permissions, schedules and secret grants), and **deleting chat messages** (all below). Nothing else in it can
change anything.

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
  exchange, a thin divider at each turn (its outcome, duration, cost, the model it ran on, links to the turn and
  its tabs; a turn on another model than the one before it is marked "→ model" in the accent), a
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
- **A chat** (`/chats/<id>`): the chat's whole log, each turn's boundary a divider linking to it, with the model
  it ran on (a switch marked as on a segment).
- **A chat's settings** (`/chats/<id>/settings`, `/permissions`, `/automation`): its model, profile and
  conversation; its permissions; its schedules, secrets and computer. See below.
- **Home** (`/home`): her files in `home/`, edited by hand, with each file's history. See below.
- **Settings** (`/settings`): the model catalog. See below.

## Deleting messages

On a chat's page, a segment, a conversation, and a turn's Conversation tab, any message can be deleted: a
person's (a photo or a sticker too) or hers (a message, a sticker, a file). Hover a bubble for the round
checkbox on its left; clicking it starts selecting, Shift-click selects the range from the last one clicked, and
a bar at the bottom says what is selected ("3 selected (you 2, her 1) · Delete · Cancel"); `Esc` cancels. The
"⋯" at a bubble's top right offers Select (how selecting starts on a phone, where there is no hover) and Delete,
for that message alone. No confirmation: the bubbles go at once and a toast counts down "Deleted 3 · Undo (10)";
Undo puts them back in place. Another delete while the toast is up joins the first: the toast counts them all
and starts its 10 seconds again, and its Undo puts all of them back. A message in a turn still running, or one
of hers not sent yet, is refused, and the bar says why; so is an undo once she has started a turn in the chat
since (the toast says why). Without script, every bubble has a checkbox and the bar a Delete button; the page
comes back with a notice holding the Undo.

A delete is final for everything shuvi reads: the message is gone from the chat's log, from what a fresh
conversation is shown, from `search_chats` and `read_chat`, from the console, and its words from the quotes of
replies to it, from turn transcripts and from what `read_chat` and `search_chats` gave her, without a trace
(docs/design.md §3, `src/store/deletions.ts`). It is not taken out of the model's conversation, Telegram, or the
backups. After the 10 seconds it cannot be undone.

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

Probes and listings run in the server, as for the control bot. While one is pending, its row (or the listing
panel) updates itself every second with how long it has waited and how long a request may take, and has a
Cancel: cancelling stops the request itself, and a cancelled probe leaves the model's last result as it was.
Without script, reload the page to see one finish.

## Home: her files

Every file of hers in `home/` (the allow-list `src/capabilities/memory/home.ts` keeps): her persona, your rules
(`directives.md`), her memory, every chat's notes (created or not yet), the playbooks, and the sticker files. Three
panes:

- **Files**, grouped, each with who changed it last and when.
- **The editor** (CodeMirror, served by the console itself at `/editor.js`; a plain textarea without script).
  Unsaved changes show against the saved file, in the gutter and inline, and as "Unsaved +n −m"; Ctrl+S / ⌘S or
  Save commits the file to `home/`, with the optional note as the message ("Edited in console" without one).
  Leaving with unsaved changes asks first.
- **History**: every commit that touched the file, newest first: who made it (her, with the chat, the turn and
  the very tool call, linked to the turn; you, from the console; or someone who committed by hand), when, the
  message, and +/−. `/home/history` lists every file's changes.

A history entry opens as a diff in GitHub's style, of the whole file (unified or split; "this change", or "this
version vs now"), with two buttons that LOAD a result into the editor without saving it: **Undo this change**
(only what that change did is taken out; later changes stay) and **Restore this version** (the whole file as it was
right after it). Look it over, then save.

**Nothing is lost by a save.** While you edit, the page checks every 5 seconds whether the file changed (she may
edit it from a chat meanwhile) and says so. A save carries the version it started from: if the file changed since,
your change and the other are merged; a clean merge is saved and says the other was kept, and one that touches the
same lines is not saved but shown side by side (the file now, and yours), to resolve and save. An undo whose lines
were rewritten since is shown the same way.

### Profiles

A profile (docs/design.md §3; `src/capabilities/memory/layers.ts`) is an overlay of her files that some chats use:
it holds only the files it replaces, and everything else comes from Base. The top of the files pane is the layer
switch: **Base**, a select of the profiles (label · name), and **+ New profile** (a name, an optional label; it
starts with nothing of its own). On a profile, its label, its ⋯ menu (Rename, Duplicate, Delete: each one commit;
Delete names the chats using it, which go back to Base) and "Used by" (its chats) sit under the switch, and each
file row starts with where the file comes from: `own` (the profile's copy), `inherits` (Base's), `hidden` (a Base
playbook it hides) or `only in <profile>`.

- **An inherited file** shows Base's text read-only, with "Inherited from Base. [Edit in Base] [Make a <profile>
  version]" (the second copies Base's text into the profile and opens it). Its history is Base's.
- **An own file** is the profile's copy: Save writes it, and its history is its own. "Remove the <profile>
  version" (asked first; the text stays in history) puts the file back to inheriting. An empty one offers **Copy
  from Base** (Base's text loaded into the editor, not saved).
- **Base's new changes**: when Base's file changed after the copy was made, the bar says "Base changed since this
  version was made (n changes)", with **View Base's changes** (Base then → Base now, GitHub-style) and **Apply
  them** (a three-way merge of Base's changes into the copy, loaded into the editor unsaved; one that overlaps the
  copy's own change opens the conflict view). Which Base commit a copy was made from is the `Base-Commit:` trailer
  of the latest commit to it that has one: Make a version, Copy from Base, Duplicate, and every save from the
  console, which records the Base commit its text is based on (a plain edit the current one, Restore of a version
  the one at that version, Undo of a change the one before it, Apply Base's head). A copy without one counts from
  the Base commit just before its first.
- **A playbook or a sticker pack** offers Hide / Unhide in its bar: chats on the profile do not see a hidden one
  (profile.yaml's `hides` and `hidden_packs`).
- **Preview**, a tab beside the file: pick a chat and see the system prompt it would get now, section by section,
  each labelled with where it came from (`· base`, `· <profile>`, or `· code` for a section written in code).

A chat's profile is switched on its settings page (below), from its next turn. A turn's System prompt tab says
which profile it ran under, and each section's layer. The control bot's `/profile` does the same.

How a commit says who made it is in `src/capabilities/memory/home.ts`'s header: hers carry the turn, the chat and the
tool call as trailers (`Turn:`, `Tool-Call:`, `Chat:`, `Tool:`); yours are authored `owner (console)` with your
login. Her commits from before trailers are matched to their call through the `commit <id>` her tool's result names,
while that turn's transcript is kept, and say "inferred".

`policy.yaml` and `inbound.yaml` are not here: a chat's permissions are edited on its settings page (below), one
chat's entry at a time, and the assistant's own proposals still need your approval.

## A chat's settings

Reached from "⚙ Settings" next to the chat's name on every page about it (its log, a segment, a conversation, a
turn) and from the ⚙ on its header in the list (shown on hover; always on a touch screen). A facts line (its model,
profile, how old its conversation is, a link to its log), then three tabs, each a page of its own:

| Tab | Address | Sections |
|---|---|---|
| **Chat** (where every way in lands) | `/chats/<id>/settings` | Model, Profile, Conversation |
| **Permissions** | `/chats/<id>/settings/permissions` | Permissions |
| **Automation & machine** | `/chats/<id>/settings/automation` | Schedules, Secrets, Computer |

Every button comes back to the tab it is on, with its result shown once.

- **Model**: the catalog as a radio list by provider: the chat's model marked current, ★ the default, ⚠ a model
  whose last probe got no tool call, each one's context window. Picking another opens **Lossless** / **Lossy** /
  **Clean start** under it, each with what it would do in this chat now, and the running turn it would stop: the control bot's
  `/model` card's own lines. Pressing one asks for the switch through the same code as the card
  (`src/control/model-cards.ts` `consoleSwitch`, `src/agent/switch.ts` `requestSwitch`): the server stops a running
  turn, then switches, and the chat's open `/model` cards in the control bot are closed as superseded. The page
  says "Switching…" until it is done, then shows the result once, in the card's words. A switch already pending for the
  chat (asked in the control bot, or in another tab) shows the same way; a button pressed twice asks once.
- **Profile**: Base and every profile, with its label and how many files it has of its own; a press switches the
  chat, from its next turn. A link leads to Profiles in Home.
- **Conversation**: when the current one began, its segments and its context. **Stop the turn** (only while one
  runs) does what `/stop` does. **New conversation** does what `/new` does, after asking: a running turn is
  stopped, every model's conversation of the chat is forgotten, and her next turn opens with the chat's last 10
  messages. **Start clean** is the same, after asking too, but her next turn opens with its new messages only, not
  the last 10: the opening of a model switch's Clean start, for the model the chat is on (picking that model in
  the list does nothing). Her files and notes stay either way, and she can still read the chat's history.
- **Permissions**: the chat's entry in `home/policy.yaml` as a form: what wakes her (every message, or mentions,
  replies and follow-ups within some minutes), what she sees (the private persona and memory are offered only for
  your DM, as the policy parser requires), each capability on or off with its parameters (a workstream's
  products), and in a group its operators and what is delegated to them. **Review changes** shows the change as a
  diff of `policy.yaml`; nothing is written until **Save to policy.yaml**, which commits it as you, from the
  console, in one commit. A form the parser refuses comes back as you typed it, with its reason, and nothing is
  written. Only this chat's entry is rewritten: the file's comments and the other chats' entries are kept as they
  are (a file laid out so that the entry cannot be edited in place is written whole, and the review says its
  comments would not survive). If the file changed after you reviewed, Save shows the diff against the file as it
  is now instead of writing. The server reloads the file within seconds.
- **Schedules**: each of the chat's schedules still to run, active and paused, soonest first: once or recurring,
  the cron in plain words ("every weekday at 09:00"; the expression itself when it cannot be said simply), the next
  run in your time zone, its note, who set it (you, or an operator by name). **Pause** keeps it without running it;
  she still sees it, as paused, and can still cancel it. **Resume** runs it next from now: nothing it missed while
  paused is run, not even once; a paused one-off whose time has passed is cancelled instead, and the page says so.
  **Cancel** asks first.
- **Secrets**: the secret profiles granted to the chat's computer now: the profile, its variable names (never a
  value: nothing else is read from the secrets file), time left, who asked for it. **Revoke now** presses the same
  button as the grant's "Revoke now" card in the control bot, so the card says it is revoked too. A secrets file
  that cannot be used (readable by others, not valid YAML) is said plainly. Nothing is granted from here: a grant
  is still her `request_secret` and your answer to its card.
- **Computer**, read only: not created, running, stopped or boosted (for which job); when it stops if left idle;
  its disk's allocated size and the most it may grow to (asked of Hangar after the page has loaded, waiting at most
  3 s, else "unknown"; it is the disk's size, not how much of it is used); its running background jobs (the
  command, redacted as their output is, and how long); and the last time `~/.computer.yaml` was applied (ok, or
  the step that failed, its reason and its output, redacted). With the computer off in this process, it says so.

### The write boundary

The console has four ways in for a write: Settings, Home, a chat's settings, and deleting messages.
Every other page answers GET and HEAD only (and `/login` its POST); a POST to it is refused with 405. Settings'
buttons POST to `/settings/<area>/<verb>`, Home's Save to `/home/save` and its profile actions to
`/home/profile/<verb>`, a chat's settings to `/chats/<id>/settings/<verb>` (switch, profile, stop, new, policy,
schedule-cancel, schedule-pause, schedule-resume, revoke), a delete to `/messages/delete` and its
undo to `/messages/undo`, and a GET to any of them is refused too. A POST there is carried out only if it passes,
on top of the sign-in and the Host check:

- **Origin**: its `Origin` header is the console's own origin: `SHUVI_CONSOLE_URL`'s, or
  `http://127.0.0.1:<port>` (`localhost`, `[::1]`) for the ssh tunnel. A request without one, or from any other
  site, gets 403.
- **A CSRF token**: every form carries a token for your session, an HMAC under a secret the server draws
  at random when it starts. With the tailnet login there is no cookie, so the token is derived from your
  login. With the token sign-in it is derived from your session cookie. A wrong or missing token gets 403.
  After a server restart, a page loaded before it is refused: reload it.

The pages need no script: each write answers with a redirect back to its page (a delete: to the page it was
made on), which shows its result once. With script, a delete is posted in the background and answered in JSON.
With script (htmx, served by the console itself), a button is disabled and shows that it is working the
moment it is pressed, and the answer replaces the page in place without a reload. The checks above are the
same either way.

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
transcript: from what to what, and lossless (how many messages were carried), lossy or a clean start. A successful compaction is a
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
