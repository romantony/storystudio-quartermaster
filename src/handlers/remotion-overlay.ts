import { renderMediaOnLambda, getRenderProgress } from '@remotion/lambda-client';
import type { AwsRegion } from '@remotion/lambda-client';

/**
 * QM-remotion-overlay — per-frame Remotion text-overlay render, invoked
 * directly inside the GenerateImages Map (Option B of
 * docs/quartermaster/remotion-overlay-lambda-integration-handoff.md, not
 * routed through the QM-generate catalog/ladder — Lambda already handles its
 * own scaling, so this doesn't need QM's scarce-GPU-fleet semaphore).
 *
 * Calls the already-deployed Remotion Lambda function/site/composition
 * (owned and redeployed by StoryStudio, not this repo) to composite
 * `textElements` from a frame's `textManifest` onto its already-animated,
 * already-audio-merged clip (Flux Ken Burns for Basic, Wan2 i2v for
 * Premium). By the time a frame reaches this step, its background is always
 * an already-rendered video for both tiers — never a bare still image (see
 * the handoff doc §1's correction) — so `background.type` is hardcoded to
 * "video" here regardless of which tier produced the clip.
 *
 * Known limitation (matches the handoff doc's own open question, §3 of
 * remotion-basic-vs-premium-integration-handoff.md): this does not verify or
 * correct the merged clip's real fps against `textManifest.fps` — a
 * Premium/Wan2 fps mismatch would silently judder rather than fail. Not
 * solved here; flagged as a follow-up.
 *
 * `duration` (the clip's real length in seconds, reported by the pod that
 * produced it — see pipeline-stack.ts's NormalizeRealDuration for Basic)
 * force-overrides Remotion's rendered duration via `forceDurationInFrames`.
 * Without this, the composition renders exactly `textManifest.durationInFrames`
 * frames — a value StoryStudio computed from the frame's originally-planned
 * duration *before* real TTS ever ran — silently truncating the tail of any
 * clip whose real narration ran longer than planned (confirmed live
 * 2026-07-21: audibly cut-off narration on every frame carrying a manifest).
 */

interface RemotionOverlayEvent {
  clipUrl: string;
  /** JSON-stringified FrameRenderManifest: {fps, durationInFrames, textElements[], ...}. */
  textManifest: string;
  frameId?: string;
  /** The clip's real length in seconds — overrides textManifest's pre-TTS-estimated durationInFrames. */
  duration?: number;
}

interface RemotionOverlayResult {
  overlayRenderedUrl: string;
}

const REGION = (process.env.REMOTION_REGION ?? 'us-east-1') as AwsRegion;
const FUNCTION_NAME = process.env.REMOTION_FUNCTION_NAME!;
const SERVE_URL = process.env.REMOTION_SERVE_URL!;
const COMPOSITION_ID = process.env.REMOTION_COMPOSITION_ID ?? 'FrameOverlay';
const POLL_INTERVAL_MS = Number(process.env.REMOTION_POLL_INTERVAL_MS ?? 2_000);
const DEADLINE_MS = Number(process.env.REMOTION_DEADLINE_MS ?? 140_000);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const handler = async (event: RemotionOverlayEvent): Promise<RemotionOverlayResult> => {
  const manifest = JSON.parse(event.textManifest) as Record<string, unknown>;
  manifest.background = { type: 'video', src: event.clipUrl };

  const fps = typeof manifest.fps === 'number' ? manifest.fps : 30;
  const forceDurationInFrames = event.duration != null ? Math.round(event.duration * fps) : undefined;

  const { renderId, bucketName } = await renderMediaOnLambda({
    region: REGION,
    functionName: FUNCTION_NAME,
    serveUrl: SERVE_URL,
    composition: COMPOSITION_ID,
    inputProps: manifest,
    codec: 'h264',
    forceDurationInFrames,
  });

  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    const progress = await getRenderProgress({ renderId, bucketName, functionName: FUNCTION_NAME, region: REGION });
    if (progress.fatalErrorEncountered) {
      const reason = progress.errors?.map((e: { message: string }) => e.message).join('; ') ?? 'unknown error';
      throw new Error(`Remotion render failed for frame ${event.frameId ?? 'na'}: ${reason}`);
    }
    if (progress.done && progress.outputFile) {
      return { overlayRenderedUrl: progress.outputFile };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Remotion render timed out after ${DEADLINE_MS}ms for frame ${event.frameId ?? 'na'}`);
};
