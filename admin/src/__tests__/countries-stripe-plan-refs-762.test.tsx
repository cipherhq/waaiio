import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  role: 'admin', token: 'synthetic-old-token', fetch: vi.fn(), getSession: vi.fn(), setSession: vi.fn(),
  countries: [] as any[], rpc: vi.fn(), writes: vi.fn(), version: 'synthetic-version-1',
}));
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: h.getSession, setSession: h.setSession } },
  adminDb: { rpc: h.rpc, from: h.writes },
}));
vi.mock('@/lib/countries', () => ({ loadCountries: async () => h.countries, invalidateCache: vi.fn() }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn() }));
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => ({ userId: 'synthetic-admin', email: 'admin@example.test', role: h.role }) }));
// Real Countries, role predicate, API helper, useStepUp and StepUpDialog.
import Countries from '@/pages/Countries';

function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function session() { return { data: { session: { access_token: h.token } }, error: null }; }
function requests(path: string) { return h.fetch.mock.calls.filter(([url]) => String(url).endsWith(path)); }
function saves() { return requests('/api/admin/provider-config').filter(([, init]) => JSON.parse(init.body).action === 'save_refs'); }
function body(call: any[]) { return JSON.parse(call[1].body); }
const verified = () => json({ session: { access_token: 'synthetic-current-token', refresh_token: 'synthetic-refresh' } });
async function transport(url: string, init: RequestInit) {
  if (url.endsWith('/prepare')) return json({ stepUpId: 'synthetic-step', factorId: 'synthetic-factor', challengeId: 'synthetic-challenge' });
  if (url.endsWith('/verify')) return verified();
  if (url.endsWith('/provider-config')) {
    const data = JSON.parse(String(init.body));
    return json({ version_id: data.action === 'get_version' ? h.version : 'synthetic-version-2' });
  }
  throw new Error('Unexpected synthetic request');
}
beforeEach(() => {
  h.role = 'admin'; h.token = 'synthetic-old-token'; h.version = 'synthetic-version-1';
  h.countries = [['US', 'USD'], ['GB', 'GBP'], ['CA', 'CAD']].map(([code, currency_code]) => ({
    code, name: code, flag: '', dialing_code: '+1', currency_code, currency_symbol: '$', currency_locale: 'en-US',
    payment_gateway: 'stripe', phone_digits: 10, phone_pattern: '', phone_placeholder: '', is_active: true,
    sort_order: 0, cities: {}, verification_tiers: {}, doc_types: [],
    pricing: { free: { price: 0, feeFlat: 0 }, growth: { price: 29.99, feeFlat: 1, provider_plan_refs: { stripe: 'price_synthetic' + code + 'Pro' } },
      business: { price: 59.99, feeFlat: 2, provider_plan_refs: { stripe: 'price_synthetic' + code + 'Premium' } } },
  }));
  h.fetch.mockReset().mockImplementation(transport);
  h.getSession.mockReset().mockImplementation(async () => session());
  h.setSession.mockReset().mockImplementation(async (value: { access_token: string }) => { h.token = value.access_token; return { error: null }; });
  h.rpc.mockReset().mockResolvedValue({ data: [], error: null }); h.writes.mockReset();
  vi.stubEnv('VITE_API_URL', 'https://synthetic.example.test'); vi.stubGlobal('fetch', h.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function select(code = 'US') {
  await screen.findByRole('option', { name: new RegExp(code + ' —') });
  fireEvent.change(screen.getByLabelText('Provider country'), { target: { value: code } });
  await waitFor(() => expect((screen.getByLabelText('Pro Stripe Price ID') as HTMLInputElement).value).toBe('price_synthetic' + code + 'Pro'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save Plan Refs' }).hasAttribute('disabled')).toBe(false));
}
async function prepare() {
  fireEvent.click(screen.getByRole('button', { name: 'Save Plan Refs' }));
  await screen.findByText('Confirm operation');
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Saving...' })).toBeNull());
}
function authorize() {
  fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
}
describe('#762 mounted Countries Stripe reference flow', () => {
  it.each(['US', 'GB', 'CA'])('%s hydrates and saves only refs with exact MFA binding, CAS and current token', async code => {
    render(<Countries />); await select(code);
    expect((screen.getByLabelText('Premium Stripe Price ID') as HTMLInputElement).value).toBe('price_synthetic' + code + 'Premium');
    fireEvent.change(screen.getByLabelText('Pro Stripe Price ID'), { target: { value: 'price_syntheticEdited' } });
    const originalPricing = JSON.stringify(h.countries.map(c => c.pricing));
    await prepare();
    const params = { action: 'save_refs', country_code: code, plan_refs: {
      growth: { stripe: 'price_syntheticEdited' }, business: { stripe: 'price_synthetic' + code + 'Premium' },
    }, expected_version_id: 'synthetic-version-1', tier_prices: null };
    expect(body(requests('/prepare')[0])).toEqual({ actionType: 'provider_config', targetId: 'save_refs', params });
    expect(saves()).toHaveLength(0); authorize();
    await waitFor(() => expect(saves()).toHaveLength(1));
    const { tier_prices: _prices, ...payload } = params;
    expect(body(saves()[0])).toEqual({ ...payload, stepUpId: 'synthetic-step' });
    expect(saves()[0][1].headers.Authorization).toBe('Bearer synthetic-current-token');
    expect(body(requests('/verify')[0])).toEqual({ stepUpId: 'synthetic-step', code: '123456' });
    expect(h.setSession).toHaveBeenCalledWith({ access_token: 'synthetic-current-token', refresh_token: 'synthetic-refresh' });
    await screen.findByText('Plan refs saved successfully');
    expect(JSON.stringify(h.countries.map(c => c.pricing))).toBe(originalPricing); expect(h.writes).not.toHaveBeenCalled();
    expect(h.rpc.mock.calls.every(([name]) => name === 'get_effective_commercial_config')).toBe(true);
  });
  it('omits untouched absent Stripe refs while saving valid other-provider refs', async () => {
    h.countries[0].pricing.growth.provider_plan_refs = { paystack: 'PLN_syntheticPro' };
    h.countries[0].pricing.business.provider_plan_refs = { flutterwave: '123456' };
    render(<Countries />); await screen.findByRole('option', { name: /US —/ });
    fireEvent.change(screen.getByLabelText('Provider country'), { target: { value: 'US' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Plan Refs' }).hasAttribute('disabled')).toBe(false));
    expect((screen.getByLabelText('Pro Stripe Price ID') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Premium Stripe Price ID') as HTMLInputElement).value).toBe('');
    await prepare(); authorize(); await waitFor(() => expect(saves()).toHaveLength(1));
    const payload = { action: 'save_refs', country_code: 'US', plan_refs: {
      growth: { paystack: 'PLN_syntheticPro' }, business: { flutterwave: '123456' },
    }, expected_version_id: 'synthetic-version-1', stepUpId: 'synthetic-step' };
    expect(body(saves()[0])).toEqual(payload);
    const { stepUpId: _step, ...params } = payload;
    expect(body(requests('/prepare')[0]).params).toEqual({ ...params, tier_prices: null });
    await screen.findByText('Plan refs saved successfully');
  });
  it.each(['Pro Stripe Price ID', 'Premium Stripe Price ID'])('denies clearing configured %s before step-up or save', async label => {
    render(<Countries />); await select();
    fireEvent.change(screen.getByLabelText(label), { target: { value: ' ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Plan Refs' }));
    await screen.findByText('Enter a valid Stripe Price ID; clearing a configured or edited reference is not supported.');
    expect(requests('/prepare')).toHaveLength(0); expect(saves()).toHaveLength(0);
  });
  it('unchanged context saves exactly once after delayed current-token resolution', async () => {
    const pending = deferred<ReturnType<typeof session>>(); let tokenWait = false;
    h.getSession.mockImplementation(async () => {
      if (h.token === 'synthetic-current-token' && !tokenWait) { tokenWait = true; return pending.promise; }
      return session();
    });
    render(<Countries />); await select('CA');
    fireEvent.change(screen.getByLabelText('Pro Stripe Price ID'), { target: { value: 'price_syntheticCaptured' } });
    await prepare(); authorize(); await waitFor(() => expect(tokenWait).toBe(true));
    expect(saves()).toHaveLength(0);
    await act(async () => { pending.resolve({ data: { session: { access_token: 'synthetic-resolved-token' } }, error: null }); await pending.promise; });
    await screen.findByText('Plan refs saved successfully');
    expect(saves()).toHaveLength(1);
    expect(body(saves()[0])).toEqual({ action: 'save_refs', country_code: 'CA', plan_refs: {
      growth: { stripe: 'price_syntheticCaptured' }, business: { stripe: 'price_syntheticCAPremium' },
    }, expected_version_id: 'synthetic-version-1', stepUpId: 'synthetic-step' });
    expect(saves()[0][1].headers.Authorization).toBe('Bearer synthetic-resolved-token');
  });
  it('switches countries without carrying edited references', async () => {
    render(<Countries />); await select(); fireEvent.change(screen.getByLabelText('Pro Stripe Price ID'), { target: { value: 'price_edited' } });
    await select('GB'); await select('CA'); await select('US'); expect(saves()).toHaveLength(0);
  });
  it.each(['country', 'refs', 'CAS', 'role', 'unmount'])('invalidates deferred MFA on %s change before fetching a mutation token', async change => {
    const pending = deferred<Response>();
    h.fetch.mockImplementation((url: string, init: RequestInit) => url.endsWith('/verify') ? pending.promise : transport(url, init));
    const view = render(<Countries />); await select(); await prepare(); authorize();
    await waitFor(() => expect(requests('/verify')).toHaveLength(1));
    if (change === 'country') fireEvent.change(screen.getByLabelText('Provider country'), { target: { value: 'GB' } });
    if (change === 'refs') fireEvent.change(screen.getByLabelText('Pro Stripe Price ID'), { target: { value: 'price_changed' } });
    if (change === 'CAS') fireEvent.click(screen.getByRole('button', { name: 'Reload CAS' }));
    if (change === 'role') { h.role = 'support'; view.rerender(<Countries />); }
    if (change === 'unmount') view.unmount();
    await act(async () => { pending.resolve(verified()); await pending.promise; });
    await waitFor(() => expect(h.setSession).toHaveBeenCalledTimes(1));
    expect(saves()).toHaveLength(0);
  });
  it.each(['country', 'refs', 'CAS', 'role', 'unmount'])('invalidates after current-token await on %s change', async change => {
    const pending = deferred<ReturnType<typeof session>>(); let tokenWait = false;
    h.getSession.mockImplementation(async () => {
      if (h.token === 'synthetic-current-token' && !tokenWait) { tokenWait = true; return pending.promise; }
      return session();
    });
    const view = render(<Countries />); await select(); await prepare(); authorize();
    await waitFor(() => expect(tokenWait).toBe(true));
    if (change === 'country') fireEvent.change(screen.getByLabelText('Provider country'), { target: { value: 'GB' } });
    if (change === 'refs') fireEvent.change(screen.getByLabelText('Pro Stripe Price ID'), { target: { value: 'price_changed' } });
    if (change === 'CAS') fireEvent.click(screen.getByRole('button', { name: 'Reload CAS' }));
    if (change === 'role') { h.role = 'support'; view.rerender(<Countries />); }
    if (change === 'unmount') view.unmount();
    await act(async () => { pending.resolve(session()); await pending.promise; });
    expect(saves()).toHaveLength(0);
  });
  it('invalidates a pending prepare after selection changes', async () => {
    const pending = deferred<Response>();
    h.fetch.mockImplementation((url: string, init: RequestInit) => url.endsWith('/prepare') ? pending.promise : transport(url, init));
    render(<Countries />); await select(); fireEvent.click(screen.getByRole('button', { name: 'Save Plan Refs' }));
    await waitFor(() => expect(requests('/prepare')).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('Provider country'), { target: { value: 'GB' } });
    await act(async () => { pending.resolve(json({ stepUpId: 'synthetic-step', factorId: 'synthetic-factor', challengeId: 'synthetic-challenge' })); await pending.promise; });
    await waitFor(() => expect(screen.queryByText('Confirm operation')).toBeNull()); expect(saves()).toHaveLength(0);
  });
  it.each(['support', 'finance', 'operations'])('%s cannot save refs', async role => {
    h.role = role; render(<Countries />); await screen.findByRole('option', { name: /US —/ });
    fireEvent.change(screen.getByLabelText('Provider country'), { target: { value: 'US' } });
    expect((await screen.findByLabelText('Pro Stripe Price ID')).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Save Plan Refs' }).hasAttribute('disabled')).toBe(true);
    expect(requests('/prepare')).toHaveLength(0); expect(saves()).toHaveLength(0);
  });
  it.each([[409, 'config_version_conflict', 'Configuration was modified by another admin. Please reload the page.'],
    [400, 'Synthetic provider validation failed', 'Synthetic provider validation failed']] as const)('shows %s save failure without success', async (status, error, message) => {
    h.fetch.mockImplementation((url: string, init: RequestInit) => url.endsWith('/provider-config') && JSON.parse(String(init.body)).action === 'save_refs'
      ? Promise.resolve(json({ error }, status)) : transport(url, init));
    render(<Countries />); await select(); await prepare(); authorize(); await screen.findByText(message);
    expect(saves()).toHaveLength(1); expect(screen.queryByText('Plan refs saved successfully')).toBeNull();
  });
  it('rejects missing refreshed token without mutation', async () => {
    h.setSession.mockImplementation(async () => { h.token = ''; return { error: null }; });
    render(<Countries />); await select(); await prepare(); authorize();
    await screen.findByText('Not authenticated — please sign in again.'); expect(saves()).toHaveLength(0);
  });
  it('failed version read disables save', async () => {
    h.fetch.mockResolvedValue(json({ error: 'synthetic failure' }, 503));
    render(<Countries />); await screen.findByText('Failed to load config version');
    fireEvent.change(screen.getByLabelText('Provider country'), { target: { value: 'US' } });
    expect((await screen.findByRole('button', { name: 'Save Plan Refs' })).hasAttribute('disabled')).toBe(true);
    expect(saves()).toHaveLength(0);
  });
});
