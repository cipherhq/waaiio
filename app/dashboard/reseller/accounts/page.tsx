'use client';

import { useEffect, useState, useMemo } from 'react';
import { useDashboard } from '@/components/dashboard/DashboardProvider';
import { PageHelp } from '@/components/dashboard/PageHelp';

interface SubAccount {
  id: string;
  name: string;
  category: string;
  status: string;
  subscription_tier: string;
  email: string | null;
  country_code: string | null;
  created_at: string;
}

interface ResellerMeta {
  total_accounts: number;
  max_sub_accounts: number;
}

const CATEGORY_OPTIONS = [
  { group: 'Beauty & Wellness', items: ['salon', 'barber', 'spa', 'tattoo', 'nail_tech', 'mua', 'lash_tech', 'medspa', 'waxing'] },
  { group: 'Health & Medical', items: ['clinic', 'dental', 'veterinary', 'therapy', 'optician', 'physiotherapy'] },
  { group: 'Food & Dining', items: ['restaurant', 'cafe', 'bar', 'lounge', 'bakery', 'catering', 'food_truck'] },
  { group: 'Delivery & Retail', items: ['shop', 'food_delivery', 'pharmacy', 'supermarket', 'tailor', 'printing'] },
  { group: 'Home & Auto Services', items: ['laundry', 'car_wash', 'mechanic', 'cleaning', 'plumber', 'pest_control', 'handyman', 'hvac', 'landscaping', 'electrician'] },
  { group: 'Professional Services', items: ['consultant', 'legal', 'accounting', 'travel_agency', 'coworking', 'security'] },
  { group: 'Hospitality', items: ['hotel', 'shortlet', 'car_rental'] },
  { group: 'Events & Entertainment', items: ['events', 'event_services', 'cinema', 'music_studio'] },
  { group: 'Faith & Community', items: ['church', 'mosque', 'ngo', 'crowdfunding_org'] },
  { group: 'Fitness', items: ['gym', 'yoga', 'pilates', 'dance', 'martial_arts', 'bootcamp'] },
  { group: 'Transport & Logistics', items: ['taxi', 'transport', 'logistics', 'courier', 'moving', 'bus'] },
  { group: 'Education & Training', items: ['school', 'tutor', 'driving_school', 'language_school', 'training_academy', 'daycare'] },
];

const TIER_OPTIONS = [
  { value: 'free', label: 'Free' },
  { value: 'growth', label: 'Growth (Pro)' },
  { value: 'business', label: 'Business (Premium)' },
];

const COUNTRY_OPTIONS = [
  { value: 'US', label: 'United States' },
  { value: 'CA', label: 'Canada' },
  { value: 'NG', label: 'Nigeria' },
  { value: 'GH', label: 'Ghana' },
  { value: 'GB', label: 'United Kingdom' },
];

