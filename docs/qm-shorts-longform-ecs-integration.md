# shorts-longform → ECS Fargate — Step Functions Integration

**Audience:** QM engineers (future you, or whoever debugs/extends this next).
**Subject:** How `generateShorts: true` now reaches the shorts-longform worker
— replaced the RunPod GPU serverless endpoint (`u3bvq5juben8ri`) with a
QM-owned CPU-only ECS Fargate task (`qm-shorts-longform`), fired
fire-and-forget from every QM-New Step Function.
**Status (2026-08-22): DEPLOYED + live-verified.** All resources are live in
`QMPipelineStack`. A direct `ecs run-task` smoke test against the deployed
task confirmed the full pipeline works on real infra (§7). **Not yet
verified:** a real project run through an actual Step Functions execution
with `generateShorts: true` — only the ECS task itself has been live-tested
directly, not the SFN's payload-builder → upload → runTask chain together in
one real execution.
**Supersedes (for architecture):** `~/longtoshort/RUNPOD-SHORTS-WORKER.md` and
`STORYSTUDIO-INTEGRATION.md` still describe the old RunPod design — useful for
the worker's own job-input field reference (segments/captions/BGM options,
still unchanged), but their "GPU pool", "RunPod `/run`", and "RunPod webhook"
sections no longer reflect how this is invoked. `~/longtoshort` remains the
dev/authoring repo for the worker's Python code; the **deploy** source of
truth is now `quartermaster/infra/docker/shorts-longform` (§6).
**Corrects:** `docs/storystudio-shorts-longform-webhook-receiver-handoff.md`
(2026-07-28) — that doc's core claim, that nothing on the Convex side ever
reads the completion webhook, is now stale. Reading `storystudio-unified`'s
`backend/convex/http.ts` + `backend/convex/e2e/shorts.ts` directly this
session confirmed `POST /api/e2e/runpod-webhook` → `applyRunpodShortsWebhook`
is implemented and does upsert `shorts` table rows. Whether it's been
live-exercised against a *real* project since being built is unverified, but
the receiver itself is not missing.

---

## 1. The big picture

```
Narration/Dialogue Basic|Premium SFN (generateShorts:true)
     │
     ▼  NormalizeShortsOptions → CheckGenerateShorts
BuildShortsPayload (Lambda: QM-shorts-trigger)
     │   pure data transform — merges caller shortsOptions with
     │   project_id/video_url/srt_url/bgm_url/webhook, no network call
     ▼
UploadShortsPayload (Lambda: QM-upload-payload)
     │   writes the JSON to S3 (qm-remove-silence-output bucket) —
     │   ecs:runTask's ContainerOverrides has an 8192-byte hard limit,
     │   a caller's shortsOptions (many explicit segments[]) could exceed
     │   it inlined (same workaround qm-concat-and-trim already uses)
     ▼
TriggerShortsEcsTask — arn:aws:states:::ecs:runTask  (NOT .sync)
     │   fire-and-forget: launches qm-shorts-longform Fargate task,
     │   returns immediately — SFN proceeds straight to FinalizeVideo*
     │   without waiting (shorts are a non-fatal, nice-to-have side
     │   artifact, same as the old RunPod design)
     ▼
qm-shorts-longform ECS task (Fargate, CPU-only, libx264)
     │   1. reads its own job input from S3 (PAYLOAD_S3_KEY)
     │   2. probe → segment → per-short trim/caption/encode/slides/BGM
     │      (identical logic to the old RunPod worker — see
     │      RUNPOD-SHORTS-WORKER.md §3 for the full job-input field ref)
     │   3. uploads each short + manifest to R2
     │   4. POSTs its own completion webhook (RunPod's platform used to
     │      do this automatically; ECS has no equivalent, so
     │      handler.py's main()/_post_webhook() does it directly)
     ▼
POST {convexEndpoint}/api/e2e/runpod-webhook?jobId=...
     {"status": "COMPLETED"|"FAILED", "output": {...same shape as before...}}
     ▼
Convex: applyRunpodShortsWebhook → upsertShortFromPipelineData (unchanged)
```

**What did NOT change** (StoryStudio-facing contract is identical): the
`generateShorts`/`shortsOptions` fields on the SFN execution input, the
worker's job-input schema (segments/frames/captions/bgm/upscale/render_style/
...), the R2 output key convention (`storystudio/{video,voice,txt,bgm}/...`),
and the webhook envelope Convex receives. This was purely a compute/invocation
migration, not a contract change.

## 2. Why this was worth doing

