# Documentary Basic on doc-gen: implementation plan

**Date:** 2026-10-11
**Status (updated 2026-10-11, end of day):** phases 0 to 3 are built. The orchestrator side (phases 1 and 2) is deployed and was verified with two real back-to-back jobs. The StoryStudio side (phase 3) is deployed to Convex production with `QM_DOCGEN_MODE=live`, but **no real MCP project has gone through it yet**; that check and phase 4 are next (`docs/TODO.md`, 2026-10-12). Sections 1 to 7 are the original plan with decisions, steps and phases marked up with what happened; section 8 lists every place the build differs from it.
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

| # | Decision | Recommendation | Outcome |
|---|---|---|---|
| D1 | `review_mode` for StoryStudio requests | `auto`. These are background requests with no reviewer waiting. With `checkpoints` the instance stays up and billing at each pause, and `max_runtime_minutes` keeps counting. Build the checkpoint routes in phase 4 for operator-submitted jobs. | **As recommended.** `DOCGEN_REVIEW_MODE` defaults to `auto`. The checkpoint routes are not built (phase 4). |
| D2 | AWS credential for start and stop | Create an access key for the existing `docgen-orchestrator` IAM user and pass it under separate variable names. The existing credential keeps its Lambda and Step Functions scope. | **Changed by the user.** No new key: inline policy `QMOrchestratorDocgenInstanceControl` (start/stop on the one instance, plus describe) on the existing user `qm-orchestrator-remotion-invoke`, whose key is already on the VPS. The default AWS credential chain is used; there are no `DOCGEN_AWS_*` variables. The `docgen-orchestrator` user is unused. |
| D3 | Which StoryStudio projects route here | MCP-created `documentary-basic`, English only, behind a new `QM_DOCGEN_MODE` switch (off, live). Projects made in the UI keep the current Step Functions path, because that flow has a script and storyboard editing step that doc-gen replaces. | **As recommended.** Set to `live` in production on 2026-10-11. |
| D4 | Duration mismatch | StoryStudio accepts 5 to 15 minutes; doc-gen builds 4 to 12 (`long.target_seconds` 240 to 720). Clamp to 720 and add a line to the result `warnings`, or lower StoryStudio's limit to 12. Recommend lowering the limit for routed projects. | **As recommended.** A routed `create_project` must ask for 5 to 12 minutes (400 otherwise). |
| D5 | Automatic retry of a failed job | One retry at most, only when `error.retryable` is true and the code is `internal` or `llm_error`. A retry starts from nothing and pays for generation again, so `timeout` and `generation_failed` go to an operator. | **Extended.** Also `instance_unreachable` and `job_lost`, the two codes the orchestrator itself raises when the instance disappears (same kind of loss as `internal`). A retry is re-queued under `<id>-r2`. |
| D6 | Paid-generation defaults | Use the doc-gen defaults (3 talking clips, 10 animated stills, 3 Shorts) unless StoryStudio's request says otherwise. Costs per episode are not measured yet. | **Confirmed by the user.** Nothing is sent unless the MCP request carries it in `documentaryMetadata.shorts` / `.visuals` / `.series` (strict: an unknown or out-of-range field is a 400). `0` and `false` are preserved. Cost per default episode is still not measured. |
| D7 | Synopsis (not in the original plan) | The plan said to write one with "the existing script model" when the project has none. | **Decided by the user:** Claude writes it (`MODELS.anthropic.primary`) unless the request carries a real one (at least 40 characters and not the topic echoed back, because the synchronous create path defaults `synopsis` to the topic). Falls back to the requester's notes, then to "A documentary about <topic>." The model call itself has not been run against the live API. |

## 3. Prerequisites (before any orchestrator code is deployed)

