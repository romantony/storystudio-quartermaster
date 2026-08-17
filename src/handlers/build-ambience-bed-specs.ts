import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

/**
 * QM-build-ambience-bed-specs — Dialogue Premium only
 * (storystudio-dialogue-qm-sfn-handoff.md §7.7/§7.3). Groups the flat shot
 * list by `sceneNumber` into one ambience-bed spec per scene: `ambiencePrompt`
 * is scene-level but arrives repeated on every shot in that scene "for
 * convenience" (§7.3) — generate the bed ONCE per scene, not once per shot.
 * Duration = Σ that scene's shots' actualDurationSeconds (emergent from
 * generated audio, §7.3 — never the original `durationSeconds` placeholder),
 * so this needs both the original `shots[]` (for ambiencePrompt) and the
 * post-generation `shotResults[]` (for actualDurationSeconds), matched by
 * `shotId`.
 *
 * Pure grouping/summing — no ffmpeg. Exists only because Step Functions'
 * JSONPath dialect has no group-by/dedup/filter support, so this can't be
 * done in ASL directly (same reason reconcile-segment-timing.ts groups
 * sceneResults by segmentIndex in plain JS rather than a per-segment Map).
 * The SFN Maps over this Lambda's output array directly.
 *
 * 2026-08-16: for a large film whose shots came via FetchShotsManifest's S3
 * mirror (dialoguePremiumShotMap's `itemSource:'s3'` — see that comment and
 * fetch-shots-manifest.ts), the caller passes `manifestLocation` instead of
 * `shots` (the full array must never land in Step Functions state, same
 * reasoning as the shot Map's ItemReader) and this reads shots directly off
 * S3 itself.
 */

interface Shot {
  shotId: string;
  sceneNumber: number;
  ambiencePrompt?: string;
}

interface ShotResult {
  shotId: string;
  actualDurationSeconds: number;
}

interface BuildAmbienceBedSpecsEvent {
  shots?: Shot[];
  manifestLocation?: { bucket: string; key: string };
  shotResults: ShotResult[];
}

export interface AmbienceBedSpec {
  sceneNumber: number;
  ambiencePrompt: string;
  totalDurationSeconds: number;
}

interface BuildAmbienceBedSpecsResult {
  ambienceBedSpecs: AmbienceBedSpec[];
}

const s3 = new S3Client({});

async function loadShots(event: BuildAmbienceBedSpecsEvent): Promise<Shot[]> {
  if (event.shots) return event.shots;
  if (!event.manifestLocation) {
    throw new Error('build-ambience-bed-specs: neither shots nor manifestLocation was provided');
  }
  const res = await s3.send(new GetObjectCommand({
    Bucket: event.manifestLocation.bucket,
    Key: event.manifestLocation.key,
  }));
  const body = await res.Body!.transformToString();
  return JSON.parse(body) as Shot[];
}

export const handler = async (event: BuildAmbienceBedSpecsEvent): Promise<BuildAmbienceBedSpecsResult> => {
  const shots = await loadShots(event);
  const durationByShotId = new Map(event.shotResults.map(r => [r.shotId, r.actualDurationSeconds]));

  const bySceneNumber = new Map<number, { ambiencePrompt: string; totalDurationSeconds: number }>();
  for (const shot of shots) {
    const duration = durationByShotId.get(shot.shotId) ?? 0;
    const existing = bySceneNumber.get(shot.sceneNumber);
    if (existing) {
      existing.totalDurationSeconds += duration;
    } else {
      bySceneNumber.set(shot.sceneNumber, {
        ambiencePrompt: shot.ambiencePrompt ?? '',
        totalDurationSeconds: duration,
      });
    }
  }

  const ambienceBedSpecs = [...bySceneNumber.entries()]
    .filter(([, spec]) => spec.ambiencePrompt.trim().length > 0)
    .sort(([a], [b]) => a - b)
    .map(([sceneNumber, spec]) => ({ sceneNumber, ...spec }));

  return { ambienceBedSpecs };
};
