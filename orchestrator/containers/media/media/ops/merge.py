"""Step 6 — audio/video merge. Ported from src/handlers/merge.ts."""
from __future__ import annotations

import os

from .. import ffmpeg as ff
from .. import io

REQUIRED = ("videoUrl", "audioUrl", "outputKey")


def run(inp: dict, workdir: str) -> dict:
    for k in REQUIRED:
        if not inp.get(k):
            raise ValueError(f"merge: missing '{k}'")

    video = io.download(inp["videoUrl"], os.path.join(workdir, "video.mp4"))
    audio = io.download(inp["audioUrl"], os.path.join(workdir, "audio.in"))
    out = os.path.join(workdir, "out.mp4")

    video_dur = ff.duration_seconds(video)
    mix_mode = inp.get("mixMode", "replace")
    video_has_audio = ff.has_audio_stream(video)

    if mix_mode == "additive" and video_has_audio:
        target = video_dur  # the video's own audio is canonical for additive
    elif inp.get("durationS") is not None:
        target = float(inp["durationS"])  # fourLang: pad shorter audio to the shared max
    else:
        target = min(video_dur, ff.duration_seconds(audio))  # legacy -shortest

    args = ff.build_merge_args(
        video, audio, out,
        target_s=target,
        mix_mode=mix_mode,
        sfx_volume=inp.get("sfxVolume"),
        video_has_audio=video_has_audio,
    )
    ff.run_checked(args, "merge", timeout=600)

    url = io.upload(out, inp["outputKey"], "video/mp4")
    return {"url": url, "durationS": round(ff.duration_seconds(out) or target, 3)}
