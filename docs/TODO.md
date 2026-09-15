# Quartermaster — TODO

Running list of planned/queued work not yet in progress. Add a target date range where known; move to a dated doc under `docs/` once actually started.

## 2026-09-15 (later same day) — prompt harness & guardrails: built, NOT deployed/committed

Implements `docs/qm-orchestrator-prompt-harness-implementation-plan.md` H1-H2-H4 (contract, seed
guardrails, lint, compile, GPT-5 mini regenerate tool, corrective ladder, findings/corrections).
All in `orchestrator/src/harness/` + migration `009_prompt_harness.sql` + wiring into
`planner.ts`/`orchestrator.ts`/`quality.ts`/`config.ts`. 315/315 tests passing (28 suites, 44 new
harness tests), `tsc --noEmit` clean. `npm run harness:lint -- <request.json>` and
`npm run harness:promote` work locally (smoke-tested against a fixture request, zero network calls
when every frame carries `shot`).

**Design deviations from the doc, deliberate:**
- `prepareCohort()` runs synchronously in `orchestrator.ts` before the bulk loop (not the doc's
  async-before-bulk-steps phrasing — same effect, simpler: no separate job-graph bookkeeping).
- The video ladder's fix for a `fixTarget: 'image_prompt'` finding (V-CAM-03/V-DIR-02) edits and
  recompiles the CURRENT (motion) prompt only — it does NOT reopen the sibling image job. That
  would touch `jobs.deps_remaining`, which 005_invariants.sql and the generator's dependency graph
  rely on; scoped out rather than risked. Flagged via `crossDomainFixDeferred` in the finding.
- The legacy `quality/rewrite.ts` path is UNCHANGED and still used for any job without
  `input.contract` (harness off, or extraction failed) — every existing rework test passes
  untouched. The harness ladder only activates when a contract is present.

**Not built (explicitly out of scope this pass):**
- The Python `motion_probe` mode on postprod-lite (§7.4) — client code exists
  (`harness/probe/motion-probe.ts`), calls will fail gracefully until that endpoint exists (same
  build-then-deploy pattern as DreamX/MMAudio). The video ladder works from VLM issues alone until
  then.
- §7.5's calibration sweep (360 live Wan2 clips, ~$7) — the profile capability tables
  (`harness/profiles/*.ts`) are hand-seeded from the Maya evidence, not yet measured.
- §9.4's replay-before-activate — `harness:promote` writes `proposed` rows; activation is manual
  (`POST /v1/harness/guardrails/:id/:version/activate`), no replay report yet.
- Migration 009 not applied anywhere live; nothing in this branch has been deployed to the VPS.

**Next steps, in order:** apply migration 009 on the VPS DB; run a real cohort with
`promptHarness: 'lint'` (shadow mode) to compare `harnessImagePrompt`/`harnessMotionPrompt` against
production output before flipping to `'enforce'`; re-run the Maya request (§13 acceptance test) once
in `'enforce'` mode.

## Next session (2026-09-15) — DreamX upscale (step 14) + MMAudio SFX (step 15): deploy + live test

New per-frame flow when `options.upscale` (engine `dreamx`, the default) and `options.sfx` are set:
image → tts → animation (3) → **upscale-frame (14, DreamX `w0h49vn1pn0r87`)** → **sfx (15, MMAudio
`nzkcsef9t2iv7s`)** → merge (6, postprod-lite, now with `sfx_url` mixed under narration at 0.22).

