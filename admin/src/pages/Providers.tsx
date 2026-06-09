import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

interface ProviderConfig {
  name: string;
  limit?: number;
  floors?: { video: number; rest: number };
  circuitState?: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  enabled: boolean;
  endpoints?: string[];
  keyLastFour?: string;
}

function CircuitBadge({ state }: { state?: string }) {
  const colors: Record<string, string> = {
    CLOSED: 'bg-green-100 text-green-800',
    OPEN: 'bg-red-100 text-red-800',
    HALF_OPEN: 'bg-yellow-100 text-yellow-800',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[state ?? 'CLOSED'] ?? 'bg-gray-100 text-gray-600'}`}>
      {state ?? 'CLOSED'}
    </span>
  );
}

function RotateKeyModal({ provider, onClose }: { provider: string; onClose: () => void }) {
  const [newKey, setNewKey] = useState('');
  const [error, setError] = useState('');
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => api.rotateProviderKey(provider, newKey),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['providers'] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="font-semibold text-gray-800">Rotate key — <span className="font-mono text-indigo-700">{provider}</span></h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg">✕</button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">New API key</label>
            <input
              type="password"
              value={newKey}
              onChange={e => setNewKey(e.target.value)}
              placeholder="Paste new key…"
              className="w-full border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          {error && <p className="text-red-600 text-sm">{error}</p>}
        </div>
        <div className="px-6 py-4 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!newKey || mutation.isPending}
            className="px-4 py-2 text-sm bg-indigo-700 text-white rounded-lg hover:bg-indigo-800 disabled:opacity-50"
          >
            {mutation.isPending ? 'Rotating…' : 'Rotate'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProviderCard({ config }: { config: ProviderConfig }) {
  const [rotating, setRotating] = useState(false);
  const qc = useQueryClient();

  const toggleMutation = useMutation({
    mutationFn: () => api.putProviderConfig(config.name, { ...config, enabled: !config.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['providers'] }),
  });

  return (
    <div className={`border rounded-xl p-5 bg-white ${!config.enabled ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <span className="font-semibold text-gray-800 font-mono">{config.name}</span>
            <CircuitBadge state={config.circuitState} />
            {!config.enabled && (
              <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">disabled</span>
            )}
          </div>

          {config.limit != null && (
            <p className="text-sm text-gray-600">
              Limit: <span className="font-semibold">{config.limit}</span>
              {config.floors && (
                <span className="ml-3 text-gray-500">
                  floors: video={config.floors.video}, rest={config.floors.rest}
                </span>
              )}
            </p>
          )}

          {config.keyLastFour && (
            <p className="text-sm text-gray-500 font-mono">
              API key: •••••••<span className="text-gray-800">{config.keyLastFour}</span>
            </p>
          )}

          {config.endpoints && config.endpoints.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {config.endpoints.map(ep => (
                <span key={ep} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded font-mono">{ep}</span>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setRotating(true)}
            className="text-xs text-indigo-600 border border-indigo-200 hover:bg-indigo-50 px-3 py-1.5 rounded-lg"
          >
            Rotate key
          </button>
          <button
            onClick={() => toggleMutation.mutate()}
            disabled={toggleMutation.isPending}
            className={`text-xs px-3 py-1.5 rounded-lg border ${
              config.enabled
                ? 'text-gray-600 border-gray-200 hover:bg-gray-50'
                : 'text-green-700 border-green-200 hover:bg-green-50'
            } disabled:opacity-50`}
          >
            {config.enabled ? 'Disable' : 'Enable'}
          </button>
        </div>
      </div>

      {rotating && <RotateKeyModal provider={config.name} onClose={() => setRotating(false)} />}
    </div>
  );
}

export default function Providers() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.getProviders(),
  });

  const providers = (data as ProviderConfig[] | undefined) ?? [];

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-6">Providers & Keys</h1>

      {isLoading && <p className="text-gray-500 text-sm">Loading…</p>}
      {error && <p className="text-red-600 text-sm">Error loading providers</p>}

      <div className="space-y-3">
        {providers.map(p => (
          <ProviderCard key={p.name} config={p} />
        ))}
      </div>
    </div>
  );
}
