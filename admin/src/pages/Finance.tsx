import { useEffect, useMemo, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';

interface Payment {
  id: string;
  amount: number;
  status: string;
  business_id: string;
  created_at: string;
}

interface PlatformFee {
  fee_total: number;
  waived: boolean;
  created_at: string;
}

interface BusinessPayout {
  net_amount: number;
  platform_fee: number;
  status: string;
  created_at: string;
}

interface Refund {
  amount: number;
  status: string;
  created_at: string;
}

interface Subscription {
  id: string;
  business_id: string;
  tier: string;
  amount: number;
  currency: string;
  status: string;
  created_at: string;
}

interface Business {
  id: string;
  category: string;
  country_code: string;
  subscription_tier: string;
}

export default function Finance() {
  const [loading, setLoading] = useState(true);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [fees, setFees] = useState<PlatformFee[]>([]);
  const [payouts, setPayouts] = useState<BusinessPayout[]>([]);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);

  useEffect(() => {
    async function load() {
      const [paymentsRes, feesRes, payoutsRes, refundsRes, bizRes, subsRes] = await Promise.all([
        adminDb.from('payments').select('id, amount, status, business_id, created_at'),
        adminDb.from('platform_fees').select('fee_total, waived, created_at'),
        adminDb.from('business_payouts').select('net_amount, platform_fee, status, created_at'),
        adminDb.from('refunds').select('amount, status, created_at').eq('status', 'success'),
        adminDb.from('businesses').select('id, category, country_code, subscription_tier'),
        adminDb.from('subscriptions').select('id, business_id, tier, amount, currency, status, created_at').eq('status', 'active'),
      ]);

      setPayments(paymentsRes.data || []);
      setFees(feesRes.data || []);
      setPayouts(payoutsRes.data || []);
      setRefunds(refundsRes.data || []);
      setBusinesses(bizRes.data || []);
      setSubscriptions(subsRes.data || []);
      setLoading(false);
    }
    load();
  }, []);

  // Compute metrics
  const metrics = useMemo(() => {
    const successPayments = payments.filter(p => p.status === 'success');
    const grossVolume = successPayments.reduce((s, p) => s + Number(p.amount || 0), 0);

    const totalRefunds = refunds.reduce((s, r) => s + Number(r.amount || 0), 0);

    const platformFees = fees.filter(f => !f.waived).reduce((s, f) => s + Number(f.fee_total || 0), 0);
    const gatewayFeeEstimate = grossVolume * 0.015; // ~1.5% estimate

    const netPlatformRevenue = platformFees;

    const payoutsOwed = payouts
      .filter(p => ['pending', 'approved'].includes(p.status))
      .reduce((s, p) => s + Number(p.net_amount || 0), 0);

    const paidOut = payouts
      .filter(p => p.status === 'paid')
      .reduce((s, p) => s + Number(p.net_amount || 0), 0);

    const processingPayouts = payouts
      .filter(p => p.status === 'processing')
      .reduce((s, p) => s + Number(p.net_amount || 0), 0);

    const outstanding = payoutsOwed + processingPayouts;
    const cashPosition = grossVolume - paidOut - processingPayouts;

    // Payment status breakdown
    const paymentBuckets: Record<string, { count: number; amount: number }> = {};
    for (const p of payments) {
      if (!paymentBuckets[p.status]) paymentBuckets[p.status] = { count: 0, amount: 0 };
      paymentBuckets[p.status].count++;
      paymentBuckets[p.status].amount += Number(p.amount || 0);
    }

    // Payout status breakdown
    const payoutBuckets: Record<string, { count: number; amount: number }> = {};
    for (const p of payouts) {
      if (!payoutBuckets[p.status]) payoutBuckets[p.status] = { count: 0, amount: 0 };
      payoutBuckets[p.status].count++;
      payoutBuckets[p.status].amount += Number(p.net_amount || 0);
    }

    const netVolume = grossVolume - totalRefunds;

    return {
      grossVolume,
      totalRefunds,
      netVolume,
      platformFees,
      gatewayFeeEstimate,
      netPlatformRevenue,
      payoutsOwed,
      paidOut,
      outstanding,
      cashPosition,
      paymentBuckets,
      payoutBuckets,
    };
  }, [payments, fees, payouts, refunds]);

  // Monthly rollup (last 12 months)
  const monthly = useMemo(() => {
    const byMonth = new Map<string, {
      month: string;
      transactions: number;
      gross: number;
      refunded: number;
      fees: number;
      payouts: number;
      net: number;
    }>();

    const getKey = (dateStr: string) => dateStr.slice(0, 7); // YYYY-MM

    for (const p of payments) {
      if (p.status !== 'success') continue;
      const key = getKey(p.created_at);
      const row = byMonth.get(key) || { month: key, transactions: 0, gross: 0, refunded: 0, fees: 0, payouts: 0, net: 0 };
      row.transactions++;
      row.gross += Number(p.amount || 0);
      byMonth.set(key, row);
    }

    for (const r of refunds) {
      const key = getKey(r.created_at);
      const row = byMonth.get(key) || { month: key, transactions: 0, gross: 0, refunded: 0, fees: 0, payouts: 0, net: 0 };
      row.refunded += Number(r.amount || 0);
      byMonth.set(key, row);
    }

    for (const f of fees) {
      if (f.waived) continue;
      const key = getKey(f.created_at);
      const row = byMonth.get(key) || { month: key, transactions: 0, gross: 0, refunded: 0, fees: 0, payouts: 0, net: 0 };
      row.fees += Number(f.fee_total || 0);
      byMonth.set(key, row);
    }

    for (const p of payouts) {
      if (p.status !== 'paid') continue;
      const key = getKey(p.created_at);
      const row = byMonth.get(key) || { month: key, transactions: 0, gross: 0, refunded: 0, fees: 0, payouts: 0, net: 0 };
      row.payouts += Number(p.net_amount || 0);
      byMonth.set(key, row);
    }

    return Array.from(byMonth.values())
      .sort((a, b) => b.month.localeCompare(a.month))
      .slice(0, 12)
      .map(row => ({ ...row, net: row.fees - row.payouts }));
  }, [payments, fees, payouts, refunds]);

  // Category revenue breakdown
  const categoryRevenue = useMemo(() => {
    const bizMap = new Map(businesses.map(b => [b.id, b.category]));
    const byCat = new Map<string, number>();

    for (const p of payments) {
      if (p.status !== 'success' || !p.business_id) continue;
      const cat = bizMap.get(p.business_id) || 'other';
      byCat.set(cat, (byCat.get(cat) || 0) + Number(p.amount || 0));
    }

    return Array.from(byCat.entries())
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10);
  }, [payments, businesses]);

  const maxCatRevenue = Math.max(...categoryRevenue.map(c => c.amount), 1);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Finance</h1>
      <p className="mt-1 text-sm text-gray-500">Comprehensive financial dashboard</p>

      {/* Metric Cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Gross Transaction Volume" value={formatMoney(metrics.grossVolume)} color="blue" />
        <MetricCard label="Total Refunds" value={formatMoney(metrics.totalRefunds)} color="red" />
        <MetricCard label="Net Volume" value={formatMoney(metrics.netVolume)} color="blue" />
        <MetricCard label="Platform Fees Earned" value={formatMoney(metrics.platformFees)} color="green" />
        <MetricCard label="Gateway Fees (est.)" value={formatMoney(metrics.gatewayFeeEstimate)} color="gray" />
        <MetricCard label="Net Platform Revenue" value={formatMoney(metrics.netPlatformRevenue)} color="indigo" />
        <MetricCard label="Payouts Owed" value={formatMoney(metrics.payoutsOwed)} color="yellow" />
        <MetricCard label="Paid Out" value={formatMoney(metrics.paidOut)} color="green" />
        <MetricCard label="Outstanding Liability" value={formatMoney(metrics.outstanding)} color="red" />
        <MetricCard label="Cash Position (est.)" value={formatMoney(metrics.cashPosition)} color="blue" />
      </div>

      {/* Payment Status Breakdown */}
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-gray-900">Payment Status Breakdown</h3>
          <div className="mt-4 space-y-3">
            {Object.entries(metrics.paymentBuckets).map(([status, data]) => (
              <div key={status} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <span className={`inline-block h-3 w-3 rounded-full ${
                    status === 'success' ? 'bg-green-400' :
                    status === 'pending' ? 'bg-yellow-400' :
                    status === 'failed' ? 'bg-red-400' :
                    'bg-gray-400'
                  }`} />
                  <span className="text-gray-600 capitalize">{status}</span>
                </div>
                <div className="text-right">
                  <span className="font-medium text-gray-900">{data.count}</span>
                  <span className="ml-2 text-gray-500">({formatMoney(data.amount)})</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-gray-900">Payout Status Breakdown</h3>
          <div className="mt-4 space-y-3">
            {Object.entries(metrics.payoutBuckets).map(([status, data]) => (
              <div key={status} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <span className={`inline-block h-3 w-3 rounded-full ${
                    status === 'paid' ? 'bg-green-400' :
                    status === 'processing' ? 'bg-blue-400' :
                    status === 'pending' ? 'bg-yellow-400' :
                    status === 'rejected' ? 'bg-red-400' :
                    'bg-gray-400'
                  }`} />
                  <span className="text-gray-600 capitalize">{status}</span>
                </div>
                <div className="text-right">
                  <span className="font-medium text-gray-900">{data.count}</span>
                  <span className="ml-2 text-gray-500">({formatMoney(data.amount)})</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Revenue by Category */}
      {categoryRevenue.length > 0 && (
        <div className="mt-8 rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-gray-900">Revenue by Business Category</h3>
          <div className="mt-4 space-y-3">
            {categoryRevenue.map(({ category, amount }) => (
              <div key={category} className="flex items-center gap-3">
                <span className="w-24 text-sm text-gray-600 capitalize truncate">{category}</span>
                <div className="flex-1 h-6 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-brand rounded-full transition-all"
                    style={{ width: `${(amount / maxCatRevenue) * 100}%` }}
                  />
                </div>
                <span className="text-sm font-medium text-gray-900 w-28 text-right">{formatMoney(amount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Revenue by Country */}
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-gray-900">Businesses by Country</h3>
          <div className="mt-4 space-y-3">
            {(() => {
              const byCountry = new Map<string, { count: number; revenue: number; subs: number }>();
              const bizMap = new Map(businesses.map(b => [b.id, b]));
              for (const b of businesses) {
                const cc = b.country_code || 'Unknown';
                const row = byCountry.get(cc) || { count: 0, revenue: 0, subs: 0 };
                row.count++;
                byCountry.set(cc, row);
              }
              for (const p of payments) {
                if (p.status !== 'success' || !p.business_id) continue;
                const biz = bizMap.get(p.business_id);
                const cc = biz?.country_code || 'Unknown';
                const row = byCountry.get(cc) || { count: 0, revenue: 0, subs: 0 };
                row.revenue += Number(p.amount || 0);
                byCountry.set(cc, row);
              }
              for (const s of subscriptions) {
                const biz = bizMap.get(s.business_id);
                const cc = biz?.country_code || 'Unknown';
                const row = byCountry.get(cc) || { count: 0, revenue: 0, subs: 0 };
                row.subs++;
                byCountry.set(cc, row);
              }
              const FLAG: Record<string, string> = { NG: '🇳🇬', US: '🇺🇸', GB: '🇬🇧', CA: '🇨🇦', GH: '🇬🇭', IN: '🇮🇳' };
              return Array.from(byCountry.entries())
                .sort((a, b) => b[1].count - a[1].count)
                .map(([cc, data]) => (
                  <div key={cc} className="flex items-center justify-between text-sm">
                    <span className="text-gray-700">{FLAG[cc] || '🌍'} {cc}</span>
                    <div className="text-right space-x-3">
                      <span className="text-gray-500">{data.count} biz</span>
                      <span className="text-gray-500">{data.subs} paid</span>
                      <span className="font-medium text-gray-900">{formatMoney(data.revenue)}</span>
                    </div>
                  </div>
                ));
            })()}
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-gray-900">Businesses by Subscription Tier</h3>
          <div className="mt-4 space-y-3">
            {(() => {
              const byTier = new Map<string, { count: number; mrr: number }>();
              for (const b of businesses) {
                const tier = b.subscription_tier || 'free';
                const row = byTier.get(tier) || { count: 0, mrr: 0 };
                row.count++;
                byTier.set(tier, row);
              }
              for (const s of subscriptions) {
                const tier = s.tier || 'free';
                const row = byTier.get(tier) || { count: 0, mrr: 0 };
                row.mrr += Number(s.amount || 0);
                byTier.set(tier, row);
              }
              const TIER_COLORS: Record<string, string> = {
                free: 'bg-gray-200', growth: 'bg-amber-400', business: 'bg-purple-500',
              };
              const TIER_LABELS: Record<string, string> = {
                free: 'Starter (Free)', growth: 'Growth (Pro)', business: 'Premium',
              };
              const totalBiz = businesses.length || 1;
              return ['free', 'growth', 'business'].map(tier => {
                const data = byTier.get(tier) || { count: 0, mrr: 0 };
                const pct = Math.round((data.count / totalBiz) * 100);
                return (
                  <div key={tier}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="text-gray-700">{TIER_LABELS[tier] || tier}</span>
                      <div className="text-right space-x-3">
                        <span className="text-gray-500">{data.count} ({pct}%)</span>
                        <span className="font-medium text-green-700">MRR: {formatMoney(data.mrr)}</span>
                      </div>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${TIER_COLORS[tier] || 'bg-gray-300'}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      </div>

      {/* Subscription MRR Summary */}
      {subscriptions.length > 0 && (
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <MetricCard
            label="Total MRR (Subscriptions)"
            value={formatMoney(subscriptions.reduce((s, sub) => s + Number(sub.amount || 0), 0))}
            color="green"
          />
          <MetricCard
            label="Active Paid Subscribers"
            value={String(subscriptions.length)}
            color="blue"
          />
          <MetricCard
            label="Avg Revenue Per Subscriber"
            value={formatMoney(subscriptions.length > 0 ? subscriptions.reduce((s, sub) => s + Number(sub.amount || 0), 0) / subscriptions.length : 0)}
            color="purple"
          />
        </div>
      )}

      {/* Monthly Rollup Table */}
      <div className="mt-8">
        <h3 className="text-lg font-semibold text-gray-900">Monthly Rollup</h3>
        <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
          {monthly.length === 0 ? (
            <div className="py-12 text-center text-sm text-gray-500">No data yet</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100 bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Month</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">Transactions</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">Gross Volume</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">Refunds</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">Platform Fees</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">Payouts</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">Net</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {monthly.map(row => (
                  <tr key={row.month} className="transition hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{formatMonth(row.month)}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{row.transactions}</td>
                    <td className="px-4 py-3 text-right text-gray-900">{formatMoney(row.gross)}</td>
                    <td className="px-4 py-3 text-right text-red-600">{row.refunded > 0 ? formatMoney(row.refunded) : '—'}</td>
                    <td className="px-4 py-3 text-right text-green-700">{formatMoney(row.fees)}</td>
                    <td className="px-4 py-3 text-right text-orange-700">{formatMoney(row.payouts)}</td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">{formatMoney(row.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value, color }: { label: string; value: string; color: string }) {
  const colors: Record<string, string> = {
    blue: 'bg-blue-50 border-blue-100',
    green: 'bg-green-50 border-green-100',
    yellow: 'bg-yellow-50 border-yellow-100',
    red: 'bg-red-50 border-red-100',
    purple: 'bg-purple-50 border-purple-100',
    indigo: 'bg-indigo-50 border-indigo-100',
    gray: 'bg-gray-50 border-gray-100',
  };
  return (
    <div className={`rounded-xl border p-4 ${colors[color] || 'bg-gray-50 border-gray-100'}`}>
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className="mt-1 text-xl font-bold text-gray-900">{value}</p>
    </div>
  );
}

function formatMonth(m: string) {
  const [year, month] = m.split('-');
  const date = new Date(Number(year), Number(month) - 1);
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function formatMoney(amount: number, currency = 'NGN'): string {
  const locales: Record<string, string> = { NGN: 'en-NG', USD: 'en-US', GBP: 'en-GB', CAD: 'en-CA', GHS: 'en-GH' };
  const hasCents = amount % 1 !== 0;
  try {
    return new Intl.NumberFormat(locales[currency] || 'en-US', {
      style: 'currency', currency,
      minimumFractionDigits: hasCents ? 2 : 0,
      maximumFractionDigits: hasCents ? 2 : 0,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString()}`;
  }
}
