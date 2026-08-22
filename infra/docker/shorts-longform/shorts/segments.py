"""Segment boundary calculation (port of E2E-calculate-segments).

Resolution priority:
  1. Explicit ``segments[]`` from the request (used as-is, normalised).
  2. ``frames[]`` metadata — marker strategy (segmentStart/segmentEnd flags),
     falling back to frame-count chunking (<9 frames -> 1, <18 -> 3, else 4).
  3. Duration split into ``num_shorts`` equal parts.
"""

import logging
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

DEFAULT_FRAME_DURATION = 5.0
MIN_SEGMENT_SECONDS = 1.0

# Source-duration brackets for the default clip count when the caller
# doesn't pass num_shorts/num_clips/max_clips: short sources yield fewer,
# less-repetitive shorts; anything 5min+ gets the same cap.
SHORT_DURATION_THRESHOLD_S = 300.0
DEFAULT_NUM_SHORTS_SHORT = 3
DEFAULT_NUM_SHORTS_LONG = 5


def default_num_shorts(duration_s: float) -> int:
    return DEFAULT_NUM_SHORTS_SHORT if duration_s < SHORT_DURATION_THRESHOLD_S else DEFAULT_NUM_SHORTS_LONG


class SegmentError(Exception):
    pass


def _to_number(value: Any, default: float) -> float:
    try:
        num = float(value)
        return num if num > 0 else default
    except (TypeError, ValueError):
        return default


def _frame_number(frame: Dict[str, Any], fallback: int) -> int:
    try:
        return int(frame.get("frameNumber"))
    except (TypeError, ValueError):
        return fallback


def _is_true(value: Any) -> bool:
    return bool(value is True or (isinstance(value, str) and value.strip().lower() == "true"))


def _segment_title(frame: Dict[str, Any], part_number: int) -> str:
    raw = frame.get("segmentTitle")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    return f"Part {part_number}"


