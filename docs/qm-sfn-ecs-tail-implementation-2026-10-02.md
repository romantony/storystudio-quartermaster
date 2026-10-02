# Assembly tail on Step Functions + ECS — implementation plan

**Date:** 2026-10-02
**Status (2026-10-03):** LIVE. AWS side deployed as `QMOrchestratorTailStack`; orchestrator `b4e4f0f` deployed to the VPS with migration 018; one project and then three concurrent projects ran end to end on production (§8.2). Committed `73c9710`, `546dd5e`, `b4e4f0f`.
**Decision (operator, 2026-10-02):** asset and video generation stay on RunPod, driven by the
orchestrator on the VPS. The *assembly tail* leaves RunPod `postprod-lite` and runs as an AWS Step
Functions execution (`E2E-VideoGenerationPipeline-Orchestrator`) on the existing ECS task, calling RunPod only for the two things that need a GPU
model: word-level captions and BGM. `DreamX-Refine` is no longer used for upscaling.

AWS does **no asset generation**. It is the tail only.

---

## 1. Target flow

*Who does what:* the **VPS orchestrator** generates all assets on RunPod and, once a project's assets are
complete, submits a request with the **asset references** to **Step Functions**, which generates the
final video on ECS. Details and the multi-project behaviour are in §4.

```
 VPS orchestrator (RunPod)                      AWS Step Functions + ECS
 ─────────────────────────                      ────────────────────────────────────────────
 per frame, in parallel:                        1. AssembleCore (ECS: qm-concat-and-trim, `tail.js assemble`)
   qwen-image-gen / qwen-edit  ─ image            ├─ merge     per-frame clip + narration (+ SFX)
   tts (flux-tts-s2t)          ─ narration        ├─ concat    normalised, one resolution/fps
   wan2-i2v                    ─ motion clip      └─ remove silence (existing, validated algorithm) + A/V parity gate
   mmaudio (mm-audio)          ─ SFX  (opt-in)             │ outputs: video, audio wav, probed duration
   remotion overlay (Lambda)   ─ text overlay              ▼
                                                  2. Parallel — both on the BGM-S2T RunPod endpoint
 when every frame is done:                          ├─ CaptionWordLevel  (Whisper, word timestamps)
   compiler writes a manifest ──► start execution   └─ GenerateBgm       (ACE-Step, length = duration)
   poll / receive result  ◄────── final video URL              │
                                                  3. Finalize (ECS: same qm-concat-and-trim task, `tail.js finalize`)
                                                    ├─ upscale        (-> 1080p, lanczos + unsharp)
                                                    ├─ burn captions  (TikTok-style word highlight)
                                                    └─ overlay BGM    (flat volume, fades, no ducking)
```

What changes against today's tail (`postprod-lite` v2, one RunPod call per project, plus the per-frame
`merge` and `dreamx-refine` assets): merge, concat, silence removal, upscale, caption burn and BGM mix
all leave RunPod. RunPod keeps only Whisper and ACE-Step, which are model inference.

## 2. Fleet (done)

Source of truth is now **`orchestrator/src/fleet-registry.ts`, hand-maintained**. It was generated
from `src/shared/fleet.ts`, which is the AWS live path's fleet; the two are independent now. The
generator `orchestrator/scripts/gen-fleet-registry.ts` (`npm run gen:fleet`) is obsolete and would
overwrite the hand-maintained file — remove it (not done: deletion was held for the operator).

Synced 2026-10-02 against the dashboard screenshot and the live RunPod API (`GET /v1/endpoints`):

| Endpoint | ID | Pods | Use |
|---|---|---:|---|
| Flux-TTS-ANIM | `rnqxi6c0mlq517` | 7 | TTS only |
| qwen-image-gen | `e165se4r3eo5hp` | 4 | text-to-image |
| qwen-image-edit | `oxwx8o879qwtla` | 4 | image edit |
| Wan2-14b-fp8-RTX6000ADA | `nd7wloyvj09xwy` | 6 | image-to-video |
| **BGM-S2T** | `6apg6j7suzuezw` | **3** (was 2) | **word-level captions + BGM**, called from the SFN tail |
| **MM-Audio-A40** | `nzkcsef9t2iv7s` | **5** (new in registry) | MMAudio SFX, own endpoint again |
| *orchestrator pool total* | | **29** | |
| Trellis2 4 · 3d-rigging 3 · Blender-headless 2 · Hunyuan-3D 2 | | 11 | 3D pipeline, not ours |
| **account total** | | **40 / 40** | exactly at the cap |

