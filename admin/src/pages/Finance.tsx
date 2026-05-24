import { useEffect, useMemo, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { useAdminSession } from '@/components/AdminLayout';
import { downloadCSV } from '@/lib/csv';

interface Payment {
  id: string;
  amount: number;
  currency: string | null;
  gateway: string | null;
  status: string;
  business_id: string;
  created_at: string;
}

interface PlatformFee {
  fee_total: number;
  waived: boolean;
  refunded_at: string | null;
  business_id: string;
  created_at: string;
}

interface BusinessPayout {
  net_amount: number;
  platform_fee: number;
  currency: string | null;
  status: string;
  created_at: string;
}

interface Refund {
  amount: number;
  business_id: string;
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
  const session = useAdminSession();
  const isFullAdmin = session?.role === 'admin';
  const [loading, setLoading] = useState(true);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [fees, setFees] = useState<PlatformFee[]>([]);
  const [payouts, setPayouts] = useState<BusinessPayout[]>([]);

  if (!isFullAdmin) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center text-center">
        <p className="text-lg font-semibold text-gray-900">Access Restricted</p>
        <p className="mt-1 text-sm text-gray-500">Only full admins can view financial data.</p>
      </div>
    );
  }
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);

  // Date range filter
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  useEffect(() => {
    async function load() {
      const [paymentsRes, feesRes, payoutsRes, refundsRes, bizRes, subsRes] = await Promise.all([
        adminDb.from('payments').select('id, amount, currency, gateway, status, business_id, created_at'),
        adminDb.from('platform_fees').select('fee_total, waived, refunded_at, business_id, created_at').is('refunded_at', null),
        adminDb.from('business_payouts').select('net_amount, platform_fee, currency, status, created_at'),
        adminDb.from('refunds').select('amount, business_id, status, created_at').eq('status', 'success'),
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

  // Date-filtered data
  function inRange(date: string): boolean {
    if (dateFrom && date < dateFrom) return false;
    if (dateTo && date > dateTo + 'T23:59:59') return false;
    return true;
  }
  const filteredPayments = useMemo(() => payments.filter(p => inRange(p.created_at)), [payments, dateFrom, dateTo]);
  const filteredFees = useMemo(() => fees.filter(f => inRange(f.created_at)), [fees, dateFrom, dateTo]);
  const filteredPayouts = useMemo(() => payouts.filter(p => inRange(p.created_at)), [payouts, dateFrom, dateTo]);
  const filteredRefunds = useMemo(() => refunds.filter(r => inRange(r.created_at)), [refunds, dateFrom, dateTo]);

  // Resolve business → currency
  const bizCurrencyMap = useMemo(() => {
    const countryToCur: Record<string, string> = { US: 'USD', CA: 'CAD', GB: 'GBP', NG: 'NGN', GH: 'GHS' };
    const map = new Map<string, string>();
    for (const b of businesses) {
      map.set(b.id, countryToCur[b.country_code] || 'NGN');
    }
    return map;
  }, [businesses]);

  function getPaymentCurrency(p: Payment): string {
    return p.currency || bizCurrencyMap.get(p.business_id) || 'NGN';
  }

  /** Format a per-currency record as "₦5,000 · $500" */
  function formatMultiCurrency(amounts: Record<string, number>): string {
    const entries = Object.entries(amounts).filter(([, a]) => a > 0);
    if (entries.length === 0) return formatMoney(0);
    return entries.map(([cur, amt]) => formatMoney(amt, cur)).join(' · ');
  }

  // Compute metrics (per-currency) using filtered data
  const metrics = useMemo(() => {
    const successPayments = filteredPayments.filter(p => p.status === 'success');

    const grossVolume: Record<string, number> = {};
    for (const p of successPayments) {
      const cur = getPaymentCurrency(p);
      grossVolume[cur] = (grossVolume[cur] || 0) + Number(p.amount || 0);
    }

    const totalRefunds: Record<string, number> = {};
    for (const r of filteredRefunds) {
      const refCur = bizCurrencyMap.get(r.business_id) || 'NGN';
      totalRefunds[refCur] = (totalRefunds[refCur] || 0) + Number(r.amount || 0);
    }

    const platformFeesByCurrency: Record<string, number> = {};
    for (const f of filteredFees.filter(f => !f.waived)) {
      const feeCur = bizCurrencyMap.get(f.business_id) || 'NGN';
      platformFeesByCurrency[feeCur] = (platformFeesByCurrency[feeCur] || 0) + Number(f.fee_total || 0);
    }

    const payoutsOwedByCurrency: Record<string, number> = {};
    for (const p of filteredPayouts.filter(p => ['pending', 'approved'].includes(p.status))) {
      const cur = p.currency || 'NGN';
      payoutsOwedByCurrency[cur] = (payoutsOwedByCurrency[cur] || 0) + Number(p.net_amount || 0);
    }

    const paidOutByCurrency: Record<string, number> = {};
    for (const p of filteredPayouts.filter(p => p.status === 'paid')) {
      const cur = p.currency || 'NGN';
      paidOutByCurrency[cur] = (paidOutByCurrency[cur] || 0) + Number(p.net_amount || 0);
    }

    const outstandingByCurrency: Record<string, number> = {};
    for (const p of filteredPayouts.filter(p => ['pending', 'approved', 'processing'].includes(p.status))) {
      const cur = p.currency || 'NGN';
      outstandingByCurrency[cur] = (outstandingByCurrency[cur] || 0) + Number(p.net_amount || 0);
    }

    // Payment status breakdown
    const paymentBuckets: Record<string, { count: number; amount: number }> = {};
    for (const p of filteredPayments) {
      if (!paymentBuckets[p.status]) paymentBuckets[p.status] = { count: 0, amount: 0 };
      paymentBuckets[p.status].count++;
      paymentBuckets[p.status].amount += Number(p.amount || 0);
    }

    // Payout status breakdown
    const payoutBuckets: Record<string, { count: number; amount: number }> = {};
    for (const p of filteredPayouts) {
      if (!payoutBuckets[p.status]) payoutBuckets[p.status] = { count: 0, amount: 0 };
      payoutBuckets[p.status].count++;
      payoutBuckets[p.status].amount += Number(p.net_amount || 0);
    }

    // Gateway breakdown
    const gatewayBuckets: Record<string, { count: number; amount: number }> = {};
    for (const p of filteredPayments.filter(p => p.status === 'success')) {
      const gw = p.gateway || 'unknown';
      if (!gatewayBuckets[gw]) gatewayBuckets[gw] = { count: 0, amount: 0 };
      gatewayBuckets[gw].count++;
      gatewayBuckets[gw].amount += Number(p.amount || 0);
    }

    return {
      grossVolume,
      totalRefunds,
      platformFeesByCurrency,
      payoutsOwedByCurrency,
      paidOutByCurrency,
      outstandingByCurrency,
      paymentBuckets,
      payoutBuckets,
      gatewayBuckets,
    };
  }, [filteredPayments, filteredFees, filteredPayouts, filteredRefunds, bizCurrencyMap]);

  // Monthly rollup (last 12 months, per currency)
  const monthly = useMemo(() => {
    const byMonthCur = new Map<string, {
      month: string;
      currency: string;
      transactions: number;
      gross: number;
      refunded: number;
      fees: number;
      payouts: number;
      net: number;
    }>();

    const getMonth = (dateStr: string) => dateStr.slice(0, 7); // YYYY-MM
    const getRow = (key: string, month: string, currency: string) =>
      byMonthCur.get(key) || { month, currency, transactions: 0, gross: 0, refunded: 0, fees: 0, payouts: 0, net: 0 };

    for (const p of payments) {
      if (p.status !== 'success') continue;
      const month = getMonth(p.created_at);
      const cur = getPaymentCurrency(p);
      const key = `${month}|${cur}`;
      const row = getRow(key, month, cur);
      row.transactions++;
      row.gross += Number(p.amount || 0);
      byMonthCur.set(key, row);
    }

    for (const r of refunds) {
      const month = getMonth(r.created_at);
      const cur = bizCurrencyMap.get(r.business_id) || 'NGN';
      const key = `${month}|${cur}`;
      const row = getRow(key, month, cur);
      row.refunded += Number(r.amount || 0);
      byMonthCur.set(key, row);
    }

    for (const f of fees) {
      if (f.waived) continue;
      const month = getMonth(f.created_at);
      const cur = bizCurrencyMap.get(f.business_id) || 'NGN';
      const key = `${month}|${cur}`;
      const row = getRow(key, month, cur);
      row.fees += Number(f.fee_total || 0);
      byMonthCur.set(key, row);
    }

    for (const p of payouts) {
      if (p.status !== 'paid') continue;
      const month = getMonth(p.created_at);
      const cur = p.currency || 'NGN';
      const key = `${month}|${cur}`;
      const row = getRow(key, month, cur);
      row.payouts += Number(p.net_amount || 0);
      byMonthCur.set(key, row);
    }

    return Array.from(byMonthCur.values())
      .sort((a, b) => b.month.localeCompare(a.month) || a.currency.localeCompare(b.currency))
      .slice(0, 24)
      .map(row => ({ ...row, net: row.gross - row.refunds - row.fees }));
  }, [payments, fees, payouts, refunds, bizCurrencyMap]);

  // Category revenue breakdown (per currency)
  const categoryRevenue = useMemo(() => {
    const bizMap = new Map(businesses.map(b => [b.id, b]));
    const byCat = new Map<string, Record<string, number>>();

    for (const p of payments) {
      if (p.status !== 'success' || !p.business_id) continue;
      const biz = bizMap.get(p.business_id);
      const cat = biz?.category || 'other';
      const cur = getPaymentCurrency(p);
      if (!byCat.has(cat)) byCat.set(cat, {});
      const catAmounts = byCat.get(cat)!;
      catAmounts[cur] = (catAmounts[cur] || 0) + Number(p.amount || 0);
    }

    // Sort by total amount across all currencies (approximate for ranking)
    return Array.from(byCat.entries())
      .map(([category, amounts]) => ({
        category,
        amounts,
        total: Object.values(amounts).reduce((s, a) => s + a, 0),
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);
  }, [payments, businesses, bizCurrencyMap]);

  const maxCatRevenue = Math.max(...categoryRevenue.map(c => c.total), 1);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Finance</h1>
          <p className="mt-1 text-sm text-gray-500">Comprehensive financial dashboard</p>
        </div>
        <div className="flex items-center gap-2">
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none" />
          <span className="text-sm text-gray-400">to</span>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none" />
          {(dateFrom || dateTo) && (
            <button onClick={() => { setDateFrom(''); setDateTo(''); }}
              className="text-xs text-brand hover:underline">Clear</button>
          )}
          <button
            onClick={() => downloadCSV(
              monthly.map(r => ({
                month: r.month,
                currency: r.currency,
                transactions: r.transactions,
                gross: r.gross,
                refunded: r.refunded,
                platform_fees: r.fees,
                payouts: r.payouts,
                net: r.net,
              })),
              `finance-monthly-${new Date().toISOString().slice(0, 10)}.csv`,
            )}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
          >
            Export CSV
          </button>
        </div>
      </div>

      {/* Metric Cards */}
      {/* Per-currency transaction volume */}
      {Object.keys(metrics.grossVolume).length > 0 && (
        <div className="mt-6">
          <h3 className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-3">Transaction Volume by Currency</h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Object.entries(metrics.grossVolume).filter(([, a]) => a > 0).map(([cur, amt]) => (
              <MetricCard key={`vol-${cur}`} label={`Volume (${cur})`} value={formatMoney(amt, cur)} color="blue" />
            ))}
            {Object.entries(metrics.totalRefunds).filter(([, a]) => a > 0).map(([cur, amt]) => (
              <MetricCard key={`ref-${cur}`} label={`Refunds (${cur})`} value={formatMoney(amt, cur)} color="red" />
            ))}
          </div>
        </div>
      )}

      {/* Platform metrics — per currency */}
      <div className="mt-6">
        <h3 className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-3">Platform</h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Platform Fees Earned" value={formatMultiCurrency(metrics.platformFeesByCurrency)} color="green" />
          <MetricCard label="Payouts Owed" value={formatMultiCurrency(metrics.payoutsOwedByCurrency)} color="yellow" />
          <MetricCard label="Paid Out" value={formatMultiCurrency(metrics.paidOutByCurrency)} color="green" />
          <MetricCard label="Outstanding Liability" value={formatMultiCurrency(metrics.outstandingByCurrency)} color="red" />
        </div>
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

      {/* Gateway Breakdown + ARR */}
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-gray-900">Payment Gateway Breakdown</h3>
          <div className="mt-4 space-y-3">
            {Object.entries(metrics.gatewayBuckets).map(([gw, data]) => (
              <div key={gw} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <span className={`inline-block h-3 w-3 rounded-full ${
                    gw === 'stripe' ? 'bg-purple-400' :
                    gw === 'paystack' ? 'bg-blue-400' :
                    'bg-gray-400'
                  }`} />
                  <span className="text-gray-600 capitalize">{gw}</span>
                </div>
                <div className="text-right">
                  <span className="font-medium text-gray-900">{data.count} txns</span>
                  <span className="ml-2 text-gray-500">({formatMoney(data.amount)})</span>
                </div>
              </div>
            ))}
            {Object.keys(metrics.gatewayBuckets).length === 0 && (
              <p className="text-xs text-gray-400">No payment data</p>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-gray-900">Recurring Revenue</h3>
          <div className="mt-4 space-y-4">
            {(() => {
              const mrrByCurrency: Record<string, number> = {};
              for (const sub of subscriptions) {
                const cur = sub.currency || 'NGN';
                const monthly = sub.amount || 0;
                mrrByCurrency[cur] = (mrrByCurrency[cur] || 0) + monthly;
              }
              const entries = Object.entries(mrrByCurrency).filter(([, a]) => a > 0);
              if (entries.length === 0) return <p className="text-xs text-gray-400">No active subscriptions</p>;
              return entries.map(([cur, mrr]) => (
                <div key={cur} className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">MRR ({cur})</span>
                    <span className="font-semibold text-gray-900">{formatMoney(mrr, cur)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">ARR ({cur})</span>
                    <span className="font-semibold text-gray-900">{formatMoney(mrr * 12, cur)}</span>
                  </div>
                </div>
              ));
            })()}
          </div>
        </div>
      </div>

      {/* Revenue by Category */}
      {categoryRevenue.length > 0 && (
        <div className="mt-8 rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-gray-900">Revenue by Business Category</h3>
          <div className="mt-4 space-y-3">
            {categoryRevenue.map(({ category, amounts, total }) => (
              <div key={category} className="flex items-center gap-3">
                <span className="w-24 text-sm text-gray-600 capitalize truncate">{category}</span>
                <div className="flex-1 h-6 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-brand rounded-full transition-all"
                    style={{ width: `${(total / maxCatRevenue) * 100}%` }}
                  />
                </div>
                <span className="text-sm font-medium text-gray-900 w-36 text-right">{formatMultiCurrency(amounts)}</span>
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
              const FLAG: Record<string, string> = { NG: '🇳🇬', US: '🇺🇸', GB: '🇬🇧', CA: '🇨🇦', GH: '🇬🇭', KE: '🇰🇪', ZA: '🇿🇦', IN: '🇮🇳' };
              const countryToCur: Record<string, string> = { US: 'USD', CA: 'CAD', GB: 'GBP', NG: 'NGN', GH: 'GHS', KE: 'KES', ZA: 'ZAR' };
              return Array.from(byCountry.entries())
                .sort((a, b) => b[1].count - a[1].count)
                .map(([cc, data]) => (
                  <div key={cc} className="flex items-center justify-between text-sm">
                    <span className="text-gray-700">{FLAG[cc] || '🌍'} {cc}</span>
                    <div className="text-right space-x-3">
                      <span className="text-gray-500">{data.count} biz</span>
                      <span className="text-gray-500">{data.subs} paid</span>
                      <span className="font-medium text-gray-900">{formatMoney(data.revenue, countryToCur[cc] || 'USD')}</span>
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
              const byTier = new Map<string, { count: number; mrrByCurrency: Record<string, number> }>();
              for (const b of businesses) {
                const tier = b.subscription_tier || 'free';
                const row = byTier.get(tier) || { count: 0, mrrByCurrency: {} };
                row.count++;
                byTier.set(tier, row);
              }
              for (const s of subscriptions) {
                const tier = s.tier || 'free';
                const row = byTier.get(tier) || { count: 0, mrrByCurrency: {} };
                const cur = s.currency || 'NGN';
                row.mrrByCurrency[cur] = (row.mrrByCurrency[cur] || 0) + Number(s.amount || 0);
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
                const data = byTier.get(tier) || { count: 0, mrrByCurrency: {} };
                const pct = Math.round((data.count / totalBiz) * 100);
                return (
                  <div key={tier}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="text-gray-700">{TIER_LABELS[tier] || tier}</span>
                      <div className="text-right space-x-3">
                        <span className="text-gray-500">{data.count} ({pct}%)</span>
                        <span className="font-medium text-green-700">MRR: {formatMultiCurrency(data.mrrByCurrency)}</span>
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
      {subscriptions.length > 0 && (() => {
        const mrrByCur: Record<string, number> = {};
        for (const sub of subscriptions) {
          const cur = sub.currency || 'NGN';
          mrrByCur[cur] = (mrrByCur[cur] || 0) + Number(sub.amount || 0);
        }
        return (
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <MetricCard
              label="Total MRR (Subscriptions)"
              value={formatMultiCurrency(mrrByCur)}
              color="green"
            />
            <MetricCard
              label="Active Paid Subscribers"
              value={String(subscriptions.length)}
              color="blue"
            />
            <MetricCard
              label="Avg Revenue Per Subscriber"
              value={formatMultiCurrency(Object.fromEntries(
                Object.entries(mrrByCur).map(([cur, amt]) => {
                  const count = subscriptions.filter(s => (s.currency || 'NGN') === cur).length;
                  return [cur, count > 0 ? amt / count : 0];
                })
              ))}
              color="purple"
            />
          </div>
        );
      })()}

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
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Currency</th>
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
                  <tr key={`${row.month}-${row.currency}`} className="transition hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{formatMonth(row.month)}</td>
                    <td className="px-4 py-3 text-gray-600">{row.currency}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{row.transactions}</td>
                    <td className="px-4 py-3 text-right text-gray-900">{formatMoney(row.gross, row.currency)}</td>
                    <td className="px-4 py-3 text-right text-red-600">{row.refunded > 0 ? formatMoney(row.refunded, row.currency) : '—'}</td>
                    <td className="px-4 py-3 text-right text-green-700">{formatMoney(row.fees, row.currency)}</td>
                    <td className="px-4 py-3 text-right text-orange-700">{formatMoney(row.payouts, row.currency)}</td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">{formatMoney(row.net, row.currency)}</td>
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
  const locales: Record<string, string> = { NGN: 'en-NG', USD: 'en-US', GBP: 'en-GB', CAD: 'en-CA', GHS: 'en-GH', KES: 'en-KE', ZAR: 'en-ZA' };
  const wholeOnly = ['NGN', 'GHS', 'KES'].includes(currency);
  const hasCents = !wholeOnly && amount % 1 !== 0;
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
