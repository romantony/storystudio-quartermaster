"""RunPod serverless entrypoint for the `media` endpoint.

One image, five ops (spec §3 steps 6, 8, 10, 11, 12) — the tail of the pipeline
that is all ffmpeg work on the same container. Dispatch on `input.op`.

Request:  {"input": {"op": "<merge|concat|upscale|caption|bgm_overlay>", ...op args..., "outputKey": "path/in/r2.mp4"}}
Success:  {"url": "...", "durationS": 12.4, ...op extras...}
Failure:  {"error": "<message>", "op": "<op>"}   (RunPod marks the job FAILED)

Each job runs in its own temp dir, always cleaned up. No global state.
"""
from __future__ import annotations

import os
import shutil
import tempfile
import time
import traceback

from media.ops import REGISTRY

try:
    import runpod
except ImportError:  # local smoke tests import this module without the SDK
    runpod = None


def process(job: dict) -> dict:
    inp = job.get("input") or {}
    op = inp.get("op")
    if op not in REGISTRY:
        return {"error": f"unknown op {op!r}; expected one of {sorted(REGISTRY)}", "op": op}

    workdir = tempfile.mkdtemp(prefix=f"media-{op}-")
    started = time.monotonic()
    try:
        result = REGISTRY[op](inp, workdir)
        result.setdefault("op", op)
        result["elapsedMs"] = int((time.monotonic() - started) * 1000)
        return result
    except Exception as exc:  # noqa: BLE001 — the error envelope IS the contract
        return {
            "error": str(exc),
            "op": op,
            "elapsedMs": int((time.monotonic() - started) * 1000),
            "trace": traceback.format_exc(limit=6) if os.environ.get("MEDIA_DEBUG") else None,
        }
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    if runpod is None:
        raise SystemExit("runpod SDK not installed — this entrypoint is for the container only")
    runpod.serverless.start({"handler": process})
