'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { formatCurrency, type CountryCode } from '@/lib/constants';

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

interface MonthBucket {
  key: string;   // e.g. "2026-03"
  label: string;  // e.g. "Mar"
  count: number;
  gross: number;
  fees: number;
  net: number;
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
  const country = (business.country_code || 'NG') as CountryCode;

  // All payouts for aggregation
  const [allPayouts, setAllPayouts] = useState<PayoutRecord[]>([]);
  const [allLoading, setAllLoading] = useState(true);

  // Paginated payouts for table
  const [payouts, setPayouts] = useState<PayoutRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [statusFilter, setStatusFilter] = useState('all');
  const [selected, setSelected] = useState<PayoutRecord | null>(null);

  // Fetch ALL payouts for aggregation (once on mount)
  useEffect(() => {
    async function loadAll() {
      setAllLoading(true);
      try {
        const params = new URLSearchParams({
          business_id: business.id,
          all: 'true',
        });
        const res = await fetch(`/api/payouts/history?${params}`);
        if (res.ok) {
          const data = await res.json();
          setAllPayouts(data.payouts || []);
        }
      } catch { /* ignore */ }
      setAllLoading(false);
    }
    loadAll();
  }, [business.id]);

  // Fetch paginated payouts for the table
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

  // Computed metrics from all payouts
  const paidPayouts = useMemo(
    () => allPayouts.filter(p => p.status === 'paid'),
    [allPayouts],
  );

  const totalPaid = useMemo(
    () => paidPayouts.reduce((s, p) => s + p.net_amount, 0),
    [paidPayouts],
  );

  const now = new Date();
  const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthKey = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;

  const thisMonthTotal = useMemo(
    () => paidPayouts
      .filter(p => p.paid_at && p.paid_at.startsWith(thisMonthKey))
      .reduce((s, p) => s + p.net_amount, 0),
    [paidPayouts, thisMonthKey],
  );

  const lastMonthTotal = useMemo(
    () => paidPayouts
      .filter(p => p.paid_at && p.paid_at.startsWith(lastMonthKey))
      .reduce((s, p) => s + p.net_amount, 0),
    [paidPayouts, lastMonthKey],
  );

