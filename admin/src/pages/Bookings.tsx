import { useEffect, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime, fmtCurrency } from '@/lib/formatters';

interface Booking {
  id: string;
  business_id: string;
  customer_id: string;
  service_name: string | null;
  booking_date: string | null;
  start_time: string | null;
  end_time: string | null;
  status: string;
  amount: number | null;
  currency: string | null;
  notes: string | null;
  payment_status: string | null;
  payment_method: string | null;
  cancellation_reason: string | null;
  created_at: string;
  updated_at: string | null;
  // enriched
  business_name?: string;
  customer_name?: string;
  customer_email?: string;
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

  useEffect(() => {
    async function load() {
      // Load bookings
      const { data: bookingData } = await adminDb
        .from('bookings')
        .select('*')
        .order('created_at', { ascending: false });

      const rows = bookingData || [];

      // Load business names + categories to filter out giving orgs
      const bizIds = [...new Set(rows.map(b => b.business_id).filter(Boolean))];
      const { data: bizData } = bizIds.length > 0
        ? await adminDb.from('businesses').select('id, name, category').in('id', bizIds)
        : { data: [] };

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
      const customerIds = [...new Set(rows.map(b => b.customer_id).filter(Boolean))];
      const { data: profileData } = customerIds.length > 0
        ? await adminDb.from('profiles').select('id, first_name, last_name, email').in('id', customerIds)
        : { data: [] };

      const profileMap = new Map(
        (profileData || []).map(p => [p.id, { name: [p.first_name, p.last_name].filter(Boolean).join(' ') || '—', email: p.email || '—' }])
      );

      // Filter out giving-category bookings, then enrich
      const enriched: Booking[] = rows
        .filter(b => !givingBizIds.has(b.business_id))
        .map(b => ({
          ...b,
          business_name: bizMap.get(b.business_id) || 'Unknown',
          customer_name: profileMap.get(b.customer_id)?.name || 'Unknown',
          customer_email: profileMap.get(b.customer_id)?.email || '—',
        }));

      setBookings(enriched);
      setLoading(false);
    }
    load();
  }, []);

  const filtered = bookings.filter(b => {
    if (statusFilter !== 'all' && b.status !== statusFilter) return false;
    if (businessFilter !== 'all' && b.business_id !== businessFilter) return false;
    if (dateStart) {
      const bookDate = b.booking_date || b.created_at;
      if (bookDate < dateStart) return false;
    }
    if (dateEnd) {
      const bookDate = b.booking_date || b.created_at;
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
      <h1 className="text-2xl font-bold text-gray-900">Bookings</h1>
      <p className="mt-1 text-sm text-gray-500">Manage all customer bookings across businesses</p>

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
          <option value="all">All Businesses</option>
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
                  <td className="px-4 py-3 text-gray-600">{b.customer_name}</td>
                  <td className="px-4 py-3 text-gray-600">{b.service_name || '—'}</td>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                    {b.booking_date ? fmtDate(b.booking_date) : fmtDate(b.created_at)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={b.status} />
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">
                    {b.amount != null ? fmtCurrency(b.amount, b.currency || 'NGN') : '—'}
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
                <DetailRow label="Name" value={selected.customer_name || '—'} />
                <DetailRow label="Email" value={selected.customer_email || '—'} />
                <DetailRow label="Customer ID" value={selected.customer_id} />
              </div>
            </div>

            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Service Details</p>
              <div className="space-y-2">
                <DetailRow label="Service" value={selected.service_name || '—'} />
                <DetailRow label="Booking Date" value={selected.booking_date ? fmtDate(selected.booking_date) : '—'} />
                <DetailRow label="Start Time" value={selected.start_time || '—'} />
                <DetailRow label="End Time" value={selected.end_time || '—'} />
                {selected.notes && <DetailRow label="Notes" value={selected.notes} />}
              </div>
            </div>

            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Payment</p>
              <div className="space-y-2">
                <DetailRow
                  label="Amount"
                  value={selected.amount != null ? fmtCurrency(selected.amount, selected.currency || 'NGN') : '—'}
                />
                <DetailRow label="Currency" value={selected.currency || '—'} />
                <DetailRow label="Payment Status" value={selected.payment_status || '—'} />
                <DetailRow label="Payment Method" value={selected.payment_method || '—'} />
              </div>
            </div>

            {selected.status === 'cancelled' && selected.cancellation_reason && (
              <div className="mt-4 rounded-lg bg-red-50 p-4">
                <p className="text-xs font-semibold uppercase text-red-500 mb-2">Cancellation</p>
                <p className="text-sm text-red-700">{selected.cancellation_reason}</p>
              </div>
            )}
          </div>
        )}
      </DetailModal>
    </div>
  );
}
