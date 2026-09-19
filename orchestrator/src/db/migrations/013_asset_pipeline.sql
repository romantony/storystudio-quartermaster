-- 013_asset_pipeline — the per-asset generator model (2026-09-19).
--
-- Replaces the cohort/step-graph model's "one project advances step by step,
-- the fleet idles whenever one step is the bottleneck" with continuous,
-- cross-project GPU saturation:
--
--   * a project submitted to the orchestrator writes EVERY asset it needs as
--     a row in that asset's own table, up front;
--   * one generator agent per asset type polls ITS OWN table for rows that
--     are ready and queues them against that endpoint's own pod limit;
--   * handoff is by writing the next table — a finished asset writes its CDN
--     url into every downstream asset's row, which becomes runnable once all
--     of its required inputs are present. No project sequencing anywhere.
--
-- WHY ONE PARTITIONED TABLE AND NOT EIGHT SEPARATE ONES: the operator's model
-- is "each agent polls its own table", and a LIST partition IS its own real
-- table — `asset_wan2_i2v` can be selected, locked and explained on its own,
-- and an agent's claim query only ever touches its partition. What it buys
-- over eight hand-copied CREATE TABLEs is one column definition, one status
-- vocabulary and one set of constraints: adding a column later is one ALTER,
-- not eight that can drift. postgres:16 on the VPS (docs/qm-orchestrator-vps-
-- access.md) — partitioned unique indexes and ON CONFLICT inference both
-- require >= 11, so this is well inside support.
--
-- This migration is ADDITIVE ONLY. cohorts/steps/jobs are untouched and the
-- cohort path keeps running exactly as before; ORCH_PIPELINE_MODE (config.ts,
-- default 'cohort') decides which path a request takes.

-- ── the asset tables ─────────────────────────────────────────────────────

CREATE TABLE assets (
  id              bigserial,
  -- Partition key. One value per generator agent (src/assets/kinds.ts).
  asset_kind      text NOT NULL,
  project_id      text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- '*' means "project-scoped, not one per frame" — the project's BGM track,
  -- and the postprod-lite one-shot that assembles the whole project. NOT NULL
  -- with a sentinel rather than a nullable column so the (kind, project,
  -- frame) uniqueness that makes a handoff write idempotent is a plain unique
  -- index that ON CONFLICT can infer — a nullable frame_id would make every
  -- project-scoped row distinct from every other under NULL semantics.
  --
  -- A project-scoped row is NOT released by the per-frame handoff mechanism:
  -- its fan-in spans every frame, which a `sources` map keyed by asset kind
  -- cannot express. The project compiler arms it explicitly instead, which is
  -- exactly the division of labour the design asks for — agents handle
  -- per-frame handoff, the compiler handles the project. Hence the
  -- `frame_id <> '*'` carve-outs below and in db/repo/assets.ts.
  frame_id        text NOT NULL DEFAULT '*',
  -- The frame's narrative position, so a project's clips concat in order and
  -- an agent's queue drains in a stable, explainable order.
  seq             int NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'blocked',
  -- blocked   waiting for required_inputs (the row exists, nothing to do yet)
  -- pending   every required input present — "not started", the agent's queue
  -- submitted handed to the provider, provider_job_id held
  -- complete  asset_url written; downstream tables already handed off to
  -- failed    terminal after the retry budget, or unrunnable
  -- cancelled compiler killed a stuck provider job; resubmitted as rework
  endpoint_id     text NOT NULL,
  provider        text NOT NULL DEFAULT 'runpod',
  -- Which upstream asset kinds must appear in `sources` before this row is
  -- runnable. The plan writes it per project (options change the chain), so
  -- the fan-in rule lives in data, not in the agent's code.
  required_inputs text[] NOT NULL DEFAULT '{}',
  -- {"<asset_kind>": {"url": "...", "durationS": 3.2}} — written by the
  -- UPSTREAM agent as it completes. This IS the handoff.
  sources         jsonb NOT NULL DEFAULT '{}',
  -- The frame's own generation parameters (steps/builders/types.ts's
  -- FrameJobInput), copied from the request at submission time.
  input           jsonb NOT NULL DEFAULT '{}',
  -- Reserved for an asset kind that needs more than one provider call to
  -- produce its asset, walked inside one row rather than needing a table per
  -- call. No kind uses it today — postprod-lite's merge/remove-silence/concat
  -- chain became a single `postprod` call on the worker instead (see
  -- assets/README.md) — but the machinery is cheap and the Remotion overlay,
  -- when it lands, is the obvious next user.
  stage           text,
  stages          text[] NOT NULL DEFAULT '{}',
  output          jsonb,
  asset_url       text,
  duration_s      numeric(10,3),
  error           jsonb,
  attempts        smallint NOT NULL DEFAULT 0,
  -- Compiler-driven "cancel the stuck job and resubmit as rework" cycles.
  -- Separate from `attempts` and separately capped: a rework CONTINUES the
  -- attempt budget rather than resetting it, so a genuinely broken asset
  -- cannot resubmit forever (the deadlock lesson from migration 012).
  reworks         smallint NOT NULL DEFAULT 0,
  provider_job_id text,
  claimed_at      timestamptz,
  submitted_at    timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- The compiler's staleness clock. Every write touches it.
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- Both keys carry the partition key, as a partitioned table requires.
  PRIMARY KEY (asset_kind, id),
  UNIQUE (asset_kind, project_id, frame_id),

  CONSTRAINT assets_status_vocab CHECK (
    status IN ('blocked', 'pending', 'submitted', 'complete', 'failed', 'cancelled')
  ),
  -- INVARIANT: must stay >= ASSET_ATTEMPTS_HARD_CAP in db/repo/assets.ts,
  -- which is what actually clamps the write. Change them together — an app
  -- ceiling above the DB CHECK is exactly what deadlocked the cohort path on
  -- 2026-09-18 (see migration 012's header).
  CONSTRAINT assets_attempts_cap CHECK (attempts <= 10),
  CONSTRAINT assets_reworks_cap  CHECK (reworks <= 3),
  -- The "successful-looking partial completion" rule (spec §12.1), enforced
  -- continuously instead of being audited afterwards: 41 of 163 "successful"
  -- shots on 2026-08-17 were silent degradations with no asset behind them.
  CONSTRAINT assets_complete_has_url CHECK (status <> 'complete' OR asset_url IS NOT NULL)
) PARTITION BY LIST (asset_kind);

