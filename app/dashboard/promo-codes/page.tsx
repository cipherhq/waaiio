'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { exportToCsv } from '@/lib/utils/csv-export';

interface PromoCode {
  id: string;
  code: string;
  description: string | null;
  discount_type: 'percentage' | 'fixed';
  discount_value: number;
  min_order_amount: number;
  max_uses: number | null;
  current_uses: number;
  valid_until: string | null;
  is_active: boolean;
  created_at: string;
}

const EMPTY_FORM = {
  id: '',
  code: '',
  description: '',
  discount_type: 'percentage' as const,
  discount_value: 0,
  min_order_amount: 0,
  max_uses: null as number | null,
  valid_until: '',
  is_active: true,
};

type ViewMode = 'list' | 'add' | 'edit';

export default function PromoCodesPage() {
  const business = useBusiness();
  const [codes, setCodes] = useState<PromoCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>('list');
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const fetchCodes = useCallback(async () => {
    try {
      const res = await fetch(`/api/promo-codes?businessId=${business.id}`);
      const data = await res.json();
      setCodes(data.error ? [] : (data.codes || []) as PromoCode[]);
    } catch { setCodes([]); }
    finally { setLoading(false); }
  }, [business.id]);

  useEffect(() => { fetchCodes(); }, [fetchCodes]);

  function openAdd() {
    setForm({ ...EMPTY_FORM });
    setFormError(null);
    setView('add');
  }

  function openEdit(promo: PromoCode) {
    setForm({
      id: promo.id,
      code: promo.code,
      description: promo.description || '',
      discount_type: promo.discount_type,
      discount_value: promo.discount_value,
      min_order_amount: promo.min_order_amount,
      max_uses: promo.max_uses,
      valid_until: promo.valid_until ? promo.valid_until.split('T')[0] : '',
      is_active: promo.is_active,
    });
    setFormError(null);
    setView('edit');
  }

  async function handleSave() {
    if (!form.code.trim()) { setFormError('Code is required.'); return; }
    if (form.discount_value <= 0) { setFormError('Discount value must be > 0.'); return; }
    setSaving(true);
    setFormError(null);
    try {
      const payload = {
        businessId: business.id,
        code: form.code.toUpperCase().trim(),
        description: form.description || null,
        discount_type: form.discount_type,
        discount_value: form.discount_value,
        min_order_amount: form.min_order_amount,
        max_uses: form.max_uses,
        valid_until: form.valid_until || null,
        is_active: form.is_active,
        ...(view === 'edit' ? { id: form.id } : {}),
      };
      const res = await fetch('/api/promo-codes', {
        method: view === 'edit' ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.error) { setFormError(data.error); }
      else { setView('list'); fetchCodes(); }
    } catch { setFormError('Something went wrong.'); }
    finally { setSaving(false); }
  }

  async function handleToggle(promo: PromoCode) {
    await fetch('/api/promo-codes', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: promo.id, businessId: business.id, is_active: !promo.is_active }),
    });
    fetchCodes();
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this promo code?')) return;
    await fetch('/api/promo-codes', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, businessId: business.id }),
    });
    if (view !== 'list') setView('list');
    fetchCodes();
  }

  function isExpired(p: PromoCode) { return p.valid_until ? new Date(p.valid_until) < new Date() : false; }
  function isMaxedOut(p: PromoCode) { return p.max_uses !== null ? p.current_uses >= p.max_uses : false; }
  function getStatus(p: PromoCode) {
    if (!p.is_active) return 'Inactive';
    if (isExpired(p)) return 'Expired';
    if (isMaxedOut(p)) return 'Maxed Out';
    return 'Active';
  }
  function statusColor(s: string) {
    return s === 'Active' ? 'bg-green-50 text-green-700' : s === 'Expired' ? 'bg-red-50 text-red-700' : s === 'Maxed Out' ? 'bg-amber-50 text-amber-700' : 'bg-gray-100 text-gray-500';
  }
  function formatDiscount(p: PromoCode) { return p.discount_type === 'percentage' ? `${p.discount_value}%` : `\u20A6${p.discount_value.toLocaleString()} off`; }

  const activeCodes = codes.filter(c => c.is_active && !isExpired(c) && !isMaxedOut(c)).length;
  const totalRedemptions = codes.reduce((s, c) => s + c.current_uses, 0);

  function handleExportCsv() {
    exportToCsv(
      codes.map(c => ({ code: c.code, description: c.description || '', discount_type: c.discount_type, discount_value: c.discount_value, min_order_amount: c.min_order_amount, max_uses: c.max_uses ?? 'Unlimited', current_uses: c.current_uses, status: getStatus(c), valid_until: c.valid_until ? new Date(c.valid_until).toLocaleDateString() : 'No expiry' })),
      'promo-codes',
      [{ key: 'code', label: 'Code' }, { key: 'discount_type', label: 'Type' }, { key: 'discount_value', label: 'Value' }, { key: 'current_uses', label: 'Uses' }, { key: 'status', label: 'Status' }, { key: 'valid_until', label: 'Valid Until' }],
    );
  }

  if (loading) {
    return <div className="flex min-h-[50vh] items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" /></div>;
  }

  // ═══════════ ADD / EDIT ═══════════
  if (view === 'add' || view === 'edit') {
    const editingPromo = view === 'edit' ? codes.find(c => c.id === form.id) : null;
    return (
      <div>
        <div className="flex items-center gap-3">
          <button onClick={() => setView('list')} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-xl font-bold text-gray-900">{view === 'add' ? 'Create Promo Code' : 'Edit Promo Code'}</h1>
        </div>

        {formError && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{formError}</div>
        )}

        <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_280px]">
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Promo Code <span className="text-red-400">*</span></label>
              <input type="text" value={form.code} onChange={e => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="e.g. SUMMER20" className="w-full rounded-lg border border-gray-200 px-3 py-2.5 font-mono text-sm uppercase outline-none focus:border-brand" autoFocus />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Description</label>
              <input type="text" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="e.g. Summer promotion - 20% off" className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Discount Type</label>
                <select value={form.discount_type} onChange={e => setForm({ ...form, discount_type: e.target.value as 'percentage' | 'fixed' })} className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand">
                  <option value="percentage">Percentage (%)</option>
                  <option value="fixed">Fixed Amount</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Discount Value {form.discount_type === 'percentage' ? '(%)' : '(\u20A6)'}</label>
                <input type="number" min={0} value={form.discount_value || ''} onChange={e => setForm({ ...form, discount_value: parseFloat(e.target.value) || 0 })} className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Min Order (\u20A6)</label>
                <input type="number" min={0} value={form.min_order_amount || ''} onChange={e => setForm({ ...form, min_order_amount: parseFloat(e.target.value) || 0 })} placeholder="0" className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Max Uses</label>
                <input type="number" min={0} value={form.max_uses ?? ''} onChange={e => setForm({ ...form, max_uses: e.target.value ? parseInt(e.target.value) : null })} placeholder="Unlimited" className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Valid Until</label>
                <input type="date" value={form.valid_until} onChange={e => setForm({ ...form, valid_until: e.target.value })} className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand" />
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Settings</p>
            <div className="flex items-center justify-between rounded-lg border border-gray-100 bg-white p-3">
              <div className="mr-3">
                <p className="text-sm font-medium text-gray-800">Active</p>
                <p className="text-xs text-gray-400">Code can be used by customers</p>
              </div>
              <button type="button" onClick={() => setForm({ ...form, is_active: !form.is_active })} className={`relative h-6 w-11 shrink-0 rounded-full transition ${form.is_active ? 'bg-brand' : 'bg-gray-200'}`}>
                <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: form.is_active ? '22px' : '2px' }} />
              </button>
            </div>
            {editingPromo && (
              <>
                <div className="rounded-lg border border-gray-100 bg-white p-3">
                  <p className="text-xs font-medium text-gray-500">Times Used</p>
                  <p className="mt-1 text-lg font-bold text-gray-900">
                    {editingPromo.current_uses}
                    {editingPromo.max_uses !== null && <span className="text-sm font-normal text-gray-400"> / {editingPromo.max_uses}</span>}
                  </p>
                </div>
                <div className="rounded-lg border border-gray-100 bg-white p-3">
                  <p className="text-xs font-medium text-gray-500">Status</p>
                  <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusColor(getStatus(editingPromo))}`}>{getStatus(editingPromo)}</span>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="mt-6 flex gap-3 border-t border-gray-100 pt-4">
          <button onClick={handleSave} disabled={saving} className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50">
            {saving ? 'Saving...' : view === 'add' ? 'Create Code' : 'Save Changes'}
          </button>
          <button onClick={() => setView('list')} className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancel</button>
          {view === 'edit' && form.id && (
            <button onClick={() => handleDelete(form.id)} className="ml-auto rounded-lg px-4 py-2.5 text-sm font-medium text-red-500 hover:bg-red-50">Delete</button>
          )}
        </div>
      </div>
    );
  }

  // ═══════════ LIST ═══════════
  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Promo Codes</h1>
          <p className="mt-1 text-sm text-gray-500">Create and manage promotional discount codes</p>
        </div>
        <div className="flex gap-2">
          {codes.length > 0 && (
            <button onClick={handleExportCsv} className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">Export CSV</button>
          )}
          <button onClick={openAdd} className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600">+ Create Code</button>
        </div>
      </div>

      {/* Metrics */}
      <div className="mt-6 grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Total Codes</p>
          <p className="mt-2 text-2xl font-bold text-gray-900">{codes.length}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Active</p>
          <p className="mt-2 text-2xl font-bold text-green-600">{activeCodes}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Total Uses</p>
          <p className="mt-2 text-2xl font-bold text-brand">{totalRedemptions}</p>
        </div>
      </div>

      {codes.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-gray-200 p-12 text-center">
          <p className="text-sm text-gray-500">No promo codes yet. Create your first promo code to get started.</p>
          <button onClick={openAdd} className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600">+ Create Code</button>
        </div>
      ) : (
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {codes.map(promo => {
            const status = getStatus(promo);
            return (
              <div
                key={promo.id}
                onClick={() => openEdit(promo)}
                className={`cursor-pointer rounded-xl border bg-white p-4 transition hover:shadow-sm ${
                  promo.is_active && !isExpired(promo) ? 'border-gray-100 hover:border-gray-200' : 'border-gray-100 opacity-70'
                }`}
              >
                <div className="flex items-start justify-between">
                  <span className="rounded bg-gray-100 px-2 py-1 font-mono text-xs font-semibold text-gray-900">{promo.code}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColor(status)}`}>{status}</span>
                </div>
                {promo.description && (
                  <p className="mt-2 text-xs text-gray-500 line-clamp-1">{promo.description}</p>
                )}
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-sm font-bold text-brand">{formatDiscount(promo)}</span>
                  <span className="text-xs text-gray-500">
                    {promo.current_uses}{promo.max_uses !== null ? ` / ${promo.max_uses}` : ''} uses
                  </span>
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-gray-50 pt-3">
                  <button
                    onClick={e => { e.stopPropagation(); handleToggle(promo); }}
                    className={`relative h-6 w-11 rounded-full transition ${promo.is_active ? 'bg-brand' : 'bg-gray-200'}`}
                  >
                    <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: promo.is_active ? '22px' : '2px' }} />
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete(promo.id); }}
                    className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-500"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
