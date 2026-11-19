import { useEffect, useRef, useState } from 'react';
import { adminApiFetch, adminApiGet, adminJson } from '@/lib/adminApi';
import { useStepUp } from '@/hooks/useStepUp';
import { StepUpDialog } from '@/components/StepUpDialog';
import { recurringStepUp, SUBSCRIPTION_STEP_UP_ACTION } from '../../../lib/admin-subscription-step-up';
import { useAdminSession } from '@/components/AdminLayout';
import { isFullAdmin } from '@/lib/adminAuth';
import { downloadCSV } from '@/lib/csv';
import { Pagination } from '@/components/Pagination';
import { SortableTh } from '@/components/SortableTh';
import { sortNumber, sortTime, useTableSort } from '@/lib/tableSort';
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

// Owner decisions 2026-11-18: pause/resume/cancel work like the merchant dashboard (gateway first,
// no refund, no message to the customer); retry gives a past_due Paystack/Flutterwave payment three
// more tries at the daily retry run. All go through POST /api/admin/recurring with a step-up and a
// reason; the server enforces every rule.
type RecurringAction = 'pause' | 'resume' | 'cancel' | 'retry';
const ACTION_LABEL: Record<RecurringAction, string> = { pause: 'Pause', resume: 'Resume', cancel: 'Cancel', retry: 'Retry' };
const RETRY_GATEWAYS = ['paystack', 'flutterwave'];

