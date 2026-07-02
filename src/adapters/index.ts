import type { Adapter } from '../types';
import { kie } from './kie';
import { replicate } from './replicate';
import { runpod } from './runpod';

export { kie, replicate, runpod };

export const ADAPTERS: Record<string, Adapter> = {
  kie,
  replicate,
  runpod,
  // modelslab decommissioned (2026-07-02) — no longer in any catalog ladder.
  // google, anthropic, openai — added when those direct-provider routes are needed
};
