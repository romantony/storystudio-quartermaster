"""FFmpeg render stages (ports of E2E-split-video, E2E-convert-aspect-ratio,
E2E-finalize-short) with NVENC encoding and libx264 fallback.

Per-short flow: trim -> extract audio -> single main encode (aspect convert
@ target resolution + ASS caption burn in one pass) -> title/end slides +
concat -> BGM mix (video stream copied).
"""

import logging
import subprocess
import tempfile
import textwrap
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .probe import has_audio_stream, probe_dimensions, probe_duration

logger = logging.getLogger(__name__)

TRIM_TIMEOUT = 300
AUDIO_TIMEOUT = 300
ENCODE_TIMEOUT = 1800
SLIDE_TIMEOUT = 120

TITLE_SLIDE_SECONDS = 3.0
END_SLIDE_SECONDS = 2.5
DEFAULT_FG_Y_OFFSET = -120

RENDER_STYLES = ("PAD", "BLUR_FILL", "CROP_FILL")

_nvenc_usable: Optional[bool] = None


class RenderError(Exception):
    pass


def _run(cmd: List[str], timeout: int, label: str) -> None:
    logger.debug("[%s] %s", label, " ".join(cmd))
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise RenderError(f"{label} timed out after {timeout}s") from exc
    if result.returncode != 0:
        raise RenderError(f"{label} failed (exit {result.returncode}): {(result.stderr or '')[-600:]}")


# ---------------------------------------------------------------------------
# Codec selection
# ---------------------------------------------------------------------------

def nvenc_available() -> bool:
    """h264_nvenc compiled in AND usable on this host (cached test encode)."""
    global _nvenc_usable
    if _nvenc_usable is not None:
        return _nvenc_usable
    try:
        listing = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True, text=True, timeout=30,
        )
        if "h264_nvenc" not in (listing.stdout or ""):
            _nvenc_usable = False
            return False
        test = subprocess.run(
            [
                "ffmpeg", "-y", "-hide_banner",
                "-f", "lavfi", "-i", "color=c=black:size=256x256:rate=24:duration=0.2",
                "-c:v", "h264_nvenc", "-f", "null", "-",
            ],
            capture_output=True, text=True, timeout=60,
        )
        _nvenc_usable = test.returncode == 0
    except Exception as exc:
        logger.warning("nvenc detection failed: %s", exc)
        _nvenc_usable = False
    logger.info("h264_nvenc usable: %s", _nvenc_usable)
    return _nvenc_usable


def video_codec_args(force_x264: bool = False) -> List[str]:
    if not force_x264 and nvenc_available():
        return [
            "-c:v", "h264_nvenc",
            "-preset", "p5",
            "-rc", "vbr", "-cq", "19", "-b:v", "0",
            "-pix_fmt", "yuv420p",
        ]
    return [
        "-c:v", "libx264",
        "-crf", "18", "-preset", "medium",
        "-pix_fmt", "yuv420p",
    ]


def _run_encode(cmd_builder, timeout: int, label: str) -> None:
    """Run an encode; if NVENC was used and fails, retry once with libx264."""
    try:
        _run(cmd_builder(force_x264=False), timeout, label)
    except RenderError as exc:
        if nvenc_available():
            logger.warning("%s failed with NVENC, retrying with libx264: %s", label, exc)
            _run(cmd_builder(force_x264=True), timeout, f"{label} (x264 retry)")
        else:
            raise


# ---------------------------------------------------------------------------
# Trim + audio extraction
# ---------------------------------------------------------------------------

def trim(src: Path, out: Path, start_s: float, end_s: float) -> None:
    """Keyframe-fast stream-copy trim (port of E2E-split-video).

    -ss/-to are input options: on ffmpeg 6.x, output-side seeking combined
    with -c copy silently drops the video stream. Input-side seeking is also
    faster (demuxer-level seek to the nearest keyframe).
    """
    if end_s <= start_s:
        raise RenderError(f"invalid trim range {start_s}..{end_s}")
    _run(
        [
            "ffmpeg", "-y",
            "-ss", str(start_s), "-to", str(end_s),
            "-i", str(src),
            "-map", "0",
            "-c", "copy", "-avoid_negative_ts", "1",
            str(out),
        ],
        TRIM_TIMEOUT, "trim",
    )


def extract_audio_wav(src: Path, out: Path) -> None:
    """16 kHz mono PCM for Whisper."""
    _run(
        [
            "ffmpeg", "-y", "-i", str(src),
            "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
            str(out),
        ],
        AUDIO_TIMEOUT, "extract-audio-wav",
    )


def extract_audio_m4a(src: Path, out: Path,
                      start_s: Optional[float] = None,
                      end_s: Optional[float] = None) -> None:
    """AAC archival copy of the short's audio (optionally a window of src)."""
    cmd = ["ffmpeg", "-y"]
    if start_s is not None:
        cmd += ["-ss", f"{start_s:.3f}"]
    if end_s is not None:
        cmd += ["-to", f"{end_s:.3f}"]
    cmd += [
        "-i", str(src),
        "-vn", "-c:a", "aac", "-b:a", "192k",
        str(out),
    ]
    _run(cmd, AUDIO_TIMEOUT, "extract-audio-m4a")


