# Quartermaster — TODO

Running list of planned/queued work not yet in progress. Add a target date range where known; move to a dated doc under `docs/` once actually started.

## Next session (2026-09-11) — QM Orchestrator live acceptance tests

Both M3 and M4 are code-complete, tested (116/116 orchestrator tests), deployed to the
VPS, and confirmed healthy — but neither has been proven against real RunPod/Replicate
infra since their latest fix. Two separate, deliberate live tests, in this order:

- **M3 re-verification — DONE 2026-09-11.** The very first unattended attempt (before
  today's deliberate test even started) hit a real incident: 5 orphaned `qwen-image-gen`
  workers billed for 2h16m because the driver never compensated a step failure right
  after a `workersMax` PATCH. Fixed (retry the `ENDPOINT_PAUSED` race, `emergencyDrain()`
  on any driver failure path, `WATCHDOG_AUTODRAIN=true`), then the retry budget itself
  turned out too short for `flux-tts-s2t` on the next attempt — widened to jittered
  backoff. Third attempt (cohort `win_2026_09_11_12`) passed clean: all 3 steps scaled
  0→N→0 unattended, zero watchdog alerts. Commits `e681651`, `56110c0`. See the
  2026-09-11 memory entries for the full incident writeup.
- **M4 live acceptance — attempted 2026-09-11, inconclusive, retry blocked on external
  billing.** Image gate passed a hard prompt cleanly (10/10, first try) — validates the
  pass path, but didn't exercise rework (need a harder trigger next time, e.g. exact
  multi-entity counting/ordering rather than legible text — `qwen-image-gen` handled the
  text prompt fine). Motion gate never resolved: **Replicate account has under $5 credit**,
  which 429s both vision models on every attempt — confirmed by replaying the call
  manually, not a code bug. Manually drained `wan2-i2v` and closed out the cohort before
  the newly-enabled `WATCHDOG_AUTODRAIN` would have force-drained it mid-gate. **Top up
  Replicate credit before re-attempting.** Two real orchestrator gaps surfaced, not yet
  fixed: the quality gate's infra-failure retry has no cap (spins forever on a persistent
  outage, unlike the 2-attempt content-rework cap), and it doesn't coordinate with the
  watchdog's endpoint-ownership model. See §13 M4 in the implementation plan doc for the
  full writeup.
- Clean up each test's cohort/project row afterward the same way earlier ones needed
  (`UPDATE cohorts SET status=...` — M6 doesn't auto-close cohorts yet, a known gap
  documented in `docs/qm-orchestrator-agent-flow.md`).
- After both pass: M5 ("the full thirteen" — steps 4–13, result assembler, Convex
  callback) is the next milestone per §13's build order.

## Queued

- **EC2 cleanup — terminate 2 stopped doc-finalize instances** (blocked on: orchestrator VPS migration for batch jobs — see `docs/qm-orchestrator-session-2026-09-{09,10}.md` — must finish first; this is explicitly sequenced after that, not concurrent)
  Found 2026-09-10 while investigating why `EC2-Other` didn't drop with the rest of the September AWS bill (see `qm-aws-cost-check-20260910-and-vps-sequencing` + `qm-ec2-other-cost-stopped-instances-20260910` memory). No NAT gateways or unattached EIPs anywhere — checked all 17 enabled regions, clean.
  - `i-08cc9f9f99b07cc32` (`storystudio-finalize`, c6in.large, 40GB gp3) — stopped 2026-06-06, 42 min after launch. Idle ~3 months.
  - `i-0a433fc67c0bc0719` (`documentary-basic-finalize`, c6a.xlarge, 100GB gp3, tagged `FinalizeJobId` containing `test`) — stopped 2026-05-09, 1 min after launch. Idle ~4 months.
  - Both belong to storystudio-unified's EC2-based doc-finalize mechanism, not quartermaster's own infra. Stopped (not terminated) within minutes of launch suggests a per-job ephemeral worker whose teardown step should terminate but doesn't — worth checking that code path before just deleting these two, in case the same bug is still live and will keep leaving new orphans.
  - Combined EBS storage ≈ $11.20/mo at gp3 rates — accounts for essentially all of the observed `EC2-Other` line.
  - Action once unblocked: confirm neither instance is still referenced by any live doc-finalize execution, then terminate both.

- **Project-wise + shared-service cost dashboard** (target: 2026-08-25 → 2026-08-29)
  Build a dashboard showing AWS spend broken down (a) per-project and (b) per shared/common service, and share it out. Groundwork/investigation already done — see `qm-project-wise-cost-attribution-investigation` memory:
  - `projectId` already exists on jobs; GPU cost already tracked per-project (`PROJECTCOST#{projectId}` DynamoDB items) — extend this pattern to Lambda + Step Functions cost (can't be tagged natively, must be self-tracked).
  - ECS Fargate task runs and S3 object uploads can get *real* native AWS Cost Explorer per-project breakdown by tagging with `ProjectId` at creation time — DynamoDB, Lambda, Step Functions cannot (shared-resource billing).
  - Cost allocation tags are currently 100% inactive account-wide — needs activating in Billing preferences first (free, ~24h propagation).
  - Precondition: check back on 2026-08-25 whether the 2026-08-23 `queue-index`/`lease-reclaim-index` DynamoDB fix actually dropped the AWS bill before building the dashboard on top of possibly-still-wrong baseline numbers.

## Open bugs (not scheduled)

- **Orphaned PROCESSING jobs**: `claimJob()` (executor.ts) sets no expiry, so a job stuck mid-flight when its Lambda invocation dies is never reclaimed. Found via the 2026-08-23 archive (130 such jobs, 3–8 days stuck). Needs a generic staleness reclaim independent of the modelslab-specific lease mechanism.
- **LeaseItem cleanup blocked**: 44,194 stale `LeaseItem` records (zero have `ttl`, none written since 2026-08-09) still need the same archive-to-S3-then-purge treatment already done for JobItems — attempt was blocked by the auto-mode safety classifier on 2026-08-23, needs a manual run or explicit permission grant.
- **Why did LeaseItem writes stop on 2026-08-09?** Unconfirmed hypothesis: traffic moved onto newer Step-Functions-orchestrated pipelines, bypassing `executor.ts`'s older rung-ladder/`acquireSimple()` dispatch path. Worth confirming — if wrong, the per-endpoint concurrency gate's crash-recovery safety net may be silently non-functional.
