/**
 * Shot contract schema tests (prompt harness plan §4).
 */
import { ShotContractSchema, primarySubject, secondarySubjects, withContract } from '../src/harness/contract';
import { validContract } from './helpers/harness-fixtures';

describe('ShotContractSchema', () => {
  it('parses a valid contract', () => {
    expect(ShotContractSchema.safeParse(validContract()).success).toBe(true);
  });

  it('rejects an unknown camera move', () => {
    const bad = { ...validContract(), camera: { ...validContract().camera, move: 'dolly_zoom' } };
    expect(ShotContractSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a subject with zero count', () => {
    const bad = validContract();
    bad.subjects[0].count = 0;
    expect(ShotContractSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects unknown top-level fields (.strict())', () => {
    const bad = { ...validContract(), extra: 'nope' };
    expect(ShotContractSchema.safeParse(bad).success).toBe(false);
  });
});

describe('primarySubject / secondarySubjects', () => {
  it('finds the primary subject by action.subjectId', () => {
    const c = validContract({
      subjects: [
        { id: 'kitten', kind: 'animal', count: 1, position: 'background', detail: 'a tabby kitten' },
        { id: 'maya', kind: 'character', count: 1, position: 'center', facing: 'camera' },
      ],
      action: { subjectId: 'maya', verb: 'reaches', screenDirection: 'none', motionLevel: 'low', ambient: [] },
    });
    expect(primarySubject(c)?.id).toBe('maya');
    expect(secondarySubjects(c).map((s) => s.id)).toEqual(['kitten']);
  });

  it('falls back to subjects[0] when subjectId matches nothing', () => {
    const c = validContract({ action: { ...validContract().action, subjectId: 'nobody' } });
    expect(primarySubject(c)?.id).toBe('maya');
  });
});

describe('withContract', () => {
  it('produces a fresh, still-valid contract without mutating the input', () => {
    const original = validContract();
    const updated = withContract(original, (d) => {
      d.camera.move = 'static';
    });
    expect(original.camera.move).toBe('push_in');
    expect(updated.camera.move).toBe('static');
    expect(updated).not.toBe(original);
  });
});