# ---------------------------------------------------------------------------
# Main encode: aspect conversion + caption burn in ONE pass
# ---------------------------------------------------------------------------

def _escape_filter_path(path: Path) -> str:
    return str(path).replace("\\", "/").replace(":", "\\:")


def build_convert_filter(
    source_ar: str,
    target_ar: str,
    width: int,
    height: int,
    render_style: str,
    fg_y_offset: int = DEFAULT_FG_Y_OFFSET,
    ass_path: Optional[Path] = None,
    sharpen: bool = False,
) -> Tuple[str, bool]:
    """Return (filter_string, use_filter_complex).

    Filter graphs ported from E2E-convert-aspect-ratio._build_filter, with the
    ASS caption burn appended to the same chain (saves a full re-encode).
    The filter_complex output is labelled [vout] (the Lambda left it
    unlabelled while also passing -map 0:v:0, which is invalid).

    ``sharpen`` adds lanczos resampling + a mild unsharp pass — the "lanczos"
    upscale mode for low-res sources (and the post-SR polish).
    """
    ass_suffix = f",ass='{_escape_filter_path(ass_path)}'" if ass_path else ""
    lanczos = ":flags=lanczos" if sharpen else ""
    unsharp = ",unsharp=5:5:0.8:3:3:0.4" if sharpen else ""

    if source_ar == target_ar:
        return (
            f"scale={width}:{height}:force_original_aspect_ratio=decrease{lanczos},"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2" + unsharp + ass_suffix,
            False,
        )

    if source_ar == "16:9" and target_ar == "9:16":
        if render_style == "PAD":
            return (
                f"scale={width}:{height}:force_original_aspect_ratio=decrease{lanczos},"
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2" + unsharp + ass_suffix,
                False,
            )
        if render_style == "CROP_FILL":
            return (
                f"scale={width}:{height}:force_original_aspect_ratio=increase{lanczos},"
                f"crop={width}:{height}" + unsharp + ass_suffix,
                False,
            )
        # Default BLUR_FILL: foreground over blurred cover background.
        return (
            f"[0:v]split=2[bg][fg];"
            f"[bg]scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},boxblur=20:1[bg];"
            f"[fg]scale={width}:{height}:force_original_aspect_ratio=decrease{lanczos}"
            f"{unsharp}[fg];"
            f"[bg][fg]overlay=(W-w)/2:(H-h)/2+({fg_y_offset})" + ass_suffix + "[vout]",
            True,
        )

    if source_ar == "9:16" and target_ar == "16:9":
        return (
            f"crop=iw:iw*9/16,scale={width}:{height}:flags=lanczos" + ass_suffix,
            False,
        )

    # Generic centre-crop square then scale (Lambda parity fallback).
    return (
        f"crop=min(iw\\,ih):min(iw\\,ih),scale={width}:{height}:flags=lanczos" + ass_suffix,
        False,
    )


def encode_main(
    src: Path,
    out: Path,
    filter_value: str,
    use_filter_complex: bool,
    start_s: Optional[float] = None,
    end_s: Optional[float] = None,
) -> None:
    """Single video encode: convert to target canvas + burn captions.

    ``start_s``/``end_s`` cut directly from ``src`` during the encode —
    frame-accurate (unlike the keyframe-snapped stream-copy trim), so AI-chosen
    sentence boundaries are honored exactly.
    """

    def builder(force_x264: bool) -> List[str]:
        cmd = ["ffmpeg", "-y"]
        if start_s is not None:
            cmd += ["-ss", f"{start_s:.3f}"]
        if end_s is not None:
            cmd += ["-to", f"{end_s:.3f}"]
        cmd += ["-i", str(src)]
        if use_filter_complex:
            cmd += ["-filter_complex", filter_value, "-map", "[vout]", "-map", "0:a?"]
        else:
            cmd += ["-vf", filter_value, "-map", "0:v:0", "-map", "0:a?"]
        cmd += video_codec_args(force_x264)
        cmd += [
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
            "-movflags", "+faststart",
            str(out),
        ]
        return cmd

    _run_encode(builder, ENCODE_TIMEOUT, "main-encode")


# ---------------------------------------------------------------------------
# Slides (ports of E2E-finalize-short slide builders)
# ---------------------------------------------------------------------------

def _escape_drawtext(value: str) -> str:
    return value.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def _drawtext_title_slide(title: str, part_number: int, height: int) -> str:
    part_fs = max(64, int(height * 0.055))
    title_fs = max(38, int(height * 0.034))
    part_text = _escape_drawtext(f"PART {part_number}")
    title_lines = textwrap.wrap(title, width=26)[:2]

    filters = [
        f"drawtext=text='{part_text}':fontsize={part_fs}:fontcolor=white:"
        f"borderw=4:bordercolor=black:x=(w-tw)/2:y={int(height * 0.37)}"
    ]
    for i, line in enumerate(title_lines):
        line_y = int(height * 0.50) + i * (title_fs + 14)
        filters.append(
            f"drawtext=text='{_escape_drawtext(line)}':fontsize={title_fs}:fontcolor=#FFD400:"
            f"borderw=3:bordercolor=black:x=(w-tw)/2:y={line_y}"
        )
    return ",".join(filters)


