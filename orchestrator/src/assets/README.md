# The asset pipeline — per-asset generator agents

*Built 2026-09-19. Off by default: `ORCH_PIPELINE_MODE=cohort`.*

## Why

The cohort model advances one project through an ordered step graph. Whichever
step is the bottleneck decides the pace, and every endpoint that is not that
step's endpoint sits idle while it runs. A 74-frame project took 33 minutes
that way (`docs/qm-full-project-run-baseline-20260918.md`), most of it with
most of the fleet doing nothing.

This model inverts it. There is no sequence, no cohort and no window. A
project's assets are all written up front; one agent per asset type drains its
own queue across every project at once; and a finished asset releases the next
one by writing into its table. Whenever anything is queued, every endpoint that
can work on something is working on it.

## The model in four sentences

1. A submitted project writes **every asset it needs** as a row in that
   asset's own table.
2. **Each generator agent polls its own table** for rows whose inputs are all
   present, and queues them against its endpoint's own pod limit.
3. **Handoff is by writing the next table**: a completed asset writes its CDN
   url into every downstream asset's row, in the same transaction that marks
   it complete. A row becomes runnable when every url it requires has arrived.
4. **The project compiler** sits above them: it waits on a whole project,
   repairs or reworks what is stuck, and once every asset exists it writes a
   JSON manifest file and arms the tail — one postprod-lite call that does all
   the remaining work and returns the final url.

## The agents

| Agent | Table | Endpoint | Scope | Gate | Produces |
|---|---|---|---|---|---|
| `qwen-image-gen` | `asset_qwen_image_gen` | qwen-image-gen | frame | image | the frame's still (t2i) |
| `qwen-edit` | `asset_qwen_edit` | qwen-image-edit | frame | image | the frame's still (i2i, reference image) |
| `tts` | `asset_tts` | flux-tts-s2t | frame | — | narration audio + its real duration |
| `wan2-i2v` | `asset_wan2_i2v` | wan2-i2v | frame | motion | the frame's silent clip |
| `dreamx-refine` | `asset_dreamx_refine` | DreamX SR-DiT | frame | — | the upscaled clip |
| `mmaudio` | `asset_mmaudio` | MM-Audio | frame | — | the clip with SFX muxed in |
| `remotion` | `asset_remotion` | **AWS Lambda** | frame | — | the clip with on-screen text |
| `bgm` | `asset_bgm` | bgm-s2t | project | — | the project's music bed |
| `postprod-lite` | `asset_postprod_lite` | postprod-lite | project | — | **the finished video** |

`qwen-image-gen`/`qwen-edit` are alternatives chosen by
`options.referenceImage`. `dreamx-refine`, `mmaudio` and `bgm` are opt-in
(`options.upscale` + `upscaleEngine: 'dreamx'`, `options.sfx`, `options.bgm`).

**There is no `animation` agent.** Ken Burns is something postprod-lite does as
part of assembly, not a separate generation: `options.motionEngine: 'animate'`
plans **no motion asset at all** and the tail animates the still. For
narration-basic that reduces the whole per-frame chain to image + TTS.

**`remotion` is the one non-RunPod agent.** `options.textOverlay` plans it, and
it renders on-screen text onto the frame's clip through the existing,
live-tested `QM-remotion-overlay` AWS Lambda — a synchronous invoke, no
run/status/webhook cycle, and the render is re-hosted into R2 before the row
completes (Remotion Lambda writes to its own bucket, whose retention QM does
not control). It sits **before** the tail rather than between merge and concat
as it does in the cohort model, because in this pipeline merge, trim and concat
all happen inside one postprod-lite call: the overlay goes onto the silent clip
and the one-shot merges narration into the already-overlaid result. A frame
with no `textManifest` passes through untouched, so a project where only some
frames carry text does not drop the rest.

## The chain

```
qwen-image-gen ─┐
                ├─► wan2-i2v ─► [dreamx-refine] ─► [mmaudio] ─► [remotion] ─┐
tts ────────────┘                                                          │
                                                                           ▼
bgm ───────────────────────────────────────────────────►  postprod-lite (one call)
                                                                           │
                                                     ┌─────────────────────┘
                                                     ▼
                                                final video url
```

