import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { supabase, adminDb } from '@/lib/supabase';
import { Building2, DollarSign, Clock, Users, LifeBuoy, Bot, CalendarDays, AlertTriangle, ShieldAlert, BadgeCheck, Flag, Zap, CreditCard, BrainCircuit, Bell, Globe, MessageCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface StatCard {
  label: string;
  value: string;
  icon: LucideIcon;
  color: string;
}

interface ActionAlert {
  icon: LucideIcon;
  label: string;
  count: number;
  color: string;
  path: string;
}

const countryToCur: Record<string, string> = { US: 'USD', CA: 'CAD', GB: 'GBP', NG: 'NGN', GH: 'GHS' };

export default function Dashboard() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<StatCard[]>([]);
  const [pendingPayouts, setPendingPayouts] = useState(0);
  const [heldPayouts, setHeldPayouts] = useState(0);
  const [alerts, setAlerts] = useState<ActionAlert[]>([]);
  // System health
  const [paymentSuccessCount, setPaymentSuccessCount] = useState(0);
  const [paymentFailedCount, setPaymentFailedCount] = useState(0);
  const [llmTotal, setLlmTotal] = useState(0);
  const [llmUsedCount, setLlmUsedCount] = useState(0);
  const [llmAvgConfidence, setLlmAvgConfidence] = useState(0);
  const [recentAlerts, setRecentAlerts] = useState<{ id: string; severity: string; title: string; business_name: string; created_at: string }[]>([]);
  const [whatsappBookings, setWhatsappBookings] = useState(0);
  const [webBookings, setWebBookings] = useState(0);
  // Feature adoption + top businesses + customer insights
  const [featureAdoption, setFeatureAdoption] = useState<Array<{ capability: string; count: number }>>([]);
  const [topBusinesses, setTopBusinesses] = useState<Array<{ name: string; bookings: number; revenue: number; country: string }>>([]);
  const [customerInsights, setCustomerInsights] = useState<{ total: number; returning: number; thisMonth: number }>({ total: 0, returning: 0, thisMonth: 0 });
  const [categoryBreakdown, setCategoryBreakdown] = useState<Array<{ category: string; count: number; bookings: number; revenue: number; revenueByCurrency: Record<string, number> }>>([]);
  // Revenue summary with time periods
  const [revenuePeriod, setRevenuePeriod] = useState<'week' | 'month' | 'all'>('month');
  const [revenueSummary, setRevenueSummary] = useState<{ fees: Record<string, number>; volume: Record<string, number>; count: number }>({ fees: {}, volume: {}, count: 0 });
  const [revenueLoading, setRevenueLoading] = useState(false);

  // Load revenue summary when period changes
  useEffect(() => {
    async function loadRevenue() {
      setRevenueLoading(true);
      try {
        const { adminQuery } = await import('@/lib/adminQuery');
        const now = new Date();
        let dateFilter: string | null = null;
        if (revenuePeriod === 'month') {
          dateFilter = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        } else if (revenuePeriod === 'week') {
          const weekAgo = new Date(now);
          weekAgo.setDate(weekAgo.getDate() - 7);
          dateFilter = weekAgo.toISOString();
        }

        const filters: Array<{ column: string; op: string; value: unknown }> = [
          { column: 'waived', op: 'eq', value: false },
          { column: 'refunded_at', op: 'is', value: null },
        ];
        if (dateFilter) filters.push({ column: 'created_at', op: 'gte', value: dateFilter });

        const { data: fees } = await adminQuery('platform_fees', {
          select: 'fee_total, transaction_amount, business_id',
          filters,
        });

        // Resolve business countries
        const bizIds = [...new Set((fees || []).map((f: { business_id: string }) => f.business_id).filter(Boolean))];
        const { data: bizData } = bizIds.length > 0
          ? await adminQuery('businesses', { select: 'id, country_code', filters: [{ column: 'id', op: 'in', value: bizIds }] })
          : { data: [] };
        const bizCountry = new Map((bizData || []).map((b: { id: string; country_code: string }) => [b.id, b.country_code || 'NG']));

        const feesByCur: Record<string, number> = {};
        const volByCur: Record<string, number> = {};
        for (const f of fees || []) {
          const cur = countryToCur[bizCountry.get(f.business_id) || 'NG'] || 'NGN';
          feesByCur[cur] = (feesByCur[cur] || 0) + Number(f.fee_total || 0);
          volByCur[cur] = (volByCur[cur] || 0) + Number(f.transaction_amount || 0);
        }

        setRevenueSummary({ fees: feesByCur, volume: volByCur, count: (fees || []).length });
      } catch (err) {
        console.error('Revenue load error:', err);
      }
      setRevenueLoading(false);
    }
    loadRevenue();
  }, [revenuePeriod]);

  useEffect(() => {
    async function loadStats() {
      try {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

        const { adminQuery } = await import('@/lib/adminQuery');
        const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
        const [bizRes, feesRes, payoutsRes, heldRes, usersRes, ticketsRes, botRes, bookingsRes, unverifiedRes, pendingDocsRes, flaggedRes, overridesRes, newBizRes, newUsersRes, churnedRes] = await Promise.all([
          adminQuery('businesses', { select: 'id', filters: [{ column: 'status', op: 'eq', value: 'active' }], count: 'exact' }),
          adminQuery('platform_fees', { select: 'fee_total, business_id', filters: [{ column: 'created_at', op: 'gte', value: monthStart }, { column: 'waived', op: 'eq', value: false }, { column: 'refunded_at', op: 'is', value: null }] }),
          adminQuery('business_payouts', { select: 'net_amount, status, business_id', filters: [{ column: 'status', op: 'eq', value: 'pending' }] }),
          adminQuery('business_payouts', { select: 'id', filters: [{ column: 'status', op: 'eq', value: 'held' }], count: 'exact' }),
          adminQuery('profiles', { select: 'id', count: 'exact' }),
          adminQuery('support_tickets', { select: 'id', filters: [{ column: 'status', op: 'in', value: ['open', 'in_progress', 'waiting'] }], count: 'exact' }),
          adminQuery('bot_sessions', { select: 'id', filters: [{ column: 'is_active', op: 'eq', value: true }], count: 'exact' }),
          adminQuery('bookings', { select: 'id', filters: [{ column: 'created_at', op: 'gte', value: monthStart }], count: 'exact' }),
          adminQuery('businesses', { select: 'id', filters: [{ column: 'verification_level', op: 'eq', value: 'unverified' }, { column: 'status', op: 'eq', value: 'active' }], count: 'exact' }),
          adminQuery('business_documents', { select: 'id', filters: [{ column: 'status', op: 'eq', value: 'pending' }], count: 'exact' }),
          adminQuery('business_payouts', { select: 'id', filters: [{ column: 'flags', op: 'neq', value: '[]' }], count: 'exact' }),
          adminQuery('capability_overrides', { select: 'business_id' }),
          // Growth metrics
          adminQuery('businesses', { select: 'id', filters: [{ column: 'created_at', op: 'gte', value: monthStart }], count: 'exact' }),
          adminQuery('profiles', { select: 'id', filters: [{ column: 'created_at', op: 'gte', value: monthStart }], count: 'exact' }),
          adminQuery('businesses', { select: 'id', filters: [{ column: 'status', op: 'in', value: ['suspended', 'cancelled'] }], count: 'exact' }),
        ]);

        // Group fees by currency via business country
        const feesBizIds = [...new Set((feesRes.data || []).map(f => f.business_id).filter(Boolean))];
        const feeBizRes = feesBizIds.length > 0
          ? await adminQuery('businesses', { select: 'id, country_code', filters: [{ column: 'id', op: 'in', value: feesBizIds }] })
          : { data: [] };
        const feeBizData = feeBizRes.data || [];
        const feeBizCountry = new Map((feeBizData || []).map(b => [b.id, b.country_code || 'NG']));

        const revByCurrency: Record<string, number> = {};
        for (const f of feesRes.data || []) {
          const cc = feeBizCountry.get(f.business_id) || 'NG';
          const cur = countryToCur[cc] || 'NGN';
          revByCurrency[cur] = (revByCurrency[cur] || 0) + Number(f.fee_total || 0);
        }
        const revenueDisplay = Object.entries(revByCurrency)
          .filter(([, a]) => a > 0)
          .map(([cur, amt]) => formatMoney(amt, cur))
          .join(' · ') || '—';

        // Group payouts by currency via business country
        const payoutBizIds = [...new Set((payoutsRes.data || []).map(p => p.business_id).filter(Boolean))];
        const payoutBizRes = payoutBizIds.length > 0
          ? await adminQuery('businesses', { select: 'id, country_code', filters: [{ column: 'id', op: 'in', value: payoutBizIds }] })
          : { data: [] };
        const payoutBizCountry = new Map((payoutBizRes.data || []).map(b => [b.id, b.country_code || 'NG']));
        const payoutByCurrency: Record<string, number> = {};
        for (const p of payoutsRes.data || []) {
          const cc = payoutBizCountry.get(p.business_id) || 'NG';
          const cur = countryToCur[cc] || 'NGN';
          payoutByCurrency[cur] = (payoutByCurrency[cur] || 0) + Number(p.net_amount || 0);
        }
        const pendingCount = payoutsRes.data?.length || 0;
        const pendingDisplay = pendingCount > 0
          ? `${pendingCount} (${Object.entries(payoutByCurrency).filter(([, a]) => a > 0).map(([cur, amt]) => formatMoney(amt, cur)).join(' · ')})`
          : '0';
        const heldCount = heldRes.count || 0;

        setPendingPayouts(pendingCount);
        setHeldPayouts(heldCount);

        // Per-currency revenue cards
        const currencyCards: StatCard[] = Object.entries(revByCurrency)
          .filter(([, a]) => a > 0)
          .map(([cur, amt]) => ({
            label: `Revenue (${cur})`,
            value: formatMoney(amt, cur),
            icon: DollarSign,
            color: 'green',
          }));

        const newBizCount = newBizRes?.count || 0;
        const newUserCount = newUsersRes?.count || 0;
        const churnedCount = churnedRes?.count || 0;

        setStats([
          {
            label: 'Total Businesses',
            value: String(bizRes.count || 0),
            icon: Building2,
            color: 'blue',
          },
          {
            label: 'New Businesses (this month)',
            value: String(newBizCount),
            icon: Zap,
            color: 'green',
          },
          {
            label: 'New Users (this month)',
            value: String(newUserCount),
            icon: Users,
            color: 'green',
          },
          {
            label: 'Churned / Suspended',
            value: String(churnedCount),
            icon: AlertTriangle,
            color: churnedCount > 0 ? 'red' : 'green',
          },
          ...currencyCards,
          {
            label: 'Pending Payouts',
            value: pendingDisplay,
            icon: Clock,
            color: 'yellow',
          },
          {
            label: 'Held Payouts',
            value: String(heldCount),
            icon: AlertTriangle,
            color: 'red',
          },
          {
            label: 'Total Users',
            value: String(usersRes.count || 0),
            icon: Users,
            color: 'purple',
          },
          {
            label: 'Open Tickets',
            value: String(ticketsRes.count || 0),
            icon: LifeBuoy,
            color: 'red',
          },
          {
            label: 'Active Bot Sessions',
            value: String(botRes.count || 0),
            icon: Bot,
            color: 'indigo',
          },
          {
            label: 'Monthly Bookings',
            value: String(bookingsRes.count || 0),
            icon: CalendarDays,
            color: 'green',
          },
          {
            label: 'Capability Overrides',
            value: `${new Set((overridesRes.data || []).map(r => r.business_id)).size} businesses`,
            icon: Zap,
            color: 'purple',
          },
        ]);

        // Build alerts
        const alertList: ActionAlert[] = [];
        const unverifiedCount = unverifiedRes.count || 0;
        const pendingDocsCount = pendingDocsRes.count || 0;
        const flaggedCount = flaggedRes.count || 0;

        if (heldCount > 0) {
          alertList.push({
            icon: ShieldAlert,
            label: 'Held payouts requiring review',
            count: heldCount,
            color: 'red',
            path: '/payouts',
          });
        }
        if (pendingDocsCount > 0) {
          alertList.push({
            icon: BadgeCheck,
            label: 'Pending verification reviews',
            count: pendingDocsCount,
            color: 'yellow',
            path: '/verification',
          });
        }
        if (unverifiedCount > 0) {
          alertList.push({
            icon: AlertTriangle,
            label: 'Unverified active businesses',
            count: unverifiedCount,
            color: 'yellow',
            path: '/businesses',
          });
        }
        if (flaggedCount > 0) {
          alertList.push({
            icon: Flag,
            label: 'Flagged payouts',
            count: flaggedCount,
            color: 'red',
            path: '/payouts',
          });
        }
        setAlerts(alertList);

        // System health queries
        const [paymentsSuccessRes, paymentsFailedRes, llmRes, recentAlertsRes, waBookingsRes, webBookingsRes] = await Promise.all([
          adminQuery('payments', { select: 'id', filters: [{ column: 'status', op: 'eq', value: 'success' }, { column: 'created_at', op: 'gte', value: monthStart }], count: 'exact' }),
          adminQuery('payments', { select: 'id', filters: [{ column: 'status', op: 'eq', value: 'failed' }, { column: 'created_at', op: 'gte', value: monthStart }], count: 'exact' }),
          adminQuery('llm_classifications', { select: 'confidence, llm_used', filters: [{ column: 'created_at', op: 'gte', value: monthStart }], limit: 500 }),
          adminQuery('alerts', { select: 'id, severity, title, business_id, created_at', order: { column: 'created_at', ascending: false }, limit: 5 }),
          adminQuery('bookings', { select: 'id', filters: [{ column: 'channel', op: 'eq', value: 'whatsapp' }, { column: 'created_at', op: 'gte', value: monthStart }], count: 'exact' }),
          adminQuery('bookings', { select: 'id', filters: [{ column: 'channel', op: 'eq', value: 'web' }, { column: 'created_at', op: 'gte', value: monthStart }], count: 'exact' }),
        ]);

        setPaymentSuccessCount(paymentsSuccessRes.count || 0);
        setPaymentFailedCount(paymentsFailedRes.count || 0);

        const llmData = llmRes.data || [];
        setLlmTotal(llmData.length);
        setLlmUsedCount(llmData.filter((r: Record<string, unknown>) => r.llm_used).length);
        const confidences = llmData.filter((r: Record<string, unknown>) => (r.confidence as number) > 0).map((r: Record<string, unknown>) => r.confidence as number);
        setLlmAvgConfidence(confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0);

        setWhatsappBookings(waBookingsRes.count || 0);
        setWebBookings(webBookingsRes.count || 0);

        // Feature adoption — which capabilities are most used
        const capRes = await adminQuery('business_capabilities', { select: 'capability, business_id', filters: [{ column: 'is_enabled', op: 'eq', value: true }] });
        const capCounts = new Map<string, number>();
        for (const r of capRes.data || []) {
          capCounts.set(r.capability, (capCounts.get(r.capability) || 0) + 1);
        }
        setFeatureAdoption(
          Array.from(capCounts.entries())
            .map(([capability, count]) => ({ capability, count }))
            .sort((a, b) => b.count - a.count)
        );

        // Top businesses by bookings + revenue
        const bizBookingsRes = await adminQuery('bookings', { select: 'business_id', filters: [{ column: 'created_at', op: 'gte', value: monthStart }] });
        const bizBookingCounts = new Map<string, number>();
        for (const b of bizBookingsRes.data || []) {
          bizBookingCounts.set(b.business_id, (bizBookingCounts.get(b.business_id) || 0) + 1);
        }
        const topBizIds = Array.from(bizBookingCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id);
        if (topBizIds.length > 0) {
          const topBizDetails = await adminQuery('businesses', { select: 'id, name, country_code', filters: [{ column: 'id', op: 'in', value: topBizIds }] });
          const topBizPayments = await adminQuery('payments', { select: 'business_id, amount', filters: [{ column: 'business_id', op: 'in', value: topBizIds }, { column: 'status', op: 'eq', value: 'success' }, { column: 'created_at', op: 'gte', value: monthStart }] });
          const bizRevMap = new Map<string, number>();
          for (const p of topBizPayments.data || []) { bizRevMap.set(p.business_id, (bizRevMap.get(p.business_id) || 0) + Number(p.amount || 0)); }
          const bizDetailMap = new Map((topBizDetails.data || []).map(b => [b.id, b]));
          setTopBusinesses(topBizIds.map(id => {
            const d = bizDetailMap.get(id);
            return { name: d?.name || 'Unknown', bookings: bizBookingCounts.get(id) || 0, revenue: bizRevMap.get(id) || 0, country: d?.country_code || 'NG' };
          }));
        }

        // Customer insights
        const totalCustomersRes = await adminQuery('customer_profiles', { select: 'id', count: 'exact' });
        const returningRes = await adminQuery('customer_profiles', { select: 'id', filters: [{ column: 'total_visits', op: 'gt', value: 1 }], count: 'exact' });
        const newCustomersRes = await adminQuery('customer_profiles', { select: 'id', filters: [{ column: 'created_at', op: 'gte', value: monthStart }], count: 'exact' });
        setCustomerInsights({
          total: totalCustomersRes.count || 0,
          returning: returningRes.count || 0,
          thisMonth: newCustomersRes.count || 0,
        });

        // Category breakdown — businesses, bookings, revenue per category
        const allBizRes = await adminQuery('businesses', { select: 'id, category, country_code', filters: [{ column: 'status', op: 'eq', value: 'active' }] });
        const allBookingsRes = await adminQuery('bookings', { select: 'business_id', filters: [{ column: 'created_at', op: 'gte', value: monthStart }] });
        const allPaymentsRes = await adminQuery('payments', { select: 'business_id, amount', filters: [{ column: 'status', op: 'eq', value: 'success' }] });

        const bizCatMap = new Map((allBizRes.data || []).map(b => [b.id, b.category]));
        const bizCountryMap = new Map((allBizRes.data || []).map(b => [b.id, b.country_code || 'NG']));
        const catStats = new Map<string, { count: number; bookings: number; revenueByCurrency: Record<string, number> }>();

        // Count businesses per category
        for (const b of allBizRes.data || []) {
          const cat = b.category || 'other';
          const existing = catStats.get(cat) || { count: 0, bookings: 0, revenueByCurrency: {} };
          existing.count++;
          catStats.set(cat, existing);
        }
        // Count bookings per category
        for (const bk of allBookingsRes.data || []) {
          const cat = bizCatMap.get(bk.business_id) || 'other';
          const existing = catStats.get(cat);
          if (existing) existing.bookings++;
        }
        // Sum revenue per category per currency
        for (const p of allPaymentsRes.data || []) {
          const cat = bizCatMap.get(p.business_id) || 'other';
          const cc = bizCountryMap.get(p.business_id) || 'NG';
          const cur = countryToCur[cc] || 'NGN';
          const existing = catStats.get(cat);
          if (existing) {
            existing.revenueByCurrency[cur] = (existing.revenueByCurrency[cur] || 0) + Number(p.amount || 0);
          }
        }

        setCategoryBreakdown(
          Array.from(catStats.entries())
            .map(([category, data]) => ({
              category,
              count: data.count,
              bookings: data.bookings,
              revenue: Object.values(data.revenueByCurrency).reduce((s, a) => s + a, 0),
              revenueByCurrency: data.revenueByCurrency,
            }))
            .sort((a, b) => b.count - a.count)
        );

        // Enrich alerts with business names
        const alertBizIds = [...new Set((recentAlertsRes.data || []).map((a: Record<string, unknown>) => a.business_id as string).filter(Boolean))];
        const alertBizRes = alertBizIds.length > 0
          ? await adminQuery('businesses', { select: 'id, name', filters: [{ column: 'id', op: 'in', value: alertBizIds }] })
          : { data: [] };
        const alertBizzes = alertBizRes.data || [];
        const alertBizMap = new Map((alertBizzes || []).map(b => [b.id, b.name]));
        setRecentAlerts((recentAlertsRes.data || []).map(a => ({
          ...a,
          business_name: alertBizMap.get(a.business_id) || 'Unknown',
        })));
      } catch (error) {
        console.warn('Failed to load dashboard stats:', error);
      } finally {
        setLoading(false);
      }
    }

    loadStats();
  }, []);

  const cardColors: Record<string, string> = {
    blue: 'bg-blue-50 border-blue-100 text-blue-600',
    green: 'bg-green-50 border-green-100 text-green-600',
    yellow: 'bg-yellow-50 border-yellow-100 text-yellow-600',
    purple: 'bg-purple-50 border-purple-100 text-purple-600',
    red: 'bg-red-50 border-red-100 text-red-600',
    indigo: 'bg-indigo-50 border-indigo-100 text-indigo-600',
  };

  const iconColors: Record<string, string> = {
    blue: 'bg-blue-100 text-blue-600',
    green: 'bg-green-100 text-green-600',
    yellow: 'bg-yellow-100 text-yellow-600',
    purple: 'bg-purple-100 text-purple-600',
    red: 'bg-red-100 text-red-600',
    indigo: 'bg-indigo-100 text-indigo-600',
  };

  const alertColors: Record<string, { bg: string; border: string; text: string; icon: string }> = {
    red: { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-800', icon: 'text-red-500' },
    yellow: { bg: 'bg-yellow-50', border: 'border-yellow-200', text: 'text-yellow-800', icon: 'text-yellow-500' },
  };

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
      <p className="mt-1 text-sm text-gray-500">Platform overview and quick actions</p>

      {/* Action Required Alerts */}
      {alerts.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Action Required</h2>
          <div className="mt-2 space-y-2">
            {alerts.map((alert) => {
              const Icon = alert.icon;
              const colors = alertColors[alert.color] || alertColors.yellow;
              return (
                <button
                  key={alert.label}
                  onClick={() => navigate(alert.path)}
                  className={`w-full flex items-center gap-3 rounded-xl border ${colors.border} ${colors.bg} px-4 py-3 text-left transition hover:shadow-sm cursor-pointer`}
                >
                  <Icon className={`h-5 w-5 shrink-0 ${colors.icon}`} />
                  <span className={`flex-1 text-sm font-medium ${colors.text}`}>{alert.label}</span>
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${colors.text} ${colors.bg}`}>
                    {alert.count}
                  </span>
                  <svg className={`h-4 w-4 shrink-0 ${colors.icon}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Stat Cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className={`rounded-xl border p-5 ${cardColors[stat.color]}`}>
              <div className="flex items-center gap-3">
                <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${iconColors[stat.color]}`}>
                  <Icon className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-xs font-medium text-gray-500">{stat.label}</p>
                  <p className="text-lg font-bold text-gray-900">{stat.value}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Revenue Summary */}
      <div className="mt-8">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">Platform Revenue</h2>
            <p className="mt-0.5 text-xs text-gray-400">Fees earned from business transactions</p>
          </div>
          <div className="flex gap-1 rounded-lg border border-gray-200 bg-white p-0.5">
            {([
              { key: 'week' as const, label: 'This Week' },
              { key: 'month' as const, label: 'This Month' },
              { key: 'all' as const, label: 'All Time' },
            ]).map(p => (
              <button
                key={p.key}
                onClick={() => setRevenuePeriod(p.key)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  revenuePeriod === p.key
                    ? 'bg-gray-900 text-white'
                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {revenueLoading ? (
          <div className="mt-4 flex justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
          </div>
        ) : (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Object.entries(revenueSummary.fees).filter(([, a]) => a > 0).map(([cur, amt]) => (
              <div key={`fee-${cur}`} className="rounded-xl border border-green-200 bg-green-50 p-5">
                <p className="text-xs font-medium text-green-600">Fees Earned ({cur})</p>
                <p className="mt-1 text-2xl font-bold text-green-800">{formatMoney(amt, cur)}</p>
                <p className="mt-1 text-xs text-green-500">
                  from {formatMoney(revenueSummary.volume[cur] || 0, cur)} volume
                </p>
              </div>
            ))}
            {Object.entries(revenueSummary.fees).filter(([, a]) => a > 0).length === 0 && (
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-5 sm:col-span-2">
                <p className="text-xs font-medium text-gray-500">No revenue {revenuePeriod === 'all' ? 'yet' : `this ${revenuePeriod}`}</p>
                <p className="mt-1 text-lg font-bold text-gray-400">—</p>
              </div>
            )}
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              <p className="text-xs font-medium text-gray-500">Transactions</p>
              <p className="mt-1 text-2xl font-bold text-gray-900">{revenueSummary.count}</p>
              <p className="mt-1 text-xs text-gray-400">
                {revenuePeriod === 'week' ? 'last 7 days' : revenuePeriod === 'month' ? 'this month' : 'all time'}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* System Health */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold text-gray-900">System Health</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {/* Payment Health */}
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-green-600" />
              <h3 className="text-sm font-semibold text-gray-900">Payment Health</h3>
            </div>
            <div className="mt-3 flex items-end justify-between">
              <div>
                <p className="text-2xl font-bold text-gray-900">
                  {(paymentSuccessCount + paymentFailedCount) > 0
                    ? `${Math.round((paymentSuccessCount / (paymentSuccessCount + paymentFailedCount)) * 100)}%`
                    : '—'}
                </p>
                <p className="text-xs text-gray-500">Success rate this month</p>
              </div>
              <div className="text-right text-xs text-gray-400">
                <p className="text-green-600 font-medium">{paymentSuccessCount} succeeded</p>
                <p className="text-red-500 font-medium">{paymentFailedCount} failed</p>
              </div>
            </div>
            {(paymentSuccessCount + paymentFailedCount) > 0 && (
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-red-100">
                <div className="h-2 rounded-full bg-green-500" style={{ width: `${(paymentSuccessCount / (paymentSuccessCount + paymentFailedCount)) * 100}%` }} />
              </div>
            )}
          </div>

          {/* LLM Performance */}
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="flex items-center gap-2">
              <BrainCircuit className="h-4 w-4 text-purple-600" />
              <h3 className="text-sm font-semibold text-gray-900">LLM Intent Detection</h3>
            </div>
            <div className="mt-3 flex items-end justify-between">
              <div>
                <p className="text-2xl font-bold text-gray-900">{llmTotal}</p>
                <p className="text-xs text-gray-500">Classifications this month</p>
              </div>
              <div className="text-right text-xs text-gray-400">
                <p className="text-purple-600 font-medium">{llmUsedCount} used LLM</p>
                <p className="text-gray-500 font-medium">{llmTotal - llmUsedCount} regex only</p>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between text-xs">
              <span className="text-gray-500">Avg confidence</span>
              <span className={`font-semibold ${llmAvgConfidence >= 0.8 ? 'text-green-600' : llmAvgConfidence >= 0.5 ? 'text-yellow-600' : 'text-red-600'}`}>
                {(llmAvgConfidence * 100).toFixed(0)}%
              </span>
            </div>
          </div>

          {/* Booking Channels */}
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-blue-600" />
              <h3 className="text-sm font-semibold text-gray-900">Booking Channels</h3>
            </div>
            <div className="mt-3 flex items-end justify-between">
              <div>
                <p className="text-2xl font-bold text-gray-900">
                  {(whatsappBookings + webBookings) > 0
                    ? `${whatsappBookings + webBookings}`
                    : '—'}
                </p>
                <p className="text-xs text-gray-500">Total this month</p>
              </div>
              <div className="text-right text-xs text-gray-400">
                <p className="text-green-600 font-medium flex items-center justify-end gap-1">
                  <MessageCircle className="h-3 w-3" /> {whatsappBookings} WhatsApp
                </p>
                <p className="text-blue-600 font-medium flex items-center justify-end gap-1">
                  <Globe className="h-3 w-3" /> {webBookings} Web
                </p>
              </div>
            </div>
            {(whatsappBookings + webBookings) > 0 && (
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-blue-100">
                <div className="h-2 rounded-full bg-green-500" style={{ width: `${(whatsappBookings / (whatsappBookings + webBookings)) * 100}%` }} />
              </div>
            )}
            <div className="mt-2 flex gap-4 text-[10px] text-gray-400">
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-green-500" /> WhatsApp</span>
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-blue-400" /> Web</span>
            </div>
          </div>

          {/* Recent Alerts */}
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-amber-600" />
                <h3 className="text-sm font-semibold text-gray-900">Recent Alerts</h3>
              </div>
              <button onClick={() => navigate('/alerts')} className="text-xs text-brand hover:underline">View all</button>
            </div>
            <div className="mt-3 space-y-2">
              {recentAlerts.length === 0 && (
                <p className="text-xs text-gray-400 py-2">No recent alerts</p>
              )}
              {recentAlerts.map(a => (
                <div key={a.id} className="flex items-center gap-2 text-xs">
                  <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${
                    a.severity === 'critical' ? 'bg-red-500' : a.severity === 'warning' ? 'bg-yellow-500' : 'bg-blue-500'
                  }`} />
                  <span className="truncate text-gray-700">{a.title}</span>
                  <span className="shrink-0 text-gray-400">{a.business_name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Platform Insights */}
      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        {/* Feature Adoption */}
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-gray-900">Feature Adoption</h3>
          <p className="mt-0.5 text-xs text-gray-400">Which capabilities businesses enable</p>
          <div className="mt-4 space-y-2">
            {featureAdoption.slice(0, 10).map(f => {
              const total = featureAdoption[0]?.count || 1;
              const pct = Math.round((f.count / total) * 100);
              return (
                <div key={f.capability} className="flex items-center gap-2">
                  <span className="w-28 truncate text-xs text-gray-600 capitalize">{f.capability.replace(/_/g, ' ')}</span>
                  <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                    <div className="h-2 rounded-full bg-brand" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="w-8 text-right text-xs font-medium text-gray-700">{f.count}</span>
                </div>
              );
            })}
            {featureAdoption.length === 0 && <p className="text-xs text-gray-400">No data yet</p>}
          </div>
        </div>

        {/* Top Businesses */}
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-gray-900">Top Businesses</h3>
          <p className="mt-0.5 text-xs text-gray-400">Most active this month</p>
          <div className="mt-4 space-y-3">
            {topBusinesses.map((b, i) => (
              <div key={b.name} className="flex items-center gap-3">
                <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold text-white ${i === 0 ? 'bg-amber-500' : i === 1 ? 'bg-gray-400' : i === 2 ? 'bg-amber-700' : 'bg-gray-300'}`}>{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{b.name}</p>
                  <p className="text-[10px] text-gray-400">{b.bookings} bookings · {b.country}</p>
                </div>
                <span className="text-xs font-semibold text-gray-700">{formatMoney(b.revenue, countryToCur[b.country] || 'NGN')}</span>
              </div>
            ))}
            {topBusinesses.length === 0 && <p className="text-xs text-gray-400">No bookings this month</p>}
          </div>
        </div>

        {/* Customer Insights */}
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-gray-900">Customer Insights</h3>
          <p className="mt-0.5 text-xs text-gray-400">Across all businesses</p>
          <div className="mt-4 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">Total Customers</span>
              <span className="text-lg font-bold text-gray-900">{customerInsights.total.toLocaleString()}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">Returning Customers</span>
              <div className="text-right">
                <span className="text-lg font-bold text-green-600">{customerInsights.returning.toLocaleString()}</span>
                {customerInsights.total > 0 && (
                  <span className="ml-1 text-xs text-gray-400">({Math.round((customerInsights.returning / customerInsights.total) * 100)}%)</span>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">New This Month</span>
              <span className="text-lg font-bold text-brand">{customerInsights.thisMonth.toLocaleString()}</span>
            </div>
            {customerInsights.total > 0 && (
              <div>
                <div className="flex justify-between text-[10px] text-gray-400 mb-1">
                  <span>New</span>
                  <span>Returning</span>
                </div>
                <div className="h-3 w-full overflow-hidden rounded-full bg-gray-100">
                  <div className="h-3 rounded-full bg-green-500" style={{ width: `${(customerInsights.returning / customerInsights.total) * 100}%` }} />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Category Breakdown */}
      {categoryBreakdown.length > 0 && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold text-gray-900">By Business Category</h2>
          <p className="mt-0.5 text-sm text-gray-500">Active businesses, bookings this month, and total revenue per category</p>
          <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100 bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Category</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">Businesses</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">Bookings</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">Revenue</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 w-40">Activity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {categoryBreakdown.map(cat => {
                  const maxBookings = categoryBreakdown[0]?.bookings || 1;
                  return (
                    <tr key={cat.category} className="hover:bg-gray-50 transition">
                      <td className="px-4 py-3 font-medium text-gray-900 capitalize">{cat.category.replace(/_/g, ' ')}</td>
                      <td className="px-4 py-3 text-right text-gray-700">{cat.count}</td>
                      <td className="px-4 py-3 text-right text-gray-700">{cat.bookings}</td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900">
                        {cat.revenue > 0
                          ? Object.entries(cat.revenueByCurrency)
                              .filter(([, a]) => a > 0)
                              .map(([cur, amt]) => formatMoney(amt, cur))
                              .join(' · ') || '—'
                          : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden">
                          <div className="h-2 rounded-full bg-brand" style={{ width: `${Math.max(2, (cat.bookings / maxBookings) * 100)}%` }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold text-gray-900">Quick Actions</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <QuickAction
            title="Approve Payouts"
            description={`${pendingPayouts} pending${heldPayouts > 0 ? `, ${heldPayouts} held` : ''}`}
            onClick={() => navigate('/payouts')}
          />
          <QuickAction
            title="Verification Reviews"
            description="Review business verification requests"
            onClick={() => navigate('/verification')}
          />
          <QuickAction
            title="Support Tickets"
            description="View and respond to open tickets"
            onClick={() => navigate('/support')}
          />
          <QuickAction
            title="Manage Users"
            description="View and manage all platform users"
            onClick={() => navigate('/users')}
          />
          <QuickAction
            title="View Financials"
            description="Revenue analytics and reporting"
            onClick={() => navigate('/finance')}
          />
          <QuickAction
            title="Platform Settings"
            description="Configure platform-wide settings"
            onClick={() => navigate('/platform-settings')}
          />
        </div>
      </div>
    </div>
  );
}

function QuickAction({ title, description, onClick }: { title: string; description: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-xl border border-gray-200 bg-white p-5 text-left transition hover:border-brand-100 hover:shadow-sm cursor-pointer"
    >
      <p className="text-sm font-semibold text-gray-900">{title}</p>
      <p className="mt-1 text-xs text-gray-500">{description}</p>
    </button>
  );
}

function formatMoney(amount: number, currency = 'NGN'): string {
  const locale = currency === 'NGN' ? 'en-NG' : currency === 'GHS' ? 'en-GH' : 'en-US';
  return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 0 }).format(amount);
}
