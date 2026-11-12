# The shared base image of every chat's computer (docs/design.md §15, src/capabilities/computer/).
#
# One image for all chats in v1. A chat's home, /home/shuvi, is its own Hangar Disk mounted over this
# image's /home/shuvi: a new disk is seeded once from what the image has there, and is never touched by
# the image again. So anything a chat installs or saves under ~ stays; anything installed elsewhere
# comes from this image, or from the chat's own ~/.computer.yaml (apt packages and a setup script), which
# shuvi applies as root on top of it and again whenever this image changes
# (src/capabilities/computer/declared.ts).
#
# So this image holds only what is generic: what the assistant's prompt names and what the framework's
# own scripts use. Anything more specific belongs in a chat's ~/.computer.yaml or under its home, never
# here: this repository is public, and what one chat needs is not.
#
# GitHub Actions builds it (.github/workflows/computer-image.yml) into the private package
# ghcr.io/<owner>/shuvi-computer; SHUVI_COMPUTER_IMAGE names the digest it prints (see the README,
# "The computer's image").
FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PIP_BREAK_SYSTEM_PACKAGES=1

# The tools the assistant's prompt names (python3 and pip, node and npm, ffmpeg, git, curl, jq, sqlite3),
# plus what the framework's own scripts use: bash, coreutils (timeout, stat, base64), util-linux (setsid
# for background jobs, flock for applying ~/.computer.yaml), time (GNU time: a job's peak memory and
# CPU), ca-certificates; and procps, so `ps` can show what runs. fonts-dejavu-core is the font video_sheet
# labels its frames with (ffmpeg's drawtext); ffmpeg's fontconfig already pulls it in, named so it stays.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils util-linux procps time \
      curl git jq sqlite3 \
      python3 python3-pip python3-venv \
      nodejs npm \
      ffmpeg fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

# The user every exec runs as, whose home the chat's disk is mounted over.
RUN useradd --create-home --home-dir /home/shuvi --shell /bin/bash --uid 1000 shuvi \
 && mkdir -p /home/shuvi/inbox \
 && chown -R shuvi:shuvi /home/shuvi

USER shuvi
WORKDIR /home/shuvi

# Keeps the container up between execs; shuvi names the same command in the container's spec.
CMD ["sleep", "infinity"]
