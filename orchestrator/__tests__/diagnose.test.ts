/**
 * Unit tests for src/diagnostics/diagnose.ts. Fake pool (`.query` spy, same
 * convention as watchdog.test.ts) + fake fetch — no real Postgres/Anthropic.
 */
import { runDiagnostic, askSonnet } from '../src/diagnostics/diagnose';

function fakeRes(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function fakePool() {
  return { query: jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] })) };
}

describe('askSonnet', () => {
  it('parses a well-formed JSON diagnosis', async () => {
    const fetchImpl = jest.fn(async () =>
      fakeRes(200, { content: [{ type: 'text', text: JSON.stringify({ severity: 'critical', message: 'account-wide RunPod issue' }) }] }),
    );
    const diagnosis = await askSonnet({ anthropicApiKey: 'k', anthropicModel: 'claude-sonnet-5' }, { trigger: 'watchdog_orphan', triggeredAt: 'now', facts: {} }, fetchImpl as unknown as typeof fetch);
    expect(diagnosis).toEqual({ severity: 'critical', message: 'account-wide RunPod issue' });
  });

  it('forces critical (never silently downgrades) when Sonnet does not return valid JSON', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(200, { content: [{ type: 'text', text: 'not json' }] }));
    const diagnosis = await askSonnet({ anthropicApiKey: 'k' }, { trigger: 'project_failed', triggeredAt: 'now', facts: {} }, fetchImpl as unknown as typeof fetch);
    expect(diagnosis.severity).toBe('critical');
    expect(diagnosis.message).toContain('not json');
  });

  it('salvages the real severity from truncated JSON instead of defaulting', async () => {
    const truncated = '{"severity":"warning","message":"looks isolated, endpoint recovered on its o';
    const fetchImpl = jest.fn(async () => fakeRes(200, { content: [{ type: 'text', text: truncated }], stop_reason: 'max_tokens' }));
    const diagnosis = await askSonnet({ anthropicApiKey: 'k' }, { trigger: 'watchdog_orphan', triggeredAt: 'now', facts: {} }, fetchImpl as unknown as typeof fetch);
    expect(diagnosis.severity).toBe('warning');
    expect(diagnosis.message).toContain('truncated at max_tokens');
  });

  it('throws on an Anthropic API error', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(401, { error: { message: 'invalid x-api-key' } }));
    await expect(
      askSonnet({ anthropicApiKey: 'bad' }, { trigger: 'project_failed', triggeredAt: 'now', facts: {} }, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow('invalid x-api-key');
  });
});

describe('runDiagnostic', () => {
  it('is a no-op when anthropicApiKey is unset (feature off)', async () => {
    const pool = fakePool();
    const fetchImpl = jest.fn();
    await runDiagnostic(
      { pool: pool as never, cfg: {}, fetchImpl: fetchImpl as unknown as typeof fetch },
      { trigger: 'watchdog_orphan', facts: {} },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('persists a diagnostic_alerts row on success', async () => {
    const pool = fakePool();
    const fetchImpl = jest.fn(async () =>
      fakeRes(200, { content: [{ type: 'text', text: JSON.stringify({ severity: 'warning', message: 'looks isolated' }) }] }),
    );
    await runDiagnostic(
      { pool: pool as never, cfg: { anthropicApiKey: 'k', anthropicModel: 'claude-sonnet-5' }, fetchImpl: fetchImpl as unknown as typeof fetch },
      { trigger: 'project_failed', projectId: 'p1', cohortId: 'c1', facts: { status: 'failed' } },
    );
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO diagnostic_alerts');
    expect(params).toEqual(['warning', 'project_failed', 'p1', 'c1', null, expect.any(String), 'looks isolated', 'claude-sonnet-5']);
  });

  it('never throws when Sonnet fails — logs and drops the alert', async () => {
    const pool = fakePool();
    const fetchImpl = jest.fn(async () => fakeRes(500, { error: { message: 'overloaded' } }));
    await expect(
      runDiagnostic(
        { pool: pool as never, cfg: { anthropicApiKey: 'k' }, fetchImpl: fetchImpl as unknown as typeof fetch },
        { trigger: 'watchdog_orphan', endpointId: 'e1', facts: {} },
      ),
    ).resolves.toBeUndefined();
    expect(pool.query).not.toHaveBeenCalled();
  });
});
