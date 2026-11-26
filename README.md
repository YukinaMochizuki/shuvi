# shuvi

A personal assistant on Telegram, for one person. The agent itself runs on
[agent-runtime](https://github.com/YukinaMochizuki/agent-runtime); shuvi is everything around it: receiving
and sending messages, deciding when to think, assembling the context, and keeping a turn alive across
restarts. The architecture, and why it is shaped this way, is in [docs/design.md](docs/design.md).

What works today: the owner's private chat and the groups `home/policy.yaml` lists, text in and out. The
assistant's reply text becomes messages, `say` speaks mid-turn, `react` reacts, `pass` stays silent; `/stop`,
`/new` and `/newclean` (a fresh start without the last messages, and without looking back) act on the chat.
Photos and stickers are shown to the model as images (the `vision` capability).
She keeps her own memory in `home/`, looks back through every chat, runs schedules and background jobs, and
asks workstream's desk. The sticker library (`home/stickers/*.yaml`, the `stickers` capability) lets her
find, view, send and learn stickers; a pack is added in conversation with `add_sticker_pack`. With Hangar
configured, each chat has its own computer. She can also tell people what is new about her: `release_log` (the
`releases` capability) lists what changed in the code she runs since a date, a commit or a PR, sorted into
features, fixes and internal changes. Other media are later slices on the same skeleton.

The framework itself never speaks in the assistant's chat. It talks to the owner through a second bot, the
**control bot** (`SHUVI_CONTROL_BOT_TOKEN`; create it with BotFather like the first): `/status` lists
running turns, recent failures, pending outbound messages and the deployed commit; `/stop <chat>` stops a
chat's turn; it sends alerts (a failed turn, a message given up after the retries, a turn stopped by the
wall-clock limit `SHUVI_TURN_MAX_MINUTES`, messages that are not getting through, a failed backup); and it
carries approval cards with buttons (`src/control/approvals.ts`). It answers only `SHUVI_OWNER_ID`.
Without its token, alerts are only logged and queued. See docs/design.md §13.

Every turn is recorded as the model saw it (its system prompt, input, thinking, text, tool calls and what
arrived mid-turn), and the **console** shows it: a private, read-only web page published to the owner's
tailnet with `tailscale serve`. `/turn <id>` in the control bot, and every alert about a turn, link to it.
See [docs/console.md](docs/console.md).

## Groups and policy

`home/policy.yaml` says which chats she serves and what each may do (docs/design.md §6–§8; the format is
in the header of `src/policy/policy.ts`). With no file she serves only the owner's DM, with everything, as
before. A group is listed by its chat id, with what wakes her there (`mention`, `reply`, `followup`), the
persona and memory layers it sees (never the private ones), and the capabilities it may use, with their
parameters (e.g. `workstream: { products: [widgetry] }`). Every message in a listed group is recorded; only a
mention, a reply to her or a follow-up starts a turn. The server reloads the file when it changes; a broken
file is alerted and the last good policy stays.

A group that is not listed is not recorded. Its first message brings an approval card to the control bot
offering to add it; approving writes the entry into `policy.yaml` and commits it in `home/`. She can propose
policy changes herself (`propose_policy`, when the owner asks); they too go through a card and are written
only once approved. A private chat with anyone but the owner is ignored, with at most one alert per person
per day.

**Deploying for groups is the owner's step:** Telegram delivers every group message to a bot only when its
privacy mode is off (BotFather → `/setprivacy` → Disable, then re-add the bot to groups it was already in)
or when the bot is an admin of the group. With privacy mode on, she sees only mentions, replies to her and
commands, so a group turn has no unseen messages to open with and follow-ups never arrive.

## Running it

```bash
bun install
bun run typecheck
bun test
bun scripts/e2e-fake.ts      # the whole path against a fake Telegram and a fake Anthropic API
bun scripts/e2e-openai-compat.ts  # the same on an OpenAI-compatible model, against a fake Chat Completions endpoint
bun scripts/e2e-switch.ts    # one chat switched between Claude and an endpoint, lossless, lossy and clean, checked on the wire
bun scripts/e2e-control.ts   # the control bot: /status, alerts, the wall-clock limit, an approval round trip
bun scripts/e2e-jobs.ts      # schedules, callback and expired jobs, inbound POSTs, the workstream desk
bun scripts/e2e-computer.ts  # each chat's computer on a fake Hangar: exec, a background job, a secret-gated exec, an owner grant
bun scripts/e2e-groups.ts    # a group: triggers, unseen messages, owner-only refusal, an unknown group added
bun scripts/e2e-media.ts     # videos from links on a fake porchkit: a prewarmed read, a probe, sheets of a link, a fetch into ~/inbox
bun scripts/e2e-read.ts      # reading links on the same fakes (read_link, save_link, the prewarm), and her browser: open a page, click
bun scripts/e2e-drain.ts     # SIGTERM drains: a running turn finishes and is delivered, exit 0; the deadline stops and retries
bun scripts/console-fixture.ts  # the console over made-up fixture data, on 127.0.0.1:8787, to look at
```

