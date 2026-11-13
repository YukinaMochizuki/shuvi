# The shuvi server, as a container (docs/design.md §16, the README's "Deploying").
#
# One process tree: tini (PID 1) → the server → one runner child per turn, each with its Claude Code CLI.
# tini forwards the stop signal to the server alone and reaps every child that exits, so a runner child
# whose server has gone, or a CLI a turn left behind, never lingers as a zombie. On SIGTERM the server
# DRAINS: no new updates or turns, the running turns finish (up to SHUVI_DRAIN_SEC, default 600) and their
# messages go out, then it exits 0. Give the container a stop timeout longer than that plus
# SHUVI_DRAIN_GRACE_SEC (`stop_grace_period: 11m` in compose), or the runtime kills the drain.
#
# Configuration is the environment, as everywhere (src/env.ts). Two directories must be volumes:
#
#   /data     SHUVI_DATA_DIR: shuvi.db, home/ (a git repo), media/, backups/
#   /claude   SHUVI_CLAUDE_CONFIG_DIR: the Claude login and Claude Code's session files, so a redeploy
#             keeps both. Log in once with the CLI the image carries, e.g.
#             `docker exec -it -e CLAUDE_CONFIG_DIR=/claude <container>
#                node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude /login`
#             (`-arm64` on arm), or copy an existing login's directory into the volume.
#
# Both must be OWNED by uid 10001 (the `shuvi` user below), not just writable: git refuses a home/ owned by
# another user. SHUVI_CLAUDE_CONFIG_DIR is applied to the catalog's `claude` login on every start
# (store/models.ts `reconcileClaudeLogin`), so a store moved in from elsewhere uses /claude. Run ONE container
# per /data at a time: the old one must have stopped before the new one starts. When the secrets file is used
# (SHUVI_SECRETS_FILE), mount the directory that holds it, writable by that user too: its `.known` file is
# kept beside it.
#
# The HEALTHCHECK calls /healthz on SHUVI_METRICS_LISTEN (loopback, default 127.0.0.1:8788): the store is
# open and the Telegram poller has polled in the last two minutes (src/server/health.ts).
#
# Built and pushed by .github/workflows/release.yml.

# oven/bun:1.4.4-slim (Debian slim), pinned by digest.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

# tini: PID 1. git: home/ is a git repo (edits are commits, the daily backup is a bundle).
# ca-certificates: HTTPS to Telegram, Anthropic and the rest.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 shuvi \
 && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/shuvi --shell /usr/sbin/nologin shuvi \
 && mkdir -p /data /claude \
 && chown shuvi:shuvi /data /claude

WORKDIR /app

# Dependencies first, so a change to the code alone reuses this layer. The Claude Code CLI comes with the
# Agent SDK (its platform package), as it does locally.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production \
 && rm -rf /root/.bun/install/cache

COPY tsconfig.json ./
COPY drizzle ./drizzle
COPY src ./src

# The commit /status shows (src/control/bot.ts `deployedCommit`): there is no .git in the image.
ARG REVISION=unknown
ENV SHUVI_COMMIT=${REVISION} \
    SHUVI_DATA_DIR=/data \
    SHUVI_CLAUDE_CONFIG_DIR=/claude \
    SHUVI_METRICS_LISTEN=127.0.0.1:8788 \
    NODE_ENV=production \
    LANG=C.UTF-8

USER shuvi
VOLUME ["/data", "/claude"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["bun", "-e", "const l=process.env.SHUVI_METRICS_LISTEN||'127.0.0.1:8788';fetch('http://'+l+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# SIGTERM is what starts the drain; say so, whatever the runtime's default.
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "src/server/main.ts"]
