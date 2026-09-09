"""End-to-end smoke of every op's ffmpeg path, GPU-less, no R2.

Synthesises tiny inputs with the local ffmpeg, runs each builder for real with
MEDIA_VIDEO_ENCODER=libx264, and checks the output exists with a plausible
duration. This is the offline half of §12.3's probe — the GPU half (NVENC,
Real-ESRGAN Vulkan, VRAM) only runs on a real endpoint.

    python orchestrator/containers/media/test/smoke_local.py
"""
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ["MEDIA_VIDEO_ENCODER"] = "libx264"

from media import ffmpeg as ff  # noqa: E402

FF = os.environ.get("FFMPEG_BIN", "ffmpeg")


def sh(args, what):
    r = subprocess.run([FF, *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"[setup] {what} failed:\n{r.stderr[-1200:]}")


def make_video(path, seconds, size="320x240", with_audio=True, tone=440):
    args = ["-y", "-f", "lavfi", "-i", f"testsrc=size={size}:rate=30:duration={seconds}"]
    if with_audio:
        args += ["-f", "lavfi", "-i", f"sine=frequency={tone}:duration={seconds}"]
    args += ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-t", str(seconds)]
    if with_audio:
        args += ["-c:a", "aac", "-shortest"]
    else:
        args += ["-an"]
    args.append(path)
    sh(args, f"make_video {path}")


def make_audio(path, seconds, tone=660):
    sh(["-y", "-f", "lavfi", "-i", f"sine=frequency={tone}:duration={seconds}",
        "-c:a", "aac", path], f"make_audio {path}")


def check(path, lo, hi, label):
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        raise SystemExit(f"  FAIL {label}: no output at {path}")
    d = ff.duration_seconds(path)
    ok = lo <= d <= hi
    print(f"  {'ok  ' if ok else 'FAIL'} {label}: {d:.2f}s (want {lo}-{hi})")
    if not ok:
        raise SystemExit(1)


def main():
    wd = tempfile.mkdtemp(prefix="media-smoke-")
    print(f"workdir {wd}\n")

    v_short = os.path.join(wd, "v_short.mp4"); make_video(v_short, 2, with_audio=True)
    v_silent = os.path.join(wd, "v_silent.mp4"); make_video(v_silent, 3, with_audio=False)
    a_long = os.path.join(wd, "a_long.m4a"); make_audio(a_long, 5)
    a_short = os.path.join(wd, "a_short.m4a"); make_audio(a_short, 1)
    clip_a = os.path.join(wd, "clip_a.mp4"); make_video(clip_a, 2, size="320x240", with_audio=True)
    clip_b = os.path.join(wd, "clip_b.mp4"); make_video(clip_b, 3, size="640x360", with_audio=False)
    srt = os.path.join(wd, "s.srt")
    with open(srt, "w", encoding="utf-8") as f:
        f.write("1\n00:00:00,000 --> 00:00:02,000\nhello world\n")

    # merge: replace, audio longer than video -> capped to video length (~2s)
    o = os.path.join(wd, "merge_cap.mp4")
    ff.run_checked(ff.build_merge_args(v_silent, a_long, o, target_s=min(3.0, 5.0)), "merge")
    check(o, 2.8, 3.2, "merge replace (cap to video 3s)")

    # merge: durationS given, audio shorter -> padded up to 4s
    o = os.path.join(wd, "merge_pad.mp4")
    ff.run_checked(ff.build_merge_args(v_silent, a_short, o, target_s=3.0), "merge")
    check(o, 2.8, 3.2, "merge replace (pad short audio to 3s)")

    # concat: 2 clips, mixed sizes + one silent -> 5s
    o = os.path.join(wd, "concat.mp4")
    ff.run_checked(ff.build_concat_normalize_args(
        [clip_a, clip_b], o, aspect_ratio="9:16",
        audio_present=[ff.has_audio_stream(clip_a), ff.has_audio_stream(clip_b)],
        durations=[ff.duration_seconds(clip_a), ff.duration_seconds(clip_b)],
        preset_override="ultrafast",
    ), "concat")
    check(o, 4.6, 5.4, "concat 2 clips")

    # caption: burn srt
    o = os.path.join(wd, "cap.mp4")
    ff.run_checked(ff.build_caption_args(v_short, srt, o), "caption")
    check(o, 1.8, 2.2, "caption burn-in")

    # bgm_overlay: bed under existing audio, video copy
    o = os.path.join(wd, "bgm.mp4")
    ff.run_checked(ff.build_bgm_overlay_args(
        v_short, a_long, o, video_duration=ff.duration_seconds(v_short), bgm_volume=0.2,
    ), "bgm_overlay")
    check(o, 1.8, 2.2, "bgm_overlay (mix)")

    # upscale: lanczos fallback path (no Vulkan locally)
    o = os.path.join(wd, "up.mp4")
    ff.run_checked(["-y", "-i", v_short, "-vf", "scale=iw*2:ih*2:flags=lanczos",
                    *ff.video_encoder_args(), "-c:a", "copy", o], "upscale.lanczos")
    check(o, 1.8, 2.2, "upscale lanczos x2")

    print("\nall media ops ok (libx264 / lanczos)")


if __name__ == "__main__":
    main()
