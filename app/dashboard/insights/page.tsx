'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, type CountryCode, type SubscriptionTier } from '@/lib/constants';
import { useCategoryConfig } from '@/hooks/useCategoryConfig';
import { PageHelp } from '@/components/dashboard/PageHelp';

// ── Types ──

interface SnapshotData {
  busiestDay: { day: string; count: number } | null;
  topService: { name: string; percentage: number } | null;
  avgRating: number;
  repeatRate: number;
}

interface TrendsData {
  revenueWoW: number; // percentage change
  retentionRate: number;
  peakHours: { hour: number; count: number }[];
  recommendations: string[];
}

interface SegmentData {
  newCount: number;
  returningCount: number;
  atRiskCount: number;
  churnedCount: number;
  total: number;
}

interface IntelligenceData {
  revenueForecast: number;
  botCompletionRate: number;
  alerts: string[];
  segments: SegmentData;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function InsightsPage() {
  const business = useBusiness();
  const { labels } = useCategoryConfig(business.category);
  const country = (business.country_code || 'NG') as CountryCode;
  const tier = (business.subscription_tier || 'free') as SubscriptionTier;

  const [loading, setLoading] = useState(true);
  const [snapshot, setSnapshot] = useState<SnapshotData | null>(null);
  const [trends, setTrends] = useState<TrendsData | null>(null);
  const [intelligence, setIntelligence] = useState<IntelligenceData | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const supabase = createClient();
      const now = new Date();
      const d90 = new Date(now);
      d90.setDate(d90.getDate() - 90);
      const d90Str = d90.toISOString().split('T')[0];

      // Parallel data fetching
      const [bookingsRes, servicesRes, feedbackRes, profilesRes, botRes] = await Promise.all([
        supabase
          .from('bookings')
          .select('id, status, date, time, guest_phone, total_amount, service_id, created_at')
          .eq('business_id', business.id)
          .gte('date', d90Str)
          .order('date', { ascending: false }),
        supabase
          .from('services')
          .select('id, name')
          .eq('business_id', business.id),
        supabase
          .from('customer_feedback')
          .select('rating, created_at')
          .eq('business_id', business.id)
          .gte('created_at', d90.toISOString()),
        supabase
          .from('customer_profiles')
          .select('total_visits, total_spent, first_seen_at, last_seen_at, avg_rating')
          .eq('business_id', business.id),
        tier === 'business'
          ? supabase
              .from('bot_sessions')
              .select('id, current_step, is_active, created_at')
              .eq('business_id', business.id)
              .gte('created_at', d90.toISOString())
          : Promise.resolve({ data: [] as { id: string; current_step: string; is_active: boolean; created_at: string }[] }),
      ]);

      const bookings = bookingsRes.data || [];
      const services = servicesRes.data || [];
      const feedback = feedbackRes.data || [];
      const profiles = profilesRes.data || [];
      const botSessions = (botRes.data || []) as { id: string; current_step: string; is_active: boolean; created_at: string }[];
      const serviceMap = new Map(services.map((s: { id: string; name: string }) => [s.id, s.name]));

      // ── SNAPSHOT (Free) ──
      // Busiest Day
      const dayCount = new Map<number, number>();
      for (const b of bookings) {
        const d = new Date(b.date + 'T00:00');
        const wd = d.getDay();
        dayCount.set(wd, (dayCount.get(wd) || 0) + 1);
      }
      let busiestDay: SnapshotData['busiestDay'] = null;
      if (dayCount.size > 0) {
        const [maxDay, maxCount] = [...dayCount.entries()].reduce((a, b) => (b[1] > a[1] ? b : a));
        busiestDay = { day: WEEKDAYS[maxDay], count: maxCount };
      }

      // Top Service
      const svcCount = new Map<string, number>();
      for (const b of bookings) {
        const name = (b.service_id ? serviceMap.get(b.service_id) : null) || 'General';
        svcCount.set(name, (svcCount.get(name) || 0) + 1);
      }
      let topService: SnapshotData['topService'] = null;
      if (svcCount.size > 0) {
        const [topName, topCount] = [...svcCount.entries()].reduce((a, b) => (b[1] > a[1] ? b : a));
        topService = { name: topName, percentage: bookings.length > 0 ? Math.round((topCount / bookings.length) * 100) : 0 };
      }

      // Avg Rating
      const avgRating = feedback.length > 0
        ? Math.round((feedback.reduce((s, f) => s + (f.rating || 0), 0) / feedback.length) * 10) / 10
        : 0;

      // Repeat Rate
      const totalProfiles = profiles.length;
      const repeatProfiles = profiles.filter(p => (p.total_visits || 0) > 1).length;
      const repeatRate = totalProfiles > 0 ? Math.round((repeatProfiles / totalProfiles) * 100) : 0;

      setSnapshot({ busiestDay, topService, avgRating, repeatRate });

      // ── TRENDS (Growth) ──
      const now7 = new Date();
      now7.setDate(now7.getDate() - 7);
      const now14 = new Date();
      now14.setDate(now14.getDate() - 14);
      const now7Str = now7.toISOString().split('T')[0];
      const now14Str = now14.toISOString().split('T')[0];
      const todayStr = new Date().toISOString().split('T')[0];

      const thisWeek = bookings.filter(b => b.date >= now7Str && b.date <= todayStr);
      const lastWeek = bookings.filter(b => b.date >= now14Str && b.date < now7Str);
      const thisWeekRev = thisWeek.reduce((s, b) => s + (b.total_amount || 0), 0);
      const lastWeekRev = lastWeek.reduce((s, b) => s + (b.total_amount || 0), 0);
      const revenueWoW = lastWeekRev > 0 ? Math.round(((thisWeekRev - lastWeekRev) / lastWeekRev) * 100) : 0;

      // Retention: customers with last_seen_at within 30d
      const d30 = new Date();
      d30.setDate(d30.getDate() - 30);
      const d30Iso = d30.toISOString();
      const activeRecent = profiles.filter(p => p.last_seen_at && p.last_seen_at >= d30Iso).length;
      const retentionRate = totalProfiles > 0 ? Math.round((activeRecent / totalProfiles) * 100) : 0;

      // Peak Hours
      const hourMap = new Map<number, number>();
      for (const b of bookings) {
        if (b.time) {
          const hour = parseInt(b.time.split(':')[0], 10);
          hourMap.set(hour, (hourMap.get(hour) || 0) + 1);
        }
      }
      const peakHours = [...hourMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([hour, count]) => ({ hour, count }));

      // Recommendations
      const recommendations: string[] = [];
      if (topService) {
        const topRev = bookings
          .filter(b => (b.service_id ? serviceMap.get(b.service_id) : 'General') === topService.name)
          .reduce((s, b) => s + (b.total_amount || 0), 0);
        const totalRev = bookings.reduce((s, b) => s + (b.total_amount || 0), 0);
        const topRevPct = totalRev > 0 ? Math.round((topRev / totalRev) * 100) : 0;
        recommendations.push(
          `Your top ${labels.serviceName?.toLowerCase() || 'service'} "${topService.name}" generates ${topRevPct}% of revenue — consider promoting it.`,
        );
      }
      if (peakHours.length >= 2) {
        const peakStr = peakHours
          .slice(0, 2)
          .map(h => `${h.hour % 12 || 12}${h.hour >= 12 ? 'PM' : 'AM'}`)
          .join(' & ');
        recommendations.push(`Peak hours are ${peakStr} — schedule your best staff then.`);
      }
      const nonRepeatPct = totalProfiles > 0 ? 100 - repeatRate : 0;
      if (nonRepeatPct > 50) {
        recommendations.push(
          `${nonRepeatPct}% of customers don't return — consider enabling a loyalty program.`,
        );
      }

      setTrends({ revenueWoW, retentionRate, peakHours, recommendations });

      // ── INTELLIGENCE (Business) ──
      const d60 = new Date();
      d60.setDate(d60.getDate() - 60);
      const d60Iso = d60.toISOString();
      const d30Iso2 = d30.toISOString();

      const newCust = profiles.filter(p => p.first_seen_at && p.first_seen_at >= d30Iso2).length;
      const returningCust = profiles.filter(p => (p.total_visits || 0) >= 2 && p.last_seen_at && p.last_seen_at >= d30Iso2).length;
      const atRiskCust = profiles.filter(p => p.last_seen_at && p.last_seen_at >= d60Iso && p.last_seen_at < d30Iso2).length;
      const churnedCust = profiles.filter(p => !p.last_seen_at || p.last_seen_at < d60Iso).length;

      // Monthly Run Rate — based on last 30 days of revenue
      const last30 = bookings.filter(b => b.date >= new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]);
      const last30Rev = last30.reduce((s, b) => s + (b.total_amount || 0), 0);
      const daysElapsedThisMonth = new Date().getDate();
      const dailyAvg = last30Rev / 30;
      const daysRemaining = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate() - daysElapsedThisMonth;
      const earnedThisMonth = bookings
        .filter(b => b.date >= new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0])
        .reduce((s, b) => s + (b.total_amount || 0), 0);
      const revenueForecast = Math.round(earnedThisMonth + dailyAvg * daysRemaining);

      // Bot Flow Completion
      const totalBot = botSessions.length;
      const completedBot = botSessions.filter(s => !s.is_active && s.current_step === 'completed').length;
      const botCompletionRate = totalBot > 0 ? Math.round((completedBot / totalBot) * 100) : 0;

      // Alerts
      const alerts: string[] = [];
      const dormant = profiles.filter(p => p.last_seen_at && p.last_seen_at < d30Iso2 && p.last_seen_at >= d60Iso).length;
      if (dormant > 0) {
        alerts.push(`${dormant} customer${dormant !== 1 ? 's' : ''} haven't visited in 30+ days.`);
      }
      // Cancellation rate trend
      const thisMonthBookings = bookings.filter(b => b.date >= new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]);
      const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
      const lastMonthBookings = bookings.filter(b => b.date >= lastMonthStart.toISOString().split('T')[0] && b.date <= lastMonthEnd.toISOString().split('T')[0]);
      const thisCancelRate = thisMonthBookings.length > 0
        ? (thisMonthBookings.filter(b => b.status === 'cancelled').length / thisMonthBookings.length) * 100
        : 0;
      const lastCancelRate = lastMonthBookings.length > 0
        ? (lastMonthBookings.filter(b => b.status === 'cancelled').length / lastMonthBookings.length) * 100
        : 0;
      if (thisCancelRate - lastCancelRate > 10) {
        alerts.push(`Cancellation rate up ${Math.round(thisCancelRate - lastCancelRate)}% compared to last month.`);
      }

      setIntelligence({
        revenueForecast,
        botCompletionRate,
        alerts,
        segments: {
          newCount: newCust,
          returningCount: returningCust,
          atRiskCount: atRiskCust,
          churnedCount: churnedCust,
          total: totalProfiles,
        },
      });

      setLoading(false);
    }
    load();
  }, [business.id, business.subscription_tier, business.country_code, business.category, labels.serviceName, tier]);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  const isGrowthOrAbove = tier === 'growth' || tier === 'business';
  const isBusiness = tier === 'business';

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Intelligence Hub</h1>
        <p className="mt-1 text-sm text-gray-500">AI-powered insights for {business.name}</p>
        <PageHelp
          pageKey="insights"
          title="Intelligence Hub"
          description="Smart business insights — customer retention, revenue forecasts, peak hours, and actionable recommendations powered by AI."
        />
      </div>

      {/* ── FREE: Snapshot ── */}
      <div className="mt-6">
        <h2 className="text-lg font-semibold text-gray-900">Snapshot</h2>
        <p className="text-sm text-gray-500">Key metrics at a glance</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Busiest Day"
            value={snapshot?.busiestDay ? snapshot.busiestDay.day : '—'}
            sub={snapshot?.busiestDay ? `${snapshot.busiestDay.count} ${labels.entityNamePlural}` : 'No data yet'}
          />
          <StatCard
            label={`Top ${labels.serviceName || 'Service'}`}
            value={snapshot?.topService?.name || '—'}
            sub={snapshot?.topService ? `${snapshot.topService.percentage}% of total` : 'No data yet'}
          />
          <StatCard
            label="Avg Rating"
            value={snapshot?.avgRating ? `${snapshot.avgRating} / 5` : '—'}
            sub={snapshot?.avgRating ? renderStars(snapshot.avgRating) : 'No reviews yet'}
          />
          <StatCard
            label="Repeat Rate"
            value={snapshot ? `${snapshot.repeatRate}%` : '—'}
            sub="Customers with 2+ visits"
          />
        </div>
      </div>

      {/* ── GROWTH: Trends & Recommendations ── */}
      <div className="mt-10">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-gray-900">Trends & Recommendations</h2>
          {!isGrowthOrAbove && <TierBadge tier="growth" />}
        </div>
        <TierLock locked={!isGrowthOrAbove} requiredTier="Growth">
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard
              label="Revenue WoW"
              value={trends ? `${trends.revenueWoW >= 0 ? '+' : ''}${trends.revenueWoW}%` : '—'}
              sub={trends?.revenueWoW !== undefined
                ? (trends.revenueWoW >= 0 ? 'Up from last week' : 'Down from last week')
                : undefined}
              accent={trends ? (trends.revenueWoW >= 0 ? 'green' : 'red') : undefined}
            />
            <StatCard
              label="Retention Rate"
              value={trends ? `${trends.retentionRate}%` : '—'}
              sub="Active in last 30 days"
            />
            <StatCard
              label="Peak Hours"
              value={trends?.peakHours.length
                ? trends.peakHours.map(h => `${h.hour % 12 || 12}${h.hour >= 12 ? 'PM' : 'AM'}`).join(', ')
                : '—'}
              sub={trends?.peakHours.length
                ? `Top ${trends.peakHours.length} busiest hours`
                : 'No time data'}
            />
          </div>

          {/* Recommendation Cards */}
          {trends && trends.recommendations.length > 0 && (
            <div className="mt-6 space-y-3">
              <h3 className="text-sm font-semibold text-gray-700">Recommendations</h3>
              {trends.recommendations.map((rec, i) => (
                <div key={i} className="flex items-start gap-3 rounded-xl border border-amber-100 bg-amber-50 p-4">
                  <svg aria-hidden="true" className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                  </svg>
                  <p className="text-sm text-amber-900">{rec}</p>
                </div>
              ))}
            </div>
          )}
        </TierLock>
      </div>

      {/* ── BUSINESS: Full Intelligence ── */}
      <div className="mt-10">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-gray-900">Full Intelligence</h2>
          {!isBusiness && <TierBadge tier="business" />}
        </div>
        <TierLock locked={!isBusiness} requiredTier="Business">
          {/* Customer Segments */}
          <div className="mt-4 rounded-xl border border-gray-100 bg-white p-6">
            <h3 className="text-sm font-semibold text-gray-900">Customer Segments</h3>
            {intelligence && intelligence.segments.total > 0 ? (
              <div className="mt-4">
                <div className="flex h-4 w-full overflow-hidden rounded-full bg-gray-100">
                  <SegmentBar
                    pct={intelligence.segments.total > 0 ? (intelligence.segments.newCount / intelligence.segments.total) * 100 : 0}
                    color="bg-blue-500"
                  />
                  <SegmentBar
                    pct={intelligence.segments.total > 0 ? (intelligence.segments.returningCount / intelligence.segments.total) * 100 : 0}
                    color="bg-green-500"
                  />
                  <SegmentBar
                    pct={intelligence.segments.total > 0 ? (intelligence.segments.atRiskCount / intelligence.segments.total) * 100 : 0}
                    color="bg-yellow-500"
                  />
                  <SegmentBar
                    pct={intelligence.segments.total > 0 ? (intelligence.segments.churnedCount / intelligence.segments.total) * 100 : 0}
                    color="bg-red-400"
                  />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <SegmentLabel label="New" count={intelligence.segments.newCount} color="bg-blue-500" />
                  <SegmentLabel label="Returning" count={intelligence.segments.returningCount} color="bg-green-500" />
                  <SegmentLabel label="At Risk" count={intelligence.segments.atRiskCount} color="bg-yellow-500" />
                  <SegmentLabel label="Churned" count={intelligence.segments.churnedCount} color="bg-red-400" />
                </div>
              </div>
            ) : (
              <p className="mt-3 text-sm text-gray-400">No customer data yet.</p>
            )}
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard
              label="Revenue Forecast"
              value={intelligence ? formatCurrency(intelligence.revenueForecast, country) : '—'}
              sub="Projected for this month"
            />
            <StatCard
              label="Bot Completion"
              value={intelligence ? `${intelligence.botCompletionRate}%` : '—'}
              sub="Sessions completed successfully"
            />
            <StatCard
              label="Total Customers"
              value={intelligence ? intelligence.segments.total : '—'}
              sub="All-time tracked"
            />
          </div>

          {/* Alert Cards */}
          {intelligence && intelligence.alerts.length > 0 && (
            <div className="mt-6 space-y-3">
              <h3 className="text-sm font-semibold text-gray-700">Alerts</h3>
              {intelligence.alerts.map((alert, i) => (
                <div key={i} className="flex items-start gap-3 rounded-xl border border-red-100 bg-red-50 p-4">
                  <svg aria-hidden="true" className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <p className="text-sm text-red-900">{alert}</p>
                </div>
              ))}
            </div>
          )}
        </TierLock>
      </div>
    </div>
  );
}

