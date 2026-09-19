/**
 * Unit tests for src/diagnostics/diagnose.ts. Fake pool (`.query` spy, same
 * convention as watchdog.test.ts) + fake fetch — no real Postgres, no real
 * Replicate.
 *
 * The transport is Replicate's predictions API (changed 2026-09-19 — the
 * direct Anthropic account ran out of credit), so a fake round trip is two
 * calls: POST /models/{model}/predictions, then GET /predictions/{id} until
 * it succeeds. Claude's output arrives as an array of string chunks, which is
 * what these fakes reproduce.
 */
import { runDiagnostic, askSonnet, DEFAULT_DIAGNOSTICS_MODEL } from '../src/diagnostics/diagnose';

function fakeRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** A Replicate transport that creates a prediction and returns `output`. */
function fakeReplicate(output: unknown, opts: { status?: string; error?: unknown } = {}) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const fetchImpl = jest.fn(async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    if (url.includes('/predictions') && init?.body) return fakeRes(200, { id: 'pred_1' });
    return fakeRes(200, { status: opts.status ?? 'succeeded', output, error: opts.error });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const CFG = { replicateApiToken: 'r8_test', replicatePollIntervalMs: 0, replicateMaxPollAttempts: 3 };

function fakePool() {
  return { query: jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] })) };
}

const SNAPSHOT = { trigger: 'watchdog_orphan' as const, triggeredAt: 'now', facts: {} };

describe('askSonnet', () => {
  it('parses a well-formed JSON diagnosis out of the streamed chunks', async () => {
    // Replicate returns Claude's output as an array of partial strings; the
    // answer only parses once they are concatenated.
    const { fetchImpl } = fakeReplicate(['{"severity":"critical",', '"message":"account-wide RunPod issue"}']);
    const diagnosis = await askSonnet(CFG, SNAPSHOT, fetchImpl);
    expect(diagnosis).toEqual({ severity: 'critical', message: 'account-wide RunPod issue' });
  });

  it('sends the snapshot, the system prompt and a bounded max_tokens to the right model', async () => {
    const { fetchImpl, calls } = fakeReplicate([JSON.stringify({ severity: 'info', message: 'fine' })]);
    await askSonnet(CFG, { ...SNAPSHOT, facts: { orphanForMs: 12 } }, fetchImpl);

    const create = calls[0];
    expect(create.url).toContain(`/models/${DEFAULT_DIAGNOSTICS_MODEL}/predictions`);
    const input = (create.body as { input: Record<string, unknown> }).input;
    expect(JSON.parse(input.prompt as string).facts).toEqual({ orphanForMs: 12 });
    expect(input.system_prompt).toContain('read-only diagnostic assistant');
    // The system facts are load-bearing, not decoration: without the billing
    // line the model's first real diagnosis (2026-09-19, endpoint
    // w0h49vn1pn0r87) told on-call an orphaned worker was "billing idly",
    // which is false — idle and ready workers cost nothing — and would have
    // sent someone chasing a cost leak that does not exist.
    expect(input.system_prompt).toContain('RunPod bills only for workers ACTIVELY RUNNING A JOB');
    expect(input.system_prompt).toContain('NEVER describe an idle, ready or orphaned worker as billing');
    // Worker counts are admin-managed from the dashboard (the fixed-pod
    // policy), so "terminate the worker" is not a remedy this assistant may
    // suggest.
    expect(input.system_prompt).toContain('Do not recommend scaling, draining or terminating workers');
    // 1536, not 512: a live run in 2026-09-17 truncated a real "critical"
    // diagnosis mid-JSON at the smaller ceiling.
    expect(input.max_tokens).toBe(1536);
    // Thinking off by default — this is a short structured judgement on an
    // alerting path, not a reasoning task.
    expect(input.effort).toBe('low');
  });

  it('honours a configured model and effort', async () => {
    const { fetchImpl, calls } = fakeReplicate([JSON.stringify({ severity: 'info', message: 'fine' })]);
    await askSonnet({ ...CFG, diagnosticsModel: 'anthropic/claude-opus-5', diagnosticsEffort: 'high' }, SNAPSHOT, fetchImpl);
    expect(calls[0].url).toContain('/models/anthropic/claude-opus-5/predictions');
    expect((calls[0].body as { input: { effort: string } }).input.effort).toBe('high');
  });

  it('reads a JSON answer Claude wrapped in a markdown fence', async () => {
    // The direct-API path used a bare JSON.parse and treated this as garbage.
    const { fetchImpl } = fakeReplicate([
      'Here is my assessment:\n```json\n{"severity":"warning","message":"single endpoint, likely transient"}\n```',
    ]);
    const diagnosis = await askSonnet(CFG, SNAPSHOT, fetchImpl);
    expect(diagnosis).toEqual({ severity: 'warning', message: 'single endpoint, likely transient' });
  });

  it('forces critical (never silently downgrades) when Sonnet does not return valid JSON', async () => {
    const { fetchImpl } = fakeReplicate(['not json']);
    const diagnosis = await askSonnet(CFG, SNAPSHOT, fetchImpl);
    expect(diagnosis.severity).toBe('critical');
    expect(diagnosis.message).toContain('not json');
    expect(diagnosis.message).toContain('[unparsed response]');
  });

  it('salvages the real severity from truncated JSON instead of defaulting', async () => {
    const truncated = '{"severity":"warning","message":"looks isolated, endpoint recovered on its o';
    const { fetchImpl } = fakeReplicate([truncated]);
    const diagnosis = await askSonnet(CFG, SNAPSHOT, fetchImpl);
    expect(diagnosis.severity).toBe('warning');
    expect(diagnosis.message).toContain('[unparsed response]');
  });

  it('throws on a Replicate API error', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(401, { detail: 'invalid token' }));
    await expect(askSonnet(CFG, SNAPSHOT, fetchImpl as unknown as typeof fetch)).rejects.toThrow(/401/);
  });

  it('throws when the prediction itself fails', async () => {
    const { fetchImpl } = fakeReplicate(null, { status: 'failed', error: 'model unavailable' });
    await expect(askSonnet(CFG, SNAPSHOT, fetchImpl)).rejects.toThrow(/failed/);
  });

  it('throws rather than recording an empty diagnosis', async () => {
    const { fetchImpl } = fakeReplicate([]);
    await expect(askSonnet(CFG, SNAPSHOT, fetchImpl)).rejects.toThrow(/no text/);
  });
});

