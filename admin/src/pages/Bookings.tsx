import { useEffect, useRef, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime, fmtCurrency } from '@/lib/formatters';

interface Booking {
  id: string;
  business_id: string;
  user_id: string | null;
  service_id: string | null;
  date: string;
  time: string;
  party_size: number;
  status: string;
  flow_type: string;
  total_amount: number;
  deposit_amount: number;
  deposit_status: string;
  guest_name: string | null;
  guest_phone: string | null;
  staff_name: string | null;
  reference_code: string;
  channel: string | null;
  notes: string | null;
  special_requests: string | null;
  created_at: string;
  updated_at: string | null;
  // enriched
  business_name?: string;
  service_name?: string;
  currency?: string;
}

// Categories handled by the Giving page — excluded here
const GIVING_CATEGORIES = ['church', 'mosque', 'ngo', 'crowdfunding_org'];

interface BusinessOption {
  id: string;
  name: string;
}

export default function Bookings() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [businesses, setBusinesses] = useState<BusinessOption[]>([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [businessFilter, setBusinessFilter] = useState('all');
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Booking | null>(null);
  const perPage = 20;
  const loadingRef = useRef(false);

  async function loadBookings() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      // Load bookings + reservations
      const [bookingsRes, reservationsRes] = await Promise.all([
        adminDb.from('bookings').select('*').order('created_at', { ascending: false }),
        adminDb.from('reservations').select('*').order('created_at', { ascending: false }),
      ]);

      // Map reservations to booking-like structure
      const mappedReservations = (reservationsRes.data || []).map(r => ({
        ...r,
        date: r.check_in,
        time: r.check_out ? `${r.nights || '?'} nights` : '',
        party_size: r.guests || 1,
        flow_type: 'reservation',
        staff_name: null,
        reference_code: r.reference_code || '',
      }));

      const rows = [...(bookingsRes.data || []), ...mappedReservations]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      // Load business names + categories to filter out giving orgs
      const bizIds = [...new Set(rows.map(b => b.business_id).filter(Boolean))];
      const { data: bizData } = bizIds.length > 0
        ? await adminDb.from('businesses').select('id, name, category, country_code').in('id', bizIds)
        : { data: [] };

      // Build business → currency map
      const COUNTRY_TO_CUR: Record<string, string> = { US: 'USD', CA: 'CAD', GB: 'GBP', NG: 'NGN', GH: 'GHS' };
      const bizCurrencyMap = new Map((bizData || []).map(b => [b.id, COUNTRY_TO_CUR[b.country_code] || 'NGN']));

      // Exclude giving-category businesses
      const givingBizIds = new Set(
        (bizData || []).filter(b => GIVING_CATEGORIES.includes(b.category)).map(b => b.id)
      );

      const bizMap = new Map((bizData || []).map(b => [b.id, b.name]));
      setBusinesses(
        (bizData || [])
          .filter(b => !GIVING_CATEGORIES.includes(b.category))
          .map(b => ({ id: b.id, name: b.name }))
          .sort((a, b) => a.name.localeCompare(b.name))
      );

      // Load customer profiles
      const customerIds = [...new Set(rows.map(b => b.user_id).filter(Boolean))];
      const { data: profileData } = customerIds.length > 0
        ? await adminDb.from('profiles').select('id, first_name, last_name, email').in('id', customerIds)
        : { data: [] };

      const profileMap = new Map(
        (profileData || []).map(p => [p.id, { name: [p.first_name, p.last_name].filter(Boolean).join(' ') || '—', email: p.email || '—' }])
      );

      // Load service names
      const serviceIds = [...new Set(rows.map(b => b.service_id).filter(Boolean))];
      const { data: serviceData } = serviceIds.length > 0
        ? await adminDb.from('services').select('id, name').in('id', serviceIds)
        : { data: [] };

      const serviceMap = new Map((serviceData || []).map(s => [s.id, s.name]));

      // Filter out giving-category bookings, then enrich
      const enriched: Booking[] = rows
        .filter(b => !givingBizIds.has(b.business_id))
        .map(b => ({
          ...b,
          business_name: bizMap.get(b.business_id) || 'Unknown',
          guest_name: b.guest_name || profileMap.get(b.user_id)?.name || '—',
          service_name: b.service_id ? serviceMap.get(b.service_id) || '—' : '—',
          currency: bizCurrencyMap.get(b.business_id) || 'NGN',
        }));

      setBookings(enriched);
    } catch (error) {
      console.warn('Failed to load bookings:', error);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  useEffect(() => {
    loadBookings();
    const interval = setInterval(loadBookings, 60_000);
    return () => clearInterval(interval);
  }, []);

  const filtered = bookings.filter(b => {
    if (statusFilter !== 'all' && b.status !== statusFilter) return false;
    if (businessFilter !== 'all' && b.business_id !== businessFilter) return false;
    if (dateStart) {
      const bookDate = b.date || b.created_at;
      if (bookDate < dateStart) return false;
    }
    if (dateEnd) {
      const bookDate = b.date || b.created_at;
      if (bookDate > dateEnd + 'T23:59:59') return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Bookings <span className="ml-2 text-xs text-gray-400">Auto-refreshing</span></h1>
      <p className="mt-1 text-sm text-gray-500">Manage all customer bookings across accounts</p>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="confirmed">Confirmed</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select
          value={businessFilter}
          onChange={e => { setBusinessFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Accounts</option>
          {businesses.map(b => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
        <input
          type="date"
          value={dateStart}
          onChange={e => { setDateStart(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        />
        <input
          type="date"
          value={dateEnd}
          onChange={e => { setDateEnd(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        />
        {(statusFilter !== 'all' || businessFilter !== 'all' || dateStart || dateEnd) && (
          <button
            onClick={() => { setStatusFilter('all'); setBusinessFilter('all'); setDateStart(''); setDateEnd(''); setPage(1); }}
            className="text-sm text-brand hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No bookings found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">ID</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Customer</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Service</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Date</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(b => (
                <tr
                  key={b.id}
                  onClick={() => setSelected(b)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 text-gray-600 font-mono text-xs">{b.id.slice(0, 8)}...</td>
                  <td className="px-4 py-3 font-medium text-gray-900">{b.business_name}</td>
                  <td className="px-4 py-3 text-gray-600">{b.guest_name}</td>
                  <td className="px-4 py-3 text-gray-600">{b.service_name || '—'}</td>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                    {b.date ? fmtDate(b.date) : fmtDate(b.created_at)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={b.status} />
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">
                    {b.total_amount != null ? fmtCurrency(b.total_amount, b.currency || 'NGN') : '—'}
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
        onClose={() => setSelected(null)}
        title="Booking Details"
      >
        {selected && (
          <div className="space-y-3 text-sm">
            <DetailRow label="Booking ID" value={selected.id} />
            <DetailRow label="Status" value={selected.status} />
            <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />
            {selected.updated_at && (
              <DetailRow label="Last Updated" value={fmtDateTime(selected.updated_at)} />
            )}

            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Business</p>
              <div className="space-y-2">
                <DetailRow label="Business" value={selected.business_name || '—'} />
                <DetailRow label="Business ID" value={selected.business_id} />
              </div>
            </div>

            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Customer</p>
              <div className="space-y-2">
                <DetailRow label="Guest" value={selected.guest_name || '—'} />
                <DetailRow label="Phone" value={selected.guest_phone || '—'} />
                <DetailRow label="Customer ID" value={selected.user_id} />
              </div>
            </div>

            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Service Details</p>
              <div className="space-y-2">
                <DetailRow label="Service" value={selected.service_name || '—'} />
                <DetailRow label="Date" value={selected.date ? fmtDate(selected.date) : '—'} />
                <DetailRow label="Time" value={selected.time || '—'} />
                <DetailRow label="Staff" value={selected.staff_name || '—'} />
                {selected.notes && <DetailRow label="Notes" value={selected.notes} />}
              </div>
            </div>

            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Payment</p>
              <div className="space-y-2">
                <DetailRow
                  label="Amount"
                  value={selected.total_amount != null && selected.total_amount > 0 ? fmtCurrency(selected.total_amount, selected.currency || 'NGN') : '—'}
                />
                <DetailRow label="Deposit Status" value={selected.deposit_status || '—'} />
                <DetailRow label="Channel" value={selected.channel || '—'} />
                <DetailRow label="Reference" value={selected.reference_code || '—'} />
              </div>
            </div>

            {selected.special_requests && (
              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Special Requests</p>
                <p className="text-sm text-gray-700">{selected.special_requests}</p>
              </div>
            )}
          </div>
        )}
      </DetailModal>
    </div>
  );
}
