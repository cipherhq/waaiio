'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useBusiness, useCapabilities } from './DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { APP_NAME } from '@/lib/constants';
import { useCategoryConfig } from '@/hooks/useCategoryConfig';
import type { CapabilityId } from '@/lib/capabilities/types';
import { useChatUnreadCount } from '@/hooks/useChatUnreadCount';

interface NavItem {
  href: string;
  label: string;
  icon: string;
  /** Show only if ANY of these capabilities is enabled */
  capabilities?: CapabilityId[];
  /** @deprecated Use capabilities instead. Kept for backward compat. */
  flowTypes?: string[];
  section?: 'main' | 'commerce' | 'marketing' | 'settings';
  /** Hide for these business categories */
  hideForCategories?: string[];
}

// Categories where scheduling/commerce nav items aren't relevant
const GIVING_CATEGORIES = ['church', 'mosque', 'school', 'ngo', 'crowdfunding_org', 'government'];

const navItems: NavItem[] = [
  // Main
  {
    href: '/dashboard',
    label: 'Overview',
    icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
    section: 'main',
  },
  {
    href: '/dashboard/reservations',
    label: 'Bookings',
    icon: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
    capabilities: ['scheduling'],
    section: 'main',
  },
  {
    href: '/dashboard/calendar',
    label: 'Calendar',
    icon: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
    capabilities: ['scheduling'],
    hideForCategories: GIVING_CATEGORIES,
    section: 'main',
  },
  {
    href: '/dashboard/services',
    label: 'Services',
    icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10',
    capabilities: ['scheduling', 'payment'],
    section: 'main',
  },
  {
    href: '/dashboard/customers',
    label: 'Customers',
    icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
    section: 'main',
  },
  // Commerce
  {
    href: '/dashboard/products',
    label: 'Products',
    icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
    capabilities: ['ordering'],
    section: 'commerce',
  },
  {
    href: '/dashboard/orders',
    label: 'Orders',
    icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2',
    capabilities: ['ordering'],
    section: 'commerce',
  },
  {
    href: '/dashboard/orders/quotes',
    label: 'Quotes',
    icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    capabilities: ['ordering'],
    section: 'commerce',
  },
  {
    href: '/dashboard/events',
    label: 'Events',
    icon: 'M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z',
    capabilities: ['ticketing'],
    section: 'commerce',
  },
  {
    href: '/dashboard/tickets',
    label: 'Tickets',
    icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
    capabilities: ['ticketing'],
    section: 'commerce',
  },
  {
    href: '/dashboard/campaigns',
    label: 'Campaigns',
    icon: 'M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z',
    capabilities: ['crowdfunding'],
    section: 'commerce',
  },
  {
    href: '/dashboard/reports',
    label: 'Reports',
    icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    capabilities: ['reports'],
    section: 'commerce',
  },
  {
    href: '/dashboard/contracts',
    label: 'Waaiio Sign',
    icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    capabilities: ['whatsapp_sign'],
    section: 'commerce',
  },
  {
    href: '/dashboard/invoices',
    label: 'Invoices',
    icon: 'M9 14l2 2 4-4m5 4.5V7a2 2 0 00-2-2H6a2 2 0 00-2 2v12.5l3.5-2 3.5 2 3.5-2 3.5 2z',
    capabilities: ['invoice'],
    section: 'commerce',
  },
  {
    href: '/dashboard/queue',
    label: 'Queue',
    icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
    capabilities: ['queue'],
    section: 'commerce',
  },
  {
    href: '/dashboard/feedback',
    label: 'Reviews',
    icon: 'M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z',
    capabilities: ['feedback'],
    section: 'commerce',
  },
  {
    href: '/dashboard/loyalty',
    label: 'Loyalty',
    icon: 'M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z',
    capabilities: ['loyalty'],
    section: 'commerce',
  },
  {
    href: '/dashboard/chat',
    label: 'Chat',
    icon: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
    capabilities: ['chat'],
    section: 'commerce',
  },
  {
    href: '/dashboard/waitlist',
    label: 'Waitlist',
    icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01',
    capabilities: ['waitlist'],
    section: 'commerce',
  },
  {
    href: '/dashboard/payouts',
    label: 'Payouts',
    icon: 'M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z',
    capabilities: ['payment', 'ordering', 'ticketing', 'crowdfunding'],
    section: 'commerce',
  },
  {
    href: '/dashboard/financials',
    label: 'Financials',
    icon: 'M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z',
    capabilities: ['payment', 'ordering', 'ticketing', 'crowdfunding'],
    section: 'commerce',
  },
  {
    href: '/dashboard/promo-codes',
    label: 'Promo Codes',
    icon: 'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z',
    capabilities: ['ordering', 'scheduling', 'ticketing'],
    hideForCategories: GIVING_CATEGORIES,
    section: 'commerce',
  },
  // Marketing
  {
    href: '/dashboard/keywords',
    label: 'Keywords',
    icon: 'M7 20l4-16m2 16l4-16M6 9h14M4 15h14',
    section: 'marketing',
  },
  {
    href: '/dashboard/sequences',
    label: 'Sequences',
    icon: 'M13 10V3L4 14h7v7l9-11h-7z',
    section: 'marketing',
  },
  {
    href: '/dashboard/rules',
    label: 'Rules',
    icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
    section: 'marketing',
  },
  {
    href: '/dashboard/referrals',
    label: 'Referrals',
    icon: 'M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z',
    capabilities: ['referral'],
    section: 'marketing',
  },
  {
    href: '/dashboard/broadcasts',
    label: 'Broadcasts',
    icon: 'M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z',
    section: 'marketing',
  },
  {
    href: '/dashboard/analytics',
    label: 'Analytics',
    icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
    section: 'marketing',
  },
  {
    href: '/dashboard/insights',
    label: 'Insights',
    icon: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z',
    section: 'marketing',
  },
  // Settings
  {
    href: '/dashboard/locations',
    label: 'Locations',
    icon: 'M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z M15 11a3 3 0 11-6 0 3 3 0 016 0z',
    section: 'settings',
  },
  {
    href: '/dashboard/integrations',
    label: 'Integrations',
    icon: 'M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z',
    section: 'settings',
  },
  {
    href: '/dashboard/faq',
    label: 'FAQ Bot',
    icon: 'M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    section: 'settings',
  },
  {
    href: '/dashboard/whatsapp',
    label: 'WhatsApp Bot',
    icon: 'M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z',
    section: 'settings',
  },
  {
    href: '/dashboard/flow-editor',
    label: 'Bot Flows',
    icon: 'M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z',
    section: 'settings',
  },
  {
    href: '/dashboard/qr-code',
    label: 'QR Code & Link',
    icon: 'M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 013.75 9.375v-4.5zM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5zM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5zM13.5 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5z',
    section: 'marketing',
  },
  {
    href: '/dashboard/pages',
    label: 'Pages',
    icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    section: 'settings',
  },
  {
    href: '/dashboard/support',
    label: 'Support',
    icon: 'M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5 0a4 4 0 11-8 0 4 4 0 018 0z',
    section: 'settings',
  },
  {
    href: '/dashboard/notifications',
    label: 'Notifications',
    icon: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
    section: 'settings',
  },
  {
    href: '/dashboard/staff',
    label: 'Staff',
    icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z',
    capabilities: ['staff'],
    section: 'main',
  },
  {
    href: '/dashboard/capabilities',
    label: 'Capabilities',
    icon: 'M13 10V3L4 14h7v7l9-11h-7z',
    section: 'settings',
  },
  {
    href: '/dashboard/settings',
    label: 'Settings',
    icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
    section: 'settings',
  },
];

