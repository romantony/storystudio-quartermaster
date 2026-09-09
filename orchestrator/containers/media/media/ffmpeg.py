"""ffmpeg / ffprobe helpers + the pure argv builders for each media op.

The builders are pure functions `(...) -> list[str]` so they unit-test without a
GPU or even ffmpeg present (test/test_ffmpeg_args.py). Everything that actually
shells out lives in `run` / the `probe_*` helpers.

Semantics are ported from the live AWS path:
  - merge:   src/handlers/merge.ts               (apad + `-t target`, the "Bug #6" pad fix)
  - concat:  infra/docker/concat-and-trim/index.ts (per-clip normalize, >40 batch path)
  - the rest are new but follow the same conventions.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
from dataclasses import dataclass

FFMPEG = os.environ.get("FFMPEG_BIN", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE_BIN", "ffprobe")

# NVENC in the image; tests and GPU-less local runs override to libx264.
VIDEO_ENCODER = os.environ.get("MEDIA_VIDEO_ENCODER", "h264_nvenc")
# NVENC uses `-preset p1..p7` (p1 fastest); libx264 uses named presets.
NVENC_PRESET = os.environ.get("MEDIA_NVENC_PRESET", "p5")
X264_PRESET = os.environ.get("MEDIA_X264_PRESET", "medium")

ASPECT_RATIOS: dict[str, tuple[int, int]] = {
    "16:9": (1920, 1088),
    "9:16": (1008, 1792),
    "1:1": (1088, 1088),
    "4:3": (1024, 768),
    "4:5": (1024, 1280),
    "21:9": (2016, 864),
}
TARGET_FPS = int(os.environ.get("MEDIA_TARGET_FPS", "30"))


class FfmpegError(RuntimeError):
    pass


@dataclass
class RunResult:
    stdout: str
    stderr: str
    status: int


def run(args: list[str], timeout: float | None = None) -> RunResult:
    """Invoke ffmpeg. `args` excludes the binary itself."""
    proc = subprocess.run(
        [FFMPEG, *args],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return RunResult(proc.stdout or "", proc.stderr or "", proc.returncode)


def run_checked(args: list[str], what: str, timeout: float | None = None) -> RunResult:
    r = run(args, timeout=timeout)
    if r.status != 0:
        raise FfmpegError(f"{what} failed (exit {r.status}): {r.stderr[-1800:]}")
    return r


# ── probes ──────────────────────────────────────────────────────────────────

def ffprobe_json(path: str) -> dict:
    proc = subprocess.run(
        [FFPROBE, "-v", "error", "-print_format", "json",
         "-show_format", "-show_streams", path],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise FfmpegError(f"ffprobe failed: {proc.stderr}")
    return json.loads(proc.stdout or "{}")


def duration_seconds(path: str) -> float:
    try:
        return max(0.01, float(ffprobe_json(path).get("format", {}).get("duration", 0)))
    except Exception:
        return 0.01


def has_audio_stream(path: str) -> bool:
    try:
        return any(s.get("codec_type") == "audio" for s in ffprobe_json(path).get("streams", []))
    except Exception:
        return False  # conservative: assume video-only rather than risk a filtergraph error


# ── encoder selection ───────────────────────────────────────────────────────

def video_encoder_args(crf_x264: int = 23, cq_nvenc: int = 26) -> list[str]:
    """`-c:v <enc> -preset <p> -<rate control>`. One place decides NVENC vs x264
    so a single env flip (MEDIA_VIDEO_ENCODER) switches every op — this is what
    makes spec §16 q3 (NVENC vs libx264 for concat) a measurement, not a rewrite.
    """
    if VIDEO_ENCODER == "h264_nvenc":
        return ["-c:v", "h264_nvenc", "-preset", NVENC_PRESET,
                "-rc", "vbr", "-cq", str(cq_nvenc), "-b:v", "0"]
    return ["-c:v", "libx264", "-preset", X264_PRESET, "-crf", str(crf_x264)]


# ── pure argv builders (one per op) ─────────────────────────────────────────

def build_merge_args(
    video_path: str,
    audio_path: str,
    out_path: str,
    *,
    target_s: float,
    mix_mode: str = "replace",
    sfx_volume: float | None = None,
    video_has_audio: bool = False,
) -> list[str]:
    """Mux `audio` onto `video`, capped/padded to `target_s`.

    replace  : audio replaces the video's track; shorter audio is padded with
               trailing silence (apad) so `-t target_s` yields exact length —
               this is merge.ts's "Bug #6" fix, done with `whole_dur` (the
               modern seconds-based apad option; the TS uses sample counts only
               because its bundled ffmpeg is a 2018 build).
    additive : audio is mixed on top of the video's existing track (spot SFX
               over dialogue). Needs a real `0:a`; falls back to replace when
               the video is silent (Wan2 clips have no audio stream at all).
    """
    if mix_mode == "additive" and video_has_audio:
        sfx_gain = (sfx_volume if sfx_volume is not None else 1.0)
        filt = (
            f"[1:a]volume={sfx_gain}[sfxin];"
            f"[0:a][sfxin]amix=inputs=2:duration=first:normalize=0[aout]"
        )
    else:
        stage = ""
        label = "1:a"
        if sfx_volume is not None:
            stage = f"[1:a]volume={sfx_volume}[sfxin];"
            label = "sfxin"
        filt = f"{stage}[{label}]apad=whole_dur={target_s:.3f}[aout]"

    return [
        "-y", "-i", video_path, "-i", audio_path,
        "-filter_complex", filt,
        "-map", "0:v:0", "-map", "[aout]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
        "-t", f"{target_s:.3f}",
        "-movflags", "+faststart",
        out_path,
    ]


def build_concat_normalize_args(
    video_paths: list[str],
    out_path: str,
    *,
    aspect_ratio: str,
    audio_present: list[bool],
    durations: list[float],
    preset_override: str | None = None,
) -> list[str]:
    """One filter_complex that scales+pads+fps-locks+format-locks every clip,
    supplies silent audio where a clip has none, then concats. Ported from
    concat-and-trim's concat_premium_audio_safe()."""
    w, h = ASPECT_RATIOS.get(aspect_ratio, ASPECT_RATIOS["9:16"])
    n = len(video_paths)
    inputs: list[str] = []
    for p in video_paths:
        inputs += ["-i", p]

    parts: list[str] = []
    concat_in: list[str] = []
    for i in range(n):
        parts.append(
            f"[{i}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,fps={TARGET_FPS},format=yuv420p[v{i}]"
        )
        concat_in.append(f"[v{i}]")
        if audio_present[i]:
            parts.append(f"[{i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a{i}]")
        else:
            parts.append(
                f"anullsrc=channel_layout=stereo:sample_rate=48000,"
                f"atrim=duration={durations[i]:.3f},asetpts=N/SR/TB[a{i}]"
            )
        concat_in.append(f"[a{i}]")
    parts.append(f"{''.join(concat_in)}concat=n={n}:v=1:a=1[outv][outa]")

    enc = video_encoder_args()
    if preset_override and enc[1] == "libx264":
        enc = ["-c:v", "libx264", "-preset", preset_override, "-crf", "23"]

    return [
        *inputs,
        "-filter_complex", ";".join(parts),
        "-map", "[outv]", "-map", "[outa]",
        *enc,
        "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000",
        "-movflags", "+faststart",
        "-y", out_path,
    ]


