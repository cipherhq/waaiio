// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityId } from '@/lib/capabilities/types';

/* ─── controllable state ─── */
const state = vi.hoisted(() => ({
  capabilities: [] as CapabilityId[],
  category: 'salon',
  tier: 'business',
  tierRequirements: {} as Partial<Record<CapabilityId, 'growth' | 'business'>>,
}));

/* ─── mocks ─── */
vi.mock('@/lib/capabilities/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/capabilities/types')>();
  return {
    ...actual,
    CAPABILITY_TIER_REQUIREMENTS: {
      ...actual.CAPABILITY_TIER_REQUIREMENTS,
      // Unequal requirements are a test-only fixture for ALL vs ANY eligibility.
      get loyalty() { return state.tierRequirements.loyalty ?? actual.CAPABILITY_TIER_REQUIREMENTS.loyalty; },
      get membership() { return state.tierRequirements.membership ?? actual.CAPABILITY_TIER_REQUIREMENTS.membership; },
    },
  };
});

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
import { CAPABILITIES } from '@/lib/capabilities/types';

/* ─── helpers ─── */
function setCaps(...caps: CapabilityId[]) { state.capabilities = caps; }
function setTier(t: string) { state.tier = t; }

function expandAddFeatures() {
  const button = screen.getByRole('button', { name: 'Add Features' });
  const section = button.parentElement!;
  fireEvent.click(button);
  return section;
}

beforeEach(() => { state.capabilities = []; state.category = 'salon'; state.tier = 'business'; state.tierRequirements = {}; });
afterEach(cleanup);

