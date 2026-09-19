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
 * Never throws into the caller: a diagnostics failure (missing API token,
 * provider outage, a DB hiccup) is logged and dropped, not allowed to affect
 * the watchdog tick or cohort finalization that triggered it.
 *
 * PROVIDER (changed 2026-09-19): Sonnet 5 is reached through **Replicate**
 * (`anthropic/claude-sonnet-5`), not the Anthropic API directly. The direct
 * account ran out of credit and every diagnostic on the VPS was failing with
 * "Your credit balance is too low" — so this now rides the same Replicate
 * token and transport the quality gate and the prompt rewriter already use,
 * which removes a second billing relationship from the critical path of an
 * alerting feature. Replicate's Claude models take `{prompt, system_prompt,
 * max_tokens, effort}` and stream their output as an array of string chunks,
 * which `runReplicateText` already concatenates.
 */
import type { Pool } from 'pg';
import type { RunpodClient } from '../runpod/client';
import { log } from '../telemetry/log';
import { extractJson, runReplicateText, type ReplicateDeps } from '../quality/replicate';

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

/** What the diagnostics call needs from the Replicate transport. Same shape
 * quality/rewrite.ts uses — one token, one client, one billing relationship. */
export interface DiagnosticsCfg {
  replicateApiToken?: string;
  replicateApiBase?: string;
  replicatePollIntervalMs?: number;
  replicateMaxPollAttempts?: number;
  replicateTimeoutMs?: number;
  /** Replicate model slug. Defaults to `anthropic/claude-sonnet-5`. */
  diagnosticsModel?: string;
  /** How much Sonnet thinks first. 'low' (the default, and the model's own
   * default) disables thinking: this is a short, structured-JSON judgement
   * over a snapshot the orchestrator already assembled, not a reasoning task,
   * and an alerting path should be fast and cheap. */
  diagnosticsEffort?: string;
}

function replicateDepsFrom(cfg: DiagnosticsCfg, fetchImpl?: typeof fetch): ReplicateDeps {
  return {
    apiToken: cfg.replicateApiToken,
    apiBase: cfg.replicateApiBase ?? 'https://api.replicate.com/v1',
    pollIntervalMs: cfg.replicatePollIntervalMs ?? 3_000,
    maxPollAttempts: cfg.replicateMaxPollAttempts ?? 80,
    timeoutMs: cfg.replicateTimeoutMs ?? 120_000,
    // Required by the interface, unused on a text call.
    visionModel: '',
    visionModelFallback: '',
    fetchImpl,
  } as ReplicateDeps;
}

export const DEFAULT_DIAGNOSTICS_MODEL = 'anthropic/claude-sonnet-5';

/** Exported for tests — the network/parsing half, isolated from gathering + persistence. */
export async function askSonnet(cfg: DiagnosticsCfg, snapshot: Snapshot, fetchImpl?: typeof fetch): Promise<Diagnosis> {
  const text = await runReplicateText(replicateDepsFrom(cfg, fetchImpl), cfg.diagnosticsModel ?? DEFAULT_DIAGNOSTICS_MODEL, {
    prompt: JSON.stringify(snapshot),
    system_prompt: SYSTEM_PROMPT,
    // 512 was found live (2026-09-17) to truncate a real "critical" diagnosis
    // mid-JSON, which silently downgraded it to "warning" via the fallback
    // below — a genuinely dangerous failure mode for an alerting feature.
    // 1536 gives a 2-4 sentence message plenty of headroom.
    max_tokens: 1536,
    effort: cfg.diagnosticsEffort ?? 'low',
  });

  if (!text.trim()) throw new Error('diagnostics: model returned no text');

  // `extractJson` rather than a bare JSON.parse: Claude routinely wraps a JSON
  // answer in a markdown fence or a sentence of preamble, and the old direct
  // path treated that as unparseable. It tries a direct parse first, so a
  // clean response costs nothing extra. It THROWS when it finds nothing —
  // which must not escape, or a garbled response would propagate as an error
  // and lose the salvage path below, the one thing stopping a truncated
  // "critical" from being dropped entirely.
  let parsed: Partial<Diagnosis> | undefined;
  try {
    parsed = extractJson(text) as Partial<Diagnosis>;
  } catch {
    parsed = undefined;
  }
  if (parsed && parsed.severity && parsed.message) {
    return { severity: parsed.severity as Diagnosis['severity'], message: parsed.message };
  }

  // Malformed or truncated JSON: never silently default to "warning" — a
  // truncated "critical" response downgraded to "warning" is worse than no
  // parsed severity at all. Salvage a severity by regex if one is visible in
  // the raw text; otherwise force "critical" so a broken diagnosis still
  // surfaces loudly rather than getting buried.
  //
  // Replicate's streamed output carries no `stop_reason`, so truncation can no
  // longer be named exactly — hence the one generic note instead of the old
  // pair. The salvage path below is what actually protects against it.
  const salvaged = /"severity"\s*:\s*"(info|warning|critical)"/.exec(text)?.[1] as Diagnosis['severity'] | undefined;
  return { severity: salvaged ?? 'critical', message: `${text} [unparsed response]` };
}

export async function runDiagnostic(
  deps: { pool: Pool; runpod?: RunpodClient; cfg: DiagnosticsCfg; fetchImpl?: typeof fetch },
  ctx: DiagnosticContext,
): Promise<void> {
  if (!deps.cfg.replicateApiToken) return; // unset = feature off, mirrors watchdogAlertWebhookUrl
  try {
    const snapshot = await gatherSnapshot(deps.runpod, ctx);
    const diagnosis = await askSonnet(deps.cfg, snapshot, deps.fetchImpl);
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
        deps.cfg.diagnosticsModel ?? DEFAULT_DIAGNOSTICS_MODEL,
      ],
    );
    const level = diagnosis.severity === 'critical' ? 'error' : diagnosis.severity === 'warning' ? 'warn' : 'info';
    log()[level]({ trigger: ctx.trigger, projectId: ctx.projectId, severity: diagnosis.severity }, 'diagnostics: alert recorded');
  } catch (err) {
    log().warn({ err, trigger: ctx.trigger }, 'diagnostics: run failed, no alert recorded (never blocks the caller)');
  }
}