def build_stream_copy_concat_args(list_file: str, out_path: str) -> list[str]:
    return ["-f", "concat", "-safe", "0", "-i", list_file, "-c", "copy", "-y", out_path]


def build_caption_args(
    video_path: str,
    subtitle_path: str,
    out_path: str,
    *,
    force_style: str | None = None,
) -> list[str]:
    """Burn SRT/ASS into the video (libass). Video must be re-encoded."""
    sub = subtitle_path.replace("\\", "/").replace(":", r"\:").replace("'", r"\'")
    vf = f"subtitles='{sub}'"
    if force_style:
        vf += f":force_style='{force_style}'"
    return [
        "-y", "-i", video_path,
        "-vf", vf,
        *video_encoder_args(),
        "-c:a", "copy",
        "-movflags", "+faststart",
        out_path,
    ]


def build_bgm_overlay_args(
    video_path: str,
    bgm_path: str,
    out_path: str,
    *,
    video_duration: float,
    bgm_volume: float = 0.18,
    duck_db: float | None = None,
    video_has_audio: bool = True,
) -> list[str]:
    """Loop `bgm` under the video's existing audio and mix. `-c:v copy` — no
    video re-encode. When `duck_db` is set, sidechain-compress the bed against
    the foreground so dialogue stays intelligible."""
    if not video_has_audio:
        # Nothing to mix against — bgm becomes the track, looped and trimmed.
        filt = f"[1:a]volume={bgm_volume},atrim=0:{video_duration:.3f},asetpts=N/SR/TB[aout]"
        return [
            "-y", "-i", video_path, "-stream_loop", "-1", "-i", bgm_path,
            "-filter_complex", filt,
            "-map", "0:v:0", "-map", "[aout]",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            "-t", f"{video_duration:.3f}", "-movflags", "+faststart", out_path,
        ]

    if duck_db is not None:
        filt = (
            f"[1:a]volume={bgm_volume}[bed];"
            f"[bed][0:a]sidechaincompress=threshold=0.03:ratio=8:makeup={abs(duck_db):.0f}[ducked];"
            f"[0:a][ducked]amix=inputs=2:duration=first:normalize=0[aout]"
        )
    else:
        filt = (
            f"[1:a]volume={bgm_volume}[bed];"
            f"[0:a][bed]amix=inputs=2:duration=first:normalize=0[aout]"
        )
    return [
        "-y", "-i", video_path, "-stream_loop", "-1", "-i", bgm_path,
        "-filter_complex", filt,
        "-map", "0:v:0", "-map", "[aout]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-t", f"{video_duration:.3f}",
        "-movflags", "+faststart",
        out_path,
    ]


def build_frames_extract_args(video_path: str, pattern: str) -> list[str]:
    return ["-y", "-i", video_path, "-qscale:v", "1", "-qmin", "1", pattern]


def build_frames_assemble_args(
    frame_glob_pattern: str,
    audio_source: str,
    out_path: str,
    *,
    fps: float,
    has_audio: bool,
) -> list[str]:
    args = ["-y", "-framerate", f"{fps:.4f}", "-i", frame_glob_pattern, "-i", audio_source]
    args += ["-map", "0:v:0"]
    if has_audio:
        args += ["-map", "1:a:0", "-c:a", "aac", "-b:a", "160k"]
    else:
        args += ["-an"]
    args += [*video_encoder_args(), "-pix_fmt", "yuv420p", "-movflags", "+faststart", out_path]
    return args


def fps_of(path: str) -> float:
    try:
        for s in ffprobe_json(path).get("streams", []):
            if s.get("codec_type") == "video":
                num, den = (s.get("r_frame_rate") or "30/1").split("/")
                return float(num) / float(den or 1)
    except Exception:
        pass
    return float(TARGET_FPS)


def parse_duration_from_stderr(stderr: str) -> float:
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)", stderr)
    if not m:
        return 0.0
    h, mnt, s = m.groups()
    return int(h) * 3600 + int(mnt) * 60 + float(s)


def quote(args: list[str]) -> str:
    return " ".join(shlex.quote(a) for a in args)