/* ─── tests ─── */
describe('Sidebar capability gating (#762)', () => {
  describe('Owner-approved capability grouping (#1044)', () => {
    it('places capability operating pages in Your Business while retaining growth and money utilities', () => {
      setCaps(...CAPABILITIES.map(cap => cap.id));
      render(<Sidebar />);
      const businessSection = within(screen.getByText('Your Business').parentElement!);
      for (const label of ['Bookings', 'Calendar', 'Chat', 'Custom flows', 'Orders', 'Tickets',
        'Subscriptions', 'Invoices', 'Payment Requests', 'Scan to Pay', 'Quotes', 'Packages',
        'Audiences', 'Broadcasts', 'Keyword Campaigns', 'Reviews', 'Loyalty', 'Loyalty Tiers',
        'Referrals', 'Instant Win', 'Parties', 'Surveys & Forms', 'Polls']) {
        expect(businessSection.getByRole('link', { name: label })).toBeTruthy();
      }
      const grow = within(screen.getByText('Grow').parentElement!);
      expect(grow.getAllByRole('link').map(link => link.textContent?.trim())).toEqual([
        'Growth', 'Analytics', 'Flow Analytics', 'QR Code & Link',
      ]);
      const money = within(screen.getByText('Money').parentElement!);
      expect(money.getAllByRole('link').map(link => link.textContent?.trim())).toEqual([
        'Payments Received', 'Revenue', 'Payouts', 'Pending Transfers', 'Billing',
      ]);
    });

    it('keeps Events-category Parties in the business section and preserves category exclusions', () => {
      setCaps('ticketing', 'scheduling');
      state.category = 'events';
      const view = render(<Sidebar />);
      expect(within(screen.getByText('Your Events').parentElement!).getByRole('link', { name: 'Parties' }).getAttribute('href'))
        .toBe('/dashboard/parties');
      view.unmount();
      state.category = 'church';
      render(<Sidebar />);
      expect(screen.queryByRole('link', { name: 'Calendar' })).toBeNull();
    });

    it('retains accessible mobile navigation and closes the drawer after following a moved link', () => {
      setCaps('poll', 'feedback');
      render(<Sidebar />);
      fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
      const drawer = screen.getByRole('dialog', { name: 'Navigation menu' });
      const group = within(drawer).getByText('Your Business').parentElement!;
      const poll = within(group).getByRole('link', { name: 'Polls' });
      poll.focus();
      expect(document.activeElement).toBe(poll);
      expect(poll.getAttribute('href')).toBe('/dashboard/polls');
      fireEvent.click(poll);
      expect(screen.queryByRole('dialog', { name: 'Navigation menu' })).toBeNull();
    });
  });
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
      const section = expandAddFeatures();
      // Now Loyalty Tiers should appear inside Add Features
      expect(screen.getByText('Loyalty Tiers')).toBeTruthy();
      expect(within(section).getByRole('link', { name: 'Loyalty Tiers' }).getAttribute('href'))
        .toBe('/dashboard/membership');
    });

    it('with neither capability: Loyalty Tiers in Add Features (not essential)', () => {
      setCaps('scheduling');
      render(<Sidebar />);
      expect(screen.queryByRole('link', { name: /^Loyalty Tiers/ })).toBeNull();
      const section = expandAddFeatures();
      const tierLink = within(section).getByRole('link', { name: 'Loyalty Tiers' });
      expect(tierLink.getAttribute('href')).toBe('/dashboard/membership');
      // The only rendered Tiers link belongs to the actual Add Features section.
      expect(screen.getAllByRole('link', { name: /^Loyalty Tiers/ })).toEqual([tierLink]);
      const essentialLinks = screen.getAllByRole('link').filter(link => !section.contains(link));
      expect(essentialLinks.length).toBeGreaterThan(0);
      expect(essentialLinks.find(link => link.textContent?.trim() === 'Loyalty Tiers')).toBeUndefined();
    });

    it('with both capabilities: Loyalty Tiers is in essential nav, not Add Features', () => {
      setCaps('loyalty', 'membership', 'scheduling');
      render(<Sidebar />);
      // Should be in essential (before Add Features)
      expect(screen.getByText('Loyalty Tiers')).toBeTruthy();
      const tierLink = screen.getByRole('link', { name: 'Loyalty Tiers' });
      const section = expandAddFeatures();
      expect(section.contains(tierLink)).toBe(false);
      expect(within(section).queryByRole('link', { name: /^Loyalty Tiers/ })).toBeNull();
      expect(screen.getAllByRole('link', { name: /^Loyalty Tiers/ })).toEqual([tierLink]);
    });
  });

  describe('Add Features placement with unequal test-only tier requirements', () => {
    it.each([
      { loyalty: 'growth', membership: 'business', tier: 'growth', upgrade: true },
      { loyalty: 'business', membership: 'growth', tier: 'growth', upgrade: true },
      { loyalty: 'growth', membership: 'business', tier: 'business', upgrade: false },
      { loyalty: 'business', membership: 'growth', tier: 'business', upgrade: false },
    ] as const)('loyalty=$loyalty membership=$membership tier=$tier requires upgrade=$upgrade',
      ({ loyalty, membership, tier, upgrade }) => {
        state.tierRequirements = { loyalty, membership };
        setTier(tier);
        setCaps('scheduling');
        render(<Sidebar />);
        expect(screen.queryByRole('link', { name: /^Loyalty Tiers/ })).toBeNull();
        const section = expandAddFeatures();
        const link = within(section).getByRole('link', { name: /^Loyalty Tiers/ });
        expect(screen.getAllByRole('link', { name: /^Loyalty Tiers/ })).toEqual([link]);
        expect(link.getAttribute('href')).toBe(upgrade ? '/dashboard/billing' : '/dashboard/membership');
        expect(link.getAttribute('title')).toBe(upgrade ? 'Upgrade to unlock Loyalty Tiers' : '');
        // These headings and links are siblings in the rendered subsection.
        let heading = link.previousElementSibling;
        while (heading && heading.tagName !== 'P') heading = heading.previousElementSibling;
        expect(heading?.textContent).toBe(upgrade ? 'Upgrade to Unlock' : 'Available to Add');
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