State at end of 2026-09-14:
- **Step 14:** code + tests done, **deployed to the VPS** (orchestrator + watchdog rebuilt).
  Builder payload live-verified on DreamX: `sr_scale: 2.25` → 1856×1056, 81 frames kept, ~66s/clip.
  (Wan2 "480p" is really 832×464, so `target_height: 1080` gets rejected at 2.328x. 2K isn't reachable.)
- **Step 15:** orchestrator code + tests done (198/198, tsc clean), **NOT deployed to the VPS**.
  MMAudio v2a verified live on the upscaled clip (5.04s SFX in 5.6s).
- **postprod-lite `merge` + `sfx_url`:** handler changed in `~/flux4B-Wan2/Flux-klien-4b/postprod-lite`
  (**uncommitted**). Image built locally and **pushed** as `romantony/story-studio-postprod-lite:latest`
  (+ `:sfx-merge-20260914`). ffmpeg levels verified in Ubuntu 22.04 and inside the built image with
  real assets: narration −27.3 dB unchanged, SFX at 0.22x, no volume jump when the SFX ends first.
  **The endpoint has not been refreshed**, so standby workers may still run the old image.
- **Nothing committed** in either repo. The quartermaster working tree also has the uncommitted
  tts→i2v duration change from 2026-09-12.

To do, in order:
1. ~~**Refresh postprod-lite**~~ **DONE 2026-09-15.** Endpoint was already at workersMax 0 with 0 workers
   (the orchestrator now scales it per step), so there was nothing stale to drain. Opened it to 1 worker
   with the watchdog paused. A fresh worker (`ho1h3nqnp0tdla`, ~7 min cold pull) ran a real `merge` on the
   09-12 f01 clip + narration, using the 09-12 BGM mp3 as the `sfx_url` stand-in. It returned
   `sfx_mixed: true`. Least-squares fit against the sources: narration ×0.998 (unchanged), SFX ×0.220,
   residual −57.8 dB. Output is stereo 48k when SFX is mixed (mono 24k without). Restored to workersMax 0,
   watchdog restarted.
2. ~~**Deploy step 15 to the VPS.**~~ **DONE 2026-09-15.** No open cohort. A full-tree hash compare
   (local vs VPS `src/` + `__tests__/`) found 13 differing files, all local-only additions: the step-15 set,
   plus 09-12 test additions that had never been synced (`assembler`, `repo.integration`, `watchdog`,
   `runpod-output` tests). No VPS-only edits. Local tsc clean, 198 passed / 11 skipped. Run jest from the
   repo root: running it inside `orchestrator/` skips ts-jest and every suite fails to parse. Backed up
   the old VPS copies to `/opt/qm-orchestrator/pre-step15-backup-20260915.tgz`, synced (hashes verified),
   rebuilt + restarted orchestrator and watchdog. Built image contains `dist/steps/builders/sfx.js`. The
   watchdog now watches `nzkcsef9t2iv7s` and autodrained MMAudio's standby pool on its first tick
   (0 workers ~10s later).
3. ~~**Full live cohort test**~~ **PASSED 2026-09-15.** Cohort `win_2026_09_15_00`, project
   `sfx-upscale-e2e-20260915-01` (3-frame Maya, upscale+sfx+removeSilence, gates off). 22/22 jobs, 0 failures,
   02:45→03:19 (34 min). Step 14 capped at 3 workers, merge fan-in `[15]`. Checked each item:
   - DreamX output 1856×1056 on all 3 frames. Merge `sfx_mixed: true` ×3.
   - Fit against each frame's own TTS + MMAudio track: narration ×0.998–0.999, SFX ×0.214–0.219,
     residual ≤ −59 dB.
   - All endpoints back to 0 workers. Cohort row closed manually (M6 gap).
   - Final concat: `…/20260915031859_5e6c4ec7-16a7-44ce-bf72-566cfc907765-u2_concat.mp4` (10.06s).
   **Findings (both addressed 2026-09-15):**
   - **SFX sounded quiet → loudness normalization added.** postprod-lite `merge` now gains the SFX to the
     narration's EBU R128 integrated loudness before `sfx_volume` (capped at +30 dB and at a −1 dBFS peak;
     skipped if either track is silent). The result reports `sfx_gain_db`. Live-verified on
     `n6252hm01qz0xh`: f03 +5.9 dB (SFX ×0.432 measured, 0.434 expected), f02 −4.7 dB.
     **Turned out MMAudio isn't actually quiet**: gated loudness is about the narration's (f01 −23.2 vs
     −23.6 LUFS). The low mean came from silence between events. So normalization removes per-clip swings
     but doesn't raise average audibility; that's `sfx_volume` 0.22 (≈13 LU under narration). **Open:**
     listen and decide whether to raise `sfx_volume`, then re-check remove_silence.
     Gotcha: image ffmpeg 4.4.2 rejects `ebur128 framelog=quiet` but still prints an all-zero Summary.
     Use `framelog=verbose` and check the return code.
   - **Watchdog false positive on step seq 0 → fixed + deployed.** `src/watchdog.ts` `!heldByStep` →
     `heldByStep == null`, regression tests added (200 passed). Live proof pending the next cohort that
     runs step 0.
   - **Local disk:** the root disk filled (279G) during the postprod-lite rebuild. BuildKit had evicted
     cache at 99% disk, so the rebuild ran from scratch and wrote a new 26 GB image. Deployed the loudnorm
     change as a thin `FROM :sfx-merge-20260914` + `COPY handler.py` overlay (pushed `:latest` +
     `:sfx-loudnorm-20260915`). A CI build from git reproduces the same content.
