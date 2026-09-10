-- 007_quality_verdict_asset — two gaps the existing quality_verdicts schema
-- didn't cover, found while building M4's gates.
--
-- asset_url: jobs.output is a single mutable slot — once a reworked job
-- re-completes, the FAILED attempt's asset URL is gone for good, recoverable
-- only transiently (between the rework write and the resubmission's
-- completion). Without this column, quality_verdicts records the score and
-- issues for a rejected asset but not what asset was actually rejected.
--
-- weighted_score: the motion gate's image-quality pre-gate (impl plan §6.5 —
-- skip the video VLM call when the source image already scored too low)
-- needs the IMAGE gate's numeric weighted score for the same frame, not just
-- its PASS/REWORK/FAIL verdict string. Nothing in 001_init.sql persisted
-- this number anywhere.

ALTER TABLE quality_verdicts ADD COLUMN asset_url text;
ALTER TABLE quality_verdicts ADD COLUMN weighted_score numeric(4,2);

-- @DOWN

ALTER TABLE quality_verdicts DROP COLUMN IF EXISTS asset_url;
ALTER TABLE quality_verdicts DROP COLUMN IF EXISTS weighted_score;
