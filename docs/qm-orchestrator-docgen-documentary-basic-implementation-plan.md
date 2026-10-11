# Documentary Basic on doc-gen: implementation plan

**Date:** 2026-10-11
**Status:** plan only, nothing built.
**Sources:** `~/local-gen-documentary/docs/ORCHESTRATOR_INTEGRATION.md` (the doc-gen contract, called "the contract" below) and `DOCKER_SERVICE_DESIGN.md`; `orchestrator/` in this repository; `storystudio-unified/backend/convex/orchestrator/`.

## 1. What is being built

StoryStudio sends a `documentary-basic` request to the QM Orchestrator. The orchestrator queues it, starts the doc-gen EC2 instance, hands it the job, follows it to the end, and posts the finished videos back to StoryStudio. Script, assets and assembly all happen inside the instance.

```
StoryStudio (Convex)                 QM Orchestrator (VPS)                    doc-gen (EC2, stopped between jobs)
  POST /v1/documentaries  ───────►   docgen_jobs row, state = queued
  ◄─────── 202
                                     dispatcher: ec2 StartInstances
                                     GET /v1/health until ready       ─────►
                                     POST /v1/documentaries           ─────►  job runs 1 to 1.5 h
                                     POST /v1/webhooks/docgen         ◄─────  signed events + 60 s heartbeat
                                     (poll status / events as fallback) ───►
                                     job.succeeded: store outputs
                                     queue empty: ec2 StopInstances
  POST /api/qm/result     ◄───────   signed result JSON
  store video, shorts, thumbnail,
  metadata; email the user
```

This is a separate path from the per-frame asset pipeline. A documentary has no `frames[]`, no RunPod jobs of the orchestrator's own, and no SFN tail. It shares only the HTTP server, Postgres, the callback sender and the dashboard.

## 2. Decisions needed before coding

| # | Decision | Recommendation |
|---|---|---|
| D1 | `review_mode` for StoryStudio requests | `auto`. These are background requests with no reviewer waiting. With `checkpoints` the instance stays up and billing at each pause, and `max_runtime_minutes` keeps counting. Build the checkpoint routes in phase 4 for operator-submitted jobs. |
| D2 | AWS credential for start and stop | Create an access key for the existing `docgen-orchestrator` IAM user and pass it under separate variable names. The existing credential keeps its Lambda and Step Functions scope. |
| D3 | Which StoryStudio projects route here | MCP-created `documentary-basic`, English only, behind a new `QM_DOCGEN_MODE` switch (off, live). Projects made in the UI keep the current Step Functions path, because that flow has a script and storyboard editing step that doc-gen replaces. |
| D4 | Duration mismatch | StoryStudio accepts 5 to 15 minutes; doc-gen builds 4 to 12 (`long.target_seconds` 240 to 720). Clamp to 720 and add a line to the result `warnings`, or lower StoryStudio's limit to 12. Recommend lowering the limit for routed projects. |
| D5 | Automatic retry of a failed job | One retry at most, only when `error.retryable` is true and the code is `internal` or `llm_error`. A retry starts from nothing and pays for generation again, so `timeout` and `generation_failed` go to an operator. |
| D6 | Paid-generation defaults | Use the doc-gen defaults (3 talking clips, 10 animated stills, 3 Shorts) unless StoryStudio's request says otherwise. Costs per episode are not measured yet. |

## 3. Prerequisites (before any orchestrator code is deployed)

1. Create the access key for `docgen-orchestrator` (contract section 2). Add to `/opt/qm-orchestrator/.env`.
2. Copy `/docgen/DOCGEN_API_TOKEN` and `/docgen/DOCGEN_CALLBACK_SECRET` from Parameter Store into the VPS `.env`.
3. From the VPS, run the manual sequence in contract section 10 with a small `auto` request (240 seconds, no Shorts, no talking clips, no animated stills). This is the first real job on the instance and the first call through the public URL after a stop and start; both are listed as untested in contract section 12. It needs a temporary receiver for the webhooks, or accept failed deliveries and poll.

Step 3 can fail for reasons that have nothing to do with the orchestrator. Finding that out before writing the integration is the point.

## 4. Orchestrator changes (`quartermaster/orchestrator`)

### 4.1 New files

