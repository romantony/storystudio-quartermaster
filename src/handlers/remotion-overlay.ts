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
 */

interface RemotionOverlayEvent {
  clipUrl: string;
  /** JSON-stringified FrameRenderManifest: {fps, durationInFrames, textElements[], ...}. */
  textManifest: string;
  frameId?: string;
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

  const { renderId, bucketName } = await renderMediaOnLambda({
    region: REGION,
    functionName: FUNCTION_NAME,
    serveUrl: SERVE_URL,
    composition: COMPOSITION_ID,
    inputProps: manifest,
    codec: 'h264',
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
