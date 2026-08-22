"""Transcription: Flux-TTS-S2T `transcribe` mode client + optional local faster-whisper.

Returns a uniform shape either way:
    {"text": str, "words": [{"text", "start_ms", "end_ms"}], "srt_content": str|None}
"""

import logging
import os
import time
from typing import Any, Dict, Optional

import requests

from .captions import words_from_chunks

logger = logging.getLogger(__name__)

RUNPOD_API_BASE = "https://api.runpod.ai/v2"


class TranscribeError(Exception):
    pass


class RunpodClient:
    """Minimal /run + poll client for calling sibling RunPod endpoints."""

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.environ.get("RUNPOD_API_KEY", "")
        if not self.api_key:
            raise TranscribeError("RUNPOD_API_KEY is not set (needed for cross-endpoint calls)")
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        })

    def run(
        self,
        endpoint_id: str,
        payload: Dict[str, Any],
        timeout_s: int = 900,
        poll_interval_s: float = 5.0,
    ) -> Dict[str, Any]:
        resp = self.session.post(
            f"{RUNPOD_API_BASE}/{endpoint_id}/run",
            json={"input": payload},
            timeout=30,
        )
        resp.raise_for_status()
        job_id = resp.json().get("id")
        if not job_id:
            raise TranscribeError(f"No job id from endpoint {endpoint_id}: {resp.text[:300]}")
        logger.info("submitted job %s to endpoint %s", job_id, endpoint_id)

        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            status_resp = self.session.get(
                f"{RUNPOD_API_BASE}/{endpoint_id}/status/{job_id}", timeout=30
            )
            status_resp.raise_for_status()
            data = status_resp.json()
            status = data.get("status")
            if status == "COMPLETED":
                return data.get("output") or {}
            if status in ("FAILED", "CANCELLED", "TIMED_OUT"):
                raise TranscribeError(
                    f"endpoint {endpoint_id} job {job_id} {status}: "
                    f"{str(data.get('error') or '')[:300]}"
                )
            time.sleep(poll_interval_s)

        try:
            self.session.post(f"{RUNPOD_API_BASE}/{endpoint_id}/cancel/{job_id}", timeout=15)
        except Exception:
            pass
        raise TranscribeError(f"endpoint {endpoint_id} job {job_id} timed out after {timeout_s}s")


def transcribe_endpoint(
    audio_url: str,
    language: str = "en",
    endpoint_id: Optional[str] = None,
    project_id: Optional[str] = None,
    frame_id: Optional[str] = None,
    client: Optional[RunpodClient] = None,
    timeout_s: int = 900,
) -> Dict[str, Any]:
    """Call Flux-TTS-S2T `transcribe` mode with word timestamps."""
    endpoint_id = endpoint_id or os.environ.get("SRT_ENDPOINT_ID", "")
    if not endpoint_id:
        raise TranscribeError("SRT_ENDPOINT_ID is not set")
    client = client or RunpodClient()

    payload: Dict[str, Any] = {
        "mode": "transcribe",
        "audio_url": audio_url,
        "task": "transcribe",
        "return_timestamps": "word",
    }
    if language:
        payload["language"] = language
    if project_id:
        payload["project_id"] = project_id
    if frame_id:
        payload["frame_id"] = frame_id

    output = client.run(endpoint_id, payload, timeout_s=timeout_s)

    srt_content: Optional[str] = None
    srt_value = output.get("srt")
    if isinstance(srt_value, str) and srt_value.strip():
        if srt_value.startswith(("http://", "https://")):
            try:
                srt_resp = requests.get(srt_value, timeout=30)
                if srt_resp.ok:
                    # See handler.py's _fetch_text: requests defaults to
                    # Latin-1 without a charset in Content-Type, mangling
                    # non-ASCII (e.g. Hindi) SRT text. Our SRT output is UTF-8.
                    srt_resp.encoding = "utf-8"
                    srt_content = srt_resp.text
            except Exception as exc:
                logger.warning("failed to fetch srt from %s: %s", srt_value[:120], exc)
        else:
            srt_content = srt_value

    return {
        "text": str(output.get("text") or ""),
        "words": words_from_chunks(output.get("chunks") or []),
        "srt_content": srt_content,
    }


def transcribe_local(wav_path: str, language: str = "en") -> Dict[str, Any]:
    """Local faster-whisper fallback (only when baked into the image)."""
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError as exc:
        raise TranscribeError(
            "faster-whisper is not installed — rebuild with ENABLE_LOCAL_WHISPER=1 "
            "or use srt_source: \"endpoint\""
        ) from exc

    model_size = os.environ.get("WHISPER_MODEL", "small")
    device = "cuda" if os.environ.get("WHISPER_DEVICE", "cpu") == "cuda" else "cpu"
    logger.info("loading faster-whisper %s on %s", model_size, device)
    model = WhisperModel(model_size, device=device, compute_type="float16" if device == "cuda" else "int8")

    segments_iter, _info = model.transcribe(
        wav_path,
        language=language or None,
        word_timestamps=True,
        vad_filter=True,
    )
    words = []
    texts = []
    for seg in segments_iter:
        texts.append(seg.text.strip())
        for word in seg.words or []:
            words.append({
                "text": word.word.strip(),
                "start_ms": int(round(word.start * 1000)),
                "end_ms": int(round(word.end * 1000)),
            })
    return {"text": " ".join(texts), "words": words, "srt_content": None}