export default function RecurringPayments() {
  const adminSession = useAdminSession();
  const canMutate = isFullAdmin(adminSession);
  const [records, setRecords] = useState<RecurringRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('all');
  const [gatewayFilter, setGatewayFilter] = useState('all');
  const [frequencyFilter, setFrequencyFilter] = useState('all');
  const [selected, setSelected] = useState<RecurringRecord | null>(null);
  const [actionSaving, setActionSaving] = useState(false);
  const [actionReason, setActionReason] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [loadError, setLoadError] = useState('');
  const stepUp = useStepUp();
  const stepUpCallbackRef = useRef<((stepUpId: string) => Promise<void>) | null>(null);
  const stepUpFlightRef = useRef(false);
  const perPage = 20;
  const loadingRef = useRef(false);

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      // Read through /api/admin/recurring: customer_subscriptions has no admin read
      // policy, so the browser read showed nothing (#1108 X3).
      const { records: rows } = await adminJson<{ records: RecurringRecord[] }>(await adminApiGet('/api/admin/recurring'));
      setRecords(rows);
      setLoadError('');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load recurring payments');
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
  const { sorted, sortProps } = useTableSort(filtered, {
    business: r => r.business_name,
    customer: r => r.customer_name || 'Unknown',
    service: r => r.service_name,
    source: r => (r.service_billing_type === 'recurring' ? 'Service' : 'Opt-in'),
    amount: r => sortNumber(r.amount),
    frequency: r => r.frequency,
    gateway: r => r.gateway,
    status: r => r.status,
    created: r => sortTime(r.created_at),
    lastCharged: r => sortTime(r.last_charged_at),
  }, { onSortChange: () => setPage(1) });
  const pageItems = sorted.slice((page - 1) * perPage, page * perPage);

  // Summary stats
  const active = records.filter(r => r.status === 'active');
  const mrrByCurrency: Record<string, number> = {};
  const wrrByCurrency: Record<string, number> = {};
  for (const r of active) {
    const cur = r.currency || 'NGN';
    if (r.frequency === 'monthly') mrrByCurrency[cur] = (mrrByCurrency[cur] || 0) + Number(r.amount);
    if (r.frequency === 'weekly') wrrByCurrency[cur] = (wrrByCurrency[cur] || 0) + Number(r.amount);
  }
  const formatMulti = (amounts: Record<string, number>) => {
    const entries = Object.entries(amounts).filter(([, a]) => a > 0);
    if (entries.length === 0) return fmtCurrency(0);
    return entries.map(([cur, amt]) => fmtCurrency(amt, cur)).join(' · ');
  };
  const pastDue = records.filter(r => r.status === 'past_due').length;
  const cancelledThisMonth = records.filter(r => {
    if (r.status !== 'cancelled') return false;
    const d = new Date();
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    return r.cancelled_at ? new Date(r.cancelled_at) >= start : false;
  }).length;

  // A reason and message belong to the row they were typed or shown for.
  useEffect(() => { setActionReason(''); setActionMessage(''); }, [selected?.id]);

  async function runAction(action: RecurringAction) {
    if (!selected || !canMutate || actionSaving) return;
    const reason = actionReason.trim();
    if (reason.length < 3) { setActionMessage('Enter a reason (at least 3 characters).'); return; }
    if (action === 'cancel' && !confirm('Cancel this recurring payment at the payment provider? No refund is made and it cannot be undone.')) return;
    const { id, business_id: businessId } = selected;
    setActionSaving(true);
    setActionMessage('');
    const onAuthorized = async (stepUpId: string) => {
      const res = await adminApiFetch('/api/admin/recurring', { subscriptionId: id, businessId, action, reason, stepUpId });
      const data = await res.json().catch(() => ({}));
      stepUpCallbackRef.current = null;
      if (!res.ok) {
        setActionMessage(data.error || 'Nothing was changed.');
        // 409: the record changed; show the real state.
        if (res.status === 409) { setSelected(null); await loadData(); }
        return;
      }
      const now = new Date().toISOString();
      const patch: Partial<RecurringRecord> = action === 'pause' ? { status: 'paused', paused_at: now }
        : action === 'resume' ? { status: 'active', paused_at: null }
        : action === 'cancel' ? { status: 'cancelled', cancelled_at: now }
        : { failure_count: 0 };
      setRecords(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
      setSelected(prev => prev && prev.id === id ? { ...prev, ...patch } : prev);
      setActionReason('');
      if (data.auditRecorded === false) setActionMessage('Done, but the audit entry could not be recorded.');
    };
    stepUpCallbackRef.current = onAuthorized;
    const binding = recurringStepUp(id, businessId, action, reason);
    try {
      await stepUp.execute({
        actionType: SUBSCRIPTION_STEP_UP_ACTION,
        targetId: binding.targetId,
        params: binding.params,
        description: `${ACTION_LABEL[action]} ${selected.customer_name || 'this customer'}'s recurring payment to ${selected.business_name || 'this business'}`,
        onAuthorized,
      });
    } catch (err) {
      stepUpCallbackRef.current = null;
      setActionMessage(err instanceof Error ? err.message : 'Step-up failed');
      stepUp.reset();
    } finally {
      setActionSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Recurring Payments</h1>
          <p className="mt-1 text-sm text-gray-500">All recurring customer subscriptions across businesses</p>
        </div>
        <button
          onClick={() => downloadCSV(
            filtered.map(r => ({
              business: r.business_name,
              customer: r.customer_name || '',
              phone: r.customer_phone || '',
              service: r.service_name || '',
              amount: r.amount,
              currency: r.currency || 'NGN',
              frequency: r.frequency,
              gateway: r.gateway || '',
              status: r.status,
              charge_count: r.charge_count,
              total_charged: r.total_charged,
              next_charge: r.next_charge_at || '',
              created_at: r.created_at,
            })),
            `recurring-payments-${new Date().toISOString().slice(0, 10)}.csv`,
          )}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
        >
          Export CSV
        </button>
      </div>

      {/* Summary Cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-5">
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
          <p className="text-xs font-medium text-gray-500">Total Active</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{active.length}</p>
        </div>
        <div className="rounded-xl border border-green-100 bg-green-50 p-4">
          <p className="text-xs font-medium text-gray-500">MRR</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{formatMulti(mrrByCurrency)}</p>
        </div>
        <div className="rounded-xl border border-purple-100 bg-purple-50 p-4">
          <p className="text-xs font-medium text-gray-500">WRR</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{formatMulti(wrrByCurrency)}</p>
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
        {loadError ? (
          <div role="alert" className="py-16 text-center text-sm text-red-600">{loadError}</div>
        ) : pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No recurring payments found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <SortableTh {...sortProps('business')} className="px-4 py-3 text-left font-medium text-gray-500">Business</SortableTh>
                <SortableTh {...sortProps('customer')} className="px-4 py-3 text-left font-medium text-gray-500">Customer</SortableTh>
                <SortableTh {...sortProps('service')} className="px-4 py-3 text-left font-medium text-gray-500">Service</SortableTh>
                <SortableTh {...sortProps('source')} className="px-4 py-3 text-left font-medium text-gray-500">Source</SortableTh>
                <SortableTh {...sortProps('amount')} className="px-4 py-3 text-right font-medium text-gray-500">Amount</SortableTh>
                <SortableTh {...sortProps('frequency')} className="px-4 py-3 text-left font-medium text-gray-500">Freq</SortableTh>
                <SortableTh {...sortProps('gateway')} className="px-4 py-3 text-left font-medium text-gray-500">Gateway</SortableTh>
                <SortableTh {...sortProps('status')} className="px-4 py-3 text-left font-medium text-gray-500">Status</SortableTh>
                <SortableTh {...sortProps('created')} className="px-4 py-3 text-left font-medium text-gray-500">Created</SortableTh>
                <SortableTh {...sortProps('lastCharged')} className="px-4 py-3 text-left font-medium text-gray-500">Last Charged</SortableTh>
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

            {/* Admin Actions */}
            {selected.status !== 'cancelled' && (
              <>
                <div className="my-4 border-t-2 border-gray-200" />
                <p className="text-xs font-bold uppercase tracking-wider text-gray-500">Admin Actions</p>
                {!canMutate ? (
                  <p className="mt-2 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">Only a full admin can change a recurring payment.</p>
                ) : (
                  <>
                    <p className="mt-2 text-xs text-gray-500">
                      Changes are made at the payment provider first. No refund is made and the customer is not messaged.
                    </p>
                    <input
                      type="text"
                      placeholder="Reason (required)"
                      aria-label="Reason for this change"
                      value={actionReason}
                      onChange={e => setActionReason(e.target.value)}
                      maxLength={500}
                      className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-brand focus:outline-none"
                    />
                  </>
                )}
                {actionMessage && (
                  <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{actionMessage}</p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {selected.status === 'active' && (
                    <button
                      onClick={() => runAction('pause')}
                      disabled={!canMutate || actionSaving}
                      className="rounded-lg bg-yellow-100 px-4 py-2 text-sm font-medium text-yellow-700 hover:bg-yellow-200 disabled:opacity-50"
                    >
                      {actionSaving ? 'Saving...' : 'Pause'}
                    </button>
                  )}
                  {selected.status === 'paused' && (
                    <button
                      onClick={() => runAction('resume')}
                      disabled={!canMutate || actionSaving}
                      className="rounded-lg bg-green-100 px-4 py-2 text-sm font-medium text-green-700 hover:bg-green-200 disabled:opacity-50"
                    >
                      {actionSaving ? 'Saving...' : 'Resume'}
                    </button>
                  )}
                  {selected.status === 'past_due' && RETRY_GATEWAYS.includes(selected.gateway || '') && (
                    <button
                      onClick={() => runAction('retry')}
                      disabled={!canMutate || actionSaving}
                      title="Resets the failure count so the daily retry charges the saved card again (up to 3 tries)"
                      className="rounded-lg bg-blue-100 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-200 disabled:opacity-50"
                    >
                      {actionSaving ? 'Saving...' : 'Retry (3 more tries)'}
                    </button>
                  )}
                  {['active', 'paused', 'past_due'].includes(selected.status) && (
                    <button
                      onClick={() => runAction('cancel')}
                      disabled={!canMutate || actionSaving}
                      className="rounded-lg bg-red-100 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-200 disabled:opacity-50"
                    >
                      {actionSaving ? 'Saving...' : 'Cancel Subscription'}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </DetailModal>

      <StepUpDialog
        open={!!stepUpCallbackRef.current && (stepUp.state.phase === 'awaiting-code' || stepUp.state.phase === 'verifying')}
        description={stepUp.state.description} method={stepUp.state.method}
        error={stepUp.state.error}
        loading={stepUp.state.phase === 'verifying'}
        onSubmit={async (code) => {
          if (stepUpFlightRef.current || !stepUpCallbackRef.current) return;
          stepUpFlightRef.current = true;
          try { await stepUp.submitCode(code, stepUpCallbackRef.current); }
          finally {
            stepUpFlightRef.current = false;
            if (!stepUpCallbackRef.current) stepUp.reset();
          }
        }}
        onCancel={() => { stepUp.reset(); stepUpCallbackRef.current = null; }}
      />
    </div>
  );
}