```bash
SHUVI_BOT_TOKEN=… SHUVI_CONTROL_BOT_TOKEN=… SHUVI_OWNER_ID=… SHUVI_OWNER_LANGUAGE="Traditional Chinese (Taiwan)" bun run server
```

Configuration is environment variables only; `src/env.ts` lists the framework's, and each capability
lists its own in the header of `src/capabilities/<id>/index.ts` (e.g. `SHUVI_WEB`). The code and its
prompts are all English; `SHUVI_OWNER_LANGUAGE` is where the owner's own language is set, and the
assistant replies in it.

Which models turns run on is the model catalog in `shuvi.db` (`src/store/models.ts`): providers (a Claude
login, or an OpenAI-compatible endpoint whose key is named in the secrets file) and their models, one of
them the default; each chat runs on its own model or the default. A first start seeds it with the Claude
login of the user the server runs as (or `SHUVI_CLAUDE_CONFIG_DIR`) and `SHUVI_MODEL`, which is what turns
ran on before. A chat keeps one conversation per model, and its model can be switched (`src/agent/switch.ts`;
one asked for during a turn stops the turn first): on every switch, between any two models, the owner chooses
whether what was said since is carried into the other model's conversation (lossless), that model's own
conversation resumes as it was left (lossy), or that model starts over with nothing (clean start: for as long
as that conversation lasts she cannot search or read back through the chats either). The model is never told.

## Data

`SHUVI_DATA_DIR` (default `./data`) holds `shuvi.db`, `home/` (the assistant's persona, directives and
memory as markdown, and `policy.yaml`) and `media/` (the photos and stickers it was sent, by `file_unique_id`;
`media/transcript/` holds the other images turn transcripts refer to, pruned with them). All of it is
private: it lives outside this repository and is never committed or pushed. A conversation on an
OpenAI-compatible model is kept in `shuvi.db` too, one message per row (tool results and images included),
and so is in its backups; one no chat uses any more is pruned `SHUVI_TRANSCRIPT_DAYS` (default 30) after it
was last written. Claude Code keeps its own session files, with a copy of each image a turn is shown; a
switch carrying a conversation onto Claude appends to them, or writes a new one (a copy, within one login).

Once a day the server writes a consistent copy of `shuvi.db` and a `git bundle` of `home/` (when it is a
git repo) to `$SHUVI_DATA_DIR/backups/<time>/`, keeping the last 7. They are on the same disk; copy
`backups/` elsewhere if the disk itself matters. To restore, stop the server, put the copied `shuvi.db` in
place (removing any `shuvi.db-wal` / `-shm` beside it), and `git clone home.bundle home`.

## Videos from links (porchkit)

With `SHUVI_PORCHKIT_URL` (e.g. `https://porchkit.example.ts.net`) and `SHUVI_PORCHKIT_TOKEN` set, the
`media` capability is on (`src/capabilities/media/`, the client in `src/porchkit/`): porchkit is a separate
service on a home connection that probes, subtitles, sheets and downloads videos, always anonymously and
within a request budget per site. In a chat whose policy enables `media`, anyone may have the assistant
look at a video from its link (`video_probe`, `video_subs`, `video_sheet`); `video_fetch`, which puts the
file in the computer's `~/inbox/`, is the owner's alone. Every link in a message that starts a turn (from
anyone; and in the message it replies to), up to 3, is read as soon as it arrives (a prewarm), and the
console's turn view says whether the turn then used it. The token is never logged and is redacted from turn transcripts.

## Her own browser (porchkit `/browse`)

