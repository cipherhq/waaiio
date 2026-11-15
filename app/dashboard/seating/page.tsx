'use client';

import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import Image from 'next/image';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import EmptyState from '@/components/dashboard/EmptyState';
import InternalHolds from '@/components/dashboard/seating/InternalHolds';
import { PageHelp } from '@/components/dashboard/PageHelp';

interface SeatingResource {
  id: string;
  name: string;
  resource_type: string;
  capacity: number;
  min_party_size: number;
  section: string | null;
  reservation_duration_minutes: number;
  deposit_amount: number;
  is_active: boolean;
  sort_order: number;
  description: string | null;
  available_days: string[] | null;
  available_from: string | null;
  available_to: string | null;
  gallery_urls?: string[];
}

/** Optional photos per table or section (#892; the database allows at most 3, M516). */
const MAX_PHOTOS = 3;

type ViewMode = 'list' | 'add' | 'edit';

const RESOURCE_TYPES = [
  { value: 'table', label: 'Table' },
  { value: 'booth', label: 'Booth' },
  { value: 'section', label: 'Section' },
  { value: 'vip_area', label: 'VIP Area' },
  { value: 'private_room', label: 'Private Room' },
  { value: 'bar_seat', label: 'Bar Seat' },
];

const DAYS_OF_WEEK = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

// A table's own window stays within one day (seating_no_overnight, M476/M510).
// Late-night bookings come from the business opening hours instead.
const OVERNIGHT_MESSAGE = (
  <>
    A table&apos;s own hours can&apos;t run past midnight. To take late-night bookings, leave <strong>Available From</strong> and{' '}
    <strong>Available Until</strong> empty so this table follows your business opening hours (Settings → Business → Operating Hours).
    Tables can&apos;t be booked outside your opening hours.
  </>
);

