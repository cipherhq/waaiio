import { useEffect, useState } from 'react';
import { adminDb } from '@/lib/supabase';
import { SummaryCard } from '@/components/SummaryCard';
import { Pagination } from '@/components/Pagination';
import { CreditCard, AlertTriangle, CheckCircle, Clock } from 'lucide-react';

interface AllowanceRow {
  id: string;
  business_id: string;
  type: string;
  amount_minor: number;
  currency_code: string;
  remaining_minor: number;
  source_ref: string;
  expires_at: string | null;
  created_at: string;
}

interface PurchaseRow {
  id: string;
  business_id: string;
  owner_id: string;
  package_amount_minor: number;
  currency_code: string;
  gateway: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  refunded_at: string | null;
  refund_amount_minor: number | null;
  consumed_shortfall_minor: number | null;
}

interface BusinessInfo {
  id: string;
  name: string;
  subscription_tier: string;
  country_code: string;
  messaging_suspended: boolean;
}

type ViewMode = 'balances' | 'purchases';

const STATUS_COLORS: Record<string, string> = {
  completed: 'bg-green-100 text-green-700',
  pending: 'bg-yellow-100 text-yellow-700',
  failed: 'bg-red-100 text-red-700',
  refunded: 'bg-gray-100 text-gray-700',
  partially_refunded: 'bg-amber-100 text-amber-700',
  disputed: 'bg-red-100 text-red-700',
  review: 'bg-orange-100 text-orange-700',
};

const TYPE_LABELS: Record<string, string> = {
  trial_grant: 'Trial',
  subscription_included: 'Subscription',
  purchased: 'Purchased',
  promotional: 'Promotional',
};