Off (0 pods): **PostProd-Lite** `n6252hm01qz0xh`, **DreamX-Refine** `w0h49vn1pn0r87`, multitalk,
long2shorts, story-studio-ernie. Dropped from the registry: multitalk (was 2). Dialogue Premium's
multitalk rung falls through to its RunComfy fallback while it is at 0.

The account is at the cap, so any pod increase has to be paid for by shrinking another endpoint.

**Consequence not yet applied in code** (§5): `kinds.ts` and `tail-endpoints.ts` still route `mmaudio`
and `bgm` to the pooled audio endpoint and `merge`/`postprod-lite`/`dreamx-refine` to endpoints that
now have 0 pods. **Do not deploy the fleet change to the VPS on its own** — the tail would queue
forever on 0-worker endpoints. It ships together with §5.

## 3. The state machine — BUILT (`infra/lib/orchestrator-tail.ts`)

**`E2E-VideoGenerationPipeline-Orchestrator`**, a STANDARD machine with its own dedicated IAM role (not the
shared `E2E-StepFunction-Role`, which ~15 other pipelines depend on and whose PassRole list is hand-edited).
90-minute timeout — it fires before the orchestrator's 95-minute wall clock, so the real `TIMED_OUT` is what
gets reported. The definition is a pure builder (`buildOrchestratorTailDefinition`) so it can be tested.

**Input** (what the orchestrator sends; ~500 bytes — Step Functions caps state at 256KB, so everything big
goes by reference): `{projectId, manifestUrl, aspectRatio, language, options:{removeSilence, captions, bgm,
bgmPrompt?, sfx}, totalDurationS, outputPrefix}`. Execution name `<projectId>-a<attempt>-<hash of manifestUrl>`.

**States**

| State | Does |
|---|---|
| `PrepareAssemble` | Builds the task's tiny payload: manifest URL + aspectRatio + outputPrefix + removeSilence. |
| `AssembleCore` | `ecs:runTask.sync`, 60 min: the existing `qm-concat-and-trim` task definition with the command overridden to `node tail.js`, `TAIL_MODE=assemble`. |
| `ReadAssembleMeta` | `aws-sdk:s3:getObject` of `<prefix>meta.json` (ECS returns nothing, so the task writes its result to a key the machine knows). |
| `GenerateAudioLayers` | `Parallel` of two optional RunPod layers on **BGM-S2T**. Any failure inside it ships the video without the layer (`NoLayers`). |
| ↳ Caption branch | gate `options.captions` → submit `{mode:'transcribe', audio_url: <assembled audio>, language, return_timestamps:'word', words_per_group:4}` → wait/poll → SRT url. |
| ↳ BGM branch | gate `options.bgm` ∧ `bgmPrompt` present → submit `{mode:'bgm', prompt, duration_s: <real duration>}` → wait/poll → MP3 url. |
| `PrepareFinalize` / `FinalizeVideo` | `ecs:runTask.sync`, 60 min, `TAIL_MODE=finalize`: video + SRT + BGM → 1080p, burned captions, mixed BGM → `final.mp4`. |
| `ReadFinalizeResult` / `BuildOutput` | Reads `result.json`; emits the execution output below. |
| `TailFailed` | `Fail` with `ErrorPath`/`CausePath` = the real Error and Cause of whatever failed. |

**Poll loops** are bounded: every 10 s, at most 90 polls (15 min) per layer — a cold BGM-S2T worker loads three
models (~80 s measured), so this is generous headroom that still cannot wedge an execution. COMPLETED-without-url,
FAILED, CANCELLED, TIMED_OUT, an unreachable endpoint and an exhausted poll budget all mean "no layer", never a
failed project. Assembly and finalize failures DO fail the execution, with the real error.

**Output on SUCCEEDED:** `{videoUrl, durationSec, frames:[{frameId, url, durationS}]}` — exactly what
`assets/agent.ts` reads.

**Calling RunPod: a Lambda, not an SFN HTTP Task.** `QM-orchestrator-runpod` (`src/handlers/orchestrator-runpod.ts`)
keeps the key in Secrets Manager (an HTTP Task needs it in an EventBridge Connection with `Bearer ` glued on at
deploy time) and **trims the response**: a transcribe result carries every word with its timestamps, easily over
100KB, which would hit the 256KB state limit — only the SRT / audio URL ever reaches the machine. It allows only
`transcribe` and `bgm`, clamps the BGM duration to 5–120 s (ACE-Step is reliable to ~120 s; finalize loops the
track), and validates endpoint/job ids so it cannot be used as a general RunPod proxy.

## 4. The VPS orchestrator: asset generation, many projects, and the handoff

