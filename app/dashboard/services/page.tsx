'use client';

import { useEffect, useState, useRef } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { Tooltip } from '@/components/dashboard/Tooltip';
import { FIELD_TOOLTIPS } from '@/lib/tooltips';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { useCategoryConfig } from '@/hooks/useCategoryConfig';
import EmptyState from '@/components/dashboard/EmptyState';
import { PageHelp } from '@/components/dashboard/PageHelp';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';

interface Service {
  id: string;
  name: string;
  description: string | null;
  price: number;
  price_is_variable: boolean;
  duration_minutes: number | null;
  buffer_minutes: number;
  deposit_amount: number;
  is_active: boolean;
  sort_order: number;
  status: 'active' | 'inactive' | 'archived';
  billing_type: 'one_time' | 'recurring';
  recurring_interval: 'weekly' | 'monthly' | null;
  is_featured: boolean;
  image_url: string | null;
  cancellation_policy: string | null;
  // Scheduling availability
  available_days: string[];
  available_from: string | null;
  available_to: string | null;
  requires_staff: boolean;
  staff_ids: string[];
  allow_staff_selection: boolean;
  // Packages
  is_package: boolean;
  included_service_ids: string[];
  // Gallery
  gallery_urls: string[];
  // Feature flags (stored in metadata)
  quote_enabled: boolean;
  metadata: Record<string, unknown>;
}

interface ServiceAddon {
  id: string;
  service_id: string | null;
  name: string;
  description: string | null;
  price: number;
  price_type: 'fixed' | 'per_unit' | 'per_hour';
  is_required: boolean;
  is_active: boolean;
  sort_order: number;
}

interface StaffMember {
  id: string;
  name: string;
  schedule: Record<string, { start?: string; end?: string }>;
}

const WEEKDAYS = [
  { key: 'monday', short: 'Mon' },
  { key: 'tuesday', short: 'Tue' },
  { key: 'wednesday', short: 'Wed' },
  { key: 'thursday', short: 'Thu' },
  { key: 'friday', short: 'Fri' },
  { key: 'saturday', short: 'Sat' },
  { key: 'sunday', short: 'Sun' },
];

type ViewMode = 'list' | 'add' | 'edit';

