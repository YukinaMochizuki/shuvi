# shuvi

A personal assistant on Telegram, for one person. The agent itself runs on
[agent-runtime](https://github.com/YukinaMochizuki/agent-runtime); shuvi is everything around it: receiving
and sending messages, deciding when to think, assembling the context, and keeping a turn alive across
restarts. The architecture, and why it is shaped this way, is in [docs/design.md](docs/design.md).

What works today (the first slice): the owner's private chat, text in and out. The assistant's reply text
becomes messages, `say` speaks mid-turn, `react` reacts, `pass` stays silent; `/stop` and `/new` act on the
chat. Photos and stickers are shown to the model as images (the `vision` capability). Groups, memory
writing, the sticker library, other media, background jobs and schedules are later slices on the same
skeleton.

## Running it

```bash
bun install
bun run typecheck
bun test
bun scripts/e2e-fake.ts      # the whole path against a fake Telegram and a fake Anthropic API
```

```bash
SHUVI_BOT_TOKEN=… SHUVI_OWNER_ID=… SHUVI_OWNER_LANGUAGE="Traditional Chinese (Taiwan)" bun run server
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
