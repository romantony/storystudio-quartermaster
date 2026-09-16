# Orchestrator session — admin dashboard + live incidents — 2026-09-16

**Audience:** Quartermaster engineers.
**Context:** Built the admin dashboard (assets/projects/cost stats + per-project targeted
rework), then live-tested it against the VPS by submitting real test traffic. That testing
surfaced three real, previously-undetected bugs in code shipped earlier the same day
(multi-project cohort support) — all found, fixed, tested, and deployed within this
session — plus one live production incident that was an external RunPod capacity issue,
correctly contained by existing safety mechanisms rather than a code bug.

## What shipped: admin dashboard

- `ORCH_ADMIN_TOKEN` (new required config) gates every `/v1/admin/*` route, plus the
  previously-unauthenticated `GET /v1/fleet` and `GET /v1/cohorts/:id`.
- `GET /v1/admin/dashboard` — self-contained HTML page (`http/routes/dashboard-html.ts`),
  token prompted once into `localStorage`.
- `GET /v1/admin/dashboard/stats` — assets generated/queued/failed, projects
  completed/queued/failed (+ `request_outbox` queued count in batch mode), cost total
  (with the disclosed `allocation_costs`-not-written undercount caveat), cost per project,
  failed-projects list. New `db/repo/admin-stats.ts`.
- `POST /v1/admin/projects/:id/rework` — regenerates only a partial/failed project's
  failed frames via an isolated `{projectId}__repair{n}` sub-project (reuses
  `plan()`/`driveCohort()` unchanged), splices the fixed frames into the original's stored
  result, re-runs concat/caption/mix_bgm directly against postprod-lite, re-finalizes the
  original project. New `agents/rework.ts`, split into `validateRework()` (awaited, fast
  400 on bad input) / `driveRework()` (fire-and-forget, the real generation), mirroring
  `http/routes/requests.ts`'s own `plan()`/`driveCohort()` split.

Deployed and verified live: dashboard reachable, auth returns 401 without a token and 200
with one, real stats returned from the live DB.

## Bugs found live and fixed

### 1. `steps.job_total` never accumulated for a 2nd project joining a cohort step

**Symptom:** Submitted two synthetic test projects into the same cohort (confirmed
`cohortProjects:2`, the multi-project join fix from earlier today held). All 4 real image
jobs (2 projects × 2 frames) landed and ran, but `/v1/cohorts/:id` kept reporting
`job_total: 2` for that step, not 4.

**Root cause:** `insertSteps()`'s `ON CONFLICT (cohort_id, seq) DO NOTHING` (added earlier
today to fix a duplicate-key crash on a 2nd project joining) left `job_total` frozen at
whatever the *first* project set it to. `runStep()`'s own completion check is unaffected —
it live-`COUNT(*)`s the `jobs` table via `stepJobCounts()`, not this column — so this was a
pure observability bug, but a real one: it under-reported every multi-project cohort on
`/v1/cohorts/:id` and the new admin dashboard.

**Fix:** `ON CONFLICT (cohort_id, seq) DO UPDATE SET job_total = steps.job_total +
EXCLUDED.job_total` — accumulates across joining projects; every other column (endpoint,
gate, dependsOn, workersTarget — all cohort-wide, not project-specific) stays as the first
project set it.

**Commit:** `d52fd7f`. Tests: `repo.integration.test.ts` (real Postgres), passing.

### 2. Per-project tail assembler crashed on a real 2nd project's tail (`steps_one_live_per_cohort`)

**Symptom:** Both synthetic test projects finished every *generation* job cleanly
(image/tts/animation all 4/4 ok, 0 failed) — but project B ended `status: 'failed'`, with
its merge/concat steps reported `reason: "not_run"` in the result's `errors[]`.

**Root cause:** `agents/assembler.ts`'s `runAssembler()` drives one project's whole tail
(merge→...→concat) before starting the next project's tail. It only marked
*non-last* tail steps `'complete'` directly after each project's pass (a fix from
2026-09-12 for a single-project multi-step-tail bug); the *last* tail step was left at
`'generated'` — a "live" status — for `release()` to handle, since `release()` was
historically only called once, after every project's tail finished.

But with two projects, project A's tail finishes and leaves its last step (`concat`) at
`'generated'`. Project B's tail then starts, and its first step's `runStep()` call does
`updateStepStatus(..., 'running', ...)` — which collides with project A's still-`'generated'`
last step under `steps_one_live_per_cohort` (one live row **per cohort**, not per seq).
Confirmed via the real error in the orchestrator logs:

```
error: duplicate key value violates unique constraint "steps_one_live_per_cohort"
    at updateStepStatus (db/repo/steps.js:147:5)
    at runStep (agents/generator.js:425:5)
    at runAssembler (agents/assembler.js:66:13)
```

This is a real gap in the multi-project cohort join work shipped earlier the same day: any
2nd+ project sharing a window would hit this the moment its tail ran, in production.

**Fix:** Mark *every* tail step `'complete'` directly after each project's pass, `lastStep`
included. `release()` doesn't require `'generated'` as a precondition — it unconditionally
writes `'draining'` then `'complete'` itself — so this is safe even on the truly final
project's truly final step.

**Commit:** `34a1fe6`. Tests: `assembler.test.ts` (2 new/rewritten cases: every step marked
complete per project, and a real 2-project pass with no thrown error), all passing.

