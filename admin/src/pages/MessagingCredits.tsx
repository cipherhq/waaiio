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
  const [page, setPage] = useState(1);
  const perPage = 20;

  // Balances view
  const [allowances, setAllowances] = useState<AllowanceRow[]>([]);
  const [businesses, setBusinesses] = useState<Map<string, BusinessInfo>>(new Map());

  // Purchases view
  const [purchases, setPurchases] = useState<PurchaseRow[]>([]);

  // Summary stats
  const [totalPurchased, setTotalPurchased] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [suspendedCount, setSuspendedCount] = useState(0);
  const [reviewCount, setReviewCount] = useState(0);

  useEffect(() => {
    async function load() {
      setLoading(true);

      if (view === 'balances') {
        // Load all active allowances with remaining credit
        const { data: allAllowances } = await adminDb
          .from('messaging_allowances')
          .select('id, business_id, type, amount_minor, currency_code, remaining_minor, source_ref, expires_at, created_at')
          .gt('remaining_minor', 0)
          .order('business_id', { ascending: true });

        const rows = allAllowances || [];
        setAllowances(rows);

        // Load business info
        const bizIds = [...new Set(rows.map(r => r.business_id))];
        if (bizIds.length > 0) {
          const { data: bizData } = await adminDb
            .from('businesses')
            .select('id, name, subscription_tier, country_code, messaging_suspended')
            .in('id', bizIds);
          const bizMap = new Map<string, BusinessInfo>();
          for (const b of bizData || []) {
            bizMap.set(b.id, b as BusinessInfo);
          }
          setBusinesses(bizMap);
          setSuspendedCount([...bizMap.values()].filter(b => b.messaging_suspended).length);
        }
      } else {
        // Load all purchases
        const { data: allPurchases } = await adminDb
          .from('messaging_topup_purchases')
          .select('id, business_id, owner_id, package_amount_minor, currency_code, gateway, status, created_at, completed_at, refunded_at, refund_amount_minor, consumed_shortfall_minor')
          .order('created_at', { ascending: false });

        const rows = allPurchases || [];
        setPurchases(rows);
        setTotalPurchased(rows.filter(p => p.status === 'completed').reduce((sum, p) => sum + p.package_amount_minor, 0));
        setPendingCount(rows.filter(p => p.status === 'pending').length);
        setReviewCount(rows.filter(p => p.status === 'review').length);

        // Load business info for purchases
        const bizIds = [...new Set(rows.map(r => r.business_id))];
        if (bizIds.length > 0) {
          const { data: bizData } = await adminDb
            .from('businesses')
            .select('id, name, subscription_tier, country_code, messaging_suspended')
            .in('id', bizIds);
          const bizMap = new Map<string, BusinessInfo>();
          for (const b of bizData || []) {
            bizMap.set(b.id, b as BusinessInfo);
          }
          setBusinesses(bizMap);
        }
      }

      setLoading(false);
    }
    load();
  }, [view]);

  // Group allowances by business for balance view
  const businessBalances = new Map<string, AllowanceRow[]>();
  for (const a of allowances) {
    const existing = businessBalances.get(a.business_id) || [];
    existing.push(a);
    businessBalances.set(a.business_id, existing);
  }
  const sortedBusinessIds = [...businessBalances.keys()].sort((a, b) => {
    const aName = businesses.get(a)?.name || '';
    const bName = businesses.get(b)?.name || '';
    return aName.localeCompare(bName);
  });

  const totalItems = view === 'balances' ? sortedBusinessIds.length : purchases.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / perPage));
  const pageStart = (page - 1) * perPage;
  const pageEnd = pageStart + perPage;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Messaging Credits</h1>
          <p className="mt-1 text-sm text-gray-500">
            Per-business messaging credit balances and top-up purchases
          </p>
        </div>
        <div className="flex rounded-lg border border-gray-200 bg-white">
          <button
            onClick={() => { setView('balances'); setPage(1); }}
            className={`px-4 py-2 text-sm font-medium rounded-l-lg ${
              view === 'balances' ? 'bg-purple-600 text-white' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            Balances
          </button>
          <button
            onClick={() => { setView('purchases'); setPage(1); }}
            className={`px-4 py-2 text-sm font-medium rounded-r-lg ${
              view === 'purchases' ? 'bg-purple-600 text-white' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            Purchases
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {view === 'balances' ? (
          <>
            <SummaryCard
              title="Businesses with Credit"
              value={sortedBusinessIds.length}
              icon={<CreditCard className="h-5 w-5" />}
            />
            <SummaryCard
              title="Suspended"
              value={suspendedCount}
              icon={<AlertTriangle className="h-5 w-5" />}
              variant={suspendedCount > 0 ? 'danger' : 'default'}
            />
          </>
        ) : (
          <>
            <SummaryCard
              title="Total Purchases"
              value={purchases.length}
              icon={<CreditCard className="h-5 w-5" />}
            />
            <SummaryCard
              title="Pending"
              value={pendingCount}
              icon={<Clock className="h-5 w-5" />}
              variant={pendingCount > 0 ? 'warning' : 'default'}
            />
            <SummaryCard
              title="Needs Review"
              value={reviewCount}
              icon={<AlertTriangle className="h-5 w-5" />}
              variant={reviewCount > 0 ? 'danger' : 'default'}
            />
            <SummaryCard
              title="Completed"
              value={purchases.filter(p => p.status === 'completed').length}
              icon={<CheckCircle className="h-5 w-5" />}
            />
          </>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-purple-600 border-t-transparent" />
        </div>
      ) : view === 'balances' ? (
        /* ── Balances View ── */
        <div className="rounded-xl border border-gray-200 bg-white">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs text-gray-500">
                  <th className="px-4 py-3 font-medium">Business</th>
                  <th className="px-4 py-3 font-medium">Tier</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium text-right">Remaining</th>
                  <th className="px-4 py-3 font-medium text-right">Total</th>
                  <th className="px-4 py-3 font-medium">Expires</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {sortedBusinessIds.slice(pageStart, pageEnd).map(bizId => {
                  const biz = businesses.get(bizId);
                  const bizAllowances = businessBalances.get(bizId) || [];
                  return bizAllowances.map((a, idx) => (
                    <tr key={a.id} className="border-b border-gray-50 last:border-0">
                      {idx === 0 && (
                        <>
                          <td className="px-4 py-3 font-medium text-gray-900" rowSpan={bizAllowances.length}>
                            <div className="flex items-center gap-2">
                              {biz?.name || bizId.slice(0, 8)}
                              {biz?.messaging_suspended && (
                                <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700">Suspended</span>
                              )}
                            </div>
                            <span className="text-xs text-gray-400">{biz?.country_code}</span>
                          </td>
                          <td className="px-4 py-3 text-gray-500 capitalize" rowSpan={bizAllowances.length}>
                            {biz?.subscription_tier || 'free'}
                          </td>
                        </>
                      )}
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          a.type === 'purchased' ? 'bg-blue-50 text-blue-700' :
                          a.type === 'trial_grant' ? 'bg-purple-50 text-purple-700' :
                          'bg-green-50 text-green-700'
                        }`}>
                          {TYPE_LABELS[a.type] || a.type}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900">
                        {formatMinor(a.remaining_minor, a.currency_code)}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-500">
                        {formatMinor(a.amount_minor, a.currency_code)}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {a.expires_at
                          ? new Date(a.expires_at).toLocaleDateString()
                          : <span className="text-gray-300">Never</span>
                        }
                      </td>
                      <td className="px-4 py-3">
                        {a.expires_at && new Date(a.expires_at) <= new Date()
                          ? <span className="text-xs text-red-500">Expired</span>
                          : <span className="text-xs text-green-600">Active</span>
                        }
                      </td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="border-t border-gray-100 px-4 py-3">
              <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
            </div>
          )}
        </div>
      ) : (
        /* ── Purchases View ── */
        <div className="rounded-xl border border-gray-200 bg-white">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs text-gray-500">
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium">Business</th>
                  <th className="px-4 py-3 font-medium text-right">Amount</th>
                  <th className="px-4 py-3 font-medium">Gateway</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Refunded</th>
                  <th className="px-4 py-3 font-medium text-right">Shortfall</th>
                </tr>
              </thead>
              <tbody>
                {purchases.slice(pageStart, pageEnd).map(p => {
                  const biz = businesses.get(p.business_id);
                  return (
                    <tr key={p.id} className="border-b border-gray-50 last:border-0">
                      <td className="whitespace-nowrap px-4 py-3 text-gray-700">
                        {new Date(p.created_at).toLocaleDateString(undefined, {
                          year: 'numeric', month: 'short', day: 'numeric',
                        })}
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {biz?.name || p.business_id.slice(0, 8)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right font-medium text-gray-900">
                        {formatMinor(p.package_amount_minor, p.currency_code)}
                      </td>
                      <td className="px-4 py-3 text-gray-500 capitalize">{p.gateway}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          STATUS_COLORS[p.status] || 'bg-gray-100 text-gray-600'
                        }`}>
                          {p.status === 'partially_refunded' ? 'Partial Refund'
                            : p.status.charAt(0).toUpperCase() + p.status.slice(1)}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right text-gray-500">
                        {p.refund_amount_minor
                          ? formatMinor(p.refund_amount_minor, p.currency_code)
                          : '--'}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        {p.consumed_shortfall_minor
                          ? <span className="font-medium text-red-600">{formatMinor(p.consumed_shortfall_minor, p.currency_code)}</span>
                          : <span className="text-gray-400">--</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="border-t border-gray-100 px-4 py-3">
              <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
