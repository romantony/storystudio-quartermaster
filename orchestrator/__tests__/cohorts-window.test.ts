/**
 * `windowId`/`windowBounds` — the deterministic tumbling-window formula
 * (impl plan §6.1), used inline by POST /v1/requests until the real
 * window scheduler lands in M6.
 */
import { windowId, windowBounds } from '../src/db/repo/cohorts';

describe('windowId', () => {
  it('formats win_YYYY_MM_DD_HH in UTC', () => {
    expect(windowId(new Date('2026-09-01T18:23:00Z'))).toBe('win_2026_09_01_18');
  });

  it('two timestamps in the same 6-hour window produce the same id', () => {
    expect(windowId(new Date('2026-09-01T12:00:01Z'))).toBe(windowId(new Date('2026-09-01T17:59:59Z')));
  });

  it('crossing a window boundary changes the id', () => {
    expect(windowId(new Date('2026-09-01T11:59:59Z'))).not.toBe(windowId(new Date('2026-09-01T12:00:00Z')));
  });
});

describe('windowBounds', () => {
  it('rounds down to the nearest 6-hour boundary and spans exactly 6 hours', () => {
    const { opensAt, closesAt } = windowBounds(new Date('2026-09-01T14:37:00Z'));
    expect(opensAt.toISOString()).toBe('2026-09-01T12:00:00.000Z');
    expect(closesAt.toISOString()).toBe('2026-09-01T18:00:00.000Z');
  });
});