function formatMinor(amount: number, currency: string): string {
  const symbols: Record<string, string> = {
    NGN: '\u20A6', USD: '$', GBP: '\u00A3', CAD: 'CA$', GHS: 'GH\u20B5',
  };
  const sym = symbols[currency?.toUpperCase()] || currency + ' ';
  return `${sym}${(amount / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
}

export default function MessagingCredits() {
  const [view, setView] = useState<ViewMode>('balances');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const perPage = 20;

  // Balances view — business-first, includes exhausted
  const [balanceBusinesses, setBalanceBusinesses] = useState<BusinessInfo[]>([]);
  const [allowancesByBiz, setAllowancesByBiz] = useState<Map<string, AllowanceRow[]>>(new Map());
  const [balanceTotalCount, setBalanceTotalCount] = useState(0);
  const [suspendedCount, setSuspendedCount] = useState(0);

  // Purchases view — server-paginated
  const [purchases, setPurchases] = useState<PurchaseRow[]>([]);
  const [purchaseTotalCount, setPurchaseTotalCount] = useState(0);
  const [purchaseBusinesses, setPurchaseBusinesses] = useState<Map<string, BusinessInfo>>(new Map());
  const [pageStatusCounts, setPageStatusCounts] = useState<{ pending: number; review: number; completed: number }>({ pending: 0, review: 0, completed: 0 });

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);

      if (view === 'balances') {
        const { data: allBizAllowances, error: allowErr } = await adminDb
          .from('messaging_allowances')
          .select('business_id')
          .order('business_id', { ascending: true });

        if (allowErr) { setError(`Failed to load allowances: ${allowErr.message}`); setLoading(false); return; }

        const distinctBizIds = [...new Set((allBizAllowances || []).map(r => r.business_id))];
        setBalanceTotalCount(distinctBizIds.length);
        const pageBizIds = distinctBizIds.slice((page - 1) * perPage, page * perPage);

        if (pageBizIds.length === 0) { setBalanceBusinesses([]); setAllowancesByBiz(new Map()); setSuspendedCount(0); setLoading(false); return; }

        const { data: bizData, error: bizErr } = await adminDb.from('businesses')
          .select('id, name, subscription_tier, country_code, messaging_suspended').in('id', pageBizIds).order('name', { ascending: true });
        if (bizErr) { setError(`Failed to load businesses: ${bizErr.message}`); setLoading(false); return; }
        setBalanceBusinesses((bizData || []) as BusinessInfo[]);

        const { count: suspCount } = await adminDb.from('businesses')
          .select('id', { count: 'exact', head: true }).in('id', distinctBizIds).eq('messaging_suspended', true);
        setSuspendedCount(suspCount ?? 0);

        const { data: pageAllowances, error: pageAllowErr } = await adminDb.from('messaging_allowances')
          .select('id, business_id, type, amount_minor, currency_code, remaining_minor, source_ref, expires_at, created_at')
          .in('business_id', pageBizIds).order('created_at', { ascending: true });
        if (pageAllowErr) { setError(`Failed to load allowance details: ${pageAllowErr.message}`); setLoading(false); return; }

        const byBiz = new Map<string, AllowanceRow[]>();
        for (const a of pageAllowances || []) { const e = byBiz.get(a.business_id) || []; e.push(a as AllowanceRow); byBiz.set(a.business_id, e); }
        setAllowancesByBiz(byBiz);
      } else {
        const rangeStart = (page - 1) * perPage;
        const { count: totalCount, error: countErr } = await adminDb.from('messaging_topup_purchases').select('id', { count: 'exact', head: true });
        if (countErr) { setError(`Failed to count purchases: ${countErr.message}`); setLoading(false); return; }
        setPurchaseTotalCount(totalCount ?? 0);

        const { data: pageData, error: pageErr } = await adminDb.from('messaging_topup_purchases')
          .select('id, business_id, owner_id, package_amount_minor, currency_code, gateway, status, created_at, completed_at, refunded_at, refund_amount_minor, consumed_shortfall_minor')
          .order('created_at', { ascending: false }).range(rangeStart, rangeStart + perPage - 1);
        if (pageErr) { setError(`Failed to load purchases: ${pageErr.message}`); setLoading(false); return; }

        const rows = (pageData || []) as PurchaseRow[];
        setPurchases(rows);
        setPageStatusCounts({ pending: rows.filter(p => p.status === 'pending').length, review: rows.filter(p => p.status === 'review').length, completed: rows.filter(p => p.status === 'completed').length });

        const bizIds = [...new Set(rows.map(r => r.business_id))];
        if (bizIds.length > 0) {
          const { data: bizData } = await adminDb.from('businesses').select('id, name, subscription_tier, country_code, messaging_suspended').in('id', bizIds);
          const m = new Map<string, BusinessInfo>(); for (const b of bizData || []) m.set(b.id, b as BusinessInfo); setPurchaseBusinesses(m);
        } else { setPurchaseBusinesses(new Map()); }
      }
      setLoading(false);
    }
    load();
  }, [view, page]);

  const totalItems = view === 'balances' ? balanceTotalCount : purchaseTotalCount;
  const totalPages = Math.max(1, Math.ceil(totalItems / perPage));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Messaging Credits</h1>
          <p className="mt-1 text-sm text-gray-500">Per-business messaging credit balances and top-up purchases</p>
        </div>
        <div className="flex rounded-lg border border-gray-200 bg-white">
          <button onClick={() => { setView('balances'); setPage(1); }} className={`px-4 py-2 text-sm font-medium rounded-l-lg ${view === 'balances' ? 'bg-purple-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>Balances</button>
          <button onClick={() => { setView('purchases'); setPage(1); }} className={`px-4 py-2 text-sm font-medium rounded-r-lg ${view === 'purchases' ? 'bg-purple-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>Purchases</button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {view === 'balances' ? (<>
          <SummaryCard title="Businesses with Allowances" value={balanceTotalCount} icon={<CreditCard className="h-5 w-5" />} />
          <SummaryCard title="Suspended" value={suspendedCount} icon={<AlertTriangle className="h-5 w-5" />} variant={suspendedCount > 0 ? 'danger' : 'default'} />
        </>) : (<>
          <SummaryCard title="Total Purchases" value={purchaseTotalCount} icon={<CreditCard className="h-5 w-5" />} />
          <SummaryCard title="Pending (this page)" value={pageStatusCounts.pending} icon={<Clock className="h-5 w-5" />} variant={pageStatusCounts.pending > 0 ? 'warning' : 'default'} />
          <SummaryCard title="Needs Review (this page)" value={pageStatusCounts.review} icon={<AlertTriangle className="h-5 w-5" />} variant={pageStatusCounts.review > 0 ? 'danger' : 'default'} />
          <SummaryCard title="Completed (this page)" value={pageStatusCounts.completed} icon={<CheckCircle className="h-5 w-5" />} />
        </>)}
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {loading ? (
        <div className="flex items-center justify-center py-20"><div className="h-8 w-8 animate-spin rounded-full border-2 border-purple-600 border-t-transparent" /></div>
      ) : error ? null : view === 'balances' ? (
        balanceBusinesses.length === 0 ? (
          <div className="rounded-xl border border-gray-200 bg-white px-6 py-12 text-center text-sm text-gray-500">No businesses with messaging allowances found.</div>
        ) : (
          <div className="rounded-xl border border-gray-200 bg-white">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr className="border-b border-gray-100 text-xs text-gray-500">
                  <th className="px-4 py-3 font-medium">Business</th><th className="px-4 py-3 font-medium">Tier</th><th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium text-right">Remaining</th><th className="px-4 py-3 font-medium text-right">Total</th><th className="px-4 py-3 font-medium">Expires</th><th className="px-4 py-3 font-medium">Status</th>
                </tr></thead>
                <tbody>{balanceBusinesses.map(biz => {
                  const bizAllowances = allowancesByBiz.get(biz.id) || [];
                  if (bizAllowances.length === 0) return (
                    <tr key={biz.id} className="border-b border-gray-50"><td className="px-4 py-3 font-medium text-gray-900"><div className="flex items-center gap-2">{biz.name}{biz.messaging_suspended && <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700">Suspended</span>}</div><span className="text-xs text-gray-400">{biz.country_code}</span></td><td className="px-4 py-3 text-gray-500 capitalize">{biz.subscription_tier || 'free'}</td><td className="px-4 py-3 text-gray-400 italic" colSpan={5}>No allowance data</td></tr>
                  );
                  return bizAllowances.map((a, idx) => (
                    <tr key={a.id} className="border-b border-gray-50 last:border-0">
                      {idx === 0 && (<><td className="px-4 py-3 font-medium text-gray-900" rowSpan={bizAllowances.length}><div className="flex items-center gap-2">{biz.name}{biz.messaging_suspended && <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700">Suspended</span>}</div><span className="text-xs text-gray-400">{biz.country_code}</span></td><td className="px-4 py-3 text-gray-500 capitalize" rowSpan={bizAllowances.length}>{biz.subscription_tier || 'free'}</td></>)}
                      <td className="px-4 py-3"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${a.type === 'purchased' ? 'bg-blue-50 text-blue-700' : a.type === 'trial_grant' ? 'bg-purple-50 text-purple-700' : 'bg-green-50 text-green-700'}`}>{TYPE_LABELS[a.type] || a.type}</span></td>
                      <td className={`px-4 py-3 text-right font-medium ${a.remaining_minor === 0 ? 'text-red-600' : 'text-gray-900'}`}>{formatMinor(a.remaining_minor, a.currency_code)}</td>
                      <td className="px-4 py-3 text-right text-gray-500">{formatMinor(a.amount_minor, a.currency_code)}</td>
                      <td className="px-4 py-3 text-xs text-gray-500">{a.expires_at ? new Date(a.expires_at).toLocaleDateString() : <span className="text-gray-300">Never</span>}</td>
                      <td className="px-4 py-3">{a.remaining_minor === 0 ? <span className="text-xs text-red-500">Exhausted</span> : a.expires_at && new Date(a.expires_at) <= new Date() ? <span className="text-xs text-red-500">Expired</span> : <span className="text-xs text-green-600">Active</span>}</td>
                    </tr>));
                })}</tbody>
              </table>
            </div>
            {totalPages > 1 && <div className="border-t border-gray-100 px-4 py-3"><Pagination page={page} totalPages={totalPages} onPageChange={setPage} /></div>}
          </div>)
      ) : (
        purchases.length === 0 ? (
          <div className="rounded-xl border border-gray-200 bg-white px-6 py-12 text-center text-sm text-gray-500">No top-up purchases found.</div>
        ) : (
          <div className="rounded-xl border border-gray-200 bg-white">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr className="border-b border-gray-100 text-xs text-gray-500">
                  <th className="px-4 py-3 font-medium">Date</th><th className="px-4 py-3 font-medium">Business</th><th className="px-4 py-3 font-medium text-right">Amount</th>
                  <th className="px-4 py-3 font-medium">Gateway</th><th className="px-4 py-3 font-medium">Status</th><th className="px-4 py-3 font-medium text-right">Refunded</th><th className="px-4 py-3 font-medium text-right">Shortfall</th>
                </tr></thead>
                <tbody>{purchases.map(p => {
                  const biz = purchaseBusinesses.get(p.business_id);
                  return (<tr key={p.id} className="border-b border-gray-50 last:border-0">
                    <td className="whitespace-nowrap px-4 py-3 text-gray-700">{new Date(p.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</td>
                    <td className="px-4 py-3 font-medium text-gray-900">{biz?.name || p.business_id.slice(0, 8)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-medium text-gray-900">{formatMinor(p.package_amount_minor, p.currency_code)}</td>
                    <td className="px-4 py-3 text-gray-500 capitalize">{p.gateway}</td>
                    <td className="px-4 py-3"><span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[p.status] || 'bg-gray-100 text-gray-600'}`}>{p.status === 'partially_refunded' ? 'Partial Refund' : p.status.charAt(0).toUpperCase() + p.status.slice(1)}</span></td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-gray-500">{p.refund_amount_minor ? formatMinor(p.refund_amount_minor, p.currency_code) : '--'}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">{p.consumed_shortfall_minor ? <span className="font-medium text-red-600">{formatMinor(p.consumed_shortfall_minor, p.currency_code)}</span> : <span className="text-gray-400">--</span>}</td>
                  </tr>);
                })}</tbody>
              </table>
            </div>
            {totalPages > 1 && <div className="border-t border-gray-100 px-4 py-3"><Pagination page={page} totalPages={totalPages} onPageChange={setPage} /></div>}
          </div>)
      )}
    </div>
  );
}
