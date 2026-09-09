-- 001_init — the orchestrator's core schema.
--
-- This is the Architecture Specification (Draft 4) §10 "Postgres schema",
-- reproduced verbatim: cohorts, projects, steps, endpoint_state, jobs,
-- quality_verdicts, and the five partial indexes exactly as the spec prints
-- them. Every addition this build needs is a later migration (002+), never an
-- edit here — 001 is the schema of record.
--
-- Spec: https://claude.ai/code/artifact/1ee33d6b-b99b-45cd-8717-e082b76ec008 (§10)

CREATE TABLE cohorts (
  id            text PRIMARY KEY,          -- 'win_2026_09_01_18'
  opens_at      timestamptz NOT NULL,
  closes_at     timestamptz NOT NULL,
  status        text NOT NULL,             -- open|running|completed|failed
  current_step  int,
  started_at    timestamptz,
  finished_at   timestamptz
);

CREATE TABLE projects (
  id           text PRIMARY KEY,
  cohort_id    text REFERENCES cohorts(id),
  request_id   text UNIQUE NOT NULL,       -- idempotency
  tier         text NOT NULL,
  language     text NOT NULL,
  status       text NOT NULL,
  request      jsonb NOT NULL,
  result       jsonb,
  callback_url text
);

CREATE TABLE steps (
  cohort_id      text REFERENCES cohorts(id) ON DELETE CASCADE,
  seq            int NOT NULL,             -- 1..13, the plan's order
  name           text NOT NULL,
  endpoint_id    text NOT NULL,
  workers_target smallint NOT NULL,        -- 25 head, 10 tail
  gate           text,                       -- image|motion|assembly|NULL
  drain_after    boolean NOT NULL DEFAULT true,
  status         text NOT NULL,
       -- pending|scaling|ready|running|generated|gating|draining|complete|failed
  job_total int, job_completed int, job_failed int,
  warm_at    timestamptz,                    -- workersReady == target
  started_at timestamptz, finished_at timestamptz,
  PRIMARY KEY (cohort_id, seq)
);

-- what the RunPod agent believes it holds, and when it last verified it
CREATE TABLE endpoint_state (
  endpoint_id    text PRIMARY KEY,
  workers_max    smallint NOT NULL DEFAULT 0,
  workers_min    smallint NOT NULL DEFAULT 0,
  workers_ready  smallint NOT NULL DEFAULT 0,
  held_by_cohort text,
  held_by_step   int,
  observed_at    timestamptz NOT NULL       -- from RunPod, never assumed
);

CREATE TABLE jobs (
  id          bigserial PRIMARY KEY,
  project_id  text REFERENCES projects(id) ON DELETE CASCADE,
  cohort_id   text NOT NULL,
  step_seq    int NOT NULL,
  seq         int NOT NULL,                -- generation order within the step
  frame_id    text,
  status      text NOT NULL DEFAULT 'planned',
              -- planned|submitted|complete|failed|regated|requeued
  deps_remaining  int NOT NULL DEFAULT 0,
  tried_rungs     text[] NOT NULL DEFAULT '{}',
  attempts        smallint NOT NULL DEFAULT 0,
  quality_status  text,                      -- pass|fail|marginal|ungated
  quality_attempts smallint NOT NULL DEFAULT 0,
  runpod_job_id   text,                      -- from /run; survives restart
  submitted_at    timestamptz,
  completed_at    timestamptz,               -- these two give secPerJob
  input       jsonb NOT NULL,
  output      jsonb,
  error       jsonb
);

CREATE TABLE quality_verdicts (
  id         bigserial PRIMARY KEY,
  job_id     bigint REFERENCES jobs(id) ON DELETE CASCADE,
  gate       text NOT NULL,               -- image|motion|assembly
  attempt    smallint NOT NULL,
  verdict    text NOT NULL,
  issues     jsonb NOT NULL DEFAULT '[]',
  action     text,
  rule_candidate boolean NOT NULL DEFAULT false,
  cost_usd   numeric(8,5),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- what the scheduler asks on every tick
CREATE INDEX jobs_step_ready ON jobs (cohort_id, step_seq, seq)
  WHERE status = 'planned' AND deps_remaining = 0;
CREATE INDEX jobs_inflight ON jobs (cohort_id, step_seq)
  WHERE status = 'submitted';
CREATE INDEX jobs_ungated ON jobs (cohort_id, step_seq)
  WHERE status = 'complete' AND quality_status IS NULL;
CREATE UNIQUE INDEX jobs_runpod_id ON jobs (runpod_job_id)
  WHERE runpod_job_id IS NOT NULL;
CREATE INDEX jobs_by_project ON jobs (project_id, status);

-- @DOWN

DROP TABLE IF EXISTS quality_verdicts;
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS endpoint_state;
DROP TABLE IF EXISTS steps;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS cohorts;
