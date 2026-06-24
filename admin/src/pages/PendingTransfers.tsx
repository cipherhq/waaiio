import { useEffect, useRef, useState } from 'react';
import { adminDb } from '@/lib/supabase';
import { logAudit } from '@/lib/auditLog';
import { useAdminSession } from '@/components/AdminLayout';
import { downloadCSV } from '@/lib/csv';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime, fmtCurrency } from '@/lib/formatters';

interface TransferRecord {
  id: string;
  business_id: string;
  business_name?: string;
  booking_id: string | null;
  order_id: string | null;
  invoice_id: string | null;
  customer_phone: string | null;
  customer_name: string | null;
  expected_amount: number;
  currency: string;
  reference_code: string;
  status: string;
  proof_type: string | null;
  proof_image_url: string | null;
  proof_text: string | null;
  verified_by_ocr: boolean;
  ocr_result: Record<string, unknown> | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  rejected_reason: string | null;
  expires_at: string | null;
  created_at: string;
}

export default function PendingTransfers() {
  const adminSession = useAdminSession();
  const [transfers, setTransfers] = useState<TransferRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [selected, setSelected] = useState<TransferRecord | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');
  const perPage = 20;

  const loadingRef = useRef(false);

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      const { data: transferData } = await adminDb
        .from('pending_transfers')
        .select('*')
        .order('created_at', { ascending: false });

      // Resolve business names
      const bizIds = [...new Set((transferData || []).map(t => t.business_id).filter(Boolean))];
      const { data: businesses } = bizIds.length > 0
        ? await adminDb.from('businesses').select('id, name').in('id', bizIds)
        : { data: [] };
      const bizMap = new Map((businesses || []).map(b => [b.id, b.name]));

      const enriched: TransferRecord[] = (transferData || []).map(t => ({
        ...t,
        business_name: t.business_id ? bizMap.get(t.business_id) || 'Unknown' : 'Unknown',
      }));

      setTransfers(enriched);
    } catch (error) {
      console.warn('Failed to load pending transfers:', error);
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
  const filtered = transfers.filter(t => {
    if (statusFilter !== 'all' && t.status !== statusFilter) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchesBusiness = t.business_name?.toLowerCase().includes(q);
      const matchesCustomer = t.customer_name?.toLowerCase().includes(q);
      const matchesRef = t.reference_code?.toLowerCase().includes(q);
      if (!matchesBusiness && !matchesCustomer && !matchesRef) return false;
    }
    if (dateFrom && t.created_at < dateFrom) return false;
    if (dateTo) {
      const nextDay = new Date(dateTo + 'T00:00:00Z');
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      if (t.created_at >= nextDay.toISOString()) return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  // Summary stats
  const pendingItems = transfers.filter(t => t.status === 'pending');
  const pendingAmount: Record<string, number> = {};
  for (const t of pendingItems) {
    const cur = t.currency || 'NGN';
    pendingAmount[cur] = (pendingAmount[cur] || 0) + Number(t.expected_amount || 0);
  }
  const pendingDisplay = Object.entries(pendingAmount)
    .filter(([, a]) => a > 0)
    .map(([c, a]) => fmtCurrency(a, c))
    .join(' · ') || '0';

  const today = new Date().toISOString().slice(0, 10);
  const confirmedToday = transfers.filter(
    t => t.status === 'confirmed' && t.confirmed_at && t.confirmed_at.slice(0, 10) === today,
  ).length;
  const rejectedCount = transfers.filter(t => t.status === 'rejected').length;
  const expiredCount = transfers.filter(t => t.status === 'expired').length;
  const ocrVerifiedCount = transfers.filter(t => t.verified_by_ocr).length;

  async function handleConfirm() {
    if (!selected || !adminSession) return;
    setActionLoading(true);
    setActionError('');
    setActionSuccess('');

    try {
      const { error } = await adminDb
        .from('pending_transfers')
        .update({
          status: 'confirmed',
          confirmed_at: new Date().toISOString(),
          confirmed_by: adminSession.userId,
        })
        .eq('id', selected.id)
        .eq('status', 'pending');

      if (error) {
        setActionError(error.message || 'Failed to confirm transfer');
        setActionLoading(false);
        return;
      }

      // Update related booking/order/invoice status
      if (selected.booking_id) {
        await adminDb.from('bookings').update({
          deposit_status: 'paid',
          status: 'confirmed',
          confirmed_at: new Date().toISOString(),
        }).eq('id', selected.booking_id);
      }
      if (selected.order_id) {
        await adminDb.from('orders').update({
          status: 'confirmed',
          paid_at: new Date().toISOString(),
        }).eq('id', selected.order_id);
      }
      if (selected.invoice_id) {
        await adminDb.from('invoices').update({
          status: 'paid',
          paid_at: new Date().toISOString(),
        }).eq('id', selected.invoice_id);
      }

      // Insert payment record (matches dashboard pending-transfers API behavior)
      await adminDb.from('payments').insert({
        business_id: selected.business_id,
        amount: selected.expected_amount,
        currency: selected.currency || 'NGN',
        status: 'success',
        payment_method: 'bank_transfer',
        gateway: 'direct',
        booking_id: selected.booking_id || null,
        order_id: selected.order_id || null,
        invoice_id: selected.invoice_id || null,
        customer_phone: selected.customer_phone || null,
        customer_name: selected.customer_name || null,
        reference: selected.reference_code || null,
        metadata: {
          pending_transfer_id: selected.id,
          confirmed_by: adminSession.userId,
          confirmed_by_admin: true,
          proof_type: selected.proof_type,
        },
      });

      // Insert platform fee record for analytics (zero fee for direct transfers)
      const { data: bizTier } = await adminDb
        .from('businesses')
        .select('subscription_tier')
        .eq('id', selected.business_id)
        .single();

      await adminDb.from('platform_fees').insert({
        business_id: selected.business_id,
        booking_id: selected.booking_id || null,
        invoice_id: selected.invoice_id || null,
        order_id: selected.order_id || null,
        transaction_amount: selected.expected_amount,
        fee_percentage: 0,
        fee_flat: 0,
        fee_total: 0,
        gateway_fee: 0,
        tier: bizTier?.subscription_tier || 'free',
        is_direct_transfer: true,
      });

      // Best-effort WhatsApp notification to customer
      if (selected.customer_phone) {
        try {
          const apiUrl = import.meta.env.VITE_API_URL || '';
          if (apiUrl) {
            await fetch(`${apiUrl}/api/admin/notify-transfer-confirmed`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                business_id: selected.business_id,
                customer_phone: selected.customer_phone,
                amount: selected.expected_amount,
                currency: selected.currency || 'NGN',
                reference_code: selected.reference_code,
              }),
            }).catch(() => { /* best-effort — ignore failures */ });
          }
        } catch {
          // Best-effort — notification failure should not block confirmation
        }
      }

      await logAudit({
        action: 'confirm_transfer',
        entity_type: 'pending_transfer',
        entity_id: selected.id,
        details: {
          business_id: selected.business_id,
          amount: selected.expected_amount,
          currency: selected.currency,
          reference_code: selected.reference_code,
        },
      });

      setActionSuccess('Transfer confirmed successfully');
      loadData();
      // Update selected record locally
      setSelected(prev => prev ? { ...prev, status: 'confirmed', confirmed_at: new Date().toISOString(), confirmed_by: adminSession.userId } : null);
    } catch {
      setActionError('Network error — please try again');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleReject() {
    if (!selected || !adminSession) return;
    if (!rejectReason.trim()) {
      setActionError('Please enter a reason for rejection');
      return;
    }
    setActionLoading(true);
    setActionError('');
    setActionSuccess('');

    try {
      const { error } = await adminDb
        .from('pending_transfers')
        .update({
          status: 'rejected',
          rejected_reason: rejectReason.trim(),
        })
        .eq('id', selected.id)
        .eq('status', 'pending');

      if (error) {
        setActionError(error.message || 'Failed to reject transfer');
        setActionLoading(false);
        return;
      }

      await logAudit({
        action: 'reject_transfer',
        entity_type: 'pending_transfer',
        entity_id: selected.id,
        details: {
          business_id: selected.business_id,
          amount: selected.expected_amount,
          currency: selected.currency,
          reference_code: selected.reference_code,
          reason: rejectReason.trim(),
        },
      });

      setActionSuccess('Transfer rejected');
      setRejectReason('');
      loadData();
      setSelected(prev => prev ? { ...prev, status: 'rejected', rejected_reason: rejectReason.trim() } : null);
    } catch {
      setActionError('Network error — please try again');
    } finally {
      setActionLoading(false);
    }
  }

  function formatAmount(amount: number, currency: string) {
    return fmtCurrency(amount, currency || 'NGN');
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  const statusTabs = [
    { value: 'all', label: 'All' },
    { value: 'pending', label: 'Pending' },
    { value: 'confirmed', label: 'Confirmed' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'expired', label: 'Expired' },
  ];

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            Bank Transfers <span className="ml-2 text-xs text-gray-400">Auto-refreshing</span>
          </h1>
          <p className="mt-1 text-sm text-gray-500">Manage pending bank transfer verifications</p>
        </div>
        <button
          onClick={() => downloadCSV(
            filtered.map(t => ({
              reference: t.reference_code,
              business: t.business_name,
              customer: t.customer_name || t.customer_phone || '',
              amount: t.expected_amount,
              currency: t.currency || 'NGN',
              status: t.status,
              proof_type: t.proof_type || '',
              ocr_verified: t.verified_by_ocr ? 'Yes' : 'No',
              created: t.created_at,
              expires: t.expires_at || '',
              confirmed_at: t.confirmed_at || '',
              rejected_reason: t.rejected_reason || '',
            })),
            `bank-transfers-${new Date().toISOString().slice(0, 10)}.csv`,
          )}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
        >
          Export CSV
        </button>
      </div>

      {/* Summary cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-5">
        <div className="rounded-xl border border-yellow-100 bg-yellow-50 p-4">
          <p className="text-xs font-medium text-gray-500">Pending ({pendingItems.length})</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{pendingDisplay}</p>
        </div>
        <div className="rounded-xl border border-green-100 bg-green-50 p-4">
          <p className="text-xs font-medium text-gray-500">Confirmed Today</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{confirmedToday}</p>
        </div>
        <div className="rounded-xl border border-red-100 bg-red-50 p-4">
          <p className="text-xs font-medium text-gray-500">Rejected</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{rejectedCount}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-gray-50 p-4">
          <p className="text-xs font-medium text-gray-500">Expired</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{expiredCount}</p>
        </div>
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
          <p className="text-xs font-medium text-gray-500">OCR Verified</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{ocrVerifiedCount}</p>
        </div>
      </div>

      {/* Status filter tabs */}
      <div className="mt-6 flex gap-1 rounded-lg bg-gray-100 p-1">
        {statusTabs.map(tab => (
          <button
            key={tab.value}
            onClick={() => { setStatusFilter(tab.value); setPage(1); }}
            className={`rounded-md px-4 py-2 text-sm font-medium transition ${
              statusFilter === tab.value
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={searchQuery}
          onChange={e => { setSearchQuery(e.target.value); setPage(1); }}
          placeholder="Search business, customer, or reference..."
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none w-64"
        />

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

        {(searchQuery || dateFrom || dateTo) && (
          <button
            onClick={() => {
              setSearchQuery('');
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
          <div className="py-16 text-center text-sm text-gray-500">No transfers found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Reference</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Customer</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Amount</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Proof</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">OCR</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Created</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Expires / Confirmed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(t => (
                <tr
                  key={t.id}
                  onClick={() => { setSelected(t); setActionError(''); setActionSuccess(''); setRejectReason(''); }}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">
                    {t.reference_code}
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-900">{t.business_name}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {t.customer_name || t.customer_phone || '—'}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">
                    {formatAmount(t.expected_amount, t.currency)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={t.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-600 capitalize">{t.proof_type || '—'}</td>
                  <td className="px-4 py-3">
                    {t.verified_by_ocr ? (
                      <span className="inline-block rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Yes</span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtDate(t.created_at)}</td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                    {t.status === 'confirmed' && t.confirmed_at
                      ? fmtDate(t.confirmed_at)
                      : t.expires_at
                        ? fmtDate(t.expires_at)
                        : '—'}
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
        onClose={() => { setSelected(null); setRejectReason(''); setActionError(''); setActionSuccess(''); }}
        title="Transfer Details"
        wide
      >
        {selected && (
          <div className="space-y-3 text-sm">
            <DetailRow label="Transfer ID" value={selected.id} />
            <DetailRow label="Reference Code" value={selected.reference_code} />
            <DetailRow label="Business" value={selected.business_name || 'Unknown'} />
            <DetailRow label="Customer Name" value={selected.customer_name} />
            <DetailRow label="Customer Phone" value={selected.customer_phone} />
            <DetailRow label="Amount" value={formatAmount(selected.expected_amount, selected.currency)} />
            <DetailRow label="Currency" value={selected.currency?.toUpperCase()} />
            <DetailRow label="Status" value={<StatusBadge status={selected.status} />} />

            <div className="my-3 border-t border-gray-100" />

            <DetailRow label="Booking ID" value={selected.booking_id ? selected.booking_id.slice(0, 8) + '...' : null} />
            <DetailRow label="Order ID" value={selected.order_id ? selected.order_id.slice(0, 8) + '...' : null} />
            <DetailRow label="Invoice ID" value={selected.invoice_id ? selected.invoice_id.slice(0, 8) + '...' : null} />

            <div className="my-3 border-t border-gray-100" />

            <DetailRow label="Proof Type" value={selected.proof_type} />
            <DetailRow label="OCR Verified" value={selected.verified_by_ocr ? 'Yes' : 'No'} />

            {selected.proof_image_url && (
              <div className="mt-3">
                <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Proof Image</p>
                <img
                  src={selected.proof_image_url}
                  alt="Transfer proof"
                  className="max-h-80 rounded-lg border border-gray-200 object-contain"
                />
              </div>
            )}

            {selected.proof_text && (
              <div className="mt-3">
                <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Proof Text</p>
                <div className="rounded-lg bg-gray-50 p-3">
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{selected.proof_text}</p>
                </div>
              </div>
            )}

            {selected.ocr_result && Object.keys(selected.ocr_result).length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-semibold uppercase text-gray-500 mb-2">OCR Result</p>
                <div className="rounded-lg bg-gray-50 p-3">
                  <pre className="text-xs text-gray-600 whitespace-pre-wrap break-words">
                    {JSON.stringify(selected.ocr_result, null, 2)}
                  </pre>
                </div>
              </div>
            )}

            <div className="my-3 border-t border-gray-100" />

            <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />
            <DetailRow label="Expires" value={selected.expires_at ? fmtDateTime(selected.expires_at) : null} />
            <DetailRow label="Confirmed At" value={selected.confirmed_at ? fmtDateTime(selected.confirmed_at) : null} />
            <DetailRow label="Confirmed By" value={selected.confirmed_by ? selected.confirmed_by.slice(0, 8) + '...' : null} />
            <DetailRow label="Rejected Reason" value={selected.rejected_reason} />

            {/* Admin actions for pending transfers */}
            {selected.status === 'pending' && (
              <>
                <div className="my-3 border-t border-gray-100" />
                <div className="space-y-3">
                  {/* Confirm button */}
                  <button
                    onClick={handleConfirm}
                    disabled={actionLoading}
                    className="w-full rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
                  >
                    {actionLoading ? 'Processing...' : 'Confirm Transfer'}
                  </button>

                  {/* Reject section */}
                  <div className="rounded-lg border border-red-100 bg-red-50 p-4">
                    <p className="text-sm font-semibold text-red-800">Reject Transfer</p>
                    <textarea
                      value={rejectReason}
                      onChange={e => setRejectReason(e.target.value)}
                      rows={2}
                      placeholder="Reason for rejection (required)"
                      className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                    <button
                      onClick={handleReject}
                      disabled={actionLoading}
                      className="mt-2 w-full rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {actionLoading ? 'Processing...' : 'Reject Transfer'}
                    </button>
                  </div>

                  {actionError && <p className="text-xs text-red-600">{actionError}</p>}
                  {actionSuccess && <p className="text-xs text-green-600">{actionSuccess}</p>}
                </div>
              </>
            )}
          </div>
        )}
      </DetailModal>
    </div>
  );
}
