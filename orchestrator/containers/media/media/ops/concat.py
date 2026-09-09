"""Step 8 — concatenate per-frame clips into one video.

Ported from infra/docker/concat-and-trim/index.ts: per-clip normalize
(scale/pad/fps/format + audio aformat or synthesized silence) through one
filter_complex; a batched path for >40 clips so the filtergraph stays sane.
Silence-trim is deliberately NOT included (spec step 8 is concat only; §9 s2t and
downstream own trimming). NVENC vs libx264 is `MEDIA_VIDEO_ENCODER`.
"""
from __future__ import annotations

import os

from .. import ffmpeg as ff
from .. import io

PARALLEL_THRESHOLD = 40
BATCH_SIZE = 10


def _collect_urls(inp: dict) -> list[str]:
    if inp.get("videos"):
        ordered = sorted(
            (v for v in inp["videos"] if v.get("videoUrl")),
            key=lambda v: v.get("frameNumber", 0),
        )
        return [v["videoUrl"] for v in ordered]
    return [u for u in inp.get("videoUrls", []) if u]


def run(inp: dict, workdir: str) -> dict:
    urls = _collect_urls(inp)
    if not urls:
        raise ValueError("concat: no videos / videoUrls provided")
    if not inp.get("outputKey"):
        raise ValueError("concat: missing 'outputKey'")
    aspect = inp.get("aspectRatio", "9:16")

    paths: list[str] = []
    for i, u in enumerate(urls):
        p = os.path.join(workdir, f"in_{i:04d}.mp4")
        io.download(u, p)
        paths.append(p)

    out = os.path.join(workdir, "concat.mp4")

    if len(paths) <= PARALLEL_THRESHOLD:
        _normalize(paths, out, aspect, preset="fast")
    else:
        batch_dir = os.path.join(workdir, "batches")
        os.makedirs(batch_dir, exist_ok=True)
        batch_outs: list[str] = []
        for i in range(0, len(paths), BATCH_SIZE):
            b_out = os.path.join(batch_dir, f"b_{i // BATCH_SIZE:04d}.mp4")
            _normalize(paths[i:i + BATCH_SIZE], b_out, aspect, preset="ultrafast")
            batch_outs.append(b_out)
            for p in paths[i:i + BATCH_SIZE]:
                try:
                    os.remove(p)
                except OSError:
                    pass
        _stream_copy_concat(batch_outs, out, workdir)

    url = io.upload(out, inp["outputKey"], "video/mp4")
    return {"url": url, "durationS": round(ff.duration_seconds(out), 3), "clips": len(paths)}


def _normalize(paths: list[str], out: str, aspect: str, *, preset: str) -> None:
    args = ff.build_concat_normalize_args(
        paths, out,
        aspect_ratio=aspect,
        audio_present=[ff.has_audio_stream(p) for p in paths],
        durations=[ff.duration_seconds(p) for p in paths],
        preset_override=preset,
    )
    ff.run_checked(args, "concat.normalize", timeout=15 * 60)


def _stream_copy_concat(paths: list[str], out: str, workdir: str) -> None:
    list_file = os.path.join(workdir, "concat.list")
    with open(list_file, "w", encoding="utf-8") as f:
        for p in paths:
            f.write(f"file '{p}'\n")
    ff.run_checked(ff.build_stream_copy_concat_args(list_file, out), "concat.streamcopy", timeout=5 * 60)