**Division of labour.** The VPS orchestrator generates *every asset* on RunPod and owns the project
until it has a complete set. It then submits **one request carrying asset references (URLs) — never the
assets themselves —** to Step Functions, which does video generation (the tail, §1/§3). AWS never
generates an asset. The orchestrator is the only thing that talks to RunPod for per-frame work; Step
Functions makes just the two RunPod audio calls in §3.

### 4.1 Asset generation with many projects (unchanged mechanism, new endpoints)

The asset model (`ORCH_PIPELINE_MODE=asset`, `src/assets/README.md`) is already built for concurrency;
nothing in it is project-aware except the compiler. In short:

1. **Submit** writes every asset a project needs as rows in the partitioned `assets` table — one
   partition per kind: `qwen-image-gen` | `qwen-edit` (alternatives by `options.referenceImage`), `tts`,
   `wan2-i2v`, optional `mmaudio`, optional `remotion`. Rows of *all* projects live in the same tables.
2. **One agent per kind** polls its own table every `ORCH_ASSET_TICK_MS` (5 s) and claims pending rows
   whose inputs have all arrived, up to its endpoint's **pod count** (`maxInFlight` = pods in
   `fleet-registry.ts`). So each endpoint is fed at exactly its real capacity, by whichever projects have
   work — a pod never idles while any project has a runnable row, and never gets more than it can run.
3. **Fairness across projects:** `claimPending` ranks rows **round-robin per project** (`6fe9cd2`,
   2026-10-01): a claim of N takes one row from each project in turn, fresh attempts before requeues. Three
   projects therefore advance together instead of the first one hogging every pod until it finishes.
4. **Handoff between agents is by data**, in the same transaction that completes a row: a finished still
   writes its URL into the `wan2-i2v` row, `tts` writes narration + real duration, and so on. A row is
   runnable once every URL it requires is present. No agent names a successor; `plan.ts` holds only
   `requires`.
5. **Quality gates** on the three visual kinds (`qwen-image-gen`, `qwen-edit`, `wan2-i2v`): a completion
   does not hand off until the local ffmpeg check (every asset) and the sampled VLM check pass. A
   rejected asset is reworked, never forwarded.
6. **Compiler** (every `ORCH_COMPILER_TICK_MS`, 30 s), per live project: repairs stranded rows, requeues
   stuck ones (bounded `reworks` ≤ 3 and `attempts`), and — when nothing is missing, stranded, stuck or
   working — **arms the tail**.

Pipelining across projects falls out of this: project B's images can run while project A's Wan2 clips
run and project C's narration runs, because each is a different endpoint with its own pods. The bottleneck
endpoint (Wan2, 6 pods) sets overall throughput; the 09-19 run measured 4.7–4.8× parallelism across three
concurrent projects with zero failed assets.

**What changes for the new fleet:** `bgm` stops being a RunPod asset kind (it moves into the SFN tail),
`dreamx-refine` and `merge` disappear, `mmaudio` moves to the MM-Audio endpoint (5 pods), and `tts` is
the only kind left on Flux-TTS-ANIM (7 pods). Per-endpoint in-flight ceilings now simply equal §2's pod
counts; there is no longer a pooled endpoint whose ceiling is shared across kinds
(`countInFlightForEndpoint`'s sharing logic becomes unused).

### 4.2 Handoff to Step Functions

The compiler's final step changes from "arm the `postprod-lite` row" to **"arm the `sfn-tail` row"**:

```
all assets complete + QA verdicts passing
        │
compiler: build manifest (frame order, clip/voice/sfx/overlay URLs, droppedFrames, options)
        │   write to R2 → manifestUrl           (a FILE — SFN's 256KB limit)
        │   claim assembly (conditional UPDATE — two ticks can't arm twice)
        ▼
sfn-tail row armed  ──►  sfn-tail agent: StartExecution(name = projectId-attempt, input = refs only)
        │
        │   VPS polls DescribeExecution  (or EventBridge → signed webhook, later)
        ▼
SUCCEEDED → output.videoUrl → result/finalize.ts → §9.6 callback to StoryStudio
FAILED / TIMED_OUT → recompile + retry within the attempts cap (as the tail row does today)
```

- **Many projects at the tail.** Each project is its own execution, so projects never share state or
  files. `sfn-tail`'s `maxInFlight` is an operator-set ceiling on concurrent executions (cost and the
  ECS task quota — Fargate tasks run per execution), **not** a pod count. The real contention is the two
  BGM-S2T calls per project against **3 pods** (§7 Q4); a queue there only delays that project's tail.
- **Overlap.** Because the tail is separate infrastructure, project A can be assembling in AWS while
  projects B and C are still generating on RunPod. Today's tail competes for the same account's pods.
- **A permanently failed frame still does not block assembly:** it drops out of the manifest
  (`droppedFrames`) and the project finishes `partial`; fewer than two surviving frames fails the project.
