'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { useDashboard, useCapabilities, useIsReseller } from './DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { APP_NAME } from '@/lib/constants';
import { useCategoryConfig } from '@/hooks/useCategoryConfig';
import { CAPABILITY_TIER_REQUIREMENTS, type CapabilityId } from '@/lib/capabilities/types';
import { ThemeToggle } from './ThemeToggle';
import { useChatUnreadCount } from '@/hooks/useChatUnreadCount';
import { useAlertUnreadCount } from '@/hooks/useAlertUnreadCount';
import { PAGE_TOOLTIPS } from '@/lib/tooltips';

interface NavItem {
  href: string;
  label: string;
  icon: string;
  /** Show only if ANY of these capabilities is enabled */
  capabilities?: CapabilityId[];
  section?: 'main' | 'manage' | 'money' | 'engage' | 'reseller' | 'settings';
  /** Hide for these business categories */
  hideForCategories?: string[];
}

// Categories where scheduling/commerce nav items aren't relevant
const GIVING_CATEGORIES = ['church', 'mosque', 'school', 'ngo', 'crowdfunding_org', 'government'];

const navItems: NavItem[] = [
  // ── MAIN: What every business sees ──
  {
    href: '/dashboard',
    label: 'Overview',
    icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
    section: 'main',
  },
  {
    href: '/dashboard/setup-assistant',
    label: 'Ace AI Setup',
    icon: 'M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z',
    section: 'main',
  },
  {
    href: '/dashboard/reservations',
    label: 'Bookings',
    icon: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
    capabilities: ['scheduling', 'appointment', 'reservation', 'table_reservation'],
    section: 'main',
  },
  {
    href: '/dashboard/calendar',
    label: 'Calendar',
    icon: 'M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5',
    capabilities: ['scheduling', 'appointment', 'reservation', 'table_reservation'],
    hideForCategories: GIVING_CATEGORIES,
    section: 'main',
  },
  {
    href: '/dashboard/customers',
    label: 'Users',
    icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
    section: 'main',
  },
  {
    href: '/dashboard/chat',
    label: 'Chat',
    icon: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
    capabilities: ['chat'],
    section: 'main',
  },

  // ── MANAGE: Set up what you sell ──
  {
    href: '/dashboard/appointments-management',
    label: 'Appointments',
    icon: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
    capabilities: ['appointment'],
    section: 'manage',
  },
  {
    href: '/dashboard/services',
    label: 'Services',
    icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10',
    capabilities: ['scheduling'],
    section: 'manage',
  },
  {
    href: '/dashboard/products',
    label: 'Products',
    icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
    capabilities: ['ordering'],
    section: 'manage',
  },
  {
    href: '/dashboard/properties',
    label: 'Properties',
    icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
    capabilities: ['reservation'],
    section: 'manage',
  },
  {
    href: '/dashboard/events',
    label: 'Events',
    icon: 'M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z',
    capabilities: ['ticketing'],
    section: 'manage',
  },
  {
    href: '/dashboard/giving',
    label: 'Donation Options',
    icon: 'M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z',
    capabilities: ['giving'],
    section: 'manage',
  },
  {
    href: '/dashboard/campaigns',
    label: 'Campaigns',
    icon: 'M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z',
    capabilities: ['crowdfunding'],
    section: 'manage',
  },
  {
    href: '/dashboard/staff',
    label: 'Staff',
    icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z',
    capabilities: ['staff'],
    section: 'manage',
  },
  {
    href: '/dashboard/locations',
    label: 'Locations',
    icon: 'M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z',
    capabilities: ['multi_location'],
    section: 'manage',
  },
  {
    href: '/dashboard/promo-codes',
    label: 'Promo Codes',
    icon: 'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z',
    capabilities: ['ordering', 'scheduling', 'ticketing'],
    hideForCategories: GIVING_CATEGORIES,
    section: 'manage',
  },

  {
    href: '/dashboard/queue',
    label: 'Queue',
    icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
    capabilities: ['queue'],
    section: 'manage',
  },
  {
    href: '/dashboard/attendance',
    label: 'Attendance',
    icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
    section: 'manage',
  },
  {
    href: '/dashboard/waitlist',
    label: 'Waitlist',
    icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01',
    capabilities: ['waitlist'],
    section: 'manage',
  },
  {
    href: '/dashboard/reports',
    label: 'Documents',
    icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    capabilities: ['reports'],
    section: 'manage',
  },
  {
    href: '/dashboard/contracts',
    label: 'E-Signatures',
    icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    capabilities: ['whatsapp_sign'],
    section: 'manage',
  },
  {
    href: '/dashboard/waivers',
    label: 'Waivers',
    icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    capabilities: ['waiver'],
    section: 'manage',
  },

  // ── MONEY: Payments, orders, invoices ──
  {
    href: '/dashboard/orders',
    label: 'Orders',
    icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2',
    capabilities: ['ordering'],
    section: 'money',
  },
  {
    href: '/dashboard/tickets',
    label: 'Tickets',
    icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
    capabilities: ['ticketing'],
    section: 'money',
  },
  {
    href: '/dashboard/recurring',
    label: 'Subscriptions',
    icon: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
    capabilities: ['recurring'],
    section: 'money',
  },
  {
    href: '/dashboard/invoices',
    label: 'Invoices',
    icon: 'M9 14l2 2 4-4m5 4.5V7a2 2 0 00-2-2H6a2 2 0 00-2 2v12.5l3.5-2 3.5 2 3.5-2 3.5 2z',
    capabilities: ['invoice'],
    section: 'money',
  },
  {
    href: '/dashboard/payment-request',
    label: 'Request Payment',
    icon: 'M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z',
    capabilities: ['payment'],
    section: 'money',
  },
  {
    href: '/dashboard/scan-to-pay',
    label: 'Scan to Pay',
    icon: 'M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 013.75 9.375v-4.5zM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5zM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0113.5 9.375v-4.5z',
    capabilities: ['payment'],
    section: 'money',
  },
  {
    href: '/dashboard/orders/quotes',
    label: 'Quotes',
    icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    capabilities: ['estimates'],
    section: 'money',
  },
  {
    href: '/dashboard/packages',
    label: 'Packages',
    icon: 'M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z',
    capabilities: ['packages'],
    section: 'money',
  },
  {
    href: '/dashboard/financials',
    label: 'Revenue',
    icon: 'M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z',
    capabilities: ['payment', 'ordering', 'ticketing', 'crowdfunding', 'giving'],
    section: 'money',
  },
  {
    href: '/dashboard/payouts',
    label: 'Payouts',
    icon: 'M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z',
    capabilities: ['payment', 'ordering', 'ticketing', 'crowdfunding', 'giving'],
    section: 'money',
  },
  {
    href: '/dashboard/payments/pending',
    label: 'Pending Transfers',
    icon: 'M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4',
    capabilities: ['payment', 'ordering', 'ticketing', 'giving'],
    section: 'money',
  },
  {
    href: '/dashboard/billing',
    label: 'Billing',
    icon: 'M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z',
    section: 'money',
  },

  // ── ENGAGE: Grow your business ──
  {
    href: '/dashboard/broadcasts',
    label: 'Broadcasts',
    icon: 'M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z',
    capabilities: ['broadcast'],
    section: 'engage',
  },
  {
    href: '/dashboard/keyword-campaigns',
    label: 'Keyword Campaigns',
    icon: 'M7 20l4-16m2 16l4-16M6 9h14M4 15h14',
    capabilities: ['broadcast'],
    section: 'engage',
  },
  {
    href: '/dashboard/feedback',
    label: 'Reviews',
    icon: 'M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z',
    capabilities: ['feedback'],
    section: 'engage',
  },
  {
    href: '/dashboard/loyalty',
    label: 'Loyalty',
    icon: 'M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z',
    capabilities: ['loyalty'],
    section: 'engage',
  },
  {
    href: '/dashboard/membership',
    label: 'Membership',
    icon: 'M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z',
    capabilities: ['loyalty', 'membership'],
    section: 'engage',
  },
  {
    href: '/dashboard/referrals',
    label: 'Referrals',
    icon: 'M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z',
    capabilities: ['referral'],
    section: 'engage',
  },
  {
    href: '/dashboard/parties',
    label: 'Parties',
    icon: 'M21 15.546c-.523 0-1.046.151-1.5.454a2.704 2.704 0 01-3 0 2.704 2.704 0 00-3 0 2.704 2.704 0 01-3 0 2.704 2.704 0 00-3 0 2.704 2.704 0 01-3 0A1.75 1.75 0 003 15.546V12a9 9 0 0118 0v3.546zM12 3v2m6.364 1.636l-1.414 1.414M21 12h-2M5 12H3m3.05-4.95L4.636 5.636',
    capabilities: ['ticketing'],
    section: 'engage',
  },
  {
    href: '/dashboard/forms',
    label: 'Surveys & Forms',
    icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01',
    capabilities: ['survey'],
    section: 'engage',
  },
  {
    href: '/dashboard/polls',
    label: 'Polls',
    icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
    capabilities: ['poll'],
    section: 'engage',
  },
  {
    href: '/dashboard/analytics',
    label: 'Analytics',
    icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
    section: 'engage',
  },
  {
    href: '/dashboard/analytics/dropoffs',
    label: 'Flow Analytics',
    icon: 'M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12',
    section: 'engage',
  },
  {
    href: '/dashboard/qr-code',
    label: 'QR Code & Link',
    icon: 'M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 013.75 9.375v-4.5zM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5zM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5zM13.5 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5z',
    section: 'engage',
  },

  // ── RESELLER: Manage sub-accounts (only visible to resellers) ──
  {
    href: '/dashboard/reseller',
    label: 'Portfolio',
    icon: 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4',
    section: 'reseller',
  },
  {
    href: '/dashboard/reseller/accounts',
    label: 'Accounts',
    icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z',
    section: 'reseller',
  },
  {
    href: '/dashboard/reseller/branding',
    label: 'Branding',
    icon: 'M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01',
    section: 'reseller',
  },
  {
    href: '/dashboard/reseller/billing',
    label: 'Billing & Commission',
    icon: 'M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z',
    section: 'reseller',
  },
  {
    href: '/dashboard/reseller/payouts',
    label: 'Payouts',
    icon: 'M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z',
    section: 'reseller',
  },
  {
    href: '/dashboard/reseller/subscription',
    label: 'Subscription',
    icon: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
    section: 'reseller',
  },
  {
    href: '/dashboard/reseller/analytics',
    label: 'Analytics',
    icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
    section: 'reseller',
  },

  // ── SETTINGS: Configure your business ──
  {
    href: '/dashboard/alerts',
    label: 'Alerts',
    icon: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
    section: 'settings',
  },
  {
    href: '/dashboard/settings',
    label: 'Settings',
    icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
    section: 'settings',
  },
  {
    href: '/dashboard/whatsapp',
    label: 'WhatsApp Setup',
    icon: 'M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z',
    section: 'settings',
  },
  {
    href: '/dashboard/faq',
    label: 'Auto-Replies',
    icon: 'M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    section: 'settings',
  },
  {
    href: '/dashboard/capabilities',
    label: 'Add Features',
    icon: 'M13 10V3L4 14h7v7l9-11h-7z',
    section: 'settings',
  },
  {
    href: '/dashboard/team',
    label: 'Team',
    icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z',
    section: 'settings',
  },
  {
    href: '/dashboard/help',
    label: 'Help',
    icon: 'M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    section: 'settings',
  },
];