See `[[qm-shorts-longform-ecs-migration]]` memory / prior session for the
full GPU-removal reasoning. Short version: the worker's GPU use (NVENC
encode, optional Real-ESRGAN upscale) was never actually load-bearing —
NVENC already had a tested libx264 fallback, and Real-ESRGAN was opt-in and
never requested by any real caller in production. Once GPU/CUDA dropped out
of the Dockerfile entirely, the worker became a plain CPU Fargate task and
could adopt the exact same `ecs:runTask`-from-Step-Functions pattern
`qm-concat-and-trim`/`qm-dialogue-mix` already use — no new GPU EC2 capacity
provider, no cold-start-vs-warm-pool tradeoff RunPod used to absorb for us.

## 3. Real, deployed resources

```
State machines (unchanged ARNs, updated definitions):
  arn:aws:states:us-east-1:929075264324:stateMachine:E2E-VideoGenerationPipeline-Narration-Basic-QM-New
  arn:aws:states:us-east-1:929075264324:stateMachine:E2E-VideoGenerationPipeline-Narration-Premium-QM-New
  arn:aws:states:us-east-1:929075264324:stateMachine:E2E-VideoGenerationPipeline-Dialogue-Basic-QM-New
  arn:aws:states:us-east-1:929075264324:stateMachine:E2E-VideoGenerationPipeline-Dialogue-Premium-QM-New

  (E2E-VideoGenerationPipeline-Basic-QM / -Premium-QM are the legacy,
   pre-QM-New pipelines — deliberately untouched, still call the original
   arn:aws:lambda:...:function:E2E-start-shorts path, not this one.)

ECS:
  Cluster:         arn:aws:ecs:us-east-1:929075264324:cluster/qm-shorts-longform
  Task definition: arn:aws:ecs:us-east-1:929075264324:task-definition/qm-shorts-longform:1 (revision bumps on each cdk deploy that changes it)
  Container name:  shorts-longform
  ECR repo:        929075264324.dkr.ecr.us-east-1.amazonaws.com/qm-shorts-longform
  Log group:       /qm/shorts-longform
  CodeBuild:       qm-shorts-longform-build

Lambdas:
  QM-shorts-trigger    — builds the job input (renamed in purpose, not name;
                          no longer calls RunPod, no longer needs a RunPod
                          secret)
  QM-upload-payload    — generic S3-payload-upload Lambda, shared with
                          qm-concat-and-trim

IAM (CDK-managed, this stack):
  qm-shorts-longform-task-role       — read-only on qm-remove-silence-output
                                        (fetches PAYLOAD_S3_KEY)
  qm-shorts-longform-execution-role  — NOT the shared ecsTaskExecutionRole;
                                        a dedicated, mutable role so CDK can
                                        auto-grant secretsmanager:GetSecretValue
                                        for the 4 container secrets (§4)

IAM (manual, one-time, shared resource — already applied):
  E2E-StepFunction-Role's ECSRunTaskForShortsAnalyze policy's PassRoleToECS
  statement (explicit role-ARN allowlist, not a wildcard) now includes both
  qm-shorts-longform-task-role and qm-shorts-longform-execution-role.
  ecs:RunTask itself was already Resource:"*" on that role, no change needed.
```

## 4. Job input / output contract

**Input** — same fields the old RunPod job.input took (see
`RUNPOD-SHORTS-WORKER.md` §3 for the full reference: `project_id`,
`video_url`, `segments`/`frames`/`num_shorts`, `render_style`, `captions`,
`srt_url`/`srt_source`, `bgm_url`/`bgm_prompt`, `slides`, `upscale` —
`"realesrgan"` no longer available, silently falls back to lanczos), **plus**
one new field the container reads that RunPod used to handle for us:

```json
{ "...same fields as before...", "webhook": "https://<convexEndpoint>/api/e2e/runpod-webhook?jobId=..." }
```

`QM-shorts-trigger` builds this whole object (still merges caller
`shortsOptions` over its own computed defaults, same precedence rules as
before); `QM-upload-payload` writes it to
`s3://qm-remove-silence-output/projects/{projectId}/payloads/shorts.json`
(or `shorts-{fieldKey}.json` per fourLang language branch — separate keys so
the 3 parallel per-language triggers for one project don't clobber each
other); the ECS task reads it back via `PAYLOAD_S3_KEY`/`PAYLOAD_BUCKET` env
vars set on `ecs:runTask`'s `ContainerOverrides`.

**Output / completion** — the container's `main()` builds the exact same
output dict `handler.py`'s `run_job()` always built (unchanged: `shorts[]`,
`video_info`, `bgm`, `manifest`, etc.), then POSTs:

```json
{"status": "COMPLETED", "output": { "...same output shape as before..." }}
```

to the `webhook` URL — `"FAILED"` if `completed_shorts == 0` or an unhandled
exception occurred before that point. This is deliberately the same envelope
RunPod's platform used to send, so Convex's `applyRunpodShortsWebhook` needed
zero changes.

