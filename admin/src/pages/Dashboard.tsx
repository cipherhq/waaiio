import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { supabase, adminDb } from '@/lib/supabase';
import { Building2, DollarSign, Clock, Users, LifeBuoy, Bot, CalendarDays, AlertTriangle, ShieldAlert, BadgeCheck, Flag, Zap, CreditCard, BrainCircuit, Bell } from 'lucide-react';
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

  useEffect(() => {
    async function loadStats() {
      try {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

        const { adminQuery } = await import('@/lib/adminQuery');
        const [bizRes, feesRes, payoutsRes, heldRes, usersRes, ticketsRes, botRes, bookingsRes, unverifiedRes, pendingDocsRes, flaggedRes, overridesRes] = await Promise.all([
          adminQuery('businesses', { select: 'id', filters: [{ column: 'status', op: 'eq', value: 'active' }], count: 'exact' }),
          adminQuery('platform_fees', { select: 'fee_total, business_id', filters: [{ column: 'created_at', op: 'gte', value: monthStart }, { column: 'waived', op: 'eq', value: false }] }),
          adminQuery('business_payouts', { select: 'net_amount, status', filters: [{ column: 'status', op: 'eq', value: 'pending' }] }),
          adminQuery('business_payouts', { select: 'id', filters: [{ column: 'status', op: 'eq', value: 'held' }], count: 'exact' }),
          adminQuery('profiles', { select: 'id', count: 'exact' }),
          adminQuery('support_tickets', { select: 'id', filters: [{ column: 'status', op: 'in', value: ['open', 'in_progress', 'waiting'] }], count: 'exact' }),
          adminQuery('bot_sessions', { select: 'id', filters: [{ column: 'is_active', op: 'eq', value: true }], count: 'exact' }),
          adminQuery('bookings', { select: 'id', filters: [{ column: 'created_at', op: 'gte', value: monthStart }], count: 'exact' }),
          adminQuery('businesses', { select: 'id', filters: [{ column: 'verification_level', op: 'eq', value: 'unverified' }, { column: 'status', op: 'eq', value: 'active' }], count: 'exact' }),
          adminQuery('business_documents', { select: 'id', filters: [{ column: 'status', op: 'eq', value: 'pending' }], count: 'exact' }),
          adminQuery('business_payouts', { select: 'id', filters: [{ column: 'flags', op: 'neq', value: '[]' }], count: 'exact' }),
          adminQuery('capability_overrides', { select: 'business_id' }),
        ]);

        // Group fees by currency via business country
        const feesBizIds = [...new Set((feesRes.data || []).map(f => f.business_id).filter(Boolean))];
        const feeBizRes = feesBizIds.length > 0
          ? await adminQuery('businesses', { select: 'id, country_code', filters: [{ column: 'id', op: 'in', value: feesBizIds }] })
          : { data: [] };
        const feeBizData = feeBizRes.data || [];
        const feeBizCountry = new Map((feeBizData || []).map(b => [b.id, b.country_code || 'NG']));
        const countryToCur: Record<string, string> = { US: 'USD', CA: 'CAD', GB: 'GBP', NG: 'NGN', GH: 'GHS' };

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

        // Group payouts by currency
        const payoutByCurrency: Record<string, number> = {};
        for (const p of payoutsRes.data || []) {
          payoutByCurrency['NGN'] = (payoutByCurrency['NGN'] || 0) + Number(p.net_amount || 0); // payouts don't have currency yet
        }
        const pendingCount = payoutsRes.data?.length || 0;
        const pendingDisplay = pendingCount > 0
          ? `${pendingCount} (${Object.entries(payoutByCurrency).filter(([, a]) => a > 0).map(([cur, amt]) => formatMoney(amt, cur)).join(' · ')})`
          : '0';
        const heldCount = heldRes.count || 0;

        setPendingPayouts(pendingCount);
        setHeldPayouts(heldCount);

        setStats([
          {
            label: 'Total Businesses',
            value: String(bizRes.count || 0),
            icon: Building2,
            color: 'blue',
          },
          {
            label: 'Monthly Revenue',
            value: revenueDisplay,
            icon: DollarSign,
            color: 'green',
          },
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
        const [paymentsSuccessRes, paymentsFailedRes, llmRes, recentAlertsRes] = await Promise.all([
          adminQuery('payments', { select: 'id', filters: [{ column: 'status', op: 'eq', value: 'success' }, { column: 'created_at', op: 'gte', value: monthStart }], count: 'exact' }),
          adminQuery('payments', { select: 'id', filters: [{ column: 'status', op: 'eq', value: 'failed' }, { column: 'created_at', op: 'gte', value: monthStart }], count: 'exact' }),
          adminQuery('llm_classifications', { select: 'confidence, llm_used', filters: [{ column: 'created_at', op: 'gte', value: monthStart }], limit: 500 }),
          adminQuery('alerts', { select: 'id, severity, title, business_id, created_at', order: { column: 'created_at', ascending: false }, limit: 5 }),
        ]);

        setPaymentSuccessCount(paymentsSuccessRes.count || 0);
        setPaymentFailedCount(paymentsFailedRes.count || 0);

        const llmData = llmRes.data || [];
        setLlmTotal(llmData.length);
        setLlmUsedCount(llmData.filter((r: Record<string, unknown>) => r.llm_used).length);
        const confidences = llmData.filter((r: Record<string, unknown>) => (r.confidence as number) > 0).map((r: Record<string, unknown>) => r.confidence as number);
        setLlmAvgConfidence(confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0);

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
