// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityId } from '@/lib/capabilities/types';

/* ─── controllable state ─── */
const state = vi.hoisted(() => ({
  capabilities: [] as CapabilityId[],
  category: 'salon',
}));

/* ─── mocks ─── */
vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useDashboard: () => ({
    business: {
      id: 'biz-1',
      name: 'Test Biz',
      slug: 'test-biz',
      category: state.category,
      subscription_tier: 'business',
      capabilities: state.capabilities,
      logo_url: null,
      bot_code: 'TEST',
      metadata: {},
    },
    allBusinesses: [{ id: 'biz-1', name: 'Test Biz', slug: 'test-biz', logo_url: null }],
    switchingBusiness: false,
    switchBusiness: vi.fn(),
  }),
  useCapabilities: () => ({
    capabilities: state.capabilities,
    hasCapability: (cap: CapabilityId) => state.capabilities.includes(cap),
  }),
  useIsReseller: () => false,
  useBusiness: () => ({
    id: 'biz-1',
    name: 'Test Biz',
    slug: 'test-biz',
    category: state.category,
    subscription_tier: 'business',
    capabilities: state.capabilities,
    logo_url: null,
    bot_code: 'TEST',
    metadata: {},
  }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => <img {...props} />,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { signOut: vi.fn().mockResolvedValue({}) },
  }),
}));

vi.mock('@/hooks/useChatUnreadCount', () => ({
  useChatUnreadCount: () => 0,
}));

vi.mock('@/hooks/useAlertUnreadCount', () => ({
  useAlertUnreadCount: () => 0,
}));

vi.mock('@/hooks/useCategoryConfig', () => ({
  useCategoryConfig: () => ({ labels: null }),
}));

vi.mock('@/lib/tooltips', () => ({
  PAGE_TOOLTIPS: {},
}));

vi.mock('@/components/dashboard/ThemeToggle', () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));

import { Sidebar } from '@/components/dashboard/Sidebar';

/* ─── helpers ─── */
function setCaps(...caps: CapabilityId[]) {
  state.capabilities = caps;
}

beforeEach(() => {
  state.capabilities = [];
  state.category = 'salon';
});
afterEach(cleanup);

/* ─── tests ─── */
describe('Sidebar capability gating (#762)', () => {
  describe('Loyalty Tiers (requireAllCapabilities: true, [loyalty, membership])', () => {
    it('is NOT shown when neither loyalty nor membership is enabled', () => {
      setCaps('scheduling');
      render(<Sidebar />);
      expect(screen.queryByText('Loyalty Tiers')).toBeNull();
    });

    it('is NOT shown when only loyalty is enabled (missing membership)', () => {
      setCaps('loyalty');
      render(<Sidebar />);
      expect(screen.queryByText('Loyalty Tiers')).toBeNull();
    });

    it('is NOT shown when only membership is enabled (missing loyalty)', () => {
      setCaps('membership');
      render(<Sidebar />);
      expect(screen.queryByText('Loyalty Tiers')).toBeNull();
    });

    it('IS shown when both loyalty AND membership are enabled', () => {
      setCaps('loyalty', 'membership');
      render(<Sidebar />);
      expect(screen.getByText('Loyalty Tiers')).toBeTruthy();
    });
  });

  describe('Loyalty link (capabilities: [loyalty], ANY semantics)', () => {
    it('is shown when loyalty is enabled', () => {
      setCaps('loyalty');
      render(<Sidebar />);
      expect(screen.getByText('Loyalty')).toBeTruthy();
    });

    it('is NOT shown in essential items when loyalty is not enabled', () => {
      setCaps('scheduling');
      render(<Sidebar />);
      // "Loyalty" should not appear in the main nav — it may be in "Add Features" collapsed section
      // The essential rendered links should not include it
      const links = screen.getAllByRole('link');
      const loyaltyLink = links.find(
        link => link.textContent?.trim() === 'Loyalty',
      );
      expect(loyaltyLink).toBeUndefined();
    });
  });

  describe('Loyalty Tiers Add Features classification (ALL contract)', () => {
    it('Loyalty Tiers not in essential nav when only loyalty enabled (moves to Add Features)', () => {
      setCaps('loyalty');
      render(<Sidebar />);
      // With only loyalty, Loyalty Tiers fails ALL check and goes to moreItems
      // It should NOT appear as an essential nav link
      const links = screen.getAllByRole('link');
      const tierLink = links.find(link => link.textContent?.trim() === 'Loyalty Tiers');
      expect(tierLink).toBeUndefined();
    });
  });

  describe('Bookings (capabilities: [scheduling, appointment, reservation, table_reservation], ANY semantics)', () => {
    it('is shown when only scheduling is present (ANY of the four)', () => {
      setCaps('scheduling');
      render(<Sidebar />);
      expect(screen.getByText('Bookings')).toBeTruthy();
    });

    it('is shown when only appointment is present', () => {
      setCaps('appointment');
      render(<Sidebar />);
      expect(screen.getByText('Bookings')).toBeTruthy();
    });
  });
});