const sectionLabels: Record<string, string> = {
  manage: 'Your Business',
  money: 'Money',
  engage: 'Grow',
  reseller: 'Reseller',
  settings: 'Settings',
};

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { business, allBusinesses, switchingBusiness, switchBusiness } = useDashboard();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);

  const { capabilities } = useCapabilities();
  const isReseller = useIsReseller();
  const hasMultipleBusinesses = allBusinesses.length > 1;

  // Lock body scroll when mobile sidebar is open
  useEffect(() => {
    if (mobileOpen) {
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      document.documentElement.style.setProperty('--scrollbar-width', `${scrollbarWidth}px`);
      document.body.classList.add('menu-open');
    } else {
      document.body.classList.remove('menu-open');
      document.documentElement.style.removeProperty('--scrollbar-width');
    }
    return () => {
      document.body.classList.remove('menu-open');
      document.documentElement.style.removeProperty('--scrollbar-width');
    };
  }, [mobileOpen]);

  // Close mobile sidebar on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Close switcher on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setSwitcherOpen(false);
      }
    }
    if (switcherOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [switcherOpen]);
  const chatUnreadCount = useChatUnreadCount(business.id);
  const alertUnreadCount = useAlertUnreadCount();
  const { labels: catLabels } = useCategoryConfig(business.category);
  const categoryLabel = catLabels?.entityName || 'business';

  const isEventsCategory = business.category === 'events';

  const [showMore, setShowMore] = useState(false);

  // Core items that are always "essential" (no capability requirement needed)
  const CORE_HREFS = new Set([
    '/dashboard',
    '/dashboard/setup-assistant',
    '/dashboard/calendar',
    '/dashboard/chat',
    '/dashboard/customers',
  ]);
  // Events category also treats Parties as essential
  if (isEventsCategory) {
    CORE_HREFS.add('/dashboard/parties');
  }

  // Separate nav items into essential (visible) and "more" (collapsed)
  const essentialItems: NavItem[] = [];
  const moreItems: NavItem[] = [];

  for (const item of navItems) {
    // Hide by category
    if (item.hideForCategories?.includes(business.category)) continue;

    // Reseller section: only show if user is a reseller
    if (item.section === 'reseller') {
      if (isReseller) essentialItems.push(item);
      continue;
    }

    // Settings and main section items are always essential
    if (item.section === 'main' || item.section === 'settings') {
      // Main section items with capabilities still need the capability check
      if (item.capabilities) {
        const hasCapability = item.capabilities.some(cap => capabilities.includes(cap));
        if (hasCapability) {
          essentialItems.push(item);
        } else {
          moreItems.push(item);
        }
      } else {
        essentialItems.push(item);
      }
      continue;
    }

    // Core items (no capability requirement) are always essential
    if (CORE_HREFS.has(item.href) && !item.capabilities) {
      essentialItems.push(item);
      continue;
    }

    // Items with capabilities: essential if capability is enabled, otherwise "more"
    if (item.capabilities) {
      const hasCapability = item.capabilities.some(cap => capabilities.includes(cap));
      if (hasCapability) {
        essentialItems.push(item);
      } else {
        moreItems.push(item);
      }
      continue;
    }

    // No capability requirement and not in core set — essential
    essentialItems.push(item);
  }

  // Split moreItems into "available on current tier" vs "requires upgrade"
  const tierRank: Record<string, number> = { free: 0, growth: 1, business: 2 };
  const currentTierRank = tierRank[business.subscription_tier || 'free'] ?? 0;

  const availableToAdd: NavItem[] = [];
  const requiresUpgrade: NavItem[] = [];

  for (const item of moreItems) {
    if (!item.capabilities || item.capabilities.length === 0) {
      availableToAdd.push(item);
      continue;
    }
    // Check if ANY of the item's capabilities are available on the current tier
    const canActivate = item.capabilities.some(cap => {
      const requiredTier = CAPABILITY_TIER_REQUIREMENTS[cap];
      return requiredTier ? tierRank[requiredTier] <= currentTierRank : true;
    });
    if (canActivate) {
      availableToAdd.push(item);
    } else {
      requiresUpgrade.push(item);
    }
  }

  // Group essential items by section — for events category, promote Parties to 'main'
  const sections = new Map<string, typeof navItems>();
  for (const item of essentialItems) {
    let section = item.section || 'main';
    // Events businesses see Parties in 'main' (after Overview and Ace AI Setup)
    if (isEventsCategory && item.href === '/dashboard/parties') {
      section = 'main';
    }
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section)!.push(item);
  }

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  const isActive = (href: string) => {
    if (href === '/dashboard') return pathname === '/dashboard';
    if (pathname === href) return true;
    // Only match sub-paths if no other nav item is a more specific match
    if (pathname.startsWith(href + '/')) {
      const hasMoreSpecific = navItems.some(
        item => item.href !== href && item.href.startsWith(href + '/') && pathname.startsWith(item.href)
      );
      return !hasMoreSpecific;
    }
    return false;
  };

  // Dynamic label: "Bookings" → category-specific label
  const getLabel = (item: NavItem) => {
    if (item.label === 'Bookings') {
      if (catLabels) {
        const renamed = catLabels.entityNamePlural.charAt(0).toUpperCase() + catLabels.entityNamePlural.slice(1);
        if (['Orders', 'Payments', 'Appointments', 'Reservations', 'Stays'].includes(renamed)) return 'Bookings';
        return renamed;
      }
    }
    if (item.label === 'Appointments') {
      if (catLabels?.appointmentNamePlural) return catLabels.appointmentNamePlural;
    }
    if (item.label === 'Properties') {
      if (catLabels?.propertyNamePlural) return catLabels.propertyNamePlural;
    }
    if (item.label === 'Services') {
      if (catLabels?.serviceNamePlural) {
        const renamed = catLabels.serviceNamePlural;
        // Don't rename to "Appointments" if there's already an Appointments item
        if (renamed === 'Appointments' && capabilities.includes('appointment')) return 'Services';
        return renamed;
      }
    }
    // Always keep "Customers" — don't rename to "Members" etc as it's confusing
    // if (item.label === 'Customers') {
    //   if (catLabels?.personLabelPlural) return catLabels.personLabelPlural;
    // }
    return item.label;
  };

  const navContent = (
    <>
      {/* Logo */}
      <div className="flex items-center gap-2 px-4 py-5">
        <Image src="/logo.png" alt="Waaiio" width={120} height={32} className="h-8 w-auto" />
      </div>

      {/* Business switcher */}
      <div className="relative mx-4 mb-4" ref={switcherRef}>
        <button
          type="button"
          onClick={() => hasMultipleBusinesses && setSwitcherOpen(!switcherOpen)}
          className={`w-full rounded-lg bg-brand-50 dark:bg-brand-950/30 px-3 py-2 text-left transition ${
            hasMultipleBusinesses ? 'cursor-pointer hover:bg-brand-100 dark:hover:bg-brand-950/50' : 'cursor-default'
          }`}
          aria-expanded={switcherOpen}
          aria-haspopup={hasMultipleBusinesses ? 'listbox' : undefined}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-brand-400 capitalize">{categoryLabel}</p>
              <p className="truncate text-sm font-semibold text-brand">{business.name}</p>
            </div>
            {hasMultipleBusinesses && (
              <svg
                className={`h-4 w-4 flex-shrink-0 text-brand-400 transition-transform ${switcherOpen ? 'rotate-180' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            )}
          </div>
        </button>

        {/* Dropdown */}
        {switcherOpen && hasMultipleBusinesses && (
          <div
            role="listbox"
            aria-label="Switch business"
            className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg"
          >
            {allBusinesses.map((biz) => {
              const isSelected = biz.id === business.id;
              return (
                <button
                  key={biz.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={switchingBusiness}
                  onClick={() => {
                    switchBusiness(biz.id);
                    setSwitcherOpen(false);
                    setMobileOpen(false);
                  }}
                  className={`flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition ${
                    isSelected
                      ? 'bg-brand-50 dark:bg-brand-950/30 text-brand font-semibold'
                      : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                  } ${switchingBusiness ? 'opacity-50' : ''}`}
                >
                  {biz.logo_url ? (
                    <Image
                      src={biz.logo_url}
                      alt=""
                      width={24}
                      height={24}
                      className="h-6 w-6 rounded-full object-cover flex-shrink-0"
                    />
                  ) : (
                    <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-brand-100 dark:bg-brand-900 text-xs font-bold text-brand">
                      {biz.name.charAt(0).toUpperCase()}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{biz.name}</p>
                    <p className="truncate text-xs text-gray-400 capitalize">{biz.category.replace(/_/g, ' ')}</p>
                  </div>
                  {isSelected && (
                    <svg className="h-4 w-4 flex-shrink-0 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              );
            })}
            {/* Add new business link */}
            <Link
              href="/get-started"
              onClick={() => { setSwitcherOpen(false); setMobileOpen(false); }}
              className="flex items-center gap-3 border-t border-gray-100 dark:border-gray-700 px-3 py-2.5 text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-200 transition"
            >
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-dashed border-gray-300 dark:border-gray-600 text-gray-400">
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
              </span>
              <span>Add New Business</span>
            </Link>
          </div>
        )}
      </div>

      {/* Nav links grouped by section */}
      <nav className="flex-1 overflow-y-auto px-3">
        {Array.from(sections.entries()).map(([section, items], idx) => (
          <div key={section}>
            {section !== 'main' && (
              <p className={`${idx > 0 ? 'mt-5' : ''} mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400`}>
                {section === 'manage' && isEventsCategory ? 'Your Events' : (sectionLabels[section] || section)}
              </p>
            )}
            <div className="space-y-0.5">
              {items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  title={PAGE_TOOLTIPS[item.href.split('/dashboard/')[1] || 'overview'] || ''}
                  className={`flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium transition ${
                    isActive(item.href)
                      ? 'bg-brand text-white'
                      : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
                  }`}
                >
                  <svg
                    className="h-5 w-5 flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d={item.icon}
                    />
                  </svg>
                  <span className="flex-1">{getLabel(item)}</span>
                  {item.label === 'Chat' && chatUnreadCount > 0 && !isActive(item.href) && (
                    <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">
                      {chatUnreadCount > 99 ? '99+' : chatUnreadCount}
                    </span>
                  )}
                  {item.label === 'Alerts' && alertUnreadCount > 0 && !isActive(item.href) && (
                    <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">
                      {alertUnreadCount > 99 ? '99+' : alertUnreadCount}
                    </span>
                  )}
                </Link>
              ))}
            </div>
          </div>
        ))}

        {/* More Features — split by tier availability */}
        {(availableToAdd.length > 0 || requiresUpgrade.length > 0) && (
          <div className="mt-4">
            <button
              onClick={() => setShowMore(!showMore)}
              className="flex w-full items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400"
            >
              <span>Add Features</span>
              <svg
                className={`h-4 w-4 transition ${showMore ? 'rotate-180' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {showMore && (
              <div className="space-y-0.5">
                {availableToAdd.length > 0 && (
                  <p className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-green-500">Available to Add</p>
                )}
                {availableToAdd.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    title={PAGE_TOOLTIPS[item.href.split('/dashboard/')[1] || 'overview'] || ''}
                    className={`flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium transition ${
                      isActive(item.href)
                        ? 'bg-brand text-white'
                        : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
                    }`}
                  >
                    <svg
                      className="h-5 w-5 flex-shrink-0"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d={item.icon}
                      />
                    </svg>
                    <span className="flex-1">{getLabel(item)}</span>
                  </Link>
                ))}
                {requiresUpgrade.length > 0 && (
                  <>
                    <p className="px-3 pt-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-amber-500">Upgrade to Unlock</p>
                    {requiresUpgrade.map((item) => (
                      <Link
                        key={item.href}
                        href="/dashboard/billing"
                        onClick={() => setMobileOpen(false)}
                        title={`Upgrade to unlock ${item.label}`}
                        className="flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
                      >
                        <svg className="h-5 w-5 flex-shrink-0 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={item.icon} />
                        </svg>
                        <span className="flex-1">{getLabel(item)}</span>
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">PRO</span>
                      </Link>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </nav>

      {/* Bottom actions */}
      <div className="border-t border-gray-200 dark:border-gray-700 px-3 py-3 space-y-0.5">
        <ThemeToggle />
        <Link
          href="/"
          className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-gray-500 dark:text-gray-400 transition hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100"
        >
          <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back to Website
        </Link>
        <button
          onClick={handleLogout}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-gray-500 dark:text-gray-400 transition hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100"
        >
          <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
          Sign Out
        </button>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile top bar with hamburger */}
      <div className="fixed left-0 right-0 top-0 z-40 flex h-14 items-center border-b border-gray-200 bg-white/95 px-4 backdrop-blur-sm dark:border-gray-700 dark:bg-gray-900/95 md:hidden">
        <button
          onClick={() => setMobileOpen(true)}
          className="rounded-lg p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
          aria-label="Open menu"
        >
          <svg aria-hidden="true" className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <span className="ml-2 truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
          {business.name}
        </span>
      </div>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation menu">
          <div className="absolute inset-0 bg-black/50" aria-hidden="true" onClick={() => setMobileOpen(false)} />
          <div className="absolute left-0 top-0 bottom-0 w-72 bg-white dark:bg-gray-900 shadow-xl flex flex-col">
            <button
              onClick={() => setMobileOpen(false)}
              className="absolute right-3 top-3 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-600"
              aria-label="Close menu"
            >
              <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            {navContent}
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden md:fixed md:inset-y-0 md:left-0 md:flex md:w-64 md:flex-col md:border-r md:border-gray-200 dark:md:border-gray-700 md:bg-white dark:md:bg-gray-900 md:z-30">
        {navContent}
      </aside>
    </>
  );
}
