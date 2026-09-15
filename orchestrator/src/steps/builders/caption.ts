/**
 * Step 11 (burn captions) payload builder — a singleJobPerProject step, like
 * steps 8/10, reading whichever came last in the optional post-processing
 * chain: step 10's (upscale) output when options.upscale is on, falling back
 * to step 8's (concat) output when it's off — mirrors the `?? ` fallback
 * steps/builders/i2v.ts already uses for its two mutually-exclusive image
 * deps, except concat/upscale aren't mutually exclusive (concat always
 * runs), so the fan-in count itself needs collapsing too — see
 * agents/planner.ts's resolveDirectDependencies().
 *
 * Targets postprod-lite's `caption` mode (orchestrator/containers/media.md):
 * `{video_url, words_per_group, font_size, highlight_color, position}` ->
 * `{video, srt, transcript, word_count}`. The params below ARE the
 * "TikTok style" ask: short word bursts (not full sentences), bold oversized
 * text, a bright per-word highlight color, bottom-center placement — the
 * same preset this endpoint's own defaults already encode (confirmed
 * explicit here rather than relying on defaults, same lesson as the step 6
 * merge `mode` bug: never assume an endpoint's default matches intent).
 *
 * Captions come from the script, not ASR, whenever possible (2026-09-15):
 * postprod-lite's blind Whisper pass drops the last seconds of long videos
 * (chunked long-form pipeline, 2026-09-10) and misspells names. Each
 * concatenated frame's narration is spread across that frame's clip
 * duration (step 7's trimmed clip, else step 6's merge), words weighted by
 * character count, and passed as `chunks` — the same method verified live on
 * 2026-09-10. Falls back to Whisper (no `chunks`) if any included frame lacks
 * a duration or narration, rather than guessing.
 */
import type { BuildContext, PayloadBuilder } from './types';

const UPSCALE_STEP_SEQ = 10;
const CONCAT_STEP_SEQ = 8;
const REMOVE_SILENCE_STEP_SEQ = 7;
const MERGE_STEP_SEQ = 6;

export interface WordChunk {
  text: string;
  timestamp: [number, number];
}

/** Word-level chunks from the narration script, timed against the clips that
 * concat actually joined (same source-step choice as builders/concat.ts:
 * trimmed clips if step 7 produced any, else merged clips; failed frames are
 * skipped exactly as concat skips them). Undefined when it can't be exact. */
export function scriptChunks(ctx: BuildContext): WordChunk[] | undefined {
  const trimmed = ctx.perFrameDetails?.[REMOVE_SILENCE_STEP_SEQ] ?? [];
  const source = trimmed.some((d) => d.url) ? trimmed : (ctx.perFrameDetails?.[MERGE_STEP_SEQ] ?? []);
  const included = source.filter((d) => d.url);
  const narrations = new Map((ctx.job.narrations ?? []).map((n) => [n.frameId, n.narration] as const));
  if (included.length === 0) return undefined;

  const chunks: WordChunk[] = [];
  let offset = 0;
  for (const clip of included) {
    const narration = clip.frameId ? narrations.get(clip.frameId) : undefined;
    if (clip.durationS === undefined || clip.durationS <= 0 || !narration?.trim()) return undefined;
    const words = narration.trim().split(/\s+/);
    const weights = words.map((w) => w.length + 1);
    const total = weights.reduce((a, b) => a + b, 0);
    let t = offset;
    words.forEach((word, i) => {
      const end = t + (clip.durationS! * weights[i]) / total;
      chunks.push({ text: word, timestamp: [Math.round(t * 100) / 100, Math.round(end * 100) / 100] });
      t = end;
    });
    offset += clip.durationS;
  }
  return chunks;
}

const WORDS_PER_GROUP = 3;
const FONT_SIZE = 64;
const HIGHLIGHT_COLOR = 'yellow';
const POSITION = 'bottom';

export const buildCaptionInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const videoUrl = ctx.perFrameOutputs?.[UPSCALE_STEP_SEQ]?.[0] ?? ctx.perFrameOutputs?.[CONCAT_STEP_SEQ]?.[0];
  if (!videoUrl) {
    throw new Error(`caption builder: no resolved video URL (checked upscale then concat) for project ${ctx.projectId}`);
  }
  const chunks = scriptChunks(ctx);
  return {
    mode: 'caption',
    video_url: videoUrl,
    words_per_group: WORDS_PER_GROUP,
    font_size: FONT_SIZE,
    highlight_color: HIGHLIGHT_COLOR,
    position: POSITION,
    ...(chunks ? { chunks } : {}),
    project_id: ctx.projectId,
  };
};
