/**
 * Guardrail types (prompt harness plan §5). Image and video are separate
 * DOMAINS with separate seed sets, separate lint modules and separate
 * regenerate-tool system prompts — a rule never crosses domains, though a
 * video rule's fix may target the image prompt (`fixTarget`).
 *
 * A guardrail's `detector.check` and `corrective[].edit` are NAMED
 * references into a fixed registry of TS functions (lint/*.ts,
 * correct/*.ts) — a learned/promoted guardrail (harness/learn/promote.ts)
 * can only recombine existing checks and fixes, never execute arbitrary
 * logic. That is deliberate: see the implementation plan §5.0.
 */

export type Domain = 'image' | 'video';
export type Severity = 'block' | 'fix' | 'warn';
export type GuardrailStatus = 'proposed' | 'probation' | 'active' | 'retired';
export type FixTarget = 'image_prompt' | 'motion_prompt' | 'contract' | 'route';

export interface ContractDetector {
  type: 'contract';
  /** Name of a function in lint/image.ts or lint/video.ts's DETECTORS map. */
  check: string;
}
export interface RegexDetector {
  type: 'regex';
  pattern: string;
  flags?: string;
  field: 'imagePrompt' | 'motionPrompt';
}
export interface LexiconDetector {
  type: 'lexicon';
  /** Name of a word/phrase list in lint's LEXICONS map. */
  list: string;
  field: 'imagePrompt' | 'motionPrompt';
}
export interface ContinuityDetector {
  type: 'continuity';
  check: string;
}
export type Detector = ContractDetector | RegexDetector | LexiconDetector | ContinuityDetector;

export interface ContractEditMeasure {
  type: 'contract_edit';
  /** Name of a function in correct/edits.ts's EDITS map. */
  edit: string;
}
export interface RouteMeasure {
  type: 'route';
  to: string; // FallbackRung, e.g. 'flux-4b' | 'replicate-wan22-fast'
}
export interface RegenerateMeasure {
  type: 'regenerate';
  instruction: string;
}
export interface ReseedMeasure {
  type: 'reseed';
}
export interface SplitShotMeasure {
  type: 'split_shot';
}
export type CorrectiveMeasure = ContractEditMeasure | RouteMeasure | RegenerateMeasure | ReseedMeasure | SplitShotMeasure;

export interface GuardrailStats {
  fired: number;
  fixed: number;
  passedAfterFix: number;
}

export interface Guardrail {
  id: string;
  domain: Domain;
  /** 'any' | 'wan2-lightning' | 'replicate-wan22-fast' | 'qwen-image' | ... */
  profile: string;
  version: number;
  status: GuardrailStatus;
  severity: Severity;
  title: string;
  detector: Detector;
  fixTarget: FixTarget;
  corrective: CorrectiveMeasure[];
  instruction: string;
  evidence: string[];
  stats?: GuardrailStats;
}

export interface Violation {
  guardrailId: string;
  severity: Severity;
  fixTarget: FixTarget;
  message: string;
  detail?: Record<string, unknown>;
}

export interface LintResult {
  violations: Violation[];
  blocking: boolean; // any severity==='block' violation present
}

export function mergeLintResults(...results: LintResult[]): LintResult {
  const violations = results.flatMap((r) => r.violations);
  return { violations, blocking: violations.some((v) => v.severity === 'block') };
}
