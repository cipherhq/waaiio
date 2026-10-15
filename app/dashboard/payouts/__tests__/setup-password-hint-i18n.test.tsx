// @vitest-environment jsdom
/**
 * Verify the setup password helper text renders the localized string
 * and the key resolves correctly in both en and pcm.
 */
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@/lib/dashboard-i18n';

// ── Mocks (same as setup-password-field.test.tsx) ──

vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: any) =>
    React.createElement('a', { href, ...rest }, children),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/payouts',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useBusiness: () => ({
    id: 'biz-test',
    name: 'Test Business',
    country_code: 'NG',
    category: 'shop',
    payout_mode: 'platform_managed',
    payment_gateway: 'paystack',
  }),
  useCapabilities: () => ([]),
  useDashboard: () => ({ business: { id: 'biz-test' }, userId: 'user-1' }),
  hasCapability: () => true,
}));

vi.mock('@/components/dashboard/PageHelp', () => ({
  PageHelp: () => null,
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      const chain: Record<string, any> = {};
      ['select', 'eq', 'order', 'limit'].forEach(m => { chain[m] = () => chain; });
      chain.maybeSingle = async () => {
        if (table === 'payout_accounts') return { data: null };
        if (table === 'payout_terms_acceptance')
          return { data: { id: 'terms-1', payout_mode: 'platform_managed', accepted_at: '2026-01-01' } };
        return { data: null };
      };
      return chain;
    },
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1', email: 'test@test.com' } } }),
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

vi.mock('@/lib/countries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/countries')>()),
  getCountry: () => ({ payment_gateway: 'paystack', currency: 'NGN' }),
}));

vi.mock('@/lib/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/constants')>()),
  formatCurrency: (amt: number) => `₦${amt}`,
}));

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('Setup password hint — i18n', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (typeof url === 'string') {
        if (url.includes('/api/payouts/balance')) return jsonResponse(200, { gross: 0, fees: 0, net_available: 0, paid_out: 0, pending_payouts: 0, pending_order_revenue: 0, pending_booking_revenue: 0, total_orders: 0, total_bookings: 0 });
        if (url.includes('/api/payouts/banks')) return jsonResponse(200, { banks: [{ code: '058', name: 'GTBank' }] });
      }
      return jsonResponse(200, {});
    });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the localized password hint text in the setup form', async () => {
    const PayoutsPage = (await import('../page')).default;
    render(React.createElement(PayoutsPage));

    await waitFor(() => {
      expect(screen.getByText('Add your bank account')).toBeTruthy();
    });

    // The helper text should be the en translation, not the old hardcoded string
    const expectedText = t('payouts.setup_password_hint', 'en');
    expect(screen.getByText(expectedText)).toBeTruthy();

    // The old text should not be present
    expect(screen.queryByText('Required to verify your identity before connecting a payout account')).toBeNull();
  });

  it('t() resolves payouts.setup_password_hint in en', () => {
    const result = t('payouts.setup_password_hint', 'en');
    expect(result).toBe(
      "Enter your Waaiio account password, the one you log in with, not your bank password.",
    );
  });

  it('t() resolves payouts.setup_password_hint in pcm', () => {
    const result = t('payouts.setup_password_hint', 'pcm');
    expect(result).toBe(
      "Put your Waaiio account password, the one wey you dey use log in, no be your bank password.",
    );
    // pcm must differ from en
    expect(result).not.toBe(t('payouts.setup_password_hint', 'en'));
  });

  it('t() falls back to en for unknown locale', () => {
    const result = t('payouts.setup_password_hint', 'xx');
    expect(result).toBe(t('payouts.setup_password_hint', 'en'));
  });
});
