import { useEffect, useState } from 'react';
import { adminDb } from '@/lib/supabase';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDateTime } from '@/lib/formatters';
import { TrendingDown, AlertCircle, CheckCircle, XCircle, RotateCcw } from 'lucide-react';

interface DropoffRow {
  id: string;
  business_id: string;
  flow_type: string | null;
  step_id: string | null;
  reason: string;
  capability: string | null;
  created_at: string;
}

interface DropoffSummary {
  reason: string;
  count: number;
}

const REASON_LABELS: Record<string, { label: string; color: string }> = {
  completed: { label: 'Completed', color: 'text-green-600' },
  cancelled: { label: 'Cancelled', color: 'text-yellow-600' },
  restarted: { label: 'Restarted', color: 'text-blue-600' },
  error: { label: 'Error', color: 'text-red-600' },
  timeout: { label: 'Timeout', color: 'text-orange-600' },
  tier_restricted: { label: 'Tier Restricted', color: 'text-purple-600' },
  abuse: { label: 'Abuse', color: 'text-red-800' },
  webhook_confirmed: { label: 'Webhook Confirmed', color: 'text-green-700' },
};

export default function BotDropoffs() {
  const [dropoffs, setDropoffs] = useState<DropoffRow[]>([]);
  const [summary, setSummary] = useState<DropoffSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterReason, setFilterReason] = useState<string>('all');
  const [filterFlow, setFilterFlow] = useState<string>('all');
  const [flowTypes, setFlowTypes] = useState<string[]>([]);

  useEffect(() => {
    loadData();
  }, [filterReason, filterFlow]);

  async function loadData() {
    setLoading(true);
    try {
      // Load summary counts
      const { data: allDropoffs } = await adminDb
        .from('flow_dropoffs')
        .select('reason')
        .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

      if (allDropoffs) {
        const counts = new Map<string, number>();
        for (const d of allDropoffs) {
          counts.set(d.reason, (counts.get(d.reason) || 0) + 1);
        }
        setSummary(Array.from(counts.entries()).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count));
      }

      // Load recent dropoffs with filters
      let query = adminDb
        .from('flow_dropoffs')
        .select('id, business_id, flow_type, step_id, reason, capability, created_at')
        .order('created_at', { ascending: false })
        .limit(100);

      if (filterReason !== 'all') query = query.eq('reason', filterReason);
      if (filterFlow !== 'all') query = query.eq('flow_type', filterFlow);

      const { data } = await query;
      setDropoffs(data || []);

      // Get distinct flow types
      const { data: flows } = await adminDb
        .from('flow_dropoffs')
        .select('flow_type')
        .not('flow_type', 'is', null)
        .limit(100);
      if (flows) {
        const unique = [...new Set(flows.map(f => f.flow_type).filter(Boolean))] as string[];
        setFlowTypes(unique.sort());
      }
    } catch (err) {
      console.error('[BotDropoffs] Load error:', err);
    } finally {
      setLoading(false);
    }
  }

  const totalDropoffs = summary.reduce((sum, s) => sum + s.count, 0);
  const errorCount = summary.find(s => s.reason === 'error')?.count || 0;
  const completedCount = summary.find(s => s.reason === 'completed')?.count || 0;
  const cancelledCount = summary.find(s => s.reason === 'cancelled')?.count || 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Bot Flow Dropoffs</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Read-only view of bot conversation exit points across all businesses (last 7 days)
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryCard title="Total Exits" value={totalDropoffs} icon={<TrendingDown className="h-5 w-5" />} />
        <SummaryCard title="Completed" value={completedCount} icon={<CheckCircle className="h-5 w-5 text-green-600" />} />
        <SummaryCard title="Cancelled" value={cancelledCount} icon={<XCircle className="h-5 w-5 text-yellow-600" />} />
        <SummaryCard title="Errors" value={errorCount} icon={<AlertCircle className="h-5 w-5 text-red-600" />} />
      </div>

      {/* Reason breakdown */}
      {summary.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">Exit Reasons (7 days)</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {summary.map(s => {
              const info = REASON_LABELS[s.reason] || { label: s.reason, color: 'text-gray-600' };
              return (
                <button
                  key={s.reason}
                  onClick={() => setFilterReason(filterReason === s.reason ? 'all' : s.reason)}
                  className={`text-left p-2 rounded-md border ${filterReason === s.reason ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20' : 'border-gray-200 dark:border-gray-600'}`}
                >
                  <span className={`text-lg font-bold ${info.color}`}>{s.count}</span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400">{info.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3">
        <select
          value={filterReason}
          onChange={e => setFilterReason(e.target.value)}
          className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
        >
          <option value="all">All Reasons</option>
          {Object.entries(REASON_LABELS).map(([key, val]) => (
            <option key={key} value={key}>{val.label}</option>
          ))}
        </select>
        <select
          value={filterFlow}
          onChange={e => setFilterFlow(e.target.value)}
          className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
        >
          <option value="all">All Flows</option>
          {flowTypes.map(ft => (
            <option key={ft} value={ft}>{ft}</option>
          ))}
        </select>
        <button onClick={loadData} className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700">
          <RotateCcw className="h-4 w-4" />
        </button>
      </div>

      {/* Recent dropoffs table */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-900">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Time</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Reason</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Flow</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Step</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Capability</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Business</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">Loading...</td></tr>
            ) : dropoffs.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">No dropoffs found</td></tr>
            ) : dropoffs.map(d => {
              const info = REASON_LABELS[d.reason] || { label: d.reason, color: 'text-gray-600' };
              return (
                <tr key={d.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                  <td className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">{fmtDateTime(d.created_at)}</td>
                  <td className={`px-4 py-2 text-sm font-medium ${info.color}`}>{info.label}</td>
                  <td className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300">{d.flow_type || '-'}</td>
                  <td className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 font-mono text-xs">{d.step_id || '-'}</td>
                  <td className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300">{d.capability || '-'}</td>
                  <td className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400 font-mono text-xs">{d.business_id?.slice(0, 8) || '-'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
