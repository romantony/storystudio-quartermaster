"""Cloudflare R2 uploads following the storystudio/{video,voice,txt,bgm}/ convention.

Env vars (endpoint secrets — never hardcode credentials):
    R2_ENDPOINT           https://<account>.r2.cloudflarestorage.com
    R2_ACCESS_KEY_ID
    R2_SECRET_ACCESS_KEY
    R2_BUCKET             default: e2e-storystudio
    R2_PUBLIC_BASE        public base URL, e.g. https://pub-xxx.r2.dev
"""

import logging
import mimetypes
import os
from pathlib import Path
from typing import Optional

import boto3

logger = logging.getLogger(__name__)

PREFIX = "storystudio"


class StorageError(Exception):
    pass


class R2Storage:
    def __init__(self):
        endpoint = os.environ.get("R2_ENDPOINT", "")
        access_key = os.environ.get("R2_ACCESS_KEY_ID", "")
        secret_key = os.environ.get("R2_SECRET_ACCESS_KEY", "")
        self.bucket = os.environ.get("R2_BUCKET", "e2e-storystudio")
        self.public_base = os.environ.get("R2_PUBLIC_BASE", "").rstrip("/")

        missing = [name for name, val in [
            ("R2_ENDPOINT", endpoint),
            ("R2_ACCESS_KEY_ID", access_key),
            ("R2_SECRET_ACCESS_KEY", secret_key),
            ("R2_PUBLIC_BASE", self.public_base),
        ] if not val]
        if missing:
            raise StorageError(f"Missing R2 env vars: {', '.join(missing)}")

        self.client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name="auto",
        )

    # -- key builders (asset naming convention) -----------------------------

    @staticmethod
    def video_key(project_id: str, name: str) -> str:
        return f"{PREFIX}/video/{project_id}_{name}"

    @staticmethod
    def voice_key(project_id: str, name: str) -> str:
        return f"{PREFIX}/voice/{project_id}_{name}"

    @staticmethod
    def txt_key(project_id: str, name: str) -> str:
        return f"{PREFIX}/txt/{project_id}_{name}"

    @staticmethod
    def bgm_key(project_id: str, name: str) -> str:
        return f"{PREFIX}/bgm/{project_id}_{name}"

    # -- uploads -------------------------------------------------------------

    def public_url(self, key: str) -> str:
        return f"{self.public_base}/{key}"

    def upload_file(self, path, key: str, content_type: Optional[str] = None) -> str:
        path = Path(path)
        if content_type is None:
            content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        size_mb = path.stat().st_size / (1024 * 1024)
        self.client.upload_file(
            str(path), self.bucket, key,
            ExtraArgs={"ContentType": content_type},
        )
        url = self.public_url(key)
        logger.info("uploaded %.1f MB -> %s", size_mb, url)
        return url

    def upload_text(self, content: str, key: str, content_type: str = "text/plain") -> str:
        self.client.put_object(
            Bucket=self.bucket,
            Key=key,
            Body=content.encode("utf-8"),
            ContentType=content_type,
        )
        url = self.public_url(key)
        logger.info("uploaded text (%d bytes) -> %s", len(content), url)
        return url
