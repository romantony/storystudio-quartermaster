-- 014_asset_quality — quality gating for the asset pipeline (2026-09-19).
--
-- The three generation kinds worth gating are the ones a human would look at
-- and reject: `qwen-image-gen`, `qwen-edit` (the frame's still) and
-- `wan2-i2v` (the frame's motion). Everything downstream of them is ffmpeg,
-- which either works or errors.
--
-- HOW IT CHANGES THE FLOW: a gated kind's completion no longer hands off. The
-- row goes `complete` with `quality_status IS NULL` — the QA agent's queue —
-- and only a passing verdict performs the handoff. That is a deliberate
-- difference from the cohort path, which gates concurrently with generation:
-- here the downstream asset is a GPU job on another endpoint, and animating a
-- rejected still is the exact waste the 2026-08-15 "missing kitten" incident
-- was. Costing one QA round-trip of latency to never spend a Wan2 job on a
-- bad image is the right trade.
--
-- A rework does NOT create a new row. It patches the same row's `input` (a
-- rewritten prompt, or a stepped seed) and sets it back to `pending`, so the
-- kind's own agent picks it up under its own pod limit like any other work.

ALTER TABLE assets
  -- NULL = awaiting the gate (only meaningful while status = 'complete').
  -- pass      accepted; the handoff has been written
  -- rework    sent back for another attempt (row is 'pending' again)
  -- exhausted the rework budget ran out and the asset was accepted anyway,
  --           flagged — a project still delivers, the §9.6 result says so
  -- ungated   this kind has no gate, or gating is switched off
  ADD COLUMN quality_status   text
    CHECK (quality_status IN ('pass', 'rework', 'exhausted', 'ungated')),
  -- INVARIANT: must stay >= ASSET_QUALITY_ATTEMPTS_HARD_CAP in
  -- db/repo/assets.ts, which is what clamps the write. Change them together —
  -- an app ceiling above a DB CHECK is what deadlocked the cohort path on
  -- 2026-09-18 (migration 012).
  ADD COLUMN quality_attempts smallint NOT NULL DEFAULT 0
    CHECK (quality_attempts <= 4),
  -- 0-10 weighted score from the last verdict, for reporting and for the
  -- "did gating actually help" question. NULL when nothing scored it.
  ADD COLUMN quality_score    numeric(4,2),
  -- The verdict's issue list, as the rubric produced it.
  ADD COLUMN quality_issues   jsonb NOT NULL DEFAULT '[]';

-- The QA agent's whole work queue: completed assets nobody has judged yet.
CREATE INDEX assets_ungated ON assets (asset_kind, completed_at)
  WHERE status = 'complete' AND quality_status IS NULL;

-- Extends 013's invariant set rather than replacing it: a gated asset that
-- reached a downstream table without a verdict means a handoff escaped the
-- gate, which is the one failure this design must not have.
CREATE FUNCTION verify_asset_quality_invariants()
  RETURNS TABLE (invariant text, detail text)
  LANGUAGE sql STABLE AS $$
  SELECT 'asset_handed_off_before_gating',
         format('%s %s/%s', a.asset_kind, a.project_id, a.frame_id)
    FROM assets a
   WHERE a.status = 'complete'
     AND a.quality_status IS NULL
     AND EXISTS (
       SELECT 1 FROM assets d
        WHERE d.project_id = a.project_id
          AND d.frame_id = a.frame_id
          AND d.sources ? a.asset_kind
     )
  UNION ALL
  -- A row cannot be waiting on the gate and also back in the queue.
  SELECT 'asset_pending_with_gate_verdict_pass',
         format('%s %s/%s', a.asset_kind, a.project_id, a.frame_id)
    FROM assets a
   WHERE a.status = 'pending' AND a.quality_status = 'pass';
$$;

-- @DOWN

DROP FUNCTION IF EXISTS verify_asset_quality_invariants();
DROP INDEX IF EXISTS assets_ungated;
ALTER TABLE assets
  DROP COLUMN IF EXISTS quality_issues,
  DROP COLUMN IF EXISTS quality_score,
  DROP COLUMN IF EXISTS quality_attempts,
  DROP COLUMN IF EXISTS quality_status;