The arrows between per-frame agents are **not** in the code. `plan.ts` stores
only `requires` — for each kind, the kinds whose url it needs — and
`handoffTargets()` reads that backwards. No agent names a successor, which is
why adding a kind is a plan change, not an agent change.

The two **project-scoped** kinds sit outside that mechanism on purpose:

* `bgm` has no per-frame input, so it is runnable from submission and
  generates in parallel with every frame — the track is ready before assembly
  starts instead of adding a cold ACE-Step generation to the critical path.
* `postprod-lite` fans in on every frame at once, which a `sources` map keyed
  by asset kind cannot express. The compiler arms it. That is the division the
  design asks for: **agents own per-frame handoff, the compiler owns the
  project.**

## The tail: one call, one pod, one url

The compiler does *not* call postprod-lite itself. It writes the manifest and
arms the project's own `postprod-lite` row; the postprod-lite agent dispatches
it like any other row. That is what makes **one pod processes one project** an
enforced property rather than a hope — the number of projects assembling at
once is that endpoint's pod count, applied by the same in-flight ceiling every
other agent obeys.

The worker then does everything locally (`postprod-lite/API.md` §10):

```
per frame:  [animate still] -> merge narration (+SFX) -> [remove silence]
project:    concat -> [upscale] -> [burn captions] -> [mix bgm] -> upload
```

Two projects on two pods cannot see each other's assets — every path is a
private temp file and every R2 key is scoped by project and frame.

Each frame's finished clip **is** hosted (`frames[].url` in the response, and
`mergedClipUrl` in the §9.6 callback): it is the project's durable per-frame
artifact, and a rework of one frame starts from it rather than redoing the
project. It is not a step boundary, though — concat reads the local file the
upload came from, so a clip crosses the network once, outbound. That is the
waste the old merge → remove_silence → concat call chain had: three calls
meant uploading and re-downloading every frame's clip twice.

`upscale` is off in every default path: `upscaleEngine: 'dreamx'` upscales each
frame before it ever reaches the tail, so Real-ESRGAN is never loaded and
**Whisper is the only model the worker holds** — needed for the word-level
timings the caption burn is built from. Those timings are taken on the *final
concatenated audio*, the only point at which they are true, since per-frame
silence removal changes every clip's length.

## Schema (migration 013)

One `assets` table, `PARTITION BY LIST (asset_kind)`, with one partition per
agent. A partition is a real table — `asset_wan2_i2v` can be selected, locked
and explained on its own, and an agent's claim only touches its own — while the
column set, the status vocabulary and the constraints are defined once.

Key columns: `required_inputs text[]` (what must arrive), `sources jsonb` (what
has, written by upstreams), `attempts` and `reworks` (two separately bounded
budgets), `frame_id` where `'*'` means project-scoped.

`pipeline_projects` holds the one genuinely project-level thing — is this
project whole yet — plus the compiled plan, the manifest and the tail's
progress. `asset_costs` is `job_costs` for this model (`job_costs.job_id` FKs
to `jobs`, which these rows are not in).

`verify_asset_invariants()` reports, for the watchdog: a *frame-scoped* row
blocked with its inputs already satisfied (a lost handoff), and a completed
project with a non-complete asset.

## What the compiler does

Per live project, per tick:

* **Repair.** Release frame rows whose inputs are all present but never
  flipped. Recreate a (kind, frame) row the plan expects that does not exist,
  seeded with whatever its upstreams already produced.
* **Rework.** A row `submitted` and quiet past its kind's `stuckAfterMs` gets
  its provider job cancelled and is requeued — bounded by `reworks` (max 3)
  *and* by `attempts`, which a rework continues rather than resets. A genuinely
  broken asset cannot resubmit forever.
* **Arm.** Once nothing is missing, stranded, stuck or working — including the
  BGM track — build the manifest, write it to R2, claim the project (a
  conditional UPDATE, so two ticks cannot arm it twice) and arm the tail row.
* **Collect.** On a later tick, a complete tail row finishes the project and
  fires the §9.6 callback; a failed one recompiles and retries within the
  attempts cap.

A permanently failed frame does **not** block assembly — it drops out, is named
in the manifest's `droppedFrames`, and the project finishes `partial`, the same
contract the cohort path has. Fewer than two surviving frames is a `failed`
project, because concat needs two.

