'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useBusiness, useCapabilities } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, getLocale, type CountryCode } from '@/lib/constants';
import { PageHelp } from '@/components/dashboard/PageHelp';

interface Booking {
  id: string;
  reference_code: string;
  date: string;
  time: string;
  party_size: number;
  status: string;
  flow_type: string;
  guest_name: string;
  guest_phone: string;
  guest_email: string | null;
  special_requests: string | null;
  staff_id: string | null;
  staff_name: string | null;
  deposit_amount: number;
  deposit_status: string;
  total_amount: number;
  channel: string | null;
  notes: string | null;
  payment_id: string | null;
  checked_in_at: string | null;
  check_in_notes: string | null;
  checked_out_at: string | null;
  checkout_notes: string | null;
  no_show_at: string | null;
  no_show_reason: string | null;
}

interface Reservation {
  id: string;
  reference_code: string;
  check_in: string;
  check_out: string;
  guests: number;
  status: string;
  guest_name: string;
  guest_phone: string;
  total_amount: number;
  deposit_amount: number;
  deposit_status: string;
  special_requests: string | null;
  property_id: string;
  property: { name: string } | null;
}

interface EventItem {
  id: string;
  name: string;
  date: string;
  time: string | null;
  venue: string | null;
  status: string;
}

interface BlockedDate {
  id: string;
  date_from: string;
  date_to: string;
  reason: string | null;
  property: { name: string } | null;
}

type EntryType = 'booking' | 'reservation' | 'event' | 'blocked';

interface CalendarEntry {
  id: string;
  type: EntryType;
  title: string;
  date: string;         // YYYY-MM-DD
  time?: string;        // HH:MM for bookings
  status: string;
  color: string;
  details: Record<string, unknown>;
}

type ViewMode = 'month' | 'week' | 'day';
type FilterMode = 'all' | 'booking' | 'reservation' | 'event';

const statusColors: Record<string, string> = {
  confirmed: 'bg-green-100 border-green-300 text-green-800',
  pending: 'bg-yellow-100 border-yellow-300 text-yellow-800',
  in_progress: 'bg-blue-100 border-blue-300 text-blue-800',
  completed: 'bg-gray-100 border-gray-300 text-gray-700',
  cancelled: 'bg-red-100 border-red-300 text-red-700',
  no_show: 'bg-red-100 border-red-300 text-red-700',
};

const statusBadge: Record<string, string> = {
  confirmed: 'bg-green-100 text-green-800',
  pending: 'bg-yellow-100 text-yellow-800',
  in_progress: 'bg-blue-100 text-blue-800',
  completed: 'bg-gray-100 text-gray-700',
  cancelled: 'bg-red-100 text-red-700',
  no_show: 'bg-red-100 text-red-700',
};

const entryTypeColors: Record<EntryType, string> = {
  booking: '', // uses statusColors
  reservation: 'bg-indigo-100 border-indigo-300 text-indigo-800',
  event: 'bg-rose-100 border-rose-300 text-rose-800',
  blocked: 'bg-gray-200 border-gray-300 text-gray-600',
};

const entryTypeDotColors: Record<EntryType, string> = {
  booking: 'bg-green-500',
  reservation: 'bg-indigo-500',
  event: 'bg-rose-500',
  blocked: 'bg-gray-400',
};

const nextActions: Record<string, { label: string; next: string; color: string; needsInput?: 'notes' | 'reason' }[]> = {
  pending: [
    { label: 'Confirm', next: 'confirmed', color: 'text-green-600 hover:bg-green-50' },
    { label: 'Cancel', next: 'cancelled', color: 'text-red-600 hover:bg-red-50' },
  ],
  confirmed: [
    { label: 'Check In', next: 'check_in', color: 'text-blue-600 hover:bg-blue-50', needsInput: 'notes' },
    { label: 'No Show', next: 'no_show', color: 'text-orange-600 hover:bg-orange-50', needsInput: 'reason' },
    { label: 'Cancel', next: 'cancelled', color: 'text-red-600 hover:bg-red-50' },
  ],
  in_progress: [
    { label: 'Check Out', next: 'check_out', color: 'text-green-600 hover:bg-green-50', needsInput: 'notes' },
  ],
};

