import { useEffect, useRef, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { logAudit } from '@/lib/auditLog';
import { useAdminSession } from '@/components/AdminLayout';
import { isFullAdmin } from '@/lib/adminAuth';
import { downloadCSV } from '@/lib/csv';
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
  const adminSession = useAdminSession();
  const canMutate = isFullAdmin(adminSession);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [refundRequests, setRefundRequests] = useState<Array<{ id: string; payment_id: string; business_id: string; customer_name: string; customer_phone: string; amount: number; currency?: string; reason: string; status: string; created_at: string }>>([]);
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

      // Resolve business IDs: directly from payment, via booking, or via order
      const bookingIds = [...new Set((paymentData || []).map(p => p.booking_id).filter(Boolean))];
      const { data: bookings } = bookingIds.length > 0
        ? await adminDb.from('bookings').select('id, business_id, reference_code').in('id', bookingIds)
        : { data: [] };
      const bookingMap = new Map((bookings || []).map(b => [b.id, b]));

      const orderIds = [...new Set((paymentData || []).map(p => p.order_id).filter(Boolean))];
      const { data: orders } = orderIds.length > 0
        ? await adminDb.from('orders').select('id, business_id, reference_code').in('id', orderIds)
        : { data: [] };
      const orderMap = new Map((orders || []).map(o => [o.id, o]));

      // Collect all business IDs (from payments + bookings + orders)
      const allBizIds = new Set<string>();
      for (const p of paymentData || []) {
        if (p.business_id) allBizIds.add(p.business_id);
        else if (p.booking_id) {
          const bk = bookingMap.get(p.booking_id);
          if (bk?.business_id) allBizIds.add(bk.business_id);
        } else if (p.order_id) {
          const ord = orderMap.get(p.order_id);
          if (ord?.business_id) allBizIds.add(ord.business_id);
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
          const order = p.order_id ? orderMap.get(p.order_id) : null;
          const resolvedBizId = p.business_id || booking?.business_id || order?.business_id || null;
          return {
            ...p,
            business_id: resolvedBizId,
            business_name: resolvedBizId ? bizMap.get(resolvedBizId) || 'Unknown' : 'Unknown',
            gateway_ref: booking?.reference_code || order?.reference_code || p.gateway_reference?.slice(-12) || p.id.slice(0, 8),
          };
        })
        .filter(p => !givingBizIds.has(p.business_id));

      setPayments(enriched);

      // Load refund requests and resolve currency from payments
      const { data: reqData } = await adminDb.from('refund_requests').select('*').order('created_at', { ascending: false });
      const paymentCurrencyMap = new Map((enriched || []).map(p => [p.id, p.currency || 'NGN']));
      const enrichedRequests = (reqData || []).map(r => ({
        ...r,
        currency: paymentCurrencyMap.get(r.payment_id) || 'NGN',
      }));
      setRefundRequests(enrichedRequests);
    } catch (error) {
      console.warn('Failed to load payments:', error);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30_000);
    return () => clearInterval(interval);
  }, []);

  // Apply filters
  const filtered = payments.filter(p => {
    if (statusFilter !== 'all' && p.status !== statusFilter) return false;
    if (gatewayFilter !== 'all' && p.gateway !== gatewayFilter) return false;
    if (dateFrom && p.created_at < dateFrom) return false;
    if (dateTo) {
      // Include the entire "dateTo" day by comparing against start of next day
      const nextDay = new Date(dateTo + 'T00:00:00Z');
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      const nextDayISO = nextDay.toISOString();
      if (p.created_at >= nextDayISO) return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  // Summary stats — per currency
  const totalByCurrency: Record<string, number> = {};
  const refundByCurrency: Record<string, number> = {};
  for (const p of filtered) {
    const cur = p.currency || 'NGN';
    totalByCurrency[cur] = (totalByCurrency[cur] || 0) + Number(p.amount || 0);
    if (Number(p.refund_amount || 0) > 0) {
      refundByCurrency[cur] = (refundByCurrency[cur] || 0) + Number(p.refund_amount || 0);
    }
  }
  const totalDisplay = Object.entries(totalByCurrency).filter(([, a]) => a > 0).map(([c, a]) => fmtCurrency(a, c)).join(' · ') || '—';
  const refundDisplay = Object.entries(refundByCurrency).filter(([, a]) => a > 0).map(([c, a]) => fmtCurrency(a, c)).join(' · ') || '—';
  const successCount = filtered.filter(p => p.status === 'success').length;
  const failedCount = filtered.filter(p => p.status === 'failed').length;
  const refundedCount = filtered.filter(p => Number(p.refund_amount || 0) > 0).length;

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Payments <span className="ml-2 text-xs text-gray-400">Auto-refreshing</span></h1>
          <p className="mt-1 text-sm text-gray-500">View and inspect all payment transactions</p>
        </div>
        <button
          onClick={() => downloadCSV(
            filtered.map(p => ({
              ref: p.gateway_ref || p.id.slice(0, 8),
              business: p.business_name,
              amount: p.amount,
              currency: p.currency || 'NGN',
              gateway: p.gateway || '',
              status: p.status,
              method: p.payment_method || '',
              refund_amount: p.refund_amount || 0,
              date: p.created_at,
            })),
            `payments-${new Date().toISOString().slice(0, 10)}.csv`,
          )}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
        >
          Export CSV
        </button>
      </div>

      {/* Pending Refund Requests */}
      {refundRequests.filter(r => r.status === 'pending').length > 0 && (
        <div className="mt-4 rounded-xl border border-orange-200 bg-orange-50 p-4">
          <h3 className="text-sm font-semibold text-orange-800">
            Pending Refund Requests ({refundRequests.filter(r => r.status === 'pending').length})
          </h3>
          <div className="mt-3 space-y-2">
            {refundRequests.filter(r => r.status === 'pending').slice(0, 5).map(req => (
              <div key={req.id} className="flex items-center justify-between rounded-lg bg-white px-3 py-2 text-sm">
                <div>
                  <span className="font-medium text-gray-900">{req.customer_name || req.customer_phone}</span>
                  <span className="ml-2 text-gray-500">{fmtCurrency(req.amount, req.currency || undefined)}</span>
                  {req.reason && <span className="ml-2 text-xs text-gray-400">— {req.reason}</span>}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={async () => {
                      if (!canMutate || !confirm(`Approve and process refund of ${fmtCurrency(req.amount, req.currency || undefined)} to ${req.customer_name || req.customer_phone}?`)) return;
                      try {
                        // Call the actual refund API to process the gateway refund
                        const apiUrl = import.meta.env.VITE_API_URL || '';
                        const { data: session } = await supabase.auth.getSession();
                        const token = session?.session?.access_token;
                        const res = await fetch(`${apiUrl}/api/admin/payments/refund`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                          body: JSON.stringify({ paymentId: req.payment_id, businessId: req.business_id, amount: req.amount, reason: req.reason || 'Approved refund request' }),
                        });
                        const data = await res.json();
                        if (!res.ok) { alert(data.error || 'Refund failed'); return; }
                        // Mark request as approved
                        await adminDb.from('refund_requests').update({ status: 'approved', reviewed_at: new Date().toISOString(), reviewed_by: session?.session?.user?.id }).eq('id', req.id);
                        await logAudit({ action: 'approve_refund_request', entity_type: 'refund_request', entity_id: req.id, details: { payment_id: req.payment_id, amount: req.amount } });
                        await loadData();
                      } catch { alert('Failed to process refund'); }
                    }}
                    className="rounded px-2 py-1 text-xs font-medium text-green-700 bg-green-100 hover:bg-green-200"
                  >
                    Approve & Refund
                  </button>
                  <button
                    onClick={async () => {
                      if (!canMutate || !confirm('Reject this refund request?')) return;
                      await adminDb.from('refund_requests').update({ status: 'rejected', reviewed_at: new Date().toISOString() }).eq('id', req.id);
                      await loadData();
                    }}
                    className="rounded px-2 py-1 text-xs font-medium text-red-700 bg-red-100 hover:bg-red-200"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Summary cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-4">
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
          <p className="text-xs font-medium text-gray-500">Total ({filtered.length})</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{totalDisplay}</p>
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
          <p className="mt-1 text-xl font-bold text-gray-900">{refundDisplay}</p>
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
