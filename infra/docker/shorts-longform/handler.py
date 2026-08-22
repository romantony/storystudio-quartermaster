"""shorts-longform RunPod serverless worker.

One job = one long-form (concat) video -> N finished shorts:
  probe -> segment -> per short: trim -> audio extract -> SRT (Flux-TTS-S2T
  transcribe mode or local faster-whisper) -> styled karaoke ASS -> single
  NVENC encode (9:16 convert @1080x1920 + caption burn) -> title/end slides
  -> BGM mix -> R2 upload.

Transcript-first mode (recommended): pass ``srt_url`` (the Step Function's
full-video SRT) and captions are sliced from it per clip — no per-short
transcription round trips — with frame-accurate cuts taken during the encode.
Add ``segments_source: "ai"`` to have Claude pick scored, sentence-aligned
highlight clips (title + hook overlay + virality scores) from that SRT;
requires ANTHROPIC_API_KEY, falls back to the duration split on any failure.

See RUNPOD-SHORTS-WORKER.md for the full design and API contract.
"""

import json
import logging
import os
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any, Dict, Optional

import boto3
import requests

from shorts import bgm as bgm_mod
from shorts import captions as cap_mod
from shorts import highlights as hl_mod
from shorts import probe as probe_mod
from shorts import render as render_mod
from shorts import segments as seg_mod
from shorts import transcribe as stt_mod
from shorts import upscale as up_mod
from shorts.storage import R2Storage

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("shorts-longform")

DEFAULT_BGM_VOLUME = 0.18
DEFAULT_LANGUAGE = "en"


def _progress(message: str) -> None:
    logger.info("[progress] %s", message)


def _aspect_ratio_label(width: int, height: int) -> str:
    known = {(1080, 1920): "9:16", (1920, 1080): "16:9", (1080, 1080): "1:1",
             (1440, 1080): "4:3", (1080, 1440): "3:4"}
    return known.get((width, height), f"{width}:{height}")


def _fetch_text(url: str) -> str:
    resp = requests.get(url, timeout=60,
                        headers={"User-Agent": "StoryStudio-Shorts/1.0"})
    resp.raise_for_status()
    # requests falls back to Latin-1 when the response has no charset in its
    # Content-Type (the norm for SRT/ASS served from S3), mangling any
    # non-ASCII text (e.g. Hindi) into mojibake. Our own SRT/ASS output is
    # always UTF-8, so decode as such regardless of what the header says.
    resp.encoding = "utf-8"
    return resp.text


def _fetch_srt_cues(srt_url: str) -> list:
    cues = cap_mod.parse_srt(_fetch_text(srt_url))
    if not cues:
        raise ValueError("srt_url returned no parseable cues")
    return cues


def _upscale_settings(inp: Dict[str, Any]) -> tuple:
    """Return (method, target_h). method in {"none", "lanczos", "realesrgan"}."""
    method = str(inp.get("upscale") or "none").strip().lower()
    if method in ("", "false", "none", "off"):
        method = "none"
    elif method in ("true", "esrgan", "realesrgan", "real-esrgan"):
        method = "realesrgan"
    elif method != "lanczos":
        logger.warning("unknown upscale method %r — using lanczos", method)
        method = "lanczos"
    raw_target = str(inp.get("upscale_target") or 1080).lower().rstrip("p")
    target_h = 720 if raw_target == "720" else 1080
    return method, target_h


def _slides_enabled(inp: Dict[str, Any], segment: Dict[str, Any]) -> bool:
    """Explicit ``slides`` wins; otherwise slides are skipped for AI clips
    (which open on a hook overlay instead of a black title slide)."""
    if "slides" in inp:
        return bool(inp["slides"])
    return segment.get("hook_line") is None


