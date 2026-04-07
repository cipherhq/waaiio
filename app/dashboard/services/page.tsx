'use client';

import { useEffect, useState } from 'react';
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
  });
  const [saving, setSaving] = useState(false);

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
    });
    setView('add');
  }

  function openEdit(service: Service) {
    setForm({ ...service });
    setView('edit');
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
      is_active: form.is_active,
      sort_order: form.sort_order,
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
            {view === 'add' ? 'Add Service' : 'Edit Service'}
          </h1>
        </div>

        <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_280px]">
          {/* Left column: Main fields */}
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Name <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Haircut, Full Body Massage"
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
          </div>

          {/* Right column: Settings */}
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Settings</p>

            <ToggleRow
              label="Variable Pricing"
              description="Price may vary (show 'from' prefix)"
              checked={form.price_is_variable}
              onChange={(v) => setForm({ ...form, price_is_variable: v })}
            />

            <ToggleRow
              label="Active"
              description="Visible to customers"
              checked={form.is_active}
              onChange={(v) => setForm({ ...form, is_active: v })}
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
            {saving ? 'Saving...' : view === 'add' ? 'Add Service' : 'Save Changes'}
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
              Delete Service
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
          <h1 className="text-2xl font-bold text-gray-900">Services</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage what your business offers
          </p>
        </div>
        <button
          onClick={openAdd}
          className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"
        >
          + Add Service
        </button>
      </div>

      {services.length === 0 ? (
        <div className="mt-12 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-50">
            <svg className="h-8 w-8 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
          <h3 className="mt-4 text-sm font-semibold text-gray-900">No services yet</h3>
          <p className="mt-1 text-sm text-gray-500">Add your first service so customers know what you offer.</p>
          <button
            onClick={openAdd}
            className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
          >
            + Add Service
          </button>
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {services.map((service) => (
            <div
              key={service.id}
              onClick={() => openEdit(service)}
              className={`cursor-pointer rounded-xl border bg-white p-4 transition hover:shadow-sm ${
                service.is_active ? 'border-gray-100 hover:border-gray-200' : 'border-gray-100 opacity-60'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="min-w-0 flex-1 pr-4">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-gray-900">{service.name}</h3>
                    {!service.is_active && (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">Inactive</span>
                    )}
                  </div>
                  {service.description && (
                    <p className="mt-0.5 text-xs text-gray-500 line-clamp-1">{service.description}</p>
                  )}
                  <div className="mt-1.5 flex items-center gap-3 text-xs text-gray-500">
                    <span className="font-medium text-gray-900">
                      {service.price_is_variable && 'From '}
                      {formatCurrency(service.price, country)}
                    </span>
                    {service.duration_minutes && (
                      <span>{service.duration_minutes} min</span>
                    )}
                    {service.deposit_amount > 0 && (
                      <span>Deposit: {formatCurrency(service.deposit_amount, country)}</span>
                    )}
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
