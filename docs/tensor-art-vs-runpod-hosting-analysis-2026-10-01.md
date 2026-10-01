# Hosting QM's models on Tensor.Art (TAMS) instead of RunPod — analysis

**Date:** 2026-10-01
**Questions:** (1) Can we publish an API on tensor.art and call it from our application?
(2) Can we create "apps" on tensor.art and wire them into our application? (3) Scalability, cost,
maintenance, migration ease, pros and cons — versus RunPod.

**Bottom line:** Tensor.Art is a *consumer generation platform with a developer API (TAMS)*, not
a GPU-hosting platform. You can **call** its API and run **ComfyUI workflow templates** on its shared
GPUs, but the public documentation shows no way to deploy our own container/handler, no exclusive
GPUs, a 5 QPS limit, and no documented webhooks. **Hands-on tests on 2026-10-01 (§5A) show it can
run both Qwen-Image and Wan2.2 i2v at good quality**, so image *and* video generation are feasible
there — but at **~1.3–5x our RunPod cost**, with a shared queue and no SLA. It still **cannot
replace RunPod** (TTS, audio, Whisper, ffmpeg, DreamX stay put). **Recommendation: do not migrate;
at most use it as an overflow provider, after confirming the open questions in §11 with Tensor.Art.**

> **Revision 2026-10-01 (later):** the first version of this doc said video was
> unverified/unlikely and that images could be ~13x cheaper. Both were wrong once real runs were
> made — see §5A. Sections 4, 5 and 9 below were corrected accordingly.

Evidence base: Tensor.Art's own TAMS docs (`tams-docs.tensor.art`) and the official ComfyUI node repo.
Several pages were thin or blocked (the API-doc pages returned 403), so many things are **documented
as absent / unknown** rather than confirmed. Those are marked **[unverified]**. Our own figures come
from this repo and are the same ones used in
`docs/replicate-vs-runpod-hosting-analysis-2026-10-01.md`.

---

## 1. What we run on RunPod (recap)

| Endpoint | Role | GPU | Pods |
|---|---|---|---|
| `flux-tts-s2t` | pooled TTS + MMAudio SFX + BGM (`audio-pool`) | A40 48GB | 7 |
| `qwen-image-gen` | T2I (Qwen-Image / Flux Klein 4B) | A40 | 4 |
| `qwen-image-edit` | I2I edit | A40 | 4 |
| `wan2-i2v` | Wan2 14B FP8 image-to-video | RTX 6000 Ada | 6 |
| `bgm-s2t`, `multitalk` | legacy BGM / lip-sync | A40 | 2 / 2 |
| `postprod-lite` | merge, concat, Whisper caption, normalize (ffmpeg) | A40 | 4 |
| `dreamx-refine` | per-frame SR-DiT upscale | — | 4 |

Key properties: our own Docker images with a custom `handler.py`; fixed pod counts set by the
operator; execution-time-only billing (≈ $0.045/frame measured 2026-09-18; image steps ≈ $0.012
each); outputs written to Cloudflare R2 by the worker.

## 2. What Tensor.Art / TAMS actually is

- **TAMS** ("Tensor.Art API Management System", `tams.tensor.art`) is the developer API. You register
  an application, get an **appId + key**, and call a REST interface. Requests are signed
  (appid, nonce, timestamp, signature).
- **Endpoint groups documented:** `jobs`, `workflow`, `models`, `resource`, `controlnet-detect`,
  `img2prompt`. The introduction describes it as an interface "to build various applications of
  model works based on **Stable Diffusion**."
- **Workflow templates:** you run a ComfyUI-style workflow JSON (nodes like
  `CheckpointLoaderSimple`, `LoraLoader`, `KSampler`, `VAEDecode`, `SaveImage`) by calling
  *get template → check params (returns estimated credits) → create job*. Parameters are mapped by
  `nodeId` + `fieldName`. Jobs return `CREATED` and are **polled** for status; completion returns
  image URLs with metadata. There is a `workflow/params/check` call that pre-quotes credits —
  useful for cost control.
