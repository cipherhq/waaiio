'use client';

import { useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';

interface PayoutRecord {
  id: string;
  period_start: string;
  period_end: string;
  gross_amount: number;
  platform_fee: number;
  gateway_fee: number;
  net_amount: number;
  status: string;
  transfer_method: string | null;
  transfer_reference: string | null;
  notes: string | null;
  paid_at: string | null;
  created_at: string;
}

const statusStyles: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  approved: 'bg-blue-100 text-blue-700',
  processing: 'bg-blue-100 text-blue-700',
  paid: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  rejected: 'bg-red-100 text-red-700',
};

export default function PayoutHistoryPage() {
  const business = useBusiness();
  const [payouts, setPayouts] = useState<PayoutRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [statusFilter, setStatusFilter] = useState('all');
  const [selected, setSelected] = useState<PayoutRecord | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          business_id: business.id,
          page: String(page),
          status: statusFilter,
        });
        const res = await fetch(`/api/payouts/history?${params}`);
        if (res.ok) {
          const data = await res.json();
          setPayouts(data.payouts || []);
          setTotalPages(data.total_pages || 1);
        }
      } catch { /* ignore */ }
      setLoading(false);
    }
    load();
  }, [business.id, page, statusFilter]);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Payout History</h1>
          <p className="mt-1 text-sm text-gray-500">Track your weekly payout records</p>
        </div>
      </div>

      {/* Filter */}
      <div className="mt-6 flex items-center gap-3">
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="processing">Processing</option>
          <option value="paid">Paid</option>
          <option value="failed">Failed</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
          </div>
        ) : payouts.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No payout records found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Date</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Period</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Gross</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Fees</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Net</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Reference</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {payouts.map(p => (
                <tr
                  key={p.id}
                  onClick={() => setSelected(p)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 text-gray-900">{formatDate(p.created_at)}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {formatDate(p.period_start)} - {formatDate(p.period_end)}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-900">{formatMoney(p.gross_amount)}</td>
                  <td className="px-4 py-3 text-right text-gray-500">{formatMoney(p.platform_fee + p.gateway_fee)}</td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">{formatMoney(p.net_amount)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[p.status] || 'bg-gray-100 text-gray-600'}`}>
                      {p.status === 'processing' && (
                        <div className="h-2.5 w-2.5 animate-spin rounded-full border border-blue-500 border-t-transparent" />
                      )}
                      {p.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 font-mono text-xs">{p.transfer_reference || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-gray-600 transition hover:bg-gray-50 disabled:opacity-50"
          >
            Previous
          </button>
          <span className="text-gray-500">Page {page} of {totalPages}</span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-gray-600 transition hover:bg-gray-50 disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}

      {/* Detail Modal */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">Payout Details</h3>
              <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-600">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="mt-4 space-y-3 text-sm">
              <DetailRow label="Period" value={`${formatDate(selected.period_start)} - ${formatDate(selected.period_end)}`} />
              <DetailRow label="Gross Amount" value={formatMoney(selected.gross_amount)} />
              <DetailRow label="Platform Fee" value={formatMoney(selected.platform_fee)} />
              <DetailRow label="Gateway Fee" value={formatMoney(selected.gateway_fee)} />
              <DetailRow label="Net Amount" value={formatMoney(selected.net_amount)} bold />
              <DetailRow label="Status" value={selected.status} />
              {selected.transfer_method && <DetailRow label="Method" value={selected.transfer_method} />}
              {selected.transfer_reference && <DetailRow label="Reference" value={selected.transfer_reference} />}
              {selected.paid_at && <DetailRow label="Paid At" value={new Date(selected.paid_at).toLocaleString()} />}
              {selected.notes && <DetailRow label="Notes" value={selected.notes} />}
            </div>

            <button
              onClick={() => setSelected(null)}
              className="mt-6 w-full rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-500">{label}</span>
      <span className={`text-gray-900 ${bold ? 'font-semibold' : ''}`}>{value}</span>
    </div>
  );
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatMoney(amount: number): string {
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 0 }).format(amount);
}
