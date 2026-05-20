'use client';

import { useEffect, useState, useCallback } from 'react';
import { formatCurrency, getLocale, type CountryCode } from '@/lib/constants';
import { useBusiness, useRequireCapability } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';

interface MembershipTier {
  id: string;
  business_id: string;
  name: string;
  min_spend: number;
  discount_percent: number;
  points_multiplier: number;
  benefits: string | null;
  color: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
}

interface TierMemberCount {
  tier_id: string | null;
  count: number;
}

interface TopMember {
  id: string;
  name: string | null;
  phone: string;
  total_spent: number;
  total_visits: number;
  membership_tier_id: string | null;
}

const DEFAULT_TIERS = [
  { name: 'Bronze', min_spend: 0, discount_percent: 0, points_multiplier: 1, color: '#CD7F32', benefits: 'Welcome tier - earn loyalty points on every purchase' },
  { name: 'Silver', min_spend: 50000, discount_percent: 5, points_multiplier: 1.5, color: '#C0C0C0', benefits: '5% discount on all services, 1.5x loyalty points' },
  { name: 'Gold', min_spend: 150000, discount_percent: 10, points_multiplier: 2, color: '#FFD700', benefits: '10% discount on all services, 2x loyalty points, priority booking' },
  { name: 'Platinum', min_spend: 500000, discount_percent: 15, points_multiplier: 3, color: '#E5E4E2', benefits: '15% discount, 3x loyalty points, priority booking, exclusive offers' },
];

const EMPTY_FORM: Omit<MembershipTier, 'id' | 'business_id' | 'created_at'> = {
  name: '',
  min_spend: 0,
  discount_percent: 0,
  points_multiplier: 1,
  benefits: '',
  color: '#6B7280',
  sort_order: 0,
  is_active: true,
};

