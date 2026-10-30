// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PayoutsPage from '../page';

const fixture = vi.hoisted(() => ({
  business: { id: 'biz-fixture', country_code: 'NG', payment_gateway: 'paystack', category: 'retail', payout_mode: 'platform_managed' },
  defaultGateway: 'paystack',
  account: null as null | Record<string, unknown>,
  update: vi.fn(),
  insert: vi.fn(),
  remove: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => fixture.business }));
vi.mock('@/lib/countries', () => ({ getCountry: () => ({ payment_gateway: fixture.defaultGateway }) }));
vi.mock('@/lib/constants', () => ({ formatCurrency: (value: number) => String(value) }));
vi.mock('@/lib/dashboard-i18n', () => ({ t: (key: string) => key }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      const chain: Record<string, any> = {};
      for (const method of ['select', 'eq', 'order', 'limit']) chain[method] = vi.fn(() => chain);
      chain.update = fixture.update.mockReturnValue(chain);
      chain.insert = fixture.insert.mockReturnValue(chain);
      chain.delete = fixture.remove.mockReturnValue(chain);
      chain.maybeSingle = vi.fn().mockResolvedValue({
        data: table === 'payout_accounts' ? fixture.account : {
          id: 'terms-fixture', payout_mode: 'platform_managed', accepted_at: '2026-01-01T00:00:00Z',
        },
      });
      return chain;
    },
  }),
}));

