import type { Adapter } from '../types';
import { anthropic } from './anthropic';
import { kie } from './kie';
import { replicate } from './replicate';
import { runpod } from './runpod';
import { lambdamerge } from './lambdamerge';
import { runcomfy } from './runcomfy';

export { anthropic, kie, replicate, runpod, lambdamerge, runcomfy };

export const ADAPTERS: Record<string, Adapter> = {
  anthropic,
  kie,
  replicate,
  runpod,
  lambda: lambdamerge,
  runcomfy,
  // modelslab decommissioned (2026-07-02) — no longer in any catalog ladder.
  // google, openai — added when those direct-provider routes are needed
};
