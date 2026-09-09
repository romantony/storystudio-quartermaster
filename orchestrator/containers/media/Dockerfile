# syntax=docker/dockerfile:1
#
# `media` RunPod serverless endpoint — the ffmpeg tail of the background
# pipeline (spec §3 steps 6, 8, 10, 11, 12). One image, five ops.
#
# Base: CUDA runtime so ffmpeg's h264_nvenc and Real-ESRGAN's Vulkan backend
# can use the host GPU (RunPod mounts the driver + NVENC/Vulkan libs at run
# time). Ubuntu 22.04's ffmpeg is built --enable-nvenc, so no custom build.
#
# NVENC needs the endpoint configured with NVIDIA_DRIVER_CAPABILITIES that
# includes `video`; Real-ESRGAN's Vulkan needs `graphics`. See probe.md.
#
#   docker build -t qm-media .
#   # local, GPU-less: MEDIA_VIDEO_ENCODER=libx264  (see test/smoke_local.sh)

FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility,video,graphics \
    REALESRGAN_BIN=/opt/realesrgan/realesrgan-ncnn-vulkan \
    REALESRGAN_MODELS=/opt/realesrgan/models

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        python3 python3-pip \
        libvulkan1 \
        ca-certificates wget unzip \
    && rm -rf /var/lib/apt/lists/*

# Real-ESRGAN ncnn-vulkan (binary + models). Pinned release.
RUN mkdir -p /opt/realesrgan \
    && wget -qO /tmp/resrgan.zip \
        https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip \
    && unzip -q /tmp/resrgan.zip -d /opt/realesrgan \
    && chmod +x /opt/realesrgan/realesrgan-ncnn-vulkan \
    && rm /tmp/resrgan.zip

WORKDIR /app
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

COPY handler.py .
COPY media ./media

CMD ["python3", "-u", "handler.py"]
