# Multi-stage: compile TypeScript in a full node image, run in a slim one
# with system ffmpeg (no @ffmpeg-installer/ffmpeg npm trick needed here —
# that package exists specifically to smuggle a native binary into a
# *Lambda* bundle; a container just installs ffmpeg normally).

FROM node:20 AS build
WORKDIR /build
COPY package.json tsconfig.json ./
RUN npm install
COPY index.ts ./
RUN npx tsc -p tsconfig.json

FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /build/dist/index.js ./index.js
CMD ["node", "index.js"]
