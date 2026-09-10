# Quartermaster Orchestrator — Implementation Plan

**Audience:** Quartermaster engineers (this repo, plus the new `orchestrator/` service).
**Spec this implements:** *Quartermaster Orchestrator — Architecture Specification, Draft 4*
(<https://claude.ai/code/artifact/1ee33d6b-b99b-45cd-8717-e082b76ec008>). Section references
below (§2, §4.1, §7.4 …) are that document's.
**Predecessor session:** `docs/qm-orchestrator-session-2026-08-31.md`.
**Status:** Plan. Nothing built. Two of the spec's seven open questions block a *choice*, none
block the *start* — §16 says exactly which and where each one lands.
**Scope:** MCP-originated, latency-tolerant generation only. The live AWS path (Step Functions +
Lambda + DynamoDB) is untouched by every task in this document except one — the single
required change to `provisioner.ts` in §5.3, which exists precisely so the two paths cannot
fight over the RunPod worker cap.

**Principles carried from the spec, in priority order:**

1. **Verify, never assume, every worker count.** The account cap is enforced silently. Two live
   incidents (12/21 frames, 13+/17 frames) came from believing a worker number that was not real.
2. **Failure is per job, never per step.** A step ends when every job row is terminal, not when
   none failed. `completed` requires every leaf asset present *and* gated.
3. **The gate closes before the drain.** Rework must land on a warm endpoint or it costs a
   3-minute cold start on 25 workers.
4. **Every seconds-per-job number is an estimate until one real cohort measures it.** The build
   order in §13 is arranged so the measurement arrives before any decision that depends on it.

---

## 0. What this document adds to the spec

The spec settles *what*. This settles *what to type, in what order*. Three things surfaced while
grounding it in the repo at HEAD that the spec does not cover and that change the build:

| # | Finding | Where | Consequence |
|---|---|---|---|
| A | **The live path's provisioner will fight the orchestrator's fleet controller.** `provisioner.ts`'s `ENDPOINTS` holds `baselineMax` values summing to **32** and re-asserts them every 2-minute sweeper tick. The orchestrator setting `wan2-i2v` to 25 (its `baselineMax` is 10) is reverted within two minutes, silently. | `src/handlers/provisioner.ts:50-56`, `src/handlers/api.ts` sweeper | §5.3 — a mandatory ownership lease on the live path, ~40 lines. **This is the one change to AWS code this plan requires, and it must land before the first live scale-up.** |
| B | **The spec's "7 workers outside the pool" is stale.** Commit `a008c66` routed MeiGen-MultiTalk *into* `FLEET` at 2 workers. Outside the pool today is `long2shorts`=4 + `LTX-DUB`=1 = **5**, and `FLEET` itself now sums to **34**, not 32. | `src/shared/fleet.ts:88-149` | §5.2 rebuilds the budget arithmetic from the file rather than from the spec's prose. The 25-per-step target survives; the *reserve* it leaves is different. |
| C | **`RUNPOD_PROVISION_LIVE` is still `false`.** Nothing in the repo has ever PATCHed RunPod worker counts in production — the provisioner has only ever shadow-logged. | `src/handlers/provisioner.ts:24` | The orchestrator's fleet controller is the **first component that will really scale RunPod**. §6.3 therefore ships with its own shadow mode and §13's M2 is a shadow-only milestone. Do not skip it. |

Everything else here is the spec, taken down to modules, state transitions, DDL and build order.

---

## 1. What already exists — build on, do not rebuild

| Capability | Where (HEAD) | Reuse for |
|---|---|---|
| RunPod worker PATCH (`workersMin`/`workersMax`) | `provisioner.ts` → `patchRunPod()` | Extract verbatim into the fleet controller's scale call (§6.3) |
| RunPod submit / poll / webhook parse, incl. the variable output shape | `src/adapters/runpod.ts` → `runpod.buildRequest/parseSubmit/poll/parseWebhook` | The generator's transport layer (§6.4). `runpodOutUrl`, `runpodOutDuration`, `runpodExecutionTimeMs` port unchanged |
| Per-mode RunPod `input` builders (t2i, i2i, tts, bgm, transcribe, animate, merge, i2v, multitalk) | `runpod.ts` → `buildRunpodInput()` | The per-step payload builders (§9). Port as pure functions; do not import the adapter |
| Real billed duration, not self-reported | `runpod.ts` → `runpodExecutionTimeMs()` (`executionTime`, not `gen_time_s` — a cold call read 94 497 ms vs 2.1 s) | `secPerJob` measurement (§6.8) and the §8 rate-card rebuild |
| Webhook auth by `?key=` query param (providers cannot set headers) | `src/handlers/webhook.ts` | The orchestrator's webhook receiver (§7.2) — same constraint, same solution |
| Ephemeral external-URL re-hosting before COMPLETE | `src/shared/persistExternalAsset.ts` | Mandatory for any Replicate/RunComfy rung the quality agent escalates to (§6.5). 103 of 122 shots were lost to this on 2026-08-17 |
| Endpoint ids, real pod counts, and their incident history | `src/shared/fleet.ts` | §5.1's endpoint registry is generated from it, not retyped |
| Rung ladders per asset/tier/operation | `src/catalog/background.json`, `resolver.ts` | §6.2's plan generation and §6.5's rung escalation |
| Shorts endpoint + passthrough contract | `src/handlers/shorts-trigger.ts` (`u3bvq5juben8ri`) | Step 13's payload builder |
| Quality evaluators, live-smoke-tested 2026-08-10 | `dialogue_basic_qa/image_evaluator.py`, `video_evaluator.py` (external repo) | §6.5's gates — wrapped, not rewritten |
| Rule-store loop prior art | `storyframe_qa_agent/rule_store.py`; `docs/qm-agent-loop-quality-director-architecture.md` §2, §5 | §6.6's rule promotion |

**What does *not* carry over.** `PROJECT_FLEET`'s per-tier pre-warm plans, `MAX_ACTIVE_PROJECTS`,
the admission/reservation gate, `dynamo-gate`'s semaphores, `rebalanceUnderCap`, and the entire
`JOBS_PER_WORKER` demand model. All of them exist to pace *interactive, per-project* admission.
A cohort scheduler that owns one endpoint at a time has no use for any of it — concurrency is
"the worker count the fleet controller just verified", full stop (spec §5.1).

---

## 2. Repository layout

New workspace, not a new repo. Sharing the root `tsconfig`/`jest` config and the `@qm/*` path
alias keeps the ported pure functions (payload builders, output diggers) testable against the
same fixtures the Lambda path uses.

```
orchestrator/
  package.json                 # workspace member; deps: pg, fastify, pino, zod, node-cron
  src/
    index.ts                   # process entry: wires agents, starts HTTP, installs shutdown hooks
    config.ts                  # env parsing (zod), fail-fast on missing/invalid
    fleet-registry.ts          # §5.1 endpoint table + worker budget assertions
    db/
      pool.ts                  # pg Pool, one per process, statement timeout
      migrations/              # numbered .sql, applied by node-pg-migrate
      repo/
        cohorts.ts  projects.ts  steps.ts  jobs.ts  verdicts.ts  endpoints.ts  rules.ts
    window/
      scheduler.ts             # tumbling-window timer, cohort open/close/queue-behind
    agents/
      planner.ts               # §6.2  request -> job graph -> ordered step plan
      fleet.ts                 # §6.3  the ONLY writer of RunPod worker counts
      generator.ts             # §6.4  submit loop + in-flight limiter + reconciler
      quality.ts               # §6.5  gate queue, verdicts, rework, rule promotion
      orchestrator.ts          # the driver: step sequencing, drain gating, cohort lifecycle
    steps/
      catalog.ts               # step id -> endpoint, workers, gate, payload builder
      builders/                # one pure function per step (§9)
      index.ts
    runpod/
      client.ts                # /run, /status, /cancel, /health, REST PATCH; retry + backoff
      types.ts
    http/
      server.ts                # fastify
      routes/requests.ts       # POST /v1/requests  (Convex -> orchestrator)
      routes/webhooks.ts       # POST /v1/webhooks/runpod/:jobToken
      routes/admin.ts          # GET /v1/cohorts, /v1/cohorts/:id, /v1/fleet
      routes/health.ts
    result/
      assemble.ts              # §6.7 result.json
      callback.ts              # POST to Convex, with retry ledger
    quality/
      evaluators.ts            # thin wrappers over the existing python/VLM evaluators
      rules.ts
    telemetry/
      metrics.ts  ledger.ts    # cost ledger, secPerJob rolling medians
  bin/
    watchdog.ts                # §6.9 — SEPARATE PROCESS, separate systemd unit
    replay.ts                  # re-run a cohort's plan against recorded fixtures
  __tests__/
```

**One process, four agent loops.** The four agents are logical, not physical. They are async
loops in one Node process sharing one `pg` pool, because every hand-off between them is a
Postgres row transition and cross-process coordination would buy nothing but failure modes.
The **watchdog is the deliberate exception** (§6.9): it must survive the process it checks.

---

## 3. Runtime topology

```
Convex ──POST /v1/requests──▶ orchestrator (VPS, always-on, TLS, stable hostname)
                              │
                              ├─ window scheduler ── 00/06/12/18 UTC tumbling
                              ├─ planner   ─┐
                              ├─ fleet     ─┤ all four read/write Postgres only
                              ├─ generator ─┤
                              ├─ quality   ─┘
                              │
                              ├──REST PATCH──▶ rest.runpod.io/v1/endpoints/{id}   (fleet only)
                              ├──POST /run──▶ api.runpod.ai/v2/{id}/run           (generator only)
                              ◀─webhook─────  api.runpod.ai   → /v1/webhooks/runpod/:token
                              ├──VLM calls──▶ Anthropic / evaluator               (quality only)
                              └──POST──────▶ Convex callbackUrl                   (result only)

watchdog (separate systemd unit) ──GET /v2/{id}/health──▶ RunPod   ── alerts, never writes
```

No media transits the VPS. RunPod endpoints fetch inputs by URL and write outputs to object
storage. The one thing to check before committing to that (§15.4): whether the quality
evaluators accept image **URLs** or need **bytes**. URLs keeps VPS bandwidth in single-digit
GB/month; bytes means 690 images a cohort through the host and the §11 sizing needs redoing.

---

## 4. Data model

Migrations are numbered SQL under `orchestrator/src/db/migrations/`. `001_init.sql` is the
spec's §10 schema verbatim; everything below it is an addition this plan requires.

### 4.1 `001_init.sql` — the spec's tables

`cohorts`, `projects`, `steps`, `endpoint_state`, `jobs`, `quality_verdicts` and the five partial
indexes, exactly as spec §10 prints them. Two notes on fields that are load-bearing rather than
descriptive:

- `jobs.runpod_job_id` + the `jobs_runpod_id` unique partial index — this is what makes restart
  safe (§10.2). It must be written **in the same transaction** that sets `status='submitted'`.
- `endpoint_state.observed_at` — the timestamp of a real RunPod read, never of a local write.
  Any code path that sets it without having called RunPod is a bug.

### 4.2 `002_measurement.sql` — what the spec needs but does not declare

The spec's §9.2 acknowledgement promises `estimatedResultAt` with `estimateBasis: "measured"`,
and §8 says to rebuild the cost table from one real cohort. Neither is possible without
somewhere to keep the measurements.

```sql
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
```

### 4.3 `003_webhooks.sql` — delivery idempotency

690 webhooks a step, retried by RunPod on any non-2xx. Receipt must be exactly-once in effect.

```sql
CREATE TABLE webhook_receipts (
  runpod_job_id text PRIMARY KEY,
  received_at   timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL,
  body          jsonb NOT NULL
);
```

The receiver inserts here with `ON CONFLICT DO NOTHING` and only applies the job transition when
the insert actually took a row. A duplicate delivery becomes a no-op plus a 200.

### 4.4 `004_rules.sql` — the rule store (§6.6)

```sql
CREATE TABLE quality_rules (
  id             bigserial PRIMARY KEY,
  scope          text NOT NULL,          -- tier | product | tier+product
  scope_key      text NOT NULL,
  gate           text NOT NULL,
  issue_category text NOT NULL,          -- e.g. PROMPT_VISUAL_MISMATCH
  rule_text      text NOT NULL,          -- injected at planning time
  fired_count    int NOT NULL DEFAULT 0,
  promoted_at    timestamptz,
  retired_at     timestamptz
);
CREATE INDEX quality_rules_active ON quality_rules (scope, scope_key, gate)
  WHERE retired_at IS NULL AND promoted_at IS NOT NULL;
```

### 4.5 Invariants worth an assertion, not a comment

Encode these as `CHECK` constraints or as a `verify_invariants()` function the watchdog calls.

| Invariant | Why |
|---|---|
| At most one row in `steps` per cohort with `status IN ('ready','running','generated','gating')` | "One step at a time" is the whole model. Two live steps means the worker budget is wrong |
| At most one row in `cohorts` with `status='running'` | §2.2's queue-behind rule |
| `endpoint_state.held_by_step IS NOT NULL` ⇒ that step is live | The §12.5 drain-that-never-fired failure, caught in-database |
| `jobs.attempts <= 2` and `jobs.quality_attempts <= 2` | §12.2's rework cap; a runaway cohort consumes the window |
| A `projects.status='completed'` row has zero leaf jobs without an asset URL and a non-`fail` verdict | §12.1. This is the rule the three "successful-looking partial completion" incidents violated |

---

## 5. Fleet, budget, and the one AWS change

### 5.1 Endpoint registry

`orchestrator/src/fleet-registry.ts` is the orchestrator's single source of endpoint truth.
Generate it from `src/shared/fleet.ts` at build time (a script that emits a `.ts` constant) rather
than hand-copying — the whole history in `fleet.ts`'s comments is a history of these two numbers
drifting apart.

| Endpoint | id | Steps it serves | Live-path claim (`baselineMax`) |
|---|---|---|---|
| qwen-image-gen | `e165se4r3eo5hp` | 1 (t2i) | 6 |
| qwen-image-edit | `oxwx8o879qwtla` | 1 (i2i) | 4 |
| flux-tts-s2t | `rnqxi6c0mlq517` | 2 (tts) | 8 |
| wan2-i2v | `nd7wloyvj09xwy` | 3 (i2v) | 10 |
| multitalk | `mt6vmstwzw0evp` | 4 (lip-sync) | 2 (fixed pool, not autoscaled) |
| bgm-s2t | `6apg6j7suzuezw` | 5, 9 | 4 |
| media *(new)* | TBD | 6, 8, 10, 11, 12 | — |
| remotion *(new)* | TBD | 7 | — |
| long2shorts | `u3bvq5juben8ri` | 13 | 4 (outside pool) |
| LTX-DUB | — | — | 1 (outside pool) |

Two endpoints do not exist yet — `media` and `remotion`. Building them is §13's M1 and they are
on the critical path for everything from step 6 onward.

### 5.2 The worker budget, rebuilt from the file

The spec's arithmetic (25 + 7 outside = 32, 8 in reserve) predates `a008c66`. At HEAD:

```
ACCOUNT_CAP                                   40
FLEET (fleet.ts) sums to                      34   (8+6+4+10+4+2)
  of which multitalk is a fixed pool           2
outside FLEET entirely                         5   (long2shorts 4, LTX-DUB 1)
committed at idle, live path only             39
```

**The live path already claims 39 of 40 at idle.** The orchestrator cannot take 25 anywhere
without the live path first giving it back. That is finding A, and it makes §5.3 mandatory
rather than an optimisation.

The budget the orchestrator asserts (spec §4.1 step 5), restated so it is checkable:

```
sum(workersMax over all OTHER account endpoints, read from RunPod)  <=  ACCOUNT_CAP - myTarget
i.e.   sum(others) <= 40 - 25 = 15
       others = long2shorts 4 + LTX-DUB 1 + multitalk 2 (when not the live step)
              + whatever the live path holds under lease
       => the live path's ceiling while a background step is live is 8.
```

`8` is the live-path reserve. It is a config value (`QM_LIVE_RESERVE_WORKERS`), not a constant,
and it is the number the spec's open question 4 is really asking about.

### 5.3 The ownership lease — the one change to live-path code

**Problem.** `runProvisioner()` re-asserts each endpoint's `baselineMax` every sweeper tick. It
would drag `wan2-i2v` from the orchestrator's 25 back to 10 within two minutes, silently, mid-step.

**Fix.** A lease item the orchestrator writes to the existing `quartermaster-jobs` table, and one
guard clause in the provisioner. Roughly 40 lines total.

```ts
// src/types.ts — new item type
export interface EndpointLeaseItem {
  pk: 'ENDPOINTLEASE';          // sk = counterKey
  sk: string;
  holder: 'orchestrator';
  cohortId: string;
  stepSeq: number;
  workers: number;
  expiresAt: number;            // epoch ms; ALWAYS set, so a dead orchestrator self-heals
  updatedAt: number;
}
```

```ts
// src/handlers/provisioner.ts — in runProvisioner(), before planFor()
const leases = await readEndpointLeases();          // one Query on pk='ENDPOINTLEASE'
for (const ep of ENDPOINTS) {
  const lease = leases[ep.counterKey];
  if (lease && lease.expiresAt > now) {
    // The background orchestrator owns this endpoint for the duration of a step.
    // Do not plan it, do not PATCH it, do not count it toward the cap rebalance —
    // it is not ours to size. Skipping is safe: the lease always expires, so a
    // dead orchestrator returns the endpoint to demand-driven sizing on its own.
    console.info('[provisioner] skipping leased endpoint', ep.counterKey,
      `held by ${lease.cohortId}#${lease.stepSeq} until ${new Date(lease.expiresAt).toISOString()}`);
    continue;
  }
  /* …existing planFor()… */
}
```

Also subtract leased workers from `ACCOUNT_CAP` inside `rebalanceUnderCap` so the live path
rebalances against its real remaining headroom (`40 - 25 = 15`), not against 40.

**Lease discipline in the orchestrator:**

- Written *before* the scale-up PATCH, with `expiresAt = now + expectedStepMs * 2 + 15 min`.
- Renewed on every fleet-agent tick while the step is live.
- Deleted in the same transaction that records a successful drain.
- `expiresAt` is never null and never further out than 6 hours. A lease that outlives the
  process must expire before the next window, or a crash strands the live path at reduced capacity.

**Tests to add on the AWS side:** extend `__tests__/provisioner.test.ts` with (a) a leased
endpoint is skipped entirely, (b) an expired lease is ignored, (c) `rebalanceUnderCap` sees the
reduced cap. Those three cover the whole blast radius of the change.

---

## 6. Module specifications

### 6.1 Window scheduler — `window/scheduler.ts`

Fixed tumbling windows at 00:00 / 06:00 / 12:00 / 18:00 UTC (§2.2). Not a sliding window: a
steady trickle would never fire one.

```
on boot            -> ensure a cohort row exists for the current open window
on window close    -> if a cohort is already status='running':
                        mark the closing cohort 'queued'  (§2.2 one-cohort-at-a-time)
                      else:
                        mark it 'running', hand to the orchestrator driver
