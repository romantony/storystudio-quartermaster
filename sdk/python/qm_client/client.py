"""
Quartermaster Python client SDK.

Usage (broker mode — wraps existing ModelsLab calls)::

    from qm_client import QMClient

    client = QMClient(base_url="https://your-qm-host.example.com",
                      gateway_key="your-static-key")

    lease = client.acquire(tenant="remotion:user_abc", lane="rest",
                           priority="P2", endpoint="sfx")
    try:
        result = call_modelslab(payload)   # existing logic unchanged
        return result
    finally:
        client.release(lease_id=lease.lease_id, lane="rest")

Usage (job queue mode — submit and poll)::

    job_id = client.submit(job)
    status = client.await_complete(request_id, timeout=300)
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional

import httpx

Lane = Literal["video", "rest", "none"]
Priority = Literal["P0", "P1", "P2"]
JobStatusStr = Literal[
    "QUEUED", "PROCESSING", "COMPLETE", "COMPLETE_WITH_FALLBACKS", "FAILED", "DEAD"
]


class QMError(Exception):
    def __init__(self, message: str, status_code: int = 0, body: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.body = body


@dataclass
class AcquireResponse:
    granted: bool
    lease_id: Optional[str] = None
    retry_after_ms: Optional[int] = None


@dataclass
class JobStatus:
    request_id: str
    status: JobStatusStr
    asset_key: Optional[str] = None
    degraded: Optional[List[Dict[str, str]]] = None
    error_reason: Optional[str] = None
    attempts: Optional[int] = None


@dataclass
class CanonicalJob:
    asset_type: str
    tier: str
    operation: str
    product: str
    queue: Literal["background", "foreground"]
    request_id: str
    prompt: str
    s3_target: str
    init_image_urls: List[str] = field(default_factory=list)
    audio_url: Optional[str] = None
    depends_on: Optional[List[str]] = None
    params: Dict[str, Any] = field(default_factory=dict)
    manifest_ref: Optional[str] = None
    platform: Optional[str] = None
    project_id: Optional[str] = None
    user_id: Optional[str] = None
    priority: Priority = "P2"
    lane: Optional[Lane] = None


class QMClient:
    """
    Thin HTTP client for the Quartermaster API.
    Provides both broker mode (acquire/release/heartbeat) and
    job queue mode (submit/await_complete).
    """

    def __init__(
        self,
        base_url: str,
        gateway_key: str,
        timeout: float = 10.0,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._headers = {
            "Content-Type": "application/json",
            "X-Gateway-Key": gateway_key,
        }
        self._timeout = timeout

    # ─── Broker mode ─────────────────────────────────────────────────────────

    def acquire(
        self,
        *,
        tenant: str,
        lane: Lane,
        priority: Priority = "P2",
        endpoint: str = "rest",
        est_duration_ms: int = 60_000,
        lease_id: Optional[str] = None,
    ) -> AcquireResponse:
        """
        Acquire a generation slot from the central semaphore.
        Blocks until granted or raises QMError on timeout.
        """
        body: Dict[str, Any] = {
            "tenant": tenant,
            "lane": lane,
            "priority": priority,
            "endpoint": endpoint,
            "estDurationMs": est_duration_ms,
        }
        if lease_id:
            body["leaseId"] = lease_id

        resp = self._post("/acquire", body)
        return AcquireResponse(
            granted=resp.get("granted", False),
            lease_id=resp.get("leaseId"),
            retry_after_ms=resp.get("retryAfterMs"),
        )

    def acquire_with_retry(
        self,
        *,
        tenant: str,
        lane: Lane,
        priority: Priority = "P2",
        endpoint: str = "rest",
        est_duration_ms: int = 60_000,
        max_wait_s: float = 180.0,
    ) -> AcquireResponse:
        """
        Like acquire() but retries until a slot is granted or max_wait_s is exceeded.
        """
        deadline = time.monotonic() + max_wait_s
        while True:
            result = self.acquire(
                tenant=tenant,
                lane=lane,
                priority=priority,
                endpoint=endpoint,
                est_duration_ms=est_duration_ms,
            )
            if result.granted:
                return result
            wait_s = (result.retry_after_ms or 5_000) / 1000.0
            if time.monotonic() + wait_s > deadline:
                raise QMError(f"Could not acquire slot within {max_wait_s}s")
            time.sleep(wait_s)

    def release(
        self,
        *,
        lease_id: str,
        lane: Lane,
        outcome: Literal["success", "failure", "timeout"] = "success",
        slot_ms: Optional[int] = None,
        platform: Optional[str] = None,
        project_id: Optional[str] = None,
        request_id: Optional[str] = None,
        model: Optional[str] = None,
        provider: Optional[str] = None,
        endpoint: Optional[str] = None,
    ) -> bool:
        """Release a previously acquired slot. Always call in a finally block."""
        body: Dict[str, Any] = {
            "leaseId": lease_id,
            "lane": lane,
            "outcome": outcome,
        }
        if slot_ms is not None:
            body["slotMs"] = slot_ms
        for k, v in [
            ("platform", platform), ("projectId", project_id), ("requestId", request_id),
            ("model", model), ("provider", provider), ("endpoint", endpoint),
        ]:
            if v is not None:
                body[k] = v

        resp = self._post("/release", body)
        return bool(resp.get("released", False))

    def heartbeat(self, *, lease_id: str, lane: Lane) -> bool:
        """Extend the lease TTL. Call periodically during long-running poll loops."""
        resp = self._post("/heartbeat", {"leaseId": lease_id, "lane": lane})
        return bool(resp.get("extended", False))

    # ─── Job queue mode ───────────────────────────────────────────────────────

    def submit(self, job: CanonicalJob) -> str:
        """
        Submit a generation job to the queue.
        Returns the jobId. Does not wait for completion.
        """
        body: Dict[str, Any] = {
            "assetType": job.asset_type,
            "tier": job.tier,
            "operation": job.operation,
            "product": job.product,
            "queue": job.queue,
            "requestId": job.request_id,
            "prompt": job.prompt,
            "s3Target": job.s3_target,
            "params": job.params,
            "priority": job.priority,
        }
        if job.init_image_urls:
            body["initImageUrls"] = job.init_image_urls
        if job.audio_url:
            body["audioUrl"] = job.audio_url
        if job.depends_on:
            body["dependsOn"] = job.depends_on
        if job.manifest_ref:
            body["manifestRef"] = job.manifest_ref
        if job.platform:
            body["platform"] = job.platform
        if job.project_id:
            body["projectId"] = job.project_id
        if job.user_id:
            body["userId"] = job.user_id
        if job.lane:
            body["lane"] = job.lane

        resp = self._post("/jobs", body)
        return str(resp.get("jobId", ""))

    def get_status(self, request_id: str) -> JobStatus:
        """Poll the status of a submitted job."""
        resp = self._get(f"/jobs/{request_id}")
        return JobStatus(
            request_id=request_id,
            status=resp.get("status", "QUEUED"),
            asset_key=resp.get("assetKey"),
            degraded=resp.get("degraded"),
            error_reason=resp.get("errorReason"),
            attempts=resp.get("attempts"),
        )

    def await_complete(
        self,
        request_id: str,
        poll_interval: float = 5.0,
        timeout: float = 300.0,
    ) -> JobStatus:
        """
        Poll until the job reaches a terminal status.
        Raises QMError on timeout or DEAD status.
        """
        terminal = {"COMPLETE", "COMPLETE_WITH_FALLBACKS", "DEAD"}
        deadline = time.monotonic() + timeout
        while True:
            status = self.get_status(request_id)
            if status.status in terminal:
                if status.status == "DEAD":
                    raise QMError(
                        f"Job {request_id} died: {status.error_reason}",
                        body=status,
                    )
                return status
            if time.monotonic() > deadline:
                raise QMError(f"Timed out waiting for job {request_id} after {timeout}s")
            time.sleep(poll_interval)

    # ─── HTTP helpers ─────────────────────────────────────────────────────────

    def _post(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        with httpx.Client(timeout=self._timeout) as c:
            resp = c.post(f"{self._base}{path}", json=body, headers=self._headers)
        return self._handle(resp)

    def _get(self, path: str) -> Dict[str, Any]:
        with httpx.Client(timeout=self._timeout) as c:
            resp = c.get(f"{self._base}{path}", headers=self._headers)
        return self._handle(resp)

    @staticmethod
    def _handle(resp: httpx.Response) -> Dict[str, Any]:
        try:
            data = resp.json()
        except Exception:
            data = {}
        if not resp.is_success:
            raise QMError(
                f"QM API error {resp.status_code}: {data.get('error', resp.text)}",
                status_code=resp.status_code,
                body=data,
            )
        return data
