'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { QRCodeCanvas } from 'qrcode.react';
import { useBusiness, useCapabilities } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import {
  formatCurrency,
  getLocale,
  TIER_TRANSACTION_LIMITS,
  type CountryCode,
} from '@/lib/constants';
import { useCategoryConfig } from '@/hooks/useCategoryConfig';
import type { Recommendation } from '@/lib/intelligence/recommendations';
import { getCategoryByKey } from '@/lib/categoryConfig';
import { PayoutBanner } from '@/components/dashboard/PayoutBanner';
import { UpgradeBanner } from '@/components/dashboard/UpgradeBanner';
import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { AISetupCard } from '@/components/dashboard/AISetupCard';
import { ResponsiveTable } from '@/components/dashboard/ResponsiveTable';
import type { CapabilityId } from '@/lib/capabilities/types';

interface Stats {
  totalBookings: number;
  todayBookings: number;
  pendingBookings: number;
  completedBookings: number;
  totalRevenue: number;
  totalServices: number;
  hasHours: boolean;
  hasWhatsAppConfig: boolean;
  outstandingInvoiceCount: number;
  outstandingInvoiceAmount: number;
}

interface RecentBooking {
  id: string;
  reference_code: string;
  guest_name: string | null;
  guest_phone: string | null;
  date: string;
  time: string;
  party_size: number;
  total_amount: number;
  deposit_amount: number;
  status: string;
  created_at: string;
}

interface RecentOrder {
  id: string;
  reference_code: string;
  total_amount: number;
  status: string;
  created_at: string;
}

