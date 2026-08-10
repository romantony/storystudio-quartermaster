import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { download, getDuration, run, uploadFile } from '../shared/ffmpeg-io';

/**
 * QM-reconcile-segment-timing — Dialogue Basic only
 * (storystudio-dialogue-qm-sfn-handoff.md §4.5). StoryStudio plans each
 * narrator segment's scenes from a words-per-second TTS estimate; the real
 * TTS/InfiniteTalk duration always differs by a little. Without correction
 * the narrator drifts against the scene track, worse with every segment.
 *
 * Runs ONCE per project (a single Task state between the two Parallel
 * branches joining and ConcatenateScenes/ConcatenateNarrator), over the
 * FULL `sceneResults`/`segmentResults` arrays rather than a per-segment Map —
 * Step Functions' JSONPath dialect has no filter-expression support
 * (`[?(@.field==value)]`), so there is no way to slice `sceneResults` down to
 * "this segment's clips" from ASL alone. Grouping by `segmentIndex` happens
 * here instead, in plain JS.
 *
 * Per segment k:
 *   D_actual = segmentResults[k].actualDurationSeconds    (exact — qwen-voice-clone's duration_s)
 *   D_scenes = sum(sceneResults[i].duration where segmentIndex===k)  (frame-derived — §4.4, NEVER the requested integer)
 *   residual = D_actual - D_scenes
 *
 *   |residual| < 0.05   -> no-op
 *   residual < 0        -> trim the isSegmentLastFrame clip by |residual|
 *   residual > 0        -> extend the isSegmentLastFrame clip by residual,
 *                          via ffmpeg loop + re-encoded trim to the exact
 *                          length (NOT freeze-frame, NOT audio truncation)
 *   residual > lastClip.duration (TTS overran by more than one whole scene)
 *                       -> distribute across the LAST TWO clips of that
 *                          segment instead of stretching one clip implausibly
 *                          long, each extension capped at ~2x its original
 *                          length (§4.5 edge case)
 *
 * Guarantee after this step: for every segment k, sum(scene durations in
 * segment k) === actualDurationSeconds(k), so segments never leak drift into
 * their successors and the final concat is sample-accurate.
 */

interface SceneClip {
  frameId: string;
  frameNumber: number;
  segmentIndex: number;
  videoUrl: string;
  /** Frame-derived actual duration (§4.4 — Wan2's real output length, e.g.
   * `frame_num / 16`, never the requested integer `duration_s`). */
  duration: number;
  isSegmentLastFrame: boolean;
}

interface SegmentActual {
  segmentIndex: number;
  actualDurationSeconds: number;
}

interface ReconcileEvent {
  sceneResults: SceneClip[];
  segmentResults: SegmentActual[];
  /** S3 key prefix for any corrected clip(s) this invocation writes. */
  outputKeyPrefix: string;
}

interface ReconcileResult {
  sceneResults: SceneClip[];
  residualsBySegment: Record<number, number>;
  /** Cumulative end-time (seconds) of every segment EXCEPT the last, within
   * the concatenated narrator track's own timeline — the interior cut points
   * CompositeNarratorOverlay (qm-dialogue-mix) fades across (§3.4's
   * fadeFrames). Step Functions has no running-sum intrinsic, so this rides
   * along on the one Lambda that already has segmentResults in order. */
  segmentBoundariesSeconds: number[];
}

const NOOP_THRESHOLD_S = 0.05;

