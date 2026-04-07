import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime, fmtCurrency } from '@/lib/formatters';

interface SubscriptionRecord {
  id: string;
  business_id: string;
  business_name?: string;
  business_category?: string;
  plan_name: string | null;
  tier: string;
  status: string;
  amount: number;
  currency: string | null;
  interval: string | null;
  auto_renew: boolean;
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  gateway: string | null;
  gateway_subscription_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string | null;
}

export default function Subscriptions() {
  const [subscriptions, setSubscriptions] = useState<SubscriptionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('all');
  const [tierFilter, setTierFilter] = useState('all');
  const [selected, setSelected] = useState<SubscriptionRecord | null>(null);
  const perPage = 20;

  const loadingRef = useRef(false);

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      // Try join first; if businesses relation isn't set up, fall back to separate query
      const { data: subData, error } = await supabase
        .from('subscriptions')
        .select('*, businesses(name, category)')
        .order('created_at', { ascending: false });

      if (error || !subData) {
        // Fallback: load subscriptions then batch-load business names
        const { data: rawSubs } = await supabase
          .from('subscriptions')
          .select('*')
          .order('created_at', { ascending: false });

        const bizIds = [...new Set((rawSubs || []).map(s => s.business_id).filter(Boolean))];
        const { data: businesses } = bizIds.length > 0
          ? await supabase.from('businesses').select('id, name, category').in('id', bizIds)
          : { data: [] };

        const bizMap = new Map((businesses || []).map(b => [b.id, { name: b.name, category: b.category }]));

        const enriched: SubscriptionRecord[] = (rawSubs || []).map(s => ({
          ...s,
          business_name: bizMap.get(s.business_id)?.name || 'Unknown',
          business_category: bizMap.get(s.business_id)?.category || '—',
        }));

        setSubscriptions(enriched);
      } else {
        // Join succeeded — extract business info from nested relation
        const enriched: SubscriptionRecord[] = subData.map((s: any) => {
          const biz = s.businesses;
          const { businesses: _, ...rest } = s;
          return {
            ...rest,
            business_name: biz?.name || 'Unknown',
            business_category: biz?.category || '—',
          };
        });

        setSubscriptions(enriched);
      }
    } catch (err) {
      console.warn('Failed to load subscriptions:', err);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  useEffect(() => { loadData(); }, []);

  // Derive unique tiers for filter dropdown
  const uniqueTiers = [...new Set(subscriptions.map(s => s.tier).filter(Boolean))].sort();

  // Apply filters
  const filtered = subscriptions.filter(s => {
    if (statusFilter !== 'all' && s.status !== statusFilter) return false;
    if (tierFilter !== 'all' && s.tier !== tierFilter) return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  // Summary stats
  const activeCount = subscriptions.filter(s => s.status === 'active').length;
  const trialCount = subscriptions.filter(s => s.status === 'trial').length;
  const mrr = subscriptions
    .filter(s => s.status === 'active')
    .reduce((sum, s) => {
      const amt = Number(s.amount || 0);
      if (s.interval === 'yearly' || s.interval === 'annual') return sum + amt / 12;
      return sum + amt;
    }, 0);

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
        <h1 className="text-2xl font-bold text-gray-900">Subscriptions</h1>
        <p className="mt-1 text-sm text-gray-500">Manage business subscription plans</p>
      </div>

      {/* Summary cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-green-100 bg-green-50 p-4">
          <p className="text-xs font-medium text-gray-500">Active</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{activeCount}</p>
        </div>
        <div className="rounded-xl border border-yellow-100 bg-yellow-50 p-4">
          <p className="text-xs font-medium text-gray-500">On Trial</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{trialCount}</p>
        </div>
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
          <p className="text-xs font-medium text-gray-500">Est. MRR</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{fmtCurrency(mrr)}</p>
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
          <option value="cancelled">Cancelled</option>
          <option value="expired">Expired</option>
          <option value="trial">Trial</option>
        </select>

        <select
          value={tierFilter}
          onChange={e => { setTierFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Tiers</option>
          {uniqueTiers.map(t => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>

        {(statusFilter !== 'all' || tierFilter !== 'all') && (
          <button
            onClick={() => {
              setStatusFilter('all');
              setTierFilter('all');
              setPage(1);
            }}
            className="text-sm text-brand hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No subscriptions found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Plan / Tier</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Amount</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Start</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">End</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Auto-renew</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(s => (
                <tr
                  key={s.id}
                  onClick={() => setSelected(s)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-medium text-gray-900">{s.business_name}</td>
                  <td className="px-4 py-3 text-gray-600">
                    <span className="capitalize">{s.plan_name || s.tier}</span>
                    {s.plan_name && s.tier && s.plan_name !== s.tier && (
                      <span className="ml-1.5 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500 capitalize">
                        {s.tier}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">
                    {fmtCurrency(s.amount, s.currency || undefined)}
                    {s.interval && (
                      <span className="ml-1 text-xs text-gray-400">/{s.interval === 'yearly' || s.interval === 'annual' ? 'yr' : 'mo'}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                    {s.current_period_start ? fmtDate(s.current_period_start) : fmtDate(s.created_at)}
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                    {s.current_period_end ? fmtDate(s.current_period_end) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                      s.auto_renew ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
                    }`}>
                      {s.auto_renew ? 'Yes' : 'No'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Detail Modal */}
      <DetailModal
        open={!!selected}
        onClose={() => setSelected(null)}
        title="Subscription Details"
      >
        {selected && (
          <div className="space-y-3 text-sm">
            <DetailRow label="Subscription ID" value={selected.id} />
            <DetailRow label="Business" value={selected.business_name || 'Unknown'} />
            <DetailRow label="Category" value={selected.business_category} />
            <DetailRow label="Plan" value={selected.plan_name} />
            <DetailRow label="Tier" value={selected.tier} />
            <DetailRow label="Status" value={selected.status} />

            <div className="my-3 border-t border-gray-100" />

            <DetailRow label="Amount" value={fmtCurrency(selected.amount, selected.currency || undefined)} />
            <DetailRow label="Currency" value={selected.currency?.toUpperCase()} />
            <DetailRow label="Interval" value={selected.interval} />
            <DetailRow label="Auto-renew" value={selected.auto_renew ? 'Yes' : 'No'} />

            <div className="my-3 border-t border-gray-100" />

            <DetailRow
              label="Period Start"
              value={selected.current_period_start ? fmtDateTime(selected.current_period_start) : null}
            />
            <DetailRow
              label="Period End"
              value={selected.current_period_end ? fmtDateTime(selected.current_period_end) : null}
            />
            <DetailRow
              label="Trial Ends"
              value={selected.trial_ends_at ? fmtDateTime(selected.trial_ends_at) : null}
            />
            <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />
            <DetailRow label="Updated" value={selected.updated_at ? fmtDateTime(selected.updated_at) : null} />

            {selected.cancelled_at && (
              <>
                <div className="my-3 border-t border-gray-100" />
                <DetailRow label="Cancelled At" value={fmtDateTime(selected.cancelled_at)} />
                <DetailRow label="Cancellation Reason" value={selected.cancellation_reason} />
              </>
            )}

            <div className="my-3 border-t border-gray-100" />

            <DetailRow label="Gateway" value={selected.gateway} />
            <DetailRow label="Gateway Subscription ID" value={selected.gateway_subscription_id} />

            {selected.metadata && Object.keys(selected.metadata).length > 0 && (
              <>
                <div className="my-3 border-t border-gray-100" />
                <div className="rounded-lg bg-gray-50 p-3">
                  <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Metadata</p>
                  <pre className="text-xs text-gray-600 whitespace-pre-wrap break-words">
                    {JSON.stringify(selected.metadata, null, 2)}
                  </pre>
                </div>
              </>
            )}

            {/* Payment history hint */}
            <div className="mt-4 rounded-lg border border-blue-100 bg-blue-50 p-3">
              <p className="text-xs text-blue-700">
                To view payment history for this subscription, visit the{' '}
                <span className="font-semibold">Payments</span> page and filter by this business.
              </p>
            </div>
          </div>
        )}
      </DetailModal>
    </div>
  );
}
