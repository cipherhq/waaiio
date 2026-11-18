import { useEffect, useRef, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { StepUpDialog } from '@/components/StepUpDialog';
import { useAdminSession } from '@/components/AdminLayout';
import { useStepUp } from '@/hooks/useStepUp';
import { adminApiFetch, adminApiGet } from '@/lib/adminApi';
import { maskPhone } from '@/lib/formatters';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDate, fmtDateTime, fmtRelative, fmtCurrency } from '@/lib/formatters';
import { Users, UserCheck, CreditCard, Building2, Search, Ban } from 'lucide-react';

interface Customer {
  id: string; // generated key (user_id or phone)
  user_id: string | null;
  name: string;
  email: string;
  phone: string;
  /** Raw guest phone as stored on bookings, for the detail lookup. */
  guest_phone: string | null;
  /** E.164 digits used for platform suspension (#1103); null when unknown. */
  canonical_phone: string | null;
  businesses: { id: string; name: string }[];
  booking_count: number;
  payment_count: number;
  spending: Record<string, number>; // currency → amount of successful payments
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

interface Suspension {
  phone: string;
  reason: string;
  suspended_at: string;
}

const COUNTRY_TO_CURRENCY: Record<string, string> = { US: 'USD', CA: 'CAD', GB: 'GBP', NG: 'NGN', GH: 'GHS', IN: 'INR' };
const currencyFor = (country: string | null | undefined) => COUNTRY_TO_CURRENCY[country || 'NG'] || 'NGN';

export default function Customers() {
  const adminSession = useAdminSession();
  const isFullAdmin = adminSession?.role === 'admin';

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [businessFilter, setBusinessFilter] = useState('all');
  const [page, setPage] = useState(1);
  const perPage = 20;

  // Detail state
  const [selected, setSelected] = useState<Customer | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loadingTx, setLoadingTx] = useState(false);
  const [txError, setTxError] = useState('');

  // All businesses for filter dropdown
  const [allBusinesses, setAllBusinesses] = useState<{ id: string; name: string }[]>([]);

  // Platform-wide suspension (#1103)
  const [suspensions, setSuspensions] = useState<Map<string, Suspension>>(new Map());
  const [suspensionError, setSuspensionError] = useState('');
  const [suspendTarget, setSuspendTarget] = useState<{ phone: string; label: string; suspend: boolean } | null>(null);
  const [suspendReason, setSuspendReason] = useState('');
  const [suspendSaving, setSuspendSaving] = useState(false);
  const [suspendMessage, setSuspendMessage] = useState('');
  const stepUp = useStepUp();
  const stepUpCallbackRef = useRef<((stepUpId: string) => Promise<void>) | null>(null);
  const stepUpFlightRef = useRef(false);

  const loadingRef = useRef(false);

  async function loadSuspensions() {
    try {
      const res = await adminApiGet('/api/admin/customers/suspension');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Unable to load suspended customers');
      setSuspensions(new Map((data.suspensions as Suspension[]).map(s => [s.phone, s])));
      setSuspensionError('');
    } catch (err) {
      setSuspensionError(err instanceof Error ? err.message : 'Unable to load suspended customers');
    }
  }

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setLoadError('');

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

