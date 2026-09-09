"""Step 12 — mix a looped BGM bed under the video's existing audio.

`-c:v copy` (no video re-encode). BGM is `-stream_loop -1` then trimmed to the
video length via `-t`. Optional `duckDb` sidechain-compresses the bed against the
foreground so narration/dialogue stays on top.
"""
from __future__ import annotations

import os

from .. import ffmpeg as ff
from .. import io

REQUIRED = ("videoUrl", "bgmUrl", "outputKey")


def run(inp: dict, workdir: str) -> dict:
    for k in REQUIRED:
        if not inp.get(k):
            raise ValueError(f"bgm_overlay: missing '{k}'")

    video = io.download(inp["videoUrl"], os.path.join(workdir, "video.mp4"))
    bgm = io.download(inp["bgmUrl"], os.path.join(workdir, "bgm.in"))
    out = os.path.join(workdir, "with_bgm.mp4")

    args = ff.build_bgm_overlay_args(
        video, bgm, out,
        video_duration=ff.duration_seconds(video),
        bgm_volume=float(inp.get("bgmVolume", 0.18)),
        duck_db=(float(inp["duckDb"]) if inp.get("duckDb") is not None else None),
        video_has_audio=ff.has_audio_stream(video),
    )
    ff.run_checked(args, "bgm_overlay", timeout=15 * 60)

    url = io.upload(out, inp["outputKey"], "video/mp4")
    return {"url": url, "durationS": round(ff.duration_seconds(out), 3)}
