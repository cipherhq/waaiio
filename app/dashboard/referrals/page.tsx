'use client';

import { useEffect, useState } from 'react';
import { getLocale, type CountryCode } from '@/lib/constants';
import { useBusiness, useRequireCapability } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';

interface Referral {
  id: string;
  business_id: string;
  referrer_phone: string;
  referrer_name: string | null;
  referee_phone: string;
  referral_code: string;
  status: string;
  reward_type: string | null;
  reward_amount: number | null;
  created_at: string;
}

interface TopReferrer {
  referrer_phone: string;
  referrer_name: string | null;
  total: number;
  converted: number;
}

const statusColors: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  converted: 'bg-green-100 text-green-800',
  rewarded: 'bg-blue-100 text-blue-800',
  expired: 'bg-gray-100 text-gray-600',
};

export default function ReferralsPage() {
  const business = useBusiness();
  const capReady = useRequireCapability('referral');
  const meta = (business.metadata || {}) as Record<string, unknown>;

  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Config form state — seeded from business.metadata
  const [rewardType, setRewardType] = useState<string>(
    (meta.referral_reward_type as string) || 'points',
  );
  const [rewardAmount, setRewardAmount] = useState<number>(
    (meta.referral_reward_amount as number) || 50,
  );
  const [rewardDescription, setRewardDescription] = useState<string>(
    (meta.referral_reward_description as string) || 'Earn 50 bonus loyalty points',
  );

  useEffect(() => {
    loadReferrals();
  }, [business.id]);

  async function loadReferrals() {
    const supabase = createClient();
    const { data } = await supabase
      .from('referrals')
      .select('*')
      .eq('business_id', business.id)
      .order('created_at', { ascending: false });
    setReferrals((data || []) as Referral[]);
    setLoading(false);
  }

  async function handleSaveConfig() {
    setSaving(true);
    const supabase = createClient();
    await supabase
      .from('businesses')
      .update({
        metadata: {
          ...meta,
          referral_reward_type: rewardType,
          referral_reward_amount: rewardAmount,
          referral_reward_description: rewardDescription,
        },
      })
      .eq('id', business.id);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  // ---- Derived metrics ----
  const totalReferrals = referrals.length;
  const pendingCount = referrals.filter((r) => r.status === 'pending').length;
  const convertedCount = referrals.filter((r) => r.status === 'converted').length;
  const rewardedCount = referrals.filter((r) => r.status === 'rewarded').length;
  const expiredCount = referrals.filter((r) => r.status === 'expired').length;
  const converted = convertedCount + rewardedCount;
  const conversionRate = totalReferrals > 0 ? Math.round((converted / totalReferrals) * 100) : 0;
  const totalRewardsGiven = referrals
    .filter((r) => r.status === 'rewarded' && r.reward_amount)
    .reduce((sum, r) => sum + (r.reward_amount || 0), 0);
  const outstandingRewards = referrals
    .filter((r) => r.status === 'converted' && r.reward_amount)
    .reduce((sum, r) => sum + (r.reward_amount || 0), 0);

  // Filtered referrals for display
  const filteredReferrals = statusFilter === 'all'
    ? referrals
    : referrals.filter((r) => r.status === statusFilter);

  // ---- Top referrers (with earnings) ----
  const referrerMap = new Map<string, TopReferrer & { rewarded_amount: number; pending_amount: number }>();
  for (const r of referrals) {
    const existing = referrerMap.get(r.referrer_phone);
    const isConverted = r.status === 'converted' || r.status === 'rewarded';
    const rewardAmt = r.reward_amount || 0;
    if (existing) {
      existing.total++;
      if (isConverted) existing.converted++;
      if (r.status === 'rewarded') existing.rewarded_amount += rewardAmt;
      if (r.status === 'converted') existing.pending_amount += rewardAmt;
      if (!existing.referrer_name && r.referrer_name) existing.referrer_name = r.referrer_name;
    } else {
      referrerMap.set(r.referrer_phone, {
        referrer_phone: r.referrer_phone,
        referrer_name: r.referrer_name,
        total: 1,
        converted: isConverted ? 1 : 0,
        rewarded_amount: r.status === 'rewarded' ? rewardAmt : 0,
        pending_amount: r.status === 'converted' ? rewardAmt : 0,
      });
    }
  }
  const topReferrers = Array.from(referrerMap.values()).sort((a, b) => b.total - a.total);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Referrals</h1>
        <p className="mt-1 text-sm text-gray-500">
          Configure rewards and track customer referrals
        </p>
      </div>

      {/* ── Config Section ── */}
      <div className="mt-6 rounded-xl border border-gray-100 bg-white p-6">
        <h2 className="text-sm font-semibold text-gray-900">Referral Reward Settings</h2>
        <p className="mt-1 text-xs text-gray-500">
          Configure what referrers earn when their invitees convert.
        </p>

        <div className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Reward Type</label>
              <select
                value={rewardType}
                onChange={(e) => setRewardType(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
              >
                <option value="points">Points</option>
                <option value="discount">Discount</option>
                <option value="freebie">Freebie</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Reward Amount</label>
              <input
                type="number"
                min={0}
                value={rewardAmount || ''}
                onChange={(e) => setRewardAmount(Number(e.target.value))}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Description</label>
              <input
                type="text"
                value={rewardDescription}
                onChange={(e) => setRewardDescription(e.target.value)}
                placeholder="e.g. Earn 50 bonus loyalty points"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </div>
          </div>

          <button
            onClick={handleSaveConfig}
            disabled={saving}
            className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Settings'}
          </button>
        </div>
      </div>

      {/* ── Metrics Cards ── */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Total Referrals</p>
          <p className="mt-2 text-2xl font-bold text-gray-900">{totalReferrals}</p>
        </div>
        <div className="rounded-xl border border-yellow-100 bg-yellow-50 p-5">
          <p className="text-xs font-medium text-gray-500">Pending Conversions</p>
          <p className="mt-2 text-2xl font-bold text-gray-900">{pendingCount}</p>
        </div>
        <div className="rounded-xl border border-green-100 bg-green-50 p-5">
          <p className="text-xs font-medium text-gray-500">Converted</p>
          <p className="mt-2 text-2xl font-bold text-gray-900">{converted}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Conversion Rate</p>
          <p className="mt-2 text-2xl font-bold text-gray-900">{conversionRate}%</p>
        </div>
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-5">
          <p className="text-xs font-medium text-gray-500">Total Rewards Given</p>
          <p className="mt-2 text-2xl font-bold text-gray-900">{totalRewardsGiven}</p>
        </div>
        <div className="rounded-xl border border-orange-100 bg-orange-50 p-5">
          <p className="text-xs font-medium text-gray-500">Outstanding Rewards</p>
          <p className="mt-2 text-2xl font-bold text-gray-900">{outstandingRewards}</p>
        </div>
      </div>

      {/* ── Conversion Funnel ── */}
      {totalReferrals > 0 && (
        <div className="mt-6 rounded-xl border border-gray-100 bg-white p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Conversion Funnel</h2>
          <div className="space-y-3">
            {[
              { label: 'Pending', count: pendingCount, color: 'bg-yellow-400' },
              { label: 'Converted', count: convertedCount, color: 'bg-green-400' },
              { label: 'Rewarded', count: rewardedCount, color: 'bg-blue-400' },
              { label: 'Expired', count: expiredCount, color: 'bg-gray-300' },
            ].map((stage) => {
              const pct = totalReferrals > 0 ? Math.round((stage.count / totalReferrals) * 100) : 0;
              return (
                <div key={stage.label} className="flex items-center gap-3">
                  <span className="w-20 text-xs font-medium text-gray-600">{stage.label}</span>
                  <div className="flex-1 h-6 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${stage.color} rounded-full transition-all`}
                      style={{ width: `${Math.max(pct, 0)}%` }}
                    />
                  </div>
                  <span className="w-16 text-right text-xs font-semibold text-gray-700">{stage.count} ({pct}%)</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {referrals.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-gray-200 p-12 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-gray-50">
            <svg aria-hidden="true" className="h-6 w-6 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
            </svg>
          </div>
          <p className="mt-3 text-sm text-gray-500">No referrals yet</p>
          <p className="mt-1 text-xs text-gray-400">Referrals will appear here as customers share their codes</p>
        </div>
      ) : (
        <>
          {/* ── Top Referrers Table ── */}
          {topReferrers.length > 0 && (
            <div className="mt-6">
              <h2 className="text-sm font-semibold text-gray-900">Top Referrers</h2>
              <div className="mt-3 overflow-x-auto rounded-xl border border-gray-100 bg-white">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-50 bg-gray-50/50">
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Referrer</th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Phone</th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Total Sent</th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Converted</th>
                      <th scope="col" className="px-4 py-3 text-right font-medium text-gray-500">Rewards Earned</th>
                      <th scope="col" className="px-4 py-3 text-right font-medium text-gray-500">Pending Rewards</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {topReferrers.map((ref) => (
                      <tr key={ref.referrer_phone} className="hover:bg-gray-50/50">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-50 text-xs font-bold text-brand">
                              {(ref.referrer_name || ref.referrer_phone).charAt(0).toUpperCase()}
                            </div>
                            <span className="font-medium text-gray-900">
                              {ref.referrer_name || 'Unknown'}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-gray-600">{ref.referrer_phone}</td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand">
                            {ref.total}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
                            {ref.converted}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-medium text-gray-900">
                          {ref.rewarded_amount > 0 ? ref.rewarded_amount : '—'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {ref.pending_amount > 0 ? (
                            <span className="text-orange-600 font-medium">{ref.pending_amount}</span>
                          ) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Status Filter Tabs ── */}
          <div className="mt-6">
            <div className="flex gap-1 overflow-x-auto rounded-lg border border-gray-200 bg-white p-1 w-fit">
              {['all', 'pending', 'converted', 'rewarded', 'expired'].map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition ${
                    statusFilter === s ? 'bg-brand text-white' : 'text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {s === 'all' ? `All (${totalReferrals})` : `${s} (${
                    s === 'pending' ? pendingCount :
                    s === 'converted' ? convertedCount :
                    s === 'rewarded' ? rewardedCount :
                    expiredCount
                  })`}
                </button>
              ))}
            </div>
          </div>

          {/* ── Recent Referrals Table ── */}
          <div className="mt-4">
            <h2 className="text-sm font-semibold text-gray-900">
              {statusFilter === 'all' ? 'Recent Referrals' : `${statusFilter.charAt(0).toUpperCase() + statusFilter.slice(1)} Referrals`}
            </h2>
            <div className="mt-3 overflow-x-auto rounded-xl border border-gray-100 bg-white">
              {filteredReferrals.length === 0 ? (
                <div className="p-8 text-center text-sm text-gray-400">No {statusFilter} referrals found</div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-50 bg-gray-50/50">
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Date</th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Referrer</th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Referee Phone</th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Code</th>
                      <th scope="col" className="px-4 py-3 text-right font-medium text-gray-500">Reward</th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {filteredReferrals.map((r) => (
                      <tr key={r.id} className="hover:bg-gray-50/50">
                        <td className="px-4 py-3 text-gray-600">
                          {new Date(r.created_at).toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          })}
                        </td>
                        <td className="px-4 py-3 font-medium text-gray-900">
                          {r.referrer_name || r.referrer_phone}
                        </td>
                        <td className="px-4 py-3 text-gray-600">{r.referee_phone}</td>
                        <td className="px-4 py-3 font-mono text-xs text-gray-400">
                          {r.referral_code}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-600">
                          {r.reward_amount ? r.reward_amount : '—'}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                              statusColors[r.status] || 'bg-gray-100 text-gray-600'
                            }`}
                          >
                            {r.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