/** Empty text saves as `fallback`; anything that is not a whole number returns null. */
function parseWholeNumber(value: string, fallback: number): number | null {
  if (value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

// Number fields hold the text being typed, so a merchant can clear and retype them.
// They are parsed and checked on save.
const defaultForm = {
  name: '',
  resource_type: 'table',
  capacity: '4',
  min_party_size: '1',
  section: '',
  reservation_duration_minutes: '90',
  deposit_amount: '0',
  is_active: true,
  sort_order: 0,
  description: '',
  available_days: [] as string[],
  available_from: '',
  available_to: '',
  gallery_urls: [] as string[],
};

export default function SeatingPage() {
  const business = useBusiness();
  const country = (business.country_code || 'NG') as CountryCode;

  const [resources, setResources] = useState<SeatingResource[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>('list');
  const [saving, setSaving] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(defaultForm);
  const [error, setError] = useState<ReactNode>('');
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const loadResources = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    const { data } = await supabase
      .from('seating_resources')
      .select('*')
      .eq('business_id', business.id)
      .order('sort_order')
      .order('name');
    setResources(data || []);
    setLoading(false);
  }, [business.id]);

  useEffect(() => { loadResources(); }, [loadResources]);

  const resetForm = () => {
    setForm(defaultForm);
    setEditId(null);
    setError('');
  };

  const openAdd = () => {
    resetForm();
    setView('add');
  };

  const openEdit = (r: SeatingResource) => {
    setForm({
      name: r.name,
      resource_type: r.resource_type,
      capacity: String(r.capacity),
      min_party_size: String(r.min_party_size),
      section: r.section || '',
      reservation_duration_minutes: String(r.reservation_duration_minutes),
      deposit_amount: String(r.deposit_amount),
      is_active: r.is_active,
      sort_order: r.sort_order,
      description: r.description || '',
      available_days: r.available_days || [],
      available_from: r.available_from || '',
      available_to: r.available_to || '',
      gallery_urls: r.gallery_urls || [],
    });
    setEditId(r.id);
    setView('edit');
  };

  const handleSave = async () => {
    if (!form.name.trim()) { setError('Name is required'); return; }
    // Empty fields keep the values they used to snap back to: 1, 1, 90 and 0.
    const capacity = parseWholeNumber(form.capacity, 1);
    const minPartySize = parseWholeNumber(form.min_party_size, 1);
    const duration = parseWholeNumber(form.reservation_duration_minutes, 90);
    const deposit = parseWholeNumber(form.deposit_amount, 0);
    if (capacity === null || capacity < 1 || capacity > 500) { setError('Max capacity must be a whole number from 1 to 500'); return; }
    if (minPartySize === null || minPartySize < 1) { setError('Min party size must be a whole number of at least 1'); return; }
    if (minPartySize > capacity) { setError('Minimum party size cannot exceed capacity'); return; }
    if (duration === null || duration < 1 || duration > 480) { setError('Duration must be a whole number of minutes from 1 to 480'); return; }
    if (deposit === null || deposit < 0) { setError('Deposit must be a whole number of 0 or more'); return; }
    if (form.available_from && form.available_to && form.available_to.slice(0, 5) <= form.available_from.slice(0, 5)) {
      setError(OVERNIGHT_MESSAGE);
      return;
    }
    setSaving(true);
    setError('');

    const supabase = createClient();
    const payload = {
      business_id: business.id,
      name: form.name.trim(),
      resource_type: form.resource_type,
      capacity,
      min_party_size: minPartySize,
      section: form.section.trim() || null,
      reservation_duration_minutes: duration,
      deposit_amount: deposit,
      is_active: form.is_active,
      sort_order: form.sort_order,
      description: form.description.trim() || null,
      available_days: form.available_days.length > 0 ? form.available_days : null,
      available_from: form.available_from || null,
      available_to: form.available_to || null,
      gallery_urls: form.gallery_urls,
    };

    const { error: err } = editId
      ? await supabase.from('seating_resources').update(payload).eq('id', editId)
      : await supabase.from('seating_resources').insert(payload);
    if (err) {
      // The database check still guards a bypassed client check; show the same guidance, not the raw error.
      setError(err.code === '40001' ? 'This resource changed. Try again.'
        : err.message?.includes('seating_capacity_conflict') ? 'Capacity cannot be reduced below existing bookings and holds.'
        : err.message?.includes('seating_no_overnight') ? OVERNIGHT_MESSAGE : err.message);
      setSaving(false);
      return;
    }

    setSaving(false);
    setView('list');
    resetForm();
    loadResources();
  };

  const handlePhotoUpload = async (file: File) => {
    if (form.gallery_urls.length >= MAX_PHOTOS) return;
    setUploadingPhoto(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('business_id', business.id);
      const res = await fetch('/api/seating-resources/upload-image', { method: 'POST', body: fd });
      const json = await res.json();
      if (json.success && json.url) {
        setForm(f => ({ ...f, gallery_urls: [...f.gallery_urls, json.url].slice(0, MAX_PHOTOS) }));
      } else {
        setError(json.error || 'Photo upload failed. Please try again.');
      }
    } catch {
      setError('Photo upload failed. Please try again.');
    }
    setUploadingPhoto(false);
    if (photoInputRef.current) photoInputRef.current.value = '';
  };

  const handleArchive = async (id: string) => {
    if (!confirm('Deactivate this seating area? It will be hidden from customers but existing reservations are preserved.')) return;
    const supabase = createClient();
    await supabase.from('seating_resources').update({ is_active: false }).eq('id', id);
    loadResources();
  };

  const toggleActive = async (id: string, active: boolean) => {
    const supabase = createClient();
    await supabase.from('seating_resources').update({ is_active: active }).eq('id', id);
    loadResources();
  };

  const getTypeLabel = (type: string) => RESOURCE_TYPES.find(t => t.value === type)?.label || type;

  if (loading) {
    return <div className="p-6"><div className="animate-pulse h-8 bg-gray-200 dark:bg-gray-700 rounded w-48 mb-4" /><div className="animate-pulse h-32 bg-gray-200 dark:bg-gray-700 rounded" /></div>;
  }

  // ── Add/Edit form ──
  if (view === 'add' || view === 'edit') {
    return (
      <div className="p-6 max-w-2xl">
        <button onClick={() => { setView('list'); resetForm(); }} className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 mb-4 flex items-center gap-1">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          Back
        </button>
        <h1 className="text-2xl font-bold mb-6">{view === 'add' ? 'Add Seating' : 'Edit Seating'}</h1>

        {error && <div className="bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 p-3 rounded-lg mb-4 text-sm">{error}</div>}

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Name *</label>
            <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Table 1, VIP Booth A, Patio Section" className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700" maxLength={100} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Type</label>
              <select value={form.resource_type} onChange={e => setForm(f => ({ ...f, resource_type: e.target.value }))}
                className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700">
                {RESOURCE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Section</label>
              <input type="text" value={form.section} onChange={e => setForm(f => ({ ...f, section: e.target.value }))}
                placeholder="e.g. Indoor, Outdoor, Rooftop" className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Max Capacity</label>
              <input type="number" min={1} max={500} value={form.capacity} onChange={e => setForm(f => ({ ...f, capacity: e.target.value }))}
                className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Min Party Size</label>
              <input type="number" min={1} max={form.capacity} value={form.min_party_size} onChange={e => setForm(f => ({ ...f, min_party_size: e.target.value }))}
                className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Duration (minutes)</label>
              <input type="number" min={15} max={480} step={15} value={form.reservation_duration_minutes}
                onChange={e => setForm(f => ({ ...f, reservation_duration_minutes: e.target.value }))}
                className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Deposit ({country})</label>
              <input type="number" min={0} step={100} value={form.deposit_amount}
                onChange={e => setForm(f => ({ ...f, deposit_amount: e.target.value }))}
                className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700" />
              {Number(form.deposit_amount) > 0 && <p className="text-xs text-gray-500 mt-1">{formatCurrency(Number(form.deposit_amount), country)}</p>}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Available Days</label>
            <div className="flex flex-wrap gap-2">
              {DAYS_OF_WEEK.map(day => (
                <label key={day} className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input type="checkbox" checked={form.available_days.includes(day)}
                    onChange={e => {
                      setForm(f => ({
                        ...f,
                        available_days: e.target.checked
                          ? [...f.available_days, day]
                          : f.available_days.filter(d => d !== day),
                      }));
                    }}
                    className="rounded border-gray-300 dark:border-gray-600" />
                  {day.charAt(0).toUpperCase() + day.slice(1, 3)}
                </label>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-1">{form.available_days.length === 0 ? 'Available every day' : `${form.available_days.length} days selected`}</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Available From</label>
              <input type="time" value={form.available_from} onChange={e => setForm(f => ({ ...f, available_from: e.target.value }))}
                className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700" />
              <p className="text-xs text-gray-500 mt-1">{!form.available_from ? 'Uses business hours' : ''}</p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Available Until</label>
              <input type="time" value={form.available_to} onChange={e => setForm(f => ({ ...f, available_to: e.target.value }))}
                className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Description</label>
            <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              rows={2} placeholder="Optional notes about this seating area"
              className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700" />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Photos (optional)</label>
            <p className="text-xs text-gray-500 mb-2">Up to {MAX_PHOTOS} photos. Customers see them on WhatsApp after they pick this seating.</p>
            <input ref={photoInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" aria-label="Upload seating photo"
              onChange={e => { const file = e.target.files?.[0]; if (file) handlePhotoUpload(file); }} />
            <div className="flex gap-2">
              {form.gallery_urls.map((url, i) => (
                <div key={url} className="relative">
                  <Image src={url} alt={`Seating photo ${i + 1}`} width={80} height={80} className="h-20 w-20 rounded-lg border border-gray-200 dark:border-gray-700 object-cover" />
                  <button type="button" aria-label={`Remove photo ${i + 1}`}
                    onClick={() => setForm(f => ({ ...f, gallery_urls: f.gallery_urls.filter((_, j) => j !== i) }))}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs text-white shadow">&times;</button>
                </div>
              ))}
              {form.gallery_urls.length < MAX_PHOTOS && (
                <button type="button" aria-label="Add photo" onClick={() => photoInputRef.current?.click()} disabled={uploadingPhoto}
                  className="flex h-20 w-20 items-center justify-center rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 text-gray-400 hover:border-purple-500 hover:text-purple-600 disabled:opacity-50">
                  {uploadingPhoto ? '...' : '+'}
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input type="checkbox" id="is_active" checked={form.is_active} onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))}
              className="rounded border-gray-300 dark:border-gray-600" />
            <label htmlFor="is_active" className="text-sm">Active (visible to customers)</label>
          </div>

          <div className="flex gap-3 pt-4">
            <button onClick={handleSave} disabled={saving}
              className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50">
              {saving ? 'Saving...' : (view === 'add' ? 'Add Seating' : 'Save Changes')}
            </button>
            <button onClick={() => { setView('list'); resetForm(); }}
              className="px-4 py-2 border rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800">
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── List view ──
  return (
    <div className="p-6">
      <PageHelp
        pageKey="seating"
        title="Tables & Sections"
        description="Configure the tables, booths, VIP areas and sections customers can reserve via WhatsApp, with capacity, timing, and availability for each."
      />

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Tables & Sections</h1>
        <button onClick={openAdd}
          className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm font-medium">
          + Add Seating
        </button>
      </div>

      {resources.length === 0 ? (
        <EmptyState
          icon="M3 10h18M3 14h18M12 3v18"
          title="No seating configured"
          description="Add your tables, booths, and seating areas so customers can reserve them on WhatsApp."
          actionLabel="Add Your First Table"
          onAction={openAdd}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {resources.map(r => (
            <div key={r.id} className={`border rounded-xl p-4 ${r.is_active ? 'bg-white dark:bg-gray-900' : 'bg-gray-50 dark:bg-gray-800 opacity-60'}`}>
              <div className="flex items-start justify-between mb-2">
                <div>
                  <h3 className="font-semibold text-lg">{r.name}</h3>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
                      {getTypeLabel(r.resource_type)}
                    </span>
                    {r.section && (
                      <span className="text-xs text-gray-500">{r.section}</span>
                    )}
                  </div>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => openEdit(r)} className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" title="Edit">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                  </button>
                  {r.is_active ? (
                    <button onClick={() => handleArchive(r.id)} className="p-1.5 text-gray-400 hover:text-red-600" title="Deactivate">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
                    </button>
                  ) : (
                    <button onClick={() => toggleActive(r.id, true)} className="p-1.5 text-gray-400 hover:text-green-600" title="Reactivate">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    </button>
                  )}
                </div>
              </div>

              <div className="space-y-1 text-sm text-gray-600 dark:text-gray-400">
                <p>
                  {r.min_party_size === r.capacity
                    ? `${r.capacity} guest${r.capacity > 1 ? 's' : ''}`
                    : `${r.min_party_size}\u2013${r.capacity} guests`}
                  {' \u00b7 '}{r.reservation_duration_minutes} min
                </p>
                {r.deposit_amount > 0 && (
                  <p>Deposit: {formatCurrency(r.deposit_amount, country)}</p>
                )}
                {r.available_days && r.available_days.length > 0 && r.available_days.length < 7 && (
                  <p className="text-xs">{r.available_days.map(d => d.slice(0, 3)).join(', ')}</p>
                )}
                {r.available_from && r.available_to && (
                  <p className="text-xs">{r.available_from}\u2013{r.available_to}</p>
                )}
              </div>

              {!r.is_active && (
                <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">Inactive \u2014 hidden from customers</p>
              )}
            </div>
          ))}
        </div>
      )}
      <InternalHolds businessId={business.id} timezone={business.timezone || 'UTC'} resources={resources} />
    </div>
  );
}
