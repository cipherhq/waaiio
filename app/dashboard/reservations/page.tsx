'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, getLocale, type CountryCode } from '@/lib/constants';
import { useCategoryConfig } from '@/hooks/useCategoryConfig';
import { RefundModal } from '@/components/dashboard/RefundModal';
import { CsvExportButton } from '@/components/dashboard/CsvExportButton';
import { PageHelp } from '@/components/dashboard/PageHelp';
import { PhoneInput } from '@/components/auth/PhoneInput';

interface ServiceOption {
  id: string;
  name: string;
  price: number;
  duration_minutes: number | null;
  requires_staff: boolean;
  staff_ids: string[];
  allow_staff_selection: boolean;
}

interface StaffOption {
  id: string;
  name: string;
}

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
  staff_id: string | null;
  staff_name: string | null;
  service_id: string | null;
  refund_amount: number | null;
  guest_list: Array<{ name: string }> | null;
  _isReservation?: boolean;
}

const allStatuses = ['all', 'pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show'];

const statusColors: Record<string, string> = {
  confirmed: 'bg-green-100 text-green-800',
  pending: 'bg-yellow-100 text-yellow-800',
  in_progress: 'bg-blue-100 text-blue-800',
  seated: 'bg-blue-100 text-blue-800',
  checked_in: 'bg-blue-100 text-blue-800',
  completed: 'bg-gray-100 text-gray-700',
  checked_out: 'bg-gray-100 text-gray-700',
  cancelled: 'bg-red-100 text-red-700',
  no_show: 'bg-red-100 text-red-700',
};

// Reservation-specific status labels
const reservationStatusLabels: Record<string, string> = {
  in_progress: 'Checked In',
  checked_in: 'Checked In',
  completed: 'Checked Out',
  checked_out: 'Checked Out',
};