export const handler = async (event: ReconcileEvent): Promise<ReconcileResult> => {
  let out = [...event.sceneResults];
  const residualsBySegment: Record<number, number> = {};

  for (const seg of event.segmentResults) {
    const clips = out.filter(c => c.segmentIndex === seg.segmentIndex);
    if (clips.length === 0) continue; // segment failed upstream — nothing to reconcile against
    // A segment whose narrator generation failed upstream (NarratorSegmentFailed's
    // {failed:true, error, segmentIndex} pass-through) carries no actualDurationSeconds —
    // without this guard, `residual` becomes NaN and retarget() below feeds ffmpeg a
    // literal "-t NaN", crashing the whole execution instead of degrading gracefully
    // the way a failed scene frame already does above (confirmed live 2026-08-09).
    if (typeof seg.actualDurationSeconds !== 'number' || Number.isNaN(seg.actualDurationSeconds)) continue;

    const dScenes = clips.reduce((sum, c) => sum + c.duration, 0);
    const residual = seg.actualDurationSeconds - dScenes;
    residualsBySegment[seg.segmentIndex] = residual;
    if (Math.abs(residual) < NOOP_THRESHOLD_S) continue;

    const lastIdx = clips.findIndex(c => c.isSegmentLastFrame);
    if (lastIdx === -1) {
      // Contract violation (every segment must mark exactly one clip) — fail
      // loud rather than silently reconciling against the wrong clip.
      throw new Error(`reconcile-segment-timing: segment ${seg.segmentIndex} has no clip with isSegmentLastFrame:true`);
    }

    if (residual < 0) {
      const target = Math.max(0.5, clips[lastIdx].duration + residual);
      const corrected = await retarget(clips[lastIdx], target, event.outputKeyPrefix, 'trim');
      out = replaceClip(out, corrected);
      continue;
    }

    // residual > 0 (extend). Overrun exceeds one whole scene -> distribute
    // across the last two clips of THIS segment rather than stretching one
    // clip implausibly long.
    const secondLastIdx = lastIdx - 1;
    if (residual > clips[lastIdx].duration && secondLastIdx >= 0) {
      const half = residual / 2;
      for (const idx of [secondLastIdx, lastIdx]) {
        const extension = Math.min(half, clips[idx].duration); // cap at ~2x original
        const corrected = await retarget(clips[idx], clips[idx].duration + extension, event.outputKeyPrefix, 'extend');
        out = replaceClip(out, corrected);
      }
      continue;
    }

    const target = clips[lastIdx].duration + residual;
    const corrected = await retarget(clips[lastIdx], target, event.outputKeyPrefix, 'extend');
    out = replaceClip(out, corrected);
  }

  const orderedSegments = [...event.segmentResults].sort((a, b) => a.segmentIndex - b.segmentIndex);
  const segmentBoundariesSeconds: number[] = [];
  let cursor = 0;
  for (let i = 0; i < orderedSegments.length - 1; i++) {
    const seg = orderedSegments[i];
    // Same failed-upstream-segment case as the loop above — fall back to the
    // segment's (reconciled) scene duration so one failed segment doesn't
    // NaN-poison every boundary after it.
    const segDuration = typeof seg.actualDurationSeconds === 'number' && !Number.isNaN(seg.actualDurationSeconds)
      ? seg.actualDurationSeconds
      : out.filter(c => c.segmentIndex === seg.segmentIndex).reduce((sum, c) => sum + c.duration, 0);
    cursor += segDuration;
    segmentBoundariesSeconds.push(cursor);
  }

  return { sceneResults: out, residualsBySegment, segmentBoundariesSeconds };
};

function replaceClip(clips: SceneClip[], corrected: SceneClip): SceneClip[] {
  return clips.map(c => (c.frameId === corrected.frameId ? corrected : c));
}

async function retarget(
  clip: SceneClip, targetSeconds: number, outputKeyPrefix: string, mode: 'trim' | 'extend',
): Promise<SceneClip> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
  const inputPath = path.join(workDir, 'input.mp4');
  const outputPath = path.join(workDir, 'output.mp4');
  const outputKey = `${outputKeyPrefix}/${clip.frameId}_${mode}.mp4`;

  try {
    await download(clip.videoUrl, inputPath);

    const args = mode === 'trim'
      // Plain cut, no re-encode — the clip is already long enough.
      ? ['-y', '-i', inputPath, '-t', targetSeconds.toFixed(3), '-c', 'copy', outputPath]
      // Loop the clip's own motion to reach the target length (not a frozen
      // last frame, not audio-truncated — scene clips are silent anyway).
      : ['-y', '-stream_loop', '-1', '-i', inputPath, '-t', targetSeconds.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-an', outputPath];

    const { status, stderr } = run(args);
    if (status !== 0) throw new Error(`ffmpeg ${mode} failed: ${stderr.slice(-1500)}`);

    const finalDuration = getDuration(outputPath) || targetSeconds;
    const url = await uploadFile(outputPath, outputKey, 'video/mp4');

    return { ...clip, videoUrl: url, duration: finalDuration };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
