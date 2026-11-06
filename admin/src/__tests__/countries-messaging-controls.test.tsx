/**
 * Countries page: the Messaging Financial Controls section is on the page again.
 *
 * Mounts the real Countries page, the real useStepUp hook and StepUpDialog. Only the
 * Supabase client, the countries loader and network transport are synthetic.
 * Proves: the section renders, loads the effective config, shows each smallest-unit
 * amount as normal money, exposes the "all other messages" (*) rate, and saves the
 * edited trial credit with the existing MFA binding while keeping the * rate.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  role: 'admin', fetch: vi.fn(), getSession: vi.fn(), setSession: vi.fn(),
  countries: [] as any[], rpc: vi.fn(), writes: vi.fn(),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: h.getSession, setSession: h.setSession } },
  adminDb: { rpc: h.rpc, from: h.writes },
}));
vi.mock('@/lib/countries', () => ({ loadCountries: async () => h.countries, invalidateCache: vi.fn() }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn() }));
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => ({ userId: 'synthetic-admin', email: 'admin@example.test', role: h.role }) }));
import Countries, { MinorAmountHint } from '@/pages/Countries';

const SNAPSHOT = {
  messaging_pricing: {
    NGN: { rates: { NG: { '*': 2100 } }, default_cost_minor: 2100, default_spend_cap_minor: 7500000 },
    USD: { rates: { US: { '*': 1 } }, default_cost_minor: 1, default_spend_cap_minor: 5000 },
  },
  trial_credit_minor_by_currency: { NGN: 600000, USD: 400 },
  subscription_included_minor_by_tier_currency: { growth: { NGN: 225000, USD: 225 }, business: { NGN: 675000, USD: 600 } },
};

function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status }); }
function requests(path: string) { return h.fetch.mock.calls.filter(([url]) => String(url).endsWith(path)); }
function body(call: any[]) { return JSON.parse(call[1].body); }
function country(code: string, currency_code: string, currency_locale: string, payment_gateway: string) {
  return {
    code, name: code, flag: '', dialing_code: '+1', currency_code, currency_symbol: '', currency_locale,
    payment_gateway, phone_digits: 10, phone_pattern: '', phone_placeholder: '', is_active: true,
    sort_order: 0, cities: {}, verification_tiers: {}, doc_types: [],
    pricing: { free: { price: 0, feeFlat: 0 }, growth: { price: 49, feeFlat: 0 }, business: { price: 89.99, feeFlat: 0 } },
  };
}
async function transport(url: string) {
  if (url.endsWith('/prepare')) return json({ stepUpId: 'synthetic-step', factorId: 'synthetic-factor', challengeId: 'synthetic-challenge' });
  if (url.endsWith('/verify')) return json({ session: { access_token: 'synthetic-current-token', refresh_token: 'synthetic-refresh' } });
  if (url.endsWith('/messaging-config')) return json({ versionId: 'synthetic-version-2' });
  if (url.endsWith('/provider-config')) return json({ version_id: 'synthetic-version-1' });
  throw new Error('Unexpected synthetic request ' + url);
}
const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const cell = (label: string) => input(label).closest('td') as HTMLElement;

beforeEach(() => {
  h.role = 'admin';
  h.countries = [country('NG', 'NGN', 'en-NG', 'paystack'), country('US', 'USD', 'en-US', 'stripe')];
  h.fetch.mockReset().mockImplementation(transport);
  h.getSession.mockReset().mockResolvedValue({ data: { session: { access_token: 'synthetic-token' } }, error: null });
  h.setSession.mockReset().mockResolvedValue({ error: null });
  h.rpc.mockReset().mockResolvedValue({ data: [{ id: 'synthetic-version-1', config_snapshot: SNAPSHOT }], error: null });
  h.writes.mockReset();
  vi.stubEnv('VITE_API_URL', 'https://synthetic.example.test'); vi.stubGlobal('fetch', h.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function loaded() {
  await screen.findByText('Messaging Financial Controls');
  await waitFor(() => expect(input('NGN trial credit').value).toBe('600000'));
}

describe('Countries page — Messaging Financial Controls restored', () => {
  it('renders the section with the effective config and plain-money amounts', async () => {
    render(<Countries />); await loaded();
    expect(within(cell('NGN trial credit')).getByText(/= ₦\s?6,000\.00/)).toBeTruthy();
    expect(input('USD trial credit').value).toBe('400');
    expect(within(cell('USD trial credit')).getByText('= $4.00')).toBeTruthy();
    expect(input('NGN spend cap').value).toBe('7500000');
    expect(within(cell('NGN spend cap')).getByText(/= ₦\s?75,000\.00/)).toBeTruthy();
    expect(input('USD growth included credit').value).toBe('225');
    expect(input('USD business included credit').value).toBe('600');
    // The live "all messages" rate is visible and editable, not hidden.
    expect(input('NG all other messages rate').value).toBe('2100');
    expect(within(cell('NG all other messages rate')).getByText(/= ₦\s?21\.00/)).toBeTruthy();
    expect(input('US all other messages rate').value).toBe('1');
    expect(within(cell('US all other messages rate')).getByText('= $0.01')).toBeTruthy();
    expect(h.rpc.mock.calls.every(([name]) => name === 'get_effective_commercial_config')).toBe(true);
  });

  it('hint follows the typed value, and shows nothing for a non-whole number', async () => {
    render(<Countries />); await loaded();
    fireEvent.change(input('USD trial credit'), { target: { value: '500' } });
    expect(within(cell('USD trial credit')).getByText('= $5.00')).toBeTruthy();
    fireEvent.change(input('USD trial credit'), { target: { value: '4.5' } });
    expect(within(cell('USD trial credit')).queryByText(/^=/)).toBeNull();
  });

  it('saves the edited trial credit with the MFA binding and keeps the all-messages rate', async () => {
    render(<Countries />); await loaded();
    fireEvent.change(input('USD trial credit'), { target: { value: '500' } });
    for (const code of ['NG', 'US']) {
      fireEvent.change(input(`${code} utility rate`), { target: { value: '5' } });
      fireEvent.change(input(`${code} marketing rate`), { target: { value: '9' } });
    }
    fireEvent.click(screen.getByRole('button', { name: /Save Messaging Config/ }));
    await screen.findByText('Confirm operation');
    const expectedPricing = {
      NGN: { rates: { NG: { '*': 2100, utility: 5, marketing: 9 } }, default_cost_minor: 2100, default_spend_cap_minor: 7500000 },
      USD: { rates: { US: { '*': 1, utility: 5, marketing: 9 } }, default_cost_minor: 1, default_spend_cap_minor: 5000 },
    };
    const expectedTrial = { NGN: 600000, USD: 500 };
    const expectedIncluded = SNAPSHOT.subscription_included_minor_by_tier_currency;
    expect(body(requests('/prepare')[0])).toEqual({
      actionType: 'messaging_config', targetId: 'messaging_bundle',
      params: {
        messaging_pricing: expectedPricing, trial_credit: expectedTrial, subscription_included: expectedIncluded,
        paystack_plan_codes: null, expected_version_id: 'synthetic-version-1', description: null,
      },
    });
    expect(requests('/messaging-config')).toHaveLength(0);
    fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
    await screen.findByText('Messaging configuration saved successfully');
    expect(requests('/messaging-config')).toHaveLength(1);
    expect(body(requests('/messaging-config')[0])).toEqual({
      messagingPricing: expectedPricing, trialCreditMinorByCurrency: expectedTrial,
      subscriptionIncludedMinorByTierCurrency: expectedIncluded, paystackPlanCodes: null,
      expectedVersionId: 'synthetic-version-1', stepUpId: 'synthetic-step',
    });
    expect(h.writes).not.toHaveBeenCalled();
  });

  it('an active market without utility and marketing rates is refused before any MFA request', async () => {
    render(<Countries />); await loaded();
    fireEvent.click(screen.getByRole('button', { name: /Save Messaging Config/ }));
    await screen.findByText('NG: Utility rate is required for active markets');
    expect(requests('/prepare')).toHaveLength(0);
    expect(requests('/messaging-config')).toHaveLength(0);
  });

  it('read-only admin roles see the section but cannot edit or save', async () => {
    h.role = 'support';
    render(<Countries />); await loaded();
    expect(input('NGN trial credit').disabled).toBe(true);
    expect(input('NG all other messages rate').disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Save Messaging Config/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('MinorAmountHint', () => {
  it.each([
    ['500', 'USD', 'en-US', '= $5.00'],
    ['550', 'CAD', 'en-CA', '= $5.50'],
    ['500', 'GBP', 'en-GB', '= £5.00'],
    ['0', 'USD', 'en-US', '= $0.00'],
  ])('%s %s shows %s', (value, currency, locale, text) => {
    render(<MinorAmountHint value={value} currency={currency} locale={locale} />);
    expect(screen.getByText(text)).toBeTruthy();
  });
  it.each(['', ' ', '-1', '4.5', 'abc'])('shows nothing for %j', value => {
    const { container } = render(<MinorAmountHint value={value} currency="USD" locale="en-US" />);
    expect(container.textContent).toBe('');
  });
  it('shows nothing for an unknown currency code', () => {
    const { container } = render(<MinorAmountHint value="500" currency="NOTACODE" locale="en-US" />);
    expect(container.textContent).toBe('');
  });
});