// Actions for scheduling businesses (appointments, bookings)
const schedulingActions: Record<string, { label: string; next: string; color: string }[]> = {
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

// Actions for reservation businesses (hotel, shortlet, car rental)
const reservationActions: Record<string, { label: string; next: string; color: string }[]> = {
  pending: [
    { label: 'Confirm', next: 'confirmed', color: 'text-green-600 hover:bg-green-50' },
    { label: 'Cancel', next: 'cancelled', color: 'text-red-600 hover:bg-red-50' },
  ],
  confirmed: [
    { label: 'Check In', next: 'checked_in', color: 'text-blue-600 hover:bg-blue-50' },
    { label: 'No Show', next: 'no_show', color: 'text-red-600 hover:bg-red-50' },
    { label: 'Cancel', next: 'cancelled', color: 'text-red-600 hover:bg-red-50' },
  ],
  checked_in: [
    { label: 'Check Out', next: 'checked_out', color: 'text-gray-600 hover:bg-gray-50' },
  ],
  // Legacy status support (in_progress maps to checked_in)
  in_progress: [
    { label: 'Check Out', next: 'checked_out', color: 'text-gray-600 hover:bg-gray-50' },
  ],
};

export default function BookingsPage() {
  const business = useBusiness();
  const { labels } = useCategoryConfig(business.category);
  const statuses = allStatuses.filter(s => !labels.hiddenStatuses.includes(s));
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState('all');
  const [bookingType, setBookingType] = useState<'all' | 'reservations' | 'bookings'>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const perPage = 20;
  const [bookingNote, setBookingNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [messageText, setMessageText] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const [requestingBalance, setRequestingBalance] = useState(false);

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) => setSelectedIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const toggleAll = () => setSelectedIds(prev => prev.size === pageItems.length ? new Set() : new Set(pageItems.map(b => b.id)));
  const [bulkUpdating, setBulkUpdating] = useState(false);

  const [refundModalOpen, setRefundModalOpen] = useState(false);
  const [refundPayment, setRefundPayment] = useState<{ id: string; amount: number; refund_amount: number; currency: string } | null>(null);
  const [staffList, setStaffList] = useState<Array<{id: string; name: string}>>([]);

  // Reschedule state
  const [showReschedule, setShowReschedule] = useState(false);
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [rescheduleTime, setRescheduleTime] = useState('');
  const [rescheduling, setRescheduling] = useState(false);

  // New Booking form state
  const [showNewBooking, setShowNewBooking] = useState(false);
  const [nbServices, setNbServices] = useState<ServiceOption[]>([]);
  const [nbStaff, setNbStaff] = useState<StaffOption[]>([]);
  const [nbLoadingServices, setNbLoadingServices] = useState(false);
  const [nbSubmitting, setNbSubmitting] = useState(false);
  const [nbSuccess, setNbSuccess] = useState<{ refCode: string; whatsappSent: boolean } | null>(null);
  const [nbForm, setNbForm] = useState({
    serviceId: '',
    date: '',
    time: '',
    staffId: '',
    customerName: '',
    customerPhone: '',
    customerEmail: '',
    partySize: 1,
    notes: '',
    sendConfirmation: true,
  });
  const [nbError, setNbError] = useState('');

  // Selected service for the new booking form
  const nbSelectedService = nbServices.find(s => s.id === nbForm.serviceId);

  // Generate time slots based on business operating hours
  const nbTimeSlots: string[] = (() => {
    if (!nbForm.date || !nbSelectedService) return [];
    const dayOfWeek = new Date(nbForm.date + 'T00:00').toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const meta = business.metadata as Record<string, unknown> | null;
    const opHours = meta?.operating_hours as Record<string, { open?: string; close?: string; is_open?: boolean }> | undefined;
    let openTime = '09:00';
    let closeTime = '17:00';
    if (opHours && opHours[dayOfWeek]) {
      const dayHours = opHours[dayOfWeek];
      if (dayHours.is_open === false) return [];
      if (dayHours.open) openTime = dayHours.open;
      if (dayHours.close) closeTime = dayHours.close;
    }
    const duration = nbSelectedService.duration_minutes || 30;
    const slots: string[] = [];
    const [openH, openM] = openTime.split(':').map(Number);
    const [closeH, closeM] = closeTime.split(':').map(Number);
    let current = openH * 60 + openM;
    const end = closeH * 60 + closeM;
    while (current + duration <= end) {
      const h = Math.floor(current / 60).toString().padStart(2, '0');
      const m = (current % 60).toString().padStart(2, '0');
      slots.push(`${h}:${m}`);
      current += duration;
    }
    return slots;
  })();

  // Load services when new booking form opens
  async function loadNewBookingServices() {
    setNbLoadingServices(true);
    const supabase = createClient();
    const { data } = await supabase
      .from('services')
      .select('id, name, price, duration_minutes, requires_staff, staff_ids, allow_staff_selection')
      .eq('business_id', business.id)
      .eq('is_active', true)
      .is('deleted_at', null)
      .order('sort_order');
    setNbServices((data || []) as ServiceOption[]);
    setNbLoadingServices(false);
  }

  // Load staff for new booking form when a service requiring staff is selected
  async function loadNewBookingStaff(service: ServiceOption) {
    const supabase = createClient();
    let query = supabase
      .from('business_staff')
      .select('id, name')
      .eq('business_id', business.id)
      .eq('is_active', true)
      .order('name');

    const { data } = await query;
    let staffData = (data || []) as StaffOption[];

    // Filter by staff_ids if service has specific staff
    if (service.allow_staff_selection && service.staff_ids && service.staff_ids.length > 0) {
      staffData = staffData.filter(s => service.staff_ids.includes(s.id));
    }

    setNbStaff(staffData);
  }

  function resetNewBookingForm() {
    setNbForm({
      serviceId: '',
      date: '',
      time: '',
      staffId: '',
      customerName: '',
      customerPhone: '',
      customerEmail: '',
      partySize: 1,
      notes: '',
      sendConfirmation: true,
    });
    setNbError('');
    setNbSuccess(null);
    setNbStaff([]);
  }

  async function handleNewBookingSubmit() {
    setNbError('');
    if (!nbForm.serviceId || !nbForm.date || !nbForm.time || !nbForm.customerName || !nbForm.customerPhone) {
      setNbError('Please fill in all required fields.');
      return;
    }
    setNbSubmitting(true);
    try {
      const res = await fetch('/api/bookings/create-manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          serviceId: nbForm.serviceId,
          date: nbForm.date,
          time: nbForm.time,
          customerName: nbForm.customerName,
          customerPhone: nbForm.customerPhone,
          customerEmail: nbForm.customerEmail || undefined,
          partySize: nbForm.partySize,
          staffId: nbForm.staffId || undefined,
          notes: nbForm.notes || undefined,
          sendConfirmation: nbForm.sendConfirmation,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNbError(data.error || 'Failed to create booking');
      } else {
        setNbSuccess({
          refCode: data.reference_code,
          whatsappSent: data.whatsapp_sent,
        });
        fetchBookings();
      }
    } catch {
      setNbError('Network error. Please try again.');
    }
    setNbSubmitting(false);
  }

  const selected = bookings.find((b) => b.id === selectedId) || null;

  // Filter by booking type tab
  const filteredByType = bookingType === 'all' ? bookings
    : bookingType === 'reservations' ? bookings.filter(b => b._isReservation)
    : bookings.filter(b => !b._isReservation);

  const totalPages = Math.max(1, Math.ceil(filteredByType.length / perPage));
  const pageItems = filteredByType.slice((page - 1) * perPage, page * perPage);

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

  const isReservationType = business.flow_type === 'reservation';
  const hasReservationCapability = business.capabilities?.includes('reservation' as any);
  const showReservations = isReservationType || hasReservationCapability;
  const nextActions = showReservations ? reservationActions : schedulingActions;

  const fetchBookings = useCallback(async () => {
    try {
      setError(false);
      const supabase = createClient();

      let allBookings: Booking[] = [];

      // Query reservations table if business has reservation capability
      if (showReservations) {
        let rQuery = supabase
          .from('reservations')
          .select('id, reference_code, check_in, check_out, nights, guests, status, guest_name, guest_phone, guest_email, channel, special_requests, deposit_amount, deposit_status, total_amount, nightly_rate, created_at, confirmed_at, checked_in_at, checked_out_at, cancelled_at, payment_id, service_id, property_id, property:properties!property_id(name)')
          .eq('business_id', business.id)
          .order('check_in', { ascending: false })
          .limit(100);

        if (filter !== 'all') {
          // Map dashboard filter values to reservation-specific statuses
          if (filter === 'in_progress') {
            rQuery = rQuery.in('status', ['checked_in', 'in_progress']);
          } else if (filter === 'completed') {
            rQuery = rQuery.in('status', ['checked_out', 'completed']);
          } else {
            rQuery = rQuery.eq('status', filter);
          }
        }
        if (dateFrom) rQuery = rQuery.gte('check_in', dateFrom);
        if (dateTo) rQuery = rQuery.lte('check_in', dateTo);

        const { data, error: rError } = await rQuery;
        if (rError) {
          console.error('[RESERVATIONS] Reservations query failed:', rError.message, rError.code);
        }
        const mapped = (data || []).map(r => {
          const prop = r.property as unknown as { name: string } | null;
          return {
            ...r,
            date: r.check_in,
            time: r.check_out ? `${r.nights || '?'} night${r.nights !== 1 ? 's' : ''}` : '',
            party_size: r.guests || 1,
            staff_id: null,
            staff_name: prop?.name || null,
            notes: `🏠 ${prop?.name || 'Property'}`,
            refund_amount: null,
            guest_list: null,
            rescheduled_at: null,
            original_date: null,
            original_time: null,
            seated_at: r.checked_in_at,
            completed_at: r.checked_out_at,
            _isReservation: true,
          };
        }) as Booking[];
        allBookings.push(...mapped);

        // If ONLY reservation type (no scheduling), skip bookings query
        if (isReservationType) {
          setBookings(allBookings);
          setLoading(false);
          return;
        }
      }

      // Query bookings table (appointments + on-demand services)
      let query = supabase
        .from('bookings')
        .select('id, reference_code, date, time, party_size, status, guest_name, guest_phone, guest_email, channel, special_requests, deposit_amount, deposit_status, total_amount, notes, created_at, confirmed_at, seated_at, completed_at, cancelled_at, payment_id, rescheduled_at, original_date, original_time, staff_id, staff_name, service_id, guest_list')
        .eq('business_id', business.id)
        .neq('flow_type', 'payment')
        .order('date', { ascending: false })
        .order('time', { ascending: false })
        .limit(100);

      if (filter !== 'all') query = query.eq('status', filter);
      if (dateFrom) query = query.gte('date', dateFrom);
      if (dateTo) query = query.lte('date', dateTo);

      const { data, error: bookingsError } = await query;
      if (bookingsError) {
        console.error('[RESERVATIONS] Bookings query failed:', bookingsError.message, bookingsError.code);
      }
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

      // Merge with reservations (if any) and sort by date descending
      allBookings.push(...(results as Booking[]));
      allBookings.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      setBookings(allBookings);
    } catch {
      setError(true);
    }
    setLoading(false);
  }, [business.id, filter, dateFrom, dateTo, search, showReservations, isReservationType]);

  useEffect(() => {
    fetchBookings();

    // Load staff list for reassignment
    async function loadStaff() {
      const supabase = createClient();
      const { data } = await supabase
        .from('business_staff')
        .select('id, name')
        .eq('business_id', business.id)
        .eq('is_active', true)
        .order('name');
      setStaffList(data || []);
    }
    loadStaff();

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
    const now = new Date().toISOString();
    if (newStatus === 'confirmed') extra.confirmed_at = now;
    if (newStatus === 'cancelled') {
      extra.cancelled_at = now;
      extra.cancelled_by = 'business';
    }

    // Determine which table this record belongs to
    const booking = bookings.find(b => b.id === id);
    const isThisReservation = !!(booking as any)?._isReservation;

    if (isThisReservation) {
      // Date-gate check-in: only allow if today >= check_in date
      if (newStatus === 'checked_in') {
        const today = new Date().toISOString().split('T')[0];
        if (booking && booking.date > today) {
          alert(`Check-in is not available until ${new Date(booking.date + 'T00:00').toLocaleDateString()}`);
          return;
        }
        extra.checked_in_at = now;
        extra.checked_in_by = 'business';
      }
      if (newStatus === 'checked_out') extra.checked_out_at = now;
    } else {
      if (newStatus === 'in_progress') extra.seated_at = now;
      if (newStatus === 'completed') extra.completed_at = now;
    }

    const table = isThisReservation ? 'reservations' : 'bookings';
    await supabase.from(table).update({ status: newStatus, ...extra }).eq('id', id);

    // Notify guest on check-in (reservation only)
    if (isThisReservation && newStatus === 'checked_in' && booking?.guest_phone) {
      fetch('/api/reservations/notify-checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reservationId: id,
          businessId: business.id,
        }),
      }).catch(() => {});
    }

    // Release booking slot on cancel/no_show so the time becomes available again
    if (newStatus === 'cancelled' || newStatus === 'no_show') {
      const booking = bookings.find(b => b.id === id);
      if (booking) {
        try {
          await supabase.rpc('release_booking_slot', {
            p_business_id: business.id,
            p_date: booking.date,
            p_start_time: booking.time,
            p_staff_id: booking.staff_id || null,
          });
        } catch { /* Non-critical if slot doesn't exist */ }

        // Notify customer via API (non-blocking)
        if (newStatus === 'cancelled' && booking.guest_phone) {
          fetch('/api/notifications/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              business_id: business.id,
              phone: booking.guest_phone,
              message: `Your booking at ${business.name} on ${booking.date} has been cancelled. Contact us if you have questions.`,
            }),
          }).catch(() => {});
        }

        // Notify assigned staff member about cancellation (non-blocking)
        if (newStatus === 'cancelled' && booking.staff_id && !booking._isReservation) {
          fetch('/api/bookings/notify-staff-cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              bookingId: booking.id,
              businessId: business.id,
            }),
          }).catch(() => {});
        }

        // Notify next waitlist customer (non-blocking)
        if (newStatus === 'cancelled') {
          fetch('/api/waitlist/notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              business_id: business.id,
              service_id: booking.service_id || null,
            }),
          }).catch(() => {});
        }
      }
    }

    fetchBookings();
  }

  const title = labels.entityNamePlural.charAt(0).toUpperCase() + labels.entityNamePlural.slice(1);

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{title}</h1>
        {!isReservationType && (
          <button
            onClick={() => {
              resetNewBookingForm();
              setShowNewBooking(true);
              loadNewBookingServices();
            }}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 transition"
          >
            + New Booking
          </button>
        )}
      </div>

      <PageHelp
        pageKey="reservations"
        title="Customer Bookings"
        description="All bookings from your WhatsApp bot appear here. You can confirm, reschedule, or cancel bookings. Customers get automatic notifications."
      />

      {/* Summary Cards */}
      {(() => {
        const today = new Date().toISOString().split('T')[0];
        const active = bookings.filter(b => !['cancelled', 'no_show'].includes(b.status));
        const todayBookings = active.filter(b => b.date === today);
        const pendingCount = bookings.filter(b => b.status === 'pending').length;
        const totalRevenue = active.reduce((s, b) => s + Number(b.total_amount || b.deposit_amount || 0), 0);
        const confirmedCount = bookings.filter(b => b.status === 'confirmed').length;

        return (
          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-blue-100 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-4">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Today</p>
              <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">{todayBookings.length}</p>
            </div>
            <div className="rounded-xl border border-yellow-100 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-900/20 p-4">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Pending</p>
              <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">{pendingCount}</p>
            </div>
            <div className="rounded-xl border border-green-100 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-4">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Confirmed</p>
              <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">{confirmedCount}</p>
            </div>
            <div className="rounded-xl border border-purple-100 dark:border-purple-800 bg-purple-50 dark:bg-purple-900/20 p-4">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Revenue</p>
              <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">{formatCurrency(totalRevenue, (business.country_code || 'NG') as CountryCode)}</p>
            </div>
          </div>
        );
      })()}

      {/* Today's upcoming */}
      {(() => {
        const today = new Date().toISOString().split('T')[0];
        const todayItems = bookings.filter(b => b.date === today && !['cancelled', 'no_show', 'completed', 'checked_out'].includes(b.status));
        if (todayItems.length === 0) return null;

        return (
          <div className="mt-4 rounded-xl border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-900/20 p-4">
            <h3 className="text-sm font-semibold text-blue-900 dark:text-blue-300">Today&apos;s Schedule ({todayItems.length})</h3>
            <div className="mt-2 space-y-2">
              {todayItems.slice(0, 5).map(b => (
                <div key={b.id} className="flex items-center justify-between rounded-lg bg-white dark:bg-gray-800 px-3 py-2 text-sm">
                  <div className="flex items-center gap-3">
                    <span className="font-medium text-gray-900 dark:text-gray-100">{b.guest_name || 'Guest'}</span>
                    {b.time && !b._isReservation && <span className="text-gray-500 dark:text-gray-400">{b.time.slice(0, 5)}</span>}
                    {b._isReservation && b.staff_name && <span className="text-gray-400 dark:text-gray-500">{b.staff_name}</span>}
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    b.status === 'confirmed' ? 'bg-green-100 text-green-700' :
                    b.status === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                    ['in_progress', 'checked_in'].includes(b.status) ? 'bg-blue-100 text-blue-700' :
                    'bg-gray-100 text-gray-600'
                  }`}>{['in_progress', 'checked_in'].includes(b.status) ? (b._isReservation ? 'Checked In' : 'In Progress') : b.status}</span>
                </div>
              ))}
              {todayItems.length > 5 && <p className="text-xs text-blue-600">+{todayItems.length - 5} more</p>}
            </div>
          </div>
        );
      })()}

      {/* Booking type tabs — only show when business has multiple types */}
      {showReservations && !isReservationType && (
        <div className="mt-4 flex gap-1 border-b border-gray-200 dark:border-gray-700">
          {([
            { id: 'all' as const, label: 'All' },
            { id: 'bookings' as const, label: 'Appointments' },
            { id: 'reservations' as const, label: 'Reservations' },
          ]).map(tab => (
            <button key={tab.id} onClick={() => { setBookingType(tab.id); setPage(1); }}
              className={`px-4 py-2.5 text-sm font-medium transition border-b-2 -mb-px ${
                bookingType === tab.id ? 'border-brand text-brand' : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}>
              {tab.label}
              <span className="ml-1.5 text-xs text-gray-400">
                {tab.id === 'all' ? bookings.length : tab.id === 'reservations' ? bookings.filter(b => b._isReservation).length : bookings.filter(b => !b._isReservation).length}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-1 overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-1">
          {statuses.map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition ${
                filter === s ? 'bg-brand text-white' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50'
              }`}
            >
              {s === 'all' ? 'All' : s.replace('_', ' ')}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="rounded-lg border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 px-3 py-1.5 text-sm outline-none focus:border-brand" />
          <span className="text-xs text-gray-400 dark:text-gray-500">to</span>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="rounded-lg border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 px-3 py-1.5 text-sm outline-none focus:border-brand" />
        </div>
        <input
          type="text"
          placeholder="Search name, phone, ref..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded-lg border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 px-3 py-1.5 text-sm outline-none focus:border-brand"
        />
        <CsvExportButton
          data={bookings.map(b => ({
            Reference: b.reference_code,
            Guest: b.guest_name,
            Staff: b.staff_name || '',
            Phone: b.guest_phone,
            Date: b.date,
            Time: b.time,
            Status: b.status,
            'Party Size': b.party_size,
            Amount: b.total_amount || b.deposit_amount || 0,
            'Deposit Status': b.deposit_status || '',
            'Special Requests': b.special_requests || '',
            Notes: b.notes || '',
            Created: b.created_at?.slice(0, 10) || '',
          }))}
          filename={`reservations-${new Date().toISOString().slice(0, 10)}`}
        />
        {(dateFrom || dateTo || search) && (
          <button onClick={() => { setDateFrom(''); setDateTo(''); setSearch(''); }} className="text-xs text-gray-400 hover:text-gray-600">
            Clear
          </button>
        )}
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          Something went wrong loading data. <button onClick={() => { setError(false); fetchBookings(); }} className="font-medium underline hover:no-underline">Try again</button>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="mt-8 flex justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
        </div>
      ) : bookings.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-gray-200 dark:border-gray-700 p-12 text-center">
          <p className="text-sm text-gray-400 dark:text-gray-500">No {labels.entityNamePlural} found</p>
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-50 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/50">
                <th scope="col" className="px-4 py-3"><input type="checkbox" checked={selectedIds.size === pageItems.length && pageItems.length > 0} onChange={toggleAll} className="h-4 w-4 rounded border-gray-300 dark:border-gray-600" /></th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Guest</th>
                {bookingType === 'reservations' || (bookingType === 'all' && showReservations) ? (
                  <>
                    <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">{labels.propertyName || 'Property'}</th>
                    <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Check-in</th>
                    <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Check-out</th>
                    <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Nights</th>
                    <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Guests</th>
                    <th scope="col" className="px-4 py-3 text-right font-medium text-gray-500 dark:text-gray-400">Amount</th>
                  </>
                ) : (
                  <>
                    <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Staff</th>
                    <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Date & Time</th>
                    <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">{labels.quantityLabel}</th>
                    <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Channel</th>
                  </>
                )}
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Status</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Ref</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-700">
              {pageItems.map((r) => (
                <tr key={r.id} className={`cursor-pointer hover:bg-gray-50/50 dark:hover:bg-gray-700/50 ${selectedIds.has(r.id) ? 'bg-brand-50/30' : ''}`} onClick={() => setSelectedId(r.id)}>
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selectedIds.has(r.id)} onChange={() => toggleSelect(r.id)} className="h-4 w-4 rounded border-gray-300 dark:border-gray-600" /></td>
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900 dark:text-gray-100">{r.guest_name || '\u2014'}</p>
                    <p className="text-xs text-gray-400 dark:text-gray-500">{r.guest_phone}</p>
                  </td>
                  {r._isReservation || bookingType === 'reservations' ? (
                    <>
                      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{r.staff_name || '—'}</td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">
                        {new Date(r.date + 'T00:00').toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), { day: 'numeric', month: 'short' })}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">
                        {r.time ? r.time.replace(/\d+ night.*/, (m: string) => {
                          const nights = parseInt(m);
                          const checkIn = new Date(r.date + 'T00:00');
                          checkIn.setDate(checkIn.getDate() + nights);
                          return checkIn.toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), { day: 'numeric', month: 'short' });
                        }) : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{r.time?.match(/\d+/)?.[0] || '—'}</td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{r.party_size}</td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900 dark:text-gray-100">
                        {formatCurrency(r.total_amount || 0, (business.country_code || 'NG') as CountryCode)}
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{r.staff_name || '—'}</td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                        {new Date(r.date + 'T00:00').toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), { weekday: 'short', day: 'numeric', month: 'short' })}
                        {r.time && !r.time.includes('night') && ` at ${r.time.slice(0, 5)}`}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{r.party_size}</td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2.5 py-1 text-xs ${r.channel === 'whatsapp' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'}`}>
                          {r.channel || 'whatsapp'}
                        </span>
                      </td>
                    </>
                  )}
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusColors[r.status] || 'bg-gray-100 text-gray-600'}`}>
                      {(showReservations && reservationStatusLabels[r.status]) || r.status.replace('_', ' ')}
                    </span>
                    {r.rescheduled_at && (
                      <span className="ml-1 inline-flex items-center rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
                        Rescheduled
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-400 dark:text-gray-500">{r.reference_code}</td>
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
              const pending = bookings.filter(b => selectedIds.has(b.id) && b.status === 'pending');
              if (pending.length === 0) { alert('No pending bookings selected'); return; }
              if (!confirm(`Confirm ${pending.length} pending booking${pending.length > 1 ? 's' : ''}?`)) return;
              setBulkUpdating(true);
              for (const b of pending) await updateStatus(b.id, 'confirmed');
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
              const cancellable = bookings.filter(b => selectedIds.has(b.id) && ['pending', 'confirmed'].includes(b.status));
              if (cancellable.length === 0) { alert('No cancellable bookings selected'); return; }
              if (!confirm(`Cancel ${cancellable.length} booking${cancellable.length > 1 ? 's' : ''}? Customers will be notified.`)) return;
              setBulkUpdating(true);
              for (const b of cancellable) await updateStatus(b.id, 'cancelled');
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

      {/* New Booking Slide-over */}
      {showNewBooking && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={() => { if (!nbSubmitting) setShowNewBooking(false); }}>
          <div className="fixed inset-0 bg-black/30" />
          <div className="relative z-10 h-full w-full max-w-lg overflow-y-auto bg-white dark:bg-gray-900 shadow-xl" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-900 px-6 py-4">
              <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">New Booking</h2>
              <button
                aria-label="Close"
                onClick={() => { if (!nbSubmitting) setShowNewBooking(false); }}
                className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="px-6 py-5 space-y-5">
              {/* Success State */}
              {nbSuccess ? (
                <div className="text-center py-8">
                  <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
                    <svg className="h-6 w-6 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                  </div>
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Booking Created</h3>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    Reference: <span className="font-mono font-bold text-brand">{nbSuccess.refCode}</span>
                  </p>
                  {nbSuccess.whatsappSent && (
                    <p className="mt-2 text-sm text-green-600 dark:text-green-400">Confirmation sent via WhatsApp</p>
                  )}
                  <button
                    onClick={() => setShowNewBooking(false)}
                    className="mt-6 rounded-lg bg-brand px-6 py-2.5 text-sm font-medium text-white hover:bg-brand-600"
                  >
                    Done
                  </button>
                </div>
              ) : (
                <>
                  {/* Error */}
                  {nbError && (
                    <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-300">
                      {nbError}
                    </div>
                  )}

                  {/* Service */}
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Service <span className="text-red-500">*</span>
                    </label>
                    {nbLoadingServices ? (
                      <div className="flex items-center gap-2 text-sm text-gray-400">
                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                        Loading services...
                      </div>
                    ) : (
                      <select
                        value={nbForm.serviceId}
                        onChange={(e) => {
                          const svc = nbServices.find(s => s.id === e.target.value);
                          setNbForm(f => ({ ...f, serviceId: e.target.value, staffId: '', time: '' }));
                          if (svc?.requires_staff) loadNewBookingStaff(svc);
                          else setNbStaff([]);
                        }}
                        className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
                      >
                        <option value="">Select a service</option>
                        {nbServices.map(s => (
                          <option key={s.id} value={s.id}>
                            {s.name} - {formatCurrency(s.price, (business.country_code || 'NG') as CountryCode)}
                            {s.duration_minutes ? ` (${s.duration_minutes}min)` : ''}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  {/* Date */}
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Date <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="date"
                      min={new Date().toISOString().split('T')[0]}
                      value={nbForm.date}
                      onChange={(e) => setNbForm(f => ({ ...f, date: e.target.value, time: '' }))}
                      className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
                    />
                  </div>

                  {/* Time */}
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Time <span className="text-red-500">*</span>
                    </label>
                    {nbForm.date && nbSelectedService ? (
                      nbTimeSlots.length > 0 ? (
                        <select
                          value={nbForm.time}
                          onChange={(e) => setNbForm(f => ({ ...f, time: e.target.value }))}
                          className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
                        >
                          <option value="">Select a time</option>
                          {nbTimeSlots.map(t => (
                            <option key={t} value={t}>{t}</option>
                          ))}
                        </select>
                      ) : (
                        <p className="text-sm text-yellow-600 dark:text-yellow-400">No available slots for this date.</p>
                      )
                    ) : (
                      <p className="text-sm text-gray-400 dark:text-gray-500">Select a service and date first</p>
                    )}
                  </div>

                  {/* Staff (conditional) */}
                  {nbSelectedService?.requires_staff && nbStaff.length > 0 && (
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                        Staff
                      </label>
                      <select
                        value={nbForm.staffId}
                        onChange={(e) => setNbForm(f => ({ ...f, staffId: e.target.value }))}
                        className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
                      >
                        <option value="">Any available</option>
                        {nbStaff.map(s => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Customer Name */}
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Customer Name <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={nbForm.customerName}
                      onChange={(e) => setNbForm(f => ({ ...f, customerName: e.target.value }))}
                      placeholder="Full name"
                      className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
                    />
                  </div>

                  {/* Customer Phone */}
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Customer Phone <span className="text-red-500">*</span>
                    </label>
                    <PhoneInput
                      value={nbForm.customerPhone}
                      onChange={(val) => setNbForm(f => ({ ...f, customerPhone: val }))}
                      countryCode={(business.country_code || 'NG') as CountryCode}
                    />
                  </div>

                  {/* Customer Email */}
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Customer Email
                    </label>
                    <input
                      type="email"
                      value={nbForm.customerEmail}
                      onChange={(e) => setNbForm(f => ({ ...f, customerEmail: e.target.value }))}
                      placeholder="email@example.com"
                      className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
                    />
                  </div>

                  {/* Party Size */}
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {labels.quantityLabel || 'Guests'}
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={nbForm.partySize}
                      onChange={(e) => setNbForm(f => ({ ...f, partySize: Math.max(1, parseInt(e.target.value) || 1) }))}
                      className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
                    />
                  </div>

                  {/* Notes */}
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Notes
                    </label>
                    <textarea
                      value={nbForm.notes}
                      onChange={(e) => setNbForm(f => ({ ...f, notes: e.target.value }))}
                      rows={3}
                      placeholder="Any special requests or notes..."
                      className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand resize-none"
                    />
                  </div>

                  {/* Send WhatsApp Confirmation */}
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={nbForm.sendConfirmation}
                      onChange={(e) => setNbForm(f => ({ ...f, sendConfirmation: e.target.checked }))}
                      className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-brand focus:ring-brand"
                    />
                    <span className="text-sm text-gray-700 dark:text-gray-300">Send WhatsApp confirmation to customer</span>
                  </label>

                  {/* Summary */}
                  {nbSelectedService && nbForm.date && nbForm.time && (
                    <div className="rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-4">
                      <h3 className="text-xs font-semibold uppercase text-gray-400 dark:text-gray-500 mb-2">Summary</h3>
                      <div className="space-y-1 text-sm">
                        <p className="text-gray-900 dark:text-gray-100"><span className="text-gray-500 dark:text-gray-400">Service:</span> {nbSelectedService.name}</p>
                        <p className="text-gray-900 dark:text-gray-100"><span className="text-gray-500 dark:text-gray-400">Date:</span> {new Date(nbForm.date + 'T00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
                        <p className="text-gray-900 dark:text-gray-100"><span className="text-gray-500 dark:text-gray-400">Time:</span> {nbForm.time}</p>
                        <p className="text-gray-900 dark:text-gray-100"><span className="text-gray-500 dark:text-gray-400">Amount:</span> {formatCurrency(nbSelectedService.price, (business.country_code || 'NG') as CountryCode)}</p>
                      </div>
                    </div>
                  )}

                  {/* Submit */}
                  <div className="flex gap-3 pt-2">
                    <button
                      onClick={handleNewBookingSubmit}
                      disabled={nbSubmitting || !nbForm.serviceId || !nbForm.date || !nbForm.time || !nbForm.customerName || !nbForm.customerPhone}
                      className="flex-1 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed transition"
                    >
                      {nbSubmitting ? (
                        <span className="flex items-center justify-center gap-2">
                          <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                          Creating...
                        </span>
                      ) : (
                        'Create Booking'
                      )}
                    </button>
                    <button
                      onClick={() => setShowNewBooking(false)}
                      disabled={nbSubmitting}
                      className="rounded-lg border border-gray-200 dark:border-gray-600 px-4 py-2.5 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Detail Panel */}
      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setSelectedId(null)}>
          <div className="fixed inset-0 bg-black/30" />
          <div className="relative z-10 h-full w-full max-w-lg overflow-y-auto bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-100 bg-white px-6 py-4">
              <div>
                <p className="font-mono text-lg font-bold text-brand">{selected.reference_code}</p>
                <span className={`mt-1 inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusColors[selected.status] || 'bg-gray-100 text-gray-600'}`}>
                  {(selected._isReservation && reservationStatusLabels[selected.status]) || selected.status.replace('_', ' ')}
                </span>
              </div>
              <button aria-label="Close" onClick={() => setSelectedId(null)} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100">
                <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="space-y-5 px-6 py-5">
              {/* Guest Info */}
              <div className="rounded-lg bg-gray-50 p-4">
                <h3 className="text-xs font-semibold uppercase text-gray-400 mb-2">Guest</h3>
                <p className="text-sm font-semibold text-gray-900">{selected.guest_name || '—'}</p>
                {selected.guest_phone && <p className="text-sm text-gray-600">{selected.guest_phone}</p>}
                {selected.guest_email && <p className="text-sm text-gray-600">{selected.guest_email}</p>}
              </div>

              {/* Guest List (group bookings) */}
              {selected.guest_list && selected.guest_list.length > 0 && (
                <div className="rounded-lg bg-gray-50 p-4">
                  <h3 className="text-xs font-semibold uppercase text-gray-400 mb-2">Guests ({selected.guest_list.length})</h3>
                  {selected.guest_list.map((g, i) => (
                    <p key={i} className="text-sm text-gray-700">{g.name}</p>
                  ))}
                </div>
              )}

              {/* Property (reservations) */}
              {selected._isReservation && selected.staff_name && (
                <div className="rounded-lg bg-brand-50 p-4">
                  <h3 className="text-xs font-semibold uppercase text-gray-400 mb-2">{labels.propertyName || 'Property'}</h3>
                  <p className="text-sm font-semibold text-gray-900">{selected.staff_name}</p>
                </div>
              )}

              {/* Booking Details */}
              <div>
                <h3 className="text-xs font-semibold uppercase text-gray-400 mb-3">Details</h3>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  {selected._isReservation ? (
                    <>
                      <div>
                        <span className="text-gray-400">Check-in</span>
                        <p className="font-medium text-gray-900">{new Date(selected.date + 'T00:00').toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), { weekday: 'short', day: 'numeric', month: 'short' })}</p>
                      </div>
                      <div>
                        <span className="text-gray-400">Nights</span>
                        <p className="font-medium text-gray-900">{selected.time?.match(/\d+/)?.[0] || '—'}</p>
                      </div>
                      <div>
                        <span className="text-gray-400">Guests</span>
                        <p className="font-medium text-gray-900">{selected.party_size}</p>
                      </div>
                      <div>
                        <span className="text-gray-400">Channel</span>
                        <p className="font-medium text-gray-900">{selected.channel || 'whatsapp'}</p>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <span className="text-gray-400">Date</span>
                        <p className="font-medium text-gray-900">{new Date(selected.date + 'T00:00').toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), { weekday: 'short', day: 'numeric', month: 'short' })}</p>
                      </div>
                      <div>
                        <span className="text-gray-400">Time</span>
                        <p className="font-medium text-gray-900">{selected.time?.slice(0, 5) || '—'}</p>
                      </div>
                      <div>
                        <span className="text-gray-400">{labels.quantityLabel}</span>
                        <p className="font-medium text-gray-900">{selected.party_size}</p>
                      </div>
                      {staffList.length > 0 ? (
                        <div>
                          <span className="text-gray-400">Staff</span>
                          <select
                            value={selected.staff_id || ''}
                            onChange={async (e) => {
                              const newStaffId = e.target.value || null;
                              const staffMember = staffList.find(s => s.id === newStaffId);
                              const supabase = createClient();
                              await supabase.from('bookings')
                                .update({
                                  staff_id: newStaffId,
                                  staff_name: staffMember?.name || null,
                                })
                                .eq('id', selected.id);
                              setBookings(prev => prev.map(b => b.id === selected.id ? { ...b, staff_id: newStaffId, staff_name: staffMember?.name || null } : b));
                            }}
                            className="mt-0.5 block w-full text-sm font-medium border border-gray-200 rounded-lg px-2 py-1"
                          >
                            <option value="">Unassigned</option>
                            {staffList.map(s => (
                              <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                          </select>
                        </div>
                      ) : selected.staff_name ? (
                        <div>
                          <span className="text-gray-400">Staff</span>
                          <p className="font-medium text-gray-900">{selected.staff_name}</p>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </div>

              {/* Payment */}
              <div className="rounded-lg border border-gray-200 p-4">
                <h3 className="text-xs font-semibold uppercase text-gray-400 mb-3">Payment</h3>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-gray-400">Total</span>
                    <p className="text-lg font-bold text-gray-900">{formatCurrency(selected.total_amount || 0, (business.country_code || 'NG') as CountryCode)}</p>
                  </div>
                  <div>
                    <span className="text-gray-400">Deposit</span>
                    <p className="font-medium text-gray-900">
                      {selected.deposit_amount ? formatCurrency(selected.deposit_amount, (business.country_code || 'NG') as CountryCode) : 'None'}
                      {selected.deposit_status && selected.deposit_status !== 'none' && (
                        <span className={`ml-1 rounded-full px-1.5 py-0.5 text-xs ${selected.deposit_status === 'paid' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                          {selected.deposit_status}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
                {selected.refund_amount && selected.refund_amount > 0 && (
                  <p className="mt-2 text-sm text-green-600">Refunded: {formatCurrency(selected.refund_amount, (business.country_code || 'NG') as CountryCode)}</p>
                )}
                {/* Balance request — show when deposit paid but total not fully covered */}
                {selected.deposit_amount > 0 && selected.deposit_status === 'paid' && selected.total_amount > selected.deposit_amount && (
                  <button onClick={async () => {
                    setRequestingBalance(true);
                    try {
                      const res = await fetch('/api/bookings/request-balance', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          bookingId: selected.id,
                          businessId: business.id,
                          table: selected._isReservation ? 'reservations' : 'bookings',
                        }),
                      });
                      const data = await res.json();
                      if (!res.ok) alert(data.error || 'Failed to request balance');
                      else alert(`Balance payment link sent to ${selected.guest_phone}!`);
                    } catch { alert('Network error'); }
                    setRequestingBalance(false);
                  }} disabled={requestingBalance}
                    className="mt-3 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50">
                    {requestingBalance ? 'Sending...' : `Request Balance (${formatCurrency((selected.total_amount || 0) - (selected.deposit_amount || 0), (business.country_code || 'NG') as CountryCode)})`}
                  </button>
                )}
                {selected.payment_id && selected.deposit_status === 'paid' && !selected.refund_amount && (
                  <button onClick={() => openRefundModal(selected)}
                    className="mt-3 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50">
                    Issue Refund
                  </button>
                )}
              </div>

              {/* Special Requests */}
              {selected.special_requests && (
                <div className="rounded-lg bg-yellow-50 border border-yellow-200 p-4">
                  <h3 className="text-xs font-semibold uppercase text-yellow-700 mb-2">Special Requests</h3>
                  <p className="text-sm text-yellow-800 whitespace-pre-line">{selected.special_requests}</p>
                </div>
              )}

              {/* Notes */}
              <div>
                <h3 className="text-xs font-semibold uppercase text-gray-400 mb-2">Internal Notes</h3>
                <div className="flex gap-2">
                  <input type="text" value={bookingNote}
                    onChange={e => setBookingNote(e.target.value)}
                    placeholder="Add a note about this booking..."
                    className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
                  <button onClick={async () => {
                    if (!bookingNote.trim()) return;
                    setSavingNote(true);
                    const supabase = createClient();
                    const table = selected._isReservation ? 'reservations' : 'bookings';
                    await supabase.from(table).update({ notes: bookingNote.trim() }).eq('id', selected.id);
                    setSavingNote(false);
                    setBookingNote('');
                    fetchBookings();
                  }} disabled={savingNote || !bookingNote.trim()}
                    className="rounded-lg bg-brand px-3 py-2 text-xs font-medium text-white disabled:opacity-50">
                    {savingNote ? '...' : 'Save'}
                  </button>
                </div>
                {selected.notes && (
                  <p className="mt-2 text-sm text-gray-600 bg-gray-50 rounded-lg px-3 py-2">{selected.notes}</p>
                )}
              </div>

              {/* Send Message */}
              <div>
                <h3 className="text-xs font-semibold uppercase text-gray-400 mb-2">Message Guest</h3>
                <div className="flex gap-2">
                  <input type="text" value={messageText}
                    onChange={e => setMessageText(e.target.value)}
                    placeholder="Type a message to send via WhatsApp..."
                    className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
                  <button onClick={async () => {
                    if (!messageText.trim() || !selected.guest_phone) return;
                    setSendingMessage(true);
                    try {
                      await fetch('/api/forms/send', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ formId: '__message__', businessId: business.id, phone: selected.guest_phone }),
                      }).catch(() => {});
                      // Fallback: use notifications endpoint pattern
                      const { ChannelResolver } = await import('@/lib/channels/channel-resolver');
                    } catch {}
                    setSendingMessage(false);
                    setMessageText('');
                  }} disabled={sendingMessage || !messageText.trim() || !selected.guest_phone}
                    className="rounded-lg bg-green-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-50">
                    {sendingMessage ? '...' : 'Send'}
                  </button>
                </div>
              </div>

              {/* Timeline */}
              <div>
                <h3 className="text-xs font-semibold uppercase text-gray-400 mb-3">Timeline</h3>
                <div className="space-y-2 text-xs">
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-2 rounded-full bg-gray-400" />
                    <span className="text-gray-500">Created</span>
                    <span className="ml-auto text-gray-400">{new Date(selected.created_at).toLocaleString()}</span>
                  </div>
                  {selected.confirmed_at && (
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-2 rounded-full bg-green-500" />
                      <span className="text-gray-500">Confirmed</span>
                      <span className="ml-auto text-gray-400">{new Date(selected.confirmed_at).toLocaleString()}</span>
                    </div>
                  )}
                  {selected.rescheduled_at && (
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-2 rounded-full bg-blue-400" />
                      <span className="text-gray-500">Rescheduled</span>
                      <span className="ml-auto text-gray-400">{new Date(selected.rescheduled_at).toLocaleString()}</span>
                    </div>
                  )}
                  {selected.seated_at && (
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-2 rounded-full bg-blue-500" />
                      <span className="text-gray-500">{selected._isReservation ? 'Checked In' : 'Started'}</span>
                      <span className="ml-auto text-gray-400">{new Date(selected.seated_at).toLocaleString()}</span>
                    </div>
                  )}
                  {selected.completed_at && (
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-2 rounded-full bg-gray-600" />
                      <span className="text-gray-500">{selected._isReservation ? 'Checked Out' : 'Completed'}</span>
                      <span className="ml-auto text-gray-400">{new Date(selected.completed_at).toLocaleString()}</span>
                    </div>
                  )}
                  {selected.cancelled_at && (
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-2 rounded-full bg-red-500" />
                      <span className="text-gray-500">Cancelled</span>
                      <span className="ml-auto text-gray-400">{new Date(selected.cancelled_at).toLocaleString()}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Reschedule — only for non-reservation pending/confirmed bookings */}
              {!selected._isReservation && ['pending', 'confirmed'].includes(selected.status) && (
                <div className="border-t border-gray-100 pt-4">
                  {!showReschedule ? (
                    <button
                      onClick={() => {
                        setShowReschedule(true);
                        setRescheduleDate('');
                        setRescheduleTime('');
                      }}
                      className="rounded-lg border border-blue-200 px-4 py-2.5 text-sm font-medium text-blue-600 hover:bg-blue-50"
                    >
                      Reschedule
                    </button>
                  ) : (
                    <div className="space-y-3">
                      <h3 className="text-xs font-semibold uppercase text-gray-400">Reschedule Booking</h3>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="mb-1 block text-xs text-gray-500">New Date</label>
                          <input
                            type="date"
                            min={new Date().toISOString().split('T')[0]}
                            value={rescheduleDate}
                            onChange={(e) => setRescheduleDate(e.target.value)}
                            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-gray-500">New Time</label>
                          <input
                            type="time"
                            value={rescheduleTime}
                            onChange={(e) => setRescheduleTime(e.target.value)}
                            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                          />
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          disabled={rescheduling || !rescheduleDate || !rescheduleTime}
                          onClick={async () => {
                            setRescheduling(true);
                            try {
                              const res = await fetch(`/api/bookings/${selected.id}/reschedule`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  newDate: rescheduleDate,
                                  newTime: rescheduleTime,
                                  businessId: business.id,
                                }),
                              });
                              const data = await res.json();
                              if (!res.ok) {
                                alert(data.error || 'Failed to reschedule');
                              } else {
                                setShowReschedule(false);
                                fetchBookings();
                              }
                            } catch {
                              alert('Network error');
                            }
                            setRescheduling(false);
                          }}
                          className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                        >
                          {rescheduling ? 'Rescheduling...' : 'Confirm Reschedule'}
                        </button>
                        <button
                          onClick={() => setShowReschedule(false)}
                          className="rounded-lg border border-gray-200 px-4 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Actions */}
              {nextActions[selected.status] && nextActions[selected.status].filter(a => !labels.hiddenStatuses.includes(a.next)).length > 0 && (
                <div className="border-t border-gray-100 pt-4">
                  <div className="flex flex-wrap gap-2">
                    {nextActions[selected.status].filter(a => !labels.hiddenStatuses.includes(a.next)).map((action) => (
                      <button key={action.next}
                        onClick={() => { updateStatus(selected.id, action.next); setSelectedId(null); }}
                        className={`rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium ${action.color}`}>
                        {action.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
