// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PayoutsPage from '../page';
import PayoutHistoryPage from '../history/page';

const fixture = vi.hoisted(() => ({
  business: { id: 'business-1', country_code: 'NG', payment_gateway: 'paystack', category: 'retail', payout_mode: 'platform_managed' },
  payouts: [] as Array<Record<string, any>>,
  fetch: vi.fn(),
  unexpected: [] as string[],
}));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => fixture.business }));
vi.mock('@/lib/countries', () => ({ getCountry: () => ({ payment_gateway: 'paystack' }) }));
vi.mock('@/lib/constants', () => ({ formatCurrency: (value: number) => 'amount ' + value }));
vi.mock('@/lib/dashboard-i18n', () => ({ t: (key: string) => key }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      if (!['payout_accounts', 'payout_terms_acceptance'].includes(table)) fixture.unexpected.push(table);
      const query: Record<string, any> = {};
      for (const method of ['select', 'eq', 'order', 'limit']) query[method] = () => query;
      query.maybeSingle = async () => ({
        data: table === 'payout_accounts'
          ? { id: 'current-account', gateway: 'paystack', bank_name: 'Current Bank', account_number: '1111111111', account_name: 'Current Merchant', verified_at: '2026-01-01' }
          : { id: 'terms', payout_mode: 'platform_managed', accepted_at: '2026-01-01' },
      });
      // No insert/update/delete methods: a read-only display must not mutate state.
      return query;
    },
  }),
}));
function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 'payout-1', period_start: '2026-01-01', period_end: '2026-01-07', created_at: '2026-01-08',
    gross_amount: 120, platform_fee: 10, gateway_fee: 5, net_amount: 105,
    status: 'pending', transfer_method: null, transfer_reference: null, notes: null, paid_at: null,
    status_explanation: 'Awaiting payout review. A transfer is not confirmed.',
    recorded_context: ['No further reason recorded.'],
    linked_destination: 'Paystack · Historical Bank · ****6789',
    ...overrides,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture.payouts = [record()];
  fixture.unexpected = [];
  window.history.replaceState({}, '', '/dashboard/payouts');
  fixture.fetch.mockImplementation(async (input: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') fixture.unexpected.push('write:' + input);
    const url = new URL(input, 'https://example.invalid');
    if (url.pathname === '/api/payouts/balance') return { ok: false, json: async () => ({}) };
    if (url.pathname === '/api/payouts/history') {
      const status = url.searchParams.get('status');
      const payouts = !status || status === 'all' ? fixture.payouts : fixture.payouts.filter(p => p.status === status);
      return { ok: true, json: async () => ({ payouts, total: payouts.length, page: 1, per_page: 20, total_pages: 1 }) };
    }
    fixture.unexpected.push(input);
    throw new Error('Unexpected request');
  });
  vi.stubGlobal('fetch', fixture.fetch);
});
afterEach(() => {
  cleanup();
  expect(fixture.unexpected).toEqual([]);
  vi.unstubAllGlobals();
});
async function show(surface: 'Account' | 'History') {
  render(surface === 'Account' ? <PayoutsPage /> : <PayoutHistoryPage />);
  await screen.findByText(fixture.payouts[0].status_explanation, { selector: 'p' });
  if (surface === 'History') {
    const badge = screen.getByText(fixture.payouts[0].status, { selector: 'span' });
    fireEvent.click(badge.closest('tr')!);
    await screen.findByText('Payout Details');
  }
}

describe.each(['Account', 'History'] as const)('W06 mounted %s consumer', surface => {
  it('preserves calendar periods while retaining local timestamp dates', async () => {
    const createdAt = '2026-01-08T00:30:00Z';
    fixture.payouts = [record({ created_at: createdAt })];
    await show(surface);
    const period = surface === 'Account' ? '1 Jan – 7 Jan' : '1 Jan 2026 - 7 Jan 2026';
    expect(screen.getAllByText(period).length).toBe(surface === 'Account' ? 1 : 2);
    const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', ...(surface === 'History' ? { year: 'numeric' } : {}) };
    expect(screen.getByRole('cell', { name: new Date(createdAt).toLocaleDateString('en-GB', options) })).toBeTruthy();
  });

  it('consumes nonempty payouts and displays recorded context plus the linked historical account', async () => {
    await show(surface);
    expect(screen.queryByText(surface === 'Account' ? 'No payouts yet' : 'No payout records found')).toBeNull();
    expect(screen.getAllByText(/amount 105/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Historical Bank · \*\*\*\*6789/)).toBeTruthy();
    expect(screen.getByText(/No further reason recorded/)).toBeTruthy();
    expect(screen.getByText(/Linked payout account/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('0123456789');
    if (surface === 'Account') expect(screen.getByText('Current Bank')).toBeTruthy();
  });

  it.each([
    ['held', null, 'On hold for review. See recorded context below.', 'Business verification was required.'],
    ['review_required', 'paystack_transfer', 'The transfer outcome requires review; neither success nor failure is confirmed.', 'Payout adjustments required reconciliation.'],
    ['approved', 'manual_bank', 'Approved for manual bank transfer; settlement confirmation has not been recorded.', 'No further reason recorded.'],
    ['paid', 'manual_bank', 'Payout settlement is recorded as paid.', 'No further reason recorded.'],
    ['future_state', null, 'No explanation is available for this recorded status.', 'No further reason recorded.'],
  ])('renders server explanation for %s without inferring settlement', async (status, method, explanation, context) => {
    fixture.payouts = [record({
      status, transfer_method: method, status_explanation: explanation, recorded_context: [context],
      paid_at: status === 'paid' ? '2026-01-08T12:00:00Z' : null,
    })];
    await show(surface);
    expect(screen.getAllByText(String(explanation)).length).toBeGreaterThan(0);
    expect(screen.getByText(new RegExp(String(context).replace(/[.*+?^$()|[\]\\]/g, '\\$&')))).toBeTruthy();
    if (surface === 'History' && method) expect(screen.getByText(String(method))).toBeTruthy();
    expect(fixture.payouts[0].status).toBe(status);
  });

  it.each([
    'Unavailable — no linked payout account details recorded.',
    'Stripe · Bank details not recorded',
  ])('renders missing/provider-only destination honestly: %s', async destination => {
    fixture.payouts = [record({ linked_destination: destination })];
    await show(surface);
    expect(screen.getByText(new RegExp(destination))).toBeTruthy();
    expect(screen.queryByText(/Historical Bank/)).toBeNull();
  });
});

describe('W06 History filters', () => {
  it.each(['held', 'review_required'])('requests the %s filter without losing the returned record', async status => {
    fixture.payouts = [record({ status, status_explanation: 'Recorded state explanation.' })];
    render(<PayoutHistoryPage />);
    await screen.findByText('Recorded state explanation.');
    fireEvent.change(screen.getByRole('combobox', { name: 'Payout status' }), { target: { value: status } });
    await waitFor(() => expect(fixture.fetch.mock.calls.some(([input]) => {
      const url = new URL(input, 'https://example.invalid');
      return url.searchParams.get('status') === status && url.searchParams.get('page') === '1';
    })).toBe(true));
    expect(await screen.findByText(status, { selector: 'span' })).toBeTruthy();
  });
});
