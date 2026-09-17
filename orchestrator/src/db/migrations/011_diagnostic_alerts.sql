-- 011_diagnostic_alerts — Sonnet-backed read-only diagnostic assistant
-- (2026-09-17). Fires on existing failure signals only (watchdog orphaned
-- workers, a project finalizing failed/partial, a generator stall timeout)
-- — never a blind poll. The orchestrator gathers the structured signal
-- itself (fleet health, endpoint staleness, recent failures); Sonnet only
-- reasons over that JSON snapshot and returns a diagnosis, never calls
-- RunPod/Postgres itself. See src/diagnostics/diagnose.ts.
CREATE TABLE diagnostic_alerts (
  id           bigserial PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  severity     text NOT NULL,        -- info | warning | critical (Sonnet's own classification)
  trigger      text NOT NULL,        -- watchdog_orphan | project_failed | project_partial | stall_timeout
  project_id   text,
  cohort_id    text,
  endpoint_id  text,
  signals      jsonb NOT NULL,       -- the structured snapshot sent to Sonnet
  message      text NOT NULL,        -- Sonnet's diagnosis, shown on the dashboard
  model        text NOT NULL
);

CREATE INDEX diagnostic_alerts_created_at_idx ON diagnostic_alerts (created_at DESC);

-- @DOWN
DROP TABLE diagnostic_alerts;
