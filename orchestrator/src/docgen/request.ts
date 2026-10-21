/**
 * Intake body for POST /v1/documentaries (StoryStudio -> orchestrator) and its
 * mapping to the doc-gen payload.
 *
 * Strict, like /v1/requests: unknown fields are rejected so a typo cannot
 * silently fall back to a default that costs money (talking clips and animated
 * stills are paid generations).
 *
 * StoryStudio cannot set review_mode, model, limits, output prefix or the
 * instance's callback URL — the orchestrator owns those. Optional sections are
 * only forwarded when sent, so the instance's own defaults apply otherwise.
 */
import { z } from 'zod';
import type { DocgenStartPayload } from './types';

/** doc-gen allows 64 chars; a retry appends '-r2' (3 chars) and must still fit. */
export const MAX_REQUEST_ID_LEN = 61;

const requestIdSchema = z
  .string()
  .min(1)
  .max(MAX_REQUEST_ID_LEN)
  .regex(/^[A-Za-z0-9_-]+$/, 'letters, digits, "_" and "-" only');

export const DocgenIntakeSchema = z
  .object({
    requestId: requestIdSchema,
    projectId: z.string().min(1),
    source: z.literal('mcp'),
    // Only documentary-basic runs on doc-gen; anything else is a routing mistake upstream, not a label to echo.
    tier: z.literal('documentary-basic'),
    callbackUrl: z.string().url().startsWith('https://', 'callbackUrl must be https'),
    topic: z.string().min(1).max(200),
    synopsis: z.string().min(1).max(1000),
    targetSeconds: z.number().int().min(60).max(1800).optional(),
    narratorVoice: z.string().min(1).optional(),
    series: z
      .object({
        name: z.string().optional(),
        episode: z.number().int().positive().optional(),
        previousEpisodeTitle: z.string().optional(),
        previousEpisodeUrl: z.string().optional(),
        nextEpisodeTitle: z.string().optional(),
        playlistUrl: z.string().optional(),
      })
      .strict()
      .optional(),
    shorts: z
      .object({
        count: z.number().int().min(0).max(3).optional(),
        angles: z.array(z.enum(['spark', 'myth', 'legacy'])).optional(),
      })
      .strict()
      .optional(),
    visuals: z
      .object({
        archive: z.boolean().optional(),
        stock: z.boolean().optional(),
        imageGen: z.boolean().optional(),
        talkingClips: z.number().int().min(0).max(5).optional(),
        animatedStills: z.number().int().min(0).max(15).optional(),
        dramatisedCharacter: z.boolean().optional(),
        allowGraphicArchive: z.boolean().optional(),
        textOverlays: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type DocgenIntake = z.infer<typeof DocgenIntakeSchema>;

export class DocgenValidationError extends Error {
  constructor(public readonly issues: Array<{ path: Array<string | number>; message: string }>) {
    super('invalid documentary request');
  }
}

export function validateIntake(body: unknown): DocgenIntake {
  const r = DocgenIntakeSchema.safeParse(body);
  if (!r.success) {
    throw new DocgenValidationError(r.error.issues.map((i) => ({ path: i.path, message: i.message })));
  }
  return r.data;
}

/** The id sent to the instance: ours on attempt 1, '<id>-r2' on a retry (a failed id is never reused). */
export function docgenRequestIdFor(requestId: string, attempt: number): string {
  return attempt <= 1 ? requestId : `${requestId}-r${attempt}`;
}

export interface BuildCtx {
  reviewMode: 'checkpoints' | 'auto';
  model: string;
  /** ORCH_PUBLIC_BASE_URL — where the instance sends its webhooks. */
  publicBaseUrl: string;
}

const strip = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

const nonEmpty = <T extends Record<string, unknown>>(o: T): T | undefined => (Object.keys(o).length ? o : undefined);

export function buildDocgenPayload(req: DocgenIntake, docgenRequestId: string, ctx: BuildCtx): DocgenStartPayload {
  const series = req.series
    ? nonEmpty(
        strip({
          name: req.series.name,
          episode: req.series.episode,
          previous_episode_title: req.series.previousEpisodeTitle,
          previous_episode_url: req.series.previousEpisodeUrl,
          next_episode_title: req.series.nextEpisodeTitle,
          playlist_url: req.series.playlistUrl,
        }),
      )
    : undefined;
  const long = nonEmpty(strip({ target_seconds: req.targetSeconds, narrator_voice: req.narratorVoice }));
  const shorts = req.shorts ? nonEmpty(strip({ count: req.shorts.count, angles: req.shorts.angles })) : undefined;
  const visuals = req.visuals
    ? nonEmpty(
        strip({
          archive: req.visuals.archive,
          stock: req.visuals.stock,
          image_gen: req.visuals.imageGen,
          talking_clips: req.visuals.talkingClips,
          animated_stills: req.visuals.animatedStills,
          dramatised_character: req.visuals.dramatisedCharacter,
          allow_graphic_archive: req.visuals.allowGraphicArchive,
          text_overlays: req.visuals.textOverlays,
        }),
      )
    : undefined;

  return {
    request_id: docgenRequestId,
    topic: req.topic,
    synopsis: req.synopsis,
    ...(series ? { series: series as DocgenStartPayload['series'] } : {}),
    ...(long ? { long } : {}),
    ...(shorts ? { shorts } : {}),
    ...(visuals ? { visuals: visuals as DocgenStartPayload['visuals'] } : {}),
    review_mode: ctx.reviewMode,
    model: ctx.model,
    output: { prefix: `docgen/${docgenRequestId}/` },
    callback: { url: `${ctx.publicBaseUrl.replace(/\/+$/, '')}/v1/webhooks/docgen` },
  };
}
