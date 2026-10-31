// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
const state = vi.hoisted(() => ({
  business: { id: 'biz', country_code: 'NG', timezone: 'Africa/Lagos', subscription_tier: 'growth', capabilities: ['payment', 'giving', 'recurring'], selectedCapabilities: ['payment', 'giving', 'recurring'], recurring_enabled: false, metadata: {}, slug: 'test' },
  subscription: { status: 'active', current_period_end: '2000-01-01T00:00:00Z', amount: 100, currency: 'NGN', gateway: 'paystack' },
}));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useDashboard: () => ({ isImpersonating: false }), useBusiness: () => state.business, useCapabilities: () => ({ capabilities: state.business.capabilities }) }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: vi.fn() }) }));
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
import { PaymentsTab } from '@/app/dashboard/settings/tabs/PaymentsTab';
import type { SettingsTabProps } from '@/app/dashboard/settings/tabs/types';
beforeEach(() => {
  state.business.capabilities = ['payment', 'giving', 'recurring'];
  state.business.selectedCapabilities = [...state.business.capabilities];
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
it.each([true, false])('giving links to the correct destination with recurring capability=%s', async enabled => {
  if (!enabled) { state.business.capabilities = ['payment', 'giving']; state.business.selectedCapabilities = [...state.business.capabilities]; }
  render(<Giving />);
  const buttons = await screen.findAllByRole('button', { name: /Add.*Category/i });
  fireEvent.click(buttons[0]);
  const link = await screen.findByRole('link', { name: 'Open recurring settings' });
  expect(link.getAttribute('href')).toBe(enabled ? '/dashboard/settings?tab=payments&section=recurring' : '/dashboard/capabilities');
});
