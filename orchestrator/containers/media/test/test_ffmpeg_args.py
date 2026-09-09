"""Pure unit tests for the argv builders — no ffmpeg, no GPU, no network.

Run: python -m pytest orchestrator/containers/media/test/  (or `python test_ffmpeg_args.py`).
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("MEDIA_VIDEO_ENCODER", "libx264")
from media import ffmpeg as ff  # noqa: E402


def test_merge_replace_pads_to_target_and_caps():
    args = ff.build_merge_args("v.mp4", "a.wav", "o.mp4", target_s=5.234)
    s = " ".join(args)
    assert "apad=whole_dur=5.234" in s
    assert "-t 5.234" in s
    assert "-c:v copy" in s            # video is never re-encoded in merge
    assert "-map [aout]" in s


def test_merge_additive_mixes_when_video_has_audio():
    args = ff.build_merge_args("v.mp4", "a.wav", "o.mp4", target_s=3.0,
                               mix_mode="additive", video_has_audio=True, sfx_volume=0.5)
    s = " ".join(args)
    assert "amix=inputs=2:duration=first:normalize=0" in s
    assert "volume=0.5" in s
    assert "apad" not in s


def test_merge_additive_without_video_audio_falls_back_to_pad():
    args = ff.build_merge_args("v.mp4", "a.wav", "o.mp4", target_s=3.0,
                               mix_mode="additive", video_has_audio=False)
    assert "apad=whole_dur=3.000" in " ".join(args)


def test_merge_sfx_volume_only_adds_a_gain_stage_when_requested():
    plain = " ".join(ff.build_merge_args("v", "a", "o", target_s=1.0))
    assert "volume=" not in plain
    withgain = " ".join(ff.build_merge_args("v", "a", "o", target_s=1.0, sfx_volume=0.8))
    assert "[1:a]volume=0.8[sfxin]" in withgain


def test_concat_normalize_scales_pads_fps_locks_every_clip():
    args = ff.build_concat_normalize_args(
        ["a.mp4", "b.mp4"], "out.mp4",
        aspect_ratio="9:16", audio_present=[True, False], durations=[2.0, 3.5],
    )
    s = " ".join(args)
    assert "scale=1008:1792:force_original_aspect_ratio=decrease" in s
    assert f"fps={ff.TARGET_FPS}" in s
    assert "concat=n=2:v=1:a=1" in s
    # clip b has no audio -> silence is synthesized at its own duration
    assert "anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=3.500" in s
    # clip a has audio -> just reformatted
    assert "[0:a]aformat=sample_fmts=fltp:sample_rates=48000" in s


def test_concat_unknown_aspect_ratio_falls_back_to_portrait():
    args = ff.build_concat_normalize_args(["a.mp4"], "o.mp4", aspect_ratio="banana",
                                          audio_present=[True], durations=[1.0])
    assert "scale=1008:1792" in " ".join(args)


def test_encoder_flip_is_one_switch():
    os.environ["MEDIA_VIDEO_ENCODER"] = "h264_nvenc"
    try:
        import importlib
        importlib.reload(ff)
        assert "h264_nvenc" in " ".join(ff.video_encoder_args())
        assert "-cq" in " ".join(ff.video_encoder_args())
    finally:
        os.environ["MEDIA_VIDEO_ENCODER"] = "libx264"
        importlib.reload(ff)
    assert "libx264" in " ".join(ff.video_encoder_args())
    assert "-crf" in " ".join(ff.video_encoder_args())


def test_caption_burns_subtitles_and_copies_audio():
    s = " ".join(ff.build_caption_args("v.mp4", "subs.ass", "o.mp4", force_style="Fontsize=24"))
    assert "subtitles=" in s
    assert "force_style=" in s
    assert "-c:a copy" in s


def test_bgm_overlay_loops_bed_and_keeps_video_copy():
    s = " ".join(ff.build_bgm_overlay_args("v.mp4", "bgm.mp3", "o.mp4",
                                           video_duration=42.0, bgm_volume=0.2))
    assert "-stream_loop -1" in s
    assert "volume=0.2" in s
    assert "amix=inputs=2:duration=first:normalize=0" in s
    assert "-c:v copy" in s
    assert "-t 42.000" in s


def test_bgm_overlay_ducking_adds_sidechain():
    s = " ".join(ff.build_bgm_overlay_args("v.mp4", "bgm.mp3", "o.mp4",
                                           video_duration=10.0, duck_db=-9))
    assert "sidechaincompress=" in s


def test_bgm_overlay_silent_video_uses_bed_as_track():
    s = " ".join(ff.build_bgm_overlay_args("v.mp4", "bgm.mp3", "o.mp4",
                                           video_duration=10.0, video_has_audio=False))
    assert "amix" not in s
    assert "atrim=0:10.000" in s


def test_frames_assemble_respects_audio_presence():
    with_a = " ".join(ff.build_frames_assemble_args("%08d.png", "src.mp4", "o.mp4", fps=24.0, has_audio=True))
    assert "-map 1:a:0" in with_a
    no_a = " ".join(ff.build_frames_assemble_args("%08d.png", "src.mp4", "o.mp4", fps=24.0, has_audio=False))
    assert "-an" in no_a and "-map 1:a:0" not in no_a


if __name__ == "__main__":
    mod = sys.modules[__name__]
    fns = [v for k, v in sorted(vars(mod).items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"  ok   {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"  FAIL {fn.__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)