def _transcribe_short(
    inp: Dict[str, Any],
    clip_path: Path,
    workdir: Path,
    storage: R2Storage,
    project_id: str,
    part_number: int,
    rp_client: Optional[stt_mod.RunpodClient],
) -> Dict[str, Any]:
    """Extract audio and transcribe. Returns {text, words, srt_content, wav_url}."""
    wav_path = workdir / f"part{part_number}_audio.wav"
    render_mod.extract_audio_wav(clip_path, wav_path)

    language = str(inp.get("language") or DEFAULT_LANGUAGE).split("-")[0].lower()
    srt_source = str(inp.get("srt_source") or "endpoint").lower()

    if srt_source == "local":
        result = stt_mod.transcribe_local(str(wav_path), language=language)
        result["wav_url"] = None
        return result

    wav_key = storage.voice_key(project_id, f"part{part_number}_short_audio_16k.wav")
    wav_url = storage.upload_file(wav_path, wav_key, content_type="audio/wav")
    result = stt_mod.transcribe_endpoint(
        audio_url=wav_url,
        language=language,
        endpoint_id=inp.get("srt_endpoint_id") or os.environ.get("SRT_ENDPOINT_ID"),
        project_id=project_id,
        frame_id=f"part{part_number}",
        client=rp_client,
    )
    result["wav_url"] = wav_url
    return result


