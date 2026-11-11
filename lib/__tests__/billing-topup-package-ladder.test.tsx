// @vitest-environment jsdom
// The billing top-up popup with a longer package ladder (Owner request 2026-11-11):
// every configured package is offered, the popup scrolls inside the screen,
// and the chosen amount is the one sent to checkout.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const state = vi.hoisted(() => ({
  business: { id: 'biz', country_code: 'NG', timezone: 'Africa/Lagos', subscription_tier: 'growth', capabilities: ['payment'], selectedCapabilities: ['payment'], recurring_enabled: false, metadata: {}, slug: 'test' },
  topupBodies: [] as unknown[],
}));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useDashboard: () => ({ isImpersonating: false }), useBusiness: () => state.business, useCapabilities: () => ({ capabilities: state.business.capabilities }) }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(''), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from: () => {
  const result = { data: [], error: null, count: 0 };
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'gte', 'in', 'order', 'limit']) chain[method] = () => chain;
  chain.maybeSingle = async () => ({ data: null, error: null });
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
} }) }));
import Billing from '@/app/dashboard/billing/page';

const NGN_LADDER = [7_500, 15_000, 37_500, 50_000, 100_000, 200_000, 500_000].map((naira) => ({
  amount_minor: naira * 100,
  label: `₦${naira.toLocaleString('en-US')}`,
}));

beforeEach(() => {
  state.topupBodies = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/messaging/topup-packages')) {
      return { ok: true, json: async () => ({ packages: NGN_LADDER, currency: 'NGN', business_id: 'biz' }) };
    }
    if (url === '/api/messaging/topup') {
      state.topupBodies.push(JSON.parse(String(init?.body)));
      // No authorization_url: the page shows an error instead of navigating away (jsdom cannot navigate).
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({ purchases: [], accounts: [], credentials: [] }) };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('offers every configured package and sends the chosen large amount to checkout', async () => {
  render(<Billing />);
  fireEvent.click((await screen.findAllByRole('button', { name: /Top Up/ }))[0]);

  const dialog = await screen.findByRole('dialog', { name: 'Top Up Messaging Credit' });
  await waitFor(() => expect(within(dialog).getByText('₦500,000')).toBeTruthy());
  for (const pkg of NGN_LADDER) expect(within(dialog).getByText(pkg.label)).toBeTruthy();

  // The popup is capped to the screen and scrolls, so the pay button stays reachable.
  expect(dialog.className).toContain('max-h-full');
  expect(dialog.className).toContain('overflow-y-auto');

  const pay = within(dialog).getByRole('button', { name: 'Continue to Payment' }) as HTMLButtonElement;
  expect(pay.disabled).toBe(true);
  fireEvent.click(within(dialog).getByText('₦200,000').closest('button')!);
  expect(pay.disabled).toBe(false);
  fireEvent.click(pay);

  await waitFor(() => expect(state.topupBodies).toEqual([{ business_id: 'biz', package_amount_minor: 20_000_000 }]));
  expect(await within(dialog).findByText('No payment URL returned')).toBeTruthy();
});