on cohort finish   -> if a 'queued' cohort exists, promote the oldest to 'running'
```

Cohort ids are `win_YYYY_MM_DD_HH` — deterministic, so a restart mid-window rejoins the same
cohort rather than opening a second one. Empty windows do not create a cohort.

**The overflow decision the spec leaves open (question 6) is deferred safely here:** the first
implementation *queues* rather than rejects, and emits a `cohort_deferred` metric. When that
metric starts firing, there is real data for the reject-or-defer conversation.

### 6.2 Planning agent — `agents/planner.ts`

Runs **on arrival**, synchronously inside `POST /v1/requests`, so a malformed request fails fast
rather than six hours later (§2.2).

```
plan(request) ->
  1. validate (zod) against the §9.1 schema; reject 4xx on failure
  2. resolve tier+product -> the step set (which of the 13 apply; step 4 only for dialogue tiers,
     steps 5/9/10/11/12/13 gated on options.bgm / subtitles / upscale / burnCaptions / shorts)
  3. expand frames[] -> job rows, one per (frame, step), with deps_remaining precomputed
  4. apply active quality_rules for this scope, injecting rule_text into prompts BEFORE first
     generation (spec §6.2 — this is where the compounding improvement lives)
  5. order jobs within each step: project, then frame index -> jobs.seq
  6. emit the step plan (§9.3 shape) with drainAfter computed by the affinity rule below
  7. write cohort/project/step/job rows in ONE transaction
  8. return the §9.2 acknowledgement, with the estimate from §6.8
