import { orderRungs, isInternalRung, rungKey } from '../src/handlers/router';
import type { Rung } from '../src/types';

const internal = (counterKey: string): Rung => ({
  provider: 'runpod', model: 'flux-klein-4b', mode: 'image',
  endpointId: 'rnqxi6c0mlq517', counterKey, routingMode: 'direct', lane: 'rest',
});
const external = (model: string): Rung => ({
  provider: 'kie', model, endpoint: 'v1/jobs/createTask', routingMode: 'aggregated', lane: 'rest', fb: true,
});

const CK = 'runpod:flux-tts-s2t';

describe('isInternalRung / rungKey', () => {
  it('identifies internal RunPod rungs by endpointId', () => {
    expect(isInternalRung(internal(CK))).toBe(true);
    expect(isInternalRung(external('google/nano-banana'))).toBe(false);
    // runpod without endpointId (legacy infinitetalk) is not "internal-managed"
    expect(isInternalRung({ provider: 'runpod', model: 'infinitetalk', routingMode: 'direct', lane: 'video' } as Rung)).toBe(false);
  });

  it('derives a stable key preferring endpointId', () => {
    expect(rungKey(internal(CK))).toBe('runpod:rnqxi6c0mlq517');
    expect(rungKey(external('google/nano-banana'))).toBe('kie:v1/jobs/createTask');
  });
});

describe('orderRungs', () => {
  const ladder = [internal(CK), external('google/nano-banana'), external('ideogram/v3-text-to-image')];

  it('leaves order unchanged when jobType is absent', () => {
    expect(orderRungs(ladder, undefined, {})).toEqual(ladder);
  });

  it('batch: internal rungs lead, external follow', () => {
    const out = orderRungs(ladder, 'batch', {});
    expect(out.map(r => r.provider)).toEqual(['runpod', 'kie', 'kie']);
  });

  it('realtime with warm free capacity: internal leads', () => {
    const out = orderRungs(ladder, 'realtime', { [CK]: { inflight: 2, warm: true } });
    expect(out[0].provider).toBe('runpod');
  });

  it('realtime with cold endpoint (inflight 0 / not warm): external leads, internal demoted to tail', () => {
    const out = orderRungs(ladder, 'realtime', { [CK]: { inflight: 0, warm: false } });
    expect(out[0].provider).toBe('kie');
    expect(out[out.length - 1].provider).toBe('runpod');
  });

  it('realtime with saturated endpoint (inflight ≥ max): external leads', () => {
    const out = orderRungs(ladder, 'realtime', { [CK]: { inflight: 5, warm: true } });
    expect(out[0].provider).toBe('kie');
  });

  it('returns ladder untouched when there are no internal rungs', () => {
    const extOnly = [external('a'), external('b')];
    expect(orderRungs(extOnly, 'batch', {})).toEqual(extOnly);
  });
});