## 5. Fire-and-forget, not `.sync` — read this before "fixing" it

`TriggerShortsEcsTask` uses `arn:aws:states:::ecs:runTask`, **not**
`ecs:runTask.sync`. This is intentional, not an oversight: shorts generation
is a non-fatal side artifact of the main long-form pipeline (same framing the
original RunPod design used — "Failure is non-fatal ... never worth failing
the whole project over"). Switching to `.sync` would make the main pipeline
block for however long the shorts job takes (minutes) before finalizing,
which is a real behavior change nobody asked for. If a future need arises to
block on shorts completion, that's a deliberate architecture decision, not a
one-line resource-suffix fix.

## 6. Build & deploy

Source of truth for the container is `infra/docker/shorts-longform/` inside
this repo (Python — unchanged from `~/longtoshort` except the entrypoint,
see below). To ship a code change:

```bash
# 1. edit infra/docker/shorts-longform/{handler.py,shorts/*.py,...}
#    (mirror the same edit into ~/longtoshort if you want the dev repo to
#    stay in sync — no automated sync between the two trees)

# 2. push a new image
aws codebuild start-build --project-name qm-shorts-longform-build
# poll: aws codebuild batch-get-builds --ids <build-id> --query "builds[0].buildStatus"

# 3. CDK-side changes (task def sizing, env vars, SFN wiring) go through the
#    normal cdk deploy — these 4 context flags are REQUIRED or they resolve
#    to a placeholder ARN (same class of gotcha as WEBHOOK_BASE_URL):
npx cdk deploy QMPipelineStack \
  -c RUNPOD_API_KEY_ARN=<arn>          # cross-endpoint transcribe/bgm calls
  -c ANTHROPIC_API_KEY_ARN=<arn>       # segments_source:"ai" highlight selection
  -c R2_ACCESS_KEY_ID_SECRET_ARN=<arn>
  -c R2_SECRET_ACCESS_KEY_SECRET_ARN=<arn>
  -c GATEWAY_STATIC_KEY_ARN=<arn>      # required by this stack regardless
```

ECS won't pick up a freshly-pushed `:latest` image on already-running tasks
(nothing is running between jobs — Fargate tasks are launched per-job and
exit), so a new `ecs:runTask` after step 2 completes is enough; no service
restart/redeploy needed.

## 7. What's actually been verified live vs. what hasn't

**Verified (2026-08-22):**
- Built the CPU-only image, confirmed `torch` absent, confirmed
  `nvenc_available()` correctly returns `False` and `video_codec_args()`
  falls back to `libx264` — all inside the actual container, not just locally.
- `cdk synth` + manual JSON inspection of all 4 QM-New state machines'
  compiled ASL confirmed `BuildShortsPayload`/`UploadShortsPayload`/
  `TriggerShortsEcsTask` (and their 3 fourLang-suffixed siblings nested in
  `FinalizeLocalizedVideos`'s Parallel branches) came out exactly as designed.
- `cdk deploy QMPipelineStack` succeeded clean, all resources
  `CREATE_COMPLETE`/`UPDATE_COMPLETE`.
- **Direct `aws ecs run-task` smoke test against the real deployed task**:
  uploaded a synthetic 12s test video to the real production R2 bucket,
  manually staged a job-input payload at the same S3 key convention
  `UploadShortsPayload` uses, ran the task directly (bypassing the SFN
  hops). Exit code 0. CloudWatch logs confirmed the full pipeline ran for
  real: download → segment → trim → encode (`h264_nvenc usable: False`,
  libx264 used) → slides → R2 upload → manifest upload. Downloaded the
  actual output: valid 1080×1920 H.264/AAC, correct duration (title slide +
  clip + end slide), correct manifest shape. Test artifacts deleted
  afterward.

**Not verified:**
- A real project executed through an actual Step Functions execution with
  `generateShorts: true` — i.e. `BuildShortsPayload`/`UploadShortsPayload`
  actually running for real and handing off to `TriggerShortsEcsTask`
  end-to-end within a live SFN execution, not just the ECS task invoked
  directly as above.
- The container's own webhook POST reaching a real Convex `jobId` and
  actually producing `shorts` table rows (the smoke test above omitted
  `webhook` entirely to avoid hitting Convex with a fabricated jobId).
- Whether Convex's webhook receiver (§ header, "Corrects") has itself been
  exercised against a real completed job since it was built — only the code
  was read, not observed handling a live callback.

**To close these out**: run a real Narration-Basic-QM-New (or any QM-New
pipeline) execution with `generateShorts: true` against a real project, then
check both CloudWatch (`/qm/shorts-longform`) for the task's own run and
Convex's `shorts` table for the resulting rows.
