# Dialogue Premium session — 2026-08-17

**Status:** in progress, continuing tomorrow.
**Trigger:** shipping the `kind:"narration"` shot addendum (commit `0f093a8`) surfaced the first real
dialogue-premium project ever to include a narration shot — a real 132→163-shot execution
(`js7ds9brcb40gta4wsw9n2m94x8cm25e`, later regenerated as `js7ds9brcb40gta4wsw9n2m94x8cm25e` job
`e2e_job_1786947172373_sc0cphuvp`) that kept failing, revealing a chain of previously-undiscovered
real bugs. Fixed one at a time, live-verified against real traffic (not synthetic tests alone), each
one uncovering the next.

## Commits (chronological)

| Commit | What |
|---|---|
| `0f093a8` | New `kind:"narration"` shot on dialogue-premium — narrator VO over a silent Wan2 visual, no lip sync. |
| `d7c2125` | 256KB shots-manifest ceiling (Distributed Map + S3 ItemReader) + pre-existing shot-identity-wipe bug + switched Wan2 i2v to Replicate + admission math. |
| `216a5fa` | Two more real-execution bugs: exec-input fields (`projectId`/`userId`/etc) getting wiped the same way shot fields were; `DropFrameData`'s `localizedAssets` allowlist crashed (ordering bug). |
| `822ed57` | Shot Map `MaxConcurrency` 12→3 — RunComfy was dropping ~1 in 4 shots to an 850s timeout under load. |
| `48fab75` | **Root fix**: external providers' (Replicate/RunComfy/KIE) ephemeral output URLs are now re-hosted to QM's own S3 (`qm-merge-output`) before a job is marked COMPLETE. |

All pushed through `d7c2125`. **`216a5fa`, `822ed57`, `48fab75` are committed but not yet pushed** —
push before/at the start of tomorrow's session if nothing else needs to change first.

## What's fixed and proven (each verified live against real infra, not just synthetic tests)

1. **256KB shots-manifest ceiling** — `FetchShotsManifest` now mirrors the manifest to S3 instead of
   returning it inline; the shot Map gained a Distributed-Map/S3-ItemReader variant
   (`GenerateShotsFromS3`) alongside the untouched inline `GenerateShots`, sharing the same ~40-state
   per-shot routing body. Needed a narrowly-scoped IAM grant directly on `E2E-StepFunction-Role`
   (`states:Start/Describe/StopExecution` + `iam:PassRole`) — the one exception to this codebase's
   usual resource-side-only grant convention, since Distributed Map's child-execution model has no
   resource-policy equivalent.
2. **Shot-identity wipe** — several `Type:'Pass'` states used bare `Parameters` with no `ResultPath`,
   which ASL defaults to `ResultPath:'$'` (whole-state replace, not merge) — silently discarding
   `shotId`/`shotNumber`/`sfxPrompt`/`tailBeatSeconds`/`textManifest` mid-pipeline. Pre-existing since
   this pipeline was built; never caught before because no execution had gotten far enough to hit it.
   Fixed by mirroring dialogue-basic's own proven `BuildSceneResult` pattern (normalize optional
   fields once, explicitly carry every needed field through every Pass state).
3. **Exec-input fields wiped too** — the Distributed Map's `ItemSelector` fix initially converted
   `$$.Execution.Input.projectId/userId/aspectRatio/...` to plain `$.X`, which then fell victim to the
   SAME Pass-state wipe as #2. Fixed by leaving `$$.Execution.Input.X` completely unrewritten — it's
   an immutable snapshot of the child execution's own input, valid for its whole lifetime regardless
   of any `$`-mutation, so it never needed rewriting.
4. **`localizedAssets` ordering bug** — `DropFrameData`'s allowlist referenced `$.localizedAssets`
   unconditionally, same bug class as `generateShorts`/`shortsOptions` (already guarded) but never
   itself guarded. Dialogue Premium runs `DropFrameData` *before* `SetNoLocalizedAssets` (unlike other
   tiers, which run it after) — fixed with the same Normalize/Default Pass-state pattern.
5. **RunComfy `MaxConcurrency` 12→3** — matches dialogue-basic's own already-proven-safe RunComfy
   concurrency. **Did not actually reduce the real-execution failure rate** (see Open Items) — kept
   anyway since it's evidence-based and not harmful, but the real bottleneck is elsewhere.
