'use client';

import { useEffect, useState, useRef } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { CATEGORY_LABELS, formatCurrency, type BusinessCategoryKey, type CountryCode } from '@/lib/constants';

interface Service {
  id: string;
  name: string;
  description: string | null;
  price: number;
  price_is_variable: boolean;
  duration_minutes: number | null;
  deposit_amount: number;
  is_active: boolean;
  sort_order: number;
  status: 'active' | 'inactive' | 'archived';
  billing_type: 'one_time' | 'recurring';
  recurring_interval: 'weekly' | 'monthly' | null;
  is_featured: boolean;
  image_url: string | null;
  cancellation_policy: string | null;
}

type ViewMode = 'list' | 'add' | 'edit';

export default function ServicesPage() {
  const business = useBusiness();
  const country = (business.country_code || 'NG') as CountryCode;
  const labels = CATEGORY_LABELS[business.category as BusinessCategoryKey];
  const isScheduling = business.flow_type === 'scheduling';
  const curr = formatCurrency(0, country).charAt(0);

  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>('list');
  const [form, setForm] = useState<Service>({
    id: '',
    name: '',
    description: null,
    price: 0,
    price_is_variable: false,
    duration_minutes: isScheduling ? 30 : null,
    deposit_amount: 0,
    is_active: true,
    sort_order: 0,
    status: 'active',
    billing_type: 'one_time',
    recurring_interval: null,
    is_featured: false,
    image_url: null,
    cancellation_policy: null,
  });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function fetchServices() {
    const supabase = createClient();
    const { data } = await supabase
      .from('services')
      .select('*')
      .eq('business_id', business.id)
      .order('sort_order', { ascending: true });
    setServices((data as Service[]) || []);
    setLoading(false);
  }

  useEffect(() => { fetchServices(); }, [business.id]);

  function openAdd() {
    setForm({
      id: '',
      name: '',
      description: null,
      price: 0,
      price_is_variable: false,
      duration_minutes: isScheduling ? 30 : null,
      deposit_amount: 0,
      is_active: true,
      sort_order: services.length,
      status: 'active',
      billing_type: 'one_time',
      recurring_interval: null,
      is_featured: false,
      image_url: null,
      cancellation_policy: null,
    });
    setView('add');
  }

  function openEdit(service: Service) {
    setForm({ ...service });
    setView('edit');
  }

  async function handleImageUpload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('business_id', business.id);
      const res = await fetch('/api/services/upload-image', { method: 'POST', body: fd });
      const json = await res.json();
      if (json.success && json.url) {
        setForm(prev => ({ ...prev, image_url: json.url }));
      }
    } catch {
      // upload failed silently
    }
    setUploading(false);
  }

  async function handleSave() {
    if (!form.name.trim()) return;
    setSaving(true);
    const supabase = createClient();

    const payload = {
      business_id: business.id,
      name: form.name.trim(),
      description: form.description?.trim() || null,
      price: form.price,
      price_is_variable: form.price_is_variable,
      duration_minutes: form.duration_minutes,
      deposit_amount: form.deposit_amount,
      is_active: form.status === 'active',
      sort_order: form.sort_order,
      status: form.status,
      billing_type: form.billing_type,
      recurring_interval: form.billing_type === 'recurring' ? form.recurring_interval : null,
      is_featured: form.is_featured,
      image_url: form.image_url,
      cancellation_policy: form.cancellation_policy?.trim() || null,
    };

    if (view === 'add') {
      await supabase.from('services').insert(payload);
    } else {
      await supabase.from('services').update(payload).eq('id', form.id);
    }

    setSaving(false);
    setView('list');
    fetchServices();
  }

  async function handleDelete() {
    if (!form.id || !confirm('Delete this service?')) return;
    const supabase = createClient();
    await supabase.from('services').delete().eq('id', form.id);
    setView('list');
    fetchServices();
  }

  /** Format price with recurring suffix */
  function priceLabel(service: Service) {
    const prefix = service.price_is_variable ? 'From ' : '';
    const base = formatCurrency(service.price, country);
    if (service.billing_type === 'recurring' && service.recurring_interval) {
      return `${prefix}${base}/${service.recurring_interval === 'weekly' ? 'week' : 'month'}`;
    }
    return `${prefix}${base}`;
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  // ═══════════════════════════════════════════
  // ADD / EDIT — Full-page two-column form
  // ═══════════════════════════════════════════
  if (view === 'add' || view === 'edit') {
    return (
      <div>
        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setView('list')}
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-xl font-bold text-gray-900">
            {view === 'add' ? `Add ${labels.serviceName}` : `Edit ${labels.serviceName}`}
          </h1>
        </div>

        <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_280px]">
          {/* Left column: Main fields */}
          <div className="space-y-4">
            {/* Image upload */}
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Image</label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleImageUpload(f);
                }}
              />
              {form.image_url ? (
                <div className="relative inline-block">
                  <img
                    src={form.image_url}
                    alt="Service"
                    className="h-28 w-28 rounded-lg border border-gray-200 object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, image_url: null })}
                    className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-xs text-white shadow hover:bg-red-600"
                  >
                    &times;
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="flex h-28 w-full items-center justify-center rounded-lg border-2 border-dashed border-gray-200 text-sm text-gray-400 hover:border-brand hover:text-brand"
                >
                  {uploading ? 'Uploading...' : 'Click to upload image'}
                </button>
              )}
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Name <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={labels.namePlaceholder}
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
                autoFocus
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Description</label>
              <textarea
                value={form.description || ''}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={2}
                placeholder="Brief description (optional)"
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
              />
            </div>

            {/* Price + Deposit — side by side */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Price ({curr})
                </label>
                <input
                  type="number"
                  min={0}
                  value={form.price || ''}
                  onChange={(e) => setForm({ ...form, price: Number(e.target.value) })}
                  placeholder="0"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Deposit ({curr})
                </label>
                <input
                  type="number"
                  min={0}
                  value={form.deposit_amount || ''}
                  onChange={(e) => setForm({ ...form, deposit_amount: Number(e.target.value) })}
                  placeholder="0"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
                />
                <p className="mt-0.5 text-xs text-gray-400">0 = no deposit required</p>
              </div>
            </div>

            {/* Billing Type + Recurring Interval */}
            {!isScheduling && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Billing Type</label>
                  <select
                    value={form.billing_type}
                    onChange={(e) => {
                      const val = e.target.value as 'one_time' | 'recurring';
                      setForm({
                        ...form,
                        billing_type: val,
                        recurring_interval: val === 'recurring' ? (form.recurring_interval || 'monthly') : null,
                      });
                    }}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
                  >
                    <option value="one_time">One-time</option>
                    <option value="recurring">Recurring</option>
                  </select>
                </div>
                {form.billing_type === 'recurring' && (
                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">Recurring Interval</label>
                    <select
                      value={form.recurring_interval || 'monthly'}
                      onChange={(e) => setForm({ ...form, recurring_interval: e.target.value as 'weekly' | 'monthly' })}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
                    >
                      <option value="weekly">Weekly</option>
                      <option value="monthly">Monthly</option>
                    </select>
                  </div>
                )}
              </div>
            )}

            {isScheduling && (
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Duration (minutes)</label>
                <input
                  type="number"
                  min={5}
                  step={5}
                  value={form.duration_minutes || ''}
                  onChange={(e) => setForm({ ...form, duration_minutes: Number(e.target.value) || null })}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
                />
              </div>
            )}

            {/* Cancellation Policy */}
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Cancellation Policy</label>
              <textarea
                value={form.cancellation_policy || ''}
                onChange={(e) => setForm({ ...form, cancellation_policy: e.target.value })}
                rows={2}
                placeholder="e.g. Full refund if cancelled 24 hours before (optional)"
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
              />
            </div>
          </div>

          {/* Right column: Settings */}
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Settings</p>

            {/* Status dropdown */}
            <div className="rounded-lg border border-gray-100 bg-white p-3">
              <label className="mb-1 block text-sm font-medium text-gray-800">Status</label>
              <select
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value as 'active' | 'inactive' | 'archived' })}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="archived">Archived</option>
              </select>
            </div>

            <ToggleRow
              label="Featured"
              description="Highlight this service"
              checked={form.is_featured}
              onChange={(v) => setForm({ ...form, is_featured: v })}
            />

            <ToggleRow
              label="Variable Pricing"
              description="Price may vary (show 'from' prefix)"
              checked={form.price_is_variable}
              onChange={(v) => setForm({ ...form, price_is_variable: v })}
            />
          </div>
        </div>

        {/* Save / Cancel / Delete footer */}
        <div className="mt-6 flex gap-3 border-t border-gray-100 pt-4">
          <button
            onClick={handleSave}
            disabled={saving || !form.name.trim()}
            className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {saving ? 'Saving...' : view === 'add' ? `Add ${labels.serviceName}` : 'Save Changes'}
          </button>
          <button
            onClick={() => setView('list')}
            className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          {view === 'edit' && form.id && (
            <button
              onClick={handleDelete}
              className="ml-auto rounded-lg px-4 py-2.5 text-sm font-medium text-red-500 hover:bg-red-50"
            >
              Delete {labels.serviceName}
            </button>
          )}
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════
  // SERVICE LIST
  // ═══════════════════════════════════════════
  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{labels.serviceNamePlural}</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage what your business offers
          </p>
        </div>
        <button
          onClick={openAdd}
          className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"
        >
          + Add {labels.serviceName}
        </button>
      </div>

      {services.length === 0 ? (
        <div className="mt-12 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-50">
            <svg className="h-8 w-8 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
          <h3 className="mt-4 text-sm font-semibold text-gray-900">No {labels.serviceNamePlural.toLowerCase()} yet</h3>
          <p className="mt-1 text-sm text-gray-500">Add your first {labels.serviceName.toLowerCase()} so {labels.personLabelPlural.toLowerCase()} know what you offer.</p>
          <button
            onClick={openAdd}
            className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
          >
            + Add {labels.serviceName}
          </button>
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {services.map((service) => (
            <div
              key={service.id}
              onClick={() => openEdit(service)}
              className={`cursor-pointer rounded-xl border bg-white p-4 transition hover:shadow-sm ${
                service.status === 'active' ? 'border-gray-100 hover:border-gray-200' : 'border-gray-100 opacity-60'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex min-w-0 flex-1 items-center gap-3 pr-4">
                  {/* Thumbnail */}
                  {service.image_url && (
                    <img
                      src={service.image_url}
                      alt={service.name}
                      className="h-10 w-10 shrink-0 rounded-lg border border-gray-100 object-cover"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-gray-900">{service.name}</h3>
                      {service.is_featured && (
                        <span className="text-amber-400" title="Featured">&#9733;</span>
                      )}
                      <StatusBadge status={service.status} />
                    </div>
                    {service.description && (
                      <p className="mt-0.5 text-xs text-gray-500 line-clamp-1">{service.description}</p>
                    )}
                    <div className="mt-1.5 flex items-center gap-3 text-xs text-gray-500">
                      <span className="font-medium text-gray-900">
                        {priceLabel(service)}
                      </span>
                      {service.duration_minutes && (
                        <span>{service.duration_minutes} min</span>
                      )}
                      {service.deposit_amount > 0 && (
                        <span>Deposit: {formatCurrency(service.deposit_amount, country)}</span>
                      )}
                    </div>
                  </div>
                </div>

                <svg className="h-4 w-4 shrink-0 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Status badge ──
function StatusBadge({ status }: { status: string }) {
  if (status === 'active') return null; // active is the default, no badge needed
  const styles =
    status === 'inactive'
      ? 'bg-gray-100 text-gray-500'
      : 'bg-gray-50 text-gray-400'; // archived
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs capitalize ${styles}`}>
      {status}
    </span>
  );
}

// ── Reusable toggle row ──
function ToggleRow({ label, description, checked, onChange }: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-gray-100 bg-white p-3">
      <div className="mr-3">
        <p className="text-sm font-medium text-gray-800">{label}</p>
        <p className="text-xs text-gray-400">{description}</p>
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition ${checked ? 'bg-brand' : 'bg-gray-200'}`}
      >
        <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: checked ? '22px' : '2px' }} />
      </button>
    </div>
  );
}