- **Idempotent and cancellable:** an execution name of `<projectId>-<attempt>` makes a duplicate start a
  no-op; `StopExecution` replaces `cancelOnTimeout`. Timeout ≈ 90 min, mirroring `Finalize`'s 5400 s.
- **Per-frame durability is kept.** Each frame's finished clip is hosted by AssembleCore
  (`meta.json` `frameTimeline[]`), so a one-frame rework restarts from that clip, as it does now.

### 4.3 VPS credentials and config

The VPS needs `states:StartExecution|DescribeExecution|StopExecution` on **that one state machine ARN**
and read access to nothing else in AWS beyond what Remotion already has (least-privilege pattern of
`qm-orchestrator-remotion-vps-deploy-20260916`). New keys (`SFN_TAIL_STATE_MACHINE_ARN`, `SFN_TAIL_REGION`, credentials,
`ORCH_TAIL_MODE`) are **forwarded in `orchestrator/deploy/docker-compose.yml`** — a `src/config.ts` key does
nothing until compose forwards it (`qm-vps-config-must-be-forwarded`). R2 keys for the manifest write are
already present.

### 4.4 Updating the VPS

The VPS runs `6fe9cd2` today (checked 2026-10-02) with the **old** fleet registry and 150 s timeouts.
Update order, all together because the fleet change alone would strand the tail on 0-pod endpoints:

1. Land §5's code + the SFN state machine + IAM (AWS side first — the orchestrator needs the ARN).
2. Set `SFN_TAIL_STATE_MACHINE_ARN` and the credentials in `/opt/qm-orchestrator/.env`; sync
   `docker-compose.yml` from the repo; `git pull` in `/opt/qm-orchestrator/repo`; rebuild and recreate
   the `orchestrator` and `watchdog` services.
3. Drain first: wait until no project is mid-tail (`ORCH_TAIL_MODE` is read per arming, but an
   in-flight `postprod-lite` row would hit a 0-pod endpoint).
4. Verify with `GET /v1/health` plus one real project; then three concurrent (§8).

## 5. Orchestrator code changes — DONE 2026-10-02 (uncommitted, undeployed)

`npx tsc` clean; `npx jest orchestrator`: **569 passed**, 54 skipped (the DB-gated suites). Migration 018
applied and the asset repo integration suite run against a throwaway Postgres 16 (29/32 + 1 failure
described below).

| File | Change |
|---|---|
| `src/fleet-registry.ts` (+ test, README, `planner.test.ts`) | Hand-maintained fleet, 6 endpoints / 29 pods (§2). |
| `src/assets/kinds.ts` | Removed `dreamx-refine`, `merge`, `bgm`, `postprod-lite`. Added `sfn-tail` (`provider:'sfn'`, project-scoped, sentinel endpoint `aws-sfn:tail`, ceiling `SFN_TAIL_MAX_EXECUTIONS = 3`, 95-min wall clock, stop on timeout). `tts` -> flux-tts-s2t (7), `mmaudio` -> MM-Audio (5). |
| `src/assets/plan.ts` | `refine`/`merge`/`bgm` gone; `sfx` requires the motion clip; `kinds = [...frameKinds, 'sfn-tail']`; `TailSteps` lost `upscale`; `clipKind` = remotion ?? mmaudio ?? wan2. |
| `src/assets/submit.ts` | One project row (`sfn-tail`, blocked); no bgm row; no `upscaleFrames` flag. |
| `src/assets/compiler.ts` | No BGM gating; arms `sfn-tail` with `{manifestUrl, aspectRatio, options, totalDurationS}`; **no inline-manifest fallback** — if R2 is unconfigured or the upload fails it logs an error and waits, without claiming assembly. |
| `src/assets/manifest.ts` | v3: `bgm: {prompt, volume}` (the tail generates it), `steps` without `upscale`, `preMerged` removed. |
| `src/assets/agent.ts` | `provider:'sfn'`: StartExecution inside the claim transaction, ARN stored as `provider_job_id`; reconcile polls `DescribeExecution` (RUNNING touches / times out -> StopExecution + requeue; SUCCEEDED -> `{video, duration_s, frames}`; FAILED/TIMED_OUT/ABORTED -> shared failure path). |
| `src/assets/result.ts` | Reads the final url / duration / per-frame clips from the `sfn-tail` row. |
| `src/aws/sfn.ts` (new) | Start/describe/stop transport, deterministic execution names, `ExecutionAlreadyExists` adoption. |
| `src/steps/builders/sfn-tail.ts` (new) | Execution input — references only, refuses a missing `manifestUrl`. |
| `src/db/migrations/018_asset_sfn_tail.sql` | `asset_sfn_tail` partition (retired partitions left in place). |
| `src/config.ts`, `src/index.ts`, `deploy/docker-compose.yml` | `SFN_TAIL_STATE_MACHINE_ARN`, `SFN_TAIL_REGION`; forwarded in compose; startup warning when unset. |
| `package.json` | `@aws-sdk/client-sfn`. |
| `src/assets/README.md`, `src/steps/tail-endpoints.ts` | Docs/comments brought in line; tail-endpoints marked cohort-only. |

