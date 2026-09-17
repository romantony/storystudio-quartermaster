/**
 * Read-only diagnostic assistant (2026-09-17). Fires only on an existing
 * failure signal already detected elsewhere — never a blind poll:
 *   - watchdog.ts: orphaned RunPod workers (real workers, no fresh
 *     endpoint_state claim)
 *   - result/finalize.ts: a project's assembled result is 'failed' or
 *     'partial'
 *
 * "Read-only" is enforced by construction, not by prompt instruction alone:
 * this module gathers the structured signal itself (the caller's own
 * already-known facts, plus a live RunPod health() read when an endpointId
 * is available) and hands Sonnet a plain JSON snapshot to reason over.
 * Sonnet has no tool access and never calls RunPod/Postgres/anything else
 * itself — it cannot take an action even if it wanted to, only produce text.
 * Any actual remediation stays a human decision (see the 2026-09-17
 * conversation this was scoped from — autonomous fixes were explicitly
 * ruled out, matching the earlier move away from per-failure LLM
 * rework/QA, docs/qm-orchestrator-prompt-harness-implementation-plan.md).
 *
 * Never throws into the caller: a diagnostics failure (missing API key,
 * Anthropic outage, a DB hiccup) is logged and dropped, not allowed to
 * affect the watchdog tick or cohort finalization that triggered it.
 */
import type { Pool } from 'pg';
import type { RunpodClient } from '../runpod/client';
import { log } from '../telemetry/log';

export type DiagnosticTrigger = 'watchdog_orphan' | 'project_failed' | 'project_partial';

export interface DiagnosticContext {
  trigger: DiagnosticTrigger;
  projectId?: string;
  cohortId?: string;
  endpointId?: string;
  /** The caller's own already-known facts about what fired this — never re-derived here. */
  facts: Record<string, unknown>;
}

interface Snapshot {
  trigger: DiagnosticTrigger;
  triggeredAt: string;
  facts: Record<string, unknown>;
  endpointHealth?:
    | { endpointId: string; ready: number; running: number; throttled: number }
    | { endpointId: string; error: string };
}

interface Diagnosis {
  severity: 'info' | 'warning' | 'critical';
  message: string;
}

const SYSTEM_PROMPT = `You are a read-only diagnostic assistant for the QM video-generation orchestrator, a RunPod-backed pipeline that generates images/video/audio for customer video-creation projects.

You are given one JSON snapshot describing a single failure signal the orchestrator already detected on its own. You have no tools and no access to any live system — reason ONLY over the JSON you are given. Do not invent facts, endpoint names, or numbers not present in the snapshot.

Respond with a single JSON object, no other text: {"severity": "info"|"warning"|"critical", "message": "<2-4 sentence plain-English diagnosis for an on-call engineer, naming the likely cause and what to check next>"}.

Severity guide: "info" for a single isolated failure with an already-known cause; "warning" for something that looks like it could recur or affect other projects; "critical" for signs of an account-wide or infrastructure-wide problem (e.g. multiple endpoints affected, or workers billing with no progress).`;

async function gatherSnapshot(runpod: RunpodClient | undefined, ctx: DiagnosticContext): Promise<Snapshot> {
  const snapshot: Snapshot = { trigger: ctx.trigger, triggeredAt: new Date().toISOString(), facts: ctx.facts };
  if (ctx.endpointId && runpod) {
    try {
      const h = await runpod.health(ctx.endpointId);
      snapshot.endpointHealth = {
        endpointId: ctx.endpointId,
        ready: h.workers.ready ?? 0,
        running: h.workers.running ?? 0,
        throttled: h.workers.throttled ?? 0,
      };
    } catch (err) {
      snapshot.endpointHealth = { endpointId: ctx.endpointId, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return snapshot;
}

/** Exported for tests — the network/parsing half, isolated from gathering + persistence. */
export async function askSonnet(
  cfg: { anthropicApiKey?: string; anthropicModel?: string },
  snapshot: Snapshot,
  fetchImpl: typeof fetch,
): Promise<Diagnosis> {
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.anthropicApiKey ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.anthropicModel ?? 'claude-sonnet-5',
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(snapshot) }],
    }),
  });
  const body = (await res.json()) as { content?: Array<{ type?: string; text?: string }>; error?: { message?: string } };
  if (!res.ok || body.error) {
    throw new Error(`Anthropic error: ${body.error?.message ?? res.status}`);
  }
  const text = body.content?.find((c) => c.type === 'text')?.text;
  if (!text) throw new Error('Anthropic response had no text content');
  try {
    const parsed = JSON.parse(text) as Partial<Diagnosis>;
    if (parsed.severity && parsed.message) return { severity: parsed.severity as Diagnosis['severity'], message: parsed.message };
  } catch {
    // fall through — treat the raw text as the message rather than dropping a real diagnosis
  }
  return { severity: 'warning', message: text };
}

export async function runDiagnostic(
  deps: { pool: Pool; runpod?: RunpodClient; cfg: { anthropicApiKey?: string; anthropicModel?: string }; fetchImpl?: typeof fetch },
  ctx: DiagnosticContext,
): Promise<void> {
  if (!deps.cfg.anthropicApiKey) return; // unset = feature off, mirrors watchdogAlertWebhookUrl
  try {
    const snapshot = await gatherSnapshot(deps.runpod, ctx);
    const diagnosis = await askSonnet(deps.cfg, snapshot, deps.fetchImpl ?? fetch);
    await deps.pool.query(
      `INSERT INTO diagnostic_alerts (severity, trigger, project_id, cohort_id, endpoint_id, signals, message, model)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        diagnosis.severity,
        ctx.trigger,
        ctx.projectId ?? null,
        ctx.cohortId ?? null,
        ctx.endpointId ?? null,
        JSON.stringify(snapshot),
        diagnosis.message,
        deps.cfg.anthropicModel ?? 'claude-sonnet-5',
      ],
    );
    const level = diagnosis.severity === 'critical' ? 'error' : diagnosis.severity === 'warning' ? 'warn' : 'info';
    log()[level]({ trigger: ctx.trigger, projectId: ctx.projectId, severity: diagnosis.severity }, 'diagnostics: alert recorded');
  } catch (err) {
    log().warn({ err, trigger: ctx.trigger }, 'diagnostics: run failed, no alert recorded (never blocks the caller)');
  }
}
