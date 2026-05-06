import { useEffect, useRef, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { maskPhone } from '@/lib/formatters';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDate, fmtDateTime, fmtRelative, fmtCurrency } from '@/lib/formatters';
import { Users, UserCheck, CreditCard, Building2, Search } from 'lucide-react';

interface Customer {
  id: string; // generated key (user_id or phone)
  user_id: string | null;
  name: string;
  email: string;
  phone: string;
  businesses: { id: string; name: string }[];
  booking_count: number;
  payment_count: number;
  total_spent: number;
  currency: string;
  spending: Record<string, number>; // currency → amount
  first_seen: string;
  last_active: string;
}

interface Transaction {
  id: string;
  type: 'booking' | 'payment' | 'order';
  business_name: string;
  service_name: string | null;
  status: string;
  amount: number;
  currency: string;
  date: string;
  reference: string | null;
}

export default function Customers() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [businessFilter, setBusinessFilter] = useState('all');
  const [page, setPage] = useState(1);
  const perPage = 20;

  // Detail state
  const [selected, setSelected] = useState<Customer | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loadingTx, setLoadingTx] = useState(false);

  // All businesses for filter dropdown
  const [allBusinesses, setAllBusinesses] = useState<{ id: string; name: string }[]>([]);

  const loadingRef = useRef(false);

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      // Fetch all data via admin API (uses service key server-side, bypasses RLS)
      const apiUrl = import.meta.env.VITE_API_URL || '';
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;

      const res = await fetch(`${apiUrl}/api/admin/customers`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) throw new Error('Failed to load customer data');
      const apiData = await res.json();

      const bookings = apiData.bookings || [];
      const payments = apiData.payments || [];
      const bizData = apiData.businesses || [];
      const profileData = apiData.profiles || [];

      const bizMap = new Map(bizData.map((b: { id: string; name: string }) => [b.id, b.name]));
      setAllBusinesses(
        bizData.map((b: { id: string; name: string }) => ({ id: b.id, name: b.name })).sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))
      );
      const profileMap = new Map(
        (profileData || []).map(p => [p.id, {
          name: [p.first_name, p.last_name].filter(Boolean).join(' ') || '',
          email: p.email || '',
          phone: p.phone || '',
        }])
      );

      // Build business → country map for currency resolution
      const bizCountryMap = new Map(bizData.map((b: { id: string; country_code?: string }) => [b.id, b.country_code || 'NG']));
      const countryToCurrency: Record<string, string> = { US: 'USD', CA: 'CAD', GB: 'GBP', NG: 'NGN', GH: 'GHS', IN: 'INR' };

      // Group by customer (user_id or guest_phone)
      const customerMap = new Map<string, {
        user_id: string | null;
        name: string;
        email: string;
        phone: string;
        businesses: Map<string, string>;
        booking_count: number;
        payment_count: number;
        total_spent: number;
        currency: string;
        spending: Record<string, number>;
        first_seen: string;
        last_active: string;
      }>();

      function getOrCreate(key: string, userId: string | null, name: string, email: string, phone: string) {
        if (!customerMap.has(key)) {
          customerMap.set(key, {
            user_id: userId,
            name,
            email,
            phone,
            businesses: new Map(),
            booking_count: 0,
            payment_count: 0,
            total_spent: 0,
            currency: 'USD',
            spending: {},
            first_seen: new Date().toISOString(),
            last_active: new Date(0).toISOString(),
          });
        }
        const entry = customerMap.get(key)!;
        // Update name/email/phone if we have better data
        if (!entry.name && name) entry.name = name;
        if (!entry.email && email) entry.email = email;
        if (!entry.phone && phone) entry.phone = phone;
        return entry;
      }

      // Process bookings
      for (const b of bookings) {
        const userId = b.user_id;
        const profile = userId ? profileMap.get(userId) : null;

        const key = userId || b.guest_phone || `anon-${b.created_at}`;
        const name = profile?.name || b.guest_name || '';
        const email = profile?.email || b.guest_email || '';
        const phone = profile?.phone || b.guest_phone || '';

        const entry = getOrCreate(key, userId, name, email, phone);
        entry.booking_count++;
        const amt = b.total_amount || b.deposit_amount || 0;
        const cc = bizCountryMap.get(b.business_id) || 'NG';
        const cur = countryToCurrency[cc] || 'NGN';
        if (typeof amt === 'number' && amt > 0) {
          entry.spending[cur] = (entry.spending[cur] || 0) + amt;
          entry.total_spent += amt;
          entry.currency = cur;
        }
        if (b.business_id) entry.businesses.set(b.business_id, bizMap.get(b.business_id) || 'Unknown');
        if (b.created_at < entry.first_seen) entry.first_seen = b.created_at;
        if (b.created_at > entry.last_active) entry.last_active = b.created_at;
      }

      // Process payments
      for (const p of payments) {
        const userId = p.user_id;
        const profile = userId ? profileMap.get(userId) : null;

        const key = userId || `pay-${p.created_at}`;
        const name = profile?.name || '';
        const email = profile?.email || '';
        const phone = profile?.phone || '';

        const entry = getOrCreate(key, userId, name, email, phone);
        entry.payment_count++;
        const cur = p.currency || 'USD';
        if (p.amount && typeof p.amount === 'number') {
          entry.spending[cur] = (entry.spending[cur] || 0) + p.amount;
          entry.total_spent += p.amount;
          entry.currency = cur;
        }
        if (p.business_id) entry.businesses.set(p.business_id, bizMap.get(p.business_id) || 'Unknown');
        if (p.created_at < entry.first_seen) entry.first_seen = p.created_at;
        if (p.created_at > entry.last_active) entry.last_active = p.created_at;
      }

      // Build final list
      const list: Customer[] = [];
      for (const [key, entry] of customerMap) {
        list.push({
          id: key,
          user_id: entry.user_id,
          name: entry.name || '—',
          email: entry.email || '—',
          phone: entry.phone || '—',
          businesses: Array.from(entry.businesses.entries()).map(([id, name]) => ({ id, name })),
          booking_count: entry.booking_count,
          payment_count: entry.payment_count,
          total_spent: entry.total_spent,
          currency: entry.currency,
          spending: entry.spending,
          first_seen: entry.first_seen,
          last_active: entry.last_active,
        });
      }

      list.sort((a, b) => new Date(b.last_active).getTime() - new Date(a.last_active).getTime());
      setCustomers(list);
    } catch (error) {
      console.warn('Failed to load customers:', error);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  useEffect(() => { loadData(); }, []);

  // Load transactions for selected customer
  useEffect(() => {
    if (!selected) {
      setTransactions([]);
      return;
    }
    setLoadingTx(true);

    async function loadTransactions() {
      const txs: Transaction[] = [];

      if (selected!.user_id) {
        const { adminDb } = await import('@/lib/supabase');
        // Fetch bookings
        const { data: bookings } = await adminDb
          .from('bookings')
          .select('id, business_id, service_name, status, total_amount, amount, reference_code, booking_date, created_at')
          .eq('user_id', selected!.user_id)
          .order('created_at', { ascending: false });

        // Fetch payments
        const { data: payments } = await adminDb
          .from('payments')
          .select('id, business_id, amount, currency, status, gateway_reference, created_at')
          .eq('user_id', selected!.user_id)
          .order('created_at', { ascending: false });

        // Fetch orders
        const { data: orders } = await adminDb
          .from('orders')
          .select('id, business_id, status, total_amount, reference_code, created_at')
          .eq('user_id', selected!.user_id)
          .order('created_at', { ascending: false });

        // Get business names for all
        const allBizIds = new Set<string>();
        for (const b of bookings || []) if (b.business_id) allBizIds.add(b.business_id);
        for (const p of payments || []) if (p.business_id) allBizIds.add(p.business_id);
        for (const o of orders || []) if (o.business_id) allBizIds.add(o.business_id);

        const bizIdArr = [...allBizIds];
        const { data: bizData } = bizIdArr.length > 0
          ? await adminDb.from('businesses').select('id, name').in('id', bizIdArr)
          : { data: [] };
        const bizMap = new Map((bizData || []).map(b => [b.id, b.name]));

        for (const b of bookings || []) {
          txs.push({
            id: b.id,
            type: 'booking',
            business_name: bizMap.get(b.business_id) || 'Unknown',
            service_name: b.service_name || null,
            status: b.status,
            amount: b.total_amount || b.amount || 0,
            currency: 'NGN',
            date: b.booking_date || b.created_at,
            reference: b.reference_code || null,
          });
        }

        for (const p of payments || []) {
          txs.push({
            id: p.id,
            type: 'payment',
            business_name: bizMap.get(p.business_id) || 'Unknown',
            service_name: null,
            status: p.status,
            amount: p.amount || 0,
            currency: p.currency || 'NGN',
            date: p.created_at,
            reference: p.gateway_reference || null,
          });
        }

        for (const o of orders || []) {
          txs.push({
            id: o.id,
            type: 'order',
            business_name: bizMap.get(o.business_id) || 'Unknown',
            service_name: null,
            status: o.status,
            amount: o.total_amount || 0,
            currency: 'NGN',
            date: o.created_at,
            reference: o.reference_code || null,
          });
        }
      }

      // Sort by date descending
      txs.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      setTransactions(txs);
      setLoadingTx(false);
    }

    loadTransactions();
  }, [selected]);

  // Filters
  const filtered = customers.filter(c => {
    if (search) {
      const q = search.toLowerCase();
      if (
        !c.name.toLowerCase().includes(q) &&
        !c.email.toLowerCase().includes(q) &&
        !c.phone.includes(q)
      ) return false;
    }
    if (businessFilter !== 'all') {
      if (!c.businesses.some(b => b.id === businessFilter)) return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  // Stats
  const totalCustomers = customers.length;
  const withBookings = customers.filter(c => c.booking_count > 0).length;
  // Aggregate revenue by currency
  const revenueByCurrency: Record<string, number> = {};
  for (const c of customers) {
    for (const [cur, amt] of Object.entries(c.spending || {})) {
      revenueByCurrency[cur] = (revenueByCurrency[cur] || 0) + amt;
    }
  }
  const revenueParts = Object.entries(revenueByCurrency).filter(([, a]) => a > 0);
  const revenueDisplay = revenueParts.length > 0
    ? revenueParts.map(([cur, amt]) => fmtCurrency(amt, cur)).join(' · ')
    : '—';
  const uniqueBiz = new Set(customers.flatMap(c => c.businesses.map(b => b.id))).size;

  const hasFilters = search || businessFilter !== 'all';

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Customers</h1>
      <p className="mt-1 text-sm text-gray-500">End customers who booked, ordered, or made payments</p>

      {/* Stats */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Total Customers" value={totalCustomers} icon={Users} color="blue" />
        <SummaryCard label="With Bookings" value={withBookings} icon={UserCheck} color="green" />
        <SummaryCard label="Total Revenue" value={revenueDisplay} icon={CreditCard} color="purple" />
        <SummaryCard label="Businesses" value={uniqueBiz} icon={Building2} color="yellow" />
      </div>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search by name, email, or phone..."
            className="rounded-lg border border-gray-300 py-2 pl-10 pr-3 text-sm text-gray-700 focus:border-brand focus:outline-none sm:w-72"
          />
        </div>
        <select
          value={businessFilter}
          onChange={e => { setBusinessFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Businesses</option>
          {allBusinesses.map(b => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
        {hasFilters && (
          <button
            onClick={() => { setSearch(''); setBusinessFilter('all'); setPage(1); }}
            className="text-sm text-brand hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No customers found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Name</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Email</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Phone</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Bookings</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Payments</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Total Spent</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Last Active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(c => (
                <tr
                  key={c.id}
                  onClick={() => setSelected(c)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-medium text-gray-900">{c.name}</td>
                  <td className="px-4 py-3 text-gray-600">{c.email}</td>
                  <td className="px-4 py-3 text-gray-600">{maskPhone(c.phone)}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {c.businesses.length === 1
                      ? c.businesses[0].name
                      : c.businesses.length > 1
                        ? `${c.businesses[0].name} +${c.businesses.length - 1}`
                        : '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">{c.booking_count}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{c.payment_count}</td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">
                    {(() => {
                      const entries = Object.entries(c.spending || {}).filter(([, a]) => a > 0);
                      if (entries.length === 0) return '—';
                      if (entries.length === 1) return fmtCurrency(entries[0][1], entries[0][0]);
                      return (
                        <span title={entries.map(([cur, amt]) => fmtCurrency(amt, cur)).join('\n')}>
                          {entries.map(([cur, amt]) => (
                            <span key={cur} className="block text-xs leading-tight">{fmtCurrency(amt, cur)}</span>
                          ))}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtRelative(c.last_active)}</td>
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
        onClose={() => setSelected(null)}
        title={selected ? selected.name : ''}
        wide
      >
        {selected && (
          <div className="space-y-4 text-sm">
            <DetailRow label="Name" value={selected.name} />
            <DetailRow label="Email" value={selected.email} />
            <DetailRow label="Phone" value={maskPhone(selected.phone)} />
            <DetailRow label="Bookings" value={selected.booking_count} />
            <DetailRow label="Payments" value={selected.payment_count} />
            <DetailRow label="Total Spent" value={
              Object.keys(selected.spending || {}).length > 0
                ? Object.entries(selected.spending).filter(([, a]) => a > 0).map(([cur, amt]) => fmtCurrency(amt, cur)).join(' · ')
                : '—'
            } />
            <DetailRow label="First Seen" value={fmtDateTime(selected.first_seen)} />
            <DetailRow label="Last Active" value={fmtDateTime(selected.last_active)} />

            {/* Businesses */}
            {selected.businesses.length > 0 && (
              <div className="rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold uppercase text-gray-500 mb-2">
                  Businesses ({selected.businesses.length})
                </p>
                <div className="space-y-1">
                  {selected.businesses.map(b => (
                    <div key={b.id} className="flex justify-between">
                      <span className="text-gray-700">{b.name}</span>
                      <span className="font-mono text-xs text-gray-400">{b.id.slice(0, 8)}...</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Transactions */}
            <div className="rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">
                Transactions ({transactions.length})
              </p>
              {loadingTx ? (
                <div className="flex justify-center py-4">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                </div>
              ) : transactions.length === 0 ? (
                <p className="text-gray-400">No transactions found</p>
              ) : (
                <div className="max-h-80 overflow-y-auto space-y-2">
                  {transactions.map(tx => (
                    <div key={`${tx.type}-${tx.id}`} className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                            tx.type === 'booking' ? 'bg-blue-100 text-blue-700'
                              : tx.type === 'order' ? 'bg-purple-100 text-purple-700'
                              : 'bg-green-100 text-green-700'
                          }`}>
                            {tx.type}
                          </span>
                          <span className="font-medium text-gray-800 truncate">{tx.business_name}</span>
                        </div>
                        <p className="mt-0.5 text-xs text-gray-400">
                          {tx.service_name ? `${tx.service_name} · ` : ''}
                          {fmtDate(tx.date)}
                          {tx.reference ? ` · ${tx.reference}` : ''}
                        </p>
                      </div>
                      <div className="ml-3 text-right shrink-0">
                        <p className="font-medium text-gray-900">
                          {tx.amount > 0 ? fmtCurrency(tx.amount, tx.currency) : '—'}
                        </p>
                        <StatusBadge status={tx.status} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </DetailModal>
    </div>
  );
}