### 3. `reconcileTick()` polled a permanently-dead RunPod job ID forever

**Symptom:** Real live incident on real production traffic (project
`js72stsqxhvxz60vqn7g8hcnds8ehdzh__a1`, cohort `win_2026_09_16_12_r2`). 3 of 13 image jobs
sat in `status: 'submitted'` for 38+ minutes with zero progress. RunPod's `/status` endpoint
404'd on all 3 (`"job not found"`) on every poll — the endpoint was showing
`workers.throttled: 11` at the time (RunPod-side capacity constraint).

**Root cause:** `reconcileTick()`'s status-check `catch` block logged a warning and moved on
for *any* error, with no distinction between a transient network blip (worth silently
retrying) and RunPod definitively saying a job no longer exists (never coming back via that
ID). `RunpodError` already carries a `klass` field from `classifyError()` — 404 resolves to
`'TerminalRetryable'`, the same taxonomy 429/5xx use for `'Transient'` — but `reconcileTick()`
never consulted it. Because `stepJobCounts()`'s `terminal` count never reached `total`,
`runStep()`'s exit condition never fired; and the warm-timeout stall escape only fires when
`terminal === 0` (other jobs in the step had already completed, masking it) — so the step,
and everything downstream, was stuck indefinitely with no automatic recovery.

**Fix:** In `reconcileTick()`'s catch block, a `RunpodError` with `klass !== 'Transient'`
now goes through `markFailedOrRetry()` (same retry ceiling as a normal terminal RunPod
status) instead of being silently retried forever — requeues for a fresh submission, or
fails the job for good once attempts are exhausted. A plain network/timeout error, or a
`Transient`-classified RunPod error (429/5xx), keeps the original silent-retry-next-tick
behavior.

**Commit:** `de4aa36`. Tests: 4 new cases in `generator.test.ts` — 404 requeues, exhausted
retries fail the job and increment the counter, a plain network error still retries
silently, a `Transient` RunPod error still retries silently. All passing.

**Verified live:** redeployed, the fix caught the exact 3 stuck jobs on the next reconcile
tick after restart, requeued them via `markFailedOrRetry`, and the step correctly closed out
(`13/13 attempted, 3 failed` — not stuck).

## Incident: RunPod TTS-endpoint capacity outage (not a code bug)

After bug #3's fix unblocked step 1, the same cohort's step 2 (TTS, endpoint
`rnqxi6c0mlq517`) got **zero workers for 8 minutes straight** and hit the existing
cold-start stall-timeout (`warmTimeoutMs`). The orchestrator's existing safety mechanisms
worked exactly as designed:

- `GeneratorStallError('warm_timeout', ...)` thrown, cohort driver stopped.
- Endpoint emergency-drained (`workersMax` PATCHed to 0) — no runaway billing.
- Project marked `failed`, result assembled (`errors: 85`), callback delivered to
  StoryStudio's production Convex endpoint (`delivery: "delivered"`) — so their own
  outbox retry logic (independently confirmed working correctly earlier the same session:
  a legitimate `stepsJoinable()` busy-cohort rejection was caught as a 5xx and retried with
  backoff) will see the failure and can resubmit.

Checked RunPod directly: the image endpoint (`e165se4r3eo5hp`) showed
`workers.throttled: 11` continuously for 20+ minutes across multiple checks — a real,
ongoing RunPod-side capacity constraint on that GPU pool, not a transient blip and not
something fixable from orchestrator code. Flagged for the RunPod account/dashboard to be
checked (capacity or spend-limit issue on that endpoint's GPU type), not otherwise acted on
this session.

This project is not a good candidate for the new rework feature — the pipeline never got
past step 1, so a full fresh resubmission (StoryStudio's own retry, new `requestId`) is the
correct recovery path, not a targeted per-frame rework.

## Found, not fixed (flagged for later)

- **`repo.integration.test.ts` test-isolation flakiness.** Running the full integration
  suite against a real local Postgres for (apparently) the first time in this environment
  surfaced 3 failing tests, all pre-existing and unrelated to this session's changes:
  `sharedCohortId` is reused across nearly every test in the file, and `seqBase()` returns a
  *random* (not incrementing) seq number, so tests can collide with rows an earlier test in
  the same run left behind — both a `stepsJoinable()` false-negative and two
  `steps_one_live_per_cohort` duplicate-key errors, purely from fixture collisions. Not
  exercised by CI/this environment before now, so unknown how long it's been broken.
- **`prepareCohort()` (prompt-harness prep) unconditionally reruns from scratch on every
  cohort resume**, even when it already fully completed once. Confirmed live: a redeploy
  mid-cohort re-ran full LLM-based contract extraction/lint/regenerate for all 13 frames
  again (~8 minutes, real LLM API cost), delaying the resumed cohort by that much before the
  bulk driver even got a chance to run. "Harmless" by design (idempotent, no-op on
  already-generated content) but wastes real time and money on every restart of a cohort
  that already went through it once.

## Verification summary

- `npm run build`: clean after every fix.
- Full mocked-unit suite (`npx jest orchestrator/__tests__`): 33/34 suites, 376+ tests
  passing throughout (1 suite — the DB-integration suite — skips without a local Postgres;
  run explicitly against a throwaway container for bugs #1/#2).
- All three fixes deployed to the VPS and re-verified against real, live traffic
  (synthetic test projects for #1/#2; real production traffic for #3).
