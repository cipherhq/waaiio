'use client';

import { Fragment, useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { PageHelp } from '@/components/dashboard/PageHelp';
import {
  PRICING_TIERS,
  CONVERSATION_LIMITS,
  BROADCAST_LIMITS,
  TIER_MARKETING_NAMES,
  type SubscriptionTier,
} from '@/lib/constants';
import Link from 'next/link';

interface SubscriptionRow {
  id: string;
  plan: string;
  status: string;
  amount: number;
  currency: string;
  gateway: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancelled_at: string | null;
}

interface PaymentRow {
  id: string;
  amount: number;
  currency: string;
  gateway: string;
  gateway_reference: string | null;
  plan: string;
  action: string;
  status: string;
  created_at: string;
}

interface FeeLineItem {
  payment_id: string;
  amount: number;
  fee: number;
  date: string;
  description?: string;
}

interface FeeInvoiceRow {
  id: string;
  invoice_number: string;
  period_start: string;
  period_end: string;
  total_transaction_amount: number;
  total_fee_amount: number;
  transaction_count: number;
  currency: string;
  status: string;
  due_date: string;
  paid_at: string | null;
  paid_via: string | null;
  line_items: FeeLineItem[] | null;
  created_at: string;
}

export default function BillingPage() {
  const business = useBusiness();
  const tier = ((business as any).subscription_tier || 'free') as SubscriptionTier;

  const [loading, setLoading] = useState(true);
  const [subscription, setSubscription] = useState<SubscriptionRow | null>(null);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [feeInvoices, setFeeInvoices] = useState<FeeInvoiceRow[]>([]);
  const [expandedInvoices, setExpandedInvoices] = useState<Set<string>>(new Set());

  // Usage stats
  const [conversationCount, setConversationCount] = useState(0);
  const [broadcastCount, setBroadcastCount] = useState(0);
  const [aiCallCount, setAiCallCount] = useState(0);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const supabase = createClient();
      const monthKey = new Date().toISOString().slice(0, 7);

      const [subRes, paymentsRes, convRes, broadcastRes, aiRes, feeInvoicesRes] = await Promise.all([
        // Current subscription
        supabase
          .from('subscriptions')
          .select('id, plan, status, amount, currency, gateway, current_period_start, current_period_end, cancelled_at')
          .eq('business_id', business.id)
          .limit(1)
          .maybeSingle(),

        // Payment history
        supabase
          .from('subscription_payments')
          .select('id, amount, currency, gateway, gateway_reference, plan, action, status, created_at')
          .eq('business_id', business.id)
          .order('created_at', { ascending: false })
          .limit(50),

        // Conversation usage this month
        supabase
          .from('conversation_usage')
          .select('conversation_count')
          .eq('business_id', business.id)
          .eq('month_key', monthKey)
          .maybeSingle(),

        // Broadcast usage this month
        supabase
          .from('broadcast_usage')
          .select('broadcast_count')
          .eq('business_id', business.id)
          .eq('month_key', monthKey)
          .maybeSingle(),

        // AI usage this month (bot sessions as proxy)
        supabase
          .from('bot_sessions')
          .select('id', { count: 'exact', head: true })
          .eq('business_id', business.id)
          .gte('created_at', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()),

        // Platform fee invoices
        supabase
          .from('platform_fee_invoices')
          .select('id, invoice_number, period_start, period_end, total_transaction_amount, total_fee_amount, transaction_count, currency, status, due_date, paid_at, paid_via, line_items, created_at')
          .eq('business_id', business.id)
          .order('created_at', { ascending: false })
          .limit(50),
      ]);

      setSubscription(subRes.data || null);
      setPayments(paymentsRes.data || []);
      setConversationCount(convRes.data?.conversation_count ?? 0);
      setBroadcastCount(broadcastRes.data?.broadcast_count ?? 0);
      setAiCallCount(aiRes.count ?? 0);
      setFeeInvoices(feeInvoicesRes.data || []);

      setLoading(false);
    }
    load();
  }, [business.id]);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  const tierConfig = PRICING_TIERS[tier];
  const marketingName = TIER_MARKETING_NAMES[tier];
  const conversationLimit = CONVERSATION_LIMITS[tier];
  const broadcastLimit = BROADCAST_LIMITS[tier];

  // Determine plan status
  const isActive = subscription?.status === 'active';
  const isCancelled = subscription?.status === 'cancelled';
  const periodEnd = subscription?.current_period_end ? new Date(subscription.current_period_end) : null;
  const isExpired = periodEnd ? periodEnd < new Date() : false;

  let statusLabel: string;
  let statusColor: string;
  if (tier === 'free') {
    statusLabel = 'Free';
    statusColor = 'bg-gray-100 text-gray-700';
  } else if (isCancelled || isExpired) {
    statusLabel = 'Expired';
    statusColor = 'bg-red-100 text-red-700';
  } else if (isActive) {
    statusLabel = 'Active';
    statusColor = 'bg-green-100 text-green-700';
  } else {
    statusLabel = 'Inactive';
    statusColor = 'bg-yellow-100 text-yellow-700';
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Billing</h1>
          <p className="mt-1 text-sm text-gray-500">Manage your plan and view payment history</p>
        </div>
        <Link
          href="/dashboard/settings"
          className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 transition"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          Manage Plan
        </Link>
      </div>

      <PageHelp
        pageKey="billing"
        title="Billing & Subscription"
        description="View your current plan, usage limits, and payment history. Upgrade or downgrade from the Settings page."
      />

      {/* Current Plan Card */}
      <div className="mt-6 rounded-xl border border-gray-100 bg-white p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">Current Plan</h2>
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${statusColor}`}>
            {statusLabel}
          </span>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-xs text-gray-500">Plan</p>
            <p className="mt-1 text-lg font-bold text-gray-900">{marketingName}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Price</p>
            <p className="mt-1 text-lg font-bold text-gray-900">
              {tier === 'free' ? 'Free' : formatCurrency(subscription?.amount ?? tierConfig.price ?? 0, subscription?.currency || 'NGN')}
              {tier !== 'free' && <span className="text-xs font-normal text-gray-400"> /month</span>}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Platform Fee</p>
            <p className="mt-1 text-lg font-bold text-gray-900">{tierConfig.feePercentage}%</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Next Billing Date</p>
            <p className="mt-1 text-lg font-bold text-gray-900">
              {tier === 'free'
                ? 'N/A'
                : periodEnd
                  ? periodEnd.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
                  : 'N/A'}
            </p>
          </div>
        </div>
        {tier !== 'free' && subscription?.gateway && (
          <p className="mt-4 text-xs text-gray-400">
            Payment via <span className="capitalize">{subscription.gateway}</span>
          </p>
        )}
      </div>

      {/* Usage Summary */}
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <UsageCard
          label="Conversations"
          used={conversationCount}
          limit={conversationLimit}
          description="WhatsApp conversations this month"
        />
        <UsageCard
          label="Broadcasts"
          used={broadcastCount}
          limit={broadcastLimit.maxBroadcasts}
          description="Broadcast messages this month"
        />
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-gray-500">AI Sessions</p>
            <svg className="h-5 w-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <p className="mt-2 text-2xl font-bold text-gray-900">{aiCallCount.toLocaleString()}</p>
          <p className="mt-1 text-xs text-gray-400">Bot sessions this month</p>
        </div>
      </div>

      {/* Payment History */}
      <div className="mt-6 rounded-xl border border-gray-100 bg-white">
        <div className="border-b border-gray-100 px-6 py-4">
          <h2 className="text-sm font-semibold text-gray-900">Payment History</h2>
          <p className="mt-0.5 text-xs text-gray-400">All subscription payments for this business</p>
        </div>
        {payments.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <svg className="mx-auto h-10 w-10 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 14l2 2 4-4m5 4.5V7a2 2 0 00-2-2H6a2 2 0 00-2 2v12.5l3.5-2 3.5 2 3.5-2 3.5 2z" />
            </svg>
            <p className="mt-2 text-sm text-gray-500">No payment history yet</p>
            {tier === 'free' && (
              <p className="mt-1 text-xs text-gray-400">
                Upgrade to a paid plan to see payment records here.
              </p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-50 text-xs text-gray-500">
                  <th className="px-6 py-3 font-medium">Date</th>
                  <th className="px-6 py-3 font-medium">Action</th>
                  <th className="px-6 py-3 font-medium">Plan</th>
                  <th className="px-6 py-3 font-medium text-right">Amount</th>
                  <th className="px-6 py-3 font-medium">Gateway</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id} className="border-b border-gray-50 last:border-0">
                    <td className="whitespace-nowrap px-6 py-3 text-gray-700">
                      {new Date(p.created_at).toLocaleDateString(undefined, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </td>
                    <td className="px-6 py-3">
                      <ActionBadge action={p.action} />
                    </td>
                    <td className="px-6 py-3 text-gray-700 capitalize">
                      {TIER_MARKETING_NAMES[p.plan as SubscriptionTier] || p.plan}
                    </td>
                    <td className="whitespace-nowrap px-6 py-3 text-right font-medium text-gray-900">
                      {p.amount === 0 ? '--' : formatSmallestUnit(p.amount, p.currency)}
                    </td>
                    <td className="px-6 py-3 text-gray-500 capitalize">{p.gateway === 'none' ? '--' : p.gateway}</td>
                    <td className="px-6 py-3">
                      <StatusBadge status={p.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Direct Transfer Fee Invoices */}
      {feeInvoices.length > 0 && (
        <div className="mt-6 rounded-xl border border-gray-100 bg-white">
          <div className="border-b border-gray-100 px-6 py-4">
            <h2 className="text-sm font-semibold text-gray-900">Direct Transfer Fee Invoices</h2>
            <p className="mt-0.5 text-xs text-gray-400">
              Platform fees on direct bank transfer payments, aggregated monthly
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-50 text-xs text-gray-500">
                  <th className="px-6 py-3 font-medium">Invoice #</th>
                  <th className="px-6 py-3 font-medium">Period</th>
                  <th className="px-6 py-3 font-medium text-right">Transfers</th>
                  <th className="px-6 py-3 font-medium text-right">Fee Amount</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                  <th className="px-6 py-3 font-medium">Due Date</th>
                  <th className="px-6 py-3 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {feeInvoices.map((inv) => {
                  const isExpanded = expandedInvoices.has(inv.id);
                  const lineItems = Array.isArray(inv.line_items) ? inv.line_items : [];
                  return (
                    <Fragment key={inv.id}>
                      <tr className="border-b border-gray-50 last:border-0">
                        <td className="whitespace-nowrap px-6 py-3 font-mono text-xs text-gray-700">
                          {inv.invoice_number}
                        </td>
                        <td className="whitespace-nowrap px-6 py-3 text-gray-700">
                          {formatDateShort(inv.period_start)} &ndash; {formatDateShort(inv.period_end)}
                        </td>
                        <td className="px-6 py-3 text-right text-gray-700">{inv.transaction_count}</td>
                        <td className="whitespace-nowrap px-6 py-3 text-right font-medium text-gray-900">
                          {formatSmallestUnit(inv.total_fee_amount, inv.currency)}
                        </td>
                        <td className="px-6 py-3">
                          <FeeStatusBadge status={inv.status} />
                        </td>
                        <td className="whitespace-nowrap px-6 py-3 text-gray-700">
                          {formatDateShort(inv.due_date)}
                        </td>
                        <td className="px-6 py-3">
                          <div className="flex items-center gap-2">
                            {(inv.status === 'pending' || inv.status === 'overdue') && (
                              <a
                                href="mailto:support@waaiio.com?subject=Fee Invoice Payment — "
                                className="text-xs font-medium text-brand hover:text-brand-700"
                              >
                                Contact Support
                              </a>
                            )}
                            {inv.status === 'paid' && inv.paid_at && (
                              <span className="text-xs text-gray-400">
                                Paid {formatDateShort(inv.paid_at)}
                              </span>
                            )}
                            {lineItems.length > 0 && (
                              <button
                                onClick={() => {
                                  setExpandedInvoices((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(inv.id)) next.delete(inv.id);
                                    else next.add(inv.id);
                                    return next;
                                  });
                                }}
                                className="ml-1 text-xs text-gray-400 hover:text-gray-600"
                                title={isExpanded ? 'Hide details' : 'Show details'}
                              >
                                <svg
                                  className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                </svg>
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {isExpanded && lineItems.length > 0 && (
                        <tr>
                          <td colSpan={7} className="bg-gray-50 px-6 py-3">
                            <p className="mb-2 text-xs font-medium text-gray-500">Fee Breakdown</p>
                            <div className="space-y-1">
                              {lineItems.map((item, idx) => (
                                <div key={idx} className="flex items-center justify-between text-xs">
                                  <span className="text-gray-600">
                                    {item.date ? formatDateShort(item.date) : `#${idx + 1}`}
                                    {item.description && ` — ${item.description}`}
                                  </span>
                                  <span className="text-gray-500">
                                    {formatSmallestUnit(item.amount, inv.currency)} transfer
                                    {' '}→{' '}
                                    <span className="font-medium text-gray-700">
                                      {formatSmallestUnit(item.fee, inv.currency)} fee
                                    </span>
                                  </span>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Helper Components ────────────────────────────────────────── */

function UsageCard({
  label,
  used,
  limit,
  description,
}: {
  label: string;
  used: number;
  limit: number;
  description: string;
}) {
  const isUnlimited = limit >= 999999 || limit === Infinity;
  const pct = isUnlimited ? 0 : limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
  const isNearLimit = !isUnlimited && pct >= 80;
  const isAtLimit = !isUnlimited && used >= limit;

  return (
    <div className="rounded-xl border border-gray-100 bg-white p-5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-gray-500">{label}</p>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
            isAtLimit
              ? 'bg-red-100 text-red-700'
              : isNearLimit
                ? 'bg-amber-100 text-amber-700'
                : 'bg-green-100 text-green-700'
          }`}
        >
          {used} / {isUnlimited ? 'Unlimited' : limit.toLocaleString()}
        </span>
      </div>
      {!isUnlimited && (
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-gray-100">
          <div
            className={`h-full rounded-full transition-all ${
              isAtLimit ? 'bg-red-500' : isNearLimit ? 'bg-amber-500' : 'bg-brand'
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      <p className="mt-2 text-xs text-gray-400">{description}</p>
    </div>
  );
}

function ActionBadge({ action }: { action: string }) {
  const styles: Record<string, string> = {
    upgrade: 'bg-brand-50 text-brand-700',
    renewal: 'bg-blue-50 text-blue-700',
    downgrade: 'bg-gray-100 text-gray-600',
  };
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${styles[action] || 'bg-gray-100 text-gray-600'}`}>
      {action}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    success: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
    pending: 'bg-yellow-100 text-yellow-700',
  };
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${styles[status] || 'bg-gray-100 text-gray-600'}`}>
      {status}
    </span>
  );
}

function FeeStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    paid: 'bg-green-100 text-green-700',
    pending: 'bg-yellow-100 text-yellow-700',
    overdue: 'bg-red-100 text-red-700',
    waived: 'bg-gray-100 text-gray-500',
    cancelled: 'bg-gray-100 text-gray-500',
  };
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${styles[status] || 'bg-gray-100 text-gray-600'}`}>
      {status}
    </span>
  );
}

/* ── Formatters ───────────────────────────────────────────────── */

function formatCurrency(amount: number, currency: string): string {
  const symbols: Record<string, string> = {
    NGN: '\u20A6',
    USD: '$',
    GBP: '\u00A3',
    CAD: 'CA$',
    GHS: 'GH\u20B5',
    INR: '\u20B9',
  };
  const sym = symbols[currency.toUpperCase()] || currency + ' ';
  return `${sym}${amount.toLocaleString()}`;
}

function formatDateShort(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatSmallestUnit(amount: number, currency: string): string {
  // Convert from smallest unit (kobo/cents) to major unit
  const major = amount / 100;
  return formatCurrency(major, currency);
}