describe('runDiagnostic', () => {
  it('is a no-op when replicateApiToken is unset (feature off)', async () => {
    const pool = fakePool();
    const fetchImpl = jest.fn();
    await runDiagnostic(
      { pool: pool as never, cfg: {}, fetchImpl: fetchImpl as unknown as typeof fetch },
      { trigger: 'watchdog_orphan', facts: {} },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('persists a diagnostic_alerts row on success, stamped with the model used', async () => {
    const pool = fakePool();
    const { fetchImpl } = fakeReplicate([JSON.stringify({ severity: 'warning', message: 'looks isolated' })]);
    await runDiagnostic(
      { pool: pool as never, cfg: CFG, fetchImpl },
      { trigger: 'project_failed', projectId: 'p1', cohortId: 'c1', facts: { status: 'failed' } },
    );
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO diagnostic_alerts');
    expect(params).toEqual([
      'warning',
      'project_failed',
      'p1',
      'c1',
      null,
      expect.any(String),
      'looks isolated',
      DEFAULT_DIAGNOSTICS_MODEL,
    ]);
  });

  it('never throws when Sonnet fails — logs and drops the alert', async () => {
    const pool = fakePool();
    const fetchImpl = jest.fn(async () => fakeRes(500, { detail: 'overloaded' }));
    await expect(
      runDiagnostic(
        { pool: pool as never, cfg: CFG, fetchImpl: fetchImpl as unknown as typeof fetch },
        { trigger: 'watchdog_orphan', endpointId: 'e1', facts: {} },
      ),
    ).resolves.toBeUndefined();
    expect(pool.query).not.toHaveBeenCalled();
  });
});