- **AI Tools:** workflows published on the Tensor.Art site as "AI Tools" have an ID; an official
  `ComfyUI_TENSOR_ART` node pack lets ComfyUI call them. The site also markets monetisation for
  creators who publish workflows as AI Tools.
- **Models:** you can upload checkpoints/LoRAs to the Tensor.Art model library and reference them by
  model ID.
- **Billing:** **credits at $0.003 USD per credit**, "calculated separately" from Tensor's
  consumer credits; failed generations don't consume credits.
- **Limits stated in the FAQ:** **5 QPS** (adjustable "in the future"); **no exclusive GPU
  resources** — all tasks go into a shared queue with potential delays at peak; generated images
  are not content-reviewed.

## 3. Direct answers to the two questions

### 3.1 "Can we publish an API on tensor.art and use it in our application?"

**Partly, in the opposite direction from what the question assumes.**

- ✅ We can **consume** Tensor.Art's API from our orchestrator: create a TAMS app, get keys, submit
  jobs, poll, download results.
- ✅ We can **run our own ComfyUI workflow JSON** through the workflow-template API, using
  checkpoints/LoRAs available on the platform (or uploaded to it).
- ❌ We **cannot publish our own container or `handler.py` as an API endpoint.** Nothing in the TAMS
  docs describes bring-your-own-Docker, custom endpoints, custom serverless handlers, or dedicated
  GPUs. There is no documented equivalent of a RunPod endpoint or a Replicate/Cog deployment.
- ⚠️ Whether **custom ComfyUI nodes** are supported is **not documented** [unverified]. Our workers
  rely on custom Python (torchao-FP8 pipelines, audio-pool co-residency, ffmpeg tails), none of which
  can be expressed as stock ComfyUI nodes.

### 3.2 "Can we create apps and add them to our application?"

Two different things share the word "app":

1. **A TAMS "application"** (at `tams.tensor.art/apps`) — it is just an **API credential/identity**.
   Creating one is trivial; it is not hosted compute.
2. **An "AI Tool" published on the Tensor.Art site** — a ComfyUI workflow packaged for the site.
   This is the closest thing to "publishing an app." It can be invoked by ID (including from our code
   via TAMS or the ComfyUI node pack). **Whether an AI Tool can be kept private, and whether a tool
   can be billed to us rather than shown publicly, is not documented** [unverified]. Publishing our
   proprietary pipeline publicly on a consumer marketplace would also expose it to other users and
   to the platform's terms.

So: yes to "create an app + call it from our application" for *ComfyUI-expressible image
workflows*; no to hosting arbitrary models/services.

## 4. Coverage: which of our workloads could even run there

| QM workload | Runs on Tensor.Art TAMS? | Notes |
|---|---|---|
| T2I (Qwen-Image / Flux Klein 4B) | **Possibly** | Needs those exact models/ComfyUI nodes present on the platform; model/license availability unverified. We use Qwen-Image specifically for quality/prompt-adherence. |
| I2I edit (Qwen-Image-Edit) | **Possibly** | Same caveat. |
| Wan2 14B FP8 i2v (our tuned Lightning profile) | **Yes on the platform (tested via the web UI)** | `wan2.2_i2v_low_noise_14B_fp8_scaled`, 8 steps, CFG 1, 5 s @ 16 fps works, 30 credits. Whether TAMS **API** exposes video jobs is still unverified. We lose control of our tuned sampler profile and seeds (memory `qm-wan2-lightning-inference-profile-and-seeds`). |
| TTS (Kokoro/Qwen3-TTS, voice clone) | **No** | Not an image-diffusion workflow. |
| BGM / SFX (ACE-Step, MMAudio) | **No** | Audio. |
| Whisper caption, ffmpeg merge/concat/normalize | **No** | CPU/ffmpeg + Whisper; not diffusion nodes. |
| DreamX SR upscale, Real-ESRGAN | **Unverified** | Upscalers exist in ComfyUI, but our specific model/pipeline would need to exist as nodes. |
| Remotion / Lambda | N/A | Not RunPod. |

