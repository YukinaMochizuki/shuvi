# shuvi

A personal assistant on Telegram, for one person. The agent itself runs on
[agent-runtime](https://github.com/YukinaMochizuki/agent-runtime); shuvi is everything around it: receiving
and sending messages, deciding when to think, assembling the context, and keeping a turn alive across
restarts. The architecture, and why it is shaped this way, is in [docs/design.md](docs/design.md).

What works today (the first slice): the owner's private chat, text in and out. The assistant's reply text
becomes messages, `say` speaks mid-turn, `react` reacts, `pass` stays silent; `/stop` and `/new` act on the
chat. Photos and stickers are shown to the model as images (the `vision` capability). The sticker library
(`home/stickers/*.yaml`, the `stickers` capability) lets her find, view, send and learn stickers;
`bun scripts/import-stickers.ts` creates skeletons for existing packs. Groups, memory writing, other
media, background jobs and schedules are later slices on the same skeleton.

The framework itself never speaks in the assistant's chat. It talks to the owner through a second bot, the
**control bot** (`SHUVI_CONTROL_BOT_TOKEN`; create it with BotFather like the first): `/status` lists
running turns, recent failures, pending outbound messages and the deployed commit; `/stop <chat>` stops a
chat's turn; it sends alerts (a failed turn, a message given up after the retries, a turn stopped by the
wall-clock limit `SHUVI_TURN_MAX_MINUTES`, messages that are not getting through, a failed backup); and it
carries approval cards with buttons (`src/control/approvals.ts`). It answers only `SHUVI_OWNER_ID`.
Without its token, alerts are only logged and queued. See docs/design.md §13.

## Running it

```bash
bun install
bun run typecheck
bun test
bun scripts/e2e-fake.ts      # the whole path against a fake Telegram and a fake Anthropic API
bun scripts/e2e-control.ts   # the control bot: /status, alerts, the wall-clock limit, an approval round trip
bun scripts/e2e-jobs.ts      # schedules, callback and expired jobs, inbound POSTs, the workstream desk
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
memory as markdown) and `media/` (the photos and stickers it was sent, by `file_unique_id`). All of it is
private: it lives outside this repository and is never committed or pushed. Note that Claude Code also
keeps a copy of each image a turn is shown, next to its session files.

Once a day the server writes a consistent copy of `shuvi.db` and a `git bundle` of `home/` (when it is a
git repo) to `$SHUVI_DATA_DIR/backups/<time>/`, keeping the last 7. They are on the same disk; copy
`backups/` elsewhere if the disk itself matters. To restore, stop the server, put the copied `shuvi.db` in
place (removing any `shuvi.db-wal` / `-shm` beside it), and `git clone home.bundle home`.

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