With porchkit configured as above, the `browser` capability is on too (`src/capabilities/browser/`): a
real Chrome on the owner's home machine, signed in to accounts made for the assistant, that she drives one
action at a time through porchkit's `/browse` (`browser_open`, `browser_click`, `browser_type`, …; each
answers with the page as text), one window per chat (porchkit's session `chat-<chat id>`, closed after 30
idle minutes). A chat gets it when its policy enables `browser`; anyone whose message starts a turn there
may use it. The owner watches, or takes over, from porchkit's live view. Placing an order needs his
approval first: `browser_request_purchase` puts a card to him in the control bot (the checkout's screenshot as
its photo, and the live view's link to look or take over first), and one approval lets one action through,
on the same site and within 15 minutes of his answer (`src/capabilities/browser/purchase.ts`): porchkit refuses, without it, a click on a button
that places an order, and on a checkout page any button, Enter, a submit or accepting a dialog (adding to the
cart never needs it). A page's alert is accepted by porchkit; a confirm or prompt stays open until she
answers it with `browser_dialog`; an approved action that opens one carries its approval to accepting that
one dialog (same window, within 2 minutes), so a "Confirm and pay?" after the approved click needs no second card. Google sign-in and account-security pages
(password, 2-Step Verification, recovery, deleting the account) are his: she sends him the live view link
instead; the rest of her own Google account (profile, photo, settings) she manages herself. porchkit without a desktop answers every call as unavailable.
`browser_send` sends the chat a screenshot (as a photo), a download (`browser_downloads` lists them) or the
page as a PDF, within Telegram's limits for a bot (10 MB a photo, 50 MB a file; `src/capabilities/browser/files.ts`).
Saving one onto the computer is the computer's own tool, `browser_save` (into `~/inbox/browser/`;
`src/capabilities/computer/browser-save.ts`): owner-only, and in a group delegated only by `delegate: [computer]`.
`browser_upload` gives a page a file (up to 20 MB): a photo or file sent in the chat (fetched by the server,
which alone holds the bot token) or a browser download, set on a file input by its ref or handed to the page's
next file chooser. A file from the computer is the computer's `browser_upload_from_computer`, owner-only and
delegated by `delegate: [computer]` like `browser_save`.
Where the page text falls short (icons, canvas pages, drawn controls), she has a pointer at screenshot
coordinates (`browser_pointer`), marked or gridded screenshots, `browser_zoom`, `browser_watch`, `browser_find`,
`browser_wait_for`, `browser_hover` and `browser_select` (`src/capabilities/browser/pointer.ts`); every answer
starts with what her action did and porchkit's hints about the page (`look.ts`), and a pointer action on a
checkout needs the owner's approval as a click does.

## Each chat's computer

With `SHUVI_HANGAR_API`, `SHUVI_HANGAR_PROJECT`, `SHUVI_HANGAR_TOKEN` (a Hangar service token, `hgr_…`,
with `project.editor` on that project) and `SHUVI_COMPUTER_IMAGE` set, every chat gets a computer on
Hangar (docs/design.md §15, `src/capabilities/computer/`): a Disk `home-<chat>` (5Gi, growing by itself
to 50Gi) mounted at `/home/shuvi` in a Container `shuvi-<chat>` (which Hangar runs as the Machine
`ct-shuvi-<chat>`), created on the first `exec`, stopped after `SHUVI_COMPUTER_IDLE_MINUTES` (default 15)
without one, never deleted. Computers created before this naming keep their name, `ct-<chat>`: shuvi
reads the name it recorded for each. The other variables it reads are listed in
`src/capabilities/computer/index.ts`.

**Each computer holds a Hangar machine for good.** A stopped container still counts as a machine against
the plan, so a plan of 10 machines allows at most 10 chats with a computer (fewer if the project holds
other machines). Past that, a new chat's first exec is refused with an alert in the control bot.

Files the owner sends (documents, videos, audio) are copied into the chat's `~/inbox/` the next time its
computer runs; sending a file never starts a computer by itself. Photos are copied only when the assistant
asks (`save_photo`).

### The computer's image

All computers run one shared base image, `computer/Dockerfile` (Debian with python3, pip, node, ffmpeg,
git, curl, jq, sqlite3, GNU time, and a `shuvi` user whose home is `/home/shuvi`). It holds only generic
tools: anything a chat needs beyond them goes in that chat's `~/.computer.yaml` (below) or under its
home, never in this public repository. It is a PRIVATE package on ghcr.io,
`ghcr.io/<repository owner>/shuvi-computer`, built by GitHub Actions
(`.github/workflows/computer-image.yml`) on every push that changes `computer/`, or by hand from the
Actions tab ("computer image", Run workflow). Each build is tagged with its commit sha, and the run prints
its digest, in the log and in the run's summary:

