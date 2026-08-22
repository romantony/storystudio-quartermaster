# qm-shorts-longform — QM-owned ECS Fargate task (replaces the old RunPod
# serverless endpoint; source of truth is now this directory, built via
# CodeBuild -> ECR, same pattern as qm-concat-and-trim/qm-dialogue-mix).
#
# CPU-only — no GPU/CUDA/NVENC dependency. Encodes with libx264 (ffmpeg's
# software encoder). The Real-ESRGAN upscale pre-pass (upscale: "realesrgan")
# needed CUDA and has been dropped; upscale requests fall back to lanczos
# automatically (see shorts/upscale.py).
#
# Entrypoint reads its job input from S3 (PAYLOAD_BUCKET/PAYLOAD_S3_KEY, set
# by ecs:runTask ContainerOverrides) instead of a RunPod job dict, and POSTs
# its own completion webhook instead of relying on RunPod's platform to do
# it — see handler.py's main()/_post_webhook().
#
# Optional local Whisper (srt_source: "local"):
#   docker build --build-arg ENABLE_LOCAL_WHISPER=1 ...

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip \
        ffmpeg fontconfig \
        curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Montserrat Black for ASS caption + drawtext rendering (upstream font repo).
RUN mkdir -p /usr/share/fonts/truetype/montserrat && \
    curl -fsSL -o /usr/share/fonts/truetype/montserrat/Montserrat-Black.ttf \
        "https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf/Montserrat-Black.ttf" && \
    fc-cache -f && \
    fc-list | grep -qi "Montserrat"

WORKDIR /app

COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

ARG ENABLE_LOCAL_WHISPER=0
RUN if [ "$ENABLE_LOCAL_WHISPER" = "1" ]; then \
        pip3 install --no-cache-dir "faster-whisper>=1.0,<2"; \
    fi

COPY handler.py test_worker.py ./
COPY shorts ./shorts

CMD ["python3", "-u", "handler.py"]
