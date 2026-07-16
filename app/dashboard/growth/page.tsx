'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { PageHelp } from '@/components/dashboard/PageHelp';
import EmptyState from '@/components/dashboard/EmptyState';

interface GrowthMetrics {
  totalContacts: number;
  whatsappEligible: number;
  needConsent: number;
  optedOut: number;
  creditsAvailable: number;
}

interface RecentActivity {
  id: string;
  type: string;
  description: string;
  created_at: string;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

export default function GrowthOverviewPage() {
  const business = useBusiness();
  const supabase = createClient();

  const [metrics, setMetrics] = useState<GrowthMetrics>({
    totalContacts: 0,
    whatsappEligible: 0,
    needConsent: 0,
    optedOut: 0,
    creditsAvailable: 0,
  });
  const [recentActivity, setRecentActivity] = useState<RecentActivity[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);

    const [
      contactsRes,
      eligibleRes,
      noConsentRes,
      optOutRes,
      creditsRes,
      activityRes,
    ] = await Promise.all([
      // Total contacts
      supabase
        .from('growth_contacts')
        .select('*', { count: 'exact', head: true })
        .eq('business_id', business.id),
      // WhatsApp eligible
      supabase
        .from('growth_contacts')
        .select('*', { count: 'exact', head: true })
        .eq('business_id', business.id)
        .in('eligibility', ['template_eligible', 'service_window']),
      // Need consent (no consent)
      supabase
        .from('growth_contacts')
        .select('*', { count: 'exact', head: true })
        .eq('business_id', business.id)
        .eq('has_consent', false),
      // Opted out
      supabase
        .from('messaging_opt_outs')
        .select('*', { count: 'exact', head: true })
        .eq('business_id', business.id),
      // Credits
      supabase
        .from('growth_credits')
        .select('balance')
        .eq('business_id', business.id)
        .limit(1)
        .maybeSingle(),
      // Recent activity
      supabase
        .from('growth_activity')
        .select('id, type, description, created_at')
        .eq('business_id', business.id)
        .order('created_at', { ascending: false })
        .limit(10),
    ]);

    setMetrics({
      totalContacts: contactsRes.count ?? 0,
      whatsappEligible: eligibleRes.count ?? 0,
      needConsent: noConsentRes.count ?? 0,
      optedOut: optOutRes.count ?? 0,
      creditsAvailable: creditsRes.data?.balance ?? 0,
    });
    setRecentActivity((activityRes.data as RecentActivity[]) || []);
    setLoading(false);
  }, [business.id, supabase]);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business.id]);

  const metricCards = [
    { label: 'Imported Contacts', value: metrics.totalContacts, color: 'text-brand-700 dark:text-brand-300' },
    { label: 'WhatsApp Eligible', value: metrics.whatsappEligible, color: 'text-green-700 dark:text-green-300' },
    { label: 'Need Consent', value: metrics.needConsent, color: 'text-amber-700 dark:text-amber-300' },
    { label: 'Opted Out', value: metrics.optedOut, color: 'text-red-700 dark:text-red-300' },
    { label: 'Credits Available', value: metrics.creditsAvailable, color: 'text-blue-700 dark:text-blue-300' },
  ];

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Growth</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Import contacts, manage consent, and run outreach campaigns
        </p>
        <PageHelp
          pageKey="growth"
          title="Growth Engine"
          description="Import your contacts, manage WhatsApp consent, and create campaigns to grow your business. Start by importing contacts from a CSV file."
        />
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
        </div>
      )}

      {!loading && (
        <>
          {/* Metric cards */}
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {metricCards.map((card) => (
              <div
                key={card.label}
                className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4"
              >
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{card.label}</p>
                <p className={`mt-1 text-2xl font-bold ${card.color}`}>{card.value}</p>
              </div>
            ))}
          </div>

          {/* CTA buttons */}
          <div className="mb-6 flex flex-wrap gap-3">
            <Link
              href="/dashboard/growth/import"
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 transition-colors"
            >
              Import Contacts
            </Link>
            <Link
              href="/dashboard/growth/campaigns"
              className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              Create Campaign
            </Link>
          </div>

          {/* Recent activity */}
          {recentActivity.length === 0 ? (
            <EmptyState
              icon={'\uD83D\uDE80'}
              title="No activity yet"
              description="Import contacts to get started with your growth engine"
              actionLabel="Import Contacts"
              actionHref="/dashboard/growth/import"
            />
          ) : (
            <div>
              <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-white">Recent Activity</h2>
              <div className="space-y-2">
                {recentActivity.map((activity) => (
                  <div
                    key={activity.id}
                    className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3"
                  >
                    <div>
                      <span className="inline-flex items-center rounded-full bg-brand-100 dark:bg-brand-900/30 px-2 py-0.5 text-xs font-medium text-brand-700 dark:text-brand-300 mr-2">
                        {activity.type}
                      </span>
                      <span className="text-sm text-gray-900 dark:text-white">{activity.description}</span>
                    </div>
                    <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap ml-4">
                      {formatDate(activity.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
