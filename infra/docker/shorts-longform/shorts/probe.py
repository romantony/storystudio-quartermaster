"""Video probing and download helpers (port of E2E-shorts-validate-and-probe)."""

import json
import logging
import subprocess
from pathlib import Path

import requests

logger = logging.getLogger(__name__)

FFPROBE_TIMEOUT = 60
DOWNLOAD_TIMEOUT = 600
DOWNLOAD_CHUNK = 8 * 1024 * 1024


class ProbeError(Exception):
    pass


def check_url_reachable(url: str) -> bool:
    """GET with Range: bytes=0-0 (presigned URLs are often signed for GET only)."""
    if not url:
        return False
    try:
        resp = requests.get(
            url,
            headers={"Range": "bytes=0-0", "User-Agent": "StoryStudio-Shorts/1.0"},
            timeout=15,
            stream=True,
        )
        ok = 200 <= resp.status_code < 400
        resp.close()
        return ok
    except Exception as exc:
        logger.warning("reachability check failed for %s: %s", url[:120], exc)
        return False


def download(url: str, dest: Path) -> Path:
    """Stream a remote file to disk."""
    resp = requests.get(
        url,
        stream=True,
        timeout=DOWNLOAD_TIMEOUT,
        headers={"User-Agent": "StoryStudio-Shorts/1.0"},
    )
    if resp.status_code >= 400:
        raise ProbeError(f"Download failed ({resp.status_code}): {url[:200]}")
    with dest.open("wb") as fh:
        for chunk in resp.iter_content(chunk_size=DOWNLOAD_CHUNK):
            if chunk:
                fh.write(chunk)
    size_mb = dest.stat().st_size / (1024 * 1024)
    logger.info("downloaded %.1f MB -> %s", size_mb, dest)
    return dest


def _run_ffprobe(target: str) -> dict:
    cmd = [
        "ffprobe", "-v", "quiet",
        "-print_format", "json",
        "-show_streams", "-show_format",
        target,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=FFPROBE_TIMEOUT)
    except subprocess.TimeoutExpired as exc:
        raise ProbeError(f"ffprobe timed out after {FFPROBE_TIMEOUT}s") from exc
    if result.returncode != 0:
        raise ProbeError(f"ffprobe exited {result.returncode}: {(result.stderr or '')[:500]}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ProbeError(f"ffprobe output is not JSON: {exc}") from exc


def probe_video(target) -> dict:
    """Return normalised video info for a local path or URL."""
    data = _run_ffprobe(str(target))
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    fmt = data.get("format", {})

    try:
        duration = float(fmt.get("duration") or (video or {}).get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0.0

    fps = 0.0
    fps_raw = (video or {}).get("r_frame_rate") or (video or {}).get("avg_frame_rate", "0/1")
    try:
        num, den = fps_raw.split("/")
        if float(den) > 0:
            fps = round(float(num) / float(den), 3)
    except Exception:
        fps = 0.0

    rotation = 0
    for sd in (video or {}).get("side_data_list", []):
        if sd.get("side_data_type") == "Display Matrix":
            try:
                rotation = int(sd.get("rotation", 0))
            except (TypeError, ValueError):
                rotation = 0
    if rotation == 0:
        try:
            rotation = int((video or {}).get("tags", {}).get("rotate", 0))
        except (TypeError, ValueError):
            rotation = 0

    return {
        "duration": round(duration, 3),
        "duration_ms": int(duration * 1000),
        "width": int((video or {}).get("width", 0)),
        "height": int((video or {}).get("height", 0)),
        "fps": fps,
        "codec": str((video or {}).get("codec_name", "unknown")),
        "has_audio": audio is not None,
        "audio_codec": str(audio.get("codec_name", "")) if audio else None,
        "rotation": rotation,
    }


def probe_duration(path) -> float:
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=FFPROBE_TIMEOUT)
    if result.returncode != 0:
        return 0.0
    try:
        return float(result.stdout.strip())
    except (TypeError, ValueError):
        return 0.0


def probe_dimensions(path) -> tuple:
    cmd = [
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height",
        "-of", "csv=s=x:p=0",
        str(path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=FFPROBE_TIMEOUT)
    if result.returncode == 0:
        parts = result.stdout.strip().split("x")
        if len(parts) == 2:
            try:
                return int(parts[0]), int(parts[1])
            except ValueError:
                pass
    logger.warning("could not probe dimensions of %s, assuming 1080x1920", path)
    return 1080, 1920


def has_audio_stream(path) -> bool:
    cmd = [
        "ffprobe", "-v", "error",
        "-select_streams", "a",
        "-show_entries", "stream=index",
        "-of", "csv=p=0",
        str(path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=FFPROBE_TIMEOUT)
    return result.returncode == 0 and bool(result.stdout.strip())