// ── Subcomponents ──

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: number | string;
  sub?: string;
  accent?: 'green' | 'red';
}) {
  const accentClass = accent === 'green' ? 'text-green-600' : accent === 'red' ? 'text-red-600' : 'text-gray-900';
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-5">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className={`mt-2 text-2xl font-bold ${accentClass}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-gray-400">{sub}</p>}
    </div>
  );
}

function renderStars(rating: number): string {
  const full = Math.floor(rating);
  const half = rating - full >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return '\u2605'.repeat(full) + (half ? '\u00BD' : '') + '\u2606'.repeat(empty);
}

function TierBadge({ tier }: { tier: 'growth' | 'business' }) {
  const label = tier === 'growth' ? 'Pro' : 'Premium';
  const color = tier === 'growth' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700';
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>{label}</span>;
}

function TierLock({
  locked,
  requiredTier,
  children,
}: {
  locked: boolean;
  requiredTier: string;
  children: ReactNode;
}) {
  if (!locked) return <>{children}</>;
  return (
    <div className="relative mt-4">
      <div className="pointer-events-none select-none blur-sm">{children}</div>
      <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-white/60 backdrop-blur-[2px]">
        <div className="text-center">
          <svg aria-hidden="true" className="mx-auto h-8 w-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
          </svg>
          <p className="mt-2 text-sm font-semibold text-gray-700">Upgrade to {requiredTier}</p>
          <p className="mt-1 text-xs text-gray-500">Unlock this section with a plan upgrade</p>
          <a
            href="/dashboard/settings"
            className="mt-3 inline-block rounded-lg bg-brand px-4 py-2 text-xs font-medium text-white transition hover:bg-brand-600"
          >
            View Plans
          </a>
        </div>
      </div>
    </div>
  );
}

function SegmentBar({ pct, color }: { pct: number; color: string }) {
  if (pct <= 0) return null;
  return <div className={`${color} transition-all`} style={{ width: `${pct}%` }} />;
}

function SegmentLabel({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className={`h-3 w-3 rounded-full ${color}`} />
      <div>
        <p className="text-xs font-medium text-gray-700">{label}</p>
        <p className="text-sm font-bold text-gray-900">{count}</p>
      </div>
    </div>
  );
}
