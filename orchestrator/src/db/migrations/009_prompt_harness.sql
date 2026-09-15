-- 009_prompt_harness — prompt harness & guardrails (impl plan:
-- docs/qm-orchestrator-prompt-harness-implementation-plan.md §9.1).
--
-- Supersedes 004_rules.sql's `quality_rules`, which was never wired up by
-- any caller. That table is left in place (dropping it is a separate,
-- later migration) rather than folded into this one, so this migration's
-- `up`/`down` stays a clean add/remove pair.
--
-- harness_guardrails: versioned, domain-separated (image vs video) rules.
-- A row here can OVERRIDE a seed guardrail (same id, higher version) or add
-- a newly promoted one — see harness/guardrails/store.ts's merge logic.
CREATE TABLE harness_guardrails (
  id            text NOT NULL,
  version       int  NOT NULL,
  domain        text NOT NULL CHECK (domain IN ('image','video')),
  profile       text NOT NULL,
  status        text NOT NULL CHECK (status IN ('proposed','probation','active','retired')),
  severity      text NOT NULL CHECK (severity IN ('block','fix','warn')),
  title         text NOT NULL,
  detector      jsonb NOT NULL,
  fix_target    text NOT NULL,
  corrective    jsonb NOT NULL,
  instruction   text NOT NULL,
  evidence      jsonb NOT NULL DEFAULT '[]',
  replay        jsonb,
  created_by    text NOT NULL DEFAULT 'promotion',
  created_at    timestamptz NOT NULL DEFAULT now(),
  activated_at  timestamptz,
  retired_at    timestamptz,
  PRIMARY KEY (id, version)
);
CREATE INDEX harness_guardrails_active ON harness_guardrails (domain, profile) WHERE status IN ('active','probation');

-- harness_profiles: calibrated per-move/per-capability agreement rates
-- (plan §7.5's sweep). Seed capability tables live in code
-- (harness/profiles/*.ts); this table is where CALIBRATED overrides land.
CREATE TABLE harness_profiles (
  profile       text NOT NULL,
  capability    text NOT NULL,      -- 'move:push_in' | 'motion_level:high'
  status        text NOT NULL,      -- allowed | probation | banned
  downgrade_to  text,
  samples       int NOT NULL DEFAULT 0,
  agreements    int NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile, capability)
);

-- harness_findings: everything observed — lint hits, tool validations, QA
-- issues, probe mismatches — the raw material for guardrail promotion.
CREATE TABLE harness_findings (
  id              bigserial PRIMARY KEY,
  cohort_id       text,
  project_id      text,
  frame_id        text,
  job_id          bigint REFERENCES jobs(id) ON DELETE SET NULL,
  domain          text NOT NULL CHECK (domain IN ('image','video')),
  profile         text NOT NULL,
  source          text NOT NULL,     -- lint | tool | image_gate | motion_gate | probe | calibration
  signature       text NOT NULL,     -- e.g. 'video.direction.reversed'
  guardrail_id    text,              -- rule that detected/should have prevented it (null = uncovered)
  confidence      text NOT NULL DEFAULT 'high',
  prompt          text,
  contract        jsonb,
  evidence        jsonb NOT NULL DEFAULT '{}',
  asset_url       text,
  guardrail_set   text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX harness_findings_sig ON harness_findings (domain, profile, signature, created_at);
CREATE INDEX harness_findings_uncovered ON harness_findings (domain, signature) WHERE guardrail_id IS NULL;

-- harness_corrections: the corrective measure applied for a finding, and
-- what happened on the next attempt.
CREATE TABLE harness_corrections (
  id              bigserial PRIMARY KEY,
  finding_id      bigint REFERENCES harness_findings(id) ON DELETE CASCADE,
  measure         jsonb NOT NULL,
  prompt_before   text,
  prompt_after    text,
  contract_before jsonb,
  contract_after  jsonb,
  outcome         text NOT NULL DEFAULT 'pending',  -- pending | passed | failed | accepted_flagged
  outcome_job_attempt smallint,
  outcome_score   numeric(4,2),
  approved_example boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);
CREATE INDEX harness_corrections_pending ON harness_corrections (outcome) WHERE outcome = 'pending';

-- @DOWN

DROP TABLE IF EXISTS harness_corrections;
DROP TABLE IF EXISTS harness_findings;
DROP TABLE IF EXISTS harness_profiles;
DROP TABLE IF EXISTS harness_guardrails;
