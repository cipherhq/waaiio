'use client';

import { useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, type CountryCode } from '@/lib/constants';

interface Campaign {
  id: string;
  title: string;
  description: string | null;
  goal_amount: number;
  raised_amount: number;
  currency: string;
  start_date: string | null;
  end_date: string | null;
  status: string;
  donor_count: number;
  min_donation: number | null;
  max_donation: number | null;
  created_at: string;
}

type ViewMode = 'list' | 'add' | 'edit';

export default function CampaignsPage() {
  const business = useBusiness();
  const country = (business.country_code || 'NG') as CountryCode;
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<ViewMode>('list');

  // Form state
  const [form, setForm] = useState({
    id: '',
    title: '',
    description: '',
    goal_amount: 0,
    start_date: '',
    end_date: '',
    status: 'active',
    raised_amount: 0,
    donor_count: 0,
    min_donation: null as number | null,
    max_donation: null as number | null,
  });

  useEffect(() => {
    loadCampaigns();
  }, [business.id]);

  async function loadCampaigns() {
    const supabase = createClient();
    const { data } = await supabase
      .from('campaigns')
      .select('*')
      .eq('business_id', business.id)
      .order('created_at', { ascending: false });
    setCampaigns((data || []) as Campaign[]);
    setLoading(false);
  }

  function openAdd() {
    setForm({
      id: '',
      title: '',
      description: '',
      goal_amount: 0,
      start_date: '',
      end_date: '',
      status: 'active',
      raised_amount: 0,
      donor_count: 0,
      min_donation: null,
      max_donation: null,
    });
    setView('add');
  }

  function openEdit(campaign: Campaign) {
    setForm({
      id: campaign.id,
      title: campaign.title,
      description: campaign.description || '',
      goal_amount: campaign.goal_amount,
      start_date: campaign.start_date || '',
      end_date: campaign.end_date || '',
      status: campaign.status,
      raised_amount: campaign.raised_amount,
      donor_count: campaign.donor_count,
      min_donation: campaign.min_donation,
      max_donation: campaign.max_donation,
    });
    setView('edit');
  }

  async function handleSave() {
    if (!form.title.trim()) return;
    setSaving(true);
    const supabase = createClient();

    // Resolve currency from business country
    const { getCountry } = await import('@/lib/countries');
    const bizCurrency = getCountry(country)?.currency_code ?? 'NGN';

    const payload = {
      business_id: business.id,
      title: form.title.trim(),
      description: form.description.trim() || null,
      goal_amount: form.goal_amount,
      currency: bizCurrency,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      status: form.status,
      min_donation: form.min_donation && form.min_donation > 0 ? form.min_donation : null,
      max_donation: form.max_donation && form.max_donation > 0 ? form.max_donation : null,
    };

    if (view === 'add') {
      await supabase.from('campaigns').insert(payload);
    } else {
      await supabase.from('campaigns').update(payload).eq('id', form.id);
    }

    setSaving(false);
    setView('list');
    loadCampaigns();
  }

  async function handleDelete() {
    if (!form.id || !confirm('Delete this campaign?')) return;
    const supabase = createClient();
    await supabase.from('campaigns').delete().eq('id', form.id);
    setView('list');
    loadCampaigns();
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
            {view === 'add' ? 'New Campaign' : 'Edit Campaign'}
          </h1>
        </div>

        <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_280px]">
          {/* Left column: Main fields */}
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Campaign Title <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="e.g. Building Fund 2024"
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
                autoFocus
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Description</label>
              <textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={3}
                placeholder="Describe the purpose and goals of this campaign..."
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Goal Amount</label>
              <input
                type="number"
                min={0}
                value={form.goal_amount || ''}
                onChange={(e) => setForm({ ...form, goal_amount: Number(e.target.value) })}
                placeholder="0"
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Minimum Donation</label>
                <input
                  type="number"
                  min={0}
                  value={form.min_donation ?? ''}
                  onChange={(e) => setForm({ ...form, min_donation: e.target.value ? Number(e.target.value) : null })}
                  placeholder="No minimum"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
                />
                <p className="mt-0.5 text-xs text-gray-400">Leave empty for no minimum</p>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Maximum Donation</label>
                <input
                  type="number"
                  min={0}
                  value={form.max_donation ?? ''}
                  onChange={(e) => setForm({ ...form, max_donation: e.target.value ? Number(e.target.value) : null })}
                  placeholder="No maximum"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
                />
                <p className="mt-0.5 text-xs text-gray-400">Leave empty for no maximum</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Start Date</label>
                <input
                  type="date"
                  value={form.start_date}
                  onChange={(e) => setForm({ ...form, start_date: e.target.value })}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">End Date</label>
                <input
                  type="date"
                  value={form.end_date}
                  onChange={(e) => setForm({ ...form, end_date: e.target.value })}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
                />
              </div>
            </div>

            {/* Edit mode: show raised amount and donor count */}
            {view === 'edit' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-gray-100 bg-gray-50 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Raised</p>
                  <p className="mt-1 text-lg font-bold text-gray-900">
                    {formatCurrency(form.raised_amount, country)}
                  </p>
                </div>
                <div className="rounded-lg border border-gray-100 bg-gray-50 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Donors</p>
                  <p className="mt-1 text-lg font-bold text-gray-900">
                    {form.donor_count}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Right column: Settings */}
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Settings</p>

            <ToggleRow
              label="Active"
              description="Campaign is visible and accepting donations"
              checked={form.status === 'active'}
              onChange={(v) => setForm({ ...form, status: v ? 'active' : 'paused' })}
            />
          </div>
        </div>

        {/* Save / Cancel / Delete footer */}
        <div className="mt-6 flex gap-3 border-t border-gray-100 pt-4">
          <button
            onClick={handleSave}
            disabled={saving || !form.title.trim()}
            className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {saving ? 'Saving...' : view === 'add' ? 'Create Campaign' : 'Save Changes'}
          </button>
          <button
            onClick={() => setView('list')}
            className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          {view === 'edit' && (
            <button
              onClick={handleDelete}
              className="ml-auto rounded-lg px-4 py-2.5 text-sm font-medium text-red-500 hover:bg-red-50"
            >
              Delete Campaign
            </button>
          )}
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════
  // CAMPAIGN LIST
  // ═══════════════════════════════════════════
  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Campaigns</h1>
          <p className="mt-1 text-sm text-gray-500">
            Create and manage crowdfunding campaigns
          </p>
        </div>
        <button
          onClick={openAdd}
          className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"
        >
          + New Campaign
        </button>
      </div>

      {campaigns.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-gray-200 p-12 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-gray-50">
            <svg className="h-6 w-6 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
          </div>
          <p className="mt-3 text-sm text-gray-500">No campaigns yet</p>
          <p className="mt-1 text-xs text-gray-400">Create a campaign to start receiving donations</p>
          <button
            onClick={openAdd}
            className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
          >
            + New Campaign
          </button>
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {campaigns.map((campaign) => {
            const progress = campaign.goal_amount > 0
              ? Math.min(100, Math.round((campaign.raised_amount / campaign.goal_amount) * 100))
              : 0;

            return (
              <div
                key={campaign.id}
                onClick={() => openEdit(campaign)}
                className="cursor-pointer rounded-xl border border-gray-100 bg-white p-5 transition hover:shadow-sm"
              >
                <div className="flex items-start justify-between">
                  <div className="min-w-0 flex-1 pr-4">
                    <h3 className="text-sm font-semibold text-gray-900">{campaign.title}</h3>
                    {campaign.description && (
                      <p className="mt-0.5 text-xs text-gray-500 line-clamp-2">{campaign.description}</p>
                    )}
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                    campaign.status === 'active' ? 'bg-green-100 text-green-700' :
                    campaign.status === 'completed' ? 'bg-blue-100 text-blue-700' :
                    'bg-gray-100 text-gray-700'
                  }`}>
                    {campaign.status}
                  </span>
                </div>

                {campaign.goal_amount > 0 && (
                  <div className="mt-3">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-gray-900">
                        {formatCurrency(campaign.raised_amount, country)} raised
                      </span>
                      <span className="text-gray-500">
                        of {formatCurrency(campaign.goal_amount, country)} goal
                      </span>
                    </div>
                    <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-gray-100">
                      <div
                        className="h-full rounded-full bg-brand transition-all"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>
                )}

                <div className="mt-3 flex items-center gap-4 text-xs text-gray-500">
                  <span>{campaign.donor_count} donors</span>
                  {campaign.end_date && (
                    <span>Ends {new Date(campaign.end_date).toLocaleDateString()}</span>
                  )}
                </div>
              </div>
            );
          })}
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