export default function ServicesPage() {
  const business = useBusiness();
  const country = (business.country_code || 'NG') as CountryCode;
  const { labels } = useCategoryConfig(business.category);
  const isScheduling = business.flow_type === 'scheduling';
  const curr = formatCurrency(0, country).charAt(0);

  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>('list');
  const [staffList, setStaffList] = useState<StaffMember[]>([]);

  const emptyForm: Service = {
    id: '',
    name: '',
    description: null,
    price: 0,
    price_is_variable: false,
    duration_minutes: isScheduling ? 30 : null,
    buffer_minutes: 0,
    deposit_amount: 0,
    is_active: true,
    sort_order: 0,
    status: 'active',
    billing_type: 'one_time',
    recurring_interval: null,
    is_featured: false,
    image_url: null,
    cancellation_policy: null,
    available_days: [],
    available_from: null,
    available_to: null,
    requires_staff: false,
    staff_ids: [],
    allow_staff_selection: false,
    is_package: false,
    included_service_ids: [],
    gallery_urls: [],
    quote_enabled: false,
    metadata: {},
  };
  const [form, setForm] = useState<Service>(emptyForm);
  const [addons, setAddons] = useState<ServiceAddon[]>([]);
  const [addonForm, setAddonForm] = useState<{ name: string; price: number; is_required: boolean }>({ name: '', price: 0, is_required: false });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showPrice, setShowPrice] = useState(labels.defaultHasPrice);
  // Toggle states for progressive disclosure
  const [showDuration, setShowDuration] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [showStaff, setShowStaff] = useState(false);
  const [showGallery, setShowGallery] = useState(false);
  const [showAddons, setShowAddons] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);

  async function fetchServices() {
    const supabase = createClient();
    const { data } = await supabase
      .from('services')
      .select('*')
      .eq('business_id', business.id)
      .neq('service_type', 'giving')
      .is('deleted_at', null)
      .order('sort_order', { ascending: true });
    setServices((data as Service[]) || []);
    setLoading(false);
  }

  async function fetchStaff() {
    const supabase = createClient();
    const { data } = await supabase
      .from('business_staff')
      .select('id, name, schedule')
      .eq('business_id', business.id)
      .eq('is_active', true);
    setStaffList((data as StaffMember[]) || []);
  }

  async function fetchAddons(serviceId: string) {
    const supabase = createClient();
    const { data } = await supabase
      .from('service_addons')
      .select('*')
      .eq('business_id', business.id)
      .or(`service_id.eq.${sanitizeFilterValue(serviceId)},service_id.is.null`)
      .eq('is_active', true)
      .order('sort_order');
    setAddons((data as ServiceAddon[]) || []);
  }

  async function saveAddon(serviceId: string) {
    if (!addonForm.name.trim()) return;
    const supabase = createClient();
    await supabase.from('service_addons').insert({
      business_id: business.id,
      service_id: serviceId,
      name: addonForm.name.trim(),
      price: addonForm.price,
      is_required: addonForm.is_required,
      sort_order: addons.length,
    });
    setAddonForm({ name: '', price: 0, is_required: false });
    fetchAddons(serviceId);
  }

  async function deleteAddon(addonId: string, serviceId: string) {
    const supabase = createClient();
    await supabase.from('service_addons').update({ is_active: false }).eq('id', addonId);
    fetchAddons(serviceId);
  }

  async function handleGalleryUpload(file: File) {
    if ((form.gallery_urls || []).length >= 3) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('business_id', business.id);
      const res = await fetch('/api/services/upload-image', { method: 'POST', body: fd });
      const json = await res.json();
      if (json.success && json.url) {
        setForm(prev => ({ ...prev, gallery_urls: [...(prev.gallery_urls || []), json.url] }));
      }
    } catch { /* silent */ }
    setUploading(false);
  }

  useEffect(() => { fetchServices(); fetchStaff(); }, [business.id]);

  function openAdd() {
    setForm({ ...emptyForm, sort_order: services.length, duration_minutes: isScheduling ? 30 : null });
    setShowPrice(labels.defaultHasPrice);
    setShowDuration(false);
    setShowSchedule(false);
    setShowStaff(false);
    setShowGallery(false);
    setShowAddons(false);
    setView('add');
  }

  function openEdit(service: Service) {
    const meta = (service.metadata || {}) as Record<string, unknown>;
    setForm({
      ...emptyForm,
      ...service,
      available_days: service.available_days || [],
      staff_ids: service.staff_ids || [],
      included_service_ids: service.included_service_ids || [],
      gallery_urls: service.gallery_urls || [],
      metadata: meta,
    });
    setShowPrice(labels.defaultHasPrice || service.price > 0 || service.deposit_amount > 0);
    // Auto-expand toggles based on existing data
    setShowDuration(!!service.duration_minutes && service.duration_minutes > 0);
    setShowSchedule((service.available_days || []).length > 0 || !!service.available_from);
    setShowStaff(service.requires_staff);
    setShowGallery((service.gallery_urls || []).length > 0);
    setShowAddons(true); // always show if editing
    if (service.id) fetchAddons(service.id);
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
      buffer_minutes: form.buffer_minutes || 0,
      deposit_amount: form.deposit_amount,
      is_active: form.status === 'active',
      sort_order: form.sort_order,
      status: form.status,
      billing_type: form.billing_type,
      recurring_interval: form.billing_type === 'recurring' ? form.recurring_interval : null,
      is_featured: form.is_featured,
      image_url: form.image_url,
      cancellation_policy: form.cancellation_policy?.trim() || null,
      available_days: form.available_days,
      available_from: form.available_from || null,
      available_to: form.available_to || null,
      requires_staff: form.requires_staff,
      staff_ids: form.requires_staff ? form.staff_ids : [],
      allow_staff_selection: form.requires_staff && form.staff_ids.length > 0 ? form.allow_staff_selection : false,
      is_package: form.is_package,
      included_service_ids: form.is_package ? form.included_service_ids : [],
      gallery_urls: form.gallery_urls || [],
      quote_enabled: form.quote_enabled,
      metadata: {
        ...(form.metadata || {}),
        collect_venue: (form.metadata || {}).collect_venue || false,
        multi_day: (form.metadata || {}).multi_day || false,
      },
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
    // Soft delete — preserves foreign key references from bookings
    const { error } = await supabase
      .from('services')
      .update({ deleted_at: new Date().toISOString(), is_active: false })
      .eq('id', form.id);
    if (error) {
      alert('Failed to delete. Please try again.');
      return;
    }
    setView('list');
    fetchServices();
  }

  /** Format price with recurring suffix */
  function priceLabel(service: Service) {
    if (service.price_is_variable && service.price === 0) {
      return labels?.quantityLabel === 'amount'
        ? `${labels.personLabelPlural} choose amount`
        : 'Variable pricing';
    }
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
            {view === 'add' ? `Add ${labels.serviceName || 'Service'}` : `Edit ${labels.serviceName || 'Service'}`}
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

            {/* Toggles for categories that don't require pricing (churches, mosques, etc.) */}
            {!labels.defaultHasPrice && (
              <div className="space-y-3">
                <div className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-gray-700">Set a fixed amount</p>
                    <p className="text-xs text-gray-400">Enable if this {(labels.serviceName || 'service').toLowerCase()} has a set price</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const next = !showPrice;
                      setShowPrice(next);
                      if (!next) setForm({ ...form, price: 0, deposit_amount: 0, price_is_variable: true });
                    }}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition ${showPrice ? 'bg-brand' : 'bg-gray-200'}`}
                  >
                    <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: showPrice ? '22px' : '2px' }} />
                  </button>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-gray-700">Recurring</p>
                    <p className="text-xs text-gray-400">Members can give on a regular schedule</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const isRecurring = form.billing_type === 'recurring';
                      setForm({
                        ...form,
                        billing_type: isRecurring ? 'one_time' : 'recurring',
                        recurring_interval: isRecurring ? null : (form.recurring_interval || 'monthly'),
                      });
                    }}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition ${form.billing_type === 'recurring' ? 'bg-brand' : 'bg-gray-200'}`}
                  >
                    <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: form.billing_type === 'recurring' ? '22px' : '2px' }} />
                  </button>
                </div>

                {form.billing_type === 'recurring' && (
                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">How often?</label>
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

            {/* Price + Deposit — side by side */}
            {showPrice && (
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
                    Deposit ({curr}) <Tooltip text={FIELD_TOOLTIPS['service.deposit']} />
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
            )}

            {/* Billing Type + Recurring Interval */}
            {showPrice && !isScheduling && (
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

            {/* ── Optional Sections (toggle to reveal) ── */}
            <div className="space-y-2 rounded-lg border border-gray-100 bg-gray-50 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-2">Additional Options</p>

              {/* Service Type */}
              <div className="flex items-center justify-between py-1">
                <div>
                  <p className="text-sm font-medium text-gray-700">Drop-off Service <Tooltip text="Drop-off services skip date and time selection. Customer just pays and drops off their item (e.g. wig revamp, laundry, repairs). Turn off for regular appointments." /></p>
                  <p className="text-xs text-gray-400">No date/time picker — customer pays and drops off</p>
                </div>
                <button type="button" onClick={() => setForm({ ...form, metadata: { ...form.metadata, is_dropoff: !(form.metadata?.is_dropoff as boolean) } })}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition ${(form.metadata?.is_dropoff as boolean) ? 'bg-brand' : 'bg-gray-200'}`}>
                  <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: (form.metadata?.is_dropoff as boolean) ? '22px' : '2px' }} />
                </button>
              </div>
              {(form.metadata?.is_dropoff as boolean) && (
                <div className="ml-1 pb-2">
                  <p className="text-xs text-gray-500 mb-1">Turnaround time (days)</p>
                  <input type="number" min={1} step={1} value={((form.metadata?.turnaround_days ?? '') as number) || ''} onChange={(e) => setForm({ ...form, metadata: { ...form.metadata, turnaround_days: Number(e.target.value) || null } })}
                    placeholder="e.g. 3" className="w-32 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
                  <span className="ml-2 text-xs text-gray-400">days until ready</span>
                </div>
              )}

              {/* Skip quantity toggle */}
              <div className="flex items-center justify-between py-1">
                <div>
                  <p className="text-sm font-medium text-gray-700">Skip quantity <Tooltip text="When on, the bot won't ask 'How many people?' — auto-sets to 1. Use for individual services like haircuts, consultations, or wig services." /></p>
                  <p className="text-xs text-gray-400">Don't ask "How many people?"</p>
                </div>
                <button type="button" onClick={() => setForm({ ...form, metadata: { ...form.metadata, skip_quantity: !(form.metadata?.skip_quantity as boolean) } })}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition ${(form.metadata?.skip_quantity as boolean) ? 'bg-brand' : 'bg-gray-200'}`}>
                  <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: (form.metadata?.skip_quantity as boolean) ? '22px' : '2px' }} />
                </button>
              </div>

              {/* Duration toggle */}
              <div className="flex items-center justify-between py-1">
                <div>
                  <p className="text-sm font-medium text-gray-700">Duration <Tooltip text={FIELD_TOOLTIPS['service.duration']} /></p>
                  <p className="text-xs text-gray-400">This service takes a specific amount of time</p>
                </div>
                <button type="button" onClick={() => { setShowDuration(!showDuration); if (showDuration) setForm({ ...form, duration_minutes: null }); }}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition ${showDuration ? 'bg-brand' : 'bg-gray-200'}`}>
                  <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: showDuration ? '22px' : '2px' }} />
                </button>
              </div>
              {showDuration && (
                <div className="ml-1 pb-2 space-y-2">
                  <div>
                    <input type="number" min={5} step={5} value={form.duration_minutes || ''} onChange={(e) => setForm({ ...form, duration_minutes: Number(e.target.value) || null })}
                      placeholder="e.g. 30" className="w-32 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
                    <span className="ml-2 text-xs text-gray-400">minutes</span>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 mb-1">Buffer time <Tooltip text={FIELD_TOOLTIPS['service.buffer']} /></p>
                    <input type="number" min={0} step={5} value={form.buffer_minutes || ''} onChange={(e) => setForm({ ...form, buffer_minutes: Number(e.target.value) || 0 })}
                      placeholder="e.g. 10" className="w-32 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
                    <span className="ml-2 text-xs text-gray-400">min cleanup/prep</span>
                  </div>
                </div>
              )}

              {/* Schedule toggle */}
              <div className="flex items-center justify-between py-1">
                <div>
                  <p className="text-sm font-medium text-gray-700">Availability Schedule</p>
                  <p className="text-xs text-gray-400">Limit which days/hours this service is available</p>
                </div>
                <button type="button" onClick={() => { setShowSchedule(!showSchedule); if (showSchedule) setForm({ ...form, available_days: [], available_from: null, available_to: null }); }}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition ${showSchedule ? 'bg-brand' : 'bg-gray-200'}`}>
                  <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: showSchedule ? '22px' : '2px' }} />
                </button>
              </div>
              {showSchedule && (
                <div className="ml-1 pb-2 space-y-3">
                  <div>
                    <p className="mb-1.5 text-xs text-gray-500">Available Days</p>
                    <div className="flex flex-wrap gap-2">
                      {WEEKDAYS.map(day => {
                        const active = form.available_days.includes(day.key);
                        return (
                          <button key={day.key} type="button"
                            onClick={() => setForm({ ...form, available_days: active ? form.available_days.filter(d => d !== day.key) : [...form.available_days, day.key] })}
                            className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${active ? 'bg-brand text-white' : 'bg-white border border-gray-200 text-gray-600 hover:border-brand'}`}>
                            {day.short}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input type="time" value={form.available_from || ''} onChange={(e) => setForm({ ...form, available_from: e.target.value || null })}
                      className="rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
                    <span className="text-sm text-gray-400">to</span>
                    <input type="time" value={form.available_to || ''} onChange={(e) => setForm({ ...form, available_to: e.target.value || null })}
                      className="rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
                  </div>
                </div>
              )}

              {/* Staff toggle */}
              {staffList.length > 0 && (
                <>
                  <div className="flex items-center justify-between py-1">
                    <div>
                      <p className="text-sm font-medium text-gray-700">Staff Assignment</p>
                      <p className="text-xs text-gray-400">Assign specific staff to this service</p>
                    </div>
                    <button type="button" onClick={() => { setShowStaff(!showStaff); if (showStaff) setForm({ ...form, requires_staff: false, staff_ids: [], allow_staff_selection: false }); else setForm({ ...form, requires_staff: true }); }}
                      className={`relative h-6 w-11 shrink-0 rounded-full transition ${showStaff ? 'bg-brand' : 'bg-gray-200'}`}>
                      <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: showStaff ? '22px' : '2px' }} />
                    </button>
                  </div>
                  {showStaff && (
                    <div className="ml-1 pb-2 space-y-3">
                      <div className="flex flex-wrap gap-2">
                        {staffList.map(s => {
                          const active = form.staff_ids.includes(s.id);
                          return (
                            <button key={s.id} type="button"
                              onClick={() => setForm({ ...form, staff_ids: active ? form.staff_ids.filter(id => id !== s.id) : [...form.staff_ids, s.id] })}
                              className={`rounded-lg px-3 py-2 text-xs font-medium transition ${active ? 'bg-brand text-white' : 'bg-white border border-gray-200 text-gray-600 hover:border-brand'}`}>
                              {s.name}
                            </button>
                          );
                        })}
                      </div>
                      {form.staff_ids.length > 0 && (
                        <label className="flex items-center gap-2 text-xs text-gray-500">
                          <input type="checkbox" checked={form.allow_staff_selection} onChange={e => setForm({ ...form, allow_staff_selection: e.target.checked })} className="rounded" />
                          Let customers choose their staff
                        </label>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* Gallery toggle */}
              <div className="flex items-center justify-between py-1">
                <div>
                  <p className="text-sm font-medium text-gray-700">Photos</p>
                  <p className="text-xs text-gray-400">Add images for this service</p>
                </div>
                <button type="button" onClick={() => setShowGallery(!showGallery)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition ${showGallery ? 'bg-brand' : 'bg-gray-200'}`}>
                  <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: showGallery ? '22px' : '2px' }} />
                </button>
              </div>
            </div>

            {/* Cancellation Policy — hidden for free-giving categories */}
            {labels.defaultHasPrice && <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Cancellation Policy</label>
              <textarea
                value={form.cancellation_policy || ''}
                onChange={(e) => setForm({ ...form, cancellation_policy: e.target.value })}
                rows={2}
                placeholder="e.g. Full refund if cancelled 24 hours before (optional)"
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
              />
            </div>}

            {/* ── Package Toggle ── */}
            {services.length > 1 && (
              <div className="space-y-3 rounded-lg border border-gray-100 bg-gray-50 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-700">This is a package</p>
                    <p className="text-xs text-gray-400">Bundle multiple services at a package price</p>
                  </div>
                  <button type="button" onClick={() => setForm({ ...form, is_package: !form.is_package, included_service_ids: [] })}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition ${form.is_package ? 'bg-brand' : 'bg-gray-200'}`}>
                    <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: form.is_package ? '22px' : '2px' }} />
                  </button>
                </div>
                {form.is_package && (
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-gray-700">Included Services</label>
                    <div className="flex flex-wrap gap-2">
                      {services.filter(s => s.id !== form.id && !s.is_package).map(s => {
                        const active = form.included_service_ids.includes(s.id);
                        return (
                          <button key={s.id} type="button"
                            onClick={() => setForm({ ...form, included_service_ids: active ? form.included_service_ids.filter(id => id !== s.id) : [...form.included_service_ids, s.id] })}
                            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${active ? 'bg-brand text-white' : 'bg-white border border-gray-200 text-gray-600 hover:border-brand'}`}>
                            {s.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── Gallery (max 3 images) ── */}
            {showGallery && (
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">Portfolio Gallery</label>
                <p className="mb-2 text-xs text-gray-400">Up to 3 images shown to customers before booking</p>
                <input ref={galleryInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleGalleryUpload(f); }} />
                <div className="flex gap-2">
                  {(form.gallery_urls || []).map((url, i) => (
                    <div key={i} className="relative">
                      <img src={url} alt={`Gallery ${i + 1}`} className="h-20 w-20 rounded-lg border border-gray-200 object-cover" />
                      <button type="button" onClick={() => setForm({ ...form, gallery_urls: form.gallery_urls.filter((_, j) => j !== i) })}
                        className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs text-white shadow">&times;</button>
                    </div>
                  ))}
                  {(form.gallery_urls || []).length < 3 && (
                    <button type="button" onClick={() => galleryInputRef.current?.click()} disabled={uploading}
                      className="flex h-20 w-20 items-center justify-center rounded-lg border-2 border-dashed border-gray-200 text-gray-400 hover:border-brand hover:text-brand">
                      {uploading ? '...' : '+'}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* ── Add-ons (only on edit, after service exists) ── */}
            {view === 'edit' && form.id && (
              <div className="space-y-3 rounded-lg border border-gray-100 bg-gray-50 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Add-ons</p>
                <p className="text-xs text-gray-400">Optional extras customers can add when booking</p>
                {addons.map(a => (
                  <div key={a.id} className="flex items-center justify-between rounded-lg bg-white border border-gray-100 px-3 py-2">
                    <div>
                      <span className="text-sm font-medium text-gray-800">{a.name}</span>
                      <span className="ml-2 text-xs text-gray-500">{formatCurrency(a.price, country)}</span>
                      {a.is_required && <span className="ml-2 text-xs text-amber-600">Required</span>}
                    </div>
                    <button onClick={() => deleteAddon(a.id, form.id)} className="text-xs text-red-400 hover:text-red-600">Remove</button>
                  </div>
                ))}
                <div className="flex gap-2">
                  <input value={addonForm.name} onChange={e => setAddonForm({ ...addonForm, name: e.target.value })} placeholder="Add-on name"
                    className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
                  <input type="number" value={addonForm.price || ''} onChange={e => setAddonForm({ ...addonForm, price: Number(e.target.value) })} placeholder="Price"
                    className="w-24 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
                  <button onClick={() => saveAddon(form.id)} disabled={!addonForm.name.trim()}
                    className="rounded-lg bg-brand px-3 py-2 text-xs font-medium text-white disabled:opacity-50">Add</button>
                </div>
                <label className="flex items-center gap-2 text-xs text-gray-500">
                  <input type="checkbox" checked={addonForm.is_required} onChange={e => setAddonForm({ ...addonForm, is_required: e.target.checked })} className="rounded" />
                  Required (customer must select this)
                </label>
              </div>
            )}

            {/* ── Feature Toggles (venue, multi-day, quotes) ── */}
            {(
              <div className="space-y-3 rounded-lg border border-gray-100 bg-gray-50 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Options</p>

                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-700">Collect venue address</p>
                    <p className="text-xs text-gray-400">Ask customers where the event/appointment is</p>
                  </div>
                  <button type="button" onClick={() => setForm({ ...form, metadata: { ...form.metadata, collect_venue: !form.metadata?.collect_venue } })}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition ${form.metadata?.collect_venue ? 'bg-brand' : 'bg-gray-200'}`}>
                    <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: form.metadata?.collect_venue ? '22px' : '2px' }} />
                  </button>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-700">Multi-day booking</p>
                    <p className="text-xs text-gray-400">Allow bookings that span multiple days</p>
                  </div>
                  <button type="button" onClick={() => setForm({ ...form, metadata: { ...form.metadata, multi_day: !form.metadata?.multi_day } })}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition ${form.metadata?.multi_day ? 'bg-brand' : 'bg-gray-200'}`}>
                    <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: form.metadata?.multi_day ? '22px' : '2px' }} />
                  </button>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-700">Price request</p>
                    <p className="text-xs text-gray-400">Customers request a price instead of booking at fixed price</p>
                  </div>
                  <button type="button" onClick={() => setForm({ ...form, quote_enabled: !form.quote_enabled })}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition ${form.quote_enabled ? 'bg-brand' : 'bg-gray-200'}`}>
                    <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: form.quote_enabled ? '22px' : '2px' }} />
                  </button>
                </div>

                {/* Max capacity */}
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Max bookings per time slot</label>
                  <p className="mb-1 text-xs text-gray-400">0 = unlimited. Prevents overbooking.</p>
                  <input type="number" min={0} value={(form as unknown as Record<string, unknown>).max_capacity as number || ''}
                    onChange={(e) => setForm({ ...form, ...{ max_capacity: Number(e.target.value) || null } } as Service)}
                    placeholder="Unlimited" className="w-32 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
                </div>
              </div>
            )}
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
              label={labels?.quantityLabel === 'amount' ? 'Open Amount' : 'Variable Pricing'}
              description={labels?.quantityLabel === 'amount'
                ? `${labels.personLabelPlural} can give any amount they choose`
                : 'Price may vary (show \'from\' prefix)'}
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
            {saving ? 'Saving...' : view === 'add' ? `Add ${labels.serviceName || 'Service'}` : 'Save Changes'}
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
              Delete {labels.serviceName || 'Service'}
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
          <h1 className="text-2xl font-bold text-gray-900">{labels.serviceNamePlural || 'Services'}</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage what your business offers
          </p>
        </div>
        <button
          onClick={openAdd}
          className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"
        >
          + Add {labels.serviceName || 'Service'}
        </button>
      </div>

      <PageHelp
        pageKey="services"
        title="Your Services"
        description="These are the services your customers can request through WhatsApp. Add your prices, descriptions, and any deposit requirements. The bot will show these options to customers automatically."
      />

      {services.length === 0 ? (
        <EmptyState
          icon="🛎️"
          title="No services yet"
          description="Add the services you offer so customers can request them on WhatsApp."
          actionLabel="Add your first service"
          onAction={openAdd}
          tip="Start with your most popular service — you can add more anytime."
        />
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
                      {service.available_days?.length > 0 && (
                        <span>{service.available_days.map(d => d.slice(0, 3)).join(', ')}</span>
                      )}
                      {service.requires_staff && service.staff_ids?.length > 0 && (
                        <span>{service.staff_ids.length} staff</span>
                      )}
                      {service.is_package && <span className="text-brand font-medium">Package</span>}
                      {service.quote_enabled && <span className="text-amber-600">Price Request</span>}
                      {(service.gallery_urls || []).length > 0 && <span>{service.gallery_urls.length} photos</span>}
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
