"""Real-ESRGAN video upscale pre-pass (realesr-general-x4v3, SRVGG compact).

Runs BEFORE aspect conversion + caption burn so low-res sources (e.g. 480p
masters) get ML super-resolution while captions stay vector-crisp on the
final 1080x1920 canvas.

The SRVGG compact architecture is implemented inline with plain PyTorch
(~40 lines) instead of depending on basicsr/realesrgan, whose pinned
torchvision requirements break regularly. Weights are baked into the Docker
image (ENABLE_UPSCALE=1) at UPSCALE_MODEL_PATH; the model is x4 with a
nearest-neighbour residual, loaded strict so a wrong file fails loudly.

Callers must treat UpscaleUnavailable / any failure as non-fatal and fall
back to plain lanczos scaling in the main encode.
"""

import logging
import os
import subprocess
from pathlib import Path
from typing import Optional

from .probe import probe_video
from .render import RenderError, video_codec_args

logger = logging.getLogger(__name__)

MODEL_PATH = os.environ.get("UPSCALE_MODEL_PATH", "/app/models/realesr-general-x4v3.pth")
UPSCALE_TIMEOUT = 1800
BATCH_FRAMES = 4

_model = None  # cached across clips within one job/worker


class UpscaleUnavailable(Exception):
    """torch / CUDA / model weights not present on this host."""


def _build_srvgg(torch, nn):
    """SRVGGNetCompact(num_feat=64, num_conv=32, upscale=4) — realesr-general-x4v3."""

    class SRVGGNetCompact(nn.Module):
        def __init__(self, num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=32, upscale=4):
            super().__init__()
            self.upscale = upscale
            self.body = nn.ModuleList()
            self.body.append(nn.Conv2d(num_in_ch, num_feat, 3, 1, 1))
            self.body.append(nn.PReLU(num_parameters=num_feat))
            for _ in range(num_conv):
                self.body.append(nn.Conv2d(num_feat, num_feat, 3, 1, 1))
                self.body.append(nn.PReLU(num_parameters=num_feat))
            self.body.append(nn.Conv2d(num_feat, num_out_ch * upscale * upscale, 3, 1, 1))
            self.upsampler = nn.PixelShuffle(upscale)

        def forward(self, x):
            out = x
            for layer in self.body:
                out = layer(out)
            out = self.upsampler(out)
            base = torch.nn.functional.interpolate(x, scale_factor=self.upscale, mode="nearest")
            return out + base

    return SRVGGNetCompact()


def _load_model():
    global _model
    if _model is not None:
        return _model
    try:
        import torch
        from torch import nn
    except ImportError as exc:
        raise UpscaleUnavailable("torch is not installed (build image with ENABLE_UPSCALE=1)") from exc
    if not torch.cuda.is_available():
        raise UpscaleUnavailable("no CUDA device for Real-ESRGAN")
    if not Path(MODEL_PATH).exists():
        raise UpscaleUnavailable(f"model weights not found: {MODEL_PATH}")

    state = torch.load(MODEL_PATH, map_location="cuda", weights_only=True)
    state = state.get("params", state)
    model = _build_srvgg(torch, nn)
    model.load_state_dict(state, strict=True)
    model = model.eval().half().cuda()
    _model = model
    logger.info("Real-ESRGAN compact model loaded (%s)", MODEL_PATH)
    return model


def upscale_video(src: Path, out: Path, target_h: int = 1080) -> bool:
    """SR-upscale ``src`` so its height reaches ``target_h``; audio copied.

    Returns False (no-op, ``out`` not written) when the source is already at
    or above ``target_h``. Raises UpscaleUnavailable / RenderError on failure.
    """
    import numpy as np

    info = probe_video(src)
    in_w, in_h, fps = info["width"], info["height"], info["fps"] or 30.0
    if in_h >= target_h:
        logger.info("upscale skipped: source %dx%d already >= %dp", in_w, in_h, target_h)
        return False

    model = _load_model()
    import torch

    out_w, out_h = in_w * 4, in_h * 4
    if out_h > target_h:  # downscale the x4 result to the requested target
        out_w = max(2, round(in_w * target_h / in_h / 2) * 2)
        out_h = target_h if target_h % 2 == 0 else target_h + 1

    reader = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", str(src),
         "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        stdout=subprocess.PIPE,
    )
    writer = subprocess.Popen(
        ["ffmpeg", "-y", "-v", "error",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{out_w}x{out_h}",
         "-r", f"{fps}", "-i", "pipe:0",
         "-i", str(src),
         "-map", "0:v", "-map", "1:a?",
         *video_codec_args(),
         "-c:a", "copy",
         "-movflags", "+faststart",
         str(out)],
        stdin=subprocess.PIPE,
    )

    frame_bytes = in_w * in_h * 3
    frames = 0
    try:
        with torch.inference_mode():
            batch = []
            while True:
                buf = reader.stdout.read(frame_bytes)
                if len(buf) < frame_bytes:
                    if batch:
                        _flush_batch(torch, np, model, batch, writer, out_w, out_h, in_w, in_h)
                        frames += len(batch)
                    break
                batch.append(buf)
                if len(batch) >= BATCH_FRAMES:
                    _flush_batch(torch, np, model, batch, writer, out_w, out_h, in_w, in_h)
                    frames += len(batch)
                    batch = []
        writer.stdin.close()
        reader.stdout.close()
        if writer.wait(timeout=UPSCALE_TIMEOUT) != 0 or reader.wait(timeout=60) != 0:
            raise RenderError("upscale ffmpeg pipe failed")
    except BrokenPipeError as exc:
        reader.kill()
        writer.kill()
        raise RenderError("upscale encoder pipe broke") from exc

    logger.info("upscaled %d frames %dx%d -> %dx%d", frames, in_w, in_h, out_w, out_h)
    if frames == 0:
        raise RenderError("upscale produced no frames")
    return True


def _flush_batch(torch, np, model, batch, writer, out_w, out_h, in_w, in_h):
    arr = np.frombuffer(b"".join(batch), dtype=np.uint8).reshape(len(batch), in_h, in_w, 3)
    x = torch.from_numpy(arr.copy()).cuda().permute(0, 3, 1, 2).half().div_(255.0)
    y = model(x)
    if y.shape[-2] != out_h or y.shape[-1] != out_w:
        y = torch.nn.functional.interpolate(y, size=(out_h, out_w), mode="area")
    y = y.clamp_(0, 1).mul_(255.0).round_().byte().permute(0, 2, 3, 1).contiguous()
    writer.stdin.write(y.cpu().numpy().tobytes())