export default function ResellerAccountsPage() {
  const { business, switchBusiness } = useDashboard();
  const [accounts, setAccounts] = useState<SubAccount[]>([]);
  const [meta, setMeta] = useState<ResellerMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: '',
    category: 'salon',
    email: '',
    country_code: 'US',
    subscription_tier: 'free',
  });

  useEffect(() => {
    loadAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business.id]);

  async function loadAccounts() {
    try {
      setError(false);
      const [accountsRes, statsRes] = await Promise.all([
        fetch(`/api/reseller/accounts?business_id=${business.id}`),
        fetch(`/api/reseller/stats?business_id=${business.id}`),
      ]);

      if (accountsRes.ok) {
        const data = await accountsRes.json();
        setAccounts(data.accounts || []);
      } else {
        setError(true);
      }

      if (statsRes.ok) {
        const json = await statsRes.json();
        const s = json.stats;
        setMeta({
          total_accounts: s?.accounts?.total ?? 0,
          max_sub_accounts: s?.reseller?.max_sub_accounts ?? 50,
        });
      }
    } catch {
      setError(true);
    }
    setLoading(false);
  }

  const filteredAccounts = useMemo(() => {
    if (!search.trim()) return accounts;
    const q = search.toLowerCase();
    return accounts.filter(a =>
      a.name.toLowerCase().includes(q) ||
      a.category.toLowerCase().includes(q) ||
      (a.email && a.email.toLowerCase().includes(q))
    );
  }, [accounts, search]);

  function formatCategory(cat: string) {
    return cat.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }

  function openAdd() {
    setEditingId(null);
    setForm({ name: '', category: 'salon', email: '', country_code: 'US', subscription_tier: 'free' });
    setShowForm(true);
  }

  function openEdit(account: SubAccount) {
    setEditingId(account.id);
    setForm({
      name: account.name,
      category: account.category,
      email: account.email || '',
      country_code: account.country_code || 'US',
      subscription_tier: account.subscription_tier,
    });
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.name.trim() || !form.email.trim()) return;
    setSaving(true);

    try {
      const payload = {
        business_id: business.id,
        name: form.name.trim(),
        category: form.category,
        email: form.email.trim(),
        country_code: form.country_code,
        subscription_tier: form.subscription_tier,
      };

      if (editingId) {
        await fetch(`/api/reseller/accounts/${editingId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } else {
        await fetch('/api/reseller/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }

      setShowForm(false);
      setEditingId(null);
      loadAccounts();
    } catch {
      // Error handling
    }
    setSaving(false);
  }

  async function handleToggleStatus(account: SubAccount) {
    setToggling(account.id);
    try {
      const newStatus = account.status === 'active' ? 'suspended' : 'active';
      await fetch(`/api/reseller/accounts/${account.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: business.id, status: newStatus }),
      });
      loadAccounts();
    } catch {
      // Error handling
    }
    setToggling(null);
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
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Sub-Accounts</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {meta
              ? `${meta.total_accounts} of ${meta.max_sub_accounts} accounts used`
              : 'Manage your client businesses'}
          </p>
        </div>
        <button
          onClick={openAdd}
          className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"
        >
          + Add Account
        </button>
      </div>

      <PageHelp
        pageKey="reseller-accounts"
        title="Sub-Accounts"
        description="Each sub-account is a separate business that gets its own WhatsApp bot, dashboard, and booking system. You can manage them all from here."
      />

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          Something went wrong loading data.{' '}
          <button onClick={() => { setError(false); loadAccounts(); }} className="font-medium underline hover:no-underline">
            Try again
          </button>
        </div>
      )}

      {/* Search */}
      <div className="mt-4">
        <input
          type="text"
          placeholder="Search accounts..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-sm rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand placeholder:text-gray-400 dark:placeholder:text-gray-500"
        />
      </div>

      {/* Add/Edit Form Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-gray-800 p-6 shadow-xl">
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">
              {editingId ? 'Edit Account' : 'Add New Account'}
            </h2>
            <div className="mt-4 space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Business Name <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Ace Salon Downtown"
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
                  autoFocus
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Category
                </label>
                <select
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
                >
                  {CATEGORY_OPTIONS.map((group) => (
                    <optgroup key={group.group} label={group.group}>
                      {group.items.map((item) => (
                        <option key={item} value={item}>
                          {formatCategory(item)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Email <span className="text-red-400">*</span>
                </label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="client@example.com"
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Country
                  </label>
                  <select
                    value={form.country_code}
                    onChange={(e) => setForm({ ...form, country_code: e.target.value })}
                    className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
                  >
                    {COUNTRY_OPTIONS.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Tier
                  </label>
                  <select
                    value={form.subscription_tier}
                    onChange={(e) => setForm({ ...form, subscription_tier: e.target.value })}
                    className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
                  >
                    {TIER_OPTIONS.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="mt-6 flex gap-3">
              <button
                onClick={handleSave}
                disabled={saving || !form.name.trim() || !form.email.trim()}
                className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
              >
                {saving ? 'Saving...' : editingId ? 'Save Changes' : 'Create Account'}
              </button>
              <button
                onClick={() => { setShowForm(false); setEditingId(null); }}
                className="rounded-lg border border-gray-200 dark:border-gray-600 px-4 py-2.5 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Accounts Table */}
      {filteredAccounts.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-gray-200 dark:border-gray-700 p-12 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-gray-50 dark:bg-gray-800">
            <svg className="h-6 w-6 text-gray-300 dark:text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
          </div>
          <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
            {search ? 'No accounts match your search' : 'No accounts yet'}
          </p>
          {!search && (
            <button
              onClick={openAdd}
              className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
            >
              + Add Account
            </button>
          )}
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
              <tr>
                <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Name</th>
                <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Category</th>
                <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Tier</th>
                <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Status</th>
                <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Created</th>
                <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 dark:text-gray-400">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-700">
              {filteredAccounts.map((account) => (
                <tr key={account.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition">
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap">
                    {account.name}
                  </td>
                  <td className="px-4 py-3 text-gray-700 dark:text-gray-300 whitespace-nowrap">
                    {formatCategory(account.category)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className="inline-block rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand capitalize">
                      {account.subscription_tier}
                    </span>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                      account.status === 'active'
                        ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                        : account.status === 'suspended'
                        ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                    }`}>
                      {account.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {new Date(account.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => openEdit(account)}
                        className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                        title="Edit"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleToggleStatus(account)}
                        disabled={toggling === account.id}
                        className={`rounded-lg px-2.5 py-1.5 text-xs font-medium ${
                          account.status === 'active'
                            ? 'text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20'
                            : 'text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20'
                        } disabled:opacity-50`}
                        title={account.status === 'active' ? 'Suspend' : 'Activate'}
                      >
                        {toggling === account.id ? '...' : account.status === 'active' ? 'Suspend' : 'Activate'}
                      </button>
                      <button
                        onClick={() => switchBusiness(account.id)}
                        className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-brand hover:bg-brand/10"
                        title="View Dashboard"
                      >
                        View
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