| File | Purpose |
|---|---|
| `src/db/migrations/024_docgen.sql` | `docgen_jobs`, `docgen_events`, with a `-- @DOWN` section |
| `src/db/repo/docgen.ts` | Row access: enqueue, claim next, apply event, mark terminal, callback bookkeeping |
| `src/docgen/client.ts` | HTTP client for the eight doc-gen endpoints; injectable `fetch` for tests |
| `src/docgen/ec2.ts` | Start, stop, describe. Same shape as `src/aws/sfn.ts`: real SDK by default, injectable implementation |
| `src/docgen/request.ts` | zod schema for the intake body, and the mapping to the doc-gen payload |
| `src/docgen/dispatcher.ts` | The tick loop that drives one job at a time |
| `src/docgen/result.ts` | Builds the result JSON for StoryStudio |
| `src/http/routes/docgen.ts` | Intake, status, webhook receiver, operator routes |
| `__tests__/docgen-*.test.ts` | Request mapping, signature check, `seq` ordering, dispatcher transitions with fake client and fake EC2 |

### 4.2 Tables (migration 024)

Start from contract section 9, with these changes:

- `request_id` (primary key) is StoryStudio's id. Add `docgen_request_id`, the id sent to the instance: equal to `request_id` on the first attempt and `<request_id>-r2` on a retry. Webhooks are matched on this column.
- Add `project_id`, `callback_url`, `callback_status`, `callback_attempts`, `result`, the same names as on `projects` (migration 008).
- Add `instance_started_at` and `last_polled_at` for the dispatcher's timers.
- A partial unique index allowing only one row in `starting_instance`, `running` or `awaiting_input`. The database then enforces "one job at a time" even if two ticks race.

### 4.3 Routes

| Route | Auth | Behaviour |
|---|---|---|
| `POST /v1/documentaries` | `ORCH_INGEST_TOKEN` | Validate, insert `queued`, answer 202 with `{requestId, accepted, queuePosition, estimatedResultAt}`. The same `requestId` again returns the existing row. Validation errors return 400 in the `{error, issues}` shape `/v1/requests` uses. |
| `GET /v1/documentaries/:requestId` | `ORCH_INGEST_TOKEN` | State, stage, progress, message, warnings, outputs. This is how StoryStudio reads status between submission and the callback. |
| `POST /v1/webhooks/docgen` | HMAC signature | See 4.5. |
| `GET /v1/admin/docgen` | `ORCH_ADMIN_TOKEN` | Queue, current job, instance state, last heartbeat. |
| `POST /v1/admin/docgen/:requestId/cancel` | `ORCH_ADMIN_TOKEN` | Calls doc-gen `cancel`, or removes a `queued` row. |
| `POST /v1/admin/docgen/:requestId/respond` | `ORCH_ADMIN_TOKEN` | Phase 4. Answers a checkpoint; starts the instance first if it was stopped. |
| `GET /v1/admin/docgen/:requestId/files/*` | `ORCH_ADMIN_TOKEN` | Phase 4. Proxies review files from the instance. |

A new intake route is used in place of `/v1/requests` because that schema is strict and requires `frames[]`.

### 4.4 Intake body and its mapping

```json
{
  "requestId": "req_k57c9x2m_20261012T0900",
  "projectId": "k57c9x2m8f3q0r1t6y4w",
  "source": "mcp",
  "tier": "documentary-basic",
  "callbackUrl": "https://<convex-deployment>.convex.site/api/qm/result",
  "topic": "The Treaty of Versailles",
  "synopsis": "How the 1919 peace settlement was negotiated ...",
  "targetSeconds": 480,
  "narratorVoice": "Charon",
  "series": { "name": "...", "episode": 4 },
  "shorts": { "count": 3 },
  "visuals": { "talkingClips": 3, "animatedStills": 10, "textOverlays": true }
}
```

- `requestId` must match `[A-Za-z0-9_-]` and be at most 61 characters, so the `-r2` suffix still fits doc-gen's 64.
- The orchestrator sets `review_mode`, `model`, `limits`, `output.prefix` (`docgen/<docgen_request_id>/`) and `callback.url` (`<ORCH_PUBLIC_BASE_URL>/v1/webhooks/docgen`). StoryStudio cannot set them.
- The built doc-gen payload is stored in `docgen_jobs.request`.

### 4.5 Webhook receiver

- Registered as its own Fastify plugin with a buffer content-type parser, so the raw body is available for the signature. This parser must not leak to other routes.
- Verify `X-Docgen-Signature` with a constant-time comparison; 401 on mismatch. Answer 200, then do the work.
- Insert into `docgen_events` (the unique key absorbs repeats). Apply the snapshot to `docgen_jobs` only when `seq` is greater than the stored `seq`. A heartbeat only updates `last_heartbeat_at`.
- On a `seq` gap, call `events?after_seq=` and apply what is missing.
- Caddy already forwards every path to the orchestrator, so no proxy change is needed.

