# StoryStudio → QM Dialogue Basic & Dialogue Premium — Implementation & Integration Guide

**Audience:** StoryStudio backend (Convex / MCP batch pipeline)
**Subject:** The two new Quartermaster-gated dialogue pipelines —
`E2E-VideoGenerationPipeline-Dialogue-Basic-QM-New` and
`E2E-VideoGenerationPipeline-Dialogue-Premium-QM-New` — confirms the wire contract is built
exactly as specified, gives the real ARNs, and documents everything QM decided on its own side
(provider choices, cost routing, where compositing lives) that doesn't change what StoryStudio
sends but is worth knowing when debugging a real run.
**Status (2026-08-09): DEPLOYED.** Both state machines, all supporting Lambdas, and the new
`qm-dialogue-mix` Fargate task are live in the account (`QMPipelineStack` + the required
`QMApiStack` cascade for the RunComfy secret). Both InfiniteTalk providers (RunComfy and
RunPod) have been live-validated end-to-end with a **real TTS-generated voice clip**, not just a
synthetic tone — confirmed genuine dynamic lip-sync on both. **No real Dialogue Basic or
Dialogue Premium project has been run through either state machine yet** — that's the next
step, and it's on StoryStudio's side (`StartExecution`, watch it through). See §7 for exactly
what live-validation has and hasn't covered.
**Companion doc:** `storystudio-unified/docs/quartermaster/storystudio-dialogue-qm-sfn-handoff.md`
— the original design/wire-contract doc StoryStudio wrote and QM implemented against. **This
doc does not repeat that one's field-by-field payload documentation** — read that first for the
full `narrator`/`segments`/`shots`/`dialogueLines` schemas. This doc only covers what changed,
what's confirmed, and what's new since that handoff.
**Modelled on:** `docs/storystudio-qm-new-sfn-trigger.md` (the narration-tier sibling — same
admission handshake, same QM-generate gateway pattern, same status-callback shape).

---

## 1. The big picture

```
                           (unchanged) admission check
StoryStudio  ─────────────────────────────────────────▶  Quartermaster (QM)
  (Convex /   POST {QM}/admission                                  │
   MCP)       {projectType:"dialogue-basic"|"dialogue-premium",    │  dialogue-premium: sizes
               tier, durationSeconds, shotCounts?, userId}         │  Wan2 demand from
     │                                                              ▼  shotCounts, not duration
     │  StartExecution, admissionId threaded through           grants a slot (or defers)
     ▼
E2E-VideoGenerationPipeline-Dialogue-{Basic|Premium}-QM-New   (STANDARD SFN, tags batchjob=true qmGateway=true)
     │
     │  Basic:   Parallel[ narrator branch (persona → per-segment TTS+lipsync),
     │                      scenes branch (per-frame image → Wan2 i2v, silent) ]
     │           → ReconcileSegmentTiming → concat scenes → concat narrator
     │           → PiP composite (qm-dialogue-mix ECS) → SRT → BGM → finalize
     │
     │  Premium: per-shot Map (action→Wan2, monologue/dialogue→InfiniteTalk)
     │           → ambience beds per scene → BGM → concat shots → SRT
     │           → ambience mix (qm-dialogue-mix ECS) → finalize (1080p upscale)
     │
     │  every generation step ──────────────────────────────────▶ POST {QM}/jobs
     ▼                                                              + poll GET /jobs/{id}
  Complete                                                          │  QM owns: provider pick,
                                                                     │  internal→external failover,
                                                                     │  per-endpoint concurrency
```

**Real, deployed state machine ARNs:**

```
arn:aws:states:us-east-1:929075264324:stateMachine:E2E-VideoGenerationPipeline-Dialogue-Basic-QM-New
arn:aws:states:us-east-1:929075264324:stateMachine:E2E-VideoGenerationPipeline-Dialogue-Premium-QM-New
```

