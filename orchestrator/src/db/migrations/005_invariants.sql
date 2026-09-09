-- 005_invariants — the structural guarantees from impl plan §4.5.
--
-- The spec's §10 does not encode these; the plan is explicit that they belong
-- "as CHECK constraints or as a verify_invariants() function the watchdog
-- calls". The two that are a single-table "at most one" become partial unique
-- indexes (enforced continuously, for free). The cross-table ones become a
-- function the watchdog (§6.9) calls on its tick.

-- "One step at a time" is the whole model. At most one live step per cohort —
-- anything not pending / complete / failed is live.
CREATE UNIQUE INDEX steps_one_live_per_cohort ON steps (cohort_id)
  WHERE status IN ('scaling', 'ready', 'running', 'generated', 'gating', 'draining');

-- §2.2's queue-behind rule: at most one running cohort, account-wide.
-- Unique on `status` among rows where status='running' ⇒ at most one such row.
CREATE UNIQUE INDEX cohorts_one_running ON cohorts (status)
  WHERE status = 'running';

-- Rework caps (§12.2) — a runaway cohort consumes the window.
ALTER TABLE jobs ADD CONSTRAINT jobs_attempts_cap CHECK (attempts <= 2);
ALTER TABLE jobs ADD CONSTRAINT jobs_quality_attempts_cap CHECK (quality_attempts <= 2);

-- Cross-table invariants the watchdog polls. Returns one row per violation;
-- an empty result means the database is consistent.
CREATE FUNCTION verify_invariants()
  RETURNS TABLE (invariant text, detail text)
  LANGUAGE sql STABLE AS $$
  -- An endpoint marked held must have a live step that holds it.
  SELECT 'endpoint_held_without_live_step',
         format('endpoint %s held_by %s#%s', e.endpoint_id, e.held_by_cohort, e.held_by_step)
    FROM endpoint_state e
   WHERE e.held_by_step IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM steps s
        WHERE s.cohort_id = e.held_by_cohort
          AND s.seq = e.held_by_step
          AND s.status IN ('scaling', 'ready', 'running', 'generated', 'gating', 'draining')
     )
  UNION ALL
  -- A completed project may not have a leaf job without an asset URL and a
  -- non-fail verdict. This is the rule the "successful-looking partial
  -- completion" incidents violated (§12.1).
  SELECT 'completed_project_with_ungated_leaf',
         format('project %s job %s', j.project_id, j.id)
    FROM jobs j
    JOIN projects p ON p.id = j.project_id
    JOIN (SELECT cohort_id, max(seq) AS leaf_seq FROM steps GROUP BY cohort_id) lf
      ON lf.cohort_id = j.cohort_id
   WHERE p.status = 'completed'
     AND j.step_seq = lf.leaf_seq
     AND (j.output ->> 'url' IS NULL OR j.quality_status = 'fail');
$$;

-- @DOWN

DROP FUNCTION IF EXISTS verify_invariants();
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_quality_attempts_cap;
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_attempts_cap;
DROP INDEX IF EXISTS cohorts_one_running;
DROP INDEX IF EXISTS steps_one_live_per_cohort;
