// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const fixture = vi.hoisted(() => ({
  fetch: vi.fn(), mutation: vi.fn(),
  business: { id: 'fixture-business', country_code: 'US', category: 'shop', payment_gateway: 'stripe' },
}));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => fixture.business }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/lib/countries', () => ({ getCountry: () => ({ code: 'US', currency: 'USD', currency_symbol: '$', payment_gateway: 'stripe' }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({
  from: (table: string) => {
    const chain = {
      select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
      maybeSingle: async () => ({ data: table === 'payout_accounts' ? {
        id: 'fixture-account', gateway: 'stripe', stripe_account_id: 'fixture-connect',
        subaccount_code: null, bank_name: 'Fixture Bank', account_number: '0000', account_name: 'Fixture', verified_at: null,
      } : { id: 'fixture-terms', payout_mode: 'platform_managed', accepted_at: '2026-01-01' } }),
      insert: fixture.mutation, update: fixture.mutation, delete: fixture.mutation,
    };
    return chain;
  }, rpc: fixture.mutation,
}) }));
import Account from '../page';
import History from '../history/page';

const timestamp = '2026-01-08T00:30:00Z';
const record = {
  id: 'fixture-payout', period_start: '2026-01-01', period_end: '2026-01-07',
  gross_amount: 100, platform_fee: 5, gateway_fee: 1, net_amount: 94, status: 'paid',
  transfer_method: 'manual_bank', transfer_reference: 'fixture-ref', notes: null,
  created_at: timestamp, paid_at: timestamp,
};
beforeEach(() => {
  vi.clearAllMocks();
  fixture.mutation.mockImplementation(() => { throw new Error('Mutation forbidden in presentation fixture'); });
  fixture.fetch.mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method && options.method !== 'GET') throw new Error('Network write forbidden');
    if (url.startsWith('/api/payouts/history?')) return new Response(JSON.stringify({ records: [record], payouts: [record], total_pages: 1 }));
    if (url.startsWith('/api/payouts/balance?')) return new Response(JSON.stringify({ gross: 100, fees: 6, net_available: 94, paid_out: 94, pending_payouts: 0, pending_order_revenue: 0, pending_booking_revenue: 0, total_orders: 1, total_bookings: 0 }));
    throw new Error(`Unexpected fixture request: ${url}`);
  });
  vi.stubGlobal('fetch', fixture.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('calendar periods on mounted payout pages', () => {
  it('keeps Account SQL DATE periods unchanged while created timestamp stays local', async () => {
    render(<Account />);
    expect(await screen.findByText('1 Jan – 7 Jan')).toBeTruthy();
    const localDay = process.env.TZ === 'America/New_York' ? '7 Jan' : '8 Jan';
    expect(screen.getByRole('cell', { name: localDay })).toBeTruthy();
    expect(fixture.mutation).not.toHaveBeenCalled();
  });
  it('keeps History list/detail periods unchanged and both timestamps local', async () => {
    render(<History />);
    fireEvent.click(await screen.findByText('1 Jan 2026 - 7 Jan 2026'));
    expect(screen.getAllByText('1 Jan 2026 - 7 Jan 2026')).toHaveLength(2);
    const localDay = process.env.TZ === 'America/New_York' ? '7 Jan 2026' : '8 Jan 2026';
    expect(screen.getByRole('cell', { name: localDay })).toBeTruthy();
    expect(screen.getByText(new Date(timestamp).toLocaleString())).toBeTruthy();
    expect(fixture.mutation).not.toHaveBeenCalled();
  });
});
