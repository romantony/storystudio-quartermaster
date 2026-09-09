"""Input download (any public URL) + output upload to Cloudflare R2.

R2 speaks the S3 API, so boto3 with a custom endpoint. Inputs arrive as already-
public URLs (same as the AWS handlers' `download()`), so reads are plain HTTP —
no credentials needed to fetch. Only writes touch R2.

Env:
  R2_ENDPOINT           https://<accountid>.r2.cloudflarestorage.com
  R2_BUCKET             bucket name
  R2_ACCESS_KEY_ID      / R2_SECRET_ACCESS_KEY
  R2_PUBLIC_BASE        public origin for reads, e.g. https://media.ai-storystudio.com
                        (r2.dev domain or a custom domain bound to the bucket)
"""
from __future__ import annotations

import os
import shutil
import urllib.request
from functools import lru_cache

R2_ENDPOINT = os.environ.get("R2_ENDPOINT", "")
R2_BUCKET = os.environ.get("R2_BUCKET", "")
R2_PUBLIC_BASE = os.environ.get("R2_PUBLIC_BASE", "").rstrip("/")
_DOWNLOAD_TIMEOUT = float(os.environ.get("MEDIA_DOWNLOAD_TIMEOUT_S", "120"))


@lru_cache(maxsize=1)
def _client():
    import boto3  # deferred so arg-builder tests need no boto3

    return boto3.client(
        "s3",
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def download(url: str, dest: str, _redirects: int = 0) -> str:
    """Fetch `url` to `dest`. Follows redirects (urllib does by default) and
    fails loudly on non-200 — the caller must not proceed with a truncated
    input (this is the failure that lost 103/122 shots on 2026-08-17)."""
    if _redirects > 5:
        raise RuntimeError(f"too many redirects fetching {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "qm-media/1"})
    with urllib.request.urlopen(req, timeout=_DOWNLOAD_TIMEOUT) as resp:  # noqa: S310 (URL is a job input)
        if resp.status != 200:
            raise RuntimeError(f"download {url} -> HTTP {resp.status}")
        with open(dest, "wb") as f:
            shutil.copyfileobj(resp, f)
    if os.path.getsize(dest) == 0:
        raise RuntimeError(f"download {url} produced a 0-byte file")
    return dest


_CONTENT_TYPES = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".srt": "application/x-subrip",
    ".ass": "text/x-ssa",
}


def upload(local_path: str, key: str, content_type: str | None = None) -> str:
    key = key.lstrip("/")
    if content_type is None:
        _, ext = os.path.splitext(key)
        content_type = _CONTENT_TYPES.get(ext.lower(), "application/octet-stream")
    with open(local_path, "rb") as f:
        _client().put_object(Bucket=R2_BUCKET, Key=key, Body=f, ContentType=content_type)
    if not R2_PUBLIC_BASE:
        raise RuntimeError("R2_PUBLIC_BASE is not set — cannot return a fetchable URL")
    return f"{R2_PUBLIC_BASE}/{key}"
