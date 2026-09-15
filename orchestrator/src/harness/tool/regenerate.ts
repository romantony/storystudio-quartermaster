/**
 * GPT-5 mini regenerate tool (prompt harness plan §8). Replaces
 * quality/rewrite.ts's per-failure LLM rewrite for any frame the harness
 * has a contract for: instead of "rewrite this prompt from the defect", the
 * tool gets the CONTRACT (ground truth), the compiled DRAFT (always
 * lint-clean), the open VIOLATIONS, and the active GUARDRAILS — and must
 * satisfy the same deterministic lint the draft already passes, plus add no
 * words the contract/draft don't license (I-REW-01/V-REW-01). Any failure —
 * API error, bad JSON, still-dirty lint, invented detail — returns
 * `undefined` so the caller falls back to the compiled draft. A rewrite
 * outage or a bad model output must never block generation.
 */
import type { ShotContract } from '../contract';
import { lintImage, type ImageLintContext } from '../lint/image';
import { lintVideo, type VideoLintContext } from '../lint/video';
import type { Domain, Guardrail, Violation } from '../guardrails/types';
import { runReplicateText, type ReplicateDeps } from '../../quality/replicate';
import { log } from '../../telemetry/log';

export interface RegenerateInput {
  domain: Domain;
  targetProfile: string; // model label, e.g. 'Wan 2.2 image-to-video, 4-step Lightning distillation, 480p'
  videoProfile?: string; // capability-profile key, e.g. 'wan2-lightning' — video domain only
  contract: ShotContract;
  draft: string;
  violations: Violation[];
  guardrails: Guardrail[];
  imageUrl?: string;
  examples?: Array<{ before: string; after: string }>;
}

interface ToolJson {
  prompt?: unknown;
  applied_guardrails?: unknown;
}

const IMAGE_TOOL_SYSTEM = `You regenerate a text-to-image / image-edit prompt so it satisfies a fixed set of guardrails.
You receive: a SHOT CONTRACT (the ground truth — counts, facing, camera side, shot size, angle, positions),
a DRAFT prompt compiled from it, the VIOLATIONS still open, and the GUARDRAILS (id + instruction).
Rules:
1. The contract is authoritative. Do not add, remove or change subjects, props, counts, facing, camera side, shot size, angle, or setting.
2. Do not add any detail that is not in the contract or the draft: no new objects, body parts, measurements, textures, or adjectives of your own.
3. Resolve every violation. Follow every guardrail instruction.
4. State everything positively. Never write "avoid", "no", "without", or "not" followed by a defect.
5. Start with shot size and camera angle. Keep "the girl from the reference image" anchor exactly once if present in the draft.
6. Plain words, present tense, one paragraph, at most 110 words.
Return JSON only: {"prompt": "...", "applied_guardrails": ["I-..."]}`;

const VIDEO_TOOL_SYSTEM = `You regenerate an image-to-video MOTION prompt for {targetProfile}, so it satisfies a fixed set of guardrails.
The clip starts from a fixed source image; the camera side, camera angle, shot size, facing and the people present are already fixed by that image.
Rules:
1. The contract is authoritative. Keep exactly its one camera move, its one primary action, its screen direction, its facing and its angle.
2. Begin with the camera move and speed, then shot size and angle.
3. Describe subject movement only in screen terms: toward the camera, away from the camera, screen-left, screen-right.
4. Mention only subjects in the contract. Ambient motion (dust, light, hair, cloth, water) only if listed in the contract.
5. End with the lock sentence from the draft, unchanged.
6. Do not add detail. Plain verbs, present tense, 12 to 45 words. Never write "avoid", "no", "without" followed by a defect.
Return JSON only: {"prompt": "...", "applied_guardrails": ["V-..."]}`;

function buildUserMessage(input: RegenerateInput): string {
  const violationLines = input.violations.map((v) => `- [${v.guardrailId}] ${v.message}`).join('\n') || '(none — improve wording only)';
  const guardrailLines = input.guardrails.map((g) => `- [${g.id}] (${g.severity}) ${g.instruction}`).join('\n');
  const exampleLines = (input.examples ?? [])
    .slice(0, 3)
    .map((e, i) => `Example ${i + 1}:\nBEFORE: ${e.before}\nAFTER: ${e.after}`)
    .join('\n\n');
  return [
    `SHOT CONTRACT:\n${JSON.stringify(input.contract)}`,
    `DRAFT:\n${input.draft}`,
    `VIOLATIONS:\n${violationLines}`,
    `GUARDRAILS:\n${guardrailLines}`,
    exampleLines ? `APPROVED EXAMPLES:\n${exampleLines}` : '',
    'Return the corrected prompt as JSON.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function parseToolJson(text: string): ToolJson | undefined {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  const candidate = fence ? fence[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return undefined;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

function lintCandidate(domain: Domain, candidate: string, input: RegenerateInput): { violations: Violation[]; blocking: boolean } {
  if (domain === 'image') {
    const ctx: ImageLintContext = { contract: input.contract, imagePrompt: candidate, draft: input.draft };
    return lintImage(ctx, input.guardrails);
  }
  const ctx: VideoLintContext = {
    contract: input.contract,
    motionPrompt: candidate,
    imagePrompt: '',
    profile: input.videoProfile ?? 'wan2-lightning',
    draft: input.draft,
  };
  return lintVideo(ctx, input.guardrails);
}

/**
 * One regenerate attempt (up to 2 tries, matching plan §8.3). Returns the
 * validated prompt, or `undefined` if the tool never produced a lint-clean,
 * no-new-words candidate — the caller must fall back to `input.draft`.
 */
export async function regeneratePrompt(
  deps: ReplicateDeps,
  cfg: { model: string; reasoningEffort: string },
  input: RegenerateInput,
): Promise<string | undefined> {
  const systemPrompt = input.domain === 'image' ? IMAGE_TOOL_SYSTEM : VIDEO_TOOL_SYSTEM.replace('{targetProfile}', input.targetProfile);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await runReplicateText(deps, cfg.model, {
        system_prompt: systemPrompt,
        prompt: buildUserMessage(input),
        image_input: input.imageUrl ? [input.imageUrl] : [],
        reasoning_effort: cfg.reasoningEffort,
        verbosity: 'low',
        max_completion_tokens: 4000,
      });
      const parsed = parseToolJson(text);
      const candidate = typeof parsed?.prompt === 'string' ? parsed.prompt.trim() : undefined;
      if (!candidate || candidate.length < 8) {
        log().warn({ domain: input.domain, attempt, raw: text.slice(0, 200) }, 'harness: regenerate tool returned no usable prompt');
        continue;
      }
      const lint = lintCandidate(input.domain, candidate, input);
      if (lint.blocking || lint.violations.some((v) => v.severity === 'fix')) {
        log().warn(
          { domain: input.domain, attempt, violations: lint.violations.map((v) => v.guardrailId) },
          'harness: regenerate tool output still fails lint',
        );
        continue;
      }
      return candidate;
    } catch (err) {
      log().warn({ domain: input.domain, attempt, err }, 'harness: regenerate tool call failed');
    }
  }
  return undefined;
}
