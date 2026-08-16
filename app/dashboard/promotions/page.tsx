'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { PageHelp } from '@/components/dashboard/PageHelp';

// ── Types ──────────────────────────────────────────────────────────────────────

interface PromoCampaign {
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'scheduled' | 'active' | 'paused' | 'ended' | 'archived';
  start_at: string | null;
  end_at: string | null;
  keyword: string | null;
  code_entry_mode: string;
  created_at: string;
  updated_at: string;
  // Aggregated stats from /api/promotions/list (DB aggregate counts — 1M-safe)
  total_codes: number;
  total_verifications: number;
  total_winners: number;
  redemption_rate: number;
  unique_participants: number;
}

interface Stats {
  active: number;
  totalCodes: number;
  totalVerifications: number;
  totalWinners: number;
  redemptionRate: number;
}

// ── StatusBadge ────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300',
    scheduled: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300',
    active: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
    paused: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300',
    ended: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300',
    archived: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${colors[status] || colors.draft}`}>
      {status}
    </span>
  );
}

// ── Skeleton ───────────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700 animate-pulse">
      <div className="h-3 w-24 bg-gray-200 dark:bg-gray-700 rounded mb-3" />
      <div className="h-7 w-16 bg-gray-200 dark:bg-gray-700 rounded" />
    </div>
  );
}

function SkeletonRow() {
  return (
    <tr className="animate-pulse">
      <td className="px-4 py-3">
        <div className="h-4 w-32 bg-gray-200 dark:bg-gray-700 rounded mb-1.5" />
        <div className="h-3 w-20 bg-gray-100 dark:bg-gray-800 rounded" />
      </td>
      <td className="px-4 py-3"><div className="h-5 w-16 bg-gray-200 dark:bg-gray-700 rounded-full" /></td>
      <td className="px-4 py-3"><div className="h-4 w-24 bg-gray-200 dark:bg-gray-700 rounded" /></td>
      <td className="px-4 py-3"><div className="h-4 w-12 bg-gray-200 dark:bg-gray-700 rounded" /></td>
      <td className="px-4 py-3"><div className="h-4 w-12 bg-gray-200 dark:bg-gray-700 rounded" /></td>
      <td className="px-4 py-3"><div className="h-4 w-10 bg-gray-200 dark:bg-gray-700 rounded" /></td>
      <td className="px-4 py-3"><div className="h-4 w-12 bg-gray-200 dark:bg-gray-700 rounded" /></td>
      <td className="px-4 py-3"><div className="h-4 w-16 bg-gray-200 dark:bg-gray-700 rounded" /></td>
    </tr>
  );
}

function SkeletonMobileCard() {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 animate-pulse">
      <div className="flex items-start justify-between mb-3">
        <div className="h-4 w-36 bg-gray-200 dark:bg-gray-700 rounded" />
        <div className="h-5 w-16 bg-gray-200 dark:bg-gray-700 rounded-full" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        {[1, 2, 3].map(i => (
          <div key={i}>
            <div className="h-3 w-12 bg-gray-100 dark:bg-gray-700 rounded mb-1" />
            <div className="h-5 w-8 bg-gray-200 dark:bg-gray-700 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatDate(dateStr: string | null) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateRange(start: string | null, end: string | null) {
  if (!start && !end) return '—';
  if (!end) return `From ${formatDate(start)}`;
  if (!start) return `Until ${formatDate(end)}`;
  return `${formatDate(start)} – ${formatDate(end)}`;
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function PromotionsPage() {
  const business = useBusiness();
  const [campaigns, setCampaigns] = useState<PromoCampaign[]>([]);
  const [stats, setStats] = useState<Stats>({ active: 0, totalCodes: 0, totalVerifications: 0, totalWinners: 0, redemptionRate: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business.id]);

  async function loadData() {
    try {
      setError(false);

      // Consume the list API — aggregate counts are computed server-side (1M-safe).
      // Do NOT query promo_campaign_codes / promo_verification_attempts / promo_redemptions
      // directly from the browser client; those tables can be very large.
      const res = await fetch(`/api/promotions/list?businessId=${encodeURIComponent(business.id)}`);
      if (!res.ok) throw new Error(`List API error: ${res.status}`);
      const json = await res.json() as { campaigns?: PromoCampaign[] };
      const rows = json.campaigns || [];

      if (rows.length === 0) {
        setCampaigns([]);
        setStats({ active: 0, totalCodes: 0, totalVerifications: 0, totalWinners: 0, redemptionRate: 0 });
        setLoading(false);
        return;
      }

      // Map API fields to local shape.
      // The list API returns: total_codes, winners_count, total_attempts, pending_fulfillment, unique_participants.
      const enriched: PromoCampaign[] = rows.map(r => {
        const codes = (r as unknown as Record<string, number>).total_codes ?? 0;
        const attempts = (r as unknown as Record<string, number>).total_attempts ?? 0;
        const winners = (r as unknown as Record<string, number>).winners_count ?? 0;
        const uniqueParticipants = (r as unknown as Record<string, number>).unique_participants ?? 0;
        const redemptionRate = codes > 0 ? Math.round((attempts / codes) * 100) : 0;
        return {
          ...r,
          total_codes: codes,
          total_verifications: attempts,
          total_winners: winners,
          redemption_rate: redemptionRate,
          unique_participants: uniqueParticipants,
        } as PromoCampaign;
      });

      setCampaigns(enriched);

      // Summary stats
      const totalCodes = enriched.reduce((s, c) => s + c.total_codes, 0);
      const totalVerifications = enriched.reduce((s, c) => s + c.total_verifications, 0);
      const totalWinners = enriched.reduce((s, c) => s + c.total_winners, 0);
      const overallRate = totalCodes > 0 ? Math.round((totalVerifications / totalCodes) * 100) : 0;

      setStats({
        active: enriched.filter(c => c.status === 'active').length,
        totalCodes,
        totalVerifications,
        totalWinners,
        redemptionRate: overallRate,
      });
    } catch (err) {
      console.warn('[promotions] Failed to load promotions', err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  // ── Loading state ──

  if (loading) {
    return (
      <div>
        {/* Header skeleton */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <div className="h-8 w-40 bg-gray-200 dark:bg-gray-700 rounded animate-pulse mb-2" />
            <div className="h-4 w-64 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
          </div>
          <div className="h-10 w-36 bg-gray-200 dark:bg-gray-700 rounded-lg animate-pulse" />
        </div>
        {/* Stats skeleton */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
          {[1, 2, 3, 4, 5].map(i => <SkeletonCard key={i} />)}
        </div>
        {/* Table skeleton desktop */}
        <div className="hidden md:block bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
              <tr>
                {['Name', 'Status', 'Dates', 'Codes', 'Participants', 'Winners', 'Redemption %', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-700">
              {[1, 2, 3].map(i => <SkeletonRow key={i} />)}
            </tbody>
          </table>
        </div>
        {/* Card skeleton mobile */}
        <div className="md:hidden space-y-3">
          {[1, 2, 3].map(i => <SkeletonMobileCard key={i} />)}
        </div>
      </div>
    );
  }

  // ── Error state ──

  if (error) {
    return (
      <div>
        <div className="flex items-start justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Instant Win Campaigns</h1>
          <Link
            href="/dashboard/promotions/create"
            className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 transition"
          >
            + Create Campaign
          </Link>
        </div>
        <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 px-4 py-4 text-sm text-red-700 dark:text-red-400 flex items-center gap-3">
          <svg className="h-5 w-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span>
            Something went wrong loading your campaigns.{' '}
            <button
              onClick={() => { setLoading(true); loadData(); }}
              className="font-medium underline hover:no-underline"
            >
              Try again
            </button>
          </span>
        </div>
      </div>
    );
  }

  // ── Empty state ──

  if (campaigns.length === 0) {
    return (
      <div>
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Instant Win Campaigns</h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Create code-based campaigns where customers enter a unique code to instantly discover if they&apos;ve won.
            </p>
          </div>
          <Link
            href="/dashboard/promotions/create"
            className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 transition"
          >
            + Create Campaign
          </Link>
        </div>

        <PageHelp
          pageKey="promotions"
          title="Instant Win Campaigns"
          description="Create code-based campaigns where customers enter a unique code to instantly discover if they've won. Print codes on products or packaging — customers verify via WhatsApp."
        />

        <div className="mt-12 flex flex-col items-center justify-center text-center px-4">
          {/* Illustration */}
          <div className="relative mx-auto flex h-24 w-24 items-center justify-center rounded-full bg-brand-50 dark:bg-brand/10">
            {/* Outer ring */}
            <div className="absolute inset-0 rounded-full border-2 border-dashed border-brand/30" />
            <svg className="h-12 w-12 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
            </svg>
          </div>

          <h3 className="mt-5 text-lg font-semibold text-gray-900 dark:text-white">
            No campaigns yet
          </h3>
          <p className="mt-2 max-w-sm text-sm text-gray-500 dark:text-gray-400">
            Create your first instant win campaign. Print unique codes on your packaging — customers verify via WhatsApp to win prizes instantly.
          </p>

          <div className="mt-6 flex flex-col sm:flex-row gap-3">
            <Link
              href="/dashboard/promotions/create"
              className="inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 transition"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Create Campaign
            </Link>
          </div>

          {/* Feature hints */}
          <div className="mt-10 grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-xl w-full text-left">
            {[
              {
                icon: 'M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z',
                title: 'Unique codes',
                desc: 'Generate thousands of unique codes for products or packaging',
              },
              {
                icon: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
                title: 'WhatsApp verify',
                desc: 'Customers verify codes instantly via WhatsApp',
              },
              {
                icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
                title: 'Real-time stats',
                desc: 'Track verifications, winners, and redemption rates live',
              },
            ].map(f => (
              <div key={f.title} className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-50 dark:bg-brand/10 mb-3">
                  <svg className="h-4 w-4 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={f.icon} />
                  </svg>
                </div>
                <p className="text-sm font-semibold text-gray-900 dark:text-white">{f.title}</p>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── Main list view ──

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Instant Win Campaigns</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {campaigns.length} campaign{campaigns.length !== 1 ? 's' : ''}
          </p>
        </div>
        <Link
          href="/dashboard/promotions/create"
          className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 transition shrink-0"
        >
          + Create Campaign
        </Link>
      </div>

      <PageHelp
        pageKey="promotions"
        title="Instant Win Campaigns"
        description="Create code-based campaigns where customers enter a unique code to instantly discover if they've won. Print codes on products — customers verify via WhatsApp."
      />

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <p className="text-sm text-gray-500 dark:text-gray-400">Active Campaigns</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">{stats.active}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <p className="text-sm text-gray-500 dark:text-gray-400">Total Codes</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">{stats.totalCodes.toLocaleString()}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <p className="text-sm text-gray-500 dark:text-gray-400">Verifications</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">{stats.totalVerifications.toLocaleString()}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <p className="text-sm text-gray-500 dark:text-gray-400">Winners</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">{stats.totalWinners.toLocaleString()}</p>
        </div>
        <div className="col-span-2 lg:col-span-1 bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <p className="text-sm text-gray-500 dark:text-gray-400">Redemption Rate</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">{stats.redemptionRate}%</p>
        </div>
      </div>

      {/* Desktop table */}
      <div className="hidden md:block bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
              <tr>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">Name</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">Status</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">Dates</th>
                <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">Codes</th>
                <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">Participants</th>
                <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">Winners</th>
                <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">Redemption %</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-700">
              {campaigns.map(campaign => (
                <tr
                  key={campaign.id}
                  className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition"
                >
                  {/* Name */}
                  <td className="px-4 py-3">
                    <Link
                      href={`/dashboard/promotions/${campaign.id}`}
                      className="group"
                    >
                      <p className="font-medium text-gray-900 dark:text-white group-hover:text-brand transition truncate max-w-[180px]">
                        {campaign.name}
                      </p>
                      {campaign.keyword && (
                        <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                          Keyword: <span className="font-mono">{campaign.keyword}</span>
                        </p>
                      )}
                    </Link>
                  </td>

                  {/* Status */}
                  <td className="px-4 py-3">
                    <StatusBadge status={campaign.status} />
                  </td>

                  {/* Dates */}
                  <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {formatDateRange(campaign.start_at, campaign.end_at)}
                  </td>

                  {/* Codes */}
                  <td className="px-4 py-3 text-right text-gray-700 dark:text-gray-300 tabular-nums">
                    {campaign.total_codes > 0 ? campaign.total_codes.toLocaleString() : (
                      <span className="text-gray-400 dark:text-gray-600">—</span>
                    )}
                  </td>

                  {/* Participants */}
                  <td className="px-4 py-3 text-right text-gray-700 dark:text-gray-300 tabular-nums">
                    {campaign.unique_participants > 0 ? campaign.unique_participants.toLocaleString() : (
                      <span className="text-gray-400 dark:text-gray-600">—</span>
                    )}
                  </td>

                  {/* Winners */}
                  <td className="px-4 py-3 text-right tabular-nums">
                    {campaign.total_winners > 0 ? (
                      <span className="text-green-700 dark:text-green-400 font-medium">
                        {campaign.total_winners.toLocaleString()}
                      </span>
                    ) : (
                      <span className="text-gray-400 dark:text-gray-600">—</span>
                    )}
                  </td>

                  {/* Redemption % */}
                  <td className="px-4 py-3 text-right tabular-nums">
                    {campaign.total_codes > 0 ? (
                      <span className={`font-medium ${
                        campaign.redemption_rate >= 50
                          ? 'text-green-700 dark:text-green-400'
                          : campaign.redemption_rate >= 20
                          ? 'text-yellow-700 dark:text-yellow-400'
                          : 'text-gray-700 dark:text-gray-300'
                      }`}>
                        {campaign.redemption_rate}%
                      </span>
                    ) : (
                      <span className="text-gray-400 dark:text-gray-600">—</span>
                    )}
                  </td>

                  {/* Actions */}
                  <td className="px-4 py-3">
                    <Link
                      href={`/dashboard/promotions/${campaign.id}`}
                      className="inline-flex items-center gap-1 rounded-lg border border-gray-200 dark:border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-white transition"
                    >
                      View
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-3">
        {campaigns.map(campaign => (
          <Link
            key={campaign.id}
            href={`/dashboard/promotions/${campaign.id}`}
            className="block bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 hover:shadow-sm transition"
          >
            <div className="flex items-start justify-between mb-3 gap-3">
              <div className="min-w-0">
                <p className="font-semibold text-gray-900 dark:text-white truncate">{campaign.name}</p>
                {campaign.keyword && (
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                    Keyword: <span className="font-mono">{campaign.keyword}</span>
                  </p>
                )}
              </div>
              <StatusBadge status={campaign.status} />
            </div>

            {/* Date range */}
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              {formatDateRange(campaign.start_at, campaign.end_at)}
            </p>

            {/* Stats grid */}
            <div className="grid grid-cols-4 gap-2 border-t border-gray-50 dark:border-gray-700 pt-3">
              <div>
                <p className="text-xs text-gray-400 dark:text-gray-500">Codes</p>
                <p className="text-sm font-semibold text-gray-900 dark:text-white tabular-nums">
                  {campaign.total_codes > 0 ? campaign.total_codes.toLocaleString() : '—'}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-400 dark:text-gray-500">Verif.</p>
                <p className="text-sm font-semibold text-gray-900 dark:text-white tabular-nums">
                  {campaign.total_verifications > 0 ? campaign.total_verifications.toLocaleString() : '—'}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-400 dark:text-gray-500">Winners</p>
                <p className={`text-sm font-semibold tabular-nums ${campaign.total_winners > 0 ? 'text-green-700 dark:text-green-400' : 'text-gray-900 dark:text-white'}`}>
                  {campaign.total_winners > 0 ? campaign.total_winners.toLocaleString() : '—'}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-400 dark:text-gray-500">Rate</p>
                <p className={`text-sm font-semibold tabular-nums ${
                  campaign.total_codes > 0
                    ? campaign.redemption_rate >= 50
                      ? 'text-green-700 dark:text-green-400'
                      : campaign.redemption_rate >= 20
                      ? 'text-yellow-700 dark:text-yellow-400'
                      : 'text-gray-900 dark:text-white'
                    : 'text-gray-900 dark:text-white'
                }`}>
                  {campaign.total_codes > 0 ? `${campaign.redemption_rate}%` : '—'}
                </p>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
