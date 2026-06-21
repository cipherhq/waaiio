import { useEffect, useState } from 'react';
import { adminDb } from '@/lib/supabase';
import { useAdminSession } from '@/components/AdminLayout';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDate, fmtCurrency } from '@/lib/formatters';
import { DollarSign, Wallet, TrendingUp, Search, AlertCircle } from 'lucide-react';

interface ResellerFinancial {
  id: string;
  company_name: string;
  tier: string;
  status: string;
  commission_percentage: number;
  active_sub_accounts: number;
  total_revenue: number;
  total_commission_earned: number;
  total_commission_paid: number;
  commission_owed: number;
}

interface MonthlyBreakdown {
  month: string;
  revenue: number;
  commission: number;
}

const PER_PAGE = 20;

export default function ResellerFinancials() {
  const adminSession = useAdminSession();
  const role = adminSession?.role;

  // Role guard: admin + finance only
  if (role !== 'admin' && role !== 'finance') {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertCircle className="h-12 w-12 text-red-400 mb-4" />
        <h2 className="text-xl font-semibold text-gray-900">Access Denied</h2>
        <p className="text-sm text-gray-500 mt-2">This page is restricted to admin and finance roles.</p>
      </div>
    );
  }

  const [resellers, setResellers] = useState<ResellerFinancial[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState('all');
  const [page, setPage] = useState(1);

  // Detail modal
  const [selected, setSelected] = useState<ResellerFinancial | null>(null);
  const [monthlyData, setMonthlyData] = useState<MonthlyBreakdown[]>([]);
  const [monthlyLoading, setMonthlyLoading] = useState(false);

  // Summary totals
  const totalPlatformRevenue = resellers.reduce((sum, r) => sum + r.total_revenue, 0);
  const totalCommissionEarned = resellers.reduce((sum, r) => sum + r.total_commission_earned, 0);
  const totalCommissionPaid = resellers.reduce((sum, r) => sum + r.total_commission_paid, 0);
  const totalOutstanding = resellers.reduce((sum, r) => sum + r.commission_owed, 0);

  useEffect(() => {
    loadFinancials();
  }, []);

  async function loadFinancials() {
    setLoading(true);
    try {
      // Fetch all resellers
      const { data: rows, error } = await adminDb
        .from('resellers')
        .select('id, company_name, billing_type, commission_percentage, status, created_at')
        .order('created_at', { ascending: false });

      if (error || !rows || rows.length === 0) {
        if (error) console.error('Failed to load resellers:', error.message);
        setResellers([]);
        setLoading(false);
        return;
      }

      const resellerIds = rows.map(r => r.id);

      // Count active sub-accounts per reseller
      const { data: subAccounts } = await adminDb
        .from('businesses')
        .select('reseller_id')
        .in('reseller_id', resellerIds)
        .eq('status', 'active');

      const subCountMap = new Map<string, number>();
      if (subAccounts) {
        for (const row of subAccounts) {
          if (row.reseller_id) {
            subCountMap.set(row.reseller_id, (subCountMap.get(row.reseller_id) || 0) + 1);
          }
        }
      }

      // Aggregate platform_fees by reseller_id
      const { data: feeRows } = await adminDb
        .from('platform_fees')
        .select('reseller_id, transaction_amount, reseller_commission')
        .in('reseller_id', resellerIds);

      const revenueMap = new Map<string, number>();
      const commissionMap = new Map<string, number>();
      if (feeRows) {
        for (const f of feeRows) {
          if (f.reseller_id) {
            revenueMap.set(f.reseller_id, (revenueMap.get(f.reseller_id) || 0) + (f.transaction_amount || 0));
            commissionMap.set(f.reseller_id, (commissionMap.get(f.reseller_id) || 0) + (f.reseller_commission || 0));
          }
        }
      }

      // Aggregate paid payouts per reseller
      const { data: payoutRows } = await adminDb
        .from('reseller_payouts')
        .select('reseller_id, net_amount')
        .eq('status', 'paid')
        .in('reseller_id', resellerIds);

      const paidMap = new Map<string, number>();
      if (payoutRows) {
        for (const p of payoutRows) {
          if (p.reseller_id) {
            paidMap.set(p.reseller_id, (paidMap.get(p.reseller_id) || 0) + (p.net_amount || 0));
          }
        }
      }

      // Derive tier from billing_type as a simple label
      const tierFromBilling = (billingType: string): string => {
        switch (billingType) {
          case 'per_seat': return 'starter';
          case 'revenue_share': return 'professional';
          case 'flat_monthly': return 'enterprise';
          default: return billingType;
        }
      };

      const enriched: ResellerFinancial[] = rows.map(r => {
        const earned = commissionMap.get(r.id) || 0;
        const paid = paidMap.get(r.id) || 0;
        return {
          id: r.id,
          company_name: r.company_name,
          tier: tierFromBilling(r.billing_type),
          status: r.status,
          commission_percentage: r.commission_percentage,
          active_sub_accounts: subCountMap.get(r.id) || 0,
          total_revenue: revenueMap.get(r.id) || 0,
          total_commission_earned: earned,
          total_commission_paid: paid,
          commission_owed: Math.max(0, earned - paid),
        };
      });

      setResellers(enriched);
    } catch (err) {
      console.error('Failed to load reseller financials:', err);
    } finally {
      setLoading(false);
    }
  }

  async function loadMonthlyBreakdown(resellerId: string) {
    setMonthlyLoading(true);
    setMonthlyData([]);
    try {
      const { data: feeRows } = await adminDb
        .from('platform_fees')
        .select('transaction_amount, reseller_commission, created_at')
        .eq('reseller_id', resellerId)
        .order('created_at', { ascending: true });

      if (!feeRows || feeRows.length === 0) {
        setMonthlyData([]);
        setMonthlyLoading(false);
        return;
      }

      // Group by YYYY-MM
      const monthMap = new Map<string, { revenue: number; commission: number }>();
      for (const f of feeRows) {
        const month = new Date(f.created_at).toISOString().slice(0, 7); // YYYY-MM
        const existing = monthMap.get(month) || { revenue: 0, commission: 0 };
        existing.revenue += f.transaction_amount || 0;
        existing.commission += f.reseller_commission || 0;
        monthMap.set(month, existing);
      }

      const breakdown: MonthlyBreakdown[] = Array.from(monthMap.entries())
        .sort(([a], [b]) => b.localeCompare(a)) // newest first
        .map(([month, data]) => ({
          month,
          revenue: data.revenue,
          commission: data.commission,
        }));

      setMonthlyData(breakdown);
    } catch (err) {
      console.error('Failed to load monthly breakdown:', err);
    } finally {
      setMonthlyLoading(false);
    }
  }

  function handleRowClick(r: ResellerFinancial) {
    setSelected(r);
    loadMonthlyBreakdown(r.id);
  }

  function formatMonth(ym: string): string {
    const [year, month] = ym.split('-');
    const date = new Date(parseInt(year), parseInt(month) - 1);
    return date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  }

  // Filtering
  const filtered = resellers.filter(r => {
    if (tierFilter !== 'all' && r.tier !== tierFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return r.company_name.toLowerCase().includes(q);
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const paginated = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  const tierLabel: Record<string, string> = {
    starter: 'Starter',
    professional: 'Professional',
    enterprise: 'Enterprise',
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Reseller Financials</h1>
        <p className="text-sm text-gray-500 mt-1">Financial overview of all reseller partners.</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Total Platform Revenue" value={fmtCurrency(totalPlatformRevenue / 100, 'USD')} icon={DollarSign} color="blue" />
        <SummaryCard label="Total Commission Earned" value={fmtCurrency(totalCommissionEarned / 100, 'USD')} icon={TrendingUp} color="green" />
        <SummaryCard label="Total Commission Paid" value={fmtCurrency(totalCommissionPaid / 100, 'USD')} icon={Wallet} color="purple" />
        <SummaryCard label="Outstanding Balance" value={fmtCurrency(totalOutstanding / 100, 'USD')} icon={AlertCircle} color={totalOutstanding > 0 ? 'yellow' : 'green'} />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search by company name..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            className="w-full rounded-xl border border-gray-300 py-2.5 pl-10 pr-4 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>
        <select
          value={tierFilter}
          onChange={e => { setTierFilter(e.target.value); setPage(1); }}
          className="rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:border-brand focus:outline-none"
        >
          <option value="all">All Tiers</option>
          <option value="starter">Starter</option>
          <option value="professional">Professional</option>
          <option value="enterprise">Enterprise</option>
        </select>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Company Name</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Tier</th>
              <th className="px-4 py-3 text-center font-medium text-gray-600">Active Sub-Accounts</th>
              <th className="px-4 py-3 text-right font-medium text-gray-600">Total Revenue</th>
              <th className="px-4 py-3 text-right font-medium text-gray-600">Commission Earned</th>
              <th className="px-4 py-3 text-right font-medium text-gray-600">Commission Owed</th>
              <th className="px-4 py-3 text-center font-medium text-gray-600">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                  Loading financials...
                </td>
              </tr>
            ) : paginated.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                  No resellers found.
                </td>
              </tr>
            ) : (
              paginated.map(r => (
                <tr
                  key={r.id}
                  className="hover:bg-gray-50 cursor-pointer transition"
                  onClick={() => handleRowClick(r)}
                >
                  <td className="px-4 py-3 font-medium text-gray-900">{r.company_name}</td>
                  <td className="px-4 py-3 text-gray-600 capitalize">{tierLabel[r.tier] || r.tier}</td>
                  <td className="px-4 py-3 text-center text-gray-700">{r.active_sub_accounts}</td>
                  <td className="px-4 py-3 text-right text-gray-700">{fmtCurrency(r.total_revenue / 100, 'USD')}</td>
                  <td className="px-4 py-3 text-right text-gray-700">{fmtCurrency(r.total_commission_earned / 100, 'USD')}</td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">
                    {r.commission_owed > 0 ? (
                      <span className="text-yellow-700">{fmtCurrency(r.commission_owed / 100, 'USD')}</span>
                    ) : (
                      <span className="text-green-600">{fmtCurrency(0, 'USD')}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center"><StatusBadge status={r.status} /></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Detail Modal with Monthly Breakdown */}
      <DetailModal open={!!selected} onClose={() => setSelected(null)} title="Reseller Financial Details" wide>
        {selected && (
          <div className="space-y-5">
            <div className="space-y-3 text-sm">
              <DetailRow label="Company Name" value={selected.company_name} />
              <DetailRow label="Tier" value={tierLabel[selected.tier] || selected.tier} />
              <DetailRow label="Commission Rate" value={`${selected.commission_percentage}%`} />
              <DetailRow label="Active Sub-Accounts" value={selected.active_sub_accounts} />
              <DetailRow label="Total Revenue" value={fmtCurrency(selected.total_revenue / 100, 'USD')} />
              <DetailRow label="Total Commission Earned" value={fmtCurrency(selected.total_commission_earned / 100, 'USD')} />
              <DetailRow label="Total Commission Paid" value={fmtCurrency(selected.total_commission_paid / 100, 'USD')} />
              <DetailRow label="Commission Owed" value={
                <span className={selected.commission_owed > 0 ? 'text-yellow-700' : 'text-green-600'}>
                  {fmtCurrency(selected.commission_owed / 100, 'USD')}
                </span>
              } />
              <DetailRow label="Status" value={<StatusBadge status={selected.status} />} />
            </div>

            {/* Monthly Breakdown */}
            <div>
              <h4 className="text-sm font-semibold text-gray-900 mb-3">Monthly Breakdown</h4>
              {monthlyLoading ? (
                <p className="text-sm text-gray-400">Loading breakdown...</p>
              ) : monthlyData.length === 0 ? (
                <p className="text-sm text-gray-400">No transaction data available.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-gray-200">
                  <table className="w-full text-sm">
                    <thead className="border-b border-gray-200 bg-gray-50">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium text-gray-600">Month</th>
                        <th className="px-3 py-2 text-right font-medium text-gray-600">Revenue</th>
                        <th className="px-3 py-2 text-right font-medium text-gray-600">Commission</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {monthlyData.map(m => (
                        <tr key={m.month}>
                          <td className="px-3 py-2 text-gray-700">{formatMonth(m.month)}</td>
                          <td className="px-3 py-2 text-right text-gray-700">{fmtCurrency(m.revenue / 100, 'USD')}</td>
                          <td className="px-3 py-2 text-right text-gray-700">{fmtCurrency(m.commission / 100, 'USD')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </DetailModal>
    </div>
  );
}
