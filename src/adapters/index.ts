import type { Adapter } from '../types';
import { modelslab } from './modelslab';
import { kie } from './kie';
import { replicate } from './replicate';
import { runpod } from './runpod';

export { modelslab, kie, replicate, runpod };

export const ADAPTERS: Record<string, Adapter> = {
  modelslab,
  kie,
  replicate,
  runpod,
  // google, anthropic, openai — added when those direct-provider routes are needed
};
