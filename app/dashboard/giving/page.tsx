'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { PageHeader } from '@/components/dashboard/PageHeader';
import { PAGE_TOOLTIPS } from '@/lib/tooltips';
import { formatCurrency, type CountryCode } from '@/lib/constants';

interface GivingCategory {
  id: string;
  name: string;
  description: string | null;
  price: number;
  price_is_variable: boolean;
  is_active: boolean;
  sort_order: number;
  billing_type: string;
  recurring_interval: string | null;
}

type View = 'list' | 'add' | 'edit';

export default function GivingPage() {
  const business = useBusiness();
  const [categories, setCategories] = useState<GivingCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>('list');
  const [saving, setSaving] = useState(false);

  // Form
  const [formId, setFormId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [fixedAmount, setFixedAmount] = useState(false);
  const [price, setPrice] = useState(0);
  const [isRecurring, setIsRecurring] = useState(false);
  const [interval, setInterval] = useState<'weekly' | 'monthly'>('monthly');

  const cc = (business.country_code || 'NG') as CountryCode;

  const fetchCategories = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('services')
      .select('id, name, description, price, price_is_variable, is_active, sort_order, billing_type, recurring_interval')
      .eq('business_id', business.id)
      .eq('service_type', 'giving')
      .is('deleted_at', null)
      .order('is_active', { ascending: false })
      .order('sort_order');
    setCategories(data || []);
    setLoading(false);
  }, [business.id]);

  useEffect(() => { fetchCategories(); }, [fetchCategories]);

  const resetForm = () => {
    setFormId(null); setName(''); setDescription(''); setFixedAmount(false); setPrice(0); setIsRecurring(false); setInterval('monthly');
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    const supabase = createClient();
    const payload = {
      business_id: business.id,
      name: name.trim(),
      description: description.trim() || null,
      price: fixedAmount ? price : 0,
      price_is_variable: !fixedAmount,
      duration_minutes: 0,
      deposit_amount: 0,
      billing_type: isRecurring ? 'recurring' : 'one_time',
      recurring_interval: isRecurring ? interval : null,
      is_active: true,
      service_type: 'giving',
    };

    if (formId) {
      await supabase.from('services').update(payload).eq('id', formId);
    } else {
      const maxOrder = categories.length > 0 ? Math.max(...categories.map(c => c.sort_order)) + 1 : 0;
      await supabase.from('services').insert({ ...payload, sort_order: maxOrder });
    }

    resetForm();
    setView('list');
    fetchCategories();
    setSaving(false);
  };

  const handleEdit = (cat: GivingCategory) => {
    setFormId(cat.id);
    setName(cat.name);
    setDescription(cat.description || '');
    setFixedAmount(!cat.price_is_variable);
    setPrice(cat.price);
    setIsRecurring(cat.billing_type === 'recurring');
    setInterval((cat.recurring_interval as 'weekly' | 'monthly') || 'monthly');
    setView('edit');
  };

  const handleToggleActive = async (id: string, currentActive: boolean) => {
    const supabase = createClient();
    await supabase.from('services').update({ is_active: !currentActive }).eq('id', id);
    fetchCategories();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this giving category?')) return;
    const supabase = createClient();
    await supabase.from('services').update({ deleted_at: new Date().toISOString(), is_active: false }).eq('id', id);
    fetchCategories();
  };

  // Stats
  const totalGiving = categories.length;

  if (view === 'add' || view === 'edit') {
    return (
      <div className="space-y-6">
        <PageHeader title={view === 'add' ? 'Add Giving Category' : 'Edit Giving Category'} />

        <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Category Name *</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g., Tithe, Offering, Building Fund"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description (optional)</label>
            <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Brief description"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
          </div>

          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={fixedAmount} onChange={e => setFixedAmount(e.target.checked)} className="rounded" />
              <span className="text-sm text-gray-700 dark:text-gray-300">Fixed amount (instead of members choosing their own amount)</span>
            </label>
            {fixedAmount && (
              <input type="number" value={price || ''} onChange={e => setPrice(Number(e.target.value))} placeholder="Amount"
                className="mt-2 w-40 rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
            )}
          </div>

          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={isRecurring} onChange={e => setIsRecurring(e.target.checked)} className="rounded" />
              <span className="text-sm text-gray-700 dark:text-gray-300">Recurring (auto-charge members on schedule)</span>
            </label>
            {isRecurring && (
              <select value={interval} onChange={e => setInterval(e.target.value as 'weekly' | 'monthly')}
                className="mt-2 rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100">
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            )}
          </div>
        </div>

        <div className="flex gap-3">
          <button onClick={() => { resetForm(); setView('list'); }} className="px-4 py-2 border border-gray-300 rounded-lg text-sm">Cancel</button>
          <button onClick={handleSave} disabled={saving || !name.trim()} className="px-6 py-2 bg-black text-white rounded-lg text-sm font-medium disabled:opacity-50">
            {saving ? 'Saving...' : view === 'add' ? 'Add Category' : 'Save Changes'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Giving Categories" tooltip={PAGE_TOOLTIPS.giving} description="Manage tithes, offerings, and donations">
        <button onClick={() => { resetForm(); setView('add'); }}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
          Add Giving Category
        </button>
      </PageHeader>

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : categories.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-12 text-center dark:border-gray-700 dark:bg-gray-800">
          <div className="text-4xl mb-4">🙏</div>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-1">No giving categories yet</h3>
          <p className="text-sm text-gray-500 mb-4">Add categories like Tithe, Offering, or Building Fund so members can give via WhatsApp.</p>
          <button onClick={() => { resetForm(); setView('add'); }}
            className="px-4 py-2 bg-black text-white rounded-lg text-sm font-medium">Add Category</button>
        </div>
      ) : (
        <div className="space-y-3">
          {categories.map(cat => (
            <div key={cat.id} className={`rounded-lg border bg-white dark:bg-gray-800 p-4 flex items-center justify-between ${cat.is_active ? 'border-gray-200 dark:border-gray-700' : 'border-gray-200 dark:border-gray-700 opacity-60'}`}>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{cat.name}</h3>
                  {!cat.is_active && <span className="text-[10px] uppercase tracking-wide font-medium text-gray-400 bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded">Inactive</span>}
                </div>
                <p className="text-xs text-gray-500 mt-0.5">
                  {cat.price_is_variable ? 'Members choose amount' : formatCurrency(cat.price, cc)}
                  {cat.billing_type === 'recurring' && ` · Recurring ${cat.recurring_interval}`}
                </p>
                {cat.description && <p className="text-xs text-gray-400 mt-0.5">{cat.description}</p>}
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => handleToggleActive(cat.id, cat.is_active)}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors ${cat.is_active ? 'bg-green-500' : 'bg-gray-300'}`}
                  title={cat.is_active ? 'Active — tap to disable' : 'Inactive — tap to enable'}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform mt-0.5 ${cat.is_active ? 'translate-x-4 ml-0.5' : 'translate-x-0.5'}`} />
                </button>
                <button onClick={() => handleEdit(cat)} className="text-xs text-blue-600 hover:text-blue-800 font-medium">Edit</button>
                <button onClick={() => handleDelete(cat.id)} className="text-xs text-red-500 hover:text-red-700">Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