4. ~~**Commit**~~ **DONE 2026-09-15** (user-approved). quartermaster: orchestrator changes (steps 14 + 15,
   the 09-12 tts-duration/clone-artifact change, the watchdog fix). `flux4B-Wan2-storystudio`: postprod-lite
   handler + API.md. **Not pushed.** Push postprod-lite before any CI build so CI doesn't overwrite `:latest`
   with an image missing the sfx/loudnorm changes.
5. ~~Open question: `remove_silence` + SFX~~ **Answered 2026-09-15.** At `sfx_volume` 0.22 the SFX sits mostly
   under silencedetect's −35 dB threshold (100ms-RMS max −28 to −38.5 dB), so removal still works. It trimmed
   a 0.63s pause in f02, and f01/f03 were untouched. It will cut SFX-only moments along with dead air.
   **If `sfx_volume` is raised (see step 3 findings), re-check this:** SFX above −35 dB will stop pauses
   being trimmed.
6. License reminder: MMAudio checkpoints are CC-BY-NC-4.0. `options.sfx` is opt-in by design.
7. **MMAudio mp4 + audio prompt (2026-09-15, user request). Built, deployed, live-verified, committed + pushed.**
   - Step 15 sends `return_video: true`, and MMAudio returns the clip with SFX/ambience muxed in (video
     stream-copied: bit-identical to DreamX). Merge now consumes that mp4 with `sfx_from_video: true`
     (narration over the mp4's own audio, same normalization). The standalone SFX mp3 isn't used.
   - Prompt: new optional per-frame `audioPrompt`. Fallback is
     `ambient environmental sound and sound effects of the scene: <imagePrompt>` (was `motionPrompt`,
     i.e. camera direction). **StoryStudio/MCP must start sending `audioPrompt`** to get authored prompts.
   - `runpodOutUrl` now resolves video keys before audio keys (MMAudio's output has both). None of the
     102 historical job outputs had both.
   - postprod-lite: `sfx_from_video`, plus a **44.1 kHz mix output**. amix followed the 24 kHz TTS rate
     and removed SFX content above 12 kHz; f02's MMAudio track was almost all above that. Image
     `:sfx-from-video-20260915` = `:latest` (thin overlay).
   - Live (manual payloads matching the builders): MMAudio ×3 → merge ×3, 44.1 kHz, narration ×0.999,
     SFX at the normalized level. Outputs `…/storystudio/video/sfx-video-e2e-20260915-01_f0{1,2,3}_merge.mp4`.
   - Pending: a real cohort run through the planner/builders (not yet exercised end-to-end).
     204 orchestrator tests pass.
   - Gotcha: python urllib → rest.runpod.io gets Cloudflare 403 (error 1010) regardless of UA; use curl.

## M5 — remaining work (audited 2026-09-15)

The plan doc's §13 M5 checklist is stale. Actual state:

- ✅ Project Assembler Agent + the whole tail (6/7/8/10/11/12) ran live on 09-12 and 09-15.
- ✅ `resolveDeps()` project_id filter (§16 q12).
- ✅ **§6.7 result assembler + callback. Built 2026-09-15, deployed to the VPS (migration 008 applied), NOT committed.**
  - `src/result/assemble.ts`: §9.6 builder. The leaf is the last step in execution order (the spec's
    `max(seq)` rule is wrong since 14/15 run before merge). Status is completed / partial / failed.
    `errors[]` capped at 200 with `errorsTotal`.
  - `src/result/callback.ts`: 8 attempts, 1s→5min backoff; retries network errors, 5xx, 408, 425, 429;
    any other 4xx = rejected. Optional `X-QM-Signature` HMAC (new `ORCH_CALLBACK_SECRET`, unset on
    the VPS = unsigned).
  - `src/result/finalize.ts`: `driveCohort` now ALWAYS finalizes, stalls included. It stores the result,
    sets project status, **closes the cohort row** (no more manual `UPDATE cohorts`), then delivers
    callbacks concurrently, persisting each attempt in `projects.callback_attempts`. The cohort row
    closes before delivery, a deliberate deviation so a down receiver can't hold
    `cohorts_one_running` for about 16 minutes.
  - Verified: 224 tests pass. Migration 008 up/down/up on throwaway PG. End-to-end on a copy of real
    cohort `win_2026_09_15_00`: result `completed`, real final URL/bytes/resolution/steps/cost; a local
    receiver got 503 then 200 → `delivered`, both attempts persisted, signature valid, cohort closed.
  - **Pending: a live cohort run** (combine with item 7's MMAudio-mp4 cohort test above).
- ⬜ `allocation_costs` never written, so there's no tail-collapse evidence and §9.6 `metrics.warmCostUsd`
  is null.
- ⬜ Catalog steps 9 (subtitles/SRT), 13 (shorts; `assets.shorts[]` stays `[]`), 4 (lip-sync, dialogue-only).
- ⬜ **Convex receiver in storystudio-unified.** None exists. M5's "done when" = Convex receives the
  §9.6 result. Needs a route plus signature verification (share `ORCH_CALLBACK_SECRET`).

## (Superseded 2026-09-15) M5 phase 1 live verification — tail ran live 09-12 and 09-15

M5 phase 1 (Project Assembler Agent + step 6/merge, commit `713f889`) is built, deployed,
watchdog fix verified live (caught + auto-drained 2 real idle `postprod-lite` workers that
had been running unclaimed since M1, ~a day). **Step 6 itself was never actually reached/
tested live** — stopped mid-run at the operator's request before the assembler got a chance
to fire. Pick up here:

- Bulk steps 1→3 ran clean (cohort `win_2026_09_11_12`, project
  `m5-live-verify-20260911-06`). Real, useful signal along the way: the motion gate's
  Replicate calls worked again (this morning's under-$5-credit throttling is resolved —
  worth confirming that's durable, not a fluke) and returned a **genuine content FAIL,
  score 4.9** on this prompt/output — a real prompt-quality data point, not an infra issue.
- Stopped before the resulting rework cycle finished; manually drained `wan2-i2v` (5 real
  workers, mid-rework) before ending the session. Cohort marked `failed`, all 4 endpoints
  confirmed at 0 real workers, watchdog confirmed silent.
- **To resume:** clean up `win_2026_09_11_12`'s leftover project/steps rows the same way
  earlier same-window tests needed (`DELETE FROM projects/steps WHERE ...`) if still in that
  6h window, then resubmit and watch specifically for step 6 (merge) — allocate-once on
  `postprod-lite`, per-project draw, release-once, zero watchdog alerts. That's M5 phase 1's
  actual "done when" bar; it hasn't been met yet.
- Use a less content-failure-prone test prompt this time (or accept a rework cycle as part
  of the test) so the run isn't blocked on the motion gate again before reaching step 6.

## Prior session (2026-09-11) — QM Orchestrator live acceptance tests

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
