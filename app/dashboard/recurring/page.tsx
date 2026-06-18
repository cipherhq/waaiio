'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness, useRequireCapability } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { PageHelp } from '@/components/dashboard/PageHelp';

interface Sub {
  id: string;
  user_id: string;
  service_id: string | null;
  service_name?: string;
  amount: number;
  currency: string;
  frequency: string;
  status: string;
  card_last_four: string | null;
  card_brand: string | null;
  next_charge_at: string | null;
  last_charged_at: string | null;
  charge_count: number;
  total_charged: number;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  setup_channel: string | null;
  created_at: string;
  updated_at: string | null;
}

const statusColors: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  paused: 'bg-yellow-100 text-yellow-800',
  past_due: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-100 text-gray-600',
};

export default function RecurringDashboardPage() {
  const business = useBusiness();
  const capReady = useRequireCapability('recurring');
  const cc = (business.country_code || 'NG') as CountryCode;

  const [subs, setSubs] = useState<Sub[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [frequencyFilter, setFrequencyFilter] = useState('all');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      setError(false);
      const supabase = createClient();

      const { data } = await supabase
        .from('customer_subscriptions')
        .select('*')
        .eq('business_id', business.id)
        .order('created_at', { ascending: false });

      if (data) {
        // Enrich with service names
        const svcIds = [...new Set(data.map(s => s.service_id).filter(Boolean))];
        let serviceMap = new Map<string, string>();

        if (svcIds.length > 0) {
          const { data: services } = await supabase.from('services').select('id, name').in('id', svcIds);
          serviceMap = new Map((services || []).map(s => [s.id, s.name]));
        }

        setSubs(data.map(s => ({ ...s, service_name: serviceMap.get(s.service_id) || 'Payment' })));
      }
    } catch {
      setError(true);
    }
    setLoading(false);
  }, [business.id]);

  useEffect(() => { loadData(); }, [loadData]);

  async function handleAction(subId: string, action: 'pause' | 'resume' | 'cancel') {
    setActionLoading(subId);
    try {
      const res = await fetch('/api/recurring/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionId: subId, action }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || 'Failed to update subscription');
      }
    } catch {
      alert('Failed to update subscription. Please try again.');
    }
    setActionLoading(null);
    loadData();
  }

  const filtered = subs.filter(s => {
    if (statusFilter !== 'all' && s.status !== statusFilter) return false;
    if (frequencyFilter !== 'all' && s.frequency !== frequencyFilter) return false;
    return true;
  });

  // Summary stats
  const activeSubs = subs.filter(s => s.status === 'active');
  const mrr = activeSubs
    .filter(s => s.frequency === 'monthly')
    .reduce((sum, s) => sum + s.amount, 0);
  const wrr = activeSubs
    .filter(s => s.frequency === 'weekly')
    .reduce((sum, s) => sum + s.amount, 0);
  const churnThisMonth = subs.filter(s => {
    if (s.status !== 'cancelled') return false;
    const d = new Date();
    const startOfMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    // Use updated_at (when status changed to cancelled) instead of created_at
    const cancelledAt = s.updated_at || s.created_at;
    if (!cancelledAt) return false;
    return new Date(cancelledAt) >= startOfMonth;
  }).length;

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Recurring Payments</h1>
      <p className="mt-1 text-sm text-gray-500">Manage automatic recurring customer payments</p>

      <PageHelp
        pageKey="recurring"
        title="Subscriptions"
        description="View and manage recurring payments. Pause, resume, or cancel subscriber auto-charges."
      />

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          Something went wrong loading data. <button onClick={() => { setError(false); loadData(); }} className="font-medium underline hover:no-underline">Try again</button>
        </div>
      )}

      {/* Summary Cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-4">
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
          <p className="text-xs font-medium text-gray-500">Active Subscribers</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{activeSubs.length}</p>
        </div>
        <div className="rounded-xl border border-green-100 bg-green-50 p-4">
          <p className="text-xs font-medium text-gray-500">Monthly Recurring</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{formatCurrency(mrr, cc)}</p>
        </div>
        <div className="rounded-xl border border-brand-100 bg-brand-50 p-4">
          <p className="text-xs font-medium text-gray-500">Weekly Recurring</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{formatCurrency(wrr, cc)}</p>
        </div>
        <div className="rounded-xl border border-red-100 bg-red-50 p-4">
          <p className="text-xs font-medium text-gray-500">Churn This Month</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{churnThisMonth}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Statuses</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="past_due">Past Due</option>
          <option value="cancelled">Cancelled</option>
        </select>

        <select
          value={frequencyFilter}
          onChange={(e) => setFrequencyFilter(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Frequencies</option>
          <option value="monthly">Monthly</option>
          <option value="weekly">Weekly</option>
        </select>
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {filtered.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">
            {subs.length === 0 ? 'No recurring subscribers yet.' : 'No matching subscribers.'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Customer</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Service</th>
                <th scope="col" className="px-4 py-3 text-right font-medium text-gray-500">Amount</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Frequency</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Card</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Last Charged</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Next Charge</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filtered.map((s) => (
                <tr key={s.id} className="transition hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{s.customer_name || 'Unknown'}</div>
                    <div className="text-xs text-gray-400">{s.customer_phone}</div>
                  </td>
                  <td className="px-4 py-3 text-gray-700">{s.service_name}</td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">
                    {formatCurrency(s.amount, cc)}
                  </td>
                  <td className="px-4 py-3 capitalize text-gray-600">{s.frequency}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[s.status] || 'bg-gray-100 text-gray-600'}`}>
                      {s.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {s.card_last_four ? `*${s.card_last_four}` : '\u2014'}
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                    {s.last_charged_at
                      ? new Date(s.last_charged_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
                      : '\u2014'}
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                    {s.next_charge_at && s.status === 'active'
                      ? new Date(s.next_charge_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
                      : '\u2014'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      {s.status === 'active' && (
                        <>
                          <button
                            onClick={() => handleAction(s.id, 'pause')}
                            disabled={actionLoading === s.id}
                            className="rounded-md bg-yellow-50 px-2 py-1 text-xs font-medium text-yellow-700 hover:bg-yellow-100 disabled:opacity-50"
                          >
                            Pause
                          </button>
                          <button
                            onClick={() => handleAction(s.id, 'cancel')}
                            disabled={actionLoading === s.id}
                            className="rounded-md bg-red-50 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-100 disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </>
                      )}
                      {s.status === 'paused' && (
                        <>
                          <button
                            onClick={() => handleAction(s.id, 'resume')}
                            disabled={actionLoading === s.id}
                            className="rounded-md bg-green-50 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-100 disabled:opacity-50"
                          >
                            Resume
                          </button>
                          <button
                            onClick={() => handleAction(s.id, 'cancel')}
                            disabled={actionLoading === s.id}
                            className="rounded-md bg-red-50 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-100 disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
