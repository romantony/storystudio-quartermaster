"""Media ops — one module per pipeline step the `media` endpoint serves.

    op            spec step   ffmpeg work
    ----------    ---------   -----------
    merge          6          mux audio+video, apad/-shortest
    concat         8          per-clip normalize + concat (NVENC/x264)
    upscale       10          Real-ESRGAN frames, or lanczos fallback
    caption       11          burn SRT/ASS (libass)
    bgm_overlay   12          loop + mix a BGM bed under existing audio
"""
from . import bgm_overlay, caption, concat, merge, upscale

REGISTRY = {
    "merge": merge.run,
    "concat": concat.run,
    "upscale": upscale.run,
    "caption": caption.run,
    "bgm_overlay": bgm_overlay.run,
}
