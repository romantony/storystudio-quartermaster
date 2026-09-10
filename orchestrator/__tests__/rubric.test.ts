/**
 * Pure unit tests for quality/rubric.ts — no mocks, no I/O (same contract
 * as steps/builders/*.ts). Given a fixture VLM JSON response, assert the
 * weighted-sum computation and the PASS/REWORK/FAIL threshold buckets.
 */
import { scoreImage, scoreVideo, isVideoGatedByImageScore, videoGatedResult, IMAGE_QA_WEIGHTS, VIDEO_QA_WEIGHTS } from '../src/quality/rubric';

const IMAGE_THRESHOLDS = { passThreshold: 8.0, reviewThreshold: 7.0 };
const VIDEO_THRESHOLDS = { gateThreshold: 7.5, passThreshold: 5.0, reviewThreshold: 5.0 };

function allDimsAt(weights: Record<string, number>, value: number): Record<string, number> {
  return Object.fromEntries(Object.keys(weights).map((k) => [k, value]));
}

describe('scoreImage', () => {
  it('computes the weighted sum from IMAGE_QA_WEIGHTS', () => {
    const result = scoreImage({ scores: allDimsAt(IMAGE_QA_WEIGHTS, 9), issues: [], summary: 'ok' }, IMAGE_THRESHOLDS);
    expect(result.weightedScore).toBe(9);
  });

  it('buckets >= passThreshold as PASS', () => {
    const result = scoreImage({ scores: allDimsAt(IMAGE_QA_WEIGHTS, 8.5), issues: [], summary: '' }, IMAGE_THRESHOLDS);
    expect(result.passStatus).toBe('PASS');
  });

  it('buckets between reviewThreshold and passThreshold as REWORK', () => {
    const result = scoreImage({ scores: allDimsAt(IMAGE_QA_WEIGHTS, 7.5), issues: [], summary: '' }, IMAGE_THRESHOLDS);
    expect(result.passStatus).toBe('REWORK');
  });

  it('buckets below reviewThreshold as FAIL', () => {
    const result = scoreImage({ scores: allDimsAt(IMAGE_QA_WEIGHTS, 2), issues: [], summary: '' }, IMAGE_THRESHOLDS);
    expect(result.passStatus).toBe('FAIL');
  });

  it('a heavy hallucination_control penalty drags the weighted score down regardless of other dims', () => {
    const scores = { ...allDimsAt(IMAGE_QA_WEIGHTS, 10), hallucination_control: 1 };
    const result = scoreImage({ scores, issues: [], summary: '' }, IMAGE_THRESHOLDS);
    // hallucination_control is weighted 0.30 — even at 1.0 it can't fail the
    // whole image alone (10*0.70 + 1*0.30 = 7.3), which itself confirms the
    // real production defect this rubric was built to catch needs the LLM
    // to also mark OTHER dims down, not just hallucination_control — worth
    // knowing, not a bug in the math.
    expect(result.weightedScore).toBeCloseTo(7.3, 2);
    expect(result.passStatus).toBe('REWORK');
  });
});

describe('scoreVideo', () => {
  it('computes the weighted sum from VIDEO_QA_WEIGHTS', () => {
    const result = scoreVideo({ scores: allDimsAt(VIDEO_QA_WEIGHTS, 7), issues: [], summary: '' }, VIDEO_THRESHOLDS);
    expect(result.weightedScore).toBe(7);
  });

  it('PASS and REWORK thresholds are equal by design — REWORK tier is collapsed, never reachable', () => {
    // Ported verbatim from config.py's QA_VIDEO_REVIEW_THRESHOLD comment.
    const justAbove = scoreVideo({ scores: allDimsAt(VIDEO_QA_WEIGHTS, 5.01), issues: [], summary: '' }, VIDEO_THRESHOLDS);
    const exact = scoreVideo({ scores: allDimsAt(VIDEO_QA_WEIGHTS, 5.0), issues: [], summary: '' }, VIDEO_THRESHOLDS);
    const below = scoreVideo({ scores: allDimsAt(VIDEO_QA_WEIGHTS, 4.99), issues: [], summary: '' }, VIDEO_THRESHOLDS);
    expect(justAbove.passStatus).toBe('PASS');
    expect(exact.passStatus).toBe('PASS');
    expect(below.passStatus).toBe('FAIL');
  });
});

describe('isVideoGatedByImageScore / videoGatedResult', () => {
  it('gates the video VLM call when the image score is below the gate threshold', () => {
    expect(isVideoGatedByImageScore(6.0, VIDEO_THRESHOLDS)).toBe(true);
    expect(isVideoGatedByImageScore(8.0, VIDEO_THRESHOLDS)).toBe(false);
  });

  it('videoGatedResult reports GATED with no score, not a FAIL', () => {
    const result = videoGatedResult(6.0, VIDEO_THRESHOLDS);
    expect(result.passStatus).toBe('GATED');
    expect(result.gatedOut).toBe(true);
    expect(result.weightedScore).toBeNull();
  });
});
