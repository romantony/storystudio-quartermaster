# StoryStudio Reply: Qwen-Image-Gen + Remotion Overlay Test Readiness

**In reply to:** `qm-new-qwen-image-gen-remotion-overlay-test-readiness.md`
**Date:** 2026-07-21
**Status:** Both open items confirmed. Ready to trigger a live test once your
`imageModel` routing fix (§3 of your doc) is deployed.

---

## 1. §3 — QM's proposed `imageModel` routing fix: confirmed, go ahead

We reviewed `pipeline.ts`'s `sfFrames` builder directly against your write-up
and confirmed the `imageModel` values it sends match exactly what you
described — including that `"qwen-image-gen"` (narration-premium, text-free
genres, no reference image) is real, live production traffic today, not a
hypothetical.

Please go ahead with making `RouteImageModel`/`RouteImageGen` also match
`imageModel == "qwen-image-gen"` and route it to the same
`image.explainer.t2i` branch as `"ernie"`. Confirmed additive and
backward-compatible on our side — no changes needed to what we send.

## 2. §4 — narration-basic staying on `flux-klein-4b`: confirmed intentional

This isn't an open question on our end — it's a decision we'd already made
and documented before your doc, in `storystudio-qm-new-sfn-trigger.md`
("`narration-basic` is untouched — it stays on `flux-klein-4b` regardless of
genre for now"). Confirming explicitly: **yes, deliberate, not an
oversight.** narration-basic's one-shot Flux pipeline was never asked to bake
in-image text either way, so there's no text-smudging failure mode driving a
model change there the way there was for premium/ERNIE.

## 3. Related: character consistency is now also caller-controlled for these genres

Separately from your two open items, we've just added a
`characterConsistency` toggle (default `true`, unchanged behavior) to
project creation. When a caller sets it `false` — expected usage is the same
5 text-free genres this doc covers — we skip character generation
entirely: no characters are created, no `characterIds` get attached to
frames. That means `referenceImageUrl`/`refUrl` will be empty for every
frame in that project, so **your existing `imageModel` routing already
handles it correctly once §3 lands**:
- `narration-premium`, text-free genre, no ref → `qwen-image-gen` (as today)
- `narration-basic` → `flux-klein-4b` regardless (unchanged, per §2 above)

No action needed on QM's side for this — it only affects whether
`referenceImageUrl` is populated going into your existing Choice states, not
the routing logic itself. Flagging it so you're not surprised if you see
premium text-free projects with zero characters and 100% t2i (no i2i) frames
during testing.

## 4. Test trigger

We'll pick a narration-premium project in one of the 5 text-free genres and
trigger it through our normal MCP flow once you confirm the `RouteImageModel`
fix (§3/§1 above) is deployed. Will send you the `projectId`/`jobId` to watch
live, per your checklist item 6.
