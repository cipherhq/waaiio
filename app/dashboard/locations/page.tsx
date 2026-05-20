'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { type CountryCode } from '@/lib/constants';
import { PhoneInput } from '@/components/auth/PhoneInput';

interface Location {
  id: string;
  business_id: string;
  name: string;
  address: string;
  city: string | null;
  phone: string | null;
  operating_hours: Record<string, DaySchedule>;
  is_primary: boolean;
  is_active: boolean;
  created_at: string;
}

type DaySchedule = { open: string; close: string; closed?: boolean };
type WeekSchedule = Record<string, DaySchedule>;

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const DAY_LABELS: Record<string, string> = {
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu',
  friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
};

const DEFAULT_HOURS: WeekSchedule = Object.fromEntries(
  DAYS.map(d => [d, { open: '09:00', close: '17:00', closed: d === 'sunday' }])
);

type ViewMode = 'list' | 'add' | 'edit';

export default function LocationsPage() {
  const business = useBusiness();
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<ViewMode>('list');

  // Form
  const [form, setForm] = useState({
    id: '',
    name: '',
    address: '',
    city: '',
    phone: '',
    isPrimary: false,
    isActive: true,
    hours: { ...DEFAULT_HOURS } as WeekSchedule,
  });
  const [showHours, setShowHours] = useState(false);

  const fetchLocations = useCallback(async () => {
    try {
      const res = await fetch(`/api/locations?businessId=${business.id}`);
      const data = await res.json();
      setLocations(data.locations || []);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [business.id]);

  useEffect(() => { fetchLocations(); }, [fetchLocations]);

  function openAdd() {
    setForm({ id: '', name: '', address: '', city: '', phone: '', isPrimary: false, isActive: true, hours: { ...DEFAULT_HOURS } });
    setShowHours(false);
    setView('add');
  }

  function openEdit(loc: Location) {
    setForm({
      id: loc.id,
      name: loc.name,
      address: loc.address,
      city: loc.city || '',
      phone: loc.phone || '',
      isPrimary: loc.is_primary,
      isActive: loc.is_active,
      hours: loc.operating_hours && Object.keys(loc.operating_hours).length > 0
        ? { ...DEFAULT_HOURS, ...loc.operating_hours }
        : { ...DEFAULT_HOURS },
    });
    setShowHours(false);
    setView('edit');
  }

  function updateDay(day: string, field: keyof DaySchedule, value: string | boolean) {
    setForm(prev => ({
      ...prev,
      hours: { ...prev.hours, [day]: { ...prev.hours[day], [field]: value } },
    }));
  }

  async function handleSave() {
    if (!form.name.trim() || !form.address.trim()) return;
    setSaving(true);
    try {
      const payload = {
        businessId: business.id,
        name: form.name.trim(),
        address: form.address.trim(),
        city: form.city.trim() || null,
        phone: form.phone.trim() || null,
        isPrimary: form.isPrimary,
        operatingHours: form.hours,
        ...(view === 'edit' ? { id: form.id, isActive: form.isActive } : {}),
      };
      const res = await fetch('/api/locations', {
        method: view === 'edit' ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) { alert('Failed to save location. Please try again.'); return; }
      setView('list');
      fetchLocations();
    } catch { alert('Failed to save location. Please try again.'); } finally { setSaving(false); }
  }

  async function handleToggleActive(loc: Location) {
    const res = await fetch('/api/locations', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: loc.id, businessId: business.id, isActive: !loc.is_active }),
    });
    if (!res.ok) alert('Failed to update location.');
    fetchLocations();
  }

  async function handleDelete(loc: Location) {
    if (!confirm(`Delete location "${loc.name}"?`)) return;
    const res = await fetch(`/api/locations?id=${loc.id}&businessId=${business.id}`, { method: 'DELETE' });
    if (!res.ok) alert('Failed to delete location.');
    if (view !== 'list') setView('list');
    fetchLocations();
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
    const openDays = DAYS.filter(d => !form.hours[d]?.closed).length;
    return (
      <div>
        <div className="flex items-center gap-3">
          <button aria-label="Go back" onClick={() => setView('list')} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-xl font-bold text-gray-900">{view === 'add' ? 'Add Location' : 'Edit Location'}</h1>
        </div>

        <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_280px]">
          {/* Left */}
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Location Name <span className="text-red-400">*</span></label>
              <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Main Branch" className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" autoFocus />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Address <span className="text-red-400">*</span></label>
              <input type="text" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} placeholder="Full street address" className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">City</label>
                <input type="text" value={form.city} onChange={e => setForm({ ...form, city: e.target.value })} placeholder="e.g. Lagos" className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Phone</label>
                <PhoneInput
                  value={form.phone}
                  onChange={(val) => setForm({ ...form, phone: val })}
                  countryCode={(business.country_code || 'US') as CountryCode}
                />
              </div>
            </div>

            {/* Operating Hours — collapsible */}
            <div className="rounded-xl border border-gray-100 bg-white">
              <button type="button" onClick={() => setShowHours(!showHours)} className="flex w-full items-center justify-between p-4">
                <div>
                  <p className="text-sm font-medium text-gray-800">Operating Hours</p>
                  <p className="text-xs text-gray-400">{openDays} days open</p>
                </div>
                <svg aria-hidden="true" className={`h-5 w-5 text-gray-400 transition ${showHours ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {showHours && (
                <div className="border-t border-gray-100 px-4 pb-4 pt-3 space-y-2">
                  {DAYS.map(day => {
                    const schedule = form.hours[day];
                    const isClosed = schedule?.closed ?? false;
                    return (
                      <div key={day} className="flex items-center gap-3">
                        <div className="w-10 text-xs font-semibold text-gray-700">{DAY_LABELS[day]}</div>
                        <button
                          type="button"
                          onClick={() => updateDay(day, 'closed', !isClosed)}
                          className={`relative h-6 w-11 shrink-0 rounded-full transition ${!isClosed ? 'bg-brand' : 'bg-gray-200'}`}
                        >
                          <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: !isClosed ? '22px' : '2px' }} />
                        </button>
                        {isClosed ? (
                          <span className="text-xs text-gray-400">Closed</span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <input type="time" value={schedule?.open || '09:00'} onChange={e => updateDay(day, 'open', e.target.value)} className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs outline-none focus:border-brand" />
                            <span className="text-xs text-gray-400">to</span>
                            <input type="time" value={schedule?.close || '17:00'} onChange={e => updateDay(day, 'close', e.target.value)} className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs outline-none focus:border-brand" />
                          </div>
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
            <ToggleRow label="Primary Location" description="Main branch for your business" checked={form.isPrimary} onChange={v => setForm({ ...form, isPrimary: v })} />
            {view === 'edit' && (
              <ToggleRow label="Active" description="Visible to customers" checked={form.isActive} onChange={v => setForm({ ...form, isActive: v })} />
            )}
          </div>
        </div>

        <div className="mt-6 flex gap-3 border-t border-gray-100 pt-4">
          <button onClick={handleSave} disabled={saving || !form.name.trim() || !form.address.trim()} className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50">
            {saving ? 'Saving...' : view === 'add' ? 'Add Location' : 'Save Changes'}
          </button>
          <button onClick={() => setView('list')} className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancel</button>
          {view === 'edit' && (
            <button onClick={() => { const loc = locations.find(l => l.id === form.id); if (loc) handleDelete(loc); }} className="ml-auto rounded-lg px-4 py-2.5 text-sm font-medium text-red-500 hover:bg-red-50">Delete</button>
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
          <h1 className="text-2xl font-bold text-gray-900">Locations</h1>
          <p className="mt-1 text-sm text-gray-500">Manage multiple branches and locations</p>
        </div>
        <button onClick={openAdd} className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600">+ Add Location</button>
      </div>

      {locations.length === 0 ? (
        <div className="mt-12 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-50">
            <svg aria-hidden="true" className="h-8 w-8 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          <h3 className="mt-4 text-sm font-semibold text-gray-900">No locations yet</h3>
          <p className="mt-1 text-sm text-gray-500">Add your first location to manage multiple branches.</p>
          <button onClick={openAdd} className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600">+ Add Location</button>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {locations.map(loc => (
            <div
              key={loc.id}
              onClick={() => openEdit(loc)}
              className={`cursor-pointer rounded-xl border bg-white p-5 transition hover:shadow-sm ${
                loc.is_active ? 'border-gray-200 hover:border-gray-300' : 'border-gray-100 opacity-60'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-sm font-bold text-gray-900 pr-2">{loc.name}</h3>
                {loc.is_primary && (
                  <span className="shrink-0 rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700">Primary</span>
                )}
              </div>
              <p className="mt-2 text-sm text-gray-600">{loc.address}</p>
              {loc.city && <p className="mt-1 text-sm text-gray-500">{loc.city}</p>}
              {loc.phone && <p className="mt-1 text-sm text-gray-500">{loc.phone}</p>}
              <div className="mt-4 flex items-center justify-between border-t border-gray-100 pt-3">
                <button
                  onClick={e => { e.stopPropagation(); handleToggleActive(loc); }}
                  className={`relative h-6 w-11 rounded-full transition ${loc.is_active ? 'bg-brand' : 'bg-gray-200'}`}
                >
                  <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: loc.is_active ? '22px' : '2px' }} />
                </button>
                <button
                  onClick={e => { e.stopPropagation(); handleDelete(loc); }}
                  className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-500"
                >
                  <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

function ToggleRow({ label, description, checked, onChange }: {
  label: string; description: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-gray-100 bg-white p-3">
      <div className="mr-3">
        <p className="text-sm font-medium text-gray-800">{label}</p>
        <p className="text-xs text-gray-400">{description}</p>
      </div>
      <button type="button" onClick={() => onChange(!checked)} className={`relative h-6 w-11 shrink-0 rounded-full transition ${checked ? 'bg-brand' : 'bg-gray-200'}`}>
        <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: checked ? '22px' : '2px' }} />
      </button>
    </div>
  );
}