## What it reuses

Every payload builder in `steps/builders/` is reused verbatim — they are
already pure `(BuildContext) -> payload` functions carrying hard-won
no-silent-degrade rules. `plan.ts`'s `toResolvedDeps()` is the whole adapter.
Request validation is `agents/planner.ts`'s `validateRequest()`, and the result
document is the same `QmResult` the cohort path emits, so flipping
`ORCH_PIPELINE_MODE` is invisible to StoryStudio — `mergedClipUrl` included,
read back out of the tail's own per-frame report.

## Quality gating

Three kinds are gated: `qwen-image-gen`, `qwen-edit` and `wan2-i2v` — the ones
a human would look at and reject. Everything after them is ffmpeg, which either
works or errors.

**A gated kind's completion does not hand off.** The row goes `complete` with
no verdict, `assets/quality.ts` judges it, and only a passing verdict writes
the handoff. That costs one QA round-trip of latency and buys never spending a
Wan2 job on a rejected still — which is exactly what the 2026-08-15 "missing
kitten" incident was.

### Two tiers

| Tier | Coverage | Needs | Catches |
|---|---|---|---|
| **local** (`quality/local.ts`) | **every** gated asset | ffmpeg. No model, no API, no GPU, no cost. | blank/black frames, **frozen clips**, wrong aspect ratio, truncated files, clips that don't match their narration |
| **VLM** (`quality/rubric.ts`, reused) | a **sampled fraction** | Replicate + a token | whether the picture shows what the prompt asked for |

The local tier is free, so it runs on everything. The VLM call is the only part
that costs money, so it is sampled — and it is the only part that could not run
locally anyway: the VPS has no GPU and the fleet has no self-hosted VLM.

Mechanism for the local tier: ffmpeg decodes a 32x32 thumbnail strip to raw
bytes on stdout and the statistics are computed in process — pixel stddev for
"is this blank", mean inter-frame delta for "does anything move". No log
scraping, no image library, and the maths is a pure function over a Buffer,
which is what the tests exercise. Both tiers produce a 0-10 score; the verdict
is the **worse** of the two, and any P0 is blocking.

### Who pays for a VLM opinion (`quality/sampling.ts`)

`ORCH_ASSET_QA_SAMPLE_RATE` is 0.3 today, heading for 0.1. Three rules:

1. **Explainer and educational products are never sampled.** Their frames are a
   deterministic Remotion composition over a background — there is no diffusion
   sampler to misbehave and nothing a VLM would catch that the local checks
   miss.
2. **Movement and direction raise the odds.** The failures a VLM earns its keep
   on — a character facing the wrong way, an action that doesn't happen, a
   subject duplicated mid-move — cluster in shots that ask for movement.
   Salience comes from the prompt harness's `ShotContract` when there is one
   (`action.motionLevel`, `camera.move`, `screenDirection`, `transformation`
   are exactly the right fields, already structured and validated) and from a
   movement/direction lexicon when there isn't. **That is also the route to the
   lower rate**: the better the contract describes movement, the more
   confidently the rate comes down.
3. Everything else is sampled at the rate.

The weight is applied to the **odds**, not the probability — so `rate` means
what it says (a mixed project averages back to it), `rate = 1` really is
everything, and `rate = 0` disables the VLM tier without touching the local
one. At 0.3 a movement-heavy shot is checked ~52% of the time and a static one
~15%.

The draw is a hash of `(project, frame, kind)`, never `Math.random()`: the same
asset always gets the same decision, so a retry cannot flip it and the sample
is reproducible when you are chasing a bad frame.

### What a rejection does

It patches the **same** row and puts it back in its own agent's queue — same
frame identity, same handoff targets, same pod limit. The correction depends
on what was wrong:

* **structural** (frozen, blank, truncated, wrong duration) → **reseed**. A bad
  sample is not a prompt problem, and rewriting the prompt to fix one is the
  cargo-cult move this project already tested and rejected
  (`docs/qm-video-conformity-prompt-testing.md`).
* **semantic** (what a VLM saw) → **rewrite the prompt** via the existing
  `quality/rewrite.ts`.
* **aspect mismatch** → neither. Regenerating cannot change the render size, so
  it is reported, not looped on.

