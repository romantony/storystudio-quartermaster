-- 008_result_callback — what §6.7's result assembler + callback need on
-- `projects` (M5, 2026-09-15).
--
-- `result` (001_init) holds the §9.6 document itself. Delivery state lives
-- next to it: a cohort is not finished until every project's callback has
-- succeeded or exhausted its retries (impl plan §6.7), and each attempt is
-- kept so a failed delivery can be diagnosed without log spelunking.
-- created_at feeds §9.6 metrics.queuedMs (request arrival -> first
-- submission); rows that predate this migration get the migration time,
-- which only affects already-finished test projects.

ALTER TABLE projects
  ADD COLUMN created_at        timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN finished_at       timestamptz,
  ADD COLUMN callback_status   text
    CHECK (callback_status IN ('pending', 'delivered', 'rejected', 'exhausted', 'skipped')),
  ADD COLUMN callback_attempts jsonb NOT NULL DEFAULT '[]';

-- @DOWN

ALTER TABLE projects
  DROP COLUMN IF EXISTS callback_attempts,
  DROP COLUMN IF EXISTS callback_status,
  DROP COLUMN IF EXISTS finished_at,
  DROP COLUMN IF EXISTS created_at;
