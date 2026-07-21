export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const resp = await fetch(path, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });

  const data = await resp.json().catch(() => ({})) as Record<string, unknown>;
  if (!resp.ok) {
    throw new ApiError(String(data?.error ?? resp.statusText), resp.status);
  }
  return data as T;
}

export const api = {
  // Auth
  login: (password: string) =>
    request('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () =>
    request('/api/auth/logout', { method: 'POST' }),

  // Catalog
  getCatalog: (queue: 'background' | 'foreground') =>
    request<Record<string, unknown>>(`/api/catalog/${queue}`),
  putLadder: (queue: 'background' | 'foreground', key: string, rungs: unknown[]) =>
    request(`/api/catalog/${queue}/ladders/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ rungs }),
    }),

  // Providers
  getProviders: () =>
    request<unknown[]>('/api/providers'),
  putProviderConfig: (name: string, data: unknown) =>
    request(`/api/providers/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  rotateProviderKey: (name: string, newKey: string) =>
    request(`/api/providers/${encodeURIComponent(name)}/rotate-key`, {
      method: 'POST',
      body: JSON.stringify({ newKey }),
    }),

  // Cost
  getCost: (params: { days?: number; platform?: string; date?: string } = {}) => {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])),
    ).toString();
    return request<unknown>(`/api/cost${qs ? `?${qs}` : ''}`);
  },
  getProjectCost: (projectId: string) =>
    request<{
      projectId: string;
      totalCostUsd: number;
      totalExecutionMs: number;
      totalRequests: number;
      breakdown: Array<{ gpuType: string; costUsd: number; executionMs: number; requestCount: number }>;
    }>(`/api/projects/${encodeURIComponent(projectId)}/cost`),

  // Balances
  getBalances: () =>
    request<unknown[]>('/api/balances'),
  recordTopUp: (provider: string, amountUsd: number) =>
    request(`/api/balances/${encodeURIComponent(provider)}`, {
      method: 'PUT',
      body: JSON.stringify({ amountUsd, date: new Date().toISOString().slice(0, 10) }),
    }),

  // Audit
  getAudit: (params: { limit?: number } = {}) =>
    request<unknown[]>(`/api/audit?limit=${params.limit ?? 50}`),
};
