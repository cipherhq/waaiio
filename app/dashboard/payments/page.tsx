'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import EmptyState from '@/components/dashboard/EmptyState';
import { PageHelp } from '@/components/dashboard/PageHelp';

// ── Types ──

interface PaymentRecord {
  id: string;
  amount: number;
  currency: string;
  gateway: string;
  gateway_reference: string | null;
  payment_method: string | null;
  status: string;
  paid_at: string | null;
  created_at: string;
  booking_id: string | null;
  invoice_id: string | null;
  campaign_id: string | null;
  reservation_id: string | null;
  order_id: string | null;
  bookings: {
    guest_name: string | null;
    guest_phone: string | null;
    flow_type: string | null;
    channel: string | null;
    payment_source: string | null;
    reference_code: string | null;
    notes: string | null;
  }[] | null;
}

const PAGE_SIZES = [25, 50, 100] as const;

type SourceFilter = 'all' | 'payment_request' | 'subscription' | 'booking' | 'invoice' | 'event' | 'order';

// ── Source classification ──
// Derives the payment source from FK columns and joined booking data.
// This is the Payments Received page — it shows ALL successful payments.

function getPaymentSource(row: PaymentRecord): { label: string; color: string; key: string } {
  if (row.invoice_id) return { label: 'Invoice', color: 'bg-indigo-50 text-indigo-700', key: 'invoice' };
  if (row.campaign_id) return { label: 'Donation', color: 'bg-pink-50 text-pink-700', key: 'donation' };
  if (row.reservation_id) return { label: 'Reservation', color: 'bg-cyan-50 text-cyan-700', key: 'booking' };
  if (row.order_id) return { label: 'Order', color: 'bg-orange-50 text-orange-700', key: 'order' };

  const booking = row.bookings?.[0];
  if (booking) {
    // Use payment_source if available (post-migration)
    if (booking.payment_source === 'subscription') return { label: 'Subscription', color: 'bg-purple-50 text-purple-700', key: 'subscription' };
    if (booking.payment_source === 'payment_request') {
      if (booking.channel === 'whatsapp') return { label: 'WhatsApp', color: 'bg-green-50 text-green-700', key: 'payment_request' };
      return { label: 'Payment Request', color: 'bg-blue-50 text-blue-700', key: 'payment_request' };
    }
    if (booking.payment_source === 'event') return { label: 'Event', color: 'bg-amber-50 text-amber-700', key: 'event' };
    if (booking.payment_source === 'booking') return { label: 'Booking', color: 'bg-teal-50 text-teal-700', key: 'booking' };
    if (booking.payment_source === 'order') return { label: 'Order', color: 'bg-orange-50 text-orange-700', key: 'order' };

    // Fallback: derive from flow_type for pre-migration records
    if (booking.flow_type === 'payment') {
      if (booking.notes?.startsWith('Recurring ')) return { label: 'Subscription', color: 'bg-purple-50 text-purple-700', key: 'subscription' };
      if (booking.channel === 'whatsapp') return { label: 'WhatsApp', color: 'bg-green-50 text-green-700', key: 'payment_request' };
      return { label: 'Payment Request', color: 'bg-blue-50 text-blue-700', key: 'payment_request' };
    }
    if (booking.flow_type === 'ticketing') return { label: 'Event', color: 'bg-amber-50 text-amber-700', key: 'event' };
    if (booking.flow_type === 'scheduling' || booking.flow_type === 'appointment') return { label: 'Booking', color: 'bg-teal-50 text-teal-700', key: 'booking' };
    if (booking.flow_type === 'ordering') return { label: 'Order', color: 'bg-orange-50 text-orange-700', key: 'order' };
  }

  return { label: 'Other', color: 'bg-gray-50 text-gray-600', key: 'other' };
}

function getCustomerName(row: PaymentRecord): string {
  return row.bookings?.[0]?.guest_name || 'Customer';
}

function getCustomerContact(row: PaymentRecord): string | null {
  return row.bookings?.[0]?.guest_phone || null;
}

