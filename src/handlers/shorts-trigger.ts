/**
 * BuildShortsPayload — the Step Functions -> qm-shorts-longform ECS task
 * payload builder.
 *
 * Pure data transform, no network calls: builds the job input the
 * qm-shorts-longform Fargate task expects (PAYLOAD_S3_KEY, uploaded by the
 * QM-upload-payload Lambda right after this one runs — see
 * shortsTriggerStates in pipeline-stack.ts) plus a `webhook` URL the task
 * POSTs its completion envelope to itself once done (there is no RunPod
 * platform doing that for it anymore — see infra/docker/shorts-longform/
 * handler.py's main()/_post_webhook()).
 *
 * `shortsOptions` is a raw passthrough merged into the task's input — the
 * worker's job input has ~20 optional fields defined ad hoc in handler.py
 * (segments/frames, num_clips, render_style, upscale, caption_config, hook,
 * slides, bgm_volume, ass_url, ...) with no formal schema, so this Lambda
 * doesn't hardcode a copy of that surface — it merges whatever the caller
 * sends and lets the worker validate it. Caller-supplied keys win over this
 * Lambda's computed defaults (srt_url/segments_source/bgm_url), but never
 * over project_id/video_url — those are always the pipeline's own
 * concat-video facts for this execution, not caller-overridable.
 */

interface ShortsTriggerEvent {
  projectId: string;
  jobId: string;
  videoUrl: string;
  srtUrl?: string;
  bgmUrl?: string;
  convexEndpoint?: string;
  /** Language of videoUrl/srtUrl's narration (e.g. 'en', 'es', 'pt-BR', 'hi') — drives the worker's own final-clip re-transcription. */
  language?: string;
  /** Raw passthrough merged into the task's input — see file header. */
  shortsOptions?: Record<string, unknown>;
}

export const handler = async (event: ShortsTriggerEvent): Promise<Record<string, unknown>> => {
  const defaults: Record<string, unknown> = { mode: 'shorts' };
  // Transcript-first AI clipping is the recommended mode (frame-accurate
  // captions sliced from the real SRT, Claude picks highlight clips) — only
  // available when the pipeline produced a full-video SRT. shortsOptions can
  // override segments_source (e.g. explicit segments[] + srt_url without AI
  // selection) since it's spread after these defaults.
  if (event.srtUrl) {
    defaults.srt_url = event.srtUrl;
    defaults.segments_source = 'ai';
  }
  if (event.bgmUrl) defaults.bgm_url = event.bgmUrl;
  if (event.language) defaults.language = event.language;

  const input: Record<string, unknown> = {
    ...defaults,
    ...(event.shortsOptions ?? {}),
    // Never caller-overridable — always this execution's own concat video.
    project_id: event.projectId,
    video_url: event.videoUrl,
  };

  if (event.convexEndpoint) {
    input.webhook = `${event.convexEndpoint}/api/e2e/runpod-webhook?jobId=${encodeURIComponent(event.jobId)}`;
  }

  return input;
};
