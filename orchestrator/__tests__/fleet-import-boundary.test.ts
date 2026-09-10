/**
 * Structural enforcement of impl plan §6.3: "the only component in the
 * system permitted to change an endpoint's worker counts... enforce that
 * structurally, not just socially." Greps every non-test source file for
 * `.patchWorkers(` and fails if anything outside agents/fleet.ts or
 * watchdog.ts calls it. watchdog.ts is the one other legitimate caller —
 * its emergency auto-drain path (WATCHDOG_AUTODRAIN, off by default, §6.9) —
 * not a third owner of normal worker-count changes.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC_DIR = join(__dirname, '../src');

function allTsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return allTsFiles(full);
    return entry.endsWith('.ts') ? [full] : [];
  });
}

describe('fleet controller import boundary', () => {
  it('only agents/fleet.ts and watchdog.ts call runpod.patchWorkers(...)', () => {
    const offenders: string[] = [];
    for (const file of allTsFiles(SRC_DIR)) {
      if (file.endsWith('agents/fleet.ts') || file.endsWith('watchdog.ts') || file.endsWith('runpod/client.ts')) continue; // the definition itself
      const content = readFileSync(file, 'utf8');
      if (/\.patchWorkers\(/.test(content)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