// ── Page ──

export default function PaymentsReceivedPage() {
  const business = useBusiness();
  const country = (business.country_code || 'NG') as CountryCode;
  const searchParams = useSearchParams();
  const router = useRouter();

  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [initialLoad, setInitialLoad] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [pageSize, setPageSize] = useState<number>(25);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const currentPage = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  const [selectedPayment, setSelectedPayment] = useState<PaymentRecord | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  // Debounce search to avoid firing on every keystroke
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchIdRef = useRef(0);

  const loadPayments = useCallback(async (page = currentPage, size = pageSize) => {
    const fetchId = ++fetchIdRef.current;
    setFetching(true);
    setFetchError(null);
    try {
      const supabase = createClient();
      const from = (page - 1) * size;
      const to = from + size - 1;

      // All filtering and counting is server-side.
      // For source filters that require booking columns (payment_source, flow_type),
      // we use !inner join which converts to INNER JOIN and allows PostgREST filtering.
      // For 'all' and FK-based filters (invoice, order), we use a regular left join.
      const needsBookingFilter = ['payment_request', 'subscription', 'booking', 'event'].includes(sourceFilter);
      const bookingJoin = needsBookingFilter ? 'bookings!inner' : 'bookings';
      const selectCols = `id, amount, currency, gateway, gateway_reference, payment_method, status, paid_at, created_at, booking_id, invoice_id, campaign_id, reservation_id, order_id, ${bookingJoin}(guest_name, guest_phone, flow_type, channel, payment_source, reference_code, notes)`;

      let query = supabase
        .from('payments')
        .select(selectCols, { count: 'exact' })
        .eq('business_id', business.id)
        .eq('status', 'success')
        .is('deleted_at', null);

      // Server-side source filter — all filtering happens at database level
      switch (sourceFilter) {
        case 'payment_request':
          query = query.eq('bookings.payment_source', 'payment_request');
          break;
        case 'subscription':
          query = query.eq('bookings.payment_source', 'subscription');
          break;
        case 'booking':
          query = query.eq('bookings.payment_source', 'booking');
          break;
        case 'event':
          query = query.eq('bookings.payment_source', 'event');
          break;
        case 'invoice':
          query = query.not('invoice_id', 'is', null);
          break;
        case 'order':
          query = query.not('order_id', 'is', null);
          break;
        // 'all' — no additional filter
      }

      // Server-side search by gateway reference
      if (debouncedSearch.trim()) {
        const escaped = debouncedSearch.replace(/[%_]/g, '\\$&');
        query = query.ilike('gateway_reference', `%${escaped}%`);
      }

      query = query
        .order('paid_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to);

      const { data, count, error } = await query;
      if (fetchId !== fetchIdRef.current) return;
      if (error) {
        setFetchError('Failed to load payments');
      } else {
        setPayments((data || []) as unknown as PaymentRecord[]);
        setTotalCount(count ?? 0);
      }
    } catch {
      if (fetchId !== fetchIdRef.current) return;
      setFetchError('Failed to load payments');
    }
    setFetching(false);
    setInitialLoad(false);
  }, [business.id, currentPage, pageSize, sourceFilter, debouncedSearch]);

  useEffect(() => { loadPayments(); }, [loadPayments]);

  // Modal focus management
  useEffect(() => {
    if (selectedPayment && modalRef.current) modalRef.current.focus();
    if (!selectedPayment && triggerRef.current) {
      triggerRef.current.focus();
      triggerRef.current = null;
    }
  }, [selectedPayment]);

  function openDetail(row: PaymentRecord, el: HTMLElement) {
    triggerRef.current = el;
    setSelectedPayment(row);
  }

  function closeDetail() { setSelectedPayment(null); }

  function goToPage(page: number) {
    const params = new URLSearchParams(searchParams.toString());
    if (page <= 1) params.delete('page');
    else params.set('page', String(page));
    router.push(`/dashboard/payments?${params.toString()}`);
  }

  function handlePageSizeChange(size: number) {
    setPageSize(size);
    const params = new URLSearchParams(searchParams.toString());
    params.delete('page');
    router.push(`/dashboard/payments?${params.toString()}`);
  }

  if (initialLoad) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center" role="status" aria-label="Loading payments">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
        <span className="sr-only">Loading payments</span>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Payments Received</h1>
          <p className="mt-1 text-sm text-gray-500">All successful payments from every source</p>
        </div>
      </div>

      <PageHelp
        pageKey="payments-received"
        title="Payments Received"
        description="View all money received by your business — payment requests, WhatsApp payments, subscriptions, bookings, invoices, and events."
      />

      {/* Filters */}
      <div className="mt-6 flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          {([
            { key: 'all', label: 'All' },
            { key: 'payment_request', label: 'Requests' },
            { key: 'subscription', label: 'Subscriptions' },
            { key: 'booking', label: 'Bookings' },
            { key: 'invoice', label: 'Invoices' },
            { key: 'event', label: 'Events' },
            { key: 'order', label: 'Orders' },
          ] as { key: SourceFilter; label: string }[]).map(f => (
            <button
              key={f.key}
              onClick={() => { setSourceFilter(f.key); goToPage(1); }}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                sourceFilter === f.key ? 'bg-brand text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name, phone, or reference..."
          className="w-full sm:w-64 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
        />
      </div>

      {/* Error */}
      {fetchError && (
        <div role="alert" className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {fetchError}
          <button onClick={() => loadPayments()} className="ml-2 font-medium underline">Retry</button>
        </div>
      )}

      {/* Content */}
      {!fetchError && payments.length === 0 && !fetching ? (
        <EmptyState
          icon="💰"
          title={sourceFilter === 'all' ? 'No payments received yet' : `No ${sourceFilter.replace('_', ' ')} payments found`}
          description="When customers pay through any channel, their payments will appear here."
        />
      ) : !fetchError && (payments.length > 0 || fetching) ? (
        <div className="mt-6">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-gray-900">Payments</h3>
            {fetching && <div className="h-3 w-3 animate-spin rounded-full border border-brand border-t-transparent" role="status" aria-label="Refreshing"><span className="sr-only">Refreshing</span></div>}
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs font-medium uppercase tracking-wider text-gray-400">
                  <th scope="col" className="pb-3 pr-4">Customer</th>
                  <th scope="col" className="pb-3 pr-4">Amount</th>
                  <th scope="col" className="pb-3 pr-4 hidden sm:table-cell">Paid</th>
                  <th scope="col" className="pb-3 pr-4">Source</th>
                  <th scope="col" className="pb-3 pr-4 hidden md:table-cell">Provider</th>
                  <th scope="col" className="pb-3 pr-4 hidden lg:table-cell">Reference</th>
                </tr>
              </thead>
              <tbody>
                {payments.map(row => {
                  const source = getPaymentSource(row);
                  const paidDate = row.paid_at || row.created_at;
                  return (
                    <tr
                      key={row.id}
                      className="border-b border-gray-50 hover:bg-gray-50/50 cursor-pointer focus-within:bg-gray-50/50"
                      tabIndex={0}
                      role="button"
                      aria-label={`View payment from ${getCustomerName(row)}, ${formatCurrency(row.amount, country)}, ${source.label}`}
                      onClick={e => openDetail(row, e.currentTarget)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(row, e.currentTarget); } }}
                    >
                      <td className="py-3 pr-4">
                        <p className="font-medium text-gray-900">{getCustomerName(row)}</p>
                        {getCustomerContact(row) && <p className="text-xs text-gray-400 font-mono">{getCustomerContact(row)}</p>}
                      </td>
                      <td className="py-3 pr-4 font-semibold text-gray-900">{formatCurrency(row.amount, country)}</td>
                      <td className="py-3 pr-4 text-gray-500 text-xs hidden sm:table-cell">
                        {new Date(paidDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td className="py-3 pr-4">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${source.color}`}>{source.label}</span>
                      </td>
                      <td className="py-3 pr-4 text-xs text-gray-500 capitalize hidden md:table-cell">{row.gateway || '-'}</td>
                      <td className="py-3 pr-4 text-xs text-gray-400 font-mono hidden lg:table-cell">{row.bookings?.[0]?.reference_code || '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalCount > 0 && (
            <div className="mt-4 flex flex-col sm:flex-row items-center justify-between gap-3 text-sm">
              <div className="flex items-center gap-2 text-gray-500">
                <span>Showing {Math.min((currentPage - 1) * pageSize + 1, totalCount)}–{Math.min(currentPage * pageSize, totalCount)} of {totalCount}</span>
                <select
                  value={pageSize}
                  onChange={e => handlePageSizeChange(Number(e.target.value))}
                  aria-label="Rows per page"
                  className="ml-2 rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 focus:outline-none focus:ring-2 focus:ring-brand/50"
                >
                  {PAGE_SIZES.map(s => <option key={s} value={s}>{s} per page</option>)}
                </select>
              </div>
              <nav aria-label="Payment pagination" className="flex items-center gap-3">
                <button onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1} aria-label="Previous page" className="rounded-md border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition">&larr; Previous</button>
                <span className="text-xs text-gray-500">Page {currentPage} of {totalPages}</span>
                <button onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= totalPages} aria-label="Next page" className="rounded-md border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition">Next &rarr;</button>
              </nav>
            </div>
          )}
        </div>
      ) : null}

      {/* Detail Modal */}
      {selectedPayment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true" aria-labelledby="payment-detail-title" onClick={closeDetail} onKeyDown={e => { if (e.key === 'Escape') closeDetail(); }}>
          <div ref={modalRef} tabIndex={-1} className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl outline-none" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 id="payment-detail-title" className="text-lg font-semibold text-gray-900">Payment Details</h3>
              <button onClick={closeDetail} aria-label="Close payment details" className="text-gray-400 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-brand/50 rounded">
                <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between"><span className="text-gray-500">Customer</span><span className="font-medium text-gray-900">{getCustomerName(selectedPayment)}</span></div>
              {getCustomerContact(selectedPayment) && <div className="flex justify-between"><span className="text-gray-500">Contact</span><span className="font-mono text-xs text-gray-700">{getCustomerContact(selectedPayment)}</span></div>}
              <div className="flex justify-between"><span className="text-gray-500">Amount</span><span className="font-semibold text-gray-900">{formatCurrency(selectedPayment.amount, country)}</span></div>
              <div className="flex justify-between items-center"><span className="text-gray-500">Source</span>{(() => { const src = getPaymentSource(selectedPayment); return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${src.color}`}>{src.label}</span>; })()}</div>
              <div className="flex justify-between"><span className="text-gray-500">Provider</span><span className="capitalize text-gray-700">{selectedPayment.gateway || '-'}</span></div>
              {selectedPayment.payment_method && <div className="flex justify-between"><span className="text-gray-500">Method</span><span className="capitalize text-gray-700">{selectedPayment.payment_method.replace(/_/g, ' ')}</span></div>}
              {selectedPayment.bookings?.[0]?.reference_code && <div className="flex justify-between"><span className="text-gray-500">Reference</span><span className="font-mono text-xs text-gray-700">{selectedPayment.bookings[0].reference_code}</span></div>}
              {selectedPayment.gateway_reference && <div className="flex justify-between"><span className="text-gray-500">Gateway Ref</span><span className="font-mono text-xs text-gray-700">{selectedPayment.gateway_reference}</span></div>}
              <div className="flex justify-between"><span className="text-gray-500">Paid</span><span className="text-green-700">{new Date(selectedPayment.paid_at || selectedPayment.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div>
              {selectedPayment.bookings?.[0]?.notes && <div className="flex justify-between"><span className="text-gray-500">Note</span><span className="text-gray-700 text-right max-w-[200px]">{selectedPayment.bookings[0].notes}</span></div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
