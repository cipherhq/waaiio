'use client';

import { useEffect, useMemo, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';

interface DropoffRow {
  id: string;
  flow_type: string;
  step_name: string | null;
  reason: string | null;
  capability: string | null;
  created_at: string;
}

interface FunnelRow {
  flow_type: string;
  total: number;
  completed: number;
  cancelled: number;
  error: number;
  completionRate: number;
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

const reasonColors: Record<string, string> = {
  completed: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  error: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  cancelled: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
  restarted: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  timeout: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
};

export default function FlowDropoffsPage() {
  const business = useBusiness();
  const [loading, setLoading] = useState(true);
  const [dropoffs, setDropoffs] = useState<DropoffRow[]>([]);

  useEffect(() => {
    async function load() {
      const supabase = createClient();
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const { data } = await supabase
        .from('flow_dropoffs')
        .select('id, flow_type, step_name, reason, capability, created_at')
        .eq('business_id', business.id)
        .gte('created_at', thirtyDaysAgo.toISOString())
        .order('created_at', { ascending: false })
        .limit(500);

      setDropoffs(data || []);
      setLoading(false);
    }
    load();
  }, [business.id]);

  // Summary stats
  const totalSessions = dropoffs.length;
  const completedCount = dropoffs.filter(d => d.reason === 'completed').length;
  const completionRate = totalSessions > 0 ? Math.round((completedCount / totalSessions) * 100) : 0;

  // Top drop-off step (most cancelled step)
  const cancelledDropoffs = dropoffs.filter(d => d.reason === 'cancelled');
  const stepCounts = new Map<string, number>();
  for (const d of cancelledDropoffs) {
    const step = d.step_name || 'unknown';
    stepCounts.set(step, (stepCounts.get(step) || 0) + 1);
  }
  const topDropoffStep = stepCounts.size > 0
    ? Array.from(stepCounts.entries()).sort((a, b) => b[1] - a[1])[0][0]
    : '--';

  // Most used capability
  const capCounts = new Map<string, number>();
  for (const d of dropoffs) {
    if (d.capability) {
      capCounts.set(d.capability, (capCounts.get(d.capability) || 0) + 1);
    }
  }
  const topCapability = capCounts.size > 0
    ? Array.from(capCounts.entries()).sort((a, b) => b[1] - a[1])[0][0]
    : '--';

  // Funnel table grouped by flow_type
  const funnelData = useMemo(() => {
    const map = new Map<string, { total: number; completed: number; cancelled: number; error: number }>();
    for (const d of dropoffs) {
      const ft = d.flow_type || 'unknown';
      const existing = map.get(ft) || { total: 0, completed: 0, cancelled: 0, error: 0 };
      existing.total++;
      if (d.reason === 'completed') existing.completed++;
      else if (d.reason === 'cancelled') existing.cancelled++;
      else if (d.reason === 'error') existing.error++;
      map.set(ft, existing);
    }
    const rows: FunnelRow[] = Array.from(map.entries())
      .map(([flow_type, stats]) => ({
        flow_type,
        ...stats,
        completionRate: stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0,
      }))
      .sort((a, b) => b.total - a.total);
    return rows;
  }, [dropoffs]);

  // Recent drop-offs (last 20 non-completed)
  const recentDropoffs = useMemo(() => {
    return dropoffs.slice(0, 20);
  }, [dropoffs]);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Flow Drop-off Analytics</h1>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Where users abandon conversations (last 30 days)
      </p>

      {/* Summary Stat Cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Total Sessions"
          value={totalSessions}
          icon="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
          color="brand"
        />
        <StatCard
          label="Completion Rate"
          value={`${completionRate}%`}
          icon="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
          color="green"
          sub={`${completedCount} completed`}
        />
        <StatCard
          label="Top Drop-off Step"
          value={topDropoffStep.replace(/_/g, ' ')}
          icon="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          color="amber"
          sub={`${stepCounts.get(topDropoffStep) || 0} drop-offs`}
        />
        <StatCard
          label="Most Used Capability"
          value={topCapability.replace(/_/g, ' ')}
          icon="M13 10V3L4 14h7v7l9-11h-7z"
          color="blue"
          sub={`${capCounts.get(topCapability) || 0} sessions`}
        />
      </div>

      {/* Drop-off Funnel Table */}
      {funnelData.length > 0 && (
        <div className="mt-8">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Drop-off Funnel by Flow Type</h2>
          <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                <tr>
                  <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Flow Type</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium text-gray-500 dark:text-gray-400">Total</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium text-gray-500 dark:text-gray-400">Completed</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium text-gray-500 dark:text-gray-400">Cancelled</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium text-gray-500 dark:text-gray-400">Errors</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium text-gray-500 dark:text-gray-400">Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700">
                {funnelData.map((row) => (
                  <tr key={row.flow_type} className="transition hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 capitalize">
                      {row.flow_type.replace(/_/g, ' ')}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700 dark:text-gray-300">{row.total}</td>
                    <td className="px-4 py-3 text-right text-green-600 dark:text-green-400 font-medium">{row.completed}</td>
                    <td className="px-4 py-3 text-right text-yellow-600 dark:text-yellow-400 font-medium">{row.cancelled}</td>
                    <td className="px-4 py-3 text-right text-red-600 dark:text-red-400 font-medium">{row.error}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        row.completionRate >= 70
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                          : row.completionRate >= 40
                            ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300'
                            : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                      }`}>
                        {row.completionRate}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent Drop-offs */}
      <div className="mt-8">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Recent Sessions</h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Last 20 flow sessions</p>

        {recentDropoffs.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-gray-200 dark:border-gray-700 p-8 text-center">
            <p className="text-sm text-gray-500 dark:text-gray-400">No flow drop-off data yet</p>
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              Data will appear here once users interact with your bot flows
            </p>
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                <tr>
                  <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Time</th>
                  <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Flow Type</th>
                  <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Step</th>
                  <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700">
                {recentDropoffs.map((d) => (
                  <tr key={d.id} className="transition hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                      {timeAgo(d.created_at)}
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 capitalize">
                      {(d.flow_type || 'unknown').replace(/_/g, ' ')}
                    </td>
                    <td className="px-4 py-3 text-gray-700 dark:text-gray-300">
                      {(d.step_name || '--').replace(/_/g, ' ')}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                        reasonColors[d.reason || ''] || 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
                      }`}>
                        {(d.reason || 'unknown').replace(/_/g, ' ')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  color,
  sub,
}: {
  label: string;
  value: number | string;
  icon: string;
  color: 'brand' | 'blue' | 'amber' | 'green';
  sub?: string;
}) {
  const colorMap = {
    brand: 'bg-brand-50 text-brand dark:bg-brand-950/30',
    blue: 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
    amber: 'bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400',
    green: 'bg-green-50 text-green-600 dark:bg-green-900/30 dark:text-green-400',
  };

  return (
    <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</p>
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${colorMap[color]}`}>
          <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={icon} />
          </svg>
        </div>
      </div>
      <p className="mt-3 text-2xl font-bold text-gray-900 dark:text-gray-100 truncate">{value}</p>
      {sub && <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">{sub}</p>}
    </div>
  );
}