      const bizMap = new Map<string, string>(bizData.map((b: { id: string; name: string }) => [b.id, b.name]));
      setAllBusinesses(
        bizData.map((b: { id: string; name: string }) => ({ id: b.id, name: b.name })).sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))
      );
      const profileMap = new Map<string, { name: string; email: string; phone: string; canonical_phone: string | null }>(
        (profileData || []).map((p: { id: string; first_name?: string; last_name?: string; email?: string; phone?: string; canonical_phone?: string | null }) => [p.id, {
          name: [p.first_name, p.last_name].filter(Boolean).join(' ') || '',
          email: p.email || '',
          phone: p.phone || '',
          canonical_phone: p.canonical_phone ?? null,
        }])
      );

      // Group by customer (user_id or guest phone)
      const customerMap = new Map<string, Omit<Customer, 'id' | 'businesses'> & { businesses: Map<string, string> }>();

      function getOrCreate(key: string, userId: string | null, name: string, email: string, phone: string) {
        if (!customerMap.has(key)) {
          customerMap.set(key, {
            user_id: userId,
            name,
            email,
            phone,
            guest_phone: null,
            canonical_phone: null,
            businesses: new Map(),
            booking_count: 0,
            payment_count: 0,
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

      function touch(entry: { first_seen: string; last_active: string }, at: string) {
        if (at < entry.first_seen) entry.first_seen = at;
        if (at > entry.last_active) entry.last_active = at;
      }

      // Process bookings. Money is counted from successful payments only, so a
      // booking adds to the count, never to "spent".
      const bookingKey = new Map<string, string>();
      for (const b of bookings) {
        const userId = b.user_id;
        const profile = userId ? profileMap.get(userId) : null;

        const key = userId || b.canonical_phone || b.guest_phone || `anon-${b.id}`;
        if (b.id) bookingKey.set(b.id, key);
        const name = profile?.name || b.guest_name || '';
        const email = profile?.email || b.guest_email || '';
        const phone = profile?.phone || b.guest_phone || '';

        const entry = getOrCreate(key, userId, name, email, phone);
        entry.booking_count++;
        if (!entry.guest_phone && b.guest_phone) entry.guest_phone = b.guest_phone;
        if (!entry.canonical_phone) entry.canonical_phone = profile?.canonical_phone || b.canonical_phone || null;
        if (b.business_id) entry.businesses.set(b.business_id, bizMap.get(b.business_id) || 'Unknown');
        touch(entry, b.created_at);
      }

      // Process successful payments. A guest payment belongs to its booking's
      // customer; a payment with neither a user nor a booking has no customer.
      for (const p of payments) {
        if (p.status !== 'success') continue;
        const key = p.user_id || (p.booking_id ? bookingKey.get(p.booking_id) : undefined);
        if (!key) continue;
        const profile = p.user_id ? profileMap.get(p.user_id) : null;

        const entry = getOrCreate(key, p.user_id || null, profile?.name || '', profile?.email || '', profile?.phone || '');
        if (!entry.canonical_phone && profile?.canonical_phone) entry.canonical_phone = profile.canonical_phone;
        entry.payment_count++;
        const cur = p.currency || 'USD';
        if (typeof p.amount === 'number' && p.amount > 0) {
          entry.spending[cur] = (entry.spending[cur] || 0) + p.amount;
        }
        if (p.business_id) entry.businesses.set(p.business_id, bizMap.get(p.business_id) || 'Unknown');
        touch(entry, p.created_at);
      }

      // Build final list
      const list: Customer[] = [];
      for (const [key, entry] of customerMap) {
        list.push({
          ...entry,
          id: key,
          name: entry.name || '—',
          email: entry.email || '—',
          phone: entry.phone || '—',
          businesses: Array.from(entry.businesses.entries()).map(([id, name]) => ({ id, name })),
        });
      }

      list.sort((a, b) => new Date(b.last_active).getTime() - new Date(a.last_active).getTime());
      setCustomers(list);
    } catch (error) {
      console.warn('Failed to load customers:', error);
      setLoadError(error instanceof Error ? error.message : 'Failed to load customer data');
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  useEffect(() => { loadData(); loadSuspensions(); }, []);

  // Load transactions for selected customer
  useEffect(() => {
    if (!selected) {
      setTransactions([]);
      setTxError('');
      return;
    }
    setLoadingTx(true);
    setTxError('');

    async function loadTransactions() {
      const txs: Transaction[] = [];
      const customer = selected!;
      try {
        if (!customer.user_id && !customer.guest_phone) return;
        // Registered customers by user; guests by the phone on their bookings.
        const [ownerColumn, ownerValue] = customer.user_id ? ['user_id', customer.user_id] : ['guest_phone', customer.guest_phone!];
        const { data: bookings, error: bookingsError } = await adminDb
          .from('bookings')
          .select('id, business_id, service_id, status, total_amount, deposit_amount, reference_code, date, created_at')
          .eq(ownerColumn, ownerValue)
          .order('created_at', { ascending: false });
        if (bookingsError) throw new Error('Unable to load bookings');

        const [paymentsRes, ordersRes] = customer.user_id
          ? await Promise.all([
            adminDb.from('payments')
              .select('id, business_id, amount, currency, status, gateway_reference, created_at')
              .eq('user_id', customer.user_id)
              .order('created_at', { ascending: false }),
            adminDb.from('orders')
              .select('id, business_id, status, total_amount, reference_code, created_at')
              .eq('user_id', customer.user_id)
              .order('created_at', { ascending: false }),
          ])
          : [{ data: [], error: null }, { data: [], error: null }];
        if (paymentsRes.error) throw new Error('Unable to load payments');
        if (ordersRes.error) throw new Error('Unable to load orders');
        const payments = paymentsRes.data || [];
        const orders = ordersRes.data || [];

        // Business names and countries (currency), and service names
        const allBizIds = new Set<string>();
        for (const b of bookings || []) if (b.business_id) allBizIds.add(b.business_id);
        for (const p of payments) if (p.business_id) allBizIds.add(p.business_id);
        for (const o of orders) if (o.business_id) allBizIds.add(o.business_id);
        const serviceIds = [...new Set((bookings || []).map(b => b.service_id).filter(Boolean))] as string[];

        const [{ data: bizData }, { data: serviceData }] = await Promise.all([
          allBizIds.size > 0
            ? adminDb.from('businesses').select('id, name, country_code').in('id', [...allBizIds])
            : Promise.resolve({ data: [] as { id: string; name: string; country_code: string | null }[] }),
          serviceIds.length > 0
            ? adminDb.from('services').select('id, name').in('id', serviceIds)
            : Promise.resolve({ data: [] as { id: string; name: string }[] }),
        ]);
        const bizMap = new Map((bizData || []).map(b => [b.id, b]));
        const serviceMap = new Map((serviceData || []).map(s => [s.id, s.name]));

        for (const b of bookings || []) {
          txs.push({
            id: b.id,
            type: 'booking',
            business_name: bizMap.get(b.business_id)?.name || 'Unknown',
            service_name: (b.service_id && serviceMap.get(b.service_id)) || null,
            status: b.status,
            amount: b.total_amount || b.deposit_amount || 0,
            currency: currencyFor(bizMap.get(b.business_id)?.country_code),
            date: b.date || b.created_at,
            reference: b.reference_code || null,
          });
        }

        for (const p of payments) {
          txs.push({
            id: p.id,
            type: 'payment',
            business_name: bizMap.get(p.business_id)?.name || 'Unknown',
            service_name: null,
            status: p.status,
            amount: p.amount || 0,
            currency: p.currency || currencyFor(bizMap.get(p.business_id)?.country_code),
            date: p.created_at,
            reference: p.gateway_reference || null,
          });
        }

        for (const o of orders) {
          txs.push({
            id: o.id,
            type: 'order',
            business_name: bizMap.get(o.business_id)?.name || 'Unknown',
            service_name: null,
            status: o.status,
            amount: o.total_amount || 0,
            currency: currencyFor(bizMap.get(o.business_id)?.country_code),
            date: o.created_at,
            reference: o.reference_code || null,
          });
        }

        // Sort by date descending
        txs.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      } catch (err) {
        setTxError(err instanceof Error ? err.message : 'Unable to load transactions');
      } finally {
        setTransactions(txs);
        setLoadingTx(false);
      }
    }

    loadTransactions();
  }, [selected]);

  function openSuspend(phone: string, label: string, suspend: boolean) {
    setSuspendTarget({ phone, label, suspend });
    setSuspendReason('');
    setSuspendMessage('');
  }

  async function confirmSuspend() {
    if (!suspendTarget || !isFullAdmin || suspendSaving) return;
    const { phone, label, suspend } = suspendTarget;
    const reason = suspendReason.trim() ? suspendReason : null;
    if (suspend && (!reason || reason.trim().length < 3)) {
      setSuspendMessage('Enter a reason (at least 3 characters).');
      return;
    }
    setSuspendSaving(true);
    setSuspendMessage('');
    const onAuthorized = async (stepUpId: string) => {
      const res = await adminApiFetch('/api/admin/customers/suspension', { phone, suspended: suspend, reason, stepUpId });
      const data = await res.json().catch(() => ({}));
      stepUpCallbackRef.current = null;
      if (!res.ok) {
        setSuspendMessage(data.error || 'The change was not saved.');
        // 409: someone else already made this change; show the real state.
        await loadSuspensions();
        return;
      }
      await loadSuspensions();
      setSuspendTarget(null);
    };
    stepUpCallbackRef.current = onAuthorized;
    try {
      await stepUp.execute({
        actionType: 'customer_suspension',
        targetId: phone,
        params: { phone, suspended: suspend, reason },
        description: `${suspend ? 'Suspend' : 'Unsuspend'} ${label} (${maskPhone(phone)}) on all Waaiio bots`,
        onAuthorized,
      });
    } catch (err) {
      stepUpCallbackRef.current = null;
      setSuspendMessage(err instanceof Error ? err.message : 'Step-up failed');
      stepUp.reset();
    } finally {
      setSuspendSaving(false);
    }
  }

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
  // Successful payments, by currency
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
  // The confirmation stays hidden while the step-up dialog is up, and comes back
  // with the error if the step-up or the save fails.
  const stepUpInFlight = ['preparing', 'awaiting-code', 'verifying', 'executing'].includes(stepUp.state.phase);
  const stepUpFailure = stepUp.state.phase === 'error' ? stepUp.state.error : '';
  const selectedSuspension = selected?.canonical_phone ? suspensions.get(selected.canonical_phone) : undefined;

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

      {loadError && (
        <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {loadError}
        </div>
      )}
      {suspensionError && (
        <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {suspensionError}. Suspension status is not shown.
        </div>
      )}

      {/* Stats */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Total Customers" value={totalCustomers} icon={Users} color="blue" />
        <SummaryCard label="With Bookings" value={withBookings} icon={UserCheck} color="green" />
        <SummaryCard label="Successful Payments" value={revenueDisplay} icon={CreditCard} color="purple" />
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
          <option value="all">All Accounts</option>
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
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {c.name}
                    {c.canonical_phone && suspensions.has(c.canonical_phone) && (
                      <span className="ml-2 align-middle"><StatusBadge status="suspended" /></span>
                    )}
                  </td>
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

      {/* Suspended numbers (#1103), including numbers not in the list above */}
      {suspensions.size > 0 && (
        <div className="mt-8">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
            <Ban className="h-5 w-5 text-red-500" /> Suspended numbers ({suspensions.size})
          </h2>
          <p className="mt-1 text-sm text-gray-500">Blocked from every Waaiio bot at every business. Marketing skips them. Payments are not affected.</p>
          <div className="mt-3 overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100 bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Phone</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Reason</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Suspended</th>
                  {isFullAdmin && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {[...suspensions.values()].map(s => (
                  <tr key={s.phone}>
                    <td className="px-4 py-3 text-gray-700">{maskPhone(s.phone)}</td>
                    <td className="px-4 py-3 text-gray-600">{s.reason}</td>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtDateTime(s.suspended_at)}</td>
                    {isFullAdmin && (
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => openSuspend(s.phone, 'this number', false)}
                          className="text-sm font-medium text-brand hover:underline"
                        >
                          Unsuspend
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

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
            <DetailRow label="Successful payments" value={selected.payment_count} />
            <DetailRow label="Total Spent" value={
              Object.entries(selected.spending || {}).filter(([, a]) => a > 0).map(([cur, amt]) => fmtCurrency(amt, cur)).join(' · ') || '—'
            } />
            <DetailRow label="First Seen" value={fmtDateTime(selected.first_seen)} />
            <DetailRow label="Last Active" value={fmtDateTime(selected.last_active)} />

            {/* Platform-wide suspension (#1103) */}
            <div className="rounded-lg border border-gray-200 p-4">
              <p className="mb-2 text-xs font-semibold uppercase text-gray-500">Waaiio access</p>
              {!selected.canonical_phone ? (
                <p className="text-gray-500">No WhatsApp number in international format is on record, so this customer cannot be suspended here.</p>
              ) : selectedSuspension ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2"><StatusBadge status="suspended" /><span className="text-gray-600">since {fmtDateTime(selectedSuspension.suspended_at)}</span></div>
                  <p className="text-gray-600">Reason: {selectedSuspension.reason}</p>
                  {isFullAdmin && (
                    <button
                      onClick={() => openSuspend(selected.canonical_phone!, selected.name, false)}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                      Unsuspend
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2"><StatusBadge status="active" /><span className="text-gray-600">Can use every Waaiio bot</span></div>
                  {isFullAdmin && !suspensionError && (
                    <button
                      onClick={() => openSuspend(selected.canonical_phone!, selected.name, true)}
                      className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
                    >
                      Suspend from all bots
                    </button>
                  )}
                </div>
              )}
            </div>

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
              ) : txError ? (
                <p role="alert" className="text-red-600">{txError}</p>
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

      {/* Suspend / unsuspend confirmation */}
      <DetailModal
        open={!!suspendTarget && !stepUpInFlight}
        onClose={() => { if (!suspendSaving) setSuspendTarget(null); }}
        title={suspendTarget?.suspend ? 'Suspend from all Waaiio bots' : 'Unsuspend this number'}
      >
        {suspendTarget && (
          <div className="space-y-4 text-sm">
            <p className="text-gray-700">
              {suspendTarget.suspend
                ? <>The number {maskPhone(suspendTarget.phone)} will be blocked from every Waaiio bot at every business. It gets one short reply, with no reason given. Marketing will skip it. Payments, refunds and payouts are not changed.</>
                : <>The number {maskPhone(suspendTarget.phone)} will be able to use Waaiio bots again.</>}
            </p>
            <label className="block">
              <span className="text-xs font-semibold uppercase text-gray-500">
                Reason{suspendTarget.suspend ? ' (required, kept in the audit log)' : ' (optional)'}
              </span>
              <textarea
                value={suspendReason}
                onChange={e => setSuspendReason(e.target.value)}
                maxLength={500}
                rows={3}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
              />
            </label>
            {(suspendMessage || stepUpFailure) && <p role="alert" className="text-red-600">{suspendMessage || stepUpFailure}</p>}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setSuspendTarget(null)}
                disabled={suspendSaving}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmSuspend}
                disabled={suspendSaving}
                className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${suspendTarget.suspend ? 'bg-red-600 hover:bg-red-700' : 'bg-brand hover:opacity-90'}`}
              >
                {suspendSaving ? 'Working…' : suspendTarget.suspend ? 'Suspend' : 'Unsuspend'}
              </button>
            </div>
          </div>
        )}
      </DetailModal>

      <StepUpDialog
        open={!!stepUpCallbackRef.current && (stepUp.state.phase === 'awaiting-code' || stepUp.state.phase === 'verifying')}
        description={stepUp.state.description} method={stepUp.state.method}
        error={stepUp.state.error}
        loading={stepUp.state.phase === 'verifying'}
        onSubmit={async (code) => {
          if (stepUpFlightRef.current || !stepUpCallbackRef.current) return;
          stepUpFlightRef.current = true;
          try { await stepUp.submitCode(code, stepUpCallbackRef.current); }
          finally {
            stepUpFlightRef.current = false;
            if (!stepUpCallbackRef.current) stepUp.reset();
          }
        }}
        onCancel={() => { stepUp.reset(); stepUpCallbackRef.current = null; }}
      />
    </div>
  );
}
