# Multi-stage: compile TypeScript in a full node image, run in a slim one
# with system ffmpeg (no @ffmpeg-installer/ffmpeg npm trick needed here —
# that package exists specifically to smuggle a native binary into a
# *Lambda* bundle; a container just installs ffmpeg normally).
#
# Two entrypoints share this image:
#   node index.js  — the original concat-and-trim task (the AWS live-path
#                    pipelines; the task definition's default CMD)
#   node tail.js   — the orchestrator assembly tail (assemble / finalize); the
#                    state machine overrides the container command to this.

FROM node:20 AS build
WORKDIR /build
COPY package.json tsconfig.json ./
RUN npm install
COPY index.ts tail.ts tail-core.ts ./
RUN npx tsc -p tsconfig.json

FROM node:20-slim
# fonts + libass for the burned-in captions (tail.js finalize): Montserrat is
# the TikTok-style caption face, Noto Sans Devanagari covers Hindi — without a
# Devanagari font libass renders conjuncts as tofu boxes (the same bug
# E2E-finalize hit). Both land in /opt/fonts, the fontsdir the ASS filter uses.
#
# Montserrat is NOT packaged in Debian bookworm (node:20-slim's base) —
# `apt-get install fonts-montserrat` fails with "Unable to locate package". It
# comes from the upstream project at a pinned release instead. Every step is
# chained with && and checked, so a missing font fails the BUILD rather than
# silently shipping captions in a fallback face.
ARG MONTSERRAT_REF=v7.222
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg fontconfig fonts-noto-core ca-certificates curl \
    && mkdir -p /opt/fonts \
    && curl -fsSL -o /opt/fonts/Montserrat-Regular.ttf \
         "https://raw.githubusercontent.com/JulietaUla/Montserrat/${MONTSERRAT_REF}/fonts/ttf/Montserrat-Regular.ttf" \
    && curl -fsSL -o /opt/fonts/Montserrat-Bold.ttf \
         "https://raw.githubusercontent.com/JulietaUla/Montserrat/${MONTSERRAT_REF}/fonts/ttf/Montserrat-Bold.ttf" \
    && find /usr/share/fonts -iname "NotoSansDevanagari*.ttf" -exec cp {} /opt/fonts/ \; \
    && ls /opt/fonts/NotoSansDevanagari*.ttf >/dev/null \
    && fc-cache -f /opt/fonts/ \
    && fc-scan --format "%{family}\n" /opt/fonts/Montserrat-Bold.ttf | grep -q "^Montserrat" \
    && fc-scan --format "%{family}\n" /opt/fonts/Montserrat-Regular.ttf | grep -q "^Montserrat" \
    && apt-get purge -y curl && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /build/dist/index.js /build/dist/tail.js /build/dist/tail-core.js ./
CMD ["node", "index.js"]
