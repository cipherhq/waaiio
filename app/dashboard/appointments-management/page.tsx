'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, type CountryCode, CATEGORY_LABELS } from '@/lib/constants';
import EmptyState from '@/components/dashboard/EmptyState';
import { PageHelp } from '@/components/dashboard/PageHelp';
import { Tooltip } from '@/components/dashboard/Tooltip';
import { FIELD_TOOLTIPS } from '@/lib/tooltips';

interface Appointment {
  id: string;
  name: string;
  description: string | null;
  price: number;
  price_is_variable: boolean;
  duration_minutes: number;
  buffer_minutes: number;
  deposit_amount: number;
  max_capacity: number;
  requires_staff: boolean;
  staff_ids: string[];
  allow_staff_selection: boolean;
  is_active: boolean;
  auto_approve: boolean;
  sort_order: number;
  image_url: string | null;
  available_days: string[];
  available_from: string | null;
  available_to: string | null;
  metadata: Record<string, unknown>;
}

interface StaffMember {
  id: string;
  name: string;
  is_active: boolean;
}

type ViewMode = 'list' | 'add' | 'edit';

export default function AppointmentsManagementPage() {
  const business = useBusiness();
  const country = (business.country_code || 'NG') as CountryCode;
  const labels = CATEGORY_LABELS[business.category as keyof typeof CATEGORY_LABELS];
  const apptLabel = labels?.appointmentName || 'Appointment';
  const apptLabelPlural = labels?.appointmentNamePlural || 'Appointments';

  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>('list');
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    id: '',
    name: '',
    description: '',
    price: 0,
    price_is_variable: false,
    duration_minutes: 30,
    buffer_minutes: 0,
    deposit_amount: 0,
    max_capacity: 1,
    requires_staff: false,
    staff_ids: [] as string[],
    allow_staff_selection: false,
    is_active: true,
    auto_approve: true,
    available_days: [] as string[],
    available_from: '' as string,
    available_to: '' as string,
    metadata: {} as Record<string, unknown>,
  });

  const loadData = useCallback(async () => {
    const supabase = createClient();
    const [{ data: appts }, { data: staffData }] = await Promise.all([
      supabase.from('appointments').select('*').eq('business_id', business.id).order('sort_order'),
      supabase.from('business_staff').select('id, name, is_active').eq('business_id', business.id).eq('is_active', true).order('name'),
    ]);
    setAppointments((appts || []) as Appointment[]);
    setStaff((staffData || []) as StaffMember[]);
    setLoading(false);
  }, [business.id]);

  useEffect(() => { loadData(); }, [loadData]);

  function openAdd() {
    setForm({
      id: '', name: '', description: '', price: 0, price_is_variable: false,
      duration_minutes: 30, buffer_minutes: 0, deposit_amount: 0, max_capacity: 1,
      requires_staff: false, staff_ids: [], allow_staff_selection: false, is_active: true, auto_approve: true,
      available_days: [], available_from: '', available_to: '', metadata: {},
    });
    setView('add');
  }

  function openEdit(a: Appointment) {
    setForm({
      id: a.id, name: a.name, description: a.description || '', price: a.price,
      price_is_variable: a.price_is_variable, duration_minutes: a.duration_minutes,
      buffer_minutes: a.buffer_minutes ?? 0,
      deposit_amount: a.deposit_amount, max_capacity: a.max_capacity ?? 1,
      requires_staff: a.requires_staff, staff_ids: a.staff_ids || [],
      allow_staff_selection: a.allow_staff_selection, is_active: a.is_active, auto_approve: a.auto_approve !== false,
      available_days: a.available_days || [],
      available_from: a.available_from || '',
      available_to: a.available_to || '',
      metadata: (a as any).metadata || {},
    });
    setView('edit');
  }

  async function handleSave() {
    if (!form.name.trim()) return;
    setSaving(true);
    const supabase = createClient();
    const payload = {
      business_id: business.id,
      name: form.name.trim(),
      description: form.description.trim() || null,
      price: form.price,
      price_is_variable: form.price_is_variable,
      duration_minutes: form.duration_minutes,
      buffer_minutes: form.buffer_minutes,
      deposit_amount: form.deposit_amount,
      max_capacity: form.max_capacity,
      requires_staff: form.requires_staff,
      staff_ids: form.requires_staff ? form.staff_ids : [],
      allow_staff_selection: form.requires_staff ? form.allow_staff_selection : false,
      is_active: form.is_active,
      auto_approve: form.auto_approve,
      available_days: form.available_days,
      available_from: form.available_from || null,
      available_to: form.available_to || null,
      metadata: form.metadata,
    };

    if (view === 'add') {
      await supabase.from('appointments').insert({ ...payload, sort_order: appointments.length });
    } else {
      await supabase.from('appointments').update(payload).eq('id', form.id);
    }

    setSaving(false);
    setView('list');
    loadData();
  }

  async function handleDelete(id: string) {
    if (!confirm(`Delete this ${apptLabel.toLowerCase()}?`)) return;
    const supabase = createClient();
    await supabase.from('appointments').delete().eq('id', id);
    if (view !== 'list') setView('list');
    loadData();
  }

  function toggleStaff(staffId: string) {
    setForm(f => ({
      ...f,
      staff_ids: f.staff_ids.includes(staffId)
        ? f.staff_ids.filter(s => s !== staffId)
        : [...f.staff_ids, staffId],
    }));
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  // ═══════════ ADD / EDIT ═══════════
  if (view === 'add' || view === 'edit') {
    return (
      <div>
        <div className="flex items-center gap-3">
          <button aria-label="Go back" onClick={() => setView('list')} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-xl font-bold text-gray-900">
            {view === 'add' ? `Add ${apptLabel}` : `Edit ${apptLabel}`}
          </h1>
        </div>

        <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_280px]">
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">{apptLabel} Name <span className="text-red-400">*</span></label>
              <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder={labels?.namePlaceholder || 'e.g. Consultation, Haircut'}
                className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" autoFocus />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Description</label>
              <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
                rows={2} placeholder="What does this appointment include?"
                className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Price</label>
                <input type="number" min={0} value={form.price || ''} onChange={e => setForm({ ...form, price: Number(e.target.value) })}
                  placeholder="0 = Free"
                  className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Duration (min)</label>
                <input type="number" min={5} step={5} value={form.duration_minutes || ''} onChange={e => setForm({ ...form, duration_minutes: Number(e.target.value) })}
                  className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Deposit</label>
                <input type="number" min={0} value={form.deposit_amount || ''} onChange={e => setForm({ ...form, deposit_amount: Number(e.target.value) })}
                  placeholder="Enter amount"
                  className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" />
                <p className="mt-1 text-xs text-gray-400">Amount collected upfront. Balance due at appointment.</p>
              </div>
            </div>

            {/* Drop-off Service */}
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm font-medium text-gray-700">Drop-off Service <Tooltip text={"A drop-off service is when customers bring in an item and leave it with you for processing — like wig revamps, laundry, phone repairs, or tailoring. There's no appointment time needed. The customer pays upfront, drops off their item, and picks it up when it's ready."} /></p>
                <p className="text-xs text-gray-400">Customer drops off an item for processing — no appointment needed</p>
              </div>
              <button type="button" onClick={() => setForm({ ...form, metadata: { ...form.metadata, is_dropoff: !(form.metadata?.is_dropoff as boolean) } })}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${(form.metadata?.is_dropoff as boolean) ? 'bg-brand' : 'bg-gray-200'}`}>
                <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: (form.metadata?.is_dropoff as boolean) ? '22px' : '2px' }} />
              </button>
            </div>
            {(form.metadata?.is_dropoff as boolean) && (
              <div className="ml-1 pb-2">
                <p className="text-xs text-gray-500 mb-1">Turnaround time (days)</p>
                <input type="number" min={1} step={1} value={(form.metadata?.turnaround_days as number) || ''}
                  onChange={(e) => setForm({ ...form, metadata: { ...form.metadata, turnaround_days: Number(e.target.value) || null } })}
                  placeholder="e.g. 3" className="w-32 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
                <span className="ml-2 text-xs text-gray-400">days until ready</span>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="mb-1 flex items-center gap-1.5 text-sm font-medium text-gray-700">
                  Buffer time (min)
                  <Tooltip text={FIELD_TOOLTIPS['service.buffer']} />
                </label>
                <input type="number" min={0} step={5} value={form.buffer_minutes || ''}
                  onChange={e => setForm({ ...form, buffer_minutes: e.target.value === '' ? 0 : Number(e.target.value) })}
                  placeholder="Enter amount"
                  className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" />
                <p className="mt-1 text-xs text-gray-400">Minutes between appointments for cleanup or breaks</p>
              </div>
              <div>
                <label className="mb-1 flex items-center gap-1.5 text-sm font-medium text-gray-700">
                  Max Capacity
                  <Tooltip text={FIELD_TOOLTIPS['service.max_capacity']} />
                </label>
                <input type="number" min={1} value={form.max_capacity || ''}
                  onChange={e => setForm({ ...form, max_capacity: Number(e.target.value) })}
                  placeholder="1"
                  className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" />
              </div>
            </div>

            {/* Available Days */}
            <div>
              <label className="mb-2 flex items-center gap-1.5 text-sm font-medium text-gray-700">
                Available Days
                <Tooltip text={FIELD_TOOLTIPS['service.available_days']} />
              </label>
              <div className="flex flex-wrap gap-2">
                {(['monday','tuesday','wednesday','thursday','friday','saturday','sunday'] as const).map(day => {
                  const selected = form.available_days.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      onClick={() => setForm(f => ({
                        ...f,
                        available_days: selected
                          ? f.available_days.filter(d => d !== day)
                          : [...f.available_days, day],
                      }))}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                        selected
                          ? 'border-brand bg-brand-50 text-brand'
                          : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                      }`}
                    >
                      {day.charAt(0).toUpperCase() + day.slice(1, 3)}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-xs text-gray-400">
                {form.available_days.length === 0 ? 'Empty = all days available' : `${form.available_days.length} day${form.available_days.length === 1 ? '' : 's'} selected`}
              </p>
            </div>

            {/* Available Hours */}
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">Available Hours</label>
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <label className="mb-1 block text-xs text-gray-500">From</label>
                  <input
                    type="time"
                    value={form.available_from}
                    onChange={e => setForm({ ...form, available_from: e.target.value })}
                    className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand"
                  />
                </div>
                <span className="mt-5 text-gray-400">–</span>
                <div className="flex-1">
                  <label className="mb-1 block text-xs text-gray-500">To</label>
                  <input
                    type="time"
                    value={form.available_to}
                    onChange={e => setForm({ ...form, available_to: e.target.value })}
                    className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand"
                  />
                </div>
              </div>
              <p className="mt-1.5 text-xs text-gray-400">Leave empty to follow business operating hours</p>
            </div>

            {/* Variable Pricing */}
            <div className="flex items-center justify-between rounded-lg border border-gray-100 bg-white p-3">
              <div className="mr-3">
                <label className="flex items-center gap-1.5 text-sm font-medium text-gray-800">
                  Variable pricing
                  <Tooltip text={FIELD_TOOLTIPS['service.variable_price']} />
                </label>
                <p className="text-xs text-gray-400">Starting price — final amount may vary</p>
              </div>
              <button
                type="button"
                onClick={() => setForm({ ...form, price_is_variable: !form.price_is_variable })}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${form.price_is_variable ? 'bg-brand' : 'bg-gray-200'}`}
              >
                <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: form.price_is_variable ? '22px' : '2px' }} />
              </button>
            </div>

            {/* Staff Assignment */}
            {staff.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-gray-700">Staff Assignment</label>
                  <button type="button" onClick={() => setForm({ ...form, requires_staff: !form.requires_staff })}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition ${form.requires_staff ? 'bg-brand' : 'bg-gray-200'}`}>
                    <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: form.requires_staff ? '22px' : '2px' }} />
                  </button>
                </div>
                {form.requires_staff && (
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-2">
                      {staff.map(s => {
                        const selected = form.staff_ids.includes(s.id);
                        return (
                          <button key={s.id} type="button" onClick={() => toggleStaff(s.id)}
                            className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                              selected ? 'border-brand bg-brand-50 text-brand' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                            }`}>
                            {selected && '✓ '}{s.name}
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-xs text-gray-400">
                      {form.staff_ids.length === 0 ? 'All staff can handle this appointment' : `${form.staff_ids.length} staff selected`}
                    </p>
                    <div className="flex items-center gap-2">
                      <input type="checkbox" checked={form.allow_staff_selection}
                        onChange={e => setForm({ ...form, allow_staff_selection: e.target.checked })}
                        className="rounded border-gray-300" />
                      <span className="text-xs text-gray-600">Allow customers to choose their staff</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right: Settings */}
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Settings</p>
            <div className="flex items-center justify-between rounded-lg border border-gray-100 bg-white p-3">
              <div className="mr-3">
                <p className="text-sm font-medium text-gray-800">Active</p>
                <p className="text-xs text-gray-400">Available for booking</p>
              </div>
              <button type="button" onClick={() => setForm({ ...form, is_active: !form.is_active })}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${form.is_active ? 'bg-brand' : 'bg-gray-200'}`}>
                <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: form.is_active ? '22px' : '2px' }} />
              </button>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-gray-100 bg-white p-3">
              <div className="mr-3">
                <p className="text-sm font-medium text-gray-800">Auto-approve</p>
                <p className="text-xs text-gray-400">Confirm bookings instantly</p>
              </div>
              <button type="button" onClick={() => setForm({ ...form, auto_approve: !form.auto_approve })}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${form.auto_approve ? 'bg-brand' : 'bg-gray-200'}`}>
                <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: form.auto_approve ? '22px' : '2px' }} />
              </button>
            </div>

            <div className="rounded-lg border border-gray-100 bg-white p-3 space-y-1">
              <p className="text-xs font-medium text-gray-500">Summary</p>
              <p className="text-sm text-gray-800">{form.price > 0 ? formatCurrency(form.price, country) : 'Free'}</p>
              <p className="text-xs text-gray-500">{form.duration_minutes} minutes</p>
              {form.deposit_amount > 0 && <p className="text-xs text-gray-500">Deposit: {formatCurrency(form.deposit_amount, country)}</p>}
              {form.requires_staff && <p className="text-xs text-gray-500">Staff: {form.staff_ids.length || 'Any'}</p>}
            </div>
          </div>
        </div>

        <div className="mt-6 flex gap-3 border-t border-gray-100 pt-4">
          <button onClick={handleSave} disabled={saving || !form.name.trim()}
            className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50">
            {saving ? 'Saving...' : view === 'add' ? `Add ${apptLabel}` : 'Save Changes'}
          </button>
          <button onClick={() => setView('list')}
            className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancel</button>
          {view === 'edit' && form.id && (
            <button onClick={() => handleDelete(form.id)}
              className="ml-auto rounded-lg px-4 py-2.5 text-sm font-medium text-red-500 hover:bg-red-50">Delete</button>
          )}
        </div>
      </div>
    );
  }

  // ═══════════ LIST ═══════════
  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{apptLabelPlural}</h1>
          <p className="mt-1 text-sm text-gray-500">Manage your bookable {apptLabelPlural.toLowerCase()} with date, time, and staff</p>
        </div>
        <button onClick={openAdd} className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600">
          + Add {apptLabel}
        </button>
      </div>

      <PageHelp
        pageKey="appointments"
        title="Your Appointments"
        description="These are the bookable time slots your customers see on WhatsApp. Set the duration, price, and available days. Customers pick a date, time, and staff member to book."
      />

      {appointments.length === 0 ? (
        <EmptyState
          icon="📅"
          title="No appointments yet"
          description="Add bookable appointments with date, time, and staff options. Customers will see these when they message your WhatsApp number."
          actionLabel="Add your first appointment"
          onAction={openAdd}
          tip="Include the duration and price — customers will see this when booking."
        />
      ) : (
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {appointments.map(a => (
            <div key={a.id} onClick={() => openEdit(a)}
              className={`cursor-pointer rounded-xl border bg-white p-5 transition hover:shadow-sm ${
                a.is_active ? 'border-gray-100 hover:border-gray-200' : 'border-gray-100 opacity-60'
              }`}>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-900">{a.name}</h3>
                <span className="text-xs text-gray-400">{a.duration_minutes}min</span>
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-lg font-bold text-gray-900">{a.price > 0 ? formatCurrency(a.price, country) : 'Free'}</span>
              </div>
              {a.deposit_amount > 0 && (
                <p className="mt-1 text-xs text-gray-500">Deposit: {formatCurrency(a.deposit_amount, country)}</p>
              )}
              {a.requires_staff && (
                <p className="mt-1 text-xs text-gray-400">Staff assigned</p>
              )}
              {!a.is_active && (
                <span className="mt-2 inline-block rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-500">Inactive</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