```

**The endpoint-affinity rule (spec §3.1) as code.** This is the tail collapse — worth ~$1.51 and
12 minutes a cohort for a scheduling rule and no new mechanism:

```ts
// steps are already dependency-ordered here
for (let i = 0; i < steps.length - 1; i++) {
  steps[i].drainAfter = steps[i].endpointId !== steps[i + 1].endpointId;
}
steps[steps.length - 1].drainAfter = true;   // always drain the last step
```

With the step order of spec §3, that collapses steps 8→10→11→12 onto one `media` allocation and
leaves 5 and 9 as the two `bgm-s2t` touches. If §16's question 2 resolves as "the media container
cannot hold everything", this rule needs no change — the endpoint ids simply differ and it stops
collapsing. That is the point of expressing it as affinity rather than as a hardcoded list.

**Job graph shape.** `deps_remaining` is a counter, not a graph walk. A job's dependencies are its
own frame's rows in the steps this step `dependsOn`. Completing a job decrements its dependents.
The `jobs_step_ready` partial index (`status='planned' AND deps_remaining=0`) is the generator's
whole work queue.

### 6.3 Fleet controller — `agents/fleet.ts`

**The only component in the system permitted to change an endpoint's worker counts.** Enforce that
structurally, not just socially: `runpod/client.ts` exports `patchWorkers()` and only
`agents/fleet.ts` imports it — add a lint rule or a one-line import test.

State machine per step:

```
     ┌─────────┐  allocate  ┌─────────┐  workersReady==target  ┌───────┐
     │ pending ├───────────▶│ scaling ├──────────────────────▶ │ ready │
     └─────────┘            └────┬────┘                        └───┬───┘
                                 │ timeout / cap assertion fails   │ generator + quality
                                 ▼                                 ▼
                            ┌─────────┐                       ┌──────────┐
                            │ stalled │ (alert, HOLD, §12.4)  │ draining │
                            └─────────┘                       └────┬─────┘
                                                                   │ workersRunning==0
                                                                   ▼
                                                              ┌──────────┐
                                                              │ complete │
                                                              └──────────┘
