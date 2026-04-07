import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { supabase } from '@/lib/supabase';
import { Building2, DollarSign, Clock, Users, LifeBuoy, Bot, CalendarDays, AlertTriangle, ShieldAlert, BadgeCheck, Flag } from 'lucide-react';
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

  useEffect(() => {
    async function loadStats() {
      try {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

        const [bizRes, feesRes, payoutsRes, heldRes, usersRes, ticketsRes, botRes, bookingsRes, unverifiedRes, pendingDocsRes, flaggedRes] = await Promise.all([
          supabase.from('businesses').select('*', { count: 'exact', head: true }).eq('status', 'active'),
          supabase.from('platform_fees').select('fee_total').gte('created_at', monthStart).eq('waived', false),
          supabase.from('business_payouts').select('net_amount, status').eq('status', 'pending'),
          supabase.from('business_payouts').select('id', { count: 'exact', head: true }).eq('status', 'held'),
          supabase.from('profiles').select('*', { count: 'exact', head: true }),
          supabase.from('support_tickets').select('*', { count: 'exact', head: true }).in('status', ['open', 'in_progress', 'waiting']),
          supabase.from('bot_sessions').select('*', { count: 'exact', head: true }).eq('status', 'active'),
          supabase.from('bookings').select('*', { count: 'exact', head: true }).gte('created_at', monthStart),
          // Alerts data
          supabase.from('businesses').select('id', { count: 'exact', head: true }).eq('verification_level', 'unverified').eq('status', 'active'),
          supabase.from('business_documents').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
          supabase.from('business_payouts').select('id', { count: 'exact', head: true }).neq('flags', '[]'),
        ]);

        const monthlyFees = (feesRes.data || []).reduce((s, f) => s + Number(f.fee_total || 0), 0);
        const pendingTotal = (payoutsRes.data || []).reduce((s, p) => s + Number(p.net_amount || 0), 0);
        const pendingCount = payoutsRes.data?.length || 0;
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
            value: formatMoney(monthlyFees),
            icon: DollarSign,
            color: 'green',
          },
          {
            label: 'Pending Payouts',
            value: `${pendingCount} (${formatMoney(pendingTotal)})`,
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