def _drawtext_end_slide(part_number: int, height: int) -> str:
    fs1 = max(54, int(height * 0.046))
    fs2 = max(42, int(height * 0.036))
    l1 = _escape_drawtext("To Be Continued...")
    l2 = _escape_drawtext(f"Part {part_number + 1} Coming Soon")
    return (
        f"drawtext=text='{l1}':fontsize={fs1}:fontcolor=white:"
        f"borderw=4:bordercolor=black:x=(w-tw)/2:y={int(height * 0.41)},"
        f"drawtext=text='{l2}':fontsize={fs2}:fontcolor=#FFD400:"
        f"borderw=3:bordercolor=black:x=(w-tw)/2:y={int(height * 0.54)}"
    )


def _generate_slide(vf: str, bg_color: str, width: int, height: int,
                    duration: float, out: Path, label: str) -> None:
    def builder(force_x264: bool) -> List[str]:
        return [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i",
            f"color=c={bg_color}:size={width}x{height}:rate=30:duration={duration}",
            "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
            "-vf", vf,
            *video_codec_args(force_x264),
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
            "-t", str(duration),
            "-movflags", "+faststart",
            str(out),
        ]
    _run_encode(builder, SLIDE_TIMEOUT, label)


def attach_silent_audio(src: Path, out: Path) -> None:
    duration = probe_duration(src)
    if duration <= 0:
        raise RenderError(f"cannot determine duration for silent-audio mux: {src}")
    _run(
        [
            "ffmpeg", "-y",
            "-i", str(src),
            "-f", "lavfi", "-t", str(duration),
            "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "192k",
            "-shortest",
            str(out),
        ],
        AUDIO_TIMEOUT, "attach-silent-audio",
    )


def concat_with_slides(
    main_clip: Path,
    out: Path,
    part_number: int,
    part_title: str,
    project_title: str = "",
) -> None:
    """title slide (3s) + main clip + end slide (2.5s) -> out."""
    width, height = probe_dimensions(main_clip)

    with tempfile.TemporaryDirectory(prefix="slides-") as tmp:
        tmp_path = Path(tmp)
        title_slide = tmp_path / "title_slide.mp4"
        end_slide = tmp_path / "end_slide.mp4"

        display_title = project_title.strip() or part_title
        _generate_slide(
            _drawtext_title_slide(display_title, part_number, height),
            "black", width, height, TITLE_SLIDE_SECONDS, title_slide, "title-slide",
        )
        _generate_slide(
            _drawtext_end_slide(part_number, height),
            "#111111", width, height, END_SLIDE_SECONDS, end_slide, "end-slide",
        )

        ready_clip = main_clip
        if not has_audio_stream(main_clip):
            ready_clip = tmp_path / "clip_with_audio.mp4"
            logger.warning("main clip has no audio — attaching silent track")
            attach_silent_audio(main_clip, ready_clip)

        concat_list = tmp_path / "concat.txt"
        concat_list.write_text(
            f"file '{title_slide}'\nfile '{ready_clip}'\nfile '{end_slide}'\n",
            encoding="utf-8",
        )

        def builder(force_x264: bool) -> List[str]:
            return [
                "ffmpeg", "-y",
                "-f", "concat", "-safe", "0",
                "-i", str(concat_list),
                *video_codec_args(force_x264),
                "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
                "-movflags", "+faststart",
                str(out),
            ]
        _run_encode(builder, ENCODE_TIMEOUT, "slide-concat")


# ---------------------------------------------------------------------------
# BGM mix (port of E2E-finalize-short._run_bgm_mix — video stream copied)
# ---------------------------------------------------------------------------

def mix_bgm(video: Path, bgm: Path, out: Path, bgm_volume: float = 0.18) -> None:
    vol = max(0.0, min(1.0, float(bgm_volume)))
    src = video
    if not has_audio_stream(video):
        silent = video.parent / f"{video.stem}_silent.mp4"
        attach_silent_audio(video, silent)
        src = silent
    filter_complex = (
        f"[1:a]volume={vol:.4f}[bgm];"
        "[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=2[a]"
    )
    _run(
        [
            "ffmpeg", "-y",
            "-i", str(src),
            "-i", str(bgm),
            "-filter_complex", filter_complex,
            "-map", "0:v", "-map", "[a]",
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",
            str(out),
        ],
        ENCODE_TIMEOUT, "bgm-mix",
    )


def normalize_render_style(value: Any) -> str:
    style = str(value or "BLUR_FILL").strip().upper()
    return style if style in RENDER_STYLES else "BLUR_FILL"
