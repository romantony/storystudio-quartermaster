-- 002_measurement — what the spec needs but does not declare (impl plan §4.2).
--
-- §9.2's acknowledgement promises estimatedResultAt with estimateBasis
-- "measured", and §8 says to rebuild the cost table from one real cohort.
-- Neither is possible without somewhere to keep the measurements.

-- Rolling per-endpoint, per-step timing. One row per (endpoint, step name);
-- the generator updates it on every terminal job.
CREATE TABLE step_baselines (
  endpoint_id   text NOT NULL,
  step_name     text NOT NULL,
  samples       int  NOT NULL DEFAULT 0,
  median_sec    numeric(8,2),          -- p50 of executionTime, the billed figure
  p95_sec       numeric(8,2),
  last_sec      numeric(8,2),
  warm_sec      numeric(8,2),          -- observed scale-up time, for the estimate's warmS term
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (endpoint_id, step_name)
);

-- Per-job cost facts. The §8 table is rebuilt from this, not re-estimated.
CREATE TABLE job_costs (
  job_id            bigint PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  endpoint_id       text NOT NULL,
  execution_ms      int,               -- RunPod executionTime: billed
  delay_ms          int,               -- RunPod delayTime: queue wait, NOT billed
  worker_rate_usd_s numeric(10,8) NOT NULL,
  cost_usd          numeric(10,6) GENERATED ALWAYS AS
                      (execution_ms / 1000.0 * worker_rate_usd_s) STORED
);

-- Warm-up is 25% of the cohort bill (§8.3). It needs its own ledger line or it
-- stays invisible.
CREATE TABLE allocation_costs (
  cohort_id     text NOT NULL,
  step_seq      int  NOT NULL,
  endpoint_id   text NOT NULL,
  workers       smallint NOT NULL,
  warm_ms       int,                   -- scale-up request -> workersReady == target
  held_ms       int,                   -- workersReady -> workersRunning == 0
  rate_usd_s    numeric(10,8) NOT NULL,
  PRIMARY KEY (cohort_id, step_seq)
);

-- @DOWN

DROP TABLE IF EXISTS allocation_costs;
DROP TABLE IF EXISTS job_costs;
DROP TABLE IF EXISTS step_baselines;
