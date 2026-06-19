'use client';

import { useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { PageHelp } from '@/components/dashboard/PageHelp';
import Link from 'next/link';

interface ResellerStats {
  total_accounts: number;
  active_accounts: number;
  revenue_this_month: number;
  commission_earned: number;
  max_sub_accounts: number;
  billing_type: string;
  commission_rate: number;
}

interface SubAccount {
  id: string;
  name: string;
  category: string;
  status: string;
  subscription_tier: string;
  created_at: string;
}

export default function ResellerOverviewPage() {
  const business = useBusiness();
  const [stats, setStats] = useState<ResellerStats | null>(null);
  const [recentAccounts, setRecentAccounts] = useState<SubAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [isReseller, setIsReseller] = useState(true);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business.id]);

  async function loadData() {
    try {
      setError(false);
      const [statsRes, accountsRes] = await Promise.all([
        fetch(`/api/reseller/stats?business_id=${business.id}`),
        fetch(`/api/reseller/accounts?business_id=${business.id}&limit=5`),
      ]);

      if (statsRes.status === 403) {
        setIsReseller(false);
        setLoading(false);
        return;
      }

      if (statsRes.ok) {
        const statsData = await statsRes.json();
        setStats(statsData);
      } else {
        setError(true);
      }

      if (accountsRes.ok) {
        const accountsData = await accountsRes.json();
        setRecentAccounts(accountsData.accounts || []);
      }
    } catch {
      setError(true);
    }
    setLoading(false);
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  if (!isReseller) {
    return (
      <div className="mx-auto mt-16 flex max-w-md flex-col items-center text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-brand-50 dark:bg-brand-900/30">
          <svg className="h-10 w-10 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
          </svg>
        </div>
        <h3 className="mt-6 text-lg font-bold text-gray-900 dark:text-gray-100">
          You&apos;re not registered as a reseller
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
          Resellers can manage multiple client businesses from a single dashboard.
          Contact our support team to learn about the reseller program and get set up.
        </p>
        <a
          href="mailto:support@waaiio.com"
          className="mt-6 rounded-xl bg-brand px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-600 hover:shadow-md active:scale-[0.98]"
        >
          Contact Support
        </a>
      </div>
    );
  }

  function formatCurrency(amount: number) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount / 100);
  }

  function formatCategory(cat: string) {
    return cat.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }

  const statCards = [
    {
      label: 'Total Accounts',
      value: stats?.total_accounts ?? 0,
      format: 'number' as const,
      color: 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400',
      icon: 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4',
    },
    {
      label: 'Active',
      value: stats?.active_accounts ?? 0,
      format: 'number' as const,
      color: 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400',
      icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
    },
    {
      label: 'Revenue This Month',
      value: stats?.revenue_this_month ?? 0,
      format: 'currency' as const,
      color: 'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
      icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    },
    {
      label: 'Commission Earned',
      value: stats?.commission_earned ?? 0,
      format: 'currency' as const,
      color: 'bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400',
      icon: 'M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z',
    },
  ];

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Reseller Portal</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Manage your client accounts and track commissions
          </p>
        </div>
        <Link
          href="/dashboard/reseller/accounts"
          className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"
        >
          Manage Accounts
        </Link>
      </div>

      <PageHelp
        pageKey="reseller-overview"
        title="Reseller Portal"
        description="Your reseller dashboard shows an overview of all client accounts you manage. Add new accounts, track their activity, and monitor your commission earnings from this portal."
      />

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          Something went wrong loading data.{' '}
          <button onClick={() => { setError(false); loadData(); }} className="font-medium underline hover:no-underline">
            Try again
          </button>
        </div>
      )}

      {/* Stats Grid */}
      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {statCards.map((card) => (
          <div
            key={card.label}
            className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5"
          >
            <div className={`inline-flex rounded-lg p-2 ${card.color}`}>
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={card.icon} />
              </svg>
            </div>
            <p className="mt-3 text-2xl font-bold text-gray-900 dark:text-gray-100">
              {card.format === 'currency' ? formatCurrency(card.value) : card.value}
            </p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{card.label}</p>
          </div>
        ))}
      </div>

      {/* Account usage */}
      {stats && stats.max_sub_accounts > 0 && (
        <div className="mt-4 rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Account Usage</p>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {stats.total_accounts} of {stats.max_sub_accounts} accounts used
            </p>
          </div>
          <div className="mt-2 h-2 w-full rounded-full bg-gray-100 dark:bg-gray-700">
            <div
              className="h-2 rounded-full bg-brand transition-all"
              style={{ width: `${Math.min((stats.total_accounts / stats.max_sub_accounts) * 100, 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Recent Accounts */}
      <div className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Recent Accounts</h2>
          <Link
            href="/dashboard/reseller/accounts"
            className="text-sm font-medium text-brand hover:text-brand-600"
          >
            View All
          </Link>
        </div>

        {recentAccounts.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-gray-200 dark:border-gray-700 p-8 text-center">
            <p className="text-sm text-gray-500 dark:text-gray-400">No accounts yet</p>
            <Link
              href="/dashboard/reseller/accounts"
              className="mt-3 inline-block rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
            >
              Add Your First Account
            </Link>
          </div>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Name</th>
                  <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Category</th>
                  <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Tier</th>
                  <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Status</th>
                  <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700">
                {recentAccounts.map((account) => (
                  <tr key={account.id}>
                    <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap">
                      {account.name}
                    </td>
                    <td className="px-4 py-2.5 text-gray-700 dark:text-gray-300 whitespace-nowrap">
                      {formatCategory(account.category)}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className="inline-block rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand capitalize">
                        {account.subscription_tier}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                        account.status === 'active'
                          ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                      }`}>
                        {account.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                      {new Date(account.created_at).toLocaleDateString()}
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
