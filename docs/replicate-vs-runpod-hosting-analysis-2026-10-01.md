# Hosting QM's GPU models on Replicate instead of RunPod — analysis

**Date:** 2026-10-01
**Question:** What would it mean to move the self-hosted RunPod workers (image, TTS, i2v,
upscale, audio, postprod) onto Replicate? Scalability, cost, maintenance, migration effort,
pros and cons.
**Bottom line:** Technically feasible and the orchestrator-side change is small, but it would
raise GPU cost roughly **4.5–8x** for our workload, remove the fixed-pod control we deliberately
built around, and require porting every worker from the RunPod handler contract to Cog. Replicate
is a good fit for *bursty, low-volume or experimental* models, and a poor fit for our steady,
GPU-bound, cost-sensitive pipeline. **Recommendation: do not migrate wholesale.** Use Replicate
selectively (see §9).

Sources for Replicate facts are listed at the end. Our own numbers come from this repo
(`src/shared/gpuPricing.ts`, `src/shared/fleet.ts`, `orchestrator/src/fleet-registry.ts`, the 2026-09-18
baseline run and 2026-09-16 incident report). Where I estimate rather than measure, it says so.

---

## 1. What we run on RunPod today

| Endpoint | Role | GPU | Pods (`workers`) |
|---|---|---|---|
| `flux-tts-s2t` (`rnqxi6c0mlq517`) | pooled TTS + MMAudio SFX + BGM (`audio-pool` image) | A40 48GB | 7 |
| `qwen-image-gen` (`e165se4r3eo5hp`) | T2I (Qwen-Image / Flux Klein 4B) | A40 | 4 |
| `qwen-image-edit` (`oxwx8o879qwtla`) | I2I edit | A40 | 4 |
| `wan2-i2v` (`nd7wloyvj09xwy`) | Wan2 14B FP8 image-to-video | RTX 6000 Ada 48GB | 6 |
| `bgm-s2t`, `multitalk` | legacy BGM / lip-sync | A40 | 2 / 2 |
| `postprod-lite` (`n6252hm01qz0xh`) | merge, concat, caption (Whisper), normalize | A40 | 4 |
| `dreamx-refine` | per-frame SR-DiT upscale | — | 4 |

Properties that matter for a migration:

- **Custom containers.** Our workers are one `handler.py` (~2,000 lines) in
  `flux4B-Wan2-storystudio`, specialised by `ENDPOINT_ROLE`, built as Docker images with
  multi-GB model weights (e.g. audio-pool ≈ 29 GB resident; qwen-image-gen/edit ≈ 44 GB each).
- **Fixed-pod policy.** Orchestrator code may never change `workersMax`; the operator sets pod
  counts via the dashboard (see `qm-orchestrator-diagnostics-and-fixed-pods-20260917`). The
  scheduler feeds each endpoint at its real pod count.
- **RunPod job contract.** `/run` → job id → `/status/{id}` or webhook, `/health`, `/cancel`.
  Errors often arrive as `COMPLETED` with `{"error": ...}` in output.
- **Outputs go to Cloudflare R2** (permanent URLs) from inside the worker.
- **Billing is execution-time only** on serverless; queue wait and idle workers are free
  (`qm-orchestrator-runpod-billing-model`).
- **Measured economics** (2026-09-18, real 10-frame project): 74 jobs, **2,197 GPU-seconds**,
  **$0.449**, ≈ **$0.045/frame**; wan2 i2v ($0.21) + qwen image ($0.12) are ~75% of it.
  Per-path later measured: $0.024/frame explainer, $0.054/frame premium.

## 2. What Replicate offers

- **Packaging:** models are built with **Cog** (`cog.yaml` + a Python `predict.py`), pushed with
  `cog push`; a private model becomes a **Deployment** with a dedicated API endpoint.
- **Scaling:** per-deployment min/max instances; scale-to-zero or always-on; rolling updates,
  canary, rollback; monitoring of latency, errors, GPU memory, spend.