```

Allocation sequence, spec §4.1, with the concrete calls and the timeouts the spec does not fix:

```ts
async function allocate(step: Step): Promise<void> {
  // 1. Take the lease FIRST. If the live path is mid-PATCH we want to lose the
  //    race here, visibly, not halfway through scaling.
  await writeLease(step.endpointId, step, ttl(step));

  // 2. Raise both counts. workersMin == workersMax == target: ACTIVE workers,
  //    not a flex floor. They bill continuously; that is what buys the absence
  //    of cold starts inside the step (spec §4.2).
  await patchWorkers(step.endpointId, { workersMin: step.workers, workersMax: step.workers });
  await recordAllocationStart(step);

  // 3. VERIFY. Never assume. GET /v2/{id}/health -> workers.ready
  //    (confirm the exact field names against runpod/API.md before wiring).
  const ready = await pollUntil(
    () => getHealth(step.endpointId).then(h => h.workers.ready >= step.workers),
    { every: 5_000, timeout: WARM_TIMEOUT_MS },        // default 8 min; cold start is 2.5-4 min
  );
  if (!ready) return stall(step, 'warm_timeout');

  // 4. Assert the cap held. Raising to 25 while others hold workers does NOT
  //    error — it caps, silently, and the step then runs under-provisioned.
  //    This is the 13-of-17-frames failure (fleet.ts, 2026-07-05).
  const others = await sumWorkersMaxExcept(step.endpointId);   // real read, all account endpoints
  if (others > ACCOUNT_CAP - step.workers) return stall(step, 'cap_breach', { others });

  await markReady(step);   // steps.status='ready', steps.warm_at=now()
}
```

```ts
async function release(step: Step, next?: Step): Promise<void> {
  // Called ONLY by the orchestrator driver, ONLY after the quality gate closes (spec §4.3).
  await patchWorkers(step.endpointId, { workersMin: 0, workersMax: 0 });
  const drained = await pollUntil(
    () => getHealth(step.endpointId).then(h => h.workers.running === 0 && h.workers.ready === 0),
    { every: 5_000, timeout: DRAIN_TIMEOUT_MS },       // default 5 min
  );
  if (!drained) return stall(step, 'drain_timeout');   // ALERT LOUDLY — this one costs $19/window
  await tx(async t => {
    await deleteLease(step.endpointId, t);
    await recordAllocationEnd(step, t);
    await markComplete(step, t);
  });
  if (next) await allocate(next);
}
```

**Shadow mode.** `ORCH_FLEET_LIVE=false` (the default) does everything except the two
`patchWorkers` calls, logging `would PATCH e165… max 6→25 min 0→25`. §13's M2 runs a full cohort
in shadow against a hand-scaled fleet before this ever flips.

**Stall means hold, not proceed.** A stalled step never advances. Alert, keep the lease alive (so
the live path does not reclaim workers mid-diagnosis), and wait for a human. "A stalled cohort is
recoverable; one that ran a step at a third of its intended capacity, silently, is the case that
took two incidents to diagnose" (spec §12.4).

### 6.4 Generator agent — `agents/generator.ts`

One agent for every asset type. The endpoint and the payload come from the plan, not the code
(spec §5). Draft 3's nine agents collapse into this loop plus the pure builders of §9.

```
loop, per step, once steps.status == 'ready':
  inFlight = 0
  while (work remains):
    claim  = SELECT ... FROM jobs
             WHERE cohort_id=$1 AND step_seq=$2 AND status='planned' AND deps_remaining=0
             ORDER BY seq
             LIMIT (step.workers - inFlight)
             FOR UPDATE SKIP LOCKED            -- safe under a future second worker process
    for job in claim:
      body = buildInput(step.name, job)        -- §9, pure
      res  = POST /v2/{endpointId}/run { input: body, webhook: callbackUrl(job) }
      -- SAME TRANSACTION: id and status, or neither (spec §12.3 idempotency)
      UPDATE jobs SET runpod_job_id=$id, status='submitted', submitted_at=now() WHERE id=job.id
    await either(webhookSignal, reconcileTick)
  when every job row for the step is terminal:
    steps.status = 'generated'; signal the orchestrator driver
```

**In-flight limit = the verified worker count.** Not a config value, not `JOBS_PER_WORKER`. Exactly
one step is live, so there is no cross-endpoint accounting to get wrong (spec §5.1).

**Ordering matters.** `jobs.seq` is the planner's order, so a cohort's frames return roughly in
project order and a project whose frames all land early starts its quality gate while another's are
still generating.

**Webhooks, not polling** (spec §5.2). 690 jobs polled at 10 s is 69 req/s — rate-limited and pure
waste. Register a webhook per job; polling is the reconciliation fallback only:

```
reconcileTick (every 60s):
  stale = jobs WHERE status='submitted'
              AND submitted_at < now() - (baseline.p95_sec * 3 + warm_sec) seconds
  for each: GET /v2/{endpointId}/status/{runpod_job_id}  -> apply terminal state if any
```

**Synchronous completion.** `/run` on a warm, fast endpoint can return `status: COMPLETED` with
`output` already populated (`runpod.ts:parseSubmit`). Handle it inline — it is the common case for
short steps and produces no webhook.

**Cancellation.** On stall or operator abort, `POST /v2/{id}/cancel/{jobId}` for every `submitted`
row before draining, so the drain is not blocked by work nobody is waiting for.

### 6.5 Quality agent — `agents/quality.ts`

Gates assets as they land, **inside the allocation**, and requeues failures while the endpoint is
still warm (spec §6). Its work queue is exactly the `jobs_ungated` index: `status='complete' AND
quality_status IS NULL`. That same query must return empty before the fleet controller is allowed
to drain — that is the whole coupling between spec §6 and §4.3.

| Gate | After step | Evaluator | Failure action | Cap |
|---|---|---|---|---|
| image | 1 | `image_evaluator.py` — anatomy, composition, prompt match, artefacts | rewrite prompt → regenerate → re-gate | 2 |
| motion | 3 | `video_evaluator.py` — prompt-visual mismatch, temporal artefacts, drift | escalate rung (spec §7) → regenerate | 2 |
| assembly | 12 | duration, A/V sync, caption timing, black frames | flag partial; **no** automatic rework | — |

The image gate pays for itself immediately: it stops the pipeline spending 90–390 s of i2v on a
frame that was never going to pass.

**Rework path.** A failed job is re-planned into the *same* step with `attempts+1`, `tried_rungs`
appended, `status='planned'`. It is picked up by the generator's next claim on a still-warm
endpoint. Two attempts maximum — one prompt correction, one rung escalation — then it fails cleanly
with `reason: 'all_rungs_exhausted'` and `triedRungs[]` in the result (spec §9.6).

**External rungs must be re-hosted.** If an escalation routes to Replicate (`wan-2.2-i2v-fast`) or
RunComfy, call `persistIfExternal()` before marking the job complete. Skipping this is what lost
103 of 122 shots on 2026-08-17 when `replicate.delivery` links 404'd hours later.

**Cost control is a first-class knob, not an afterthought.** Two gates over a ten-project cohort is
~1,380 VLM calls, ~$4 — more than steps 8–12 combined (spec §6.3). `options.qualityGates` takes
`full | sampled | image-only | off`. Ship the first few cohorts at `full` precisely to measure the
pass rate, then decide (§16, question 5). Every call writes `quality_verdicts.cost_usd`, so the
decision is made against a number.

### 6.6 Rule promotion — `quality/rules.ts`

Every correction is also a candidate rule. When the same `issue_category` fires ≥ N times for the
same scope (start at N=5, one cohort's worth), promote it: write a `quality_rules` row, and the
planner injects it at planning time from then on. The gate catches defects; the rule store is what
stops producing them. Prior art and the data model to copy: `storyframe_qa_agent/rule_store.py`,
`docs/qm-agent-loop-quality-director-architecture.md` §5.

### 6.7 Result assembler — `result/assemble.ts`, `result/callback.ts`

Emits the spec §9.6 shape. Three parts of it are load-bearing rather than decorative:

- `steps[]` — per-step totals, `warmMs`, `runMs`. Without it a caller cannot see that a cohort ran
  but their project lost four frames in animation.
- `quality{}` — gated / passedFirstAttempt / reworked / acceptedMarginal / escalatedRung. This is
  what makes spec §7's rung choice auditable after the fact.
- `errors[]` — `frameId`, step, agent, reason, `triedRungs[]`.

**The completion rule (spec §12.1), as a single query:**

```sql
-- a project is 'completed' ONLY if this returns zero rows
SELECT j.id FROM jobs j
JOIN (SELECT cohort_id, max(seq) AS leaf_seq FROM steps GROUP BY cohort_id) lf
  ON lf.cohort_id = j.cohort_id
WHERE j.project_id = $1
  AND j.step_seq = lf.leaf_seq                        -- leaf: steps.seq, not step_seq
  AND (j.output->>'url' IS NULL OR j.quality_status = 'fail');
