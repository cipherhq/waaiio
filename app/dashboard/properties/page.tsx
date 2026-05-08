'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, type CountryCode, CATEGORY_LABELS } from '@/lib/constants';

interface Property {
  id: string;
  name: string;
  description: string | null;
  property_type: string;
  price: number;
  price_is_variable: boolean;
  deposit_amount: number;
  max_guests: number;
  bedrooms: number;
  bathrooms: number;
  amenities: string[];
  photos: string[];
  address: string | null;
  is_active: boolean;
  sort_order: number;
}

type ViewMode = 'list' | 'add' | 'edit';

const AMENITY_OPTIONS = [
  'WiFi', 'Air Conditioning', 'Parking', 'Pool', 'Kitchen', 'Washer/Dryer',
  'TV', 'Hot Water', 'Security', 'Generator', 'Gym', 'Balcony',
];

const PROPERTY_TYPES: Record<string, string[]> = {
  shortlet: ['studio', 'apartment', 'flat', 'villa', 'duplex', 'penthouse'],
  hotel: ['room', 'suite', 'deluxe', 'executive', 'presidential'],
  car_rental: ['sedan', 'suv', 'van', 'bus', 'pickup', 'luxury'],
};

export default function PropertiesPage() {
  const business = useBusiness();
  const country = (business.country_code || 'NG') as CountryCode;
  const labels = CATEGORY_LABELS[business.category as keyof typeof CATEGORY_LABELS];
  const propertyLabel = labels?.propertyName || 'Property';
  const propertyLabelPlural = labels?.propertyNamePlural || 'Properties';
  const types = PROPERTY_TYPES[business.category] || PROPERTY_TYPES.shortlet;

  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>('list');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<string[]>([]);

  const [form, setForm] = useState({
    id: '',
    name: '',
    description: '',
    property_type: types[0] || 'apartment',
    price: 0,
    deposit_amount: 0,
    max_guests: 1,
    bedrooms: 0,
    bathrooms: 0,
    amenities: [] as string[],
    address: '',
    is_active: true,
  });

  const loadProperties = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('properties')
      .select('*')
      .eq('business_id', business.id)
      .order('sort_order');
    setProperties((data || []) as Property[]);
    setLoading(false);
  }, [business.id]);

  useEffect(() => { loadProperties(); }, [loadProperties]);

  async function handlePhotoUpload(file: File) {
    if (photos.length >= 5) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('business_id', business.id);
      const res = await fetch('/api/services/upload-image', { method: 'POST', body: fd });
      const json = await res.json();
      if (json.success && json.url) {
        setPhotos(prev => [...prev, json.url]);
      }
    } catch { /* silent */ }
    setUploading(false);
    if (photoInputRef.current) photoInputRef.current.value = '';
  }

  function openAdd() {
    setForm({
      id: '', name: '', description: '', property_type: types[0] || 'apartment',
      price: 0, deposit_amount: 0, max_guests: 1, bedrooms: 0, bathrooms: 0,
      amenities: [], address: '', is_active: true,
    });
    setPhotos([]);
    setView('add');
  }

  function openEdit(p: Property) {
    setForm({
      id: p.id, name: p.name, description: p.description || '',
      property_type: p.property_type, price: p.price, deposit_amount: p.deposit_amount,
      max_guests: p.max_guests, bedrooms: p.bedrooms, bathrooms: p.bathrooms,
      amenities: p.amenities || [], address: p.address || '', is_active: p.is_active,
    });
    setPhotos(p.photos || []);
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
      property_type: form.property_type,
      price: form.price,
      deposit_amount: form.deposit_amount,
      max_guests: form.max_guests,
      bedrooms: form.bedrooms,
      bathrooms: form.bathrooms,
      amenities: form.amenities,
      photos,
      address: form.address.trim() || null,
      is_active: form.is_active,
    };

    if (view === 'add') {
      await supabase.from('properties').insert({ ...payload, sort_order: properties.length });
    } else {
      await supabase.from('properties').update(payload).eq('id', form.id);
    }

    setSaving(false);
    setView('list');
    loadProperties();
  }

  async function handleDelete(id: string) {
    if (!confirm(`Delete this ${propertyLabel.toLowerCase()}?`)) return;
    const supabase = createClient();
    await supabase.from('properties').delete().eq('id', id);
    if (view !== 'list') setView('list');
    loadProperties();
  }

  function toggleAmenity(amenity: string) {
    setForm(f => ({
      ...f,
      amenities: f.amenities.includes(amenity)
        ? f.amenities.filter(a => a !== amenity)
        : [...f.amenities, amenity],
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
          <button onClick={() => setView('list')} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-xl font-bold text-gray-900">
            {view === 'add' ? `Add ${propertyLabel}` : `Edit ${propertyLabel}`}
          </h1>
        </div>

        <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_280px]">
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">{propertyLabel} Name <span className="text-red-400">*</span></label>
              <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder={labels?.namePlaceholder || `e.g. Studio Apartment`}
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand" autoFocus />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Description</label>
              <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
                rows={2} placeholder="Describe this property..."
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand" />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Nightly Rate</label>
                <input type="number" min={0} value={form.price || ''} onChange={e => setForm({ ...form, price: Number(e.target.value) })}
                  placeholder="0 = Free"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Deposit</label>
                <input type="number" min={0} value={form.deposit_amount || ''} onChange={e => setForm({ ...form, deposit_amount: Number(e.target.value) })}
                  placeholder="0"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Max Guests</label>
                <input type="number" min={1} value={form.max_guests} onChange={e => setForm({ ...form, max_guests: Number(e.target.value) })}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand" />
              </div>
            </div>

            {business.category !== 'car_rental' && (
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Type</label>
                  <select value={form.property_type} onChange={e => setForm({ ...form, property_type: e.target.value })}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand capitalize">
                    {types.map(t => <option key={t} value={t} className="capitalize">{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Bedrooms</label>
                  <input type="number" min={0} value={form.bedrooms || ''} onChange={e => setForm({ ...form, bedrooms: Number(e.target.value) })}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand" />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Bathrooms</label>
                  <input type="number" min={0} value={form.bathrooms || ''} onChange={e => setForm({ ...form, bathrooms: Number(e.target.value) })}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand" />
                </div>
              </div>
            )}

            {/* Amenities */}
            {business.category !== 'car_rental' && (
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700">Amenities</label>
                <div className="flex flex-wrap gap-2">
                  {AMENITY_OPTIONS.map(a => {
                    const selected = form.amenities.includes(a);
                    return (
                      <button key={a} type="button" onClick={() => toggleAmenity(a)}
                        className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                          selected ? 'border-brand bg-brand-50 text-brand' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                        }`}>
                        {selected && '✓ '}{a}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Address / Location</label>
              <input type="text" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })}
                placeholder="e.g. 5 Marina Drive, Lekki"
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand" />
            </div>

            {/* Photos */}
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">Photos (max 5)</label>
              <input ref={photoInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handlePhotoUpload(f); }} />
              <div className="flex flex-wrap gap-3">
                {photos.map((url, i) => (
                  <div key={i} className="group relative h-24 w-24 overflow-hidden rounded-lg border border-gray-200">
                    <img src={url} alt="" className="h-full w-full object-cover" />
                    <button type="button" onClick={() => setPhotos(photos.filter((_, j) => j !== i))}
                      className="absolute right-1 top-1 hidden rounded-full bg-black/50 p-1 text-white group-hover:block">
                      <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
                {photos.length < 5 && (
                  <button type="button" onClick={() => photoInputRef.current?.click()} disabled={uploading}
                    className="flex h-24 w-24 items-center justify-center rounded-lg border-2 border-dashed border-gray-200 text-gray-400 hover:border-brand hover:text-brand disabled:opacity-50">
                    {uploading ? (
                      <div className="h-5 w-5 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                    ) : (
                      <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                      </svg>
                    )}
                  </button>
                )}
              </div>
            </div>
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

            {/* Summary card */}
            <div className="rounded-lg border border-gray-100 bg-white p-3 space-y-1">
              <p className="text-xs font-medium text-gray-500">Summary</p>
              <p className="text-sm text-gray-800">{formatCurrency(form.price, country)}/night</p>
              {form.deposit_amount > 0 && <p className="text-xs text-gray-500">Deposit: {formatCurrency(form.deposit_amount, country)}</p>}
              <p className="text-xs text-gray-500">{form.max_guests} guest{form.max_guests !== 1 ? 's' : ''} max</p>
              {form.bedrooms > 0 && <p className="text-xs text-gray-500">{form.bedrooms} bed · {form.bathrooms} bath</p>}
            </div>
          </div>
        </div>

        <div className="mt-6 flex gap-3 border-t border-gray-100 pt-4">
          <button onClick={handleSave} disabled={saving || !form.name.trim()}
            className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50">
            {saving ? 'Saving...' : view === 'add' ? `Add ${propertyLabel}` : 'Save Changes'}
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
          <h1 className="text-2xl font-bold text-gray-900">{propertyLabelPlural}</h1>
          <p className="mt-1 text-sm text-gray-500">Manage your {propertyLabelPlural.toLowerCase()} and pricing</p>
        </div>
        <button onClick={openAdd} className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600">
          + Add {propertyLabel}
        </button>
      </div>

      {properties.length === 0 ? (
        <div className="mt-12 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-50">
            <svg className="h-8 w-8 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
          </div>
          <h3 className="mt-4 text-sm font-semibold text-gray-900">No {propertyLabelPlural.toLowerCase()} yet</h3>
          <p className="mt-1 text-sm text-gray-500">Add your first {propertyLabel.toLowerCase()} to start accepting reservations</p>
          <button onClick={openAdd} className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600">
            + Add {propertyLabel}
          </button>
        </div>
      ) : (
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {properties.map(p => (
            <div key={p.id} onClick={() => openEdit(p)}
              className={`cursor-pointer rounded-xl border bg-white overflow-hidden transition hover:shadow-sm ${
                p.is_active ? 'border-gray-100 hover:border-gray-200' : 'border-gray-100 opacity-60'
              }`}>
              {p.photos && p.photos.length > 0 && (
                <div className="h-32 w-full overflow-hidden">
                  <img src={p.photos[0]} alt={p.name} className="h-full w-full object-cover" />
                </div>
              )}
              <div className="p-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-900">{p.name}</h3>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 capitalize">{p.property_type}</span>
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-lg font-bold text-gray-900">{formatCurrency(p.price, country)}</span>
                <span className="text-xs text-gray-500">/night</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-500">
                <span>{p.max_guests} guest{p.max_guests !== 1 ? 's' : ''}</span>
                {p.bedrooms > 0 && <span>· {p.bedrooms} bed</span>}
                {p.bathrooms > 0 && <span>· {p.bathrooms} bath</span>}
                {p.deposit_amount > 0 && <span>· {formatCurrency(p.deposit_amount, country)} deposit</span>}
              </div>
              {p.amenities.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {p.amenities.slice(0, 4).map(a => (
                    <span key={a} className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand">{a}</span>
                  ))}
                  {p.amenities.length > 4 && (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">+{p.amenities.length - 4}</span>
                  )}
                </div>
              )}
              {!p.is_active && (
                <span className="mt-2 inline-block rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-500">Inactive</span>
              )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
