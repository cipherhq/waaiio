'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, type CountryCode } from '@/lib/constants';

interface Product {
  id: string;
  name: string;
}

interface VolumeDiscountRule {
  id?: string;
  product_id: string | null;
  name: string;
  min_quantity: number;
  max_quantity: number | null;
  discount_type: 'percentage' | 'fixed_per_unit' | 'fixed_total';
  discount_value: number;
  is_active: boolean;
  sort_order: number;
}

const EMPTY_RULE: Omit<VolumeDiscountRule, 'sort_order'> = {
  product_id: null,
  name: '',
  min_quantity: 10,
  max_quantity: null,
  discount_type: 'percentage',
  discount_value: 0,
  is_active: true,
};

function getPreviewText(rule: VolumeDiscountRule, products: Product[], curr: string): string {
  const productName = rule.product_id
    ? products.find(p => p.id === rule.product_id)?.name || 'Product'
    : 'All Products';
  const qtyRange = rule.max_quantity
    ? `${rule.min_quantity}–${rule.max_quantity}`
    : `${rule.min_quantity}+`;

  let discountText = '';
  switch (rule.discount_type) {
    case 'percentage':
      discountText = `${rule.discount_value}% off`;
      break;
    case 'fixed_per_unit':
      discountText = `${curr}${rule.discount_value} off each`;
      break;
    case 'fixed_total':
      discountText = `${curr}${rule.discount_value} off total`;
      break;
  }

  return `${qtyRange} ${productName} → ${discountText}`;
}

