/**
 * `postprod-lite` one-shot payload — the whole project's tail in one call
 * (2026-09-19). See `orchestrator/containers/media.md` §10 and
 * `~/flux4B-Wan2/Flux-klien-4b/postprod-lite/API.md` §10.
 *
 * Unlike every other builder here, this one carries no generation parameters:
 * the work is described by the compiler's manifest, and the payload is just a
 * pointer to it. The manifest travels as a FILE by preference — an inline
 * manifest is the fallback for when R2 credentials aren't configured, and is
 * exactly the oversized-payload shape that broke this pipeline twice before
 * (the SFN 256KB DataLimitExceeded incidents of 2026-08-12 and 2026-08-17),
 * so a large project without R2 is refused rather than sent.
 *
 * `assets/compiler.ts` writes `manifestUrl` (or `manifest`) into the
 * project-scoped `postprod-lite` asset row's input and arms it; the
 * postprod-lite agent then dispatches it under that endpoint's pod limit,
 * which is what enforces "one pod processes one project".
 */
import type { BuildContext, PayloadBuilder } from './types';

/** An inline manifest above this is refused — use R2. Well under RunPod's own
 * request limit, and far under the 256KB that has bitten this pipeline. */
export const INLINE_MANIFEST_MAX_BYTES = 128 * 1024;

export const buildPostprodInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const input = ctx.job as unknown as { manifestUrl?: string; manifest?: unknown };

  if (input.manifestUrl) {
    return { mode: 'postprod', manifest_url: input.manifestUrl, project_id: ctx.projectId };
  }

  if (!input.manifest) {
    throw new Error(
      `postprod builder: project ${ctx.projectId} has no manifest — the compiler arms this row with one, so this row was released by something else`,
    );
  }

  const bytes = Buffer.byteLength(JSON.stringify(input.manifest), 'utf8');
  if (bytes > INLINE_MANIFEST_MAX_BYTES) {
    throw new Error(
      `postprod builder: project ${ctx.projectId}'s inline manifest is ${bytes} bytes (limit ${INLINE_MANIFEST_MAX_BYTES}) — configure R2 so the compiler can write it as a file`,
    );
  }

  return { mode: 'postprod', manifest: input.manifest, project_id: ctx.projectId };
};
