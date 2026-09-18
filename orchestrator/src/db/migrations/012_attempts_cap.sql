-- Raise `jobs_attempts_cap` so it can accommodate the resource-exhaustion
-- retry ceiling.
--
-- Real incident, 2026-09-18 (project js7efef-rerun-20260918, job 1276): a
-- qwen-image-gen job failed with CUDA OOM at attempts=2. `retryCeiling()`
-- returns `maxResourceAttempts` (5) for that error class, so
-- markFailedOrRetry's `WHERE attempts < 5` guard passed and it tried to write
-- attempts=3 — which 005's `CHECK (attempts <= 2)` rejected. The UPDATE threw,
-- reconcileTick aborted before it could fall through to markTerminal, and the
-- job stayed `submitted` forever: retried every ~5 s, log spammed once per
-- tick, and all 64 downstream jobs of that project wedged behind it. A
-- deadlock is strictly worse than the dropped frame the ceiling was raised to
-- prevent.
--
-- The 005 cap encodes §12.2's "a runaway cohort consumes the window" rule; the
-- intent is a hard stop, not the number 2 specifically. 10 is comfortably
-- above any sane ORCH_MAX_RESOURCE_ATTEMPTS while still bounding a runaway.
--
-- INVARIANT: this must stay >= JOBS_ATTEMPTS_HARD_CAP in db/repo/jobs.ts,
-- which is what actually clamps the write. Change them together.

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_attempts_cap;
ALTER TABLE jobs ADD CONSTRAINT jobs_attempts_cap CHECK (attempts <= 10);

-- @DOWN
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_attempts_cap;
ALTER TABLE jobs ADD CONSTRAINT jobs_attempts_cap CHECK (attempts <= 2);