-- anything else is 'partial', with errors[] populated
```

> The leaf-step column on `steps` is `seq`, not `step_seq` (`step_seq` is on
> `jobs`). Written as `(SELECT max(step_seq) FROM steps …)` Postgres resolves
> `step_seq` to the outer `jobs` row and rejects it — "aggregate functions are
> not allowed in WHERE". The `GROUP BY` join above is the working form (and is
> what `005_invariants.sql`'s `verify_invariants()` uses).

**Shorts close by construction.** "Shorts complete" is defined as *manifest read and clip URLs
recorded in `assets.shorts[]`*, not as "the render job returned 200". That closes the still-open
2026-07-11 gap where all three clips rendered and uploaded while the project's `shorts` array
stayed `[]` — the orchestrator cannot mark the step complete without the URLs it must report.

**Callback delivery.** POST to `projects.callback_url` with exponential backoff (1 s → 5 min, 8
attempts), each attempt appended to a `callback_attempts` jsonb column. A cohort is not finished
until every project's callback has succeeded or exhausted.

### 6.8 The estimate — `telemetry/ledger.ts`

The thing the batch API could not give you (spec §2.1, §9.2):

```
estimateMinutes(remainingSteps) =
  Σ over steps of ( warmSec(endpoint) + ceil(jobs / workers) × secPerJob(endpoint, step) ) / 60

secPerJob := step_baselines.median_sec        -> estimateBasis 'measured'
          |  steps.sec_per_job from the plan  -> estimateBasis 'default'
```

Always report which. An estimate labelled `measured` that is actually a guess is worse than no
estimate. Recompute and re-emit on every step transition, so a long-running cohort's ETA improves
rather than going stale.

### 6.9 Watchdog — `bin/watchdog.ts`, separate systemd unit

Guards the failure mode this design introduces (spec §12.5): an endpoint left at 25 active workers
because the orchestrator died between the quality gate and the release call. ~$19 per six-hour
window, silently, with no failed job to point at it.

```
every 60s:
  for each endpoint in the registry:
    real = GET /v2/{id}/health -> workers.ready + workers.running
    if real > 0:
      lease = read ENDPOINTLEASE / endpoint_state.held_by_step
      if no live step holds it  ->  ALERT (page-worthy), and after ORPHAN_GRACE_MS
                                    (default 10 min) optionally auto-drain if
                                    WATCHDOG_AUTODRAIN=true
```

It is twenty lines and it is the only check that survives the process it is checking. Give it its
own systemd unit, its own restart policy, and its own alert channel. It reads RunPod and the
database; it never writes the database.

---

## 7. HTTP surface

### 7.1 Inbound from Convex — `POST /v1/requests`

Body: spec §9.1. Response: spec §9.2. Auth: bearer token, `ORCH_INGEST_TOKEN`.
Idempotent on `requestId` via `projects.request_id UNIQUE` — a replayed request returns the
original acknowledgement with the original `cohortId`, never a second plan.

Validation is strict (zod, `.strict()`): unknown fields reject. `source` must be `"mcp"`; anything
else is 400, because nothing but MCP may enter the window.

### 7.2 Inbound from RunPod — `POST /v1/webhooks/runpod/:jobToken`

`jobToken` is an HMAC of `jobs.id` under `ORCH_WEBHOOK_SECRET`, embedded in the callback URL at
submit time. RunPod cannot attach custom auth headers to a callback — the same constraint
`src/handlers/webhook.ts` solved with a `?key=` param, and the same solution, per-job rather than
global.

- Always answer **200 quickly**, before doing the work, so RunPod does not retry-storm.
- Insert into `webhook_receipts` `ON CONFLICT DO NOTHING`; apply the transition only if the row was
  taken (§4.3).
- Parse with the ported `parseWebhook` — `runpodOutUrl`, `runpodOutDuration`,
  `runpodExecutionTimeMs`.
- Write `job_costs` from `executionTime` (billed) and `delayTime` (queue, not billed).

**Hostname stability is now a correctness requirement, not a convenience.** 690 webhooks per step
register against this host; a changing hostname breaks a cohort, not a handful of callbacks
(spec §11).

### 7.3 Admin / observability

`GET /v1/health` (liveness + pg + last RunPod contact), `GET /v1/cohorts`, `GET /v1/cohorts/:id`
(step table, per-step job tallies, live ETA), `GET /v1/fleet` (registry vs real `workers.ready`,
side by side — the single most useful page during M2), `POST /v1/cohorts/:id/abort` (cancel
in-flight jobs, drain, mark partial).

### 7.4 Outbound

| Call | Who may make it | Notes |
|---|---|---|
| `PATCH rest.runpod.io/v1/endpoints/{id}` | fleet only | body `{workersMin, workersMax}`; port from `patchRunPod()` |
| `GET api.runpod.ai/v2/{id}/health` | fleet, watchdog | worker counts; **verify field names against `runpod/API.md` before wiring** |
| `POST api.runpod.ai/v2/{id}/run` | generator only | `{input, webhook}` |
| `GET api.runpod.ai/v2/{id}/status/{jobId}` | generator (reconcile) only | fallback path |
| `POST api.runpod.ai/v2/{id}/cancel/{jobId}` | generator only | abort/stall path |
| VLM evaluator | quality only | 25-way parallel, seconds each |
| Convex `callbackUrl` | result only | retry ledger |

All RunPod calls go through `runpod/client.ts` with retry on 429/5xx (exponential, jittered, cap 5)
and a hard per-call timeout. `classifyError` ports from `runpod.ts` unchanged.

---

## 8. State machines

### 8.1 `cohorts.status`

`open → running → completed | failed`, with `open → queued → running` when the previous cohort has
not finished. `current_step` advances only on a verified drain.

### 8.2 `steps.status`

```
pending ─▶ scaling ─▶ ready ─▶ running ─▶ generated ─▶ gating ─▶ draining ─▶ complete
             │                                            │          │
             └────────────▶ stalled ◀─────────────────────┴──────────┘
```

| Transition | Written by | Guard |
|---|---|---|
| `pending→scaling` | fleet | lease taken; previous step `complete` |
| `scaling→ready` | fleet | `workers.ready >= target` **and** cap assertion passed |
| `ready→running` | generator | first submission accepted |
| `running→generated` | generator | every job row terminal |
| `generated→gating` | quality | step has a gate; else straight to `draining` |
| `gating→draining` | orchestrator | `jobs_ungated` returns empty **and** rework queue empty |
| `draining→complete` | fleet | `workers.running == 0` verified, lease deleted |
| `*→stalled` | fleet | timeout or cap breach. Terminal until a human intervenes |

If `drainAfter=false`, `draining` is skipped entirely and the next step goes `pending→ready`
directly on the same warm endpoint (spec §3.1).

### 8.3 `jobs.status`

```
planned ─▶ submitted ─▶ complete ─▶ (gated) ─▶ terminal
              │             │
              │             └─ quality fail ─▶ requeued ─▶ planned  (attempts < 2)
              └─▶ failed ─▶ requeued ─▶ planned  (attempts < 2)  |  terminal failed
