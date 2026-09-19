# syntax=docker/dockerfile:1
#
# Orchestrator image. Self-contained within orchestrator/ — the committed
# src/fleet-registry.ts is what the runtime uses, so no reach into ../src and
# no `npm run gen:fleet` at build time (that script is a dev tool; its output is
# guarded by fleet-registry.test.ts).
#
#   build:   docker compose build orchestrator
#   migrate: docker compose run --rm orchestrator node dist/db/migrate.js up
#   run:     docker compose up -d orchestrator

# ---- builder: full deps, compile TS, stage the .sql files ----
FROM node:20-bookworm-slim AS builder
WORKDIR /build
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json \
 && mkdir -p dist/db/migrations \
 && cp src/db/migrations/*.sql dist/db/migrations/

# ---- runtime: prod deps only ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
# ffmpeg/ffprobe: the asset pipeline's LOCAL quality tier (src/quality/local.ts)
# decodes a tiny thumbnail strip from each generated image/clip and measures it
# in process — blank frames, frozen clips, wrong aspect ratios. No model, no
# GPU, no API. This is the only reason the image needs it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force
COPY --from=builder /build/dist ./dist

RUN useradd --system --uid 10001 orch && chown -R orch:orch /app
USER orch

EXPOSE 8080
# Migrations are an explicit deploy step (spec §15.3: never automatic on boot).
CMD ["node", "dist/index.js"]
