'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { QRCodeCanvas } from 'qrcode.react';
import { useBusiness, useCapabilities } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import {
  formatCurrency,
  type CountryCode,
} from '@/lib/constants';
import { useCategoryConfig } from '@/hooks/useCategoryConfig';
import type { Recommendation } from '@/lib/intelligence/recommendations';
import { getCategoryByKey } from '@/lib/categoryConfig';
import { PayoutBanner } from '@/components/dashboard/PayoutBanner';
import { UpgradeBanner } from '@/components/dashboard/UpgradeBanner';
import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { AISetupCard } from '@/components/dashboard/AISetupCard';

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
  const [orderRevenue, setOrderRevenue] = useState(0);
  const [totalOrders, setTotalOrders] = useState(0);
  const [monthlyBookings, setMonthlyBookings] = useState(0);
  const [loading, setLoading] = useState(true);
  const [linkCopied, setLinkCopied] = useState(false);

  const { labels } = useCategoryConfig(business.category);
  const country = (business.country_code || 'NG') as CountryCode;
  const categoryTemplate = getCategoryByKey(business.category);

  const whatsappNumber = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_NG || process.env.NEXT_PUBLIC_GUPSHUP_WHATSAPP_NUMBER || '';
  const whatsappLink = business.bot_code
    ? `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(business.bot_code)}`
    : '';

  useEffect(() => {
    async function load() {
      const supabase = createClient();
      const today = new Date().toISOString().split('T')[0];
      const monthStart = today.slice(0, 7) + '-01'; // YYYY-MM-01

      const [totalRes, todayRes, pendingRes, revenueRes, recentRes, servicesRes, waConfigRes, monthlyRes, orderCountRes, orderRevenueRes, recentOrdersRes, completedRes, outstandingInvRes] = await Promise.all([
        supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('business_id', business.id),
        supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('business_id', business.id).eq('date', today),
        supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('business_id', business.id).eq('status', 'pending'),
        supabase.from('payments').select('amount').eq('status', 'success').in('booking_id',
          (await supabase.from('bookings').select('id').eq('business_id', business.id)).data?.map(b => b.id) || []
        ),
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
        supabase.from('orders').select('total_amount').eq('business_id', business.id).is('deleted_at', null).in('status', ['confirmed', 'processing', 'ready', 'shipped', 'delivered']),
        supabase.from('orders').select('id, reference_code, total_amount, status, created_at').eq('business_id', business.id).is('deleted_at', null).order('created_at', { ascending: false }).limit(5),
        // Completion rate
        supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('business_id', business.id).eq('status', 'completed'),
        // Outstanding invoices
        supabase.from('invoices').select('total_amount').eq('business_id', business.id).in('status', ['sent', 'viewed', 'overdue']),
      ]);

      const revenue = (revenueRes.data || []).reduce((sum, p) => sum + (p.amount || 0), 0);
      const hours = business.operating_hours as Record<string, unknown> | null;

      const outstandingInvoices = outstandingInvRes.data || [];
      setStats({
        totalBookings: totalRes.count || 0,
        todayBookings: todayRes.count || 0,
        pendingBookings: pendingRes.count || 0,
        completedBookings: completedRes.count || 0,
        totalRevenue: revenue,
        totalServices: servicesRes.count || 0,
        hasHours: !!hours && Object.keys(hours).length > 0,
        hasWhatsAppConfig: !!waConfigRes.data?.bot_greeting,
        outstandingInvoiceCount: outstandingInvoices.length,
        outstandingInvoiceAmount: outstandingInvoices.reduce((sum, inv) => sum + Number(inv.total_amount || 0), 0),
      });
      setRecent((recentRes.data || []) as RecentBooking[]);
      setTotalOrders(orderCountRes.count || 0);
      setOrderRevenue((orderRevenueRes.data || []).reduce((sum, o) => sum + (o.total_amount || 0), 0));
      setRecentOrders((recentOrdersRes.data || []) as RecentOrder[]);
      setMonthlyBookings(monthlyRes.count || 0);
      setLoading(false);

      // Load recommendations in background
      fetch('/api/dashboard/recommendations')
        .then(r => r.json())
        .then(data => setRecommendations(data.recommendations || []))
        .catch(() => {});
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
      desc: `Tell customers what you offer`,
      done: stats.totalServices > 0,
      href: '/dashboard/services',
      icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10',
    },
    {
      id: 'hours',
      title: 'Set operating hours',
      desc: 'Let customers know when you\'re open',
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
      desc: 'Start receiving customers',
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

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  const verificationLevel = (business as unknown as Record<string, unknown>).verification_level as string | undefined;

  return (
    <div>
      {/* AI setup assistant for new businesses */}
      <AISetupCard />

      {/* Onboarding checklist for new businesses */}
      <OnboardingChecklist />

      {/* Verification banner */}
      {(!verificationLevel || verificationLevel === 'unverified') && (
        <div className="mb-6 rounded-xl border border-yellow-200 bg-yellow-50 p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-yellow-100">
              <svg className="h-4 w-4 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-yellow-800">Verify your business to receive payouts</p>
              <p className="mt-0.5 text-xs text-yellow-700">
                Your business is currently unverified. Upload required documents to unlock payouts and higher limits.
              </p>
              <Link
                href="/dashboard/verification"
                className="mt-2 inline-flex items-center gap-1 rounded-lg bg-yellow-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-yellow-700 transition"
              >
                Verify Now
                <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Payout setup banner */}
      {(hasCapability('payment') || hasCapability('ordering') || hasCapability('ticketing') || hasCapability('crowdfunding')) && (
        <PayoutBanner />
      )}

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="mt-1 text-sm text-gray-500">
            Welcome back, {business.name} {categoryTemplate?.icon || ''}
          </p>
        </div>
        {whatsappLink && (
          <button
            onClick={copyLink}
            className="flex items-center gap-2 rounded-lg bg-whatsapp px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-green-600 transition"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
            </svg>
            {linkCopied ? 'Copied!' : 'Share WhatsApp Link'}
          </button>
        )}
      </div>

      {/* Upgrade nudge banner */}
      <UpgradeBanner
        currentBookings={monthlyBookings}
        tier={business.subscription_tier}
      />

      {/* Stats */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={`Total ${labels.entityNamePlural}`}
          value={stats.totalBookings}
          icon="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
          color="brand"
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

      {/* Setup Checklist + WhatsApp Card */}
      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        {/* Setup Checklist */}
        {!allComplete && (
          <div className="lg:col-span-2 rounded-xl border border-gray-100 bg-white p-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-gray-900">Get Started</h2>
                <p className="mt-0.5 text-sm text-gray-500">
                  Complete these steps to get the most out of your bot
                </p>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-2 w-24 rounded-full bg-gray-100 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-brand transition-all"
                    style={{ width: `${(completedSteps / setupSteps.length) * 100}%` }}
                  />
                </div>
                <span className="text-xs font-medium text-gray-500">
                  {completedSteps}/{setupSteps.length}
                </span>
              </div>
            </div>

            <div className="mt-5 space-y-2">
              {setupSteps.map((step) => (
                <Link
                  key={step.id}
                  href={step.href}
                  className={`flex items-center gap-4 rounded-lg px-4 py-3 transition ${
                    step.done
                      ? 'bg-green-50/50'
                      : 'bg-gray-50 hover:bg-brand-50/50'
                  }`}
                >
                  <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                    step.done ? 'bg-green-100' : 'bg-white border border-gray-200'
                  }`}>
                    {step.done ? (
                      <svg className="h-4 w-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg className="h-4 w-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={step.icon} />
                      </svg>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm font-medium ${step.done ? 'text-green-700' : 'text-gray-900'}`}>
                      {step.title}
                    </p>
                    <p className="text-xs text-gray-500">{step.desc}</p>
                  </div>
                  {!step.done && (
                    <svg className="h-4 w-4 shrink-0 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  )}
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* WhatsApp Link Card */}
        <div className={allComplete ? 'lg:col-span-2' : ''}>
          <div className="rounded-xl border border-gray-100 bg-gradient-to-br from-green-50 to-white p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-whatsapp/10">
                <svg className="h-5 w-5 text-whatsapp" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                </svg>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Your WhatsApp Bot</h3>
                <p className="text-xs text-gray-500">Share this link with your customers</p>
              </div>
            </div>

            {business.bot_code && (
              <div className="mt-4">
                <div className="flex items-center gap-2">
                  <code className="rounded-lg bg-white px-3 py-1.5 text-sm font-bold text-brand shadow-sm">
                    {business.bot_code}
                  </code>
                  <span className="text-xs text-gray-400">Bot Code</span>
                </div>
                {whatsappLink && (
                  <div className="mt-3 flex items-center gap-2">
                    <input
                      readOnly
                      value={whatsappLink}
                      className="flex-1 truncate rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600"
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

          {/* QR Code Card */}
          {whatsappLink && (
            <Link
              href="/dashboard/qr-code"
              className="mt-4 flex items-center gap-5 rounded-xl border border-gray-100 bg-white p-5 transition hover:border-brand/20 hover:shadow-sm"
            >
              <div className="shrink-0 rounded-lg border border-gray-100 bg-white p-2">
                <QRCodeCanvas value={whatsappLink} size={80} level="H" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-900">Your QR Code</p>
                <p className="mt-0.5 text-xs text-gray-500">
                  Customers scan this to reach you on WhatsApp instantly
                </p>
                <span className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-brand">
                  Download poster
                  <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </span>
              </div>
            </Link>
          )}

          {/* Quick Actions */}
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Link
              href="/dashboard/whatsapp"
              className="flex items-center gap-3 rounded-xl border border-gray-100 bg-white p-4 transition hover:border-brand/20 hover:shadow-sm"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50">
                <svg className="h-4 w-4 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900">Bot Settings</p>
                <p className="text-xs text-gray-400">Customize replies</p>
              </div>
            </Link>
            <Link
              href="/dashboard/broadcasts"
              className="flex items-center gap-3 rounded-xl border border-gray-100 bg-white p-4 transition hover:border-brand/20 hover:shadow-sm"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50">
                <svg className="h-4 w-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900">Broadcasts</p>
                <p className="text-xs text-gray-400">Message customers</p>
              </div>
            </Link>
          </div>
        </div>

        {/* Quick Stats Sidebar (when checklist is done) */}
        {allComplete && (
          <div className="space-y-4">
            <div className="rounded-xl border border-gray-100 bg-white p-5">
              <h3 className="text-sm font-semibold text-gray-900">Business Info</h3>
              <div className="mt-3 space-y-2.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Category</span>
                  <span className="font-medium text-gray-900">{categoryTemplate?.label}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Status</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    business.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                  }`}>
                    {business.status}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">{labels.serviceNamePlural || 'Services'}</span>
                  <span className="font-medium text-gray-900">{stats.totalServices}</span>
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
            <h2 className="text-base font-semibold text-gray-900">Recent Orders</h2>
            <Link
              href="/dashboard/orders"
              className="text-sm font-medium text-brand hover:text-brand-600"
            >
              View all
            </Link>
          </div>
          <div className="mt-4 overflow-x-auto rounded-xl border border-gray-100 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-50 bg-gray-50/50">
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Ref</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Date</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">Amount</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {recentOrders.map((o) => (
                  <tr key={o.id} className="hover:bg-gray-50/50">
                    <td className="px-4 py-3 font-mono text-xs text-gray-900">{o.reference_code}</td>
                    <td className="px-4 py-3 text-gray-600">
                      {new Date(o.created_at).toLocaleDateString('en-NG', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">{formatCurrency(o.total_amount, country)}</td>
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
          </div>
        </div>
      )}

      {/* Smart Recommendations */}
      {recommendations.length > 0 && (
        <div className="mt-8">
          <h2 className="text-base font-semibold text-gray-900">Recommended Actions</h2>
          <p className="mt-1 text-xs text-gray-500">AI-powered suggestions to grow your revenue</p>
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
                          <span className="text-xs font-medium text-gray-500">{rec.metric}</span>
                        )}
                      </div>
                      <p className="mt-1.5 text-sm font-semibold text-gray-900">{rec.title}</p>
                      <p className="mt-0.5 text-xs text-gray-600">{rec.description}</p>
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
          <h2 className="text-base font-semibold text-gray-900">
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
          <div className="mt-4 rounded-xl border border-dashed border-gray-200 p-8 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-gray-50">
              <svg className="h-6 w-6 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <p className="mt-3 text-sm text-gray-500">No {labels.entityNamePlural} yet</p>
            <p className="mt-1 text-xs text-gray-400">
              Share your WhatsApp link to start receiving {labels.entityNamePlural}
            </p>
          </div>
        ) : recent.length === 0 ? null : (
          <div className="mt-4 overflow-x-auto rounded-xl border border-gray-100 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-50 bg-gray-50/50">
                  <th className="px-4 py-3 text-left font-medium text-gray-500">{labels.personLabel}</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Date</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">{labels.quantityLabel}</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Ref</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {recent.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50/50">
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900">{r.guest_name || '\u2014'}</p>
                      <p className="text-xs text-gray-400">{r.guest_phone}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {new Date(r.date + 'T00:00').toLocaleDateString('en-NG', {
                        weekday: 'short',
                        day: 'numeric',
                        month: 'short',
                      })}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {labels.quantityLabel === 'amount'
                        ? formatCurrency(r.total_amount || r.deposit_amount || 0, country)
                        : r.party_size}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[r.status] || 'bg-gray-100 text-gray-600'}`}>
                        {r.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-400">{r.reference_code}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  color,
}: {
  label: string;
  value: number | string;
  icon: string;
  color: 'brand' | 'blue' | 'amber' | 'green';
}) {
  const colorMap = {
    brand: 'bg-brand-50 text-brand',
    blue: 'bg-blue-50 text-blue-600',
    amber: 'bg-amber-50 text-amber-600',
    green: 'bg-green-50 text-green-600',
  };

  return (
    <div className="rounded-xl border border-gray-100 bg-white p-5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-gray-500">{label}</p>
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${colorMap[color]}`}>
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={icon} />
          </svg>
        </div>
      </div>
      <p className="mt-3 text-2xl font-bold text-gray-900">{value}</p>
    </div>
  );
}
