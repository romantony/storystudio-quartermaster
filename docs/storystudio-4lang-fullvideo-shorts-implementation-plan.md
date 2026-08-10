# `fourLangFullVideo` — Implementation Plan

**Audience:** Quartermaster engineers (this repo) + StoryStudio backend/Convex owners + the
`storystudio-unified` (`e2e-finalize` Fargate task) and `longtoshort` (shorts-longform RunPod
worker) owners.

**Responds to:** `storystudio-open-agent/docs/quartermaster-multilang-video-shorts-request.md`
(StoryStudio's distribution team asking for full localized video packages — muxed video,
title/description/tags, thumbnail, per-language Shorts — for es/pt-BR/hi, building on the
audio-only `fourLang` that's live today).

**Status:** Not started. `fourLang` (translate → localized TTS → localized SRT, audio-only) is
**live** on both `E2E-VideoGenerationPipeline-Narration-Basic-QM-New` and
`-Narration-Premium-QM-New` (`docs/storystudio-4lang-integration.md`) — this plan is the next
increment on top of it, gated behind a new `fourLangFullVideo` flag exactly as the request asks.

**Companion docs:** `docs/storystudio-4lang-integration.md` (what exists today — read this
first), `docs/storystudio-qm-new-sfn-trigger.md` (base QM-New contract), `docs/qm-implementation-plan.md`
(overall QM architecture).

---

## 1. The one finding that shapes this whole plan

The request document frames `fourLangFullVideo` as "mux the dub into the existing video, same
as today's audio-only `fourLang` plus a render step." Having read `infra/lib/pipeline-stack.ts`
end to end, that framing undersells the real risk. Two facts about how QM-New actually builds
the English video change the shape of the work:

1. **English narration is baked into the video per frame, not overlaid at the end.** Each
   frame's `merge`/`pipeline` QM call (`qmFrameAssetsMap` / `qmPremiumFrameAssetsMap`) muxes
   that frame's Kokoro/Qwen TTS audio directly onto that frame's animated clip
   (`video.narrationBasic.merge` / `.pipeline`, `video.narrationPremium.merge`) **before**
   concat. `ConcatenateVideos` (`E2E-video-concat-premium`) then produces a video that already
   has English narration burned in, plus (separately) `concatenatedVideo.audioUrl` — an
   audio-only extraction of that same English track, used for Whisper SRT and re-fed into
   `FinalizeVideoBasic`/`Premium` alongside `bgmUrl`. The Fargate `e2e-finalize` task therefore
   already does a "strip the video's baked audio, remix `voiceAudioUrl` + `bgmUrl`, burn
   captions" operation — **which is exactly the primitive per-language dubbing needs.** Good
   news: no new BGM-isolation work is required (answers request §4.1's first half) —
   `bgmResult.cdnUrl` is already an independent, language-agnostic stem, never baked together
   with narration before finalize.
2. **But every frame's clip length is locked to the English narration's spoken duration**
   (`NormalizeRealDuration` / Wan2's `duration_s` — both driven by the English TTS call's
   `durationS`). The video's total length is therefore fixed to the English track's length.
   `fourLang`'s localized TTS is a **whole-script** synthesis (not per-frame) with its own
   total duration — Spanish and Portuguese narration is typically 15–30% longer than the
   English source for the same meaning; Hindi varies. Muxing a longer localized audio track
   onto a video sized for the shorter English track means either the audio gets truncated to
   the video's length, or video and audio drift out of sync for whichever portion overhangs.
   **The request document doesn't ask about this at all — it's a bigger risk than any of the
   5 questions it does ask, and needs a decision before `fourLangFullVideo` can ship.** See §3
   below for the proposed fix (frame-hold padding) and why it's the cheapest option that
   doesn't require re-rendering any visuals.

Everything else in this plan is comparatively mechanical plumbing on top of what's already
built (`localizationStates`, `bgmStates`, `shortsTriggerStates`, the Fargate finalize task, the
Remotion text-overlay Lambda).

---

## 2. What already exists (reuse, don't rebuild)

| Piece | Where | What it gives `fourLangFullVideo` for free |
|---|---|---|
| Per-language translate → TTS → SRT | `localizationStates()`, `pipeline-stack.ts:590` | `localizedAssets[].scriptText/voiceoverUrl/srtUrl` for es/pt-BR/hi — exactly the inputs a per-language finalize needs. Already parallel (`MaxConcurrency: 3`), already per-language-failure-isolated (`LocalizationFailedForLanguage`, mirrors request §4.5's ask). |
| BGM as an independent stem | `bgmStates()`, `pipeline-stack.ts:509` + `bgmResult.cdnUrl` | Language-agnostic — the same track reused for all 4 videos (English + 3 dubs), no re-generation. |
| Strip-and-remix video finalize | `FinalizeVideoBasic`/`Premium` → Fargate task `e2e-finalize` | The exact video+audio+bgm+captions mux operation `fourLangFullVideo` needs, just not yet callable per-language or with a language-suffixed output key (see WS-3). |
| Fire-and-forget Shorts trigger | `shortsTriggerStates()` / `src/handlers/shorts-trigger.ts` | `TriggerShortsFromLongForm` already posts `videoUrl` + `srtUrl` + `bgmUrl` (+ passthrough `shortsOptions`) to the `shorts-longform` RunPod worker and lets its own webhook report completion — same call shape works per-language once each language has a `videoUrl`/`srtUrl`. |
| Per-frame text-overlay compositing | `textOverlayStates()` + `QM-remotion-overlay` Lambda | Proven pattern for "swap text onto an existing visual" — directly applicable to request §4.3's thumbnail text-swap option (see §4.3 below). |
| Translation via QM's LLM rung | `TranslateScript` state, `llm.narration.translate` (Anthropic) | The pattern (not the content) for a new `localizeMetadata` operation (§4.2). |

**What's genuinely new:** a per-language finalize fan-out, a metadata-localization LLM call, a
thumbnail-localization step, per-language Shorts triggering, and the frame-hold padding fix in
`e2e-finalize` — none of which exist today.

---

## 3. Resolving the request's 5 open questions

### 3.1 BGM handling (request §4.1)
Already answered by §1: BGM is a separate stem today, no isolation work needed. **New
sub-question this plan surfaces:** how does `e2e-finalize` handle `voiceAudioUrl` longer than
`videoUrl`? Two options, ranked:
- **(Recommended) Frame-hold padding.** If localized audio duration > video duration, extend
  the video by freezing its last frame (`ffmpeg tpad`) for the difference before muxing. Cheap
  (no re-render of any frame), visually inert (a held final frame reads fine for a few extra
  seconds of narration), and reuses `e2e-finalize`'s existing ffmpeg step — this is a small
  patch to that Fargate task, not a new pipeline. Requires a decision + change in
  `storystudio-unified`'s `e2e-finalize` source (this repo doesn't own it).
- **(Rejected for v1) Re-render per-frame durations per language.** Technically the "correct"
  fix (each frame gets its own localized-length clip) but re-runs the entire per-frame
  image→TTS→animate/i2v→merge pipeline 3x per project — the same cost as 3 additional full
  video generations, defeating the "just mux" premise of this whole feature and `fourLangFullVideo`'s
  stated goal of controlling cost explicitly (request §3.1). Worth revisiting only if frame-hold
  padding looks bad in practice.

### 3.2 Title/description quality (request §4.2)
Recommend SEO-aware, non-literal localization — same "meaning-preserving, not word-for-word"
posture `TranslateScript` already uses for narration script translation, extended with an
explicit "write this as if optimizing for {language} YouTube search, not as a translation of
the English title" instruction. Implementation: a new `operation: 'localizeMetadata'` under
`llm.narration` (same Anthropic rung `TranslateScript` uses), one call per language, input =
the English `videoTitle`/`videoDescription`/`videoTags` **that StoryStudio must supply** — see
§5, QM-New does not generate English metadata itself today (confirmed: no `videoTitle`/
`videoDescription`/`videoTags` field appears anywhere in `pipeline-stack.ts` — that's produced
outside QM, in Convex/StoryStudio). This is a scope point the request document doesn't
surface: **QM can localize metadata but cannot originate it** — StoryStudio needs to pass the
English triplet into `StartExecution` for this to work at all.

### 3.3 Thumbnail approach (request §4.3)
Same scope point as above compounds here: **QM doesn't generate the English thumbnail today
either** (no thumbnail generation state exists in `pipeline-stack.ts`). Two sub-decisions,
both blocked on StoryStudio clarifying how the English thumbnail is actually produced today:
- If it's a StoryStudio-side Remotion/Canva/Convex composition QM never sees → localizing it is
  StoryStudio's job (translate the on-screen text, re-run their own composition 3x), not QM's —
  update the request's scope accordingly.
- If QM should own it going forward → recommend the **text-swap** option (request §4.3's first
  choice, "fast, risk of visually-off translated text"), built as a still-image sibling of the
  already-proven `RenderTextOverlay`/`QM-remotion-overlay` Lambda (a new Remotion composition,
  e.g. `ThumbnailOverlay`, reusing the same Lambda/serve-URL infrastructure) rather than a
  fresh from-scratch localized generation pass — cheaper, and the visual-risk downside is the
  same class of risk `RenderTextOverlay` already ships with for frame overlays today, so it's
  not new risk surface, just more of the same one. **Needs a QA/preview step before return**,
  per the request's own question — recommend the same non-fatal passthrough failure policy
  `RenderTextOverlay` uses (bad overlay → fall back to the un-overlaid base image) rather than
  blocking the whole language's package on it.

### 3.4 Latency/cost (request §4.4)
Rough estimate, additive to today's `fourLang` (already ~1–2 min, per
`storystudio-4lang-integration.md` §5):
- Per-language finalize (Fargate, reused task): comparable to the English finalize's own wall
  time (Basic: minutes; Premium's 1080p upscale: longer) — ×3 languages, but **parallel** with
  each other (independent Fargate tasks) and already parallel with nothing else blocking (runs
  after `localizedAssets` is ready).
- Per-language metadata localization: 3 more small Anthropic LLM calls (seconds each, parallel).
- Per-language thumbnail: 3 more Remotion renders if QM owns thumbnails (§3.3) — same order of
  magnitude as one `RenderTextOverlay` call (~seconds, per that state's `TimeoutSeconds: 180`).
- Per-language Shorts (only when `longFormVideo` + `fourLangFullVideo` both set): 3 more
  `TriggerShortsFromLongForm` calls — these are fire-and-forget (30s Lambda timeout to submit,
  real work happens async on the RunPod worker + its own webhook), so they don't block the SFN,
  but do add real GPU/API load ×3 on the shorts-longform worker and whatever LLM it uses for
  hook selection.
- Net: `fourLangFullVideo` roughly triples the "back half" of the pipeline's compute (finalize
  + metadata + thumbnail + shorts), done in parallel across languages, on top of the ~1–2 min
  `fourLang` already adds. Get a real number from one dev-stack run before quoting StoryStudio
  a hard figure — don't estimate wall-clock minutes without measuring the Fargate finalize
  task's actual duration on a real project first.

### 3.5 Failure granularity (request §4.5)
Already the pattern `localizationStates` uses (`LocalizationFailedForLanguage`, one Map
iteration failing doesn't fail the Map or the project) — extend the same Map (or a sibling Map
keyed on the same 3 languages, see WS-3) so a language whose *finalize* step fails also degrades
to `{ language, failed: true, error: ... }` in the response, independent of the other 2
languages and of the English master video. No new failure-handling design needed, just apply
the existing one further downstream.

---

## 4. New flag: `fourLangFullVideo`

Per the request (§3.1), a new opt-in field, not an overload of `fourLang`:

```json
{ "fourLang": true, "fourLangFullVideo": true }
```

- Requires `fourLang: true` (validate at `StartExecution` time or treat `fourLangFullVideo`
  without `fourLang` as a no-op — StoryStudio's call, document whichever QM implements).
- When set, also runs Shorts per language if `longFormVideo`/`generateShorts` is set — same
  auto-on-above-180s rule as today, evaluated **independently per language's final duration**
  (post frame-hold padding from §3.1, a language's video may be longer than the English one).

---

## 5. Required StoryStudio-side input this plan depends on

Two things QM cannot produce on its own, both need to arrive in `StartExecution`'s input
alongside `fourLangFullVideo: true` (or QM needs to be told explicitly it now owns generating
them — a scope decision, see §3.2/§3.3):

- `videoTitle` / `videoDescription` / `videoTags` (English) — to localize from.
- Whichever thumbnail asset (source image + text layer, or a fully rendered thumbnail) the
  English video already has — to localize from, if QM is doing text-swap (§3.3).

Flag this back to StoryStudio explicitly — the request document phrases these as "the same
metadata triplet the English output already returns at the top level," which is StoryStudio's
own Convex output, not something `E2E-VideoGenerationPipeline-Narration-*-QM-New` currently
produces or has access to.

---

## 6. Workstreams

### WS-1 — `llm.narration.localizeMetadata` catalog rung + SFN states
- `src/catalog/background.json`: new ladder key (Anthropic direct, same as `translate` — likely
  literally the same rung, differentiated by `operation`).
- `pipeline-stack.ts`: extend `localizationStates()`'s per-language iterator (or a parallel
  branch inside the same `LocalizeLanguages` Map) with `LocalizeMetadata` states, gated on
  `fourLangFullVideo` and on English `videoTitle`/`videoDescription`/`videoTags` being present
  in the execution input (§5) — same "guarantee-present-before-`.$`-reference" defaulting
  pattern the rest of this file uses throughout (`NormalizeFourLang`, the voice-field chain,
  `textManifest`) to avoid a `States.Runtime` crash if StoryStudio omits them.

### WS-2 — Frame-hold padding in `e2e-finalize` (cross-repo: `storystudio-unified`)
- Not in this repo. File as a dependency: `e2e-finalize` needs to accept a longer
  `voiceAudioUrl` than `videoUrl` and pad the video (§3.1's recommended fix) instead of
  truncating audio or drifting. Needed before any per-language finalize call is safe to run for
  real (es/pt-BR routinely trip this).
- Also needs a language-aware **output key** — today's `outputKey` is hardcoded to
  `projects/{projectId}/videos/concatenated.mp4` with no language suffix (confirmed at
  `pipeline-stack.ts:2067`/`3173`); 4 parallel finalize calls (en + 3 dubs) writing the same key
  would race/clobber. Needs e.g. `projects/{projectId}/videos/{lang}/final.mp4`.

### WS-3 — Per-language finalize fan-out (this repo, `pipeline-stack.ts`)
- New Map (or extend `LocalizeLanguages`'s existing per-language branch) that, per successfully
  localized language, builds a `finalizeTaskInput` mirroring `PrepareFinalizeBasic`/`Premium`
  but with `voiceAudioUrl` = that language's `voiceoverUrl`, `captionsUrl` = that language's
  `srtUrl`, `bgmUrl` = the same project-level `bgmResult.cdnUrl`, `videoUrl` = the same English
  `mergedVideoUrl` (visuals are language-independent — only the baked-in audio track differs,
  and finalize strips that regardless per §1), plus a `language`/output-key-suffix field for
  WS-2's new contract.
- Gate the whole fan-out on `fourLangFullVideo` (absent/false → today's audio-only behavior,
  zero change — same "gate absent, ladder/behavior unchanged" posture every other optional flag
  in this file uses).
- Runs as a Fargate `ecs:runTask.sync` per language, same as English's own finalize — 3 more
  parallel ECS tasks per project when enabled.

### WS-4 — Per-language Shorts trigger (this repo)
- After WS-3 produces a language's final `videoUrl` (+ its `srtUrl`, + the shared `bgmUrl`),
  call `TriggerShortsFromLongForm` again with that language's assets, gated on
  `fourLangFullVideo && generateShorts` (independently evaluated per language's real final
  duration, per §4).
- Needs a `language` field threaded into `shortsOptions` so the shorts-longform worker's hook
  line/keyword selection runs natively in that language (request §3.3) — **cross-repo
  dependency on `longtoshort`'s worker** (`~/longtoshort/RUNPOD-SHORTS-WORKER.md`): confirm it
  accepts and actually uses a language param in its Claude-based hook-selection prompt before
  relying on this; if it doesn't yet, that's a prerequisite piece of work there, not something
  this repo can guarantee alone.

### WS-5 — Thumbnail localization (only if QM ends up owning it — see §3.3)
- Contingent on the StoryStudio scope clarification in §3.3. If QM owns it: new Remotion
  composition (`ThumbnailOverlay`) + Lambda invoke state, modeled directly on
  `textOverlayStates()`'s `RenderTextOverlay`/passthrough-failure pattern.

### WS-6 — Response shape + docs
- Extend `localizedAssets[]` (or whatever the Map's `ResultPath` produces) with `videoUrl`,
  `videoTitle`, `videoDescription`, `videoTags`, `thumbnailUrl`, `shorts[]` per language, per
  the request's §3.2/§3.3 shape.
- Update `docs/storystudio-4lang-integration.md` (or split a new `storystudio-4lang-fullvideo-integration.md`
  contract doc off it) with the new field, the new response shape, and the per-language failure
  shape from §3.5.

---

## 7. Rollout phases

1. **WS-2 first, standalone.** Get frame-hold padding + language-suffixed output keys landed
   and tested in `e2e-finalize` before anything in this repo depends on it — this is the
   riskiest, most load-bearing piece and the one the request document didn't know to ask about.
2. **WS-3 + WS-1**, behind `fourLangFullVideo`, no Shorts/thumbnail yet. Validate one real
   project (Basic tier first, cheaper) end-to-end: 3 dubbed videos + 3 localized metadata sets,
   correct audio/video sync (no truncation, no drift) after WS-2's padding fix.
3. **WS-4** (Shorts), once WS-3 is trusted and the `longtoshort` language-param dependency is
   confirmed.
4. **WS-5** (thumbnails), only after the §3.3 scope question is answered — may turn out to be
   entirely StoryStudio-side and not land in this repo at all.
5. **WS-6** docs, updated incrementally alongside each phase rather than saved for the end.

## 8. Verification
- `npm run build` (tsc) for any `src/` catalog/type changes (WS-1).
- `npx cdk synth` (`npm run synth`) after `pipeline-stack.ts` changes (WS-1/3/4) — confirms the
  new ASL states synthesize and the state machine JSON stays under Step Functions' size limits
  (this file already runs close to that ceiling in a few places — watch for it).
- Manual dev-stack run: one Basic-tier project with `fourLang: true, fourLangFullVideo: true`,
  no Shorts — confirm all 3 language finalize tasks complete, output keys don't collide (WS-2),
  and the longest-language video (typically es or pt-BR) has no truncated/cut-off narration.
- Repeat with `generateShorts: true` once WS-4 lands — confirm 4 independent Shorts sets
  (en + 3 langs) all land via their respective webhooks.
- Per-language failure test: force one language's finalize to fail (bad `voiceAudioUrl`) and
  confirm the other two languages + the English master still complete (§3.5).
