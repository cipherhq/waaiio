'use client';

import { useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, type CountryCode, getLocale } from '@/lib/constants';
import { useCategoryConfig } from '@/hooks/useCategoryConfig';
import { CsvExportButton } from '@/components/dashboard/CsvExportButton';
import { PageHelp } from '@/components/dashboard/PageHelp';

interface DailyCount {
  date: string;
  count: number;
  revenue: number;
}

interface HourlyCount {
  hour: number;
  count: number;
}

interface ServiceStat {
  name: string;
  count: number;
  revenue: number;
}

interface TopCustomer {
  name: string | null;
  phone: string | null;
  total_spent: number;
  total_visits: number;
  last_seen_at: string | null;
}

type TimeRange = '7d' | '30d' | '90d';

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export default function AnalyticsPage() {
  const business = useBusiness();
  const { labels } = useCategoryConfig(business.category);
  const country = (business.country_code || 'NG') as CountryCode;

  const [timeRange, setTimeRange] = useState<TimeRange>('30d');
  const [customDateFrom, setCustomDateFrom] = useState('');
  const [customDateTo, setCustomDateTo] = useState('');
  const [totalBookings, setTotalBookings] = useState(0);
  const [completedBookings, setCompletedBookings] = useState(0);
  const [cancelledBookings, setCancelledBookings] = useState(0);
  const [noShows, setNoShows] = useState(0);
  const [totalRevenue, setTotalRevenue] = useState(0);
  const [uniqueGuests, setUniqueGuests] = useState(0);
  const [newGuests, setNewGuests] = useState(0);
  const [repeatGuests, setRepeatGuests] = useState(0);
  const [dailyCounts, setDailyCounts] = useState<DailyCount[]>([]);
  const [hourlyCounts, setHourlyCounts] = useState<HourlyCount[]>([]);
  const [topServices, setTopServices] = useState<ServiceStat[]>([]);
  const [topCustomers, setTopCustomers] = useState<TopCustomer[]>([]);
  const [botSessions, setBotSessions] = useState(0);
  const [botCompletedSessions, setBotCompletedSessions] = useState(0);
  const [botEscalated, setBotEscalated] = useState(0);
  const [paymentSuccess, setPaymentSuccess] = useState(0);
  const [paymentFailed, setPaymentFailed] = useState(0);
  const [whatsappBookings, setWhatsappBookings] = useState(0);
  const [webBookings, setWebBookings] = useState(0);
  const [apiBookings, setApiBookings] = useState(0);
  const [inboundMessages, setInboundMessages] = useState(0);
  const [outboundMessages, setOutboundMessages] = useState(0);
  const [totalConversations, setTotalConversations] = useState(0);
  const [botTotalSessions, setBotTotalSessions] = useState(0);
  const [botCompleted, setBotCompleted] = useState(0);
  const [botAbandoned, setBotAbandoned] = useState(0);
  const [botActive, setBotActive] = useState(0);
  const [botCompletionRate, setBotCompletionRate] = useState(0);
  const [topIntents, setTopIntents] = useState<{ intent: string; count: number }[]>([]);
  const [avgConfidence, setAvgConfidence] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(false);
      const supabase = createClient();

      try {
      const days = timeRange === '7d' ? 7 : timeRange === '30d' ? 30 : 90;
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      const startStr = customDateFrom || startDate.toISOString().split('T')[0];
      const endStr = customDateTo || new Date().toISOString().split('T')[0];

      if (customDateFrom && customDateTo && customDateFrom > customDateTo) {
        setLoading(false);
        return;
      }

      let bookingsQuery = supabase
        .from('bookings')
        .select('id, status, date, time, guest_phone, total_amount, deposit_amount, service_id, channel')
        .eq('business_id', business.id)
        .gte('date', startStr);
      if (endStr) bookingsQuery = bookingsQuery.lte('date', endStr);
      bookingsQuery = bookingsQuery.order('date', { ascending: false });

      // Get current month key for conversation_usage
      const now = new Date();
      const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

      const [bookingsRes, servicesRes, botSessionsRes, paymentsRes, convUsageRes, intentsRes, customersRes] = await Promise.all([
        bookingsQuery,
        supabase
          .from('services')
          .select('id, name')
          .eq('business_id', business.id),
        supabase
          .from('bot_sessions')
          .select('id, is_active, current_step, session_data')
          .eq('business_id', business.id)
          .gte('created_at', startStr + 'T00:00:00'),
        supabase
          .from('payments')
          .select('id, status')
          .eq('business_id', business.id)
          .gte('created_at', startStr + 'T00:00:00'),
        supabase
          .from('conversation_usage')
          .select('inbound_count, outbound_count, conversation_count')
          .eq('business_id', business.id)
          .eq('month_key', monthKey)
          .maybeSingle(),
        supabase
          .from('llm_classifications')
          .select('detected_intent, confidence')
          .eq('business_id', business.id)
          .gte('created_at', startStr + 'T00:00:00'),
        supabase
          .from('customer_profiles')
          .select('name, phone, total_spent, total_visits, last_seen_at')
          .eq('business_id', business.id)
          .order('total_spent', { ascending: false })
          .limit(10),
      ]);
      const bookings = bookingsRes.data;
      const serviceMap = new Map((servicesRes.data || []).map((s: { id: string; name: string }) => [s.id, s.name]));

      const all = bookings || [];
      setTotalBookings(all.length);
      setCompletedBookings(all.filter((b) => b.status === 'completed').length);
      setCancelledBookings(all.filter((b) => b.status === 'cancelled').length);
      setNoShows(all.filter((b) => b.status === 'no_show').length);
      setTotalRevenue(all.reduce((sum, b) => sum + (b.total_amount || b.deposit_amount || 0), 0));

      // Channel breakdown
      setWhatsappBookings(all.filter((b) => b.channel === 'whatsapp').length);
      setWebBookings(all.filter((b) => b.channel === 'web').length);
      setApiBookings(all.filter((b) => b.channel === 'api').length);

      // Guest analysis
      const phoneMap = new Map<string, number>();
      for (const b of all) {
        if (b.guest_phone) {
          phoneMap.set(b.guest_phone, (phoneMap.get(b.guest_phone) || 0) + 1);
        }
      }
      setUniqueGuests(phoneMap.size);
      const repeats = Array.from(phoneMap.values()).filter((c) => c > 1).length;
      setRepeatGuests(repeats);
      setNewGuests(phoneMap.size - repeats);

      // Daily counts
      const dayMap = new Map<string, { count: number; revenue: number }>();
      for (const b of all) {
        const existing = dayMap.get(b.date) || { count: 0, revenue: 0 };
        existing.count++;
        existing.revenue += b.total_amount || b.deposit_amount || 0;
        dayMap.set(b.date, existing);
      }
      const daily: DailyCount[] = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const ds = d.toISOString().split('T')[0];
        const entry = dayMap.get(ds) || { count: 0, revenue: 0 };
        daily.push({ date: ds, ...entry });
      }
      setDailyCounts(daily);

      // Hourly distribution
      const hourMap = new Map<number, number>();
      for (const b of all) {
        if (b.time) {
          const hour = parseInt(b.time.split(':')[0], 10);
          hourMap.set(hour, (hourMap.get(hour) || 0) + 1);
        }
      }
      const hourly: HourlyCount[] = [];
      for (let h = 6; h <= 23; h++) {
        hourly.push({ hour: h, count: hourMap.get(h) || 0 });
      }
      setHourlyCounts(hourly);

      // Top services
      const svcStatsMap = new Map<string, { count: number; revenue: number }>();
      for (const b of all) {
        const name = (b.service_id ? serviceMap.get(b.service_id) : null) || 'General';
        const existing = svcStatsMap.get(name) || { count: 0, revenue: 0 };
        existing.count++;
        existing.revenue += b.total_amount || b.deposit_amount || 0;
        svcStatsMap.set(name, existing);
      }
      const services = Array.from(svcStatsMap.entries())
        .map(([name, stats]) => ({ name, ...stats }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
      setTopServices(services);

      // Top customers
      setTopCustomers((customersRes.data as TopCustomer[] | null) || []);

      // Bot session stats
      const allSessions = botSessionsRes.data || [];
      setBotSessions(allSessions.length);
      const completedSessions = allSessions.filter(s => !s.is_active);
      setBotCompletedSessions(completedSessions.length);
      const escalatedSessions = allSessions.filter(s => {
        const data = s.session_data as Record<string, unknown> | null;
        return data?.escalated_to_human === true;
      });
      setBotEscalated(escalatedSessions.length);

      // Bot Performance (detailed)
      const convData = convUsageRes.data;
      setInboundMessages(convData?.inbound_count || 0);
      setOutboundMessages(convData?.outbound_count || 0);
      setTotalConversations(convData?.conversation_count || 0);

      setBotTotalSessions(allSessions.length);
      const completed = allSessions.filter(s => !s.is_active && s.current_step === 'complete');
      const abandoned = allSessions.filter(s => !s.is_active && s.current_step !== 'complete');
      const active = allSessions.filter(s => s.is_active);
      setBotCompleted(completed.length);
      setBotAbandoned(abandoned.length);
      setBotActive(active.length);
      setBotCompletionRate(allSessions.length > 0 ? Math.round((completed.length / allSessions.length) * 100) : 0);

      // Intent distribution
      const intentMap = new Map<string, number>();
      let totalConf = 0;
      let confCount = 0;
      for (const cls of (intentsRes.data || []) as { detected_intent: string | null; confidence: number }[]) {
        if (cls.detected_intent) {
          intentMap.set(cls.detected_intent, (intentMap.get(cls.detected_intent) || 0) + 1);
        }
        if (cls.confidence > 0) {
          totalConf += cls.confidence;
          confCount++;
        }
      }
      const sortedIntents = Array.from(intentMap.entries())
        .map(([intent, count]) => ({ intent, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
      setTopIntents(sortedIntents);
      setAvgConfidence(confCount > 0 ? Math.round((totalConf / confCount) * 100) : 0);

      // Payment stats
      const allPayments = paymentsRes.data || [];
      setPaymentSuccess(allPayments.filter(p => p.status === 'success').length);
      setPaymentFailed(allPayments.filter(p => p.status === 'failed').length);

      setLoading(false);
      } catch (err) {
        console.error('[ANALYTICS] Failed to load analytics:', err);
        setError(true);
        setLoading(false);
      }
    }
    load();
  }, [business.id, timeRange, customDateFrom, customDateTo, retryCount]);

  if (error) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4">
        <p className="text-sm text-red-600 dark:text-red-400">Failed to load analytics data.</p>
        <button
          onClick={() => setRetryCount(c => c + 1)}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
        >
          Retry
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  const completionRate = totalBookings > 0 ? Math.round((completedBookings / totalBookings) * 100) : 0;
  const noShowRate = totalBookings > 0 ? Math.round((noShows / totalBookings) * 100) : 0;
  const cancellationRate = totalBookings > 0 ? Math.round((cancelledBookings / totalBookings) * 100) : 0;
  const maxDaily = Math.max(...dailyCounts.map((d) => d.count), 1);
  const maxDailyRevenue = Math.max(...dailyCounts.map((d) => d.revenue), 1);
  const maxHourly = Math.max(...hourlyCounts.map((h) => h.count), 1);
  const avgSpend = uniqueGuests > 0 ? Math.round(totalRevenue / uniqueGuests) : 0;

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Analytics</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Performance overview for {business.name}</p>
          <PageHelp
            pageKey="analytics"
            title="Business Analytics"
            description="See how your business is performing — daily bookings, revenue trends, top services, peak hours, and customer insights. Filter by time range for deeper analysis."
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 rounded-lg bg-gray-100 dark:bg-gray-800 p-1">
            {(['7d', '30d', '90d'] as TimeRange[]).map((range) => (
              <button
                key={range}
                onClick={() => { setTimeRange(range); setCustomDateFrom(''); setCustomDateTo(''); }}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  timeRange === range && !customDateFrom
                    ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100'
                    : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                }`}
              >
                {range === '7d' ? '7 days' : range === '30d' ? '30 days' : '90 days'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input type="date" value={customDateFrom} onChange={(e) => setCustomDateFrom(e.target.value)} className="rounded-lg border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 px-3 py-1.5 text-sm outline-none focus:border-brand" />
            <span className="text-xs text-gray-400 dark:text-gray-500">to</span>
            <input type="date" value={customDateTo} onChange={(e) => setCustomDateTo(e.target.value)} className="rounded-lg border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 px-3 py-1.5 text-sm outline-none focus:border-brand" />
          </div>
          {customDateFrom && customDateTo && customDateFrom > customDateTo && (
            <p className="text-xs font-medium text-red-500">End date must be after start date</p>
          )}
          <CsvExportButton
            data={dailyCounts.map(d => ({
              Date: d.date,
              Bookings: d.count,
              Revenue: d.revenue,
            }))}
            filename={`analytics-${new Date().toISOString().slice(0, 10)}`}
          />
        </div>
      </div>

      {/* Stats Grid */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label={`Total ${labels.entityNamePlural}`} value={totalBookings} />
        <StatCard label="Revenue" value={formatCurrency(totalRevenue, country)} />
        <StatCard label="Completion Rate" value={`${completionRate}%`} sub={`${completedBookings} completed`} />
        <StatCard label={`Unique ${labels.personLabelPlural}`} value={uniqueGuests} sub={`${newGuests} new, ${repeatGuests} returning`} />
        <StatCard label="Avg. Spend" value={formatCurrency(avgSpend, country)} sub={`per ${labels.personLabel.toLowerCase()}`} />
      </div>

      {/* Status Breakdown */}
      <div className={`mt-6 grid gap-4 ${labels.hiddenStatuses.includes('no_show') ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`}>
        <MiniStat label="Completed" value={completedBookings} rate={completionRate} color="bg-green-500" />
        <MiniStat label="Cancelled" value={cancelledBookings} rate={cancellationRate} color="bg-yellow-500" />
        {!labels.hiddenStatuses.includes('no_show') && (
          <MiniStat label="No Shows" value={noShows} rate={noShowRate} color="bg-red-500" />
        )}
      </div>

      {/* Booking Channels */}
      {totalBookings > 0 && (
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-green-50 dark:bg-green-900/30">
                <svg aria-hidden="true" className="h-4 w-4 text-green-600 dark:text-green-400" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                </svg>
              </div>
              <div className="flex-1">
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">WhatsApp {labels.entityNamePlural}</p>
                <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">{whatsappBookings}</p>
                <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">
                  {totalBookings > 0 ? Math.round((whatsappBookings / totalBookings) * 100) : 0}% of total
                </p>
              </div>
            </div>
            {totalBookings > 0 && (
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
                <div className="h-2 rounded-full bg-green-500" style={{ width: `${(whatsappBookings / totalBookings) * 100}%` }} />
              </div>
            )}
          </div>
          <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50 dark:bg-blue-900/30">
                <svg aria-hidden="true" className="h-4 w-4 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                </svg>
              </div>
              <div className="flex-1">
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Web {labels.entityNamePlural}</p>
                <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">{webBookings}</p>
                <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">
                  {totalBookings > 0 ? Math.round((webBookings / totalBookings) * 100) : 0}% of total
                </p>
              </div>
            </div>
            {totalBookings > 0 && (
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
                <div className="h-2 rounded-full bg-blue-500" style={{ width: `${(webBookings / totalBookings) * 100}%` }} />
              </div>
            )}
          </div>
          <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-purple-50 dark:bg-purple-900/30">
                <svg aria-hidden="true" className="h-4 w-4 text-purple-600 dark:text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
                </svg>
              </div>
              <div className="flex-1">
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">API {labels.entityNamePlural}</p>
                <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">{apiBookings}</p>
                <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">
                  {totalBookings > 0 ? Math.round((apiBookings / totalBookings) * 100) : 0}% of total
                </p>
              </div>
            </div>
            {totalBookings > 0 && (
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
                <div className="h-2 rounded-full bg-purple-500" style={{ width: `${(apiBookings / totalBookings) * 100}%` }} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Charts Row */}
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        {/* Daily Volume Chart */}
        <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{labels.entityNamePlural} Over Time</h2>
          <div className="mt-4 flex items-end gap-[2px]" style={{ height: 160 }}>
            {dailyCounts.map((d) => (
              <div key={d.date} className="group relative flex-1">
                <div
                  className="w-full rounded-t bg-brand transition hover:bg-brand-400"
                  style={{ height: `${Math.max((d.count / maxDaily) * 140, 2)}px` }}
                />
                <div className="pointer-events-none absolute -top-8 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded bg-gray-800 dark:bg-gray-600 px-2 py-1 text-xs text-white opacity-0 group-hover:opacity-100">
                  {d.count} &middot; {formatCurrency(d.revenue, country)}
                  <br />
                  {new Date(d.date + 'T00:00').toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), { day: 'numeric', month: 'short' })}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between text-xs text-gray-400 dark:text-gray-500">
            <span>{timeRange === '7d' ? '7 days ago' : timeRange === '30d' ? '30 days ago' : '90 days ago'}</span>
            <span>Today</span>
          </div>
        </div>

        {/* Revenue Over Time Chart */}
        <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Revenue Over Time</h2>
          <div className="mt-4 flex items-end gap-[2px]" style={{ height: 160 }}>
            {dailyCounts.map((d) => (
              <div key={d.date} className="group relative flex-1">
                <div
                  className="w-full rounded-t bg-green-500 transition hover:bg-green-400"
                  style={{ height: `${Math.max((d.revenue / maxDailyRevenue) * 140, 2)}px` }}
                />
                <div className="pointer-events-none absolute -top-8 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded bg-gray-800 dark:bg-gray-600 px-2 py-1 text-xs text-white opacity-0 group-hover:opacity-100">
                  {formatCurrency(d.revenue, country)}
                  <br />
                  {new Date(d.date + 'T00:00').toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), { day: 'numeric', month: 'short' })}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between text-xs text-gray-400 dark:text-gray-500">
            <span>{timeRange === '7d' ? '7 days ago' : timeRange === '30d' ? '30 days ago' : '90 days ago'}</span>
            <span>Today</span>
          </div>
        </div>
      </div>

      {/* Peak Hours Chart */}
      <div className="mt-6 rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Peak Hours</h2>
        <div className="mt-4 flex items-end gap-1" style={{ height: 160 }}>
          {hourlyCounts.map((h) => (
            <div key={h.hour} className="group relative flex-1">
              <div
                className="w-full rounded-t bg-accent transition hover:bg-accent/80"
                style={{ height: `${Math.max((h.count / maxHourly) * 140, 2)}px` }}
              />
              <div className="pointer-events-none absolute -top-8 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded bg-gray-800 dark:bg-gray-600 px-2 py-1 text-xs text-white opacity-0 group-hover:opacity-100">
                {h.count} at {h.hour}:00
              </div>
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between text-xs text-gray-400 dark:text-gray-500">
          <span>6 AM</span>
          <span>12 PM</span>
          <span>6 PM</span>
          <span>11 PM</span>
        </div>
      </div>

      {/* Top Services */}
      {topServices.length > 0 && (
        <div className="mt-8 rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Top {labels.serviceNamePlural}</h2>
          <div className="mt-4 space-y-3">
            {topServices.map((s, i) => {
              const pct = totalBookings > 0 ? Math.round((s.count / totalBookings) * 100) : 0;
              return (
                <div key={s.name} className="flex items-center gap-4">
                  <span className="w-6 text-center text-xs font-bold text-gray-400 dark:text-gray-500">{i + 1}</span>
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{s.name}</span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">{s.count} ({pct}%)</span>
                    </div>
                    <div className="mt-1 h-2 w-full rounded-full bg-gray-100 dark:bg-gray-700">
                      <div className="h-2 rounded-full bg-brand" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                  <span className="w-24 text-right text-xs font-medium text-gray-600 dark:text-gray-300">
                    {formatCurrency(s.revenue, country)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Top Customers */}
      <div className="mt-8 rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Top {labels.personLabelPlural}</h2>
        {topCustomers.length === 0 ? (
          <p className="mt-4 text-center text-sm text-gray-500 dark:text-gray-400 py-6">No customer data yet</p>
        ) : (
          <div className="mt-4 space-y-3">
            {topCustomers.map((c, i) => (
              <div key={i} className="flex flex-wrap items-center gap-4">
                <span className="w-6 text-center text-xs font-bold text-gray-400 dark:text-gray-500">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{c.name || c.phone || 'Unknown'}</p>
                  <p className="text-xs text-gray-400 dark:text-gray-500">
                    {c.total_visits} visit{c.total_visits === 1 ? '' : 's'}
                    {c.last_seen_at && (
                      <> &middot; Last seen {new Date(c.last_seen_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</>
                    )}
                  </p>
                </div>
                <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {formatCurrency(c.total_spent, country)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bot & Payment Performance */}
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        {/* Bot Performance */}
        {botSessions > 0 && (
          <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Bot Performance</h2>
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{botSessions}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">Total Sessions</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-green-600 dark:text-green-400">
                  {botSessions > 0 ? Math.round(((botCompletedSessions - botEscalated) / botSessions) * 100) : 0}%
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">Self-Resolved</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{botEscalated}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">Escalated to Human</p>
              </div>
            </div>
            <div className="mt-4 h-3 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
              {botSessions > 0 && (
                <>
                  <div
                    className="float-left h-3 bg-green-500"
                    style={{ width: `${((botCompletedSessions - botEscalated) / botSessions) * 100}%` }}
                  />
                  <div
                    className="float-left h-3 bg-amber-400"
                    style={{ width: `${(botEscalated / botSessions) * 100}%` }}
                  />
                </>
              )}
            </div>
            <div className="mt-2 flex gap-4 text-[10px] text-gray-400 dark:text-gray-500">
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-green-500" /> Self-resolved</span>
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-amber-400" /> Escalated</span>
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-gray-200 dark:bg-gray-600" /> Active</span>
            </div>
          </div>
        )}

        {/* Payment Success Rate */}
        {(paymentSuccess + paymentFailed) > 0 && (
          <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Payment Success Rate</h2>
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{paymentSuccess + paymentFailed}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">Total Payments</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-green-600 dark:text-green-400">
                  {Math.round((paymentSuccess / (paymentSuccess + paymentFailed)) * 100)}%
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">Success Rate</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-red-600 dark:text-red-400">{paymentFailed}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">Failed</p>
              </div>
            </div>
            <div className="mt-4 h-3 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
              <div
                className="h-3 rounded-full bg-green-500"
                style={{ width: `${(paymentSuccess / (paymentSuccess + paymentFailed)) * 100}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Bot Performance (Detailed) */}
      {(inboundMessages > 0 || botTotalSessions > 0) && (
        <>
          <h2 className="mt-10 text-lg font-bold text-gray-900 dark:text-gray-100">Bot Performance</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Messaging activity and session outcomes this month</p>

          {/* Stat cards row */}
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Inbound Messages" value={inboundMessages} sub="This month" />
            <StatCard label="Outbound Messages" value={outboundMessages} sub="This month" />
            <StatCard label="Bot Sessions" value={botTotalSessions} sub={`${totalConversations} conversations`} />
            <StatCard label="Completion Rate" value={`${botCompletionRate}%`} sub={`${botCompleted} completed`} />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            {/* Intent Distribution */}
            {topIntents.length > 0 && (
              <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Top Intents Detected</h3>
                  <span className="text-xs text-gray-400 dark:text-gray-500">Avg confidence: {avgConfidence}%</span>
                </div>
                <div className="mt-4 space-y-3">
                  {(() => {
                    const maxIntentCount = Math.max(...topIntents.map(i => i.count), 1);
                    return topIntents.map((item, i) => (
                      <div key={item.intent} className="flex items-center gap-3">
                        <span className="w-5 text-center text-xs font-bold text-gray-400 dark:text-gray-500">{i + 1}</span>
                        <div className="flex-1">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium text-gray-900 dark:text-gray-100 capitalize">{item.intent.replace(/_/g, ' ')}</span>
                            <span className="text-xs text-gray-500 dark:text-gray-400">{item.count}</span>
                          </div>
                          <div className="mt-1 h-2 w-full rounded-full bg-gray-100 dark:bg-gray-700">
                            <div className="h-2 rounded-full bg-brand" style={{ width: `${(item.count / maxIntentCount) * 100}%` }} />
                          </div>
                        </div>
                      </div>
                    ));
                  })()}
                </div>
              </div>
            )}

            {/* Session Outcomes */}
            {botTotalSessions > 0 && (
              <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Session Outcomes</h3>
                <div className="mt-4 space-y-4">
                  {[
                    { label: 'Completed', value: botCompleted, color: 'bg-green-500', textColor: 'text-green-600 dark:text-green-400' },
                    { label: 'Abandoned', value: botAbandoned, color: 'bg-yellow-500', textColor: 'text-yellow-600 dark:text-yellow-400' },
                    { label: 'Active', value: botActive, color: 'bg-blue-500', textColor: 'text-blue-600 dark:text-blue-400' },
                  ].map((item) => {
                    const pct = botTotalSessions > 0 ? Math.round((item.value / botTotalSessions) * 100) : 0;
                    return (
                      <div key={item.label}>
                        <div className="flex items-center justify-between text-sm">
                          <span className="font-medium text-gray-700 dark:text-gray-300">{item.label}</span>
                          <span className={`font-semibold ${item.textColor}`}>{item.value} ({pct}%)</span>
                        </div>
                        <div className="mt-1.5 h-3 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
                          <div className={`h-3 rounded-full ${item.color}`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 flex gap-4 text-[10px] text-gray-400 dark:text-gray-500">
                  <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-green-500" /> Completed</span>
                  <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-yellow-500" /> Abandoned</span>
                  <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-blue-500" /> Active</span>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</p>
      <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
      {sub && <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">{sub}</p>}
    </div>
  );
}

function MiniStat({ label, value, rate, color }: { label: string; value: number; rate: number; color: string }) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
      <div className="flex-1">
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</p>
        <p className="mt-1 text-lg font-bold text-gray-900 dark:text-gray-100">{value}</p>
      </div>
      <div className="flex items-center gap-2">
        <div className="h-8 w-8 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
          <svg viewBox="0 0 36 36" className="h-8 w-8 -rotate-90">
            <circle cx="18" cy="18" r="15.9" fill="none" stroke="#e5e7eb" strokeWidth="3" className="dark:stroke-gray-600" />
            <circle
              cx="18"
              cy="18"
              r="15.9"
              fill="none"
              className={color.replace('bg-', 'stroke-')}
              strokeWidth="3"
              strokeDasharray={`${rate} ${100 - rate}`}
              strokeLinecap="round"
            />
          </svg>
        </div>
        <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">{rate}%</span>
      </div>
    </div>
  );
}
