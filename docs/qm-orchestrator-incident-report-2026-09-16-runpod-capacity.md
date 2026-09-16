# Incident report — 4 real production project failures, 2026-09-16

**Audience:** Quartermaster + StoryStudio engineers.
**Window:** 2026-09-16 ~06:39 UTC – ~16:46 UTC.
**Impact:** 4 real StoryStudio production requests failed or partially failed. All 4
delivered a clean failure/partial callback (StoryStudio was notified promptly and
correctly in every case — nothing hung silently from their side).
**Root cause (3 of 4):** a sustained RunPod GPU-capacity/queue backlog on the image, TTS,
and animation endpoints, lasting from minutes up to **~90 minutes** of queue delay per
job — far longer than the orchestrator's 8-minute stall-detection window. This is an
external RunPod-side capacity issue, not an orchestrator code bug. As of 16:55 UTC, all
three affected endpoints report clean health (0 queued, 0 throttled) — capacity has
recovered.
**Root cause (1 of 4):** a pre-existing CUDA-OOM incident from earlier today (before the
capacity issue), already understood and partially mitigated.

| Project | Tier | Status | Root cause |
|---|---|---|---|
| `js72stsqxhvxz60vqn7g8hcnds8ehdzh__a1` | narration-premium | failed | RunPod TTS queue backlog (~31–39 min delay); 3 image frames also lost 404s |
| `js76a6d9k3eze1t30xyrrkrwt58eghfj__a1` | narration-premium | partial | Pre-existing CUDA OOM incident (5 frames), unrelated to today's capacity issue |
| `js77awr2f85k06d7yka0q72yqn8eg1bk__a1` | narration-basic | failed | RunPod animation queue backlog (~75–91 min delay) |
| `js7efefanw2exz1863fh002w5x8eg5er__a1` | narration-basic | failed (2/10 frames) | 2 image jobs lost (RunPod 404 "job not found"), same backlog window |

---

## 1. `js72stsqxhvxz60vqn7g8hcnds8ehdzh__a1` (narration-premium)

**Cohort:** `win_2026_09_16_12_r2`. **Result:** `failed`, callback delivered 14:12:33 UTC.

**Timeline:**
- Step 1 (image, 13 frames): 3 jobs' RunPod job IDs vanished — `GET /status` returned
  `404 "job not found"` on every poll. These 3 had already used both retry attempts before
  the outage, so once caught (see §4 below — this part **was** an orchestrator bug, fixed
  same day) they failed for good rather than being requeued a 3rd time. Other 10 image
  frames completed normally.
- Step 2 (TTS, endpoint `rnqxi6c0mlq517`): submitted 14:04:28. `runpod.health()` reported
  **zero ready workers for the full 8-minute `warmTimeoutMs`**, with `terminal === 0` at
  every check in that window, so the orchestrator correctly declared a stall at 14:12:32,
  emergency-drained the endpoint (no further billing), marked the project `failed`, and
  delivered the callback at 14:12:33.
- **What happened after we gave up:** all 13 TTS jobs actually completed successfully —
  just **31–39 minutes later** (`completed_at` timestamps 14:43:18–14:43:55), well after
  the project was already marked failed and StoryStudio notified. RunPod kept working the
  backlog after our drain PATCH; it stopped new work from being scheduled but did not
  cancel jobs already in RunPod's queue.

**Cost:** $0.129 total — RunPod's serverless billing is execution-time-only
(`delay_ms`/queue-wait is not billed), so the long queue delay itself cost nothing extra;
the failure was pure lost customer time, not spend.

## 2. `js77awr2f85k06d7yka0q72yqn8eg1bk__a1` (narration-basic)

**Cohort:** `win_2026_09_16_12_r3`. **Result:** `failed`, callback delivered 14:52:34 UTC.

**Timeline:**
- Step 1 (image, 14 frames): completed, but took ~18 minutes (14:20:46 → 14:39:08) —
  already an early sign of the same capacity crunch.
- Step 2 (TTS): completed in ~5.3 minutes.
- Step 3 (animation, endpoint `nd7wloyvj09xwy`): started 14:44:33. Stalled and failed at
  14:52:34 (8-minute timeout, `terminal: 0` at declaration).
- **What happened after we gave up:** 13 of 14 animation jobs completed successfully, but
  with RunPod-reported `delay_ms` of **4.56–5.46 million ms — 76 to 91 minutes of queue
  wait** — the worst of the three incidents. `completed_at` timestamps land between
  16:02–16:17, **over an hour after** the project was already failed and its callback
  delivered. One job (976) is left in an inconsistent state: `status: 'planned'` (it was
  independently requeued by the reconcile fix before its very-delayed webhook eventually
  arrived) but with a `completed_at` timestamp written anyway — a minor data-integrity
  side effect of the webhook and the retry-requeue racing each other; harmless here since
  the project had already failed regardless, but worth a small hardening fix (see §5).

**Cost:** $0.538 — again, execution-time-only billing; no wasted spend from the long queue
wait.

## 3. `js7efefanw2exz1863fh002w5x8eg5er__a1` (narration-basic)

**Cohort:** `win_2026_09_16_12_r4`. **Result:** `failed` (8/10 frames succeeded).

