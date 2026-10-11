-- 024_docgen — documentary-basic on the doc-gen EC2 instance (2026-10-11).
--
-- One row per StoryStudio documentary request. This is NOT the per-frame asset
-- pipeline: a documentary has no frames and no RunPod jobs of ours — the whole
-- script/asset/assembly run happens inside the instance, which we start, call,
-- follow and stop (src/docgen/).
--
-- `queued` and `starting_instance` exist only here; the instance never reports
-- them. `request_id` is StoryStudio's id; `docgen_request_id` is what we send
-- the instance (equal on attempt 1, '<id>-r2' on a retry) and is what webhooks
-- are matched on.
--
-- The partial unique index is the one-job-at-a-time rule enforced by the
-- database: even if two dispatcher ticks race, only one row can be active.

CREATE TABLE docgen_jobs (
  request_id          text PRIMARY KEY,
  docgen_request_id   text NOT NULL UNIQUE,
  job_id              text UNIQUE,
  project_id          text NOT NULL,
  callback_url        text NOT NULL,
  state               text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'starting_instance', 'running', 'awaiting_input', 'succeeded', 'failed', 'cancelled')),
  stage               text,
  seq                 integer NOT NULL DEFAULT 0,
  progress            real,
  message             text,
  request             jsonb NOT NULL,   -- the payload sent to the instance
  status              jsonb,            -- the last status object received
  outputs             jsonb,
  error               jsonb,
  result              jsonb,            -- what we send StoryStudio
  attempts            integer NOT NULL DEFAULT 0,
  callback_status     text
    CHECK (callback_status IN ('pending', 'delivered', 'rejected', 'exhausted', 'skipped')),
  callback_attempts   jsonb NOT NULL DEFAULT '[]',
  queued_at           timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  instance_started_at timestamptz,
  last_heartbeat_at   timestamptz,
  last_polled_at      timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX docgen_jobs_state_queued ON docgen_jobs (state, queued_at);

CREATE UNIQUE INDEX docgen_jobs_one_active ON docgen_jobs ((true))
  WHERE state IN ('starting_instance', 'running', 'awaiting_input');

CREATE TABLE docgen_events (
  id          bigserial PRIMARY KEY,
  request_id  text NOT NULL REFERENCES docgen_jobs (request_id),
  seq         integer NOT NULL,
  event       text NOT NULL,
  body        jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, seq, event)
);

-- @DOWN

DROP TABLE IF EXISTS docgen_events;
DROP TABLE IF EXISTS docgen_jobs;