6. **External-provider URL persistence (the big one)** — QM had *never*, anywhere in the system,
   re-hosted a provider's output to permanent storage; `executor.ts`/`webhook.ts` just stored whatever
   URL the provider returned. Replicate's `replicate.delivery` links expire — confirmed live: 103 of
   122 "successfully" generated shots from one real run were already dead (HTTP 404) within a few
   hours, before concat ever read them. New `src/shared/persistExternalAsset.ts`: no-op for internal
   rungs (self-hosted RunPod/Lambda, which already persist their own output), downloads+re-uploads to
   `qm-merge-output` for everything else, before the job is ever marked COMPLETE. Wired into both real
   completion paths (`executor.ts` sync, `webhook.ts` async-external). Live-verified: a real Replicate
   i2v call now returns a permanent S3 URL (confirmed genuine 81KB MP4), a real self-hosted call is
   confirmed unaffected.

## Real-world proof

A real 163-shot project (job `e2e_job_1786947172373_sc0cphuvp`) was run twice today after fixes #1–4:
- First run: all 163 shots reached the Map-orchestration "succeeded" state; 41/163 were actually
  silent `ShotFailed` degradations (850s timeout — 32 on `video:monologue`/RunComfy, 8 on `image:i2i`).
  Progressed all the way to `ConcatenateShots`, further than any dialogue-premium execution ever had —
  then failed on a dead Replicate URL (motivated fix #6).
- Second run (after fix #5, `MaxConcurrency:3`): **identical 41/163 failure count** — concurrency
  wasn't the real lever. Also failed at concat on the same Replicate-expiry issue (motivated fix #6,
  built after this run).
- Fix #6 was verified via a standalone real Replicate call (not a full project re-run, to avoid
  burning another ~3.5 hours of real GPU time) — see commit `48fab75`'s message for the exact proof.

**Not yet done**: a fresh full-project run combining fixes #5 and #6 together, to see whether the
persistence fix alone is enough to get a complete video through, or whether the RunComfy failure rate
still needs its own fix first.

## Open items — pick up here tomorrow

1. **RunComfy's real bottleneck is still unsolved.** `MaxConcurrency:3` didn't reduce the 41/163
   failure rate at all — same exact count as at `MaxConcurrency:12`. This is a real signal the
   constraint may be **account-wide** (shared across every concurrent execution on the RunComfy
   account, not just this one project's own dispatch), not per-execution. RunComfy has no documented
   capacity limit anywhere in this codebase (flagged as an open gap since the original handoff doc).
   User pointed at `https://mcp.runcomfy.com/mcp` as a way to get real account data — **this MCP
   server has not been added yet** (401 Unauthorized on a plain fetch, needs `claude mcp add
   --transport http runcomfy https://mcp.runcomfy.com/mcp` then `claude mcp login runcomfy` — was
   about to do this when the session paused; needs explicit go-ahead, since adding an MCP server is a
   persistent config change).
2. **`qm-generate.ts`'s 850s blocking-poll ceiling** is itself a contributor, separate from raw
   RunComfy congestion — confirmed live via RunComfy's own dashboard that some "timed out" jobs had
   actually completed, just after QM gave up waiting. Options discussed but not built: raise the
   ceiling, or move RunComfy completions to webhook-based (like RunPod's own slow-InfiniteTalk route
   already does) instead of blocking-poll.
3. **Per-kind concurrency split** — `MaxConcurrency:3` currently throttles the whole shot Map (action/
   narration shots too, even though they don't touch RunComfy at all). A real fix would split
   monologue/dialogue into their own lower-concurrency path while action/narration keep higher
   throughput — bigger architectural change, not attempted this session.
4. **The 180s vs ~15min mismatch** — this specific project's shots manifest sums to ~15 minutes of
   content, not the intended 180 seconds. Confirmed this is entirely StoryStudio-side (no target-
   duration field exists anywhere in the wire payload QM receives) — needs to be raised with whoever
   owns StoryStudio's Layer 1/2 script-generation logic, not fixable from QM.
5. **Full combined verification** — once RunComfy's real bottleneck is better understood (or at least
   accepted as-is), run the real project through one more time end-to-end with fixes #1–6 all in place
   to confirm a complete, playable video actually comes out the other end.

## Reference

- Real execution ARNs (state machine `E2E-VideoGenerationPipeline-Dialogue-Premium-QM-New`):
  - `js75vdgd4prhaa6ensx1rqwhh98ckf30-e2e_job_1786895909468_rshd0uzmp` — first real narration-shot
    project, hit the 256KB ceiling.
  - `e2e_job_1786947172373_sc0cphuvp-retry1` / `-retry2-maxconc3` — the two full 163-shot runs
    described above.
- Memory (this assistant's persistent notes, for continuity across sessions):
  `qm-dialogue-premium-narration-shot-kind.md`,
  `qm-dialogue-premium-manifest-shotidentity-replicate-20260817.md`,
  `qm-external-asset-persistence-fix-20260817.md`,
  `qm-cdk-diff-no-changes-wrong-lambda-gotcha.md`.
