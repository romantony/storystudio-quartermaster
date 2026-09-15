/**
 * QA prompt rewriter (2026-09-15). When a quality gate rejects an asset, an
 * LLM (Replicate-hosted `openai/gpt-5-mini` by default) rewrites the
 * generation prompt from the evaluator's issues, instead of the old
 * `original + " (avoid: <defect description>)"` suffix. That suffix put the
 * defect's own nouns ("two right hands", "three crystals") into the positive
 * prompt, which diffusion models tend to render — seen live on
 * win_2026_09_15_06, where f12/f13 failed image QA three times in a row.
 *
 * The rewrite keeps the scene and story beat, states the fix as positive,
 * concrete constraints (e.g. "exactly one girl, two arms, two hands"), and
 * returns only the prompt. Any failure (API error, empty output) returns
 * undefined so the caller falls back to the old correction — a rewrite
 * outage must never block rework.
 */
import type { Issue } from './rubric';
import { runReplicateText, type ReplicateDeps } from './replicate';
import { log } from '../telemetry/log';

export interface RewriteInput {
  gate: 'image' | 'motion';
  /** The prompt as originally requested. */
  originalPrompt: string;
  /** The prompt that produced the rejected asset (may already be a rewrite). */
  currentPrompt: string;
  issues: Issue[];
  summary?: string;
  /** Image gate: the rejected image. Motion gate: the source frame. */
  imageUrl?: string;
  /** Story context, so the rewrite doesn't drift off the beat. */
  narration?: string;
  /** Image-side prompt for the motion gate (what the clip starts from). */
  imagePrompt?: string;
  /** The model the next attempt will run on — the rewrite is tuned to it. */
  targetModel: string;
}

const IMAGE_SYSTEM = `You rewrite text-to-image / image-edit prompts after an automated quality check rejected the result.
Rules:
- Keep the same scene, subject, story beat, framing intent and visual style.
- If the prompt refers to a character from a reference image, keep that reference.
- Fix every reported issue by stating the correct result as POSITIVE, concrete constraints (counts, anatomy, placement), e.g. "exactly one girl", "two arms and two hands", "a single glowing crystal beside her".
- Never describe the defect itself and never write "avoid", "no", "without" followed by the defect; diffusion models render nouns they are given.
- Prefer simpler compositions when the issue is duplicated people, extra limbs or cluttered objects.
- Output ONLY the new prompt, one paragraph, at most 110 words, no quotes, no preamble.`;

const MOTION_SYSTEM = `You rewrite image-to-video motion prompts after an automated quality check rejected the generated clip.
Rules:
- The clip starts from a fixed source image; describe only camera movement and subject motion that is physically plausible from that image.
- Fix every reported issue with POSITIVE, concrete direction: one clear camera move (e.g. "slow push in", "gentle pan left"), simple continuous subject motion, the character stays the only person in frame, stable natural anatomy.
- Never describe the defect and never use "avoid", "no", "without" followed by the defect.
- Keep it short and specific: at most 45 words, no quotes, no preamble. Output ONLY the new motion prompt.`;

function buildUserMessage(input: RewriteInput): string {
  const issues = input.issues.length
    ? input.issues.map((i) => `- [${i.category ?? 'ISSUE'}] ${i.description ?? ''}`).join('\n')
    : `- ${input.summary ?? 'rejected without itemized issues'}`;
  return [
    `Target model for the next attempt: ${input.targetModel}`,
    input.narration ? `Story narration for this shot: ${input.narration}` : '',
    input.gate === 'motion' && input.imagePrompt ? `Source image was generated from: ${input.imagePrompt}` : '',
    `Original prompt: ${input.originalPrompt}`,
    input.currentPrompt !== input.originalPrompt ? `Prompt that produced the rejected result: ${input.currentPrompt}` : '',
    `Quality check issues:\n${issues}`,
    input.imageUrl ? (input.gate === 'image' ? 'The attached image is the rejected result.' : 'The attached image is the source frame of the clip.') : '',
    'Write the corrected prompt.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function cleanRewrite(text: string, maxChars: number): string | undefined {
  const cleaned = text
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^(new |corrected |rewritten )?(motion )?prompt:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < 8) return undefined;
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned;
}

export async function rewritePrompt(
  deps: ReplicateDeps,
  cfg: { model: string; reasoningEffort: string },
  input: RewriteInput,
): Promise<string | undefined> {
  try {
    const text = await runReplicateText(deps, cfg.model, {
      system_prompt: input.gate === 'image' ? IMAGE_SYSTEM : MOTION_SYSTEM,
      prompt: buildUserMessage(input),
      image_input: input.imageUrl ? [input.imageUrl] : [],
      reasoning_effort: cfg.reasoningEffort,
      verbosity: 'low',
      max_completion_tokens: 4000,
    });
    const prompt = cleanRewrite(text, input.gate === 'image' ? 900 : 400);
    if (!prompt) log().warn({ gate: input.gate, raw: text.slice(0, 200) }, 'rewrite: empty/unusable model output');
    return prompt;
  } catch (err) {
    log().warn({ gate: input.gate, err }, 'rewrite: prompt rewrite call failed, falling back to the (avoid: ...) correction');
    return undefined;
  }
}