```
SHUVI_COMPUTER_IMAGE=ghcr.io/<owner>/shuvi-computer@sha256:…
```

`SHUVI_COMPUTER_IMAGE` holds that digest, not a tag: a tag that moves later is not picked up by an existing
container, and a digest says exactly which image runs. Changing it rebuilds each container's root disk on
its next start (once no background job runs there); homes are kept.

Hangar pulls the private image with a login shuvi gives it. Once, the owner:

1. checks on GitHub that the package `shuvi-computer` is private (Packages › shuvi-computer › Package
   settings › Danger Zone › Change visibility);
2. creates a token that can only read packages: a classic personal access token with the single scope
   `read:packages` (fine-grained tokens do not cover ghcr.io), with an expiry, and nothing else;
3. sets `SHUVI_COMPUTER_REGISTRY_USER` (their GitHub user name) and `SHUVI_COMPUTER_REGISTRY_TOKEN` (that
   token) in shuvi's environment, next to `SHUVI_HANGAR_TOKEN`, never in `home/` or this repository.

shuvi keeps the login in a Hangar Secret of type `registry-auth`, `shuvi-computer-registry`, applied when a
container starts (Hangar never answers with its values), and names it in each container's
`imagePullSecrets`. When the token is renewed, restart the server: the next start applies the new one.
Without the two variables the image is pulled anonymously, which only works for a public image.

### What a computer has beyond the image: `~/.computer.yaml`

What the assistant installs under her home (`pip install --user`, npm packages in home, programs in
`~/.local/bin`) stays by itself. System packages are declared in the chat's own `~/.computer.yaml`, on its
home disk, so they are runtime data, private to the owner, and need no change to this repository:

```yaml
# ~/.computer.yaml on a chat's computer
apt: [ripgrep, imagemagick]
setup: |
  echo "anything else to do as root after the packages"
```

Only `apt` (Debian package names) and `setup` (a shell script, run with `bash -e`) are allowed; any other
key is an error she sees. shuvi applies the file as root before her next command whenever it is not
applied on the container's root disk: on the first start, after she edits it, and after a new
`SHUVI_COMPUTER_IMAGE` (a new image is a fresh root disk). Otherwise nothing runs but one short read of
the file and its recorded hash before each command. apt keeps its downloads in `~/.cache/computer/apt`,
so applying it again after a new image does not download them again. Each step is limited to
`SHUVI_COMPUTER_APPLY_STEP_SEC` (default 900). A failure is shown to her in that command's result (the step and its output) and raised as
an alert in the control bot; the file is tried again at the computer's next start, or at once with
`apply_computer_config`.

Changing the file is owner-only. Every computer tool (`exec` included, and `apply_computer_config`)
follows the rule every owner-only tool shares (`ownerAuthority` in `src/agent/turn.ts`): a turn with a
message from the owner may use it, other people's messages beside his neither grant nor block it, and a
turn with nothing from the owner is refused. To review it, ask her to send it
(`send_file ~/.computer.yaml`), or to show it (`cat ~/.computer.yaml` in an exec).

### Secrets

Credentials a task needs (an API token) are named profiles. They come from two places: a host-side file,
outside `home/` and git, readable only by the user shuvi runs as (`SHUVI_SECRETS_FILE`, default
`/etc/shuvi.secrets.yaml`), and the console's Secrets page (`/settings/secrets`), where the owner adds,
replaces and deletes profiles himself:

```yaml
# chmod 600 /etc/shuvi.secrets.yaml
modal:
  MODAL_TOKEN_ID: ak-…
  MODAL_TOKEN_SECRET: as-…
```