**Image gen (~$0.12 of the $0.45 baseline run) and i2v ($0.21) — about 75% of GPU spend — are both
feasible on the platform (§5A).** Audio, Whisper, ffmpeg and post-production are not.

## 5. Cost analysis

### 5.1 What we can and can't compute

- Tensor.Art price: **$0.003 per credit.** The credits **per job** depend on model, resolution,
  steps and GPU time, and I could not find a published per-model rate card (the API-doc pages were
  inaccessible and the FAQ gives only the unit price). `workflow/params/check` returns an estimate
  per job, so the real number is obtainable in minutes with a test key.
- RunPod today for one Qwen image: ≈ **$0.012/image** (qwen image ≈ $0.12 per 10-frame run).

### 5.2 Break-even

At $0.003/credit, a Tensor.Art image only matches RunPod's ≈ $0.012 if it consumes **≤ ~4 credits**.
Consumer Tensor.Art images typically cost on the order of 1–several credits on consumer models, so
for light SD-class workflows it may be competitive; for Qwen-Image-class models at our resolutions
it is **unknown and could easily exceed 4 credits** [unverified — get a quote via
`params/check`].

### 5.3 Cost structure differences

| | RunPod (today) | Tensor.Art TAMS |
|---|---|---|
| Unit | GPU-seconds, execution only | Credits ($0.003) per job, quoted before run |
| Idle / cold start | Idle free; cold start unbilled | None to us (shared pool) — a genuine plus |
| Failed jobs | Billed for execution time | Not charged |
| Predictability | Runtime-dependent | Pre-quotable per job — a plus |
| Commitments | None | Not documented; no enterprise/volume tier found |
| Hidden risk | Capacity stalls | Peak-hour queue delays; credit price/rate-card can change; no SLA documented |

### 5.4 Cost verdict

Superseded by measured numbers in §5A: **not cheaper** for the models we actually run.

## 5A. Hands-on test results (2026-10-01)

Runs on both platforms with the same prompt (a lighthouse keeper scene) and, where possible, the
same seed/input. Credit price assumed at the TAMS $0.003 (the consumer UI was used for the
Tensor.Art runs, so the API price is **unconfirmed**). RunPod GPU cost uses the repo's flat
$0.00021/s. Output files were saved to `~/Downloads/runpod-test-outputs-2026-10-01/`
(not committed).

### Tensor.Art (web UI)

| Run | Settings | Credits | ≈ USD |
|---|---|---|---|
| Image, SD-class model (knight on beach) | 1176×784 | 0.3 | $0.0009 |
| Image, **Qwen-Image** (keeper) | ~1584×1056 | 9 | $0.027 |
| Video, Wan2.2 i2v (knight) | 1184×768, 5 s, 16 fps, 81 frames, 8 steps, CFG 1 | 30 | $0.09 |
| Video, Wan2.2 i2v (keeper) | same | 30 | $0.09 |

The video price was flat at 30 credits per 5 s clip. Video generation was noted by the operator as
slow (the time was not measured). The first image test used a cheap SD-class model, so its price
must **not** be read as the Qwen price.

### RunPod (our production endpoints, live)

**Qwen-Image** (`qwen-image-gen`, seed 3617914767, 1536×1024), three jobs:

| Run | Result |
|---|---|
| default (no overrides) | OK |
| `num_inference_steps=4`, `true_cfg_scale=1.0` | **Byte-identical to default** (same md5) |
| 8 steps, CFG 1 | OK, near-identical look |

Finding: **production `qwen-image-gen` already runs the Lightning 4-step, CFG 1 configuration.**
There is nothing to "switch to CFG 1". Timing was **not usable**: all three jobs reported
`cold_start` and took 150–190 s including model load. A warm re-run is needed for a per-image cost.

**Wan2.2 i2v** (`wan2-i2v`), Tensor.Art's keeper image as input, same prompt, 5 s, seed fixed:

| Run | Result | GPU time | ≈ USD |
|---|---|---|---|
| 480p, 4 steps (production setting) | OK, 768×512 | 88 s | $0.019 |
| 480p, 8 steps | OK, 768×512 | 148 s | $0.031 |
| 720p, 8 steps | **CUDA out of memory** on the 48 GB card | — | — |

