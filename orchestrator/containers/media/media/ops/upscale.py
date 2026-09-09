"""Step 10 — video upscale.

Two paths, chosen by `input.model`:
  - "realesrgan-x4plus" / "realesrgan-x4plus-anime" (default): ML SR. Extract
    frames -> realesrgan-ncnn-vulkan per frame -> reassemble at the source fps
    with the source audio. ncnn-vulkan keeps VRAM low (spec §16 q4: the media
    endpoint wants NVENC + almost no VRAM) at the cost of frame I/O — which is
    exactly what §12.3's probe measures.
  - "lanczos": no model. A single ffmpeg `scale=…:flags=lanczos` + light
    `unsharp`. Fast, runs GPU-less, the fallback when the SR binary is absent.
"""
from __future__ import annotations

import glob
import os
import shutil
import subprocess

from .. import ffmpeg as ff
from .. import io

REALESRGAN_BIN = os.environ.get("REALESRGAN_BIN", "realesrgan-ncnn-vulkan")
REALESRGAN_MODELS = os.environ.get("REALESRGAN_MODELS", "/opt/realesrgan/models")
DEFAULT_MODEL = os.environ.get("MEDIA_UPSCALE_MODEL", "realesrgan-x4plus")


def run(inp: dict, workdir: str) -> dict:
    if not inp.get("videoUrl") or not inp.get("outputKey"):
        raise ValueError("upscale: missing 'videoUrl' / 'outputKey'")

    video = io.download(inp["videoUrl"], os.path.join(workdir, "in.mp4"))
    out = os.path.join(workdir, "up.mp4")
    model = inp.get("model", DEFAULT_MODEL)
    scale = int(inp.get("scale", 2))

    if model == "lanczos" or not shutil.which(REALESRGAN_BIN):
        _lanczos(video, out, scale)
    else:
        _realesrgan(video, out, workdir, model=model, scale=scale)

    url = io.upload(out, inp["outputKey"], "video/mp4")
    return {
        "url": url,
        "durationS": round(ff.duration_seconds(out), 3),
        "model": model if (model == "lanczos" or shutil.which(REALESRGAN_BIN)) else "lanczos",
        "scale": scale,
    }


def _lanczos(video: str, out: str, scale: int) -> None:
    vf = f"scale=iw*{scale}:ih*{scale}:flags=lanczos,unsharp=5:5:0.6:5:5:0.0"
    args = ["-y", "-i", video, "-vf", vf, *ff.video_encoder_args(),
            "-c:a", "copy", "-movflags", "+faststart", out]
    ff.run_checked(args, "upscale.lanczos", timeout=30 * 60)


def _realesrgan(video: str, out: str, workdir: str, *, model: str, scale: int) -> None:
    frames_in = os.path.join(workdir, "f_in")
    frames_out = os.path.join(workdir, "f_out")
    os.makedirs(frames_in, exist_ok=True)
    os.makedirs(frames_out, exist_ok=True)

    fps = ff.fps_of(video)
    has_audio = ff.has_audio_stream(video)

    ff.run_checked(
        ff.build_frames_extract_args(video, os.path.join(frames_in, "%08d.png")),
        "upscale.extract", timeout=20 * 60,
    )
    n_in = len(glob.glob(os.path.join(frames_in, "*.png")))
    if n_in == 0:
        raise ff.FfmpegError("upscale: frame extraction produced no frames")

    # ncnn-vulkan processes a whole directory in one call.
    proc = subprocess.run(
        [REALESRGAN_BIN, "-i", frames_in, "-o", frames_out,
         "-n", model, "-s", str(scale), "-m", REALESRGAN_MODELS, "-f", "png"],
        capture_output=True, text=True, timeout=60 * 60,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"realesrgan failed (exit {proc.returncode}): {proc.stderr[-1800:]}")
    n_out = len(glob.glob(os.path.join(frames_out, "*.png")))
    if n_out != n_in:
        raise RuntimeError(f"realesrgan produced {n_out} frames from {n_in}")

    audio_source = video if has_audio else os.devnull
    ff.run_checked(
        ff.build_frames_assemble_args(
            os.path.join(frames_out, "%08d.png"), audio_source, out,
            fps=fps, has_audio=has_audio,
        ),
        "upscale.assemble", timeout=30 * 60,
    )
