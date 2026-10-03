# QM-animate — per-frame Ken Burns on Lambda (see handler.ts).
# Build context: infra/docker (the handler imports ../concat-and-trim/tail-core.ts).

FROM node:20-slim AS build
WORKDIR /src
RUN npm install --no-save --no-audit --no-fund esbuild@0.24.0
COPY concat-and-trim/tail-core.ts concat-and-trim/tail-core.ts
COPY animate-lambda/handler.ts animate-lambda/handler.ts
# The AWS SDK v3 ships with the nodejs20.x Lambda base image — keep it external.
RUN npx esbuild animate-lambda/handler.ts --bundle --platform=node --target=node20 \
      --external:@aws-sdk/* --outfile=/out/index.js

FROM public.ecr.aws/lambda/nodejs:20
# Static ffmpeg/ffprobe (GPL build: libx264 + zoompan). Every check fails the
# build rather than shipping a binary that cannot render.
RUN dnf install -y tar xz && dnf clean all \
 && curl -fsSL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz -o /tmp/ff.tar.xz \
 && mkdir -p /tmp/ff && tar -xJf /tmp/ff.tar.xz -C /tmp/ff --strip-components=1 \
 && install -m 0755 /tmp/ff/ffmpeg /tmp/ff/ffprobe /usr/local/bin/ \
 && rm -rf /tmp/ff /tmp/ff.tar.xz \
 && ffmpeg -hide_banner -filters | grep -q ' zoompan ' \
 && ffmpeg -hide_banner -encoders | grep -q libx264 \
 && ffprobe -version >/dev/null
ENV FFMPEG_PATH=/usr/local/bin/ffmpeg FFPROBE_PATH=/usr/local/bin/ffprobe
COPY --from=build /out/index.js ${LAMBDA_TASK_ROOT}/index.js
CMD ["index.handler"]