export default function DashboardOverview() {
  const business = useBusiness();
  const { hasCapability } = useCapabilities();
  const [stats, setStats] = useState<Stats>({
    totalBookings: 0, todayBookings: 0, pendingBookings: 0, completedBookings: 0,
    totalRevenue: 0, totalServices: 0, hasHours: false, hasWhatsAppConfig: false,
    outstandingInvoiceCount: 0, outstandingInvoiceAmount: 0,
  });
  const [recent, setRecent] = useState<RecentBooking[]>([]);
  const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [showPayoutBanner, setShowPayoutBanner] = useState(false);
  const [orderRevenue, setOrderRevenue] = useState(0);
  const [totalOrders, setTotalOrders] = useState(0);
  const [monthlyBookings, setMonthlyBookings] = useState(0);
  const [monthlyOrders, setMonthlyOrders] = useState(0);
  const [webBookings, setWebBookings] = useState(0);
  const [loading, setLoading] = useState(true);
  const [linkCopied, setLinkCopied] = useState(false);
  const [bookingLinkCopied, setBookingLinkCopied] = useState(false);
  const [deletionScheduled, setDeletionScheduled] = useState<string | null>(null);
  const [cancellingDeletion, setCancellingDeletion] = useState(false);

  const { labels } = useCategoryConfig(business.category);
  const country = (business.country_code || 'NG') as CountryCode;
  const categoryTemplate = getCategoryByKey(business.category);

  const [whatsappLink, setWhatsappLink] = useState('');
  const [whatsappDisplayNumber, setWhatsappDisplayNumber] = useState('');

  // Load the correct WhatsApp number for this business (parallel queries, priority pick)
  useEffect(() => {
    async function loadWhatsAppLink() {
      const supabase = createClient();
      const channelId = business.assigned_channel_id || business.whatsapp_channel_id;

      // Fire all 3 queries in parallel instead of sequential waterfall
      const [assignedResult, dedicatedResult, sharedResult] = await Promise.all([
        channelId
          ? supabase.from('whatsapp_channels').select('phone_number').eq('id', channelId).maybeSingle()
          : Promise.resolve({ data: null }),
        supabase.from('whatsapp_channels').select('phone_number')
          .eq('business_id', business.id).eq('channel_type', 'dedicated').eq('is_active', true).maybeSingle(),
        supabase.from('whatsapp_channels').select('phone_number')
          .eq('channel_type', 'shared').eq('is_active', true).limit(1).maybeSingle(),
      ]);

      // Priority: assigned > dedicated > shared
      const phone = assignedResult.data?.phone_number
        || dedicatedResult.data?.phone_number
        || sharedResult.data?.phone_number;

      const num = phone?.replace(/[^0-9]/g, '') || '';
      setWhatsappDisplayNumber(num);

      // Shared channels need bot code prefix
      const isShared = !assignedResult.data?.phone_number && !dedicatedResult.data?.phone_number;
      setWhatsappLink(isShared && business.bot_code
        ? `https://wa.me/${num}?text=${encodeURIComponent(business.bot_code)}`
        : `https://wa.me/${num}`);
    }
    loadWhatsAppLink();
  }, [business.id]);

  // Check if account deletion is scheduled (grace period)
  useEffect(() => {
    async function checkDeletion() {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: profile } = await supabase
        .from('profiles')
        .select('metadata')
        .eq('id', user.id)
        .maybeSingle();
      const meta = (profile?.metadata || {}) as Record<string, unknown>;
      if (meta.deletion_scheduled && meta.deletion_date) {
        setDeletionScheduled(meta.deletion_date as string);
      }
    }
    checkDeletion();
  }, []);

  useEffect(() => {
    async function load() {
      try {
      const supabase = createClient();
      const today = new Date().toISOString().split('T')[0];
      const monthStart = today.slice(0, 7) + '-01'; // YYYY-MM-01

      const [totalRes, todayRes, pendingRes, revenueRes, recentRes, servicesRes, waConfigRes, monthlyRes, orderCountRes, orderRevenueRes, recentOrdersRes, completedRes, outstandingInvRes, outstandingInvCountRes, webBookingsRes, monthlyOrdersRes] = await Promise.all([
        supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('business_id', business.id),
        supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('business_id', business.id).eq('date', today),
        supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('business_id', business.id).eq('status', 'pending'),
        // Server-side SUM via RPC — avoids fetching thousands of rows to the client
        supabase.rpc('get_business_revenue', { p_business_id: business.id }),
        supabase.from('bookings')
          .select('id, reference_code, guest_name, guest_phone, date, time, party_size, total_amount, deposit_amount, status, created_at')
          .eq('business_id', business.id)
          .order('created_at', { ascending: false })
          .limit(5),
        supabase.from('services').select('id', { count: 'exact', head: true }).eq('business_id', business.id),
        supabase.from('whatsapp_config').select('bot_greeting').eq('business_id', business.id).maybeSingle(),
        supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('business_id', business.id).gte('created_at', monthStart),
        // Order queries
        supabase.from('orders').select('id', { count: 'exact', head: true }).eq('business_id', business.id).is('deleted_at', null),
        // Server-side SUM via RPC — avoids fetching all order rows to the client
        supabase.rpc('get_order_revenue', { p_business_id: business.id }),
        supabase.from('orders').select('id, reference_code, total_amount, status, created_at').eq('business_id', business.id).is('deleted_at', null).order('created_at', { ascending: false }).limit(5),
        // Completion rate
        supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('business_id', business.id).eq('status', 'completed'),
        // Server-side SUM via RPC — avoids fetching all invoice rows to the client
        supabase.rpc('get_outstanding_invoices', { p_business_id: business.id }),
        // Outstanding invoice count (moved into Promise.all — was sequential before)
        supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('business_id', business.id).in('status', ['sent', 'viewed', 'overdue']),
        supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('business_id', business.id).eq('channel', 'web'),
        // Monthly orders for tier usage
        supabase.from('orders').select('id', { count: 'exact', head: true }).eq('business_id', business.id).is('deleted_at', null).gte('created_at', monthStart),
      ]);

      const revenue = Number(revenueRes.data ?? 0);
      const hours = business.operating_hours as Record<string, unknown> | null;
      const outstandingInvoiceAmount = Number(outstandingInvRes.data ?? 0);
      const outstandingInvoiceCount = outstandingInvCountRes.count || 0;

      setStats({
        totalBookings: totalRes.count || 0,
        todayBookings: todayRes.count || 0,
        pendingBookings: pendingRes.count || 0,
        completedBookings: completedRes.count || 0,
        totalRevenue: revenue,
        totalServices: servicesRes.count || 0,
        hasHours: !!hours && Object.keys(hours).length > 0,
        hasWhatsAppConfig: !!waConfigRes.data?.bot_greeting,
        outstandingInvoiceCount: outstandingInvoiceCount || 0,
        outstandingInvoiceAmount,
      });
      setRecent((recentRes.data || []) as RecentBooking[]);
      setTotalOrders(orderCountRes.count || 0);
      setOrderRevenue(Number(orderRevenueRes.data ?? 0));
      setRecentOrders((recentOrdersRes.data || []) as RecentOrder[]);
      setMonthlyBookings(monthlyRes.count || 0);
      setMonthlyOrders(monthlyOrdersRes.count || 0);
      setWebBookings(webBookingsRes.count || 0);
      setLoading(false);

      // Check if business has a payout account — show banner if revenue exists but no payout setup
      if (revenue > 0) {
        supabase.from('payout_accounts').select('id', { count: 'exact', head: true })
          .eq('business_id', business.id).eq('is_active', true)
          .then(({ count }) => {
            if ((count || 0) === 0) setShowPayoutBanner(true);
          });
      }

      // Load recommendations in background
      fetch('/api/dashboard/recommendations')
        .then(r => r.json())
        .then(data => setRecommendations(data.recommendations || []))
        .catch(() => {});
      } catch (err) {
        console.error('[DASHBOARD] Load error:', err);
        setLoading(false); // Show page even if data fetch fails
      }
    }
    load();
  }, [business.id]);

  function copyLink() {
    navigator.clipboard.writeText(whatsappLink);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }

  // Setup checklist items
  const setupSteps = [
    {
      id: 'services',
      title: `Add your ${(labels.serviceNamePlural || 'Services').toLowerCase()}`,
      desc: `Tell users what you offer`,
      done: stats.totalServices > 0,
      href: '/dashboard/services',
      icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10',
    },
    {
      id: 'hours',
      title: 'Set operating hours',
      desc: 'Let users know when you\'re available',
      done: stats.hasHours,
      href: '/dashboard/settings',
      icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
    },
    {
      id: 'bot',
      title: 'Customize your bot',
      desc: 'Personalize the greeting message',
      done: stats.hasWhatsAppConfig,
      href: '/dashboard/whatsapp',
      icon: 'M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z',
    },
    {
      id: 'share',
      title: 'Share your WhatsApp link',
      desc: 'Go live',
      done: stats.totalBookings > 0,
      href: '/dashboard/whatsapp',
      icon: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1',
    },
  ];

  const completedSteps = setupSteps.filter(s => s.done).length;
  const allComplete = completedSteps === setupSteps.length;

  const statusColors: Record<string, string> = {
    confirmed: 'bg-green-100 text-green-800',
    pending: 'bg-yellow-100 text-yellow-800',
    seated: 'bg-blue-100 text-blue-800',
    in_progress: 'bg-blue-100 text-blue-800',
    completed: 'bg-gray-100 text-gray-700',
    cancelled: 'bg-red-100 text-red-700',
    no_show: 'bg-red-100 text-red-700',
  };

  async function cancelDeletion() {
    setCancellingDeletion(true);
    try {
      const res = await fetch('/api/account', { method: 'PATCH' });
      if (res.ok) {
        setDeletionScheduled(null);
        window.location.reload();
      }
    } catch {
      // silently fail — user can retry
    } finally {
      setCancellingDeletion(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  const verificationLevel = business.verification_level;

  return (
    <div>
      {/* Scheduled deletion banner */}
      {deletionScheduled && (
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-red-200 bg-red-50 px-5 py-4 relative z-10">
          <div className="flex items-center gap-3">
            <svg aria-hidden="true" className="h-6 w-6 text-red-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="text-sm font-semibold text-red-900">
                Your account is scheduled for deletion on {new Date(deletionScheduled).toLocaleDateString()}.
              </p>
              <p className="text-xs text-red-700">All your data will be permanently removed after this date.</p>
            </div>
          </div>
          <button
            onClick={cancelDeletion}
            disabled={cancellingDeletion}
            className="shrink-0 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition disabled:opacity-50"
          >
            {cancellingDeletion ? 'Cancelling...' : 'Cancel Deletion'}
          </button>
        </div>
      )}

      {/* Incomplete setup banner */}
      {business.status === 'pending' && (
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-orange-200 bg-orange-50 px-5 py-4 relative z-10">
          <div className="flex items-center gap-3">
            <svg aria-hidden="true" className="h-6 w-6 text-orange-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="text-sm font-semibold text-orange-900">Your business setup is incomplete.</p>
              <p className="text-xs text-orange-700">Complete setup to go live.</p>
            </div>
          </div>
          <Link
            href="/get-started"
            className="shrink-0 rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 transition"
          >
            Complete Setup
          </Link>
        </div>
      )}

      {/* Pending payout banner */}
      {showPayoutBanner && (
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 relative z-10">
          <div className="flex items-center gap-3">
            <span className="text-2xl">💰</span>
            <div>
              <p className="text-sm font-semibold text-amber-900">You have pending earnings!</p>
              <p className="text-xs text-amber-700">Set up your payout account to start receiving payments.</p>
            </div>
          </div>
          <a href="/dashboard/payouts" className="shrink-0 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 transition">
            Set Up Payouts
          </a>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-6 relative z-0">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Dashboard</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Welcome back, {business.name} {categoryTemplate?.icon || ''}
          </p>
        </div>
        {whatsappLink && (
          <button
            onClick={copyLink}
            className="flex items-center gap-2 rounded-lg bg-whatsapp px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-green-600 transition"
          >
            <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
            </svg>
            {linkCopied ? 'Copied!' : 'Share WhatsApp Link'}
          </button>
        )}
      </div>

      {/* Onboarding checklist (dismissible) */}
      <OnboardingChecklist />

      {/* Compact banners — inline, not full-width blocks */}
      <div className="space-y-2 mb-6">
        <AISetupCard />

        {(!verificationLevel || verificationLevel === 'unverified') && (
          <div className="flex items-center gap-3 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3">
            <svg aria-hidden="true" className="h-4 w-4 text-yellow-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-xs text-yellow-700 flex-1">
              <span className="font-semibold">Verify your business</span> to unlock payouts and higher limits.
            </p>
            <Link
              href="/dashboard/verification"
              className="shrink-0 rounded-lg bg-yellow-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-yellow-700 transition"
            >
              Verify Now
            </Link>
          </div>
        )}
      </div>

      {/* Payout setup banner */}
      {(hasCapability('payment') || hasCapability('ordering') || hasCapability('ticketing') || hasCapability('crowdfunding')) && (
        <PayoutBanner />
      )}

      {/* Upgrade nudge banner */}
      <UpgradeBanner
        currentBookings={monthlyBookings}
        tier={business.subscription_tier}
      />

      {/* Stats */}
      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label={`Total ${labels.entityNamePlural}`}
          value={stats.totalBookings}
          icon="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
          color="brand"
          sub={webBookings > 0 ? `${webBookings} from web` : undefined}
        />
        {totalOrders > 0 && (
          <StatCard
            label="Total Orders"
            value={totalOrders}
            icon="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
            color="blue"
          />
        )}
        <StatCard
          label={`Today's ${labels.entityNamePlural}`}
          value={stats.todayBookings}
          icon="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
          color="blue"
        />
        <StatCard
          label={`Pending ${labels.entityNamePlural}`}
          value={stats.pendingBookings}
          icon="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
          color="amber"
        />
        {/* Separate revenue cards when business has both ordering and payment */}
        {hasCapability('ordering') && orderRevenue > 0 && (
          <StatCard
            label="Order Revenue"
            value={formatCurrency(orderRevenue, country)}
            icon="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
            color="green"
          />
        )}
        {(hasCapability('payment') || hasCapability('ticketing') || hasCapability('crowdfunding')) && (
          <StatCard
            label={hasCapability('ordering') && orderRevenue > 0
              ? (labels.quantityLabel === 'amount' ? 'Giving Revenue' : `${labels.entityNamePlural.charAt(0).toUpperCase() + labels.entityNamePlural.slice(1)} Revenue`)
              : 'Revenue'}
            value={formatCurrency(stats.totalRevenue, country)}
            icon="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            color="green"
          />
        )}
        {hasCapability('ordering') && !hasCapability('payment') && !hasCapability('ticketing') && !hasCapability('crowdfunding') && (
          <StatCard
            label="Revenue"
            value={formatCurrency(orderRevenue, country)}
            icon="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            color="green"
          />
        )}
        {hasCapability('scheduling') && !hasCapability('payment') && !hasCapability('ordering') && !hasCapability('ticketing') && !hasCapability('crowdfunding') && (
          <StatCard
            label={labels.serviceNamePlural || 'Services'}
            value={stats.totalServices}
            icon="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
            color="green"
          />
        )}
        {stats.outstandingInvoiceCount > 0 && (
          <StatCard
            label="Outstanding Invoices"
            value={`${stats.outstandingInvoiceCount} (${formatCurrency(stats.outstandingInvoiceAmount, country)})`}
            icon="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            color="amber"
          />
        )}
        {stats.totalBookings > 0 && (
          <StatCard
            label="Completion Rate"
            value={`${(stats.completedBookings / stats.totalBookings * 100).toFixed(0)}%`}
            icon="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
            color="green"
          />
        )}
      </div>

      {/* Tier Usage Indicators — show for free/growth tiers */}
      {(business.subscription_tier === 'free' || business.subscription_tier === 'growth') && (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <UsageBar
            label={`${labels.entityNamePlural} this month`}
            current={monthlyBookings}
            limit={TIER_TRANSACTION_LIMITS[business.subscription_tier]?.bookings ?? 50}
          />
          {hasCapability('ordering') && (
            <UsageBar
              label="Orders this month"
              current={monthlyOrders}
              limit={TIER_TRANSACTION_LIMITS[business.subscription_tier]?.orders ?? 50}
            />
          )}
        </div>
      )}

      {/* WhatsApp Link Card */}
      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        <div className={allComplete ? "lg:col-span-2" : "lg:col-span-3"}>
          <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-gradient-to-br from-green-50 to-white dark:from-green-900/20 dark:to-gray-800 p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-whatsapp/10">
                <svg aria-hidden="true" className="h-5 w-5 text-whatsapp" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                </svg>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Your WhatsApp Bot</h3>
                <p className="text-xs text-gray-500 dark:text-gray-400">Share this link with your users</p>
              </div>
            </div>

            {business.bot_code && (
              <div className="mt-4">
                <div className="flex items-center gap-2">
                  <code className="rounded-lg bg-white dark:bg-gray-700 px-3 py-1.5 text-sm font-bold text-brand shadow-sm">
                    {business.bot_code}
                  </code>
                  <span className="text-xs text-gray-400 dark:text-gray-500">Bot Code</span>
                </div>
                {whatsappLink && (
                  <div className="mt-3 flex items-center gap-2">
                    <input
                      readOnly
                      value={whatsappLink}
                      className="flex-1 truncate rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-xs text-gray-600 dark:text-gray-300"
                    />
                    <button
                      onClick={copyLink}
                      className="shrink-0 rounded-lg bg-whatsapp px-3 py-2 text-xs font-semibold text-white hover:bg-green-600 transition"
                    >
                      {linkCopied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Web Booking Link Card */}
          {business.slug && (
            <div className="mt-4 rounded-xl border border-gray-100 dark:border-gray-700 bg-gradient-to-br from-brand-50/50 to-white dark:from-brand-900/20 dark:to-gray-800 p-5">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand/10">
                  <svg aria-hidden="true" className="h-5 w-5 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Web Booking Page</h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Customers can book directly from this link</p>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <input
                  readOnly
                  value={`${typeof window !== 'undefined' ? window.location.origin : 'https://www.waaiio.com'}/b/${business.slug}`}
                  className="flex-1 truncate rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-xs text-gray-600 dark:text-gray-300"
                />
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(`${window.location.origin}/b/${business.slug}`);
                    setBookingLinkCopied(true);
                    setTimeout(() => setBookingLinkCopied(false), 2000);
                  }}
                  className="shrink-0 rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white hover:bg-brand-600 transition"
                >
                  {bookingLinkCopied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
          )}

          {/* QR Code Card */}
          {whatsappLink && (
            <Link
              href="/dashboard/qr-code"
              className="mt-4 flex items-center gap-5 rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 transition hover:border-brand/20 hover:shadow-sm"
            >
              <div className="shrink-0 rounded-lg border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-2">
                <QRCodeCanvas value={whatsappLink} size={80} level="H" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Your QR Code</p>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  Customers scan this to reach you on WhatsApp instantly
                </p>
                <span className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-brand">
                  Download poster
                  <svg aria-hidden="true" className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </span>
              </div>
            </Link>
          )}

          {/* Quick Actions — dynamic based on capabilities */}
          <QuickActions business={business} hasCapability={hasCapability} />
        </div>

        {/* Quick Stats Sidebar (when checklist is done) */}
        {allComplete && (
          <div className="space-y-4">
            <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Business Info</h3>
              <div className="mt-3 space-y-2.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500 dark:text-gray-400">Category</span>
                  <span className="font-medium text-gray-900 dark:text-gray-100">{categoryTemplate?.label}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500 dark:text-gray-400">Status</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    business.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                  }`}>
                    {business.status}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500 dark:text-gray-400">{labels.serviceNamePlural || 'Services'}</span>
                  <span className="font-medium text-gray-900 dark:text-gray-100">{stats.totalServices}</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Recent Orders */}
      {recentOrders.length > 0 && (
        <div className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Recent Orders</h2>
            <Link
              href="/dashboard/orders"
              className="text-sm font-medium text-brand hover:text-brand-600"
            >
              View all
            </Link>
          </div>
          <ResponsiveTable className="mt-4 rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-50 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/50">
                  <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Ref</th>
                  <th scope="col" className="hidden sm:table-cell px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Date</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium text-gray-500 dark:text-gray-400">Amount</th>
                  <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700">
                {recentOrders.map((o) => (
                  <tr key={o.id} className="hover:bg-gray-50/50 dark:hover:bg-gray-700/30">
                    <td className="px-4 py-3 font-mono text-xs text-gray-900 dark:text-gray-100 break-all">{o.reference_code}</td>
                    <td className="hidden sm:table-cell px-4 py-3 text-gray-600 dark:text-gray-400">
                      {new Date(o.created_at).toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900 dark:text-gray-100">{formatCurrency(o.total_amount, country)}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        o.status === 'delivered' ? 'bg-green-100 text-green-800' :
                        o.status === 'shipped' ? 'bg-blue-100 text-blue-800' :
                        o.status === 'processing' || o.status === 'ready' ? 'bg-blue-100 text-blue-800' :
                        o.status === 'confirmed' ? 'bg-green-100 text-green-800' :
                        o.status === 'cancelled' ? 'bg-red-100 text-red-700' :
                        'bg-gray-100 text-gray-600'
                      }`}>
                        {o.status.replace('_', ' ')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ResponsiveTable>
        </div>
      )}

      {/* Smart Recommendations */}
      {recommendations.length > 0 && (
        <div className="mt-8">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Recommended Actions</h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">AI-powered suggestions to grow your revenue</p>
          <div className="mt-3 space-y-3">
            {recommendations.slice(0, 4).map(rec => {
              const impactColors = {
                high: 'border-red-200 bg-red-50',
                medium: 'border-yellow-200 bg-yellow-50',
                low: 'border-blue-200 bg-blue-50',
              };
              const impactBadge = {
                high: 'bg-red-100 text-red-700',
                medium: 'bg-yellow-100 text-yellow-700',
                low: 'bg-blue-100 text-blue-700',
              };
              return (
                <div key={rec.id} className={`rounded-xl border p-4 ${impactColors[rec.impact]}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${impactBadge[rec.impact]}`}>
                          {rec.impact} impact
                        </span>
                        {rec.metric && (
                          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{rec.metric}</span>
                        )}
                      </div>
                      <p className="mt-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">{rec.title}</p>
                      <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">{rec.description}</p>
                    </div>
                    {rec.actionPath && rec.actionLabel && (
                      <Link
                        href={rec.actionPath}
                        className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 transition"
                      >
                        {rec.actionLabel}
                      </Link>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recent Bookings */}
      <div className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Recent {labels.entityNamePlural}
          </h2>
          {recent.length > 0 && (
            <Link
              href="/dashboard/reservations"
              className="text-sm font-medium text-brand hover:text-brand-600"
            >
              View all
            </Link>
          )}
        </div>

        {recent.length === 0 && recentOrders.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-gray-200 dark:border-gray-700 p-8 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-gray-50 dark:bg-gray-800/50">
              <svg aria-hidden="true" className="h-6 w-6 text-gray-300 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">No {labels.entityNamePlural} yet</p>
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              Share your WhatsApp link to start receiving {labels.entityNamePlural}
            </p>
          </div>
        ) : recent.length === 0 ? null : (
          <ResponsiveTable className="mt-4 rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-50 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/50">
                  <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">{labels.personLabel}</th>
                  <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Date</th>
                  <th scope="col" className="hidden sm:table-cell px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">{labels.quantityLabel}</th>
                  <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Status</th>
                  <th scope="col" className="hidden md:table-cell px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Ref</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700">
                {recent.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50/50 dark:hover:bg-gray-700/30">
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900 dark:text-gray-100">{r.guest_name || '\u2014'}</p>
                      <p className="text-xs text-gray-400 dark:text-gray-500 break-all">{r.guest_phone}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                      {new Date(r.date + 'T00:00').toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), {
                        weekday: 'short',
                        day: 'numeric',
                        month: 'short',
                      })}
                    </td>
                    <td className="hidden sm:table-cell px-4 py-3 text-gray-600 dark:text-gray-400">
                      {labels.quantityLabel === 'amount'
                        ? formatCurrency(r.total_amount || r.deposit_amount || 0, country)
                        : r.party_size}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[r.status] || 'bg-gray-100 text-gray-600'}`}>
                        {r.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="hidden md:table-cell px-4 py-3 font-mono text-xs text-gray-400 dark:text-gray-500 break-all">{r.reference_code}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ResponsiveTable>
        )}
      </div>
    </div>
  );
}

interface QuickAction {
  title: string;
  description: string;
  href: string;
  icon: string;
  bgColor: string;
  iconColor: string;
}

function QuickActions({
  business,
  hasCapability,
}: {
  business: { category: string; capabilities: CapabilityId[] };
  hasCapability: (cap: CapabilityId) => boolean;
}) {
  const actions: QuickAction[] = [];

  if (hasCapability('ticketing')) {
    actions.push({
      title: 'Create Event',
      description: 'Set up a new event with tickets',
      href: '/dashboard/events',
      icon: 'M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z',
      bgColor: 'bg-brand-50 dark:bg-brand-950/30',
      iconColor: 'text-brand',
    });
  }

  if (business.category === 'events' || business.capabilities.includes('ticketing')) {
    actions.push({
      title: 'Create Party',
      description: 'Plan and manage a party',
      href: '/dashboard/parties',
      icon: 'M21 15.546c-.523 0-1.046.151-1.5.454a2.704 2.704 0 01-3 0 2.704 2.704 0 00-3 0 2.704 2.704 0 01-3 0 2.704 2.704 0 00-3 0 2.704 2.704 0 01-3 0A1.75 1.75 0 003 15.546V12a9 9 0 0118 0v3.546zM12 3v2m6.364 1.636l-1.414 1.414M21 12h-2M5 12H3m3.05-4.95L4.636 5.636',
      bgColor: 'bg-pink-50 dark:bg-pink-950/30',
      iconColor: 'text-pink-600',
    });
  }

  if (hasCapability('giving') || hasCapability('crowdfunding')) {
    actions.push({
      title: 'Set Up Giving',
      description: hasCapability('crowdfunding') ? 'Launch a campaign' : 'Configure donation options',
      href: hasCapability('crowdfunding') ? '/dashboard/campaigns' : '/dashboard/giving',
      icon: 'M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z',
      bgColor: 'bg-red-50 dark:bg-red-950/30',
      iconColor: 'text-red-500',
    });
  }

  if (hasCapability('broadcast')) {
    actions.push({
      title: 'Send Broadcast',
      description: 'Send a message to all users',
      href: '/dashboard/broadcasts',
      icon: 'M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z',
      bgColor: 'bg-blue-50 dark:bg-blue-950/30',
      iconColor: 'text-blue-600',
    });
  }

  if (hasCapability('ordering')) {
    actions.push({
      title: 'Add Products',
      description: 'Add items users can order',
      href: '/dashboard/products',
      icon: 'M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z',
      bgColor: 'bg-amber-50 dark:bg-amber-950/30',
      iconColor: 'text-amber-600',
    });
  }

  if (hasCapability('scheduling') || hasCapability('appointment')) {
    actions.push({
      title: 'Add Services',
      description: 'Define what you offer and availability',
      href: '/dashboard/services',
      icon: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
      bgColor: 'bg-green-50 dark:bg-green-950/30',
      iconColor: 'text-green-600',
    });
  }

  // Max 6 cards
  const visibleActions = actions.slice(0, 6);

  if (visibleActions.length === 0) return null;

  return (
    <div className="mt-6">
      <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Quick Actions</h3>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visibleActions.map((action) => (
          <Link
            key={action.href}
            href={action.href}
            className="flex items-center gap-3 rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 transition hover:border-brand/20 hover:shadow-sm"
          >
            <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${action.bgColor}`}>
              <svg aria-hidden="true" className={`h-4 w-4 ${action.iconColor}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={action.icon} />
              </svg>
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{action.title}</p>
              <p className="text-xs text-gray-400 dark:text-gray-500 truncate">{action.description}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  color,
  sub,
}: {
  label: string;
  value: number | string;
  icon: string;
  color: 'brand' | 'blue' | 'amber' | 'green';
  sub?: string;
}) {
  const colorMap = {
    brand: 'bg-brand-50 text-brand',
    blue: 'bg-blue-50 text-blue-600',
    amber: 'bg-amber-50 text-amber-600',
    green: 'bg-green-50 text-green-600',
  };

  return (
    <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</p>
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${colorMap[color]}`}>
          <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={icon} />
          </svg>
        </div>
      </div>
      <p className="mt-3 text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
      {sub && <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">{sub}</p>}
    </div>
  );
}

function UsageBar({
  label,
  current,
  limit,
}: {
  label: string;
  current: number;
  limit: number;
}) {
  if (limit <= 0) return null;
  const ratio = Math.min(current / limit, 1.2);
  const percent = Math.min(ratio * 100, 100);

  let barColor = 'bg-brand';
  let textColor = 'text-gray-600 dark:text-gray-400';
  if (ratio >= 1) {
    barColor = 'bg-red-500';
    textColor = 'text-red-600';
  } else if (ratio >= 0.8) {
    barColor = 'bg-amber-500';
    textColor = 'text-amber-600';
  }

  return (
    <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</p>
        <p className={`text-xs font-semibold ${textColor}`}>
          {current}/{limit}
        </p>
      </div>
      <div className="h-2 w-full rounded-full bg-gray-100 dark:bg-gray-700">
        <div
          className={`h-2 rounded-full ${barColor} transition-all`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {ratio >= 1 && (
        <p className="mt-1.5 text-[10px] text-red-500">
          Limit reached. <a href="/dashboard/settings" className="underline font-semibold">Upgrade</a> for more.
        </p>
      )}
    </div>
  );
}