export default function MembershipPage() {
  const business = useBusiness();
  const capReady = useRequireCapability('membership');
  const cc = (business.country_code || 'NG') as CountryCode;

  const [tiers, setTiers] = useState<MembershipTier[]>([]);
  const [tierCounts, setTierCounts] = useState<Map<string | null, number>>(new Map());
  const [topMembers, setTopMembers] = useState<TopMember[]>([]);
  const [loading, setLoading] = useState(true);

  // Form state
  const [editingTier, setEditingTier] = useState<MembershipTier | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    const supabase = createClient();

    // Fetch tiers
    const { data: tierData } = await supabase
      .from('membership_tiers')
      .select('*')
      .eq('business_id', business.id)
      .order('sort_order', { ascending: true });

    const allTiers = (tierData || []) as MembershipTier[];
    setTiers(allTiers);

    // Fetch member counts per tier
    const { data: customers } = await supabase
      .from('customer_profiles')
      .select('membership_tier_id')
      .eq('business_id', business.id);

    const counts = new Map<string | null, number>();
    for (const c of customers || []) {
      const key = c.membership_tier_id || null;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    setTierCounts(counts);

    // Fetch top members (by total_spent, with a tier)
    const { data: topData } = await supabase
      .from('customer_profiles')
      .select('id, name, phone, total_spent, total_visits, membership_tier_id')
      .eq('business_id', business.id)
      .not('membership_tier_id', 'is', null)
      .order('total_spent', { ascending: false })
      .limit(15);

    setTopMembers((topData || []) as TopMember[]);
    setLoading(false);
  }, [business.id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  function openAddForm() {
    setEditingTier(null);
    setForm({ ...EMPTY_FORM, sort_order: tiers.length });
    setShowForm(true);
  }

  function openEditForm(tier: MembershipTier) {
    setEditingTier(tier);
    setForm({
      name: tier.name,
      min_spend: tier.min_spend,
      discount_percent: tier.discount_percent,
      points_multiplier: tier.points_multiplier,
      benefits: tier.benefits || '',
      color: tier.color,
      sort_order: tier.sort_order,
      is_active: tier.is_active,
    });
    setShowForm(true);
  }

  function cancelForm() {
    setShowForm(false);
    setEditingTier(null);
    setForm(EMPTY_FORM);
  }

  async function saveTier() {
    setSaving(true);
    const supabase = createClient();

    const payload = {
      business_id: business.id,
      name: form.name.trim(),
      min_spend: Number(form.min_spend) || 0,
      discount_percent: Number(form.discount_percent) || 0,
      points_multiplier: Number(form.points_multiplier) || 1,
      benefits: form.benefits?.trim() || null,
      color: form.color,
      sort_order: form.sort_order,
      is_active: form.is_active,
    };

    if (editingTier) {
      await supabase
        .from('membership_tiers')
        .update(payload)
        .eq('id', editingTier.id);
    } else {
      await supabase.from('membership_tiers').insert(payload);
    }

    setSaving(false);
    cancelForm();
    fetchData();
  }

  async function deleteTier(id: string) {
    if (!confirm('Delete this tier? Customers in this tier will become untiered.')) return;
    setDeleting(id);
    const supabase = createClient();
    await supabase.from('membership_tiers').delete().eq('id', id);
    setDeleting(null);
    fetchData();
  }

  async function addDefaultTiers() {
    if (tiers.length > 0 && !confirm('This will add default tiers alongside your existing ones. Continue?')) return;
    setSaving(true);
    const supabase = createClient();
    const rows = DEFAULT_TIERS.map((t, i) => ({
      business_id: business.id,
      ...t,
      sort_order: tiers.length + i,
    }));
    await supabase.from('membership_tiers').insert(rows);
    setSaving(false);
    fetchData();
  }

  function getTierName(tierId: string | null) {
    if (!tierId) return 'No Tier';
    return tiers.find((t) => t.id === tierId)?.name || 'Unknown';
  }

  function getTierColor(tierId: string | null) {
    if (!tierId) return '#6B7280';
    return tiers.find((t) => t.id === tierId)?.color || '#6B7280';
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Membership Tiers</h1>
      <p className="mt-1 text-sm text-gray-500">
        Reward your best customers with automatic tier upgrades based on spending
      </p>

      {loading ? (
        <div className="mt-8 flex justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
        </div>
      ) : (
        <>
          {/* Tier Overview Cards */}
          {tiers.length > 0 && (
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {tiers.filter((t) => t.is_active).map((tier) => (
                <div
                  key={tier.id}
                  className="rounded-xl border border-gray-100 bg-white p-5"
                  style={{ borderLeftColor: tier.color, borderLeftWidth: 4 }}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-gray-900">{tier.name}</p>
                    <span
                      className="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white"
                      style={{ backgroundColor: tier.color }}
                    >
                      {tierCounts.get(tier.id) || 0}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-400">
                    Min spend: {formatCurrency(tier.min_spend, cc)}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-400">
                    {tier.discount_percent}% discount &middot; {tier.points_multiplier}x points
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* Tier Management */}
          <div className="mt-8 rounded-xl border border-gray-100 bg-white p-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-gray-900">Manage Tiers</h2>
                <p className="mt-1 text-xs text-gray-400">
                  Define spending thresholds and rewards for each tier
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={addDefaultTiers}
                  disabled={saving}
                  className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-50"
                >
                  Add Default Tiers
                </button>
                <button
                  onClick={openAddForm}
                  className="rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white transition hover:bg-brand/90"
                >
                  + Add Tier
                </button>
              </div>
            </div>

            {/* Inline Add/Edit Form */}
            {showForm && (
              <div className="mt-5 rounded-lg border border-brand/20 bg-brand-50/30 p-5">
                <h3 className="text-sm font-semibold text-gray-900">
                  {editingTier ? `Edit "${editingTier.name}"` : 'New Tier'}
                </h3>
                <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-500">
                      Tier Name
                    </label>
                    <input
                      type="text"
                      value={form.name}
                      onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                      placeholder="e.g. Gold"
                      className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500">
                      Min Lifetime Spend
                    </label>
                    <input
                      type="number"
                      min={0}
                      value={form.min_spend || ''}
                      onChange={(e) => setForm((f) => ({ ...f, min_spend: parseFloat(e.target.value) || 0 }))}
                      className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500">
                      Discount %
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={form.discount_percent || ''}
                      onChange={(e) => setForm((f) => ({ ...f, discount_percent: parseFloat(e.target.value) || 0 }))}
                      className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500">
                      Points Multiplier
                    </label>
                    <input
                      type="number"
                      min={1}
                      step={0.5}
                      value={form.points_multiplier || ''}
                      onFocus={e => e.target.select()}
                      onChange={(e) => setForm((f) => ({ ...f, points_multiplier: parseFloat(e.target.value) || 1 }))}
                      className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500">
                      Color
                    </label>
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        type="color"
                        value={form.color}
                        onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
                        className="h-9 w-9 cursor-pointer rounded border border-gray-200"
                      />
                      <input
                        type="text"
                        value={form.color}
                        onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                      />
                    </div>
                  </div>
                  <div className="flex items-end">
                    <label className="flex items-center gap-2 text-sm text-gray-600">
                      <input
                        type="checkbox"
                        checked={form.is_active}
                        onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
                        className="rounded border-gray-300"
                      />
                      Active
                    </label>
                  </div>
                  <div className="sm:col-span-2 lg:col-span-3">
                    <label className="block text-xs font-medium text-gray-500">
                      Benefits Description
                    </label>
                    <input
                      type="text"
                      value={form.benefits || ''}
                      onChange={(e) => setForm((f) => ({ ...f, benefits: e.target.value }))}
                      placeholder="e.g. 10% discount, priority booking, exclusive offers"
                      className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                  </div>
                </div>
                <div className="mt-4 flex items-center gap-3">
                  <button
                    onClick={saveTier}
                    disabled={saving || !form.name.trim()}
                    className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand/90 disabled:opacity-50"
                  >
                    {saving ? 'Saving...' : editingTier ? 'Update Tier' : 'Create Tier'}
                  </button>
                  <button
                    onClick={cancelForm}
                    className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Tiers Table */}
            {tiers.length === 0 && !showForm ? (
              <div className="mt-5 rounded-xl border border-dashed border-gray-200 p-12 text-center">
                <p className="text-sm text-gray-400">
                  No membership tiers yet. Add default tiers to get started quickly.
                </p>
                <button
                  onClick={addDefaultTiers}
                  disabled={saving}
                  className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand/90 disabled:opacity-50"
                >
                  {saving ? 'Creating...' : 'Add Default Tiers'}
                </button>
              </div>
            ) : tiers.length > 0 ? (
              <div className="mt-5 overflow-x-auto rounded-xl border border-gray-100">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-50 bg-gray-50/50">
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Tier</th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Min Spend</th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Discount</th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Points Multiplier</th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Members</th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                      <th scope="col" className="px-4 py-3 text-right font-medium text-gray-500">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {tiers.map((tier) => (
                      <tr key={tier.id} className="hover:bg-gray-50/50">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span
                              className="inline-block h-3 w-3 rounded-full"
                              style={{ backgroundColor: tier.color }}
                            />
                            <span className="font-medium text-gray-900">{tier.name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-gray-600">
                          {formatCurrency(tier.min_spend, cc)}
                        </td>
                        <td className="px-4 py-3 text-gray-600">{tier.discount_percent}%</td>
                        <td className="px-4 py-3 text-gray-600">{tier.points_multiplier}x</td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand">
                            {tierCounts.get(tier.id) || 0}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {tier.is_active ? (
                            <span className="inline-flex items-center rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-600">
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                              Inactive
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={() => openEditForm(tier)}
                            className="mr-2 text-xs font-medium text-brand hover:underline"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => deleteTier(tier.id)}
                            disabled={deleting === tier.id}
                            className="text-xs font-medium text-red-500 hover:underline disabled:opacity-50"
                          >
                            {deleting === tier.id ? 'Deleting...' : 'Delete'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>

          {/* Top Members */}
          <div className="mt-8">
            <h2 className="text-sm font-semibold text-gray-900">Top Members</h2>
            {topMembers.length === 0 ? (
              <div className="mt-4 rounded-xl border border-dashed border-gray-200 p-12 text-center">
                <p className="text-sm text-gray-400">
                  No tiered members yet. Customers will be assigned tiers automatically based on their spending.
                </p>
              </div>
            ) : (
              <div className="mt-3 overflow-x-auto rounded-xl border border-gray-100 bg-white">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-50 bg-gray-50/50">
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Customer</th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Phone</th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Tier</th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Total Spent</th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Visits</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {topMembers.map((m) => (
                      <tr key={m.id} className="hover:bg-gray-50/50">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-50 text-xs font-bold text-brand">
                              {(m.name || m.phone).charAt(0).toUpperCase()}
                            </div>
                            <span className="font-medium text-gray-900">
                              {m.name || 'Unknown'}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-gray-600">{m.phone}</td>
                        <td className="px-4 py-3">
                          <span
                            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-white"
                            style={{ backgroundColor: getTierColor(m.membership_tier_id) }}
                          >
                            {getTierName(m.membership_tier_id)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-600">
                          {formatCurrency(Number(m.total_spent), cc)}
                        </td>
                        <td className="px-4 py-3 text-gray-600">{m.total_visits}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