def _process_short(
    inp: Dict[str, Any],
    segment: Dict[str, Any],
    source_path: Path,
    workdir: Path,
    storage: R2Storage,
    bgm_info: Optional[Dict[str, Any]],
    rp_client: Optional[stt_mod.RunpodClient],
    index: int,
    total: int,
    srt_cues: Optional[list] = None,
    video_has_audio: bool = True,
) -> Dict[str, Any]:
    project_id = str(inp["project_id"])
    n = segment["part_number"]
    title = segment["title"]

    target_w = int(inp.get("target_width") or 1080)
    target_h = int(inp.get("target_height") or 1920)
    source_ar = str(inp.get("source_aspect_ratio") or "16:9")
    target_ar = str(inp.get("target_aspect_ratio") or _aspect_ratio_label(target_w, target_h))
    render_style = render_mod.normalize_render_style(inp.get("render_style"))
    fg_y_offset = int(inp.get("fg_y_offset", render_mod.DEFAULT_FG_Y_OFFSET))
    captions_enabled = bool(inp.get("captions", True))
    slides_enabled = _slides_enabled(inp, segment)
    hook_text = segment.get("hook_line") if bool(inp.get("hook", True)) else None
    bgm_volume = float(inp.get("bgm_volume") or DEFAULT_BGM_VOLUME)
    caption_config = {**cap_mod.DEFAULT_CAPTION_CONFIG, **(inp.get("caption_config") or {})}
    transcript_mode = srt_cues is not None

    result: Dict[str, Any] = {
        "part_number": n,
        "title": title,
        "start_s": segment["start_s"],
        "end_s": segment["end_s"],
        "video": None,
        "audio": None,
        "srt": None,
        "captions_applied": False,
        "bgm_applied": False,
        "status": "completed",
    }
    for key in ("hook_line", "keywords", "virality", "reason"):
        if segment.get(key) is not None:
            result[key] = segment[key]

    # a. Clip source: transcript mode cuts frame-accurately during the main
    # encode (stream-copy trims snap to keyframes — seconds off on sparse-GOP
    # masters, which would desync the sliced captions).
    raw_clip: Optional[Path] = None
    if transcript_mode:
        clip_has_audio = video_has_audio
    else:
        _progress(f"short {index}/{total}: trimming")
        raw_clip = workdir / f"part{n}_raw.mp4"
        render_mod.trim(source_path, raw_clip, segment["start_s"], segment["end_s"])
        clip_has_audio = probe_mod.has_audio_stream(raw_clip)

    # b. Archival audio -----------------------------------------------------
    if clip_has_audio:
        m4a_path = workdir / f"part{n}_audio.m4a"
        if transcript_mode:
            render_mod.extract_audio_m4a(source_path, m4a_path,
                                         segment["start_s"], segment["end_s"])
        else:
            render_mod.extract_audio_m4a(raw_clip, m4a_path)
        result["audio"] = storage.upload_file(
            m4a_path, storage.voice_key(project_id, f"part{n}_short_audio.m4a"),
            content_type="audio/mp4",
        )

    # c/d. Captions: caller-supplied ASS wins; else slice the full-video SRT
    # or transcribe per short. A custom ASS (job-level ``ass_url`` or
    # per-segment ``segments[].ass_url``) is burned as-is — its own styling
    # and timing are authoritative, so no hook overlay is injected.
    ass_path: Optional[Path] = None
    custom_ass_url = str(segment.get("ass_url") or inp.get("ass_url") or "").strip()
    if custom_ass_url:
        try:
            ass_path = workdir / f"part{n}_custom.ass"
            ass_path.write_text(_fetch_text(custom_ass_url), encoding="utf-8")
            result["captions_applied"] = True
            result["caption_source"] = "custom_ass"
        except Exception as exc:
            logger.warning("part %d: ass_url fetch failed (%s) — using generated captions",
                           n, exc)
            ass_path = None

    cues = []
    if ass_path is None and captions_enabled and clip_has_audio:
        if transcript_mode:
            cues = cap_mod.regroup_karaoke(
                cap_mod.slice_cues(srt_cues, segment["start_s"], segment["end_s"]),
                int(caption_config.get("wordsPerGroup", 3)),
            )
        else:
            _progress(f"short {index}/{total}: transcribing")
            try:
                stt = _transcribe_short(inp, raw_clip, workdir, storage, project_id, n, rp_client)
                if stt["words"]:
                    cues = cap_mod.cues_from_words(
                        stt["words"], int(caption_config.get("wordsPerGroup", 3))
                    )
                elif stt.get("srt_content"):
                    cues = cap_mod.parse_srt(stt["srt_content"])
            except Exception as exc:
                # Captions are non-critical: ship the short without them.
                logger.warning("part %d: caption generation failed (%s) — continuing without", n, exc)
                result["caption_error"] = str(exc)[:300]
        if not cues and not result.get("caption_error"):
            logger.warning("part %d: no caption cues for this window", n)
    elif ass_path is None and captions_enabled and not clip_has_audio:
        logger.warning("part %d: clip has no audio stream — skipping captions", n)

    if ass_path is None and (cues or hook_text):
        ass_path = workdir / f"part{n}.ass"
        ass_path.write_text(
            cap_mod.build_ass(cues, caption_config, target_w, target_h,
                              hook_text=hook_text, keywords=segment.get("keywords")),
            encoding="utf-8",
        )
    if cues:
        srt_text = cap_mod.build_srt(cues, all_caps=bool(caption_config.get("allCaps", True)))
        result["srt"] = storage.upload_text(
            srt_text, storage.txt_key(project_id, f"part{n}_short.srt")
        )
        result["captions_applied"] = True

    # e. Optional Real-ESRGAN upscale pre-pass (before captions, so text
    # stays vector-crisp), then the single main encode: convert + burn.
    upscale_method, upscale_target = _upscale_settings(inp)
    sr_clip: Optional[Path] = None
    if upscale_method == "realesrgan":
        _progress(f"short {index}/{total}: upscaling to {upscale_target}p")
        try:
            if transcript_mode:
                pre_clip = workdir / f"part{n}_pre.mp4"
                render_mod.encode_main(source_path, pre_clip, "null", False,
                                       start_s=segment["start_s"], end_s=segment["end_s"])
            else:
                pre_clip = raw_clip
            sr_candidate = workdir / f"part{n}_sr.mp4"
            if up_mod.upscale_video(pre_clip, sr_candidate, upscale_target):
                sr_clip = sr_candidate
                result["upscale"] = f"realesrgan_{upscale_target}p"
            else:
                result["upscale"] = "skipped_source_hires"
        except Exception as exc:
            # Non-fatal: ship the short with plain lanczos scaling instead.
            logger.warning("part %d: Real-ESRGAN upscale failed (%s) — "
                           "falling back to lanczos", n, exc)
            result["upscale"] = "lanczos_fallback"
            result["upscale_error"] = str(exc)
    elif upscale_method == "lanczos":
        result["upscale"] = "lanczos"

    _progress(f"short {index}/{total}: encoding {render_style} {target_w}x{target_h}")
    main_clip = workdir / f"part{n}_main.mp4"
    filter_value, use_complex = render_mod.build_convert_filter(
        source_ar, target_ar, target_w, target_h, render_style, fg_y_offset, ass_path,
        sharpen=(upscale_method != "none"),
    )
    if sr_clip is not None:
        render_mod.encode_main(sr_clip, main_clip, filter_value, use_complex)
    elif transcript_mode:
        render_mod.encode_main(source_path, main_clip, filter_value, use_complex,
                               start_s=segment["start_s"], end_s=segment["end_s"])
    else:
        render_mod.encode_main(raw_clip, main_clip, filter_value, use_complex)

    # f. Slides + concat ------------------------------------------------------
    staged = main_clip
    if slides_enabled:
        _progress(f"short {index}/{total}: adding title/end slides")
        with_slides = workdir / f"part{n}_slides.mp4"
        render_mod.concat_with_slides(
            main_clip, with_slides, n, title, str(inp.get("project_title") or "")
        )
        staged = with_slides

    # g. BGM ------------------------------------------------------------------
    if bgm_info:
        _progress(f"short {index}/{total}: mixing BGM")
        final_path = workdir / f"part{n}_final.mp4"
        render_mod.mix_bgm(staged, bgm_info["path"], final_path, bgm_volume)
        result["bgm_applied"] = True
    else:
        final_path = staged

    # h. Upload ----------------------------------------------------------------
    _progress(f"short {index}/{total}: uploading")
    result["video"] = storage.upload_file(
        final_path, storage.video_key(project_id, f"part{n}_short.mp4"),
        content_type="video/mp4",
    )
    result["duration_s"] = round(probe_mod.probe_duration(final_path), 3)

    # Free per-part intermediates early (long videos x many parts).
    for path in workdir.glob(f"part{n}_*"):
        if path != final_path:
            try:
                path.unlink()
            except OSError:
                pass

    return result


