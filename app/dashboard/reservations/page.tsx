'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { useCategoryConfig } from '@/hooks/useCategoryConfig';
import { RefundModal } from '@/components/dashboard/RefundModal';
import { CsvExportButton } from '@/components/dashboard/CsvExportButton';

interface Booking {
  id: string;
  reference_code: string;
  date: string;
  time: string;
  party_size: number;
  status: string;
  guest_name: string;
  guest_phone: string;
  guest_email: string;
  channel: string;
  special_requests: string | null;
  deposit_amount: number;
  deposit_status: string;
  total_amount: number;
  notes: string | null;
  created_at: string;
  confirmed_at: string | null;
  seated_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  payment_id: string | null;
  rescheduled_at: string | null;
  original_date: string | null;
  original_time: string | null;
}

const allStatuses = ['all', 'pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show'];

const statusColors: Record<string, string> = {
  confirmed: 'bg-green-100 text-green-800',
  pending: 'bg-yellow-100 text-yellow-800',
  in_progress: 'bg-blue-100 text-blue-800',
  seated: 'bg-blue-100 text-blue-800',
  completed: 'bg-gray-100 text-gray-700',
  cancelled: 'bg-red-100 text-red-700',
  no_show: 'bg-red-100 text-red-700',
};

const nextActions: Record<string, { label: string; next: string; color: string }[]> = {
  pending: [
    { label: 'Confirm', next: 'confirmed', color: 'text-green-600 hover:bg-green-50' },
    { label: 'Cancel', next: 'cancelled', color: 'text-red-600 hover:bg-red-50' },
  ],
  confirmed: [
    { label: 'Start', next: 'in_progress', color: 'text-blue-600 hover:bg-blue-50' },
    { label: 'No Show', next: 'no_show', color: 'text-red-600 hover:bg-red-50' },
    { label: 'Cancel', next: 'cancelled', color: 'text-red-600 hover:bg-red-50' },
  ],
  in_progress: [
    { label: 'Complete', next: 'completed', color: 'text-gray-600 hover:bg-gray-50' },
  ],
};

