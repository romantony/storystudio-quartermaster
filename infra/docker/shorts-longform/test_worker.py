"""Local test harness — runs the handler directly, no RunPod runtime needed.

Usage:
    export R2_ENDPOINT=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
           R2_BUCKET=e2e-storystudio R2_PUBLIC_BASE=... \
           RUNPOD_API_KEY=... SRT_ENDPOINT_ID=rnqxi6c0mlq517
    python3 test_worker.py --input test_input.json

Offline unit checks (no network, no env needed):
    python3 test_worker.py --offline
"""

import argparse
import json
import sys


def run_job_from_file(input_file: str) -> int:
    from handler import run_job

    with open(input_file, encoding="utf-8") as fh:
        payload = json.load(fh)
    # test_input.json predates the ECS entrypoint and may still be wrapped
    # RunPod-style ({"input": {...}}) — accept either shape.
    inp = payload["input"] if "input" in payload else payload

    result = run_job(inp)
    print(json.dumps(result, indent=2))
    return 1 if "error" in result else 0


def run_offline_checks() -> int:
    """Pure-Python sanity checks for segments + captions (no ffmpeg/network)."""
    from shorts.captions import (build_ass, build_srt, cues_from_words,
                                 parse_srt, words_from_chunks)
    from shorts.segments import resolve_segments

    failures = []

    def check(name, cond):
        status = "ok" if cond else "FAIL"
        print(f"  [{status}] {name}")
        if not cond:
            failures.append(name)

    # --- segments -----------------------------------------------------------
    segs, strategy = resolve_segments(None, None, 4, 200.0)
    check("duration strategy -> 4 parts", strategy == "duration" and len(segs) == 4)
    check("duration parts cover video", abs(segs[-1]["end_s"] - 200.0) < 0.01)

    frames = [{"frameNumber": i + 1, "duration": 5.0} for i in range(20)]
    frames[0]["segmentStart"] = True
    frames[0]["segmentTitle"] = "Opening"
    frames[9]["segmentEnd"] = True
    frames[10]["segmentStart"] = True
    segs, strategy = resolve_segments(None, frames, None, 100.0)
    check("marker strategy detected", strategy == "markers" and len(segs) == 2)
    check("marker titles preserved", segs[0]["title"] == "Opening")
    check("marker boundaries", segs[0]["start_s"] == 0.0 and segs[0]["end_s"] == 50.0)

    plain = [{"frameNumber": i + 1, "duration": 5.0} for i in range(20)]
    segs, strategy = resolve_segments(None, plain, None, 100.0)
    check("chunk fallback -> 4 parts", strategy == "frame_chunks" and len(segs) == 4)

    segs, strategy = resolve_segments(
        [{"partNumber": 1, "startMs": 0, "endMs": 30000, "title": "A"},
         {"part_number": 2, "start_s": 30, "end_s": 500, "title": "B"}],
        None, None, 60.0,
    )
    check("explicit + camelCase/ms accepted", strategy == "explicit" and len(segs) == 2)
    check("explicit clamped to duration", segs[1]["end_s"] == 60.0)

    # --- captions -------------------------------------------------------------
    chunks = [
        {"text": " Deep", "timestamp": [0.0, 0.32]},
        {"text": " in", "timestamp": [0.32, 0.45]},
        {"text": " the", "timestamp": [0.45, 0.60]},
        {"text": " desert", "timestamp": [0.60, 1.10]},
        {"text": " stands", "timestamp": [2.60, 3.00]},
    ]
    words = words_from_chunks(chunks)
    check("words parsed", len(words) == 5 and words[0]["text"] == "Deep")

    cues = cues_from_words(words, words_per_group=3)
    check("word grouping (3 + gap-break)", len(cues) == 3)
    check("gap starts new cue", cues[2]["text"] == "stands")

    ass = build_ass(cues, video_w=1080, video_h=1920)
    check("ASS header PlayRes", "PlayResX: 1080" in ass and "PlayResY: 1920" in ass)
    check("ASS style Montserrat Black", "Montserrat Black,92" in ass)
    check("ASS karaoke highlight", "\\c&H0000D4FF&" in ass)  # #FFD400 -> BGR 00D4FF
    check("ASS all-caps", "DEEP" in ass)

    srt = build_srt(cues, all_caps=True)
    reparsed = parse_srt(srt)
    check("SRT round-trip", len(reparsed) == len(cues))

    # --- transcript-first mode: SRT slicing + hook overlay -----------------------
    from shorts.captions import regroup_karaoke, slice_cues

    full = [{"start_ms": 0, "end_ms": 2000, "text": "one two"},
            {"start_ms": 2000, "end_ms": 4000, "text": "three four"},
            {"start_ms": 10000, "end_ms": 12000, "text": "outside"}]
    window = slice_cues(full, 1.0, 5.0)
    check("slice_cues drops non-overlapping", len(window) == 2)
    check("slice_cues rebases to window", window[0]["start_ms"] == 0 and window[1]["start_ms"] == 1000)
    check("slice_cues clamps to window", window[0]["end_ms"] == 1000)

    groups = regroup_karaoke(window, 3)
    check("regroup produces karaoke cues", len(groups) >= 1 and groups[0].get("words"))

    # keyword coloring: green (#00E676 -> BGR &H0076E600) on inactive keyword
    # words; the karaoke highlight still wins while the keyword is active.
    # ("deep" sits in the 3-word group "Deep in the", so it renders inactive
    # while "in"/"the" are spoken.)
    ass_kw = build_ass(cues, video_w=1080, video_h=1920, keywords=["deep", "cut off"])
    check("keyword colored when inactive", "{\\c&H0076E600&}DEEP" in ass_kw)
    check("karaoke highlight wins on active keyword", "{\\c&H0000D4FF&}DEEP" in ass_kw)
    check("keywords off by config",
          "&H0076E600" not in build_ass(cues, {"keywordHighlight": False},
                                        video_w=1080, video_h=1920, keywords=["deep"]))

    ass_hook = build_ass(cues, video_w=1080, video_h=1920, hook_text="First time in 50 years")
    check("hook style present", "Style: Hook," in ass_hook)
    check("hook event over opening", "Dialogue: 1,0:00:00.00,0:00:02.80,Hook" in ass_hook)
    check("no hook -> no Hook style", "Hook" not in build_ass(cues, video_w=1080, video_h=1920))

    # --- AI segment metadata passthrough ------------------------------------------
    segs, strategy = resolve_segments(
        [{"partNumber": 1, "startMs": 0, "endMs": 30000, "title": "A",
          "hook_line": "hooky", "virality": {"overall": 88},
          "keywords": ["x"], "reason": "r"}],
        None, None, 60.0,
    )
    check("explicit segments keep AI metadata",
          segs[0].get("hook_line") == "hooky" and segs[0]["virality"]["overall"] == 88)

    # --- render filter builder (string-level, no ffmpeg) ------------------------
    from shorts.render import build_convert_filter, normalize_render_style
    f, complex_ = build_convert_filter("16:9", "9:16", 1080, 1920, "BLUR_FILL")
    check("BLUR_FILL uses filter_complex + [vout]", complex_ and f.endswith("[vout]"))
    f, complex_ = build_convert_filter("16:9", "9:16", 1080, 1920, "CROP_FILL")
    check("CROP_FILL simple vf", not complex_ and "crop=1080:1920" in f)
    check("no sharpen by default", "unsharp" not in f and "lanczos" not in f)
    f, _ = build_convert_filter("16:9", "9:16", 1080, 1920, "CROP_FILL", sharpen=True)
    check("sharpen adds lanczos+unsharp", "flags=lanczos" in f and "unsharp" in f)
    check("style normalisation", normalize_render_style("weird") == "BLUR_FILL")

    # --- upscale: graceful degradation without torch/GPU --------------------------
    from shorts.upscale import UpscaleUnavailable, _load_model
    try:
        _load_model()
        check("upscale model loads or raises UpscaleUnavailable", True)
    except UpscaleUnavailable:
        check("upscale model loads or raises UpscaleUnavailable", True)
    except Exception:
        check("upscale model loads or raises UpscaleUnavailable", False)

    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED: {failures}")
        return 1
    print("all offline checks passed")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="test_input.json", help="job input JSON file")
    parser.add_argument("--offline", action="store_true", help="run offline unit checks only")
    args = parser.parse_args()

    sys.exit(run_offline_checks() if args.offline else run_job_from_file(args.input))
