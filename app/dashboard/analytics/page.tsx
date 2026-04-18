'use client';

import { useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { CATEGORY_LABELS, type BusinessCategoryKey, formatCurrency, type CountryCode } from '@/lib/constants';
import { CsvExportButton } from '@/components/dashboard/CsvExportButton';

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

type TimeRange = '7d' | '30d' | '90d';

export default function AnalyticsPage() {
  const business = useBusiness();
  const labels = CATEGORY_LABELS[business.category as BusinessCategoryKey] || CATEGORY_LABELS.other;
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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const supabase = createClient();

      const days = timeRange === '7d' ? 7 : timeRange === '30d' ? 30 : 90;
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      const startStr = customDateFrom || startDate.toISOString().split('T')[0];
      const endStr = customDateTo || undefined;

      let bookingsQuery = supabase
        .from('bookings')
        .select('id, status, date, time, guest_phone, total_amount, deposit_amount, service_id')
        .eq('business_id', business.id)
        .gte('date', startStr);
      if (endStr) bookingsQuery = bookingsQuery.lte('date', endStr);
      bookingsQuery = bookingsQuery.order('date', { ascending: false });

      const [bookingsRes, servicesRes] = await Promise.all([
        bookingsQuery,
        supabase
          .from('services')
          .select('id, name')
          .eq('business_id', business.id),
      ]);
      const bookings = bookingsRes.data;
      const serviceMap = new Map((servicesRes.data || []).map((s: { id: string; name: string }) => [s.id, s.name]));

      const all = bookings || [];
      setTotalBookings(all.length);
      setCompletedBookings(all.filter((b) => b.status === 'completed').length);
      setCancelledBookings(all.filter((b) => b.status === 'cancelled').length);
      setNoShows(all.filter((b) => b.status === 'no_show').length);
      setTotalRevenue(all.reduce((sum, b) => sum + (b.total_amount || b.deposit_amount || 0), 0));

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

      setLoading(false);
    }
    load();
  }, [business.id, timeRange, customDateFrom, customDateTo]);

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
  const maxHourly = Math.max(...hourlyCounts.map((h) => h.count), 1);

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
          <p className="mt-1 text-sm text-gray-500">Performance overview for {business.name}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 rounded-lg bg-gray-100 p-1">
            {(['7d', '30d', '90d'] as TimeRange[]).map((range) => (
              <button
                key={range}
                onClick={() => { setTimeRange(range); setCustomDateFrom(''); setCustomDateTo(''); }}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  timeRange === range && !customDateFrom ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {range === '7d' ? '7 days' : range === '30d' ? '30 days' : '90 days'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input type="date" value={customDateFrom} onChange={(e) => setCustomDateFrom(e.target.value)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-brand" />
            <span className="text-xs text-gray-400">to</span>
            <input type="date" value={customDateTo} onChange={(e) => setCustomDateTo(e.target.value)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-brand" />
          </div>
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
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={`Total ${labels.entityNamePlural}`} value={totalBookings} />
        <StatCard label="Revenue" value={formatCurrency(totalRevenue, country)} />
        <StatCard label="Completion Rate" value={`${completionRate}%`} sub={`${completedBookings} completed`} />
        <StatCard label={`Unique ${labels.personLabelPlural}`} value={uniqueGuests} sub={`${newGuests} new, ${repeatGuests} returning`} />
      </div>

      {/* Status Breakdown */}
      <div className={`mt-6 grid gap-4 ${labels.hiddenStatuses.includes('no_show') ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`}>
        <MiniStat label="Completed" value={completedBookings} rate={completionRate} color="bg-green-500" />
        <MiniStat label="Cancelled" value={cancelledBookings} rate={cancellationRate} color="bg-yellow-500" />
        {!labels.hiddenStatuses.includes('no_show') && (
          <MiniStat label="No Shows" value={noShows} rate={noShowRate} color="bg-red-500" />
        )}
      </div>

      {/* Charts Row */}
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        {/* Daily Volume Chart */}
        <div className="rounded-xl border border-gray-100 bg-white p-6">
          <h2 className="text-sm font-semibold text-gray-900">{labels.entityNamePlural} Over Time</h2>
          <div className="mt-4 flex items-end gap-[2px]" style={{ height: 160 }}>
            {dailyCounts.map((d) => (
              <div key={d.date} className="group relative flex-1">
                <div
                  className="w-full rounded-t bg-brand transition hover:bg-brand-400"
                  style={{ height: `${Math.max((d.count / maxDaily) * 140, 2)}px` }}
                />
                <div className="pointer-events-none absolute -top-8 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded bg-gray-800 px-2 py-1 text-xs text-white opacity-0 group-hover:opacity-100">
                  {d.count} &middot; {formatCurrency(d.revenue, country)}
                  <br />
                  {new Date(d.date + 'T00:00').toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between text-xs text-gray-400">
            <span>{timeRange === '7d' ? '7 days ago' : timeRange === '30d' ? '30 days ago' : '90 days ago'}</span>
            <span>Today</span>
          </div>
        </div>

        {/* Peak Hours Chart */}
        <div className="rounded-xl border border-gray-100 bg-white p-6">
          <h2 className="text-sm font-semibold text-gray-900">Peak Hours</h2>
          <div className="mt-4 flex items-end gap-1" style={{ height: 160 }}>
            {hourlyCounts.map((h) => (
              <div key={h.hour} className="group relative flex-1">
                <div
                  className="w-full rounded-t bg-accent transition hover:bg-accent/80"
                  style={{ height: `${Math.max((h.count / maxHourly) * 140, 2)}px` }}
                />
                <div className="pointer-events-none absolute -top-8 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded bg-gray-800 px-2 py-1 text-xs text-white opacity-0 group-hover:opacity-100">
                  {h.count} at {h.hour}:00
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between text-xs text-gray-400">
            <span>6 AM</span>
            <span>12 PM</span>
            <span>6 PM</span>
            <span>11 PM</span>
          </div>
        </div>
      </div>

      {/* Top Services */}
      {topServices.length > 0 && (
        <div className="mt-8 rounded-xl border border-gray-100 bg-white p-6">
          <h2 className="text-sm font-semibold text-gray-900">Top {labels.serviceNamePlural}</h2>
          <div className="mt-4 space-y-3">
            {topServices.map((s, i) => {
              const pct = totalBookings > 0 ? Math.round((s.count / totalBookings) * 100) : 0;
              return (
                <div key={s.name} className="flex items-center gap-4">
                  <span className="w-6 text-center text-xs font-bold text-gray-400">{i + 1}</span>
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-gray-900">{s.name}</span>
                      <span className="text-xs text-gray-500">{s.count} ({pct}%)</span>
                    </div>
                    <div className="mt-1 h-2 w-full rounded-full bg-gray-100">
                      <div className="h-2 rounded-full bg-brand" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                  <span className="w-24 text-right text-xs font-medium text-gray-600">
                    {formatCurrency(s.revenue, country)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-5">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className="mt-2 text-2xl font-bold text-gray-900">{value}</p>
      {sub && <p className="mt-1 text-xs text-gray-400">{sub}</p>}
    </div>
  );
}

function MiniStat({ label, value, rate, color }: { label: string; value: number; rate: number; color: string }) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-gray-100 bg-white p-4">
      <div className="flex-1">
        <p className="text-xs font-medium text-gray-500">{label}</p>
        <p className="mt-1 text-lg font-bold text-gray-900">{value}</p>
      </div>
      <div className="flex items-center gap-2">
        <div className="h-8 w-8 overflow-hidden rounded-full bg-gray-100">
          <svg viewBox="0 0 36 36" className="h-8 w-8 -rotate-90">
            <circle cx="18" cy="18" r="15.9" fill="none" stroke="#e5e7eb" strokeWidth="3" />
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
        <span className="text-sm font-semibold text-gray-700">{rate}%</span>
      </div>
    </div>
  );
}