A profile kept in the console is sealed in `shuvi.db` (AES-256-GCM) under `SHUVI_SECRETS_KEY`, 32 bytes as
base64 (`openssl rand -base64 32`), which lives in the environment only: a copy of the database holds no
readable value. Without the key, nothing can be kept there, and what was kept is not given out. A name is the
file's or the console's, never both (the file's wins).

The assistant asks for one with `request_secret`; the control bot shows the owner the variable names (never
the values) with buttons for this chat (4 hours, 1 day, 3 days), every chat (4 hours, 1 day, 3 days, until
revoked) or deny. A grant to every chat is an *owner grant*: every chat's computer gets it, but only in
calls made for the owner, never in a group operator's. The owner can also grant a profile to every chat from
the Secrets page. Every grant puts a "Revoke now" card in the control bot. Granted values go only into the
environment of the execs they cover, and every known value is shown to the model and the chat as
`[REDACTED:<profile>]`. Every value ever read, from the file or the console, is also kept in
`<secrets file>.known` (mode 600, beside it), so a value rotated out, or a file that turns unreadable, is still
redacted; with neither usable, output is withheld.

Each profile can carry a note, which is not secret: a one-line summary in her prompt beside the profile's
name, and details she reads with `secret_info` (scope, account or org ids, how to use it). The owner edits
it on the Secrets page; she keeps what she learns there with `update_secret_note`. A note holding a secret
value is refused.

When a profile does not exist yet, she asks for it with the variables it needs and what each one is
(`request_secret` with `vars`). The control bot's card then links to the console (`SHUVI_CONSOLE_URL` makes the
link absolute), where the owner types the values on a page made for a phone and picks the grant; values are
never typed into Telegram. A granted value can also go into her browser: `browser_type` with
`secret: "<profile>.<VAR>"` (the owner's call only) types it without her seeing it, porchkit masks that field in
every picture after, and every browser answer's text is redacted. A page that shows the value elsewhere (a
confirmation) is not masked in pictures, and pictures are never redacted. This needs a porchkit that knows `mask`
on `type` and answers `masked` (and `left` on a failed one); with an older one, secret typing is refused or reported
as unconfirmed.
Requests for a new secret need `SHUVI_CONSOLE_URL`, so the card's link opens on the owner's phone.

## Deploying

shuvi runs as a container: the `Dockerfile` at the root builds it (Bun on Debian slim, a non-root user,
`tini` as PID 1), and `.github/workflows/release.yml` pushes it to `ghcr.io/<owner>/shuvi`, public, after CI
passes on `main`. docs/design.md §16 has the reasoning.

### The container

Configuration is environment variables only, as above. Two volumes must survive a redeploy; both must be
**owned** by uid 10001, the image's `shuvi` user (`chown -R 10001:10001`), not merely writable by it: git
refuses to work in a `home/` owned by someone else ("dubious ownership"), so memory edits would fail:

| volume | variable (set by the image) | holds |
|---|---|---|
| `/data` | `SHUVI_DATA_DIR` | `shuvi.db`, `home/`, `media/`, `backups/` |
| `/claude` | `SHUVI_CLAUDE_CONFIG_DIR` | the Claude login and Claude Code's session files |

Log in to Claude once, into the volume, with the CLI the image carries:

```bash
docker exec -it -e CLAUDE_CONFIG_DIR=/claude <container> \
  node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude /login   # -linux-arm64 on arm
```

or copy an existing login's directory into it. `SHUVI_CLAUDE_CONFIG_DIR` is applied on every start: the
`claude` login in the model catalog is pointed at it if it says otherwise (logged), so a store moved from
another machine uses the volume.

**Moving an existing store in** (from a VM, say): stop the old server, copy its data dir into `/data` and
its Claude login dir into `/claude`, `chown -R 10001:10001` both, then start the container. Claude Code files
sessions by working directory, and the image's is `/app`, not the old checkout's, so each chat's Claude
conversation is not found once and starts over, opening with the chat's last messages (as after a lost
session); its history in `shuvi.db` is untouched.

**One server per data dir.** The old container must have stopped before the new one starts (compose's
default stop-then-start does this; a blue-green or rolling deploy does not). A turn's liveness is a process
id, which means nothing across containers, so a second server on the same `/data` would take the first's
running turns for dead and run them again beside the originals.

A compose service looks like this (the host paths and the env file are yours):

```yaml
services:
  shuvi:
    image: ghcr.io/<owner>/shuvi:main
    env_file: shuvi.env            # SHUVI_BOT_TOKEN, SHUVI_OWNER_ID, SHUVI_CONTROL_BOT_TOKEN, …
    volumes:
      - /srv/shuvi/data:/data
      - /srv/shuvi/claude:/claude
      # With SHUVI_SECRETS_FILE=/etc/shuvi/secrets.yaml, if used. Writable: its .known file is kept beside it.
      - /srv/shuvi/secrets:/etc/shuvi
    stop_grace_period: 11m         # longer than SHUVI_DRAIN_SEC (600) + 30 s
    restart: unless-stopped
```

