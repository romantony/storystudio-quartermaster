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
 * Pure grouping/summing — no ffmpeg, no network. Exists only because Step
 * Functions' JSONPath dialect has no group-by/dedup/filter support, so this
 * can't be done in ASL directly (same reason reconcile-segment-timing.ts
 * groups sceneResults by segmentIndex in plain JS rather than a per-segment
 * Map). The SFN Maps over this Lambda's output array directly.
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
  shots: Shot[];
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

export const handler = async (event: BuildAmbienceBedSpecsEvent): Promise<BuildAmbienceBedSpecsResult> => {
  const durationByShotId = new Map(event.shotResults.map(r => [r.shotId, r.actualDurationSeconds]));

  const bySceneNumber = new Map<number, { ambiencePrompt: string; totalDurationSeconds: number }>();
  for (const shot of event.shots) {
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
