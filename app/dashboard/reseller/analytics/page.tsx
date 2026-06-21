'use client';

import { useEffect, useState, useMemo } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { PageHelp } from '@/components/dashboard/PageHelp';

interface Account {
  id: string;
  name: string;
  category: string;
  status: string;
  total_revenue: number;
  total_bookings: number;
  total_orders: number;
  commission_generated: number;
  last_activity: string | null;
}

interface MonthlyTrend {
  month: string;
  revenue: number;
  commission: number;
  new_accounts: number;
}

interface TopAccount {
  id: string;
  name: string;
  revenue: number;
}

interface AnalyticsData {
  accounts: Account[];
  monthly_trend: MonthlyTrend[];
  top_accounts: TopAccount[];
}

export default function ResellerAnalyticsPage() {
  const business = useBusiness();
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business.id]);

  async function loadData() {
    try {
      setError(false);
      setLoading(true);
      const res = await fetch('/api/reseller/analytics');
      if (!res.ok) {
        setError(true);
        setLoading(false);
        return;
      }
      const json = await res.json();
      setData(json);
    } catch {
      setError(true);
    }
    setLoading(false);
  }

  const filteredAccounts = useMemo(() => {
    if (!data) return [];
    if (!search.trim()) return data.accounts;
    const q = search.toLowerCase();
    return data.accounts.filter((a) => a.name.toLowerCase().includes(q));
  }, [data, search]);

  const totals = useMemo(() => {
    return filteredAccounts.reduce(
      (acc, a) => ({
        revenue: acc.revenue + a.total_revenue,
        bookings: acc.bookings + a.total_bookings,
        orders: acc.orders + a.total_orders,
        commission: acc.commission + a.commission_generated,
      }),
      { revenue: 0, bookings: 0, orders: 0, commission: 0 }
    );
  }, [filteredAccounts]);

  function formatCurrency(amount: number) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount / 100);
  }

  function formatCategory(cat: string) {
    return cat.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
  }

  function formatDate(dateStr: string | null) {
    if (!dateStr) return '--';
    return new Date(dateStr).toLocaleDateString();
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mt-8 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-400">
        Something went wrong loading analytics.{' '}
        <button onClick={loadData} className="font-medium underline hover:no-underline">
          Try again
        </button>
      </div>
    );
  }

  const maxRevenue = Math.max(...data.monthly_trend.map((m) => m.revenue), 1);

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Reseller Analytics</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Detailed performance breakdown of your portfolio
          </p>
        </div>
      </div>

      <PageHelp
        pageKey="reseller-analytics"
        title="Reseller Analytics"
        description="Track revenue, commissions, and account activity across your entire reseller portfolio. Use the monthly trend chart to spot growth patterns and the breakdown table to identify top performers."
      />

      {/* Monthly Trend Chart */}
      <div className="mt-6 rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Monthly Revenue Trend</h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Last 6 months</p>
        <div className="mt-4 flex items-end gap-3" style={{ height: 160 }}>
          {data.monthly_trend.map((m) => {
            const pct = maxRevenue > 0 ? (m.revenue / maxRevenue) * 100 : 0;
            return (
              <div key={m.month} className="flex flex-1 flex-col items-center gap-1">
                <span className="text-[10px] font-medium text-gray-700 dark:text-gray-300">
                  {formatCurrency(m.revenue)}
                </span>
                <div className="w-full flex flex-col justify-end" style={{ height: 120 }}>
                  <div
                    className="w-full rounded-t bg-brand transition-all"
                    style={{ height: `${Math.max(pct, 2)}%` }}
                  />
                </div>
                <span className="text-[10px] text-gray-500 dark:text-gray-400">
                  {m.month.slice(5)}
                </span>
              </div>
            );
          })}
        </div>
        <div className="mt-4 flex gap-6 border-t border-gray-100 dark:border-gray-700 pt-3">
          {data.monthly_trend.map((m) => (
            <div key={m.month} className="flex-1 text-center">
              <p className="text-[10px] text-gray-500 dark:text-gray-400">Commission</p>
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300">{formatCurrency(m.commission)}</p>
              <p className="mt-1 text-[10px] text-gray-500 dark:text-gray-400">New</p>
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300">{m.new_accounts}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Top Performing Accounts */}
      {data.top_accounts.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Top Performing Accounts</h2>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {data.top_accounts.map((account, i) => (
              <div
                key={account.id}
                className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-4"
              >
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand/10 text-xs font-bold text-brand">
                    {i + 1}
                  </span>
                  <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{account.name}</p>
                </div>
                <p className="mt-2 text-lg font-bold text-gray-900 dark:text-gray-100">
                  {formatCurrency(account.revenue)}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">Total Revenue</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Account Breakdown Table */}
      <div className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Account Breakdown</h2>
          <input
            type="text"
            placeholder="Search accounts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>

        <div className="mt-3 overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
              <tr>
                <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Name</th>
                <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Category</th>
                <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Status</th>
                <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 dark:text-gray-400">Revenue</th>
                <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 dark:text-gray-400">Bookings</th>
                <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 dark:text-gray-400">Orders</th>
                <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 dark:text-gray-400">Commission</th>
                <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Last Activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-700">
              {filteredAccounts.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                    {search ? 'No accounts match your search' : 'No accounts found'}
                  </td>
                </tr>
              ) : (
                <>
                  {filteredAccounts.map((account) => (
                    <tr key={account.id}>
                      <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap">
                        {account.name}
                      </td>
                      <td className="px-4 py-2.5 text-gray-700 dark:text-gray-300 whitespace-nowrap">
                        {formatCategory(account.category)}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                            account.status === 'active'
                              ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                              : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                          }`}
                        >
                          {account.status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-900 dark:text-gray-100 whitespace-nowrap">
                        {formatCurrency(account.total_revenue)}
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-700 dark:text-gray-300 whitespace-nowrap">
                        {account.total_bookings}
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-700 dark:text-gray-300 whitespace-nowrap">
                        {account.total_orders}
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-900 dark:text-gray-100 whitespace-nowrap">
                        {formatCurrency(account.commission_generated)}
                      </td>
                      <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                        {formatDate(account.last_activity)}
                      </td>
                    </tr>
                  ))}
                  {/* Summary row */}
                  <tr className="bg-gray-50 dark:bg-gray-800 font-semibold">
                    <td className="px-4 py-2.5 text-gray-900 dark:text-gray-100">Totals</td>
                    <td className="px-4 py-2.5" />
                    <td className="px-4 py-2.5" />
                    <td className="px-4 py-2.5 text-right text-gray-900 dark:text-gray-100">
                      {formatCurrency(totals.revenue)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-gray-700 dark:text-gray-300">
                      {totals.bookings}
                    </td>
                    <td className="px-4 py-2.5 text-right text-gray-700 dark:text-gray-300">
                      {totals.orders}
                    </td>
                    <td className="px-4 py-2.5 text-right text-gray-900 dark:text-gray-100">
                      {formatCurrency(totals.commission)}
                    </td>
                    <td className="px-4 py-2.5" />
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