// HOUR_START, HOUR_END, and HOURS are now derived per-business inside the component via useMemo
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function formatDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatTime(time: string): string {
  const parts = time.slice(0, 5).split(':');
  const h = parseInt(parts[0], 10);
  const m = parts[1];
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${m} ${ampm}`;
}

function startOfWeek(d: Date): Date {
  const result = new Date(d);
  result.setDate(result.getDate() - result.getDay());
  return result;
}

/** Generate all dates between two YYYY-MM-DD strings inclusive */
function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const d = new Date(from + 'T00:00');
  const end = new Date(to + 'T00:00');
  while (d <= end) {
    dates.push(formatDateKey(d));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

// formatCurrency is imported from @/lib/constants — handles all countries properly

export default function CalendarPage() {
  const business = useBusiness();
  const { hasCapability } = useCapabilities();
  const [view, setView] = useState<ViewMode>('month');
  const [filter, setFilter] = useState<FilterMode>('all');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [blockedDates, setBlockedDates] = useState<BlockedDate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<CalendarEntry | null>(null);
  const [staffList, setStaffList] = useState<Array<{id: string; name: string; color: string}>>([]);
  const [staffFilter, setStaffFilter] = useState<string>('all');

  // Check-in/check-out/no-show action modal
  const [actionModal, setActionModal] = useState<{
    bookingId: string;
    action: string;
    inputType: 'notes' | 'reason' | null;
    label: string;
  } | null>(null);
  const [actionInput, setActionInput] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  const hasReservations = hasCapability('reservation');
  const hasEvents = hasCapability('ticketing');

  // Derive calendar hours from business operating_hours (earliest open, latest close across all days)
  const { HOUR_START, HOUR_END, HOURS } = useMemo(() => {
    let earliest = 8;
    let latest = 20;
    const oh = business.operating_hours;
    if (oh && typeof oh === 'object') {
      const entries = Object.values(oh);
      if (entries.length > 0) {
        let foundOpen = false;
        for (const slot of entries) {
          if (slot && typeof slot.open === 'string' && typeof slot.close === 'string') {
            const openHour = parseInt(slot.open.split(':')[0], 10);
            const closeHour = parseInt(slot.close.split(':')[0], 10);
            if (!isNaN(openHour) && !isNaN(closeHour)) {
              if (!foundOpen) {
                earliest = openHour;
                latest = closeHour;
                foundOpen = true;
              } else {
                if (openHour < earliest) earliest = openHour;
                if (closeHour > latest) latest = closeHour;
              }
            }
          }
        }
      }
    }
    // Clamp to valid range
    earliest = Math.max(0, Math.min(23, earliest));
    latest = Math.max(earliest + 1, Math.min(24, latest));
    return {
      HOUR_START: earliest,
      HOUR_END: latest,
      HOURS: Array.from({ length: latest - earliest }, (_, i) => earliest + i),
    };
  }, [business.operating_hours]);

  // Load staff list for filter
  useEffect(() => {
    async function loadStaff() {
      const supabase = createClient();
      const { data } = await supabase
        .from('business_staff')
        .select('id, name, color')
        .eq('business_id', business.id)
        .eq('is_active', true)
        .order('name');
      setStaffList(data || []);
    }
    loadStaff();
  }, [business.id]);

  // Compute date range based on view
  const viewDateRange = useMemo(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();

    if (view === 'month') {
      const first = new Date(year, month, 1);
      const last = new Date(year, month + 1, 0);
      const start = new Date(first);
      start.setDate(start.getDate() - start.getDay());
      const end = new Date(last);
      end.setDate(end.getDate() + (6 - end.getDay()));
      return { start, end };
    }

    if (view === 'week') {
      const start = startOfWeek(currentDate);
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      return { start, end };
    }

    return { start: new Date(currentDate), end: new Date(currentDate) };
  }, [view, currentDate]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
    const supabase = createClient();
    const startStr = formatDateKey(viewDateRange.start);
    const endStr = formatDateKey(viewDateRange.end);

    // Fetch bookings
    const { data: bookingData } = await supabase
      .from('bookings')
      .select('id, reference_code, date, time, party_size, status, flow_type, guest_name, guest_phone, guest_email, special_requests, staff_id, staff_name, deposit_amount, deposit_status, total_amount, channel, notes, payment_id, checked_in_at, check_in_notes, checked_out_at, checkout_notes, no_show_at, no_show_reason')
      .eq('business_id', business.id)
      .neq('flow_type', 'payment')
      .gte('date', startStr)
      .lte('date', endStr)
      .order('time', { ascending: true });

    setBookings((bookingData || []) as Booking[]);

    // Fetch reservations if capability exists
    if (hasReservations) {
      const { data: reservationData } = await supabase
        .from('reservations')
        .select('id, reference_code, check_in, check_out, guests, status, guest_name, guest_phone, total_amount, deposit_amount, deposit_status, special_requests, property_id, property:properties!property_id(name)')
        .eq('business_id', business.id)
        .lte('check_in', endStr)
        .gte('check_out', startStr)
        .in('status', ['pending', 'confirmed', 'in_progress', 'completed']);

      setReservations(
        ((reservationData || []) as Array<Omit<Reservation, 'property'> & { property: { name: string }[] }>).map((r) => ({
          ...r,
          property: r.property?.[0] || null,
        })),
      );

      // Fetch blocked dates
      const { data: blockedData } = await supabase
        .from('property_blocked_dates')
        .select('id, date_from, date_to, reason, property:properties!property_id(name)')
        .eq('business_id', business.id)
        .lte('date_from', endStr)
        .gte('date_to', startStr);

      setBlockedDates(
        ((blockedData || []) as Array<Omit<BlockedDate, 'property'> & { property: { name: string }[] }>).map((bd) => ({
          ...bd,
          property: bd.property?.[0] || null,
        })),
      );
    }

    // Fetch events if capability exists
    if (hasEvents) {
      const { data: eventData } = await supabase
        .from('events')
        .select('id, name, date, time, venue, status')
        .eq('business_id', business.id)
        .gte('date', startStr)
        .lte('date', endStr)
        .in('status', ['published', 'sold_out']);

      setEvents((eventData || []) as EventItem[]);
    }

    setLoading(false);
    } catch (err) {
      console.error('[CALENDAR] Failed to load data:', err);
      setError(true);
      setLoading(false);
    }
  }, [business.id, viewDateRange.start, viewDateRange.end, hasReservations, hasEvents]);

  useEffect(() => {
    fetchData();

    const supabase = createClient();
    const channels: ReturnType<typeof supabase.channel>[] = [];

    // Realtime for bookings
    const bookingChannel = supabase
      .channel('calendar-bookings')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'bookings', filter: `business_id=eq.${business.id}` },
        () => fetchData(),
      )
      .subscribe();
    channels.push(bookingChannel);

    // Realtime for reservations
    if (hasReservations) {
      const reservationChannel = supabase
        .channel('calendar-reservations')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'reservations', filter: `business_id=eq.${business.id}` },
          () => fetchData(),
        )
        .subscribe();
      channels.push(reservationChannel);
    }

    return () => {
      for (const ch of channels) {
        supabase.removeChannel(ch);
      }
    };
  }, [fetchData, business.id, hasReservations]);

  // Convert all data into CalendarEntry[]
  const allEntries = useMemo(() => {
    const entries: CalendarEntry[] = [];

    // Bookings
    for (const b of bookings) {
      entries.push({
        id: b.id,
        type: 'booking',
        title: b.guest_name || '\u2014',
        date: b.date,
        time: b.time?.slice(0, 5),
        status: b.status,
        color: statusColors[b.status] || 'bg-gray-100 border-gray-300 text-gray-700',
        details: b as unknown as Record<string, unknown>,
      });
    }

    // Reservations — span multiple days
    for (const r of reservations) {
      const days = dateRange(r.check_in, r.check_out);
      const propertyName = r.property?.name || '';
      for (let i = 0; i < days.length; i++) {
        entries.push({
          id: `${r.id}-${days[i]}`,
          type: 'reservation',
          title: `${r.guest_name || '\u2014'}${propertyName ? ` - ${propertyName}` : ''} (${i + 1}/${days.length})`,
          date: days[i],
          status: r.status,
          color: entryTypeColors.reservation,
          details: r as unknown as Record<string, unknown>,
        });
      }
    }

    // Events
    for (const e of events) {
      entries.push({
        id: e.id,
        type: 'event',
        title: e.name,
        date: e.date,
        time: e.time?.slice(0, 5) || undefined,
        status: e.status,
        color: entryTypeColors.event,
        details: e as unknown as Record<string, unknown>,
      });
    }

    // Blocked dates — span multiple days
    for (const bd of blockedDates) {
      const days = dateRange(bd.date_from, bd.date_to);
      const propertyName = bd.property?.name || 'Property';
      for (let i = 0; i < days.length; i++) {
        entries.push({
          id: `${bd.id}-${days[i]}`,
          type: 'blocked',
          title: `${propertyName} - Blocked${bd.reason ? `: ${bd.reason}` : ''} (${i + 1}/${days.length})`,
          date: days[i],
          status: 'blocked',
          color: entryTypeColors.blocked,
          details: bd as unknown as Record<string, unknown>,
        });
      }
    }

    return entries;
  }, [bookings, reservations, events, blockedDates]);

  // Apply type + staff filters
  const filteredEntries = useMemo(() => {
    let entries = allEntries;
    if (filter !== 'all') {
      entries = entries.filter((e) => e.type === filter);
    }
    if (staffFilter !== 'all') {
      entries = entries.filter((e) => {
        if (e.type === 'booking') return (e.details as unknown as Booking).staff_id === staffFilter;
        return true; // Show non-booking entries regardless
      });
    }
    return entries;
  }, [allEntries, filter, staffFilter]);

  // Group entries by date
  const entriesByDate = useMemo(() => {
    const map: Record<string, CalendarEntry[]> = {};
    for (const entry of filteredEntries) {
      if (!map[entry.date]) map[entry.date] = [];
      map[entry.date].push(entry);
    }
    // Sort entries within each date: bookings with time first, then others
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => {
        if (a.time && b.time) return a.time.localeCompare(b.time);
        if (a.time) return -1;
        if (b.time) return 1;
        return 0;
      });
    }
    return map;
  }, [filteredEntries]);

  // Keep bookingsByDate for the updateStatus function
  const bookingsByDate = useMemo(() => {
    const map: Record<string, Booking[]> = {};
    for (const b of bookings) {
      if (!map[b.date]) map[b.date] = [];
      map[b.date].push(b);
    }
    return map;
  }, [bookings]);

  async function updateStatus(id: string, newStatus: string, notes?: string) {
    // Use the status API for check-in/check-out/no-show (captures timestamps, notes, notifications)
    if (['check_in', 'check_out', 'no_show'].includes(newStatus)) {
      setActionLoading(true);
      try {
        const res = await fetch(`/api/bookings/${id}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: newStatus,
            notes: newStatus !== 'no_show' ? notes : undefined,
            reason: newStatus === 'no_show' ? notes : undefined,
            notify_customer: true,
          }),
        });
        if (!res.ok) {
          const data = await res.json();
          alert(data.error || 'Failed to update');
        }
      } catch { alert('Something went wrong'); }
      setActionLoading(false);
      setActionModal(null);
      setActionInput('');
      setSelectedEntry(null);
      fetchData();
      return;
    }

    // Direct update for simple status changes (confirm, cancel)
    const supabase = createClient();
    const extra: Record<string, unknown> = {};
    if (newStatus === 'confirmed') extra.confirmed_at = new Date().toISOString();
    if (newStatus === 'cancelled') {
      extra.cancelled_at = new Date().toISOString();
      extra.cancelled_by = 'business';
    }

    await supabase.from('bookings').update({ status: newStatus, ...extra }).eq('id', id);

    // Release slot + notify customer on cancel/no_show
    if (newStatus === 'cancelled' || newStatus === 'no_show') {
      // Find booking from all dates
      let booking: Booking | undefined;
      for (const arr of Object.values(bookingsByDate)) {
        booking = arr.find(b => b.id === id);
        if (booking) break;
      }
      if (booking) {
        try {
          await supabase.rpc('release_booking_slot', {
            p_business_id: business.id,
            p_date: booking.date,
            p_start_time: booking.time,
            p_staff_id: booking.staff_id || null,
          });
        } catch { /* Non-critical */ }

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
        if (newStatus === 'cancelled' && booking.staff_id) {
          fetch('/api/bookings/notify-staff-cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              bookingId: booking.id,
              businessId: business.id,
            }),
          }).catch(() => {});
        }
      }
    }

    setSelectedEntry(null);
    fetchData();
  }

  function navigate(direction: -1 | 1) {
    const d = new Date(currentDate);
    if (view === 'month') {
      d.setMonth(d.getMonth() + direction);
    } else if (view === 'week') {
      d.setDate(d.getDate() + direction * 7);
    } else {
      d.setDate(d.getDate() + direction);
    }
    setCurrentDate(d);
  }

  function goToToday() {
    setCurrentDate(new Date());
  }

  const periodLabel = useMemo(() => {
    if (view === 'month') {
      return `${MONTH_NAMES[currentDate.getMonth()]} ${currentDate.getFullYear()}`;
    }
    if (view === 'week') {
      const ws = startOfWeek(currentDate);
      const we = new Date(ws);
      we.setDate(we.getDate() + 6);
      const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
      return `${ws.toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), opts)} - ${we.toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), opts)}, ${we.getFullYear()}`;
    }
    return currentDate.toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }, [view, currentDate]);

  const monthGrid = useMemo(() => {
    if (view !== 'month') return [];
    const cells: Date[] = [];
    const d = new Date(viewDateRange.start);
    while (d <= viewDateRange.end) {
      cells.push(new Date(d));
      d.setDate(d.getDate() + 1);
    }
    return cells;
  }, [view, viewDateRange]);

  const weekDays = useMemo(() => {
    if (view !== 'week') return [];
    const ws = startOfWeek(currentDate);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(ws);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, [view, currentDate]);

  const today = formatDateKey(new Date());
  const currentMonth = currentDate.getMonth();

  // Monthly summary stats
  const monthlyStats = useMemo(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const monthEntries = allEntries.filter(e => {
      const d = new Date(e.date + 'T00:00');
      return d.getFullYear() === year && d.getMonth() === month;
    });
    const bookingEntries = monthEntries.filter(e => e.type === 'booking');
    const total = bookingEntries.length;
    const confirmed = bookingEntries.filter(e => e.status === 'confirmed' || e.status === 'completed' || e.status === 'in_progress').length;
    const cancelled = bookingEntries.filter(e => e.status === 'cancelled').length;
    const noShow = bookingEntries.filter(e => e.status === 'no_show').length;
    const pending = bookingEntries.filter(e => e.status === 'pending').length;
    const revenue = bookingEntries.reduce((s, e) => s + Number((e.details as Record<string, unknown>).total_amount || (e.details as Record<string, unknown>).deposit_amount || 0), 0);
    const reservationCount = monthEntries.filter(e => e.type === 'reservation').length;
    const eventCount = monthEntries.filter(e => e.type === 'event').length;
    return { total, confirmed, cancelled, noShow, pending, revenue, reservationCount, eventCount };
  }, [allEntries, currentDate]);

  // Determine which filter options to show
  const filterOptions: { key: FilterMode; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'booking', label: 'Bookings' },
  ];
  if (hasReservations) filterOptions.push({ key: 'reservation', label: 'Reservations' });
  if (hasEvents) filterOptions.push({ key: 'event', label: 'Events' });

  // Legend items
  const legendItems: { label: string; dotColor: string }[] = [
    { label: 'Booking', dotColor: entryTypeDotColors.booking },
  ];
  if (hasReservations) {
    legendItems.push({ label: 'Reservation', dotColor: entryTypeDotColors.reservation });
    legendItems.push({ label: 'Blocked', dotColor: entryTypeDotColors.blocked });
  }
  if (hasEvents) legendItems.push({ label: 'Event', dotColor: entryTypeDotColors.event });

  function renderEntryPill(entry: CalendarEntry, compact = false) {
    return (
      <button
        key={entry.id}
        onClick={() => setSelectedEntry(entry)}
        className={`w-full truncate rounded border px-1 py-0.5 text-left text-[10px] leading-tight ${entry.color}`}
      >
        <span className={`mr-0.5 inline-block h-1.5 w-1.5 rounded-full ${entryTypeDotColors[entry.type]}`} />
        {!compact && entry.time && <span className="font-medium">{entry.time}</span>}{' '}
        {entry.title}
      </button>
    );
  }

  function renderDetailModal() {
    if (!selectedEntry) return null;

    const d = selectedEntry.details;
    const entryType = selectedEntry.type;

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setSelectedEntry(null)}>
        <div className="fixed inset-0 bg-black/30" />
        <div
          className="relative z-10 w-full max-w-md rounded-xl bg-white shadow-xl dark:bg-gray-800"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Modal header */}
          <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 dark:border-gray-700">
            <div>
              {entryType === 'booking' && (
                <p className="font-mono text-lg font-bold text-brand">
                  {String((d as unknown as Booking).reference_code)}
                </p>
              )}
              {entryType === 'reservation' && (
                <p className="font-mono text-lg font-bold text-indigo-700">
                  {String((d as unknown as Reservation).reference_code)}
                </p>
              )}
              {entryType === 'event' && (
                <p className="text-lg font-bold text-rose-700">
                  {String((d as unknown as EventItem).name)}
                </p>
              )}
              {entryType === 'blocked' && (
                <p className="text-lg font-bold text-gray-700 dark:text-gray-300">
                  Blocked Dates
                </p>
              )}
              <div className="mt-1 flex items-center gap-2">
                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                  entryType === 'booking'
                    ? (statusBadge[selectedEntry.status] || 'bg-gray-100 text-gray-600')
                    : entryType === 'reservation'
                    ? 'bg-indigo-100 text-indigo-700'
                    : entryType === 'event'
                    ? 'bg-rose-100 text-rose-700'
                    : 'bg-gray-200 text-gray-600'
                }`}>
                  {selectedEntry.status.replace('_', ' ')}
                </span>
                <span className="text-xs text-gray-400 capitalize dark:text-gray-500">{entryType}</span>
              </div>
            </div>
            <button
              onClick={() => setSelectedEntry(null)}
              className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 dark:text-gray-500 dark:hover:bg-gray-700"
            >
              <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Modal body */}
          <div className="space-y-5 px-6 py-5">
            {/* === BOOKING DETAIL === */}
            {entryType === 'booking' && (() => {
              const b = d as unknown as Booking;
              return (
                <>
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Guest</h3>
                    <p className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100">
                      {b.guest_name || '\u2014'}
                    </p>
                    {b.guest_phone && (
                      <p className="text-sm text-gray-500 dark:text-gray-400">{b.guest_phone}</p>
                    )}
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Details</h3>
                    <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <span className="text-gray-400 dark:text-gray-500">Date</span>
                        <p className="font-medium text-gray-900 dark:text-gray-100">
                          {new Date(b.date + 'T00:00').toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), {
                            weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
                          })}
                        </p>
                      </div>
                      <div>
                        <span className="text-gray-400 dark:text-gray-500">Time</span>
                        <p className="font-medium text-gray-900 dark:text-gray-100">
                          {b.time ? formatTime(b.time) : '\u2014'}
                        </p>
                      </div>
                      <div>
                        <span className="text-gray-400 dark:text-gray-500">Party Size</span>
                        <p className="font-medium text-gray-900 dark:text-gray-100">{b.party_size}</p>
                      </div>
                      {staffList.length > 0 ? (
                        <div>
                          <span className="text-gray-400 dark:text-gray-500">Staff</span>
                          <select
                            value={b.staff_id || ''}
                            onChange={async (e) => {
                              const newStaffId = e.target.value || null;
                              const staffMember = staffList.find(s => s.id === newStaffId);
                              const supabase = createClient();
                              await supabase.from('bookings')
                                .update({
                                  staff_id: newStaffId,
                                  staff_name: staffMember?.name || null,
                                })
                                .eq('id', b.id);
                              setSelectedEntry(null);
                              fetchData();
                            }}
                            className="mt-0.5 block w-full text-sm font-medium border border-gray-200 rounded-lg px-2 py-1 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                          >
                            <option value="">Unassigned</option>
                            {staffList.map(s => (
                              <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                          </select>
                        </div>
                      ) : b.staff_name ? (
                        <div>
                          <span className="text-gray-400 dark:text-gray-500">Staff</span>
                          <p className="font-medium text-gray-900 dark:text-gray-100">{b.staff_name}</p>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  {b.special_requests && (
                    <div className="rounded-lg bg-yellow-50 p-3">
                      <h3 className="text-sm font-medium text-yellow-800">Special Requests</h3>
                      <p className="mt-1 text-sm text-yellow-700">{b.special_requests}</p>
                    </div>
                  )}
                  {nextActions[selectedEntry.status] && nextActions[selectedEntry.status].length > 0 && (
                    <div>
                      <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Actions</h3>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {nextActions[selectedEntry.status].map((action) => (
                          <button
                            key={action.next}
                            onClick={() => {
                              if (action.needsInput) {
                                setActionModal({ bookingId: b.id, action: action.next, inputType: action.needsInput, label: action.label });
                                setActionInput('');
                              } else {
                                updateStatus(b.id, action.next);
                              }
                            }}
                            className={`rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium dark:border-gray-600 ${action.color}`}
                          >
                            {action.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* Check-in/Check-out timestamps */}
                  {b.checked_in_at && (
                    <div className="rounded-lg bg-blue-50 p-3">
                      <p className="text-xs font-medium text-blue-700">Checked in: {new Date(b.checked_in_at).toLocaleTimeString()}</p>
                      {b.check_in_notes && <p className="mt-1 text-xs text-blue-600">{b.check_in_notes}</p>}
                    </div>
                  )}
                  {b.checked_out_at && (
                    <div className="rounded-lg bg-green-50 p-3">
                      <p className="text-xs font-medium text-green-700">Checked out: {new Date(b.checked_out_at).toLocaleTimeString()}</p>
                      {b.checkout_notes && <p className="mt-1 text-xs text-green-600">{b.checkout_notes}</p>}
                    </div>
                  )}
                  {b.no_show_at && (
                    <div className="rounded-lg bg-red-50 p-3">
                      <p className="text-xs font-medium text-red-700">No-show: {new Date(b.no_show_at).toLocaleTimeString()}</p>
                      {b.no_show_reason && <p className="mt-1 text-xs text-red-600">Reason: {b.no_show_reason}</p>}
                    </div>
                  )}
                </>
              );
            })()}

            {/* === RESERVATION DETAIL === */}
            {entryType === 'reservation' && (() => {
              const r = d as unknown as Reservation;
              return (
                <>
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Guest</h3>
                    <p className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100">
                      {r.guest_name || '\u2014'}
                    </p>
                    {r.guest_phone && (
                      <p className="text-sm text-gray-500 dark:text-gray-400">{r.guest_phone}</p>
                    )}
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Details</h3>
                    <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
                      {r.property?.name && (
                        <div className="col-span-2">
                          <span className="text-gray-400 dark:text-gray-500">Property</span>
                          <p className="font-medium text-gray-900 dark:text-gray-100">{r.property.name}</p>
                        </div>
                      )}
                      <div>
                        <span className="text-gray-400 dark:text-gray-500">Check-in</span>
                        <p className="font-medium text-gray-900 dark:text-gray-100">
                          {new Date(r.check_in + 'T00:00').toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), {
                            weekday: 'short', day: 'numeric', month: 'short',
                          })}
                        </p>
                      </div>
                      <div>
                        <span className="text-gray-400 dark:text-gray-500">Check-out</span>
                        <p className="font-medium text-gray-900 dark:text-gray-100">
                          {new Date(r.check_out + 'T00:00').toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), {
                            weekday: 'short', day: 'numeric', month: 'short',
                          })}
                        </p>
                      </div>
                      <div>
                        <span className="text-gray-400 dark:text-gray-500">Guests</span>
                        <p className="font-medium text-gray-900 dark:text-gray-100">{r.guests}</p>
                      </div>
                      <div>
                        <span className="text-gray-400 dark:text-gray-500">Amount</span>
                        <p className="font-medium text-gray-900 dark:text-gray-100">
                          {formatCurrency(r.total_amount, (business.country_code || 'NG') as CountryCode)}
                        </p>
                      </div>
                      {r.deposit_amount > 0 && (
                        <div>
                          <span className="text-gray-400 dark:text-gray-500">Deposit</span>
                          <p className="font-medium text-gray-900 dark:text-gray-100">
                            {formatCurrency(r.deposit_amount, (business.country_code || 'NG') as CountryCode)}
                            <span className="ml-1 text-xs text-gray-400 capitalize dark:text-gray-500">({r.deposit_status})</span>
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                  {r.special_requests && (
                    <div className="rounded-lg bg-indigo-50 p-3">
                      <h3 className="text-sm font-medium text-indigo-800">Special Requests</h3>
                      <p className="mt-1 text-sm text-indigo-700">{r.special_requests}</p>
                    </div>
                  )}
                  <p className="text-xs text-gray-400 dark:text-gray-500">Manage reservation status on the Reservations page.</p>
                </>
              );
            })()}

            {/* === EVENT DETAIL === */}
            {entryType === 'event' && (() => {
              const ev = d as unknown as EventItem;
              return (
                <>
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Details</h3>
                    <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <span className="text-gray-400 dark:text-gray-500">Date</span>
                        <p className="font-medium text-gray-900 dark:text-gray-100">
                          {new Date(ev.date + 'T00:00').toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), {
                            weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
                          })}
                        </p>
                      </div>
                      {ev.time && (
                        <div>
                          <span className="text-gray-400 dark:text-gray-500">Time</span>
                          <p className="font-medium text-gray-900 dark:text-gray-100">{formatTime(ev.time)}</p>
                        </div>
                      )}
                      {ev.venue && (
                        <div className="col-span-2">
                          <span className="text-gray-400 dark:text-gray-500">Venue</span>
                          <p className="font-medium text-gray-900 dark:text-gray-100">{ev.venue}</p>
                        </div>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-gray-400 dark:text-gray-500">Manage event details on the Events page.</p>
                </>
              );
            })()}

            {/* === BLOCKED DATE DETAIL === */}
            {entryType === 'blocked' && (() => {
              const bd = d as unknown as BlockedDate;
              return (
                <>
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Details</h3>
                    <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
                      {bd.property?.name && (
                        <div className="col-span-2">
                          <span className="text-gray-400 dark:text-gray-500">Property</span>
                          <p className="font-medium text-gray-900 dark:text-gray-100">{bd.property.name}</p>
                        </div>
                      )}
                      <div>
                        <span className="text-gray-400 dark:text-gray-500">From</span>
                        <p className="font-medium text-gray-900 dark:text-gray-100">
                          {new Date(bd.date_from + 'T00:00').toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), {
                            weekday: 'short', day: 'numeric', month: 'short',
                          })}
                        </p>
                      </div>
                      <div>
                        <span className="text-gray-400 dark:text-gray-500">To</span>
                        <p className="font-medium text-gray-900 dark:text-gray-100">
                          {new Date(bd.date_to + 'T00:00').toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), {
                            weekday: 'short', day: 'numeric', month: 'short',
                          })}
                        </p>
                      </div>
                      {bd.reason && (
                        <div className="col-span-2">
                          <span className="text-gray-400 dark:text-gray-500">Reason</span>
                          <p className="font-medium text-gray-900 dark:text-gray-100">{bd.reason}</p>
                        </div>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-gray-400 dark:text-gray-500">Manage blocked dates on the Properties page.</p>
                </>
              );
            })()}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-400">
          Something went wrong loading data. <button onClick={() => { setError(false); fetchData(); }} className="font-medium underline">Try again</button>
        </div>
      )}
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Calendar</h1>
          <PageHelp
            pageKey="calendar"
            title="Booking Calendar"
            description="Visual calendar view of all your bookings. Switch between month, week, and day views. Click on a booking to see details or reschedule."
          />
        </div>
        <div className="flex gap-1 rounded-lg border border-gray-200 bg-white p-1 dark:border-gray-700 dark:bg-gray-800">
          {(['month', 'week', 'day'] as ViewMode[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition ${
                view === v ? 'bg-brand text-white' : 'text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-700/50'
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {/* Filter + Legend row */}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        {/* Filter tabs */}
        {filterOptions.length > 2 && (
          <div className="flex gap-1 rounded-lg border border-gray-200 bg-white p-1 dark:border-gray-700 dark:bg-gray-800">
            {filterOptions.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                  filter === f.key ? 'bg-gray-800 text-white dark:bg-gray-600' : 'text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-700/50'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}

        {/* Staff filter */}
        {staffList.length > 0 && (
          <select
            value={staffFilter}
            onChange={e => setStaffFilter(e.target.value)}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
          >
            <option value="all">All Staff</option>
            {staffList.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        )}

        {/* Legend */}
        {legendItems.length > 1 && (
          <div className="flex items-center gap-3">
            {legendItems.map((item) => (
              <div key={item.label} className="flex items-center gap-1">
                <span className={`inline-block h-2.5 w-2.5 rounded-full ${item.dotColor}`} />
                <span className="text-xs text-gray-500 dark:text-gray-400">{item.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Navigation */}
      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700/50"
        >
          <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <button
          onClick={goToToday}
          className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700/50"
        >
          Today
        </button>
        <button
          onClick={() => navigate(1)}
          className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700/50"
        >
          <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200">{periodLabel}</h2>
      </div>

      {/* Monthly Stats */}
      {view === 'month' && !loading && (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5">
            <p className="text-[10px] font-medium uppercase text-gray-400 dark:text-gray-500">Total Bookings</p>
            <p className="text-lg font-bold text-gray-900 dark:text-gray-100">{monthlyStats.total}</p>
          </div>
          <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 px-3 py-2.5">
            <p className="text-[10px] font-medium uppercase text-green-600 dark:text-green-400">Confirmed</p>
            <p className="text-lg font-bold text-green-700 dark:text-green-300">{monthlyStats.confirmed}</p>
          </div>
          <div className="rounded-lg border border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-900/20 px-3 py-2.5">
            <p className="text-[10px] font-medium uppercase text-yellow-600 dark:text-yellow-400">Pending</p>
            <p className="text-lg font-bold text-yellow-700 dark:text-yellow-300">{monthlyStats.pending}</p>
          </div>
          <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5">
            <p className="text-[10px] font-medium uppercase text-red-600 dark:text-red-400">Cancelled</p>
            <p className="text-lg font-bold text-red-700 dark:text-red-300">{monthlyStats.cancelled}</p>
          </div>
          {monthlyStats.noShow > 0 && (
            <div className="rounded-lg border border-orange-200 dark:border-orange-800 bg-orange-50 dark:bg-orange-900/20 px-3 py-2.5">
              <p className="text-[10px] font-medium uppercase text-orange-600 dark:text-orange-400">No Shows</p>
              <p className="text-lg font-bold text-orange-700 dark:text-orange-300">{monthlyStats.noShow}</p>
            </div>
          )}
          {monthlyStats.revenue > 0 && (
            <div className="rounded-lg border border-brand/20 dark:border-brand/30 bg-brand/5 dark:bg-brand/10 px-3 py-2.5">
              <p className="text-[10px] font-medium uppercase text-brand dark:text-brand/80">Revenue</p>
              <p className="text-lg font-bold text-brand">{formatCurrency(monthlyStats.revenue, (business.country_code || 'NG') as CountryCode)}</p>
            </div>
          )}
        </div>
      )}

      {/* Loading */}
      {loading ? (
        <div className="mt-8 flex justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
        </div>
      ) : (
        <>
          {/* Month View */}
          {view === 'month' && (
            <div className="mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
              <div className="grid grid-cols-7 border-b border-gray-100 bg-gray-50/50 dark:border-gray-700 dark:bg-gray-800/30">
                {DAY_NAMES.map((d) => (
                  <div key={d} className="px-2 py-2 text-center text-xs font-medium text-gray-500 dark:text-gray-400">
                    {d}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7">
                {monthGrid.map((date) => {
                  const key = formatDateKey(date);
                  const dayEntries = entriesByDate[key] || [];
                  const isToday = key === today;
                  const isOtherMonth = date.getMonth() !== currentMonth;
                  const maxPills = 3;
                  const visible = dayEntries.slice(0, maxPills);
                  const extra = dayEntries.length - maxPills;

                  return (
                    <div
                      key={key}
                      className={`min-h-[100px] border-b border-r border-gray-100 p-1.5 dark:border-gray-700 ${
                        isOtherMonth ? 'bg-gray-50/40 dark:bg-gray-800/30' : ''
                      }`}
                    >
                      <div className="mb-1 flex items-center justify-between">
                        <span
                          className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                            isToday
                              ? 'bg-brand text-white'
                              : isOtherMonth
                              ? 'text-gray-300 dark:text-gray-600'
                              : 'text-gray-700 dark:text-gray-300'
                          }`}
                        >
                          {date.getDate()}
                        </span>
                        {dayEntries.length > 0 && (
                          <span className="text-[10px] text-gray-400 dark:text-gray-500">{dayEntries.length}</span>
                        )}
                      </div>
                      <div className="flex flex-col gap-0.5">
                        {visible.map((entry) => renderEntryPill(entry))}
                        {extra > 0 && (
                          <span className="px-1 text-[10px] text-gray-400 dark:text-gray-500">+{extra} more</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Week View */}
          {view === 'week' && (
            <div className="mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
              {/* All-day / multi-day entries row */}
              {(() => {
                const allDayEntries = weekDays.map((d) => {
                  const key = formatDateKey(d);
                  return (entriesByDate[key] || []).filter((e) => !e.time);
                });
                const hasAllDay = allDayEntries.some((arr) => arr.length > 0);
                if (!hasAllDay) return null;
                return (
                  <div className="grid grid-cols-[60px_repeat(7,1fr)] border-b border-gray-200 bg-gray-50/30 dark:border-gray-700 dark:bg-gray-800/30">
                    <div className="flex items-start justify-end border-r border-gray-100 px-2 py-1 dark:border-gray-700">
                      <span className="text-[10px] text-gray-400 dark:text-gray-500">All day</span>
                    </div>
                    {weekDays.map((d, i) => {
                      const entries = allDayEntries[i];
                      return (
                        <div key={formatDateKey(d)} className="min-h-[32px] border-r border-gray-50 p-0.5 last:border-r-0 dark:border-gray-700">
                          {entries.map((entry) => renderEntryPill(entry, true))}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
              {/* Header row with day names */}
              <div className="grid grid-cols-[60px_repeat(7,1fr)] border-b border-gray-100 bg-gray-50/50 dark:border-gray-700 dark:bg-gray-800/30">
                <div className="border-r border-gray-100 px-2 py-2 dark:border-gray-700" />
                {weekDays.map((d) => {
                  const key = formatDateKey(d);
                  const isToday = key === today;
                  return (
                    <div key={key} className="border-r border-gray-100 px-2 py-2 text-center last:border-r-0 dark:border-gray-700">
                      <span className="text-xs text-gray-500 dark:text-gray-400">{DAY_NAMES[d.getDay()]}</span>
                      <div
                        className={`mx-auto mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                          isToday ? 'bg-brand text-white' : 'text-gray-700 dark:text-gray-300'
                        }`}
                      >
                        {d.getDate()}
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* Time slots */}
              <div className="max-h-[600px] overflow-y-auto">
                {HOURS.map((hour) => (
                  <div key={hour} className="grid grid-cols-[60px_repeat(7,1fr)] border-b border-gray-50 last:border-b-0 dark:border-gray-700">
                    <div className="flex items-start justify-end border-r border-gray-100 px-2 py-1 dark:border-gray-700">
                      <span className="text-[10px] text-gray-400 dark:text-gray-500">
                        {hour % 12 || 12}{hour >= 12 ? 'PM' : 'AM'}
                      </span>
                    </div>
                    {weekDays.map((d) => {
                      const key = formatDateKey(d);
                      const dayEntries = entriesByDate[key] || [];
                      const hourEntries = dayEntries.filter((e) => {
                        if (!e.time) return false;
                        const eHour = parseInt(e.time.slice(0, 2), 10);
                        return eHour === hour;
                      });
                      return (
                        <div key={`${key}-${hour}`} className="min-h-[48px] border-r border-gray-50 p-0.5 last:border-r-0 dark:border-gray-700">
                          {hourEntries.map((entry) => renderEntryPill(entry))}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Day View */}
          {view === 'day' && (
            <div className="mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
              {/* All-day entries */}
              {(() => {
                const key = formatDateKey(currentDate);
                const allDayEntries = (entriesByDate[key] || []).filter((e) => !e.time);
                if (allDayEntries.length === 0) return null;
                return (
                  <div className="border-b border-gray-200 bg-gray-50/30 p-3 dark:border-gray-700 dark:bg-gray-800/30">
                    <p className="mb-1 text-xs font-medium text-gray-400 dark:text-gray-500">All Day</p>
                    <div className="flex flex-col gap-1">
                      {allDayEntries.map((entry) => (
                        <button
                          key={entry.id}
                          onClick={() => setSelectedEntry(entry)}
                          className={`w-full rounded-lg border p-3 text-left ${entry.color}`}
                        >
                          <div className="flex items-center gap-2">
                            <span className={`inline-block h-2 w-2 rounded-full ${entryTypeDotColors[entry.type]}`} />
                            <span className="text-sm font-semibold">{entry.title}</span>
                            <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ${
                              entry.type === 'booking'
                                ? (statusBadge[entry.status] || 'bg-gray-100 text-gray-600')
                                : entry.type === 'reservation'
                                ? 'bg-indigo-100 text-indigo-700'
                                : entry.type === 'event'
                                ? 'bg-rose-100 text-rose-700'
                                : 'bg-gray-200 text-gray-600'
                            }`}>
                              {entry.status.replace('_', ' ')}
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })()}
              <div className="max-h-[700px] overflow-y-auto">
                {HOURS.map((hour) => {
                  const key = formatDateKey(currentDate);
                  const dayEntries = entriesByDate[key] || [];
                  const hourEntries = dayEntries.filter((e) => {
                    if (!e.time) return false;
                    const eHour = parseInt(e.time.slice(0, 2), 10);
                    return eHour === hour;
                  });
                  return (
                    <div
                      key={hour}
                      className="grid grid-cols-[72px_1fr] border-b border-gray-50 last:border-b-0 dark:border-gray-700"
                    >
                      <div className="flex items-start justify-end border-r border-gray-100 px-3 py-2 dark:border-gray-700">
                        <span className="text-xs text-gray-400 dark:text-gray-500">
                          {hour % 12 || 12}:00 {hour >= 12 ? 'PM' : 'AM'}
                        </span>
                      </div>
                      <div className="min-h-[56px] p-2">
                        {hourEntries.length === 0 ? (
                          <div className="h-full" />
                        ) : (
                          <div className="flex flex-col gap-2">
                            {hourEntries.map((entry) => (
                              <button
                                key={entry.id}
                                onClick={() => setSelectedEntry(entry)}
                                className={`w-full rounded-lg border p-3 text-left ${entry.color}`}
                              >
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2">
                                    <span className={`inline-block h-2 w-2 rounded-full ${entryTypeDotColors[entry.type]}`} />
                                    <span className="text-sm font-semibold">{entry.title}</span>
                                  </div>
                                  <span
                                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ${
                                      entry.type === 'booking'
                                        ? (statusBadge[entry.status] || 'bg-gray-100 text-gray-600')
                                        : entry.type === 'reservation'
                                        ? 'bg-indigo-100 text-indigo-700'
                                        : entry.type === 'event'
                                        ? 'bg-rose-100 text-rose-700'
                                        : 'bg-gray-200 text-gray-600'
                                    }`}
                                  >
                                    {entry.status.replace('_', ' ')}
                                  </span>
                                </div>
                                <div className="mt-1 flex items-center gap-3 text-xs">
                                  {entry.time && <span>{formatTime(entry.time)}</span>}
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Empty state */}
          {filteredEntries.length === 0 && (
            <div className="mt-4 rounded-xl border border-dashed border-gray-200 p-12 text-center dark:border-gray-700">
              <p className="text-sm text-gray-400 dark:text-gray-500">
                {filter === 'all' ? 'No entries for this period' : `No ${filter}s for this period`}
              </p>
            </div>
          )}
        </>
      )}

      {/* Detail Modal */}
      {renderDetailModal()}

      {/* Action Input Modal (check-in notes, no-show reason) */}
      {actionModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={() => setActionModal(null)}>
          <div className="fixed inset-0 bg-black/40" />
          <div className="relative z-10 w-full max-w-sm rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">{actionModal.label}</h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {actionModal.inputType === 'reason' ? 'Why did the customer miss their appointment?' : 'Any notes for this visit? (optional)'}
            </p>
            <textarea
              value={actionInput}
              onChange={e => setActionInput(e.target.value)}
              rows={3}
              placeholder={actionModal.inputType === 'reason' ? 'e.g. No answer, cancelled last minute...' : 'e.g. Arrived 5 min early, brought a friend...'}
              className="mt-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              autoFocus
            />
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setActionModal(null)}
                className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700/50"
              >
                Cancel
              </button>
              <button
                onClick={() => updateStatus(actionModal.bookingId, actionModal.action, actionInput)}
                disabled={actionLoading || (actionModal.inputType === 'reason' && !actionInput.trim())}
                className="flex-1 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              >
                {actionLoading ? 'Processing...' : actionModal.label}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
