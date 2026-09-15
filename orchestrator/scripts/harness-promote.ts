/**
 * `npm run harness:promote` — the offline half of the findings->guardrails
 * workflow (implementation plan §9.3). Reads `harness_findings`/
 * `harness_corrections` from the live DB, writes `proposed` guardrail rows
 * for recurring uncovered failures, and prints a correction-outcome report.
 * Proposed rows are inert (guardrails/store.ts only loads 'active'/
 * 'probation') until an operator reviews and activates one — see
 * `POST /v1/harness/guardrails/:id/:version/activate`.
 */
import { loadConfig } from '../src/config';
import { initPool, getPool, closePool } from '../src/db/pool';
import { runPromotion } from '../src/harness/learn/promote';

async function main(): Promise<void> {
  const cfg = loadConfig();
  initPool(cfg);
  try {
    const report = await runPromotion(getPool());
    console.log(`Proposed ${report.proposed.length} new guardrail(s):`);
    for (const g of report.proposed) console.log(`  ${g.id} (${g.domain}/${g.profile}): ${g.instruction}`);
    console.log(`\nCorrection outcome stats (last 30 days):`);
    for (const s of report.correctionStats) {
      const rate = s.total > 0 ? ((s.passed / s.total) * 100).toFixed(0) : 'n/a';
      console.log(`  ${s.guardrailId ?? '(uncovered)'} / ${s.measureType}: ${s.passed}/${s.total} passed (${rate}%)`);
    }
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