(These runs also hit a ~270 s worker cold start in queue delay, which is not billed on RunPod.)

### CFG: nothing to change on our side

Our Wan2.2 worker (`model_server.py`, `_lightning_generate`) makes **one conditional pass per step
and skips the unconditional branch** (`enable_cfg=false`); its `guide_scale=3.5/3.5` is passed for
call-site parity and is **unused**. That is the same regime as Tensor.Art's "CFG 1", so CFG does not
explain any quality difference. What *does* differ: steps (4 vs 8), resolution (480p vs ~768p),
and a single `low_noise` DiT named in their settings vs our high+low pair.

### Quality comparison (same input image, same prompt)

- **RunPod 480p clips:** more dramatic — stronger waves/spray, visible rain, bigger push-in. Also
  more drift: the keeper walks toward camera and turns **fully into profile**; in the 8-step clip a
  wave spray covers the lighthouse. 8 steps was **not clearly better** than 4.
- **Tensor.Art clip:** calmer, more stable, higher resolution; subject, lantern and lighthouse stay
  consistent. Also over-turns (whole body, not "head slightly").
- Across all three the face holds. The prompt should say "head only, body stays facing camera".

### Cost comparison

| Step | Tensor.Art | RunPod measured | Ratio |
|---|---|---|---|
| Wan2.2 i2v 5 s | $0.09 (1184×768) | $0.019 (4 step) – $0.031 (8 step) at 768×512 | **3–5x** at our native size |
| Same, at equal resolution | $0.09 | est. $0.06–0.09 (extrapolated; **720p OOMs on our card**) | ~1.0–1.5x (estimate) |
| Qwen image | $0.027 | ≈ $0.012 (baseline-run estimate, not re-measured warm) | ~2.3x |

**Per frame (image + video):** Tensor.Art ≈ **$0.117** vs RunPod ≈ **$0.033** at our native 480p —
about **3.5x**. The larger size on Tensor.Art cannot be reproduced on our hardware.

### What the tests changed in this document

1. Video is available on Tensor.Art — the earlier "no video" caveat is removed.
2. The "images could be 13x cheaper" reading was wrong: the 0.3-credit image was a different model;
   Qwen-Image costs 9 credits.
3. Both platforms already run CFG-off/CFG-1 distilled sampling; CFG is not a lever.
4. Tensor.Art's real advantage is **resolution** (we OOM above 480p) and stability — not cost.

### Not yet measured

- Submit-to-done latency on Tensor.Art (reported "took time").
- Whether TAMS **API** exposes video jobs and what credits it charges there.
- Warm per-image RunPod Qwen cost.
- Qwen-Image-Edit on Tensor.Art (not tested).

## 6. Scalability analysis

| Dimension | RunPod | Tensor.Art TAMS |
|---|---|---|
| Throughput ceiling | Pods we set (≈ 33 workers) | **5 QPS** documented (adjustable on request); our *submission* rate is far below this, but see queue point |
| Capacity guarantee | Dedicated pods once running | **None** — "not possible" to get exclusive GPUs; shared queue with peak delays |
| Predictable latency | Yes at fixed pods (except incidents) | No; consumer traffic competes with us |
| Cold start | 2–7 min | Hidden from us (shared warm pool) |
| Scale-up on our own demand | Limited by account cap (40) | Not controllable; platform decides |
| Batch/cohort scheduling | Orchestrator feeds at pod rate | Orchestrator can't know capacity; would have to be purely reactive |
| Callbacks | Webhooks + polling | **Polling only documented**; no webhook documented |
| Output retention | We persist to R2 | Not documented [unverified] — must copy to R2 immediately |

**Scalability verdict:** worse for us, structurally. Our orchestrator's design (continuous
saturation of known, fixed capacity, with stall detection and an "absolute fixed-pod" policy) assumes
dedicated, observable capacity. A shared consumer queue with no SLA recreates exactly the failure mode
of the 2026-09-16 incident (31–91 min queue delays), but with *no* ability to add pods or see health.