const sectionLabels: Record<string, string> = {
  commerce: 'Commerce',
  marketing: 'Marketing',
  settings: 'Settings',
};

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const business = useBusiness();
  const [mobileOpen, setMobileOpen] = useState(false);

  const { capabilities } = useCapabilities();
  const chatUnreadCount = useChatUnreadCount(business.id);
  const { labels: catLabels } = useCategoryConfig(business.category);
  const categoryLabel = catLabels?.entityName || 'business';

  // Filter nav items based on capabilities and category
  const visibleItems = navItems.filter(item => {
    // Hide if this item is excluded for the business category
    if (item.hideForCategories?.includes(business.category)) return false;
    if (!item.capabilities) return true;
    // Show if ANY required capability is enabled
    return item.capabilities.some(cap => capabilities.includes(cap));
  });

  // Group by section
  const sections = new Map<string, typeof navItems>();
  for (const item of visibleItems) {
    const section = item.section || 'main';
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
        // Don't relabel to "Orders" when the commerce Orders page is also visible
        if (renamed === 'Orders') return 'Bookings';
        return renamed;
      }
    }
    if (item.label === 'Guests') {
      if (catLabels) return catLabels.personLabelPlural;
    }
    if (item.label === 'Services') {
      if (catLabels?.serviceNamePlural) return catLabels.serviceNamePlural;
    }
    if (item.label === 'Customers') {
      if (catLabels?.personLabelPlural) return catLabels.personLabelPlural;
    }
    return item.label;
  };

  const navContent = (
    <>
      {/* Logo */}
      <div className="flex items-center gap-2 px-4 py-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="Waaiio" className="h-8" />
      </div>

      {/* Business name */}
      <div className="mx-4 mb-4 rounded-lg bg-brand-50 px-3 py-2">
        <p className="text-xs font-medium text-brand-400 capitalize">{categoryLabel}</p>
        <p className="truncate text-sm font-semibold text-brand">{business.name}</p>
      </div>

      {/* Nav links grouped by section */}
      <nav className="flex-1 overflow-y-auto px-3">
        {Array.from(sections.entries()).map(([section, items], idx) => (
          <div key={section}>
            {section !== 'main' && (
              <p className={`${idx > 0 ? 'mt-5' : ''} mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-gray-400`}>
                {sectionLabels[section] || section}
              </p>
            )}
            <div className="space-y-0.5">
              {items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                    isActive(item.href)
                      ? 'bg-brand text-white'
                      : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
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
                </Link>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Back to Website + Logout */}
      <div className="border-t border-gray-100 p-3 space-y-0.5">
        <Link
          href="/"
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-gray-500 transition hover:bg-gray-100 hover:text-gray-900"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M10 19l-7-7m0 0l7-7m-7 7h18"
            />
          </svg>
          Back to Website
        </Link>
        <button
          onClick={handleLogout}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-gray-500 transition hover:bg-red-50 hover:text-red-600"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
            />
          </svg>
          Sign Out
        </button>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile hamburger */}
      <button
        onClick={() => setMobileOpen(true)}
        className="fixed left-4 top-4 z-40 rounded-lg bg-white p-2 shadow-md lg:hidden"
        aria-label="Open menu"
      >
        <svg className="h-5 w-5 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="fixed inset-0 bg-black/30" onClick={() => setMobileOpen(false)} />
          <div className="fixed inset-y-0 left-0 flex w-64 flex-col bg-white shadow-xl">
            <button
              onClick={() => setMobileOpen(false)}
              className="absolute right-3 top-4 rounded p-1 text-gray-400 hover:text-gray-600"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            {navContent}
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden lg:fixed lg:inset-y-0 lg:flex lg:w-64 lg:flex-col lg:border-r lg:border-gray-100 lg:bg-white">
        {navContent}
      </aside>
    </>
  );
}
