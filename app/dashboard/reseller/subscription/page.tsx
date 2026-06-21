'use client';

import { useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { PageHelp } from '@/components/dashboard/PageHelp';

const RESELLER_TIERS = {
  starter: {
    price: 29900,
    label: 'Starter',
    maxAccounts: 10,
    features: [
      'Up to 10 sub-accounts',
      'Basic analytics dashboard',
      'Email support',
      'Commission tracking',
      'Standard branding',
    ],
  },
  professional: {
    price: 79900,
    label: 'Professional',
    maxAccounts: 50,
    features: [
      'Up to 50 sub-accounts',
      'Advanced analytics & reports',
      'Priority support',
      'Commission tracking',
      'Custom branding',
      'Bulk account management',
      'API access',
    ],
  },
  enterprise: {
    price: 150000,
    label: 'Enterprise',
    maxAccounts: 999,
    features: [
      'Unlimited sub-accounts',
      'Enterprise analytics suite',
      'Dedicated account manager',
      'Commission tracking',
      'White-label branding',
      'Bulk account management',
      'Full API access',
      'Custom integrations',
      'SLA guarantee',
    ],
  },
} as const;

type TierKey = keyof typeof RESELLER_TIERS;

interface SubscriptionInfo {
  tier: TierKey;
  label: string;
  price: number;
  maxAccounts: number;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
  current_period_end: number | null;
  mode?: string;
}

interface Invoice {
  id: string;
  amount: number;
  description: string;
  status: string;
  due_date: string | null;
  paid_at: string | null;
  period_start: string | null;
  period_end: string | null;
  line_items: unknown;
  created_at: string;
}

export default function ResellerSubscriptionPage() {
  const business = useBusiness();
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [upgrading, setUpgrading] = useState<TierKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business.id]);

  async function loadData() {
    try {
      setError(null);
      const [subRes, invRes] = await Promise.all([
        fetch('/api/reseller/subscription'),
        fetch('/api/reseller/invoices'),
      ]);

      if (subRes.ok) {
        const data = await subRes.json();
        setSubscription(data);
      } else {
        const data = await subRes.json();
        setError(data.error || 'Failed to load subscription');
      }

      if (invRes.ok) {
        const data = await invRes.json();
        setInvoices(data.invoices || []);
      }
    } catch {
      setError('Something went wrong loading data');
    }
    setLoading(false);
  }

  async function handleUpgrade(tier: TierKey) {
    if (upgrading) return;
    setUpgrading(tier);
    setError(null);

    try {
      const res = await fetch('/api/reseller/subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier }),
      });

      if (res.ok) {
        const data = await res.json();
        setSubscription(data);
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to update subscription');
      }
    } catch {
      setError('Something went wrong. Please try again.');
    }
    setUpgrading(null);
  }

  async function handleCancel() {
    if (!confirm('Are you sure you want to cancel your subscription? Access continues until the end of your billing period.')) {
      return;
    }
    setError(null);

    try {
      const res = await fetch('/api/reseller/subscription', { method: 'DELETE' });
      if (res.ok) {
        await loadData();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to cancel subscription');
      }
    } catch {
      setError('Something went wrong. Please try again.');
    }
  }

  function formatCurrency(amount: number) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount / 100);
  }

  function formatDate(dateStr: string | null | undefined) {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  function formatTimestamp(ts: number | null | undefined) {
    if (!ts) return null;
    return new Date(ts * 1000).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  const currentTier = subscription?.tier || 'starter';
  const tierOrder: TierKey[] = ['starter', 'professional', 'enterprise'];
  const currentTierIndex = tierOrder.indexOf(currentTier);

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
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Subscription</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Manage your reseller plan and view invoices
        </p>
      </div>

      <PageHelp
        pageKey="reseller-subscription"
        title="Subscription Management"
        description="Choose the plan that fits your needs. Upgrade anytime to unlock more sub-accounts and features."
      />

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Current Plan Summary */}
      {subscription && (
        <div className="mt-6 rounded-xl border border-brand/30 bg-brand/5 dark:bg-brand/10 p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  {RESELLER_TIERS[currentTier]?.label || currentTier} Plan
                </h2>
                <span className="inline-flex items-center rounded-full bg-brand/10 px-2.5 py-0.5 text-xs font-medium text-brand dark:text-brand-light">
                  Current Plan
                </span>
              </div>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {formatCurrency(RESELLER_TIERS[currentTier]?.price || 0)}/month
                {' '}&middot;{' '}
                Up to {RESELLER_TIERS[currentTier]?.maxAccounts || 0} sub-accounts
              </p>
              {subscription.subscription_status && (
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                  Status: <span className="capitalize">{subscription.subscription_status}</span>
                  {subscription.current_period_end && (
                    <> &middot; Renews {formatTimestamp(subscription.current_period_end)}</>
                  )}
                </p>
              )}
            </div>
            {subscription.stripe_subscription_id && (
              <button
                onClick={handleCancel}
                className="text-sm text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {/* Tier Comparison Cards */}
      <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {tierOrder.map((tierKey, index) => {
          const tier = RESELLER_TIERS[tierKey];
          const isCurrent = tierKey === currentTier;
          const isUpgrade = index > currentTierIndex;
          const isDowngrade = index < currentTierIndex;

          return (
            <div
              key={tierKey}
              className={`relative rounded-xl border p-6 transition-shadow ${
                isCurrent
                  ? 'border-brand shadow-md ring-1 ring-brand/20'
                  : 'border-gray-200 dark:border-gray-700 hover:shadow-sm'
              } bg-white dark:bg-gray-800`}
            >
              {tierKey === 'professional' && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="inline-flex items-center rounded-full bg-brand px-3 py-0.5 text-xs font-medium text-white">
                    Most Popular
                  </span>
                </div>
              )}

              <div className="text-center">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  {tier.label}
                </h3>
                <p className="mt-2">
                  <span className="text-3xl font-bold text-gray-900 dark:text-gray-100">
                    {formatCurrency(tier.price)}
                  </span>
                  <span className="text-sm text-gray-500 dark:text-gray-400">/mo</span>
                </p>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  {tier.maxAccounts === 999 ? 'Unlimited' : `Up to ${tier.maxAccounts}`} sub-accounts
                </p>
              </div>

              <ul className="mt-6 space-y-3">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
                    <svg className="mt-0.5 h-4 w-4 shrink-0 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    {feature}
                  </li>
                ))}
              </ul>

              <div className="mt-6">
                {isCurrent ? (
                  <button
                    disabled
                    className="w-full rounded-lg bg-gray-100 dark:bg-gray-700 px-4 py-2.5 text-sm font-medium text-gray-500 dark:text-gray-400 cursor-not-allowed"
                  >
                    Current Plan
                  </button>
                ) : isUpgrade ? (
                  <button
                    onClick={() => handleUpgrade(tierKey)}
                    disabled={!!upgrading}
                    className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50 transition-colors"
                  >
                    {upgrading === tierKey ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                        Upgrading...
                      </span>
                    ) : (
                      'Upgrade'
                    )}
                  </button>
                ) : isDowngrade ? (
                  <button
                    onClick={() => handleUpgrade(tierKey)}
                    disabled={!!upgrading}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
                  >
                    {upgrading === tierKey ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
                        Processing...
                      </span>
                    ) : (
                      'Downgrade'
                    )}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {/* Invoice History */}
      <div className="mt-10">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Invoice History</h2>

        {invoices.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-gray-200 dark:border-gray-700 py-12 text-center">
            <svg className="mx-auto h-10 w-10 text-gray-300 dark:text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 14l2 2 4-4m5 4.5V7a2 2 0 00-2-2H6a2 2 0 00-2 2v12.5l3.5-2 3.5 2 3.5-2 3.5 2z" />
            </svg>
            <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">No invoices yet</p>
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              Invoices will appear here once billing begins
            </p>
          </div>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Date</th>
                  <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Description</th>
                  <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Period</th>
                  <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 dark:text-gray-400">Amount</th>
                  <th scope="col" className="px-4 py-2.5 text-center text-xs font-medium text-gray-500 dark:text-gray-400">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700">
                {invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                      {formatDate(invoice.created_at)}
                    </td>
                    <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-gray-100">
                      {invoice.description || 'Reseller subscription'}
                    </td>
                    <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                      {invoice.period_start && invoice.period_end
                        ? `${formatDate(invoice.period_start)} - ${formatDate(invoice.period_end)}`
                        : '-'}
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap">
                      {formatCurrency(invoice.amount)}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          invoice.status === 'paid'
                            ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'
                            : invoice.status === 'overdue'
                              ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'
                              : 'bg-yellow-50 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-400'
                        }`}
                      >
                        {invoice.status}
                      </span>
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