```

`deps_remaining` decrements on the dependents of any job reaching `complete` **with a passing or
absent verdict** — never on a job that is about to be reworked, or the next step starts against an
asset that is being regenerated.

---

## 9. Payload builders

One pure function per step in `steps/builders/`, one test each. This is spec §5.2's warning made
concrete: the payload differences do not vanish, they move — keep them in one module with one test
each and the nine-agents-into-one collapse is real; scatter them and you have rebuilt nine agents
inside one process.

| Step | Endpoint | Mode / route | Port from | Notes |
|---|---|---|---|---|
| 1 image | qwen-image-gen / -edit | `t2i` / `i2i` | `buildRunpodInput` cases `t2i`, `i2i` | `model` field selects Flux Klein 4B vs Qwen-Image |
| 2 audio · tts | flux-tts-s2t | `tts` | case `tts` | `voice \|\| rung.fixed.voice` — `\|\|` not `??`, an explicit `''` must fall through |
| 3 animation · i2v | wan2-i2v | i2v | case `i2v` (`runpod.ts:315`) | `sample_steps` / `guidance` are spec §7's rung knobs. `ceil` the duration, never `round` |
| 4 lip-sync | multitalk → runcomfy | `multitalk` | case `multitalk` | 15 s/clip hard cap (`MULTITALK_LOCAL_MAX_DURATION_S`) |
| 5 bgm_sfx | bgm-s2t | `bgm` | case `bgm` | ACE-Step caps ~120–180 s; generate short, loop downstream |
| 6 av merge | media | new | `adapters/lambdamerge.ts` semantics | ffmpeg `-shortest`; video must be ≥ audio |
| 7 remotion overlay | remotion | new | `src/handlers/remotion-overlay.ts` | `textManifest` passthrough |
| 8 concat | media (NVENC) | new | `runpod.ts` case `concat` | measured 5–6 min on Fargate; the one real number in spec §8 |
| 9 s2t · subtitles | bgm-s2t | `transcribe` | case `transcribe` | `return_timestamps: 'word'` |
| 10 upscale | media | new | — | needs the SR model in the media image (§16 q2) |
| 11 burn caption | media | new | — | ffmpeg + ASS/SRT |
| 12 overlay bgm | media | new | — | mix + loop the short BGM bed |
| 13 shorts | long2shorts | `/run` | `src/handlers/shorts-trigger.ts` | raw `shortsOptions` passthrough; caller keys win except `project_id`/`video_url` |

Each builder is `(job: Job, step: StepPlan) => Record<string, unknown>`. No I/O, no DB, no clock.

---

## 10. Failure, restart, idempotency

### 10.1 Idempotency rules

| Level | Key | Enforced by |
|---|---|---|
| Request | `projects.request_id` | `UNIQUE` — a replay returns the original ack |
| Submission | `jobs.runpod_job_id` | `jobs_runpod_id` unique partial index + same-transaction write |
| Webhook | `webhook_receipts.runpod_job_id` | PK + `ON CONFLICT DO NOTHING` |
| Allocation | `endpoint_state.held_by_step` | at most one live step per endpoint |
| Callback | `projects.result IS NOT NULL` | never re-assembled, only re-delivered |

### 10.2 Boot reconciliation — run before anything else

```
1. Reconcile endpoint_state against RunPod FIRST, before any scheduling decision.
   A crash between "scale to 25" and "record it" leaves 25 workers billing with
   nothing in front of them and nothing in the database that knows (spec §12.3).
   For every registry endpoint: GET /v2/{id}/health, write observed_at.
   Any endpoint holding workers with no live step -> drain it, log loudly.
2. Read cohorts WHERE status='running' -> current_step.
3. Read jobs WHERE status='submitted' AND runpod_job_id IS NOT NULL
   -> GET /status for each, apply terminal states, resume collecting.
   NEVER resubmit a job that already has a runpod_job_id.
4. Re-register nothing: webhooks are addressed to a URL, not a connection.
   Anything that fired while we were down is recovered by step 3.
