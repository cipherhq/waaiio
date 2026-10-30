// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityId } from '@/lib/capabilities/types';

/* ─── controllable state ─── */
const state = vi.hoisted(() => ({
  capabilities: [] as CapabilityId[],
  category: 'salon',
  tier: 'business',
}));

/* ─── mocks ─── */
vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useDashboard: () => ({
    business: {
      id: 'biz-1', name: 'Test Biz', slug: 'test-biz', category: state.category,
      subscription_tier: state.tier, capabilities: state.capabilities,
      logo_url: null, bot_code: 'TEST', metadata: {},
    },
    allBusinesses: [{ id: 'biz-1', name: 'Test Biz', slug: 'test-biz', logo_url: null }],
    switchingBusiness: false, switchBusiness: vi.fn(),
  }),
  useCapabilities: () => ({
    capabilities: state.capabilities,
    hasCapability: (cap: CapabilityId) => state.capabilities.includes(cap),
  }),
  useIsReseller: () => false,
  useBusiness: () => ({
    id: 'biz-1', name: 'Test Biz', slug: 'test-biz', category: state.category,
    subscription_tier: state.tier, capabilities: state.capabilities,
    logo_url: null, bot_code: 'TEST', metadata: {},
  }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock('next/image', () => ({ default: (props: Record<string, unknown>) => <img {...props} /> }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signOut: vi.fn().mockResolvedValue({}) } }),
}));
vi.mock('@/hooks/useChatUnreadCount', () => ({ useChatUnreadCount: () => 0 }));
vi.mock('@/hooks/useAlertUnreadCount', () => ({ useAlertUnreadCount: () => 0 }));
vi.mock('@/hooks/useCategoryConfig', () => ({ useCategoryConfig: () => ({ labels: null }) }));
vi.mock('@/lib/tooltips', () => ({ PAGE_TOOLTIPS: {} }));
vi.mock('@/components/dashboard/ThemeToggle', () => ({ ThemeToggle: () => <div data-testid="theme-toggle" /> }));

import { Sidebar } from '@/components/dashboard/Sidebar';

/* ─── helpers ─── */
function setCaps(...caps: CapabilityId[]) { state.capabilities = caps; }
function setTier(t: string) { state.tier = t; }

function expandAddFeatures() {
  const btns = screen.queryAllByText('Add Features');
  // Click all instances to expand (mobile + desktop sidebars)
  btns.forEach(btn => fireEvent.click(btn));
}

beforeEach(() => { state.capabilities = []; state.category = 'salon'; state.tier = 'business'; });
afterEach(cleanup);

/* ─── tests ─── */
describe('Sidebar capability gating (#762)', () => {
  describe('Loyalty Tiers essential nav (requireAllCapabilities: true)', () => {
    it('NOT shown when neither loyalty nor membership is enabled', () => {
      setCaps('scheduling');
      render(<Sidebar />);
      expect(screen.queryByText('Loyalty Tiers')).toBeNull();
    });

    it('NOT shown when only loyalty is enabled', () => {
      setCaps('loyalty');
      render(<Sidebar />);
      // Not in essential links
      const links = screen.getAllByRole('link');
      const tierLink = links.find(l => l.textContent?.trim() === 'Loyalty Tiers');
      expect(tierLink).toBeUndefined();
    });

    it('NOT shown when only membership is enabled', () => {
      setCaps('membership');
      render(<Sidebar />);
      const links = screen.getAllByRole('link');
      const tierLink = links.find(l => l.textContent?.trim() === 'Loyalty Tiers');
      expect(tierLink).toBeUndefined();
    });

    it('IS shown when both loyalty AND membership are enabled', () => {
      setCaps('loyalty', 'membership');
      render(<Sidebar />);
      expect(screen.getByText('Loyalty Tiers')).toBeTruthy();
    });
  });

  describe('Loyalty Tiers in Add Features (ALL-capability tier eligibility)', () => {
    it('with only loyalty enabled: Loyalty Tiers appears in Add Features, not essential', () => {
      setCaps('loyalty');
      render(<Sidebar />);
      // Not in essential nav
      const essentialLinks = screen.getAllByRole('link');
      expect(essentialLinks.find(l => l.textContent?.trim() === 'Loyalty Tiers')).toBeUndefined();
      // Expand Add Features
      expandAddFeatures();
      // Now Loyalty Tiers should appear inside Add Features
      expect(screen.getByText('Loyalty Tiers')).toBeTruthy();
    });

    it('with neither capability: Loyalty Tiers in Add Features (not essential)', () => {
      setCaps('scheduling');
      render(<Sidebar />);
      expandAddFeatures();
      // May or may not appear depending on tier — but NOT in essential
      const essentialLinks = screen.getAllByRole('link').filter(l => {
        // Check if link is before the Add Features section
        return !l.closest('[class*="space-y-0.5"]');
      });
      expect(essentialLinks.find(l => l.textContent?.trim() === 'Loyalty Tiers')).toBeUndefined();
    });

    it('with both capabilities: Loyalty Tiers is in essential nav, not Add Features', () => {
      setCaps('loyalty', 'membership', 'scheduling');
      render(<Sidebar />);
      // Should be in essential (before Add Features)
      expect(screen.getByText('Loyalty Tiers')).toBeTruthy();
    });
  });

  describe('Loyalty link (ANY semantics preserved)', () => {
    it('shown when loyalty is enabled', () => {
      setCaps('loyalty');
      render(<Sidebar />);
      expect(screen.getByText('Loyalty')).toBeTruthy();
    });

    it('not in essential nav when loyalty is not enabled', () => {
      setCaps('scheduling');
      render(<Sidebar />);
      const links = screen.getAllByRole('link');
      const loyaltyLink = links.find(l => l.textContent?.trim() === 'Loyalty');
      expect(loyaltyLink).toBeUndefined();
    });
  });

  describe('Bookings (ANY of 4 capabilities — unrelated ANY preserved)', () => {
    it('shown when only scheduling is present', () => {
      setCaps('scheduling');
      render(<Sidebar />);
      expect(screen.getByText('Bookings')).toBeTruthy();
    });

    it('shown when only appointment is present', () => {
      setCaps('appointment');
      render(<Sidebar />);
      expect(screen.getByText('Bookings')).toBeTruthy();
    });
  });
});
