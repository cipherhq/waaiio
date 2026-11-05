// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
const state = vi.hoisted(() => ({
  business: { id: 'biz', country_code: 'NG', timezone: 'Africa/Lagos', subscription_tier: 'growth', capabilities: ['payment', 'giving', 'recurring'], selectedCapabilities: ['payment', 'giving', 'recurring'], recurring_enabled: false, metadata: {}, slug: 'test' },
  query: '',
  subscription: { status: 'active', current_period_end: '2000-01-01T00:00:00Z', amount: 100, currency: 'NGN', gateway: 'paystack' },
}));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useDashboard: () => ({ isImpersonating: false }), useBusiness: () => state.business, useCapabilities: () => ({ capabilities: state.business.capabilities }) }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(state.query), useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from: (table: string) => {
  const result = { data: table === 'subscriptions' ? state.subscription : [], error: null, count: 0 };
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'gte', 'in', 'order', 'limit']) chain[method] = () => chain;
  chain.maybeSingle = async () => result;
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
} }) }));
import Billing from '@/app/dashboard/billing/page';
import Giving from '@/app/dashboard/giving/page';
import Settings from '@/app/dashboard/settings/page';
import { PaymentsTab } from '@/app/dashboard/settings/tabs/PaymentsTab';
import type { SettingsTabProps } from '@/app/dashboard/settings/tabs/types';
beforeEach(() => {
  state.business.capabilities = ['payment', 'giving', 'recurring'];
  state.business.selectedCapabilities = [...state.business.capabilities];
  state.query = '';
  state.subscription.status = 'active'; state.subscription.current_period_end = '2000-01-01T00:00:00Z';
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ purchases: [], accounts: [], credentials: [] }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('explains expired period without inventing a failed renewal', async () => {
  render(<Billing />);
  expect((await screen.findByRole('status')).textContent).toContain('a renewed period has not been confirmed');
  expect(screen.getByRole('link', { name: 'Manage renewal' }).getAttribute('href')).toBe('/dashboard/settings?tab=account');
  expect(screen.queryByText('Renewal failed')).toBeNull();
});
it('labels a cancelled future period as ending, not ended', async () => {
  state.subscription.status = 'cancelled'; state.subscription.current_period_end = '2099-01-01T00:00:00Z';
  render(<Billing />);
  await screen.findByText('Cancelled');
  expect(screen.getByText('Billing Period Ends')).toBeTruthy();
  expect(screen.queryByText('Billing Period Ended')).toBeNull();
});
it('shows overdue payment explicitly', async () => {
  state.subscription.status = 'past_due'; render(<Billing />);
  expect(await screen.findByText('Payment overdue')).toBeTruthy();
});
it('renders recurring controls for a payment-only business', async () => {
  const props = { business: state.business, capabilities: ['payment'], country: 'NG', curr: '₦', saving: false, saved: false, setSaving: vi.fn(), setSaved: vi.fn(), openSections: ['recurring'], toggleSection: vi.fn() } as unknown as SettingsTabProps;
  render(<PaymentsTab {...props} />);
  expect((await screen.findAllByRole('heading', { name: 'Recurring Payments' })).length).toBeGreaterThan(0);
  expect(screen.getByText(/Enable automatic recurring payments/)).toBeTruthy();
});
it('renders recurring controls for a Giving-only business', async () => {
  // Owner decision 2026-11-05: Giving businesses can switch recurring on here.
  const props = { business: state.business, capabilities: ['giving'], country: 'NG', curr: '₦', saving: false, saved: false, setSaving: vi.fn(), setSaved: vi.fn(), openSections: ['recurring'], toggleSection: vi.fn() } as unknown as SettingsTabProps;
  render(<PaymentsTab {...props} />);
  expect((await screen.findAllByRole('heading', { name: 'Recurring Payments' })).length).toBeGreaterThan(0);
  expect(screen.getByText(/Enable automatic recurring payments/)).toBeTruthy();
});
// Owner decision 2026-11-05: the Giving link opens the page that can clear the
// block it names: Plan & Upgrade, Capabilities, or Payments > Recurring.
it.each([
  ['recurring available but switched off', ['payment', 'giving', 'recurring'], ['payment', 'giving', 'recurring'], 'Enable Recurring Payments in Settings > Payments first.', '/dashboard/settings?tab=payments&section=recurring'],
  ['recurring paused by plan', ['payment', 'giving'], ['payment', 'giving', 'recurring'], 'Recurring is paused due to your current plan. Upgrade to activate.', '/dashboard/settings?tab=account'],
  ['recurring not selected', ['payment', 'giving'], ['payment', 'giving'], 'Enable Recurring on the Capabilities page first.', '/dashboard/capabilities'],
])('giving shows the fix link when %s', async (_label, capabilities, selected, reason, href) => {
  state.business.capabilities = capabilities; state.business.selectedCapabilities = selected;
  render(<Giving />);
  const buttons = await screen.findAllByRole('button', { name: /Add.*Category/i });
  fireEvent.click(buttons[0]);
  expect(screen.getByText(reason)).toBeTruthy();
  const links = await screen.findAllByRole('link', { name: 'Open recurring settings' });
  expect(links).toHaveLength(1);
  expect(links[0].getAttribute('href')).toBe(href);
});
it('settings opens Payments with the Recurring section expanded from that link', async () => {
  // In-app <Link> click: the router already has the new query, but Next has not
  // yet updated window.location, so the address still shows the Giving page.
  window.history.pushState({}, '', '/dashboard/giving');
  state.query = 'tab=payments&section=recurring';
  try {
    render(<Settings />);
    expect((await screen.findAllByRole('heading', { name: 'Recurring Payments' })).length).toBeGreaterThan(0);
    expect(screen.getByText(/Enable automatic recurring payments/)).toBeTruthy();
  } finally {
    window.history.pushState({}, '', '/');
  }
});
it('settings opens Account with Plan & Upgrade expanded from the plan-paused link', async () => {
  window.history.pushState({}, '', '/dashboard/giving');
  state.query = 'tab=account';
  try {
    render(<Settings />);
    expect(await screen.findByRole('heading', { name: 'Plan & Upgrade' })).toBeTruthy();
  } finally {
    window.history.pushState({}, '', '/');
  }
});