## 7. Maintenance analysis

**Easier**
- No images to build, no workers to recycle, no `diffusers`/`huggingface_hub` drift bugs on the covered
  slice; no GPU ops for those steps.
- Credit pre-quote per job simplifies per-project cost attribution for image steps.

**Harder / new**
- **Vendor lock-in to a consumer platform's workflow/model catalogue.** Models and nodes can be
  removed, renamed or re-licensed by creators/the platform.
- **Reproducibility:** our Wan2/Qwen behaviour is pinned (inference profile, seeds, FP8, no-offload).
  A shared platform gives no control over versions of nodes/models.
- **Polling-only integration** → more orchestrator load and no push notifications.
- **Compliance/legal:** licence and ToS uncertainty. Commercial use of output depends on both the
  platform terms and each model's/LoRA's licence; the company is Asia-based, with different
  jurisdiction from US/EU. For a commercial video product this needs a read of the actual terms and a
  written confirmation — *the search results only describe consumer tiers*, not API terms.
- **Content moderation is not applied** to API outputs (the FAQ says so), which shifts brand-safety
  checking entirely onto our QA path.
- **Support/SLA:** none documented for API customers.
- **Two-vendor operation** for the long tail (audio, video, post-prod stay on RunPod).

## 8. Migration difficulty

| Layer | Effort | Notes |
|---|---|---|
| Orchestrator client | **Easy–moderate** (≈ 2–4 days) | New provider adapter: signed requests (appid/nonce/timestamp/signature), job create → poll → map result URLs → copy to R2. Same shape as the thin `orchestrator/src/runpod/client.ts` (≈190 lines) abstraction. Replace RunPod `/health`-style stall detection with job-status/timeouts. |
| Models/workflows | **Hard / uncertain** | Must re-express Qwen T2I/I2I as ComfyUI workflow templates using models available on the platform, then re-validate image quality against the QA gates and prompt harness. Qwen-Image / Qwen-Image-Edit availability is unverified. |
| Video, audio, post-prod | **Not migratable** per documentation | Stay on RunPod regardless. |
| Rollback | Easy if done behind a provider switch | Keep RunPod endpoints configured; flip by asset kind. |

"Easy to migrate?" — **No.** The plumbing is easy; the platform simply doesn't host the things that
make up most of our fleet, and the part it could host needs a compatibility and quality re-validation.

## 9. Pros and cons