-- One partition per generator agent. The name is what that agent polls.
CREATE TABLE asset_qwen_image_gen PARTITION OF assets FOR VALUES IN ('qwen-image-gen');
CREATE TABLE asset_qwen_edit      PARTITION OF assets FOR VALUES IN ('qwen-edit');
CREATE TABLE asset_tts            PARTITION OF assets FOR VALUES IN ('tts');
CREATE TABLE asset_wan2_i2v       PARTITION OF assets FOR VALUES IN ('wan2-i2v');
CREATE TABLE asset_bgm            PARTITION OF assets FOR VALUES IN ('bgm');
CREATE TABLE asset_dreamx_refine  PARTITION OF assets FOR VALUES IN ('dreamx-refine');
CREATE TABLE asset_mmaudio        PARTITION OF assets FOR VALUES IN ('mmaudio');
CREATE TABLE asset_postprod_lite  PARTITION OF assets FOR VALUES IN ('postprod-lite');

-- What each agent asks on every tick: its own queue, oldest first, retries
-- last (the cohort path's ORDER BY attempts rule, kept).
CREATE INDEX assets_queue ON assets (asset_kind, attempts, seq, created_at)
  WHERE status = 'pending';
-- How many of this kind are on the endpoint right now (the pod-limit check),
-- and which rows reconcile/staleness scans read.
CREATE INDEX assets_inflight ON assets (asset_kind, updated_at)
  WHERE status = 'submitted';
-- The compiler's fan-in scan: one project's whole asset set.
CREATE INDEX assets_by_project ON assets (project_id, status);
-- The webhook receiver's lookup. Not UNIQUE: a unique index on a partitioned
-- table must carry the partition key, and provider job ids are already
-- globally unique on the provider's side.
CREATE INDEX assets_provider_job ON assets (provider_job_id)
  WHERE provider_job_id IS NOT NULL;

-- ── the project compiler's own state ─────────────────────────────────────

-- The compiler agent sits above the per-asset ones: it waits on a WHOLE
-- project, repairs or reworks what is stuck, and then fires the tail. That is
-- a project-level condition, so it needs project-level state — the asset
-- tables deliberately know nothing about "is this project finished".
CREATE TABLE pipeline_projects (
  project_id       text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'generating',
  -- generating  per-asset agents still working
  -- assembling  every asset present; the tail call is in flight
  -- completed | partial | failed  terminal; `projects.result` holds §9.6
  -- The resolved asset chain for this project (assets/plan.ts's AssetPlan):
  -- which kinds are active and what each one requires. Persisted, not
  -- recomputed, so a mid-flight options change or a code deploy cannot
  -- silently re-route a project that is already half generated.
  plan             jsonb NOT NULL,
  expected_assets  int NOT NULL DEFAULT 0,
  -- The compiler's JSON manifest — the tail's input, written as a file
  -- rather than an inline payload. Inline manifests have twice blown the
  -- 256KB SFN limit on this pipeline (2026-08-12, 2026-08-17).
  manifest         jsonb,
  manifest_url     text,
  -- Which tail call is in flight, for the sequential dispatcher.
  tail_stage       text,
  tail_job_id      text,
  final_url        text,
  attempts         smallint NOT NULL DEFAULT 0,
  last_error       jsonb,
  started_at       timestamptz NOT NULL DEFAULT now(),
  assembling_at    timestamptz,
  completed_at     timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pipeline_projects_status_vocab CHECK (
    status IN ('generating', 'assembling', 'completed', 'partial', 'failed')
  ),
  CONSTRAINT pipeline_projects_attempts_cap CHECK (attempts <= 5)
);

-- The compiler's own tick query.
CREATE INDEX pipeline_projects_live ON pipeline_projects (status, updated_at)
  WHERE status IN ('generating', 'assembling');

-- ── cost ledger ──────────────────────────────────────────────────────────

-- `job_costs` (002) is keyed on `jobs(id)` and cannot hold an asset row, but
-- the per-frame cost number it feeds is a headline metric for this pipeline
-- ($0.045/frame on the 2026-09-18 baseline run). Same columns, same generated
-- `cost_usd`, keyed on the asset instead. The compiler's own tail calls are
-- recorded with asset_id NULL and a project_id, since the tail is not an
-- asset row.
CREATE TABLE asset_costs (
  id                bigserial PRIMARY KEY,
  asset_id          bigint,
  asset_kind        text,
  project_id        text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  frame_id          text,
  endpoint_id       text NOT NULL,
  provider_job_id   text,
  execution_ms      int,               -- RunPod executionTime: billed
  delay_ms          int,               -- RunPod delayTime: queue wait, NOT billed
  worker_rate_usd_s numeric(10,8) NOT NULL,
  cost_usd          numeric(10,6) GENERATED ALWAYS AS
                      (execution_ms / 1000.0 * worker_rate_usd_s) STORED,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- One ledger line per provider job, so a webhook and a reconcile tick racing
-- on the same completion cannot double-bill it.
CREATE UNIQUE INDEX asset_costs_provider_job ON asset_costs (provider_job_id)
  WHERE provider_job_id IS NOT NULL;
CREATE INDEX asset_costs_by_project ON asset_costs (project_id);

-- ── invariants the watchdog polls ────────────────────────────────────────

-- Same contract as 005's verify_invariants(): one row per violation, empty
-- means consistent. Kept as its own function so the cohort path's invariant
-- set stays exactly what it was.
CREATE FUNCTION verify_asset_invariants()
  RETURNS TABLE (invariant text, detail text)
  LANGUAGE sql STABLE AS $$
  -- A row whose required inputs are all present must not still be blocked —
  -- that is a lost handoff, the failure mode this whole model trades for the
  -- step graph's explicit deps_remaining counter.
  -- Project-scoped rows ('*') are excluded: they are armed by the compiler,
  -- not by a handoff, so "blocked with no unmet inputs" is their normal
  -- resting state, not a fault.
  SELECT 'asset_blocked_with_inputs_satisfied',
         format('%s %s/%s', a.asset_kind, a.project_id, a.frame_id)
    FROM assets a
   WHERE a.status = 'blocked'
     AND a.frame_id <> '*'
     AND NOT EXISTS (
       SELECT 1 FROM unnest(a.required_inputs) r WHERE NOT (a.sources ? r)
     )
  UNION ALL
  -- A finished project may not have a leaf asset without a URL.
  SELECT 'pipeline_completed_with_missing_asset',
         format('project %s missing %s/%s', a.project_id, a.asset_kind, a.frame_id)
    FROM assets a
    JOIN pipeline_projects p ON p.project_id = a.project_id
   WHERE p.status = 'completed'
     AND a.status <> 'complete';
$$;

-- @DOWN

DROP FUNCTION IF EXISTS verify_asset_invariants();
DROP TABLE IF EXISTS asset_costs;
DROP TABLE IF EXISTS pipeline_projects;
DROP TABLE IF EXISTS asset_postprod_lite;
DROP TABLE IF EXISTS asset_mmaudio;
DROP TABLE IF EXISTS asset_dreamx_refine;
DROP TABLE IF EXISTS asset_bgm;
DROP TABLE IF EXISTS asset_wan2_i2v;
DROP TABLE IF EXISTS asset_tts;
DROP TABLE IF EXISTS asset_qwen_edit;
DROP TABLE IF EXISTS asset_qwen_image_gen;
DROP TABLE IF EXISTS assets;
