# The shared base image of every chat's computer (docs/design.md §15, src/capabilities/computer/).
#
# One image for all chats in v1. A chat's home, /home/shuvi, is its own Hangar Disk mounted over this
# image's /home/shuvi: a new disk is seeded once from what the image has there, and is never touched by
# the image again. So anything a chat installs or saves under ~ stays; anything installed elsewhere
# comes from this image (and an ad-hoc `apt install` lasts only until the image changes).
#
# GitHub Actions builds it (.github/workflows/computer-image.yml) into the private package
# ghcr.io/<owner>/shuvi-computer; SHUVI_COMPUTER_IMAGE names the digest it prints (see the README,
# "The computer's image").
FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PIP_BREAK_SYSTEM_PACKAGES=1

# The common tools the assistant's prompt names, plus what the framework's own scripts use:
# util-linux (setsid, for background jobs), time (GNU time: a job's peak memory and CPU), coreutils.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils util-linux procps time less file unzip zip xz-utils \
      curl wget git jq sqlite3 \
      python3 python3-pip python3-venv \
      nodejs npm \
      ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp moves fast; take the release from PyPI rather than Debian's. faster-whisper runs transcribe
# on the CPU (CTranslate2, int8); its models download into ~/.cache on first use, so they persist on
# the chat's disk.
RUN pip3 install --no-cache-dir yt-dlp faster-whisper

# The user every exec runs as, whose home the chat's disk is mounted over.
RUN useradd --create-home --home-dir /home/shuvi --shell /bin/bash --uid 1000 shuvi \
 && mkdir -p /home/shuvi/inbox \
 && chown -R shuvi:shuvi /home/shuvi

USER shuvi
WORKDIR /home/shuvi

# Keeps the container up between execs; shuvi names the same command in the container's spec.
CMD ["sleep", "infinity"]
