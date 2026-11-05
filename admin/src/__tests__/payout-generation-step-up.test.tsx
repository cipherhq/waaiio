import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const m = vi.hoisted(() => ({ token: 'before-mfa', fetch: vi.fn(), setSession: vi.fn(), prepare: 0,
  rejectVerification: false, status: 200, result: {} as Record<string, unknown>, rows: [] as Record<string, unknown>[] }));
vi.mock('@/lib/supabase', () => ({ supabase: { auth: {
  getSession: async () => ({ data: { session: { access_token: m.token } } }),
  setSession: m.setSession,
} }, adminDb: {} }));
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => ({ role: 'admin' }) }));
vi.mock('@/lib/countries', () => ({ loadCountries: async () => {}, getCountryCurrencyDetailMap: () => ({}) }));
import Payouts from '../pages/Payouts';

beforeEach(() => {
  vi.clearAllMocks(); m.token = 'before-mfa'; m.prepare = 0; m.rejectVerification = false;
  m.status = 200; m.result = { created: 2, held: 0, skipped: 0, failed: 0 }; m.rows = [];
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  m.setSession.mockImplementation(async ({ access_token }) => { m.token = access_token; return { error: null }; });
  m.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/step-up/prepare')) return Response.json({ stepUpId: `grant-${++m.prepare}`, factorId: 'factor', challengeId: '' });
    if (url.endsWith('/step-up/verify')) return m.rejectVerification
      ? Response.json({ error: 'Restart required', code: 'STEP_UP_RESTART_REQUIRED' }, { status: 400 })
      : Response.json({ session: { access_token: 'after-mfa', refresh_token: 'rotated-refresh' } });
    if (url.endsWith('/payouts/generate')) return Response.json(m.result, { status: m.status });
    return Response.json({ payouts: m.rows, total_pages: 1 });
  });
  vi.stubGlobal('fetch', m.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const calls = (suffix: string) => m.fetch.mock.calls.filter(([url]) => url.endsWith(suffix));
async function begin() {
  fireEvent.click(await screen.findByRole('button', { name: 'Generate Weekly Payouts' }));
  await screen.findByText('Confirm operation');
}
function submit() {
  fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
}

it('requires fresh preparation after failed MFA and uses rotated session only after success', async () => {
  m.rejectVerification = true;
  render(<Payouts />); await begin(); submit();
  await screen.findByText(/Cancel and restart/);
  expect(calls('/payouts/generate')).toHaveLength(0);
  expect(m.setSession).not.toHaveBeenCalled();
  submit();
  expect(calls('/step-up/verify')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  m.rejectVerification = false;
  await begin(); submit();
  await waitFor(() => expect(calls('/payouts/generate')).toHaveLength(1));
  const [, request] = calls('/payouts/generate')[0];
  expect(request.headers.Authorization).toBe('Bearer after-mfa');
  expect(JSON.parse(request.body)).toEqual({ stepUpId: 'grant-2' });
  expect(JSON.parse(calls('/step-up/verify')[1][1].body)).toEqual({ stepUpId: 'grant-2', code: '123456' });
});

it.each([
  [200, { created: 2, held: 0, skipped: 0, failed: 0 }, 'Created: 2'],
  [207, { created: 1, held: 1, failed: 2, skipped: 3, error: 'Payout generation completed with failures', needs_attention: ['fixture-id'] }, 'Needs review (payout IDs): fixture-id'],
  [200, { created: 0, held: 0, skipped: 1, failed: 0, message: 'No eligible payouts for this period' }, 'No eligible payouts for this period'],
  [500, { error: 'Failed to generate payouts' }, 'Failed to generate payouts'],
] as const)('shows fixture response %s after the real hook completes', async (status, result, message) => {
  m.status = status; m.result = result;
  render(<Payouts />); await begin();
  expect(calls('/payouts/generate')).toHaveLength(0);
  submit();
  await waitFor(() => expect(window.alert).toHaveBeenCalled());
  expect(vi.mocked(window.alert).mock.calls[0][0]).toContain(message);
  expect(calls('/payouts/generate')).toHaveLength(1);
  expect(m.setSession).toHaveBeenCalledWith({ access_token: 'after-mfa', refresh_token: 'rotated-refresh' });
});

it.each([
  ['USD', 'NG', /USD\s*94\.25/],
  ['NGN', 'US', /NGN\s*94\.25/],
  [null, 'NG', /94\.25 \(currency unknown\)/],
  ['invalid', 'US', /94\.25 \(currency unknown\)/],
] as const)('uses stored currency %s in the row, settlement modal and MFA description', async (currency, country, amount) => {
  m.rows = [{ id: 'fixture-payout', business_id: 'fixture-business', business_name: 'Currency fixture',
    country_code: country, currency, net_amount: 94.25, gross_amount: 100, platform_fee: 5,
    gateway_fee: 0.75, status: 'approved', transfer_method: 'manual_bank', flags: [],
    period_start: '2026-01-01', period_end: '2026-01-07', created_at: '2026-01-08T00:00:00Z' }];
  render(<Payouts />);
  expect(await screen.findByText(amount)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm Settlement' }));
  expect(screen.getByText((text) => text.startsWith('Currency fixture —') && amount.test(text))).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText('e.g. NIP/SESSION-ID/RECEIPT-NUMBER'), { target: { value: 'SYNTHETIC-REFERENCE' } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getAllByRole('button', { name: 'Confirm Settlement' }).at(-1)!);
  expect(await screen.findByText((text) => text.startsWith('Confirm settlement for Currency fixture —') && amount.test(text))).toBeTruthy();
  expect(calls('/step-up/prepare')).toHaveLength(1);
  expect(calls('/step-up/verify')).toHaveLength(0);
  expect(calls('/confirm-settlement')).toHaveLength(0);
});