export default function VolumeDiscountsPage() {
  const business = useBusiness();
  const country = (business.country_code || 'NG') as CountryCode;
  const curr = formatCurrency(0, country).charAt(0);

  const [rules, setRules] = useState<VolumeDiscountRule[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const fetchData = useCallback(async () => {
    const supabase = createClient();
    const [{ data: rulesData }, { data: productsData }] = await Promise.all([
      supabase
        .from('volume_discount_rules')
        .select('*')
        .eq('business_id', business.id)
        .order('sort_order'),
      supabase
        .from('products')
        .select('id, name')
        .eq('business_id', business.id)
        .is('deleted_at', null)
        .eq('is_active', true)
        .order('name'),
    ]);
    setRules((rulesData as VolumeDiscountRule[]) || []);
    setProducts((productsData as Product[]) || []);
    setLoading(false);
  }, [business.id]);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function handleSave() {
    setSaving(true);
    const supabase = createClient();

    // Get existing IDs
    const { data: existing } = await supabase
      .from('volume_discount_rules')
      .select('id')
      .eq('business_id', business.id);
    const existingIds = new Set((existing || []).map(r => r.id));
    const currentIds = new Set(rules.filter(r => r.id).map(r => r.id));

    // Delete removed rules
    for (const id of existingIds) {
      if (!currentIds.has(id)) {
        await supabase.from('volume_discount_rules').delete().eq('id', id);
      }
    }

    // Upsert rules
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (!rule.name.trim()) continue;
      const payload = {
        business_id: business.id,
        product_id: rule.product_id || null,
        name: rule.name.trim(),
        min_quantity: rule.min_quantity,
        max_quantity: rule.max_quantity || null,
        discount_type: rule.discount_type,
        discount_value: rule.discount_value,
        is_active: rule.is_active,
        sort_order: i,
      };
      if (rule.id) {
        await supabase.from('volume_discount_rules').update(payload).eq('id', rule.id);
      } else {
        const { data } = await supabase.from('volume_discount_rules').insert(payload).select('id').single();
        if (data) {
          const updated = [...rules];
          updated[i] = { ...updated[i], id: data.id };
          setRules(updated);
        }
      }
    }

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Volume Discounts</h1>
          <p className="mt-1 text-sm text-gray-500">
            Automatically apply quantity-based discounts to WhatsApp orders.
          </p>
        </div>
      </div>

      <div className="mt-6 max-w-3xl space-y-4">
        {rules.map((rule, idx) => (
          <div key={rule.id || idx} className="rounded-xl border border-gray-100 bg-white p-5">
            {/* Preview */}
            {rule.name && rule.discount_value > 0 && (
              <div className="mb-3 rounded-lg bg-brand-50 px-3 py-2">
                <p className="text-sm font-medium text-brand">
                  {getPreviewText(rule, products, curr)}
                </p>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Rule Name</label>
                <input
                  type="text"
                  value={rule.name}
                  onChange={(e) => {
                    const updated = [...rules];
                    updated[idx] = { ...updated[idx], name: e.target.value };
                    setRules(updated);
                  }}
                  placeholder="e.g. Bulk Order Discount"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Product</label>
                <select
                  value={rule.product_id || ''}
                  onChange={(e) => {
                    const updated = [...rules];
                    updated[idx] = { ...updated[idx], product_id: e.target.value || null };
                    setRules(updated);
                  }}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                >
                  <option value="">Select a product</option>
                  {products.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-4 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Min Qty</label>
                <input
                  type="number"
                  min={1}
                  value={rule.min_quantity || ''}
                  onFocus={e => e.target.select()}
                  onChange={(e) => {
                    const updated = [...rules];
                    updated[idx] = { ...updated[idx], min_quantity: Number(e.target.value) || 1 };
                    setRules(updated);
                  }}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Max Qty</label>
                <input
                  type="number"
                  min={0}
                  value={rule.max_quantity ?? ''}
                  onChange={(e) => {
                    const updated = [...rules];
                    updated[idx] = { ...updated[idx], max_quantity: e.target.value ? Number(e.target.value) : null };
                    setRules(updated);
                  }}
                  placeholder="No cap"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Type</label>
                <select
                  value={rule.discount_type}
                  onChange={(e) => {
                    const updated = [...rules];
                    updated[idx] = { ...updated[idx], discount_type: e.target.value as VolumeDiscountRule['discount_type'] };
                    setRules(updated);
                  }}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                >
                  <option value="percentage">Percentage (%)</option>
                  <option value="fixed_per_unit">Fixed per unit ({curr})</option>
                  <option value="fixed_total">Fixed total ({curr})</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Value</label>
                <input
                  type="number"
                  min={0}
                  step={rule.discount_type === 'percentage' ? 0.5 : 1}
                  value={rule.discount_value || ''}
                  onChange={(e) => {
                    const updated = [...rules];
                    updated[idx] = { ...updated[idx], discount_value: Number(e.target.value) || 0 };
                    setRules(updated);
                  }}
                  placeholder={rule.discount_type === 'percentage' ? '0%' : '0'}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                />
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const updated = [...rules];
                    updated[idx] = { ...updated[idx], is_active: !updated[idx].is_active };
                    setRules(updated);
                  }}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition ${rule.is_active ? 'bg-brand' : 'bg-gray-200'}`}
                >
                  <div className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition" style={{ left: rule.is_active ? '18px' : '2px' }} />
                </button>
                <span className="text-xs text-gray-500">{rule.is_active ? 'Active' : 'Inactive'}</span>
              </div>
              <button
                onClick={() => setRules(rules.filter((_, i) => i !== idx))}
                className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
              >
                <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          </div>
        ))}

        <button
          onClick={() => setRules([...rules, { ...EMPTY_RULE, sort_order: rules.length }])}
          className="w-full rounded-lg border border-dashed border-gray-300 py-3 text-sm font-medium text-gray-500 hover:border-brand hover:text-brand"
        >
          + Add Discount Rule
        </button>

        {rules.length === 0 && (
          <div className="rounded-lg bg-blue-50 p-4">
            <p className="text-sm text-blue-700">
              Volume discounts are automatically applied when a customer orders enough quantity.
              They stack with promo codes — volume discount first, then promo code on top.
            </p>
          </div>
        )}

        <div className="flex gap-3 border-t border-gray-100 pt-4">
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {saving ? 'Saving...' : saved ? 'Saved!' : 'Save All Rules'}
          </button>
        </div>
      </div>
    </div>
  );
}