Both tagged `batchjob=true`, `qmGateway=true`, same execution role (`E2E-StepFunction-Role`) as
every other QM-New machine. QM API base for reference: `https://dqpan45lenw2j.cloudfront.net`.

---

## 2. Admission — unchanged, confirm `shotCounts` for Premium

`POST {QM}/admission` with `{requestId, projectType, tier, durationSeconds, userId}` works
exactly as documented in `docs/storystudio-qm-admission-gate.md`. Nothing new for Dialogue
Basic. For **Dialogue Premium**, send `shotCounts: {total, monologue, dialogue, action}` in the
same request (per the handoff doc §2/§7.2) — this is now genuinely wired through to the
capacity estimator, not just accepted and ignored:

- If `shotCounts` is present, Wan2 demand is sized from `shotCounts.action` directly.
- If it's omitted, QM falls back to a duration-derived estimate (`duration/5`, the same
  proportion narration-premium uses) — which the handoff doc's own §2 flags as an overestimate
  for a dialogue-dense film. **Sending `shotCounts` is how you avoid that overestimate**, not
  just a nice-to-have.

`admissionId` threads into the execution input exactly as before; release it yourself on
terminal state, same as every other tier.

---

## 3. Wire contract — built exactly as specified, no changes needed

Every payload field documented in the handoff doc's §3 (Dialogue Basic) and §7 (Dialogue
Premium) is implemented as written: `narrator`, `narratorOverlay`, `segments[]`, `frames[]` for
Basic; `shotCounts`, `voiceBank[]`, `shots[]`, `dialogueLines[]` for Premium. **You do not need
to change anything about how you're already constructing these payloads.** Specifically
confirmed:

- **`shotsManifestUrl` fallback (§7.2) is implemented.** `CheckValidation` routes to a
  `RouteShotsSource` Choice: `shots` present → proceed inline; otherwise fetches
  `shotsManifestUrl` (plain HTTPS GET + JSON parse, works against an R2 URL — not routed through
  AWS S3's native integration, since R2 isn't S3) and hydrates `$.shots` before continuing. Send
  whichever one crosses the 256KB threshold first; QM handles both.
- **Every field listed in §3.7 as "NOT sent" is genuinely not read.** No code path references
  `voiceUrls`, `voiceGender`, `fourLang`, etc. for either dialogue tier.
- **`ReconcileSegmentTiming` (§4.5) reads the returned frame-derived duration, never the
  requested integer** — confirmed in code, matches the doc's explicit requirement.
- **The `+1.00s` trailing pad on `fast/multi` is trimmed before concat** (§7.4/§7.6.6) via a
  dedicated `QM-trim-clip` Lambda, using the exact `left_duration + right_duration` target
  known at `BuildTurnTracks` time — not silence-detected.
- **TTS batches per turn, not per line** (§7.4/§7.9.2) — one call joins a speaker's consecutive
  lines, exactly as recommended.

If you're debugging a real execution and something looks like a contract mismatch, it's more
likely a QM-side bug than a StoryStudio-side one — the payload shape itself was not
reinterpreted anywhere.

---

## 4. Where QM's implementation differs from the design doc's *literal recommendation*

These don't change anything you send or receive — they're QM-internal architecture decisions,
documented here so a real-execution debugging session isn't surprised by them.

### 4.1 PiP compositing and ambience-bed mixing are a new QM-owned Fargate task, not inside finalize

