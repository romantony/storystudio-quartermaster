-- 017_asset_merge — per-frame audio/video merge as its own generator agent
-- (2026-09-20, merge-parallelization follow-up to docs/qm-orchestrator-
-- three-project-run-analysis-2026-09-19.md).
--
-- Merge (clip + narration -> one clip, ffmpeg `-c:v copy` mux) used to happen
-- serially, one frame at a time, inside the postprod-lite one-shot tail —
-- after every OTHER per-frame asset had already finished, on ONE pod, while
-- postprod-lite's other pods sat idle for the whole ~30-40 min generation
-- phase. It is exactly as parallelizable as wan2-i2v/dreamx-refine/mmaudio
-- already are: independent per frame, needing only that frame's own clip and
-- its narration. This agent runs it during generation instead, on the new
-- postprod-lite-v2 endpoint's shared pod pool (postprod-lite-v2/handler.py's
-- existing standalone `mode=="merge"` entrypoint, unchanged) — the one-shot
-- tail then receives an already-merged clip per frame (`preMerged: true`)
-- and skips straight to concat.
--
-- Only planned when the project has a motion model at all (assets/plan.ts):
-- an `motionEngine:'animate'` project has no per-frame clip to pre-merge —
-- Ken Burns only happens inside the tail itself — so those projects are
-- untouched and keep merging in the one-shot, same as before this agent
-- existed.

CREATE TABLE asset_merge PARTITION OF assets FOR VALUES IN ('merge');

-- @DOWN

DROP TABLE IF EXISTS asset_merge;
