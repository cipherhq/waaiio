/**
 * #596 Finance UI reconciliation tests.
 *
 * Validates:
 * 1. Query failure → degraded banner, not zeros; CSV disabled
 * 2. Multi-currency amounts never combined into single totals
 * 3. Country filter applied to payouts, payments, and category volume
 * 4. Payout metrics display record counts (no fake currency)
 * 5. Transfer method dropdown excludes flutterwave_transfer
 * 6. Dashboard CategoryPaymentValue renders per-currency correctly
 * 7. Settlement-state display: approved manual_bank shows Confirm Settlement
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// ── Hoisted mocks ──
const h = vi.hoisted(() => ({
  from: vi.fn(),
  getSession: vi.fn(),
  fetch: vi.fn(),
  role: { current: 'admin' },
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
vi.mock('@/lib/adminQuery', () => ({ adminQuery: vi.fn().mockResolvedValue({ data: [], count: 0 }) }));
vi.mock('@/components/Pagination', () => ({ Pagination: () => null }));
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));

import Finance from '../pages/Finance';
import { CategoryPaymentValue } from '../pages/Dashboard';
import Payouts from '../pages/Payouts';

// ── Query plan helpers ──
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
  { business_id: NG, net_amount: 900, platform_fee: 50, gateway_fee: 50, status: 'paid', created_at: '2026-09-25T10:00:00Z' },
  { business_id: US, net_amount: 18, platform_fee: 1, gateway_fee: 1, status: 'pending', created_at: '2026-10-05T10:00:00Z' },
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
  h.fetch.mockResolvedValue(new Response(JSON.stringify({ payouts: [], total_pages: 1 }), { status: 200 }));
  vi.stubGlobal('fetch', h.fetch);
});

// ═══════════════════════════════════════════════════════════
// 1. Query failure → degraded state, not zeros
// ═══════════════════════════════════════════════════════════
describe('#596 Finance: query failure → degraded state', () => {
  it.each(sourceNames)('shows error banner on failed %s query', async table => {
    setSource(table, { data: null, error: { code: '42501', message: 'permission denied' } });
    render(<Finance />);
    expect(await screen.findByRole('alert')).toHaveTextContent('source queries failed');
    expect(screen.queryByText('Platform Fees Earned')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
  });

  it.each(sourceNames)('treats unexpected null without error as failure: %s', async table => {
    setSource(table, { data: null, error: null });
    render(<Finance />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Platform Fees Earned')).not.toBeInTheDocument();
  });

  it('surfaces rejected network requests and retries successfully', async () => {
    plan.payments = async () => { throw new Error('network lost'); };
    render(<Finance />);
    expect(await screen.findByRole('alert')).toHaveTextContent('payments (network)');
    setSource('payments', { data: [], error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Retry finance data' }));
    expect(await screen.findByText('Platform Fees Earned')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders true empty without degraded banner', async () => {
    render(<Finance />);
    expect(await screen.findByText('Platform Fees Earned')).toBeInTheDocument();
    expect(screen.getByText('No payment data')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
    expect(screen.getByText(/not complete or reconciled/)).toBeInTheDocument();
  });

  it('denies support roles before querying', () => {
    h.role.current = 'support';
    render(<Finance />);
    expect(screen.getByText('Access Restricted')).toBeInTheDocument();
    expect(h.from).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Multi-currency: never combined, always separated
// ═══════════════════════════════════════════════════════════
describe('#596 Finance: multi-currency separation', () => {
  it('requests real payout columns with amounts — no currency column', async () => {
    setSource('business_payouts', { data: payouts, error: null });
    render(<Finance />);
    await screen.findByText('Platform Fees Earned');
    const cols = selected.business_payouts[0].split(',').map((s: string) => s.trim());
    expect(cols).toContain('business_id');
    expect(cols).toContain('net_amount');
    expect(cols).toContain('status');
    expect(cols).not.toContain('currency');
  });

  it('payout metric cards show business-inferred currency amounts', async () => {
    setSource('business_payouts', { data: payouts, error: null });
    setSource('businesses', { data: businesses, error: null });
    render(<Finance />);
    expect(await screen.findByText('Payouts Owed')).toBeInTheDocument();
    expect(screen.getByText('Paid Out')).toBeInTheDocument();
    expect(screen.getByText('Outstanding Liability')).toBeInTheDocument();
  });

  it('separates NGN and USD in category volume, using count-based bar', async () => {
    setSource('payments', { data: payments, error: null });
    setSource('businesses', { data: businesses.map(b => ({ ...b, category: 'retail' })), error: null });
    render(<Finance />);
    const title = await screen.findByText('Payment Volume by Business Category');
    const card = title.parentElement!;
    expect(within(card).getByText('2 tx')).toBeInTheDocument();
    // Both currencies shown separately
    const amounts = within(card).getByText(/₦.*\$/);
    expect(amounts).toBeInTheDocument();
  });

  it('payout status breakdown uses business-inferred currency', async () => {
    setSource('business_payouts', { data: payouts, error: null });
    setSource('businesses', { data: businesses, error: null });
    render(<Finance />);
    const heading = await screen.findByText(/Payout Status Breakdown/);
    expect(heading).toHaveTextContent('currency inferred from business country');
  });
});

// ═══════════════════════════════════════════════════════════
// 3. Country + date filter applies to payouts
// ═══════════════════════════════════════════════════════════
describe('#596 Finance: filtering', () => {
  it('country filter applies to payout amounts and counts', async () => {
    setSource('payments', { data: payments, error: null });
    setSource('businesses', { data: businesses, error: null });
    setSource('business_payouts', { data: payouts, error: null });
    render(<Finance />);
    await screen.findByText('Platform Fees Earned');
    // Both countries visible initially
    expect(screen.getByText('Payouts Owed')).toBeInTheDocument();
    expect(screen.getByText('Paid Out')).toBeInTheDocument();
    // Filter to US only — NG paid payout (₦900) disappears, only US pending ($18) remains
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'US' } });
    await waitFor(() => {
      const owedCard = screen.getByText('Payouts Owed').parentElement!;
      // US has 1 pending payout ($18) — should show USD amount
      expect(within(owedCard).getByText(/\$18/)).toBeInTheDocument();
    });
  });

  it('date filter applies to category volume and monthly rollup', async () => {
    setSource('payments', { data: payments, error: null });
    setSource('businesses', { data: businesses, error: null });
    render(<Finance />);
    await screen.findByText('Payment Volume by Business Category');
    expect(screen.getByText('retail')).toBeInTheDocument();
    expect(screen.getByText('healthcare')).toBeInTheDocument();
    // Set date after all NG payments
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: '2026-10-06' } });
    await waitFor(() => expect(screen.queryByText('retail')).not.toBeInTheDocument());
    expect(screen.queryByText('healthcare')).not.toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════
// 4. Dashboard CategoryPaymentValue component
// ═══════════════════════════════════════════════════════════
describe('#596 Dashboard: CategoryPaymentValue', () => {
  it('renders dash for all-zero amounts', () => {
    render(<CategoryPaymentValue amounts={{ NGN: 0, USD: 0 }} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders single currency', () => {
    render(<CategoryPaymentValue amounts={{ NGN: 100, USD: 0 }} />);
    expect(screen.getByText(/₦100/)).toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('renders multiple currencies separated, never summed', () => {
    const { container } = render(<CategoryPaymentValue amounts={{ NGN: 100, USD: 20 }} />);
    const text = container.textContent || '';
    expect(text).toContain('₦100');
    expect(text).toContain('$20');
    expect(text).not.toContain('120');
  });
});

// ═══════════════════════════════════════════════════════════
// 5. Payouts: transfer method dropdown
// ═══════════════════════════════════════════════════════════
describe('#596 Payouts: transfer method dropdown', () => {
  it('excludes flutterwave_transfer from approve dropdown', async () => {
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
    expect(screen.getAllByText('Approve Payout').length).toBeGreaterThanOrEqual(1);
    const options = Array.from(document.querySelectorAll('option')).map(o => o.value);
    expect(options).toContain('manual_bank');
    expect(options).toContain('paystack_transfer');
    expect(options).toContain('stripe_transfer');
    expect(options).not.toContain('flutterwave_transfer');
    expect(options).not.toContain('manual_cash');
  });
});

// ═══════════════════════════════════════════════════════════
// 6. Settlement-state display: Confirm Settlement button
// ═══════════════════════════════════════════════════════════
describe('#596 Payouts: settlement state display', () => {
  it('shows Confirm Settlement for approved manual_bank payouts', async () => {
    h.fetch.mockResolvedValue(new Response(JSON.stringify({
      payouts: [{
        id: 'pay-settle', business_id: NG, business_name: 'Settled Merchant',
        payout_account_id: 'acct-1',
        period_start: '2026-10-01', period_end: '2026-10-08', gross_amount: 5000,
        platform_fee: 50, gateway_fee: 0, net_amount: 4950, country_code: 'NG',
        status: 'approved', transfer_method: 'manual_bank',
        created_at: '2026-10-09T00:00:00Z',
      }],
      total_pages: 1,
    }), { status: 200 }));
    render(<Payouts />);
    expect(await screen.findByText('Settled Merchant')).toBeInTheDocument();
    expect(screen.getByText('Confirm Settlement')).toBeInTheDocument();
  });
});
