import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

interface BalanceEntry {
  provider: string;
  balanceUsd: number;
  burnRateUsdPerDay: number;
  runwayDays: number | null;
  lowBalanceThresholdUsd?: number;
  lastTopUpDate?: string;
  lastTopUpAmountUsd?: number;
}

function RunwayBar({ days }: { days: number | null }) {
  if (days === null) return <span className="text-gray-400 text-sm">—</span>;
  const color = days > 14 ? 'bg-green-500' : days > 7 ? 'bg-yellow-500' : 'bg-red-500';
  const width = Math.min(100, (days / 30) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-gray-100 rounded-full h-2 max-w-[120px]">
        <div className={`${color} h-2 rounded-full`} style={{ width: `${width}%` }} />
      </div>
      <span className={`text-sm font-medium ${days > 14 ? 'text-green-700' : days > 7 ? 'text-yellow-700' : 'text-red-700'}`}>
        {days.toFixed(0)}d
      </span>
    </div>
  );
}

function TopUpModal({ provider, onClose }: { provider: string; onClose: () => void }) {
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => api.recordTopUp(provider, parseFloat(amount)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['balances'] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="font-semibold text-gray-800">Record top-up — <span className="font-mono text-indigo-700">{provider}</span></h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg">✕</button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Amount (USD)</label>
            <div className="relative">
              <span className="absolute left-3 top-2 text-gray-400">$</span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full border rounded-lg pl-6 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>
          {error && <p className="text-red-600 text-sm">{error}</p>}
        </div>
        <div className="px-6 py-4 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0 || mutation.isPending}
            className="px-4 py-2 text-sm bg-indigo-700 text-white rounded-lg hover:bg-indigo-800 disabled:opacity-50"
          >
            {mutation.isPending ? 'Saving…' : 'Record'}
          </button>
        </div>
      </div>
    </div>
  );
}

function BalanceCard({ entry }: { entry: BalanceEntry }) {
  const [toppingUp, setToppingUp] = useState(false);
  const isLow = entry.lowBalanceThresholdUsd != null && entry.balanceUsd < entry.lowBalanceThresholdUsd;

  return (
    <div className={`border rounded-xl p-5 bg-white ${isLow ? 'border-red-300 ring-1 ring-red-200' : ''}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-gray-800 font-mono">{entry.provider}</span>
            {isLow && (
              <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">Low balance</span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
            <div>
              <span className="text-gray-500">Balance</span>
              <p className={`font-semibold ${isLow ? 'text-red-700' : 'text-gray-900'}`}>
                ${entry.balanceUsd.toFixed(2)}
              </p>
            </div>
            <div>
              <span className="text-gray-500">Burn rate</span>
              <p className="font-semibold text-gray-900">
                {entry.burnRateUsdPerDay > 0 ? `$${entry.burnRateUsdPerDay.toFixed(2)}/day` : '—'}
              </p>
            </div>
            <div className="col-span-2">
              <span className="text-gray-500 text-xs">Runway</span>
              <div className="mt-1">
                <RunwayBar days={entry.runwayDays} />
              </div>
            </div>
          </div>

          {entry.lastTopUpDate && (
            <p className="text-xs text-gray-400">
              Last top-up: ${entry.lastTopUpAmountUsd?.toFixed(2)} on {entry.lastTopUpDate}
            </p>
          )}
        </div>

        <button
          onClick={() => setToppingUp(true)}
          className="text-xs text-indigo-600 border border-indigo-200 hover:bg-indigo-50 px-3 py-1.5 rounded-lg shrink-0"
        >
          Record top-up
        </button>
      </div>

      {toppingUp && <TopUpModal provider={entry.provider} onClose={() => setToppingUp(false)} />}
    </div>
  );
}

export default function Balances() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['balances'],
    queryFn: () => api.getBalances(),
  });

  const balances = (data as BalanceEntry[] | undefined) ?? [];
  const lowCount = balances.filter(b => b.lowBalanceThresholdUsd != null && b.balanceUsd < b.lowBalanceThresholdUsd).length;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-gray-900">Balances & Runway</h1>
        {lowCount > 0 && (
          <span className="text-sm bg-red-100 text-red-700 px-3 py-1 rounded-full font-medium">
            {lowCount} provider{lowCount > 1 ? 's' : ''} low
          </span>
        )}
      </div>

      {isLoading && <p className="text-gray-500 text-sm">Loading…</p>}
      {error && <p className="text-red-600 text-sm">Error loading balances</p>}

      <div className="space-y-3">
        {balances.map(b => (
          <BalanceCard key={b.provider} entry={b} />
        ))}
      </div>
    </div>
  );
}