Bounded by `quality_attempts` (max 4, its own budget — a quality rework does
not consume the provider-failure retry budget). Past the cap the asset is
accepted **flagged**, so a project still delivers and the result says so.

Two deadlock breakers, because a gate that can wedge a project is worse than
no gate: the compiler treats a complete-but-unjudged asset as *not done* (so it
can never reach the manifest), and after 20 minutes it releases it unjudged,
loudly, writing the handoff it was holding.

This does not replace the prompt harness
(`feedback-prompt-harness-over-llm-rework`): the local tier is deterministic
rules applied to output instead of input, and the LLM tier is off by default.

## Fixed pods

Nothing here ever PATCHes `workersMax`. Pod counts are **read** from
`fleet-registry.ts` / `steps/tail-endpoints.ts` and used as the per-endpoint
in-flight ceiling; an admin maintains all eight endpoints on the RunPod
dashboard. The ceiling is per *endpoint*, not per kind, so two kinds sharing an
endpoint share its pods.

## Operating it

```
ORCH_PIPELINE_MODE=assets      # the rollout switch; 'cohort' is the default
ORCH_ASSET_TICK_MS=5000        # how often each agent polls its own table
ORCH_COMPILER_TICK_MS=30000    # how often the compiler sweeps live projects
ORCH_ASSET_QA=full             # full (default) | local | off
ORCH_ASSET_QA_SAMPLE_RATE=0.3  # fraction getting the PAID VLM check; local is 100%
ORCH_ASSET_QA_MOTION_WEIGHT=2.5
ORCH_ASSET_QA_STATIC_WEIGHT=0.4
ORCH_ASSET_QA_TICK_MS=10000
R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY   # lets the compiler write the
                               # manifest as a FILE; without them it falls back
                               # to inline and refuses one over 128KB
```

* `GET /v1/assets` — per-kind queue depth vs pods, and every live project.
  Queued work behind an endpoint with idle pods is the failure this
  architecture exists to prevent, and this is where you see it.
* `GET /v1/assets/:projectId` — every asset row, with `waitingOn` (the inputs a
  row still lacks). The first thing to look at when a project is stuck.

## Worker-side changes this shipped with

In `~/flux4B-Wan2/Flux-klien-4b/postprod-lite/handler.py`:

* **`postprod` mode** — the one-shot above. Local-file cores (`_merge_local`,
  `_concat_local`, `_caption_local`, `_mix_bgm_local`, `_remove_silence_local`,
  `_animate_local`) were extracted from the existing URL-in/URL-out modes, so
  every per-mode call behaves exactly as before and the one-shot composes the
  same ffmpeg, without the uploads.
* **Per-mode model loading** — `load_models()` used to run at handler entry,
  before the mode was read, so a 2.8-second merge waited behind Whisper *and*
  Real-ESRGAN. Now `ensure_whisper()` / `ensure_upscaler()` load on first use.
  In this pipeline only Whisper is ever loaded: frames are upscaled on the
  DreamX endpoint upstream, so the whole-video `upscale` step stays off and
  Real-ESRGAN is never touched.
* `test_postprod.py` covers the one-shot's orchestration with stubs (order,
  drop handling, temp-file cleanup) — no GPU needed.

## Not built yet

* **`remotion` + `mmaudio` together is untested.** The overlay renders over a
  clip that already carries an SFX track, and the manifest then asks the tail
  to lift that track back off it (`sfxFromVideo`). If Remotion drops the audio,
  merge fails loudly rather than degrading silently — but nobody has run it.
* **The prompt harness** runs per cohort today. In this model it belongs at
  submission time, where the asset rows are first written.
* **Local QA thresholds are unmeasured.** `minFrameDelta` (1.0) and
  `minStddev` (4) were chosen from first principles, not from a corpus of real
  Wan2 output. Run a batch of known-good and known-frozen clips through
  `checkVideoLocally` before trusting them — a false FROZEN wastes a GPU job.
* **No TTS gate.** Whisper could check that the narration audio says what the
  script says, which would catch a truncated or garbled read. It would need the
  same kind of local tier as the visual checks.
* **Nothing has run live.** The worker image needs rebuilding and pushing, and
  migration 013 needs applying on the VPS, before any of this executes.
