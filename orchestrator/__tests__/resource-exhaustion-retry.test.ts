/**
 * isResourceExhaustionError()/extractErrorText()/retryCeiling() — real
 * incident, 2026-09-16: this orchestrator's first live StoryStudio request
 * hit "CUDA out of memory" on 5/18 image jobs (qwen-image-gen's endpoint
 * mixes ~44GB A40/A6000 cards with 80GB A100s), both attempts exhausted the
 * flat maxAttempts=2 ceiling, permanently dropping those 5 frames from the
 * final video. A day earlier (2026-09-15, see jobs-retry.test.ts's header),
 * an almost identical CUDA OOM incident is what motivated markFailedOrRetry
 * existing at all — this raises the ceiling specifically for this failure
 * class instead of a second flat bump that would also over-retry a genuine
 * content/validation failure.
 */
import { isResourceExhaustionError, extractErrorText } from '../src/runpod/types';
import { retryCeiling } from '../src/agents/generator';

describe('isResourceExhaustionError', () => {
  it('recognizes the real CUDA OOM message from the 2026-09-16 incident', () => {
    const real =
      "CUDA out of memory. Tried to allocate 9.51 GiB. GPU 0 has a total capacity of 44.43 GiB of which 29.81 MiB is free. Process 2876051 has 44.40 GiB memory in use.";
    expect(isResourceExhaustionError(real)).toBe(true);
  });

  it('is case-insensitive and matches a bare "out of memory" without the CUDA prefix', () => {
    expect(isResourceExhaustionError('Worker killed: out of memory')).toBe(true);
    expect(isResourceExhaustionError('OUT OF MEMORY')).toBe(true);
  });

  it('does not misclassify an unrelated failure as resource-exhaustion', () => {
    expect(isResourceExhaustionError('Invalid mode \'None\'')).toBe(false);
    expect(isResourceExhaustionError('Connection timed out')).toBe(false);
  });

  it('returns false for undefined/empty text', () => {
    expect(isResourceExhaustionError(undefined)).toBe(false);
    expect(isResourceExhaustionError('')).toBe(false);
  });
});

describe('extractErrorText', () => {
  it('prefers a plain string over an object', () => {
    expect(extractErrorText('plain message', { error: 'nested' })).toBe('plain message');
  });

  it('pulls .error off an object when the first value is not a usable string', () => {
    expect(extractErrorText(undefined, { error: 'CUDA out of memory' })).toBe('CUDA out of memory');
  });

  it('falls back to .message when .error is absent', () => {
    expect(extractErrorText({ message: 'worker crashed' })).toBe('worker crashed');
  });

  it('falls back to JSON.stringify when nothing else yields text', () => {
    expect(extractErrorText({ status: 'FAILED' })).toBe('{"status":"FAILED"}');
  });

  it('returns undefined when every value is nullish', () => {
    expect(extractErrorText(undefined, null)).toBeUndefined();
  });
});

describe('retryCeiling', () => {
  const cfg = { maxAttempts: 2, maxResourceAttempts: 5 };

  it('raises the ceiling to maxResourceAttempts for a detected OOM error', () => {
    expect(retryCeiling('CUDA out of memory. Tried to allocate 9.51 GiB.', cfg)).toBe(5);
  });

  it('keeps the default maxAttempts ceiling for a non-resource failure', () => {
    expect(retryCeiling('RunPod worker health check failed', cfg)).toBe(2);
  });

  it('keeps the default ceiling when there is no error text at all', () => {
    expect(retryCeiling(undefined, cfg)).toBe(2);
  });

  it('never returns a ceiling below maxAttempts even if maxResourceAttempts were misconfigured lower', () => {
    expect(retryCeiling('out of memory', { maxAttempts: 5, maxResourceAttempts: 2 })).toBe(5);
  });
});
