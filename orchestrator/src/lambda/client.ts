/**
 * AWS Lambda transport — the one deliberate exception to this orchestrator
 * having no AWS SDK (config.ts's watchdog comment used to say so outright).
 * Added 2026-09-16 for the Remotion text-overlay step (steps/catalog.ts's
 * seq 16, `source: 'lambda'`): reuses the already-deployed, live-tested
 * `QM-remotion-overlay` function instead of reimplementing Remotion
 * rendering on RunPod (that RunPod path was scoped out the same session —
 * see orchestrator/containers/README.md's `remotion` row).
 *
 * Deliberately a single synchronous `InvokeCommand`
 * (`InvocationType: 'RequestResponse'`) rather than RunPod's async
 * run+poll+webhook cycle — the target function already blocks internally
 * until Remotion's render finishes (confirmed live: ~11-17s per frame,
 * comfortably inside Lambda's default request timeout) and returns the
 * final output URL directly, so there's nothing to poll.
 */
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

export interface RemotionOverlayInput {
  clipUrl: string;
  frameId?: string;
  duration?: number;
  /** JSON-stringified FrameRenderManifest — see steps/builders/remotion-overlay.ts. */
  textManifest: string;
}

export interface RemotionOverlayResult {
  overlayRenderedUrl: string;
}

/** Injectable transport, mirroring quality/replicate.ts's ReplicateTransport
 * shape: real AWS calls by default, swappable for a fake in tests. */
export interface LambdaTransport {
  functionName: string;
  region: string;
  invokeImpl?: (functionName: string, region: string, payload: unknown) => Promise<unknown>;
}

async function defaultInvoke(functionName: string, region: string, payload: unknown): Promise<unknown> {
  const client = new LambdaClient({ region });
  const res = await client.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
  const raw = res.Payload ? Buffer.from(res.Payload).toString('utf-8') : '';
  let parsed: unknown = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`Lambda ${functionName} returned non-JSON payload: ${raw.slice(0, 300)}`);
  }
  if (res.FunctionError) {
    const errorMessage = (parsed as { errorMessage?: string } | null)?.errorMessage;
    throw new Error(`Lambda ${functionName} returned ${res.FunctionError}: ${errorMessage ?? JSON.stringify(parsed).slice(0, 500)}`);
  }
  return parsed;
}

export async function invokeRemotionOverlay(deps: LambdaTransport, input: RemotionOverlayInput): Promise<RemotionOverlayResult> {
  const invoke = deps.invokeImpl ?? defaultInvoke;
  const result = (await invoke(deps.functionName, deps.region, input)) as Partial<RemotionOverlayResult> | null;
  if (!result?.overlayRenderedUrl) {
    throw new Error(`Lambda ${deps.functionName} returned no overlayRenderedUrl: ${JSON.stringify(result)}`);
  }
  return { overlayRenderedUrl: result.overlayRenderedUrl };
}
