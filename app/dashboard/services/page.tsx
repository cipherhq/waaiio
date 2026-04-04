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

export default function ServicesPage() {
  const business = useBusiness();
  const country = (business.country_code || 'NG') as CountryCode;
  const labels = CATEGORY_LABELS[business.category as BusinessCategoryKey];
  const isScheduling = business.flow_type === 'scheduling';

  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Service | null>(null);
  const [isNew, setIsNew] = useState(false);
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

  function handleAdd() {
    setIsNew(true);
    setEditing({
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
  }

  async function handleSave() {
    if (!editing) return;
    setSaving(true);
    const supabase = createClient();

    const payload = {
      business_id: business.id,
      name: editing.name,
      description: editing.description || null,
      price: editing.price,
      price_is_variable: editing.price_is_variable,
      duration_minutes: editing.duration_minutes,
      deposit_amount: editing.deposit_amount,
      is_active: editing.is_active,
      sort_order: editing.sort_order,
    };

    if (isNew) {
      await supabase.from('services').insert(payload);
    } else {
      await supabase.from('services').update(payload).eq('id', editing.id);
    }

    setSaving(false);
    setEditing(null);
    setIsNew(false);
    fetchServices();
  }

  async function handleDelete(id: string) {
    const supabase = createClient();
    await supabase.from('services').delete().eq('id', id);
    fetchServices();
  }

  async function toggleActive(service: Service) {
    const supabase = createClient();
    await supabase
      .from('services')
      .update({ is_active: !service.is_active })
      .eq('id', service.id);
    fetchServices();
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  if (editing) {
    const curr = formatCurrency(0, country).charAt(0);
    return (
      <div>
        <div className="flex items-center gap-4">
          <button
            onClick={() => { setEditing(null); setIsNew(false); }}
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-2xl font-bold text-gray-900">{isNew ? 'Add Service' : 'Edit Service'}</h1>
        </div>

        <div className="mt-6 max-w-xl space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Name</label>
            <input
              type="text"
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder="e.g. Haircut, Full Body Massage"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Description</label>
            <textarea
              value={editing.description || ''}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
              rows={2}
              placeholder="Brief description (optional)"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Price ({curr})</label>
              <input
                type="number"
                min={0}
                value={editing.price}
                onChange={(e) => setEditing({ ...editing, price: Number(e.target.value) })}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Deposit ({curr})</label>
              <input
                type="number"
                min={0}
                value={editing.deposit_amount}
                onChange={(e) => setEditing({ ...editing, deposit_amount: Number(e.target.value) })}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
              />
              <p className="mt-1 text-xs text-gray-400">0 = no deposit required</p>
            </div>
          </div>

          {isScheduling && (
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Duration (minutes)</label>
              <input
                type="number"
                min={5}
                step={5}
                value={editing.duration_minutes || ''}
                onChange={(e) => setEditing({ ...editing, duration_minutes: Number(e.target.value) || null })}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </div>
          )}

          <div className="flex items-center justify-between rounded-lg border border-gray-100 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-gray-700">Variable pricing</p>
              <p className="text-xs text-gray-400">Price may vary (show "from" prefix)</p>
            </div>
            <button
              onClick={() => setEditing({ ...editing, price_is_variable: !editing.price_is_variable })}
              className={`relative h-6 w-11 rounded-full transition ${editing.price_is_variable ? 'bg-brand' : 'bg-gray-200'}`}
            >
              <div
                className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition"
                style={{ left: editing.price_is_variable ? '22px' : '2px' }}
              />
            </button>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              onClick={handleSave}
              disabled={saving || !editing.name.trim()}
              className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {saving ? 'Saving...' : isNew ? 'Add Service' : 'Save Changes'}
            </button>
            <button
              onClick={() => { setEditing(null); setIsNew(false); }}
              className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

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
          onClick={handleAdd}
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
            onClick={handleAdd}
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
              className={`flex items-center justify-between rounded-xl border bg-white p-4 ${
                service.is_active ? 'border-gray-100' : 'border-gray-100 opacity-60'
              }`}
            >
              <div className="min-w-0 flex-1">
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

              <div className="flex items-center gap-2 pl-4">
                <button
                  onClick={() => toggleActive(service)}
                  className={`relative h-6 w-11 rounded-full transition ${service.is_active ? 'bg-brand' : 'bg-gray-200'}`}
                  title={service.is_active ? 'Deactivate' : 'Activate'}
                >
                  <div
                    className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition"
                    style={{ left: service.is_active ? '22px' : '2px' }}
                  />
                </button>
                <button
                  onClick={() => { setEditing(service); setIsNew(false); }}
                  className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>
                <button
                  onClick={() => handleDelete(service.id)}
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