export default function BookingsPage() {
  const business = useBusiness();
  const { labels } = useCategoryConfig(business.category);
  const statuses = allStatuses.filter(s => !labels.hiddenStatuses.includes(s));
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const perPage = 20;

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) => setSelectedIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const toggleAll = () => setSelectedIds(prev => prev.size === pageItems.length ? new Set() : new Set(pageItems.map(b => b.id)));
  const [bulkUpdating, setBulkUpdating] = useState(false);

  const [refundModalOpen, setRefundModalOpen] = useState(false);
  const [refundPayment, setRefundPayment] = useState<{ id: string; amount: number; refund_amount: number; currency: string } | null>(null);

  const selected = bookings.find((b) => b.id === selectedId) || null;

  const totalPages = Math.max(1, Math.ceil(bookings.length / perPage));
  const pageItems = bookings.slice((page - 1) * perPage, page * perPage);

  // Reset page on filter change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setPage(1); }, [filter, dateFrom, dateTo, search]);

  async function openRefundModal(booking: Booking) {
    if (!booking.payment_id) return;
    const supabase = createClient();
    const { data: payment } = await supabase
      .from('payments')
      .select('id, amount, refund_amount, currency')
      .eq('id', booking.payment_id)
      .single();
    if (payment) {
      setRefundPayment({
        id: payment.id,
        amount: Number(payment.amount),
        refund_amount: Number(payment.refund_amount || 0),
        currency: payment.currency || 'NGN',
      });
      setRefundModalOpen(true);
    }
  }

  const fetchBookings = useCallback(async () => {
    const supabase = createClient();
    let query = supabase
      .from('bookings')
      .select('id, reference_code, date, time, party_size, status, guest_name, guest_phone, guest_email, channel, special_requests, deposit_amount, deposit_status, total_amount, notes, created_at, confirmed_at, seated_at, completed_at, cancelled_at, payment_id, rescheduled_at, original_date, original_time')
      .eq('business_id', business.id)
      .neq('flow_type', 'payment')
      .order('date', { ascending: false })
      .order('time', { ascending: false })
      .limit(100);

    if (filter !== 'all') query = query.eq('status', filter);
    if (dateFrom) query = query.gte('date', dateFrom);
    if (dateTo) query = query.lte('date', dateTo);

    const { data } = await query;
    let results = data || [];

    if (search) {
      const q = search.toLowerCase();
      results = results.filter(
        (r) =>
          r.guest_name?.toLowerCase().includes(q) ||
          r.guest_phone?.includes(q) ||
          r.reference_code?.toLowerCase().includes(q),
      );
    }

    setBookings(results as Booking[]);
    setLoading(false);
  }, [business.id, filter, dateFrom, dateTo, search]);

  useEffect(() => {
    fetchBookings();

    const supabase = createClient();
    const channel = supabase
      .channel('bookings-list')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'bookings', filter: `business_id=eq.${business.id}` },
        () => fetchBookings(),
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [fetchBookings, business.id]);

  async function updateStatus(id: string, newStatus: string) {
    const supabase = createClient();
    const extra: Record<string, unknown> = {};
    if (newStatus === 'confirmed') extra.confirmed_at = new Date().toISOString();
    if (newStatus === 'in_progress') extra.seated_at = new Date().toISOString();
    if (newStatus === 'completed') extra.completed_at = new Date().toISOString();
    if (newStatus === 'cancelled') extra.cancelled_at = new Date().toISOString();

    await supabase.from('bookings').update({ status: newStatus, ...extra }).eq('id', id);
    fetchBookings();
  }

  const title = labels.entityNamePlural.charAt(0).toUpperCase() + labels.entityNamePlural.slice(1);

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">{title}</h1>

      {/* Filters */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-1 overflow-x-auto rounded-lg border border-gray-200 bg-white p-1">
          {statuses.map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition ${
                filter === s ? 'bg-brand text-white' : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              {s === 'all' ? 'All' : s.replace('_', ' ')}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-brand" />
          <span className="text-xs text-gray-400">to</span>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-brand" />
        </div>
        <input
          type="text"
          placeholder="Search name, phone, ref..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-brand"
        />
        <CsvExportButton
          data={bookings.map(b => ({
            Reference: b.reference_code,
            Guest: b.guest_name,
            Phone: b.guest_phone,
            Date: b.date,
            Time: b.time,
            Status: b.status,
            'Party Size': b.party_size,
          }))}
          filename={`reservations-${new Date().toISOString().slice(0, 10)}`}
        />
        {(dateFrom || dateTo || search) && (
          <button onClick={() => { setDateFrom(''); setDateTo(''); setSearch(''); }} className="text-xs text-gray-400 hover:text-gray-600">
            Clear
          </button>
        )}
      </div>

      {/* Table */}
      {loading ? (
        <div className="mt-8 flex justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
        </div>
      ) : bookings.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-gray-200 p-12 text-center">
          <p className="text-sm text-gray-400">No {labels.entityNamePlural} found</p>
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border border-gray-100 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-50 bg-gray-50/50">
                <th className="px-4 py-3"><input type="checkbox" checked={selectedIds.size === pageItems.length && pageItems.length > 0} onChange={toggleAll} className="h-4 w-4 rounded border-gray-300" /></th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">{labels.personLabel}</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Date & Time</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">{labels.quantityLabel}</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Channel</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Ref</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map((r) => (
                <tr key={r.id} className={`cursor-pointer hover:bg-gray-50/50 ${selectedIds.has(r.id) ? 'bg-brand-50/30' : ''}`} onClick={() => setSelectedId(r.id)}>
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selectedIds.has(r.id)} onChange={() => toggleSelect(r.id)} className="h-4 w-4 rounded border-gray-300" /></td>
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900">{r.guest_name || '\u2014'}</p>
                    <p className="text-xs text-gray-400">{r.guest_phone}</p>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {new Date(r.date + 'T00:00').toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short' })}
                    {r.time && ` at ${r.time.slice(0, 5)}`}
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {labels.quantityLabel === 'amount'
                      ? formatCurrency(r.total_amount || r.deposit_amount || 0, (business.country_code || 'NG') as CountryCode)
                      : r.party_size}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-1 text-xs ${r.channel === 'whatsapp' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                      {r.channel || 'whatsapp'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusColors[r.status] || 'bg-gray-100 text-gray-600'}`}>
                      {r.status.replace('_', ' ')}
                    </span>
                    {r.rescheduled_at && (
                      <span className="ml-1 inline-flex items-center rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
                        Rescheduled
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-400">{r.reference_code}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                      {(nextActions[r.status] || []).filter(a => !labels.hiddenStatuses.includes(a.next)).map((action) => (
                        <button
                          key={action.next}
                          onClick={() => updateStatus(r.id, action.next)}
                          className={`rounded px-3 py-1.5 text-xs font-medium ${action.color}`}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Bulk Action Bar */}
      {selectedIds.size > 0 && (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-brand/20 bg-brand-50 p-3">
          <span className="text-sm font-medium text-gray-700">{selectedIds.size} selected</span>
          <button
            disabled={bulkUpdating}
            onClick={async () => {
              setBulkUpdating(true);
              for (const id of selectedIds) await updateStatus(id, 'confirmed');
              setBulkUpdating(false);
              setSelectedIds(new Set());
            }}
            className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {bulkUpdating ? 'Updating...' : 'Confirm All'}
          </button>
          <button
            disabled={bulkUpdating}
            onClick={async () => {
              setBulkUpdating(true);
              for (const id of selectedIds) await updateStatus(id, 'cancelled');
              setBulkUpdating(false);
              setSelectedIds(new Set());
            }}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            Cancel All
          </button>
          <button onClick={() => setSelectedIds(new Set())} className="text-xs text-gray-500 hover:text-gray-700">Clear</button>
        </div>
      )}

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

      {/* Refund Modal */}
      {refundPayment && (
        <RefundModal
          open={refundModalOpen}
          onClose={() => { setRefundModalOpen(false); setRefundPayment(null); }}
          paymentId={refundPayment.id}
          paymentAmount={refundPayment.amount}
          existingRefundAmount={refundPayment.refund_amount}
          currency={refundPayment.currency}
          businessId={business.id}
          isDirectSplit={business.payout_mode === 'direct_split'}
          countryCode={(business.country_code || 'NG') as CountryCode}
          onSuccess={() => { fetchBookings(); setSelectedId(null); }}
        />
      )}

      {/* Detail Panel */}
      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setSelectedId(null)}>
          <div className="fixed inset-0 bg-black/30" />
          <div className="relative z-10 h-full w-full max-w-md overflow-y-auto bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-100 bg-white px-6 py-4">
              <div>
                <p className="font-mono text-lg font-bold text-brand">{selected.reference_code}</p>
                <span className={`mt-1 inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusColors[selected.status] || 'bg-gray-100 text-gray-600'}`}>
                  {selected.status.replace('_', ' ')}
                </span>
              </div>
              <button onClick={() => setSelectedId(null)} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="space-y-6 px-6 py-5">
              <div>
                <h3 className="text-sm font-medium text-gray-500">{labels.personLabel}</h3>
                <p className="mt-1 text-sm font-medium text-gray-900">{selected.guest_name || '\u2014'}</p>
                {selected.guest_phone && <p className="text-sm text-gray-500">{selected.guest_phone}</p>}
                {selected.guest_email && <p className="text-sm text-gray-500">{selected.guest_email}</p>}
              </div>
              <div>
                <h3 className="text-sm font-medium text-gray-500">Details</h3>
                <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-gray-400">Date</span>
                    <p className="font-medium text-gray-900">
                      {new Date(selected.date + 'T00:00').toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
                    </p>
                  </div>
                  <div>
                    <span className="text-gray-400">Time</span>
                    <p className="font-medium text-gray-900">{selected.time?.slice(0, 5) || '\u2014'}</p>
                  </div>
                  <div>
                    <span className="text-gray-400">{labels.quantityLabel === 'amount' ? 'Amount' : labels.quantityLabel}</span>
                    <p className="font-medium text-gray-900">
                      {labels.quantityLabel === 'amount'
                        ? formatCurrency(selected.total_amount || selected.deposit_amount || 0, (business.country_code || 'NG') as CountryCode)
                        : selected.party_size}
                    </p>
                  </div>
                  <div>
                    <span className="text-gray-400">Channel</span>
                    <p className="font-medium text-gray-900">{selected.channel || 'whatsapp'}</p>
                  </div>
                </div>
              </div>
              {selected.special_requests && (
                <div className="rounded-lg bg-yellow-50 p-3">
                  <h3 className="text-sm font-medium text-yellow-800">Special Requests</h3>
                  <p className="mt-1 text-sm text-yellow-700">{selected.special_requests}</p>
                </div>
              )}
              {selected.rescheduled_at && (
                <div className="rounded-lg bg-blue-50 p-3">
                  <p className="text-xs font-medium text-blue-800">Rescheduled</p>
                  <p className="mt-1 text-xs text-blue-600">
                    Originally: {selected.original_date
                      ? new Date(selected.original_date + 'T00:00').toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short' })
                      : '—'}{selected.original_time ? ` at ${selected.original_time.slice(0, 5)}` : ''}
                  </p>
                  <p className="mt-0.5 text-xs text-blue-500">
                    Changed on {new Date(selected.rescheduled_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </p>
                </div>
              )}
              {nextActions[selected.status] && nextActions[selected.status].filter(a => !labels.hiddenStatuses.includes(a.next)).length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-gray-500">Actions</h3>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {nextActions[selected.status].filter(a => !labels.hiddenStatuses.includes(a.next)).map((action) => (
                      <button
                        key={action.next}
                        onClick={() => { updateStatus(selected.id, action.next); setSelectedId(null); }}
                        className={`rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium ${action.color}`}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {selected.payment_id && selected.deposit_status === 'paid' && (
                <div>
                  <h3 className="text-sm font-medium text-gray-500">Refund</h3>
                  <button
                    onClick={() => openRefundModal(selected)}
                    className="mt-2 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
                  >
                    Issue Refund
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