**Left alone on purpose:** the cohort model (`steps/catalog.ts`, `agents/rework.ts`, the old builders and
the `tail-endpoints.ts` constants they import). The VPS runs `ORCH_PIPELINE_MODE=assets`, so none of it
is live; delete it together once cohort mode is confirmed dead. The obsolete generator
`scripts/gen-fleet-registry.ts` is also still there (deleting it is the operator's call).

**Known test-suite failures that are NOT from this change** (the repo SQL is untouched): in
`repo.integration.test.ts` three cohort `stepsJoinable` tests, and in `asset-repo.integration.test.ts`
"surfaces an asset left unjudged past the grace window" — it backdates `completed_at` only, but
`listStaleUngated` has used `GREATEST(completed_at, updated_at)` since the 09-19 fix. Both predate this work.

### The contract the AWS side must meet

The orchestrator is finished against exactly this; the state machine must produce it.

* **Input** (what `buildSfnTailInput` sends): `{projectId, manifestUrl, aspectRatio, language, options:{removeSilence,
  captions, bgm, bgmPrompt?, sfx}, totalDurationS, outputPrefix}`. Execution name
  `<projectId>-a<attempt>-<sha256(manifestUrl)[0:8]>`.
* **Manifest** (v3, `src/assets/manifest.ts`): `frames[]` in narrative order, each
  `{frameId, seq, audioUrl, narration, durationS, videoUrl | imageUrl+animate, sfxFromVideo?}`;
  `droppedFrames[]`; `steps{removeSilence, burnCaptions}`; `captions?`; `bgm?{prompt, volume}`.
* **Output on SUCCEEDED** (required): `{videoUrl: string, durationSec: number, frames: [{frameId, url}]}`.
  A SUCCEEDED with no `videoUrl` is treated as a failure.
* **Failure**: end in `Fail` with a meaningful `Error`/`Cause` (it is copied into the row's error and into the
  project's error list). Make the state machine's own timeout **90 min** — the orchestrator's wall clock is
  95 min and only exists to stop a stuck RUNNING execution.
* **No callback to the orchestrator.** It polls.
* **Credential**: `states:StartExecution|DescribeExecution|StopExecution` on this one state machine ARN.

Not yet done on the orchestrator side: per-execution **cost** (an execution has no worker-seconds rate, so
`asset_costs` records nothing for the tail). Log the state machine's duration/ECS task seconds in §8 and
decide the attribution then.

## 6. AWS / ECS changes — BUILT (local tests; nothing deployed)

### Why finalize is NOT `e2e-finalize`

The plan was to reuse StoryStudio's `e2e-finalize` task. Reading its source (`storystudio-unified/infrastructure/
fargate/e2e-finalize`, `lambda/E2E-finalize-video-premium`) ruled it out:
- it calls `verify_jwt_token()` and **raises `Missing JWT token`** without a StoryStudio JWT, verified against
  their own `E2E_JWT_SECRET` — the orchestrator has no legitimate way to mint one;
- it reports to StoryStudio's Convex (only when `convexEndpoint`+`jwtToken`+`jobId` are all present — so omitting
  them *is* a safe no-write mode, but the JWT check comes first);
- it returns nothing to Step Functions and uploads to R2 with credentials this account doesn't inject.

So upscale / burn / overlay is a **finalize stage in the QM-owned `qm-concat-and-trim` task**, with the algorithm
ported faithfully (scale → unsharp → ass, the TikTok caption style, resolution maths) and one deliberate change:
the BGM is a **flat volume with fades and no sidechain ducking** (the 2026-08-13 Audio Mix Levels spec —
Voice 100 % / SFX 22 % / BGM 20 %, no duck). The manifest's `bgm.volume` (0.15) is honoured. This also removes the
external dependency and the Convex coupling entirely.

### The container (`infra/docker/concat-and-trim/`)

One image, two entrypoints: `node index.js` is the original task (untouched behaviour — the AWS live-path
pipelines keep using it); `node tail.js` is the orchestrator tail. The state machine overrides the container
command; there is **no new cluster, task definition, repository or IAM role**.

| File | |
|---|---|
| `index.ts` | Helpers exported, `main()` guarded by `require.main === module`, `concatAllFrames` split so the tail reuses the exact validated concat/batch/stream-copy path (`concatLocalClips`). **One real fix:** `setsar=1` in the per-clip normalise — scale's rounding gives clips of different source sizes different SARs (e.g. 3653:3654) and the concat filter refuses to join them. Found by the end-to-end test; the live path never hit it because its clips are all one size. A no-op when SAR is already 1:1. |
| `tail-core.ts` | Pure logic: manifest check, SFX loudness normalisation (ebur128), merge filter (apad, 44.1 kHz, dropout 0), Ken Burns, A/V parity, resolution maths, TikTok ASS captions, finalize filter chain. |
| `tail.ts` | `assemble` (per-frame merge/Ken Burns → host each clip → concat → optional silence removal → parity gate → `video.mp4`, `audio.wav`, `meta.json`) and `finalize` (→ `final.mp4`, `result.json`). A frame that cannot be built is dropped and named; fewer than two survivors fails. Captions/BGM that cannot be fetched degrade to a video without them. |
| `Dockerfile` | Compiles all three files; adds `fontconfig`, Montserrat and Noto Sans Devanagari into `/opt/fonts` (without a Devanagari font libass renders Hindi conjuncts as tofu). |

**Outputs go to the existing `qm-remove-silence-output` S3 bucket** (public-read, no lifecycle rule, so URLs
persist), under `projects/<id>/tail/`. The final video is served from there rather than R2: R2 would need R2
credentials injected into the task, which the shared immutable `ecsTaskExecutionRole` cannot do. Revisit if
StoryStudio needs R2 URLs specifically.

### CDK (`infra/lib/pipeline-stack.ts`)

- `QM-orchestrator-runpod` Lambda + `secretsmanager:GetSecretValue` on the existing RunPod secret.
- `qm-orchestrator-tail-sfn-role`: `ecs:RunTask` on `qm-concat-and-trim:*`, `ecs:StopTask/DescribeTasks`,
  `iam:PassRole` (the task role and `ecsTaskExecutionRole`, only to `ecs-tasks.amazonaws.com`), the managed
  `StepFunctionsGetEventsForECSTaskRule`, invoke on the Lambda, read on the output bucket. Nothing else.
- The state machine (`CfnStateMachine`, tags `batchjob`, `orchestrator`).
- Managed policy **`qm-orchestrator-tail-control`** (`states:StartExecution` on the one machine,
  `Describe/StopExecution` on its executions) — **to be attached by hand** to the VPS user
  `qm-orchestrator-remotion-invoke`, which is itself not CDK-managed; a routine deploy should not edit the
  credential a production box runs on.
- Outputs: `OrchestratorTailStateMachineArn` (→ `SFN_TAIL_STATE_MACHINE_ARN` on the VPS) and
  `OrchestratorTailControlPolicyArn`.
- `cdk synth` verified: no VPC / NAT / gateway resources appear (the known `ecs.Cluster` gotcha), the definition
  string resolves to valid JSON with the right `Ref`/`GetAtt`s, and the **CodeBuild source asset hash changes** —
  expected, the Docker context changed, so the image must be rebuilt (§8).

### Verification done (all local, no AWS calls)

| What | How |
|---|---|
| Container logic | 38 unit tests (`tail-core.test.ts`). |
| Container end to end | `tail.e2e.test.ts`, **real ffmpeg**, a local HTTP server standing in for R2, S3 mocked in memory: four frames (plain, SFX, Ken Burns still, plain) → merge → concat → silence removal → parity gate → finalize to 1080×1920 with looped BGM and captions **proven burned in** by a frame diff against a no-caption render. Also: <2 frames fails, a broken frame is dropped, missing captions/BGM degrade, a missing video fails. Stable over repeated runs. |
| Lambda | 20 tests (modes allowed, id validation, BGM clamp, response trimming, 404, worker-error-in-COMPLETED). |
| State machine | Structure (reachability, Defaults) **plus an ASL interpreter** that executes the machine against scripted ECS/S3/Lambda responses: happy path with exact payloads, optional layers skipping/failing/timing out, bounded polling, assemble/finalize failure carrying the real Error and Cause. Mutating a JSONPath makes 6 tests fail. Also accepted by `asl-validator`. |
| CDK | `cdk synth` of the whole pipeline stack; IAM and resolved definition inspected. |

## 7. Open questions — answered 2026-10-02

1. **BGM-S2T serves BGM and word timestamps — CONFIRMED LIVE (2026-10-02).** Two jobs against
   `6apg6j7suzuezw`, submitted from the VPS:
   - `transcribe` (`return_timestamps:"word"`, `words_per_group:3`) on a real narration clip from the
     10-01 run → `chunks[]` with per-word `[start,end]` (12 words, first `Maya [0,0.38]`), the full
     `text`, and a hosted grouped **`srt`** (valid 3-word cues). 3.2 s of inference.
   - `bgm` (`duration_s:10`) → hosted MP3, `ffprobe` duration **10.03 s**, HTTP 200. 3.6 s of inference.
   - **Cold start:** both jobs waited ~13–15 s in queue and ~78–87 s execution, because the first job on a
     cold worker loads ACE-Step (46 s), SFX (21–24 s) and Whisper (8–9 s). Warm calls are ~3–4 s. Budget
     the SFN poll loop for ≥ 300 s on the first call after idle, as the orchestrator did for tts.
   - **Use `mode:"transcribe"`, not `mode:"caption"`, in the SFN.** `caption` burns the captions into a
     video on the pod; the burn belongs to `e2e-finalize` on ECS. `transcribe` returns what we need
     (`srt` + word `chunks`) and takes the final concatenated *audio* — the only point where word
     timings are true after silence removal. §3's `CaptionWordLevel` state is corrected accordingly.
2. **Burned-in word-level captions — RESOLVED (§6).** `e2e-finalize` cannot be used (it demands a StoryStudio
   JWT), so the QM finalize stage burns them; the end-to-end test proves they are really in the frame. What is
   still unjudged is how they *look* on a real video — the style is a port of StoryStudio's TikTok look
   (Montserrat 72, yellow word highlight, bottom margin), so check one real render by eye.
3. **1080p upscale in place of DreamX.** Decided by the operator. It is an ffmpeg lanczos scale + unsharp, not a
   model, so quality is below DreamX SR-DiT. The concat step letterboxes into the legacy dimension table first
   (`9:16` → 1008×1792) and finalize then scales that to 1080×1920 — so the open **9:16 bug** (TODO 2026-09-18)
   is worth checking on the first real run: a landscape Wan2 clip inside a portrait canvas gets black bars.
4. **Capacity.** Each project, when its AssembleCore finishes in Step Functions/ECS, calls the BGM-S2T
   RunPod endpoint for **both** assets — word-level captions (`transcribe`) and BGM (`bgm`) — in
   parallel, and each project gets its own pair. Three projects = six calls on 3 pods, so some queue;
   each is seconds when warm, so the queue clears fast. Watch it, no change needed.
5. **MMAudio.** After the animation / Wan2 i2v step, `mmaudio` runs per frame on the MM-Audio endpoint
   (5 pods) — that is the registry's `mm-audio` entry and stays. It is opt-in per project
   (`options.sfx`); the **Yes/No SFX flag** on the request is a later addition, and the existing
   `options.sfx` is the hook it will drive.
6. **Cost.** Fargate time replaces A40 time for the tail. Not measured: log per-execution duration from
   day one and compare with the 09-18 baseline ($0.045/frame all-in).

## 8.1 Deployed and live-verified — 2026-10-02

**Deployed as a separate stack, `QMOrchestratorTailStack`** (operator's call). `cdk diff` of `QMPipelineStack` showed that
deploying it would also ship **8 live-path commits never deployed since 2026-08-22** (provisioner pod pools `75aae8a`, M0.5
lease `d138d71`, ModelsLab decommission `a5a8b9d`, queue-index readers `f429ba7`, …) across 29 existing resources. The tail
stack only ADDS resources and imports the cluster/repo/bucket by name; its diff was 16 `[+]`, zero `[~]`. Those 8 commits are
still undeployed — a separate decision.

Built pieces: task definition `qm-orchestrator-tail` on image tag **`orchestrator-tail`** (the live path's `:latest`, dated
2026-07-29, is untouched — so the `setsar` fix and the `index.ts` refactor have NOT reached the live path), CodeBuild project
`qm-orchestrator-tail-build` (buildspec `buildspec-tail.yml`), Lambda `QM-orchestrator-runpod`, state machine
`arn:aws:states:us-east-1:929075264324:stateMachine:E2E-VideoGenerationPipeline-Orchestrator`, policy
`arn:aws:iam::929075264324:policy/qm-orchestrator-tail-control` (NOT yet attached).

First image build failed: **`fonts-montserrat` does not exist in Debian bookworm** (node:20-slim). Fixed by fetching the static
TTFs from the upstream project at tag v7.222, with every font step checked so a missing font fails the build. (StoryStudio's
e2e-finalize Dockerfile has the same apt line but ends the chain with `;`, which masks the failure — it likely ships no Montserrat.)

| Run | Frames | Result | Wall clock | Checked |
|---|---|---|---|---|
| `qm-e2e-rr-b-20261001` (16:9, SFX) | 3 | SUCCEEDED | 4m10s (assemble 69s, layers 115s incl. RunPod cold start, finalize 65s) | 1920×1080, A/V drift 0.13s, captions burned (Montserrat, yellow word highlight, synced), BGM on |
| `js79srd…__a1` from 09-19 (9:16, SFX) | 18 | SUCCEEDED | 6m52s (assemble 3m31s, layers ~30s warm, finalize 2m48s) | 1080×1920, 87.8s, A/V drift 0.18s, full-frame portrait (no bars — these clips were DreamX 1056×1856), captions + BGM to the last second |

Outputs: `s3://qm-remove-silence-output/projects/manual-tail-test/…/tail/`.

## 8.2 Orchestrator cutover + production runs — 2026-10-02/03

Policy `qm-orchestrator-tail-control` attached to `qm-orchestrator-remotion-invoke`; `SFN_TAIL_STATE_MACHINE_ARN`/`SFN_TAIL_REGION`
added to the VPS `.env` (backup `.env.bak-20261002`); compose synced (backup `docker-compose.yml.bak-20261002`); VPS drained (no live
projects); `git pull` to `b4e4f0f`, images rebuilt, migration 018 applied, orchestrator + watchdog recreated. Health ok, 7 agents incl.
`sfn-tail`, and the VPS credential verified against the state machine from inside the container.

| Project | Frames | Run | Tail (SFN) | Result |
|---|---|---|---|---|
| `qm-e2e-sfntail-20261002-01` (alone) | 3 | 13.5 min | 3m55s | completed, 1920×1080, 10.7s, captions + BGM + SFX, callback delivered |
| `qm-e2e-sfntail-20261003-02` (concurrent) | 3 | 12.3 min | 3m30s | completed, 10.6s, delivered |
| `qm-e2e-sfntail-20261003-03` (concurrent) | 3 | 9.3 min | 2m25s | completed, 10.73s, delivered |
| `qm-e2e-sfntail-20261003-04` (concurrent) | 3 | 10.8 min | 2m45s | completed, 10.63s, delivered |

Every asset first-attempt, zero errors, every §9.6 result carries `mergedClipUrl`s. Generation is still the long pole (Wan2 at 6 pods);
the tails overlap in AWS without contending for RunPod pods. Not yet run: a large project (the 111- and 95-frame 09-19 sets), a 9:16
project with native (non-DreamX) Wan2 clips, Hindi captions. Per-execution cost still unrecorded.

## 8. Rollout and verification

Everything above is built and tested locally. **Nothing is deployed.** Order matters — the orchestrator change
must not reach the VPS before the state machine exists (§4.4).

1. ~~**Build the image.**~~ DONE via `QMOrchestratorTailStack` (§8.1) — the text below describes the original plan. `cdk deploy QMPipelineStack` creates the Lambda, role, state machine and policy, and
   updates the CodeBuild source asset (the Docker context changed) — but CodeBuild does not run on its own:
   `aws codebuild start-build --project-name qm-concat-and-trim-build` and poll to `SUCCEEDED`, exactly as for
   the original task. Pass the real secret ARNs and `-c WEBHOOK_BASE_URL=…` (the documented gotcha). Check
   `cdk diff` first for stray VPC/NAT resources. The existing `index.js` entrypoint is unchanged, so the AWS
   live-path pipelines are unaffected by the new image — but `setsar=1` does touch their concat, so run one
   existing pipeline after the rebuild to confirm.
2. ~~**Run the machine by hand**~~ DONE for two projects (§8.1); the 111- and 95-frame 09-19 projects are still worth a run. (`aws stepfunctions start-execution`) with a real manifest: first the 09-19
   projects' still-hosted per-frame clips (also closes the TODO "re-assemble #3 and #1"), then one with
   captions + BGM + SFX. This is the first time ECS, S3 and RunPod meet.
3. **Attach `qm-orchestrator-tail-control`** to the VPS user `qm-orchestrator-remotion-invoke`; set
   `SFN_TAIL_STATE_MACHINE_ARN` in `/opt/qm-orchestrator/.env`; sync `docker-compose.yml`.
4. **Drain, then deploy the orchestrator** (code + migration 018 + the §2 fleet together). One real project end
   to end, then three concurrent: A/V parity, caption sync, BGM present at the tail, resolution and aspect ratio.
5. **Commit** after the operator's go-ahead.

Not yet measured: per-execution cost (Fargate seconds + RunPod seconds) — log it from the first run and compare
with the 09-18 baseline ($0.045/frame all-in). The orchestrator records no cost for the tail today.

Per project convention: verify each step against real infra before calling it done; deploy is routine, commit
waits for the operator.