1. ~~Create the access key for `docgen-orchestrator`.~~ **Not done, by decision D2.** The inline EC2 policy went on the existing orchestrator IAM user instead.
2. Copy `/docgen/DOCGEN_API_TOKEN` and `/docgen/DOCGEN_CALLBACK_SECRET` from Parameter Store into the VPS `.env`. **Done** (backup `.env.bak-pre-docgen`).
3. From the VPS, run the manual sequence in contract section 10 with a small `auto` request (240 seconds, no Shorts, no talking clips, no animated stills). **Done 2026-10-11:** job `dg_4b8e2518b5bc` succeeded in 38 minutes (a 212-second video; thumbnail, metadata and credits uploaded, all CDN URLs public). The public URL works from the VPS after a stop and start (four 504s while booting, then 200), and health reported `ready: true` with Storyblocks still connected. Webhook delivery was not exercised (a placeholder callback URL was used and the job was polled).

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
| `lib/docgen.ts` and `orchestrator/docgen.ts` (new; planned as `buildDocgenRequest.ts`) | Builds the 4.4 body from `documentaryMetadata`: `topic`, `synopsis`, `targetDurationMin` times 60, voice, Shorts settings. When the project has no synopsis, write a two to three sentence one with the existing script model before submitting; doc-gen requires it. |
| `schema.ts` | `orchestratorRequests.kind` (`frames` or `documentary`), optional so old rows stay valid. |
| `orchestrator/submit.ts` | The outbox drain posts `documentary` rows to `/v1/documentaries`. These rows do not count toward `QM_ORCH_MAX_IN_FLIGHT`, because the orchestrator queues them itself and always answers 202. |
| `orchestrator/ingest.ts` | No change expected; it already keys on `requestId` and reads `status`. |
| `orchestrator/postProcessDocgen.ts` (new; planned as `postProcessDocumentary.ts`) | For `kind: "documentary"`: store the final video URL, the Shorts, the thumbnail and the credits; fetch the metadata file and store title, description and tags; skip StoryStudio's own YouTube-metadata and thumbnail generation, since doc-gen supplies both; put `warnings` on the project; send the completion or failure email. |
| `orchestrator/watchdog.ts` | An overdue threshold for documentaries: no result 4 hours after acceptance. **Not changed:** the existing rule (6 hours after `estimatedResultAt`) already covers documentary rows, so it was left alone; tightening it is a phase 4 item. |
| `http.ts` (agent API) | For routed projects, skip the `E2E_STEP_FUNCTION_DOCUMENTARY_BASIC_ARN` requirement and apply the D4 duration limit. |

