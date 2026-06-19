'use client';

import { createContext, useContext, useCallback, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { CapabilityId } from '@/lib/capabilities/types';
import { loadCountries } from '@/lib/countries';

export interface Business {
  id: string;
  owner_id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string;
  flow_type: string;
  subscription_tier: string;
  address: string;
  city: string;
  neighborhood: string;
  phone: string;
  email: string | null;
  status: string;
  operating_hours: Record<string, { open: string; close: string }> | null;
  deposit_per_guest: number;
  rating_avg: number;
  rating_count: number;
  total_bookings: number;
  logo_url: string | null;
  cover_photo_url: string | null;
  bot_code: string | null;
  wa_method: 'shared' | 'transfer' | 'coexist' | null;
  assigned_channel_id: string | null;
  whatsapp_channel_id: string | null;
  gupshup_app_id: string | null;
  is_whitelabel: boolean;
  verification_level: string | null;
  timezone: string;
  trial_ends_at: string;
  country_code: string | null;
  payment_gateway: string | null;
  whatsapp_catalog_id: string | null;
  payout_mode: string;
  recurring_enabled: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  capabilities: CapabilityId[];
  capabilityOverrides: CapabilityId[];
}

export interface BusinessSummary {
  id: string;
  name: string;
  category: string;
  logo_url: string | null;
}

interface DashboardContextType {
  business: Business;
  userId: string;
  allBusinesses: BusinessSummary[];
  switchingBusiness: boolean;
  switchBusiness: (businessId: string) => Promise<void>;
  isReseller: boolean;
}

const DashboardContext = createContext<DashboardContextType | null>(null);

export function DashboardProvider({
  business,
  userId,
  allBusinesses = [],
  isReseller = false,
  children,
}: {
  business: Business;
  userId: string;
  allBusinesses?: BusinessSummary[];
  isReseller?: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const [switchingBusiness, setSwitchingBusiness] = useState(false);

  useEffect(() => {
    loadCountries();
  }, []);

  const switchBusiness = useCallback(async (businessId: string) => {
    if (businessId === business.id) return;
    setSwitchingBusiness(true);
    try {
      const res = await fetch('/api/dashboard/switch-business', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId }),
      });
      if (res.ok) {
        // Navigate to dashboard root and refresh server data
        router.push('/dashboard');
        router.refresh();
      }
    } catch {
      // Silently fail — user can retry
    } finally {
      setSwitchingBusiness(false);
    }
  }, [business.id, router]);

  return (
    <DashboardContext.Provider value={{ business, userId, allBusinesses, switchingBusiness, switchBusiness, isReseller }}>
      {children}
    </DashboardContext.Provider>
  );
}

export function useBusiness() {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error('useBusiness must be used within DashboardProvider');
  return ctx.business;
}

export function useDashboard() {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error('useDashboard must be used within DashboardProvider');
  return ctx;
}

/** Check if the business has a specific capability enabled */
export function useCapabilities() {
  const business = useBusiness();
  const hasCapability = useCallback(
    (cap: CapabilityId) => business.capabilities.includes(cap),
    [business.capabilities],
  );
  return { capabilities: business.capabilities, hasCapability };
}

/** Check if the current user is a reseller */
export function useIsReseller() {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error('useIsReseller must be used within DashboardProvider');
  return ctx.isReseller;
}

/** Redirect to capabilities page if business lacks a required capability */
export function useRequireCapability(...caps: CapabilityId[]) {
  const { hasCapability } = useCapabilities();
  const router = useRouter();
  const missing = caps.find(cap => !hasCapability(cap));
  useEffect(() => {
    if (missing) {
      router.replace(`/dashboard/capabilities?upgrade=${missing}`);
    }
  }, [missing, router]);
  return !missing;
}