  // Monthly buckets (last 12 months)
  const monthlyBuckets = useMemo(() => {
    const buckets: MonthBucket[] = [];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      buckets.push({ key, label: monthNames[d.getMonth()], count: 0, gross: 0, fees: 0, net: 0 });
    }
    for (const p of paidPayouts) {
      const dateStr = p.paid_at || p.created_at;
      const pKey = dateStr.slice(0, 7); // "YYYY-MM"
      const bucket = buckets.find(b => b.key === pKey);
      if (bucket) {
        bucket.count++;
        bucket.gross += p.gross_amount;
        bucket.fees += p.platform_fee + p.gateway_fee;
        bucket.net += p.net_amount;
      }
    }
    return buckets;
  }, [paidPayouts, now.getFullYear(), now.getMonth()]);

  const maxMonthly = useMemo(
    () => Math.max(...monthlyBuckets.map(m => m.net), 1),
    [monthlyBuckets],
  );

  // Monthly summary rows (newest first, only months with actual data)
  const monthlySummaryRows = useMemo(
    () => [...monthlyBuckets].reverse().filter(m => m.count > 0 || m.gross > 0),
    [monthlyBuckets],
  );

  const summaryTotals = useMemo(() => {
    return monthlySummaryRows.reduce(
      (acc, m) => ({
        count: acc.count + m.count,
        gross: acc.gross + m.gross,
        fees: acc.fees + m.fees,
        net: acc.net + m.net,
      }),
      { count: 0, gross: 0, fees: 0, net: 0 },
    );
  }, [monthlySummaryRows]);

  return (
    <div>
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Payouts</h1>
        <p className="mt-1 text-sm text-gray-500">Full breakdown of your payout records</p>
      </div>

      {/* Tabs */}
      <div className="mt-4 flex gap-1 border-b border-gray-200">
        <Link
          href="/dashboard/payouts"
          className="border-b-2 border-transparent px-4 py-2 text-sm font-medium text-gray-500 transition hover:text-gray-700 hover:border-gray-300"
        >
          Account
        </Link>
        <span className="border-b-2 border-brand px-4 py-2 text-sm font-medium text-brand">
          History
        </span>
      </div>

      {/* Summary Metric Cards */}
      {allLoading ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="animate-pulse rounded-xl border border-gray-100 bg-gray-50 p-4">
              <div className="h-3 w-20 rounded bg-gray-200" />
              <div className="mt-2 h-6 w-28 rounded bg-gray-200" />
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Total Paid" value={formatCurrency(totalPaid, country)} color="green" />
          <MetricCard label="This Month" value={formatCurrency(thisMonthTotal, country)} color="blue" />
          <MetricCard label="Last Month" value={formatCurrency(lastMonthTotal, country)} color="gray" />
          <MetricCard label="Total Payouts" value={String(paidPayouts.length)} color="gray" />
        </div>
      )}

      {/* Monthly Payouts Chart */}
      {!allLoading && (
        <div className="mt-8 rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-gray-900">Monthly Payouts</h3>
          <div className="mt-4 flex items-end gap-3" style={{ height: 160 }}>
            {monthlyBuckets.map((m, i) => (
              <div key={i} className="flex flex-1 flex-col items-center gap-1">
                <span className="text-[10px] text-gray-500">
                  {m.net > 0 ? formatCompact(m.net) : ''}
                </span>
                <div
                  className="w-full rounded-t-md bg-brand transition-all"
                  style={{ height: `${Math.max(4, (m.net / maxMonthly) * 140)}px` }}
                />
                <span className="text-xs text-gray-500">{m.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Monthly Summary Table */}
      {!allLoading && (
        <div className="mt-6 overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <div className="px-4 py-3 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900">Monthly Summary</h3>
          </div>
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Month</th>
                <th scope="col" className="px-4 py-3 text-right font-medium text-gray-500">Payouts</th>
                <th scope="col" className="px-4 py-3 text-right font-medium text-gray-500">Gross</th>
                <th scope="col" className="px-4 py-3 text-right font-medium text-gray-500">Fees</th>
                <th scope="col" className="px-4 py-3 text-right font-medium text-gray-500">Net Paid</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {monthlySummaryRows.map(m => (
                <tr key={m.key} className={m.count === 0 ? 'text-gray-300' : ''}>
                  <td className="px-4 py-3 text-gray-900">{formatMonthLabel(m.key)}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{m.count}</td>
                  <td className="px-4 py-3 text-right text-gray-900">{formatCurrency(m.gross, country)}</td>
                  <td className="px-4 py-3 text-right text-gray-500">{formatCurrency(m.fees, country)}</td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">{formatCurrency(m.net, country)}</td>
                </tr>
              ))}
              {/* Totals row */}
              <tr className="border-t-2 border-gray-200 bg-gray-50 font-semibold">
                <td className="px-4 py-3 text-gray-900">Total</td>
                <td className="px-4 py-3 text-right text-gray-900">{summaryTotals.count}</td>
                <td className="px-4 py-3 text-right text-gray-900">{formatCurrency(summaryTotals.gross, country)}</td>
                <td className="px-4 py-3 text-right text-gray-500">{formatCurrency(summaryTotals.fees, country)}</td>
                <td className="px-4 py-3 text-right text-gray-900">{formatCurrency(summaryTotals.net, country)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* Filter */}
      <div className="mt-8 flex items-center gap-3">
        <h3 className="text-sm font-semibold text-gray-900">All Records</h3>
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

      {/* Records Table */}
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
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Date</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Period</th>
                <th scope="col" className="px-4 py-3 text-right font-medium text-gray-500">Gross</th>
                <th scope="col" className="px-4 py-3 text-right font-medium text-gray-500">Fees</th>
                <th scope="col" className="px-4 py-3 text-right font-medium text-gray-500">Net</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Reference</th>
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
                  <td className="px-4 py-3 text-right text-gray-900">{formatCurrency(p.gross_amount, country)}</td>
                  <td className="px-4 py-3 text-right text-gray-500">{formatCurrency(p.platform_fee + p.gateway_fee, country)}</td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">{formatCurrency(p.net_amount, country)}</td>
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
                <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="mt-4 space-y-3 text-sm">
              <DetailRow label="Period" value={`${formatDate(selected.period_start)} - ${formatDate(selected.period_end)}`} />
              <DetailRow label="Gross Amount" value={formatCurrency(selected.gross_amount, country)} />
              <DetailRow label="Platform Fee" value={formatCurrency(selected.platform_fee, country)} />
              <DetailRow label="Gateway Fee" value={formatCurrency(selected.gateway_fee, country)} />
              <DetailRow label="Net Amount" value={formatCurrency(selected.net_amount, country)} bold />
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

/* ── Helpers ─────────────────────────────────────────── */

function MetricCard({ label, value, color }: { label: string; value: string; color: string }) {
  const colors: Record<string, string> = {
    blue: 'bg-blue-50 border-blue-100',
    green: 'bg-green-50 border-green-100',
    gray: 'bg-gray-50 border-gray-100',
  };
  return (
    <div className={`rounded-xl border p-4 ${colors[color] || 'bg-gray-50 border-gray-100'}`}>
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className="mt-1 text-xl font-bold text-gray-900">{value}</p>
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

function formatMonthLabel(key: string) {
  const [year, month] = key.split('-');
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${monthNames[parseInt(month) - 1]} ${year}`;
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}
