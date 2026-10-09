/**
 * #595 Finance UI truth: executable mounted Admin components with mocked database/provider.
 * The loaded source is the production Finance/Dashboard/Payouts component, not text matching.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const h = vi.hoisted(() => ({
  from: vi.fn(),
  getSession: vi.fn(),
  fetch: vi.fn(),
  role: { current: 'admin' },
  adminQuery: vi.fn(),
}));
vi.mock('@/lib/supabase', () => ({
  adminDb: { from: h.from },
  supabase: { auth: { getSession: h.getSession } },
}));
vi.mock('@/components/AdminLayout', () => ({
  useAdminSession: () => ({ role: h.role.current, userId: 'finance-test-user' }),
}));
vi.mock('@/lib/countries', () => ({
  loadCountries: async () => {},
  getCountryCurrencyMap: () => ({ NG: 'NGN', US: 'USD' }),
  getCountryCurrencyDetailMap: () => ({}),
}));
vi.mock('@/lib/adminQuery', () => ({ adminQuery: h.adminQuery }));
vi.mock('@/components/Pagination', () => ({ Pagination: () => null }));
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));

import Finance from '../pages/Finance';
import Dashboard from '../pages/Dashboard';
import Payouts from '../pages/Payouts';

const sourceNames = ['payments', 'platform_fees', 'business_payouts', 'refunds', 'businesses', 'subscriptions'];
type SourceResponse = { data: unknown[] | null; error: unknown };
const plan: Record<string, () => Promise<SourceResponse>> = {};
const selected: Record<string, string[]> = {};
const NG = 'business-ng';
const US = 'business-us';
const businesses = [
  { id: NG, category: 'retail', country_code: 'NG', subscription_tier: 'growth' },
  { id: US, category: 'healthcare', country_code: 'US', subscription_tier: 'growth' },
];
const payments = [
  { id: 'ng-1', amount: 100, currency: 'NGN', gateway: 'paystack', status: 'success', business_id: NG, created_at: '2026-09-20T10:00:00Z' },
  { id: 'us-1', amount: 20, currency: 'USD', gateway: 'stripe', status: 'success', business_id: US, created_at: '2026-10-04T10:00:00Z' },
];
const payouts = [
  { business_id: NG, status: 'paid', created_at: '2026-09-25T10:00:00Z' },
  { business_id: US, status: 'pending', created_at: '2026-10-05T10:00:00Z' },
];

function setSource(name: string, response: SourceResponse) {
  plan[name] = async () => response;
}
function buildQuery(table: string) {
  const query: any = {
    select: vi.fn((columns: string) => { (selected[table] ||= []).push(columns); return query; }),
    is: vi.fn(() => query),
    eq: vi.fn(() => query),
    then: (resolve: any, reject: any) => (plan[table] || (() => Promise.resolve({ data: [], error: null })))().then(resolve, reject),
  };
  return query;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.role.current = 'admin';
  Object.keys(plan).forEach(k => delete plan[k]);
  Object.keys(selected).forEach(k => delete selected[k]);
  for (const table of sourceNames) setSource(table, { data: [], error: null });
  h.from.mockImplementation(buildQuery);
  h.getSession.mockResolvedValue({ data: { session: { access_token: 'fake-test-token' } } });
  h.adminQuery.mockResolvedValue({ data: [], count: 0 });
  h.fetch.mockResolvedValue(new Response(JSON.stringify({ payouts: [], total_pages: 1 }), { status: 200 }));
  vi.stubGlobal('fetch', h.fetch);
});

describe('#595 mounted Finance: error is not a valid zero', () => {
  it.each(sourceNames)('hides every financial figure on a failed %s query', async table => {
    setSource(table, { data: null, error: { code: '42501', message: 'permission denied' } });
    render(<Finance />);
    expect(await screen.findByRole('alert')).toHaveTextContent('source queries failed');
    expect(screen.getByRole('alert')).toHaveTextContent(table === 'platform_fees' ? 'platform fees' : table === 'business_payouts' ? 'payouts' : table);
    expect(screen.queryByText('Platform Fees Earned')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
  });

  it.each(sourceNames)('treats unexpected null without error as failure: %s', async table => {
    setSource(table, { data: null, error: null });
    render(<Finance />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Platform Fees Earned')).not.toBeInTheDocument();
  });

  it('surfaces rejected network requests and retries successfully, without a permanent spinner', async () => {
    plan.payments = async () => { throw new Error('network lost'); };
    render(<Finance />);
    expect(await screen.findByRole('alert')).toHaveTextContent('payments (network)');
    setSource('payments', { data: [], error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Retry finance data' }));
    expect(await screen.findByText('Platform Fees Earned')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders true empty successful sources without a degraded banner, but keeps unverified CSV disabled', async () => {
    render(<Finance />);
    expect(await screen.findByText('Platform Fees Earned')).toBeInTheDocument();
    expect(screen.getByText('No payment data')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
    expect(screen.getByText(/not complete or reconciled/)).toBeInTheDocument();
  });

  it('denies support roles before querying sensitive finance tables', () => {
    h.role.current = 'support';
    render(<Finance />);
    expect(screen.getByText('Access Restricted')).toBeInTheDocument();
    expect(h.from).not.toHaveBeenCalled();
  });

  it('requests only real payout columns and displays record counts without currency invention', async () => {
    setSource('business_payouts', { data: payouts, error: null });
    render(<Finance />);
    expect(await screen.findByText('Payouts Pending/Approved (records)')).toBeInTheDocument();
    const cols = selected.business_payouts[0].split(',').map(s => s.trim());
    expect(cols).toContain('business_id');
    expect(cols).not.toContain('currency');
    expect(within(screen.getByText('Payouts Pending/Approved (records)').parentElement!).getByText('1')).toBeInTheDocument();
    expect(screen.getByText(/denomination unverified/)).toBeInTheDocument();
    expect(screen.queryByText('Outstanding Liability')).not.toBeInTheDocument();
  });

  it('applies country and date filters to category volume, monthly rollup, and payout record counts', async () => {
    setSource('payments', { data: payments, error: null });
    setSource('businesses', { data: businesses, error: null });
    setSource('business_payouts', { data: payouts, error: null });
    render(<Finance />);
    const title = await screen.findByText('Payment Volume by Business Category');
    expect(screen.getByText('retail')).toBeInTheDocument();
    expect(screen.getByText('healthcare')).toBeInTheDocument();
    const categoryBlock = title.parentElement!;
    expect(within(categoryBlock).getAllByText('1 tx')).toHaveLength(2);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'US' } });
    await waitFor(() => expect(screen.queryByText('retail')).not.toBeInTheDocument());
    expect(screen.getByText('healthcare')).toBeInTheDocument();
    expect(within(screen.getByText('Payouts Pending/Approved (records)').parentElement!).getByText('1')).toBeInTheDocument();
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: '2026-10-06' } });
    await waitFor(() => expect(screen.queryByText('healthcare')).not.toBeInTheDocument());
    expect(within(screen.getByText('Payouts Pending/Approved (records)').parentElement!).getByText('0')).toBeInTheDocument();
    expect(screen.getByText(/Monthly Rollup \(filtered client-loaded estimates/)).toBeInTheDocument();
  });

  it('separates NGN and USD category amounts and has a count-based bar, never a mixed-money bar', async () => {
    setSource('payments', { data: payments, error: null });
    setSource('businesses', { data: businesses.map(b => ({ ...b, category: 'retail' })), error: null });
    render(<Finance />);
    const title = await screen.findByText('Payment Volume by Business Category');
    const card = title.parentElement!;
    expect(within(card).getByText('2 tx')).toBeInTheDocument();
    const amounts = within(card).getByText(/₦.*\$/);
    expect(amounts).toBeInTheDocument();
    const bar = card.querySelector('div[style*="width"]') as HTMLElement;
    expect(bar?.style.width).toBe('100%');
  });
});

describe('#595 mounted Dashboard and Payouts', () => {
  it('renders Dashboard category payment volume for positive currencies and an all-zero category', async () => {
    h.adminQuery.mockImplementation(async (table: string, args: any) => {
      if (table === 'businesses' && args?.select?.includes('category')) {
        return { data: businesses, count: 2 };
      }
      if (table === 'payments' && args?.select === 'business_id, amount') {
        return { data: [{ business_id: NG, amount: 0 }, { business_id: US, amount: 20 }], count: 2 };
      }
      return { data: [], count: 0 };
    });
    render(<Dashboard />);
    expect(await screen.findByText('By Category')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Payment Volume' })).toBeInTheDocument();
    const rows = document.querySelectorAll('table tbody tr');
    expect(rows.length).toBeGreaterThan(0);
    expect(screen.getByText(/currency inferred from business country/)).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders real Payouts approval dropdown without the unsupported Flutterwave transfer method', async () => {
    h.fetch.mockResolvedValue(new Response(JSON.stringify({
      payouts: [{
        id: 'pay-1', business_id: NG, business_name: 'Test Merchant', payout_account_id: null,
        period_start: '2026-10-01', period_end: '2026-10-08', gross_amount: 1000,
        platform_fee: 10, gateway_fee: 0, net_amount: 990, country_code: 'NG',
        status: 'pending', created_at: '2026-10-09T00:00:00Z',
      }],
      total_pages: 1,
    }), { status: 200 }));
    render(<Payouts />);
    expect(await screen.findByText('Test Merchant')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.getByText('Approve Payout')).toBeInTheDocument();
    const options = Array.from(document.querySelectorAll('option')).map(o => o.value);
    expect(options).toEqual(expect.arrayContaining(['manual_bank', 'manual_cash', 'paystack_transfer', 'stripe_transfer']));
    expect(options).not.toContain('flutterwave_transfer');
  });
});
