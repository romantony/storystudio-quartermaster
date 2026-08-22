"""BGM resolution: pre-generated URL, or generate via Flux-TTS-S2T `bgm` mode."""

import logging
import math
import os
from pathlib import Path
from typing import Any, Dict, Optional

from .probe import download
from .transcribe import RunpodClient

logger = logging.getLogger(__name__)

BGM_MAX_DURATION_S = 240.0


class BgmError(Exception):
    pass


def resolve_bgm(
    bgm_url: Optional[str],
    bgm_prompt: Optional[str],
    duration_s: float,
    workdir: Path,
    project_id: Optional[str] = None,
    client: Optional[RunpodClient] = None,
    timeout_s: int = 900,
) -> Optional[Dict[str, Any]]:
    """Return {"path": Path, "url": str, "generated": bool} or None when no BGM.

    ``bgm_url`` wins over ``bgm_prompt``. Generation targets the longest short
    (plus slide time), capped at BGM_MAX_DURATION_S.
    """
    if bgm_url:
        path = workdir / "bgm_source.mp3"
        download(bgm_url, path)
        return {"path": path, "url": bgm_url, "generated": False}

    if not bgm_prompt:
        return None

    endpoint_id = os.environ.get("BGM_ENDPOINT_ID") or os.environ.get("SRT_ENDPOINT_ID", "")
    if not endpoint_id:
        raise BgmError("BGM_ENDPOINT_ID is not set but bgm_prompt was given")
    client = client or RunpodClient()

    target_duration = min(BGM_MAX_DURATION_S, max(10.0, math.ceil(duration_s)))
    payload: Dict[str, Any] = {
        "mode": "bgm",
        "prompt": bgm_prompt,
        "duration_s": target_duration,
    }
    if project_id:
        payload["project_id"] = project_id
        payload["frame_id"] = "shorts"

    logger.info("generating BGM via endpoint %s (%.0fs)", endpoint_id, target_duration)
    output = client.run(endpoint_id, payload, timeout_s=timeout_s)
    audio_url = output.get("audio")
    if not audio_url:
        raise BgmError(f"bgm mode returned no audio URL: {str(output)[:300]}")

    path = workdir / "bgm_generated.mp3"
    download(audio_url, path)
    return {"path": path, "url": audio_url, "generated": True}