Same signature as `js72`'s image-step failures: 2 image jobs' RunPod job IDs vanished
(`404 "job not found"`), already at 2 attempts each, so they failed for good once caught.
Everything else in this project (TTS, animation, merge, remove-silence, sfx, remotion
overlay, bgm-overlay, burn-captions) completed cleanly — this run landed **after** RunPod
capacity had partially recovered (started 14:54:32, well after the worst of the backlog),
so only the tail end of the outage clipped 2 frames rather than stalling an entire step.

## 4. `js76a6d9k3eze1t30xyrrkrwt58eghfj__a1` (narration-premium) — unrelated, older incident

**Result:** `partial`, callback delivered 06:39:54 UTC — **before** today's capacity issue
began. 5 frames hit genuine **CUDA out-of-memory** errors on the image-generation worker
(`"CUDA out of memory. Tried to allocate 9.51 GiB... 44.40 GiB memory in use"`), which then
cascaded downstream (animation/merge/remove-silence/upscale/sfx all show the same 5 frames
failed or `"no resolved animation video URL"` — the expected knock-on effect of an
upstream failure). This is the incident `retryCeiling()` (commit `ad25a1b`) was built to
retry harder against, deployed earlier the same day — but these 5 frames had already
exhausted their attempts and failed *before* that fix landed, so they were never eligible
for the fix retroactively. 8/13 frames succeeded.

This project is the **correct candidate for the new admin-dashboard rework feature**: a
genuine partial failure (majority succeeded, 5 frames genuinely dead) rather than a
whole-pipeline stall. The other 3 need a full fresh resubmission instead (see §5).

---

## 5. Corrective measures

### Already fixed today (same session, see `docs/qm-orchestrator-session-2026-09-16-admin-dashboard-and-incidents.md`)
- `reconcileTick()` now requeues/fails a job on a definitive RunPod error (404 etc.)
  instead of polling a dead job ID forever — this is what let `js72` and `js7efefanw`'s
  image steps recover and close out cleanly instead of hanging indefinitely, the way the
  original incident (before today's fix) would have.

### Recommended next
1. **Check RunPod account/dashboard for the root cause of the capacity backlog.** Three
   different endpoints (image, TTS, animation — different GPU pools) were all affected
   within the same few-hour window, with delays from ~8 minutes up to ~90 minutes. That
   pattern (multiple independent endpoint types, same account, same window) points at an
   account-level constraint — a spend/quota cap, a region-wide GPU shortage RunPod was
   experiencing, or a shared quota ceiling — rather than one endpoint's own workers being
   unhealthy. This needs a human to check RunPod's own status/account page; nothing in the
   orchestrator can diagnose *why* RunPod had no capacity, only detect and safely contain
   the symptom.
2. **Reconsider the 8-minute `warmTimeoutMs` stall window against a real, longer-than-usual
   RunPod backlog.** The current behavior is *safe* (no wasted billing, clean customer-facing
   failure, no silent hang) but is now shown to be *premature* under a sustained backlog:
   `js72` and `js77` were both going to succeed in full, 31–91 minutes later, and the
   customer was told "failed" for a request RunPod was still actively going to deliver.
   Options worth considering, not yet implemented:
   - Use `runpod.health()`'s own `workers.throttled` count as a distinct signal from
     "truly nothing happening" (all worker counts zero) — RunPod reporting throttled
     workers means it acknowledges the job and is (slowly) working it, which is a
     materially different situation from total silence.
   - A longer soft-timeout with an alert (Slack/log) at 8 minutes, and only a hard
     fail+drain at a much longer ceiling (e.g. 30–45 min) — trading a bit of held-open
     endpoint time (still free per RunPod's execution-only billing) for fewer premature
     customer-facing failures during a real but temporary backlog.
   - This is a genuine trade-off (a true dead endpoint should still fail fast, not hang
     for 45 minutes) and deserves a deliberate decision, not a silent change — flagging
     for discussion rather than shipping unilaterally.
3. **Minor hardening: job 976's inconsistent `status: 'planned'` + populated `completed_at`.**
   A very-delayed webhook and the reconcile-triggered requeue raced on the same job row.
   Harmless in this incident (the project had already failed), but worth a follow-up: either
   have the webhook handler no-op when a job's `attempts` has advanced past what the webhook's
   payload corresponds to, or have `markFailedOrRetry`'s requeue clear the old `runpod_job_id`
   early enough that a late webhook for the *old* id can't match a row anymore.
4. **Rework only `js76a6d9k3eze1t30xyrrkrwt58eghfj__a1`** via the new admin dashboard —
   it's the one genuine "mostly succeeded, some frames genuinely dead" case. The other
   three failed before their pipelines got far enough for a targeted per-frame rework to
   make sense; they need StoryStudio to resubmit fresh (new `requestId`) now that RunPod
   capacity has recovered (confirmed clean health on all 3 endpoints as of 16:55 UTC).
5. **No cost impact requiring action.** Confirmed across all 4 incidents: RunPod's
   serverless billing charges execution time only, not queue delay — the long backlogs
   did not create runaway spend, only lost turnaround time.
