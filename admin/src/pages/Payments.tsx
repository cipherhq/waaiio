import { useEffect, useRef, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { logAudit } from '@/lib/auditLog';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime, fmtCurrency } from '@/lib/formatters';

// Categories handled by the Giving page — excluded here
const GIVING_CATEGORIES = ['church', 'mosque', 'ngo', 'crowdfunding_org'];

interface PaymentRecord {
  id: string;
  business_id: string;
  business_name?: string;
  amount: number;
  refund_amount: number;
  currency: string | null;
  gateway: string | null;
  gateway_ref: string | null;
  status: string;
  payment_method: string | null;
  booking_id: string | null;
  order_id: string | null;
  customer_id: string | null;
  customer_email?: string | null;
  customer_name?: string | null;
  metadata: Record<string, unknown> | null;
  failure_reason: string | null;
  refunded_at: string | null;
  created_at: string;
  updated_at: string | null;
}

export default function Payments() {
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('all');
  const [gatewayFilter, setGatewayFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [selected, setSelected] = useState<PaymentRecord | null>(null);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [refundLoading, setRefundLoading] = useState(false);
  const [refundError, setRefundError] = useState('');
  const [refundSuccess, setRefundSuccess] = useState('');
  const perPage = 20;

  const loadingRef = useRef(false);

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      const { data: paymentData } = await adminDb
        .from('payments')
        .select('*')
        .order('created_at', { ascending: false });

      // Resolve business IDs: directly from payment or via booking
      const bookingIds = [...new Set((paymentData || []).map(p => p.booking_id).filter(Boolean))];
      const { data: bookings } = bookingIds.length > 0
        ? await adminDb.from('bookings').select('id, business_id, reference_code').in('id', bookingIds)
        : { data: [] };
      const bookingMap = new Map((bookings || []).map(b => [b.id, b]));

      // Collect all business IDs (from payments + bookings)
      const allBizIds = new Set<string>();
      for (const p of paymentData || []) {
        if (p.business_id) allBizIds.add(p.business_id);
        else if (p.booking_id) {
          const bk = bookingMap.get(p.booking_id);
          if (bk?.business_id) allBizIds.add(bk.business_id);
        }
      }

      const { data: businesses } = allBizIds.size > 0
        ? await adminDb.from('businesses').select('id, name, category').in('id', [...allBizIds])
        : { data: [] };

      const givingBizIds = new Set(
        (businesses || []).filter(b => GIVING_CATEGORIES.includes(b.category)).map(b => b.id)
      );
      const bizMap = new Map((businesses || []).map(b => [b.id, b.name]));

      // Enrich payments with business name + booking reference
      const enriched: PaymentRecord[] = (paymentData || [])
        .map(p => {
          const booking = p.booking_id ? bookingMap.get(p.booking_id) : null;
          const resolvedBizId = p.business_id || booking?.business_id || null;
          return {
            ...p,
            business_id: resolvedBizId,
            business_name: resolvedBizId ? bizMap.get(resolvedBizId) || 'Unknown' : 'Unknown',
            gateway_ref: booking?.reference_code || p.gateway_reference?.slice(-12) || p.id.slice(0, 8),
          };
        })
        .filter(p => !givingBizIds.has(p.business_id));

      setPayments(enriched);
    } catch (error) {
      console.warn('Failed to load payments:', error);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  useEffect(() => { loadData(); }, []);

  // Apply filters
  const filtered = payments.filter(p => {
    if (statusFilter !== 'all' && p.status !== statusFilter) return false;
    if (gatewayFilter !== 'all' && p.gateway !== gatewayFilter) return false;
    if (dateFrom && p.created_at < dateFrom) return false;
    if (dateTo) {
      // Include the entire "dateTo" day by comparing against start of next day
      const endOfDay = dateTo + 'T23:59:59.999Z';
      if (p.created_at > endOfDay) return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  // Summary stats
  const totalAmount = filtered.reduce((s, p) => s + Number(p.amount || 0), 0);
  const successCount = filtered.filter(p => p.status === 'success').length;
  const failedCount = filtered.filter(p => p.status === 'failed').length;
  const refundedCount = filtered.filter(p => Number(p.refund_amount || 0) > 0).length;
  const refundedTotal = filtered.reduce((s, p) => s + Number(p.refund_amount || 0), 0);

  async function handleAdminRefund() {
    if (!selected) return;
    const amt = parseFloat(refundAmount);
    const remaining = Number(selected.amount) - Number(selected.refund_amount || 0);
    if (isNaN(amt) || amt <= 0) { setRefundError('Enter a valid amount'); return; }
    if (amt > remaining) { setRefundError(`Maximum refundable: ${fmtCurrency(remaining, selected.currency || undefined)}`); return; }

    setRefundLoading(true);
    setRefundError('');
    setRefundSuccess('');

    try {
      const apiUrl = import.meta.env.VITE_API_URL || '';
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) { setRefundError('Not authenticated'); setRefundLoading(false); return; }

      const res = await fetch(`${apiUrl}/api/admin/payments/refund`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          paymentId: selected.id,
          businessId: selected.business_id,
          amount: amt,
          reason: refundReason.trim() || undefined,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setRefundError(data.error || 'Refund failed');
        setRefundLoading(false);
        return;
      }

      await logAudit({
        action: 'refund_payment',
        entity_type: 'payment',
        entity_id: selected.id,
        details: { amount: amt, reason: refundReason.trim(), refundId: data.refundId, isDirectSplit: data.isDirectSplit },
      });

      setRefundSuccess(data.isDirectSplit
        ? 'Refund recorded (direct split — please return funds manually)'
        : 'Refund processed successfully');
      setRefundAmount('');
      setRefundReason('');
      loadData();
    } catch {
      setRefundError('Network error — please try again');
    } finally {
      setRefundLoading(false);
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
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Payments</h1>
        <p className="mt-1 text-sm text-gray-500">View and inspect all payment transactions</p>
      </div>

      {/* Summary cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-4">
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
          <p className="text-xs font-medium text-gray-500">Total ({filtered.length})</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{fmtCurrency(totalAmount)}</p>
        </div>
        <div className="rounded-xl border border-green-100 bg-green-50 p-4">
          <p className="text-xs font-medium text-gray-500">Successful</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{successCount}</p>
        </div>
        <div className="rounded-xl border border-red-100 bg-red-50 p-4">
          <p className="text-xs font-medium text-gray-500">Failed</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{failedCount}</p>
        </div>
        <div className="rounded-xl border border-orange-100 bg-orange-50 p-4">
          <p className="text-xs font-medium text-gray-500">Refunded ({refundedCount})</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{fmtCurrency(refundedTotal)}</p>
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
          <option value="success">Success</option>
          <option value="pending">Pending</option>
          <option value="failed">Failed</option>
          <option value="refunded">Refunded</option>
        </select>

        <select
          value={gatewayFilter}
          onChange={e => { setGatewayFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Gateways</option>
          <option value="paystack">Paystack</option>
          <option value="stripe">Stripe</option>
          <option value="flutterwave">Flutterwave</option>
        </select>

        <input
          type="date"
          value={dateFrom}
          onChange={e => { setDateFrom(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        />
        <span className="text-sm text-gray-400">to</span>
        <input
          type="date"
          value={dateTo}
          onChange={e => { setDateTo(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        />

        {(statusFilter !== 'all' || gatewayFilter !== 'all' || dateFrom || dateTo) && (
          <button
            onClick={() => {
              setStatusFilter('all');
              setGatewayFilter('all');
              setDateFrom('');
              setDateTo('');
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
          <div className="py-16 text-center text-sm text-gray-500">No payments found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Ref</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Amount</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Gateway</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Method</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(p => (
                <tr
                  key={p.id}
                  onClick={() => setSelected(p)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">
                    {p.gateway_ref || p.id.slice(0, 8)}
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-900">{p.business_name}</td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">
                    {fmtCurrency(p.amount, p.currency || undefined)}
                  </td>
                  <td className="px-4 py-3 text-gray-600 capitalize">{p.gateway || '—'}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-600 capitalize">{p.payment_method || '—'}</td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtDate(p.created_at)}</td>
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
        onClose={() => { setSelected(null); setRefundAmount(''); setRefundReason(''); setRefundError(''); setRefundSuccess(''); }}
        title="Payment Details"
      >
        {selected && (
          <div className="space-y-3 text-sm">
            <DetailRow label="Payment ID" value={selected.id} />
            <DetailRow label="Business" value={selected.business_name || 'Unknown'} />
            <DetailRow label="Amount" value={fmtCurrency(selected.amount, selected.currency || undefined)} />
            <DetailRow label="Currency" value={selected.currency?.toUpperCase()} />
            <DetailRow label="Gateway" value={selected.gateway} />
            <DetailRow label="Gateway Ref" value={selected.gateway_ref} />
            <DetailRow label="Status" value={selected.status} />
            <DetailRow label="Payment Method" value={selected.payment_method} />

            <div className="my-3 border-t border-gray-100" />

            <DetailRow
              label="Booking / Order"
              value={selected.booking_id ? selected.booking_id.slice(0, 8) + '...' : selected.order_id ? selected.order_id.slice(0, 8) + '...' : null}
            />
            <DetailRow label="Customer ID" value={selected.customer_id ? selected.customer_id.slice(0, 8) + '...' : null} />
            <DetailRow label="Customer Email" value={selected.customer_email} />
            <DetailRow label="Customer Name" value={selected.customer_name} />

            <div className="my-3 border-t border-gray-100" />

            <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />
            <DetailRow label="Updated" value={selected.updated_at ? fmtDateTime(selected.updated_at) : null} />
            <DetailRow label="Refunded At" value={selected.refunded_at ? fmtDateTime(selected.refunded_at) : null} />
            <DetailRow label="Failure Reason" value={selected.failure_reason} />

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

            {/* Refund Section */}
            {(selected.status === 'success' || (selected.status === 'refunded' && Number(selected.refund_amount || 0) < Number(selected.amount))) && (
              <>
                <div className="my-3 border-t border-gray-100" />
                <div className="rounded-lg border border-red-100 bg-red-50 p-4">
                  <p className="text-sm font-semibold text-red-800">Issue Refund</p>
                  {Number(selected.refund_amount || 0) > 0 && (
                    <p className="mt-1 text-xs text-red-600">
                      Already refunded: {fmtCurrency(Number(selected.refund_amount), selected.currency || undefined)} of {fmtCurrency(selected.amount, selected.currency || undefined)}
                    </p>
                  )}
                  <div className="mt-3 space-y-2">
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      max={Number(selected.amount) - Number(selected.refund_amount || 0)}
                      value={refundAmount}
                      onChange={e => setRefundAmount(e.target.value)}
                      placeholder={`Amount (max ${fmtCurrency(Number(selected.amount) - Number(selected.refund_amount || 0), selected.currency || undefined)})`}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setRefundAmount(String(Number(selected.amount) - Number(selected.refund_amount || 0)))}
                        className="rounded-md bg-white border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Full
                      </button>
                      <button
                        type="button"
                        onClick={() => setRefundAmount(String(Math.round((Number(selected.amount) - Number(selected.refund_amount || 0)) / 2 * 100) / 100))}
                        className="rounded-md bg-white border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Half
                      </button>
                    </div>
                    <textarea
                      value={refundReason}
                      onChange={e => setRefundReason(e.target.value)}
                      rows={2}
                      placeholder="Reason (optional)"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                    {refundError && <p className="text-xs text-red-600">{refundError}</p>}
                    {refundSuccess && <p className="text-xs text-green-600">{refundSuccess}</p>}
                    <button
                      onClick={handleAdminRefund}
                      disabled={refundLoading}
                      className="w-full rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {refundLoading ? 'Processing...' : 'Confirm Refund'}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </DetailModal>
    </div>
  );
}
