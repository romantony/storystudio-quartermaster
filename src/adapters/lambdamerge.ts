import type { Adapter, BuiltRequest, CanonicalJob, ErrClass, PollResult, Rung, SubmitResult } from '../types';

const FUNCTION_NAME = process.env.QM_MERGE_FUNCTION_NAME ?? 'QM-merge';

/**
 * QM-owned Lambda merge (audio+video mux) — replaces RunPod's flux-tts-s2t
 * merge mode for video.narrationBasic.merge (and its Premium alias). Pure
 * ffmpeg work with no model inference, so it never needed the GPU pod;
 * moved here 2026-07-27 to stop competing with image/TTS/animate for the
 * shared 6-worker pool (merge x4-per-frame was one of the two biggest
 * concurrent fan-outs against it, a real contributor to a real execution's
 * timeouts) and to unblock the long-flagged silence-padding fix (Bug #6)
 * RunPod's -shortest-only merge never got — see src/handlers/merge.ts's own
 * header comment for that fix.
 *
 * Synchronous — one Lambda invoke, no async job/poll model. `buildRequest`
 * returns a `lambda:<functionName>` pseudo-URL that executor.ts's submit()
 * recognizes and direct-invokes via the Lambda SDK instead of fetch()-ing it
 * as HTTP (this repo's other adapters are all real HTTP APIs; a same-account
 * Lambda-to-Lambda call has no HTTP endpoint of its own to hit).
 */
export const lambdamerge: Adapter = {
  supportsWebhook: false,

  buildRequest(job: CanonicalJob, _rung: Rung): BuiltRequest {
    const outputKey = `merge/${job.projectId}/${job.frameId}-${job.jobId}.mp4`;
    return {
      url: `lambda:${FUNCTION_NAME}`,
      method: 'POST',
      headers: {},
      body: {
        videoUrl: job.initImageUrls?.[0],
        audioUrl: job.audioUrl,
        ...(job.params.durationS !== undefined ? { durationS: job.params.durationS } : {}),
        ...(job.params.mixMode === 'additive' ? { mixMode: 'additive' as const } : {}),
        ...(job.params.sfxVolume !== undefined ? { sfxVolume: job.params.sfxVolume } : {}),
        outputKey,
      },
    };
  },

  parseSubmit(raw: unknown): SubmitResult {
    const r = raw as { cdnUrl?: string; durationS?: number; errorMessage?: string; errorType?: string };
    if (!r.cdnUrl) {
      throw Object.assign(new Error(`QM-merge error: ${r.errorMessage ?? 'no cdnUrl in response'}`), { raw });
    }
    return { outputUrls: [r.cdnUrl], durationS: r.durationS, raw };
  },

  async poll(_taskRef: string, _rung: Rung): Promise<PollResult> {
    // Never invoked — parseSubmit always populates outputUrls on success
    // (a direct Lambda RequestResponse invoke has no async job/polling model).
    return { done: true, failed: true, error: 'lambdamerge adapter has no poll path' };
  },

  classifyError(httpCode: number, _raw: unknown): ErrClass {
    // executor.ts's submit() maps a Lambda FunctionError / invoke exception to
    // httpCode 500 (see the lambda: branch there) — treat that as transient
    // (retry once, then fail over to the RunPod fallback rung); anything else
    // (a genuine ffmpeg/logic error the Lambda itself reported) as permanent.
    return httpCode >= 500 ? 'Transient' : 'TerminalPermanent';
  },
};