Both questions below were answered while building. `voiceName` can hold another provider's voice, so it is forwarded only when it is a Gemini TTS voice (otherwise doc-gen's `Charon` applies). Shorts are stored as rows in the `shorts` table (`language "en"`, `partNumber` 1 to 3, titles taken from doc-gen's ids such as `a_spark`).

## 6. Phases and how each is verified

| Phase | Work | Done when | Status |
|---|---|---|---|
| 0 | Section 3 prerequisites and the manual job from the VPS | A real job succeeds on the instance and its CDN URLs open | **Done.** A real 38-minute job succeeded; URLs open. |
| 1 | Migration, repo, client, EC2 wrapper, request mapping, webhook receiver, unit tests | Tests pass; signed sample webhooks from the doc-gen mock runner are applied in `seq` order on the VPS | **Done and deployed** (`eb3befc`). Signed events sent through the public URL: 401s, a gap, a late and a duplicate event, a heartbeat, a final event with outputs, and no resurrection after the end. |
| 2 | Dispatcher, intake and status routes, result callback, config and compose, deploy | A request posted to `/v1/documentaries` with curl starts the instance, runs, delivers a signed result to a test receiver, and the instance stops. Then two requests back to back: the second runs without a stop in between. | **Done and deployed** (`8aa6bc5`). Two real jobs (14 and 21 minutes): the instance stayed up between them and stopped after the second; both callbacks were answered 200 by StoryStudio production (the receiver was `accomplished-firefly-291.convex.site`, which answers `unknown_request` for an unknown id and stores nothing). No alerts. |
| 3 | StoryStudio routing, request builder, drain, post-processing | One MCP `documentary-basic` project goes end to end on the Convex dev deployment, then one on production with `QM_DOCGEN_MODE=live` | **Built, committed and deployed to production** (`2f63107`, `cdb9fad`; `QM_DOCGEN_MODE=live`). **The end-to-end check with a real MCP project is still pending.** |
| 4 | Failure handling and operations: silence detection, instance-stopped recovery, the D5 retry, missing-URL re-host, dashboard panel, cancel, checkpoint routes | Each is exercised on purpose: stop the instance mid-job, block the webhook route, cancel a running job | **Partly built.** Silence detection, instance-stopped recovery and the D5 retry are in the dispatcher, with 31 scenarios tested against a real Postgres, but have not run live. Cancel, checkpoint and files routes, the missing-URL re-host and the dashboard panel are not built. |
| 5 | Update `storystudio-orchestrator-integration.md` with the documentary contract; record measured cost and duration per episode | | Not started. |

Phases 1 and 2 are about two days of work, phase 3 about one, phase 4 about one. Phase 0 depends on how the first real doc-gen run behaves.

## 7. Risks

- ~~The production path of doc-gen has never run.~~ **Resolved:** three real jobs ran on 2026-10-11. What none of them used: stock footage (see section 8) and talking clips or animated stills (all three runs turned them off).
- **Storyblocks sign-in lifetime is unknown.** When it expires, every stock job is refused until a person signs in on the instance desktop. The dispatcher holds the queue and alerts; it cannot fix it.
- **No one hears the audio.** doc-gen reports "No audio has been listened to" as a warning on every job. With `auto` the video reaches the user unreviewed, so StoryStudio should show the warnings.
- **Output URLs are public as soon as they are reported**, including for jobs that later fail or are cancelled.
- **One job at a time.** At 1 to 1.5 hours each, ten queued requests take most of a day. `estimatedResultAt` in the acknowledgement should reflect queue position.
- **Allowed caller address.** doc-gen admits only `129.121.78.38`. If the VPS address changes, every call returns 403 until the CloudFront function is edited.
- **An instance left running** costs about 127 USD a month. Covered three ways: the dispatcher's explicit stop, the instance's idle stop, and the CloudWatch uptime alarm named in the design document (confirm that alarm exists).

## 8. What was built, and where it differs from the plan

Built 2026-10-11. Orchestrator: `eb3befc` (phase 1), `8aa6bc5` (phase 2). StoryStudio (`storystudio-unified`, `master`): `2f63107`, `cdb9fad`.

**Orchestrator, against sections 4.1 to 4.9**
- **Files.** The webhook receiver is its own plugin, `src/http/routes/docgen-webhook.ts`, so its raw-body JSON parser stays scoped to that route; intake, status and the admin view are in `src/http/routes/docgen.ts`. Extra modules: `src/docgen/types.ts`, `events.ts` (applies one event; shared by the webhook and by catch-up polling), `signature.ts` and `setup.ts` (builds the client and EC2 transport, or null when the feature is off). Tests: `docgen-request`, `docgen-client`, `docgen-webhook`, `docgen-result`, `docgen-routes`, and two against real Postgres (`docgen-repo.integration`, `docgen-dispatcher.integration`).
- **Routes.** Built: `POST /v1/documentaries`, `GET /v1/documentaries/:requestId`, `POST /v1/webhooks/docgen`, `GET /v1/admin/docgen`. Not built: the admin cancel, respond and files routes.
- **Intake.** `tier` must be the literal `documentary-basic`. `requestId` is at most 61 characters so a `-rN` retry suffix still fits doc-gen's 64.
- **Config.** `DOCGEN_AWS_ACCESS_KEY_ID` and `DOCGEN_AWS_SECRET_ACCESS_KEY` do not exist (D2). The feature is on only when `DOCGEN_BASE_URL`, `DOCGEN_API_TOKEN` and `DOCGEN_CALLBACK_SECRET` are all set. The dispatcher's timings (5-minute boot timeout, 5-minute silence, 10-minute unreachable, and the retry back-offs) are constants in `dispatcher.ts` rather than environment variables.
- **Dispatcher.** A start the instance refuses (no capacity, still stopping, busy with an unknown job, not ready, bad credentials, a CloudFront 403) goes back to the queue with a back-off and consumes no attempt; a 400 fails the request for good. Only an accepted job counts as an attempt. An output with no URL leaves the instance up (it stops itself after 20 idle minutes) and logs an alert; the automatic re-host is phase 4. Operator alerts are error-level log lines with `alert: true`, not rows in `diagnostic_alerts` (that table is for Sonnet diagnoses).
- **Estimate.** `estimatedResultAt` is a flat 75 minutes per job ahead, and the response says `estimateBasis: "default"`. The three measured runs took 14, 21 and 38 minutes at the smallest settings.

**StoryStudio, against section 5**
- **Routing hook.** The single hook is `agentApi.runInlineScriptAndGenerate`, because both ways a project starts (the MCP queue and `POST /projects`) end there.
- **Bug caught after the first push.** Neither create path stores `documentaryMetadata` on the project; it only travels in that action's `settings`. The first version read it from the project, so it would have used the placeholder title (`Agent Project 3`) as the topic. Fixed in `cdb9fad`: the metadata is passed explicitly, and an admin resubmit reuses the previous documentary request's payload. A pure function, `buildIntakeFromMetadata`, now holds that logic and is unit-tested with the model call injected.
- **Generated types.** `_generated/api.d.ts` was edited by hand: `convex codegen` pushes to the live dev deployment.
- **Result handling.** Title, description and tags come from doc-gen's `youtube_metadata.md` (parsed; tested against two real files, saved as fixtures); the thumbnail is doc-gen's own and is saved before the shared terminal effects, so they skip StoryStudio's thumbnail generator. The result's `warnings` are stored only in the `orchestratorRequests` row; the user sees "N notes to review" (showing them is a TODO).

**Measured on the instance**
- Phase 0: 212-second video in 38 minutes. Phase 2: 215 seconds in 14 minutes and 183 seconds in 21 minutes. All three came out short of the 240-second target.
- The instance reported image `docgen:e42ee20`, not the overlay build `b08c855`; overlays still rendered. Not explained.
- doc-gen's `stage` and `message` lag the real work by minutes (it showed "Generating narration" while fetching images), so the dispatcher treats `updated_at` and the heartbeat, not the stage, as the sign of life.
- Warnings on every job: "No audio has been listened to", plus weak-image notes (a modern photo for a period scene, small line drawings). Wikimedia Commons searches were rate-limited.
- **Stock footage was never used.** doc-gen reported "stock skipped because the builder takes only images" on both phase 2 jobs. Whether Storyblocks video is used at all is open (it lives in `~/local-gen-documentary`).
- Cost per default episode (3 talking clips, 10 animated stills, 3 Shorts) has not been measured; none of the three runs used them.
