/**
 * Deterministic motion probe client (prompt harness plan §7.4). Calls
 * postprod-lite's `motion_probe` mode — Farnebäck optical flow + person
 * detection, the same motion-scoring family Movie Gen used to filter its
 * training data (§3.2.1) — so the executed camera move and subject
 * direction can be checked independently of the VLM, which is what keeps
 * the motion gate working through an outage like the 2026-09-15 Replicate
 * Gemini video-eval E001 incident.
 *
 * IMPORTANT — deployment status: `motion_probe` is a NEW postprod-lite mode
 * that does not exist on the deployed image as of this harness build (the
 * Python side lives in the separate flux4B-Wan2/postprod-lite repo and
 * needs its own build+push+endpoint-refresh, same pattern as DreamX/MMAudio
 * — see docs/TODO.md). Until that ships, every call here fails and is
 * treated as "probe unavailable" — the video ladder (correct/video-ladder.ts)
 * falls back to VLM-only signatures, exactly as if the probe had timed out.
 * This client is real and ready for that endpoint the moment it exists.
 */
import type { RunpodClient } from '../../runpod/client';
import type { CameraMove, ScreenDir, ShotContract } from '../contract';
import { primarySubject } from '../contract';
import { log } from '../../telemetry/log';

export interface MotionProbeResult {
  camera: { move: CameraMove | 'unknown'; confidence: number; tx: number; ty: number; scale: number };
  subject: { direction: ScreenDir | 'unknown'; confidence: number; boxGrowth: number };
  personsMax: number;
  frozen: boolean;
  warpScore: number;
}

interface RawProbeOutput {
  camera?: { move?: string; confidence?: number; tx?: number; ty?: number; scale?: number };
  subject?: { direction?: string; confidence?: number; box_growth?: number };
  persons_max?: number;
  frozen?: boolean;
  warp_score?: number;
}

const VALID_MOVES = new Set<string>([
  'static',
  'push_in',
  'pull_out',
  'zoom_in',
  'zoom_out',
  'pan_left',
  'pan_right',
  'truck_left',
  'truck_right',
  'tilt_up',
  'tilt_down',
  'pedestal_up',
  'pedestal_down',
  'arc',
  'tracking',
  'handheld',
]);
const VALID_DIRECTIONS = new Set<string>(['toward_camera', 'away_from_camera', 'screen_left', 'screen_right', 'up', 'down', 'none']);

function parseResult(raw: RawProbeOutput): MotionProbeResult {
  return {
    camera: {
      move: raw.camera?.move && VALID_MOVES.has(raw.camera.move) ? (raw.camera.move as CameraMove) : 'unknown',
      confidence: raw.camera?.confidence ?? 0,
      tx: raw.camera?.tx ?? 0,
      ty: raw.camera?.ty ?? 0,
      scale: raw.camera?.scale ?? 1,
    },
    subject: {
      direction: raw.subject?.direction && VALID_DIRECTIONS.has(raw.subject.direction) ? (raw.subject.direction as ScreenDir) : 'unknown',
      confidence: raw.subject?.confidence ?? 0,
      boxGrowth: raw.subject?.box_growth ?? 0,
    },
    personsMax: raw.persons_max ?? 1,
    frozen: raw.frozen ?? false,
    warpScore: raw.warp_score ?? 0,
  };
}

export interface MotionProbeDeps {
  runpod: Pick<RunpodClient, 'run' | 'status'>;
  endpointId: string;
  pollIntervalMs: number;
  maxPollAttempts: number;
  sleepImpl?: (ms: number) => Promise<void>;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Best-effort: any failure (endpoint missing, timeout, malformed output)
 * returns `undefined` rather than throwing — a probe outage must never
 * block the motion gate, same contract as quality/replicate.ts's VLM call
 * failures (recordEvalFailure), but even softer: no retry budget is spent,
 * since the ladder can fall back to VLM-only signatures immediately. */
export async function runMotionProbe(deps: MotionProbeDeps, videoUrl: string): Promise<MotionProbeResult | undefined> {
  const sleep = deps.sleepImpl ?? defaultSleep;
  try {
    const submitted = await deps.runpod.run(deps.endpointId, { mode: 'motion_probe', video_url: videoUrl, sample_fps: 4, person_detect: true });
    if (!submitted.id) return undefined;
    for (let i = 0; i < deps.maxPollAttempts; i++) {
      const status = await deps.runpod.status(deps.endpointId, submitted.id);
      if (status.status === 'COMPLETED') return parseResult((status.output ?? {}) as RawProbeOutput);
      if (status.status === 'FAILED' || status.status === 'CANCELLED') {
        log().warn({ endpointId: deps.endpointId, status: status.status }, 'harness: motion probe job failed');
        return undefined;
      }
      await sleep(deps.pollIntervalMs);
    }
    log().warn({ endpointId: deps.endpointId }, 'harness: motion probe timed out');
    return undefined;
  } catch (err) {
    log().warn({ endpointId: deps.endpointId, err }, 'harness: motion probe call failed (endpoint may not support motion_probe yet)');
    return undefined;
  }
}

export interface ProbeComparison {
  moveMatches: boolean | 'unknown';
  directionMatches: boolean | 'unknown';
  personEntry: boolean;
  frozenMismatch: boolean;
}

/** Deterministic comparison against the contract — no VLM involved. Used to
 * classify findings (learn/signatures.ts) and to gate camera-only reworks
 * on probe/VLM agreement (plan §7.4). */
export function compareProbeToContract(probe: MotionProbeResult, contract: ShotContract): ProbeComparison {
  const primary = primarySubject(contract);
  return {
    moveMatches: probe.camera.move === 'unknown' ? 'unknown' : probe.camera.move === contract.camera.move,
    directionMatches:
      probe.subject.direction === 'unknown' || contract.action.screenDirection === 'none'
        ? 'unknown'
        : probe.subject.direction === contract.action.screenDirection,
    personEntry: probe.personsMax > contract.subjects.filter((s) => s.kind === 'character').reduce((n, s) => n + s.count, 0),
    frozenMismatch: probe.frozen && contract.action.motionLevel !== 'low' && !!primary,
  };
}
