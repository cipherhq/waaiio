'use client';

import { useEffect, useState, useCallback } from 'react';
import { getLocale, type CountryCode } from '@/lib/constants';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { PageHelp } from '@/components/dashboard/PageHelp';

interface LoyaltyMember {
  id: string;
  customer_phone: string;
  customer_name: string | null;
  points_balance: number;
  total_earned: number;
  total_redeemed: number;
  visit_count: number;
}

interface LoyaltyTransaction {
  id: string;
  customer_phone: string;
  points_change: number;
  reason: string | null;
  created_at: string;
}

interface LoyaltyConfig {
  loyalty_earning_enabled: boolean;
  loyalty_points_mode: 'per_visit' | 'per_amount';
  loyalty_points_per_visit: number;
  loyalty_points_per_currency: number;
  loyalty_reward_threshold: number;
  loyalty_reward_description: string;
}

const DEFAULT_CONFIG: LoyaltyConfig = {
  loyalty_earning_enabled: false,
  loyalty_points_mode: 'per_visit',
  loyalty_points_per_visit: 10,
  loyalty_points_per_currency: 100,
  loyalty_reward_threshold: 100,
  loyalty_reward_description: 'a free service',
};

export default function LoyaltyPage() {
  const business = useBusiness();

  const [config, setConfig] = useState<LoyaltyConfig>(DEFAULT_CONFIG);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const [members, setMembers] = useState<LoyaltyMember[]>([]);
  const [transactions, setTransactions] = useState<LoyaltyTransaction[]>([]);
  const [loading, setLoading] = useState(true);

  // Metrics
  const [activeMembers, setActiveMembers] = useState(0);
  const [totalPointsIssued, setTotalPointsIssued] = useState(0);
  const [rewardsClaimed, setRewardsClaimed] = useState(0);

  // Load config from business metadata
  useEffect(() => {
    const meta = business.metadata || {};
    setConfig({
      loyalty_earning_enabled: meta.loyalty_earning_enabled === true,
      loyalty_points_mode: (meta.loyalty_points_mode as string) === 'per_amount' ? 'per_amount' : 'per_visit',
      loyalty_points_per_visit:
        typeof meta.loyalty_points_per_visit === 'number'
          ? meta.loyalty_points_per_visit
          : DEFAULT_CONFIG.loyalty_points_per_visit,
      loyalty_points_per_currency:
        typeof meta.loyalty_points_per_currency === 'number'
          ? meta.loyalty_points_per_currency
          : DEFAULT_CONFIG.loyalty_points_per_currency,
      loyalty_reward_threshold:
        typeof meta.loyalty_reward_threshold === 'number'
          ? meta.loyalty_reward_threshold
          : DEFAULT_CONFIG.loyalty_reward_threshold,
      loyalty_reward_description:
        typeof meta.loyalty_reward_description === 'string'
          ? meta.loyalty_reward_description
          : DEFAULT_CONFIG.loyalty_reward_description,
    });
  }, [business.metadata]);

  const fetchData = useCallback(async () => {
    const supabase = createClient();

    // Fetch loyalty members (top 20 by points_balance)
    const { data: memberData } = await supabase
      .from('loyalty_points')
      .select('id, customer_phone, customer_name, points_balance, total_earned, total_redeemed, visit_count')
      .eq('business_id', business.id)
      .order('points_balance', { ascending: false })
      .limit(20);

    const allMembers = (memberData || []) as LoyaltyMember[];
    setMembers(allMembers);

    // Fetch all members for metrics (count + sums)
    const { data: allMemberData } = await supabase
      .from('loyalty_points')
      .select('total_earned, total_redeemed')
      .eq('business_id', business.id);

    const all = allMemberData || [];
    setActiveMembers(all.length);
    setTotalPointsIssued(all.reduce((sum, m) => sum + (m.total_earned || 0), 0));
    setRewardsClaimed(all.filter((m) => (m.total_redeemed || 0) > 0).length);

    // Fetch recent transactions
    const { data: txData } = await supabase
      .from('loyalty_transactions')
      .select('id, customer_phone, points_change, reason, created_at')
      .eq('business_id', business.id)
      .order('created_at', { ascending: false })
      .limit(20);

    setTransactions((txData || []) as LoyaltyTransaction[]);
    setLoading(false);
  }, [business.id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  async function saveConfig() {
    setSaving(true);
    setSaveSuccess(false);

    const supabase = createClient();
    const updatedMetadata = {
      ...(business.metadata || {}),
      loyalty_earning_enabled: config.loyalty_earning_enabled,
      loyalty_points_mode: config.loyalty_points_mode,
      loyalty_points_per_visit: config.loyalty_points_per_visit,
      loyalty_points_per_currency: config.loyalty_points_per_currency,
      loyalty_reward_threshold: config.loyalty_reward_threshold,
      loyalty_reward_description: config.loyalty_reward_description,
    };

    const { error } = await supabase
      .from('businesses')
      .update({ metadata: updatedMetadata })
      .eq('id', business.id);

    setSaving(false);
    if (!error) {
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    }
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Loyalty Program</h1>
      <p className="mt-1 text-sm text-gray-500">
        Reward your customers for repeat visits
      </p>

      <PageHelp
        pageKey="loyalty"
        title="Loyalty Program"
        description="Reward repeat customers with points. Customers earn points with every booking or purchase, and can redeem them for discounts. Set how many points per visit."
      />

      {/* Config Section */}
      <div className="mt-6 rounded-xl border border-gray-100 bg-white p-6">
        <h2 className="text-sm font-semibold text-gray-900">Program Settings</h2>
        <p className="mt-1 text-xs text-gray-400">
          Configure how points are earned and rewards are given
        </p>

        <div className="mt-5 space-y-5">
          {/* Enable/disable toggle */}
          <div className="flex items-center justify-between rounded-lg border border-gray-200 p-4">
            <div>
              <p className="text-sm font-medium text-gray-900">Enable Points Earning</p>
              <p className="text-xs text-gray-400">When enabled, customers automatically earn points on bookings, orders, and payments. Giving/donations never earn points.</p>
            </div>
            <button
              onClick={() => setConfig(c => ({ ...c, loyalty_earning_enabled: !c.loyalty_earning_enabled }))}
              className={`relative h-6 w-11 rounded-full transition ${config.loyalty_earning_enabled ? 'bg-brand' : 'bg-gray-300'}`}
            >
              <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${config.loyalty_earning_enabled ? 'translate-x-5' : ''}`} />
            </button>
          </div>

          {!config.loyalty_earning_enabled && (
            <p className="text-xs text-amber-600 bg-amber-50 rounded-lg p-3">Points earning is currently off. Customers can still view and redeem existing points, but no new points will be awarded.</p>
          )}

          {/* Points config — only shown when earning is enabled */}
          {config.loyalty_earning_enabled && (
            <>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-2">How do customers earn points?</label>
                <div className="flex gap-2">
                  <button onClick={() => setConfig(c => ({ ...c, loyalty_points_mode: 'per_visit' }))} className={`rounded-lg px-4 py-2 text-xs font-medium transition ${config.loyalty_points_mode === 'per_visit' ? 'bg-brand text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>Per Visit (flat)</button>
                  <button onClick={() => setConfig(c => ({ ...c, loyalty_points_mode: 'per_amount' }))} className={`rounded-lg px-4 py-2 text-xs font-medium transition ${config.loyalty_points_mode === 'per_amount' ? 'bg-brand text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>Per Amount Spent</button>
                </div>
              </div>
              <div className="grid gap-5 sm:grid-cols-3">
                {config.loyalty_points_mode === 'per_visit' ? (
                  <div>
                    <label className="block text-xs font-medium text-gray-500">Points Per Visit</label>
                    <input type="number" min={1} value={config.loyalty_points_per_visit || ''} onFocus={e => e.target.select()} onChange={e => setConfig(c => ({ ...c, loyalty_points_per_visit: parseInt(e.target.value, 10) || 0 }))} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-medium text-gray-500">Spend per 1 Point (e.g. 100 = 1 point per 100 spent)</label>
                    <input type="number" min={1} value={config.loyalty_points_per_currency || ''} onFocus={e => e.target.select()} onChange={e => setConfig(c => ({ ...c, loyalty_points_per_currency: parseInt(e.target.value, 10) || 0 }))} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-gray-500">Reward Threshold (points)</label>
                  <input type="number" min={1} value={config.loyalty_reward_threshold || ''} onFocus={e => e.target.select()} onChange={e => setConfig(c => ({ ...c, loyalty_reward_threshold: parseInt(e.target.value, 10) || 0 }))} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500">Reward Description</label>
                  <input type="text" value={config.loyalty_reward_description} onChange={e => setConfig(c => ({ ...c, loyalty_reward_description: e.target.value }))} placeholder="e.g. a free service" className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
                </div>
              </div>
            </>
          )}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={saveConfig}
            disabled={saving}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand/90 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
          {saveSuccess && (
            <span className="text-sm text-green-600">Settings saved</span>
          )}
        </div>

        <p className="mt-3 text-xs text-gray-400">
          {config.loyalty_points_mode === 'per_amount'
            ? `Customers earn 1 point per ${config.loyalty_points_per_currency} spent.`
            : `Customers earn ${config.loyalty_points_per_visit} points per visit.`
          }{' '}
          After {config.loyalty_reward_threshold} points they receive{' '}
          {config.loyalty_reward_description}. Redemptions generate a unique code for staff verification.
        </p>
      </div>

      {/* Metrics Cards */}
      {loading ? (
        <div className="mt-8 flex justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
        </div>
      ) : (
        <>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-gray-100 bg-white p-5">
              <p className="text-xs font-medium text-gray-500">Active Members</p>
              <p className="mt-2 text-2xl font-bold text-gray-900">
                {activeMembers}
              </p>
            </div>
            <div className="rounded-xl border border-gray-100 bg-white p-5">
              <p className="text-xs font-medium text-gray-500">
                Total Points Issued
              </p>
              <p className="mt-2 text-2xl font-bold text-gray-900">
                {totalPointsIssued.toLocaleString()}
              </p>
            </div>
            <div className="rounded-xl border border-gray-100 bg-white p-5">
              <p className="text-xs font-medium text-gray-500">Rewards Claimed</p>
              <p className="mt-2 text-2xl font-bold text-gray-900">
                {rewardsClaimed}
              </p>
              <p className="mt-1 text-xs text-gray-400">
                {activeMembers > 0
                  ? `${Math.round((rewardsClaimed / activeMembers) * 100)}% of members`
                  : 'No members yet'}
              </p>
            </div>
          </div>

          {/* Top Customers Table */}
          <div className="mt-8">
            <h2 className="text-sm font-semibold text-gray-900">Top Customers</h2>
            {members.length === 0 ? (
              <div className="mt-4 rounded-xl border border-dashed border-gray-200 p-12 text-center">
                <p className="text-sm text-gray-400">
                  No loyalty members yet. Members will appear here once they start
                  earning points.
                </p>
              </div>
            ) : (
              <div className="mt-3 overflow-x-auto rounded-xl border border-gray-100 bg-white">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-50 bg-gray-50/50">
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">
                        Customer Name
                      </th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">
                        Phone
                      </th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">
                        Points Balance
                      </th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">
                        Visit Count
                      </th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">
                        Total Earned
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {members.map((m) => (
                      <tr key={m.id} className="hover:bg-gray-50/50">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-50 text-xs font-bold text-brand">
                              {(m.customer_name || m.customer_phone)
                                .charAt(0)
                                .toUpperCase()}
                            </div>
                            <span className="font-medium text-gray-900">
                              {m.customer_name || 'Unknown'}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-gray-600">
                          {m.customer_phone}
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand">
                            {m.points_balance}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-600">
                          {m.visit_count}
                        </td>
                        <td className="px-4 py-3 text-gray-600">
                          {m.total_earned.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Recent Transactions Table */}
          <div className="mt-8">
            <h2 className="text-sm font-semibold text-gray-900">
              Recent Transactions
            </h2>
            {transactions.length === 0 ? (
              <div className="mt-4 rounded-xl border border-dashed border-gray-200 p-12 text-center">
                <p className="text-sm text-gray-400">
                  No loyalty transactions yet. They will appear here as customers
                  earn and redeem points.
                </p>
              </div>
            ) : (
              <div className="mt-3 overflow-x-auto rounded-xl border border-gray-100 bg-white">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-50 bg-gray-50/50">
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">
                        Date
                      </th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">
                        Customer Phone
                      </th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">
                        Points Change
                      </th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">
                        Reason
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {transactions.map((tx) => (
                      <tr key={tx.id} className="hover:bg-gray-50/50">
                        <td className="px-4 py-3 text-gray-600">
                          {formatDate(tx.created_at)}
                        </td>
                        <td className="px-4 py-3 text-gray-600">
                          {tx.customer_phone}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`text-sm font-medium ${
                              tx.points_change > 0
                                ? 'text-green-600'
                                : tx.points_change < 0
                                  ? 'text-red-600'
                                  : 'text-gray-600'
                            }`}
                          >
                            {tx.points_change > 0
                              ? `+${tx.points_change}`
                              : tx.points_change}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-600">
                          {tx.reason || '\u2014'}
                        </td>
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