- **Hardware:** T4 16GB, **L40S 48GB** ($3.51/h), A100 80GB ($5.04/h), H100 80GB ($5.49/h);
  multi-GPU (2–8x A100/H100/H200/L40S) needs committed spend. **There is no A40 or RTX 6000 Ada
  tier on the current price list**, so our 48GB workloads map to L40S.
- **Billing:**
  - *Public models:* active processing time only.
  - *Private models / deployments:* **setup + idle + active** — every second an instance is online.
    (Fast-booting fine-tunes are the exception; our large custom models are not.)
- **Limits:** 600 prediction-creates/min, 3,000/min on other endpoints. API-created prediction
  inputs/outputs/files are **deleted after 1 hour** by default.
- **Webhooks** for prediction updates; Python/JS SDKs.

## 3. Cost analysis

### 3.1 Unit price comparison

| | RunPod (our account) | Replicate |
|---|---|---|
| 48GB workhorse (A40 / L40S) | $0.44/h in `gpuPricing.ts`; orchestrator `job_costs` uses a flat $0.00021/s ≈ $0.76/h | L40S **$0.000975/s = $3.51/h** |
| Wan2 card (RTX 6000 Ada) | $0.77/h | L40S $3.51/h, or H100 $5.49/h |
| Billing basis | execution time only | execution time **+ setup + idle** for private deployments |

The repo carries two inconsistent RunPod rates (the $0.44/h table vs. the flat $0.00021/s in cost
tracking, which the baseline memory already flags as slightly overstated). The conclusion below
holds under either.

### 3.2 Same workload, re-priced (estimate)

Using the 2026-09-18 baseline (2,197 GPU-seconds, 10 frames) and *assuming an L40S runs each job in
about the same wall time as the A40/RTX 6000 Ada did* (unmeasured — L40S is generally faster than
A40, so this is conservative for Replicate):

| | GPU-seconds | Rate | Cost / 10 frames | ≈ per frame |
|---|---|---|---|---|
| RunPod, as billed by `job_costs` | 2,197 | $0.00021/s | $0.46 | $0.045 |
| RunPod, at the A40 table rate | 2,197 | $0.44/h | $0.27 | $0.027 |
| **Replicate L40S, active time only** | 2,197 | $0.000975/s | **$2.14** | **$0.21** |

→ **~4.6x** the currently-tracked cost, **~8x** the A40 table rate, *before* adding setup and idle.
If a faster H100 cuts wan2 runtime by 2–3x it would still cost about 2–3x RunPod for that step
($5.49/h vs ≤$0.77/h) — a faster GPU does not close a 7x price gap.

### 3.3 Setup and idle time (the part that surprises people)

On a private deployment every second the instance is online is billed.

- **Scale-to-zero:** you pay setup (container start + weight load) on every cold boot. Our own
  cold starts are 2–3 min for image/TTS and ~7 min for a fresh postprod-lite pull; large-weight
  containers like Wan2 are similar or worse. Each cold boot adds minutes of L40S billing (≈ $0.10–0.40
  per cold start at $3.51/h) on top of the job, and any scale-down idle timeout is billed too.
- **Always-on (min instances ≥ 1):** one L40S ≈ **$2,560/month**. Eight GPU endpoints × 1 warm
  instance ≈ **$20k/month** before serving a single request. On RunPod an idle worker costs $0.
- **Our traffic shape is bursty** (batches of projects, then nothing), which is the worst case for
  per-uptime billing: either you pay for idle, or you pay cold-start setup repeatedly.

### 3.4 Where Replicate *can* be cheaper

- **Public/community models** (billed active-time only, no idle, no ops): any step where a public
  Replicate model is good enough, with no custom container to maintain. QM already does this for the
  VLM QA and prompt-rewrite LLM calls, and earlier for Dialogue Premium i2v.
- **Very low-volume or spiky models** where the alternative is a permanently-provisioned RunPod pod.
  Not our case: we use RunPod serverless scale-to-zero already.
- **Engineering time** saved by not running GPU infra (valued in §5), if volume is small enough that
  this dominates. At ~$0.05–0.20/frame it does not, at current scale.

### 3.5 Cost verdict

