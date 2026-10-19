/**
 * Builds the result StoryStudio receives at its `callbackUrl` when a
 * documentary finishes (implementation plan §4.7).
 *
 * Same envelope as the per-frame result (`requestId`, `projectId`, `status`,
 * `assets.final.url`, `errors[]`) so StoryStudio's existing ingest stores it
 * unchanged; `kind: "documentary"` tells it which post-processing to run.
 * A documentary has no frames, so `assets.frames` is always `[]`.
 *
 * Status:
 *   completed  the long video and every other output has a public url
 *   partial    the long video has a url but something else is missing a url
 *   failed     no usable long video — the job failed, was cancelled, or
 *              "succeeded" without a long_video output
 */
import type { DocgenJobRow } from '../db/repo/docgen';
import type { DocgenOutput, DocgenStatus } from './types';

export type DocgenResultStatus = 'completed' | 'partial' | 'failed';

export interface DocgenResult {
  requestId: string;
  projectId: string;
  kind: 'documentary';
  status: DocgenResultStatus;
  createdAt: string;
  finishedAt: string;
  project: { tier: 'documentary-basic'; product: 'documentary'; aspectRatio: '16:9'; frameCount: 0 };
  assets: {
    final: { url: string; bytes: number | null; durationS: null; resolution: null } | null;
    frames: [];
    /** `thumbnail`: the Short's own 9:16 thumbnail (output kind short_thumbnail at shorts/<id>/thumb/), when doc-gen made one. */
    shorts: Array<{ id: string; url: string; bytes: number | null; thumbnail: { url: string } | null }>;
    thumbnail: { url: string } | null;
    metadata: { url: string } | null;
    shortsMetadata: { url: string } | null;
    credits: { url: string } | null;
  };
  warnings: string[];
  costs: Record<string, number>;
  metrics: { queuedMs: number | null; runMs: number | null; attempts: number };
  errors: Array<{ frameId: null; step: string; agent: 'docgen'; reason: string; code: string; retryable: boolean | null }>;
}

const shortId = (path: string): string => /(?:^|\/)shorts\/([^/]+)\//.exec(path)?.[1] ?? path;

export function buildDocgenResult(row: DocgenJobRow, now: Date = new Date()): DocgenResult {
  const st: Partial<DocgenStatus> = row.status ?? {};
  const outputs: DocgenOutput[] = Array.isArray(row.outputs) ? (row.outputs as DocgenOutput[]) : st.outputs ?? [];
  const warnings = [...(st.warnings ?? [])];

  const one = (kind: string) => outputs.find((o) => o.kind === kind);
  const link = (kind: string) => {
    const o = one(kind);
    return o?.url ? { url: o.url } : null;
  };
  const long = one('long_video');
  const shortThumbs = new Map(outputs.filter((o) => o.kind === 'short_thumbnail' && o.url).map((o) => [shortId(o.path), o.url as string]));
  const shorts = outputs.filter((o) => o.kind === 'short' && o.url).map((o) => {
    const id = shortId(o.path); const thumb = shortThumbs.get(id);
    return { id, url: o.url as string, bytes: o.bytes ?? null, thumbnail: thumb ? { url: thumb } : null };
  });

  // Every output the instance reported must have a url to count as complete;
  // an entry without one means its upload failed (the instance says which in `warnings`).
  const missing = outputs.filter((o) => !o.url);
  for (const o of missing) warnings.push(`Output not uploaded: ${o.kind} (${o.path})`);

  let status: DocgenResultStatus;
  if (row.state !== 'succeeded' || !long?.url) status = 'failed';
  else status = missing.length ? 'partial' : 'completed';

  if (row.state === 'succeeded' && !long?.url) warnings.push('The job reported success but produced no long video with a public url.');

  const errors: DocgenResult['errors'] = [];
  const err = (row.error ?? st.error) as { code?: string; stage?: string; message?: string; retryable?: boolean } | null | undefined;
  if (row.state === 'failed' || row.state === 'cancelled') {
    errors.push({
      frameId: null,
      step: err?.stage ?? st.stage ?? 'unknown',
      agent: 'docgen',
      reason: err?.message ?? (row.state === 'cancelled' ? 'cancelled' : 'doc-gen reported a failure'),
      code: err?.code ?? row.state,
      retryable: err?.retryable ?? null,
    });
  }

  const finished = row.finishedAt ?? now;
  return {
    requestId: row.requestId,
    projectId: row.projectId,
    kind: 'documentary',
    status,
    createdAt: row.queuedAt.toISOString(),
    finishedAt: finished.toISOString(),
    project: { tier: 'documentary-basic', product: 'documentary', aspectRatio: '16:9', frameCount: 0 },
    assets: {
      final: long?.url ? { url: long.url, bytes: long.bytes ?? null, durationS: null, resolution: null } : null,
      frames: [],
      shorts,
      thumbnail: link('thumbnail'),
      metadata: link('metadata'),
      shortsMetadata: link('shorts_metadata'),
      credits: link('credits'),
    },
    warnings,
    costs: st.costs ?? {},
    metrics: {
      queuedMs: row.startedAt ? row.startedAt.getTime() - row.queuedAt.getTime() : null,
      runMs: row.startedAt ? finished.getTime() - row.startedAt.getTime() : null,
      attempts: row.attempts,
    },
    errors,
  };
}
