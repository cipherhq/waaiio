'use client';

import { useEffect, useMemo, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';

interface Payment {
  id: string;
  booking_id: string | null;
  order_id: string | null;
  amount: number;
  status: string;
  reference: string;
  created_at: string;
}

interface Booking {
  id: string;
  flow_type: string;
  reference_code: string;
  customer_name: string | null;
  total_amount: number;
  status: string;
  created_at: string;
}

interface Transaction {
  id: string;
  date: string;
  type: 'booking' | 'order' | 'donation' | 'ticket' | 'payment';
  description: string;
  customer: string;
  amount: number;
  status: string;
  reference: string;
}

const typeStyles: Record<string, string> = {
  booking: 'bg-blue-100 text-blue-700',
  order: 'bg-green-100 text-green-700',
  donation: 'bg-purple-100 text-purple-700',
  ticket: 'bg-orange-100 text-orange-700',
  payment: 'bg-gray-100 text-gray-600',
};

export default function FinancialsPage() {
  const business = useBusiness();
  const [loading, setLoading] = useState(true);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [platformFees, setPlatformFees] = useState(0);
  const [pendingPayouts, setPendingPayouts] = useState(0);
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const perPage = 20;

  useEffect(() => {
    async function load() {
      const supabase = createClient();

      const [paymentsRes, bookingsRes, feesRes, payoutsRes] = await Promise.all([
        supabase
          .from('payments')
          .select('id, booking_id, order_id, amount, status, reference, created_at')
          .eq('business_id', business.id)
          .order('created_at', { ascending: false }),
        supabase
          .from('bookings')
          .select('id, flow_type, reference_code, customer_name, total_amount, status, created_at')
          .eq('business_id', business.id)
          .order('created_at', { ascending: false }),
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
      ]);

      setPayments(paymentsRes.data || []);
      setBookings(bookingsRes.data || []);
      setPlatformFees((feesRes.data || []).reduce((s, f) => s + Number(f.fee_total || 0), 0));
      setPendingPayouts((payoutsRes.data || []).reduce((s, p) => s + Number(p.net_amount || 0), 0));
      setLoading(false);
    }
    load();
  }, [business.id]);

  // Calculate metrics
  const totalRevenue = useMemo(() =>
    payments.filter(p => p.status === 'success').reduce((s, p) => s + Number(p.amount || 0), 0),
  [payments]);

  const netEarnings = totalRevenue - platformFees;

  // Build unified transactions
  const transactions = useMemo(() => {
    const txns: Transaction[] = [];
    const bookingMap = new Map(bookings.map(b => [b.id, b]));

    for (const p of payments) {
      const booking = p.booking_id ? bookingMap.get(p.booking_id) : null;
      let type: Transaction['type'] = 'payment';
      let description = `Payment ${p.reference}`;

      if (booking) {
        const flow = booking.flow_type || '';
        if (flow.includes('donation') || flow.includes('crowdfund')) {
          type = 'donation';
          description = `Donation - ${booking.reference_code}`;
        } else if (flow.includes('ticket') || flow.includes('event')) {
          type = 'ticket';
          description = `Ticket - ${booking.reference_code}`;
        } else if (flow.includes('order')) {
          type = 'order';
          description = `Order - ${booking.reference_code}`;
        } else {
          type = 'booking';
          description = `Booking - ${booking.reference_code}`;
        }
      } else if (p.order_id) {
        type = 'order';
        description = `Order payment - ${p.reference}`;
      }

      txns.push({
        id: p.id,
        date: p.created_at,
        type,
        description,
        customer: booking?.customer_name || '—',
        amount: Number(p.amount || 0),
        status: p.status,
        reference: p.reference,
      });
    }

    return txns;
  }, [payments, bookings]);

  // Filtered transactions
  const filtered = useMemo(() => {
    let result = transactions;
    if (typeFilter !== 'all') result = result.filter(t => t.type === typeFilter);
    if (statusFilter !== 'all') result = result.filter(t => t.status === statusFilter);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(t =>
        t.reference.toLowerCase().includes(q) ||
        t.customer.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q)
      );
    }
    return result;
  }, [transactions, typeFilter, statusFilter, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  // Monthly revenue for chart (last 6 months)
  const monthlyRevenue = useMemo(() => {
    const months: { label: string; amount: number }[] = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = d.toLocaleDateString('en-US', { month: 'short' });
      const amount = payments
        .filter(p => p.status === 'success' && p.created_at.startsWith(key))
        .reduce((s, p) => s + Number(p.amount || 0), 0);
      months.push({ label, amount });
    }
    return months;
  }, [payments]);

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
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Total Revenue" value={formatMoney(totalRevenue)} color="blue" />
        <MetricCard label="Platform Fees" value={formatMoney(platformFees)} color="orange" />
        <MetricCard label="Net Earnings" value={formatMoney(netEarnings)} color="green" />
        <MetricCard label="Pending Payouts" value={formatMoney(pendingPayouts)} color="yellow" />
      </div>

      {/* Monthly Revenue Chart */}
      <div className="mt-8 rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-gray-900">Monthly Revenue</h3>
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
        <select
          value={typeFilter}
          onChange={e => { setTypeFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Types</option>
          <option value="booking">Bookings</option>
          <option value="order">Orders</option>
          <option value="donation">Donations</option>
          <option value="ticket">Tickets</option>
          <option value="payment">Payments</option>
        </select>
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Statuses</option>
          <option value="success">Success</option>
          <option value="pending">Pending</option>
          <option value="failed">Failed</option>
        </select>
        <input
          type="text"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search reference or customer..."
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none sm:w-64"
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
                <th className="px-4 py-3 text-left font-medium text-gray-500">Type</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Description</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Customer</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Amount</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Ref</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(t => (
                <tr key={t.id} className="transition hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-900 whitespace-nowrap">{formatDate(t.date)}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${typeStyles[t.type]}`}>
                      {t.type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-700 max-w-[200px] truncate">{t.description}</td>
                  <td className="px-4 py-3 text-gray-600">{t.customer}</td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">{formatMoney(t.amount)}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      t.status === 'success' ? 'bg-green-100 text-green-700' :
                      t.status === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                      'bg-red-100 text-red-700'
                    }`}>
                      {t.status}
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

function formatMoney(amount: number): string {
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 0 }).format(amount);
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}
