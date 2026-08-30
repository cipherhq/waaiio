'use client';

import { useEffect, useMemo, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, type CountryCode, getLocale } from '@/lib/constants';
import { useCategoryConfig } from '@/hooks/useCategoryConfig';
import { CsvExportButton } from '@/components/dashboard/CsvExportButton';
import { PageHelp } from '@/components/dashboard/PageHelp';

interface TransactionRow {
  txn_id: string;
  txn_type: string;
  flow_type: string;
  reference_code: string;
  purpose: string;
  customer_name: string | null;
  amount: number;
  status: string;
  event_date: string;
}

interface Transaction {
  id: string;
  date: string;
  type: string;
  description: string;
  customer: string;
  amount: number;
  status: string;
  reference: string;
}

const flowTypeStyles: Record<string, string> = {
  payment: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  giving: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  booking: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  order: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  ordering: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  invoice: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300',
  donation: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  crowdfund: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  ticket: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  event: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
};

export default function FinancialsPage() {
  const business = useBusiness();
  const { labels } = useCategoryConfig(business.category);
  const country = (business.country_code || 'NG') as CountryCode;
  const isGiving = labels.quantityLabel === 'amount';

  const [loading, setLoading] = useState(true);
  const [txnRows, setTxnRows] = useState<TransactionRow[]>([]);
  const [platformFees, setPlatformFees] = useState(0);
  const [pendingPayouts, setPendingPayouts] = useState(0);
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const perPage = 20;

  const [totalRefunds, setTotalRefunds] = useState(0);
  const [platformPct, setPlatformPct] = useState<number | null>(null);
  const isDirectSplit = business.payout_mode === 'direct_split';

  // Server-side revenue totals (same inclusion semantics as rows, no row-cap)
  const [bookingRevenue, setBookingRevenue] = useState(0);
  const [orderRevenue, setOrderRevenue] = useState(0);
  const [invoiceRevenue, setInvoiceRevenue] = useState(0);
  const [totalRevenue, setTotalRevenue] = useState(0);

  useEffect(() => {
    async function load() {
      const supabase = createClient();

      const [txnRes, totalsRes, feesRes, payoutsRes, payoutAccountRes, refundsRes] = await Promise.all([
        // Unified transaction projection via RPC (#226)
        supabase.rpc('get_business_transactions', {
          p_business_id: business.id,
          p_limit: 500,
          p_offset: 0,
        }),
        // Authoritative server-side totals (#226)
        supabase.rpc('get_business_revenue_totals', {
          p_business_id: business.id,
        }),
        supabase
          .from('platform_fees')
          .select('fee_total')
          .eq('business_id', business.id)
          .eq('waived', false)
          .is('refunded_at', null),
        supabase
          .from('business_payouts')
          .select('net_amount')
          .eq('business_id', business.id)
          .in('status', ['pending', 'approved']),
        isDirectSplit
          ? supabase
              .from('payout_accounts')
              .select('platform_percentage')
              .eq('business_id', business.id)
              .eq('is_active', true)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        supabase
          .from('refunds')
          .select('amount, status')
          .eq('business_id', business.id)
          .eq('status', 'success'),
      ]);

      setTxnRows((txnRes.data as TransactionRow[]) || []);

      // Set server-side totals
      const totals = (totalsRes.data as Array<{ booking_revenue: number; order_revenue: number; invoice_revenue: number; total_revenue: number }>) || [];
      if (totals.length > 0) {
        setBookingRevenue(Number(totals[0].booking_revenue || 0));
        setOrderRevenue(Number(totals[0].order_revenue || 0));
        setInvoiceRevenue(Number(totals[0].invoice_revenue || 0));
        setTotalRevenue(Number(totals[0].total_revenue || 0));
      }

      if (isDirectSplit) {
        setPlatformPct(payoutAccountRes.data?.platform_percentage ?? 2.5);
      } else {
        setPlatformFees((feesRes.data || []).reduce((s, f) => s + Number(f.fee_total || 0), 0));
      }
      setPendingPayouts((payoutsRes.data || []).reduce((s, p) => s + Number(p.net_amount || 0), 0));
      setTotalRefunds((refundsRes.data || []).reduce((s, r) => s + Number(r.amount || 0), 0));
      setLoading(false);
    }
    load();
  }, [business.id, isDirectSplit]);

  const effectiveFees = isDirectSplit && platformPct !== null
    ? Math.round(totalRevenue * (platformPct / 100))
    : platformFees;
  const netEarnings = totalRevenue - effectiveFees - totalRefunds;

  // Map RPC rows to Transaction interface
  const transactions = useMemo(() => {
    return txnRows.map((row): Transaction => ({
      id: row.txn_id,
      date: row.event_date,
      type: row.flow_type || row.txn_type,
      description: row.purpose,
      customer: row.customer_name || '\u2014',
      amount: Number(row.amount || 0),
      status: row.status,
      reference: row.reference_code,
    }));
  }, [txnRows]);

  // Filtered transactions
  const filtered = useMemo(() => {
    let result = transactions;
    if (typeFilter !== 'all') result = result.filter(t => t.type === typeFilter);
    if (statusFilter !== 'all') result = result.filter(t => t.status === statusFilter);
    if (dateFrom) result = result.filter(t => t.date >= dateFrom);
    if (dateTo) result = result.filter(t => t.date <= dateTo + 'T23:59:59');
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(t =>
        t.reference?.toLowerCase().includes(q) ||
        t.customer.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q)
      );
    }
    return result;
  }, [transactions, typeFilter, statusFilter, dateFrom, dateTo, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  // Unique flow types for dynamic filter options
  const availableTypes = useMemo(() => {
    const types = new Set(txnRows.map(r => r.flow_type || r.txn_type));
    return Array.from(types);
  }, [txnRows]);

  // Monthly revenue for chart (last 6 months) — from transaction rows
  const monthlyRevenue = useMemo(() => {
    const months: { label: string; amount: number }[] = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = d.toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), { month: 'short' });

      const amt = txnRows
        .filter(r => {
          if (!r.event_date?.startsWith(key)) return false;
          if (r.status === 'cancelled' || r.status === 'no_show' || r.status === 'failed') return false;
          if (r.txn_type === 'order' && !['confirmed', 'processing', 'ready', 'shipped', 'delivered'].includes(r.status)) return false;
          if (r.txn_type === 'invoice' && r.status !== 'paid') return false;
          return true;
        })
        .reduce((s, r) => s + Number(r.amount || 0), 0);

      months.push({ label, amount: amt });
    }
    return months;
  }, [txnRows]);

  const maxMonthly = Math.max(...monthlyRevenue.map(m => m.amount), 1);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Financials</h1>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Transaction tracking and revenue analytics</p>

      <PageHelp
        pageKey="financials"
        title="Financial Overview"
        description="See how much money your business has made through Waaiio. Track revenue by service type, view platform fees, and monitor your payout history."
      />

      {/* Metric Cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard label={isGiving ? 'Total Received' : 'Total Revenue'} value={formatCurrency(totalRevenue, country)} color="blue" />
        <MetricCard label="Platform Fees" value={formatCurrency(effectiveFees, country)} color="orange" />
        <MetricCard label="Total Refunds" value={formatCurrency(totalRefunds, country)} color="red" />
        <MetricCard label={isGiving ? 'Net Received' : 'Net Earnings'} value={formatCurrency(netEarnings, country)} color="green" />
        <MetricCard label="Pending Payouts" value={formatCurrency(pendingPayouts, country)} color="yellow" />
      </div>

      {/* Monthly Revenue Chart */}
      <div className="mt-8 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Monthly {isGiving ? 'Giving' : 'Revenue'}</h3>
        <div className="mt-4 flex items-end gap-3" style={{ height: 160 }}>
          {monthlyRevenue.map((m, i) => (
            <div key={i} className="flex flex-1 flex-col items-center gap-1">
              <span className="text-[10px] text-gray-500 dark:text-gray-400">{m.amount > 0 ? formatCompact(m.amount) : ''}</span>
              <div
                className="w-full rounded-t-md bg-brand transition-all"
                style={{ height: `${Math.max(4, (m.amount / maxMonthly) * 140)}px` }}
              />
              <span className="text-xs text-gray-500 dark:text-gray-400">{m.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Filters */}
      <div className="mt-8 flex flex-wrap items-center gap-3">
        {availableTypes.length > 1 && (
          <select
            value={typeFilter}
            onChange={e => { setTypeFilter(e.target.value); setPage(1); }}
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 dark:bg-gray-700 focus:border-brand focus:outline-none"
          >
            <option value="all">All Types</option>
            {availableTypes.map(t => (
              <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
            ))}
          </select>
        )}
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 dark:bg-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Statuses</option>
          <option value="completed">Completed</option>
          <option value="confirmed">Confirmed</option>
          <option value="pending">Pending</option>
          <option value="delivered">Delivered</option>
          <option value="paid">Paid</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <input
          type="text"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          placeholder={`Search reference or ${labels.personLabel.toLowerCase()}...`}
          className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-700 dark:text-gray-100 dark:bg-gray-700 focus:border-brand focus:outline-none sm:w-64"
        />
        <div className="flex flex-wrap items-center gap-2">
          <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); }} className="w-full sm:w-auto rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 px-3 py-2 text-sm outline-none focus:border-brand" />
          <span className="text-xs text-gray-400 dark:text-gray-500">to</span>
          <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1); }} className="w-full sm:w-auto rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 px-3 py-2 text-sm outline-none focus:border-brand" />
        </div>
        <CsvExportButton
          data={filtered.map(t => ({
            Date: new Date(t.date).toLocaleDateString(),
            Type: t.type,
            Description: t.description,
            Customer: t.customer,
            Amount: t.amount,
            Status: t.status,
            Reference: t.reference,
          }))}
          filename={`financials-${new Date().toISOString().slice(0, 10)}`}
        />
      </div>

      {/* Transaction Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500 dark:text-gray-400">No transactions found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
              <tr>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Date</th>
                {availableTypes.length > 1 && (
                  <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Type</th>
                )}
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Description</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">{labels.personLabel}</th>
                <th scope="col" className="px-4 py-3 text-right font-medium text-gray-500 dark:text-gray-400">Amount</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Status</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Ref</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-700">
              {pageItems.map(t => (
                <tr key={t.id} className="transition hover:bg-gray-50 dark:hover:bg-gray-700/50">
                  <td className="px-4 py-3 text-gray-900 dark:text-gray-100 whitespace-nowrap">{formatDate(t.date)}</td>
                  {availableTypes.length > 1 && (
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${flowTypeStyles[t.type] || 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'}`}>
                        {t.type}
                      </span>
                    </td>
                  )}
                  <td className="px-4 py-3 text-gray-700 dark:text-gray-300 max-w-[200px] truncate">{t.description}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{t.customer}</td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900 dark:text-gray-100">{formatCurrency(t.amount, country)}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                      t.status === 'completed' || t.status === 'confirmed' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' :
                      t.status === 'in_progress' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' :
                      t.status === 'pending' ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300' :
                      'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                    }`}>
                      {t.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 font-mono text-xs">{t.reference}</td>
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
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-gray-600 dark:text-gray-400 transition hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50"
          >
            Previous
          </button>
          <span className="text-gray-500 dark:text-gray-400">Page {page} of {totalPages}</span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-gray-600 dark:text-gray-400 transition hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, color }: { label: string; value: string; color: string }) {
  const colors: Record<string, string> = {
    blue: 'bg-blue-50 border-blue-100 dark:bg-blue-900/20 dark:border-blue-800',
    green: 'bg-green-50 border-green-100 dark:bg-green-900/20 dark:border-green-800',
    orange: 'bg-orange-50 border-orange-100 dark:bg-orange-900/20 dark:border-orange-800',
    yellow: 'bg-yellow-50 border-yellow-100 dark:bg-yellow-900/20 dark:border-yellow-800',
    red: 'bg-red-50 border-red-100 dark:bg-red-900/20 dark:border-red-800',
  };
  return (
    <div className={`rounded-xl border p-4 ${colors[color] || 'bg-gray-50 border-gray-100 dark:bg-gray-800/50 dark:border-gray-700'}`}>
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</p>
      <p className="mt-1 text-xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
    </div>
  );
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}