5. Resume the agent loops.
```

Persisting `runpod_job_id` is what makes this possible. Draft 3 stored one `batch_id`; direct
submission means 690 ids instead, which is why the unique partial index matters.

### 10.3 Failure taxonomy

| Failure | Detection | Response |
|---|---|---|
| Job fails at RunPod | webhook `status=FAILED` | rework per §6.5, cap 2, then terminal with `triedRungs[]` |
| Job goes quiet | reconcile tick past `p95×3` | `/status`; if `IN_QUEUE` past the window, cancel and rework |
| Warm-up never reaches target | `pollUntil` timeout | **stall the cohort**, alert, hold the lease (spec §12.4) |
| Cap assertion fails | `sum(others) > cap - target` | stall. Never proceed under-provisioned |
| Drain never reaches zero | `pollUntil` timeout | stall + **page**. This is the $19/window failure |
| Orchestrator dies mid-step | watchdog sees orphaned workers | alert; optional auto-drain after grace (§6.9) |
| Orchestrator dies between gate and release | watchdog + lease expiry | live-path provisioner reclaims on expiry; watchdog pages first |
| Postgres unavailable | pool health | stop submitting immediately; in-flight jobs are recoverable via `runpod_job_id`, un-recorded submissions are not |
| Convex callback fails | retry ledger exhausted | project stays `completed`, callback marked `undelivered`, alert |

---

## 11. Observability

**Metrics** (Prometheus text on `/metrics`, or push — either is fine; having them is not optional):

- `cohort_duration_seconds`, `step_duration_seconds{step}`, `step_warm_seconds{endpoint}`
- `jobs_total{step,status}`, `job_execution_seconds{endpoint,step}` (histogram)
- `workers_ready{endpoint}` vs `workers_target{endpoint}` — **the divergence that preceded both
  frame-loss incidents**
- `gate_verdicts_total{gate,verdict}`, `gate_cost_usd_total`
- `rework_total{gate,action}`, `escalations_total{from,to}`
- `cohort_cost_usd{component}` where component ∈ gpu | warm | quality
- `orphaned_workers` (watchdog) — alert on `> 0` for 2 consecutive scrapes

**Alerts, in descending order of "wake someone":**

1. `orphaned_workers > 0` for 2 min — money burning with nothing to show for it
2. step `stalled` — a cohort of ten projects is held
3. drain timeout
4. `workers_ready < workers_target` while a step is `running`
5. callback undelivered after retry exhaustion
6. cohort deferred (a second cohort queued behind a running one) — informational, but it is the
   signal that §16 question 6 has become real

**The cost ledger** is the deliverable of §12's first measurement: per cohort, GPU vs warm-up vs
quality, per step, from `job_costs` and `allocation_costs` rather than from the spec's estimates.

---

## 12. Measurement plan — run these before the decisions that depend on them

### 12.1 The rate-card cohort (unblocks spec §8 entirely)

Every seconds-per-job figure in the spec except concat is an estimate, and cost scales linearly in
all of them. If image generation is 25 s rather than 12 s, step 1 doubles.

**Do:** run one real ten-project cohort with `qualityGates: "full"`, `job_costs` and
`allocation_costs` populated. **Produce:** the spec §8.1 table rebuilt from measurements, plus real
`step_baselines` so the very next cohort's acknowledgement can say `estimateBasis: "measured"`.
**Until then spec §8 is a shape, not a budget** — and no rung decision should be made against it.

### 12.2 The Wan 2.2 sweep (spec §7.4 — unblocks the largest number in the document)

The single largest cost decision here: the rungs price from $14.18 to $58.28 a cohort, and
animation is 49% of the bill at the cheap rung and 79% at the expensive one.

**Prerequisite: the motion gate must exist first.** It is the only instrument that can say whether
the hybrid rung restored adherence or merely produced smoother frames that still ignore the prompt.
Build §6.5's motion gate, then sweep.

**Do:** one real project, 69 frames, `steps ∈ {4, 6, 8, 12, 20} × cfg ∈ {1.0, 2.5, 3.5, 5.0}`, with
and without the Lightning LoRA — 40 configurations, motion-gate scoring every output.
**Record:** mismatch rate against seconds per generation; find the knee.
**Cost:** about a day of pod time. **Decides:** a line item worth $25–45 per cohort.

**Measure rung 2 (hybrid) first** — it is the only option that could beat both the cheap rung on
quality and the expensive one on cost, and nobody has run it. Rung 3's 45% escalation rate is
extrapolated from the audit's 47-of-78 flagged scenes and is the weakest input in the spec: at 20%
escalation rung 3 costs ~$26 and beats everything; at 60% it costs ~$50 and barely beats rung 1.

**Note the scheduling consequence before choosing rung 1:** the animation step alone runs ~3 h,
pushing cohort duration past 4 h. Rung 1 and a six-hour window are compatible only up to roughly
ten projects.

### 12.3 The media-container probe (§16 question 2)

Build the media image with ffmpeg + NVENC + the SR model and run one job each of concat, upscale,
caption burn-in and BGM overlay against it. Four workloads with quite different VRAM profiles
sharing a cold start — if they cannot share an image, the tail is four allocations rather than one
and the warm-up figure rises ~$1.51 a cohort. Half a day; it validates §6.2's affinity collapse.

---

## 13. Build order

Each milestone is independently shippable and independently reversible. **The vertical slice comes
before breadth** — steps 1→3 end to end teaches more than thirteen half-built steps.

### M0 — Foundations *(no RunPod contact)* — **DONE 2026-09-09**
- [x] `orchestrator/` workspace, config, pg pool, migrations `001`–`005` (`005` = §4.5 invariants)
- [x] `fleet-registry.ts` generated from `fleet.ts`; a test that fails if they diverge
- [x] `runpod/client.ts` with retry/backoff/timeouts; **recorded fixtures, no live calls**
- [x] Fastify server, `/v1/health`, structured logging
- **Done:** migrations apply + roll back cleanly on the VPS's Postgres 16; `/v1/health` → 200.
  Deployed at `orchestrator.ai-storystudio.com` (compose: db + orchestrator + caddy). Commits
  `ab7f402`, `8e735ba`, `eec0f23`. Runbook: `docs/qm-orchestrator-vps-access.md`.

### M0.5 — The live-path lease *(AWS side; blocks M3)* — **DONE 2026-09-09** (`d138d71`)
- [x] `EndpointLeaseItem` in `src/types.ts`; `readEndpointLeases()` + skip in `runProvisioner()`
- [x] Leased workers subtracted from `ACCOUNT_CAP` — `rebalanceUnderCap(plans, cap)` called as
      `ACCOUNT_CAP - sum(leased)`
- [x] Three tests in `__tests__/provisioner.test.ts` (§5.3); suite 6 → 9, green
- **Done:** a written non-expired lease makes `runProvisioner` skip the endpoint entirely.
  Orchestrator-side lease *writer* (fleet agent) lands with M3.

### M1 — the two new endpoints *(revised: reuse, don't build)* — **in progress**
The `media` "container" was going to be new ffmpeg code — until `flux4B-Wan2-storystudio`
(the `flux-tts-s2t` / `bgm-s2t` codebase) turned out to already implement `merge`, `concat`,
`upscale`, `caption`, `mix_bgm` **and** `postprod`, on R2, in production. A reimplementation
(commit `059a4ad`) was reverted. So M1 is now a deploy + a contract, not a build.
- [x] Contract pinned — `orchestrator/containers/media.md` (the 5 modes' input/output, the
      caption-re-runs-Whisper consequence, why `postprod` is unused, the concat-no-normalize gap).
- [ ] Deploy `flux4B-Wan2-storystudio` with `ENDPOINT_ROLE=all` as the `media` endpoint;
      register its `endpointId` in `fleet-registry.ts` (with M2).
- [ ] Measure `gen_time_s` + `executionTime` + peak VRAM per mode on a real cohort's assets
      → feeds spec §8 rate card and §16 q4 (GPU class for this role).
- [~] `remotion` — **deferred for M1** (§16 q3): step 7 stays on the existing Remotion Lambda
      (`src/handlers/remotion-overlay.ts`), the one remaining AWS touch in the background path.
- **Decision taken:** caption = Whisper-regenerated from the concatenated video (does not consume
      step 9's SRT). Step 9 keeps only if a standalone pre-concat `.srt` deliverable is wanted —
      else the planner may drop it (M2).
- **Done when:** each of the 5 modes completes one real job for a cohort and writes to R2.

### M2 — Plan and generate, shadow fleet — **code complete 2026-09-10, real acceptance run pending**
- [x] Planner: §9.1 validation (zod `.strict()`), job graph, step plan, affinity collapse
      (`agents/planner.ts`). Plans only catalogued steps (1-3 for now — `steps/catalog.ts`);
      resolves the full spec step-set so widening to 4-13 in M5 needs no change here.
- [x] Generator: submit loop, in-flight limiter (= verified worker count, not config),
      synchronous-completion handling, webhook receiver (`http/routes/webhooks.ts`),
      reconcile-tick fallback (`agents/generator.ts`)
- [x] Fleet controller with `ORCH_FLEET_LIVE=false` — logs every PATCH it would make
      (`agents/fleet.ts`); real health verification + cap assertion regardless. Lease-write
      (§6.3 step 1) intentionally NOT wired — M0.5 already flagged that as landing with M3.
- [x] New migration `006_step_deps.sql` — `001`'s schema never persisted §9.3's `dependsOn`;
      applies/rolls back cleanly.
- [x] `db/repo/{cohorts,projects,steps,jobs,costs}.ts`, `steps/builders/{image,tts,i2v}.ts`
      (ported from `src/adapters/runpod.ts`'s `t2i`/`tts`/`i2v` cases), `agents/orchestrator.ts`
      (the minimal driver — no gating phase yet, `agents/quality.ts` doesn't exist until M4),
      `http/routes/{requests,admin}.ts`, `telemetry/ledger.ts` (`estimateBasis: "default"` only
      — `step_baselines` isn't written until there's a real measured cohort).
- [x] 56 tests green (36 pure-unit + 4 repo-layer integration against a real throwaway Postgres
      + the pre-existing suite), incl. a structural test that only `agents/fleet.ts` calls
      `patchWorkers`. The integration tests caught two real bugs before they shipped:
      `windowId` used the raw current hour instead of rounding to the window's 00/06/12/18
      opening hour, and `ensureCohort` raised a raw Postgres constraint error (instead of a
      clear typed one) when a different cohort was still `running` — both fixed.
- [ ] **Hand-scale one endpoint manually; run steps 1→2→3 only, one real project, no gates** —
      not yet done. Needs: deploy to the VPS, set `ORCH_PUBLIC_BASE_URL` (new required config,
      didn't exist before M2), a human manually set one endpoint's real worker count to match
      the small number the test plan will carry, then `POST /v1/requests`.
- **Done when:** a real project's frames complete image + tts + i2v, with `job_costs` populated
  from real `execution_ms`/`delay_ms`, having never scaled a worker programmatically. Not yet
  verified against real infra — see `docs/qm-orchestrator-session-2026-09-10-m2.md`.
- **This milestone is where finding C is retired.** Read the shadow log line by line before M3
  — still applies once the real run happens.

### M3 — Live fleet control
- [ ] Flip `ORCH_FLEET_LIVE=true` on one endpoint, one step
- [ ] Warm/drain verification polls, cap assertion, stall handling
- [ ] Watchdog deployed **first**, alerting, before the first live scale-up
- **Done when:** a step scales 0→25→0 with both polls verified, and the watchdog stays silent.

### M4 — Quality gates
- [ ] Evaluator wrappers, `jobs_ungated` queue, verdict writes
- [ ] Image gate, then motion gate; rework path with the attempts cap
- [ ] Drain gated on the quality agent, not the generator
- **Done when:** a deliberately bad prompt is caught, reworked on the warm endpoint, and passes —
  with no second warm-up in the allocation log.

### M5 — The full thirteen
- [ ] Steps 4–13, one payload builder at a time, each with its test
- [ ] Tail collapse verified: steps 8/10/11/12 show **one** `allocation_costs` row
- [ ] Result assembler, shorts manifest read-back, Convex callback with retries
- **Done when:** one project runs 1→13 and Convex receives a spec §9.6 result with
  `status: completed`.

### M6 — Cohort mechanics
- [ ] Window scheduler, queue-behind, deterministic cohort ids
- [ ] Boot reconciliation (§10.2), tested by killing the process mid-step
- [ ] Estimate with `estimateBasis`, refreshed per step transition
- **Done when:** the process is killed during step 3 and resumes without resubmitting a single job.

### M7 — Measure, then decide
- [ ] §12.1 rate-card cohort → rebuild spec §8
- [ ] §12.2 Wan 2.2 sweep → choose the rung
- [ ] Gate-scope decision from the measured pass rate (§16 q5)
- [ ] Cohort-size cap from the measured cohort duration (§16 q6)
- **Done when:** spec §8's table and §7's rung are both sourced from measurements, and §16 has four
  fewer open questions.

**Explicitly not in the build order:** cohort overlap (spec §3.3). It reintroduces exactly the cap
contention the one-endpoint-at-a-time model exists to remove, and it is only worth it once
throughput actually binds. Revisit when `cohort_deferred` fires regularly.

---

## 14. Test plan

| Layer | What | How |
|---|---|---|
| Unit | Payload builders (§9) | One test per builder, fixtures from real RunPod requests. The `\|\|`-vs-`??` voice bug and the `ceil`-vs-`round` duration bug both get named regression tests |
| Unit | Affinity collapse | A 13-step plan collapses to 9 allocations; a plan with a foreign endpoint between two same-endpoint steps does not collapse |
| Unit | Estimate arithmetic | Known baselines → known minutes; `measured` vs `default` basis |
| Integration (pg) | State machines | Every transition in §8.2/§8.3, including the illegal ones (must throw) |
| Integration (pg) | Invariants (§4.5) | Two live steps, two running cohorts, a completed project with an ungated leaf — all must be rejected |
| Integration (mock RunPod) | Warm timeout, drain timeout, cap breach | Each must `stall`, never proceed |
| Integration (mock RunPod) | Webhook idempotency | Same webhook ×3 → one transition, three 200s |
| Integration (mock RunPod) | Restart safety | Kill mid-step, reboot, assert zero resubmissions and correct resume |
| Contract | spec §9.1 / §9.6 | Round-trip against Convex's schema; unknown fields reject |
| Live smoke (M2+) | One project, steps 1→3 | Real endpoints, shadow fleet |
| Live (M3+) | Scale 0→25→0 | Both verification polls; watchdog silent |

**The single most valuable test in the suite** is the mock-RunPod one where `/health` reports
`workers.ready = 8` after a PATCH to 25 (the silent cap). The step must stall. That is the
13-of-17-frames incident, encoded.

---

## 15. Deployment

### 15.1 The host

4 vCPU / 16 GB / 200 GB NVMe (spec §11's recommended tier). Bluehost NVMe 8 genuinely runs it;
NVMe 16 is comfortable with room for the mirror and an admin UI. The extra load Draft 4 adds — 690
submissions, 690 webhooks, ~1,380 VLM calls per cohort — is I/O concurrency, not compute: it wants
file descriptors and connection pooling, not cores. Raise `ulimit -n`, size the pg pool at 20–30,
and keep an outbound HTTP agent with `keepAlive`.

### 15.2 Non-negotiable host properties (spec §11)

- **Always on** — it owns the window timer and receives every job webhook.
- **Stably addressable and TLS-terminated** — 690 webhooks per step register against this hostname.
- **Durably stored** — Postgres is the only record that a cohort is mid-flight.

Small is fine; ephemeral is not.

### 15.3 Processes

Two systemd units: `qm-orchestrator.service` and `qm-watchdog.service`. Separate restart policies,
separate alert routing. Postgres 16 local, `pg_dump` nightly to object storage, WAL archiving to
the planned mirror. `node-pg-migrate` on deploy, never automatic on boot.

### 15.4 Bandwidth — one thing to confirm

Single-digit GB/month, JSON and API traffic only — **if the VLM takes image URLs**. If it takes
bytes, the host starts moving 690 images a cohort and spec §11's sizing needs redoing. Confirm this
against the evaluator before buying the box.

### 15.5 Secrets

`RUNPOD_API_KEY`, `ORCH_INGEST_TOKEN`, `ORCH_WEBHOOK_SECRET`, VLM key, Convex callback token, pg
credentials. File-based with `0600` and systemd `EnvironmentFile`, or a secrets manager. Never in
the repo, never in the plan JSON.

---

## 16. Open decisions

Two of the spec's seven block a *choice*; none block the *start*. Where each lands in this plan:

| # | Question | Blocks | Resolved by |
|---|---|---|---|
| 1 | **Which Wan 2.2 rung?** $14 → $58 a cohort | Nothing until M7 | §12.2's sweep, after M4's motion gate exists. Build the gate, sweep, then choose |
| 2 | **Does the media container hold everything?** | M1, M5's tail collapse | §12.3's probe. §6.2's affinity rule needs no change either way — the endpoint ids simply differ |
| 3 | **Remotion on RunPod, or keep Lambda?** 8× the cost and a headless-Chrome container to maintain | M1, step 7 | Decide on M1's build experience. Keeping Remotion Lambda costs $0.46 a cohort and breaks only the "no AWS" property — nothing else in this plan changes |
| 4 | **Pod count and GPU choice** | M1's container specs, spec §8's rate card | Two constraints: the media endpoint needs NVENC and almost no VRAM (a cheap encoder-capable card beats a large one); Wan 2.2 at full CFG may need more VRAM than the 4-step rung, which would make rung 1 more expensive than priced |
| 5 | **Quality gate scope** — full / sampled / image-only | Nothing | Ship `full` for the first few cohorts precisely to get the pass rate, then decide against `quality_verdicts.cost_usd` |
| 6 | **Cohort size cap and overflow policy** | Nothing | §6.1 queues rather than rejects and emits `cohort_deferred`. Decide when the metric fires — the cap depends on the rung, so it cannot be settled before question 1 |
| 7 | **One rung catalog or two?** | Nothing | This plan **duplicates**: `steps/catalog.ts` is the orchestrator's own. Sharing risks a change made for cohort behaviour breaking interactive latency. Revisit if the two drift in ways that cause a real bug |

**New, from grounding this in the repo — decide before M3:**

| # | Question | Recommendation |
|---|---|---|
| 8 | **`QM_LIVE_RESERVE_WORKERS`** — how many of the 40 the live path may hold while a background step is live | Start at **8** (§5.2's arithmetic). It is a config value; tune it against real live-path traffic during the background window, which is by design the quietest part of the day |
| 9 | **Does the lease belong in DynamoDB or somewhere neutral?** | DynamoDB. The provisioner already reads that table every tick; a second datastore in the live path's hot loop is a worse trade than a slightly odd home for the row |
| 10 | **Auto-drain on orphan detection, or alert only?** | Alert only, first. Flip `WATCHDOG_AUTODRAIN=true` once the alert has fired a few times and proved it has no false positives — an auto-drain on a false positive kills a live cohort's step |

---

## 17. Appendix — configuration

| Var | Default | Meaning |
|---|---|---|
| `ORCH_WINDOW_CRON` | `0 0,6,12,18 * * *` | Tumbling window close times (UTC) |
| `ORCH_WORKERS_HEAD` | `25` | Per-step target for high fan-out steps |
| `ORCH_WORKERS_TAIL` | `10` | Per-step target for per-project steps |
| `QM_LIVE_RESERVE_WORKERS` | `8` | Workers the live AWS path may hold during a background step |
| `RUNPOD_ACCOUNT_CAP` | `40` | Shared account cap. Mirror of `fleet.ts` |
| `ORCH_FLEET_LIVE` | `false` | When false, log PATCHes instead of sending them |
| `ORCH_WARM_TIMEOUT_MS` | `480000` | Scale-up verification timeout (cold start is 2.5–4 min) |
| `ORCH_DRAIN_TIMEOUT_MS` | `300000` | Scale-down verification timeout |
| `ORCH_RECONCILE_INTERVAL_MS` | `60000` | Straggler `/status` poll |
| `ORCH_MAX_ATTEMPTS` | `2` | Rework cap per job (spec §12.2) |
| `ORCH_QUALITY_GATES` | `full` | Default when the request does not specify |
| `WATCHDOG_INTERVAL_MS` | `60000` | Orphan check |
| `WATCHDOG_AUTODRAIN` | `false` | Alert-only until proven (§16 q10) |
| `ORPHAN_GRACE_MS` | `600000` | How long an orphaned endpoint may hold workers before auto-drain |
| `WORKER_RATE_USD_S` | `0.00021` | 24 GB-class active worker. **An assumption — replace from a real invoice** |

---

## 18. Sources

Grounded in `src/shared/fleet.ts`, `src/handlers/provisioner.ts`, `src/adapters/runpod.ts`,
`src/handlers/webhook.ts`, `src/handlers/shorts-trigger.ts`, `src/shared/persistExternalAsset.ts`,
`src/catalog/background.json`, `docs/qm-agent-loop-quality-director-architecture.md`,
`docs/qm-orchestrator-session-2026-08-31.md` and `infra/lib/pipeline-stack.ts`, all at commit
`a008c66`.

Costs are modelled from an assumed rate card and estimated seconds-per-job. Rebuild spec §8 from
one real cohort's measurements (§12.1) before treating any figure as a budget. Nothing here is
built yet.
