# `orchestrator/containers/` — RunPod serverless endpoints (M1)

New endpoints the background pipeline needs that don't exist on the live path
(spec §5.1). Everything else in `orchestrator/` is the control plane; these are
the workers it drives.

| Dir | Endpoint | Serves | Status |
|---|---|---|---|
| `media/` | `media` | steps 6 merge, 8 concat, 10 upscale, 11 caption, 12 bgm_overlay | **built** — offline-tested; deploy + §12.3 probe pending |
| — | `remotion` | step 7 text overlay | **deferred** — stays on the existing Remotion Lambda for M1 (spec §16 q3; `src/handlers/remotion-overlay.ts`). ~$0.46/cohort, the only remaining AWS touch in the background path. |

Outputs go to **Cloudflare R2** (S3 API). Inputs are fetched as plain public
URLs.

The orchestrator-side payload builders (`steps/builders/`, spec §9) that turn a
job row into one of these endpoints' `input` land with M2/M5, not here.