### 4.6 Dispatcher

One loop, ticking every 10 seconds, started from `src/index.ts` only when `DOCGEN_BASE_URL` is set. All state is in Postgres, so a restart resumes where it stopped.

| Row state | Each tick |
|---|---|
| none active, a row `queued` | Claim the oldest, set `starting_instance`, call `StartInstances`. On a capacity error, put it back to `queued` and back off. |
| `starting_instance` | `GET /v1/health`. CloudFront 502 and 504 mean "not up yet". When `ready` is true, `POST /v1/documentaries`, store `job_id`, set `running`. After 5 minutes without `ready`: re-queue and raise an alert. `not_ready` because Storyblocks needs a sign-in: hold the queue, stop the instance, alert a person; do not count an attempt. A 409 `busy` naming a job the orchestrator does not know: alert, do not stop the instance. |
| `running` | Nothing while webhooks arrive. No event or heartbeat for 5 minutes: poll status and catch up on events. No answer from the API for 10 minutes: describe the instance. If it is stopped, start it; doc-gen then reports the job failed with `internal`. |
| `awaiting_input` | With `auto` this should not occur. Alert. In phase 4, stop the instance after a configurable wait. |
| terminal | Build the result, deliver the callback, then claim the next `queued` row or call `StopInstances`. |

Rules the code must hold to:

- Never call `StopInstances` while a row is `running`.
- Before stopping, check that every output has a `url`. If one is missing, fetch it through the `files` endpoint and upload it to R2 with the existing `src/r2/client.ts`.
- A failed job that qualifies under D5 gets a new row attempt with the `-r2` id; `attempts` is capped at 2.
- Stop the instance explicitly when the queue is empty. The instance's own 20-minute idle stop is the safety net, not the plan.

### 4.7 Result sent to StoryStudio

Delivered with the existing `deliverCallback` (same headers, same retry schedule, same signature).

```json
{
  "requestId": "req_k57c9x2m_20261012T0900",
  "projectId": "k57c9x2m8f3q0r1t6y4w",
  "kind": "documentary",
  "status": "completed",
  "createdAt": "...", "finishedAt": "...",
  "project": { "tier": "documentary-basic", "aspectRatio": "16:9", "frameCount": 0 },
  "assets": {
    "final": { "url": "https://cdn-v2.ai-storystudio.com/docgen/.../out/the-treaty-of-versailles.mp4", "bytes": 184220331, "durationS": null, "resolution": null },
    "frames": [],
    "shorts": [ { "id": "a_spark", "url": "...", "bytes": 21877002 } ],
    "thumbnail": { "url": "..." },
    "metadata": { "url": "..." },
    "shortsMetadata": { "url": "..." },
    "credits": { "url": "..." }
  },
  "warnings": ["No audio has been listened to"],
  "costs": { "infinitetalk_clips": 3, "ltx_clips": 10 },
  "metrics": { "queuedMs": 0, "runMs": 0 },
  "errors": []
}
```

`assets.final.url` and `status` sit where the per-frame result has them, so StoryStudio's existing ingest stores this unchanged. `status` is `completed`, `partial` (a long video exists but another output is missing) or `failed`. `kind` tells StoryStudio which post-processing to run.

### 4.8 Configuration

New keys in `src/config.ts`, each also forwarded in `deploy/docker-compose.yml` (a key that is not forwarded does nothing):

`DOCGEN_BASE_URL`, `DOCGEN_API_TOKEN`, `DOCGEN_CALLBACK_SECRET`, `DOCGEN_INSTANCE_ID`, `DOCGEN_REGION`, `DOCGEN_AWS_ACCESS_KEY_ID`, `DOCGEN_AWS_SECRET_ACCESS_KEY`, `DOCGEN_REVIEW_MODE` (default `auto`), `DOCGEN_MODEL`, `DOCGEN_MAX_ATTEMPTS` (default 2), `DOCGEN_TICK_MS` (default 10000).

An empty `DOCGEN_BASE_URL` switches the feature off: the routes answer 503 and the dispatcher does not start. New dependency: `@aws-sdk/client-ec2`.

### 4.9 Dashboard

One panel on the existing admin dashboard: instance state, the current job with stage, progress and message, seconds since the last heartbeat, the queue, and the last five finished jobs with their warnings.

