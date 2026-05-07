'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { getLocale, type CountryCode } from '@/lib/constants';

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
}

type ViewMode = 'month' | 'week' | 'day';

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

const nextActions: Record<string, { label: string; next: string; color: string }[]> = {
  pending: [
    { label: 'Confirm', next: 'confirmed', color: 'text-green-600 hover:bg-green-50' },
    { label: 'Cancel', next: 'cancelled', color: 'text-red-600 hover:bg-red-50' },
  ],
  confirmed: [
    { label: 'Start', next: 'in_progress', color: 'text-blue-600 hover:bg-blue-50' },
    { label: 'No Show', next: 'no_show', color: 'text-orange-600 hover:bg-orange-50' },
    { label: 'Cancel', next: 'cancelled', color: 'text-red-600 hover:bg-red-50' },
  ],
  in_progress: [
    { label: 'Complete', next: 'completed', color: 'text-gray-600 hover:bg-gray-50' },
  ],
};

const HOUR_START = 8;
const HOUR_END = 20;
const HOURS = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i);
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

export default function CalendarPage() {
  const business = useBusiness();
  const [view, setView] = useState<ViewMode>('month');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);

  // Compute date range based on view
  const dateRange = useMemo(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();

    if (view === 'month') {
      const first = new Date(year, month, 1);
      const last = new Date(year, month + 1, 0);
      // Extend to full weeks
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

    // day
    return { start: new Date(currentDate), end: new Date(currentDate) };
  }, [view, currentDate]);

  const fetchBookings = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    const startStr = formatDateKey(dateRange.start);
    const endStr = formatDateKey(dateRange.end);

    const { data } = await supabase
      .from('bookings')
      .select('id, reference_code, date, time, party_size, status, flow_type, guest_name, guest_phone, guest_email, special_requests, staff_id, staff_name, deposit_amount, deposit_status, total_amount, channel, notes, payment_id')
      .eq('business_id', business.id)
      .neq('flow_type', 'payment')
      .gte('date', startStr)
      .lte('date', endStr)
      .order('time', { ascending: true });

    setBookings((data || []) as Booking[]);
    setLoading(false);
  }, [business.id, dateRange.start, dateRange.end]);

  useEffect(() => {
    fetchBookings();

    const supabase = createClient();
    const channel = supabase
      .channel('calendar-bookings')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'bookings', filter: `business_id=eq.${business.id}` },
        () => fetchBookings(),
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [fetchBookings, business.id]);

  // Group bookings by date
  const bookingsByDate = useMemo(() => {
    const map: Record<string, Booking[]> = {};
    for (const b of bookings) {
      if (!map[b.date]) map[b.date] = [];
      map[b.date].push(b);
    }
    return map;
  }, [bookings]);

  async function updateStatus(id: string, newStatus: string) {
    const supabase = createClient();
    const extra: Record<string, unknown> = {};
    if (newStatus === 'confirmed') extra.confirmed_at = new Date().toISOString();
    if (newStatus === 'in_progress') extra.seated_at = new Date().toISOString();
    if (newStatus === 'completed') extra.completed_at = new Date().toISOString();
    if (newStatus === 'cancelled') {
      extra.cancelled_at = new Date().toISOString();
      extra.cancelled_by = 'business';
    }

    await supabase.from('bookings').update({ status: newStatus, ...extra }).eq('id', id);

    // Release slot + notify customer on cancel/no_show (same as reservations page)
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
      }
    }

    setSelectedBooking(null);
    fetchBookings();
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

  // Period label
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

  // Build month grid
  const monthGrid = useMemo(() => {
    if (view !== 'month') return [];
    const cells: Date[] = [];
    const d = new Date(dateRange.start);
    while (d <= dateRange.end) {
      cells.push(new Date(d));
      d.setDate(d.getDate() + 1);
    }
    return cells;
  }, [view, dateRange]);

  // Build week days
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

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Calendar</h1>
        <div className="flex gap-1 rounded-lg border border-gray-200 bg-white p-1">
          {(['month', 'week', 'day'] as ViewMode[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition ${
                view === v ? 'bg-brand text-white' : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {/* Navigation */}
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <button
          onClick={goToToday}
          className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
        >
          Today
        </button>
        <button
          onClick={() => navigate(1)}
          className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <h2 className="text-lg font-semibold text-gray-800">{periodLabel}</h2>
      </div>

      {/* Loading */}
      {loading ? (
        <div className="mt-8 flex justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
        </div>
      ) : (
        <>
          {/* Month View */}
          {view === 'month' && (
            <div className="mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white">
              {/* Day names header */}
              <div className="grid grid-cols-7 border-b border-gray-100 bg-gray-50/50">
                {DAY_NAMES.map((d) => (
                  <div key={d} className="px-2 py-2 text-center text-xs font-medium text-gray-500">
                    {d}
                  </div>
                ))}
              </div>
              {/* Day cells */}
              <div className="grid grid-cols-7">
                {monthGrid.map((date) => {
                  const key = formatDateKey(date);
                  const dayBookings = bookingsByDate[key] || [];
                  const isToday = key === today;
                  const isOtherMonth = date.getMonth() !== currentMonth;
                  const maxPills = 3;
                  const visible = dayBookings.slice(0, maxPills);
                  const extra = dayBookings.length - maxPills;

                  return (
                    <div
                      key={key}
                      className={`min-h-[100px] border-b border-r border-gray-100 p-1.5 ${
                        isOtherMonth ? 'bg-gray-50/40' : ''
                      }`}
                    >
                      <div className="mb-1 flex items-center justify-between">
                        <span
                          className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                            isToday
                              ? 'bg-brand text-white'
                              : isOtherMonth
                              ? 'text-gray-300'
                              : 'text-gray-700'
                          }`}
                        >
                          {date.getDate()}
                        </span>
                        {dayBookings.length > 0 && (
                          <span className="text-[10px] text-gray-400">{dayBookings.length}</span>
                        )}
                      </div>
                      <div className="flex flex-col gap-0.5">
                        {visible.map((b) => (
                          <button
                            key={b.id}
                            onClick={() => setSelectedBooking(b)}
                            className={`w-full truncate rounded border px-1 py-0.5 text-left text-[10px] leading-tight ${
                              statusColors[b.status] || 'bg-gray-100 border-gray-300 text-gray-700'
                            }`}
                          >
                            <span className="font-medium">{b.time?.slice(0, 5)}</span>{' '}
                            {b.guest_name || '\u2014'}{b.staff_name ? ` · ${b.staff_name}` : ''}
                          </button>
                        ))}
                        {extra > 0 && (
                          <span className="px-1 text-[10px] text-gray-400">+{extra} more</span>
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
            <div className="mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white">
              {/* Header row with day names */}
              <div className="grid grid-cols-[60px_repeat(7,1fr)] border-b border-gray-100 bg-gray-50/50">
                <div className="border-r border-gray-100 px-2 py-2" />
                {weekDays.map((d) => {
                  const key = formatDateKey(d);
                  const isToday = key === today;
                  return (
                    <div key={key} className="border-r border-gray-100 px-2 py-2 text-center last:border-r-0">
                      <span className="text-xs text-gray-500">{DAY_NAMES[d.getDay()]}</span>
                      <div
                        className={`mx-auto mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                          isToday ? 'bg-brand text-white' : 'text-gray-700'
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
                  <div key={hour} className="grid grid-cols-[60px_repeat(7,1fr)] border-b border-gray-50 last:border-b-0">
                    <div className="flex items-start justify-end border-r border-gray-100 px-2 py-1">
                      <span className="text-[10px] text-gray-400">
                        {hour % 12 || 12}{hour >= 12 ? 'PM' : 'AM'}
                      </span>
                    </div>
                    {weekDays.map((d) => {
                      const key = formatDateKey(d);
                      const dayBookings = bookingsByDate[key] || [];
                      const hourBookings = dayBookings.filter((b) => {
                        if (!b.time) return false;
                        const bHour = parseInt(b.time.slice(0, 2), 10);
                        return bHour === hour;
                      });
                      return (
                        <div key={`${key}-${hour}`} className="min-h-[48px] border-r border-gray-50 p-0.5 last:border-r-0">
                          {hourBookings.map((b) => (
                            <button
                              key={b.id}
                              onClick={() => setSelectedBooking(b)}
                              className={`mb-0.5 w-full truncate rounded border px-1 py-0.5 text-left text-[10px] leading-tight ${
                                statusColors[b.status] || 'bg-gray-100 border-gray-300 text-gray-700'
                              }`}
                            >
                              <span className="font-medium">{b.time?.slice(0, 5)}</span>{' '}
                              {b.guest_name || '\u2014'}{b.staff_name ? ` · ${b.staff_name}` : ''}
                            </button>
                          ))}
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
            <div className="mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white">
              <div className="max-h-[700px] overflow-y-auto">
                {HOURS.map((hour) => {
                  const key = formatDateKey(currentDate);
                  const dayBookings = bookingsByDate[key] || [];
                  const hourBookings = dayBookings.filter((b) => {
                    if (!b.time) return false;
                    const bHour = parseInt(b.time.slice(0, 2), 10);
                    return bHour === hour;
                  });
                  return (
                    <div
                      key={hour}
                      className="grid grid-cols-[72px_1fr] border-b border-gray-50 last:border-b-0"
                    >
                      <div className="flex items-start justify-end border-r border-gray-100 px-3 py-2">
                        <span className="text-xs text-gray-400">
                          {hour % 12 || 12}:00 {hour >= 12 ? 'PM' : 'AM'}
                        </span>
                      </div>
                      <div className="min-h-[56px] p-2">
                        {hourBookings.length === 0 ? (
                          <div className="h-full" />
                        ) : (
                          <div className="flex flex-col gap-2">
                            {hourBookings.map((b) => (
                              <button
                                key={b.id}
                                onClick={() => setSelectedBooking(b)}
                                className={`w-full rounded-lg border p-3 text-left ${
                                  statusColors[b.status] || 'bg-gray-100 border-gray-300 text-gray-700'
                                }`}
                              >
                                <div className="flex items-center justify-between">
                                  <span className="text-sm font-semibold">
                                    {b.guest_name || '\u2014'}
                                  </span>
                                  <span
                                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                                      statusBadge[b.status] || 'bg-gray-100 text-gray-600'
                                    }`}
                                  >
                                    {b.status.replace('_', ' ')}
                                  </span>
                                </div>
                                <div className="mt-1 flex items-center gap-3 text-xs">
                                  <span>{b.time ? formatTime(b.time) : '\u2014'}</span>
                                  {b.staff_name && (
                                    <span className="text-gray-500">
                                      Staff: {b.staff_name}
                                    </span>
                                  )}
                                  <span className="text-gray-500">
                                    Party: {b.party_size}
                                  </span>
                                </div>
                                {b.special_requests && (
                                  <p className="mt-1 truncate text-[11px] text-gray-500">
                                    {b.special_requests}
                                  </p>
                                )}
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

          {/* Empty state for day/week when no bookings */}
          {(view === 'day' || view === 'week') && bookings.length === 0 && (
            <div className="mt-4 rounded-xl border border-dashed border-gray-200 p-12 text-center">
              <p className="text-sm text-gray-400">No bookings for this period</p>
            </div>
          )}
        </>
      )}

      {/* Detail Modal */}
      {selectedBooking && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setSelectedBooking(null)}>
          <div className="fixed inset-0 bg-black/30" />
          <div
            className="relative z-10 w-full max-w-md rounded-xl bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
              <div>
                <p className="font-mono text-lg font-bold text-brand">
                  {selectedBooking.reference_code}
                </p>
                <span
                  className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                    statusBadge[selectedBooking.status] || 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {selectedBooking.status.replace('_', ' ')}
                </span>
              </div>
              <button
                onClick={() => setSelectedBooking(null)}
                className="rounded-lg p-2 text-gray-400 hover:bg-gray-100"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Modal body */}
            <div className="space-y-5 px-6 py-5">
              {/* Guest info */}
              <div>
                <h3 className="text-sm font-medium text-gray-500">Guest</h3>
                <p className="mt-1 text-sm font-medium text-gray-900">
                  {selectedBooking.guest_name || '\u2014'}
                </p>
                {selectedBooking.guest_phone && (
                  <p className="text-sm text-gray-500">{selectedBooking.guest_phone}</p>
                )}
              </div>

              {/* Details grid */}
              <div>
                <h3 className="text-sm font-medium text-gray-500">Details</h3>
                <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-gray-400">Date</span>
                    <p className="font-medium text-gray-900">
                      {new Date(selectedBooking.date + 'T00:00').toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), {
                        weekday: 'short',
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </p>
                  </div>
                  <div>
                    <span className="text-gray-400">Time</span>
                    <p className="font-medium text-gray-900">
                      {selectedBooking.time ? formatTime(selectedBooking.time) : '\u2014'}
                    </p>
                  </div>
                  <div>
                    <span className="text-gray-400">Party Size</span>
                    <p className="font-medium text-gray-900">{selectedBooking.party_size}</p>
                  </div>
                  {selectedBooking.staff_name && (
                    <div>
                      <span className="text-gray-400">Staff</span>
                      <p className="font-medium text-gray-900">{selectedBooking.staff_name}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Special requests */}
              {selectedBooking.special_requests && (
                <div className="rounded-lg bg-yellow-50 p-3">
                  <h3 className="text-sm font-medium text-yellow-800">Special Requests</h3>
                  <p className="mt-1 text-sm text-yellow-700">{selectedBooking.special_requests}</p>
                </div>
              )}

              {/* Actions */}
              {nextActions[selectedBooking.status] &&
                nextActions[selectedBooking.status].length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium text-gray-500">Actions</h3>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {nextActions[selectedBooking.status].map((action) => (
                        <button
                          key={action.next}
                          onClick={() => updateStatus(selectedBooking.id, action.next)}
                          className={`rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium ${action.color}`}
                        >
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
