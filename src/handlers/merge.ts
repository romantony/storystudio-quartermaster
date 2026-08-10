import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  download, FFMPEG, getDuration, getSampleRate, parseDurationFromStderr, run, uploadFile,
} from '../shared/ffmpeg-io';

/** additive mixMode needs an existing `0:a` stream to mix into — an action
 * shot with no narration VO is still silent (Wan2 has no audio at all) even
 * on the "common tail," so this falls back to plain replace behavior rather
 * than erroring on a nonexistent audio stream. */
function hasAudioStream(input: string): boolean {
  const r = spawnSync(FFMPEG, ['-i', input], { maxBuffer: 1024 * 1024 * 16 });
  return /Stream .* Audio:/.test(r.stderr?.toString() ?? '');
}

/**
 * QM-merge — audio+video mux for the narration-basic per-frame pipeline
 * (video.narrationBasic.merge / video.narrationPremium.merge alias),
 * replacing the RunPod flux-tts-s2t pod's `run_merge()`. Merge is pure
 * ffmpeg muxing (no model inference) — it was only ever on the GPU pod for
 * convenience, and moving it here removes it entirely from the shared
 * 6-worker pool it used to compete with image/TTS/animate for (found live
 * 2026-07-27: merge x4-per-frame was one of the two biggest concurrent
 * fan-outs against that pool, alongside TTS x4, and a real contributor to
 * that day's execution timeouts).
 *
 * Also finally fixes the long-flagged "Bug #6" padding gap: RunPod's
 * `run_merge()` hardcoded ffmpeg's `-shortest` flag, which always trims to
 * the SHORTER of video/audio — wrong for fourLang, where a language whose
 * TTS came in shorter than the frame's shared max-across-4-languages video
 * needs its AUDIO padded with trailing silence, not the video trimmed. That
 * fix was blocked for months behind flux4B-Wan2's untracked-repo deploy
 * friction; owning merge here removes that blocker entirely.
 *
 * Single ffmpeg invocation handles both cases uniformly via `apad`'s
 * `whole_dur` option (pads audio with silence up to a target duration,
 * no-op if audio is already >= that duration) combined with an output `-t`
 * cap: `durationS` present -> target = durationS (pad shorter audio, matches
 * fourLangMergeBranch's frame-shared-max-duration use); `durationS` absent
 * -> target = min(videoDuration, audioDuration), reproducing the legacy
 * `-shortest` trim-to-shorter behavior other (non-fourLang) callers rely on.
 */

interface MergeEvent {
  videoUrl: string;
  audioUrl: string;
  /** Target duration in seconds. Present (fourLang per-frame): pad shorter
   * audio with trailing silence to reach it. Absent: trim to the shorter of
   * video/audio (legacy -shortest behavior). Ignored when mixMode==='additive'
   * (the video's own audio duration is always canonical there). */
  durationS?: number;
  /** 'replace' (default): audioUrl REPLACES the video's own audio track,
   * same as always. 'additive': audioUrl is MIXED in on top of the video's
   * EXISTING audio (amix, not apad) — Dialogue Premium's QMMixShotAudio
   * layering a spot SFX over a shot that already carries dialogue/narration
   * audio (storystudio-dialogue-qm-sfn-handoff.md §8). */
  mixMode?: 'replace' | 'additive';
  outputKey: string;
}

interface MergeResult {
  cdnUrl: string;
  durationS: number;
}

export const handler = async (event: MergeEvent): Promise<MergeResult> => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
  const videoPath = path.join(workDir, 'video.mp4');
  const audioPath = path.join(workDir, 'audio.in');
  const outputPath = path.join(workDir, 'output.mp4');

  try {
    await Promise.all([download(event.videoUrl, videoPath), download(event.audioUrl, audioPath)]);

    const videoDuration = getDuration(videoPath);

    let filter: string;
    let target: number;
    if (event.mixMode === 'additive' && hasAudioStream(videoPath)) {
      // Mix audioUrl IN ON TOP of the video's own existing audio (a spot SFX
      // over dialogue/narration that's already there) rather than replacing
      // it — normalize=0 so ffmpeg doesn't attenuate every input by 1/n
      // (same amix gotcha as the dialogue-mix ECS task's ambience-bed mix).
      // The video's own audio duration is canonical; the SFX clip is
      // typically much shorter and just plays under it.
      filter = '[0:a][1:a]amix=inputs=2:duration=first:normalize=0[aout]';
      target = videoDuration;
    } else {
      const audioProbe = run(['-i', audioPath, '-f', 'null', '-']);
      const audioDuration = parseDurationFromStderr(audioProbe.stderr);
      const sampleRate = getSampleRate(audioProbe.stderr);
      target = event.durationS ?? Math.min(videoDuration, audioDuration);

      // Always pad by a fixed, generous sample count (a full minute of
      // silence) rather than computing the exact gap — the `-t target` output
      // cap below trims it to the exact right length either way, so this
      // works uniformly for both the pad case (audio shorter than target) and
      // the trim case (audio already >= target, where the padding is simply
      // never reached before the cutoff).
      const padLenSamples = sampleRate * 60;
      filter = `[1:a]apad=pad_len=${padLenSamples}[aout]`;
    }

    const { status, stderr } = run([
      '-y', '-i', videoPath, '-i', audioPath,
      '-filter_complex', filter,
      '-map', '0:v:0', '-map', '[aout]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
      '-t', target.toFixed(3),
      outputPath,
    ]);
    if (status !== 0) throw new Error(`ffmpeg merge failed: ${stderr.slice(-1500)}`);

    const finalDuration = getDuration(outputPath) || target;
    const url = await uploadFile(outputPath, event.outputKey, 'video/mp4');

    return { cdnUrl: url, durationS: finalDuration };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};
