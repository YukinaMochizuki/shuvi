# shuvi

A personal assistant on Telegram, for one person. The agent itself runs on
[agent-runtime](https://github.com/YukinaMochizuki/agent-runtime); shuvi is everything around it: receiving
and sending messages, deciding when to think, assembling the context, and keeping a turn alive across
restarts. The architecture, and why it is shaped this way, is in [docs/design.md](docs/design.md).

What works today: the owner's private chat and the groups `home/policy.yaml` lists, text in and out. The
assistant's reply text becomes messages, `say` speaks mid-turn, `react` reacts, `pass` stays silent; `/stop`
and `/new` act on the chat. Photos and stickers are shown to the model as images (the `vision` capability).
She keeps her own memory in `home/`, looks back through every chat, runs schedules and background jobs, and
asks workstream's desk. The sticker library (`home/stickers/*.yaml`, the `stickers` capability) lets her
find, view, send and learn stickers; a pack is added in conversation with `add_sticker_pack`. With Hangar
configured, each chat has its own computer. Other media are later slices on the same skeleton.

The framework itself never speaks in the assistant's chat. It talks to the owner through a second bot, the
**control bot** (`SHUVI_CONTROL_BOT_TOKEN`; create it with BotFather like the first): `/status` lists
running turns, recent failures, pending outbound messages and the deployed commit; `/stop <chat>` stops a
chat's turn; it sends alerts (a failed turn, a message given up after the retries, a turn stopped by the
wall-clock limit `SHUVI_TURN_MAX_MINUTES`, messages that are not getting through, a failed backup); and it
carries approval cards with buttons (`src/control/approvals.ts`). It answers only `SHUVI_OWNER_ID`.
Without its token, alerts are only logged and queued. See docs/design.md §13.

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
bun scripts/e2e-control.ts   # the control bot: /status, alerts, the wall-clock limit, an approval round trip
bun scripts/e2e-jobs.ts      # schedules, callback and expired jobs, inbound POSTs, the workstream desk
bun scripts/e2e-computer.ts  # each chat's computer on a fake Hangar: exec, a background job, a secret-gated exec
bun scripts/e2e-groups.ts    # a group: triggers, unseen messages, owner-only refusal, an unknown group added
```

```bash
SHUVI_BOT_TOKEN=… SHUVI_CONTROL_BOT_TOKEN=… SHUVI_OWNER_ID=… SHUVI_OWNER_LANGUAGE="Traditional Chinese (Taiwan)" bun run server
```

Configuration is environment variables only; `src/env.ts` lists the framework's, and each capability
lists its own in the header of `src/capabilities/<id>/index.ts` (e.g. `SHUVI_WEB`). The code and its
prompts are all English; `SHUVI_OWNER_LANGUAGE` is where the owner's own language is set, and the
assistant replies in it. Turns run on the Claude login of the user the server runs as, unless
`SHUVI_CLAUDE_CONFIG_DIR` names another.

## Data

`SHUVI_DATA_DIR` (default `./data`) holds `shuvi.db`, `home/` (the assistant's persona, directives and
memory as markdown, and `policy.yaml`) and `media/` (the photos and stickers it was sent, by `file_unique_id`). All of it is
private: it lives outside this repository and is never committed or pushed. Note that Claude Code also
keeps a copy of each image a turn is shown, next to its session files.

Once a day the server writes a consistent copy of `shuvi.db` and a `git bundle` of `home/` (when it is a
git repo) to `$SHUVI_DATA_DIR/backups/<time>/`, keeping the last 7. They are on the same disk; copy
`backups/` elsewhere if the disk itself matters. To restore, stop the server, put the copied `shuvi.db` in
place (removing any `shuvi.db-wal` / `-shm` beside it), and `git clone home.bundle home`.

## Each chat's computer

With `SHUVI_HANGAR_API`, `SHUVI_HANGAR_PROJECT`, `SHUVI_HANGAR_TOKEN` (a Hangar service token, `hgr_…`,
with `project.editor` on that project) and `SHUVI_COMPUTER_IMAGE` set, every chat gets a computer on
Hangar (docs/design.md §15, `src/capabilities/computer/`): a Disk `home-<chat>` (5Gi, growing to 50Gi)
mounted at `/home/shuvi` in a Container `ct-<chat>`, created on the first `exec`, stopped after
`SHUVI_COMPUTER_IDLE_MINUTES` (default 15) without one, never deleted. The other variables it reads are
listed in `src/capabilities/computer/index.ts`.

**Each computer holds a Hangar machine for good.** A stopped container still counts as a machine against
the plan, so a plan of 10 machines allows at most 10 chats with a computer (fewer if the project holds
other machines). Past that, a new chat's first exec is refused with an alert in the control bot.

Files the owner sends (documents, videos, audio) are copied into the chat's `~/inbox/` the next time its
computer runs; sending a file never starts a computer by itself. Photos are copied only when the assistant
asks (`save_photo`).

### The computer's image

All computers run one shared base image, `computer/Dockerfile` (Debian with python3, pip, node, ffmpeg,
yt-dlp, git, curl, jq, sqlite3, faster-whisper, and a `shuvi` user whose home is `/home/shuvi`). It is a
PRIVATE package on ghcr.io, `ghcr.io/<repository owner>/shuvi-computer`, built by GitHub Actions
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

### Secrets

Credentials a task needs (an API token) are named profiles in a host-side file, outside `home/` and git,
readable only by the user shuvi runs as (`SHUVI_SECRETS_FILE`, default `/etc/shuvi.secrets.yaml`):

```yaml
# chmod 600 /etc/shuvi.secrets.yaml
modal:
  MODAL_TOKEN_ID: ak-…
  MODAL_TOKEN_SECRET: as-…
```

The assistant asks for one with `request_secret`; the control bot shows the owner the variable names (never
the values) with buttons for 4 hours, 1 day, 3 days or deny. A grant is for that chat only; it puts a
"Revoke now" card in the control bot. Granted values go only into the environment of that chat's execs,
and every known value is shown to the model and the chat as `[REDACTED:<profile>]`. Every value ever read
from the file is also kept in `<secrets file>.known` (mode 600, beside it), so a value rotated out of the
file, or a file that turns unreadable, is still redacted; with neither usable, output is withheld.

## Deploying

Each turn runs in its own detached process, so restarting the server never interrupts one. Under systemd
that only holds with `KillMode=process`; the default kills every process in the unit's cgroup, turns
included:

```ini
[Service]
ExecStart=/usr/local/bin/bun run src/server/main.ts
WorkingDirectory=/opt/shuvi
EnvironmentFile=/etc/shuvi.env
KillMode=process
Restart=always
```
