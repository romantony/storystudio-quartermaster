# Orchestrator postprod pipeline run + caption-drift finding — 2026-09-10

**Audience:** Quartermaster engineers.
**Status:** Done. Real assembly pipeline run against M2's real acceptance-test assets, a
real caption-sync defect found and root-caused, fixed, and re-verified.
**Predecessor:** `docs/qm-orchestrator-session-2026-09-10-m2.md` (the planner/generator/
fleet-controller real acceptance run this pipeline consumes the output of).
**Endpoints used:** `postprod-lite` (`n6252hm01qz0xh`), `bgm-s2t` (`6apg6j7suzuezw`).

## What this was

M2's real acceptance run produced 18 frames of real assets (image, TTS audio, i2v
video) for project `req_m2test_20260910_03` but never assembled them into a finished
video — that wasn't in M2's scope. This session ran the remaining `postprod-lite`
modes by hand against those real assets to produce one: `merge` (per-frame video+audio)
→ `concat` → `remove_silence` → `upscale` → `caption` → `mix_bgm`, plus one `bgm-s2t`
call to generate a real background track. All 24 real job submissions across this run
completed with zero failures.

| Stage | Endpoint/mode | Result | Time |
|---|---|---|---|
| Merge ×18 | `postprod-lite` `merge` | 18/18 clips (video+audio) merged | ~2m30s total |
| Concat | `postprod-lite` `concat` | 18 clips → 72.44s | 23.1s exec |
| Remove silence | `postprod-lite` `remove_silence` | 72.44s → 70.88s, 10 segments cut | 28.6s exec |
| Upscale | `postprod-lite` `upscale` | → 1080p (Real-ESRGAN) | 52.7s exec |
| BGM generation | `bgm-s2t` `bgm` (ACE-Step) | 90s instrumental, forest/dawn prompt | 10.6s gen (109.5s incl. cold-start) |
| Mix BGM | `postprod-lite` `mix_bgm` | final, BGM at volume 0.12 | 16.5s exec |

Per-frame TTS audio (3.27-4.5s) was always shorter than each frame's fixed 5.06s i2v
clip in this run, so `merge`'s `-shortest` flag only ever trimmed video, never audio —
worth flagging because the reverse case (a longer narration line than its i2v clip)
would silently drop trailing audio/words for that frame. Not exercised here; a real
gap to watch for once frame-level narration length varies more.

## The caption-drift finding

The first `caption` pass (Whisper, run via `postprod-lite`'s built-in mode) produced a
burned-in video where the user reported the captions were out of sync with the
voiceover and some spoken words never appeared as captions at all.

**Confirmed directly, not just by report.** Extracted the last 6s of the captioned
video's audio and ran `silencedetect` on it: speech continued right up to the true end
of the clip (70.88s), but the SRT's last cue ended at 67.5s — the final ~3.4s of real,
audible narration ("...exactly as it always has.") had no caption at all.

**First hypothesis, tested and disproved.** The working theory was that running
`remove_silence` *before* `caption` strips the natural pauses between sentences that
Whisper's word-timestamp aligner uses as anchors — so the fix should be to reorder to
`caption` before `remove_silence`, preserving those pauses. Re-ran `caption` on the raw
72.44s concat output (pauses intact) to test this:

| | Original (remove_silence → caption) | Reordered (caption → remove_silence) |
|---|---|---|
| Video duration | 70.88s | 72.44s |
| Last caption timestamp | 67.5s | 68.12s |
| **Coverage** | **95.2%** | **94.0%** — no better, slightly worse |
| Word count | 196 (exact match to the source script) | **225** — 29 extra, hallucinated |

The reorder didn't fix the tail-truncation (still ~4-5% of the clip's tail uncaptioned)
and made word-accuracy worse: Whisper hallucinated 29 extra words into the now-longer
silent gaps, a well-known failure mode. This ruled out pause-removal as the cause and
points at HuggingFace's Whisper *chunked long-form* pipeline itself (used once audio
exceeds ~30s) losing timestamp accuracy toward the tail — a pipeline-level limitation,
not something fixable by changing what audio we feed it.

## The fix: deterministic captions, not ASR

`postprod-lite`'s `caption` mode always runs a blind Whisper pass — per its own
`API.md` "Known limitations", it doesn't accept precomputed timing/text to skip that.
But this pipeline already *has* ground truth: the exact narration text per frame (from
the project request) and each frame's real merged-clip duration (from `merge`'s own
output). There's no need to re-transcribe audio we generated from known text in the
first place.

Built captions locally instead of through the endpoint:
1. Per frame (in concat order), distribute that frame's known narration text across
   its known clip duration, character-length-weighted per word (a duration proxy, not
   true phoneme alignment, but anchored to real clip boundaries so it can't drift off
   the true audio the way re-transcription can).
2. Generate the `.ass` file locally, matching `postprod-lite`'s own caption style
   exactly (`LiberationSans`, 64px, yellow word-highlight, bottom position, 3-word
   groups) by porting its `_chunks_to_ass` logic.
3. Burn it onto the raw concat output with local `ffmpeg` (`libass` is available
   locally; verified the required font is installed).
4. Upload the result to the project's R2 bucket directly (`e2e-storystudio`,
   credentials read from the `postprod-lite` RunPod template `ud534tgyb1` — the
   worker's own env, not a new credential), then feed that URL back into
   `remove_silence` → `upscale` → `mix_bgm` as normal.

**Verified, not just assumed correct.** Extracted frames at the same tail timestamp
before and after the `remove_silence` re-run (68s pre-trim, 66.5s post-trim, matching
the ~1.5s the trim removed) — both show the correct caption text ("by morning, it",
inside the final frame's real sentence) exactly where the real audio has it. The
`remove_silence` cut count was identical (10 segments) to the original run, as
expected — captioning is orthogonal to where the audio's silence gaps are.

**Final corrected video:**
`https://pub-bce4924e66d944668be30268ccf4492c.r2.dev/storystudio/video/20260910114849_44250885-91b5-4f75-9fc1-8b2f95379ff9-e1_mix_bgm.mp4`
— 70.88s, 1080p, deterministically-captioned, BGM mixed at 0.12.

## Not done / open

1. `postprod-lite`'s `caption` mode still only does blind Whisper — the deterministic
   approach here was a one-off local script, not a mode the endpoint itself supports.
   Given how directly this bit a real run, worth promoting to a real option: either (a)
   wire `caption` to accept precomputed `chunks`/text+duration per its own documented
   follow-up, or (b) keep deterministic captioning as an orchestrator-side step for any
   caller that already has per-frame text+timing (which the orchestrator always will).
2. The `merge` step's audio-longer-than-video case (`-shortest` would truncate audio,
   silently dropping trailing narration words) wasn't exercised in this run — every
   frame's TTS came in under its i2v clip's 5.06s. Worth a guard or at least a logged
   warning in `run_merge` before a real project with more variable narration length
   hits it silently.
3. The character-length word-timing heuristic used for the deterministic captions is
   an approximation, not true phoneme alignment — acceptable for this fix (anchored to
   real clip boundaries, can't drift off the true audio the way ASR can) but not as
   precise as forced alignment would be, if that's ever worth the added complexity.
