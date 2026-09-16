# `orchestrator/containers/`

RunPod endpoints the background pipeline drives that aren't already wired for the
live path (spec §5.1). **Nothing is built in this repo** — the workers all live
elsewhere; this directory just pins the contracts the orchestrator codes against.
`remotion` below is the one exception to both of those: it's not RunPod, and its
dispatch code lives in this repo (`src/lambda/client.ts`), not "elsewhere" — see
its row for why.

| Endpoint | Serves | Where the worker lives | Status |
|---|---|---|---|
| `media` | steps 6 merge, 8 concat, 10 upscale, 11 caption, 12 bgm_overlay | `romantony/flux4B-Wan2-storystudio` (same codebase as `flux-tts-s2t` / `bgm-s2t`), deployed with `ENDPOINT_ROLE=all` | contract pinned in `media.md`; deploy + measure pending |
| `remotion` | educational/explainer text overlay (`options.textOverlay`, step 16) | AWS Remotion Lambda (`../src/handlers/remotion-overlay.ts`, `QM-remotion-overlay`) — invoked directly via `src/lambda/client.ts`, not RunPod; output re-hosted into R2 via `src/r2/client.ts` | **wired 2026-09-16**, against StoryStudio's real `storystudio-orchestrator-request-examples.md` §3 sample. Live-tested first (quality clean, ~11-17s/frame, ~$0.0015/frame — negligible, not a cost driver), then implemented: `steps/catalog.ts`'s seq 16 (`source: 'lambda'`, sits between remove-silence (7) and concat (8) in real execution order despite its number — see that entry's comment), `steps/builders/remotion-overlay.ts` (closes StoryStudio's named `background.src` gap by resolving it from step 6/7's output; a frame with no `textManifest` passes its clip through unchanged via a `__passthrough` marker rather than failing — fixed same day after reconciling StoryStudio's doc, since concat's fan-in is all-or-nothing per project and would otherwise silently drop that frame), and `agents/generator.ts`'s `source === 'lambda'` dispatch branch (a single synchronous invoke, no RunPod run/status/webhook cycle). `frames[].textManifest` now validates against the real `FrameRenderManifest` shape. **R2 persistence added same day**: Remotion Lambda's own S3 bucket (`remotionlambda-useast1-55dp29f3ln`) isn't QM's storage — no bucket policy, no lifecycle rule QM controls — so `src/r2/client.ts` downloads and re-uploads every output into the same `e2e-storystudio` R2 bucket every other QM service already writes to, under `remotion-overlay/<projectId>/<frameId>.mp4`, before the job is ever marked complete (throws, doesn't fall back to the ephemeral URL, on persist failure — same "don't repeat the 2026-08-17 replicate.delivery incident" philosophy as the top-level repo's `persistExternalAsset.ts`). Deployed + live-verified end-to-end on the VPS (dedicated least-privilege IAM user for the Lambda invoke, existing shared R2 credential from Secrets Manager for the R2 write). Still not exercised by a real StoryStudio request (blocked on StoryStudio's own `orchestratorRouting.ts` explainer/educational allowlist gate, unrelated to this wiring). |

Reused as-is (no work): `qwen-image-gen`, `qwen-image-edit`, `flux-tts-s2t`,
`wan2-i2v`, `multitalk`, `bgm-s2t`, `long2shorts` — the orchestrator submits to
the same endpoint IDs the live path uses, with its own payloads.

The orchestrator-side payload builders (`steps/builders/`, spec §9) that turn a
job row into one of these endpoints' `input` land with M2/M5.

Outputs go to **Cloudflare R2** (S3 API). Inputs are fetched as plain public URLs.
