# Orchestrator build session — M2 (plan and generate, shadow fleet) — 2026-09-10

**Audience:** Quartermaster engineers.
**Status:** M2 DONE. Code complete, 56 tests green, deployed to the VPS, and the real
acceptance run completed successfully — 54/54 jobs across steps 1→2→3, zero failures.
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

## The real acceptance run — DONE

Deployed to the VPS (pulled `2c9a3bd`, rebuilt, applied migration `006`, restarted; added
the now-required `ORCH_PUBLIC_BASE_URL` and `RUNPOD_API_KEY` to `.env`/`docker-compose.yml`
— neither had been wired through before, a real gap this run surfaced and fixed).
`ORCH_WORKERS_HEAD` set to 5 for the test (later, real capacity ended up far exceeding that
via manual scaling — see below).

**Submitted a real 90-second, 18-frame narration-basic project** (cohort `win_2026_09_10_06`,
project `req_m2test_20260910_03` — the third attempt; see "What actually blocked the first
two attempts" below). **Result: 54/54 jobs (18 × 3 steps) complete, zero failures.**

| Step | Endpoint | Jobs | Wall-clock | Avg exec | Min / max exec | Avg queue delay |
|---|---|---|---|---|---|---|
| 1 image | qwen-image-gen | 18/18 | 5m 24s | 47.4s | 9.4s / 163.0s | 12.2s |
| 2 tts | flux-tts-s2t | 18/18 | 2m 52s | 9.5s | 1.2s / 36.7s | 5.2s |
| 3 animation | wan2-i2v | 18/18 | 15m 20s | 79.9s | 77.1s / 87.8s | 130.0s |

Real per-worker cold-start, from the actual RunPod worker logs (qwen-image-gen): model load
takes **~124-152s**; once warm, real generation is **~7.7-7.8s/image** — matches the image
step's min-exec figure. Zero errors anywhere in the logs across all 18 generations.

**What actually blocked the first two attempts — a real, generalizable finding.** Every
endpoint in this test (`qwen-image-gen`, `flux-tts-s2t`, `wan2-i2v`) is a shared live-path
endpoint that normally runs at `workersMin=0`, scaling up organically from real traffic.
`agents/fleet.ts`'s `allocate()` polls real `workers.ready` and only lets the generator
submit *after* verification passes — but with `workersMin=0` and no jobs queued yet, nothing
prompts RunPod to actually provision workers: a genuine chicken-and-egg deadlock. The first
two attempts stalled (hit the 8-minute `warmTimeoutMs`) for exactly this reason. Confirmed via
the user's own RunPod worker logs that workers were loading correctly the whole time (no
errors), just gradually — RunPod does not appear to provision many new workers in parallel
for one endpoint; each new worker's cold model-load (~2.5min) seems to gate the next.

**Fix used for this session**: real, manual `workersMin`/`workersMax` PATCHes via the RunPod
REST API, done by hand in sync with the driver's own step transitions — scale the next
step's endpoint up *before* it needs to allocate, scale the previous one down to 0 the
moment it finishes (shadow mode's `release()` never sends the real scale-down PATCH, so its
own drain-verification would otherwise hang on real leftover workers — this happened once,
on step 1→2, until manually fixed). This is **not** the fully automatic parallel/shadow flow
the design targets (M3+) — it was a manually-orchestrated, sequential, one-endpoint-at-a-time
run. It proves the mechanism (DB state machine, webhook receipt, idempotent submission,
dependency resolution across steps) works correctly end to end against real infra; it does
not yet prove unattended cold-start-from-zero works without a human in the loop — that
question is really M3's (`ORCH_FLEET_LIVE=true`, real automatic scaling) to answer, with a
watchdog. Worth deciding before M3 whether `allocate()` should send an initial `workersMin`
nudge itself (even in shadow mode) rather than relying on organic demand, given how it
behaved here on endpoints with `workersMin=0`.

**Final cleanup verified**: all 4 touched endpoints back to `workersMin=0`/`workersMax=0`
(zero lingering cost). `multitalk` (1) and `PostProd-Lite` (2) were untouched by this test
— `multitalk`'s earlier 3→1 reduction (M1 session) is a standing decision, not reverted.

This closes M2's "done when" criterion — see the implementation plan §13.

## Not done / next steps

1. `caption`'s Whisper-vs-precomputed-chunks gap (noted in `postprod-lite/API.md`, M1) —
   unrelated to M2, still open.
2. `step_baselines` isn't written yet — `telemetry/ledger.ts`'s estimate stays
   `estimateBasis: "default"`. This run's real per-job timings (above) are the first real
   data available to seed it, whenever that's built.
3. Peak-VRAM instrumentation, deferred from M1, still open.
4. Whether `agents/fleet.ts` should proactively nudge `workersMin` itself (see above) is
   worth resolving before M3 flips `ORCH_FLEET_LIVE=true` for real.

See `docs/qm-orchestrator-implementation-plan.md` §13 for the full M2 checklist.
