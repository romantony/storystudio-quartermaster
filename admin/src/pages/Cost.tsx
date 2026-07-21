import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

interface CostRow {
  provider: string;
  model: string;
  product?: string;
  date: string;
  calls: number;
  successRate: number;
  costUsd: number;
}

interface CostSummary {
  rows: CostRow[];
  totalUsd: number;
  dateRange: { from: string; to: string };
}

type GroupBy = 'provider' | 'model' | 'product' | 'date';

function fmt(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function pct(n: number) {
  return (n * 100).toFixed(1) + '%';
}

function groupRows(rows: CostRow[], by: GroupBy): { key: string; calls: number; successRate: number; costUsd: number }[] {
  const map = new Map<string, { calls: number; successCalls: number; costUsd: number }>();
  for (const r of rows) {
    const key = r[by] ?? '—';
    const cur = map.get(key) ?? { calls: 0, successCalls: 0, costUsd: 0 };
    cur.calls += r.calls;
    cur.successCalls += r.calls * r.successRate;
    cur.costUsd += r.costUsd;
    map.set(key, cur);
  }
  return Array.from(map.entries())
    .map(([key, v]) => ({
      key,
      calls: v.calls,
      successRate: v.calls > 0 ? v.successCalls / v.calls : 0,
      costUsd: v.costUsd,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);
}

function ProjectCostLookup() {
  const [input, setInput] = useState('');
  const [projectId, setProjectId] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['project-cost', projectId],
    queryFn: () => api.getProjectCost(projectId),
    enabled: projectId.length > 0,
  });

  return (
    <div className="bg-white border rounded-xl p-4 mb-6">
      <p className="text-xs text-gray-500 mb-2">Project cost (real RunPod GPU-second billing, not an estimate)</p>
      <form
        className="flex gap-2 mb-3"
        onSubmit={(e) => { e.preventDefault(); setProjectId(input.trim()); }}
      >
        <input
          className="flex-1 border rounded-lg px-3 py-1.5 text-sm font-mono"
          placeholder="Project ID (e.g. js75gpvt4jpa7xjvjyq97ga1z18a96yg)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button type="submit" className="px-3 py-1.5 rounded-lg bg-indigo-700 text-white text-sm">
          Look up
        </button>
      </form>

      {isLoading && <p className="text-gray-500 text-sm">Loading…</p>}
      {error && <p className="text-red-600 text-sm">Error loading project cost</p>}

      {data && (
        <div>
          <p className="text-2xl font-bold text-gray-900 mb-3">${fmt(data.totalCostUsd)}</p>
          {data.breakdown.length > 0 ? (
            <table className="w-full text-sm">
              <thead className="border-b">
                <tr>
                  <th className="text-left py-1.5 font-medium text-gray-600">GPU type</th>
                  <th className="text-right py-1.5 font-medium text-gray-600">Requests</th>
                  <th className="text-right py-1.5 font-medium text-gray-600">GPU time</th>
                  <th className="text-right py-1.5 font-medium text-gray-600">Cost (USD)</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.breakdown.map((row) => (
                  <tr key={row.gpuType}>
                    <td className="py-1.5 font-mono text-gray-800">{row.gpuType}</td>
                    <td className="py-1.5 text-right text-gray-700">{row.requestCount.toLocaleString()}</td>
                    <td className="py-1.5 text-right text-gray-700">{(row.executionMs / 1000).toFixed(1)}s</td>
                    <td className="py-1.5 text-right font-mono text-gray-800">${fmt(row.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-gray-500 text-sm">No recorded GPU usage for this project.</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function Cost() {
  const [groupBy, setGroupBy] = useState<GroupBy>('provider');
  const [days, setDays] = useState(7);

  const { data, isLoading, error } = useQuery({
    queryKey: ['cost', days],
    queryFn: () => api.getCost({ days }),
  });

  const summary = data as CostSummary | undefined;
  const grouped = summary ? groupRows(summary.rows, groupBy) : [];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-gray-900">Cost & Usage</h1>
        <div className="flex items-center gap-3">
          <div className="flex rounded-lg border overflow-hidden text-sm">
            {([7, 14, 30] as const).map(d => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-3 py-1.5 ${days === d ? 'bg-indigo-700 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
              >
                {d}d
              </button>
            ))}
          </div>
          <div className="flex rounded-lg border overflow-hidden text-sm">
            {(['provider', 'model', 'product', 'date'] as GroupBy[]).map(g => (
              <button
                key={g}
                onClick={() => setGroupBy(g)}
                className={`px-3 py-1.5 ${groupBy === g ? 'bg-indigo-700 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
              >
                {g}
              </button>
            ))}
          </div>
        </div>
      </div>

      <ProjectCostLookup />

      {summary && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-white border rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">Total spend</p>
            <p className="text-2xl font-bold text-gray-900">${fmt(summary.totalUsd)}</p>
          </div>
          <div className="bg-white border rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">Total calls</p>
            <p className="text-2xl font-bold text-gray-900">
              {summary.rows.reduce((s, r) => s + r.calls, 0).toLocaleString()}
            </p>
          </div>
          <div className="bg-white border rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">Avg success rate</p>
            <p className="text-2xl font-bold text-gray-900">
              {(() => {
                const total = summary.rows.reduce((s, r) => s + r.calls, 0);
                const ok = summary.rows.reduce((s, r) => s + r.calls * r.successRate, 0);
                return total > 0 ? pct(ok / total) : '—';
              })()}
            </p>
          </div>
        </div>
      )}

      {isLoading && <p className="text-gray-500 text-sm">Loading…</p>}
      {error && <p className="text-red-600 text-sm">Error loading cost data</p>}

      {grouped.length > 0 && (
        <div className="bg-white border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600 capitalize">{groupBy}</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Calls</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Success</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Cost (USD)</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Share</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {grouped.map((row, i) => (
                <tr key={i} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-gray-800">{row.key}</td>
                  <td className="px-4 py-3 text-right text-gray-700">{row.calls.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={`${row.successRate >= 0.95 ? 'text-green-700' : row.successRate >= 0.8 ? 'text-yellow-700' : 'text-red-700'}`}>
                      {pct(row.successRate)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-gray-800">${fmt(row.costUsd)}</td>
                  <td className="px-4 py-3 text-right text-gray-500">
                    {summary ? pct(row.costUsd / summary.totalUsd) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-gray-50 border-t">
              <tr>
                <td className="px-4 py-3 font-medium text-gray-700">Total</td>
                <td className="px-4 py-3 text-right font-medium text-gray-700">
                  {grouped.reduce((s, r) => s + r.calls, 0).toLocaleString()}
                </td>
                <td />
                <td className="px-4 py-3 text-right font-mono font-semibold text-gray-800">
                  ${summary ? fmt(summary.totalUsd) : '—'}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
