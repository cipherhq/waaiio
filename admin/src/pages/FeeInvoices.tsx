import { useEffect, useRef, useState } from 'react';
import { adminDb, supabase } from '@/lib/supabase';
import { logAudit } from '@/lib/auditLog';
import { useAdminSession } from '@/components/AdminLayout';
import { isFullAdmin } from '@/lib/adminAuth';
import { downloadCSV } from '@/lib/csv';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime, fmtCurrency } from '@/lib/formatters';

interface LineItem {
  payment_id?: string;
  description?: string;
  amount: number;
  fee: number;
  date?: string;
}

interface FeeInvoice {
  id: string;
  business_id: string;
  business_name?: string;
  invoice_number: string;
  period_start: string;
  period_end: string;
  total_transaction_amount: number;
  total_fee_amount: number;
  transaction_count: number;
  currency: string;
  status: string;
  due_date: string;
  paid_at: string | null;
  paid_via: string | null;
  payment_reference: string | null;
  waived_reason: string | null;
  waived_by: string | null;
  line_items: LineItem[] | null;
  created_at: string;
}

const STATUS_COLOR_MAP: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  paid: 'bg-green-100 text-green-700',
  overdue: 'bg-red-100 text-red-700',
  waived: 'bg-blue-100 text-blue-700',
  cancelled: 'bg-gray-100 text-gray-600',
};

const STATUS_TABS = ['all', 'pending', 'overdue', 'paid', 'waived'] as const;