**Stopping drains.** On SIGTERM the server stops polling Telegram and starts no new turn, waits for the
running turns to finish and their messages to go out (up to `SHUVI_DRAIN_SEC`, default 600), then exits 0.
A turn still running at the deadline is stopped and answered again by the next server; the owner is told in
the control bot. Messages sent meanwhile wait with Telegram, so nothing is lost; a deploy does mean up to
`SHUVI_DRAIN_SEC` without answers. The runtime's stop timeout must be longer than the drain
(`SHUVI_DRAIN_SEC` + `SHUVI_DRAIN_GRACE_SEC` (15) + a few seconds), or it kills the server partway; a second
signal ends the drain at once.

**Health and metrics.** `/healthz` and `/metrics` (Prometheus) listen on `SHUVI_METRICS_LISTEN`, loopback
only, default `127.0.0.1:8788` (anything else is refused at startup); the image's `HEALTHCHECK` calls
`/healthz`. Loopback is the container's own, so Prometheus cannot reach it from another container directly:
publish it with `tailscale serve` from a tailnet sidecar that shares the container's network namespace, and
scrape that. The metric names are listed in docs/design.md §16. They are counts and times only.

**Backups before a migration.** A start with schema migrations pending first copies `shuvi.db` to
`$SHUVI_DATA_DIR/backups/pre-migrate-<from>-<to>-<time>.db` (the last 5 are kept). To roll a deploy back,
stop the server, put that copy in place as `shuvi.db` (removing `shuvi.db-wal` / `-shm`), and run the image
the copy came from. Older copies are pruned before a new one is taken; if the copy still cannot be written
(a full disk), the server refuses to start rather than migrate without one: free space, and start it again.

### CI and the release

`.github/workflows/ci.yml` runs on every push and pull request: `typecheck`, `unit tests`, and one job per
`scripts/e2e-*.ts` (with ffmpeg, so nothing skips; against fakes only, so it needs no secret). Require the
one check **`ci passed`** on `main`: it is green only when every other job is, new e2e scripts included.

`.github/workflows/release.yml` runs when CI passes on a push to `main`: it pushes
`ghcr.io/<owner>/shuvi:sha-<12>`, and points `ghcr.io/<owner>/shuvi:main` at it only if that commit is still the
tip of `main` (so a late release of an older commit never moves it back). It authenticates with the workflow's
own `GITHUB_TOKEN` (`packages: write`), so the repository needs no secret for it. The image carries the OCI
`source` and `revision` labels, which link the package to this repository, and its release log: `main`'s
history up to that commit, written beside the code as `release-log.txt` (the image has no `.git`) and read by
`release_log`. The checkout is therefore not shallow.

The image is **public** on ghcr, as the code is. After the package's first push, make it public once: on
GitHub, the package `shuvi` → Package settings → Change visibility → Public. (ghcr creates a new package
private.)

**Deployment is a pull.** The owner's platform watches `ghcr.io/<owner>/shuvi:main`, and when its digest
changes it pulls the image and redeploys it, stopping the old container before starting the new one (one
server per data dir, above). Nothing on GitHub holds a credential of that platform, and nothing here pushes
to it.

The computer image has its own workflow (`computer-image.yml`, a private package), untouched by this one.

### The old way: systemd on a VM

Before the container, shuvi ran from a checkout under systemd. It still can, but stopping now behaves
differently. SIGTERM drains there too: a restart means up to `SHUVI_DRAIN_SEC` (default 600 s) without
polling Telegram while running turns finish, where before the server exited at once and the turns carried on
in their own processes. That is a regression on a VM, accepted because the container is the deployment;
lower `SHUVI_DRAIN_SEC` there if restarts must be quick (a turn still running at the deadline is stopped and
answered again). `TimeoutStopSec` must exceed the drain, so systemd does not kill it partway. Keep
`KillMode=process` (the default kills every process in the unit's cgroup): it still lets a turn outlive a
server that dies without draining (a crash, SIGKILL), which the next server then picks up.

```ini
[Service]
ExecStart=/usr/local/bin/bun run src/server/main.ts
WorkingDirectory=/opt/shuvi
EnvironmentFile=/etc/shuvi.env
KillMode=process
Restart=always
# Let the drain finish: SHUVI_DRAIN_SEC + SHUVI_DRAIN_GRACE_SEC + a little.
TimeoutStopSec=640
```
