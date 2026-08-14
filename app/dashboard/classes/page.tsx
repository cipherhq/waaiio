'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { PageHelp } from '@/components/dashboard/PageHelp';
import EmptyState from '@/components/dashboard/EmptyState';
import { formatCurrency, type CountryCode } from '@/lib/constants';

// ── Types ────────────────────────────────────────────

interface ClassService {
  id: string;
  name: string;
  description: string | null;
  price: number;
  duration_minutes: number | null;
  max_capacity: number | null;
  is_active: boolean;
  is_class: boolean;
}

interface SessionService {
  id: string;
  name: string;
  business_id: string;
  duration: number | null;
  price: number;
}

interface ClassSession {
  id: string;
  service_id: string;
  recurrence_rule_id: string | null;
  date: string;
  start_time: string;
  end_time: string;
  staff_id: string | null;
  location_id: string | null;
  capacity: number;
  status: 'scheduled' | 'cancelled' | 'completed';
  cancellation_reason: string | null;
  created_at: string;
  attendee_count: number;
  services: SessionService;
}

interface Attendee {
  id: string;
  reference_code: string;
  guest_name: string;
  guest_phone: string;
  guest_email: string | null;
  party_size: number;
  status: string;
  created_at: string;
}

interface SessionDetail extends ClassSession {
  attendees: Attendee[];
}

interface StaffMember {
  id: string;
  name: string;
}

type TabId = 'classes' | 'sessions';

const WEEKDAYS = [
  { value: 0, label: 'Sunday', short: 'Sun', key: 'sun' },
  { value: 1, label: 'Monday', short: 'Mon', key: 'mon' },
  { value: 2, label: 'Tuesday', short: 'Tue', key: 'tue' },
  { value: 3, label: 'Wednesday', short: 'Wed', key: 'wed' },
  { value: 4, label: 'Thursday', short: 'Thu', key: 'thu' },
  { value: 5, label: 'Friday', short: 'Fri', key: 'fri' },
  { value: 6, label: 'Saturday', short: 'Sat', key: 'sat' },
];

// ── Helpers ──────────────────────────────────────────

