/**
 * `npm run harness:lint -- <request.json> [--profile wan2-lightning]`
 *
 * Offline dry run of the prompt harness (implementation plan §6.1, H1):
 * loads a §9.1-shaped request from disk, runs the same per-frame pipeline
 * `prepareCohort()` uses, and prints a per-frame report — no DB, no
 * cohort/project rows, no writes. Useful for iterating on guardrails
 * against real past requests (harness/learn/promote.ts's replay uses the
 * same `lintRequest()` entry point over a batch instead of one file).
 *
 * Needs REPLICATE_API_TOKEN in the environment for contract extraction and
 * the regenerate tool; a request whose every frame already carries
 * `shot` runs with zero network calls.
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config';
import { RequestSchema } from '../src/agents/planner';
import { lintRequest } from '../src/harness';

function main(): void {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: npm run harness:lint -- <request.json>');
    process.exit(1);
  }
  const cfg = loadConfig();
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success) {
    console.error('invalid request:', JSON.stringify(parsed.error.issues, null, 2));
    process.exit(1);
  }

  lintRequest(
    {
      replicate: {
        apiToken: cfg.replicateApiToken,
        apiBase: cfg.replicateApiBase,
        timeoutMs: cfg.replicateTimeoutMs,
        visionModel: cfg.replicateVisionModel,
        visionModelFallback: cfg.replicateVisionModelFallback,
        pollIntervalMs: cfg.replicatePollIntervalMs,
        maxPollAttempts: cfg.replicateMaxPollAttempts,
      },
      extractCfg: { model: cfg.replicateRewriteModel, reasoningEffort: cfg.replicateRewriteReasoning },
      regenerateCfg: { model: cfg.replicateRewriteModel, reasoningEffort: cfg.replicateRewriteReasoning },
      // No `pool` — dry run never consults learned/promoted guardrails,
      // seed set only.
    },
    parsed.data,
  )
    .then((results) => {
      let totalFindings = 0;
      for (const { frameId, output } of results) {
        console.log(`\n=== ${frameId} ===`);
        if (output.harnessError) {
          console.log(`  harness error: ${output.harnessError}`);
          continue;
        }
        console.log(`  splitShot: ${output.splitShot}  imageFallbackRung: ${output.imageFallbackRung ?? '-'}  motionFallbackRung: ${output.motionFallbackRung ?? '-'}`);
        console.log(`  imagePrompt: ${output.imagePrompt}`);
        console.log(`  motionPrompt: ${output.motionPrompt}`);
        if (output.findings.length) {
          totalFindings += output.findings.length;
          for (const f of output.findings) console.log(`  finding [${f.guardrailId ?? 'uncovered'}] ${f.signature}: ${f.message}`);
        }
      }
      console.log(`\n${results.length} frames, ${totalFindings} lint findings.`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

main();
