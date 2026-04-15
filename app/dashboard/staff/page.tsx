'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';

interface StaffMember {
  id: string;
  business_id: string;
  user_id: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  role: string;
  is_active: boolean;
  services: string[];
  schedule: Record<string, { start: string; end: string }> | null;
}

interface Service {
  id: string;
  name: string;
  is_active: boolean;
}

const DAYS = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
] as const;

const EMPTY_STAFF: Omit<StaffMember, 'id' | 'business_id' | 'user_id'> = {
  name: '',
  phone: null,
  email: null,
  role: 'staff',
  is_active: true,
  services: [],
  schedule: null,
};

type ViewMode = 'list' | 'add' | 'edit';

export default function StaffPage() {
  const business = useBusiness();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [businessServices, setBusinessServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>('list');
  const [saving, setSaving] = useState(false);

  // Form state
  const [form, setForm] = useState<Omit<StaffMember, 'business_id' | 'user_id'>>({ id: '', ...EMPTY_STAFF });
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [scheduleEnabled, setScheduleEnabled] = useState<Record<string, boolean>>({});
  const [showSchedule, setShowSchedule] = useState(false);

  const fetchStaff = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('business_staff')
      .select('*')
      .eq('business_id', business.id)
      .order('name', { ascending: true });
    setStaff((data as StaffMember[]) || []);
    setLoading(false);
  }, [business.id]);

  const fetchServices = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('services')
      .select('id, name, is_active')
      .eq('business_id', business.id)
      .eq('is_active', true)
      .order('name', { ascending: true });
    setBusinessServices((data as Service[]) || []);
  }, [business.id]);

  useEffect(() => { fetchStaff(); fetchServices(); }, [fetchStaff, fetchServices]);

  function openAdd() {
    setForm({ id: '', ...EMPTY_STAFF });
    setFirstName('');
    setLastName('');
    setScheduleEnabled({});
    setShowSchedule(false);
    setView('add');
  }

  function openEdit(member: StaffMember) {
    setForm({ ...member });
    const parts = member.name.split(' ');
    setFirstName(parts[0] || '');
    setLastName(parts.slice(1).join(' ') || '');
    const enabled: Record<string, boolean> = {};
    if (member.schedule) {
      for (const day of DAYS) {
        if (member.schedule[day.key]) enabled[day.key] = true;
      }
    }
    setScheduleEnabled(enabled);
    setShowSchedule(!!member.schedule && Object.keys(member.schedule).length > 0);
    setView('edit');
  }

  function toggleDay(dayKey: string) {
    const nowEnabled = !scheduleEnabled[dayKey];
    setScheduleEnabled(prev => ({ ...prev, [dayKey]: nowEnabled }));
    if (nowEnabled) {
      const current = form.schedule || {};
      setForm({ ...form, schedule: { ...current, [dayKey]: { start: '09:00', end: '17:00' } } });
    } else {
      const current = { ...(form.schedule || {}) };
      delete current[dayKey];
      setForm({ ...form, schedule: Object.keys(current).length > 0 ? current : null });
    }
  }

  function updateDayTime(dayKey: string, field: 'start' | 'end', value: string) {
    const current = form.schedule || {};
    const daySchedule = current[dayKey] || { start: '09:00', end: '17:00' };
    setForm({ ...form, schedule: { ...current, [dayKey]: { ...daySchedule, [field]: value } } });
  }

  function toggleService(serviceName: string) {
    const current = form.services || [];
    if (current.includes(serviceName)) {
      setForm({ ...form, services: current.filter(s => s !== serviceName) });
    } else {
      setForm({ ...form, services: [...current, serviceName] });
    }
  }

  async function handleSave() {
    if (!firstName.trim()) return;
    setSaving(true);
    const fullName = lastName.trim() ? `${firstName.trim()} ${lastName.trim()}` : firstName.trim();
    const payload = {
      business_id: business.id,
      name: fullName,
      phone: form.phone || null,
      email: form.email || null,
      role: form.role,
      is_active: form.is_active,
      services: form.services,
      schedule: form.schedule,
    };

    try {
      if (view === 'add') {
        await fetch('/api/staff', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } else {
        await fetch('/api/staff', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: form.id, ...payload }),
        });
      }
    } catch (err) {
      console.error(err);
    }
    setSaving(false);
    setView('list');
    fetchStaff();
  }

  async function handleDelete(staffId: string) {
    if (!confirm('Delete this staff member?')) return;
    try {
      await fetch('/api/staff', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffId }),
      });
    } catch (err) {
      console.error(err);
    }
    setView('list');
    fetchStaff();
  }

  async function toggleActive(member: StaffMember) {
    const supabase = createClient();
    await supabase.from('business_staff').update({ is_active: !member.is_active }).eq('id', member.id);
    fetchStaff();
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  // ═══════════ ADD / EDIT VIEW ═══════════
  if (view === 'add' || view === 'edit') {
    return (
      <div>
        <div className="flex items-center gap-3">
          <button onClick={() => setView('list')} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-xl font-bold text-gray-900">
            {view === 'add' ? 'Add Staff Member' : 'Edit Staff Member'}
          </h1>
        </div>

        <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_280px]">
          {/* Left: Main fields */}
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">First Name <span className="text-red-400">*</span></label>
                <input
                  type="text"
                  value={firstName}
                  onChange={e => setFirstName(e.target.value)}
                  placeholder="First name"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
                  autoFocus
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Last Name</label>
                <input
                  type="text"
                  value={lastName}
                  onChange={e => setLastName(e.target.value)}
                  placeholder="Last name"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Phone</label>
                <input
                  type="tel"
                  value={form.phone || ''}
                  onChange={e => setForm({ ...form, phone: e.target.value })}
                  placeholder="+234..."
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Email</label>
                <input
                  type="email"
                  value={form.email || ''}
                  onChange={e => setForm({ ...form, email: e.target.value })}
                  placeholder="email@example.com"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Role</label>
              <select
                value={form.role}
                onChange={e => setForm({ ...form, role: e.target.value })}
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
              >
                <option value="staff">Staff</option>
                <option value="manager">Manager</option>
              </select>
            </div>

            {/* Services */}
            {businessServices.length > 0 && (
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700">Services</label>
                <div className="flex flex-wrap gap-2">
                  {businessServices.map(svc => {
                    const selected = form.services?.includes(svc.name);
                    return (
                      <button
                        key={svc.id}
                        type="button"
                        onClick={() => toggleService(svc.name)}
                        className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                          selected
                            ? 'border-brand bg-brand-50 text-brand'
                            : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                        }`}
                      >
                        {selected && '✓ '}{svc.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Schedule — collapsible */}
            <div className="rounded-xl border border-gray-100 bg-white">
              <button
                type="button"
                onClick={() => setShowSchedule(!showSchedule)}
                className="flex w-full items-center justify-between p-4"
              >
                <div>
                  <p className="text-sm font-medium text-gray-800">Work Schedule</p>
                  <p className="text-xs text-gray-400">
                    {Object.keys(scheduleEnabled).filter(k => scheduleEnabled[k]).length > 0
                      ? `${Object.keys(scheduleEnabled).filter(k => scheduleEnabled[k]).length} days set`
                      : 'No schedule set (available anytime)'}
                  </p>
                </div>
                <svg className={`h-5 w-5 text-gray-400 transition ${showSchedule ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {showSchedule && (
                <div className="border-t border-gray-100 px-4 pb-4 pt-3 space-y-2">
                  {DAYS.map(day => {
                    const enabled = scheduleEnabled[day.key] || false;
                    const daySchedule = form.schedule?.[day.key];
                    return (
                      <div key={day.key} className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => toggleDay(day.key)}
                          className={`w-12 rounded-md py-1.5 text-center text-xs font-semibold transition ${
                            enabled ? 'bg-brand text-white' : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                          }`}
                        >
                          {day.label}
                        </button>
                        {enabled ? (
                          <div className="flex items-center gap-2">
                            <input
                              type="time"
                              value={daySchedule?.start || '09:00'}
                              onChange={e => updateDayTime(day.key, 'start', e.target.value)}
                              className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs outline-none focus:border-brand"
                            />
                            <span className="text-xs text-gray-400">to</span>
                            <input
                              type="time"
                              value={daySchedule?.end || '17:00'}
                              onChange={e => updateDayTime(day.key, 'end', e.target.value)}
                              className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs outline-none focus:border-brand"
                            />
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">Day off</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right: Settings */}
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Settings</p>
            <div className="flex items-center justify-between rounded-lg border border-gray-100 bg-white p-3">
              <div className="mr-3">
                <p className="text-sm font-medium text-gray-800">Active</p>
                <p className="text-xs text-gray-400">Available for bookings</p>
              </div>
              <button
                type="button"
                onClick={() => setForm({ ...form, is_active: !form.is_active })}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${form.is_active ? 'bg-brand' : 'bg-gray-200'}`}
              >
                <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: form.is_active ? '22px' : '2px' }} />
              </button>
            </div>

            <div className="rounded-lg border border-gray-100 bg-white p-3">
              <p className="text-sm font-medium text-gray-800">Role: {form.role === 'manager' ? 'Manager' : 'Staff'}</p>
              <p className="text-xs text-gray-400 mt-0.5">
                {form.role === 'manager' ? 'Can manage business settings' : 'Can serve customers'}
              </p>
            </div>

            {form.services.length > 0 && (
              <div className="rounded-lg border border-gray-100 bg-white p-3">
                <p className="text-xs font-medium text-gray-500 mb-1.5">Assigned Services</p>
                <div className="flex flex-wrap gap-1">
                  {form.services.map(s => (
                    <span key={s} className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand">{s}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Save / Cancel / Delete */}
        <div className="mt-6 flex gap-3 border-t border-gray-100 pt-4">
          <button
            onClick={handleSave}
            disabled={saving || !firstName.trim()}
            className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {saving ? 'Saving...' : view === 'add' ? 'Add Staff' : 'Save Changes'}
          </button>
          <button
            onClick={() => setView('list')}
            className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          {view === 'edit' && form.id && (
            <button
              onClick={() => handleDelete(form.id)}
              className="ml-auto rounded-lg px-4 py-2.5 text-sm font-medium text-red-500 hover:bg-red-50"
            >
              Delete
            </button>
          )}
        </div>
      </div>
    );
  }

  // ═══════════ LIST VIEW ═══════════
  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Staff</h1>
          <p className="mt-1 text-sm text-gray-500">Manage your team members and their schedules</p>
        </div>
        <button onClick={openAdd} className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600">
          + Add Staff
        </button>
      </div>

      {staff.length === 0 ? (
        <div className="mt-12 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-50">
            <svg className="h-8 w-8 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
          </div>
          <h3 className="mt-4 text-sm font-semibold text-gray-900">No staff members yet</h3>
          <p className="mt-1 text-sm text-gray-500">Add your first team member to manage schedules and services.</p>
          <button onClick={openAdd} className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600">
            + Add Staff
          </button>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {staff.map(member => (
            <div
              key={member.id}
              onClick={() => openEdit(member)}
              className={`cursor-pointer rounded-xl border bg-white p-5 transition hover:shadow-sm ${
                member.is_active ? 'border-gray-100 hover:border-gray-200' : 'border-gray-100 opacity-60'
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-sm font-semibold text-gray-900">{member.name}</h3>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                      member.role === 'manager' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
                    }`}>
                      {member.role}
                    </span>
                  </div>
                  {!member.is_active && (
                    <span className="mt-1 inline-block rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-500">Inactive</span>
                  )}
                </div>
              </div>

              <div className="mt-3 space-y-1">
                {member.phone && (
                  <p className="text-xs text-gray-500">{member.phone}</p>
                )}
                {member.email && (
                  <p className="truncate text-xs text-gray-500">{member.email}</p>
                )}
              </div>

              {member.services && member.services.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {member.services.map(svc => (
                    <span key={svc} className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand">{svc}</span>
                  ))}
                </div>
              )}

              <div className="mt-4 flex items-center justify-between border-t border-gray-50 pt-3">
                <button
                  onClick={e => { e.stopPropagation(); toggleActive(member); }}
                  className={`relative h-6 w-11 rounded-full transition ${member.is_active ? 'bg-brand' : 'bg-gray-200'}`}
                >
                  <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: member.is_active ? '22px' : '2px' }} />
                </button>
                <button
                  onClick={e => { e.stopPropagation(); handleDelete(member.id); }}
                  className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-500"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