function formatTime(timeStr: string): string {
  // Handle HH:MM:SS or HH:MM
  const [h, m] = timeStr.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${m.toString().padStart(2, '0')} ${ampm}`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function capacityColor(attendees: number, capacity: number): string {
  if (capacity === 0) return 'text-gray-500';
  const ratio = attendees / capacity;
  if (ratio >= 1) return 'text-red-600 dark:text-red-400';
  if (ratio >= 0.75) return 'text-amber-600 dark:text-amber-400';
  return 'text-green-600 dark:text-green-400';
}

function statusBadge(status: string): { label: string; className: string } {
  switch (status) {
    case 'scheduled':
      return { label: 'Scheduled', className: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' };
    case 'cancelled':
      return { label: 'Cancelled', className: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' };
    case 'completed':
      return { label: 'Completed', className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300' };
    default:
      return { label: status, className: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' };
  }
}

// ── Component ────────────────────────────────────────

export default function ClassesPage() {
  const business = useBusiness();
  const countryCode = (business.country_code || 'NG') as CountryCode;

  // Tab state
  const [activeTab, setActiveTab] = useState<TabId>('classes');

  // Classes tab state
  const [classes, setClasses] = useState<ClassService[]>([]);
  const [classesLoading, setClassesLoading] = useState(true);
  const [classesError, setClassesError] = useState<string | null>(null);

  // Sessions tab state
  const [sessions, setSessions] = useState<ClassSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [filterServiceId, setFilterServiceId] = useState<string | null>(null);

  // Staff (for create dialog)
  const [staffList, setStaffList] = useState<StaffMember[]>([]);

  // Create class dialog
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newClass, setNewClass] = useState({
    name: '',
    description: '',
    price: '',
    duration: '60',
    capacity: '10',
    // Recurrence rule fields
    dayOfWeek: 1,
    startTime: '09:00',
    staffId: '',
  });

  // Session detail dialog
  const [selectedSession, setSelectedSession] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Cancel session
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);

  // ── Data fetching ────────────────────────────────

  const fetchClasses = useCallback(async () => {
    setClassesLoading(true);
    setClassesError(null);
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from('services')
        .select('id, name, description, price, duration_minutes, max_capacity, is_active, is_class')
        .eq('business_id', business.id)
        .eq('is_class', true)
        .order('name');

      if (error) throw error;
      setClasses((data as ClassService[]) || []);
    } catch {
      setClassesError('Failed to load classes');
    }
    setClassesLoading(false);
  }, [business.id]);

  const fetchSessions = useCallback(async (serviceId?: string | null) => {
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const params = new URLSearchParams({ businessId: business.id });
      if (serviceId) params.set('serviceId', serviceId);

      const res = await fetch(`/api/classes/sessions?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to load sessions');
      }
      const { data } = await res.json();
      setSessions(data || []);
    } catch (err) {
      setSessionsError(err instanceof Error ? err.message : 'Failed to load sessions');
    }
    setSessionsLoading(false);
  }, [business.id]);

  const fetchStaff = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('business_staff')
      .select('id, name')
      .eq('business_id', business.id)
      .eq('is_active', true)
      .order('name');
    setStaffList((data as StaffMember[]) || []);
  }, [business.id]);

  const fetchSessionDetail = async (sessionId: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const res = await fetch(`/api/classes/sessions/${sessionId}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to load session details');
      }
      const { data } = await res.json();
      setSelectedSession(data);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : 'Failed to load session details');
    }
    setDetailLoading(false);
  };

  // ── Initial load ──────────────────────────────────

  useEffect(() => {
    fetchClasses();
    fetchStaff();
  }, [fetchClasses, fetchStaff]);

  useEffect(() => {
    if (activeTab === 'sessions') {
      fetchSessions(filterServiceId);
    }
  }, [activeTab, filterServiceId, fetchSessions]);

  // ── Create class ──────────────────────────────────

  const handleCreateClass = async () => {
    setCreating(true);
    setCreateError(null);

    try {
      const WEEKDAY_MAP = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
      const priceNum = Math.round(parseFloat(newClass.price) * 100) || 0;
      const durationNum = parseInt(newClass.duration) || 60;
      const capacityNum = parseInt(newClass.capacity) || 10;

      // Atomic class creation via server authority (service + recurrence + generation)
      const res = await fetch('/api/classes/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          name: newClass.name.trim(),
          description: newClass.description.trim() || null,
          price: priceNum,
          durationMinutes: durationNum,
          maxCapacity: capacityNum,
          weekday: WEEKDAY_MAP[newClass.dayOfWeek] || 'mon',
          startTime: newClass.startTime,
          staffId: newClass.staffId || null,
          capacityOverride: capacityNum,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to create class');
      }

      // Reset form and refresh
      setNewClass({
        name: '', description: '', price: '', duration: '60', capacity: '10',
        dayOfWeek: 1, startTime: '09:00', staffId: '',
      });
      setShowCreateDialog(false);
      fetchClasses();
      if (activeTab === 'sessions') fetchSessions(filterServiceId);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create class');
    }
    setCreating(false);
  };

  // ── Cancel session ────────────────────────────────

  const handleCancelSession = async () => {
    if (!selectedSession) return;
    setCancelling(true);

    try {
      const res = await fetch(`/api/classes/sessions/${selectedSession.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'cancelled',
          cancellationReason: cancelReason.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to cancel session');
      }

      setShowCancelConfirm(false);
      setCancelReason('');
      setSelectedSession(null);
      fetchSessions(filterServiceId);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to cancel session');
    }
    setCancelling(false);
  };

  // ── Filter sessions to a class ────────────────────

  const handleClassClick = (classId: string) => {
    setFilterServiceId(classId);
    setActiveTab('sessions');
  };

  // ── Render ────────────────────────────────────────

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Classes</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Manage your class offerings and sessions
          </p>
        </div>

        {activeTab === 'classes' && (
          <button
            onClick={() => setShowCreateDialog(true)}
            className="rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-600 hover:shadow-md active:scale-[0.98]"
          >
            Create Class
          </button>
        )}
      </div>

      <PageHelp
        pageKey="classes"
        title="Class Booking"
        description="Create classes with recurring schedules. Sessions are generated automatically and customers can book spots through WhatsApp."
      />

      {/* Tabs */}
      <div className="mt-6 border-b border-gray-200 dark:border-gray-700">
        <nav className="-mb-px flex gap-6">
          {([
            { id: 'classes' as TabId, label: 'Classes' },
            { id: 'sessions' as TabId, label: 'Upcoming Sessions' },
          ]).map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                setActiveTab(tab.id);
                if (tab.id === 'sessions' && !filterServiceId) {
                  setFilterServiceId(null);
                }
              }}
              className={`whitespace-nowrap border-b-2 px-1 pb-3 text-sm font-medium transition ${
                activeTab === tab.id
                  ? 'border-brand text-brand'
                  : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      <div className="mt-6">
        {activeTab === 'classes' && (
          <ClassesTab
            classes={classes}
            loading={classesLoading}
            error={classesError}
            countryCode={countryCode}
            onClassClick={handleClassClick}
            onCreateClick={() => setShowCreateDialog(true)}
          />
        )}

        {activeTab === 'sessions' && (
          <SessionsTab
            sessions={sessions}
            classes={classes}
            loading={sessionsLoading}
            error={sessionsError}
            filterServiceId={filterServiceId}
            countryCode={countryCode}
            onFilterChange={setFilterServiceId}
            onSessionClick={(id) => fetchSessionDetail(id)}
          />
        )}
      </div>

      {/* Create Class Dialog */}
      {showCreateDialog && (
        <CreateClassDialog
          newClass={newClass}
          setNewClass={setNewClass}
          staffList={staffList}
          creating={creating}
          error={createError}
          onSubmit={handleCreateClass}
          onClose={() => { setShowCreateDialog(false); setCreateError(null); }}
        />
      )}

      {/* Session Detail Dialog */}
      {(selectedSession || detailLoading) && (
        <SessionDetailDialog
          session={selectedSession}
          loading={detailLoading}
          error={detailError}
          countryCode={countryCode}
          onClose={() => { setSelectedSession(null); setDetailError(null); }}
          onCancelClick={() => setShowCancelConfirm(true)}
        />
      )}

      {/* Cancel Confirmation Dialog */}
      {showCancelConfirm && selectedSession && (
        <CancelConfirmDialog
          sessionName={selectedSession.services?.name || 'Session'}
          sessionDate={formatDate(selectedSession.date)}
          reason={cancelReason}
          setReason={setCancelReason}
          cancelling={cancelling}
          onConfirm={handleCancelSession}
          onClose={() => { setShowCancelConfirm(false); setCancelReason(''); }}
        />
      )}
    </div>
  );
}

// ── Classes Tab ──────────────────────────────────────

function ClassesTab({
  classes,
  loading,
  error,
  countryCode,
  onClassClick,
  onCreateClick,
}: {
  classes: ClassService[];
  loading: boolean;
  error: string | null;
  countryCode: CountryCode;
  onClassClick: (id: string) => void;
  onCreateClick: () => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
        {error}
      </div>
    );
  }

  if (classes.length === 0) {
    return (
      <EmptyState
        icon="🎓"
        title="No classes yet"
        description="Create your first class to start offering group sessions. Classes have recurring schedules and let multiple customers book the same time slot."
        actionLabel="Create Class"
        onAction={onCreateClick}
        tip="Classes generate upcoming sessions automatically based on their schedule. Customers can book spots through WhatsApp."
      />
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {classes.map((cls) => (
        <button
          key={cls.id}
          onClick={() => onClassClick(cls.id)}
          className="group rounded-xl border border-gray-200 bg-white p-5 text-left shadow-sm transition hover:border-brand/30 hover:shadow-md dark:border-gray-700 dark:bg-gray-800 dark:hover:border-brand/40"
        >
          <div className="flex items-start justify-between">
            <h3 className="font-semibold text-gray-900 group-hover:text-brand dark:text-gray-100">
              {cls.name}
            </h3>
            <span
              className={`ml-2 shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                cls.is_active
                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                  : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
              }`}
            >
              {cls.is_active ? 'Active' : 'Inactive'}
            </span>
          </div>

          {cls.description && (
            <p className="mt-1.5 line-clamp-2 text-sm text-gray-500 dark:text-gray-400">
              {cls.description}
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-gray-600 dark:text-gray-300">
            <span className="font-medium">
              {formatCurrency(cls.price / 100, countryCode)}
            </span>
            {cls.duration_minutes && (
              <span className="text-gray-400 dark:text-gray-500">
                {cls.duration_minutes} min
              </span>
            )}
            {cls.max_capacity && (
              <span className="text-gray-400 dark:text-gray-500">
                {cls.max_capacity} spots
              </span>
            )}
          </div>

          <p className="mt-3 text-xs text-brand group-hover:underline">
            View sessions →
          </p>
        </button>
      ))}
    </div>
  );
}

// ── Sessions Tab ─────────────────────────────────────

function SessionsTab({
  sessions,
  classes,
  loading,
  error,
  filterServiceId,
  countryCode,
  onFilterChange,
  onSessionClick,
}: {
  sessions: ClassSession[];
  classes: ClassService[];
  loading: boolean;
  error: string | null;
  filterServiceId: string | null;
  countryCode: CountryCode;
  onFilterChange: (id: string | null) => void;
  onSessionClick: (id: string) => void;
}) {
  return (
    <div>
      {/* Filter bar */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <select
          value={filterServiceId || ''}
          onChange={(e) => onFilterChange(e.target.value || null)}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
        >
          <option value="">All Classes</option>
          {classes.map((cls) => (
            <option key={cls.id} value={cls.id}>{cls.name}</option>
          ))}
        </select>

        {filterServiceId && (
          <button
            onClick={() => onFilterChange(null)}
            className="text-sm text-brand hover:underline"
          >
            Clear filter
          </button>
        )}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
        </div>
      )}

      {!loading && error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
          {error}
        </div>
      )}

      {!loading && !error && sessions.length === 0 && (
        <EmptyState
          icon="📅"
          title="No upcoming sessions"
          description={
            filterServiceId
              ? 'This class has no upcoming sessions. Sessions are generated automatically from the class schedule.'
              : 'No upcoming sessions found. Create a class with a schedule to generate sessions.'
          }
        />
      )}

      {!loading && !error && sessions.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700">
                <th className="pb-3 pr-4 font-medium text-gray-500 dark:text-gray-400">Date</th>
                <th className="pb-3 pr-4 font-medium text-gray-500 dark:text-gray-400">Time</th>
                <th className="hidden pb-3 pr-4 font-medium text-gray-500 dark:text-gray-400 sm:table-cell">Class</th>
                <th className="hidden pb-3 pr-4 font-medium text-gray-500 dark:text-gray-400 md:table-cell">Capacity</th>
                <th className="pb-3 pr-4 font-medium text-gray-500 dark:text-gray-400">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
              {sessions.map((session) => {
                const badge = statusBadge(session.status);
                return (
                  <tr
                    key={session.id}
                    onClick={() => onSessionClick(session.id)}
                    className="cursor-pointer transition hover:bg-gray-50 dark:hover:bg-gray-800/50"
                  >
                    <td className="py-3 pr-4 font-medium text-gray-900 dark:text-gray-100">
                      {formatDate(session.date)}
                      <span className="block text-xs text-gray-400 sm:hidden">
                        {session.services?.name || '—'}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-gray-600 dark:text-gray-300">
                      {formatTime(session.start_time)}
                      {session.end_time && (
                        <span className="text-gray-400"> – {formatTime(session.end_time)}</span>
                      )}
                    </td>
                    <td className="hidden py-3 pr-4 text-gray-600 dark:text-gray-300 sm:table-cell">
                      {session.services?.name || '—'}
                    </td>
                    <td className="hidden py-3 pr-4 md:table-cell">
                      <span className={capacityColor(session.attendee_count, session.capacity)}>
                        {session.attendee_count} / {session.capacity}
                      </span>
                    </td>
                    <td className="py-3 pr-4">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>
                        {badge.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Create Class Dialog ──────────────────────────────

function CreateClassDialog({
  newClass,
  setNewClass,
  staffList,
  creating,
  error,
  onSubmit,
  onClose,
}: {
  newClass: {
    name: string;
    description: string;
    price: string;
    duration: string;
    capacity: string;
    dayOfWeek: number;
    startTime: string;
    staffId: string;
  };
  setNewClass: React.Dispatch<React.SetStateAction<typeof newClass>>;
  staffList: StaffMember[];
  creating: boolean;
  error: string | null;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const isValid = newClass.name.trim().length > 0 && parseFloat(newClass.price) >= 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Create Class</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700"
            aria-label="Close"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
            {error}
          </div>
        )}

        <div className="mt-5 space-y-4">
          {/* Name */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Class Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={newClass.name}
              onChange={(e) => setNewClass((p) => ({ ...p, name: e.target.value }))}
              placeholder="e.g. Morning Yoga"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
          </div>

          {/* Description */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Description
            </label>
            <textarea
              value={newClass.description}
              onChange={(e) => setNewClass((p) => ({ ...p, description: e.target.value }))}
              rows={2}
              placeholder="Brief description of the class"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
          </div>

          {/* Price + Duration + Capacity row */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Price
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={newClass.price}
                onChange={(e) => setNewClass((p) => ({ ...p, price: e.target.value }))}
                placeholder="0.00"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Duration (min)
              </label>
              <input
                type="number"
                min="15"
                step="15"
                value={newClass.duration}
                onChange={(e) => setNewClass((p) => ({ ...p, duration: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Capacity
              </label>
              <input
                type="number"
                min="1"
                value={newClass.capacity}
                onChange={(e) => setNewClass((p) => ({ ...p, capacity: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              />
            </div>
          </div>

          {/* Schedule */}
          <fieldset className="rounded-lg border border-gray-200 p-4 dark:border-gray-600">
            <legend className="px-2 text-sm font-medium text-gray-700 dark:text-gray-300">
              Weekly Schedule
            </legend>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Day</label>
                <select
                  value={newClass.dayOfWeek}
                  onChange={(e) => setNewClass((p) => ({ ...p, dayOfWeek: parseInt(e.target.value) }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                >
                  {WEEKDAYS.map((wd) => (
                    <option key={wd.value} value={wd.value}>{wd.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Start Time</label>
                <input
                  type="time"
                  value={newClass.startTime}
                  onChange={(e) => setNewClass((p) => ({ ...p, startTime: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                />
              </div>
            </div>

            {staffList.length > 0 && (
              <div className="mt-3">
                <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Instructor (optional)</label>
                <select
                  value={newClass.staffId}
                  onChange={(e) => setNewClass((p) => ({ ...p, staffId: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                >
                  <option value="">No instructor</option>
                  {staffList.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            )}
          </fieldset>
        </div>

        {/* Actions */}
        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={creating}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            onClick={onSubmit}
            disabled={creating || !isValid}
            className="rounded-lg bg-brand px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {creating ? 'Creating...' : 'Create Class'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Session Detail Dialog ────────────────────────────

function SessionDetailDialog({
  session,
  loading,
  error,
  countryCode,
  onClose,
  onCancelClick,
}: {
  session: SessionDetail | null;
  loading: boolean;
  error: string | null;
  countryCode: CountryCode;
  onClose: () => void;
  onCancelClick: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Session Details</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700"
            aria-label="Close"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-12">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
            {error}
          </div>
        )}

        {!loading && session && (
          <>
            {/* Session info */}
            <div className="mt-5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {session.services?.name || 'Class'}
                </span>
                {(() => {
                  const badge = statusBadge(session.status);
                  return (
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>
                      {badge.label}
                    </span>
                  );
                })()}
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-gray-500 dark:text-gray-400">Date</p>
                  <p className="font-medium text-gray-900 dark:text-gray-100">{formatDate(session.date)}</p>
                </div>
                <div>
                  <p className="text-gray-500 dark:text-gray-400">Time</p>
                  <p className="font-medium text-gray-900 dark:text-gray-100">
                    {formatTime(session.start_time)}
                    {session.end_time && ` – ${formatTime(session.end_time)}`}
                  </p>
                </div>
                <div>
                  <p className="text-gray-500 dark:text-gray-400">Capacity</p>
                  <p className={`font-medium ${capacityColor(session.attendee_count, session.capacity)}`}>
                    {session.attendee_count} / {session.capacity} spots
                  </p>
                </div>
                {session.services?.price !== undefined && (
                  <div>
                    <p className="text-gray-500 dark:text-gray-400">Price</p>
                    <p className="font-medium text-gray-900 dark:text-gray-100">
                      {formatCurrency(session.services.price / 100, countryCode)}
                    </p>
                  </div>
                )}
              </div>

              {session.cancellation_reason && (
                <div className="rounded-lg bg-gray-50 p-3 dark:bg-gray-700/50">
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Cancellation Reason</p>
                  <p className="mt-0.5 text-sm text-gray-700 dark:text-gray-300">{session.cancellation_reason}</p>
                </div>
              )}
            </div>

            {/* Attendees */}
            <div className="mt-6">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                Attendees ({session.attendee_count})
              </h3>

              {session.attendees.length === 0 ? (
                <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">No attendees yet.</p>
              ) : (
                <div className="mt-3 divide-y divide-gray-100 dark:divide-gray-700/50">
                  {session.attendees.map((att) => (
                    <div key={att.id} className="flex items-center justify-between py-2.5">
                      <div>
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          {att.guest_name || 'Guest'}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {att.guest_phone}
                          {att.party_size > 1 && ` · ${att.party_size} spots`}
                        </p>
                      </div>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        att.status === 'confirmed'
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                          : att.status === 'pending'
                            ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300'
                            : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                      }`}>
                        {att.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Cancel button — only for scheduled sessions */}
            {session.status === 'scheduled' && (
              <div className="mt-6 border-t border-gray-200 pt-4 dark:border-gray-700">
                <button
                  onClick={onCancelClick}
                  className="w-full rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700 transition hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
                >
                  Cancel Session
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Cancel Confirmation Dialog ───────────────────────

function CancelConfirmDialog({
  sessionName,
  sessionDate,
  reason,
  setReason,
  cancelling,
  onConfirm,
  onClose,
}: {
  sessionName: string;
  sessionDate: string;
  reason: string;
  setReason: (r: string) => void;
  cancelling: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800">
        <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">Cancel Session</h3>

        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          Are you sure you want to cancel <span className="font-medium">{sessionName}</span> on{' '}
          <span className="font-medium">{sessionDate}</span>? All attendees will need to be notified.
        </p>

        <div className="mt-4">
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            Reason (optional)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="e.g. Instructor unavailable"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
          />
        </div>

        <div className="mt-5 flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={cancelling}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Keep Session
          </button>
          <button
            onClick={onConfirm}
            disabled={cancelling}
            className="rounded-lg bg-red-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {cancelling ? 'Cancelling...' : 'Yes, Cancel Session'}
          </button>
        </div>
      </div>
    </div>
  );
}
