import { useEffect, useRef, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime, fmtCurrency } from '@/lib/formatters';

interface RecurringRecord {
  id: string;
  business_id: string;
  business_name?: string;
  user_id: string;
  service_id: string | null;
  service_name?: string;
  service_billing_type?: string;
  amount: number;
  currency: string;
  frequency: string;
  status: string;
  gateway: string | null;
  gateway_subscription_code: string | null;
  card_last_four: string | null;
  card_brand: string | null;
  next_charge_at: string | null;
  last_charged_at: string | null;
  charge_count: number;
  total_charged: number;
  failure_count: number;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  setup_channel: string | null;
  cancelled_at: string | null;
  paused_at: string | null;
  created_at: string;
}

export default function RecurringPayments() {
  const [records, setRecords] = useState<RecurringRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('all');
  const [gatewayFilter, setGatewayFilter] = useState('all');
  const [frequencyFilter, setFrequencyFilter] = useState('all');
  const [selected, setSelected] = useState<RecurringRecord | null>(null);
  const perPage = 20;
  const loadingRef = useRef(false);

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      const { data } = await adminDb
        .from('customer_subscriptions')
        .select('*')
        .order('created_at', { ascending: false });

      // Enrich with business and service names
      const bizIds = [...new Set((data || []).map(r => r.business_id))];
      const svcIds = [...new Set((data || []).map(r => r.service_id).filter(Boolean))];

      const { data: businesses } = bizIds.length > 0
        ? await adminDb.from('businesses').select('id, name').in('id', bizIds)
        : { data: [] };

      const { data: services } = svcIds.length > 0
        ? await adminDb.from('services').select('id, name, billing_type').in('id', svcIds)
        : { data: [] };

      const bizMap = new Map((businesses || []).map(b => [b.id, b.name]));
      const svcMap = new Map((services || []).map(s => [s.id, { name: s.name, billing_type: s.billing_type }]));

      setRecords(
        (data || []).map(r => {
          const svc = svcMap.get(r.service_id);
          return {
            ...r,
            business_name: bizMap.get(r.business_id) || 'Unknown',
            service_name: svc?.name || 'Payment',
            service_billing_type: svc?.billing_type || 'one_time',
          };
        }),
      );
    } catch (error) {
      console.warn('Failed to load recurring payments:', error);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  useEffect(() => { loadData(); }, []);

  const filtered = records.filter(r => {
    if (statusFilter !== 'all' && r.status !== statusFilter) return false;
    if (gatewayFilter !== 'all' && r.gateway !== gatewayFilter) return false;
    if (frequencyFilter !== 'all' && r.frequency !== frequencyFilter) return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  // Summary stats
  const active = records.filter(r => r.status === 'active');
  const mrr = active.filter(r => r.frequency === 'monthly').reduce((s, r) => s + Number(r.amount), 0);
  const wrr = active.filter(r => r.frequency === 'weekly').reduce((s, r) => s + Number(r.amount), 0);
  const pastDue = records.filter(r => r.status === 'past_due').length;
  const cancelledThisMonth = records.filter(r => {
    if (r.status !== 'cancelled') return false;
    const d = new Date();
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    return r.cancelled_at ? new Date(r.cancelled_at) >= start : false;
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
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Recurring Payments</h1>
        <p className="mt-1 text-sm text-gray-500">All recurring customer subscriptions across businesses</p>
      </div>

      {/* Summary Cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-5">
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
          <p className="text-xs font-medium text-gray-500">Total Active</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{active.length}</p>
        </div>
        <div className="rounded-xl border border-green-100 bg-green-50 p-4">
          <p className="text-xs font-medium text-gray-500">MRR</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{fmtCurrency(mrr)}</p>
        </div>
        <div className="rounded-xl border border-purple-100 bg-purple-50 p-4">
          <p className="text-xs font-medium text-gray-500">WRR</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{fmtCurrency(wrr)}</p>
        </div>
        <div className="rounded-xl border border-orange-100 bg-orange-50 p-4">
          <p className="text-xs font-medium text-gray-500">Past Due</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{pastDue}</p>
        </div>
        <div className="rounded-xl border border-red-100 bg-red-50 p-4">
          <p className="text-xs font-medium text-gray-500">Cancelled This Month</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{cancelledThisMonth}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Statuses</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="past_due">Past Due</option>
          <option value="cancelled">Cancelled</option>
        </select>

        <select
          value={gatewayFilter}
          onChange={e => { setGatewayFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Gateways</option>
          <option value="paystack">Paystack</option>
          <option value="stripe">Stripe</option>
        </select>

        <select
          value={frequencyFilter}
          onChange={e => { setFrequencyFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Frequencies</option>
          <option value="monthly">Monthly</option>
          <option value="weekly">Weekly</option>
        </select>

        {(statusFilter !== 'all' || gatewayFilter !== 'all' || frequencyFilter !== 'all') && (
          <button
            onClick={() => { setStatusFilter('all'); setGatewayFilter('all'); setFrequencyFilter('all'); setPage(1); }}
            className="text-sm text-brand hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No recurring payments found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Customer</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Service</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Source</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Amount</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Freq</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Gateway</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Created</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Last Charged</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(r => (
                <tr
                  key={r.id}
                  onClick={() => setSelected(r)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-medium text-gray-900">{r.business_name}</td>
                  <td className="px-4 py-3">
                    <div className="text-gray-900">{r.customer_name || 'Unknown'}</div>
                    <div className="text-xs text-gray-400">{r.customer_phone}</div>
                  </td>
                  <td className="px-4 py-3 text-gray-700">{r.service_name}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      r.service_billing_type === 'recurring'
                        ? 'bg-purple-100 text-purple-700'
                        : 'bg-gray-100 text-gray-600'
                    }`}>
                      {r.service_billing_type === 'recurring' ? 'Service' : 'Opt-in'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">
                    {fmtCurrency(r.amount, r.currency || undefined)}
                  </td>
                  <td className="px-4 py-3 capitalize text-gray-600">{r.frequency}</td>
                  <td className="px-4 py-3 capitalize text-gray-600">{r.gateway || '\u2014'}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtDate(r.created_at)}</td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                    {r.last_charged_at ? fmtDate(r.last_charged_at) : '\u2014'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Detail Modal */}
      <DetailModal open={!!selected} onClose={() => setSelected(null)} title="Subscription Details">
        {selected && (
          <div className="space-y-3 text-sm">
            <DetailRow label="Subscription ID" value={selected.id} />
            <DetailRow label="Business" value={selected.business_name} />
            <DetailRow label="Customer" value={selected.customer_name || 'Unknown'} />
            <DetailRow label="Phone" value={selected.customer_phone} />
            <DetailRow label="Email" value={selected.customer_email} />
            <DetailRow label="Service" value={selected.service_name} />
            <DetailRow label="Source" value={selected.service_billing_type === 'recurring' ? 'Service-level recurring' : 'Customer opt-in'} />

            <div className="my-3 border-t border-gray-100" />

            <DetailRow label="Amount" value={fmtCurrency(selected.amount, selected.currency || undefined)} />
            <DetailRow label="Frequency" value={selected.frequency} />
            <DetailRow label="Status" value={selected.status} />
            <DetailRow label="Gateway" value={selected.gateway} />
            <DetailRow label="Setup Channel" value={selected.setup_channel} />

            <div className="my-3 border-t border-gray-100" />

            <DetailRow label="Card" value={selected.card_last_four ? `*${selected.card_last_four} (${selected.card_brand})` : null} />
            <DetailRow label="Gateway Subscription" value={selected.gateway_subscription_code} />
            <DetailRow label="Total Charged" value={fmtCurrency(selected.total_charged, selected.currency || undefined)} />
            <DetailRow label="Charge Count" value={String(selected.charge_count)} />
            <DetailRow label="Failure Count" value={String(selected.failure_count)} />

            <div className="my-3 border-t border-gray-100" />

            <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />
            <DetailRow label="Last Charged" value={selected.last_charged_at ? fmtDateTime(selected.last_charged_at) : null} />
            <DetailRow label="Next Charge" value={selected.next_charge_at ? fmtDateTime(selected.next_charge_at) : null} />
            <DetailRow label="Paused At" value={selected.paused_at ? fmtDateTime(selected.paused_at) : null} />
            <DetailRow label="Cancelled At" value={selected.cancelled_at ? fmtDateTime(selected.cancelled_at) : null} />
          </div>
        )}
      </DetailModal>
    </div>
  );
}
