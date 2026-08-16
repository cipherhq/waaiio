'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
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

interface RecurrenceRule {
  id: string;
  service_id: string;
  business_id: string;
  weekday: string;
  start_time: string;
  staff_id: string | null;
  capacity_override: number | null;
  is_active: boolean;
  effective_from: string;
  effective_until: string | null;
  business_staff: { id: string; name: string } | null;
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

const WEEKDAY_LABELS: Record<string, string> = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};

const WEEKDAY_MAP = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// ── Helpers ──────────────────────────────────────────

function formatTime(timeStr: string): string {
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

  // Staff (for create/edit dialogs)
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
    dayOfWeek: 1,
    startTime: '09:00',
    staffId: '',
  });

  // Edit class dialog
  const [editingClass, setEditingClass] = useState<ClassService | null>(null);
  const [editForm, setEditForm] = useState({
    name: '', description: '', price: '', duration: '', capacity: '',
  });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Manage schedule dialog
  const [scheduleClass, setScheduleClass] = useState<ClassService | null>(null);
  const [scheduleRules, setScheduleRules] = useState<RecurrenceRule[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [showAddRule, setShowAddRule] = useState(false);
  const [addRuleForm, setAddRuleForm] = useState({ weekday: 'mon', startTime: '09:00', staffId: '', capacityOverride: '' });
  const [addRuleSaving, setAddRuleSaving] = useState(false);
  const [editingRule, setEditingRule] = useState<RecurrenceRule | null>(null);
  const [editRuleForm, setEditRuleForm] = useState({ weekday: '', startTime: '', staffId: '', capacityOverride: '' });
  const [editRuleSaving, setEditRuleSaving] = useState(false);

  // Archive/Delete confirmation
  const [archiveTarget, setArchiveTarget] = useState<ClassService | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ClassService | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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
        .is('deleted_at', null)
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

  const fetchRecurrenceRules = async (serviceId: string) => {
    setScheduleLoading(true);
    setScheduleError(null);
    try {
      const params = new URLSearchParams({ businessId: business.id, serviceId });
      const res = await fetch(`/api/classes/recurrence?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to load schedule');
      }
      const { data } = await res.json();
      setScheduleRules(data || []);
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : 'Failed to load schedule');
    }
    setScheduleLoading(false);
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
      const priceNum = Math.round(parseFloat(newClass.price) * 100) || 0;
      const durationNum = parseInt(newClass.duration) || 60;
      const capacityNum = parseInt(newClass.capacity) || 10;

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

  // ── Edit class ────────────────────────────────────

  const openEditDialog = (cls: ClassService) => {
    setEditingClass(cls);
    setEditForm({
      name: cls.name,
      description: cls.description || '',
      price: (cls.price / 100).toString(),
      duration: (cls.duration_minutes || 60).toString(),
      capacity: (cls.max_capacity || 10).toString(),
    });
    setEditError(null);
  };

  const handleEditClass = async () => {
    if (!editingClass) return;
    setEditSaving(true);
    setEditError(null);

    try {
      const res = await fetch(`/api/classes/${editingClass.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editForm.name.trim(),
          description: editForm.description.trim() || null,
          price: Math.round(parseFloat(editForm.price) * 100) || 0,
          durationMinutes: parseInt(editForm.duration) || 60,
          maxCapacity: parseInt(editForm.capacity) || 10,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to update class');
      }

      setEditingClass(null);
      fetchClasses();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update class');
    }
    setEditSaving(false);
  };

  // ── Archive class ─────────────────────────────────

  const handleArchiveClass = async () => {
    if (!archiveTarget) return;
    setArchiving(true);
    try {
      const newActive = !archiveTarget.is_active;
      const res = await fetch(`/api/classes/${archiveTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: newActive }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to update class');
      }

      setArchiveTarget(null);
      fetchClasses();
      if (activeTab === 'sessions') fetchSessions(filterServiceId);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update class');
    }
    setArchiving(false);
  };

  // ── Delete class ──────────────────────────────────

  const handleDeleteClass = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/classes/${deleteTarget.id}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to delete class');
      }

      setDeleteTarget(null);
      fetchClasses();
      if (activeTab === 'sessions') fetchSessions(filterServiceId);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete class');
    }
    setDeleting(false);
  };

  // ── Schedule management ───────────────────────────

  const openScheduleDialog = (cls: ClassService) => {
    setScheduleClass(cls);
    setShowAddRule(false);
    setEditingRule(null);
    fetchRecurrenceRules(cls.id);
  };

  const handleAddRule = async () => {
    if (!scheduleClass) return;
    setAddRuleSaving(true);
    try {
      const res = await fetch('/api/classes/recurrence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          serviceId: scheduleClass.id,
          weekday: addRuleForm.weekday,
          startTime: addRuleForm.startTime,
          staffId: addRuleForm.staffId || null,
          capacityOverride: addRuleForm.capacityOverride ? parseInt(addRuleForm.capacityOverride) : null,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to add schedule');
      }

      setShowAddRule(false);
      setAddRuleForm({ weekday: 'mon', startTime: '09:00', staffId: '', capacityOverride: '' });
      fetchRecurrenceRules(scheduleClass.id);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to add schedule');
    }
    setAddRuleSaving(false);
  };

  const openEditRule = (rule: RecurrenceRule) => {
    setEditingRule(rule);
    setEditRuleForm({
      weekday: rule.weekday,
      startTime: rule.start_time,
      staffId: rule.staff_id || '',
      capacityOverride: rule.capacity_override?.toString() || '',
    });
  };

  const handleEditRule = async () => {
    if (!editingRule || !scheduleClass) return;
    setEditRuleSaving(true);
    try {
      const res = await fetch('/api/classes/recurrence', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          ruleId: editingRule.id,
          weekday: editRuleForm.weekday,
          startTime: editRuleForm.startTime,
          staffId: editRuleForm.staffId || null,
          clearStaff: !editRuleForm.staffId && !!editingRule.staff_id,
          capacityOverride: editRuleForm.capacityOverride ? parseInt(editRuleForm.capacityOverride) : null,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to update schedule');
      }

      setEditingRule(null);
      fetchRecurrenceRules(scheduleClass.id);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update schedule');
    }
    setEditRuleSaving(false);
  };

  const handleToggleRule = async (rule: RecurrenceRule) => {
    if (!scheduleClass) return;
    try {
      const res = await fetch('/api/classes/recurrence', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          ruleId: rule.id,
          isActive: !rule.is_active,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to update rule');
      }

      fetchRecurrenceRules(scheduleClass.id);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update rule');
    }
  };

  const handleDeleteRule = async (rule: RecurrenceRule) => {
    if (!scheduleClass) return;
    if (!confirm('Remove this schedule? Future unbooked sessions for this slot will be removed.')) return;
    try {
      const res = await fetch('/api/classes/recurrence', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId: business.id, ruleId: rule.id }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to remove schedule');
      }

      fetchRecurrenceRules(scheduleClass.id);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to remove schedule');
    }
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
            onEditClick={openEditDialog}
            onScheduleClick={openScheduleDialog}
            onArchiveClick={setArchiveTarget}
            onDeleteClick={(cls) => { setDeleteTarget(cls); setDeleteError(null); }}
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

      {/* Edit Class Dialog */}
      {editingClass && (
        <EditClassDialog
          form={editForm}
          setForm={setEditForm}
          saving={editSaving}
          error={editError}
          onSubmit={handleEditClass}
          onClose={() => { setEditingClass(null); setEditError(null); }}
        />
      )}

      {/* Manage Schedule Dialog */}
      {scheduleClass && (
        <ManageScheduleDialog
          cls={scheduleClass}
          rules={scheduleRules}
          loading={scheduleLoading}
          error={scheduleError}
          staffList={staffList}
          showAddRule={showAddRule}
          setShowAddRule={setShowAddRule}
          addRuleForm={addRuleForm}
          setAddRuleForm={setAddRuleForm}
          addRuleSaving={addRuleSaving}
          onAddRule={handleAddRule}
          editingRule={editingRule}
          editRuleForm={editRuleForm}
          setEditRuleForm={setEditRuleForm}
          editRuleSaving={editRuleSaving}
          onEditRule={handleEditRule}
          onOpenEditRule={openEditRule}
          onCancelEditRule={() => setEditingRule(null)}
          onToggleRule={handleToggleRule}
          onDeleteRule={handleDeleteRule}
          onClose={() => { setScheduleClass(null); setScheduleError(null); }}
        />
      )}

      {/* Archive Confirmation */}
      {archiveTarget && (
        <ConfirmDialog
          title={archiveTarget.is_active ? 'Archive Class' : 'Reactivate Class'}
          message={
            archiveTarget.is_active
              ? `Archive "${archiveTarget.name}"? This will stop generating new sessions and prevent new bookings. Existing bookings and history are preserved.`
              : `Reactivate "${archiveTarget.name}"? The class will become visible again. You may need to reactivate its schedules separately.`
          }
          confirmLabel={archiveTarget.is_active ? 'Archive' : 'Reactivate'}
          confirmClassName={archiveTarget.is_active
            ? 'bg-amber-600 hover:bg-amber-700 text-white'
            : 'bg-green-600 hover:bg-green-700 text-white'}
          loading={archiving}
          onConfirm={handleArchiveClass}
          onClose={() => setArchiveTarget(null)}
        />
      )}

      {/* Delete Confirmation */}
      {deleteTarget && (
        <ConfirmDialog
          title="Delete Class"
          message={`Permanently delete "${deleteTarget.name}"? This can only be done if the class has no booking history.`}
          confirmLabel="Delete"
          confirmClassName="bg-red-600 hover:bg-red-700 text-white"
          loading={deleting}
          error={deleteError}
          onConfirm={handleDeleteClass}
          onClose={() => { setDeleteTarget(null); setDeleteError(null); }}
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

// ── Three-Dot Menu ──────────────────────────────────

function ThreeDotMenu({
  cls,
  onEdit,
  onSchedule,
  onArchive,
  onDelete,
}: {
  cls: ClassService;
  onEdit: () => void;
  onSchedule: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
        aria-label="Class actions"
      >
        <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
          <path d="M10 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4z" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-1 w-48 rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-600 dark:bg-gray-800">
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(false); onEdit(); }}
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            Edit Class
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(false); onSchedule(); }}
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            Manage Schedule
          </button>
          <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(false); onArchive(); }}
            className={`flex w-full items-center gap-2 px-4 py-2 text-left text-sm ${
              cls.is_active
                ? 'text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-900/20'
                : 'text-green-600 hover:bg-green-50 dark:text-green-400 dark:hover:bg-green-900/20'
            }`}
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
            </svg>
            {cls.is_active ? 'Archive Class' : 'Reactivate Class'}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(false); onDelete(); }}
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Delete Class
          </button>
        </div>
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
  onEditClick,
  onScheduleClick,
  onArchiveClick,
  onDeleteClick,
}: {
  classes: ClassService[];
  loading: boolean;
  error: string | null;
  countryCode: CountryCode;
  onClassClick: (id: string) => void;
  onCreateClick: () => void;
  onEditClick: (cls: ClassService) => void;
  onScheduleClick: (cls: ClassService) => void;
  onArchiveClick: (cls: ClassService) => void;
  onDeleteClick: (cls: ClassService) => void;
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
        <div
          key={cls.id}
          className="group relative rounded-xl border border-gray-200 bg-white p-5 shadow-sm transition hover:border-brand/30 hover:shadow-md dark:border-gray-700 dark:bg-gray-800 dark:hover:border-brand/40"
        >
          <div className="flex items-start justify-between">
            <h3 className="font-semibold text-gray-900 group-hover:text-brand dark:text-gray-100">
              {cls.name}
            </h3>
            <div className="flex items-center gap-1">
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                  cls.is_active
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                    : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
                }`}
              >
                {cls.is_active ? 'Active' : 'Inactive'}
              </span>
              <ThreeDotMenu
                cls={cls}
                onEdit={() => onEditClick(cls)}
                onSchedule={() => onScheduleClick(cls)}
                onArchive={() => onArchiveClick(cls)}
                onDelete={() => onDeleteClick(cls)}
              />
            </div>
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

          <button
            onClick={() => onClassClick(cls.id)}
            className="mt-3 text-xs text-brand hover:underline"
          >
            View sessions →
          </button>
        </div>
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

// ── Edit Class Dialog ────────────────────────────────

function EditClassDialog({
  form,
  setForm,
  saving,
  error,
  onSubmit,
  onClose,
}: {
  form: { name: string; description: string; price: string; duration: string; capacity: string };
  setForm: React.Dispatch<React.SetStateAction<typeof form>>;
  saving: boolean;
  error: string | null;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const isValid = form.name.trim().length > 0 && parseFloat(form.price) >= 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Edit Class</h2>
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
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Class Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Description
            </label>
            <textarea
              value={form.description}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
              rows={2}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Price</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.price}
                onChange={(e) => setForm((p) => ({ ...p, price: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Duration (min)</label>
              <input
                type="number"
                min="15"
                step="15"
                value={form.duration}
                onChange={(e) => setForm((p) => ({ ...p, duration: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Capacity</label>
              <input
                type="number"
                min="1"
                value={form.capacity}
                onChange={(e) => setForm((p) => ({ ...p, capacity: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              />
            </div>
          </div>

          <p className="text-xs text-gray-500 dark:text-gray-400">
            Changes to duration and capacity only affect future sessions. Booked sessions are not modified.
          </p>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            onClick={onSubmit}
            disabled={saving || !isValid}
            className="rounded-lg bg-brand px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Manage Schedule Dialog ───────────────────────────

function ManageScheduleDialog({
  cls,
  rules,
  loading,
  error,
  staffList,
  showAddRule,
  setShowAddRule,
  addRuleForm,
  setAddRuleForm,
  addRuleSaving,
  onAddRule,
  editingRule,
  editRuleForm,
  setEditRuleForm,
  editRuleSaving,
  onEditRule,
  onOpenEditRule,
  onCancelEditRule,
  onToggleRule,
  onDeleteRule,
  onClose,
}: {
  cls: ClassService;
  rules: RecurrenceRule[];
  loading: boolean;
  error: string | null;
  staffList: StaffMember[];
  showAddRule: boolean;
  setShowAddRule: (v: boolean) => void;
  addRuleForm: { weekday: string; startTime: string; staffId: string; capacityOverride: string };
  setAddRuleForm: React.Dispatch<React.SetStateAction<typeof addRuleForm>>;
  addRuleSaving: boolean;
  onAddRule: () => void;
  editingRule: RecurrenceRule | null;
  editRuleForm: { weekday: string; startTime: string; staffId: string; capacityOverride: string };
  setEditRuleForm: React.Dispatch<React.SetStateAction<typeof editRuleForm>>;
  editRuleSaving: boolean;
  onEditRule: () => void;
  onOpenEditRule: (rule: RecurrenceRule) => void;
  onCancelEditRule: () => void;
  onToggleRule: (rule: RecurrenceRule) => void;
  onDeleteRule: (rule: RecurrenceRule) => void;
  onClose: () => void;
}) {
  const inputCls = "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100";

  const renderRuleForm = (
    form: typeof addRuleForm,
    setForm: React.Dispatch<React.SetStateAction<typeof addRuleForm>>,
    saving: boolean,
    onSave: () => void,
    onCancel: () => void,
    saveLabel: string,
  ) => (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-600 dark:bg-gray-700/50">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Day</label>
          <select value={form.weekday} onChange={(e) => setForm(p => ({ ...p, weekday: e.target.value }))} className={inputCls}>
            {WEEKDAYS.map(wd => <option key={wd.key} value={wd.key}>{wd.label}</option>)}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Start Time</label>
          <input type="time" value={form.startTime} onChange={(e) => setForm(p => ({ ...p, startTime: e.target.value }))} className={inputCls} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {staffList.length > 0 && (
          <div>
            <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Instructor</label>
            <select value={form.staffId} onChange={(e) => setForm(p => ({ ...p, staffId: e.target.value }))} className={inputCls}>
              <option value="">None</option>
              {staffList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Capacity Override</label>
          <input
            type="number" min="1" value={form.capacityOverride}
            onChange={(e) => setForm(p => ({ ...p, capacityOverride: e.target.value }))}
            placeholder={`Default: ${cls.max_capacity || 10}`}
            className={inputCls}
          />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} disabled={saving} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-600">
          Cancel
        </button>
        <button onClick={onSave} disabled={saving} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50">
          {saving ? 'Saving...' : saveLabel}
        </button>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Manage Schedule</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">{cls.name}</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700" aria-label="Close">
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

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
          </div>
        ) : (
          <div className="mt-5 space-y-4">
            {rules.length === 0 && !showAddRule && (
              <p className="py-4 text-center text-sm text-gray-500 dark:text-gray-400">
                No recurring schedules. Add one to start generating sessions.
              </p>
            )}

            {/* Existing rules */}
            {rules.map((rule) => (
              <div key={rule.id}>
                {editingRule?.id === rule.id ? (
                  renderRuleForm(editRuleForm, setEditRuleForm, editRuleSaving, onEditRule, onCancelEditRule, 'Update')
                ) : (
                  <div className={`flex items-center justify-between rounded-lg border p-3 ${
                    rule.is_active
                      ? 'border-gray-200 bg-white dark:border-gray-600 dark:bg-gray-700/50'
                      : 'border-gray-100 bg-gray-50 opacity-60 dark:border-gray-700 dark:bg-gray-800'
                  }`}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900 dark:text-gray-100">
                          {WEEKDAY_LABELS[rule.weekday] || rule.weekday}
                        </span>
                        <span className="text-sm text-gray-500 dark:text-gray-400">
                          {formatTime(rule.start_time)}
                        </span>
                        {!rule.is_active && (
                          <span className="rounded-full bg-gray-200 px-1.5 py-0.5 text-xs text-gray-600 dark:bg-gray-600 dark:text-gray-300">
                            Paused
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex gap-3 text-xs text-gray-500 dark:text-gray-400">
                        {rule.business_staff?.name && (
                          <span>Instructor: {rule.business_staff.name}</span>
                        )}
                        {rule.capacity_override && (
                          <span>Capacity: {rule.capacity_override}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => onOpenEditRule(rule)}
                        title="Edit"
                        className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-600 dark:hover:text-gray-300"
                      >
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => onToggleRule(rule)}
                        title={rule.is_active ? 'Pause' : 'Resume'}
                        className={`rounded p-1.5 ${
                          rule.is_active
                            ? 'text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20'
                            : 'text-green-500 hover:bg-green-50 dark:hover:bg-green-900/20'
                        }`}
                      >
                        {rule.is_active ? (
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        ) : (
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        )}
                      </button>
                      <button
                        onClick={() => onDeleteRule(rule)}
                        title="Remove"
                        className="rounded p-1.5 text-red-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                      >
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Add rule form */}
            {showAddRule && renderRuleForm(
              addRuleForm, setAddRuleForm, addRuleSaving, onAddRule,
              () => setShowAddRule(false), 'Add Schedule',
            )}

            {/* Add rule button */}
            {!showAddRule && (
              <button
                onClick={() => setShowAddRule(true)}
                disabled={!cls.is_active}
                className="flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-gray-300 py-3 text-sm font-medium text-gray-500 transition hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-400 dark:hover:border-brand dark:hover:text-brand"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Add Schedule
              </button>
            )}

            {!cls.is_active && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                This class is archived. Reactivate it to add new schedules.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Confirm Dialog (reusable) ────────────────────────

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  confirmClassName,
  loading,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  confirmClassName: string;
  loading: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800">
        <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">{title}</h3>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{message}</p>

        {error && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={loading}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={`rounded-lg px-5 py-2 text-sm font-semibold shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50 ${confirmClassName}`}
          >
            {loading ? 'Processing...' : confirmLabel}
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