## 5. StoryStudio changes (`storystudio-unified/backend/convex`)

| File | Change |
|---|---|
| `lib/orchestratorRouting.ts` | `docgenRoute()`: `QM_DOCGEN_MODE` live, `projectType` is `documentary-basic`, created through MCP, English. Otherwise the current path. |
| `orchestrator/buildDocgenRequest.ts` (new) | Builds the 4.4 body from `documentaryMetadata`: `topic`, `synopsis`, `targetDurationMin` times 60, voice, Shorts settings. When the project has no synopsis, write a two to three sentence one with the existing script model before submitting; doc-gen requires it. |
| `schema.ts` | `orchestratorRequests.kind` (`frames` or `documentary`), optional so old rows stay valid. |
| `orchestrator/submit.ts` | The outbox drain posts `documentary` rows to `/v1/documentaries`. These rows do not count toward `QM_ORCH_MAX_IN_FLIGHT`, because the orchestrator queues them itself and always answers 202. |
| `orchestrator/ingest.ts` | No change expected; it already keys on `requestId` and reads `status`. |
| `orchestrator/postProcessDocumentary.ts` (new) | For `kind: "documentary"`: store the final video URL, the Shorts, the thumbnail and the credits; fetch the metadata file and store title, description and tags; skip StoryStudio's own YouTube-metadata and thumbnail generation, since doc-gen supplies both; put `warnings` on the project; send the completion or failure email. |
| `orchestrator/watchdog.ts` | An overdue threshold for documentaries: no result 4 hours after acceptance. |
| `http.ts` (agent API) | For routed projects, skip the `E2E_STEP_FUNCTION_DOCUMENTARY_BASIC_ARN` requirement and apply the D4 duration limit. |

To confirm while building: whether `documentaryMetadata.voiceName` already holds Gemini voice names (doc-gen expects one, default `Charon`), and where the project stores Shorts so the doc-gen ones appear in the UI.

## 6. Phases and how each is verified

| Phase | Work | Done when |
|---|---|---|
| 0 | Section 3 prerequisites and the manual job from the VPS | A real job succeeds on the instance and its CDN URLs open |
| 1 | Migration, repo, client, EC2 wrapper, request mapping, webhook receiver, unit tests | Tests pass; signed sample webhooks from the doc-gen mock runner are applied in `seq` order on the VPS |
| 2 | Dispatcher, intake and status routes, result callback, config and compose, deploy | A request posted to `/v1/documentaries` with curl starts the instance, runs, delivers a signed result to a test receiver, and the instance stops. Then two requests back to back: the second runs without a stop in between. |
| 3 | StoryStudio routing, request builder, drain, post-processing | One MCP `documentary-basic` project goes end to end on the Convex dev deployment, then one on production with `QM_DOCGEN_MODE=live` |
| 4 | Failure handling and operations: silence detection, instance-stopped recovery, the D5 retry, missing-URL re-host, dashboard panel, cancel, checkpoint routes | Each is exercised on purpose: stop the instance mid-job, block the webhook route, cancel a running job |
| 5 | Update `storystudio-orchestrator-integration.md` with the documentary contract; record measured cost and duration per episode | |

Phases 1 and 2 are about two days of work, phase 3 about one, phase 4 about one. Phase 0 depends on how the first real doc-gen run behaves.

## 7. Risks

- **The production path of doc-gen has never run.** Everything on the instance was tested with a mock runner. Phase 0 exists to find this out early.
- **Storyblocks sign-in lifetime is unknown.** When it expires, every stock job is refused until a person signs in on the instance desktop. The dispatcher holds the queue and alerts; it cannot fix it.
- **No one hears the audio.** doc-gen reports "No audio has been listened to" as a warning on every job. With `auto` the video reaches the user unreviewed, so StoryStudio should show the warnings.
- **Output URLs are public as soon as they are reported**, including for jobs that later fail or are cancelled.
- **One job at a time.** At 1 to 1.5 hours each, ten queued requests take most of a day. `estimatedResultAt` in the acknowledgement should reflect queue position.
- **Allowed caller address.** doc-gen admits only `129.121.78.38`. If the VPS address changes, every call returns 403 until the CloudFront function is edited.
- **An instance left running** costs about 127 USD a month. Covered three ways: the dispatcher's explicit stop, the instance's idle stop, and the CloudWatch uptime alarm named in the design document (confirm that alarm exists).
