"""Step 11 — burn subtitles into the video (libass). New, but conventions match
merge/concat. Video is re-encoded (can't -c:v copy through a filter); audio is
copied through."""
from __future__ import annotations

import os

from .. import ffmpeg as ff
from .. import io

REQUIRED = ("videoUrl", "subtitlesUrl", "outputKey")


def run(inp: dict, workdir: str) -> dict:
    for k in REQUIRED:
        if not inp.get(k):
            raise ValueError(f"caption: missing '{k}'")

    video = io.download(inp["videoUrl"], os.path.join(workdir, "video.mp4"))
    ext = ".ass" if inp["subtitlesUrl"].lower().endswith(".ass") else ".srt"
    sub = io.download(inp["subtitlesUrl"], os.path.join(workdir, f"subs{ext}"))
    out = os.path.join(workdir, "captioned.mp4")

    args = ff.build_caption_args(video, sub, out, force_style=inp.get("forceStyle"))
    ff.run_checked(args, "caption", timeout=20 * 60)

    url = io.upload(out, inp["outputKey"], "video/mp4")
    return {"url": url, "durationS": round(ff.duration_seconds(out), 3)}
