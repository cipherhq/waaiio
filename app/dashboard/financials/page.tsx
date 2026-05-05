'use client';

import { useEffect, useMemo, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { useCategoryConfig } from '@/hooks/useCategoryConfig';
import { CsvExportButton } from '@/components/dashboard/CsvExportButton';

interface BookingRow {
  id: string;
  flow_type: string;
  reference_code: string;
  guest_name: string | null;
  total_amount: number;
  deposit_amount: number;
  status: string;
  created_at: string;
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
  payment: 'bg-purple-100 text-purple-700',
  booking: 'bg-blue-100 text-blue-700',
  order: 'bg-green-100 text-green-700',
  donation: 'bg-purple-100 text-purple-700',
  crowdfund: 'bg-orange-100 text-orange-700',
  ticket: 'bg-orange-100 text-orange-700',
  event: 'bg-orange-100 text-orange-700',
};

export default function FinancialsPage() {
  const business = useBusiness();
  const { labels } = useCategoryConfig(business.category);
  const country = (business.country_code || 'NG') as CountryCode;
  const isGiving = labels.quantityLabel === 'amount';

  const [loading, setLoading] = useState(true);
  const [bookings, setBookings] = useState<BookingRow[]>([]);
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

  useEffect(() => {
    async function load() {
      const supabase = createClient();

      const [bookingsRes, feesRes, payoutsRes, payoutAccountRes, refundsRes] = await Promise.all([
        supabase
          .from('bookings')
          .select('id, flow_type, reference_code, guest_name, total_amount, deposit_amount, status, created_at')
          .eq('business_id', business.id)
          .order('created_at', { ascending: false })
          .limit(500),
        supabase
          .from('platform_fees')
          .select('fee_total')
          .eq('business_id', business.id)
          .eq('waived', false),
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

      setBookings(bookingsRes.data || []);
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

  // Revenue from all non-cancelled bookings
  const totalRevenue = useMemo(() =>
    bookings
      .filter(b => b.status !== 'cancelled' && b.status !== 'no_show')
      .reduce((s, b) => s + Number(b.total_amount || b.deposit_amount || 0), 0),
  [bookings]);

  const effectiveFees = isDirectSplit && platformPct !== null
    ? Math.round(totalRevenue * (platformPct / 100))
    : platformFees;
  const netEarnings = totalRevenue - effectiveFees - totalRefunds;

  // Build unified transactions from bookings
  const flowTypeLabel = (ft: string): string => {
    switch (ft) {
      case 'payment': return 'Payment';
      case 'scheduling': return 'Booking';
      case 'ordering': return 'Order';
      case 'ticketing': return 'Ticket';
      case 'reservation': return 'Reservation';
      default: return 'Booking';
    }
  };

  const transactions = useMemo(() => {
    return bookings.map((b): Transaction => {
      const ft = b.flow_type || 'booking';
      return {
        id: b.id,
        date: b.created_at,
        type: ft,
        description: `${flowTypeLabel(ft)} - ${b.reference_code}`,
        customer: b.guest_name || '\u2014',
        amount: Number(b.total_amount || b.deposit_amount || 0),
        status: b.status,
        reference: b.reference_code,
      };
    });
  }, [bookings, entityLabel]);

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
    const types = new Set(bookings.map(b => b.flow_type || 'booking'));
    return Array.from(types);
  }, [bookings]);

  // Monthly revenue for chart (last 6 months)
  const monthlyRevenue = useMemo(() => {
    const months: { label: string; amount: number }[] = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = d.toLocaleDateString('en-US', { month: 'short' });
      const amount = bookings
        .filter(b => b.status !== 'cancelled' && b.status !== 'no_show' && b.created_at.startsWith(key))
        .reduce((s, b) => s + Number(b.total_amount || b.deposit_amount || 0), 0);
      months.push({ label, amount });
    }
    return months;
  }, [bookings]);

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
      <h1 className="text-2xl font-bold text-gray-900">Financials</h1>
      <p className="mt-1 text-sm text-gray-500">Transaction tracking and revenue analytics</p>

      {/* Metric Cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard label={isGiving ? 'Total Received' : 'Total Revenue'} value={formatCurrency(totalRevenue, country)} color="blue" />
        <MetricCard label="Platform Fees" value={formatCurrency(effectiveFees, country)} color="orange" />
        <MetricCard label="Total Refunds" value={formatCurrency(totalRefunds, country)} color="red" />
        <MetricCard label={isGiving ? 'Net Received' : 'Net Earnings'} value={formatCurrency(netEarnings, country)} color="green" />
        <MetricCard label="Pending Payouts" value={formatCurrency(pendingPayouts, country)} color="yellow" />
      </div>

      {/* Monthly Revenue Chart */}
      <div className="mt-8 rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-gray-900">Monthly {isGiving ? 'Giving' : 'Revenue'}</h3>
        <div className="mt-4 flex items-end gap-3" style={{ height: 160 }}>
          {monthlyRevenue.map((m, i) => (
            <div key={i} className="flex flex-1 flex-col items-center gap-1">
              <span className="text-[10px] text-gray-500">{m.amount > 0 ? formatCompact(m.amount) : ''}</span>
              <div
                className="w-full rounded-t-md bg-brand transition-all"
                style={{ height: `${Math.max(4, (m.amount / maxMonthly) * 140)}px` }}
              />
              <span className="text-xs text-gray-500">{m.label}</span>
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
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
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
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Statuses</option>
          <option value="completed">Completed</option>
          <option value="confirmed">Confirmed</option>
          <option value="pending">Pending</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <input
          type="text"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          placeholder={`Search reference or ${labels.personLabel.toLowerCase()}...`}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none sm:w-64"
        />
        <div className="flex items-center gap-2">
          <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); }} className="rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand" />
          <span className="text-xs text-gray-400">to</span>
          <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1); }} className="rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand" />
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
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No transactions found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Date</th>
                {availableTypes.length > 1 && (
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Type</th>
                )}
                <th className="px-4 py-3 text-left font-medium text-gray-500">Description</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">{labels.personLabel}</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Amount</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Ref</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(t => (
                <tr key={t.id} className="transition hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-900 whitespace-nowrap">{formatDate(t.date)}</td>
                  {availableTypes.length > 1 && (
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${flowTypeStyles[t.type] || 'bg-gray-100 text-gray-600'}`}>
                        {t.type}
                      </span>
                    </td>
                  )}
                  <td className="px-4 py-3 text-gray-700 max-w-[200px] truncate">{t.description}</td>
                  <td className="px-4 py-3 text-gray-600">{t.customer}</td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">{formatCurrency(t.amount, country)}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                      t.status === 'completed' || t.status === 'confirmed' ? 'bg-green-100 text-green-700' :
                      t.status === 'in_progress' ? 'bg-blue-100 text-blue-700' :
                      t.status === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                      'bg-red-100 text-red-700'
                    }`}>
                      {t.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 font-mono text-xs">{t.reference}</td>
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
    </div>
  );
}

function MetricCard({ label, value, color }: { label: string; value: string; color: string }) {
  const colors: Record<string, string> = {
    blue: 'bg-blue-50 border-blue-100',
    green: 'bg-green-50 border-green-100',
    orange: 'bg-orange-50 border-orange-100',
    yellow: 'bg-yellow-50 border-yellow-100',
    red: 'bg-red-50 border-red-100',
  };
  return (
    <div className={`rounded-xl border p-4 ${colors[color] || 'bg-gray-50 border-gray-100'}`}>
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className="mt-1 text-xl font-bold text-gray-900">{value}</p>
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