def run_job(inp: Dict[str, Any]) -> Dict[str, Any]:
    """Core shorts-generation logic — `inp` is the flat job input (an ECS
    task's PAYLOAD_S3_KEY payload, née RunPod's job["input"])."""
    started = time.monotonic()

    mode = str(inp.get("mode") or "shorts")
    if mode != "shorts":
        return {"error": f"Unsupported mode: {mode!r} (this worker only supports 'shorts')"}

    project_id = str(inp.get("project_id") or "").strip()
    video_url = str(inp.get("video_url") or "").strip()
    if not project_id:
        return {"error": "project_id is required"}
    if not video_url:
        return {"error": "video_url is required"}

    try:
        storage = R2Storage()
    except Exception as exc:
        return {"error": f"storage init failed: {exc}"}

    srt_url = str(inp.get("srt_url") or "").strip()

    rp_client: Optional[stt_mod.RunpodClient] = None
    needs_endpoint_calls = (
        (bool(inp.get("captions", True)) and not srt_url
         and str(inp.get("srt_source") or "endpoint") == "endpoint")
        or (inp.get("bgm_prompt") and not inp.get("bgm_url"))
    )
    if needs_endpoint_calls:
        try:
            rp_client = stt_mod.RunpodClient()
        except Exception as exc:
            return {"error": str(exc)}

    with tempfile.TemporaryDirectory(prefix="shorts-") as tmp:
        workdir = Path(tmp)

        # 1. Probe + download ------------------------------------------------
        _progress("validating source video")
        if not probe_mod.check_url_reachable(video_url):
            return {"error": f"video_url is not reachable: {video_url[:200]}"}
        _progress("downloading source video")
        source_path = workdir / "source.mp4"
        try:
            probe_mod.download(video_url, source_path)
            video_info = probe_mod.probe_video(source_path)
        except Exception as exc:
            return {"error": f"source download/probe failed: {exc}"}
        if video_info["duration"] <= 0 or video_info["width"] <= 0:
            return {"error": f"source video unusable: {video_info}"}

        # 2. Full-video SRT (transcript-first mode) ----------------------------
        srt_cues = None
        if srt_url:
            _progress("fetching full-video SRT")
            try:
                srt_cues = _fetch_srt_cues(srt_url)
                logger.info("srt_url: %d cues", len(srt_cues))
            except Exception as exc:
                # Non-fatal: fall back to per-short transcription.
                logger.warning("srt_url fetch failed (%s) — falling back to "
                               "per-short transcription", exc)

        # 3. Segments: AI highlight selection, else explicit/markers/duration ---
        segments = None
        strategy = None
        if str(inp.get("segments_source") or "").lower() == "ai":
            if srt_cues:
                _progress("selecting highlights (AI)")
                num_clips = inp.get("num_clips") or inp.get("num_shorts")
                try:
                    segments = hl_mod.select_highlights(
                        srt_cues,
                        max_clips=int(inp.get("max_clips") or seg_mod.default_num_shorts(video_info["duration"])),
                        min_clip_s=float(inp.get("min_clip_s") or hl_mod.DEFAULT_MIN_CLIP_S),
                        max_clip_s=float(inp.get("max_clip_s") or hl_mod.DEFAULT_MAX_CLIP_S),
                        exact_clips=int(num_clips) if num_clips else None,
                        project_title=str(inp.get("project_title") or ""),
                    )
                    for seg in segments:
                        seg["end_s"] = min(seg["end_s"], video_info["duration"])
                        seg["duration_s"] = round(seg["end_s"] - seg["start_s"], 3)
                    strategy = "ai"
                except Exception as exc:
                    logger.warning("AI highlight selection failed (%s) — "
                                   "falling back to duration split", exc)
            else:
                logger.warning("segments_source=ai requires a usable srt_url — "
                               "falling back to duration split")
        if segments is None:
            try:
                segments, strategy = seg_mod.resolve_segments(
                    inp.get("segments"),
                    inp.get("frames"),
                    inp.get("num_shorts"),
                    video_info["duration"],
                )
            except seg_mod.SegmentError as exc:
                return {"error": str(exc)}

        # 4. BGM (once per project) ---------------------------------------------
        bgm_info = None
        if inp.get("bgm_url") or inp.get("bgm_prompt"):
            _progress("resolving BGM")
            max_short = max(s["duration_s"] for s in segments)
            slide_pad = (
                render_mod.TITLE_SLIDE_SECONDS + render_mod.END_SLIDE_SECONDS
                if any(_slides_enabled(inp, s) for s in segments) else 0.0
            )
            try:
                bgm_info = bgm_mod.resolve_bgm(
                    inp.get("bgm_url"), inp.get("bgm_prompt"),
                    max_short + slide_pad, workdir,
                    project_id=project_id, client=rp_client,
                )
            except Exception as exc:
                # BGM is non-critical (Lambda parity: skip on download failure).
                logger.warning("BGM resolution failed (%s) — continuing without BGM", exc)

        # 5. Per-short loop (sequential, soft-fail per short) ---------------------
        shorts_results = []
        for i, segment in enumerate(segments, start=1):
            try:
                shorts_results.append(_process_short(
                    inp, segment, source_path, workdir, storage,
                    bgm_info, rp_client, i, len(segments),
                    srt_cues=srt_cues, video_has_audio=video_info["has_audio"],
                ))
            except Exception as exc:
                logger.error("part %s failed: %s\n%s",
                             segment["part_number"], exc, traceback.format_exc())
                shorts_results.append({
                    "part_number": segment["part_number"],
                    "title": segment["title"],
                    "start_s": segment["start_s"],
                    "end_s": segment["end_s"],
                    "video": None,
                    "status": "failed",
                    "error": str(exc)[:500],
                })

        completed = [s for s in shorts_results if s.get("status") == "completed"]
        failed = [s for s in shorts_results if s.get("status") == "failed"]

        # 6. BGM upload (generated) + output manifest ------------------------------
        bgm_url_out = None
        if bgm_info:
            if bgm_info["generated"]:
                try:
                    bgm_url_out = storage.upload_file(
                        bgm_info["path"], storage.bgm_key(project_id, "shorts_bgm.mp3"),
                        content_type="audio/mpeg",
                    )
                except Exception as exc:
                    logger.warning("generated BGM upload failed: %s", exc)
            else:
                bgm_url_out = bgm_info["url"]

        output: Dict[str, Any] = {
            "mode": "shorts",
            "project_id": project_id,
            "video_info": {
                "duration": video_info["duration"],
                "width": video_info["width"],
                "height": video_info["height"],
                "fps": video_info["fps"],
                "has_audio": video_info["has_audio"],
            },
            "segment_strategy": strategy,
            "total_shorts": len(shorts_results),
            "completed_shorts": len(completed),
            "failed_shorts": len(failed),
            "shorts": shorts_results,
            "bgm": bgm_url_out,
            "gen_time_s": round(time.monotonic() - started, 1),
        }

        try:
            output["manifest"] = storage.upload_text(
                json.dumps(output, indent=2),
                storage.txt_key(project_id, "shorts_manifest.json"),
                content_type="application/json",
            )
        except Exception as exc:
            logger.warning("manifest upload failed: %s", exc)
            output["manifest"] = None

        if not completed:
            errors = "; ".join(
                f"part{s['part_number']}: {s.get('error', 'unknown')}" for s in failed
            )
            return {"error": f"all {len(failed)} shorts failed — {errors}"[:1000], **output}

        return output