function response(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

function expectNoFlutterwaveRequests() {
  for (const [input, init] of fixture.fetch.mock.calls) {
    expect(String(input)).not.toContain('flutterwave');
    if (init?.body) expect(JSON.parse(init.body).gateway).not.toBe('flutterwave');
  }
}

function expectNoBrowserWrites() {
  expect(fixture.update).not.toHaveBeenCalled();
  expect(fixture.insert).not.toHaveBeenCalled();
  expect(fixture.remove).not.toHaveBeenCalled();
}

function historicalAccount() {
  fixture.business.payment_gateway = 'flutterwave';
  fixture.account = {
    id: 'account-fixture', gateway: 'flutterwave', bank_name: 'Historical Bank',
    account_number: '0123456789', account_name: 'Historical Merchant',
    square_merchant_id: null, verified_at: '2026-01-01T00:00:00Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.business = { id: 'biz-fixture', country_code: 'NG', payment_gateway: 'paystack', category: 'retail', payout_mode: 'platform_managed' };
  fixture.defaultGateway = 'paystack';
  fixture.account = null;
  window.history.replaceState({}, '', '/dashboard/payouts');
  fixture.fetch.mockImplementation(async (input: string, init?: RequestInit) => {
    if (input.startsWith('/api/payouts/balance')) return response({}, false);
    if (input.startsWith('/api/payouts/history')) return response({ records: [{
      id: 'paid-fixture', period_start: '2026-01-01', period_end: '2026-01-07',
      net_amount: 1250, status: 'paid', created_at: '2026-01-08',
    }] });
    if (input.startsWith('/api/payouts/banks?')) return response({ banks: [{ code: '058', name: 'Fixture Bank' }] });
    if (input === '/api/payouts/resolve') return response({ account_name: 'Fixture Merchant' });
    if (input === '/api/payouts/setup') return response({ success: true, payout_account_id: 'new-fixture', account_name: 'Fixture Merchant', verified: true });
    if (input === '/api/payouts/disconnect') {
      const body = JSON.parse(String(init?.body));
      return body.password === 'correct-password'
        ? response({ success: true })
        : response({ error: 'Incorrect password' }, false);
    }
    throw new Error('Unexpected fixture request: ' + input);
  });
  vi.stubGlobal('fetch', fixture.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('W05 rendered payout setup availability', () => {
  it.each(['NG', 'GH'])('offers a usable bank setup without a Flutterwave choice in %s', async (country) => {
    fixture.business.country_code = country;
    render(<PayoutsPage />);
    await screen.findByRole('option', { name: 'Fixture Bank' });
    expect(screen.queryByRole('button', { name: /Flutterwave/i })).toBeNull();
    expect(fixture.fetch).toHaveBeenCalledWith('/api/payouts/banks?gateway=paystack&country=' + country);
    expectNoFlutterwaveRequests();
    expectNoBrowserWrites();
  });

  it.each([
    { saved: 'flutterwave', fallback: 'paystack' },
    { saved: '', fallback: 'flutterwave' },
    { saved: 'flutterwave', fallback: 'flutterwave' },
  ])('normalizes stale saved $saved/default $fallback locally through successful Paystack setup', async ({ saved, fallback }) => {
    fixture.business.payment_gateway = saved;
    fixture.defaultGateway = fallback;
    render(<PayoutsPage />);
    await screen.findByRole('option', { name: 'Fixture Bank' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '058' } });
    fireEvent.change(screen.getByPlaceholderText('0123456789'), { target: { value: '0123456789' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify Account' }));
    await screen.findByText('Fixture Merchant');
    const submit = screen.getByRole('button', { name: 'Yes, set up payouts' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('Enter your account password'), { target: { value: 'correct-password' } });
    fireEvent.click(submit);
    await screen.findByText('Payout account connected');
    const resolveCall = fixture.fetch.mock.calls.find(([url]) => url === '/api/payouts/resolve');
    expect(resolveCall).toBeDefined();
    expect(JSON.parse(resolveCall![1].body)).toEqual({ gateway: 'paystack', bank_code: '058', account_number: '0123456789' });
    const setupCall = fixture.fetch.mock.calls.find(([url]) => url === '/api/payouts/setup');
    expect(setupCall).toBeDefined();
    expect(JSON.parse(setupCall![1].body)).toMatchObject({
      business_id: 'biz-fixture', gateway: 'paystack', bank_code: '058', password: 'correct-password',
    });
    expect(fixture.business.payment_gateway).toBe(saved);
    expectNoFlutterwaveRequests();
    expectNoBrowserWrites();
  });

  it('preserves the historical Flutterwave account and recent payout display', async () => {
    historicalAccount();
    render(<PayoutsPage />);
    await screen.findByText('Payout account connected');
    expect(screen.getByText('Historical Bank')).toBeTruthy();
    expect(screen.getByText('Historical Merchant')).toBeTruthy();
    expect(screen.getByText('****6789')).toBeTruthy();
    expect(screen.getByText('flutterwave')).toBeTruthy();
    await screen.findByText('paid');
    expect(screen.getByText('1250')).toBeTruthy();
    expect(fixture.fetch.mock.calls.some(([url]) => url.startsWith('/api/payouts/banks'))).toBe(false);
    expectNoBrowserWrites();
  });

  it('preserves password-protected disconnect and returns to Paystack setup', async () => {
    historicalAccount();
    render(<PayoutsPage />);
    await screen.findByText('Payout account connected');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect', exact: true }));
    const disconnect = screen.getByRole('button', { name: 'Disconnect Account' }) as HTMLButtonElement;
    expect(disconnect.disabled).toBe(true);
    expect(fixture.fetch.mock.calls.some(([url]) => url === '/api/payouts/disconnect')).toBe(false);
    fireEvent.change(screen.getByPlaceholderText('Enter your password'), { target: { value: 'wrong-password' } });
    fireEvent.click(disconnect);
    await screen.findByText('Incorrect password');
    expect(screen.getByText('Historical Merchant')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Enter your password'), { target: { value: 'correct-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Account' }));
    await screen.findByRole('option', { name: 'Fixture Bank' });
    const calls = fixture.fetch.mock.calls.filter(([url]) => url === '/api/payouts/disconnect');
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1][1].body)).toEqual({ business_id: 'biz-fixture', password: 'correct-password' });
    expectNoFlutterwaveRequests();
    expectNoBrowserWrites();
  });

  it('keeps change-account password confirmation and normalizes the subsequent setup choice', async () => {
    historicalAccount();
    render(<PayoutsPage />);
    await screen.findByText('Payout account connected');
    fireEvent.click(screen.getByRole('button', { name: 'Change account' }));
    expect((screen.getByRole('button', { name: 'Confirm Change' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('Enter your password'), { target: { value: 'correct-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Change' }));
    await screen.findByRole('option', { name: 'Fixture Bank' });
    expect((screen.getByPlaceholderText('Enter your account password') as HTMLInputElement).value).toBe('correct-password');
    expectNoFlutterwaveRequests();
    expectNoBrowserWrites();
  });

  it.each(['US', 'GB', 'CA'])('preserves nonaffected provider choices in %s', async (country) => {
    fixture.business.country_code = country;
    fixture.business.payment_gateway = 'stripe';
    fixture.defaultGateway = 'stripe';
    render(<PayoutsPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Stripe Industry standard/ })).toBeTruthy());
    expect(screen.getByRole('button', { name: /PayPal Trusted worldwide/ })).toBeTruthy();
    if (country === 'US') expect(screen.getByRole('button', { name: /Square Great for retail/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Flutterwave/i })).toBeNull();
    expectNoFlutterwaveRequests();
    expectNoBrowserWrites();
  });
});
