'use client';

import { createContext, useContext, useCallback, useEffect, type ReactNode } from 'react';
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
  payout_mode: string;
  recurring_enabled: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  capabilities: CapabilityId[];
  capabilityOverrides: CapabilityId[];
}

interface DashboardContextType {
  business: Business;
  userId: string;
}

const DashboardContext = createContext<DashboardContextType | null>(null);

export function DashboardProvider({
  business,
  userId,
  children,
}: {
  business: Business;
  userId: string;
  children: ReactNode;
}) {
  useEffect(() => {
    loadCountries();
  }, []);

  return (
    <DashboardContext.Provider value={{ business, userId }}>
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
