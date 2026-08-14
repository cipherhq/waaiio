'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import EmptyState from '@/components/dashboard/EmptyState';
import { PageHelp } from '@/components/dashboard/PageHelp';

// ── Types ──

interface ClassService {
  id: string;
  name: string;
  description: string | null;
  price: number;
  duration_minutes: number | null;
  max_capacity: number | null;
  is_active: boolean;
  class_schedule: Array<{ day: string; time: string }>;
  image_url: string | null;
}

interface ClassBooking {
  id: string;
  service_id: string;
  date: string;
  time: string;
  guest_name: string | null;
  guest_phone: string | null;
  status: string;
  party_size: number;
  created_at: string;
}

/** A "session" is a distinct (service, date, time) combination derived from bookings */
interface ClassSession {
  serviceId: string;
  serviceName: string;
  date: string;
  time: string;
  capacity: number;
  booked: number;
  bookings: ClassBooking[];
}

type Tab = 'classes' | 'sessions';

const WEEKDAYS = [
  { key: 'monday', short: 'Mon' },
  { key: 'tuesday', short: 'Tue' },
  { key: 'wednesday', short: 'Wed' },
  { key: 'thursday', short: 'Thu' },
  { key: 'friday', short: 'Fri' },
  { key: 'saturday', short: 'Sat' },
  { key: 'sunday', short: 'Sun' },
];

// ── Helpers ──

function formatScheduleSummary(schedule: Array<{ day: string; time: string }>): string {
  if (!schedule || schedule.length === 0) return 'No schedule set';
  return schedule
    .map(s => {
      const dayLabel = WEEKDAYS.find(d => d.key === s.day)?.short || s.day;
      return `${dayLabel} ${s.time}`;
    })
    .join(', ');
}

