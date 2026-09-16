-- 010_request_outbox — `ORCH_SCHEDULING_MODE=batch` queue (impl plan: two
-- ingestion modes, 2026-09-16). Unused while schedulingMode stays 'project'
-- (the default) — POST /v1/requests plans+drives immediately in that mode,
-- exactly as before this migration. In 'batch' mode, a validated request is
-- recorded here instead of being planned on arrival; agents/batch-window.ts's
-- cron-driven runBatchWindow() plans every row queued before a window's
-- cutoff together, in one cohort, then drives it once.
CREATE TABLE request_outbox (
  id           bigserial PRIMARY KEY,
  request_id   text NOT NULL UNIQUE,
  project_id   text NOT NULL,
  payload      jsonb NOT NULL,        -- the validated OrchestratorRequest, replayed into plan() as-is
  status       text NOT NULL DEFAULT 'queued',   -- queued | planned | rejected
  cohort_id    text,
  error        text,
  received_at  timestamptz NOT NULL DEFAULT now(),
  planned_at   timestamptz
);

-- runBatchWindow()'s own selection query: queued rows ordered by arrival.
CREATE INDEX request_outbox_status_received ON request_outbox (status, received_at);

-- @DOWN

DROP TABLE IF EXISTS request_outbox;