For the same GPU work, expect **~4.5–8x higher GPU spend** on Replicate private deployments, plus
setup/idle overhead that is hard to predict without a pilot. There is no volume at which on-demand
Replicate beats on-demand RunPod serverless for these models; only committed-spend discounts (not
published, enterprise negotiation) could narrow it.

## 4. Scalability analysis

| Dimension | RunPod (today) | Replicate |
|---|---|---|
| Elastic scale | Per-endpoint `workersMax`; we fix it deliberately | Autoscaling min/max instances per deployment; "zero to hundreds" |
| Control over capacity | Absolute (operator sets pods; scheduler feeds at pod rate) | Autoscaler decides; we set only min/max. Our scheduler's "queue at exactly pod count" model would need rethinking |
| Cold start | 2–3 min typical, ~7 min cold image pull | Comparable for large custom images; mitigated only by paying for always-on |
| Capacity shortages | **Real, repeated:** 2026-09-16 incident — 31–91 min queue delays across three endpoints, account-wide 40-worker cap shared with another product | Different failure mode: GPU availability for L40S/H100 per region is Replicate's problem, but also opaque; no published SLA outside enterprise contracts |
| Per-account ceilings | 40 workers account-wide (confirmed shared) | 600 creates/min API limit (ample: our peak is a few jobs/s); GPU instance caps raised with volume/commit |
| Multi-GPU / bigger cards | Wide menu (A40…H100/H200/B200) | L40S/A100/H100 single; multi-GPU needs committed spend |
| Concurrency per instance | One request per worker | Cog supports configurable per-instance concurrency; can raise utilisation if the model tolerates it (our VRAM-heavy models mostly don't — see qwen VRAM notes) |
| Observability | Dashboard + `/health`; we built a watchdog + diagnostics around its quirks (health says "ready" while jobs sit `IN_QUEUE`) | Built-in latency/error/GPU-memory/spend metrics per deployment — a genuine improvement |

**Scalability verdict:** Replicate scales *further and more automatically*, and could remove the
single biggest operational risk we have actually hit (RunPod capacity stalls). But it gives up the
deterministic, operator-controlled capacity model the orchestrator is built on, and scaling is paid
for in uptime. For our workload sizes (tens of concurrent GPU jobs, not thousands) RunPod's ceiling is
not the constraint; its *reliability under shared-account contention* is.

## 5. Maintenance analysis

**What gets easier**

- No custom RunPod endpoint ops: no manual image-swap-then-recycle-workers dance (the
  `:latest` tag staleness bit us on 2026-09-20), no per-endpoint `workersMax` babysitting.
- Rolling updates, canary, rollback built in; versioned immutable model versions (`cog push`).
- Native per-deployment metrics and spend reporting (useful given our "no per-project cost
  attribution" gap).
- Replicate's own infra handles node health; fewer "worker crash-loop that `/health` doesn't show".

**What gets harder / new burden**

- **Rewrite every worker in Cog.** ~2,000 lines of `handler.py` in modes keyed by `ENDPOINT_ROLE`
  must become one or more `Predictor` classes with typed inputs. Our multi-mode, multi-model
  workers (image + TTS + merge + caption in one image) map poorly to Cog's one-predict-signature
  model; likely one Cog model per capability (more deployments to run and pay for).
- **Dependency drift is still ours.** The diffusers-git-HEAD / `huggingface_hub` floor bug
  (broke prod twice) is a container-build problem and migrates with us unchanged.
- **1-hour output deletion.** We would have to keep (and in our case already have) the R2
  re-host path (`persistExternalAsset`) — but then adds a webhook-race: copy before expiry,
  or keep uploading to R2 from inside the worker as we do now.
- **Replicate account cost controls:** no documented hard spend cap on deployments; need max-instance
  limits and alerts to avoid a runaway bill. Idle billing means a forgotten min-instance deployment
  is a silent leak.
- **Vendor concentration:** the orchestrator already calls Replicate for VLM QA and LLM rewrite;
  moving GPU generation there too makes one vendor outage a total outage.
- **Ongoing dual-stack period** (see §6) — operating both until parity is proven.

## 6. Migration difficulty

### 6.1 Orchestrator side — easy (≈ 1–2 days)

RunPod coupling is concentrated and thin:

- `orchestrator/src/runpod/client.ts` (~190 lines), `types.ts` (~120), `output.ts` (~40) — the whole
  client: submit, status, health, cancel, backoff, error classification.
- Callers use a handful of verbs (`status`, `health`, `cancel`, submit via the agent) in
  `assets/agent.ts`, `agents/generator.ts`, `watchdog.ts`, `diagnostics/diagnose.ts`,
  `admin.ts`.
- `fleet-registry.ts` (generated from `src/shared/fleet.ts`) maps counter keys → endpoint ids.
- The Replicate client already exists in the orchestrator (`replicateApiToken`, polling,
  `quality/` module), so auth, polling and cost bookkeeping patterns are in place.

Work: introduce a provider interface, add a Replicate implementation mapping RunPod's states
(`IN_QUEUE/IN_PROGRESS/COMPLETED/FAILED`) to Replicate's (`starting/processing/succeeded/failed/canceled`),
translate the `{"error": ...}`-inside-COMPLETED convention, replace `/health`-based stall detection
(no equivalent: Replicate exposes no "ready workers" count per deployment via prediction API; use
prediction status + deployment metrics), and retire or reshape the watchdog/fleet agents that assume
fixed pods.

### 6.2 Worker side — the hard part (≈ 3–6+ weeks, estimate)

- Port `handler.py` modes → Cog predictors; rebuild images as Cog images; weights handling
  (baked in vs. downloaded at `setup()` — baked is faster to boot but bigger to push).
- Re-validate each model's behaviour: Wan2 Lightning inference profile and seeds, torchao-FP8
  no-offload constraint, qwen VRAM hygiene, audio-pool co-residency. Each had real production bugs
  that only live runs found; porting re-opens them.
- Re-pin diffusers/hf-hub in the new base images.
- Unknown without a pilot: Cog image size limits for 40GB+ weights, push time, and actual boot times
  on Replicate hardware.
- Re-run QA calibration and the baseline projects end-to-end (the repo's own workflow rule:
  live-verify every change against real infra).

### 6.3 Rollback

Cheap if done incrementally: keep RunPod endpoints at `workers=0`, route per asset kind through the
provider interface, flip back with config. (`VPS config must be forwarded` gotcha applies: any new
`src/config.ts` key is inert until docker-compose forwards it.)

### 6.4 Verdict

*Orchestrator:* easy. *Workers:* moderate-to-heavy, and the risk is in re-validating model behaviour,
not in plumbing. "Easy to migrate" is true only for the thin client layer.

## 7. Pros and cons

### Pros of Replicate

1. **Operational simplification** — managed autoscaling, rolling updates, canary, rollback.
2. **Built-in observability and spend reporting** per deployment.
3. **Removes the shared-account 40-worker cap and the capacity-stall failure mode** seen on 2026-09-16.
4. **No idle cost for public models**, and a large catalogue of ready-made models (image, video, audio,
   LLM/VLM) usable with zero container work.
5. **Same vendor already in use** for VLM QA / LLM rewrite — one billing relationship, one SDK.
6. **Versioned model releases** (`cog push`) — cleaner than "push `:latest` and recycle workers".
7. **Higher-end hardware** (H100/H200, multi-GPU with commit) available without new account setup.
8. Scales to far larger parallelism than our current ~33 GPU workers if volume grows.

### Cons of Replicate

1. **Cost: ~4.5–8x per GPU-second** for our workloads on equivalent 48GB GPUs, plus setup + idle billing
   on private deployments.
2. **Idle economics don't suit bursty traffic** — pay for warmth ($2.5k/mo per always-on L40S) or for
   repeated multi-minute cold boots.
3. **Loss of deterministic capacity control** that the orchestrator and the "absolute fixed-pod"
   policy depend on.
4. **Full worker rewrite to Cog**; multi-mode handlers fragment into more deployments.
5. **No A40 / RTX 6000 Ada tier** — our tuned cost/perf points disappear.
6. **1-hour output expiry** — must persist to R2 immediately (already solved, but a hard dependency).
7. **Weaker free-form debugging** — less direct access to worker logs/shell than the RunPod dashboard
   (unverified; confirm in pilot).
8. **No documented hard spend cap**; runaway min-instance configs bill silently.
9. **Vendor concentration** — one outage hits generation *and* QA/LLM.
10. **Re-validation burden** — every model's production bug history is re-exposed.

### RunPod, for symmetry

*Pros:* ~5–8x cheaper GPU-seconds; zero idle cost; full container freedom; exact capacity control;
broad GPU menu; execution-time-only billing; working, live-verified pipeline.
*Cons:* capacity incidents (2026-09-16), shared account cap, opaque `/health`, manual image rollout and
worker recycling, more ops surface (watchdog, diagnostics, fleet registry), image-drift bugs.

## 8. Options

| Option | Cost vs today | Effort | Risk | Verdict |
|---|---|---|---|---|
| A. Stay on RunPod, harden (cap isolation, pinned deps, health/stall fixes) | 1x | low, ongoing | low | **Default** |
| B. Full migration to Replicate private deployments | ~4.5–8x GPU + idle | high | high | Not recommended |
| C. Hybrid: provider abstraction; **public Replicate models** for non-core steps; RunPod for the heavy custom ones | ≈1x–1.3x | medium (orchestrator work only) | low | **Recommended extension** |
| D. Replicate as *overflow/failover* for capacity stalls only | 1x + small spend on overflow | medium | low | Worth a pilot (see §9) |
| E. Dedicated RunPod account / separate endpoints for QM vs. other products | ≈1x | low | low | Cheapest fix for the account-cap contention |

## 9. Recommendation and next steps

1. **Do not migrate the core GPU fleet.** The cost multiple alone outweighs the ops benefits at current
   volume, and the migration risk is concentrated in worker re-validation.
2. **Address the real pain directly (Option A/E):** isolate QM's endpoints from the other product's
   account cap; pin `diffusers` to a commit
   ([[feedback-diffusers-githead-hf-hub-floor-drift]]); improve the `IN_QUEUE`-with-ready-workers
   detection.
3. **Introduce a provider interface in `orchestrator/src/runpod/`** (~1–2 days). It is cheap, reversible,
   and makes Option C/D possible. Do it only if the user wants that flexibility — it does not change
   behaviour on its own.
4. **Pilot one step on Replicate** to replace estimates with measurements — best candidate is
   `dreamx-refine` or `postprod-lite` caption (spiky, self-contained), or Option D failover for
   `qwen-image-gen`. Measure: cold boot time, billed setup seconds, per-job seconds on L40S, cost per
   frame, output reliability. Gate any wider move on that data.
5. Re-run this comparison if volume grows ≥10x (committed-spend pricing and sustained utilisation change
   the economics) or if Replicate publishes cheaper 48GB-class tiers.

## 10. Caveats and what I did not verify

- Replicate prices and limits are from its public pages as of this date; committed-spend discounts and
  enterprise SLAs are negotiated and not public.
- The L40S runtime equivalence, cold-boot times, Cog image size limits and Wan2 FP8 compatibility on
  Replicate hardware are **assumptions, not measurements**.
- RunPod rates: the repo contains two different figures (§3.1); neither was re-checked against the live
  RunPod dashboard for this document.
- Cost figures use one 10-frame baseline run; real monthly spend depends on volume I did not have.

## Sources

- Replicate pricing — https://replicate.com/pricing
- Billing for private models and deployments — https://replicate.com/docs/topics/billing
- Deployments — https://replicate.com/docs/topics/deployments
- Deploy a custom model — https://replicate.com/docs/guides/deploy-a-custom-model
- Rate limits — https://replicate.com/docs/topics/predictions/rate-limits
- Data retention / webhooks — https://replicate.com/docs/topics/webhooks/receive-webhook
- Repo: `src/shared/gpuPricing.ts`, `src/shared/fleet.ts`, `orchestrator/src/fleet-registry.ts`,
  `orchestrator/src/runpod/*`, `docs/qm-orchestrator-incident-report-2026-09-16-runpod-capacity.md`,
  memories `qm-full-project-run-baseline-20260918`, `qm-orchestrator-runpod-billing-model`,
  `qm-orchestrator-merge-pooling-cutover-20260920`
