/**
 * Step 16 (educational/explainer text overlay) payload builder — sits
 * between merge (6)/remove-silence (7) and concat (8); see
 * steps/catalog.ts's seq-16 entry for why it's numbered 16 but runs there.
 *
 * Targets the existing AWS `QM-remotion-overlay` Lambda (src/lambda/client.ts),
 * not a RunPod endpoint — dispatched via agents/generator.ts's `source ===
 * 'lambda'` branch, not deps.runpod.run(). Payload shape matches that
 * Lambda's real, live-tested contract (2026-09-16 session) exactly:
 * `{clipUrl, frameId, duration, textManifest: <JSON string>}`.
 *
 * Closes the design gap StoryStudio's own
 * docs/quartermaster/storystudio-orchestrator-request-examples.md §3 names:
 * `frame.textManifest.background.src` always arrives empty, because
 * StoryStudio submits the request before the orchestrator has generated any
 * per-frame video — this builder overwrites `background.src` with the
 * resolved step 7 (remove-silence, if it ran) or step 6 (merge) clip URL,
 * the same waterfall steps/builders/concat.ts uses. `duration` is that same
 * dependency's real reported `duration_s` (resolveDeps() reads it
 * generically off any dependency's output — see builders/types.ts) — the
 * clip's ACTUAL length, not the manifest's pre-generation
 * durationInFrames estimate, matching the live QM-New path's own
 * force-override behavior (src/handlers/remotion-overlay.ts).
 *
 * Per-frame optional (2026-09-16 fix, caught while reconciling StoryStudio's
 * request-examples doc §3): `options.textOverlay` plans a step-16 job for
 * EVERY frame, but not every frame in a project necessarily carries a
 * `textManifest` — a frame with none should pass its clip through unchanged,
 * not fail. A thrown error here would mark just that one job 'failed'
 * (harmless in isolation), but steps/builders/concat.ts's fan-in treats step
 * 16's output as all-or-nothing per PROJECT (`overlaid.length > 0 ? overlaid
 * : ...`), so one manifest-less frame failing would silently drop it out of
 * the concatenated video entirely rather than passing it through — instead,
 * return a `__passthrough` marker; agents/generator.ts's `source ===
 * 'lambda'` branch recognizes it and completes the job immediately with the
 * original clip as output, without ever invoking the Lambda.
 */
import type { BuildContext, PayloadBuilder } from './types';

/**
 * The clip to overlay, most-processed first. 7/6 are the cohort path's
 * remove-silence and merge outputs; 15/14/3 are the asset pipeline's, where
 * per-frame merge happens inside the postprod-lite one-shot AFTER this step,
 * so the overlay goes onto the silent clip instead (assets/plan.ts). Ordered,
 * so the cohort path resolves exactly as it always did.
 */
const CLIP_SOURCE_SEQS = [7, 6, 15, 14, 3];

/**
 * Explicit render dimensions from an "W:H" aspect ratio, on the same
 * 1920-long-edge rule as StoryStudio's `resolveManifestDimensions`.
 *
 * The deployed `FrameOverlay` composition is supposed to derive these from
 * `aspectRatio` itself, but live it does not: a 9:16 manifest with only
 * `aspectRatio` renders 1920x1080 (reproduced directly against
 * QM-remotion-overlay 2026-10-03), and the tail then letterboxes that
 * landscape render back into the portrait canvas. Explicit width/height —
 * the resolver's first branch — renders 1080x1920 correctly, so set them.
 */
export function overlayDimensions(aspectRatio: string | undefined): { width: number; height: number } | undefined {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec((aspectRatio ?? '').trim());
  if (!match) return undefined;
  const ratioW = parseFloat(match[1]);
  const ratioH = parseFloat(match[2]);
  if (!ratioW || !ratioH) return undefined;
  const longEdge = 1920;
  const even = (n: number) => Math.round(n / 2) * 2;
  return ratioH > ratioW
    ? { width: even((longEdge * ratioW) / ratioH), height: longEdge }
    : { width: longEdge, height: even((longEdge * ratioH) / ratioW) };
}

export const buildRemotionOverlayInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const dep = CLIP_SOURCE_SEQS.map((seq) => ctx.resolvedDeps[seq]).find((d) => d?.url);
  const clipUrl = dep?.url;
  if (!clipUrl) {
    throw new Error(`remotion-overlay builder: no resolved source clip URL for frame ${ctx.frameId ?? '(none)'}`);
  }
  if (!ctx.job.textManifest) {
    return { __passthrough: true, clipUrl };
  }

  const manifest: Record<string, unknown> = { ...ctx.job.textManifest, background: { type: 'video', src: clipUrl } };
  if (!manifest.width || !manifest.height) {
    const dims = overlayDimensions((manifest.aspectRatio as string | undefined) ?? ctx.job.aspectRatio);
    if (dims) Object.assign(manifest, dims);
  }

  const payload: Record<string, unknown> = {
    clipUrl,
    textManifest: JSON.stringify(manifest),
  };
  if (ctx.frameId) payload.frameId = ctx.frameId;
  if (dep?.durationS !== undefined) payload.duration = dep.durationS;
  return payload;
};
