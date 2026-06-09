import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

type Queue = 'background' | 'foreground';

interface Rung {
  provider: string;
  model: string;
  modelId?: string;
  endpoint?: string;
  lane: string;
  routingMode: string;
  fb?: boolean;
  note?: string;
}

interface Ladder {
  key: string;
  rungs: Rung[];
  aliasOf?: string;
}

function RungBadge({ rung }: { rung: Rung }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-mono
      ${rung.fb ? 'bg-yellow-100 text-yellow-800' : 'bg-blue-100 text-blue-800'}`}>
      {rung.provider}/{rung.model}
      {rung.fb && <span className="text-yellow-600">(fb)</span>}
    </span>
  );
}

function LadderRow({ ladder, queue, onEdit }: { ladder: Ladder; queue: Queue; onEdit: (l: Ladder) => void }) {
  return (
    <div className="border rounded-lg p-4 bg-white hover:shadow-sm transition-shadow">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-sm font-semibold text-gray-800">{ladder.key}</p>
          {ladder.aliasOf && (
            <p className="text-xs text-gray-500 mt-0.5">→ alias of <span className="font-mono">{ladder.aliasOf}</span></p>
          )}
          {!ladder.aliasOf && (
            <div className="flex flex-wrap gap-1 mt-2">
              {ladder.rungs.map((r, i) => (
                <span key={i} className="flex items-center gap-1">
                  <span className="text-gray-400 text-xs">{i + 1}.</span>
                  <RungBadge rung={r} />
                  <span className={`text-xs text-gray-400 font-mono`}>({r.lane})</span>
                </span>
              ))}
            </div>
          )}
        </div>
        {!ladder.aliasOf && (
          <button
            onClick={() => onEdit(ladder)}
            className="text-xs text-indigo-600 hover:underline whitespace-nowrap"
          >
            Edit
          </button>
        )}
      </div>
    </div>
  );
}

function EditModal({ ladder, queue, onClose }: { ladder: Ladder; queue: Queue; onClose: () => void }) {
  const qc = useQueryClient();
  const [rungs, setRungs] = useState<Rung[]>(ladder.rungs);
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: () => api.putLadder(queue, ladder.key, rungs),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['catalog', queue] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  function moveUp(i: number) {
    if (i === 0) return;
    const next = [...rungs];
    [next[i - 1], next[i]] = [next[i], next[i - 1]];
    setRungs(next);
  }

  function moveDown(i: number) {
    if (i === rungs.length - 1) return;
    const next = [...rungs];
    [next[i], next[i + 1]] = [next[i + 1], next[i]];
    setRungs(next);
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="font-semibold text-gray-800">Edit ladder: <span className="font-mono text-indigo-700">{ladder.key}</span></h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-2">
          {rungs.map((rung, i) => (
            <div key={i} className="border rounded-lg p-3 bg-gray-50 flex items-center gap-3">
              <span className="text-gray-400 text-xs w-4">{i + 1}</span>
              <div className="flex-1 font-mono text-sm">
                <span className="text-indigo-700">{rung.provider}</span>
                <span className="text-gray-400">/</span>
                <span>{rung.model}</span>
                {rung.fb && <span className="ml-2 text-xs text-yellow-600 bg-yellow-100 px-1.5 py-0.5 rounded">fb</span>}
                <span className="ml-2 text-xs text-gray-400">{rung.lane}</span>
              </div>
              <div className="flex gap-1">
                <button onClick={() => moveUp(i)} disabled={i === 0} className="text-gray-400 hover:text-gray-600 disabled:opacity-30 px-1">↑</button>
                <button onClick={() => moveDown(i)} disabled={i === rungs.length - 1} className="text-gray-400 hover:text-gray-600 disabled:opacity-30 px-1">↓</button>
              </div>
            </div>
          ))}
        </div>
        <div className="px-6 py-4 border-t flex items-center justify-between">
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <div className="ml-auto flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
            <button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
              className="px-4 py-2 text-sm bg-indigo-700 text-white rounded-lg hover:bg-indigo-800 disabled:opacity-50"
            >
              {mutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Catalog() {
  const [queue, setQueue] = useState<Queue>('background');
  const [editing, setEditing] = useState<Ladder | null>(null);
  const [filter, setFilter] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['catalog', queue],
    queryFn: () => api.getCatalog(queue),
  });

  const ladders: Ladder[] = data
    ? Object.entries((data as { ladders?: Record<string, unknown> }).ladders ?? {}).map(([key, val]) => {
        if (typeof val === 'object' && val !== null && 'aliasOf' in val) {
          return { key, rungs: [], aliasOf: (val as { aliasOf: string }).aliasOf };
        }
        return { key, rungs: (val as Rung[]) ?? [] };
      })
    : [];

  const filtered = filter
    ? ladders.filter(l => l.key.toLowerCase().includes(filter.toLowerCase()))
    : ladders;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-gray-900">Capability Catalog</h1>
        <div className="flex items-center gap-3">
          <input
            type="text"
            placeholder="Filter…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm w-48 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <div className="flex rounded-lg border overflow-hidden text-sm">
            {(['background', 'foreground'] as Queue[]).map(q => (
              <button
                key={q}
                onClick={() => setQueue(q)}
                className={`px-4 py-1.5 ${queue === q ? 'bg-indigo-700 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      </div>

      {data && (
        <p className="text-xs text-gray-400 mb-4 font-mono">
          version: {(data as { version?: string }).version ?? '—'}
        </p>
      )}

      {isLoading && <p className="text-gray-500 text-sm">Loading…</p>}
      {error && <p className="text-red-600 text-sm">Error loading catalog</p>}

      <div className="space-y-2">
        {filtered.map(ladder => (
          <LadderRow key={ladder.key} ladder={ladder} queue={queue} onEdit={setEditing} />
        ))}
      </div>

      {editing && (
        <EditModal ladder={editing} queue={queue} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}
