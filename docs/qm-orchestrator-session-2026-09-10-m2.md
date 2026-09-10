# Orchestrator build session — M2 (plan and generate, shadow fleet) — 2026-09-10

**Audience:** Quartermaster engineers.
**Status:** M2 code complete, 56 tests green, real acceptance run against the VPS still pending.
**Plan:** `docs/qm-orchestrator-implementation-plan.md` §13 M2. **Spec:** artifact
`1ee33d6b-b99b-45cd-8717-e082b76ec008`.
**Predecessor:** M1 (`postprod-lite` endpoint, deployed + measured, same day).

## What shipped

The planner, generator, and fleet controller (§6.2-6.4), wired behind `POST /v1/requests`
via a minimal driver (`agents/orchestrator.ts`) rather than a standalone loop — the
tumbling-window scheduler that would run them independently of a request is M6, not M2.

**New migration `006_step_deps.sql`** — a real gap in `001_init`, not previously noticed:
the spec's own §9.3 plan JSON carries a `dependsOn` array per step, but `001`'s `steps`
table never got a column for it. Added `depends_on int[]`, applies/rolls back cleanly.

**Planner only plans catalogued steps.** `steps/catalog.ts` registers steps 1 (image),
2 (tts), 3 (animation) only — the vertical slice M2 is scoped to. The planner itself
resolves the *full* 13-step topology from tier/options (a plain narration-premium
request naturally resolves to `[1,2,3,6,8]`; a dialogue tier adds 4; options add
5/9/10/11/12/13) but filters to what's catalogued, logging a warning for the rest. This
is deliberate: M5 adding steps 4-13's catalog entries is the only change needed to widen
what actually runs — `planner.ts` itself doesn't change. Step 7 (Remotion) never appears
at all; it stays on the existing AWS Lambda, not part of the orchestrator's own plan.

**Payload builders** (`steps/builders/{image,tts,i2v}.ts`) ported verbatim from
`src/adapters/runpod.ts`'s `t2i`/`tts`(Kokoro)/`i2v` cases, including the `||` vs `??`
empty-string fix and the `Math.ceil` (never round) duration fix already documented there.
Pure functions — a step's dependency (e.g. i2v needs step 1's generated image URL) is
resolved by the generator *before* calling the builder, not by the builder itself.

**Worker count is plan-time, not catalog-time.** Originally had `workers: 25` hardcoded
per catalog entry — caught before it shipped that this would make the fleet controller's
real health-check verification wait forever for 25 workers a hand-scaled test would never
provide. Fixed: `steps/catalog.ts` carries no worker count at all; `planner.ts` sets every
planned step's `workers_target` from `cfg.workersHead`, so the persisted plan and the
fleet controller's verification always agree on what a real test actually set.

**Webhook auth is compute-then-compare, not decode.** `agents/generator.ts`'s
`webhookToken(secret, jobId)` is a one-way HMAC — the receiver can't recover `jobId` from
it. It looks the job up via RunPod's own job id in the payload body (already stored as
`jobs.runpod_job_id` at submission time), then recomputes the expected token from that
job's id and compares (`timingSafeEqual`). A mismatch or unknown RunPod id is ignored.

**New required config: `ORCH_PUBLIC_BASE_URL`.** Didn't exist before M2 — needed to build
each job's per-job webhook callback URL. No default; spec §11 is explicit that hostname
stability here is a correctness requirement, not a convenience.

## Two real bugs the integration tests caught (both fixed, not just noted)

1. **`windowId` used the raw current hour**, not the window's opening hour (00/06/12/18) —
   two timestamps in the same 6-hour window produced *different* cohort ids, defeating the
   entire point of a deterministic id (§6.1: "a restart mid-window rejoins the same cohort").
2. **`ensureCohort` didn't handle a different cohort still being `running`** —
   `005_invariants`'s `cohorts_one_running` unique index rejected the insert with a raw,
   cryptic Postgres constraint error instead of something `POST /v1/requests` could turn
   into a clean response. Added `CohortBusyError`, a named, catchable error for exactly
   the case M6's real queue-behind logic will resolve properly later.

## Not done / next steps

1. **The real acceptance run** — deploy to the VPS, hand-scale one endpoint's real worker
   count to match the small number the test plan will carry, `POST /v1/requests` with a
   real 3-5 frame narration project, confirm via `GET /v1/cohorts/:id` that steps 1→2→3
   complete with `job_costs` populated from real `execution_ms`/`delay_ms`, and read the
   shadow log line by line (M2's own stated purpose — "this is where finding C is retired").
2. `caption`'s Whisper-vs-precomputed-chunks gap (noted in `postprod-lite/API.md`, M1) —
   unrelated to M2, still open.
3. `step_baselines` isn't written yet — `telemetry/ledger.ts`'s estimate stays
   `estimateBasis: "default"` until a real cohort's timings exist to average.
4. Peak-VRAM instrumentation, deferred from M1, still open.

See `docs/qm-orchestrator-implementation-plan.md` §13 for the full M2 checklist.