def _fetch_input() -> Dict[str, Any]:
    """Read this task's job input, written to S3 by the QM-upload-payload
    Lambda before ecs:runTask fired this container (PAYLOAD_S3_KEY) —
    ecs:runTask's ContainerOverrides has an 8192-byte limit that an inline
    JSON env var could exceed for a caller-supplied ``shortsOptions`` with
    e.g. many explicit ``segments[]``, so the SFN always uploads first
    (same workaround the qm-concat-and-trim ECS task uses)."""
    bucket = os.environ["PAYLOAD_BUCKET"]
    key = os.environ["PAYLOAD_S3_KEY"]
    s3 = boto3.client("s3")
    body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    return json.loads(body)


def _post_webhook(url: str, status: str, output: Dict[str, Any]) -> None:
    """POST the completion envelope to Convex's runpod-webhook endpoint —
    replaces what RunPod's serverless platform used to do automatically on
    job completion. Envelope shape ({status, output}) is unchanged so
    Convex's existing applyRunpodShortsWebhook parser needs no changes.
    Best-effort: nothing downstream can catch a failure here, the real work
    is already done or already failed."""
    try:
        requests.post(url, json={"status": status, "output": output}, timeout=30)
    except Exception:
        logger.exception("webhook POST failed: %s", url)


def main() -> None:
    inp = _fetch_input()
    webhook = str(inp.get("webhook") or "").strip()

    try:
        output = run_job(inp)
    except Exception as exc:
        logger.error("shorts job failed: %s\n%s", exc, traceback.format_exc())
        if webhook:
            _post_webhook(webhook, "FAILED", {"error": str(exc)[:500]})
        sys.exit(1)

    status = "FAILED" if output.get("error") else "COMPLETED"
    if webhook:
        _post_webhook(webhook, status, output)
    sys.exit(0 if status == "COMPLETED" else 1)


if __name__ == "__main__":
    main()