function formatTime12h(time: string): string {
  if (!time) return '';
  const [h, m] = time.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

function formatDateReadable(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function getCapacityColor(booked: number, capacity: number): string {
  if (capacity <= 0) return 'text-gray-500';
  const ratio = booked / capacity;
  if (ratio >= 1) return 'text-red-600 dark:text-red-400';
  if (ratio >= 0.75) return 'text-amber-600 dark:text-amber-400';
  return 'text-green-600 dark:text-green-400';
}

function getCapacityBadge(booked: number, capacity: number): { label: string; className: string } {
  if (capacity <= 0) return { label: 'No limit', className: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300' };
  const ratio = booked / capacity;
  if (ratio >= 1) return { label: 'Full', className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' };
  if (ratio >= 0.75) return { label: 'Almost full', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' };
  return { label: 'Available', className: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' };
}

// ── Main Page ──

export default function ClassesPage() {
  const business = useBusiness();
  const country = (business.country_code || 'NG') as CountryCode;

  const [tab, setTab] = useState<Tab>('classes');
  const [classes, setClasses] = useState<ClassService[]>([]);
  const [sessions, setSessions] = useState<ClassSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  // Create class dialog
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [saving, setSaving] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: '',
    description: '',
    price: 0,
    duration_minutes: 60,
    max_capacity: 10,
    class_schedule: [{ day: 'monday', time: '09:00' }] as Array<{ day: string; time: string }>,
  });

  // Session detail dialog
  const [selectedSession, setSelectedSession] = useState<ClassSession | null>(null);
  const [showSessionDetail, setShowSessionDetail] = useState(false);

  // Cancel confirmation
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Filter sessions by class
  const [filterClassId, setFilterClassId] = useState<string | null>(null);

  // ── Data fetching ──

  const loadClasses = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('services')
      .select('id, name, description, price, duration_minutes, max_capacity, is_active, class_schedule, image_url')
      .eq('business_id', business.id)
      .eq('is_class', true)
      .is('deleted_at', null)
      .order('name');
    setClasses((data as ClassService[]) || []);
    setLoading(false);
  }, [business.id]);

  const loadSessions = useCallback(async (classIdFilter?: string | null) => {
    setSessionsLoading(true);
    const supabase = createClient();
    const today = new Date().toISOString().split('T')[0];

    // Fetch upcoming bookings for class services
    let query = supabase
      .from('bookings')
      .select('id, service_id, date, time, guest_name, guest_phone, status, party_size, created_at')
      .eq('business_id', business.id)
      .gte('date', today)
      .in('status', ['confirmed', 'pending', 'in_progress'])
      .order('date', { ascending: true })
      .order('time', { ascending: true });

    // Filter by class service IDs
    const classServiceIds = classIdFilter
      ? [classIdFilter]
      : classes.map(c => c.id);

    if (classServiceIds.length === 0) {
      setSessions([]);
      setSessionsLoading(false);
      return;
    }

    query = query.in('service_id', classServiceIds);
    const { data } = await query;
    const bookings = (data as ClassBooking[]) || [];

    // Group bookings by (service_id, date, time) to form sessions
    const sessionMap = new Map<string, ClassSession>();
    for (const b of bookings) {
      const key = `${b.service_id}|${b.date}|${b.time}`;
      if (!sessionMap.has(key)) {
        const cls = classes.find(c => c.id === b.service_id);
        sessionMap.set(key, {
          serviceId: b.service_id,
          serviceName: cls?.name || 'Unknown',
          date: b.date,
          time: b.time,
          capacity: cls?.max_capacity || 0,
          booked: 0,
          bookings: [],
        });
      }
      const session = sessionMap.get(key)!;
      session.booked += b.party_size || 1;
      session.bookings.push(b);
    }

    // Also add scheduled sessions that have no bookings yet
    // Generate upcoming sessions for the next 4 weeks from class schedules
    const classesToShow = classIdFilter
      ? classes.filter(c => c.id === classIdFilter)
      : classes;

    for (const cls of classesToShow) {
      if (!cls.is_active || !cls.class_schedule || cls.class_schedule.length === 0) continue;

      const dayMap: Record<string, number> = {
        sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
        thursday: 4, friday: 5, saturday: 6,
      };

      const now = new Date();
      for (let weekOffset = 0; weekOffset < 4; weekOffset++) {
        for (const sched of cls.class_schedule) {
          const targetDay = dayMap[sched.day];
          if (targetDay === undefined) continue;

          const d = new Date(now);
          d.setDate(d.getDate() + weekOffset * 7);
          // Move to the target day within this week
          const currentDay = d.getDay();
          let diff = targetDay - currentDay;
          if (weekOffset === 0 && diff < 0) continue; // skip past days in current week
          d.setDate(d.getDate() + diff);

          const dateStr = d.toISOString().split('T')[0];
          if (dateStr < today) continue;

          const key = `${cls.id}|${dateStr}|${sched.time}:00`;
          if (!sessionMap.has(key)) {
            // Also try without seconds
            const keyNoSec = `${cls.id}|${dateStr}|${sched.time}`;
            if (!sessionMap.has(keyNoSec)) {
              sessionMap.set(key, {
                serviceId: cls.id,
                serviceName: cls.name,
                date: dateStr,
                time: sched.time,
                capacity: cls.max_capacity || 0,
                booked: 0,
                bookings: [],
              });
            }
          }
        }
      }
    }

    // Sort by date then time
    const sorted = Array.from(sessionMap.values()).sort((a, b) => {
      const dateCompare = a.date.localeCompare(b.date);
      if (dateCompare !== 0) return dateCompare;
      return a.time.localeCompare(b.time);
    });

    setSessions(sorted);
    setSessionsLoading(false);
  }, [business.id, classes]);

  useEffect(() => {
    loadClasses();
  }, [loadClasses]);

  useEffect(() => {
    if (tab === 'sessions' && classes.length > 0) {
      loadSessions(filterClassId);
    }
  }, [tab, classes, filterClassId, loadSessions]);

  // ── Create class ──

  async function handleCreateClass() {
    if (!createForm.name.trim()) return;
    setSaving(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.from('services').insert({
        business_id: business.id,
        name: createForm.name.trim(),
        description: createForm.description.trim() || null,
        price: createForm.price,
        duration_minutes: createForm.duration_minutes,
        max_capacity: createForm.max_capacity,
        is_class: true,
        class_schedule: createForm.class_schedule,
        is_active: true,
        status: 'active',
      });
      if (error) throw error;
      setShowCreateDialog(false);
      setCreateForm({
        name: '',
        description: '',
        price: 0,
        duration_minutes: 60,
        max_capacity: 10,
        class_schedule: [{ day: 'monday', time: '09:00' }],
      });
      await loadClasses();
    } catch {
      // Could add toast here
    }
    setSaving(false);
  }

  // ── Cancel session (cancel all bookings for a session) ──

  async function handleCancelSession() {
    if (!selectedSession) return;
    setCancelling(true);
    try {
      const supabase = createClient();
      const bookingIds = selectedSession.bookings.map(b => b.id);
      if (bookingIds.length > 0) {
        const { error } = await supabase
          .from('bookings')
          .update({ status: 'cancelled' })
          .in('id', bookingIds);
        if (error) throw error;
      }
      setShowCancelConfirm(false);
      setShowSessionDetail(false);
      setSelectedSession(null);
      await loadSessions(filterClassId);
    } catch {
      // Could add toast here
    }
    setCancelling(false);
  }

  // ── Render ──

  if (loading) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Classes</h1>
        <div className="mt-8 flex justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Classes</h1>
        <button
          onClick={() => setShowCreateDialog(true)}
          className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-600 hover:shadow-md active:scale-[0.98]"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Create Class
        </button>
      </div>

      <PageHelp
        pageKey="classes"
        title="Group Classes"
        description="Create and manage group classes with capacity limits. Students sign up for available time slots via WhatsApp. Track attendance and manage your schedule here."
      />

      {classes.length === 0 ? (
        <EmptyState
          icon="👥"
          title="No classes yet"
          description="Create your first group class to start accepting bookings. Classes support recurring schedules, capacity limits, and automatic waitlisting."
          actionLabel="Create Class"
          onAction={() => setShowCreateDialog(true)}
          tip="Classes are group sessions with capacity limits. Customers can book via WhatsApp and you manage attendance here."
        />
      ) : (
        <>
          {/* Tabs */}
          <div className="mt-6 flex gap-1 rounded-lg bg-gray-100 dark:bg-gray-800 p-1 w-fit">
            {(['classes', 'sessions'] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => { setTab(t); if (t === 'classes') setFilterClassId(null); }}
                className={`rounded-md px-4 py-2 text-sm font-medium transition ${
                  tab === t
                    ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                }`}
              >
                {t === 'classes' ? 'Classes' : 'Upcoming Sessions'}
                <span className="ml-1.5 text-gray-400">
                  {t === 'classes' ? classes.length : sessions.length}
                </span>
              </button>
            ))}
          </div>

          {/* Tab Content */}
          {tab === 'classes' ? (
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {classes.map(cls => (
                <div
                  key={cls.id}
                  onClick={() => {
                    setFilterClassId(cls.id);
                    setTab('sessions');
                  }}
                  className="cursor-pointer rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 transition hover:shadow-md hover:border-brand/30"
                >
                  {/* Class header */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="font-semibold text-gray-900 dark:text-gray-100 truncate">{cls.name}</h3>
                      {cls.description && (
                        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 line-clamp-2">{cls.description}</p>
                      )}
                    </div>
                    <span className={`shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      cls.is_active
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                        : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
                    }`}>
                      {cls.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </div>

                  {/* Details */}
                  <div className="mt-4 space-y-2">
                    <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                      <svg className="h-4 w-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <span>{cls.price > 0 ? formatCurrency(cls.price, country) : 'Free'}</span>
                    </div>

                    {cls.duration_minutes && (
                      <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                        <svg className="h-4 w-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <span>{cls.duration_minutes} min</span>
                      </div>
                    )}

                    <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                      <svg className="h-4 w-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                      <span>{cls.max_capacity ? `${cls.max_capacity} spots` : 'Unlimited'}</span>
                    </div>

                    <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                      <svg className="h-4 w-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                      <span className="truncate">{formatScheduleSummary(cls.class_schedule)}</span>
                    </div>
                  </div>

                  {/* View sessions link */}
                  <div className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-700">
                    <span className="text-sm font-medium text-brand hover:text-brand-600">
                      View sessions →
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            /* Sessions tab */
            <div className="mt-6">
              {/* Class filter for sessions */}
              {classes.length > 1 && (
                <div className="mb-4 flex items-center gap-2">
                  <label className="text-sm text-gray-500 dark:text-gray-400">Filter:</label>
                  <select
                    value={filterClassId || ''}
                    onChange={(e) => setFilterClassId(e.target.value || null)}
                    className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm outline-none focus:border-brand dark:text-gray-100"
                  >
                    <option value="">All classes</option>
                    {classes.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {sessionsLoading ? (
                <div className="mt-8 flex justify-center">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                </div>
              ) : sessions.length === 0 ? (
                <div className="mt-8 text-center text-gray-500 dark:text-gray-400">
                  <p className="text-lg font-medium">No upcoming sessions</p>
                  <p className="mt-1 text-sm">Sessions will appear here based on your class schedules and bookings.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 dark:border-gray-700 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                        <th className="px-4 py-3">Date</th>
                        <th className="px-4 py-3">Time</th>
                        <th className="px-4 py-3">Class</th>
                        <th className="px-4 py-3">Capacity</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                      {sessions.map((session, idx) => {
                        const badge = getCapacityBadge(session.booked, session.capacity);
                        return (
                          <tr
                            key={`${session.serviceId}-${session.date}-${session.time}-${idx}`}
                            onClick={() => { setSelectedSession(session); setShowSessionDetail(true); }}
                            className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 transition"
                          >
                            <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap">
                              {formatDateReadable(session.date)}
                            </td>
                            <td className="px-4 py-3 text-gray-600 dark:text-gray-300 whitespace-nowrap">
                              {formatTime12h(session.time)}
                            </td>
                            <td className="px-4 py-3 text-gray-900 dark:text-gray-100">
                              {session.serviceName}
                            </td>
                            <td className="px-4 py-3">
                              <span className={`font-semibold ${getCapacityColor(session.booked, session.capacity)}`}>
                                {session.booked}/{session.capacity || '∞'}
                              </span>
                              <span className="ml-1 text-gray-400 text-xs">
                                {session.capacity > 0 ? `(${Math.max(0, session.capacity - session.booked)} left)` : ''}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>
                                {badge.label}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <svg className="h-4 w-4 text-gray-400 inline-block" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                              </svg>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ── Create Class Dialog ── */}
      {showCreateDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowCreateDialog(false)} />
          <div className="relative w-full max-w-lg rounded-2xl bg-white dark:bg-gray-900 shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-6 py-4">
              <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Create Class</h2>
              <button
                onClick={() => setShowCreateDialog(false)}
                className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-600 transition"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">
              {/* Name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Class Name *</label>
                <input
                  type="text"
                  value={createForm.name}
                  onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                  placeholder="e.g. Morning Yoga, CrossFit Basics"
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm outline-none focus:border-brand dark:text-gray-100"
                />
              </div>

              {/* Description */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
                <textarea
                  value={createForm.description}
                  onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
                  placeholder="Brief description of the class..."
                  rows={2}
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm outline-none focus:border-brand dark:text-gray-100 resize-none"
                />
              </div>

              {/* Price & Duration */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Price</label>
                  <input
                    type="number"
                    min={0}
                    value={createForm.price}
                    onChange={(e) => setCreateForm({ ...createForm, price: Number(e.target.value) || 0 })}
                    className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm outline-none focus:border-brand dark:text-gray-100"
                  />
                  <p className="mt-0.5 text-xs text-gray-400">0 = Free</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Duration (min)</label>
                  <input
                    type="number"
                    min={5}
                    value={createForm.duration_minutes}
                    onChange={(e) => setCreateForm({ ...createForm, duration_minutes: Number(e.target.value) || 60 })}
                    className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm outline-none focus:border-brand dark:text-gray-100"
                  />
                </div>
              </div>

              {/* Capacity */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Max Capacity</label>
                <input
                  type="number"
                  min={1}
                  value={createForm.max_capacity}
                  onChange={(e) => setCreateForm({ ...createForm, max_capacity: Number(e.target.value) || 10 })}
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm outline-none focus:border-brand dark:text-gray-100"
                />
                <p className="mt-0.5 text-xs text-gray-400">Maximum students per session</p>
              </div>

              {/* Schedule */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Schedule</label>
                <p className="text-xs text-gray-400 mb-2">Set recurring days and times for this class</p>
                {createForm.class_schedule.map((entry, i) => (
                  <div key={i} className="flex items-center gap-2 mb-2">
                    <select
                      value={entry.day}
                      onChange={(e) => {
                        const updated = [...createForm.class_schedule];
                        updated[i] = { ...updated[i], day: e.target.value };
                        setCreateForm({ ...createForm, class_schedule: updated });
                      }}
                      className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm outline-none focus:border-brand dark:text-gray-100"
                    >
                      {WEEKDAYS.map(d => <option key={d.key} value={d.key}>{d.short}</option>)}
                    </select>
                    <input
                      type="time"
                      value={entry.time}
                      onChange={(e) => {
                        const updated = [...createForm.class_schedule];
                        updated[i] = { ...updated[i], time: e.target.value };
                        setCreateForm({ ...createForm, class_schedule: updated });
                      }}
                      className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm outline-none focus:border-brand dark:text-gray-100"
                    />
                    {createForm.class_schedule.length > 1 && (
                      <button
                        type="button"
                        onClick={() => {
                          setCreateForm({
                            ...createForm,
                            class_schedule: createForm.class_schedule.filter((_, j) => j !== i),
                          });
                        }}
                        className="text-red-400 hover:text-red-600 text-lg leading-none"
                      >
                        &times;
                      </button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setCreateForm({
                      ...createForm,
                      class_schedule: [...createForm.class_schedule, { day: 'monday', time: '09:00' }],
                    });
                  }}
                  className="rounded-lg border border-dashed border-gray-300 dark:border-gray-600 px-3 py-1.5 text-xs text-gray-500 hover:border-brand hover:text-brand transition"
                >
                  + Add Day/Time
                </button>
              </div>
            </div>

            <div className="flex justify-end gap-3 border-t border-gray-200 dark:border-gray-700 px-6 py-4">
              <button
                onClick={() => setShowCreateDialog(false)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateClass}
                disabled={saving || !createForm.name.trim()}
                className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
              >
                {saving ? 'Creating...' : 'Create Class'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Session Detail Dialog ── */}
      {showSessionDetail && selectedSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => { setShowSessionDetail(false); setSelectedSession(null); }} />
          <div className="relative w-full max-w-lg rounded-2xl bg-white dark:bg-gray-900 shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-6 py-4">
              <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Session Details</h2>
              <button
                onClick={() => { setShowSessionDetail(false); setSelectedSession(null); }}
                className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-600 transition"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="px-6 py-5 max-h-[70vh] overflow-y-auto">
              {/* Session info */}
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <svg className="h-5 w-5 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <div>
                    <p className="font-semibold text-gray-900 dark:text-gray-100">{selectedSession.serviceName}</p>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {formatDateReadable(selectedSession.date)} at {formatTime12h(selectedSession.time)}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <svg className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  <div>
                    <span className={`font-semibold ${getCapacityColor(selectedSession.booked, selectedSession.capacity)}`}>
                      {selectedSession.booked} / {selectedSession.capacity || '∞'}
                    </span>
                    <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">
                      {selectedSession.capacity > 0
                        ? `${Math.max(0, selectedSession.capacity - selectedSession.booked)} spots remaining`
                        : 'Unlimited capacity'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Attendee list */}
              <div className="mt-6">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-3">
                  Attendees ({selectedSession.bookings.length})
                </h3>
                {selectedSession.bookings.length === 0 ? (
                  <p className="text-sm text-gray-400 italic">No bookings yet for this session.</p>
                ) : (
                  <div className="space-y-2">
                    {selectedSession.bookings.map((booking) => (
                      <div
                        key={booking.id}
                        className="flex items-center justify-between rounded-lg bg-gray-50 dark:bg-gray-800 px-4 py-3"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-gray-900 dark:text-gray-100 truncate">
                            {booking.guest_name || 'Unknown'}
                          </p>
                          {booking.guest_phone && (
                            <p className="text-xs text-gray-500 dark:text-gray-400">{booking.guest_phone}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          {booking.party_size > 1 && (
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                              x{booking.party_size}
                            </span>
                          )}
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            booking.status === 'confirmed'
                              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                              : booking.status === 'pending'
                              ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                              : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
                          }`}>
                            {booking.status}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Footer with cancel button */}
            <div className="flex justify-between border-t border-gray-200 dark:border-gray-700 px-6 py-4">
              <div>
                {selectedSession.bookings.length > 0 && (
                  <button
                    onClick={() => setShowCancelConfirm(true)}
                    className="rounded-lg px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition"
                  >
                    Cancel Session
                  </button>
                )}
              </div>
              <button
                onClick={() => { setShowSessionDetail(false); setSelectedSession(null); }}
                className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Cancel Confirmation Dialog ── */}
      {showCancelConfirm && selectedSession && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowCancelConfirm(false)} />
          <div className="relative w-full max-w-sm rounded-2xl bg-white dark:bg-gray-900 shadow-xl p-6">
            <div className="text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
                <svg className="h-6 w-6 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
              <h3 className="mt-4 text-lg font-bold text-gray-900 dark:text-gray-100">Cancel this session?</h3>
              <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                This will cancel {selectedSession.bookings.length} booking{selectedSession.bookings.length !== 1 ? 's' : ''} for {selectedSession.serviceName} on {formatDateReadable(selectedSession.date)}.
                This action cannot be undone.
              </p>
            </div>
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setShowCancelConfirm(false)}
                className="flex-1 rounded-lg px-4 py-2.5 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 border border-gray-200 dark:border-gray-700 transition"
              >
                Keep Session
              </button>
              <button
                onClick={handleCancelSession}
                disabled={cancelling}
                className="flex-1 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-red-700 disabled:opacity-50"
              >
                {cancelling ? 'Cancelling...' : 'Cancel Session'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
