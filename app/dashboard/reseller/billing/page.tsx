'use client';

import { useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { PageHelp } from '@/components/dashboard/PageHelp';

interface BillingSummary {
  billing_type: 'per_seat' | 'revenue_share' | 'flat_monthly';
  commission_rate: number;
  total_accounts: number;
  commission_earned: number;
  revenue_this_month: number;
}

interface CommissionEntry {
  id: string;
  amount: number;
  description: string;
  sub_account_name: string;
  created_at: string;
}

const BILLING_TYPE_LABELS: Record<string, { label: string; description: string }> = {
  per_seat: { label: 'Per Seat', description: 'You pay a fixed fee per active sub-account each month' },
  revenue_share: { label: 'Revenue Share', description: 'You earn a percentage of each sub-account\'s revenue' },
  flat_monthly: { label: 'Flat Monthly', description: 'You pay a fixed monthly fee regardless of account count' },
};

export default function ResellerBillingPage() {
  const business = useBusiness();
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [commissions, setCommissions] = useState<CommissionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    loadBillingData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business.id]);

  async function loadBillingData() {
    try {
      setError(false);
      const [statsRes, commissionsRes] = await Promise.all([
        fetch(`/api/reseller/stats?business_id=${business.id}`),
        fetch(`/api/reseller/commissions?business_id=${business.id}`),
      ]);

      if (statsRes.ok) {
        const data = await statsRes.json();
        setSummary({
          billing_type: data.billing_type || 'revenue_share',
          commission_rate: data.commission_rate ?? 0,
          total_accounts: data.total_accounts ?? 0,
          commission_earned: data.commission_earned ?? 0,
          revenue_this_month: data.revenue_this_month ?? 0,
        });
      } else {
        setError(true);
      }

      if (commissionsRes.ok) {
        const data = await commissionsRes.json();
        setCommissions(data.commissions || []);
      }
    } catch {
      setError(true);
    }
    setLoading(false);
  }

  function formatCurrency(amount: number) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount / 100);
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  const billingInfo = summary ? BILLING_TYPE_LABELS[summary.billing_type] : null;

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Billing & Commission</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Your reseller billing summary and commission history
        </p>
      </div>

      <PageHelp
        pageKey="reseller-billing"
        title="Billing & Commission"
        description="Track your reseller commissions and billing details. Commissions are calculated based on your billing type and paid out monthly."
      />

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          Something went wrong loading data.{' '}
          <button onClick={() => { setError(false); loadBillingData(); }} className="font-medium underline hover:no-underline">
            Try again
          </button>
        </div>
      )}

      {/* Billing Summary Cards */}
      {summary && (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {/* Billing Type */}
          <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
            <div className="inline-flex rounded-lg bg-blue-50 dark:bg-blue-900/20 p-2 text-blue-600 dark:text-blue-400">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 14l2 2 4-4m5 4.5V7a2 2 0 00-2-2H6a2 2 0 00-2 2v12.5l3.5-2 3.5 2 3.5-2 3.5 2z" />
              </svg>
            </div>
            <p className="mt-3 text-lg font-bold text-gray-900 dark:text-gray-100">
              {billingInfo?.label || summary.billing_type}
            </p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Billing Type</p>
            {billingInfo && (
              <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">{billingInfo.description}</p>
            )}
          </div>

          {/* Commission Rate */}
          <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
            <div className="inline-flex rounded-lg bg-green-50 dark:bg-green-900/20 p-2 text-green-600 dark:text-green-400">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <p className="mt-3 text-lg font-bold text-gray-900 dark:text-gray-100">
              {summary.commission_rate}%
            </p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Commission Rate</p>
          </div>

          {/* Commission Earned */}
          <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
            <div className="inline-flex rounded-lg bg-amber-50 dark:bg-amber-900/20 p-2 text-amber-600 dark:text-amber-400">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            </div>
            <p className="mt-3 text-lg font-bold text-gray-900 dark:text-gray-100">
              {formatCurrency(summary.commission_earned)}
            </p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Total Commission Earned</p>
          </div>
        </div>
      )}

      {/* Monthly Revenue Overview */}
      {summary && (
        <div className="mt-6 rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">This Month</h2>
          <div className="mt-3 grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400">Sub-Account Revenue</p>
              <p className="mt-1 text-xl font-bold text-gray-900 dark:text-gray-100">
                {formatCurrency(summary.revenue_this_month)}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400">Your Commission</p>
              <p className="mt-1 text-xl font-bold text-brand">
                {formatCurrency(Math.round(summary.revenue_this_month * (summary.commission_rate / 100)))}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Recent Commissions */}
      <div className="mt-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Recent Commissions</h2>

        {commissions.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-gray-200 dark:border-gray-700 py-12 text-center">
            <svg className="mx-auto h-10 w-10 text-gray-300 dark:text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">No commission entries yet</p>
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              Commissions appear here as your sub-accounts generate revenue
            </p>
          </div>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Date</th>
                  <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Sub-Account</th>
                  <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Description</th>
                  <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 dark:text-gray-400">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700">
                {commissions.map((entry) => (
                  <tr key={entry.id}>
                    <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                      {new Date(entry.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap">
                      {entry.sub_account_name}
                    </td>
                    <td className="px-4 py-2.5 text-gray-700 dark:text-gray-300">
                      {entry.description}
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium text-green-600 dark:text-green-400 whitespace-nowrap">
                      {formatCurrency(entry.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