### Pros of Tensor.Art
1. **Zero GPU ops** for the covered image steps — no containers, no worker recycling.
2. **No idle or cold-start cost/latency visible to us**; failed jobs aren't billed.
3. **Pre-quoted credits per job** (`workflow/params/check`) — easy cost control and attribution.
4. **Simple REST + ComfyUI workflow JSON** — if a workflow already exists in ComfyUI, little glue.
5. **Large model/LoRA library** (consumer SD/Flux-style styles), and our own uploads possible.
6. **Free tier / low entry cost** for experiments (consumer credits are separate from TAMS credits —
   don't assume the free credits apply to the API).
7. **Possible price advantage** for simple image steps, pending a quote.

### Cons of Tensor.Art
1. **Cannot host our models or containers** — not a replacement for RunPod; only a vendor API.
2. **No exclusive/dedicated GPUs**; shared queue with peak delays; no SLA documented.
3. **5 QPS cap**, adjustable only by request.
4. **No TTS, audio, Whisper or ffmpeg support documented** — those pipeline steps stay on RunPod.
   (Image and Wan2.2 video do run there — §5A — but at ~1.3–5x our RunPod cost.)
5. **No webhooks documented**; output retention, job timeout and error semantics undocumented.
6. **Custom node support unknown** — our non-standard pipelines can't be assumed to run.
7. **Licensing/terms risk** for commercial use; model licences vary per model/LoRA; Asia-based
   jurisdiction.
8. **No content moderation of outputs** — extra QA burden.
9. **Publishing "AI Tools" is a public-marketplace concept**; private/protected hosting of our IP is
   not documented.
10. **Reproducibility and version control** are weaker than self-hosted images (our Wan2 profile, FP8
    quantisation and seed discipline).
11. **Doc maturity:** several core API pages are sparse or access-restricted; the integration risk is
    higher than the incumbent vendors'.

### RunPod, for symmetry
*Pros:* full container control (our tuned Wan2/Qwen/audio-pool); cheap GPU-seconds, no idle cost;
operator-controlled capacity; hosts every modality we use; execution-time billing; live-verified.
*Cons:* capacity incidents (2026-09-16); shared account cap; opaque `/health`; manual image rollout;
dependency drift; ops overhead.

## 10. Options

| Option | Cost | Effort | Risk | Verdict |
|---|---|---|---|---|
| A. Stay on RunPod (harden: cap isolation, pinned deps, stall detection) | 1x | low | low | **Default** |
| B. Replace RunPod with Tensor.Art | n/a (can't host most workloads) | — | — | **Not feasible** |
| C. Use TAMS as a **secondary/overflow image + video provider** behind a provider interface | ~1.3–5x on the overflow share only | medium | medium (quality, terms, queue, no SLA) | **Only if the checks below pass**; also the only way to get >480p video, since our 48 GB card OOMs at 720p |
| D. Replicate (see companion doc) for overflow/custom models | 4–8x GPU | medium–high | medium | Better fit than Tensor.Art for hosting custom containers |

## 11. What to confirm before any pilot (cheap, a day)

1. Get a TAMS key and run `workflow/params/check` on a Qwen-Image-style workflow → **real credits per
   image**, compare with ≈ $0.012.
2. Confirm **which models exist**: Qwen-Image, Qwen-Image-Edit, Flux Klein 4B, Wan2 14B — and their
   licences for commercial output.
3. Ask Tensor.Art sales/support in writing: **API commercial terms, SLA, dedicated capacity, rate-limit
   raise above 5 QPS, output retention, webhooks, private AI Tools, custom nodes, video/audio endpoints.**
4. Measure **queue latency** at peak hours over a few days for our 10–100-frame bursts (video was
   reported as slow in the 2026-10-01 test, unmeasured).
5. Confirm the **TAMS API** (not just the web UI) exposes Wan2.2 i2v and its credit price.
6. Run the QA gates / prompt harness on its output; check that the aspect ratios QM needs (e.g. 9:16 at
   464×832) are supported.

If (1)–(3) are not all favourable, close the idea.

## 12. Caveats

- Only Tensor.Art's public docs and third-party summaries were available. The API-doc pages were
  access-blocked and several TAMS pages were summarised with large gaps. **Everything marked
  [unverified] could change the conclusion** — but the central finding (no BYO container / no
  dedicated GPU) is stated in their own FAQ ("Currently, it is not possible" to get exclusive GPU
  resources) and is consistent with every page I could read.
- The credit-per-job number is unknown, so no definitive cost comparison is claimed.
- RunPod per-frame figures are from one 10-frame baseline run (2026-09-18).

## Sources

- TAMS home — https://tams.tensor.art/
- TAMS docs: Introduction — https://tams-docs.tensor.art/docs/api/intro/
- TAMS docs: Integration FAQ — https://tams-docs.tensor.art/docs/api/guide/integration-faq/
- TAMS docs: Workflow — https://tams-docs.tensor.art/docs/use-cases/workflow/
- TAMS docs: Workflow Template — https://tams-docs.tensor.art/docs/use-cases/workflow/workflow_template/
- Official ComfyUI node pack — https://github.com/Tensor-Art/ComfyUI_TENSOR_ART
- Third-party reviews of plans/commercial-use terms — https://www.tooljunction.io/ai-tools/tensor-art ,
  https://book.st-hakky.com/en/data-science/tensor-art-commercial-use-guide
- Repo: `src/shared/fleet.ts`, `src/shared/gpuPricing.ts`, `orchestrator/src/runpod/*`;
  baseline memory `qm-full-project-run-baseline-20260918`;
  companion doc `docs/replicate-vs-runpod-hosting-analysis-2026-10-01.md`