def _build_timed_frames(frames: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    ordered = sorted(frames, key=lambda f: _frame_number(f, 0))
    running = 0.0
    timed = []
    for idx, frame in enumerate(ordered):
        duration = _to_number(frame.get("duration"), DEFAULT_FRAME_DURATION)
        timed.append({
            "index": idx,
            "frame": frame,
            "frame_number": _frame_number(frame, idx + 1),
            "start": running,
            "end": running + duration,
            "segment_start": _is_true(frame.get("segmentStart")),
            "segment_end": _is_true(frame.get("segmentEnd")),
            "segment_number": frame.get("segmentNumber"),
        })
        running += duration
    return timed


def _segment_count_hint(total_frames: int) -> int:
    if total_frames <= 0:
        return 0
    if total_frames < 9:
        return 1
    if total_frames < 18:
        return 3
    return 4


def _build_marker_segments(timed: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    starts = [i for i, f in enumerate(timed) if f["segment_start"]]
    if not starts:
        return []
    segments = []
    for seq, start_idx in enumerate(starts):
        next_start = starts[seq + 1] if seq + 1 < len(starts) else None
        limit = (next_start - 1) if next_start is not None else (len(timed) - 1)
        end_idx = limit
        for i in range(start_idx, limit + 1):
            if timed[i]["segment_end"]:
                end_idx = i
                break
        start, end = timed[start_idx], timed[end_idx]
        try:
            part_number = int(start["segment_number"])
            if part_number <= 0:
                raise ValueError
        except (TypeError, ValueError):
            part_number = seq + 1
        segments.append({
            "part_number": part_number,
            "title": _segment_title(start["frame"], part_number),
            "start_s": round(start["start"], 3),
            "end_s": round(end["end"], 3),
        })
    return sorted(segments, key=lambda s: s["part_number"])


def _build_chunk_segments(timed: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    total = len(timed)
    if total == 0:
        return []
    count = _segment_count_hint(total)
    if count <= 1:
        return [{
            "part_number": 1,
            "title": "Part 1",
            "start_s": round(timed[0]["start"], 3),
            "end_s": round(timed[-1]["end"], 3),
        }]
    chunk = max(1, total // count)
    segments = []
    for idx in range(count):
        start_idx = idx * chunk
        if start_idx >= total:
            break
        end_idx = (idx + 1) * chunk - 1
        if idx == count - 1 or end_idx >= total:
            end_idx = total - 1
        segments.append({
            "part_number": idx + 1,
            "title": f"Part {idx + 1}",
            "start_s": round(timed[start_idx]["start"], 3),
            "end_s": round(timed[end_idx]["end"], 3),
        })
    return segments


def _build_duration_segments(duration_s: float, num_shorts: int) -> List[Dict[str, Any]]:
    if duration_s <= 0:
        raise SegmentError("Cannot auto-segment: video duration unknown")
    count = max(1, int(num_shorts) if num_shorts else default_num_shorts(duration_s))
    seg_dur = duration_s / count
    segments = [{
        "part_number": i + 1,
        "title": f"Part {i + 1}",
        "start_s": round(i * seg_dur, 3),
        "end_s": round((i + 1) * seg_dur, 3),
    } for i in range(count)]
    segments[-1]["end_s"] = round(duration_s, 3)
    return segments


def _normalise_explicit(segments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Accept snake_case, camelCase, or millisecond field variants."""
    out = []
    for i, seg in enumerate(segments):
        if not isinstance(seg, dict):
            continue

        def pick(*keys, scale=1.0):
            for key in keys:
                if seg.get(key) is not None:
                    try:
                        return float(seg[key]) * scale
                    except (TypeError, ValueError):
                        continue
            return None

        start = pick("start_s", "startTime", "startSeconds")
        if start is None:
            start = pick("start_ms", "startMs", scale=0.001)
        end = pick("end_s", "endTime", "endSeconds")
        if end is None:
            end = pick("end_ms", "endMs", scale=0.001)
        if start is None or end is None:
            logger.warning("segment %d missing start/end — skipped: %s", i, seg)
            continue
        try:
            part_number = int(seg.get("part_number") or seg.get("partNumber") or (i + 1))
        except (TypeError, ValueError):
            part_number = i + 1
        title = str(seg.get("title") or f"Part {part_number}").strip() or f"Part {part_number}"
        normalised = {
            "part_number": part_number,
            "title": title,
            "start_s": round(start, 3),
            "end_s": round(end, 3),
        }
        # Optional per-clip extras ride along: AI-selection metadata
        # (SelectHighlights Lambda) and caller-supplied caption overrides.
        for key in ("hook_line", "keywords", "virality", "reason", "ass_url"):
            if seg.get(key) is not None:
                normalised[key] = seg[key]
        out.append(normalised)
    return out


def resolve_segments(
    explicit: Optional[List[Dict[str, Any]]],
    frames: Optional[List[Dict[str, Any]]],
    num_shorts: Optional[int],
    duration_s: float,
) -> Tuple[List[Dict[str, Any]], str]:
    """Return (segments, strategy). Segments are clamped to the video duration."""
    if explicit:
        segments, strategy = _normalise_explicit(explicit), "explicit"
    elif frames and isinstance(frames, list):
        typed = [f for f in frames if isinstance(f, dict)]
        if not typed:
            raise SegmentError("frames[] does not contain valid frame objects")
        timed = _build_timed_frames(typed)
        marker = _build_marker_segments(timed)
        if marker:
            segments, strategy = marker, "markers"
        else:
            segments, strategy = _build_chunk_segments(timed), "frame_chunks"
    else:
        segments, strategy = _build_duration_segments(duration_s, num_shorts), "duration"

    cleaned = []
    for seg in segments:
        start, end = seg["start_s"], seg["end_s"]
        if duration_s > 0:
            end = min(end, duration_s)
            start = min(start, duration_s)
        if end - start < MIN_SEGMENT_SECONDS:
            logger.warning("segment part %s too short after clamping (%.2fs) — dropped",
                           seg["part_number"], end - start)
            continue
        cleaned.append({**seg, "start_s": start, "end_s": end,
                        "duration_s": round(end - start, 3)})

    if not cleaned:
        raise SegmentError(f"No usable segments (strategy={strategy})")
    logger.info("resolved %d segments via %s", len(cleaned), strategy)
    return cleaned, strategy
