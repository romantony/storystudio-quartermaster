import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

interface AuditEntry {
  timestamp: string;
  actor: string;
  action: string;
  resource?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
}

function diffKeys(before: unknown, after: unknown): string[] {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [];
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  return Array.from(new Set([...Object.keys(b), ...Object.keys(a)])).filter(
    k => JSON.stringify(b[k]) !== JSON.stringify(a[k]),
  );
}

function DiffViewer({ before, after }: { before: unknown; after: unknown }) {
  const keys = diffKeys(before, after);
  if (keys.length === 0) return null;
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  return (
    <table className="text-xs font-mono w-full mt-2">
      <thead>
        <tr className="text-gray-400">
          <th className="text-left py-0.5 pr-4">field</th>
          <th className="text-left py-0.5 pr-4 text-red-400">before</th>
          <th className="text-left py-0.5 text-green-600">after</th>
        </tr>
      </thead>
      <tbody>
        {keys.map(k => (
          <tr key={k}>
            <td className="py-0.5 pr-4 text-gray-500">{k}</td>
            <td className="py-0.5 pr-4 text-red-600">{JSON.stringify(b[k]) ?? '—'}</td>
            <td className="py-0.5 text-green-700">{JSON.stringify(a[k]) ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasDiff = !!(entry.before || entry.after);

  return (
    <div className="border-b last:border-0 py-3 px-4">
      <div
        className={`flex items-start gap-4 ${hasDiff ? 'cursor-pointer hover:bg-gray-50 -mx-4 px-4 rounded' : ''}`}
        onClick={() => hasDiff && setExpanded(e => !e)}
      >
        <time className="text-xs text-gray-400 font-mono whitespace-nowrap pt-0.5 w-36">
          {new Date(entry.timestamp).toLocaleString('en-US', {
            month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
          })}
        </time>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs bg-indigo-100 text-indigo-800 px-2 py-0.5 rounded font-medium">{entry.action}</span>
            <span className="text-sm text-gray-700 font-medium">{entry.actor}</span>
            {entry.resource && (
              <span className="text-sm text-gray-500 font-mono truncate">{entry.resource}</span>
            )}
            {entry.ip && <span className="text-xs text-gray-400">{entry.ip}</span>}
          </div>
        </div>
        {hasDiff && (
          <span className="text-gray-400 text-xs shrink-0">{expanded ? '▲' : '▼'}</span>
        )}
      </div>
      {expanded && hasDiff && (
        <div className="mt-2 ml-40 bg-gray-50 rounded-lg p-3">
          <DiffViewer before={entry.before} after={entry.after} />
        </div>
      )}
    </div>
  );
}

export default function Audit() {
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(50);

  const { data, isLoading, error } = useQuery({
    queryKey: ['audit', limit],
    queryFn: () => api.getAudit({ limit }),
  });

  const entries = (data as AuditEntry[] | undefined) ?? [];
  const filtered = filter
    ? entries.filter(
        e =>
          e.actor.toLowerCase().includes(filter.toLowerCase()) ||
          e.action.toLowerCase().includes(filter.toLowerCase()) ||
          (e.resource ?? '').toLowerCase().includes(filter.toLowerCase()),
      )
    : entries;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-gray-900">Audit Log</h1>
        <div className="flex items-center gap-3">
          <input
            type="text"
            placeholder="Filter actor / action…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm w-52 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <select
            value={limit}
            onChange={e => setLimit(Number(e.target.value))}
            className="border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value={50}>Last 50</option>
            <option value={100}>Last 100</option>
            <option value={250}>Last 250</option>
          </select>
        </div>
      </div>

      {isLoading && <p className="text-gray-500 text-sm">Loading…</p>}
      {error && <p className="text-red-600 text-sm">Error loading audit log</p>}

      {filtered.length > 0 && (
        <div className="bg-white border rounded-xl overflow-hidden">
          {filtered.map((entry, i) => (
            <AuditRow key={`${entry.timestamp}-${i}`} entry={entry} />
          ))}
        </div>
      )}

      {!isLoading && filtered.length === 0 && (
        <p className="text-gray-400 text-sm text-center py-12">No audit entries found</p>
      )}

      {filtered.length >= limit && (
        <button
          onClick={() => setLimit(l => l + 100)}
          className="mt-4 text-sm text-indigo-600 hover:underline"
        >
          Load more
        </button>
      )}
    </div>
  );
}