The handoff doc recommends (§3.4, §10 open question 3) that the narrator PiP composite (Basic)
and per-scene ambience-bed mixing (Premium) live "inside the existing finalize Fargate task."
That task (`e2e-finalize`) runs on the `storystudio-e2e` cluster and is not part of the
`quartermaster` repo — QM only calls it by ARN. So both landed in a **new QM-owned ECS task,
`qm-dialogue-mix`**, which runs immediately before the unmodified `FinalizeVideoDialogueBasic`/
`FinalizeVideoDialoguePremium` call. This is the doc's own named fallback for exactly this case
(§3.4: "If QM's finalize task cannot take on per-segment compositing, the fallback is a
dedicated... Fargate/Lambda step"). `e2e-finalize` itself required zero changes — it still
receives the same `{videoUrl, voiceAudioUrl, captionsUrl, bgmUrl, targetResolution}` shape it
always has; `voiceAudioUrl` for Premium now points at the ambience-mixed track instead of the
raw concatenated shot audio, which is the only thing that changed from finalize's perspective.

### 4.2 Dialogue Basic's narrator now splits across TWO lip-sync providers, by cost

The handoff doc's original design used RunComfy's `community/infinite-talk/fast` for every
narrator segment. **As of 2026-08-09, that's the short-segment path only.** A follow-up product
decision added cost-based routing: RunComfy bills $0.015/second, while RunPod's legacy
InfiniteTalk endpoint (`api.runpod.ai/v2/infinitetalk/run` — the same one Documentary Premium
already uses) bills a flat $0.25/generation regardless of duration. QM now routes on the
**actual measured TTS duration** (never the planned one):

- `actualDurationSeconds > 15s` → RunPod InfiniteTalk
- otherwise → RunComfy InfiniteTalk (unchanged from the original design)

Since narrator segments are planned at 30-40s, **every real segment takes the RunPod path in
practice** — RunComfy's mono rung stays wired for the rare/theoretical short-segment case
rather than being removed. This is entirely invisible to StoryStudio: same input (`audioUrl`,
`personaImageUrl`), same output shape (`videoUrl`, `durationS` sourced from the TTS call either
way), same downstream PiP composite handling regardless of which provider ran. It's documented
here purely so a resolution/quality difference between two segments in the same render (RunPod's
InfiniteTalk output is a different native resolution than RunComfy's 624×352) doesn't read as a
bug — the PiP composite already normalizes both to the project's canvas dimensions.

### 4.3 RunComfy's narrator/monologue/dialogue calls are poll-only, no webhook

The handoff doc's §4.3 originally described a `>45s` "RunPod webhook" branch for the narrator
lip-sync call. That framing predates the pivot to RunComfy (§10 open question 1 was never
formally resolved in the doc, but the doc's own later live-testing in §7 settled on RunComfy,
not documentary-premium's RunPod-hosted integration, for the *default* short-segment path).
RunComfy has no webhook mechanism of its own — QM's RunComfy calls are plain synchronous poll,
relying on the QM-generate gateway's 850s blocking-poll ceiling, which the doc's own §7.12.1
measurement (~106s server-side for a 26s clip) confirms is comfortable headroom. Nothing for
StoryStudio to do differently; mentioned in case a >45s webhook code path is ever searched for
and not found.

---

## 5. Open questions from the handoff doc (§10) — resolved / still open

| # | Question | Status |
|---|---|---|
| 1 | Reuse documentary-premium's RunPod InfiniteTalk for the narrator? | **Superseded.** RunComfy is the default provider (§4.2 above); RunPod's *same* legacy endpoint documentary-premium uses is now also wired in, but for cost-routing reasons, not code reuse. |
| 2 | RunComfy `fast/multi` audio semantics | Resolved in the doc itself (§7.4/§7.6) — implemented as specified. |
| 3 | Where does the PiP composite live? | **Resolved: new QM-owned Fargate task** (`qm-dialogue-mix`), not inside finalize — see §4.1 above. |
| 4 | Per-line vs per-shot TTS batching | Resolved in the doc itself (§7.9.2) — implemented as specified (per-turn). |
| 5 | RunComfy spend ceiling | **Still open / not implemented.** RunComfy calls are not subject to any spend cap today. Flag if this needs to be built before high-volume Dialogue Premium traffic. |
| 6 | `shotsManifestUrl` fallback | **Resolved: implemented** — see §3 above. |

---

## 6. New QM catalog keys (for debugging a real execution)

| Key | Provider | Notes |
|---|---|---|
| `image.dialogueBasic.persona` | RunPod (Qwen-Image-Gen) → KIE fallback | Narrator persona still, once per project |
| `image.dialogueBasic.t2i` / `.i2i` | RunPod (Qwen) | Scene stills |
| `voice.dialogueBasic.tts` | RunPod (Qwen voice-clone/design) | Per segment |
| `video.dialogueBasic.i2v` | RunPod (Wan2) | Silent scene clips |
| `video.dialogueBasic.narrator` | **RunComfy** | Narrator lip-sync, `actualDurationSeconds <= 15s` only |
| `video.dialogueBasic.narratorRunpod` | **RunPod** | Narrator lip-sync, `actualDurationSeconds > 15s` — the common case |
| `image.dialoguePremium.t2i` / `.i2i` | RunPod (Qwen) | Shot stills |
| `voice.dialoguePremium.tts` | RunPod (Qwen) | Per turn |
| `video.dialoguePremium.i2v` | RunPod (Wan2) | `action` shots |
| `video.dialoguePremium.monologue` | RunComfy (mono) | `monologue` shots |
| `video.dialoguePremium.dialogue` | RunComfy (multi) | `dialogue` shots |
| `sfx.dialoguePremium` | RunPod (ACE-Step) | Spot SFX |
| `bgm.dialoguePremium` | RunPod (ACE-Step) → Suno/KIE | Project BGM + per-scene ambience beds (same rung, `operation:"ambience"`) |

---

## 7. Validation status — what's actually been confirmed live

**Confirmed, with real assets, before deploy:**
- RunComfy mono (`community/infinite-talk/fast`) and multi (`fast/multi`) endpoints, submitted
  through QM's actual production adapter code — a real TTS-generated voice clip (not a
  synthetic tone) produced genuine, verified dynamic lip movement.
- RunPod's legacy InfiniteTalk endpoint, same real-voice test, same result.
- Both durations matched exactly (RunComfy: input audio duration; RunPod: same).

**Confirmed at deploy:**
- Both state machines `CREATE_COMPLETE`, zero failures across all new resources.
- `qm-dialogue-mix:latest` image built and confirmed in ECR; ECS task definition references it.
- The executor Lambda's `RUNCOMFY_API_KEY_ARN` and `WEBHOOK_BASE_URL` both correct post-deploy.

**NOT yet confirmed — this is the actual next step:**
Every item in the handoff doc's §11 validation-gaps list still needs a real execution to
observe, not just a code read:
1. Narrator/scene sync holding at the *end* of a real multi-segment render.
2. Composite audio actually surviving (the doc's named failure mode: a silent MP4 at the right
   duration).
3. fps normalization not producing a stutter/speed-shift artifact on real Wan2 + InfiniteTalk
   media (only synthetic clips have been through the PiP composite so far).
4. The RunComfy `+1.00s` trim on a real multi-shot Premium concat — confirm the pad is gone
   *and* authored pauses (`pauseAfterSeconds`) survive uncrushed.
5. Ambience bed continuity across cuts within a scene on a real multi-scene Premium render.
6. `DropFrameData`'s allowlist — inspect a real execution's state output directly, don't infer
   from a successful completion (the doc's own repeated warning: a dropped field degrades
   silently).

**Recommendation:** start with a small Dialogue Basic project (one or two narrator segments,
few frames) rather than a full 300s render, so any of the above surfaces on the smallest
possible blast radius.

---

## 8. Known gaps (unchanged from the original handoff doc)

- No RunComfy spend-ceiling mechanism (§5 above).
- Premium's `transitionOut` (`DISSOLVE`/`MATCH_CUT`/etc.) is not rendered — v1 concatenates
  every shot as a straight cut regardless of the field's value.
- `narratorOverlay.mode: "cutaway"` and `"split"` are implemented structurally but unvalidated
  — only `"pip"` (the default) matches the doc's own live-tested §7.8 recipe.
