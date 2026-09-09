# `orchestrator/containers/`

RunPod endpoints the background pipeline drives that aren't already wired for the
live path (spec §5.1). **Nothing is built in this repo** — the workers all live
elsewhere; this directory just pins the contracts the orchestrator codes against.

| Endpoint | Serves | Where the worker lives | Status |
|---|---|---|---|
| `media` | steps 6 merge, 8 concat, 10 upscale, 11 caption, 12 bgm_overlay | `romantony/flux4B-Wan2-storystudio` (same codebase as `flux-tts-s2t` / `bgm-s2t`), deployed with `ENDPOINT_ROLE=all` | contract pinned in `media.md`; deploy + measure pending |
| `remotion` | step 7 text overlay | AWS Remotion Lambda (`src/handlers/remotion-overlay.ts`) | **deferred for M1** (spec §16 q3) — the one remaining AWS touch |

Reused as-is (no work): `qwen-image-gen`, `qwen-image-edit`, `flux-tts-s2t`,
`wan2-i2v`, `multitalk`, `bgm-s2t`, `long2shorts` — the orchestrator submits to
the same endpoint IDs the live path uses, with its own payloads.

The orchestrator-side payload builders (`steps/builders/`, spec §9) that turn a
job row into one of these endpoints' `input` land with M2/M5.

Outputs go to **Cloudflare R2** (S3 API). Inputs are fetched as plain public URLs.
