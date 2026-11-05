// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import PayoutsPage from '../page';
const f = vi.hoisted(() => ({ businessId: 'b1', mode: 'platform_managed', connected: true, held: true, currencyDenied: false, fetch: vi.fn() }));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => ({ id: f.businessId, country_code: 'NG', payment_gateway: 'paystack', category: 'retail', payout_mode: f.mode }) }));
vi.mock('@/lib/countries', () => ({ getCountry: () => ({ payment_gateway: 'paystack' }) }));
vi.mock('@/lib/constants', () => ({ formatCurrency: (value: number) => 'amount ' + value }));
vi.mock('@/lib/dashboard-i18n', () => ({ t: (key: string) => key }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from(table: string) {
  if (!['payout_accounts', 'payout_terms_acceptance'].includes(table)) throw Error('Unexpected table');
  const q: Record<string, any> = {};
  for (const method of ['select', 'eq', 'order', 'limit']) q[method] = () => q;
  q.maybeSingle = async () => ({ data: table === 'payout_accounts' ? (f.connected ? { id: 'a1', gateway: 'paystack', bank_name: 'Bank', account_number: '1234', account_name: 'Merchant' } : null) : { id: 'terms', payout_mode: f.mode, accepted_at: '2026-01-01' } });
  return q;
} }) }));
beforeEach(() => {
  Object.assign(f, { businessId: 'b1', mode: 'platform_managed', connected: true, held: true, currencyDenied: false });
  vi.clearAllMocks(); window.history.replaceState({}, '', '/dashboard/payouts');
  f.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') throw Error('Unexpected write');
    if (url.startsWith('/api/payouts/balance')) return { ok: !f.currencyDenied, status: f.currencyDenied ? 409 : 200, json: async () => f.currencyDenied ? { settlement_held: f.held, error: 'Currency reconciliation required' } : { settlement_held: f.held, total_revenue: 1000, gross: 1000, fees: 120, net_available: 880, pending_payouts: 0, total_orders: 0, total_bookings: 0 } };
    if (url.startsWith('/api/payouts/history')) return { ok: true, json: async () => ({ payouts: [] }) };
    if (url.startsWith('/api/payouts/banks')) return { ok: true, json: async () => ({ banks: [] }) };
    throw Error('Unexpected request');
  });
  vi.stubGlobal('fetch', f.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('actual merchant payout page accounting state', () => {
  it.each([true, false])('shows held reconciliation state and preserved provisional amount (connected=%s)', async connected => {
    f.connected = connected; render(<PayoutsPage />);
    expect(await screen.findByText('Settlement held for reconciliation')).toBeTruthy();
    expect(screen.getAllByText('Provisional Accounting Total').length).toBeGreaterThan(0);
    expect(screen.getAllByText('amount 880').length).toBeGreaterThan(0);
    expect(screen.queryByText('Available for Payout')).toBeNull(); expect(screen.queryByText('Available')).toBeNull();
    expect(screen.queryByRole('button', { name: /release|withdraw/i })).toBeNull();
  });
  it('still shows the hold when currency reconciliation forbids scalar totals', async () => {
    f.currencyDenied = true; render(<PayoutsPage />);
    expect(await screen.findByText('Settlement held for reconciliation')).toBeTruthy();
    expect(screen.queryByText('amount 880')).toBeNull(); expect(screen.queryByText('Available for Payout')).toBeNull();
  });
  it('retains available label for unheld platform balances', async () => {
    f.held = false; render(<PayoutsPage />);
    expect(await screen.findByText('Available for Payout')).toBeTruthy();
    expect(screen.queryByText('Settlement held for reconciliation')).toBeNull();
  });
  it.each([true, false])('ignores stale balance responses after switching business (old held=%s)', async oldHeld => {
    let resolveOld!: (value: unknown) => void;
    const priorFetch = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/payouts/balance?business_id=b1') {
        return Promise.resolve({ ok: true, status: 200, json: () => new Promise(resolve => { resolveOld = resolve; }) });
      }
      return priorFetch(url, init);
    });
    const view = render(<PayoutsPage />);
    await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
    f.businessId = 'b2'; f.held = !oldHeld;
    view.rerender(<PayoutsPage />);
    await screen.findByText(oldHeld ? 'Available for Payout' : 'Settlement held for reconciliation');
    await act(async () => { resolveOld({ settlement_held: oldHeld, gross: 9999, net_available: 9999, total_revenue: 9999, fees: 0 }); });
    expect(screen.queryByText('amount 9999')).toBeNull();
    expect(Boolean(screen.queryByText('Settlement held for reconciliation'))).toBe(!oldHeld);
  });
  it('does not present connected direct-provider earnings as held', async () => {
    f.mode = 'direct_split'; render(<PayoutsPage />);
    expect(await screen.findByText('Net Earned')).toBeTruthy(); expect(screen.getByText('amount 880')).toBeTruthy();
    expect(screen.queryByText('Settlement held for reconciliation')).toBeNull(); expect(screen.queryByText('Provisional Accounting Total')).toBeNull();
  });
});