export default function FeeInvoices() {
  const adminSession = useAdminSession();
  const canMutate = isFullAdmin(adminSession);
  const [invoices, setInvoices] = useState<FeeInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [selected, setSelected] = useState<FeeInvoice | null>(null);

  // Mark as Paid state
  const [payRef, setPayRef] = useState('');
  const [payLoading, setPayLoading] = useState(false);
  const [payError, setPayError] = useState('');
  const [paySuccess, setPaySuccess] = useState('');

  // Waive state
  const [waiveReason, setWaiveReason] = useState('');
  const [waiveLoading, setWaiveLoading] = useState(false);
  const [waiveError, setWaiveError] = useState('');
  const [waiveSuccess, setWaiveSuccess] = useState('');

  const perPage = 20;
  const loadingRef = useRef(false);

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      const { data: invoiceData } = await adminDb
        .from('platform_fee_invoices')
        .select('*')
        .order('created_at', { ascending: false });

      // Resolve business names
      const bizIds = [...new Set((invoiceData || []).map(i => i.business_id).filter(Boolean))];
      const { data: businesses } = bizIds.length > 0
        ? await adminDb.from('businesses').select('id, name').in('id', bizIds)
        : { data: [] };
      const bizMap = new Map((businesses || []).map(b => [b.id, b.name]));

      const enriched: FeeInvoice[] = (invoiceData || []).map(i => ({
        ...i,
        business_name: i.business_id ? bizMap.get(i.business_id) || 'Unknown' : 'Unknown',
      }));

      setInvoices(enriched);
    } catch (error) {
      console.warn('Failed to load fee invoices:', error);
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
  const filtered = invoices.filter(i => {
    if (statusFilter !== 'all' && i.status !== statusFilter) return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  // Summary stats
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const outstandingByCurrency: Record<string, number> = {};
  const collectedThisMonthByCurrency: Record<string, number> = {};
  let overdueCount = 0;
  const waivedByCurrency: Record<string, number> = {};

  for (const inv of invoices) {
    const cur = inv.currency || 'NGN';
    const feeInMajor = Number(inv.total_fee_amount || 0) / 100;

    if (inv.status === 'pending' || inv.status === 'overdue') {
      outstandingByCurrency[cur] = (outstandingByCurrency[cur] || 0) + feeInMajor;
    }
    if (inv.status === 'overdue') {
      overdueCount++;
    }
    if (inv.status === 'paid' && inv.paid_at && inv.paid_at >= monthStart) {
      collectedThisMonthByCurrency[cur] = (collectedThisMonthByCurrency[cur] || 0) + feeInMajor;
    }
    if (inv.status === 'waived') {
      waivedByCurrency[cur] = (waivedByCurrency[cur] || 0) + feeInMajor;
    }
  }

  const outstandingDisplay = Object.entries(outstandingByCurrency)
    .filter(([, a]) => a > 0)
    .map(([c, a]) => fmtCurrency(a, c))
    .join(' + ') || '0';
  const collectedDisplay = Object.entries(collectedThisMonthByCurrency)
    .filter(([, a]) => a > 0)
    .map(([c, a]) => fmtCurrency(a, c))
    .join(' + ') || '0';
  const waivedDisplay = Object.entries(waivedByCurrency)
    .filter(([, a]) => a > 0)
    .map(([c, a]) => fmtCurrency(a, c))
    .join(' + ') || '0';

  async function handleMarkAsPaid() {
    if (!selected || !canMutate) return;
    if (!window.confirm('Mark this fee invoice as paid?')) return;
    setPayLoading(true);
    setPayError('');
    setPaySuccess('');

    try {
      const { data: session } = await supabase.auth.getSession();
      const userId = session?.session?.user?.id;

      const { error } = await adminDb
        .from('platform_fee_invoices')
        .update({
          status: 'paid',
          paid_at: new Date().toISOString(),
          paid_via: 'manual',
          payment_reference: payRef.trim() || null,
        })
        .eq('id', selected.id);

      if (error) {
        setPayError(error.message);
        return;
      }

      await logAudit({
        action: 'mark_fee_invoice_paid',
        entity_type: 'platform_fee_invoice',
        entity_id: selected.id,
        details: {
          invoice_number: selected.invoice_number,
          business_id: selected.business_id,
          amount: selected.total_fee_amount,
          payment_reference: payRef.trim() || null,
          marked_by: userId,
        },
      });

      setPaySuccess('Invoice marked as paid');
      setPayRef('');
      await loadData();
      // Update selected with new data
      setSelected(prev => prev ? { ...prev, status: 'paid', paid_at: new Date().toISOString(), paid_via: 'manual', payment_reference: payRef.trim() || null } : null);
    } catch {
      setPayError('Failed to update invoice');
    } finally {
      setPayLoading(false);
    }
  }

  async function handleWaive() {
    if (!selected || !canMutate) return;
    if (!window.confirm('Waive this fee invoice? This cannot be undone.')) return;
    if (!waiveReason.trim()) {
      setWaiveError('A reason is required to waive an invoice');
      return;
    }

    setWaiveLoading(true);
    setWaiveError('');
    setWaiveSuccess('');

    try {
      const { data: session } = await supabase.auth.getSession();
      const userId = session?.session?.user?.id;

      const { error } = await adminDb
        .from('platform_fee_invoices')
        .update({
          status: 'waived',
          waived_reason: waiveReason.trim(),
          waived_by: userId,
        })
        .eq('id', selected.id);

      if (error) {
        setWaiveError(error.message);
        return;
      }

      await logAudit({
        action: 'waive_fee_invoice',
        entity_type: 'platform_fee_invoice',
        entity_id: selected.id,
        details: {
          invoice_number: selected.invoice_number,
          business_id: selected.business_id,
          amount: selected.total_fee_amount,
          reason: waiveReason.trim(),
          waived_by: userId,
        },
      });

      setWaiveSuccess('Invoice waived');
      setWaiveReason('');
      await loadData();
      setSelected(prev => prev ? { ...prev, status: 'waived', waived_reason: waiveReason.trim(), waived_by: userId || null } : null);
    } catch {
      setWaiveError('Failed to waive invoice');
    } finally {
      setWaiveLoading(false);
    }
  }

  function formatPeriod(start: string, end: string) {
    return `${fmtDate(start)} - ${fmtDate(end)}`;
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
          <h1 className="text-2xl font-bold text-gray-900">
            Fee Invoices <span className="ml-2 text-xs text-gray-400">Auto-refreshing</span>
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Platform fee invoices for direct bank transfer businesses
          </p>
        </div>
        <button
          onClick={() => downloadCSV(
            filtered.map(inv => ({
              invoice_number: inv.invoice_number,
              business: inv.business_name,
              period: `${inv.period_start} to ${inv.period_end}`,
              transfers: inv.transaction_count,
              transaction_amount: (inv.total_transaction_amount / 100).toFixed(2),
              fee_amount: (inv.total_fee_amount / 100).toFixed(2),
              currency: inv.currency || 'NGN',
              status: inv.status,
              due_date: inv.due_date,
              paid_at: inv.paid_at || '',
              paid_via: inv.paid_via || '',
              payment_reference: inv.payment_reference || '',
            })),
            `fee-invoices-${new Date().toISOString().slice(0, 10)}.csv`,
          )}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
        >
          Export CSV
        </button>
      </div>

      {/* Summary cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-4">
        <div className="rounded-xl border border-orange-100 bg-orange-50 p-4">
          <p className="text-xs font-medium text-gray-500">Total Outstanding</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{outstandingDisplay}</p>
        </div>
        <div className="rounded-xl border border-green-100 bg-green-50 p-4">
          <p className="text-xs font-medium text-gray-500">Collected This Month</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{collectedDisplay}</p>
        </div>
        <div className="rounded-xl border border-red-100 bg-red-50 p-4">
          <p className="text-xs font-medium text-gray-500">Overdue</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{overdueCount}</p>
        </div>
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
          <p className="text-xs font-medium text-gray-500">Waived</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{waivedDisplay}</p>
        </div>
      </div>

      {/* Status filter tabs */}
      <div className="mt-6 flex gap-1 rounded-lg bg-gray-100 p-1">
        {STATUS_TABS.map(tab => (
          <button
            key={tab}
            onClick={() => { setStatusFilter(tab); setPage(1); }}
            className={`rounded-md px-4 py-2 text-sm font-medium capitalize transition ${
              statusFilter === tab
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab === 'all' ? `All (${invoices.length})` : `${tab} (${invoices.filter(i => i.status === tab).length})`}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No fee invoices found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Invoice #</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Period</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Transfers</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Fee Amount</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Due Date</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Paid At</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(inv => (
                <tr
                  key={inv.id}
                  onClick={() => {
                    setSelected(inv);
                    setPayRef('');
                    setPayError('');
                    setPaySuccess('');
                    setWaiveReason('');
                    setWaiveError('');
                    setWaiveSuccess('');
                  }}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">{inv.invoice_number}</td>
                  <td className="px-4 py-3 font-medium text-gray-900">{inv.business_name}</td>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{formatPeriod(inv.period_start, inv.period_end)}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{inv.transaction_count}</td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">
                    {fmtCurrency(inv.total_fee_amount / 100, inv.currency || undefined)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={inv.status} colorMap={STATUS_COLOR_MAP} />
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtDate(inv.due_date)}</td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{inv.paid_at ? fmtDate(inv.paid_at) : '—'}</td>
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
        onClose={() => {
          setSelected(null);
          setPayRef('');
          setPayError('');
          setPaySuccess('');
          setWaiveReason('');
          setWaiveError('');
          setWaiveSuccess('');
        }}
        title="Fee Invoice Details"
        wide
      >
        {selected && (
          <div className="space-y-3 text-sm">
            <DetailRow label="Invoice Number" value={selected.invoice_number} />
            <DetailRow label="Business" value={selected.business_name || 'Unknown'} />
            <DetailRow label="Period" value={formatPeriod(selected.period_start, selected.period_end)} />
            <DetailRow label="Status" value={<StatusBadge status={selected.status} colorMap={STATUS_COLOR_MAP} />} />

            <div className="my-3 border-t border-gray-100" />

            <DetailRow label="Transaction Count" value={selected.transaction_count} />
            <DetailRow label="Total Transaction Amount" value={fmtCurrency(selected.total_transaction_amount / 100, selected.currency || undefined)} />
            <DetailRow label="Total Fee Amount" value={fmtCurrency(selected.total_fee_amount / 100, selected.currency || undefined)} />
            <DetailRow label="Currency" value={selected.currency?.toUpperCase()} />

            <div className="my-3 border-t border-gray-100" />

            <DetailRow label="Due Date" value={fmtDate(selected.due_date)} />
            <DetailRow label="Paid At" value={selected.paid_at ? fmtDateTime(selected.paid_at) : null} />
            <DetailRow label="Paid Via" value={selected.paid_via} />
            <DetailRow label="Payment Reference" value={selected.payment_reference} />

            {selected.waived_reason && (
              <>
                <div className="my-3 border-t border-gray-100" />
                <DetailRow label="Waived Reason" value={selected.waived_reason} />
                <DetailRow label="Waived By" value={selected.waived_by ? selected.waived_by.slice(0, 8) + '...' : null} />
              </>
            )}

            <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />

            {/* Line Items */}
            {selected.line_items && selected.line_items.length > 0 && (
              <>
                <div className="my-3 border-t border-gray-100" />
                <div className="rounded-lg bg-gray-50 p-3">
                  <p className="text-xs font-semibold uppercase text-gray-500 mb-2">
                    Line Items ({selected.line_items.length})
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-gray-200">
                          <th className="pb-1 text-left font-medium text-gray-500">Description</th>
                          <th className="pb-1 text-right font-medium text-gray-500">Amount</th>
                          <th className="pb-1 text-right font-medium text-gray-500">Fee</th>
                          <th className="pb-1 text-left font-medium text-gray-500">Date</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {selected.line_items.map((item, idx) => (
                          <tr key={idx}>
                            <td className="py-1 text-gray-700">
                              {item.description || item.payment_id?.slice(0, 8) || `Item ${idx + 1}`}
                            </td>
                            <td className="py-1 text-right text-gray-700">
                              {fmtCurrency(item.amount / 100, selected.currency || undefined)}
                            </td>
                            <td className="py-1 text-right text-gray-700">
                              {fmtCurrency(item.fee / 100, selected.currency || undefined)}
                            </td>
                            <td className="py-1 text-gray-500">
                              {item.date ? fmtDate(item.date) : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}

            {/* Admin Actions — only for pending/overdue invoices */}
            {canMutate && (selected.status === 'pending' || selected.status === 'overdue') && (
              <>
                <div className="my-3 border-t border-gray-100" />

                {/* Mark as Paid */}
                <div className="rounded-lg border border-green-100 bg-green-50 p-4">
                  <p className="text-sm font-semibold text-green-800">Mark as Paid</p>
                  <p className="mt-1 text-xs text-green-600">
                    Record a manual payment of {fmtCurrency(selected.total_fee_amount / 100, selected.currency || undefined)}
                  </p>
                  <div className="mt-3 space-y-2">
                    <input
                      type="text"
                      value={payRef}
                      onChange={e => setPayRef(e.target.value)}
                      placeholder="Payment reference (optional)"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                    {payError && <p className="text-xs text-red-600">{payError}</p>}
                    {paySuccess && <p className="text-xs text-green-600">{paySuccess}</p>}
                    <button
                      onClick={handleMarkAsPaid}
                      disabled={payLoading}
                      className="w-full rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
                    >
                      {payLoading ? 'Processing...' : 'Confirm Paid'}
                    </button>
                  </div>
                </div>

                {/* Waive */}
                <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50 p-4">
                  <p className="text-sm font-semibold text-blue-800">Waive Invoice</p>
                  <p className="mt-1 text-xs text-blue-600">
                    Waive this fee invoice with a reason
                  </p>
                  <div className="mt-3 space-y-2">
                    <textarea
                      value={waiveReason}
                      onChange={e => setWaiveReason(e.target.value)}
                      rows={2}
                      placeholder="Reason for waiving (required)"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                    {waiveError && <p className="text-xs text-red-600">{waiveError}</p>}
                    {waiveSuccess && <p className="text-xs text-blue-600">{waiveSuccess}</p>}
                    <button
                      onClick={handleWaive}
                      disabled={waiveLoading}
                      className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {waiveLoading ? 'Processing...' : 'Waive Invoice'}
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
